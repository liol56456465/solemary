// Home servers (docs/home-servers.md): the id config and its test-mode safety, the role mirror
// (add / remove / no loop / hierarchy skip / unknown main state), the 5-minute health message
// (built within limits, edited instead of re-posted) and /database profile (owner only, its
// sections, no secrets, auto-delete in the profile channel only). Fakes only; nothing connects.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';

const {
    REAL_GUILDS, REAL_CHANNELS, REAL_MIRROR_RULES, REAL_IDS, homeServers, homeServerTestModeErrors, parseMirrorRules, unsetMirrorRules,
    DEFAULT_OWNER_TOOLS_GUILD_ID: HOME_DEFAULT,
} = await import('../src/config/homeServers.js');
const { DEFAULT_OWNER_TOOLS_GUILD_ID } = await import('../src/config/ownerTools.js');
const mirror = await import('../src/services/homeServers/roleMirror.js');
const health = await import('../src/services/homeServers/healthReport.js');
const { PROFILE_SECTIONS, createDatabaseLookup, createPageStore, paginate } = await import('../src/services/owner/databaseLookup.js');
const { runDatabaseCommand, isProfileChannel, PROFILE_DELETE_MS } = await import('../src/commands/Owner/database.js');
const { default: databaseCommand } = await import('../src/commands/Owner/database.js');
const { OWNER_TOOLS_REFUSAL } = await import('../src/utils/commandGate.js');
const { botConfig } = await import('../src/config/bot.js');
const { recordCronRun, recordCronSkip, cronStatsSnapshot, resetCronStats } = await import('../src/utils/cronStats.js');

const PROD = {}; // NODE_ENV not "test": the real ids
const MAIN = REAL_GUILDS.main;
const SUPPORT = REAL_GUILDS.support;
const DATABASE = REAL_GUILDS.database;
const SRC_A = '1527697154926182498'; // → support 1564363263402184885
const SRC_ADMIN = '1527697154943225980'; // → database 1569108491380072581 (support rule UNSET)
const SRC_TOP = '1527697154943225982'; // → support 1564362821071016080 + database 1569108245241536613
const T_A = '1564363263402184885';
const T_DB_ADMIN = '1569108491380072581';
const T_TOP_SUPPORT = '1564362821071016080';
const T_TOP_DB = '1569108245241536613';
const OTHER_ROLE = '1564363121685176320'; // the Banned role: never touched by the mirror
const USER = '1777777777777777771';

function quietLog() {
    const lines = [];
    const push = (level) => (message, meta) => lines.push({ level, message, meta });
    return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

// ── Config ───────────────────────────────────────────────────────────────

test('config: the three real servers, the two channels, one place; owner tools reuse the id', () => {
    const real = homeServers(PROD);
    assert.deepEqual(real.guilds, { main: '1527697154926182492', support: '1564312871976829009', database: '1564332751170044186' });
    assert.deepEqual(real.channels, { health: '1569108216372269217', profile: '1564332757029490851' });
    assert.equal(DEFAULT_OWNER_TOOLS_GUILD_ID, HOME_DEFAULT);
    assert.equal(DEFAULT_OWNER_TOOLS_GUILD_ID, REAL_GUILDS.database);
    assert.equal(real.mirrorRules.length, 6);
});

test('config: the owner\'s 18-digit role id is an UNSET entry, reported once', () => {
    const unset = unsetMirrorRules(PROD);
    assert.equal(unset.length, 1);
    assert.equal(unset[0].given, '156436291527508386');
    assert.equal(unset[0].guild, 'support');
    mirror.resetRoleMirrorState();
    const log = quietLog();
    assert.equal(mirror.logUnsetRulesOnce({ env: PROD, log }), 1);
    assert.equal(mirror.logUnsetRulesOnce({ env: PROD, log }), 0, 'only once per process');
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0].message, /156436291527508386/);
});

