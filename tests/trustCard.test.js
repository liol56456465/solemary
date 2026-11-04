// Public trust card (/trust): the SQL filters, the read (bot cache, heads-up counts, errors),
// small-number masking, the cached reader, the setting, and the page (off → 404 + no footer
// link + not in the sitemap, on → masked numbers, DB error → 503, a failed cat or rules read
// hides only that block, share image, no inline style or script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
    MIN_MEMBERS, TRUST_DAYS, casesPerThousandText, createTrustCardReader, goodStandingText, rateText, readTrustCard,
    standingQuery, trustAppealsQuery, trustCardView, trustCasesQuery,
} from '../src/services/enforcement/trustCardService.js';
import { ladderSentence } from '../src/services/site/pages/trust.js';
import { createSite, sitemapXml } from '../src/services/site/site.js';
import { getSettingEntry, seedValue, validateSetting } from '../src/services/settings/settingsRegistry.js';

const NOW = new Date('2026-11-01T12:00:00Z');
const GUILD = '100000000000000001';

// ── SQL ───────────────────────────────────────────────────────────────────

test('appeals SQL: appeals only, joined to counted cases, first answer = earlier of claim and decision', () => {
    const since = new Date('2026-08-03T12:00:00Z');
    const { text, params } = trustAppealsQuery(GUILD, since);
    assert.deepEqual(params, [GUILD, since]);
    assert.match(text, /a\.kind = 'appeal'/);
    assert.match(text, /JOIN \S+ c ON c\.case_code = a\.case_code/);
    assert.match(text, /c\.guild_id = \$1 AND a\.created_at >= \$2/);
    assert.match(text, /c\.is_test = FALSE AND c\.is_imported = FALSE/);
    assert.match(text, /LEAST\(a\.claimed_at, CASE WHEN a\.status IN \('accepted', 'denied'\) AND a\.decided_at IS NOT NULL THEN a\.decided_at END\)/);
    assert.match(text, /percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY m\.first_hours\)/);
    assert.match(text, /percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY m\.decision_hours\)/);
    const outer = text.slice(0, text.indexOf('FROM'));
    for (const forbidden of ['user_id', 'username', 'decided_by', 'note', 'body', 'case_code']) assert.ok(!outer.includes(forbidden), forbidden);
});

test('cases SQL: test, imported and voided cases are left out', () => {
    const { text } = trustCasesQuery(GUILD, new Date());
    assert.match(text, /c\.is_test = FALSE AND c\.is_imported = FALSE AND c\.voided_at IS NULL/);
    assert.match(text, /c\.guild_id = \$1 AND c\.created_at >= \$2/);
});

test('standing SQL: counted warns or an active mute/ban, among the given members, one count out', () => {
    const { text, params } = standingQuery(GUILD, ['1', '2']);
    assert.deepEqual(params, [GUILD, ['1', '2']]);
    assert.match(text, /l\.warns_since_level > 0 AND l\.user_id = ANY\(\$2::text\[\]\)/);
    assert.match(text, /c\.type IN \('mute', 'ban'\) AND c\.status IN \('active', 'appeal_pending'\)/);
    assert.match(text, /c\.voided_at IS NULL AND c\.is_test = FALSE AND c\.target_user_id = ANY\(\$2::text\[\]\)/);
    assert.match(text, /UNION/, 'someone with both counts once');
    assert.match(text, /^SELECT COUNT\(\*\)::int AS flagged/);
});

// ── Read ──────────────────────────────────────────────────────────────────

function fakeClient({ memberCount = 200, ids = ['11', '12', '13'], ready = true, name = 'Mewvo' } = {}) {
    const guild = { name, memberCount, members: { cache: new Map(ids.map((id) => [id, {}])) } };
    return { isReady: () => ready, guilds: { cache: new Map([[GUILD, guild]]) } };
}

const APPEAL_ROW = { received: 9, accepted: 4, denied: 2, answered: 7, median_first_hours: '5.2', decided: 6, median_decision_hours: 30.4 };

function fakeRun(seen = []) {
    return async (text, params) => {
        seen.push({ text, params });
        if (text.includes('percentile_cont')) return { rows: [APPEAL_ROW] };
        if (text.includes('flagged')) return { rows: [{ flagged: 6 }] };
        return { rows: [{ cases: '14' }] };
    };
}

