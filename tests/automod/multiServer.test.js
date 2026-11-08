// Multi-server B1: automod in every server. Off by default outside the main server (and the
// main server keeps its old defaults), the main-only guards are gone (each check runs in another
// server only once automod is on there), state is per server and bounded, and the invite filter
// allows the server's own invites plus its allowlist, never Mewvo's servers everywhere.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000777';
const OTHER2 = '100000000000000888';
const THIRD = '100000000000000999';
const OWN_CHANNEL = '400000000000000001';
Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT });

const { pgDb } = await import('../../src/utils/postgresDatabase.js');
const { db } = await import('../../src/utils/database/wrapper.js');
const { MemoryStorage } = await import('../../src/utils/memoryStorage.js');
const { logger } = await import('../../src/utils/logger.js');
const { BoundedMap, BoundedSet } = await import('../../src/utils/boundedMap.js');
const { resetSettingsCacheForTests, setSettingsCacheForTests } = await import('../../src/services/settings/guildSettings.js');
const settingsMod = await import('../../src/services/automod/automodSettings.js');
const {
    normalizeSettings, getAutomodSettings, updateAutomodSettings, setAutomodEnabled, setInviteAllowlist, setStaffGuard,
    normalizeInviteEntry, resetAutomodSettingsCache, automodSettingsCacheSize, INVITE_ALLOWLIST_MAX,
} = settingsMod;
const { ruleMode, resolveRuleMode } = await import('../../src/services/automod/policy.js');
const automod = await import('../../src/services/automod/automodService.js');
const { moderateMessage, inviteGuildIsForeign, resetAutomodState, automodStateSizes, setAutomodDepsForTest, evaluateMessage, STATE_LIMITS, describeAutomodReadiness } = automod;
const slow = await import('../../src/services/automod/autoSlowmode.js');
const headsUp = await import('../../src/services/automod/headsUp.js');
const raid = await import('../../src/services/automod/raidService.js');
const { checkJoinGate } = await import('../../src/services/automod/joinGate.js');
const { startProbationOnJoin, resetProbationCache } = await import('../../src/services/automod/probationService.js');
const guard = await import('../../src/services/automod/staffGuardService.js');
const memberChecks = await import('../../src/services/automod/memberChecks.js');
const { handleNativeExecution, resetNativeBridge } = await import('../../src/services/automod/nativeBridge.js');
const { checkContestTarget } = await import('../../src/services/automod/automodContest.js');
const mood = await import('../../src/services/automod/moodService.js');
const registry = await import('../../src/services/automod/reviewRegistry.js');
const { buildDigest } = await import('../../src/services/automod/automodDigest.js');

const DAY = 24 * 3600 * 1000;
const realIsAvailable = pgDb.isAvailable;
const realPool = pgDb.pool;

function memoryDb() {
    db.db = new MemoryStorage();
    db.useFallback = true;
    db.initialized = true;
    db.connectionType = 'memory';
}

/** The enforcement database "up", queries answered by `answer` (recorded). */
function fakePg(answer = () => []) {
    const queries = [];
    const run = async (sql, params = []) => {
        queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return { rows: (await answer(String(sql), params)) || [], rowCount: 1 };
    };
    pgDb.pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    pgDb.isAvailable = () => true;
    return queries;
}

/** Records every logger call while `fn` runs. */
async function captureLogs(fn) {
    const calls = [];
    const saved = {};
    for (const level of ['error', 'warn', 'info', 'debug']) {
        saved[level] = logger[level];
        logger[level] = (...args) => { calls.push([level, ...args]); };
    }
    try {
        await fn();
    } finally {
        Object.assign(logger, saved);
    }
    return calls;
}

function setup() {
    memoryDb();
    resetSettingsCacheForTests();
    resetAutomodSettingsCache();
    resetAutomodState();
    for (const id of [OTHER, OTHER2, THIRD, SUPPORT]) setSettingsCacheForTests(id, {});
    return fakePg();
}

afterEach(() => {
    pgDb.isAvailable = realIsAvailable;
    pgDb.pool = realPool;
    setAutomodDepsForTest();
    headsUp.setHeadsUpDepsForTest();
    slow.setAutoSlowmodeDepsForTest();
    raid.resetRaidState();
    guard.resetStaffGuardState();
    memberChecks.resetMemberChecksState();
    mood.resetMoodState();
    registry.resetReviewRegistry();
    resetNativeBridge();
    resetProbationCache();
    resetSettingsCacheForTests();
    resetAutomodSettingsCache();
});

const turnOn = (guildId, extra = {}) => updateAutomodSettings(guildId, { enabled: true, ...extra });

// ── fakes ─────────────────────────────────────────────────────────────────

function fakeGuild(id, { vanityURLCode = null, channels = new Map(), ownerId = 'owner' } = {}) {
    const guild = {
        id, name: `Server ${id.slice(-3)}`, ownerId, vanityURLCode,
        invites: { cache: new Map() },
        channels: { cache: channels, fetch: async (cid) => channels.get(cid) || null },
        roles: { cache: new Map() },
        members: { cache: new Map(), fetch: async () => null, kick: async (botId) => { guild.kicked.push(botId); } },
        fetchOwner: async () => ({ send: async () => null }),
        kicked: [],
    };
    return guild;
}

function fakeClient(guilds, { fetchInvite = async () => null } = {}) {
    const client = {
        user: { id: 'bot' },
        guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
        fetchInvite,
        channels: { fetch: async () => null },
        users: { fetch: async () => null },
    };
    for (const guild of guilds) guild.client = client;
    return client;
}