test('test mode: no real id is ever used; unset env = feature off; real ids in env refused', () => {
    const off = homeServers({ NODE_ENV: 'test' });
    assert.deepEqual(off.guilds, { main: null, support: null, database: null });
    assert.deepEqual(off.channels, { health: null, profile: null });
    assert.deepEqual(off.mirrorRules, []);

    const sneaky = homeServers({
        NODE_ENV: 'test', MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, HOME_DATABASE_GUILD_ID: DATABASE,
        HOME_HEALTH_CHANNEL_ID: REAL_CHANNELS.health, HOME_PROFILE_CHANNEL_ID: REAL_CHANNELS.profile,
        HOME_ROLE_MIRROR: `${SRC_A}>${T_A}@support`,
    });
    assert.deepEqual(sneaky.guilds, { main: null, support: null, database: null });
    assert.deepEqual(sneaky.channels, { health: null, profile: null });
    assert.deepEqual(sneaky.mirrorRules, []);

    const testEnv = {
        NODE_ENV: 'test', MAIN_GUILD_ID: '200000000000000001', SUPPORT_GUILD_ID: '200000000000000002', HOME_DATABASE_GUILD_ID: '200000000000000003',
        HOME_HEALTH_CHANNEL_ID: '200000000000000004', HOME_PROFILE_CHANNEL_ID: '200000000000000005',
        HOME_ROLE_MIRROR: '300000000000000001,300000000000000002>300000000000000003@support; 300000000000000004>300000000000000005@database',
    };
    const ok = homeServers(testEnv);
    assert.equal(ok.guilds.database, '200000000000000003');
    assert.equal(ok.channels.health, '200000000000000004');
    assert.equal(ok.mirrorRules.length, 2);
    assert.deepEqual(ok.mirrorRules[0].sources, ['300000000000000001', '300000000000000002']);
    for (const id of [...Object.values(ok.guilds), ...Object.values(ok.channels), ...ok.mirrorRules.flatMap((r) => [...r.sources, r.target])]) {
        assert.ok(!REAL_IDS.has(id));
    }
});

test('test mode: validateTestMode errors for real HOME_* ids and the real database server in TEST_GUILD_IDS', () => {
    assert.deepEqual(homeServerTestModeErrors({ NODE_ENV: 'test' }), []);
    const errors = homeServerTestModeErrors({
        HOME_DATABASE_GUILD_ID: DATABASE, HOME_HEALTH_CHANNEL_ID: REAL_CHANNELS.health,
        HOME_ROLE_MIRROR: `${SRC_A}>300000000000000003@support`, TEST_GUILD_IDS: `200000000000000001,${DATABASE}`,
    });
    assert.equal(errors.length, 4);
    assert.ok(errors.some((e) => /TEST_GUILD_IDS/.test(e)));
});

test('parseMirrorRules: bad rules dropped with a problem line', () => {
    const { rules, problems } = parseMirrorRules('nonsense; 300000000000000001>300000000000000002@elsewhere; 300000000000000001>300000000000000002@database');
    assert.equal(rules.length, 1);
    assert.equal(problems.length, 2);
});

// ── Role mirror fakes ────────────────────────────────────────────────────

function fakeRole(id, position, extra = {}) {
    return { id, name: `role-${id.slice(-4)}`, position, managed: false, ...extra };
}

function fakeGuild(id, { roles = [], botPosition = 100, manageRoles = true } = {}) {
    const guild = { id, name: `guild-${id.slice(-4)}` };
    const roleCache = new Map(roles.map((r) => [r.id, { ...r, guild }]));
    guild.roles = { cache: roleCache, fetch: async (rid) => roleCache.get(rid) ?? null };
    const me = {
        id: 'bot', permissions: { has: () => manageRoles },
        roles: { highest: { name: 'Mewvo', position: botPosition } },
    };
    const memberCache = new Map();
    guild.members = {
        cache: memberCache, me,
        fetchMe: async () => me,
        fetch: async (uid) => {
            if (typeof uid !== 'string') return memberCache;
            const member = memberCache.get(uid);
            if (!member) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
            return member;
        },
    };
    guild.memberCount = 0;
    return guild;
}

function fakeMember(guild, id, roleIds = [], client = null, calls = []) {
    const cache = new Map(roleIds.map((r) => [r, { id: r }]));
    const member = {
        id, guild, client, user: { id, bot: false }, partial: false,
        roles: {
            cache,
            add: async (roleId, reason) => { calls.push(['add', guild.id, roleId, reason]); cache.set(roleId, { id: roleId }); },
            remove: async (roleId, reason) => { calls.push(['remove', guild.id, roleId, reason]); cache.delete(roleId); },
        },
    };
    guild.members.cache.set(id, member);
    guild.memberCount = guild.members.cache.size;
    return member;
}

/** main + support + database with all target roles below the bot. */
function world({ supportBot = 100, manageRoles = true } = {}) {
    const calls = [];
    const main = fakeGuild(MAIN);
    const support = fakeGuild(SUPPORT, { roles: [fakeRole(T_A, 5), fakeRole(T_TOP_SUPPORT, 6), fakeRole('1564363269765079070', 7), fakeRole(OTHER_ROLE, 8)], botPosition: supportBot, manageRoles });
    const database = fakeGuild(DATABASE, { roles: [fakeRole(T_DB_ADMIN, 5), fakeRole(T_TOP_DB, 6)] });
    const client = { guilds: { cache: new Map([[MAIN, main], [SUPPORT, support], [DATABASE, database]]) } };
    return { calls, main, support, database, client };
}

