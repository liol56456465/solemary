// Automod immune members (owner, 2026-11-13): roles / user ids whose messages automod still checks
// but never deletes or punishes; each hit is a "message kept" line in the review channel, grouped
// per member and rule. The settings (normalized, capped, @everyone refused), the message path
// (immune wins over the administrator rule; commands and XP go on), the line with its jump link,
// and Discord's own AutoMod "warn" policy turned into a log line for them.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AutoModerationActionType } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000777';
const IMMUNE_ROLE = '600000000000000011';
const IMMUNE_USER = '200000000000000044';
const PLAIN_USER = '200000000000000055';
Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT });

const { pgDb } = await import('../../src/utils/postgresDatabase.js');
const { db } = await import('../../src/utils/database/wrapper.js');
const { MemoryStorage } = await import('../../src/utils/memoryStorage.js');
const { logger } = await import('../../src/utils/logger.js');
const { resetSettingsCacheForTests, setSettingsCacheForTests } = await import('../../src/services/settings/guildSettings.js');
const {
    IMMUNE_ROLES_MAX, IMMUNE_USERS_MAX, getAutomodSettings, isImmuneMember, normalizeSettings, resetAutomodSettingsCache, setImmuneEntry, updateAutomodSettings,
} = await import('../../src/services/automod/automodSettings.js');
const { handleImmuneHits, moderateMessage, resetAutomodState, setAutomodDepsForTest } = await import('../../src/services/automod/automodService.js');
const { handleNativeExecution, resetNativeBridge } = await import('../../src/services/automod/nativeBridge.js');
const { buildCardPayload } = await import('../../src/services/automod/reviewFormat.js');
const { entryFrom } = await import('../../src/services/automod/reviewCards.js');
const registry = await import('../../src/services/automod/reviewRegistry.js');

const DAY = 24 * 3600 * 1000;
const realIsAvailable = pgDb.isAvailable;
const realPool = pgDb.pool;

function setup(answer = () => []) {
    db.db = new MemoryStorage();
    db.useFallback = true;
    db.initialized = true;
    db.connectionType = 'memory';
    resetSettingsCacheForTests();
    resetAutomodSettingsCache();
    resetAutomodState();
    setSettingsCacheForTests(OTHER, {});
    const queries = [];
    const run = async (sql, params = []) => {
        queries.push(String(sql).replace(/\s+/g, ' ').trim());
        return { rows: (await answer(String(sql), params)) || [], rowCount: 1 };
    };
    pgDb.pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    pgDb.isAvailable = () => true;
    return queries;
}

afterEach(() => {
    pgDb.isAvailable = realIsAvailable;
    pgDb.pool = realPool;
    setAutomodDepsForTest();
    registry.resetReviewRegistry();
    resetNativeBridge();
    resetSettingsCacheForTests();
    resetAutomodSettingsCache();
});

async function quietly(fn) {
    const saved = {};
    for (const level of ['error', 'warn', 'info', 'debug']) { saved[level] = logger[level]; logger[level] = () => {}; }
    try { return await fn(); } finally { Object.assign(logger, saved); }
}

function fakeGuild(id) {
    const guild = {
        id, name: 'Server', ownerId: 'owner',
        invites: { cache: new Map() }, channels: { cache: new Map(), fetch: async () => null },
        roles: { cache: new Map() }, members: { cache: new Map(), fetch: async () => null },
    };
    guild.client = { user: { id: 'bot' }, guilds: { cache: new Map([[id, guild]]) }, fetchInvite: async () => null, channels: { fetch: async () => null }, users: { fetch: async () => null } };
    return guild;
}

let seq = 0;
function fakeMessage(guild, text, { authorId = PLAIN_USER, roleIds = [], admin = false } = {}) {
    seq += 1;
    const member = {
        id: authorId, guild, joinedTimestamp: Date.now() - 100 * DAY, client: guild.client,
        permissions: { has: () => admin }, roles: { cache: new Map(roleIds.map((r) => [r, { id: r }])) },
    };
    const message = {
        id: `m${seq}`, guild, guildId: guild.id, channelId: 'c1', url: `https://discord.com/channels/${guild.id}/c1/m${seq}`, content: text,
        author: { id: authorId, bot: false, username: 'amy', createdTimestamp: Date.now() - 400 * DAY },
        member, mentions: { users: new Map(), roles: new Map() }, attachments: new Map(), client: guild.client,
        channel: { id: 'c1', name: 'general', isThread: () => false, send: async () => ({ delete: async () => {} }) },
        delete: async () => { message.deleted = true; },
    };
    return message;
}