let messageSeq = 0;
/** A message whose content reads are counted (no filter may run where automod is off). */
function fakeMessage(guild, text, { authorId = 'u1', channelId = 'c1' } = {}) {
    messageSeq += 1;
    const reads = { content: 0 };
    const sent = [];
    const member = {
        id: authorId, guild, joinedTimestamp: Date.now() - 100 * DAY,
        permissions: { has: () => false }, roles: { cache: new Map() }, client: guild.client,
    };
    const message = {
        id: `m${messageSeq}`, guild, guildId: guild.id, channelId, url: `https://discord.com/channels/${guild.id}/${channelId}/m${messageSeq}`,
        get content() { reads.content += 1; return text; },
        author: { id: authorId, bot: false, username: 'amy', createdTimestamp: Date.now() - 400 * DAY },
        member,
        mentions: { users: new Map(), roles: new Map() },
        attachments: new Map(),
        client: guild.client,
        channel: { id: channelId, name: 'general', isThread: () => false, send: async (p) => { sent.push(p); return { delete: async () => {} }; } },
        delete: async () => { message.deleted = true; },
        reads, sent,
    };
    return message;
}

function recordingDeps() {
    const calls = [];
    const rec = (name, value) => async (...args) => { calls.push({ name, args }); return value; };
    setAutomodDepsForTest({
        countOffences: rec('countOffences', 0),
        applyStep: rec('applyStep', { record: { case_code: 'abc2345' } }),
        postReviewCard: rec('postReviewCard', null),
        noteRepeatHit: rec('noteRepeatHit', null),
        deleteQuietly: rec('deleteQuietly', null),
        isRaidJoiner: rec('isRaidJoiner', false),
        giveSecondChance: rec('giveSecondChance', false),
        giveHeadsUp: rec('giveHeadsUp', false),
        noteIncidentEvent: rec('noteIncidentEvent', 'inactive'),
    });
    return calls;
}

// ── defaults ──────────────────────────────────────────────────────────────

test('defaults: the main server keeps the old ones; any other server (support too) starts off', () => {
    for (const home of [normalizeSettings(null), normalizeSettings(null, MAIN), normalizeSettings({}, MAIN)]) {
        assert.equal(home.enabled, true);
        assert.equal(home.staffGuard, true);
        assert.deepEqual(home.defaultOffRules, []);
        assert.equal(ruleMode(home, 'english'), 'on');
        assert.equal(ruleMode(home, 'characters'), 'on');
    }
    for (const id of [OTHER, SUPPORT]) {
        const other = normalizeSettings(null, id);
        assert.equal(other.enabled, false, id);
        assert.equal(other.staffGuard, false, id);
        assert.deepEqual(other.inviteAllowlist, []);
        // Mewvo's English-only house rules are off there unless set; the rest follow the global mode.
        assert.equal(ruleMode(other, 'english'), 'off');
        assert.equal(ruleMode(other, 'characters'), 'off');
        assert.equal(ruleMode(other, 'caps'), 'on');
        assert.equal(ruleMode(other, 'scam'), 'on');
    }
});

test('defaults: a stored value always wins (main server off stays off, another server on stays on)', () => {
    assert.equal(normalizeSettings({ enabled: false }, MAIN).enabled, false);
    const other = normalizeSettings({ enabled: true, staffGuard: true, ruleModes: { english: 'on', characters: 'monitor' } }, OTHER);
    assert.equal(other.enabled, true);
    assert.equal(other.staffGuard, true);
    assert.equal(ruleMode(other, 'english'), 'on');
    assert.equal(ruleMode(other, 'characters'), 'monitor');
    // A channel exception still applies to a rule that is off by default.
    assert.equal(resolveRuleMode({ ...normalizeSettings(null, OTHER), channelRules: { c9: { english: 'monitor' } } }, 'english', { id: 'c9' }), 'monitor');
});

test('defaults: saved settings of another server keep "off" and never store the derived fields', async () => {
    setup();
    assert.equal((await getAutomodSettings(OTHER)).enabled, false, 'nothing stored: off');
    await updateAutomodSettings(OTHER, { mode: 'monitor' });
    const stored = await db.get(`automod:settings:${OTHER}`);
    assert.equal(stored.enabled, false);
    assert.equal(stored.staffGuard, false);
    assert.equal(Object.hasOwn(stored, 'defaultOffRules'), false);
    const on = await setAutomodEnabled(OTHER, true);
    assert.equal(on.enabled, true);
    assert.deepEqual(on.defaultOffRules, ['english', 'characters']);
    assert.equal((await setStaffGuard(OTHER, true)).staffGuard, true);
    assert.equal((await getAutomodSettings(MAIN)).enabled, true, 'main server: nothing stored, on as before');
});

// ── moderateMessage ───────────────────────────────────────────────────────

test('another server with automod off (or never set up): no filter runs, nothing logged, no state', async () => {
    setup();
    const calls = recordingDeps();
    const guild = fakeGuild(OTHER);
    fakeClient([guild]);
    const message = fakeMessage(guild, 'free nitro https://dlscord-gift.com/claim discord.gg/abcdef');
    let result;
    const logs = await captureLogs(async () => { result = await moderateMessage(message); });
    assert.equal(result, false);
    assert.equal(message.reads.content, 0, 'the message text was never read');
    assert.deepEqual(calls, []);
    assert.deepEqual(logs, []);
    assert.deepEqual(Object.values(automodStateSizes()), [0, 0, 0, 0, 0, 0, 0]);

    // Turned off explicitly: the same.
    await updateAutomodSettings(OTHER, { enabled: false });
    assert.equal(await moderateMessage(fakeMessage(guild, 'free nitro https://dlscord-gift.com/claim')), false);
    assert.deepEqual(calls, []);
});