beforeEach(() => mirror.resetRoleMirrorState());

test('mirror: a source role in main adds the target roles; the reason is "Mewvo role mirror"', async () => {
    const w = world();
    const mainMember = fakeMember(w.main, USER, [SRC_TOP], w.client, w.calls);
    fakeMember(w.support, USER, [], w.client, w.calls);
    fakeMember(w.database, USER, [], w.client, w.calls);
    const result = await mirror.syncMirrorForUser(w.client, USER, { mainMember, env: PROD, log: quietLog() });
    assert.equal(result.added, 2);
    assert.deepEqual(w.calls.map((c) => c.slice(0, 3)).sort(), [['add', DATABASE, T_TOP_DB], ['add', SUPPORT, T_TOP_SUPPORT]].sort());
    assert.ok(w.calls.every((c) => c[3] === 'Mewvo role mirror'));
});

test('mirror: any of the four admin-tier roles gives the database role; the UNSET support rule does nothing', async () => {
    const w = world();
    const mainMember = fakeMember(w.main, USER, ['1527697154943225977'], w.client, w.calls);
    fakeMember(w.support, USER, [], w.client, w.calls);
    fakeMember(w.database, USER, [], w.client, w.calls);
    await mirror.syncMirrorForUser(w.client, USER, { mainMember, env: PROD, log: quietLog() });
    assert.deepEqual(w.calls.map((c) => c.slice(0, 3)), [['add', DATABASE, T_DB_ADMIN]]);
});

test('mirror: no source role any more → only the managed roles are removed; other roles stay', async () => {
    const w = world();
    const mainMember = fakeMember(w.main, USER, [], w.client, w.calls);
    const supportMember = fakeMember(w.support, USER, [T_A, T_TOP_SUPPORT, OTHER_ROLE], w.client, w.calls);
    await mirror.syncMirrorForUser(w.client, USER, { mainMember, env: PROD, log: quietLog() });
    assert.deepEqual(w.calls.map((c) => c.slice(0, 3)).sort(), [['remove', SUPPORT, T_A], ['remove', SUPPORT, T_TOP_SUPPORT]].sort());
    assert.ok(supportMember.roles.cache.has(OTHER_ROLE), 'the Banned role (not managed) is untouched');
});

test('mirror: guildMemberUpdate in main with a source change syncs; non-source changes and support/database updates do nothing (no loop)', async () => {
    const w = world();
    const before = fakeMember(w.main, USER, [], w.client, w.calls);
    const oldMember = { ...before, roles: { cache: new Map() } };
    before.roles.cache.set(SRC_A, { id: SRC_A });
    fakeMember(w.support, USER, [], w.client, w.calls);
    await mirror.handleMemberUpdate(oldMember, before, { env: PROD, log: quietLog() });
    assert.deepEqual(w.calls.map((c) => c.slice(0, 3)), [['add', SUPPORT, T_A]]);

    w.calls.length = 0;
    const unrelatedOld = { ...before, roles: { cache: new Map(before.roles.cache) } };
    before.roles.cache.set('1527697154926100000', { id: '1527697154926100000' });
    assert.equal(mirror.handleMemberUpdate(unrelatedOld, before, { env: PROD, log: quietLog() }), null, 'non-source role change ignored');

    // The mirror's own change in support fires guildMemberUpdate there: ignored.
    const supportMember = w.support.members.cache.get(USER);
    const supportOld = { ...supportMember, roles: { cache: new Map() } };
    assert.equal(mirror.handleMemberUpdate(supportOld, supportMember, { env: PROD, log: quietLog() }), null);
    const dbMember = fakeMember(w.database, USER, [T_DB_ADMIN], w.client, w.calls);
    assert.equal(mirror.handleMemberUpdate({ ...dbMember, roles: { cache: new Map() } }, dbMember, { env: PROD, log: quietLog() }), null);
    assert.equal(w.calls.length, 0);
});

test('mirror: hierarchy / Manage Roles problems skip the role and warn once per role per hour', async () => {
    const w = world({ supportBot: 6 }); // T_A (5) is below the bot, T_TOP_SUPPORT (6) is not
    const mainMember = fakeMember(w.main, USER, [SRC_A, SRC_TOP], w.client, w.calls);
    fakeMember(w.support, USER, [], w.client, w.calls);
    const log = quietLog();
    await mirror.syncMirrorForUser(w.client, USER, { mainMember, env: PROD, log, only: 'support' });
    assert.deepEqual(w.calls.map((c) => c.slice(0, 3)), [['add', SUPPORT, T_A]]);
    await mirror.syncMirrorForUser(w.client, USER, { mainMember, env: PROD, log, only: 'support' });
    const warns = log.lines.filter((l) => l.level === 'warn' && l.message.includes(T_TOP_SUPPORT));
    assert.equal(warns.length, 1, 'one warning per role per hour');
    assert.match(warns[0].message, /highest role/);

    const noPerm = world({ manageRoles: false });
    const m2 = fakeMember(noPerm.main, USER, [SRC_A], noPerm.client, noPerm.calls);
    fakeMember(noPerm.support, USER, [], noPerm.client, noPerm.calls);
    const log2 = quietLog();
    await mirror.syncMirrorForUser(noPerm.client, USER, { mainMember: m2, env: PROD, log: log2, only: 'support' });
    assert.equal(noPerm.calls.length, 0);
    assert.ok(log2.lines.some((l) => /Manage Roles/.test(l.message)));
});

