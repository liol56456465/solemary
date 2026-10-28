// Scheduled and recurring messages (services/scheduledMessageService.js): next-run maths
// (once, every day, weekdays, every N hours, DST changes in IANA zones), the
// once-a-minute runner (posts due ones, reschedules, skips late runs, pauses after 3
// failures with one alert) and the dashboard-facing service functions, against an
// in-memory store with the same interface as the SQL one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FAILURE_LIMIT, MAX_LATE_MS, RETRY_MS, SCHEDULED_MAX_PER_GUILD, cleanSchedule, createScheduledMessage, describeSchedule, formatInZone,
    nextRunAfter, runDueScheduledMessages, runScheduledMessageNow, setScheduledMessagePaused, updateScheduledMessage, zonedTimeToUtc,
} from '../src/services/scheduledMessageService.js';

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
const at = (s) => Date.parse(s);
const MIN = 60_000;
const HOUR = 60 * MIN;
const GUILD = '100000000000000001';
const CHANNEL = '500000000000000001';

// ── next-run maths ────────────────────────────────────────────────────────

test('zonedTimeToUtc: normal times, the spring-forward gap moves forward, the fall-back repeat takes the first', () => {
    assert.equal(iso(zonedTimeToUtc(2026, 3, 28, 9, 0, 'Europe/Vilnius')), '2026-03-28T07:00:00.000Z', 'EET +2');
    assert.equal(iso(zonedTimeToUtc(2026, 3, 29, 9, 0, 'Europe/Vilnius')), '2026-03-29T06:00:00.000Z', 'EEST +3');
    assert.equal(iso(zonedTimeToUtc(2026, 3, 29, 3, 30, 'Europe/Vilnius')), '2026-03-29T01:30:00.000Z', '03:30 does not exist → 04:30 EEST');
    assert.equal(iso(zonedTimeToUtc(2026, 10, 25, 3, 30, 'Europe/Vilnius')), '2026-10-25T00:30:00.000Z', '03:30 happens twice → the first (EEST)');
    assert.equal(iso(zonedTimeToUtc(2026, 3, 8, 2, 30, 'America/New_York')), '2026-03-08T07:30:00.000Z', '02:30 → 03:30 EDT');
    assert.equal(iso(zonedTimeToUtc(2026, 11, 1, 1, 30, 'America/New_York')), '2026-11-01T05:30:00.000Z', '01:30 twice → EDT');
    assert.equal(iso(zonedTimeToUtc(2026, 6, 1, 12, 0, 'UTC')), '2026-06-01T12:00:00.000Z');
});

test('nextRunAfter once: the instant in the zone, null when it has passed', () => {
    const once = { kind: 'once', date: '2026-11-02', time: '09:15' };
    assert.equal(iso(nextRunAfter(once, 'Europe/Vilnius', at('2026-10-29T00:00:00Z'))), '2026-11-02T07:15:00.000Z');
    assert.equal(nextRunAfter(once, 'Europe/Vilnius', at('2026-11-02T07:15:00Z')), null, 'strictly after: the same instant is gone');
    assert.equal(nextRunAfter(once, 'Asia/Tokyo', at('2026-11-02T07:15:00Z')), null, 'Tokyo 09:15 was hours earlier');
});

test('nextRunAfter every day: same wall-clock time across both DST changes (Vilnius and New York)', () => {
    const daily = { kind: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] };
    assert.equal(iso(nextRunAfter(daily, 'Europe/Vilnius', at('2026-03-28T05:00:00Z'))), '2026-03-28T07:00:00.000Z', 'later today');
    assert.equal(iso(nextRunAfter(daily, 'Europe/Vilnius', at('2026-03-28T07:00:00Z'))), '2026-03-29T06:00:00.000Z', 'next day, after spring forward (23 h later)');
    assert.equal(iso(nextRunAfter(daily, 'Europe/Vilnius', at('2026-10-24T06:00:00Z'))), '2026-10-25T07:00:00.000Z', 'after fall back (25 h later)');
    assert.equal(iso(nextRunAfter(daily, 'America/New_York', at('2026-03-07T14:00:00Z'))), '2026-03-08T13:00:00.000Z', 'EST 14:00Z → EDT 13:00Z');
    // Local midnight crossing: 23:30 UTC is already the next day in Vilnius.
    assert.equal(iso(nextRunAfter({ kind: 'weekly', time: '00:30', days: [0, 1, 2, 3, 4, 5, 6] }, 'Europe/Vilnius', at('2026-06-01T21:00:00Z'))), '2026-06-01T21:30:00.000Z');
});

