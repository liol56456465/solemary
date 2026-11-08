// Multi-server B5 (T2): crons and startup jobs only look at servers that use the feature, are
// paced, counters need no member fetch, unchanged commands are not re-registered, feeds are
// fetched 4 at a time with a time budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const G1 = '100000000000000771';
const G2 = '100000000000000772';
const G3 = '100000000000000773';
Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT });

const { GUILD_SQL } = await import('../src/services/scheduling/guildScan.js');
const stats = await import('../src/services/serverstatsService.js');
const { checkBirthdays } = await import('../src/services/birthdayService.js');
const cat = await import('../src/services/community/catService.js');
const modmail = await import('../src/services/modmailService.js');
const { updateGuildConfigAtomic } = await import('../src/utils/database/guildConfigStorage.js');
const { setSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
const { runStartupJobs, scheduleStartupJobs, levelSyncGapMs } = await import('../src/services/scheduling/startupJobs.js');
const loader = await import('../src/handlers/loaders/commandLoader.js');
const { enforcementConfig } = await import('../src/config/enforcement.js');
const { testMode } = await import('../src/config/testMode.js');
const feeds = await import('../src/services/community/feedService.js');

const noFetch = () => { throw new Error('no full member fetch allowed'); };

function counterGuild(id, { memberCount = 10, bots = 2, channels = [] } = {}) {
    const cache = new Collection();
    for (let i = 0; i < bots; i += 1) cache.set(`b${i}`, { user: { bot: true } });
    cache.set('h0', { user: { bot: false } });
    const renamed = [];
    const channelCache = new Map(channels.map((cid) => [cid, {
        id: cid, name: 'old', toString: () => `<#${cid}>`,
        setName: async (name) => { renamed.push([cid, name]); },
    }]));
    return { id, memberCount, renamed, members: { cache, fetch: noFetch }, channels: { cache: channelCache, fetch: async () => null } };
}

// ── Counters ──────────────────────────────────────────────────────────────

test('counter stats: memberCount + cached bots, no member fetch', () => {
    const guild = counterGuild(G1, { memberCount: 50, bots: 3 });
    assert.deepEqual(stats.getGuildCounterStats(guild), { totalCount: 50, botCount: 3, humanCount: 47 });
    assert.equal(stats.counterCountFromStats({ totalCount: 5, botCount: 1, humanCount: 4 }, 'members_only'), 4);
});

test('counter cron: one query, only servers with counters, a pause between them, orphans removed, disabled kept', async () => {
    stats._resetRenameBackoff();
    const g1 = counterGuild(G1, { memberCount: 40, bots: 1, channels: ['c1', 'c2'] });
    const g2 = counterGuild(G2, { memberCount: 7, bots: 0, channels: ['c3'] });
    const g3 = counterGuild(G3); // no counters: never touched
    const saved = new Map();
    const client = {
        guilds: { cache: new Map([[G1, g1], [G2, g2], [G3, g3]]) },
        db: {
            get: async () => assert.fail('no per-server read with SQL'),
            update: async (key, mutator) => { const next = await mutator(rowsByGuild.get(key.split(':')[1])); saved.set(key, next); return next; },
        },
    };
    const counter = (id, type, channelId, enabled = true) => ({ id, type, channelId, enabled, guildId: G1, createdAt: 'x' });
    const rowsByGuild = new Map([
        [G1, [counter('1', 'members', 'c1'), counter('2', 'bots', 'c2'), counter('3', 'members_only', 'gone'), counter('4', 'members_only', 'gone2', false)]],
        [G2, [counter('5', 'members_only', 'c3')]],
        ['100000000000000999', [counter('6', 'members', 'x')]], // the bot left this server
    ]);
    const queries = [];
    const query = async (sql) => { queries.push(sql); return { rows: [...rowsByGuild].map(([id, counters]) => ({ id, counters })) }; };
    const pauses = [];
    const summary = await stats.updateAllServerCounters(client, { query, sleepFn: async (ms) => pauses.push(ms) });
    assert.deepEqual(queries, [GUILD_SQL.counters]);
    assert.deepEqual(summary, { servers: 2, renamedOk: 3, removed: 1, errors: 0 });
    assert.deepEqual(pauses, [stats.COUNTER_SERVER_PAUSE_MS], 'one pause between the two servers');
    assert.deepEqual(g1.renamed, [['c1', 'Members & Bots-40'], ['c2', 'Bots-1']]);
    assert.deepEqual(g2.renamed, [['c3', 'Members-7']]);
    assert.deepEqual(g3.renamed, []);
    assert.deepEqual(saved.get(`guild:${G1}:counters`).map((c) => c.id), ['1', '2', '4'], 'the orphan goes, the disabled counter stays');
});

test('counter 403 backoff: a channel the bot may not rename is skipped, then retried', async () => {
    stats._resetRenameBackoff();
    let calls = 0;
    const guild = counterGuild(G1, { channels: ['c1'] });
    guild.channels.cache.get('c1').setName = async () => { calls += 1; const e = new Error('Missing Permissions'); e.status = 403; e.code = 50013; throw e; };
    const counter = { id: '1', type: 'members', channelId: 'c1' };
    const t0 = 1_000_000;
    assert.equal(await stats.updateCounter({}, guild, counter, { now: t0 }), false);
    assert.equal(await stats.updateCounter({}, guild, counter, { now: t0 + 60_000 }), false);
    assert.equal(calls, 1, 'skipped during the backoff');
    assert.ok(stats.renameBackoffRemaining('c1', t0) > 0);
    await stats.updateCounter({}, guild, counter, { now: t0 + 61 * 60_000 });
    assert.equal(calls, 2, 'tried again after an hour');
    assert.ok(stats.renameBackoffRemaining('c1', t0 + 61 * 60_000) > 60 * 60_000, 'the next wait doubles');
    stats._resetRenameBackoff();
});

// ── Birthdays ─────────────────────────────────────────────────────────────

test('birthday cron: only servers with a birthday channel are read', async () => {
    const reads = [];
    const db = { rows: () => null, get: async (key, fallback = null) => { reads.push(key); return fallback; }, set: async () => true, update: async () => null };
    const guild = { name: 'x', channels: { fetch: async () => null }, members: { fetch: async () => null } };
    const client = { db, guilds: { cache: new Map([[G1, guild], [G2, guild]]) } };
    await checkBirthdays(client, { query: async (sql) => { assert.equal(sql, GUILD_SQL.birthdays); return { rows: [{ id: G1 }] }; } });
    assert.ok(reads.some((key) => key.includes(G1)));
    assert.ok(!reads.some((key) => key.includes(G2)), 'the server without a channel is not read');

    reads.length = 0;
    await checkBirthdays(client, { query: async () => { throw new Error('db down'); } });
    assert.ok(reads.some((key) => key.includes(G2)), 'list unreadable: every server, as before');
});

// ── Server cat ────────────────────────────────────────────────────────────

test('cat cron: servers with new messages, the failed ones again, and once after a restart the recently active', async () => {
    cat._resetCatScanForTests();
    const client = { guilds: { cache: new Map([[G1, { id: G1 }], [G2, { id: G2 }], [G3, { id: G3 }]]) } };
    let checked = [];
    let active = [G1];
    const deps = {
        getLevelingConfig: async () => ({}),
        takeActive: () => { const ids = active; active = []; return ids; },
        query: async (sql) => (sql === GUILD_SQL.activeSince ? { rows: [{ id: G2 }] } : { rows: [{ total: 0, last_week: 0, previous_week: 0 }] }),
        pending: () => [],
        lockdown: async () => false,
        getState: async (id) => { checked.push(id); if (id === G3) throw new Error('boom'); return { stage: 0, grownAt: null }; },
        env: {},
    };
    // catSettings reads the settings cache.
    for (const id of [G1, G2, G3]) setSettingsCacheForTests(id, {});
    await cat.checkCatGrowth(client, deps);
    assert.deepEqual(checked.sort(), [G1, G2], 'new messages + the after-restart scan');
    checked = [];
    await cat.checkCatGrowth(client, deps);
    assert.deepEqual(checked, [], 'idle servers cost nothing');
    active = [G3];
    await cat.checkCatGrowth(client, deps);
    checked = [];
    await cat.checkCatGrowth(client, deps);
    assert.deepEqual(checked, [G3], 'a failed check is tried again');
    cat._resetCatScanForTests();
});

// ── Modmail ───────────────────────────────────────────────────────────────

function mmGuild(id, name, { category = false } = {}) {
    const channels = new Map();
    if (category) channels.set(`${id}9`, { id: `${id}9`, type: ChannelType.GuildCategory });
    return { id, name, channels: { cache: channels }, members: { cache: new Map(), fetch: async () => ({ id: 'm' }) } };
}

test('modmail: only servers with a category have their config read; config writes update the set; a stale entry is re-checked', async () => {
    modmail._resetModmailServerSetForTests();
    for (const id of [G1, G2, G3]) setSettingsCacheForTests(id, {});
    const client = { guilds: { cache: new Map([[G1, mmGuild(G1, 'A', { category: true })], [G2, mmGuild(G2, 'B', { category: true })], [G3, mmGuild(G3, 'C')]]) } };
    const stored = { [G1]: { ticketCategoryId: `${G1}9` }, [G2]: {}, [G3]: {} };
    const reads = [];
    const getConfig = async (c, guildId) => { reads.push(guildId); return { ...stored[guildId], modmailBlocked: [] }; };
    let queries = 0;
    const query = async (sql) => { queries += 1; assert.equal(sql, GUILD_SQL.ticketCategory); return { rows: [{ id: G1 }] }; };

    let result = await modmail.modmailServersFor(client, '500000000000000004', { getConfig, query });
    assert.deepEqual(result.servers.map((g) => g.id), [G1]);
    assert.deepEqual(reads, [G1], 'servers without a category are not read');

    // G2 gets a ticket category: the set knows at once, no refresh needed.
    stored[G2] = { ticketCategoryId: `${G2}9` };
    const fakeDb = { update: async (key, mutator) => mutator(stored[G2]) };
    await updateGuildConfigAtomic({ db: fakeDb }, G2, (current) => ({ ...current, ticketCategoryId: `${G2}9` }));
    reads.length = 0;
    result = await modmail.modmailServersFor(client, '500000000000000004', { getConfig, query });
    assert.deepEqual(result.servers.map((g) => g.id).sort(), [G1, G2]);
    assert.equal(queries, 1, 'within 5 minutes the set is not reloaded');

    // G1 turns modmail off but the set still lists it: its fresh config decides, never the set.
    stored[G1] = {};
    result = await modmail.modmailServersFor(client, '500000000000000004', { getConfig, query });
    assert.deepEqual(result.servers.map((g) => g.id), [G2]);

    // No SQL (in-memory storage or tests without a database): every server, as before.
    modmail._resetModmailServerSetForTests();
    reads.length = 0;
    await modmail.modmailServersFor(client, '500000000000000004', { getConfig });
    assert.deepEqual(reads.sort(), [G1, G2, G3]);
    modmail._resetModmailServerSetForTests();
});

// ── Startup jobs ──────────────────────────────────────────────────────────

test('startup jobs: only servers with panels or rules that the bot is in, paced, big servers skip the level sync, one log line', async () => {
    const big = { id: G3, memberCount: 30_000 };
    const client = { guilds: { cache: new Map([[G1, { id: G1, memberCount: 10 }], [G2, { id: G2, memberCount: 10 }], [G3, big]]) } };
    const LEFT = '100000000000000999';
    const lists = {
        [GUILD_SQL.reactionRoles]: [G1, LEFT],
        [GUILD_SQL.ticketPanel]: [G2],
        [GUILD_SQL.verificationPanel]: [],
        [GUILD_SQL.levelRewards]: [G1, G3],
    };
    const query = async (sql) => ({ rows: (lists[sql] || []).map((id) => ({ id })) });
    const calls = [];
    const job = (name, part) => async (c, guild) => { calls.push(`${name}:${guild.id}`); return part; };
    const jobs = {
        reactionRoles: job('rr', { removed: 1, errors: 0 }),
        ticketPanels: job('ticket', { healthy: 1 }),
        verificationPanels: job('verify', { healthy: 1 }),
        levelRoles: job('level', { given: 2 }),
    };
    const pauses = [];
    const lines = [];
    const result = await runStartupJobs(client, { query, jobs, sleepFn: async (ms) => pauses.push(ms), log: (line) => lines.push(line) });
    assert.deepEqual(calls, [`rr:${G1}`, `ticket:${G2}`, `level:${G1}`], 'never the server the bot left; the 30k server skips the level sync');
    assert.deepEqual(pauses, [150], 'a pause between the two panel servers');
    assert.equal(result.largeSkipped, 1);
    assert.equal(result.jobs.reactionRoles.removed, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Startup jobs done in \d+ s\. reactionRoles: servers 1, removed 1, errors 0; .*above 25000 members/);

    // A job whose list can't be read is skipped; the others still run.
    calls.length = 0;
    const failing = async (sql) => { if (sql === GUILD_SQL.ticketPanel) throw new Error('db down'); return query(sql); };
    const again = await runStartupJobs(client, { query: failing, jobs, sleepFn: async () => {}, log: () => {} });
    assert.deepEqual(again.jobs.ticketPanels, { skipped: 'database' });
    assert.ok(calls.includes(`rr:${G1}`));
});

test('startup jobs: scheduled ~60 s after ready; level syncs spread over about 30 minutes', () => {
    let scheduled = null;
    scheduleStartupJobs({}, { schedule: (fn, ms) => { scheduled = ms; return null; }, run: async () => {} });
    assert.equal(scheduled, 60_000);
    assert.equal(levelSyncGapMs(1), 0);
    assert.equal(levelSyncGapMs(100), 18_000);
    assert.equal(levelSyncGapMs(3), 30_000, 'at most 30 s apart');
    assert.equal(levelSyncGapMs(10_000), 2_000, 'at least 2 s apart');
});

// ── Command registration hash ─────────────────────────────────────────────

test('commands: unchanged lists (and settled home copies) skip every PUT; a change or an unreadable hash registers', async () => {
    const saved = { main: enforcementConfig.mainGuildId, support: enforcementConfig.supportGuildId, test: testMode.enabled };
    Object.assign(enforcementConfig, { mainGuildId: MAIN, supportGuildId: SUPPORT });
    testMode.enabled = false;
    try {
        const store = new Map();
        const hashStore = { get: async (id) => store.get(id) ?? null, set: async (id, record) => { store.set(id, record); } };
        const puts = [];
        const rest = { get: async () => [], put: async (route) => { puts.push(String(route)); } };
        const SETS = { global: [{ name: 'help', description: 'h' }], owner: [] };
        const BOT = '1531096173786566697';
        const timers = [];

        await loader.registerCommandSets(rest, BOT, SETS, 0, { hashStore, schedule: (fn) => timers.push(fn) });
        assert.ok(puts.length > 0);
        assert.equal(store.get(BOT).settled, false, 'home copies still up: not skippable yet');
        puts.length = 0;
        await loader.registerCommandSets(rest, BOT, SETS, 0, { hashStore, schedule: () => {} });
        assert.ok(puts.length > 0, 'not settled: registers again');

        await timers[0]();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(store.get(BOT).settled, true);
        puts.length = 0;
        const skipped = await loader.registerCommandSets(rest, BOT, SETS, 0, { hashStore, schedule: () => {} });
        assert.equal(skipped.skipped, true);
        assert.deepEqual(puts, [], 'unchanged: no PUT at all');

        const changed = { global: [{ name: 'help', description: 'changed' }], owner: [] };
        await loader.registerCommandSets(rest, BOT, changed, 0, { hashStore, schedule: () => {} });
        assert.ok(puts.length > 0, 'changed: registers');

        puts.length = 0;
        const broken = { get: async () => { throw new Error('db down'); }, set: async () => {} };
        await loader.registerCommandSets(rest, BOT, changed, 0, { hashStore: broken, schedule: () => {} });
        assert.ok(puts.length > 0, 'hash unreadable: registers');

        // A failed PUT is not remembered.
        store.clear();
        const failingRest = { get: async () => [{ id: '1000000000000000001' }], put: async (route) => { if (String(route).includes(MAIN)) throw new Error('Missing Access'); } };
        await loader.registerCommandSets(failingRest, BOT, SETS, 0, { hashStore, schedule: () => {} });
        assert.equal(store.has(BOT), false);
    } finally {
        Object.assign(enforcementConfig, { mainGuildId: saved.main, supportGuildId: saved.support });
        testMode.enabled = saved.test;
    }
});

// ── YouTube feeds ─────────────────────────────────────────────────────────

test('feeds: 4 fetches at once; out of time → stops and starts with the rest next poll', async () => {
    const sources = Array.from({ length: 10 }, (_, i) => `UC${String(i).padStart(22, '0')}`);
    feeds.setFeedsForTests(sources.map((source, i) => ({ id: i + 1, guild_id: G1, kind: 'youtube', source_id: source, channel_id: 'c', last_item_id: null })));
    let inFlight = 0;
    let maxInFlight = 0;
    const fetched = [];
    const fakeFetch = async (url) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        fetched.push(new URL(url).searchParams.get('channel_id'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { ok: true, text: async () => '<feed></feed>' };
    };
    const all = await feeds.pollFeeds({}, fakeFetch);
    assert.equal(all.sources, 10);
    assert.equal(all.stoppedAt, undefined);
    assert.equal(maxInFlight, 4);

    // A clock that passes the budget after 6 fetches started.
    fetched.length = 0;
    let clock = 0;
    const now = () => clock;
    const slowFetch = async (url) => { clock += fetched.length >= 5 ? 1000 : 0; return fakeFetch(url); };
    const first = await feeds.pollFeeds({}, slowFetch, { budgetMs: 500, now });
    assert.ok(first.stoppedAt > 0);
    const reached = new Set(fetched);
    fetched.length = 0;
    await feeds.pollFeeds({}, fakeFetch);
    const left = sources.filter((s) => !reached.has(s));
    assert.deepEqual(fetched.slice(0, left.length).sort(), left.sort(), 'the next poll starts with the feeds not reached');
    assert.deepEqual(feeds.feedPollOrder(['b', 'c', 'a'], 'b'), ['b', 'c', 'a']);
    feeds.setFeedsForTests([]);
});