test('mirror: joining support gets the roles; leaving main removes them; unknown main state removes nothing', async () => {
    const w = world();
    fakeMember(w.main, USER, [SRC_A], w.client, w.calls);
    const joined = fakeMember(w.support, USER, [], w.client, w.calls);
    await mirror.handleMemberAdd(joined, { env: PROD, log: quietLog() });
    assert.deepEqual(w.calls.map((c) => c.slice(0, 3)), [['add', SUPPORT, T_A]]);

    w.calls.length = 0;
    const leaver = w.main.members.cache.get(USER);
    w.main.members.cache.delete(USER);
    await mirror.handleMemberRemove(leaver, { env: PROD, log: quietLog() });
    assert.deepEqual(w.calls.map((c) => c.slice(0, 3)), [['remove', SUPPORT, T_A]]);

    // Main fetch fails (not "Unknown Member"): nothing is removed.
    const w2 = world();
    fakeMember(w2.support, USER, [T_A], w2.client, w2.calls);
    w2.main.members.fetch = async () => { throw Object.assign(new Error('Service unavailable'), { code: 500 }); };
    const result = await mirror.syncMirrorForUser(w2.client, USER, { env: PROD, log: quietLog() });
    assert.equal(result.skipped, 'main member unknown');
    assert.equal(w2.calls.length, 0);

    // Main server not available at all: nothing happens.
    const w3 = world();
    w3.client.guilds.cache.delete(MAIN);
    fakeMember(w3.support, USER, [T_A], w3.client, w3.calls);
    assert.equal((await mirror.syncMirrorForUser(w3.client, USER, { env: PROD, log: quietLog() })).skipped, 'main server not available');
    assert.equal(w3.calls.length, 0);
});

test('mirror: reconcile is paced, uses the fetch gate, leaves members missing from a partial main list alone, one summary line', async () => {
    const w = world();
    fakeMember(w.main, '1777777777777777001', [SRC_A], w.client, w.calls);
    fakeMember(w.support, '1777777777777777001', [], w.client, w.calls); // needs T_A
    fakeMember(w.support, '1777777777777777002', [T_A], w.client, w.calls); // not in (partial) main list: unknown
    const fetched = [];
    const fetchAll = async (guild) => {
        fetched.push(guild.id);
        return { members: guild.members.cache, partial: guild.id === MAIN, reason: guild.id === MAIN ? 'cooldown' : 'cache' };
    };
    let pauses = 0;
    const log = quietLog();
    const summary = await mirror.reconcileRoleMirror(w.client, { env: PROD, log, fetchAll, sleep: async () => { pauses += 1; } });
    assert.deepEqual(fetched.sort(), [MAIN, SUPPORT, DATABASE].sort());
    assert.equal(summary.added, 1);
    assert.equal(summary.removed, 0, 'the unknown member keeps the role');
    assert.equal(summary.unknown, 1);
    assert.equal(pauses, 1, 'a pause after each member that changed');
    assert.equal(log.lines.filter((l) => l.level === 'info').length, 1);
    assert.match(log.lines.find((l) => l.level === 'info').message, /Role mirror reconcile: scanned 2, added 1, removed 0/);

    // A complete main list: the member without source roles loses the managed role.
    w.calls.length = 0;
    const full = async (guild) => ({ members: guild.members.cache, partial: false, reason: 'cache' });
    const again = await mirror.reconcileRoleMirror(w.client, { env: PROD, log: quietLog(), fetchAll: full, sleep: async () => {} });
    assert.equal(again.removed, 1);
});