test('another server with automod on: the message is checked and acted on in that server', async () => {
    setup();
    const calls = recordingDeps();
    const guild = fakeGuild(OTHER);
    fakeClient([guild]);
    await turnOn(OTHER);
    const message = fakeMessage(guild, 'free nitro https://dlscord-gift.com/claim');
    assert.equal(await moderateMessage(message), true);
    const step = calls.find((c) => c.name === 'applyStep');
    assert.ok(step, 'punished');
    assert.equal(step.args[0].guild.id, OTHER);
    assert.equal(step.args[0].rule, 'scam');
    assert.ok(calls.find((c) => c.name === 'deleteQuietly'));
});

test('another server: "English only" is off by default; the main server keeps it', async () => {
    setup();
    const calls = recordingDeps();
    const other = fakeGuild(OTHER);
    const main = fakeGuild(MAIN);
    fakeClient([other, main]);
    await turnOn(OTHER);
    const text = 'Labas, kaip sekasi? Šiandien labai graži diena ir visi esame laimingi kartu čia.';
    assert.equal(await moderateMessage(fakeMessage(other, text)), false);
    assert.deepEqual(calls.filter((c) => c.name === 'applyStep'), [], 'nothing done in the other server');
    await moderateMessage(fakeMessage(main, text));
    assert.ok(calls.some((c) => c.name === 'applyStep' || c.name === 'postReviewCard' || c.name === 'giveSecondChance'), 'main server still enforces English only');
});

// ── invites ───────────────────────────────────────────────────────────────

test('invite filter: own server allowed, Mewvo servers foreign elsewhere, allowlist by id or code', () => {
    // Another server: its own invites only (and its allowlist).
    assert.equal(inviteGuildIsForeign(OTHER, { guildId: OTHER }), false);
    assert.equal(inviteGuildIsForeign(MAIN, { guildId: OTHER }), true, 'Mewvo main is advertising elsewhere');
    assert.equal(inviteGuildIsForeign(SUPPORT, { guildId: OTHER }), true, 'Mewvo support is advertising elsewhere');
    assert.equal(inviteGuildIsForeign(THIRD, { guildId: OTHER }), true);
    assert.equal(inviteGuildIsForeign(THIRD, { guildId: OTHER, allowlist: [THIRD] }), false);
    assert.equal(inviteGuildIsForeign(THIRD, { guildId: OTHER, allowlist: ['PartnerCode'], code: 'partnercode' }), false);
    assert.equal(inviteGuildIsForeign(THIRD, { guildId: OTHER2, allowlist: [] }), true, 'another server\'s allowlist does not apply');
    assert.equal(inviteGuildIsForeign(null, { guildId: OTHER }), false, 'unresolved code advertises nothing');
    // Home servers: as before (each other's invites allowed), plus their own allowlist.
    for (const home of [MAIN, SUPPORT, null]) {
        assert.equal(inviteGuildIsForeign(MAIN, { guildId: home }), false);
        assert.equal(inviteGuildIsForeign(SUPPORT, { guildId: home }), false);
        assert.equal(inviteGuildIsForeign(THIRD, { guildId: home }), true);
    }
    assert.equal(inviteGuildIsForeign(THIRD), true, 'no guild: the main server view');
    assert.equal(inviteGuildIsForeign(THIRD, { guildId: MAIN, allowlist: [THIRD] }), false);
});

test('invite filter, live: the vanity code and allowlisted codes need no lookup; foreign invites are hits', async () => {
    setup();
    const calls = recordingDeps();
    const lookups = [];
    const guild = fakeGuild(OTHER, { vanityURLCode: 'OurPlace' });
    fakeClient([guild], {
        fetchInvite: async (code) => {
            lookups.push(code);
            return { guild: { id: { ownplace2: OTHER, mewvo: MAIN, spamzone: THIRD }[code] } };
        },
    });
    await turnOn(OTHER, { inviteAllowlist: ['Friends1'] });
    assert.equal(await moderateMessage(fakeMessage(guild, 'join us at discord.gg/OurPlace and discord.gg/friends1', { authorId: 'u3' })), false);
    assert.deepEqual(lookups, [], 'vanity + allowlist: no API call');
    assert.equal(await moderateMessage(fakeMessage(guild, 'second room discord.gg/ownplace2', { authorId: 'u4' })), false, 'another invite to this server');
    assert.deepEqual(calls.filter((c) => c.name === 'applyStep'), []);

    await moderateMessage(fakeMessage(guild, 'come to discord.gg/mewvo', { authorId: 'u5' }));
    const ad = calls.find((c) => c.name === 'applyStep');
    assert.equal(ad?.args[0].rule, 'advertising', 'an invite to Mewvo\'s own server is advertising here');
    assert.deepEqual(lookups, ['ownplace2', 'mewvo']);
});

test('invite allowlist setting: links, codes and ids; add, remove, clear; limits', async () => {
    assert.equal(normalizeInviteEntry('https://discord.gg/AbC-12'), 'AbC-12');
    assert.equal(normalizeInviteEntry('discord.com/invite/xyz99?event=1'), 'xyz99');
    assert.equal(normalizeInviteEntry(` ${THIRD} `), THIRD);
    assert.equal(normalizeInviteEntry('not a code!'), null);
    assert.equal(normalizeInviteEntry(''), null);
    setup();
    let saved = await setInviteAllowlist(OTHER, 'add', 'https://discord.gg/Partner');
    saved = await setInviteAllowlist(OTHER, 'add', THIRD);
    assert.deepEqual(saved.inviteAllowlist, ['Partner', THIRD]);
    saved = await setInviteAllowlist(OTHER, 'remove', 'Partner');
    assert.deepEqual(saved.inviteAllowlist, [THIRD]);
    assert.deepEqual((await setInviteAllowlist(OTHER, 'clear')).inviteAllowlist, []);
    await assert.rejects(setInviteAllowlist(OTHER, 'add', '%%%'), /invite link, an invite code or a server id/);
    await assert.rejects(setInviteAllowlist(OTHER, 'nope', 'x'), /Unknown action/);
    for (let i = 0; i < INVITE_ALLOWLIST_MAX; i += 1) await setInviteAllowlist(OTHER, 'add', `code${i}`);
    await assert.rejects(setInviteAllowlist(OTHER, 'add', 'onemore'), /at most/);
    assert.deepEqual((await getAutomodSettings(OTHER2)).inviteAllowlist, [], 'per server');
    assert.equal(normalizeSettings({ inviteAllowlist: ['ok1', 'ok1', '!!', 5] }, OTHER).inviteAllowlist.length, 1);
});

