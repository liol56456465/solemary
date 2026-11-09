// Invite leave reconcile (src/services/invites/inviteReconcile.js): the pure "who is absent"
// decision (an untrusted member list closes nobody), per-server flow (no fetch without open rows,
// paging, batched closes), pacing over servers with the feature on, the cron + startup wiring,
// and the "never a quick leave" age rule. No database (tests/db/inviteTracking.test.js), no Discord.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Collection } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const G1 = '100000000000000991';
const G2 = '100000000000000992';
const G3 = '100000000000000993';
Object.assign(process.env, { MAIN_GUILD_ID: process.env.MAIN_GUILD_ID || MAIN, SUPPORT_GUILD_ID: process.env.SUPPORT_GUILD_ID || SUPPORT });

const rec = await import('../src/services/invites/inviteReconcile.js');
const stats = await import('../src/services/invites/inviteStats.js');
const { INVITE_LIMITS } = await import('../src/services/settings/settingsRegistry.js');
const store = await import('../src/services/invites/inviteStore.js');

const members = (...ids) => new Collection(ids.map((id) => [id, { id }]));
const gate = (cache, reason = 'fetched', partial = false) => ({ members: cache, fetched: reason === 'fetched', partial, reason });

// ── pure decision ─────────────────────────────────────────────────────────

test('memberListTrusted: only a complete list (not partial, fetched/fresh/cache, size >= memberCount)', () => {
    const guild = { memberCount: 3 };
    const full = members('a', 'b', 'c');
    assert.equal(rec.memberListTrusted(guild, gate(full, 'fetched')), true);
    assert.equal(rec.memberListTrusted(guild, gate(full, 'fresh')), true);
    assert.equal(rec.memberListTrusted(guild, gate(full, 'cache')), true);
    assert.equal(rec.memberListTrusted(guild, gate(members('a', 'b'), 'cache')), false, 'a 90% cache is not complete');
    for (const reason of ['too-large', 'rate-limited', 'cooldown', 'busy', 'timeout', 'failed', 'no-intent', 'no-guild']) {
        assert.equal(rec.memberListTrusted(guild, gate(full, reason, true)), false, reason);
        assert.equal(rec.memberListTrusted(guild, gate(full, reason, false)), false, `${reason} even if not flagged partial`);
    }
    assert.equal(rec.memberListTrusted(guild, gate(full, 'fetched', true)), false, 'partial');
    assert.equal(rec.memberListTrusted({ memberCount: 0 }, gate(full)), false, 'unknown member count');
    assert.equal(rec.memberListTrusted(guild, null), false);
});

test('absentJoinIds: rows whose member is missing; an untrusted list → nobody', () => {
    const rows = [{ id: '1', userId: 'a' }, { id: '2', userId: 'x' }, { id: '3', userId: 'b' }, { id: '4', userId: 'y' }];
    const cache = members('a', 'b');
    assert.deepEqual(rec.absentJoinIds(rows, cache, true), ['2', '4']);
    assert.deepEqual(rec.absentJoinIds(rows, cache, false), [], 'untrusted: nobody');
    assert.deepEqual(rec.absentJoinIds(rows, new Collection(), false), [], 'empty untrusted cache: nobody');
    assert.deepEqual(rec.absentJoinIds(rows, null, true), []);
    assert.deepEqual(rec.absentJoinIds([], cache, true), []);
});

test('age rule: reconciled rows are never quick leaves under any allowed fakeLeaveHours', () => {
    assert.equal(rec.MIN_AGE_HOURS, INVITE_LIMITS.maxLeaveHours);
    assert.equal(stats.normalizeInviteSettings({ fakeLeaveHours: INVITE_LIMITS.maxLeaveHours + 1 }).fakeLeaveHours <= INVITE_LIMITS.maxLeaveHours, true);
    const now = Date.UTC(2026, 10, 9);
    const joinedAt = now - rec.MIN_AGE_HOURS * 3_600_000 - 1; // the youngest row the reconcile may close
    for (const fakeLeaveHours of [1, 24, 168, INVITE_LIMITS.maxLeaveHours]) {
        assert.equal(stats.isFakeJoin({ joinedAt, leftAt: now, accountCreatedAt: null }, { fakeAccountDays: 0, fakeLeaveHours }), false, `${fakeLeaveHours} h`);
    }
});

// ── one server ────────────────────────────────────────────────────────────

test('reconcileGuild: no open rows → no member fetch', async () => {
    let fetched = 0;
    const out = await rec.reconcileGuild({ id: G1, memberCount: 5 }, {
        list: async () => [], close: async () => assert.fail('no close'), fetchMembers: async () => { fetched += 1; },
    });
    assert.deepEqual(out, { open: 0, closed: 0, untrusted: null });
    assert.equal(fetched, 0);
});