test('mirror: test mode with no HOME_ROLE_MIRROR does nothing, even with the real servers in the cache', async () => {
    const w = world();
    const member = fakeMember(w.main, USER, [SRC_A], w.client, w.calls);
    fakeMember(w.support, USER, [], w.client, w.calls);
    const env = { NODE_ENV: 'test' };
    assert.equal(mirror.handleMemberUpdate({ partial: true }, member, { env }), null);
    assert.equal(mirror.handleMemberAdd(w.support.members.cache.get(USER), { env }), null);
    assert.equal(mirror.handleMemberRemove(member, { env }), null);
    assert.equal((await mirror.reconcileRoleMirror(w.client, { env, log: quietLog() })).skipped, 'no rules');
    // Even MAIN_GUILD_ID set to the real main server is refused in test mode.
    assert.equal(mirror.handleMemberUpdate({ partial: true }, member, { env: { ...env, MAIN_GUILD_ID: MAIN, HOME_ROLE_MIRROR: `${SRC_A}>${T_A}@support` } }), null);
    assert.equal(w.calls.length, 0);
});

// ── Health report ────────────────────────────────────────────────────────

function sampleHealth(extra = {}) {
    return {
        at: Date.UTC(2026, 10, 9, 12, 0), uptimeSeconds: 93_784, pingMs: 42, guilds: 3, cachedMembers: 1234,
        heapUsed: 80 * 1024 * 1024, heapTotal: 120 * 1024 * 1024, rss: 200 * 1024 * 1024, loopP99Ms: 12.3,
        db: { status: 'ok', latencyMs: 3.2, sizeBytes: 50 * 1024 * 1024, schema: { version: 12, label: 'baseline-v12' } },
        expectedSchema: 12,
        crons: Array.from({ length: 60 }, (_, i) => ({ name: `job_${String(i).padStart(2, '0')}_${'x'.repeat(30)}`, lastRunAt: Date.now(), lastOkAt: Date.now(), lastFailAt: 0, failures: 0, skipped: 0 })),
        errorsSinceLast: 0, errorTotal: 5, rateLimitsSinceLast: 0, rateLimitTotal: 1,
        sessionStarts: { remaining: 990, total: 1000, reset_after: 3_600_000 },
        env: { nodeEnv: 'production', replitDeployment: true, node: 'v22.23.4' },
        ...extra,
    };
}

test('health: the message has every part, no pings, within embed limits', () => {
    const payload = health.buildHealthMessage(sampleHealth());
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    const json = payload.embeds[0].toJSON();
    const text = JSON.stringify(json);
    for (const part of ['Uptime: 1d 2h 3m', 'Gateway ping: 42 ms', 'Servers: 3', 'cached members: 1234', 'Heap:', 'Event loop p99: 12.3 ms',
        'Status: OK', 'Size: 50.0 MB', 'Schema: v12', 'Errors: 0', 'Rate-limit hits: 0', 'Session starts today: 990 of 1000', 'NODE_ENV: production']) {
        assert.ok(text.includes(part), part);
    }
    assert.ok(json.description.length <= 4096);
    for (const field of json.fields) assert.ok(field.value.length <= 1024);
    const total = json.title.length + json.description.length + json.footer.text.length + json.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    assert.ok(total <= 6000, `total ${total}`);
    assert.match(json.title, /All good/);
});

test('health: failing cron first, database down = Problem, schema mismatch shown', () => {
    const crons = [
        { name: 'a_ok', lastRunAt: 1, lastOkAt: 2, lastFailAt: 0, failures: 0, skipped: 0 },
        { name: 'z_broken', lastRunAt: 3, lastOkAt: 0, lastFailAt: 4, failures: 2, lastError: 'boom', skipped: 1 },
    ];
    const lines = health.cronLines(crons);
    assert.match(lines[0], /^✗ `z_broken`.*2 failed \(boom\).*1 skipped/);
    const down = health.buildHealthMessage(sampleHealth({ db: { status: 'down', latencyMs: null, sizeBytes: null, schema: { version: 11 } } }));
    const json = down.embeds[0].toJSON();
    assert.match(json.title, /Problem/);
    assert.ok(JSON.stringify(json).includes('NOT CONNECTED'));
    assert.ok(JSON.stringify(json).includes('v11 (expected v12)'));
});

function fakeHealthChannel({ editFails = null } = {}) {
    const calls = [];
    const channel = {
        id: '200000000000000004', guildId: '200000000000000003', name: 'health',
        isTextBased: () => true,
        guild: { members: { me: { id: 'bot' } } },
        permissionsFor: () => ({ has: (bits) => Array.isArray(bits) }),
        send: async (payload) => { calls.push(['send', payload]); return { id: `20000000000000${String(calls.length).padStart(4, '0')}0` }; },
        messages: { edit: async (id, payload) => { calls.push(['edit', id, payload]); if (editFails) throw editFails; } },
    };
    const client = { channels: { cache: new Map([[channel.id, channel]]), fetch: async () => null } };
    return { channel, client, calls };
}

