// Public transparency report: the SQL (filters, UTC month buckets), the aggregation of its
// rows (empty months, the median total row), small-number masking, the cached reader, and the
// /transparency page (off → 404 + no footer link, on → numbers only, DB error → 503).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
    REPORT_MONTHS, aggregateReport, appealsQuery, casesQuery, createTransparencyReader, maskCount, maskTotal,
    medianText, readTransparencyReport, reportMonths,
} from '../src/services/enforcement/transparencyService.js';
import { createSite, sitemapXml } from '../src/services/site/site.js';
import { getSettingEntry, validateSetting, seedValue } from '../src/services/settings/settingsRegistry.js';

const NOW = new Date('2026-10-29T13:00:00Z');
const GUILD = '100000000000000001';

// ── Months and SQL ────────────────────────────────────────────────────────

test('report months: six completed UTC months plus the current one, across a year boundary', () => {
    const months = reportMonths(NOW);
    assert.equal(months.length, REPORT_MONTHS);
    assert.deepEqual(months.map((m) => m.key), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    assert.deepEqual(months.map((m) => m.current), [false, false, false, false, false, false, true]);
    assert.equal(months[0].start.toISOString(), '2026-04-01T00:00:00.000Z');
    // Late on the 31st in UTC is still that month; January reaches back into last year.
    assert.equal(reportMonths(new Date('2026-01-31T23:59:59Z'))[0].key, '2025-07');
    assert.equal(reportMonths(new Date('2026-01-31T23:59:59Z'))[6].key, '2026-01');
});

test('cases SQL: main server, UTC months, test/imported excluded, voided counted apart, no identities selected', () => {
    const { text, params } = casesQuery(GUILD, new Date('2026-04-01T00:00:00Z'));
    assert.deepEqual(params, [GUILD, new Date('2026-04-01T00:00:00Z')]);
    assert.match(text, /date_trunc\('month', c\.created_at AT TIME ZONE 'UTC'\)/);
    assert.match(text, /GROUP BY 1/);
    assert.match(text, /c\.guild_id = \$1 AND c\.created_at >= \$2 AND c\.is_test = FALSE AND c\.is_imported = FALSE/);
    // Every action count skips voided cases; the voided column counts only them.
    for (const column of ['warns', 'mutes', 'kicks', 'bans', 'ladder_bans', 'automod']) {
        assert.match(text, new RegExp(`FILTER \\(WHERE [^)]*c\\.voided_at IS NULL\\)::int AS ${column}`), column);
    }
    assert.match(text, /FILTER \(WHERE c\.voided_at IS NOT NULL\)::int AS voided/);
    assert.match(text, /c\.type = 'ban' AND c\.is_auto/);
    assert.match(text, /c\.reason_key LIKE 'automod:%'/);
    const selectList = text.slice(0, text.indexOf('FROM'));
    for (const forbidden of ['case_code', 'target_user_id', 'target_username', 'moderator', 'reason,', 'reason ', 'name']) {
        assert.ok(!selectList.includes(forbidden), `selects ${forbidden}`);
    }
});

test('appeals SQL: appeals only, joined to counted cases, median of decided ones, one total row', () => {
    const { text, params } = appealsQuery(GUILD, new Date('2026-04-01T00:00:00Z'));
    assert.equal(params[0], GUILD);
    assert.match(text, /a\.kind = 'appeal'/);
    assert.match(text, /JOIN \S+ c ON c\.case_code = a\.case_code/);
    assert.match(text, /c\.guild_id = \$1 AND a\.created_at >= \$2/);
    assert.match(text, /c\.is_test = FALSE AND c\.is_imported = FALSE/);
    assert.match(text, /date_trunc\('month', a\.created_at AT TIME ZONE 'UTC'\)/);
    assert.match(text, /percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY m\.decision_hours\)/);
    assert.match(text, /a\.status IN \('accepted', 'denied'\) AND a\.decided_at IS NOT NULL/);
    assert.match(text, /GROUPING SETS \(\(m\.month\), \(\)\)/);
    const outer = text.slice(0, text.indexOf('FROM'));
    for (const forbidden of ['user_id', 'username', 'decided_by', 'note', 'body']) assert.ok(!outer.includes(forbidden), forbidden);
});

// ── Aggregation ───────────────────────────────────────────────────────────

const CASE_ROWS = [
    { month: '2026-05', warns: 12, mutes: 4, kicks: 2, bans: 5, ladder_bans: 2, automod: 6, voided: 1 },
    { month: '2026-10', warns: '7', mutes: '0', kicks: '0', bans: '3', ladder_bans: '3', automod: '1', voided: '0' },
    { month: '2025-12', warns: 99, mutes: 99, kicks: 99, bans: 99, ladder_bans: 0, automod: 0, voided: 0 }, // outside the window
];
const APPEAL_ROWS = [
    { month: '2026-05', is_total: false, received: 6, accepted: 2, denied: 3, open: 1, decided: 5, median_hours: 30.4 },
    { month: '2026-10', is_total: false, received: 2, accepted: 1, denied: 0, open: 1, decided: 1, median_hours: 0.5 },
    { month: null, is_total: true, received: 8, accepted: 3, denied: 3, open: 2, decided: 6, median_hours: '20.25' },
];

