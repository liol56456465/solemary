// Multi-server B3 (A1): per-server routing, the guilds login and the server picker
// (docs/multi-server-b3.md sections 0-2). A real Express app on 127.0.0.1 with fake servers:
// MAIN (home), SUPPORT (home, redirects to main), A (the user is an admin), B (a stranger's
// server), C (the bot is not in it). Access, blacklist and settings are injected; no Discord,
// no database. The broad IDOR sweep over every route is a later suite (dashboardMultiServer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createConfirmStore } from '../src/services/dashboard/confirmTokens.js';
import { createGuildDashboards, createLruCache, scopedConfirms } from '../src/services/dashboard/guildDashboards.js';
import { HOME_ONLY_PAGES, isHomeOnlyPage } from '../src/services/dashboard/homeOnly.js';
import { currentGuildId, guildPath, path, rootPath, runInGuild } from '../src/services/dashboard/html.js';
import { canManageFromOAuth, collectPicker, guildListFrom } from '../src/services/dashboard/serverPicker.js';
import { STATE_COOKIE, SESSION_COOKIE, createState, createStateStore, guildSegment, signValue } from '../src/services/dashboard/security.js';
import { defaultServices } from '../src/services/dashboard/services.js';
import { createDashboardApp, dashboardSettings, safeReturnPath } from '../src/services/dashboard/routes.js';

const SECRET = 'x'.repeat(64);
const MAIN = '100000000000000001';
const SUPPORT = '100000000000000009';
const A = '110000000000000011';
const B = '120000000000000012';
const C = '130000000000000013'; // the bot is not here
const D = '140000000000000014'; // the user manages it, the bot is not here ("Add Mewvo")
const ADMIN = '200000000000000002';
const STRANGER = '300000000000000003';
const OWNER = '500000000000000005';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: `${ORIGIN}/`, MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, NODE_ENV: 'test',
};

function fakeGuild(id, name) {
    return { id, name, iconURL: () => null, members: { cache: new Map(), fetch: async () => null }, channels: { cache: new Map() }, roles: { cache: new Map() } };
}