const HEALTH_ENV = { NODE_ENV: 'test', HOME_DATABASE_GUILD_ID: '200000000000000003', HOME_HEALTH_CHANNEL_ID: '200000000000000004' };

test('health: posts once, stores the id, then EDITS the same message; a deleted message is posted again', async () => {
    health.resetHealthState();
    const { client, calls } = fakeHealthChannel();
    const store = new Map();
    const kv = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); } };
    const collect = async () => sampleHealth();
    const first = await health.postHealthReport(client, { env: HEALTH_ENV, kv, collect, log: quietLog() });
    assert.equal(first.posted, true);
    assert.equal(store.get(health.HEALTH_MESSAGE_KEY).messageId, first.messageId);
    assert.deepEqual(calls[0][1].allowedMentions, { parse: [] });
    const second = await health.postHealthReport(client, { env: HEALTH_ENV, kv, collect, log: quietLog() });
    assert.equal(second.edited, true);
    assert.equal(calls[1][0], 'edit');
    assert.equal(calls[1][1], first.messageId);
    assert.equal(calls.filter((c) => c[0] === 'send').length, 1, 'one message, edited after that');

    // After a restart: the id comes from the key-value store, still an edit.
    health.resetHealthState();
    const third = await health.postHealthReport(client, { env: HEALTH_ENV, kv, collect, log: quietLog() });
    assert.equal(third.edited, true);

    // Someone deleted it: Unknown Message → a new one, stored.
    health.resetHealthState();
    const gone = fakeHealthChannel({ editFails: Object.assign(new Error('Unknown Message'), { code: 10008 }) });
    const fourth = await health.postHealthReport(gone.client, { env: HEALTH_ENV, kv, collect, log: quietLog() });
    assert.equal(fourth.posted, true);
    assert.deepEqual(gone.calls.map((c) => c[0]), ['edit', 'send']);
    assert.equal(store.get(health.HEALTH_MESSAGE_KEY).messageId, fourth.messageId);
});

test('health: other edit errors do not post a duplicate; no channel in test mode = skipped', async () => {
    health.resetHealthState();
    const store = new Map([[health.HEALTH_MESSAGE_KEY, { channelId: '200000000000000004', messageId: '200000000000009999' }]]);
    const kv = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); } };
    const broken = fakeHealthChannel({ editFails: Object.assign(new Error('Internal'), { code: 0 }) });
    const result = await health.postHealthReport(broken.client, { env: HEALTH_ENV, kv, collect: async () => sampleHealth(), log: quietLog() });
    assert.ok(result.failed);
    assert.equal(broken.calls.filter((c) => c[0] === 'send').length, 0);

    const skipped = await health.postHealthReport(broken.client, { env: { NODE_ENV: 'test' }, kv, log: quietLog() });
    assert.ok(skipped.skipped);
});

test('health: collect counts errors and rate limits since the last report; DB size and schema cached', async () => {
    health.resetHealthState();
    let errorTotal = 3;
    const queries = [];
    const query = async (text) => {
        queries.push(text);
        if (/pg_database_size/.test(text)) return { rows: [{ bytes: '1048576' }] };
        if (/schema_migrations/.test(text)) return { rows: [{ version: 12, label: 'baseline-v12' }] };
        return { rows: [{ '?column?': 1 }] };
    };
    const client = { guilds: { cache: new Map([['1', { members: { cache: new Map([['a', {}], ['b', {}]]) } }]]) }, ws: { ping: 30 } };
    const options = {
        query, dbAvailable: () => true, errors: () => errorTotal, rateLimits: () => 0, crons: () => [],
        fetchLimit: async () => ({ remaining: 999, total: 1000, reset_after: 1000 }), loopP99: () => null, now: () => 1_000_000,
    };
    const h1 = await health.collectHealth(client, options);
    assert.equal(h1.cachedMembers, 2);
    assert.equal(h1.db.sizeBytes, 1048576);
    assert.equal(h1.db.schema.version, 12);
    // Committed by a successful post: the next report shows only new errors.
    const { client: chClient } = fakeHealthChannel();
    await health.postHealthReport(chClient, { env: HEALTH_ENV, kv: { get: async () => null, set: async () => {} }, collect: async () => h1, log: quietLog() });
    errorTotal = 7;
    const h2 = await health.collectHealth(client, options);
    assert.equal(h2.errorsSinceLast, 4);
    assert.equal(queries.filter((q) => /pg_database_size/.test(q)).length, 1, 'size cached for 10 minutes');

    const down = await health.collectHealth(client, { ...options, dbAvailable: () => false });
    assert.equal(down.db.status, 'down');
});

