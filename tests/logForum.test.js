// Advanced logs (owner, 2026-11-13): a kind of log can go to a forum channel with one post per
// member ("<username> logs <id>"), every log about that member in their post; logs about no member in
// "Server logs". Any failure (not a forum, missing permissions, Discord refusal) falls back to the
// kind's normal channel. Covers logForum.js, loggingService.logEvent, enforcementService.postModLog
// and the config round trip of logging.forums.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

const { db } = await import('../src/utils/database/wrapper.js');
const { MemoryStorage } = await import('../src/utils/memoryStorage.js');
const { logger } = await import('../src/utils/logger.js');
const { LOG_FORUM_KINDS, isLogForumPost, logForumId, logPostName, resetLogForumState, sendToLogForum } = await import('../src/services/logForum.js');
const { subjectFromFields } = await import('../src/services/enforcement/enforcementService.js');
const { logEvent, resetLogChannelBackoff, setLogForums, getLoggingStatus } = await import('../src/services/loggingService.js');
const { normalizeGuildConfig, validateGuildConfigOrThrow } = await import('../src/utils/schemas.js');
const { GUILD_CONFIG_DEFAULTS } = await import('../src/config/guild/guildConfigDefaults.js');

const MEMBER = '200000000000000044';
let guildSeq = 0;
const nextGuild = () => `9100000000000000${String((guildSeq += 1)).padStart(2, '0')}`;

function memoryDb() {
    db.db = new MemoryStorage();
    db.useFallback = true;
    db.initialized = true;
    db.connectionType = 'memory';
}

afterEach(() => { resetLogForumState(); resetLogChannelBackoff(); });

async function quietly(fn) {
    const saved = {};
    for (const level of ['error', 'warn', 'info', 'debug']) { saved[level] = logger[level]; logger[level] = () => {}; }
    try { return await fn(); } finally { Object.assign(logger, saved); }
}

/** A config store like the real one (client.db): get / set / update. */
function store(initial = {}) {
    const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
    return {
        data,
        async get(key, fallback = null) { return data.has(key) ? structuredClone(data.get(key)) : fallback; },
        async set(key, value) { data.set(key, structuredClone(value)); return true; },
        async delete(key) { return data.delete(key); },
        async update(key, mutator, defaultValue = null) {
            const next = await mutator(data.has(key) ? structuredClone(data.get(key)) : structuredClone(defaultValue));
            data.set(key, structuredClone(next));
            return structuredClone(next);
        },
    };
}

/** A guild with a forum (posts are threads) and a normal text channel. */
function fakeGuild({ forumPerms = true, requireTag = false, forumType = ChannelType.GuildForum } = {}) {
    const id = nextGuild();
    const channels = new Map();
    const guild = { id, name: 'G', iconURL: () => null, members: { me: {} }, channels: { cache: channels, fetch: async (cid) => channels.get(cid) || null } };
    guild.client = { users: { cache: new Map([[MEMBER, { id: MEMBER, username: 'amy' }]]), fetch: async () => null }, guilds: { cache: new Map([[id, guild]]) } };
    const text = { id: '930000000000000001', type: ChannelType.GuildText, guildId: id, sent: [], permissionsFor: () => ({ has: () => true }), send: async (m) => { text.sent.push(m); return { id: 'tm' }; }, isTextBased: () => true };
    let threadSeq = 0;
    const forum = {
        id: '930000000000000002', type: forumType, guildId: id, created: [],
        flags: { has: (flag) => requireTag && flag === 'RequireTag' }, availableTags: requireTag ? [{ id: 'mods', moderated: true }, { id: 'tag1', moderated: false }] : [],
        permissionsFor: () => ({ has: () => forumPerms }),
        threads: {
            cache: new Map(),
            create: async ({ name, message, appliedTags, autoArchiveDuration }) => {
                forum.creates = (forum.creates || 0) + 1;
                if (forum.failCreate) throw forum.failCreate;
                threadSeq += 1;
                const thread = { id: `94000000000000000${threadSeq}`, name, parentId: forum.id, locked: false, sent: [message] };
                thread.send = async (m) => { thread.sent.push(m); return { id: `m${thread.sent.length}` }; };
                forum.threads.cache.set(thread.id, thread);
                channels.set(thread.id, thread);
                forum.created.push({ name, appliedTags, autoArchiveDuration });
                return thread;
            },
        },
    };
    channels.set(text.id, text);
    channels.set(forum.id, forum);
    const removeThread = (threadId) => { forum.threads.cache.delete(threadId); channels.delete(threadId); };
    return { guild, text, forum, removeThread };
}