/** admins: Map guildId → Set of admin user ids (mutable: tests take access away). */
async function serve({ admins = new Map([[MAIN, new Set([ADMIN])], [A, new Set([ADMIN])], [B, new Set()]]), owners = [OWNER], blocked = { users: new Set(), guilds: new Set() }, guildsAnswer = null } = {}) {
    const settings = dashboardSettings(ENV);
    const client = {
        user: { id: '999999999999999999' },
        guilds: { cache: new Map([[MAIN, fakeGuild(MAIN, 'Mewvo')], [SUPPORT, fakeGuild(SUPPORT, 'Support')], [A, fakeGuild(A, 'Alpha <A>')], [B, fakeGuild(B, 'Bravo')]]) },
    };
    const calls = { updateSettings: [], getCaseByCode: [], facts: [] };
    const sessions = createMemorySessionStore();
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
        fetchCalls.push({ url, options });
        if (url.includes('/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
        if (url.endsWith('/users/@me/guilds')) return { ok: true, status: 200, json: async () => guildsAnswer || [] };
        return { ok: true, status: 200, json: async () => ({ id: ADMIN, username: 'admin' }) };
    };
    const app = express();
    const dashboard = createDashboardApp({
        client, settings, env: ENV, sessions, fetchImpl,
        owners: () => owners,
        accessFor: (guildId) => createAccessChecker(client, {
            guildId,
            facts: async (c, userId, gid) => {
                calls.facts.push([userId, gid]);
                return { inGuild: c.guilds.cache.has(gid), isAdmin: Boolean(admins.get(gid)?.has(userId)), isOwnerId: owners.includes(userId) && (gid === MAIN || gid === SUPPORT) };
            },
        }),
        blacklist: ({ userId, guildId } = {}) => (userId && blocked.users.has(userId) ? { kind: 'user' } : guildId && blocked.guilds.has(guildId) ? { kind: 'guild' } : null),
        settingsReady: async () => {},
        services: {
            ...defaultServices,
            getAutomodSettings: async () => null, getJoinToCreateConfiguration: async () => null, getApplicationSettings: async () => null,
            getGuildConfig: async () => ({}), postModLog: async () => {},
            updateSettings: async (guildId, patch) => { calls.updateSettings.push([guildId, patch]); return patch; },
        },
        data: {
            searchCaseRecords: async () => ({ rows: [], total: 0 }),
            getLatestAppealStatusesForCases: async () => new Map(),
            getCaseEdits: async () => [], listEvidence: async () => [], getAppealHistory: async () => [], listCaseNotes: async () => [],
            resolveImageUrls: async () => new Map(),
            getCaseByCode: async (code, guildId) => { calls.getCaseByCode.push([code, guildId]); return code === 'abcde' ? { case_code: 'abcde', guild_id: A, type: 'warn' } : null; },
            overview: { getGuildConfig: async () => null, getWelcomeConfig: async () => null },
        },
    });
    app.use('/dashboard', dashboard.router);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function loginAs(userId = ADMIN) {
        const session = await sessions.create({ userId, username: `u${userId.slice(-2)}` });
        return { session, cookie: `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}` };
    }
    async function request(pathname, { method = 'GET', cookie = '', form = null, origin = ORIGIN } = {}) {
        const headers = { ...(cookie ? { cookie } : {}) };
        let body;
        if (form) {
            headers['content-type'] = 'application/x-www-form-urlencoded';
            if (origin) headers.origin = origin;
            body = new URLSearchParams(form).toString();
        }
        const res = await fetch(`${base}${pathname}`, { method, headers, body, redirect: 'manual' });
        return { status: res.status, location: res.headers.get('location'), body: await res.text(), headers: res.headers };
    }
    return {
        dashboard, client, sessions, calls, admins, blocked, fetchCalls, loginAs, request, settings,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

// ── pure helpers ──────────────────────────────────────────────────────────

test('path() follows the request\'s server; rootPath and guildPath are fixed', async () => {
    assert.equal(path('/cases'), '/dashboard/cases', 'outside a server: no prefix (tests, previews, global pages)');
    assert.equal(rootPath('/theme'), '/dashboard/theme');
    assert.equal(rootPath(), '/dashboard');
    assert.equal(guildPath(A, '/cases'), `/dashboard/${A}/cases`);
    const inner = await runInGuild(A, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { path: path('/cases'), root: rootPath('/lang'), id: currentGuildId() };
    });
    assert.deepEqual(inner, { path: `/dashboard/${A}/cases`, root: '/dashboard/lang', id: A }, 'kept across awaits');
    assert.equal(currentGuildId(), null);
});

test('guildSegment: snowflakes are servers; digit-like bad ids are invalid; lowercase words are old links', () => {
    assert.deepEqual(guildSegment(A), { guildId: A, invalid: false });
    for (const bad of ['1234567890123456', '123456789012345678901', '12345678901234567x', 'ABC', 'Overview', '', '%31']) {
        assert.deepEqual(guildSegment(bad), { guildId: null, invalid: true }, bad);
    }
    assert.deepEqual(guildSegment('reaction-roles'), { guildId: null, invalid: false });
});

test('homeOnly: support and backup by sidebar key, route key and path, any case', () => {
    assert.deepEqual([...HOME_ONLY_PAGES], ['support', 'backup']);
    for (const key of ['support', 'page:support', '/support', '/support/save', '/Support', '//support', 'backup', '/backup/download', 'page:backup']) assert.equal(isHomeOnlyPage(key), true, key);
    for (const key of ['supporter', '/cases', 'page:rules', '', null, '/owner/backup']) assert.equal(isHomeOnlyPage(key), false, String(key));
});

test('confirm tokens are scoped per server: a token from A is refused in B', () => {
    const store = createConfirmStore();
    const inA = scopedConfirms(store, A);
    const inB = scopedConfirms(store, B);
    const { token, hash } = inA.issue({ session: 's', subject: 'module:x/y', payload: { ok: 1 } });
    assert.equal(inB.consume(token, { session: 's', subject: 'module:x/y', hash }), null, 'B cannot confirm A\'s preview');
    const again = inA.issue({ session: 's', subject: 'module:x/y', payload: { ok: 2 } });
    assert.deepEqual(inA.consume(again.token, { session: 's', subject: 'module:x/y', hash: again.hash }), { ok: 2 });
});

test('registry: one instance per server, bounded LRU with an idle timeout', () => {
    let now = 0;
    let built = 0;
    const reg = createGuildDashboards({ build: (id) => ({ id, n: (built += 1) }), max: 2, idleMs: 1000, now: () => now });
    assert.equal(reg.get(A), reg.get(A), 'cached');
    reg.get(B);
    reg.get(C);
    assert.equal(reg.size(), 2, 'bounded');
    assert.equal(reg.peek(A), null, 'least recently used dropped');
    now = 5000;
    assert.equal(reg.peek(B), null, 'idle entries expire');
    const lru = createLruCache({ max: 1 });
    lru.set('a', 1);
    lru.set('b', 2);
    assert.equal(lru.get('a'), undefined);
});

test('safeReturnPath: only dashboard paths; absolute URLs, //host, .., encoded tricks → the picker', () => {
    assert.equal(safeReturnPath(`/dashboard/${A}/cases?member=1`), `/dashboard/${A}/cases?member=1`);
    for (const bad of ['https://evil.example/', '//evil.example', '/dashboard//evil.example', '/dashboard/../admin', '/dashboard/%2e%2e/x',
        '/dashboard/a\\b', 'javascript:alert(1)', '/dashboardx', `/dashboard/${A}/cases?q=<x>`, `/dashboard/${'a'.repeat(400)}`, '', null]) {
        assert.equal(safeReturnPath(bad), '/dashboard', String(bad));
    }
});

test('OAuth guild list: keeps shared or managed servers only, with id, name, icon; Manage Server / Administrator / owner', () => {
    assert.equal(canManageFromOAuth({ permissions: '32' }), true);
    assert.equal(canManageFromOAuth({ permissions: '8' }), true);
    assert.equal(canManageFromOAuth({ owner: true, permissions: '0' }), true);
    assert.equal(canManageFromOAuth({ permissions: '2048' }), false);
    assert.equal(canManageFromOAuth({ permissions: 'x' }), false);
    const list = guildListFrom([
        { id: A, name: 'Alpha', icon: 'a'.repeat(32), permissions: '0', features: ['X'] },
        { id: D, name: 'Delta', icon: 'javascript:1', permissions: '32' },
        { id: '160000000000000016', name: 'Other', permissions: '0' },
        { id: 'not-an-id', name: 'x', permissions: '8' },
    ], { botHas: (id) => id === A });
    assert.deepEqual(list, [
        { id: A, name: 'Alpha', icon: 'a'.repeat(32), canManage: false },
        { id: D, name: 'Delta', icon: null, canManage: true },
    ]);
    assert.deepEqual(guildListFrom({ id: ADMIN }), [], 'not an array (e.g. an error object) → empty');
});

test('picker data: live re-check, at most 50 checks, 5 at a time, Add Mewvo links; main for owners and after a restart', async () => {
    const cache = new Map([[MAIN, {}], [A, { name: 'Alpha' }], [B, { name: 'Bravo' }]]);
    const client = { guilds: { cache: { has: (id) => cache.has(id), get: (id) => cache.get(id) } } };
    let running = 0;
    let peak = 0;
    const checkAccess = async (id) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return { allowed: id === A || id === MAIN, role: 'admin' };
    };
    const list = [{ id: A, name: 'Alpha', canManage: false }, { id: B, name: 'Bravo', canManage: true }, { id: D, name: 'Delta', icon: null, canManage: true }];
    const data = await collectPicker({ client, list, mainGuildId: MAIN, isOwner: false, checkAccess, clientId: '400000000000000004' });
    assert.deepEqual(data.servers.map((s) => s.id), [A], 'B re-checked live and dropped; main not added for a non-owner with a list');
    assert.equal(data.addable.length, 1);
    assert.match(data.addable[0].href, /guild_id=140000000000000014&disable_guild_select=true$/);
    assert.ok(data.addable[0].href.startsWith('https://discord.com/oauth2/authorize?client_id=400000000000000004'));
    const owner = await collectPicker({ client, list, mainGuildId: MAIN, isOwner: true, checkAccess });
    assert.deepEqual(owner.servers.map((s) => s.id), [MAIN, A], 'home server first for bot owners');
    const restarted = await collectPicker({ client, list: null, mainGuildId: MAIN, checkAccess });
    assert.equal(restarted.listKnown, false);
    assert.deepEqual(restarted.servers.map((s) => s.id), [MAIN], 'without a list the main server is still checked');
    const many = Array.from({ length: 60 }, (_, i) => ({ id: String(150000000000000100n + BigInt(i)), name: `S${i}`, canManage: false }));
    for (const g of many) cache.set(g.id, {});
    peak = 0;
    let checks = 0;
    const big = await collectPicker({ client, list: many, mainGuildId: MAIN, checkAccess: async (id) => { checks += 1; return checkAccess(id); } });
    assert.equal(checks, 50);
    assert.equal(big.limited, true);
    assert.ok(peak <= 5, `concurrency ${peak}`);
});

// ── the router ────────────────────────────────────────────────────────────

test('[I2] /dashboard/<id>/… reaches that server\'s instance with the suffix as req.path; links keep the prefix', async () => {
    const h = await serve();
    try {
        const { cookie } = await h.loginAs();
        const res = await h.request(`/dashboard/${A}/help`, { cookie: `${cookie}; mewvo_nav=all` });
        assert.equal(res.status, 200);
        assert.ok(res.body.includes(`href="/dashboard/${A}/cases"`), 'sidebar links under the server');
        assert.ok(res.body.includes('Alpha &lt;A&gt;'), 'the server switcher shows this server (escaped)');
        assert.ok(res.body.includes('href="/dashboard/theme?mode='), 'theme links are global');
        assert.ok(res.body.includes('action="/dashboard/logout"'), 'logout is global');
        // The navigation (sidebar + phone sheet); the glossary text on /help has its own links (pages, not nav).
        const nav = [...res.body.matchAll(/<nav class="(?:side-nav|tabbar)"[\s\S]*?<\/nav>/g)].map((m) => m[0]).join('');
        assert.ok(nav.includes(`href="/dashboard/${A}/rules"`), 'nav found');
        assert.ok(!nav.includes(`href="/dashboard/${A}/support"`), 'home-only Support module hidden in A');
        assert.ok(!nav.includes(`href="/dashboard/${A}/backup"`), 'home-only Backup hidden in A');
        assert.equal(res.headers.get('content-security-policy').includes("script-src 'self'"), true);
        const root = await h.request(`/dashboard/${A}`, { cookie });
        assert.equal(root.status, 302);
        assert.equal(root.location, `/dashboard/${A}/overview`);
        const main = await h.request(`/dashboard/${MAIN}/help`, { cookie: `${cookie}; mewvo_nav=all` });
        assert.ok(main.body.includes(`href="/dashboard/${MAIN}/backup"`), 'home server keeps its home-only pages');
    } finally {
        await h.close();
    }
});

test('old links: GET 302 and POST 307 to the same page of the main server; the support id 302s to main', async () => {
    const h = await serve();
    try {
        const get = await h.request('/dashboard/cases/abcde?tab=1');
        assert.equal(get.status, 302);
        assert.equal(get.location, `/dashboard/${MAIN}/cases/abcde?tab=1`);
        const post = await h.request('/dashboard/leveling/save', { method: 'POST', form: { a: '1' } });
        assert.equal(post.status, 307);
        assert.equal(post.location, `/dashboard/${MAIN}/leveling/save`);
        const support = await h.request(`/dashboard/${SUPPORT}/cases?member=1`);
        assert.equal(support.status, 302);
        assert.equal(support.location, `/dashboard/${MAIN}/cases?member=1`);
        const supportRoot = await h.request(`/dashboard/${SUPPORT}`);
        assert.equal(supportRoot.location, `/dashboard/${MAIN}`);
        const supportPost = await h.request(`/dashboard/${SUPPORT}/handover`, { method: 'POST', form: { text: 'x' } });
        assert.equal(supportPost.status, 307);
        // The 307'd POST still needs its CSRF token and origin at the target (checkPost runs there).
        const { cookie } = await h.loginAs();
        const noCsrf = await h.request(`/dashboard/${MAIN}/handover`, { method: 'POST', cookie, form: { text: 'x' } });
        assert.equal(noCsrf.status, 403);
        assert.equal(h.calls.updateSettings.length, 0);
    } finally {
        await h.close();
    }
});

test('one uniform 404: bad ids, bot not in the server, blacklisted server, no access; blacklisted user 403', async () => {
    const h = await serve();
    try {
        const { cookie } = await h.loginAs();
        const reference = await h.request(`/dashboard/${C}/help`, { cookie });
        assert.equal(reference.status, 404);
        assert.match(reference.body, /Server not found or you can&#39;t manage it/);
        assert.ok(!reference.body.includes('Bravo') && !reference.body.includes('Alpha'), 'no server name leaks');
        const variants = ['/dashboard/1234567890123456/help', '/dashboard/123456789012345678901/help', '/dashboard/12345678901234567x/help', `/dashboard/${B}/help`, `/dashboard/${B}/cases/abcde`];
        for (const url of variants) {
            const res = await h.request(url, { cookie });
            assert.equal(res.status, 404, url);
            assert.equal(res.body, reference.body, `${url}: the same page as a server the bot is not in`);
        }
        h.blocked.guilds.add(A);
        const blockedServer = await h.request(`/dashboard/${A}/help`, { cookie });
        assert.equal(blockedServer.status, 404);
        assert.equal(blockedServer.body, reference.body);
        h.blocked.guilds.clear();
        h.blocked.users.add(ADMIN);
        assert.equal((await h.request(`/dashboard/${A}/help`, { cookie })).status, 403);
        assert.equal((await h.request('/dashboard', { cookie })).status, 403, 'the picker too');
        // Anonymous: the login, coming back here (never a 404 that would say whether the server exists).
        const anon = await h.request(`/dashboard/${B}/cases?member=1`);
        assert.equal(anon.status, 302);
        assert.equal(anon.location, `/dashboard?r=${encodeURIComponent(`/dashboard/${B}/cases?member=1`)}`);
        assert.equal((await h.request(`/dashboard/${B}/handover`, { method: 'POST', form: { text: 'x' } })).status, 401);
    } finally {
        await h.close();
    }
});

test('[I1] a POST\'s 303 Location keeps the server prefix; CSRF and Origin are checked per server route', async () => {
    const h = await serve();
    try {
        const { session, cookie } = await h.loginAs();
        const ok = await h.request(`/dashboard/${A}/handover`, { method: 'POST', cookie, form: { csrf: session.csrf, text: 'hello' } });
        assert.equal(ok.status, 303);
        assert.equal(ok.location, `/dashboard/${A}/overview`);
        assert.deepEqual(h.calls.updateSettings.map(([g]) => g), [A], 'saved in A only');
        const foreign = await h.request(`/dashboard/${A}/handover`, { method: 'POST', cookie, form: { csrf: session.csrf, text: 'x' }, origin: 'https://evil.example' });
        assert.equal(foreign.status, 403);
        const noOrigin = await h.request(`/dashboard/${A}/handover`, { method: 'POST', cookie, form: { csrf: session.csrf, text: 'x' }, origin: null });
        assert.equal(noOrigin.status, 403);
        const other = await h.loginAs();
        const otherToken = await h.request(`/dashboard/${A}/handover`, { method: 'POST', cookie, form: { csrf: other.session.csrf, text: 'x' } });
        assert.equal(otherToken.status, 403, "another session's token");
        assert.equal(h.calls.updateSettings.length, 1);
    } finally {
        await h.close();
    }
});

test('A vs B: a stranger in B gets 404 and nothing in B is read or written; A\'s case code under B is looked up in B', async () => {
    const h = await serve();
    try {
        const { session, cookie } = await h.loginAs();
        const post = await h.request(`/dashboard/${B}/handover`, { method: 'POST', cookie, form: { csrf: session.csrf, text: 'x' } });
        assert.equal(post.status, 404);
        assert.equal(h.calls.updateSettings.length, 0);
        assert.equal(h.calls.getCaseByCode.length, 0, 'no data read in B without access');
        h.admins.get(B).add(ADMIN);
        h.dashboard.accessOf(B).forget(ADMIN);
        const caseInB = await h.request(`/dashboard/${B}/cases/abcde`, { cookie });
        assert.equal(caseInB.status, 404, "A's case is not B's");
        assert.deepEqual(h.calls.getCaseByCode, [['abcde', B]], 'looked up with B, never A');
        const caseInA = await h.request(`/dashboard/${A}/cases/abcde`, { cookie });
        assert.equal(caseInA.status, 200);
        assert.deepEqual(h.calls.getCaseByCode.at(-1), ['abcde', A]);
    } finally {
        await h.close();
    }
});

test('losing access to one server 404s that server only; the session and the other servers keep working', async () => {
    const h = await serve({ admins: new Map([[MAIN, new Set()], [A, new Set([ADMIN])], [B, new Set([ADMIN])]]) });
    try {
        const { session, cookie } = await h.loginAs();
        assert.equal((await h.request(`/dashboard/${B}/help`, { cookie })).status, 200);
        h.admins.get(B).delete(ADMIN);
        // GETs use the access cache (30 s); a POST checks fresh at once.
        assert.equal((await h.request(`/dashboard/${B}/help`, { cookie })).status, 200, 'cached GET');
        const post = await h.request(`/dashboard/${B}/handover`, { method: 'POST', cookie, form: { csrf: session.csrf, text: 'x' } });
        assert.equal(post.status, 404, 'fresh check on every POST');
        assert.equal(h.calls.updateSettings.length, 0);
        const gone = await h.request(`/dashboard/${B}/help`, { cookie });
        assert.equal(gone.status, 404, 'the fresh answer is cached for the next GET');
        assert.ok(!(gone.headers.get('set-cookie') || '').includes(`${SESSION_COOKIE}=;`), 'cookie not cleared');
        assert.ok(await h.sessions.get(session.id), 'session kept');
        assert.equal((await h.request(`/dashboard/${A}/help`, { cookie })).status, 200, 'A still works');
        const logout = await h.request('/dashboard/logout', { method: 'POST', cookie, form: { csrf: session.csrf } });
        assert.equal(logout.status, 303, 'logout needs a session, not access to any server (none in MAIN here)');
        assert.equal(await h.sessions.get(session.id), null);
    } finally {
        await h.close();
    }
});

test('home-only pages 404 in other servers for every spelling (GET and POST); they stay in the main server', async () => {
    const h = await serve();
    try {
        const { session, cookie } = await h.loginAs();
        const spellings = (name) => [`/${name}`, `/${name}/`, `/${name[0].toUpperCase()}${name.slice(1)}`, `/${name.toUpperCase()}`,
            `/%${name.charCodeAt(0).toString(16)}${name.slice(1)}`, `//${name}`, `/${name}%2F`];
        for (const name of HOME_ONLY_PAGES) {
            for (const spelled of spellings(name)) {
                const get = await h.request(`/dashboard/${A}${spelled}`, { cookie });
                assert.equal(get.status, 404, `GET ${spelled}`);
                const post = await h.request(`/dashboard/${A}${spelled}/save`, { method: 'POST', cookie, form: { csrf: session.csrf } });
                assert.equal(post.status, 404, `POST ${spelled}/save`);
            }
        }
        for (const sub of ['/backup/download', '/Backup/Download', '/%62ackup/download']) {
            assert.equal((await h.request(`/dashboard/${A}${sub}`, { cookie })).status, 404, sub);
        }
        for (const sub of ['/backup/apply', '/BACKUP/apply', '/backup/preview']) {
            assert.equal((await h.request(`/dashboard/${A}${sub}`, { method: 'POST', cookie, form: { csrf: session.csrf, token: 'x' } })).status, 404, `POST ${sub}`);
        }
        assert.equal(h.calls.updateSettings.length, 0, 'nothing saved');
        assert.equal((await h.request(`/dashboard/${MAIN}/backup`, { cookie })).status, 200, 'the main server keeps its backup page');
    } finally {
        await h.close();
    }
});

test('login: scopes identify guilds, the server list is read once, the token is never stored; the return path survives, tampering → picker', async () => {
    const guildsAnswer = [{ id: A, name: 'Alpha', permissions: '8' }, { id: B, name: 'Bravo', permissions: '0' }, { id: D, name: 'Delta', permissions: '32' }];
    const h = await serve({ guildsAnswer });
    try {
        const start = await h.request(`/dashboard?r=${encodeURIComponent(`/dashboard/${A}/cases?member=1`)}`);
        assert.equal(start.status, 302);
        const authorize = new URL(start.location);
        assert.equal(authorize.searchParams.get('scope'), 'identify guilds');
        const nonce = decodeURIComponent(/mewvo_dash_state=([^;]+)/.exec(start.headers.get('set-cookie'))[1]);
        const cb = await h.request(`/dashboard/oauth/callback?code=c&state=${encodeURIComponent(authorize.searchParams.get('state'))}`, { cookie: `${STATE_COOKIE}=${encodeURIComponent(nonce)}` });
        assert.equal(cb.status, 303);
        assert.equal(cb.location, `/dashboard/${A}/cases?member=1`, 'back to the page that asked for the login');
        assert.equal(h.fetchCalls.filter((c) => c.url.endsWith('/users/@me/guilds')).length, 1);
        assert.ok(!(cb.headers.get('set-cookie') || '').includes('tok'), 'the access token never reaches the browser');
        const sessionCookie = /mewvo_dash=([^;]+)/.exec(cb.headers.get('set-cookie'))[1];
        const cookie = `${SESSION_COOKIE}=${sessionCookie}`;
        const picker = await h.request('/dashboard', { cookie });
        assert.equal(picker.status, 200);
        assert.ok(picker.body.includes(`href="/dashboard/${A}/overview"`), 'A listed');
        assert.ok(!picker.body.includes(`/dashboard/${B}/`), 'B (no access) not listed');
        assert.ok(picker.body.includes('guild_id=140000000000000014&amp;disable_guild_select=true'), 'Add Mewvo for D');
        assert.ok(!picker.body.includes('tok'), 'no token in the page');
        const stored = [...h.dashboard.guildLists.keys()].map((k) => h.dashboard.guildLists.get(k));
        assert.deepEqual(Object.keys(stored[0][0]).sort(), ['canManage', 'icon', 'id', 'name'], 'only ids, names, icons');

        // Tampered return paths are dropped at the start and again at the callback.
        for (const bad of ['https://evil.example/', '//evil.example', '/dashboard/../x', '/dashboard//evil.example']) {
            const again = await h.request(`/dashboard?r=${encodeURIComponent(bad)}`);
            const url = new URL(again.location);
            const n = decodeURIComponent(/mewvo_dash_state=([^;]+)/.exec(again.headers.get('set-cookie'))[1]);
            const back = await h.request(`/dashboard/oauth/callback?code=c&state=${encodeURIComponent(url.searchParams.get('state'))}`, { cookie: `${STATE_COOKIE}=${encodeURIComponent(n)}` });
            assert.equal(back.location, '/dashboard', bad);
        }
        // A state signed with a bad return path (defence in depth: checked again at the callback).
        const forged = createState(SECRET, Date.now(), { returnTo: 'https://evil.example/' });
        const forgedRes = await h.request(`/dashboard/oauth/callback?code=c&state=${encodeURIComponent(forged.state)}`, { cookie: `${STATE_COOKIE}=${encodeURIComponent(forged.nonce)}` });
        assert.equal(forgedRes.location, '/dashboard');
        // A changed state (return path edited by hand) fails the signature.
        const real = createState(SECRET, Date.now(), { returnTo: `/dashboard/${A}/cases` });
        const [payload, sig] = [real.state.slice(0, real.state.lastIndexOf('.')), real.state.slice(real.state.lastIndexOf('.') + 1)];
        const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), r: 'https://evil.example/' })).toString('base64url');
        const editedRes = await h.request(`/dashboard/oauth/callback?code=c&state=${encodeURIComponent(`${edited}.${sig}`)}`, { cookie: `${STATE_COOKIE}=${encodeURIComponent(real.nonce)}` });
        assert.equal(editedRes.status, 400);
        assert.equal(createStateStore().take('garbage', 'n', SECRET), null);
    } finally {
        await h.close();
    }
});

test('picker after a restart: "Refresh server list" logs in again with prompt=none; owners see the home server and the Owner area', async () => {
    const h = await serve();
    try {
        const { cookie } = await h.loginAs(OWNER);
        const picker = await h.request('/dashboard', { cookie });
        assert.equal(picker.status, 200);
        assert.match(picker.body, /Server list not loaded/);
        assert.ok(picker.body.includes(`href="/dashboard/${MAIN}/overview"`), 'home server for OWNER_IDS');
        assert.ok(picker.body.includes('href="/dashboard/owner"'), 'Owner area link');
        assert.ok(!picker.body.includes('class="side-nav"'), 'no server sidebar on the picker');
        const refresh = await h.request('/dashboard?refresh=1', { cookie });
        assert.equal(refresh.status, 302);
        assert.equal(new URL(refresh.location).searchParams.get('prompt'), 'none');
        const stranger = await h.loginAs(STRANGER);
        const empty = await h.request('/dashboard', { cookie: stranger.cookie });
        assert.equal(empty.status, 200, 'anyone may log in');
        assert.match(empty.body, /There is no server you can manage with Mewvo yet/);
    } finally {
        await h.close();
    }
});
