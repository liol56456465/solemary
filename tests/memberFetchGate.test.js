// The member fetch gate (src/utils/memberFetchGate.js): joining, the 60 s gap, per-caller
// freshness, the global cap of 2, the 90% cache skip, the size cap, the rate-limit path, and
// that every full guild.members.fetch() in src/ goes through it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { GatewayRateLimitError } from '@discordjs/util';
import {
    fetchAllMembers, fullFetchMaxMembers, isGatewayRateLimit, memberFetchGateStats, resetMemberFetchGate,
    MAX_CONCURRENT, MIN_GAP_MS,
} from '../src/utils/memberFetchGate.js';
import { pickRandomMember } from '../src/services/randomMemberService.js';
import { runRoleRules } from '../src/services/members/roleRuleService.js';

beforeEach(() => resetMemberFetchGate());

/** A deferred promise: the test decides when the fake fetch finishes. */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/**
 * A fake guild with `cached` members in the cache and `memberCount` in total. fetch() fills
 * the cache to memberCount; `behave` replaces it (return a promise / throw).
 */
function fakeGuild(id, { memberCount = 100, cached = 0, behave = null } = {}) {
    const cache = new Map();
    const add = (n) => { for (let i = cache.size; i < n; i += 1) cache.set(`m${i}`, { id: `m${i}`, user: { id: `m${i}`, bot: false, username: `u${i}` }, roles: { cache: new Set() } }); };
    add(cached);
    const guild = {
        id, memberCount, calls: [],
        members: {
            cache,
            fetch: async (options) => {
                guild.calls.push(options);
                if (behave) return behave(options);
                add(memberCount);
                return cache;
            },
        },
        roles: { cache: new Map() },
    };
    guild.fill = () => add(memberCount);
    return guild;
}

const clock = (start = 1_000_000) => {
    const c = { t: start, now: () => c.t };
    return c;
};

test('gate: concurrent callers for one guild join the running fetch (one gateway request)', async () => {
    const d = deferred();
    const guild = fakeGuild('1', { behave: () => d.promise });
    const first = fetchAllMembers(guild);
    const second = fetchAllMembers(guild);
    const third = fetchAllMembers(guild);
    await new Promise((r) => setImmediate(r));
    guild.fill();
    d.resolve();
    const results = await Promise.all([first, second, third]);
    assert.equal(guild.calls.length, 1, 'one full fetch');
    assert.deepEqual(guild.calls[0], { time: 15_000 }, 'a full fetch (no user id) with a time limit');
    assert.deepEqual(results.map((r) => [r.fetched, r.partial]), [[true, false], [true, false], [true, false]]);
    assert.equal(results[0].reason, 'fetched');
    assert.equal(results[1].reason, 'fresh', 'joined');
    assert.equal(results[0].members, guild.members.cache);
});

test('gate: at least 60 s between full fetches per guild; per-caller freshness reuses a recent fetch', async () => {
    const c = clock();
    const guild = fakeGuild('2');
    assert.equal((await fetchAllMembers(guild, { now: c.now })).reason, 'fetched');
    guild.members.cache.clear(); // members dropped out of the cache again
    c.t += 30_000;
    let r = await fetchAllMembers(guild, { now: c.now, maxAgeMs: 0 });
    assert.deepEqual([r.reason, r.partial, guild.calls.length], ['fresh', false, 1], 'maxAgeMs is never below 60 s');
    c.t += MIN_GAP_MS;
    r = await fetchAllMembers(guild, { now: c.now, maxAgeMs: 60 * 60_000 });
    assert.deepEqual([r.reason, guild.calls.length], ['fresh', 1], 'a 1 h caller reuses a 90 s old fetch');
    guild.members.cache.clear();
    r = await fetchAllMembers(guild, { now: c.now, maxAgeMs: 60_000 });
    assert.deepEqual([r.reason, guild.calls.length], ['fetched', 2], 'a 60 s caller fetches again');
});