test('cron stats: runs, failures and skips are recorded for the report', () => {
    resetCronStats();
    recordCronRun('health_report', { ok: true, startedAt: 1, endedAt: 2 });
    recordCronRun('health_report', { ok: false, startedAt: 3, endedAt: 4, error: new Error('db down') });
    recordCronSkip('health_report');
    const [job] = cronStatsSnapshot();
    assert.equal(job.runs, 2);
    assert.equal(job.failures, 1);
    assert.equal(job.skipped, 1);
    assert.equal(job.lastError, 'db down');
    resetCronStats();
});

// ── /database profile ────────────────────────────────────────────────────

const OWNER = '1999999999999999991';
const STRANGER = '1999999999999999992';

function withOwners(ids, fn) {
    const saved = botConfig.commands.owners;
    botConfig.commands.owners = ids;
    return Promise.resolve().then(fn).finally(() => { botConfig.commands.owners = saved; });
}

function fakeInteraction({ userId = OWNER, guildId = DATABASE, channelId = '1564332750000000001', subcommand = 'profile', options = { user: USER } } = {}) {
    const calls = [];
    return {
        calls,
        id: '2000000000000000001', createdTimestamp: Date.now(),
        user: { id: userId, username: 'owner' }, guildId, channelId,
        deferred: false, replied: false,
        isChatInputCommand: () => true,
        options: { getSubcommand: () => subcommand, getString: (name) => options[name] ?? null },
        async deferReply(payload) { this.deferred = true; calls.push(['defer', payload]); },
        async reply(payload) { this.replied = true; calls.push(['reply', payload]); },
        async editReply(payload) { calls.push(['edit', payload]); return { id: '2000000000000000777' }; },
        async fetchReply() { return { id: '2000000000000000777' }; },
        async deleteReply() { calls.push(['deleteReply']); },
        async followUp(payload) { calls.push(['followUp', payload]); },
    };
}

function fakeQuery(answer = () => []) {
    const calls = [];
    return { calls, query: async (text, params = []) => { calls.push({ text, params }); return { rows: answer(text, params) }; } };
}

test('profile: the subcommand exists with a user option', () => {
    const json = databaseCommand.data.toJSON();
    const sub = json.options.find((o) => o.name === 'profile');
    assert.ok(sub);
    assert.equal(sub.options[0].name, 'user');
    assert.ok(sub.description.length <= 100);
});

test('profile: every requested section is there; no IP, OAuth, session or secret column is selected', () => {
    const names = PROFILE_SECTIONS.map(([name]) => name);
    for (const wanted of ['Cases against them', 'Warns per server', 'Warn ladder', 'Appeals', 'Watchlist', 'Keep-apart orders', 'Levels / XP',
        'Tickets opened', 'Modmail channels', 'Verification log', 'OAuth verified in', 'Mewvo website account', 'Premium plan', 'Bot blacklist',
        'Staff warnings', 'Staff activity (per week)']) {
        assert.ok(names.includes(wanted), wanted);
    }
    const tables = { ...Object.fromEntries(Object.keys(createTables()).map((k) => [k, k])) };
    const sql = PROFILE_SECTIONS.map(([, build]) => build(tables)).join('\n');
    for (const forbidden of ['verification_ips', 'verification_guild_ips', 'temp_data', 'member_sessions', 'dashboard_sessions', 'password_hash',
        'ip_hash', 'totp_secret', 'recovery', 'access_token', 'refresh_token', 'SELECT *']) {
        assert.ok(!sql.includes(forbidden), `profile selects ${forbidden}`);
    }
    assert.ok(!/\bcode\b,/.test(sql.replace(/case_code|RIGHT\(key_code, 4\)/g, '')), 'no premium code in full');
});

function createTables() {
    return {
        users: 1, mod_cases: 1, mod_ladder: 1, mod_appeals: 1, mod_watchlist: 1, no_contact_orders: 1, user_levels: 1, tickets: 1, modmail_links: 1,
        guilds: 1, verification_audit: 1, oauth_verified_guilds: 1, member_accounts: 1, premium_subscriptions: 1, premium_orders: 1,
        bot_blacklist: 1, staff_warnings: 1, staff_activity: 1,
    };
}

test('profile: owner only; a stranger gets the refusal and nothing is queried', async () => {
    const { query, calls } = fakeQuery();
    const interaction = fakeInteraction({ userId: STRANGER, channelId: REAL_CHANNELS.profile });
    await withOwners([OWNER], () => runDatabaseCommand(interaction, { lookup: createDatabaseLookup({ query }), log: quietLog(), env: PROD }));
    assert.equal(interaction.calls[0][0], 'reply');
    assert.equal(interaction.calls[0][1].content, OWNER_TOOLS_REFUSAL);
    assert.equal(calls.length, 0);
    const elsewhere = fakeInteraction({ guildId: MAIN });
    await withOwners([OWNER], () => runDatabaseCommand(elsewhere, { lookup: createDatabaseLookup({ query }), log: quietLog(), env: PROD }));
    assert.equal(elsewhere.calls[0][1].content, OWNER_TOOLS_REFUSAL);
});