const embed = (title) => ({ embeds: [{ title }] });

// ── names and settings ────────────────────────────────────────────────────

test('post names: "<username> logs <id>" (id never cut), "Server logs" without a member', () => {
    assert.equal(logPostName({ id: MEMBER, username: 'amy' }), `amy logs ${MEMBER}`);
    assert.equal(logPostName(null), 'Server logs');
    const long = logPostName({ id: MEMBER, username: 'x'.repeat(200) });
    assert.equal(long.length, 100);
    assert.ok(long.endsWith(` logs ${MEMBER}`));
    assert.equal(logPostName({ id: MEMBER }), `unknown logs ${MEMBER}`);
});

test('settings: a kind is Advanced only with a valid forum id; forums survive the config round trip', () => {
    const config = { logging: { forums: { modlog: '930000000000000002', members: 'junk', reports: '930000000000000002' } } };
    assert.equal(logForumId(config, 'modlog'), '930000000000000002');
    assert.equal(logForumId(config, 'members'), null);
    assert.equal(logForumId(config, 'reports'), null, 'reports and applications are workflows, never forums');
    assert.ok(['audit', 'moderation', 'members', 'messages', 'server', 'community', 'dashboard', 'modlog'].every((k) => LOG_FORUM_KINDS.includes(k)));
    const saved = validateGuildConfigOrThrow(normalizeGuildConfig({ logging: { forums: { modlog: '930000000000000002', dashboard: '930000000000000003' } } }, GUILD_CONFIG_DEFAULTS));
    assert.deepEqual(normalizeGuildConfig(saved, GUILD_CONFIG_DEFAULTS).logging.forums, { modlog: '930000000000000002', dashboard: '930000000000000003' });
});

test('setLogForums: one locked write; Normal removes the forum; only real changes are reported', async () => {
    const guildId = nextGuild();
    const client = { db: store({ [`guild:${guildId}:config`]: { logging: { enabled: true, channels: { audit: '930000000000000001' } } } }), guilds: { cache: new Map() } };
    assert.deepEqual(await setLogForums(client, guildId, { modlog: '930000000000000002', members: null }), [{ kind: 'modlog', old: null, new: '930000000000000002' }]);
    assert.equal((await getLoggingStatus(client, guildId)).forums.modlog, '930000000000000002');
    assert.equal((await getLoggingStatus(client, guildId)).channels.audit, '930000000000000001', 'channels untouched');
    assert.deepEqual(await setLogForums(client, guildId, { modlog: '930000000000000002' }), []);
    assert.deepEqual(await setLogForums(client, guildId, { modlog: null }), [{ kind: 'modlog', old: '930000000000000002', new: null }]);
    assert.equal((await getLoggingStatus(client, guildId)).forums.modlog, null);
    await assert.rejects(setLogForums(client, guildId, { reports: '930000000000000002' }), /Invalid log forum kind/);
});

// ── posting ───────────────────────────────────────────────────────────────

test('sendToLogForum: first log makes the member\'s post, later logs go into it; a deleted post is made again', async () => {
    memoryDb();
    const { guild, forum, removeThread } = fakeGuild();
    const first = await sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER, username: 'amy' }, payload: embed('one') });
    assert.ok(first);
    assert.deepEqual(forum.created.map((c) => c.name), [`amy logs ${MEMBER}`]);
    const post = forum.threads.cache.values().next().value;
    assert.deepEqual(post.sent[0].allowedMentions, { parse: [] }, 'never pings');
    await sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER }, payload: embed('two') });
    assert.equal(forum.created.length, 1, 'same post');
    assert.deepEqual(post.sent.map((m) => m.embeds[0].title), ['one', 'two']);
    // After a restart (no memory) the stored post is found again.
    resetLogForumState();
    await sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER }, payload: embed('three') });
    assert.equal(forum.created.length, 1);
    // Someone deleted the post: a new one.
    removeThread(post.id);
    await sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER }, payload: embed('four') });
    assert.equal(forum.created.length, 2);
    // No member: the "Server logs" post; a forum that requires a tag gets its first tag.
    await sendToLogForum({ guild, forumId: forum.id, subject: null, payload: embed('server') });
    assert.equal(forum.created.at(-1).name, 'Server logs');
    const tagged = fakeGuild({ requireTag: true });
    await sendToLogForum({ guild: tagged.guild, forumId: tagged.forum.id, subject: { id: MEMBER }, payload: embed('t') });
    assert.deepEqual(tagged.forum.created[0].appliedTags, ['tag1']);
});