// ── per-server keys ───────────────────────────────────────────────────────

function fakeKv() {
    const store = new Map();
    return {
        store,
        kvGet: async (key) => (store.has(key) ? structuredClone(store.get(key)) : null),
        kvSet: async (key, value) => { store.set(key, structuredClone(value)); return true; },
        kvDelete: async (key) => { store.delete(key); return true; },
        kvUpdate: async (key, mutator) => {
            const next = await mutator(store.has(key) ? structuredClone(store.get(key)) : null);
            store.set(key, structuredClone(next));
            return next;
        },
        kvList: async (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)),
    };
}

function slowChannel(guild, id) {
    const channel = {
        id, guild, guildId: guild.id, rateLimitPerUser: 0, isThread: () => false,
        setRateLimitPerUser: async (seconds) => { channel.rateLimitPerUser = seconds; },
        send: async () => null,
    };
    guild.channels.cache.set(id, channel);
    return channel;
}

test('auto slowmode: one key per server; lifting one server never rewrites another', async () => {
    const kv = fakeKv();
    slow.setAutoSlowmodeDepsForTest(kv);
    const a = fakeGuild(OTHER);
    const b = fakeGuild(OTHER2);
    const client = fakeClient([a, b]);
    const ca = slowChannel(a, 'ca');
    const cb = slowChannel(b, 'cb');
    assert.equal(await slow.startSlowmode(ca), 'started');
    assert.equal(await slow.startSlowmode(cb), 'started');
    assert.deepEqual(Object.keys(kv.store.get(`automod:slowmode:${OTHER}`)), ['ca']);
    assert.deepEqual(Object.keys(kv.store.get(`automod:slowmode:${OTHER2}`)), ['cb']);
    assert.equal(kv.store.has('automod:slowmode'), false, 'no shared key');

    const realNow = Date.now;
    try {
        Date.now = () => realNow() + 4 * 60 * 1000;
        // b busy again just now: only a is calm.
        const state = await slow.startSlowmode(cb);
        assert.equal(state, 'extended');
        await slow.liftCalmSlowmodes(client);
    } finally {
        Date.now = realNow;
    }
    assert.equal(ca.rateLimitPerUser, 0);
    assert.equal(cb.rateLimitPerUser, 5);
    assert.equal(kv.store.has(`automod:slowmode:${OTHER}`), false, 'empty server key deleted');
    assert.ok(kv.store.get(`automod:slowmode:${OTHER2}`).cb);
});

test('auto slowmode: after a restart the per-server keys and the old single key are picked up', async () => {
    const kv = fakeKv();
    const old = Date.now() - 10 * 60 * 1000;
    kv.store.set('automod:slowmode', { cl: { guildId: OTHER, since: old, lastBusy: old, reason: 'x' } });
    kv.store.set(`automod:slowmode:${OTHER2}`, { cn: { guildId: OTHER2, since: old, lastBusy: old, reason: 'x' } });
    slow.setAutoSlowmodeDepsForTest(kv);
    const a = fakeGuild(OTHER);
    const b = fakeGuild(OTHER2);
    const client = fakeClient([a, b]);
    const cl = slowChannel(a, 'cl');
    const cn = slowChannel(b, 'cn');
    cl.rateLimitPerUser = 5;
    cn.rateLimitPerUser = 5;
    await slow.liftCalmSlowmodes(client);
    assert.equal(cl.rateLimitPerUser, 0, 'legacy entry lifted');
    assert.equal(cn.rateLimitPerUser, 0, 'per-server entry lifted');
    assert.deepEqual(kv.store.get('automod:slowmode'), {}, 'old key emptied');
    assert.equal(kv.store.has(`automod:slowmode:${OTHER}`), false);
    assert.equal(kv.store.has(`automod:slowmode:${OTHER2}`), false);
});

test('auto slowmode tracking: a server with automod off is not even counted; channel list bounded', async () => {
    setup();
    slow.setAutoSlowmodeDepsForTest(fakeKv());
    const guild = fakeGuild(OTHER);
    fakeClient([guild]);
    const channel = slowChannel(guild, 'busy');
    const msg = (i) => ({ guildId: OTHER, author: { id: `u${i % 4}`, bot: false }, channel, client: guild.client });
    for (let i = 0; i < 20; i += 1) await slow.trackChannelActivity(msg(i));
    assert.equal(slow.autoSlowmodeStateSizes().recent, 0);
    assert.equal(channel.rateLimitPerUser, 0);
    await turnOn(OTHER);
    for (let i = 0; i < 20; i += 1) await slow.trackChannelActivity(msg(i));
    assert.equal(channel.rateLimitPerUser, 5, 'automod on: slowmode set');
    const map = new BoundedMap(slow.RECENT_CHANNELS_MAX);
    for (let i = 0; i < slow.RECENT_CHANNELS_MAX + 50; i += 1) map.set(`c${i}`, []);
    assert.equal(map.size, slow.RECENT_CHANNELS_MAX);
});