function recordingDeps() {
    const calls = [];
    const rec = (name, value) => async (...args) => { calls.push({ name, args }); return value; };
    setAutomodDepsForTest({
        countOffences: rec('countOffences', 0), applyStep: rec('applyStep', { record: { case_code: 'abc2345' } }),
        postReviewCard: rec('postReviewCard', null), noteRepeatHit: rec('noteRepeatHit', null), deleteQuietly: rec('deleteQuietly', null),
        isRaidJoiner: rec('isRaidJoiner', false), giveSecondChance: rec('giveSecondChance', false), giveHeadsUp: rec('giveHeadsUp', false),
        noteIncidentEvent: rec('noteIncidentEvent', 'inactive'),
    });
    return calls;
}

const SCAM = 'free nitro https://dlscord-gift.com/claim';

// ── settings ──────────────────────────────────────────────────────────────

test('immune settings: empty by default; stored lists keep ids only, no duplicates, capped', () => {
    assert.deepEqual(normalizeSettings(null, MAIN).immune, { roleIds: [], userIds: [] });
    assert.deepEqual(normalizeSettings({ immune: 'junk' }, OTHER).immune, { roleIds: [], userIds: [] });
    const many = Array.from({ length: 70 }, (_, i) => `2000000000000001${String(i).padStart(2, '0')}`);
    const value = normalizeSettings({ immune: { roleIds: [IMMUNE_ROLE, IMMUNE_ROLE, 'x', 5, ...many], userIds: [IMMUNE_USER, '<@1>', ...many] } }, OTHER).immune;
    assert.equal(value.roleIds[0], IMMUNE_ROLE);
    assert.equal(value.roleIds.length, IMMUNE_ROLES_MAX);
    assert.equal(value.userIds[0], IMMUNE_USER);
    assert.equal(value.userIds.length, IMMUNE_USERS_MAX);
    assert.ok(value.roleIds.every((id) => /^\d{17,20}$/.test(id)));
});

test('isImmuneMember: listed user id or a listed role; anyone else, or no settings, is not', () => {
    const settings = { immune: { roleIds: [IMMUNE_ROLE], userIds: [IMMUNE_USER] } };
    const member = (id, roles = []) => ({ id, roles: { cache: new Map(roles.map((r) => [r, { id: r }])) } });
    assert.equal(isImmuneMember(member(IMMUNE_USER), settings), true);
    assert.equal(isImmuneMember(member(PLAIN_USER, [IMMUNE_ROLE]), settings), true);
    assert.equal(isImmuneMember(member(PLAIN_USER, ['600000000000000099']), settings), false);
    assert.equal(isImmuneMember({ id: IMMUNE_USER }, settings), true, 'no roles known: the id still counts');
    assert.equal(isImmuneMember(member(IMMUNE_USER), {}), false);
    assert.equal(isImmuneMember(null, settings), false);
});

test('setImmuneEntry: adds and removes under the lock; @everyone, bad ids and a full list are refused', async () => {
    setup();
    let r = await setImmuneEntry(OTHER, 'role', IMMUNE_ROLE, true);
    assert.equal(r.changed, true);
    assert.deepEqual(r.settings.immune.roleIds, [IMMUNE_ROLE]);
    r = await setImmuneEntry(OTHER, 'role', IMMUNE_ROLE, true);
    assert.equal(r.changed, false, 'already there');
    r = await setImmuneEntry(OTHER, 'user', IMMUNE_USER, true);
    assert.deepEqual((await getAutomodSettings(OTHER)).immune, { roleIds: [IMMUNE_ROLE], userIds: [IMMUNE_USER] });
    r = await setImmuneEntry(OTHER, 'role', IMMUNE_ROLE, false);
    assert.deepEqual(r.settings.immune.roleIds, []);
    await assert.rejects(setImmuneEntry(OTHER, 'role', OTHER, true), /@everyone cannot be immune/);
    await assert.rejects(setImmuneEntry(OTHER, 'user', 'nope', true), /valid user/);
    await assert.rejects(setImmuneEntry(OTHER, 'channel', IMMUNE_USER, true), /Unknown immune kind/);
    await updateAutomodSettings(OTHER, { immune: { roleIds: Array.from({ length: IMMUNE_ROLES_MAX }, (_, i) => `6100000000000000${String(i).padStart(2, '0')}`), userIds: [] } });
    await assert.rejects(setImmuneEntry(OTHER, 'role', IMMUNE_ROLE, true), /At most 10 immune roles/);
    assert.equal((await getAutomodSettings(OTHER)).immune.roleIds.includes(IMMUNE_ROLE), false);
});

// ── the message path ──────────────────────────────────────────────────────