test('reconcileGuild: untrusted list (fetch skipped, error, partial) → nothing closed', async () => {
    for (const result of [gate(members('a'), 'too-large', true), gate(members('a'), 'failed', true), gate(members('a'), 'cache', false)]) {
        const out = await rec.reconcileGuild({ id: G1, memberCount: 50 }, {
            list: async () => [{ id: '1', userId: 'x' }],
            close: async () => assert.fail('must not close when unsure'),
            fetchMembers: async () => result,
        });
        assert.equal(out.closed, 0);
        assert.equal(out.untrusted, result.reason);
    }
});

test('reconcileGuild: trusted list → closes absent rows only, in batches, through every page', async () => {
    const cache = members('a', 'b');
    const all = [];
    for (let i = 1; i <= rec.PAGE_SIZE + 3; i += 1) all.push({ id: String(i), userId: i % 2 ? `gone${i}` : (i % 4 ? 'a' : 'b') });
    const lists = [];
    const closes = [];
    const out = await rec.reconcileGuild({ id: G1, memberCount: 2 }, {
        list: async (guildId, { minAgeHours, afterId, limit }) => {
            lists.push({ guildId, minAgeHours, afterId });
            return all.filter((r) => Number(r.id) > Number(afterId)).slice(0, limit);
        },
        close: async (guildId, ids, { minAgeHours }) => {
            assert.equal(guildId, G1);
            assert.equal(minAgeHours, rec.MIN_AGE_HOURS);
            assert.ok(ids.length <= rec.UPDATE_BATCH);
            closes.push(ids);
            return ids.length;
        },
        fetchMembers: async () => gate(cache),
    });
    const expected = all.filter((r) => r.userId.startsWith('gone')).map((r) => r.id);
    assert.deepEqual(closes.flat(), expected);
    assert.equal(out.closed, expected.length);
    assert.equal(out.open, all.length);
    assert.deepEqual(lists.map((l) => l.afterId), [0, String(rec.PAGE_SIZE)]);
    assert.ok(lists.every((l) => l.minAgeHours === rec.MIN_AGE_HOURS && l.guildId === G1));
});

test('reconcileGuild: later pages use the member snapshot, not a cache cleared mid-run (GUILD_CREATE)', async () => {
    const cache = members('a');
    const all = [];
    for (let i = 1; i <= rec.PAGE_SIZE + 2; i += 1) all.push({ id: String(i), userId: i === 1 ? 'gone' : 'a' });
    const closed = [];
    const out = await rec.reconcileGuild({ id: G1, memberCount: 1 }, {
        list: async (guildId, { afterId, limit }) => all.filter((r) => Number(r.id) > Number(afterId)).slice(0, limit),
        close: async (guildId, ids) => { cache.clear(); closed.push(...ids); return ids.length; },
        fetchMembers: async () => gate(cache),
    });
    assert.deepEqual(closed, ['1'], 'present member a is not closed on page 2 after the cache was cleared');
    assert.equal(out.closed, 1);
});

test('reconcileGuild: a database error on close throws (the run counts it as failed)', async () => {
    await assert.rejects(rec.reconcileGuild({ id: G1, memberCount: 1 }, {
        list: async () => [{ id: '1', userId: 'x' }],
        close: async () => { throw new Error('db down'); },
        fetchMembers: async () => gate(members('a')),
    }), /db down/);
});

// ── all servers: pacing ───────────────────────────────────────────────────