test('heads-up: one index per server; the per-minute check finds both; the old single index still resolves', async () => {
    const kv = fakeKv();
    const now = Date.now();
    const cards = [];
    headsUp.setHeadsUpDepsForTest({
        ...kv,
        sendDm: async () => true,
        postReviewCard: async (p) => { cards.push(p); return { id: `card${cards.length}`, channelId: 'review' }; },
        closeCard: async () => null,
        isRaidJoiner: async () => false,
        now: () => now,
    });
    const hit = { rule: 'disrespect', evidence: 'insulted someone', detail: 'x', mode: 'on' };
    for (const [guildId, id] of [[OTHER, 'ma'], [OTHER2, 'mb']]) {
        const message = { id, guildId, channelId: 'c1', url: 'u', guild: { id: guildId, name: 'S' }, author: { id: 'u1' }, channel: { name: 'g' } };
        assert.equal(await headsUp.giveHeadsUp(message, hit, { card: {} }), 'pending');
    }
    assert.deepEqual(Object.keys(kv.store.get(headsUp.indexKey(OTHER))), [`${OTHER}:ma`]);
    assert.deepEqual(Object.keys(kv.store.get(headsUp.indexKey(OTHER2))), [`${OTHER2}:mb`]);
    assert.equal(kv.store.has('automod:headsup:index'), false, 'no shared index row');

    // Waiting since before the deploy: in the old single index.
    kv.store.set('automod:headsup:index', { [`${THIRD}:mc`]: { dueAt: now - 1000, rule: 'sexual' } });
    kv.store.set(`automod:headsup:pending:${THIRD}:mc`, { guildId: THIRD, messageId: 'mc', rule: 'sexual' });
    const due = await headsUp.dueHeadsUps(now + 3 * 60 * 1000);
    assert.deepEqual(due.map((d) => d.messageId).sort(), ['ma', 'mb', 'mc']);
    assert.ok(await headsUp.takeHeadsUp(THIRD, 'mc'), 'claimed from the old index');
    assert.deepEqual(kv.store.get('automod:headsup:index'), {});
    assert.ok(await headsUp.takeHeadsUp(OTHER, 'ma'));
    assert.equal(await headsUp.takeHeadsUp(OTHER, 'ma'), null, 'only once');
    assert.ok(kv.store.get(headsUp.indexKey(OTHER2))[`${OTHER2}:mb`], 'the other server untouched');
});

test('digest: hits, open cards and raids are counted per server', () => {
    registry.recordHit({ rule: 'caps', channelId: 'a1', guildId: OTHER });
    registry.recordHit({ rule: 'spam', channelId: 'b1', guildId: OTHER2 });
    registry.recordHit({ rule: 'spam', channelId: 'm1', guildId: MAIN });
    registry.recordEvent('raid', Date.now(), OTHER2);
    const since = Date.now() - 1000;
    const mine = (id) => id === OTHER;
    assert.deepEqual(registry.hitsSince(since, mine).map((h) => h.channelId), ['a1']);
    assert.equal(registry.eventsSince(since, 'raid', mine).length, 0);
    assert.equal(registry.eventsSince(since, 'raid', (id) => id === OTHER2).length, 1);
    assert.deepEqual(registry.activeGuildIds(since).sort(), [MAIN, OTHER, OTHER2].sort());
    const digest = buildDigest({ stats: { total: 0, byGroup: [] }, hits: registry.hitsSince(since, mine), guildId: OTHER });
    assert.match(digest.fields[1].value, /Excessive caps: 1/);
    assert.doesNotMatch(JSON.stringify(digest.fields), /b1|m1/, 'no other server\'s channel');
});

// ── the other guards ──────────────────────────────────────────────────────

function fakeMember(guild, { id = '200000000000000001', displayName = 'amy', avatar = null } = {}) {
    const member = {
        id, guild, client: guild.client, displayName, nickname: null, manageable: true,
        joinedTimestamp: Date.now(),
        user: { id, bot: false, username: displayName, globalName: null, avatar, createdTimestamp: Date.now() - 400 * DAY },
        permissions: { has: () => false },
        roles: { cache: new Map() },
        setNickname: async (name) => { member.renamed = name; },
        send: async () => null,
        kick: async () => { member.kicked = true; },
    };
    return member;
}

test('raid watch: another server only with automod on; state per server and bounded', async () => {
    setup();
    const guild = fakeGuild(OTHER);
    fakeClient([guild]);
    await raid.recordJoin(fakeMember(guild));
    assert.deepEqual(raid.raidStateSizes(), { recentJoins: 0, lockdownCache: 0 }, 'off: not even read');
    await turnOn(OTHER);
    await raid.recordJoin(fakeMember(guild));
    assert.equal(raid.raidStateSizes().recentJoins, 1);
    assert.equal(await raid.raidWatchOn(MAIN), true, 'main server: always, as before');
    assert.equal(await raid.raidWatchOn(SUPPORT), false, 'support server: off until turned on');
});

test('join gate: another server only with automod on; flags go to that server\'s own review channel', async () => {
    setup();
    const sent = [];
    const reviewChannel = { id: OWN_CHANNEL, isTextBased: () => true, send: async (p) => { sent.push(p); return { id: 'line1', channelId: OWN_CHANNEL }; } };
    const guild = fakeGuild(OTHER, { channels: new Map([[OWN_CHANNEL, reviewChannel]]) });
    fakeClient([guild]);
    setSettingsCacheForTests(OTHER, { reviewChannelId: OWN_CHANNEL });
    await updateAutomodSettings(OTHER, { joinGate: { avatar: 'flag' } });
    assert.equal(await checkJoinGate(fakeMember(guild)), null, 'automod off: gate set up but not run');
    await turnOn(OTHER);
    assert.equal(await checkJoinGate(fakeMember(guild)), 'flagged');
    assert.equal(sent.length, 1);
});