test('immune member breaks a rule: message kept, nothing punished, one "message kept" line; commands and XP go on', async () => {
    setup();
    const calls = recordingDeps();
    const guild = fakeGuild(OTHER);
    await updateAutomodSettings(OTHER, { enabled: true, mode: 'enforce', immune: { roleIds: [IMMUNE_ROLE], userIds: [IMMUNE_USER] } });
    for (const message of [fakeMessage(guild, SCAM, { authorId: IMMUNE_USER }), fakeMessage(guild, SCAM, { roleIds: [IMMUNE_ROLE] })]) {
        calls.length = 0;
        assert.equal(await quietly(() => moderateMessage(message)), false, 'not removed: callers go on');
        assert.equal(message.deleted, undefined);
        assert.deepEqual(calls.map((c) => c.name), ['postReviewCard']);
        const card = calls[0].args[0];
        assert.equal(card.rule, 'scam');
        assert.equal(card.deleted, false);
        assert.equal(card.note.link, true);
        assert.match(card.note.title, /Immune member, message kept/);
        assert.equal(card.messageUrl, message.url);
    }
    // Control: the same message from anyone else is acted on.
    calls.length = 0;
    assert.equal(await quietly(() => moderateMessage(fakeMessage(guild, SCAM))), true);
    assert.ok(calls.some((c) => c.name === 'applyStep'));
});

test('immune wins over the administrator rule: an immune administrator\'s message stays (no delete, no admin alert)', async () => {
    setup();
    const calls = recordingDeps();
    const guild = fakeGuild(OTHER);
    await updateAutomodSettings(OTHER, { enabled: true, mode: 'enforce', immune: { roleIds: [], userIds: [IMMUNE_USER] } });
    const message = fakeMessage(guild, SCAM, { authorId: IMMUNE_USER, admin: true });
    assert.equal(await quietly(() => moderateMessage(message)), false);
    assert.equal(message.deleted, undefined);
    assert.deepEqual(calls.map((c) => c.name), ['postReviewCard']);
    // Not immune: an administrator's message is still removed (handleAdminHits, unchanged).
    calls.length = 0;
    assert.equal(await quietly(() => moderateMessage(fakeMessage(guild, SCAM, { authorId: PLAIN_USER, admin: true }))), true);
    assert.ok(calls.some((c) => c.name === 'deleteQuietly'));
});

test('handleImmuneHits: one line per rule (not per hit), never deletes; no hit → false', async () => {
    const posts = [];
    const guild = fakeGuild(OTHER);
    const message = fakeMessage(guild, 'x', { authorId: IMMUNE_USER });
    const hits = [{ rule: 'caps', mode: 'enforce', evidence: 'caps' }, { rule: 'caps', mode: 'enforce' }, { rule: 'spam', mode: 'monitor' }];
    assert.equal(await handleImmuneHits(message, hits, { postReviewCard: async (p) => posts.push(p) }), true);
    assert.deepEqual(posts.map((p) => p.rule), ['caps', 'spam']);
    assert.ok(posts.every((p) => p.deleted === false && p.note.link === true));
    assert.equal(message.deleted, undefined);
    assert.equal(await handleImmuneHits(message, [], { postReviewCard: async (p) => posts.push(p) }), false);
    assert.equal(posts.length, 2);
});

test('the "message kept" line links to the latest message; other notes (second chance) stay as before', () => {
    const base = {
        guild: { id: OTHER }, rule: 'caps', evidence: 'caps', targetUser: { id: IMMUNE_USER, username: 'amy' },
        channelId: '7', messageUrl: `https://discord.com/channels/${OTHER}/7/9`, content: 'HELLO', deleted: false,
    };
    const kept = buildCardPayload(entryFrom({ ...base, note: { title: '🛡 Immune member, message kept', link: true } }), { lang: 'en' });
    assert.equal(kept.content, `🛡 Immune member, message kept · <@${IMMUNE_USER}> · Excessive caps · <#7> · [Jump to message](https://discord.com/channels/${OTHER}/7/9)`);
    assert.deepEqual(kept.components, [], 'information only: no buttons');
    const other = buildCardPayload(entryFrom({ ...base, note: { title: 'Friendly notice (first small offence)' } }), { lang: 'en' });
    assert.doesNotMatch(other.content, /Jump to message/);
});

test('Discord AutoMod rule set to "warn": an immune member is only logged, never warned', async () => {
    setup((sql) => (/FROM \S*automod_native_rules/.test(sql) ? [{ rule_id: '1', policy: 'warn', dedupe_minutes: 10 }] : []));
    const guild = fakeGuild(OTHER);
    guild.autoModerationRules = { fetch: async () => null };
    await updateAutomodSettings(OTHER, { enabled: true, mode: 'enforce', immune: { roleIds: [IMMUNE_ROLE], userIds: [] } });
    const warned = [];
    const saved = logger.warn;
    // The warn path is the only one that logs "Native AutoMod warn on <id>" (the system action fails in this fake).
    const execute = async (user, roles) => {
        guild.members.fetch = async (id) => ({ id, roles: { cache: new Map(roles.map((r) => [r, { id: r }])) } });
        logger.warn = (line) => { if (/Native AutoMod warn on/.test(String(line))) warned.push(user.id); };
        try {
            await handleNativeExecution({ guild, action: { type: AutoModerationActionType.BlockMessage }, ruleId: '1', userId: user.id, user, channelId: 'c1', content: 'darn' });
        } finally { logger.warn = saved; }
    };
    await execute({ id: PLAIN_USER, username: 'amy', bot: false }, [IMMUNE_ROLE]);
    assert.deepEqual(warned, [], 'immune: no warn attempted');
    // Control: the same rule for a member without the role goes down the warn path.
    await execute({ id: '200000000000000066', username: 'bo', bot: false }, []);
    assert.deepEqual(warned, ['200000000000000066']);
});