test('reconcileInviteLeaves: only servers with the feature on, one at a time, a pause between, one summary line', async () => {
    const guilds = new Map([[G1, { id: G1 }], [G2, { id: G2 }], [G3, { id: G3 }]]);
    const client = { guilds: { cache: guilds } };
    const order = [];
    let active = 0;
    let maxActive = 0;
    const pauses = [];
    const lines = [];
    let failure = null;
    await rec.reconcileInviteLeaves(client, {
        isOn: (id) => id !== G2,
        dbAvailable: () => true,
        reconcile: async (guild) => {
            active += 1; maxActive = Math.max(maxActive, active);
            order.push(guild.id);
            await new Promise((r) => setImmediate(r));
            active -= 1;
            if (guild.id === G3) throw new Error('boom');
            return { open: 4, closed: 3, untrusted: null };
        },
        sleepFn: async (ms) => { pauses.push(ms); },
        log: (line) => lines.push(line),
    }).catch((error) => { failure = error; });
    assert.match(failure?.message || '', /failed for 1 server/, 'a failed server makes the run fail (cronStats)');
    const totals = failure.totals;
    assert.deepEqual(order, [G1, G3]);
    assert.equal(maxActive, 1, 'one server at a time');
    assert.deepEqual(pauses, [rec.RECONCILE_SERVER_PAUSE_MS]);
    assert.deepEqual(totals, { servers: 2, closed: 3, untrusted: 0, errors: 1 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /2 server\(s\), 3 row\(s\) closed, 0 skipped .*1 failed/);
});

test('reconcileInviteLeaves: untrusted servers are counted with their reason; database down → skipped', async () => {
    const client = { guilds: { cache: new Map([[G1, { id: G1 }], [G2, { id: G2 }]]) } };
    const lines = [];
    const totals = await rec.reconcileInviteLeaves(client, {
        isOn: () => true, dbAvailable: () => true, sleepFn: async () => {}, log: (l) => lines.push(l),
        reconcile: async () => ({ open: 1, closed: 0, untrusted: 'too-large' }),
    });
    assert.equal(totals.untrusted, 2);
    assert.match(lines[0], /too-large: 2/);
    const skipped = await rec.reconcileInviteLeaves(client, {
        isOn: () => assert.fail('no server read'), dbAvailable: () => false, log: () => {},
    });
    assert.deepEqual(skipped, { skipped: 'database' });
});

// ── wiring ────────────────────────────────────────────────────────────────

test('scheduleInviteLeaveReconcile: daily cron + one startup run after ready and the warm-up, both guarded', async () => {
    const scheduled = [];
    const timers = [];
    const wrapped = [];
    let ran = 0;
    let readyFn = null;
    let warmDone = false;
    const job = rec.scheduleInviteLeaveReconcile({
        schedule: (expression, fn, options) => scheduled.push({ expression, fn, options }),
        wrap: (name, fn) => { const w = async () => fn(); wrapped.push(name); return w; },
        run: async () => { assert.equal(warmDone, true, 'runs after the warm-up'); ran += 1; },
        whenReady: (fn) => { readyFn = fn; },
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
        warmUp: async () => { await new Promise((r) => setImmediate(r)); warmDone = true; },
    });
    assert.deepEqual(wrapped, [rec.RECONCILE_JOB]);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].expression, rec.RECONCILE_CRON);
    assert.deepEqual(scheduled[0].options, { timezone: 'UTC' });
    assert.equal(scheduled[0].fn, job);
    assert.equal(timers.length, 0, 'nothing before ready');
    readyFn();
    assert.equal(timers[0].ms, rec.RECONCILE_STARTUP_DELAY_MS);
    await timers[0].fn();
    assert.equal(ran, 1);
});

test('app.js wires the reconcile inside setupCronJobs, after the test-mode early return, with exclusive()', () => {
    const src = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
    const start = src.indexOf('setupCronJobs() {');
    const testModeReturn = src.indexOf('return;', src.indexOf('testMode.cronEnabled', start));
    const wiring = src.indexOf('scheduleInviteLeaveReconcile({', start);
    assert.ok(start > 0 && testModeReturn > start && wiring > testModeReturn, 'off in test mode unless TEST_ENABLE_CRON=true');
    assert.match(src.slice(wiring, wiring + 400), /wrap: exclusive/);
    assert.match(src.slice(wiring, wiring + 400), /reconcileInviteLeaves\(this\)/);
});

test('store: closeOpenJoins sends one ANY($ids) UPDATE for open rows of the guild with the age check; empty → no query', async () => {
    const calls = [];
    const query = async (text, params) => { calls.push({ text, params }); return { rowCount: 2, rows: [] }; };
    assert.equal(await store.closeOpenJoins(G1, [], { minAgeHours: 720 }, { query }), 0);
    assert.equal(calls.length, 0);
    assert.equal(await store.closeOpenJoins(G1, ['5', '6', '5', 'bad'], { minAgeHours: 720 }, { query }), 2);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /id = ANY\(\$2::bigint\[\]\)/);
    assert.match(calls[0].text, /left_at IS NULL/);
    assert.match(calls[0].text, /guild_id = \$1/);
    assert.match(calls[0].text, /joined_at < NOW\(\) - make_interval\(hours => \$3::int\)/);
    assert.deepEqual(calls[0].params, [G1, ['5', '6'], 720]);
    await assert.rejects(store.closeOpenJoins(G1, ['1'], { minAgeHours: 720 }, { query: async () => null }), /no result/);
    await assert.rejects(store.closeOpenJoins(G1, ['1'], { minAgeHours: 720 }, { query: async () => { throw new Error('down'); } }), /down/);
});

test('inviteWarmUpSettled: follows the latest warm-up and never rejects', async () => {
    const cache = await import('../src/services/invites/inviteCache.js');
    let release;
    const client = { guilds: { cache: new Map([[G1, { id: G1 }]]) } };
    const run = cache.warmAllInviteCaches(client, {
        isOn: () => true, sleepFn: async () => {}, warm: () => new Promise((r) => { release = r; }),
    });
    let settled = false;
    const waiting = cache.inviteWarmUpSettled().then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'still warming');
    release('ready');
    await run;
    await waiting;
    assert.equal(settled, true);
});