test('nextRunAfter weekdays: the next chosen day, over a weekend, by the zone\'s own calendar', () => {
    const mwf = { kind: 'weekly', time: '18:30', days: [1, 3, 5] };
    // 2026-10-30 is a Friday.
    assert.equal(iso(nextRunAfter(mwf, 'UTC', at('2026-10-30T10:00:00Z'))), '2026-10-30T18:30:00.000Z', 'Friday, later today');
    assert.equal(iso(nextRunAfter(mwf, 'UTC', at('2026-10-30T19:00:00Z'))), '2026-11-02T18:30:00.000Z', 'then Monday');
    assert.equal(iso(nextRunAfter({ kind: 'weekly', time: '08:00', days: [0] }, 'UTC', at('2026-11-01T08:00:00Z'))), '2026-11-08T08:00:00.000Z', 'one day: a week later');
    // Sunday 23:00 UTC is Monday 08:00 in Tokyo: Monday's run in Tokyo is at 23:00 UTC Sunday.
    assert.equal(iso(nextRunAfter({ kind: 'weekly', time: '08:00', days: [1] }, 'Asia/Tokyo', at('2026-11-01T12:00:00Z'))), '2026-11-01T23:00:00.000Z');
});

test('nextRunAfter every N hours: from the start, counting real hours (DST does not shift it)', () => {
    const every6 = { kind: 'interval', date: '2026-03-28', time: '09:00', hours: 6 };
    assert.equal(iso(nextRunAfter(every6, 'Europe/Vilnius', at('2026-03-27T00:00:00Z'))), '2026-03-28T07:00:00.000Z', 'before the start: the start');
    assert.equal(iso(nextRunAfter(every6, 'Europe/Vilnius', at('2026-03-28T07:00:00Z'))), '2026-03-28T13:00:00.000Z');
    assert.equal(iso(nextRunAfter(every6, 'Europe/Vilnius', at('2026-03-29T08:00:00Z'))), '2026-03-29T13:00:00.000Z', 'missed ones are skipped, the grid stays');
    const daily = { kind: 'interval', date: '2026-03-28', time: '09:00', hours: 24 };
    assert.equal(iso(nextRunAfter(daily, 'Europe/Vilnius', at('2026-03-28T07:00:00Z'))), '2026-03-29T07:00:00.000Z', '24 real hours = 10:00 local after spring forward');
});

test('cleanSchedule refuses bad input; describeSchedule and formatInZone read well', () => {
    assert.throws(() => cleanSchedule({ kind: 'once', date: '2026-02-30', time: '10:00' }), /Date/);
    assert.throws(() => cleanSchedule({ kind: 'once', date: '2026-02-01', time: '24:00' }), /Time/);
    assert.throws(() => cleanSchedule({ kind: 'weekly', time: '10:00', days: [] }), /weekday/);
    assert.throws(() => cleanSchedule({ kind: 'interval', date: '2026-02-01', time: '10:00', hours: 0 }), /between 1 and 168/);
    assert.throws(() => cleanSchedule({ kind: 'cron' }), /unknown choice/);
    assert.deepEqual(cleanSchedule({ kind: 'weekly', time: '10:00', days: [5, 1, 1, 9] }), { kind: 'weekly', time: '10:00', days: [1, 5] });
    assert.equal(describeSchedule({ kind: 'weekly', time: '10:00', days: [0, 1, 5] }), 'Mon, Fri, Sun at 10:00');
    assert.equal(describeSchedule({ kind: 'weekly', time: '10:00', days: [0, 1, 2, 3, 4, 5, 6] }), 'Every day at 10:00');
    assert.equal(describeSchedule({ kind: 'interval', date: '2026-01-01', time: '08:00', hours: 1 }), 'Every 1 hour from 2026-01-01 08:00');
    assert.equal(formatInZone(at('2026-11-02T07:15:00Z'), 'Europe/Vilnius'), '2026-11-02 09:15');
});