test('gate: a failed fetch is not retried within 60 s; the cache comes back as partial', async () => {
    const c = clock();
    let fail = true;
    const guild = fakeGuild('3', { cached: 10, behave: () => { if (fail) throw new Error('gateway down'); guild.fill(); return guild.members.cache; } });
    let r = await fetchAllMembers(guild, { now: c.now });
    assert.deepEqual([r.reason, r.partial, r.fetched, r.members.size], ['failed', true, false, 10]);
    c.t += 59_000;
    r = await fetchAllMembers(guild, { now: c.now });
    assert.deepEqual([r.reason, r.partial, guild.calls.length], ['cooldown', true, 1]);
    fail = false;
    c.t += 1_000;
    r = await fetchAllMembers(guild, { now: c.now });
    assert.deepEqual([r.reason, r.partial, guild.calls.length], ['fetched', false, 2]);
});

test('gate: at most 2 full fetches at once across guilds; the third waits for a slot', async () => {
    const pending = [deferred(), deferred(), deferred()];
    const guilds = pending.map((d, i) => fakeGuild(`4${i}`, { behave: () => d.promise }));
    const runs = guilds.map((g) => fetchAllMembers(g));
    await new Promise((r) => setImmediate(r));
    assert.equal(MAX_CONCURRENT, 2);
    assert.deepEqual(guilds.map((g) => g.calls.length), [1, 1, 0], 'third guild queued');
    assert.deepEqual(memberFetchGateStats().running, 2);
    assert.equal(memberFetchGateStats().waiting, 1);
    pending[0].resolve();
    await runs[0];
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(guilds.map((g) => g.calls.length), [1, 1, 1], 'slot handed to the waiter');
    pending[1].resolve();
    pending[2].resolve();
    await Promise.all(runs);
    assert.deepEqual(memberFetchGateStats(), { running: 0, waiting: 0, inflight: 0, tracked: 3 });
});

test('gate: a caller that cannot get a slot within waitMs gets the cache as partial (busy)', async () => {
    const pending = [deferred(), deferred()];
    const busy = pending.map((d, i) => fakeGuild(`5${i}`, { behave: () => d.promise }));
    const runs = busy.map((g) => fetchAllMembers(g));
    const late = fakeGuild('59', { cached: 5 });
    const r = await fetchAllMembers(late, { waitMs: 10 });
    assert.deepEqual([r.reason, r.partial, r.members.size, late.calls.length], ['busy', true, 5, 0]);
    pending.forEach((d) => d.resolve());
    await Promise.all(runs);
    assert.equal(memberFetchGateStats().waiting, 0);
});

test('gate: no fetch when the cache already holds >= 90% of memberCount', async () => {
    const guild = fakeGuild('6', { memberCount: 100, cached: 90 });
    const r = await fetchAllMembers(guild);
    assert.deepEqual([r.reason, r.partial, r.fetched, guild.calls.length], ['cache', false, false, 0]);
    const under = fakeGuild('7', { memberCount: 100, cached: 89 });
    assert.equal((await fetchAllMembers(under)).reason, 'fetched');
});