test('readTrustCard: 90 days back, three queries + heads-up counts, numbers parsed', async () => {
    const seen = [];
    const headsUpCalls = [];
    const card = await readTrustCard(GUILD, {
        client: fakeClient(), now: NOW, run: fakeRun(seen),
        headsUp: async (id, options) => { headsUpCalls.push({ id, options }); return { sent: 10, fixed: 8, acted: 2 }; },
    });
    assert.equal(seen.length, 3);
    for (const q of seen.filter((s) => !s.text.includes('flagged'))) assert.equal(q.params[1].toISOString(), '2026-08-03T12:00:00.000Z');
    assert.deepEqual(seen.find((s) => s.text.includes('flagged')).params[1], ['11', '12', '13'], 'the cached members');
    assert.deepEqual(headsUpCalls, [{ id: GUILD, options: { days: TRUST_DAYS, now: NOW.getTime() } }]);
    assert.equal(card.serverName, 'Mewvo');
    assert.equal(card.memberCount, 200);
    assert.equal(card.cases, 14);
    assert.equal(card.flagged, 6);
    assert.deepEqual(card.appeals, { received: 9, accepted: 4, denied: 2, answered: 7, decided: 6, medianFirstHours: 5.2, medianDecisionHours: 30.4 });
    assert.deepEqual(card.headsUp, { fixed: 8, acted: 2 });
});

test('readTrustCard: under 10 members the standing query is skipped; errors throw (never zeros)', async () => {
    const seen = [];
    const small = await readTrustCard(GUILD, { client: fakeClient({ memberCount: MIN_MEMBERS - 1 }), now: NOW, run: fakeRun(seen), headsUp: async () => ({ fixed: 0, acted: 0 }) });
    assert.equal(seen.length, 2);
    assert.equal(small.flagged, null);
    const headsUp = async () => ({ fixed: 0, acted: 0 });
    await assert.rejects(readTrustCard(GUILD, { client: fakeClient(), now: NOW, run: async () => { throw new Error('connection lost'); }, headsUp }), /connection lost/);
    await assert.rejects(readTrustCard(GUILD, { client: fakeClient(), now: NOW, run: async () => ({}), headsUp }), /no rows/);
    await assert.rejects(readTrustCard(GUILD, { client: fakeClient(), now: NOW, run: fakeRun(), headsUp: async () => { throw new Error('kv down'); } }), /kv down/);
    await assert.rejects(readTrustCard(GUILD, { client: fakeClient({ ready: false }), now: NOW, run: fakeRun(), headsUp }), /not connected/);
    await assert.rejects(readTrustCard('999', { client: fakeClient(), now: NOW, run: fakeRun(), headsUp }), /not in the cache/);
    await assert.rejects(readTrustCard(null, { client: fakeClient(), now: NOW, run: fakeRun(), headsUp }), /MAIN_GUILD_ID/);
});

// ── Masking and math ──────────────────────────────────────────────────────

test('rates: hidden under 3, rounded to whole percent', () => {
    assert.equal(rateText(1, 2), null);
    assert.equal(rateText(0, 0), null);
    assert.equal(rateText(2, 3), '67%');
    assert.equal(rateText(0, 5), '0%');
    assert.equal(rateText(9, 9), '100%');
});

test('heads-up fix rate is fixed / (fixed + acted); sent is not part of it', () => {
    const view = (fixed, acted) => trustCardView({ ...CARD, headsUp: { fixed, acted } }).headsUpRate;
    assert.equal(view(8, 2), '80%');
    assert.equal(view(1, 2), '33%');
    assert.equal(view(2, 0), null, 'fewer than 3');
    assert.equal(view(0, 0), null);
});

test('good standing: hidden under 10 members, rounded down while anyone is flagged', () => {
    assert.equal(goodStandingText(9, 0), null);
    assert.equal(goodStandingText(200, null), null);
    assert.equal(goodStandingText(10, 0), '100%');
    assert.equal(goodStandingText(10, 1), '90%');
    assert.equal(goodStandingText(1000, 1), '99%', 'not rounded up to 100%');
    assert.equal(goodStandingText(200, 6), '97%');
    assert.equal(goodStandingText(10, 50), '0%');
});

