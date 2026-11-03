// Dashboard → Moderate → Raid timeline (dashboard/incidentPages.js, incidentRoutes.js):
// the list and one incident render escaped, without inline styles or scripts, with minute
// rows that expand and quiet minutes folded; a database error is a 503 that says so; an
// incident of another server is a 404; moderators get 403 (Administrator-only page), in
// the sidebar under Moderate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard, dashboardSettings } from '../src/services/dashboard/routes.js';
import { defaultOwnerDeps } from '../src/services/dashboard/ownerRoutes.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import { SESSION_COOKIE, signValue } from '../src/services/dashboard/security.js';
import { createConfirmStore } from '../src/services/dashboard/confirmTokens.js';
import { NAV } from '../src/services/dashboard/html.js';
import { ADMIN as ADMIN_LEVEL, requiredLevel, routeKey } from '../src/services/dashboard/permissions.js';
import { incidentDetailPage, incidentListPage, minuteChart } from '../src/services/dashboard/incidentPages.js';
import { namesFrom } from '../src/services/dashboard/incidentRoutes.js';
import { buildTimeline } from '../src/services/automod/incidentTimeline.js';

const SECRET = 'z'.repeat(64);
const GUILD = '100000000000000001';
const ADMIN = '200000000000000002';
const MOD = '200000000000000007';
const MODROLE = '600000000000000050';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};
const T0 = Date.parse('2026-11-03T14:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000);
const uid = (n) => `3000000000000000${String(n).padStart(2, '0')}`;
const SESSION = { username: 'admin', csrf: 't' };

const incident = { id: '7', guild_id: GUILD, trigger_kind: 'join_raid', started_at: at(30), ended_at: at(20 * 60), ended_by: ADMIN, report_id: null, event_count: 4, dropped_events: 0 };
const events = [
    { id: 1, at: at(30), kind: 'lockdown_start', detail: '10 accounts joined within 60 seconds' },
    { id: 2, at: at(31), kind: 'verification', detail: 'Raised to High' },
    { id: 3, at: at(95), kind: 'automod', target_id: uid(3), detail: '<script>alert(1)</script> rule: message deleted' },
    { id: 4, at: at(20 * 60), kind: 'lockdown_end', actor_id: ADMIN, detail: 'Ended by admin' },
];
const sources = {
    members: [{ id: 1, user_id: uid(1), kind: 'join', created_at: at(10) }, { id: 2, user_id: uid(3), kind: 'join', created_at: at(40) }],
    cases: [{ id: 5, case_code: 'abc2345', type: 'ban', target_user_id: uid(3), target_username: '<b>evil</b>', moderator_id: ADMIN, moderator_username: 'admin', is_auto: false, created_at: at(100) }],
    audit: [], report: null, truncated: {},
};

const textOf = (page) => String(page);

test('list page: rows with duration and a link, the running one marked; empty and error states', () => {
    const rows = [
        { ...incident, id: '8', started_at: at(3600), ended_at: null, event_count: 12, dropped_events: 3 },
        incident,
    ];
    const page = incidentListPage({ session: SESSION, rows, activeId: '8', now: T0 + 3600 * 1000 + 5 * 60 * 1000 });
    assert.match(page, /<h1>Raid timeline<\/h1>/);
    assert.match(page, /href="\/dashboard\/incidents\/8"/);
    assert.match(page, /Still running/);
    assert.match(page, /19 min/);
    assert.match(page, /\(\+3 not kept\)/);
    assert.match(page, /aria-current="page"[^>]*><span class="side-text">Raid timeline/);
    assert.ok(!/style=/.test(page) && !/<script>(?!<\/script>)/.test(page.replace(/<script src="[^"]+" defer><\/script>/, '')));
    assert.match(incidentListPage({ session: SESSION, rows: [] }), /No raids in the last 90 days/);
    assert.match(incidentListPage({ session: SESSION, rows: null }), /could not be loaded \(database\)/);
    // Never closed and not running: says so instead of guessing an end.
    assert.match(incidentListPage({ session: SESSION, rows: [{ ...incident, ended_at: null }], activeId: null }), /Not recorded/);
});

test('detail page: header, actions by type, chart, minute rows with quiet minutes folded; everything escaped', () => {
    const timeline = buildTimeline({ incident, events, sources });
    const names = new Map([[uid(1), 'first<joiner>']]);
    const page = textOf(incidentDetailPage({ session: SESSION, timeline, names }));
    assert.match(page, /<h1>Raid on 2026-11-03 14:00 UTC<\/h1>/);
    assert.match(page, /<dt>Duration<\/dt><dd><b>19 min<\/b>/);
    assert.match(page, /<dt>Joined<\/dt><dd><b>2<\/b>/);
    assert.match(page, /<th>Bans<\/th>/);
    assert.match(page, /<td>1<\/td><td>0<\/td><td>0<\/td><td>0<\/td><td>0<\/td><td>0<\/td><td>1<\/td><td>0<\/td>/, 'one ban, one automod action without a case');
    assert.match(page, /Verification level:<\/b> Raised to High/);
    assert.match(page, /Invites and DMs:<\/b> Not recorded/);
    assert.match(page, /class="chart chart-wide" role="img" aria-label="Joins per minute: 2 in total/);
    assert.match(page, /<li class="minute-gap muted">18 quiet minutes<\/li>/);
    assert.match(page, /<summary><b>2026-11-03 14:00 UTC<\/b> <span class="muted">2 joins · 2 lockdown steps<\/span><\/summary>/);
    assert.match(page, /<details open>/, 'few minutes: rows start open');
    assert.match(page, /href="\/dashboard\/cases\/abc2345"/);
    assert.match(page, /href="\/dashboard\/users\/300000000000000001">first&lt;joiner&gt;<\/a>/);
    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!page.includes('<b>evil</b>'));
    assert.ok(!/style=/.test(page));
    assert.match(textOf(incidentDetailPage({ session: SESSION, timeline: null })), /could not be loaded \(database\)/);
});

test('detail page: dropped events and a lost end are explained', () => {
    const timeline = buildTimeline({ incident: { ...incident, ended_at: null, dropped_events: 40 }, events, sources });
    const page = textOf(incidentDetailPage({ session: SESSION, timeline }));
    assert.match(page, /Only the first 2000 lockdown, join gate and automod events were kept; 40 more happened\./);
    assert.match(page, /The end of this lockdown was not recorded/);
    assert.match(page, /<dt>Ended<\/dt><dd><b>Not recorded<\/b>/);
});

test('chart: bars are CSS classes, labels every few bars', () => {
    const chart = { bucketMinutes: 5, buckets: Array.from({ length: 12 }, (_, i) => ({ start: T0 + i * 300000, joins: i, actions: 0 })) };
    const out = textOf(minuteChart(chart, 'joins', 'Joins'));
    assert.equal((out.match(/class="bar"/g) || []).length, 12);
    assert.match(out, /class="h-10"/);
    assert.match(out, /per 5 minutes: 66 in total/);
    assert.ok(!/style=/.test(out));
});

test('names come from the bot cache only', () => {
    const client = {
        guilds: { cache: new Map([[GUILD, { members: { cache: new Map([[uid(1), { user: { username: 'amy' } }]]) } }]]) },
        users: { cache: new Map([[uid(2), { username: 'bob' }]]) },
    };
    const names = namesFrom(client, GUILD, [uid(1), uid(2), uid(3), null, uid(1)]);
    assert.deepEqual([...names], [[uid(1), 'amy'], [uid(2), 'bob']]);
});

test('access table and sidebar: Administrator-only, listed under Moderate', () => {
    assert.equal(routeKey('GET', '/incidents'), 'page:incidents');
    assert.equal(routeKey('GET', '/incidents/12'), 'page:incidents');
    assert.equal(requiredLevel('page:incidents'), ADMIN_LEVEL);
    const moderate = NAV.find((group) => group.group === 'Moderate');
    assert.ok(moderate.items.some((item) => item.key === 'incidents' && item.label === 'Raid timeline'));
});

// ── end to end through requireUser ────────────────────────────────────────

function fakeRes() {
    return {
        statusCode: 200, headers: {}, body: null,
        status(code) { this.statusCode = code; return this; },
        type() { return this; },
        send(body) { this.body = body; return this; },
        set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; },
        append() { return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
}

async function setup(userId, incidents) {
    const guild = { id: GUILD, name: 'Main', members: { cache: new Map() }, roles: { cache: new Map() } };
    const client = { user: { id: '999999999999999998' }, guilds: { cache: new Map([[GUILD, guild]]) }, users: { cache: new Map(), fetch: async () => null } };
    const sessions = createMemorySessionStore();
    const access = createAccessChecker(client, {
        facts: async (c, id) => ({ inGuild: true, isAdmin: id === ADMIN, isOwnerId: false, isModerator: id === MOD }),
    });
    const calls = [];
    const wrapped = Object.fromEntries(Object.entries(incidents).map(([name, fn]) => [name, async (...args) => { calls.push(name); return fn(...args); }]));
    const d = createDashboard({
        client, settings: dashboardSettings(ENV), sessions, access, env: ENV, confirms: createConfirmStore(),
        services: { getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) },
        auditStore: { writeRows: async () => 0, list: async () => ({ rows: [], total: 0 }), users: async () => [] },
        data: { overview: { getGuildConfig: async () => ({ modRole: MODROLE }), getWelcomeConfig: async () => ({}) } },
        enforcement: { getGuildConfig: async () => ({ modRole: MODROLE }), isBotOwner: () => false },
        owner: { ...defaultOwnerDeps, isBotOwner: () => false },
        incidents: wrapped,
    });
    const session = await sessions.create({ userId, username: 'staff' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, cookie, calls };
}

async function get(h, handler, path, params = {}) {
    const res = fakeRes();
    let passed = false;
    const req = { method: 'GET', path, originalUrl: `/dashboard${path}`, params, query: {}, headers: { cookie: h.cookie } };
    await h.d.requireUser(req, res, () => { passed = true; });
    if (passed) await handler(req, res);
    res.passed = passed;
    return res;
}

const goodData = {
    list: async () => [incident],
    get: async (guildId, id) => (guildId === GUILD && id === '7' ? incident : null),
    events: async () => events,
    sources: async () => sources,
    activeId: async () => null,
};

test('admin: list and detail render; another server\'s or a missing incident is 404; bad id is 404 without a read', async () => {
    const h = await setup(ADMIN, goodData);
    const list = await get(h, h.d.incidents.list, '/incidents');
    assert.equal(list.statusCode, 200, String(list.body).slice(0, 300));
    assert.match(list.body, /Open timeline/);
    const detail = await get(h, h.d.incidents.detail, '/incidents/7', { id: '7' });
    assert.equal(detail.statusCode, 200);
    assert.match(detail.body, /Minute by minute/);
    const missing = await get(h, h.d.incidents.detail, '/incidents/8', { id: '8' });
    assert.equal(missing.statusCode, 404);
    h.calls.length = 0;
    const bad = await get(h, h.d.incidents.detail, '/incidents/abc', { id: 'abc' });
    assert.equal(bad.statusCode, 404);
    assert.deepEqual(h.calls, [], 'nothing read for a bad id');
});

test('admin: a database error is a 503 page that says so (list and detail)', async () => {
    const boom = async () => { throw new Error('db down'); };
    const h = await setup(ADMIN, { ...goodData, list: boom, sources: boom });
    const list = await get(h, h.d.incidents.list, '/incidents');
    assert.equal(list.statusCode, 503);
    assert.match(list.body, /could not be loaded \(database\)/);
    const detail = await get(h, h.d.incidents.detail, '/incidents/7', { id: '7' });
    assert.equal(detail.statusCode, 503);
    assert.match(detail.body, /could not be loaded \(database\)/);
    // The lockdown state failing does not break the pages, and an open incident says the status could not be read.
    const open = { ...incident, ended_at: null };
    const h2 = await setup(ADMIN, { ...goodData, list: async () => [open], get: async () => open, activeId: boom });
    const list2 = await get(h2, h2.d.incidents.list, '/incidents');
    assert.equal(list2.statusCode, 200);
    assert.match(list2.body, /Could not be read/);
    const detail2 = await get(h2, h2.d.incidents.detail, '/incidents/7', { id: '7' });
    assert.equal(detail2.statusCode, 200);
    assert.match(detail2.body, /Whether this lockdown is still running could not be read/);
    assert.doesNotMatch(detail2.body, /The end of this lockdown was not recorded/);
});

test('moderator: 403 on the list and on an incident, before any data is read', async () => {
    const h = await setup(MOD, goodData);
    for (const [path, handler, params] of [['/incidents', h.d.incidents.list, {}], ['/incidents/7', h.d.incidents.detail, { id: '7' }]]) {
        const res = await get(h, handler, path, params);
        assert.equal(res.statusCode, 403, path);
        assert.equal(res.passed, false, path);
    }
    assert.deepEqual(h.calls, []);
});