test('gate: refuses a full fetch above FULL_FETCH_MAX_MEMBERS (default 25000) or the caller cap', async () => {
    assert.equal(fullFetchMaxMembers({}), 25_000);
    assert.equal(fullFetchMaxMembers({ FULL_FETCH_MAX_MEMBERS: '1000' }), 1000);
    assert.equal(fullFetchMaxMembers({ FULL_FETCH_MAX_MEMBERS: 'nope' }), 25_000);
    assert.equal(fullFetchMaxMembers({ FULL_FETCH_MAX_MEMBERS: '-5' }), 25_000);
    const big = fakeGuild('8', { memberCount: 25_001, cached: 40 });
    let r = await fetchAllMembers(big);
    assert.deepEqual([r.reason, r.partial, r.members.size, big.calls.length], ['too-large', true, 40, 0]);
    const atCap = fakeGuild('9', { memberCount: 25_000, cached: 0, behave: () => atCap.members.cache });
    assert.equal((await fetchAllMembers(atCap)).reason, 'fetched', '25000 itself is allowed');

    const saved = process.env.FULL_FETCH_MAX_MEMBERS;
    process.env.FULL_FETCH_MAX_MEMBERS = '50';
    try {
        r = await fetchAllMembers(fakeGuild('10', { memberCount: 51 }));
        assert.equal(r.reason, 'too-large', 'env read at call time');
    } finally {
        if (saved === undefined) delete process.env.FULL_FETCH_MAX_MEMBERS; else process.env.FULL_FETCH_MAX_MEMBERS = saved;
    }
    r = await fetchAllMembers(fakeGuild('11', { memberCount: 6_000 }), { maxMembers: 5_000 });
    assert.equal(r.reason, 'too-large', 'caller cap (randomuser)');
});

test('gate: a gateway rate limit = later: cache returned partial, warned once per guild per hour, retried after retry_after', async () => {
    const c = clock();
    const warnings = [];
    const { logger } = await import('../src/utils/logger.js');
    const warn = logger.warn;
    logger.warn = (message) => { warnings.push(String(message)); };
    try {
        let limited = true;
        const guild = fakeGuild('12', { cached: 3, behave: (options) => {
            if (limited) throw new GatewayRateLimitError({ opcode: 8, retry_after: 120, meta: { guild_id: '12' } }, { guild_id: '12', ...options });
            guild.fill();
            return guild.members.cache;
        } });
        let r = await fetchAllMembers(guild, { now: c.now });
        assert.deepEqual([r.reason, r.partial, r.members.size], ['rate-limited', true, 3]);
        c.t += 90_000;
        r = await fetchAllMembers(guild, { now: c.now });
        assert.deepEqual([r.reason, guild.calls.length], ['rate-limited', 1], 'retry_after (120 s) respected, past the 60 s gap');
        c.t += 31_000;
        r = await fetchAllMembers(guild, { now: c.now });
        assert.deepEqual([r.reason, guild.calls.length], ['rate-limited', 2], 'tried again, limited again');
        assert.equal(warnings.filter((w) => w.includes('rate-limited')).length, 1, 'warned once within the hour');
        c.t += 60 * 60_000;
        await fetchAllMembers(guild, { now: c.now });
        assert.equal(warnings.filter((w) => w.includes('rate-limited')).length, 2, 'warned again after an hour');
        limited = false;
        c.t += 5 * 60_000;
        r = await fetchAllMembers(guild, { now: c.now });
        assert.deepEqual([r.reason, r.partial], ['fetched', false]);
    } finally {
        logger.warn = warn;
    }
    assert.ok(isGatewayRateLimit(Object.assign(new Error('x'), { code: 'RATE_LIMITED' })));
    assert.ok(!isGatewayRateLimit(new Error('Members didn\'t arrive in time.')));
    assert.ok(!isGatewayRateLimit(null));
});

test('gate: a hanging fetch times out, frees its slot, and reports partial', async () => {
    const guild = fakeGuild('13', { behave: () => new Promise(() => {}) });
    const r = await fetchAllMembers(guild, { timeoutMs: 20 });
    assert.deepEqual([r.reason, r.partial], ['timeout', true]);
    assert.equal(memberFetchGateStats().running, 0);
    assert.equal(memberFetchGateStats().inflight, 0);
    const gone = await fetchAllMembers(null);
    assert.deepEqual([gone.reason, gone.partial], ['no-guild', true]);
});

test('gate: per-guild state stays bounded', async () => {
    for (let i = 0; i < 5_100; i += 1) {
        await fetchAllMembers({ id: `g${i}`, memberCount: 1, members: { cache: new Map(), fetch: async () => null } });
    }
    assert.ok(memberFetchGateStats().tracked <= 5_000);
});