test('cases per 1,000 members: hidden under 10 members or with 1–2 cases', () => {
    assert.equal(casesPerThousandText(14, 9), null);
    assert.equal(casesPerThousandText(2, 500), null);
    assert.equal(casesPerThousandText(0, 500), '0');
    assert.equal(casesPerThousandText(14, 200), '70');
    assert.equal(casesPerThousandText(3, 700), '4.3');
});

const CARD = {
    days: 90, since: new Date('2026-08-03T12:00:00Z'), generatedAt: NOW, serverName: 'Mewvo <b>', memberCount: 200,
    appeals: { received: 9, accepted: 4, denied: 2, answered: 7, decided: 6, medianFirstHours: 5.2, medianDecisionHours: 30.4 },
    cases: 14, flagged: 6, headsUp: { fixed: 8, acted: 2 },
};
const SMALL_CARD = {
    ...CARD,
    appeals: { received: 2, accepted: 1, denied: 1, answered: 2, decided: 2, medianFirstHours: 3, medianDecisionHours: 4 },
    cases: 1, headsUp: { fixed: 1, acted: 1 },
};

test('view: 1–2 counts become "fewer than 3", rates and medians under 3 are hidden', () => {
    const full = trustCardView(CARD);
    assert.equal(full.received.text, '9');
    assert.equal(full.decided.text, '6');
    assert.equal(full.firstAnswer, '5 hours');
    assert.equal(full.decisionTime, '30 hours');
    assert.equal(full.successRate, '67%');
    assert.equal(full.goodStanding, '97%');
    assert.equal(full.casesPerThousand, '70');
    assert.equal(full.headsUpRate, '80%');
    const small = trustCardView(SMALL_CARD);
    assert.deepEqual(small.received, { text: 'fewer than 3', masked: true, kind: 'fewer', value: 3 });
    assert.deepEqual(small.decided, { text: 'fewer than 3', masked: true, kind: 'fewer', value: 3 });
    for (const key of ['firstAnswer', 'decisionTime', 'successRate', 'casesPerThousand', 'headsUpRate', 'firstAnswerParts', 'decisionTimeParts', 'casesPerThousandValue']) assert.equal(small[key], null, key);
    assert.deepEqual(full.firstAnswerParts, { unit: 'hours', value: 5 });
    assert.equal(full.casesPerThousandValue, 70);
});

test('ladder sentence comes from the enforcement config', () => {
    assert.equal(ladderSentence({ warnsPerLevel: 3, ladderBans: { 1: 7 * 86400000, 2: 30 * 86400000, 3: null } }),
        'Warnings add up: the third warning brings a 7-day ban, and each warning after that ban brings a longer one (a 30-day ban, then a permanent ban).');
    assert.ok(!/—/.test(ladderSentence()), 'no em dash');
});

// ── Cache ─────────────────────────────────────────────────────────────────

test('reader: cached for 10 minutes and shared; a failed read is not cached', async () => {
    let clock = 0;
    let calls = 0;
    let fail = true;
    const client = fakeClient();
    const read = async (guildId, options) => {
        calls += 1;
        assert.equal(guildId, GUILD);
        assert.equal(options.client, client);
        if (fail) throw new Error('db down');
        return { calls };
    };
    const reader = createTrustCardReader({ guildId: () => GUILD, client, read, now: () => clock });
    await assert.rejects(reader(), /db down/);
    fail = false;
    const [a, b] = await Promise.all([reader(), reader()]);
    assert.equal(calls, 2, 'the failure was not cached; concurrent views share one read');
    assert.equal(a, b);
    clock += 9 * 60 * 1000;
    await reader();
    assert.equal(calls, 2);
    clock += 2 * 60 * 1000;
    await reader();
    assert.equal(calls, 3);
});

// ── Setting ───────────────────────────────────────────────────────────────

test('setting: trustCardEnabled is a main-server boolean, off by default', () => {
    const entry = getSettingEntry('trustCardEnabled');
    assert.equal(entry.guild, 'main');
    assert.equal(entry.kind, 'boolean');
    assert.equal(seedValue(entry, {}), false);
    assert.equal(validateSetting('trustCardEnabled', true).ok, true);
    assert.equal(validateSetting('trustCardEnabled', 'yes').ok, false);
});

