// Owner area → Recent errors (/dashboard/owner/errors): owners only (others get the Owner area's
// plain 404), groups rendered and escaped, the search passed to the store, a database error
// answered with 503 "database not responding" (never an empty list), translated (de).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';

const { createDashboard, dashboardSettings } = await import('../src/services/dashboard/routes.js');
const { createMemorySessionStore } = await import('../src/services/dashboard/sessionStore.js');
const { createAccessChecker } = await import('../src/services/dashboard/access.js');
const { SESSION_COOKIE, signValue } = await import('../src/services/dashboard/security.js');
const { OWNER_NAV, navGroups } = await import('../src/services/dashboard/html.js');
const { dashboardText } = await import('../src/services/dashboard/language.js');

const SECRET = 'y'.repeat(64);
const OWNER = '200000000000000003';
const ADMIN = '200000000000000002';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: process.env.MAIN_GUILD_ID, NODE_ENV: 'test',
};
const GROUPS = [
    { error_code: 'COMMAND_ERROR', source: 'ban', error_type: 'unknown', count: 7, last_seen: new Date('2026-11-07T10:00:00Z'), servers: 2, sample_trace: 'int_ab12', guild_id: process.env.MAIN_GUILD_ID, message: 'pool <b>exhausted</b>' },
    { error_code: 'TASK_ERROR', source: 'giveaway_check', error_type: 'discord_api', count: 1, last_seen: new Date('2026-11-07T09:00:00Z'), servers: 0, sample_trace: null, guild_id: null, message: '' },
];

function fakeRes() {
    return {
        statusCode: 200, headers: {}, cookies: [], body: null, redirectedTo: null,
        status(code) { this.statusCode = code; return this; },
        type() { return this; },
        send(body) { this.body = body; return this; },
        set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; },
        append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
}

async function setup({ userId = OWNER, list = null } = {}) {
    const guilds = new Map([[process.env.MAIN_GUILD_ID, { id: process.env.MAIN_GUILD_ID, name: 'Main <i>server</i>' }]]);
    const client = { user: { id: '999999999999999998', username: 'Mewvo' }, guilds: { cache: guilds }, users: { cache: new Map(), fetch: async () => null } };
    const searches = [];
    const ownerErrors = { store: { list: async (filter) => { searches.push(filter); return list ? list(filter) : { groups: GROUPS, total: 8 }; } } };
    const owner = { isBotOwner: (id) => id === OWNER };
    const sessions = createMemorySessionStore({ ttlMs: 48 * 3600 * 1000 });
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: id === ADMIN || id === OWNER, isOwnerId: id === OWNER }) });
    const auditStore = { writeRows: async () => 0, list: async () => ({ rows: [], total: 0 }), users: async () => [] };
    const services = { postModLog: async () => {}, getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) };
    const data = { overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) } };
    const d = createDashboard({ client, settings: dashboardSettings(ENV), sessions, access, services, auditStore, env: ENV, data, owner, ownerErrors });
    const session = await sessions.create({ userId, username: 'owner' }, Date.now());
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, searches, cookie };
}

// The route's chain: requireUser → requireOwner → handler (routes.js).
async function get(h, { query = {}, lang = null } = {}) {
    const res = fakeRes();
    const req = { method: 'GET', params: {}, query, path: '/owner/errors', headers: { cookie: `${h.cookie}${lang ? `; mewvo_lang=${lang}` : ''}` } };
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (!passed) return res;
    let ownerOk = false;
    await h.d.owner.requireOwner(req, res, () => { ownerOk = true; });
    if (ownerOk) await h.d.ownerErrors.errors(req, res, () => {});
    return res;
}

test('recent errors: in the Owner nav (owners only), others get the plain 404 and no read', async () => {
    assert.ok(OWNER_NAV.items.some((item) => item.key === 'owner/errors'));
    assert.ok(!navGroups({ isOwner: false }).some((g) => g.items.some((i) => i.key === 'owner/errors')));
    const h = await setup({ userId: ADMIN });
    const res = await get(h);
    assert.equal(res.statusCode, 404);
    assert.doesNotMatch(res.body, /Recent errors<\/h1>|COMMAND_ERROR/);
    assert.equal(h.searches.length, 0, 'the store is never read for a non-owner');
});

test('recent errors: groups with count, last seen, sample Ref and server; text escaped', async () => {
    const h = await setup();
    const res = await get(h);
    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.match(body, /<h1>Recent errors<\/h1>/);
    assert.match(body, /<code>COMMAND_ERROR<\/code>/);
    assert.match(body, /<code>ban<\/code>/);
    assert.match(body, /<td>7<\/td>/);
    assert.match(body, /2026-11-07 10:00 UTC/);
    assert.match(body, /<code>COMMAND_ERROR · int_ab12<\/code>/, 'the Ref the user saw');
    assert.match(body, /Main &lt;i&gt;server&lt;\/i&gt;/);
    assert.ok(body.includes(process.env.MAIN_GUILD_ID));
    assert.match(body, /2 servers in total/);
    assert.match(body, /pool &lt;b&gt;exhausted&lt;\/b&gt;/);
    assert.ok(!body.includes('<b>exhausted'), 'messages are escaped');
    assert.match(body, /giveaway_check/);
    assert.match(body, /No server \(DM or task\)/);
    assert.match(body, /Errors kept: 8 \(the newest 500 are kept/);
    assert.match(body, /href="\/dashboard\/owner\/errors"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/dashboard\/owner\/errors"/, 'sidebar marks the page');
    assert.deepEqual(h.searches, [{ trace: null, code: null }]);
});

test('recent errors: the search box takes a pasted Ref; empty states', async () => {
    const h = await setup({ list: () => ({ groups: [], total: 0 }) });
    const res = await get(h, { query: { q: 'COMMAND_ERROR · int_AB12' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(h.searches, [{ trace: 'int_ab12', code: 'COMMAND_ERROR' }]);
    assert.match(res.body, /No errors match “COMMAND_ERROR · int_AB12”/);
    assert.match(res.body, /value="COMMAND_ERROR · int_AB12"/);
    const none = await get(h);
    assert.match(none.body, /No errors recorded\./);
});

test('recent errors: a database error is 503 "not responding", never an empty list', async () => {
    const h = await setup({ list: () => { throw new Error('connection timeout'); } });
    const res = await get(h);
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /Database unavailable/);
    assert.match(res.body, /database is not responding/);
    assert.doesNotMatch(res.body, /No errors recorded/);
});

test('recent errors: translated (German page and sidebar)', async () => {
    const de = dashboardText('de');
    const h = await setup();
    const res = await get(h, { lang: 'de' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes(`<h1>${de.t('ownerErrors.page.title')}</h1>`));
    assert.ok(res.body.includes(de.t('frame.nav.items.owner_errors')));
    assert.ok(res.body.includes(de.t('ownerErrors.table.lastSeen')));
    assert.notEqual(de.t('ownerErrors.page.title'), 'Recent errors');
});
