// The Automod log (owner, 2026-11-13: "it should show everything the automod did; the moderation will
// only be when a staff himself does it"). A log kind of its own (channel or Advanced forum, never the
// main log when unset), a record for every automod decision (one per burst, or per new action), and
// automated punishments in it instead of the mod log when the server has one. Covers automodLog.js,
// loggingService (destination, postToLogDestination), enforcementService.postModLog / logEnforcement
// (`automated`), and the hooks in reviewCards, headsUp, joinGate, raidService and automodService.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

const { db } = await import('../src/utils/database/wrapper.js');
const { MemoryStorage } = await import('../src/utils/memoryStorage.js');
const { logger } = await import('../src/utils/logger.js');
const { LOG_FORUM_KINDS, resetLogForumState } = await import('../src/services/logForum.js');
const { LOG_DESTINATIONS, hasAutomodLog, resetLogChannelBackoff, resolveLogChannel } = await import('../src/services/loggingService.js');
const { logEnforcement, postModLog } = await import('../src/services/enforcement/enforcementService.js');
const { setSettingsCacheForTests, resetSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
const automodLog = await import('../src/services/automod/automodLog.js');
const { noteRepeatHit, postReviewCard } = await import('../src/services/automod/reviewCards.js');
const registry = await import('../src/services/automod/reviewRegistry.js');
const { finishHeadsUp, setHeadsUpDepsForTest } = await import('../src/services/automod/headsUp.js');
const { gateRecord } = await import('../src/services/automod/joinGate.js');
const { lockdownRecord } = await import('../src/services/automod/raidService.js');
const { handleImmuneHits } = await import('../src/services/automod/automodService.js');

const MEMBER = '200000000000000044';
const OTHER_MEMBER = '200000000000000045';
const MODLOG = '930000000000000001';
const AUTOMOD = '930000000000000003';
const AUDIT = '930000000000000004';
const FORUM = '930000000000000002';
let guildSeq = 0;
const nextGuild = () => `9200000000000000${String((guildSeq += 1)).padStart(2, '0')}`;

function memoryDb() {
    db.db = new MemoryStorage();
    db.useFallback = true;
    db.initialized = true;
    db.connectionType = 'memory';
}

afterEach(() => {
    resetLogForumState();
    resetLogChannelBackoff();
    resetSettingsCacheForTests();
    automodLog.setAutomodLogSinkForTest();
    automodLog.resetAutomodLogState();
    registry.resetReviewRegistry();
    setHeadsUpDepsForTest();
});

async function quietly(fn) {
    const saved = {};
    for (const level of ['error', 'warn', 'info', 'debug']) { saved[level] = logger[level]; logger[level] = () => {}; }
    try { return await fn(); } finally { Object.assign(logger, saved); }
}

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

/** A guild with a mod log, an automod log and a main log text channel, a forum, and a client whose config is `logging`. */
function fakeServer(logging = {}) {
    const id = nextGuild();
    const channels = new Map();
    const guild = { id, name: 'G', iconURL: () => null, members: { me: {}, cache: new Map(), fetch: async () => null }, channels: { cache: channels, fetch: async (cid) => channels.get(cid) || null } };
    const text = (cid) => {
        const channel = { id: cid, type: ChannelType.GuildText, guildId: id, sent: [], permissionsFor: () => ({ has: () => channel.allowed !== false }), isTextBased: () => true };
        channel.send = async (m) => { channel.sent.push(m); return { id: `m${channel.sent.length}` }; };
        channels.set(cid, channel);
        return channel;
    };
    const modlog = text(MODLOG);
    const automod = text(AUTOMOD);
    const audit = text(AUDIT);
    const forum = {
        id: FORUM, type: ChannelType.GuildForum, guildId: id, created: [], flags: { has: () => false }, availableTags: [],
        permissionsFor: () => ({ has: () => true }),
        threads: {
            cache: new Map(),
            create: async ({ name, message }) => {
                const thread = { id: `94000000000000000${forum.created.length + 1}`, name, parentId: FORUM, locked: false, sent: [message] };
                thread.send = async (m) => { thread.sent.push(m); return { id: 't' }; };
                forum.threads.cache.set(thread.id, thread);
                channels.set(thread.id, thread);
                forum.created.push(name);
                return thread;
            },
        },
    };
    channels.set(FORUM, forum);
    const users = { cache: new Map([[MEMBER, { id: MEMBER, username: 'amy' }]]), fetch: async () => null };
    const client = {
        db: store({ [`guild:${id}:config`]: { logging: { enabled: true, ...logging } } }),
        guilds: { cache: new Map([[id, guild]]), fetch: async () => null },
        users,
        user: { id: '500000000000000001', username: 'Mewvo' },
    };
    guild.client = client;
    setSettingsCacheForTests(id, { modLogChannelId: MODLOG });
    return { id, guild, client, modlog, automod, audit, forum };
}

const caseFields = [{ name: 'User', value: `amy (${MEMBER})` }, { name: 'Moderator', value: 'Mewvo (500000000000000001)' }];

// ── the log kind ──────────────────────────────────────────────────────────

test('automod is a log destination and an Advanced kind; unset it never falls back to the main log', () => {
    assert.ok(LOG_DESTINATIONS.includes('automod'));
    assert.ok(LOG_FORUM_KINDS.includes('automod'));
    const config = { logging: { channels: { audit: AUDIT } } };
    assert.equal(resolveLogChannel(config, 'automod'), null);
    assert.equal(resolveLogChannel(config, 'members'), AUDIT, 'control: an ordinary kind falls back');
    assert.equal(resolveLogChannel({ logging: { channels: { audit: AUDIT, automod: AUTOMOD } } }, 'automod'), AUTOMOD);
    assert.equal(hasAutomodLog(config), false);
    assert.equal(hasAutomodLog({ logging: { enabled: true, channels: { automod: AUTOMOD } } }), true);
    assert.equal(hasAutomodLog({ logging: { enabled: true, forums: { automod: FORUM } } }), true);
    assert.equal(hasAutomodLog({ logging: { enabled: false, channels: { automod: AUTOMOD } } }), false, 'logging off: not in use');
});

test('logAutomod: posts in the automod channel; nothing when unset (not the main log); ignore lists and event toggles apply', async () => {
    memoryDb();
    const record = { type: 'action', title: 'Automod: Spam', subject: { id: MEMBER, username: 'amy' }, fields: [{ name: 'Done', value: 'Message deleted' }] };
    const set = fakeServer({ channels: { audit: AUDIT, automod: AUTOMOD } });
    assert.ok(await automodLog.logAutomod(set.client, set.id, record));
    assert.equal(set.automod.sent.length, 1);
    assert.equal(set.automod.sent[0].embeds[0].data.title, 'Automod: Spam');
    assert.match(set.automod.sent[0].embeds[0].data.description, /Message deleted/);
    assert.equal(set.audit.sent.length, 0);

    const unset = fakeServer({ channels: { audit: AUDIT } });
    assert.equal(await automodLog.logAutomod(unset.client, unset.id, record), null);
    assert.equal(unset.audit.sent.length, 0, 'never the main log');

    const ignored = fakeServer({ channels: { automod: AUTOMOD }, ignore: { users: [MEMBER], channels: [], roles: [] } });
    assert.equal(await automodLog.logAutomod(ignored.client, ignored.id, record), null);
    const toggledOff = fakeServer({ channels: { automod: AUTOMOD }, enabledEvents: { 'automod.action': false } });
    assert.equal(await automodLog.logAutomod(toggledOff.client, toggledOff.id, record), null);
    assert.ok(await automodLog.logAutomod(toggledOff.client, toggledOff.id, { ...record, type: 'flag' }), 'control: another automod event still posts');
    assert.equal(await automodLog.logAutomod(set.client, set.id, { ...record, type: 'bogus' }), null, 'unknown types are refused');
});

test('logAutomod: Advanced puts the record in the member\'s post; a record about no member in "Server logs"', async () => {
    memoryDb();
    const s = fakeServer({ forums: { automod: FORUM } });
    await automodLog.logAutomod(s.client, s.id, { type: 'action', title: 'x', subject: { id: MEMBER, username: 'amy' }, fields: [] });
    await automodLog.logAutomod(s.client, s.id, lockdownRecord('start', { joinerCount: 9, raised: true, panic: null }));
    assert.deepEqual(s.forum.created, [`amy logs ${MEMBER}`, 'Server logs']);
});

// ── records ───────────────────────────────────────────────────────────────

const hit = (over = {}) => ({
    guild: { id: '920000000000009999' }, rule: 'spam', evidence: 'sent 6 messages in 5 seconds',
    targetUser: { id: MEMBER, username: 'amy' }, channelId: '930000000000000010', messageUrl: 'https://discord.com/channels/1/2/3', content: 'buy now', ...over,
});
const fieldOf = (record, name) => record.fields.find((field) => field.name === name)?.value;

test('hit records: action with case code, failed step, watch mode, notes, native, reports and personal info', () => {
    const warned = automodLog.automodHitRecord(hit({ step: { type: 'warn' }, result: { record: { case_code: 'k3f9a' } }, deleted: true, offence: 2 }));
    assert.equal(warned.type, 'action');
    assert.match(warned.title, /^Automod: /);
    assert.match(fieldOf(warned, 'Done'), /\(case `k3f9a`\)/);
    assert.equal(fieldOf(warned, 'Message'), 'Deleted');
    assert.equal(fieldOf(warned, 'Offence'), '#2 for this rule');
    assert.equal(warned.excerpt, '||buy now||');
    assert.deepEqual(warned.subject, { id: MEMBER, username: 'amy' });

    const ladder = automodLog.automodHitRecord(hit({ step: { type: 'warn' }, result: { record: { case_code: 'aaaaa' }, banRecord: { case_code: 'bbbbb' } } }));
    assert.match(fieldOf(ladder, 'Done'), /warning limit reached: banned \(case `bbbbb`\)/);
    const failed = automodLog.automodHitRecord(hit({ step: { type: 'warn' }, result: { error: { userMessage: 'Mewvo cannot warn them' } } }));
    assert.match(fieldOf(failed, 'Done'), /failed: Mewvo cannot warn them/);
    const monitor = automodLog.automodHitRecord(hit({ monitor: true, suggested: { type: 'warn' }, deleted: false }));
    assert.equal(monitor.type, 'flag');
    assert.match(fieldOf(monitor, 'Done'), /^Watch mode, nothing done \(the rule would /);
    assert.match(fieldOf(monitor, 'Message'), /^Kept · \[jump to message\]/);
    const immune = automodLog.automodHitRecord(hit({ note: { title: '🛡 Immune member, message kept' }, deleted: false, logKind: 'flag' }));
    assert.equal(immune.type, 'flag');
    assert.equal(fieldOf(immune, 'Done'), 'Immune member, message kept');
    const notice = automodLog.automodHitRecord(hit({ note: { title: 'Friendly notice (first small offence)' }, logKind: 'notice' }));
    assert.equal(notice.type, 'notice');
    const native = automodLog.automodHitRecord(hit({ rule: 'native:123', ruleLabel: 'Discord AutoMod: Bad words', note: { title: 'Discord AutoMod blocked a message' } }));
    assert.equal(native.type, 'native');
    assert.equal(native.title, 'Discord AutoMod: Bad words');
    const raid = automodLog.automodHitRecord(hit({ step: { type: 'kick' }, result: { record: { case_code: 'rrrrr' } }, raid: true }));
    assert.match(fieldOf(raid, 'Done'), /^Raid joiner: /);
    assert.equal(automodLog.automodHitRecord(hit({ report: { reporter: 'bob' } })), null, 'a member report is not automod');
    assert.equal(automodLog.automodHitRecord(hit({ rule: 'privacy', content: 'my phone is 555' })).excerpt, null, 'personal info is never copied');
});

test('bursts: one record per burst; a repeat that took a new action gets its own; a burst ends after the window', () => {
    const t = 1_000_000;
    assert.equal(automodLog.shouldLogHit('k', {}, t), true);
    assert.equal(automodLog.shouldLogHit('k', {}, t + 1000), false);
    assert.equal(automodLog.shouldLogHit('k', { step: { type: 'mute' } }, t + 2000), true, 'a new action');
    assert.equal(automodLog.shouldLogHit('k', {}, t + 2000 + 10 * 60 * 1000), true, 'window passed');
    assert.equal(automodLog.shouldLogHit(null, {}, t), true, 'never grouped (raid kicks, heads-ups)');
    assert.equal(automodLog.shouldLogHit(null, {}, t), true);
});

test('postReviewCard: every hit is recorded in the Automod log (grouped like the card); repeats inside the cooldown are not', async () => {
    const records = [];
    automodLog.setAutomodLogSinkForTest(async (args) => { records.push(args); return { id: 'x' }; });
    const guild = { id: nextGuild(), client: { guilds: { cache: new Map() } } };
    setSettingsCacheForTests(guild.id, {});
    const base = hit({ guild });
    await quietly(() => postReviewCard({ ...base, step: { type: 'warn' }, result: { record: { case_code: 'k3f9a' } }, deleted: true }));
    await quietly(() => postReviewCard({ ...base, deleted: true }));
    await quietly(() => noteRepeatHit({ ...base, deleted: true }));
    await quietly(() => postReviewCard({ ...base, step: { type: 'mute', durationMs: 3600000 }, result: { record: { case_code: 'm2m2m' } }, deleted: true }));
    await quietly(() => postReviewCard({ ...base, targetUser: { id: OTHER_MEMBER, username: 'bo' }, deleted: true }));
    await quietly(() => postReviewCard({ ...base, rule: 'report', report: { reporter: 'bob', messageId: '1', removed: false } }));
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((r) => r.eventType), ['automod.action', 'automod.action', 'automod.action']);
    assert.deepEqual(records.map((r) => r.data.userId), [MEMBER, MEMBER, OTHER_MEMBER]);
    assert.match(records[1].data.fields.find((f) => f.name === 'Done').value, /m2m2m/);
    assert.equal(records[0].guildId, guild.id);
});

test('immune hits: the "message kept" line is an Automod log flag', async () => {
    const posted = [];
    const message = {
        id: 'msg1', guild: { id: nextGuild() }, author: { id: MEMBER, username: 'amy' }, channelId: '930000000000000010', url: 'u', content: 'x', attachments: { size: 0 },
    };
    await handleImmuneHits(message, [{ rule: 'spam', evidence: 'e' }], { postReviewCard: async (p) => { posted.push(p); } });
    assert.equal(posted[0].logKind, 'flag');
    assert.equal(automodLog.automodHitRecord(posted[0]).type, 'flag');
});

test('heads-up endings are recorded (fixed or acted); an expired record without a member is not', async () => {
    const records = [];
    setHeadsUpDepsForTest({ logAutomod: async (client, guildId, record) => { records.push({ guildId, record }); }, kvUpdate: async () => ({}), closeCard: async () => {} });
    const client = { users: { cache: new Map([[MEMBER, { username: 'amy' }]]) }, channels: { fetch: async () => null } };
    const base = { guildId: '920000000000000077', messageId: 'm1', userId: MEMBER, rule: 'language', channelId: '930000000000000010', messageUrl: 'u' };
    await quietly(() => finishHeadsUp(client, base, 'edited'));
    await quietly(() => finishHeadsUp(client, base, 'acted'));
    await quietly(() => finishHeadsUp(client, { guildId: '920000000000000077', messageId: 'm2', expired: true }, 'dropped'));
    assert.equal(records.length, 2);
    assert.equal(records[0].record.type, 'headsup');
    assert.match(records[0].record.fields.find((f) => f.name === 'Heads-up').value, /^Fixed by the member/);
    assert.match(records[1].record.fields.find((f) => f.name === 'Heads-up').value, /^Not fixed in time/);
    assert.deepEqual(records[0].record.subject, { id: MEMBER, username: 'amy' });
});

test('join gate and lockdown records', () => {
    const member = { id: MEMBER, user: { username: 'amy' } };
    const gate = gateRecord(member, [{ check: 'avatar', action: 'kick', reason: 'no profile picture' }], 'Kicked');
    assert.equal(gate.type, 'joingate');
    assert.deepEqual(gate.subject, { id: MEMBER, username: 'amy' });
    assert.match(gate.fields.find((f) => f.name === 'Checks').value, /No profile picture: no profile picture \(kick\)/);
    const start = lockdownRecord('start', { joinerCount: 12, raised: true, panic: { applied: true, until: new Date(0).toISOString() } });
    assert.equal(start.type, 'raid');
    assert.match(start.fields[0].value, /12 accounts joined/);
    assert.match(start.fields.find((f) => f.name === 'Invites and DMs').value, /^Paused until/);
    const manual = lockdownRecord('start', { joinerCount: 0, raised: false, panic: null, startedBy: { id: OTHER_MEMBER, username: 'boss' } });
    assert.match(manual.title, /started by an administrator/);
    const end = lockdownRecord('end', { state: { joinerIds: ['1', '2'], raisedVerification: true, incidentActions: { applied: true }, gateKicks: ['1'] }, restored: true, resumed: false, admin: { id: OTHER_MEMBER, username: 'boss' } });
    assert.match(end.title, /ended/);
    assert.equal(end.fields.find((f) => f.name === 'Raid joiners').value, '2');
    assert.match(end.fields.find((f) => f.name === 'Invites and DMs').value, /Could not resume/);
});

// ── automated records: the Automod log instead of the mod log ─────────────

test('postModLog automated: the Automod log when set (never pings); staff records stay in the mod log', async () => {
    memoryDb();
    const s = fakeServer({ channels: { automod: AUTOMOD } });
    assert.equal(await quietly(() => postModLog(s.client, 'warn', caseFields, { guildId: s.id, automated: true })), true);
    assert.equal(s.automod.sent.length, 1);
    assert.deepEqual(s.automod.sent[0].allowedMentions, { parse: [] });
    assert.equal(s.modlog.sent.length, 0);
    // Control: the same record by staff goes to the mod log.
    assert.equal(await quietly(() => postModLog(s.client, 'warn', caseFields, { guildId: s.id })), true);
    assert.equal(s.modlog.sent.length, 1);
    assert.equal(s.automod.sent.length, 1);
    // Any kind (the quarantine feature passes automated for its own kind).
    assert.equal(await quietly(() => postModLog(s.client, 'quarantine', [{ name: 'Member', value: `amy (${MEMBER})` }], { guildId: s.id, title: 'Quarantined', automated: true })), true);
    assert.equal(s.automod.sent.length, 2);
    assert.equal(s.modlog.sent.length, 1);
});

test('postModLog automated: no Automod log, or a broken one → where it went before (nothing disappears)', async () => {
    memoryDb();
    const none = fakeServer({ channels: {} });
    assert.equal(await quietly(() => postModLog(none.client, 'warn', caseFields, { guildId: none.id, automated: true })), true);
    assert.equal(none.modlog.sent.length, 1);
    const broken = fakeServer({ channels: { automod: AUTOMOD } });
    broken.automod.allowed = false;
    assert.equal(await quietly(() => postModLog(broken.client, 'warn', caseFields, { guildId: broken.id, automated: true })), true);
    assert.equal(broken.automod.sent.length, 0);
    assert.equal(broken.modlog.sent.length, 1);
    // Logging switched off: automatic punishments stay in the mod log.
    const off = fakeServer({ enabled: false, channels: { automod: AUTOMOD } });
    assert.equal(await quietly(() => postModLog(off.client, 'warn', caseFields, { guildId: off.id, automated: true })), true);
    assert.equal(off.automod.sent.length, 0);
    assert.equal(off.modlog.sent.length, 1);
    // Advanced automod log: the member's post.
    const forum = fakeServer({ forums: { automod: FORUM } });
    assert.equal(await quietly(() => postModLog(forum.client, 'ban', caseFields, { guildId: forum.id, automated: true })), true);
    assert.deepEqual(forum.forum.created, [`amy logs ${MEMBER}`]);
    assert.equal(forum.modlog.sent.length, 0);
});

test('logEnforcement: automod cases go to the Automod log (even with no mod log set); staff cases to the mod log', async () => {
    memoryDb();
    const record = { case_code: 'k3f9a', name: 'amy warn 1', reason: 'Automod: Spam', type: 'warn', dm_delivered: true };
    const target = { id: MEMBER, username: 'amy' };
    const s = fakeServer({ channels: { audit: AUDIT, automod: AUTOMOD } });
    await quietly(() => logEnforcement(s.client, s.id, 'warn', { record, target, moderatorLabel: 'Mewvo (1)', automated: true }));
    assert.equal(s.automod.sent.length, 1);
    assert.match(s.automod.sent[0].embeds[0].data.description, /k3f9a/);
    assert.equal(s.modlog.sent.length, 0);
    await quietly(() => logEnforcement(s.client, s.id, 'warn', { record: { ...record, case_code: 'staff1' }, target, moderatorLabel: 'bob (2)' }));
    assert.equal(s.modlog.sent.length, 1, 'control: a staff case');
    assert.equal(s.automod.sent.length, 1);
    assert.equal(s.audit.sent.length, 0, 'no general log copy');

    // No mod log channel at all, but an Automod log: the automod case goes there, no general-log copy.
    const noModLog = fakeServer({ channels: { audit: AUDIT, automod: AUTOMOD } });
    setSettingsCacheForTests(noModLog.id, {});
    await quietly(() => logEnforcement(noModLog.client, noModLog.id, 'warn', { record, target, moderatorLabel: 'Mewvo (1)', automated: true }));
    assert.equal(noModLog.automod.sent.length, 1);
    assert.equal(noModLog.audit.sent.length, 0);
    // Control: a staff case there still gets the general-log copy, as before.
    await quietly(() => logEnforcement(noModLog.client, noModLog.id, 'warn', { record, target, moderatorLabel: 'bob (2)' }));
    assert.equal(noModLog.audit.sent.length, 1);
    assert.equal(noModLog.automod.sent.length, 1);
});