test('probation on rejoin: another server only with automod on (no query while off)', async () => {
    const queries = setup();
    const guild = fakeGuild(OTHER);
    fakeClient([guild]);
    assert.equal(await startProbationOnJoin(fakeMember(guild)), null);
    assert.equal(queries.length, 0);
    await turnOn(OTHER);
    assert.equal(await startProbationOnJoin(fakeMember(guild)), null, 'no recent ban');
    const caseQueries = queries.filter((q) => /mod_cases/.test(q.sql));
    assert.equal(caseQueries.length, 2, 'checked the server\'s ban history');
    assert.ok(caseQueries.every((q) => q.params[0] === OTHER));
});

test('staff guard: another server needs automod on AND the staff guard on; the main server as before', async () => {
    setup();
    const other = fakeGuild(OTHER);
    const main = fakeGuild(MAIN);
    fakeClient([other, main]);
    const entry = { action: AuditLogEvent.BotAdd, executorId: '200000000000000099', targetId: '300000000000000099' };
    const logs = await captureLogs(async () => {
        await guard.handleAuditLogEntry(entry, other);
        assert.deepEqual(other.kicked, [], 'nothing set up');
        await turnOn(OTHER);
        await guard.handleAuditLogEntry(entry, other);
        assert.deepEqual(other.kicked, [], 'automod on, staff guard still off');
        await setStaffGuard(OTHER, true);
        await guard.handleAuditLogEntry(entry, other);
        assert.deepEqual(other.kicked, ['300000000000000099']);
        await guard.handleAuditLogEntry(entry, main);
        assert.deepEqual(main.kicked, ['300000000000000099'], 'main server: always on');
    });
    void logs;
    // Unwatched actions never read the settings.
    resetAutomodSettingsCache();
    const third = fakeGuild(THIRD);
    fakeClient([third]);
    db.db.get = async () => { throw new Error('settings must not be read'); };
    await guard.handleAuditLogEntry({ action: AuditLogEvent.MessageDelete, executorId: '2' }, third);
    await assert.rejects(guard.handleAuditLogEntry(entry, third), /must not be read/, 'a watched action does read them');
});

test('impersonation names: another server only with automod on; non-English names left alone by default', async () => {
    setup();
    const other = fakeGuild(OTHER);
    const main = fakeGuild(MAIN);
    fakeClient([other, main]);
    const fancy = '𝓐𝓶𝔂';
    let member = fakeMember(other, { displayName: fancy });
    await memberChecks.checkImpersonation(member);
    assert.equal(member.renamed, undefined, 'automod off');
    await turnOn(OTHER);
    member = fakeMember(other, { displayName: fancy });
    await memberChecks.checkImpersonation(member);
    assert.equal(member.renamed, undefined, '"Non-English characters" off by default there');
    await updateAutomodSettings(OTHER, { enabled: true, ruleModes: { characters: 'on' } });
    member = fakeMember(other, { id: '200000000000000002', displayName: fancy });
    await memberChecks.checkImpersonation(member);
    assert.equal(member.renamed, 'Amy', 'turned on: reset like in the main server');
    member = fakeMember(main, { id: '200000000000000003', displayName: fancy });
    await memberChecks.checkImpersonation(member);
    assert.equal(member.renamed, 'Amy', 'main server unchanged');
});