test('aggregation: rows land in their month, missing months are zeros, totals add up, total median from SQL', () => {
    const report = aggregateReport({ caseRows: CASE_ROWS, appealRows: APPEAL_ROWS }, NOW);
    assert.equal(report.months.length, 7);
    const may = report.months.find((m) => m.key === '2026-05');
    assert.deepEqual(may.cases, { warns: 12, mutes: 4, kicks: 2, bans: 5, ladderBans: 2, automod: 6, voided: 1 });
    assert.equal(may.appeals.medianHours, 30.4);
    const june = report.months.find((m) => m.key === '2026-06');
    assert.deepEqual(june.cases, { warns: 0, mutes: 0, kicks: 0, bans: 0, ladderBans: 0, automod: 0, voided: 0 });
    assert.equal(june.appeals.medianHours, null);
    assert.equal(report.months.at(-1).cases.warns, 7, 'text counts from pg are numbers');
    assert.equal(report.totals.cases.warns, 19, 'the row outside the window is ignored');
    assert.equal(report.totals.cases.bans, 8);
    assert.equal(report.totals.appeals.received, 8);
    assert.equal(report.totals.appeals.decided, 6);
    assert.equal(report.totals.appeals.medianHours, 20.25);
});

test('readTransparencyReport: two queries from the first report month; any error throws (never zeros)', async () => {
    const seen = [];
    const run = async (text, params) => {
        seen.push({ text, params });
        return { rows: text.includes('percentile_cont') ? APPEAL_ROWS : CASE_ROWS };
    };
    const report = await readTransparencyReport(GUILD, { now: NOW, run });
    assert.equal(seen.length, 2);
    for (const q of seen) assert.equal(q.params[1].toISOString(), '2026-04-01T00:00:00.000Z');
    assert.equal(report.totals.cases.warns, 19);
    await assert.rejects(readTransparencyReport(GUILD, { now: NOW, run: async () => { throw new Error('connection lost'); } }), /connection lost/);
    await assert.rejects(readTransparencyReport(GUILD, { now: NOW, run: async () => ({}) }), /no rows/);
    await assert.rejects(readTransparencyReport(null, { now: NOW, run }), /MAIN_GUILD_ID/);
});

// ── Masking ───────────────────────────────────────────────────────────────

test('small numbers: 1 and 2 are hidden, totals over a hidden month say "at least", medians need 3 decisions', () => {
    assert.deepEqual(maskCount(0), { text: '0', masked: false });
    assert.deepEqual(maskCount(1), { text: 'fewer than 3', masked: true });
    assert.deepEqual(maskCount(2), { text: 'fewer than 3', masked: true });
    assert.deepEqual(maskCount(3), { text: '3', masked: false });
    assert.deepEqual(maskCount(1234), { text: '1,234', masked: false });
    assert.deepEqual(maskTotal([5, 4, 0]), { text: '9', masked: false });
    assert.deepEqual(maskTotal([5, 2, 0]), { text: 'at least 6', masked: true }, 'the 2 cannot be worked out');
    assert.deepEqual(maskTotal([5, 1, 0]), { text: 'at least 6', masked: true }, 'same text for 1 and 2');
    assert.deepEqual(maskTotal([1, 1, 0]), { text: 'fewer than 3', masked: true });
    assert.deepEqual(maskTotal([0, 0]), { text: '0', masked: false });
    assert.equal(medianText(30, 2), null);
    assert.equal(medianText(null, 5), null);
    assert.equal(medianText(0.4, 3), 'under an hour');
    assert.equal(medianText(1.4, 3), '1 hour');
    assert.equal(medianText(30.4, 5), '30 hours');
    assert.equal(medianText(84, 5), '3.5 days');
});

// ── Cache ─────────────────────────────────────────────────────────────────

test('reader: cached for 10 minutes and shared; a failed read is not cached', async () => {
    let clock = 0;
    let calls = 0;
    let fail = true;
    const read = async (guildId) => {
        calls += 1;
        assert.equal(guildId, GUILD);
        if (fail) throw new Error('db down');
        return { calls };
    };
    const reader = createTransparencyReader({ guildId: () => GUILD, read, now: () => clock });
    await assert.rejects(reader(), /db down/);
    fail = false;
    const [a, b] = await Promise.all([reader(), reader()]);
    assert.equal(calls, 2, 'the failure was not cached; concurrent views share one read');
    assert.equal(a, b);
    clock += 9 * 60 * 1000;
    await reader();
    assert.equal(calls, 2, 'still cached after 9 minutes');
    clock += 2 * 60 * 1000;
    await reader();
    assert.equal(calls, 3, 'read again after 10 minutes');
});

// ── Setting ───────────────────────────────────────────────────────────────