// ── in-memory store (same interface as createScheduledMessageStore) ────────

function memoryStore(rows = []) {
    const data = rows.map((r, i) => ({ id: i + 1, guildId: GUILD, channelId: CHANNEL, timezone: 'UTC', lastRunAt: null, lastError: null, lastMessageId: null, failureCount: 0, paused: false, createdBy: '2', payload: { content: 'Hi', embed: null }, ...r }));
    const copy = (r) => (r ? structuredClone(r) : null);
    const find = (id) => data.find((r) => r.id === id);
    return {
        data,
        available: async () => true,
        list: async (g) => data.filter((r) => r.guildId === g).map(copy),
        get: async (g, id) => copy(data.find((r) => r.guildId === g && r.id === id)),
        insert: async (row, max) => {
            if (data.filter((r) => r.guildId === row.guildId).length >= max) return null;
            const r = { id: data.length + 1, lastRunAt: null, lastError: null, lastMessageId: null, failureCount: 0, paused: false, ...structuredClone(row) };
            data.push(r);
            return copy(r);
        },
        update: async (g, id, patch) => { const r = find(id); Object.assign(r, structuredClone(patch), { failureCount: 0, lastError: null }); return copy(r); },
        setPaused: async (g, id, paused, nextRunAt) => { const r = find(id); Object.assign(r, { paused, nextRunAt }); if (!paused) r.failureCount = 0; return copy(r); },
        remove: async (g, id) => { const i = data.findIndex((r) => r.id === id); if (i < 0) return false; data.splice(i, 1); return true; },
        due: async (now) => data.filter((r) => !r.paused && r.nextRunAt !== null && r.nextRunAt <= now).sort((a, b) => a.nextRunAt - b.nextRunAt).map(copy),
        claim: async (id, expected, next) => { const r = find(id); if (!r || r.paused || r.nextRunAt !== expected) return false; r.nextRunAt = next; return true; },
        recordSuccess: async (id, now, messageId) => Object.assign(find(id), { lastRunAt: now, lastError: null, lastMessageId: messageId, failureCount: 0 }),
        recordNote: async (id, now, note) => Object.assign(find(id), { lastRunAt: now, lastError: note }),
        recordFailure: async (id, now, error, limit, retry) => {
            const r = find(id);
            r.failureCount += 1;
            Object.assign(r, { lastRunAt: now, lastError: error, paused: r.paused || r.failureCount >= limit });
            if (retry !== null) r.nextRunAt = retry;
            return { failureCount: r.failureCount, paused: r.paused };
        },
    };
}

function fakeClient({ channelMissing = false } = {}) {
    const channel = { id: CHANNEL, name: 'general' };
    const guild = { id: GUILD, channels: { cache: new Map(channelMissing ? [] : [[CHANNEL, channel]]), fetch: async () => null } };
    return { guild, channel, client: { isReady: () => true, guilds: { cache: new Map([[GUILD, guild]]) } } };
}

function recorder({ fail = null } = {}) {
    const posts = [];
    const post = async (guild, args) => {
        posts.push({ guildId: guild.id, ...args, channelId: args.channel.id });
        if (fail) throw fail();
        return { message: { id: `9000000000000000${posts.length}` } };
    };
    return { posts, post };
}