test('report reactions: another server only with automod on', async () => {
    setup();
    const guild = fakeGuild(OTHER);
    fakeClient([guild]);
    const message = fakeMessage(guild, 'rude text', { authorId: '200000000000000005' });
    const reporters = new Map(['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => [id, { id, bot: false, username: id }]));
    const reaction = {
        emoji: { name: (await import('../../src/config/automod.js')).automodConfig.reportEmoji },
        message, users: { fetch: async () => reporters },
    };
    await captureLogs(() => memberChecks.handleReportReaction(reaction, { bot: false }));
    assert.equal(message.deleted, undefined, 'automod off');
    await turnOn(OTHER);
    await captureLogs(() => memberChecks.handleReportReaction(reaction, { bot: false }));
    assert.equal(message.deleted, true);
});

test('native AutoMod bridge: another server only with automod on (policies not even loaded while off)', async () => {
    const queries = setup();
    const guild = fakeGuild(OTHER);
    fakeClient([guild]);
    guild.autoModerationRules = { fetch: async () => null };
    const { AutoModerationActionType } = await import('discord.js');
    const execution = { guild, action: { type: AutoModerationActionType.BlockMessage }, ruleId: '1', userId: 'u1', user: null };
    await handleNativeExecution(execution);
    assert.equal(queries.length, 0);
    await turnOn(OTHER);
    await captureLogs(() => handleNativeExecution(execution));
    assert.ok(queries.some((q) => /automod_native_rules/.test(q.sql) && q.params[0] === OTHER));
});

test('contest: an automod case of any server can be contested by its member', () => {
    const record = { guild_id: OTHER, target_user_id: '111', reason_key: 'automod:spam', status: 'active', voided_at: null };
    assert.deepEqual(checkContestTarget(record, '111'), { ok: true });
    assert.equal(checkContestTarget(record, '222').ok, false);
    assert.equal(checkContestTarget(record, '111', MAIN).ok, false, 'limited to one server when asked');
});

test('readiness line works for any server the bot is in', async () => {
    setup();
    const guild = fakeGuild(OTHER);
    guild.members.me = { permissions: { has: () => true } };
    const client = fakeClient([guild]);
    assert.equal(await describeAutomodReadiness(client, OTHER), 'off, enforce; all permissions present');
    assert.equal(await describeAutomodReadiness(client, THIRD), 'skipped: the bot is not in that server');
});

// ── bounded state ─────────────────────────────────────────────────────────

test('BoundedMap / BoundedSet: never above the limit, oldest out, re-set keeps a key', () => {
    const map = new BoundedMap(3);
    for (const k of ['a', 'b', 'c']) map.set(k, k);
    map.set('a', 'A');
    map.set('d', 'd');
    assert.deepEqual([...map.keys()], ['c', 'a', 'd']);
    const set = new BoundedSet(2);
    set.add(1); set.add(2); set.add(3);
    assert.deepEqual([...set], [2, 3]);
    assert.throws(() => new BoundedMap(0));
});

test('bounded: settings cache, message history, mood, raid joins, probation, staff guard, reports', async () => {
    setup();
    for (let i = 0; i < 5100; i += 1) await getAutomodSettings(`9${String(i).padStart(17, '0')}`);
    assert.ok(automodSettingsCacheSize() <= 5000, 'settings cache');

    const guild = fakeGuild(OTHER);
    fakeClient([guild]);
    const now = Date.now();
    const member = { joinedTimestamp: now - 100 * DAY, permissions: { has: () => false } };
    for (let i = 0; i < STATE_LIMITS.history + 200; i += 1) {
        await evaluateMessage({
            guildId: OTHER, author: { id: `u${i}`, createdTimestamp: now - 400 * DAY }, channelId: 'c', content: 'hi',
            mentions: { users: new Map(), roles: new Map() }, client: { user: { id: 'bot' } }, guild,
        }, member, now);
    }
    assert.equal(automodStateSizes().history, STATE_LIMITS.history, 'history capped');

    for (let i = 0; i < mood.MOOD_CHANNELS_MAX + 100; i += 1) {
        await mood.noteMoodSignals({ channelId: `c${i}`, author: { id: 'u' } }, [{ rule: 'disrespect' }], { moodAlerts: true }, now);
    }
    assert.ok(mood.moodStateSizes().signals <= mood.MOOD_CHANNELS_MAX, 'mood');

    const reports = new BoundedSet(memberChecks.MEMBER_CHECKS_MAX);
    for (let i = 0; i < memberChecks.MEMBER_CHECKS_MAX + 10; i += 1) reports.add(i);
    assert.equal(reports.size, memberChecks.MEMBER_CHECKS_MAX);
    for (const limit of [raid.RAID_STATE_MAX, guard.GUARD_ACTIVITY_MAX]) assert.ok(Number.isInteger(limit) && limit <= 10000);
});

test('bounded: raid join windows of many servers stay capped', async () => {
    setup();
    const ids = [];
    for (let i = 0; i < raid.RAID_STATE_MAX + 20; i += 1) ids.push(`8${String(i).padStart(17, '0')}`);
    for (const id of ids) await db.set(`automod:settings:${id}`, { enabled: true });
    for (const id of ids) {
        const guild = fakeGuild(id);
        await raid.recordJoin({ id: 'u', guild });
    }
    assert.equal(raid.raidStateSizes().recentJoins, raid.RAID_STATE_MAX);
    assert.ok(raid.raidStateSizes().lockdownCache <= raid.RAID_STATE_MAX);
    void PermissionFlagsBits;
});

test('review cards: a card only reaches cases of its own server (home servers share theirs)', async () => {
    const { recordsFor } = await import('../../src/services/automod/reviewCards.js');
    const { isSameCaseServer } = await import('../../src/services/enforcement/caseService.js');
    const cases = {
        aaa: { case_code: 'aaa', guild_id: OTHER }, bbb: { case_code: 'bbb', guild_id: OTHER2 },
        ccc: { case_code: 'ccc', guild_id: SUPPORT }, ddd: { case_code: 'ddd', guild_id: MAIN },
    };
    // Same contract as caseService.getCaseByCode(code, guildId).
    const lookup = async (code, guildId) => (cases[code] && isSameCaseServer(cases[code].guild_id, guildId) ? cases[code] : null);
    assert.deepEqual((await recordsFor('aaa,bbb', OTHER, lookup)).map((r) => r.case_code), ['aaa']);
    await assert.rejects(recordsFor('bbb', OTHER, lookup), /no longer exists/);
    assert.deepEqual((await recordsFor('ccc,ddd,aaa', MAIN, lookup)).map((r) => r.case_code), ['ccc', 'ddd']);
    // Two non-home servers never reach each other's cases, in either direction, nor the home pair's.
    assert.deepEqual((await recordsFor('aaa,bbb,ccc,ddd', OTHER2, lookup)).map((r) => r.case_code), ['bbb']);
    await assert.rejects(recordsFor('aaa', OTHER2, lookup), /no longer exists/);
    await assert.rejects(recordsFor('ccc,ddd', OTHER, lookup), /no longer exists/);
    // The support server sees the home pair's cases (one shared staff), never another server's.
    assert.deepEqual((await recordsFor('ddd,ccc,aaa,bbb', SUPPORT, lookup)).map((r) => r.case_code), ['ddd', 'ccc']);
});

test('review cards: an action runs in the case\'s own server, with the moderator as a member there', async () => {
    const { actingGuild } = await import('../../src/services/automod/reviewCards.js');
    for (const id of [MAIN, SUPPORT, OTHER, OTHER2]) setSettingsCacheForTests(id, {});
    const admin = (guildId, isAdmin = true) => ({
        id: 'u1', guild: { id: guildId },
        permissions: { has: () => isAdmin, any: () => isAdmin },
        roles: { cache: new Map() },
    });
    const guilds = new Map();
    const fakeGuild = (id, members) => ({
        id, name: `server ${id}`,
        members: { fetch: async (userId) => { const m = members[userId]; if (!m) throw new Error('Unknown Member'); return m; } },
    });
    guilds.set(SUPPORT, fakeGuild(SUPPORT, { u1: admin(SUPPORT) }));
    guilds.set(OTHER2, fakeGuild(OTHER2, { u1: admin(OTHER2) }));
    const click = (guildId) => ({
        guild: { id: guildId }, guildId, member: admin(guildId), user: { id: 'u1' },
        client: { guilds: { cache: guilds } },
    });

    // Same server (or no server named): the clicking server and member, unchanged.
    const own = click(OTHER);
    assert.equal((await actingGuild(own, OTHER)).guild, own.guild);
    assert.equal((await actingGuild(own, null)).moderator, own.member);
    // Two non-home servers: refused both ways, even when the admin is an Administrator in both.
    await assert.rejects(actingGuild(click(OTHER), OTHER2), /another server/);
    guilds.set(OTHER, fakeGuild(OTHER, { u1: admin(OTHER) }));
    await assert.rejects(actingGuild(click(OTHER2), OTHER), /another server/);
    // Non-home ↔ home: refused both ways.
    await assert.rejects(actingGuild(click(OTHER), MAIN), /another server/);
    await assert.rejects(actingGuild(click(MAIN), OTHER), /another server/);
    // A main-server card about a support member: runs in the support server, as that member there.
    const fromMain = await actingGuild(click(MAIN), SUPPORT);
    assert.equal(fromMain.guild.id, SUPPORT);
    assert.equal(fromMain.moderator.guild.id, SUPPORT);
    // ...only when the moderator is an Administrator there too.
    guilds.set(SUPPORT, fakeGuild(SUPPORT, { u1: admin(SUPPORT, false) }));
    await assert.rejects(actingGuild(click(MAIN), SUPPORT), /Administrator permission in server/);
    guilds.set(SUPPORT, fakeGuild(SUPPORT, {}));
    await assert.rejects(actingGuild(click(MAIN), SUPPORT), /Administrator permission in server/);
    guilds.delete(SUPPORT);
    await assert.rejects(actingGuild(click(MAIN), SUPPORT), /no longer in the server/);
    resetSettingsCacheForTests();
});

test('review cards: the "apply" select names the member\'s server', async () => {
    const { buildCardPayload } = await import('../../src/services/automod/reviewFormat.js');
    const ids = (entry) => JSON.stringify(buildCardPayload(entry).components);
    const base = { kind: 'monitor', rule: 'spam', userId: '111', actions: [], hits: [], tier: 'full', evidence: 'x', at: Date.now() };
    assert.match(ids({ ...base, guildId: SUPPORT }), new RegExp(`amreview:apply:spam:111:${SUPPORT}`));
    assert.match(ids(base), /amreview:apply:spam:111"/);
});

test('review, join gate and raid release buttons: no main-server-only guard left, administrators still required', async () => {
    const { readFileSync } = await import('node:fs');
    for (const name of ['automodReview', 'joinGateButtons', 'raidRelease']) {
        const text = readFileSync(new URL(`../../src/handlers/${name}.js`, import.meta.url), 'utf8');
        assert.doesNotMatch(text, /mainGuildId/, name);
        assert.match(text, /!interaction\.guildId \|\| !isAdministrator\(interaction\.member\)/, name);
    }
});

test('/automod works in every server: each server changes only its own settings; staffguard toggle', async () => {
    setup();
    const { default: automodCommand } = await import('../../src/commands/Enforcement/automod.js');
    const run = async (guildId, sub, options = {}) => {
        const replies = [];
        const guild = guildId ? { ...fakeGuild(guildId), members: { me: { permissions: { has: () => true } }, cache: new Map() } } : null;
        const interaction = {
            id: `i${Math.random()}`, createdTimestamp: Date.now(), guildId, guild,
            user: { id: 'admin', username: 'admin' },
            member: { id: 'admin', permissions: { has: () => true, any: () => true }, roles: { cache: new Map() } },
            options: {
                getSubcommand: () => sub, getSubcommandGroup: () => null,
                getBoolean: (name) => options[name] ?? null, getString: (name) => options[name] ?? null,
                getInteger: (name) => options[name] ?? null, getChannel: () => null, getRole: () => null,
            },
            deferReply: async () => { interaction.deferred = true; },
            editReply: async (payload) => { replies.push(payload); return payload; },
            reply: async (payload) => { replies.push(payload); return payload; },
        };
        await automodCommand.execute(interaction);
        return JSON.stringify(replies);
    };
    assert.match(await run(OTHER, 'staffguard', { enabled: true }), /Staff guard is \*\*on\*\*.*automod enable/);
    assert.equal((await getAutomodSettings(OTHER)).staffGuard, true);
    assert.equal((await getAutomodSettings(OTHER2)).staffGuard, false, 'another server is untouched');
    assert.match(await run(OTHER2, 'enable', { enabled: true }), /Automod/);
    assert.equal((await getAutomodSettings(OTHER2)).enabled, true);
    assert.equal((await getAutomodSettings(OTHER)).enabled, false, 'another server is untouched');
    await assert.rejects(run(MAIN, 'staffguard', { enabled: false }), /always on in this server/);
    await assert.rejects(run(null, 'status'), (error) => /Use this command in a server/.test(error.userMessage));
});

test('join gate: a "Verify with Discord" counts only in its own server (the home pair counts as one)', async () => {
    const { verificationScope } = await import('../../src/services/automod/joinGate.js');
    assert.deepEqual(verificationScope(MAIN), [MAIN, SUPPORT]);
    assert.deepEqual(verificationScope(SUPPORT), [MAIN, SUPPORT]);
    assert.deepEqual(verificationScope(OTHER), [OTHER]);
    assert.deepEqual(verificationScope(OTHER2), [OTHER2]);
});