// ── the other automod paths (review 2026-11-13) ───────────────────────────

const { checkJoinGate } = await import('../../src/services/automod/joinGate.js');
const memberChecks = await import('../../src/services/automod/memberChecks.js');
const { burstKey } = registry;

test('join gate: a listed user id is never kicked; anyone else failing the same check is', async () => {
    setup();
    const guild = fakeGuild(OTHER);
    await updateAutomodSettings(OTHER, { enabled: true, mode: 'enforce', joinGate: { avatar: 'kick' }, immune: { roleIds: [], userIds: [IMMUNE_USER] } });
    const joiner = (id) => {
        const m = { id, guild, client: guild.client, user: { id, bot: false, avatar: null, username: 'amy', globalName: null }, roles: { cache: new Map() }, kicked: false };
        m.send = async () => null;
        m.kick = async () => { m.kicked = true; };
        return m;
    };
    const immune = joiner(IMMUNE_USER);
    assert.equal(await quietly(() => checkJoinGate(immune)), null);
    assert.equal(immune.kicked, false);
    const plain = joiner(PLAIN_USER);
    assert.equal(await quietly(() => checkJoinGate(plain)), 'kicked');
    assert.equal(plain.kicked, true);
});

test('member reports: an immune author\'s message is not removed (staff get the card); anyone else\'s is', async () => {
    setup();
    const guild = fakeGuild(OTHER);
    await updateAutomodSettings(OTHER, { enabled: true, mode: 'enforce', immune: { roleIds: [], userIds: [IMMUNE_USER] } });
    const { automodConfig } = await import('../../src/config/automod.js');
    const reporters = new Map(Array.from({ length: automodConfig.reportReactions + 1 }, (_, i) => [`r${i}`, { id: `r${i}`, bot: false, username: `r${i}` }]));
    const react = (message) => memberChecks.handleReportReaction({ emoji: { name: automodConfig.reportEmoji }, message, users: { fetch: async () => reporters } }, { bot: false });
    const kept = fakeMessage(guild, 'hello', { authorId: IMMUNE_USER });
    await quietly(() => react(kept));
    assert.equal(kept.deleted, undefined);
    const removed = fakeMessage(guild, 'hello', { authorId: PLAIN_USER });
    await quietly(() => react(removed));
    assert.equal(removed.deleted, true);
});

test('names: an immune member with a styled name is not renamed; anyone else is (main server, English letters only)', async () => {
    setup();
    const guild = fakeGuild(MAIN);
    await updateAutomodSettings(MAIN, { enabled: true, mode: 'enforce', immune: { roleIds: [IMMUNE_ROLE], userIds: [] } });
    const member = (roles) => {
        const m = {
            id: PLAIN_USER, guild, user: { id: PLAIN_USER, bot: false, username: 'amy' }, displayName: 'ᴀᴍʏ', manageable: true,
            permissions: { has: () => false }, roles: { cache: new Map(roles.map((r) => [r, { id: r }])) }, renamed: null,
        };
        m.setNickname = async (name) => { m.renamed = name; };
        return m;
    };
    const immune = member([IMMUNE_ROLE]);
    await quietly(() => memberChecks.checkImpersonation(immune));
    assert.equal(immune.renamed, null);
    const plain = member([]);
    await quietly(() => memberChecks.checkImpersonation(plain));
    assert.notEqual(plain.renamed, null);
});

test('review lines: notes with different titles never share a line (immune vs. second chance)', () => {
    const base = { guildId: OTHER, userId: IMMUNE_USER, rule: 'caps', kind: 'note' };
    assert.notEqual(burstKey({ ...base, note: { title: '🛡 Immune member, message kept' } }), burstKey({ ...base, note: { title: 'Friendly notice (first small offence)' } }));
    assert.equal(burstKey({ ...base, note: { title: 'x' } }), burstKey({ ...base, note: { title: 'x' } }));
    assert.equal(burstKey({ guildId: OTHER, userId: IMMUNE_USER, rule: 'caps', kind: 'action' }), `${OTHER}:${IMMUNE_USER}:caps:action`, 'other kinds unchanged');
});