const permissionError = () => Object.assign(new Error('Bot cannot post'), { type: 'permission', userMessage: 'I am missing Send Messages in #general. Nothing was posted.' });

// ── the runner ────────────────────────────────────────────────────────────

test('runner: posts a due message exactly like Send a message (the stored payload) and moves next_run_at on', async () => {
    const now = at('2026-10-30T09:00:30Z');
    const store = memoryStore([
        { schedule: { kind: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, nextRunAt: at('2026-10-30T09:00:00Z'), payload: { content: 'Daily @everyone', embed: { title: 'T', description: '', imageUrl: '', footer: '', colour: 1 } } },
        { schedule: { kind: 'weekly', time: '10:00', days: [5] }, nextRunAt: at('2026-10-30T10:00:00Z') },
        { schedule: { kind: 'weekly', time: '09:00', days: [5] }, nextRunAt: at('2026-10-30T09:00:00Z'), paused: true },
    ]);
    const { client, channel } = fakeClient();
    const { posts, post } = recorder();
    const result = await runDueScheduledMessages(client, { store, now, post, postModLog: async () => assert.fail('no alert') });
    assert.deepEqual(result, { posted: 1, failed: 0, skipped: 0, paused: 0 });
    assert.equal(posts.length, 1, 'only the due, unpaused one');
    assert.equal(posts[0].channel, channel);
    assert.equal(posts[0].content, 'Daily @everyone');
    assert.deepEqual(posts[0].embed, { title: 'T', description: '', imageUrl: '', footer: '', colour: 1 });
    assert.equal(iso(store.data[0].nextRunAt), '2026-10-31T09:00:00.000Z');
    assert.equal(store.data[0].lastRunAt, now);
    assert.equal(store.data[0].lastMessageId, '90000000000000001');
    // The next tick (same minute) finds nothing due: no double post.
    await runDueScheduledMessages(client, { store, now: now + 20_000, post });
    assert.equal(posts.length, 1);
});

test('runner: a one-time message is posted once and then finished; a claimed-elsewhere row is not posted', async () => {
    const now = at('2026-11-02T07:15:10Z');
    const store = memoryStore([{ schedule: { kind: 'once', date: '2026-11-02', time: '09:15' }, timezone: 'Europe/Vilnius', nextRunAt: at('2026-11-02T07:15:00Z') }]);
    const { client } = fakeClient();
    const { posts, post } = recorder();
    await runDueScheduledMessages(client, { store, now, post });
    assert.equal(posts.length, 1);
    assert.equal(store.data[0].nextRunAt, null, 'done');
    assert.equal(store.data[0].paused, false);

    const raced = memoryStore([{ schedule: { kind: 'weekly', time: '09:00', days: [5] }, nextRunAt: at('2026-10-30T09:00:00Z') }]);
    raced.claim = async () => false;
    const r = recorder();
    await runDueScheduledMessages(client, { store: raced, now: at('2026-10-30T09:00:30Z'), post: r.post });
    assert.equal(r.posts.length, 0, 'another instance claimed it first');
});

test('runner: a run more than 6 hours late (bot was offline) is skipped and noted, not posted', async () => {
    const due = at('2026-10-30T09:00:00Z');
    const store = memoryStore([{ schedule: { kind: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, nextRunAt: due }]);
    const { client } = fakeClient();
    const { posts, post } = recorder();
    const result = await runDueScheduledMessages(client, { store, now: due + MAX_LATE_MS + MIN, post });
    assert.equal(result.skipped, 1);
    assert.equal(posts.length, 0);
    assert.match(store.data[0].lastError, /Skipped the run of 2026-10-30 09:00 \(UTC\): the bot was offline/);
    assert.equal(store.data[0].failureCount, 0, 'not a failure');
    assert.equal(iso(store.data[0].nextRunAt), '2026-10-31T09:00:00.000Z');
});

test('runner: failures record last_error; the third in a row pauses it and alerts the alerts channel once', async () => {
    const store = memoryStore([{ schedule: { kind: 'interval', date: '2026-10-30', time: '09:00', hours: 1 }, nextRunAt: at('2026-10-30T09:00:00Z') }]);
    const { client } = fakeClient();
    const { posts, post } = recorder({ fail: permissionError });
    const alerts = [];
    const postModLog = async (...args) => alerts.push(args);
    for (let i = 0; i < FAILURE_LIMIT; i += 1) {
        const now = at('2026-10-30T09:00:30Z') + i * HOUR;
        await runDueScheduledMessages(client, { store, now, post, postModLog });
        assert.equal(store.data[0].failureCount, i + 1);
        assert.equal(store.data[0].lastError, 'I am missing Send Messages in #general. Nothing was posted.');
        assert.equal(store.data[0].paused, i + 1 >= FAILURE_LIMIT, `paused after ${i + 1}?`);
        assert.equal(alerts.length, i + 1 >= FAILURE_LIMIT ? 1 : 0);
    }
    assert.equal(posts.length, FAILURE_LIMIT);
    const [alertClient, kind, fields, options] = alerts[0];
    assert.equal(alertClient, client);
    assert.equal(kind, 'system');
    assert.match(options.title, /Scheduled message paused/);
    assert.match(fields.map((f) => f.value).join('\n'), /#1 in <#500000000000000001>[\s\S]*missing Send Messages/);
    // Paused: later ticks do nothing.
    await runDueScheduledMessages(client, { store, now: at('2026-10-31T09:00:30Z'), post, postModLog });
    assert.equal(posts.length, FAILURE_LIMIT);
});

test('runner: a success resets the failure count; a missing channel is a failure; a failing one-time message retries in 5 min', async () => {
    const store = memoryStore([{ schedule: { kind: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, nextRunAt: at('2026-10-30T09:00:00Z'), failureCount: 2, lastError: 'old' }]);
    const ok = fakeClient();
    const r = recorder();
    await runDueScheduledMessages(ok.client, { store, now: at('2026-10-30T09:00:30Z'), post: r.post });
    assert.equal(store.data[0].failureCount, 0);
    assert.equal(store.data[0].lastError, null);

    const missing = fakeClient({ channelMissing: true });
    const onceStore = memoryStore([{ schedule: { kind: 'once', date: '2026-10-30', time: '09:00' }, nextRunAt: at('2026-10-30T09:00:00Z') }]);
    const now = at('2026-10-30T09:00:30Z');
    const m = recorder();
    await runDueScheduledMessages(missing.client, { store: onceStore, now, post: m.post });
    assert.equal(m.posts.length, 0, 'nothing to post into');
    assert.equal(onceStore.data[0].lastError, 'The channel no longer exists.');
    assert.equal(onceStore.data[0].nextRunAt, now + RETRY_MS, 'retried, not lost');
    assert.equal(onceStore.data[0].paused, false);
});

test('runner: does nothing before the client is ready', async () => {
    const store = memoryStore([{ schedule: { kind: 'weekly', time: '09:00', days: [5] }, nextRunAt: 0 }]);
    store.due = async () => assert.fail('not read');
    const result = await runDueScheduledMessages({ isReady: () => false }, { store, now: Date.now(), post: async () => assert.fail('no post') });
    assert.deepEqual(result, { posted: 0, failed: 0, skipped: 0, paused: 0 });
});

// ── service functions used by the dashboard ───────────────────────────────

test('create: time zone canonicalised, first run computed, past times and the 50 limit refused', async () => {
    const store = memoryStore();
    const now = at('2026-10-29T12:00:00Z');
    const row = await createScheduledMessage({ guildId: GUILD, channelId: CHANNEL, payload: { content: 'Hi', embed: null, extra: 'dropped' }, schedule: { kind: 'once', date: '2026-11-02', time: '09:15' }, timezone: 'europe/vilnius', createdBy: '2' }, { store, now });
    assert.equal(row.timezone, 'Europe/Vilnius');
    assert.equal(iso(row.nextRunAt), '2026-11-02T07:15:00.000Z');
    assert.deepEqual(row.payload, { content: 'Hi', embed: null });
    await assert.rejects(createScheduledMessage({ guildId: GUILD, channelId: CHANNEL, payload: { content: 'x' }, schedule: { kind: 'once', date: '2026-10-01', time: '09:15' }, timezone: 'UTC', createdBy: '2' }, { store, now }), /already passed/);
    await assert.rejects(createScheduledMessage({ guildId: GUILD, channelId: CHANNEL, payload: { content: 'x' }, schedule: { kind: 'once', date: '2026-12-01', time: '09:15' }, timezone: 'Mars/Base', createdBy: '2' }, { store, now }), /not a known time zone/);
    const full = memoryStore(Array.from({ length: SCHEDULED_MAX_PER_GUILD }, () => ({ schedule: { kind: 'weekly', time: '09:00', days: [1] }, nextRunAt: now + HOUR })));
    await assert.rejects(createScheduledMessage({ guildId: GUILD, channelId: CHANNEL, payload: { content: 'x' }, schedule: { kind: 'weekly', time: '09:00', days: [1] }, timezone: 'UTC', createdBy: '2' }, { store: full, now }), /at most 50/);
});

test('pause / resume / edit / run now: resume recomputes from now and clears failures; a finished one-time message cannot resume', async () => {
    const now = at('2026-10-30T12:00:00Z');
    const store = memoryStore([
        { schedule: { kind: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, nextRunAt: at('2026-10-28T09:00:00Z'), paused: true, failureCount: 3, lastError: 'x' },
        { schedule: { kind: 'once', date: '2026-10-01', time: '09:00' }, nextRunAt: null },
        { schedule: { kind: 'once', date: '2026-11-01', time: '09:00' }, nextRunAt: at('2026-11-01T09:00:00Z') },
    ]);
    const { after } = await setScheduledMessagePaused(GUILD, 1, false, { store, now });
    assert.equal(after.paused, false);
    assert.equal(iso(after.nextRunAt), '2026-10-31T09:00:00.000Z', 'from now, missed runs not replayed');
    assert.equal(after.failureCount, 0);
    await assert.rejects(setScheduledMessagePaused(GUILD, 2, false, { store, now }), /no future time left/);
    await assert.rejects(setScheduledMessagePaused(GUILD, 9, true, { store, now }), /no scheduled message #9/);

    const edited = await updateScheduledMessage(GUILD, 1, { channelId: CHANNEL, payload: { content: 'New' }, schedule: { kind: 'interval', date: '2026-10-30', time: '13:00', hours: 2 }, timezone: 'UTC' }, { store, now });
    assert.equal(iso(edited.after.nextRunAt), '2026-10-30T13:00:00.000Z');
    assert.equal(edited.before.payload.content, 'Hi');

    const { guild } = fakeClient();
    const r = recorder();
    const run = await runScheduledMessageNow(guild, 3, { store, now, post: r.post });
    assert.equal(run.message.id, '90000000000000001');
    assert.equal(r.posts.length, 1);
    assert.equal(store.data[2].nextRunAt, null, 'a one-time message run early is finished');
    const repeat = await runScheduledMessageNow(guild, 1, { store, now, post: r.post });
    assert.ok(repeat.message);
    assert.equal(iso(store.data[0].nextRunAt), '2026-10-30T13:00:00.000Z', 'a repeating one keeps its schedule');

    const failing = recorder({ fail: permissionError });
    await assert.rejects(runScheduledMessageNow(guild, 1, { store, now, post: failing.post }), /Bot cannot post/);
    assert.match(store.data[0].lastError, /missing Send Messages/);
    assert.equal(store.data[0].failureCount, 0, 'a manual run does not count towards the pause');
});