test('profile in the profile channel: visible reply, deleted after 2 minutes; secrets in rows hidden', async () => {
    const { query } = fakeQuery((text) => {
        if (/FROM mod_cases WHERE target_user_id/.test(text) && /case_code/.test(text)) return [{ case_code: 'abc23x', guild_id: MAIN, status: 'active', reason: 'spam', _n: '1' }];
        if (/FROM member_accounts/.test(text)) return [{ account_name: 'kitty', session_token: 'should-not-show', _n: '1' }];
        return [];
    });
    const scheduled = [];
    const interaction = fakeInteraction({ channelId: REAL_CHANNELS.profile });
    await withOwners([OWNER], () => runDatabaseCommand(interaction, {
        lookup: createDatabaseLookup({ query }), log: quietLog(), env: PROD, store: createPageStore(), nonce: () => 'abcdef123456',
        schedule: (fn, ms) => scheduled.push({ fn, ms }),
    }));
    const [, deferPayload] = interaction.calls.find(([kind]) => kind === 'defer');
    assert.ok(!deferPayload?.flags, 'not ephemeral in the profile channel');
    const edit = interaction.calls.find(([kind]) => kind === 'edit')[1];
    assert.deepEqual(edit.allowedMentions, { parse: [] });
    const description = edit.embeds[0].toJSON().description;
    assert.match(description, /abc23x/);
    assert.match(description, /Cases against them/);
    assert.ok(!description.includes('should-not-show'));
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, PROFILE_DELETE_MS);
    assert.equal(PROFILE_DELETE_MS, 120_000);
    await scheduled[0].fn();
    assert.ok(interaction.calls.some(([kind]) => kind === 'deleteReply'));
});

test('profile elsewhere in the database server: ephemeral, no auto-delete; other subcommands never visible', async () => {
    const scheduled = [];
    const schedule = (fn, ms) => scheduled.push({ fn, ms });
    const interaction = fakeInteraction({ channelId: '1564332750000000009' });
    await withOwners([OWNER], () => runDatabaseCommand(interaction, { lookup: createDatabaseLookup({ query: fakeQuery().query }), log: quietLog(), env: PROD, store: createPageStore(), schedule }));
    assert.ok(interaction.calls.find(([kind]) => kind === 'defer')[1].flags, 'ephemeral');
    assert.equal(scheduled.length, 0);

    const user = fakeInteraction({ channelId: REAL_CHANNELS.profile, subcommand: 'user' });
    await withOwners([OWNER], () => runDatabaseCommand(user, { lookup: createDatabaseLookup({ query: fakeQuery().query }), log: quietLog(), env: PROD, store: createPageStore(), schedule }));
    assert.ok(user.calls.find(([kind]) => kind === 'defer')[1].flags, '/database user stays ephemeral in the profile channel');
    assert.equal(scheduled.length, 0);

    assert.equal(isProfileChannel({ guildId: MAIN, channelId: REAL_CHANNELS.profile }, { env: PROD }), false);
    assert.equal(isProfileChannel({ guildId: DATABASE, channelId: REAL_CHANNELS.profile }, { env: { NODE_ENV: 'test' } }), false, 'test mode never uses the real channel');
});

test('profile: the delete falls back to the message id when deleteReply fails', async () => {
    const scheduled = [];
    const deleted = [];
    const interaction = fakeInteraction({ channelId: REAL_CHANNELS.profile });
    interaction.deleteReply = async () => { throw Object.assign(new Error('Invalid Webhook Token'), { code: 50027 }); };
    interaction.channel = { messages: { delete: async (id) => { deleted.push(id); } } };
    await withOwners([OWNER], () => runDatabaseCommand(interaction, {
        lookup: createDatabaseLookup({ query: fakeQuery().query }), log: quietLog(), env: PROD, store: createPageStore(), schedule: (fn) => scheduled.push(fn),
    }));
    await scheduled[0]();
    assert.deepEqual(deleted, ['2000000000000000777']);
});

test('profile: pages fit the embed limits', async () => {
    const { query } = fakeQuery((text) => Array.from({ length: 25 }, (_, i) => ({ case_code: `abc${i}`, reason: 'r'.repeat(200), _n: '40' })));
    const result = await createDatabaseLookup({ query }).profile(USER);
    const { pages, title } = paginate(result);
    assert.match(title, /Profile of/);
    assert.ok(pages.length > 1);
    for (const page of pages) assert.ok(page.length <= 4096);
});