test('setting: transparencyReportEnabled is a main-server boolean, off by default', () => {
    const entry = getSettingEntry('transparencyReportEnabled');
    assert.equal(entry.guild, 'main');
    assert.equal(entry.kind, 'boolean');
    assert.equal(seedValue(entry, {}), false);
    assert.equal(validateSetting('transparencyReportEnabled', true).ok, true);
    assert.equal(validateSetting('transparencyReportEnabled', 'yes').ok, false);
});

// ── Page ──────────────────────────────────────────────────────────────────

const REPORT = aggregateReport({ caseRows: CASE_ROWS, appealRows: APPEAL_ROWS }, NOW);

async function serve({ enabled = true, read = async () => REPORT, env = {} } = {}) {
    const app = express();
    const reads = { count: 0 };
    app.use(createSite({
        client: { commands: new Map() }, env: { CLIENT_ID: '123456789012345678', ...env },
        leaderboard: async () => ({ enabled: true, rows: [] }), status: () => ({ state: 'online', uptimeMs: 1000 }),
        transparency: { enabled: () => (typeof enabled === 'function' ? enabled() : enabled), read: async () => { reads.count += 1; return read(); } },
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
        const res = await fetch(base + path, { redirect: 'manual' });
        return { status: res.status, headers: res.headers, body: await res.text() };
    };
    return { get, reads, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('off: /transparency is the 404 page, nothing is read, no footer link, not in the sitemap', async () => {
    const site = await serve({ enabled: false, env: { PUBLIC_SITE_ENABLED: 'true', PUBLIC_URL: 'https://meowist.example' } });
    try {
        const page = await site.get('/transparency');
        assert.equal(page.status, 404);
        assert.match(page.body, /Page not found/);
        assert.equal(site.reads.count, 0);
        const home = await site.get('/');
        assert.ok(!home.body.includes('href="/transparency"'));
        const sitemap = await site.get('/sitemap.xml');
        assert.ok(!sitemap.body.includes('/transparency'));
    } finally { await site.close(); }
});

test('a setting read that throws counts as off', async () => {
    const site = await serve({ enabled: () => { throw new Error('settings not loaded'); } });
    try {
        assert.equal((await site.get('/transparency')).status, 404);
        assert.ok(!(await site.get('/faq')).body.includes('href="/transparency"'));
    } finally { await site.close(); }
});

test('on: numbers only, small counts hidden, current month marked, footer link and sitemap entry', async () => {
    const site = await serve({ env: { PUBLIC_SITE_ENABLED: 'true', PUBLIC_URL: 'https://meowist.example' } });
    try {
        const page = await site.get('/transparency');
        assert.equal(page.status, 200);
        assert.equal(page.headers.get('cache-control'), 'no-cache');
        const body = page.body;
        assert.match(body, /<h1>Transparency report<\/h1>/);
        assert.match(body, /April 2026/);
        assert.match(body, /October 2026 <span class="tag">so far<\/span>/);
        assert.ok(!body.includes('September 2025') && !body.includes('November 2026'));
        assert.match(body, /<td class="num">12<\/td>/, 'May warnings');
        assert.match(body, /fewer than 3/);
        assert.match(body, /at least/);
        assert.match(body, /30 hours/, 'May median');
        assert.match(body, /20 hours/, 'total median');
        assert.match(body, /not enough decisions/, 'October has one decision');
        assert.match(body, /Voided as mistakes/);
        assert.match(body, /Test simulations/);
        // No identities: no Discord IDs, no case-code-looking tokens in the tables, no inline style/script.
        // (The top bar's Add to Discord link carries the client ID; the report is in <main>.)
        const main = body.slice(body.indexOf('<main'), body.indexOf('</main>'));
        assert.ok(!/\d{17,20}/.test(main), 'no snowflake');
        assert.ok(!/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,7}\b/.test(main.replace(/<[^>]+>/g, ' ')), 'no case-code-looking token');
        const tables = [...body.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]).join('');
        const cells = [...tables.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);
        assert.ok(cells.length > 50);
        for (const text of cells) assert.match(text, /^(\d[\d,]*|fewer than 3|at least [\d,]+|not enough decisions|under an hour|\d+ hours?|[\d.]+ days)$/, text);
        assert.ok(!/style=|<script/i.test(body));
        assert.match(body, /<li><a href="\/transparency" aria-current="page">Transparency<\/a><\/li>/);
        assert.match((await site.get('/about')).body, /href="\/transparency"/);
        assert.match((await site.get('/sitemap.xml')).body, /<loc>https:\/\/meowist\.example\/transparency<\/loc>/);
    } finally { await site.close(); }
});

test('database error: 503 with a clear message and no numbers', async () => {
    const site = await serve({ read: async () => { throw new Error('connection refused'); } });
    try {
        const page = await site.get('/transparency');
        assert.equal(page.status, 503);
        assert.match(page.body, /could not be loaded right now because the database is not responding/);
        assert.ok(!/<table/.test(page.body));
        assert.ok(!page.body.includes('connection refused'), 'no internal error text');
    } finally { await site.close(); }
});

test('sitemapXml lists /transparency only when asked', () => {
    assert.ok(!sitemapXml('https://x.example').includes('/transparency'));
    assert.match(sitemapXml('https://x.example', { transparency: true }), /x\.example\/transparency/);
});