test('sendToLogForum: two logs at the same moment make one post, not two', async () => {
    memoryDb();
    const { guild, forum } = fakeGuild();
    await Promise.all([1, 2, 3].map((n) => sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER }, payload: embed(String(n)) })));
    assert.equal(forum.created.length, 1);
    assert.equal(forum.threads.cache.values().next().value.sent.length, 3);
});

test('sendToLogForum: not a forum or missing permissions → null (the caller uses the normal channel)', async () => {
    memoryDb();
    const noPerms = fakeGuild({ forumPerms: false });
    assert.equal(await quietly(() => sendToLogForum({ guild: noPerms.guild, forumId: noPerms.forum.id, subject: { id: MEMBER }, payload: embed('x') })), null);
    const notForum = fakeGuild({ forumType: ChannelType.GuildText });
    assert.equal(await quietly(() => sendToLogForum({ guild: notForum.guild, forumId: notForum.forum.id, subject: null, payload: embed('x') })), null);
    const { guild } = fakeGuild();
    assert.equal(await quietly(() => sendToLogForum({ guild, forumId: '930000000000000099', subject: null, payload: embed('x') })), null);
});

test('logEvent: an Advanced kind posts in the member\'s forum post; a broken forum falls back to the normal channel', async () => {
    memoryDb();
    const { guild, text, forum } = fakeGuild();
    const config = { logging: { enabled: true, channels: { audit: text.id }, forums: { members: forum.id } } };
    const client = { db: store({ [`guild:${guild.id}:config`]: config }), guilds: { cache: new Map([[guild.id, guild]]) }, users: guild.client.users };
    await logEvent({ client, guildId: guild.id, eventType: 'member.join', data: { title: 'User joined', userId: MEMBER } });
    assert.deepEqual(forum.created.map((c) => c.name), [`amy logs ${MEMBER}`]);
    assert.equal(text.sent.length, 0, 'not also in the text channel');
    // A kind that is not Advanced: the text channel as before.
    await logEvent({ client, guildId: guild.id, eventType: 'message.delete', data: { title: 'Deleted', userId: MEMBER } });
    assert.equal(text.sent.length, 1);
    // The forum stops working: the member log goes to the normal channel.
    forum.permissionsFor = () => ({ has: () => false });
    resetLogForumState();
    await quietly(() => logEvent({ client, guildId: guild.id, eventType: 'member.join', data: { title: 'User joined', userId: MEMBER } }));
    assert.equal(text.sent.length, 2);
});