// ── callers ──────────────────────────────────────────────────────────────

test('caller /tools randomuser: goes through the gate, cache-only above 5000 members, reports partial', async () => {
    const guild = fakeGuild('20', { memberCount: 10 });
    const first = await pickRandomMember(guild, {}, { pick: () => 0 });
    await pickRandomMember(guild, {}, { pick: () => 0 });
    assert.equal(guild.calls.length, 1, 'second run inside 10 min reuses the fetch');
    assert.equal(first.partial, false);
    assert.equal(first.poolSize, 10);

    const big = fakeGuild('21', { memberCount: 6_000, cached: 3 });
    const picked = await pickRandomMember(big, {}, { pick: () => 0 });
    assert.deepEqual([big.calls.length, picked.partial, picked.poolSize], [0, true, 3], 'big server: cache only');
});

test('caller role rules: completes the member cache through the gate (once an hour)', async () => {
    const guild = fakeGuild('22', { memberCount: 10 });
    guild.members.me = { id: '999', roles: { highest: { position: 10 } } };
    const client = { guilds: { cache: new Map([['22', guild]]) } };
    const deps = {
        guildIds: async () => ['22'],
        listRules: async () => [{ id: 1, name: 'r', trigger: 'days_in_server', threshold: 30, triggerRoleId: null, roleId: '600000000000000001', removeWhenFalse: false, enabled: true }],
        loadLevels: async () => new Map(),
        recordRun: async () => {},
        sleep: async () => {},
        delayMs: 0,
        limit: 0,
    };
    const [first] = await runRoleRules(client, { deps });
    guild.members.cache.clear();
    const [second] = await runRoleRules(client, { deps });
    assert.equal(guild.calls.length, 1, 'one full fetch within the hour');
    assert.equal(first.partial, false);
    assert.equal(second.partial, false, 'recent fetch counts as fresh');
});

/** Every `.members.fetch(` call in src/ whose argument is empty or an options object without a user. */
async function fullFetchSites() {
    const root = new URL('../src/', import.meta.url).pathname;
    const sites = [];
    const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const file = join(dir, entry.name);
            if (entry.isDirectory()) await walk(file);
            else if (entry.name.endsWith('.js')) {
                const lines = (await readFile(file, 'utf8')).split('\n');
                lines.forEach((line, i) => {
                    for (const match of line.matchAll(/members\??\.fetch\(([^)]*)\)?/g)) {
                        const arg = match[1].trim();
                        const full = arg === '' || (arg.startsWith('{') && !/\buser\b/.test(arg));
                        if (full) sites.push(`${relative(root, file)}:${i + 1}`);
                    }
                });
            }
        }
    };
    await walk(root);
    return sites;
}

test('every full guild.members.fetch() in src/ goes through the member fetch gate', async () => {
    const sites = (await fullFetchSites())
        // serverstatsService: its full fetch is removed by B5 T2 (guild.memberCount instead).
        .filter((site) => !site.startsWith('services/serverstatsService.js:'));
    assert.deepEqual([...new Set(sites.map((s) => s.replace(/:\d+$/, '')))], ['utils/memberFetchGate.js'], `full fetches outside the gate: ${sites.join(', ')}`);
});

test('the routed callers import the gate', async () => {
    const files = [
        'services/randomMemberService.js', 'services/leveling/levelRoleSyncService.js', 'services/members/roleRuleService.js',
        'services/dashboard/enforcementRoutes.js', 'commands/Enforcement/staff.js', 'services/staffActivityService.js',
        'services/enforcement/bannedRoleService.js',
    ];
    for (const file of files) {
        const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
        assert.match(source, /import \{ fetchAllMembers \} from '[./]+\/(utils\/)?memberFetchGate\.js'/, file);
        assert.ok((source.match(/fetchAllMembers/g) || []).length >= 2, `${file} uses the gate`);
    }
});