// ── Page ──────────────────────────────────────────────────────────────────

const CAT = { name: 'Biscuit', stage: { name: 'Young cat' }, mood: 'happy', image: 'young-happy.png' };
const RULES = { rules: [{ number: 1, title: 'No spam' }, { number: 2, title: 'Be <kind>' }], updatedAt: null };

async function serve({ enabled = true, transparency = false, read = async () => CARD, cat = async () => CAT, rules = async () => RULES, env = {} } = {}) {
    const app = express();
    const reads = { count: 0 };
    app.use(createSite({
        client: { commands: new Map() }, env: { CLIENT_ID: '123456789012345678', ...env },
        leaderboard: async () => ({ enabled: true, rows: [] }), status: () => ({ state: 'online', uptimeMs: 1000 }),
        transparency: { enabled: () => transparency, read: async () => { throw new Error('not used'); } },
        trust: { enabled: () => (typeof enabled === 'function' ? enabled() : enabled), read: async () => { reads.count += 1; return read(); } },
        cat, rules,
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
        const res = await fetch(base + path, { redirect: 'manual' });
        return { status: res.status, headers: res.headers, body: await res.text() };
    };
    return { get, reads, close: () => new Promise((resolve) => server.close(resolve)) };
}

const PUBLIC = { PUBLIC_SITE_ENABLED: 'true', PUBLIC_URL: 'https://mewvo.example' };

test('off: /trust is the 404 page, nothing is read, no footer link, not in the sitemap', async () => {
    const site = await serve({ enabled: false, env: PUBLIC });
    try {
        const page = await site.get('/trust');
        assert.equal(page.status, 404);
        assert.match(page.body, /Page not found/);
        assert.equal(site.reads.count, 0);
        assert.ok(!(await site.get('/')).body.includes('href="/trust"'));
        assert.ok(!(await site.get('/sitemap.xml')).body.includes('/trust'));
    } finally { await site.close(); }
});

test('a setting read that throws counts as off', async () => {
    const site = await serve({ enabled: () => { throw new Error('settings not loaded'); } });
    try {
        assert.equal((await site.get('/trust')).status, 404);
        assert.ok(!(await site.get('/faq')).body.includes('href="/trust"'));
    } finally { await site.close(); }
});

test('on: tiles, how it moderates, rules, cat, footer link, sitemap, cat share image, no inline style/script', async () => {
    const site = await serve({ env: PUBLIC });
    try {
        const page = await site.get('/trust');
        assert.equal(page.status, 200);
        assert.equal(page.headers.get('cache-control'), 'no-cache');
        const body = page.body;
        assert.match(body, /<h1>Mewvo &lt;b&gt;: trust card<\/h1>/, 'server name escaped');
        assert.match(body, /First answer on an appeal<\/dt><dd class="trust-value">5 hours<\/dd>/);
        assert.match(body, /Appeals accepted<\/dt><dd class="trust-value">67%<\/dd>/);
        assert.match(body, /Members in good standing<\/dt><dd class="trust-value">97%<\/dd>/);
        assert.match(body, /Fixed after a heads-up<\/dt><dd class="trust-value">80%<\/dd>/);
        assert.match(body, /Members fixed 80% of flagged messages themselves after a heads-up\./);
        assert.match(body, /Cases per 1,000 members<\/dt><dd>70<\/dd>/);
        assert.match(body, /the third warning brings a 7-day ban/);
        assert.match(body, /decided by a person/);
        assert.match(body, /case with its own code/);
        assert.match(body, /<li><a href="\/rules#rule-1">No spam<\/a><\/li><li><a href="\/rules#rule-2">Be &lt;kind&gt;<\/a><\/li>/);
        assert.match(body, /<img src="\/img\/cat\/young-happy\.png"[^>]*alt="Biscuit, the server cat/);
        assert.match(body, /Last 90 days, from .* Small numbers are hidden\.<\/p>/);
        assert.ok(!body.includes('href="/transparency"'), 'no transparency link while it is off');
        assert.match(body, /<li><a href="\/trust" aria-current="page">Trust card<\/a><\/li>/);
        assert.match(body, /<meta property="og:image" content="https:\/\/mewvo\.example\/img\/cat\/young-happy\.png">/);
        assert.match(body, /<meta name="twitter:card" content="summary">/);
        assert.match(body, /<link rel="canonical" href="https:\/\/mewvo\.example\/trust">/);
        assert.ok(!/style=|<script/i.test(body));
        assert.ok(!/—/.test(body.slice(body.indexOf('<main'), body.indexOf('</main>'))), 'no em dash in the page');
        const main = body.slice(body.indexOf('<main'), body.indexOf('</main>'));
        assert.ok(!/\d{17,20}/.test(main), 'no snowflake');
        assert.match((await site.get('/about')).body, /href="\/trust"/);
        assert.match((await site.get('/sitemap.xml')).body, /<loc>https:\/\/mewvo\.example\/trust<\/loc>/);
        // Other pages keep the default share image.
        assert.match((await site.get('/about')).body, /og:image" content="https:\/\/mewvo\.example\/img\/og\.png"/);
    } finally { await site.close(); }
});

test('on: small numbers masked, rates and medians say not enough data', async () => {
    const site = await serve({ read: async () => SMALL_CARD });
    try {
        const body = (await site.get('/trust')).body;
        assert.match(body, /Appeals received<\/dt><dd>fewer than 3<\/dd>/);
        assert.match(body, /Of fewer than 3 appeals decided\./);
        assert.match(body, /First answer on an appeal<\/dt><dd class="trust-value trust-none">Not enough data yet<\/dd>/);
        assert.match(body, /Appeals accepted<\/dt><dd class="trust-value trust-none">Not enough data yet/);
        assert.match(body, /Fixed after a heads-up<\/dt><dd class="trust-value trust-none">Not enough data yet/);
        assert.match(body, /Cases per 1,000 members<\/dt><dd>Not enough data yet/);
        assert.ok(!/\b[12]%/.test(body));
    } finally { await site.close(); }
});

test('good standing hidden under 10 members', async () => {
    const site = await serve({ read: async () => ({ ...CARD, memberCount: 9, flagged: null }) });
    try {
        assert.match((await site.get('/trust')).body, /Members in good standing<\/dt><dd class="trust-value trust-none">Not enough data yet/);
    } finally { await site.close(); }
});

test('transparency on: the footer note links the report', async () => {
    const site = await serve({ transparency: true });
    try {
        assert.match((await site.get('/trust')).body, /Full monthly numbers: <a href="\/transparency">Transparency report<\/a>\./);
    } finally { await site.close(); }
});

test('database error: 503, no numbers, no internal text; the next view reads again (nothing cached)', async () => {
    let fail = true;
    let calls = 0;
    const reader = createTrustCardReader({
        guildId: GUILD, read: async () => { calls += 1; if (fail) throw new Error('connection refused'); return CARD; },
    });
    const site = await serve({ read: reader });
    try {
        const page = await site.get('/trust');
        assert.equal(page.status, 503);
        assert.equal(page.headers.get('retry-after'), '120');
        assert.match(page.body, /trust card could not be loaded right now/);
        assert.ok(!/trust-tiles/.test(page.body));
        assert.ok(!page.body.includes('connection refused'));
        fail = false;
        assert.equal((await site.get('/trust')).status, 200);
        assert.equal(calls, 2);
    } finally { await site.close(); }
});

test('a failed cat read hides only the cat (and the cat share image); a failed rules read hides only the rules', async () => {
    const site = await serve({ cat: async () => { throw new Error('cat down'); }, rules: async () => { throw new Error('rules down'); }, env: PUBLIC });
    try {
        const page = await site.get('/trust');
        assert.equal(page.status, 200);
        assert.ok(!page.body.includes('trust-cat'));
        assert.ok(!page.body.includes('id="trust-rules"'));
        assert.match(page.body, /trust-tiles/);
        assert.match(page.body, /How this server moderates/);
        assert.match(page.body, /og:image" content="https:\/\/mewvo\.example\/img\/og\.png"/);
    } finally { await site.close(); }
});

test('sitemapXml lists /trust only when asked', () => {
    assert.ok(!sitemapXml('https://x.example').includes('/trust'));
    assert.match(sitemapXml('https://x.example', { trust: true }), /x\.example\/trust/);
});