test('postModLog: an Advanced mod log puts a punishment in the punished member\'s post; without a member in "Server logs"', async () => {
    memoryDb();
    const { guild, text, forum } = fakeGuild();
    const { postModLog } = await import('../src/services/enforcement/enforcementService.js');
    const { setSettingsCacheForTests, resetSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
    resetSettingsCacheForTests();
    setSettingsCacheForTests(guild.id, { modLogChannelId: text.id });
    const client = { db: store({ [`guild:${guild.id}:config`]: { logging: { forums: { modlog: forum.id } } } }), guilds: { cache: new Map([[guild.id, guild]]) }, users: guild.client.users };
    assert.equal(await quietly(() => postModLog(client, 'warn', [{ name: 'User', value: `amy (${MEMBER})` }], { guildId: guild.id, subject: { id: MEMBER, username: 'amy' } })), true);
    assert.deepEqual(forum.created.map((c) => c.name), [`amy logs ${MEMBER}`]);
    assert.equal(text.sent.length, 0);
    await quietly(() => postModLog(client, 'caseedit', [], { guildId: guild.id, description: 'edited' }));
    assert.equal(forum.created.at(-1).name, 'Server logs');
    // Forum unusable: the normal mod log channel.
    forum.type = ChannelType.GuildText;
    resetLogForumState();
    assert.equal(await quietly(() => postModLog(client, 'warn', [{ name: 'User', value: 'x' }], { guildId: guild.id, subject: { id: MEMBER } })), true);
    assert.equal(text.sent.length, 1);
    resetSettingsCacheForTests();
});

// ── review fixes (2026-11-13) ─────────────────────────────────────────────

test('new posts archive after an hour (never fill the active-thread cap); a forum at a Discord limit is paused', async () => {
    memoryDb();
    const { guild, forum } = fakeGuild();
    await sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER }, payload: embed('a') });
    assert.equal(forum.created[0].autoArchiveDuration, 60);
    const full = fakeGuild();
    full.forum.failCreate = Object.assign(new Error('Maximum number of active threads reached'), { code: 160006 });
    assert.equal(await quietly(() => sendToLogForum({ guild: full.guild, forumId: full.forum.id, subject: { id: MEMBER }, payload: embed('a') })), null);
    assert.equal(full.forum.creates, 1);
    full.forum.failCreate = null;
    assert.equal(await quietly(() => sendToLogForum({ guild: full.guild, forumId: full.forum.id, subject: { id: '200000000000000045' }, payload: embed('b') })), null, 'paused: normal channel');
    assert.equal(full.forum.creates, 1, 'no new attempt while paused');
});

test('a temporary refusal in an existing post goes to the normal channel; only a deleted or locked post gets a new one', async () => {
    memoryDb();
    const { guild, forum } = fakeGuild();
    await sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER }, payload: embed('a') });
    const post = forum.threads.cache.values().next().value;
    post.send = async () => { throw Object.assign(new Error('Service unavailable'), { status: 503 }); };
    assert.equal(await quietly(() => sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER }, payload: embed('b') })), null);
    assert.equal(forum.created.length, 1, 'history not split');
    post.send = async () => { throw Object.assign(new Error('Thread is locked'), { code: 160005 }); };
    assert.ok(await quietly(() => sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER }, payload: embed('c') })));
    assert.equal(forum.created.length, 2);
});

test('a forum that requires a tag gets the first tag anyone may use (not a moderated one)', async () => {
    memoryDb();
    const { guild, forum } = fakeGuild({ requireTag: true });
    await sendToLogForum({ guild, forumId: forum.id, subject: { id: MEMBER }, payload: embed('t') });
    assert.deepEqual(forum.created[0].appliedTags, ['tag1']);
});

test('mod log entries without a subject find the member in their "User (id)" field; Mewvo\'s own log posts are recognised', () => {
    assert.deepEqual(subjectFromFields([{ name: 'Case', value: 'abc' }, { name: 'User', value: `amy (${MEMBER})` }]), { id: MEMBER, username: 'amy' });
    assert.deepEqual(subjectFromFields([{ name: 'Member', value: `<@${MEMBER}> (${MEMBER})` }]), { id: MEMBER, username: null });
    assert.equal(subjectFromFields([{ name: 'Moderator', value: `bob (${MEMBER})` }]), null, 'only the member fields');
    assert.equal(subjectFromFields([{ name: 'User', value: 'no id here' }]), null);
    assert.equal(subjectFromFields(null), null);
    const config = { logging: { forums: { members: '930000000000000002' } } };
    const thread = (ownerId, parentId) => ({ ownerId, parentId, client: { user: { id: 'bot' } } });
    assert.equal(isLogForumPost(thread('bot', '930000000000000002'), config), true);
    assert.equal(isLogForumPost(thread('someone', '930000000000000002'), config), false, 'a member\'s own post is logged as usual');
    assert.equal(isLogForumPost(thread('bot', '930000000000000099'), config), false, 'another forum');
    assert.equal(isLogForumPost(thread('bot', '930000000000000002'), null), false);
});
