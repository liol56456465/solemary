// Dashboard → Activity (services/stats/activityService.js, dashboard/activityPage.js):
// message counts are buffered per server and day (no content), a failed write is kept for
// the next run, the series has one entry per day, the page escapes and shows a 503 note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _pendingActivity, activitySeries, flushActivity, lastDays, noteMessage } from '../src/services/stats/activityService.js';
import { activityPage, barChart, totals } from '../src/services/dashboard/activityPage.js';

const G = '100000000000000001';
const NOW = Date.parse('2026-10-31T12:00:00Z');

test('counting: guild messages only, bots and DMs ignored; flush writes and keeps failures', async () => {
    _pendingActivity().clear();
    noteMessage({ guildId: G, author: { bot: false } }, NOW);
    noteMessage({ guildId: G, author: { bot: false } }, NOW);
    noteMessage({ guildId: G, author: { bot: true } }, NOW);
    noteMessage({ guildId: null, author: { bot: false } }, NOW);
    assert.deepEqual([..._pendingActivity()], [[`${G}|2026-10-31`, 2]]);
    await flushActivity({ query: async () => { throw new Error('db down'); } });
    assert.deepEqual([..._pendingActivity()], [[`${G}|2026-10-31`, 2]], 'kept for the next run');
    const writes = [];
    await flushActivity({ query: async (text, params) => { writes.push(params); return { rowCount: 1 }; } });
    assert.deepEqual(writes, [[G, '2026-10-31', 2]]);
    assert.equal(_pendingActivity().size, 0);
});

test('series: one entry per day, oldest first, sources merged', async () => {
    assert.deepEqual(lastDays(3, NOW), ['2026-10-29', '2026-10-30', '2026-10-31']);
    const query = async (text) => {
        if (text.includes('guild_daily_stats')) return { rows: [{ day: '2026-10-30', messages: 40 }] };
        if (text.includes('member_events')) return { rows: [{ day: '2026-10-31', kind: 'join', n: 3 }, { day: '2026-10-31', kind: 'leave', n: 1 }] };
        return { rows: [{ day: '2026-10-29', n: 2 }] };
    };
    const series = await activitySeries(G, { days: 3, now: NOW, query });
    assert.deepEqual(series, [
        { day: '2026-10-29', messages: 0, joins: 0, leaves: 0, cases: 2 },
        { day: '2026-10-30', messages: 40, joins: 0, leaves: 0, cases: 0 },
        { day: '2026-10-31', messages: 0, joins: 3, leaves: 1, cases: 0 },
    ]);
    assert.deepEqual(totals(series), { messages: 40, joins: 3, leaves: 1, cases: 2 });
});

test('page: charts with a text alternative and a table; database error → message', () => {
    const series = lastDays(30, NOW).map((day, i) => ({ day, messages: i, joins: 0, leaves: 0, cases: i % 3 }));
    const chart = barChart(series, 'messages', 'Messages').text ?? String(barChart(series, 'messages', 'Messages'));
    assert.equal((chart.match(/class="bar( today)?"/g) || []).length, 30);
    assert.match(chart, /aria-label="Messages per day for 30 days, 435 in total/);
    assert.ok(!/style=/.test(chart));
    const page = activityPage({ session: { username: 'a', csrf: 't' }, series });
    assert.match(page, /<h1>Activity<\/h1>/);
    assert.match(page, /Every day as a table/);
    assert.match(activityPage({ session: { username: 'a', csrf: 't' }, series: null }), /could not be loaded/);
});
