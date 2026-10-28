import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSS_PATH, JS_PATH, THEME_COOKIE, escapeHtml, formatAge, html, layout, queryString, raw, themeFrom } from '../src/services/dashboard/html.js';
import {
    SESSION_COOKIE, STATE_COOKIE, createRateLimiter, createState, createStateStore, isGlobalRateLimitExempt,
    isSnowflake, parseCookies, serializeCookie, signValue, verifySignedValue,
} from '../src/services/dashboard/security.js';
import { createMemorySessionStore, hashSessionId } from '../src/services/dashboard/sessionStore.js';
import { gettingStarted, moduleStatesFrom, overviewPage, collectOverview } from '../src/services/dashboard/overview.js';
import { readFileSync } from 'node:fs';
import { createAccessChecker, decideAccess } from '../src/services/dashboard/access.js';
import { auditPage, caseDetailPage, casesPage, isAllowedImageUrl, isSafeLink } from '../src/services/dashboard/pages.js';
import { SECURITY_HEADERS, createDashboard, dashboardSettings, registerDashboard, safeBackPath } from '../src/services/dashboard/routes.js';

// The only script on any page: the static enhancement file (CSP script-src 'self').
const ALLOWED_SCRIPT = `<script src="${JS_PATH}" defer></script>`;
const SECRET = 'x'.repeat(64);
const GUILD = '100000000000000001';
const ADMIN = '200000000000000002';
const STRANGER = '300000000000000003';

// ── escaping ──────────────────────────────────────────────────────────────

test('escapeHtml escapes every HTML-significant character', () => {
    assert.equal(escapeHtml(`<script>alert("x")</script>&'\``), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;&#96;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(42), '42');
});

test('html template escapes values, keeps nested html, joins arrays, drops null/false', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const out = html`<a title="${evil}">${[html`<b>${'<i>'}</b>`, '<u>']}</a>${null}${false}${raw('<br>')}`.text;
    assert.equal(out, '<a title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"><b>&lt;i&gt;</b>&lt;u&gt;</a><br>');
});

test('queryString skips empty values and encodes the rest', () => {
    assert.equal(queryString({ a: '', b: null, c: 'x y&z' }), '?c=x+y%26z');
    assert.equal(queryString({}), '');
    assert.equal(formatAge(0, 3 * 86400000), '3 d');
    assert.equal(formatAge(0, 5 * 60000), '5 min');
});

test('only Discord CDN https URLs become images; only http(s) become links', () => {
    assert.equal(isAllowedImageUrl('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1'), true);
    assert.equal(isAllowedImageUrl('https://media.discordapp.net/a.png'), true);
    assert.equal(isAllowedImageUrl('http://cdn.discordapp.com/a.png'), false);
    assert.equal(isAllowedImageUrl('https://evil.example/a.png'), false);
    assert.equal(isSafeLink('javascript:alert(1)'), false);
    assert.equal(isSafeLink('https://discord.com/channels/1/2/3'), true);
});

test('pages escape user-provided case fields', () => {
    const session = { username: '<admin>', csrf: 'tok' };
    const row = {
        case_code: 'abcde', type: 'warn', target_username: '<script>x</script>', target_user_id: ADMIN,
        moderator_username: 'mod"', reason: '<img src=x onerror=1>', created_at: new Date(0), status: 'active',
    };
    const list = casesPage({ session, query: { text: '"><script>' }, rows: [row], total: 1 });
    assert.ok(!list.includes('<script>x</script>'));
    assert.ok(!list.includes('<img src=x'));
    assert.ok(list.includes('&lt;script&gt;x&lt;/script&gt;'));
    assert.ok(list.includes('value="&quot;&gt;&lt;script&gt;"'));
    assert.ok(list.includes('&lt;admin&gt;'));
    const detail = caseDetailPage({
        session, record: { ...row, name: '<b>n</b>' }, statusLabel: 'active',
        evidence: [
            { row: { id: 1, kind: 'link', url: 'javascript:alert(1)', added_by_username: 'm', added_at: new Date(0), excerpt: '<x>' }, freshUrl: null },
            { row: { id: 2, kind: 'image', added_by_username: 'm', added_at: new Date(0) }, freshUrl: 'https://cdn.discordapp.com/a.png?x=1&y=2' },
            { row: { id: 3, kind: 'image', added_by_username: 'm', added_at: new Date(0) }, freshUrl: 'https://evil.example/a.png' },
        ],
    });
    assert.ok(!detail.includes('href="javascript:'));
    assert.ok(detail.includes('<img src="https://cdn.discordapp.com/a.png?x=1&amp;y=2"'));
    assert.ok(!detail.includes('evil.example'));
    assert.ok(detail.includes('&lt;b&gt;n&lt;/b&gt;'));
});

test('pages have no inline styles or scripts and link the one stylesheet', () => {
    const page = casesPage({ session: { username: 'a', csrf: 't' }, rows: [], total: 0 });
    assert.ok(page.includes(`<link rel="stylesheet" href="${CSS_PATH}">`));
    assert.match(CSS_PATH, /^\/dashboard\/static\/dashboard\.css\?v=[0-9a-f]{10}$/, 'versioned, so a deploy never mixes new pages with a cached old stylesheet');
    assert.match(JS_PATH, /^\/dashboard\/static\/dashboard\.js\?v=[0-9a-f]{10}$/);
    assert.ok(page.includes(ALLOWED_SCRIPT), 'the one external script (progressive enhancement)');
    assert.ok(!/<style|style=|<script/i.test(page.replace(ALLOWED_SCRIPT, '')));
    assert.ok(page.includes('href="/dashboard/overview"'), 'sidebar');
    assert.ok(!page.includes('Phase 2'), 'no placeholders left (Phase 2 built the module pages)');
    assert.ok(page.includes('href="/dashboard/enforcement"'), 'settings pages in the sidebar');
    const audit = auditPage({ session: { username: 'a', csrf: 't' }, rows: [{ created_at: new Date(0), username: '<u>', user_id: ADMIN, module: 'logging', key: 'modLogChannelId', old: null, new: '123' }] });
    assert.ok(audit.includes('&lt;u&gt;'));
    assert.ok(!/<style|style=|<script/i.test(audit.replace(ALLOWED_SCRIPT, '')));
    const css = readFileSync(new URL('../src/services/dashboard/static/dashboard.css', import.meta.url), 'utf8');
    assert.ok(!/gradient/i.test(css), 'plain design: no gradients');
});

// ── signing, state, sessions ──────────────────────────────────────────────

test('signed values verify only with the right secret and untouched value', () => {
    const signed = signValue('abc', SECRET);
    assert.equal(verifySignedValue(signed, SECRET), 'abc');
    assert.equal(verifySignedValue(signed, 'y'.repeat(64)), null);
    assert.equal(verifySignedValue(signed.replace('abc', 'abd'), SECRET), null);
    assert.equal(verifySignedValue('nodot', SECRET), null);
    assert.equal(verifySignedValue('', SECRET), null);
    assert.equal(verifySignedValue(undefined, SECRET), null);
});

test('OAuth state: signed, bound to the cookie nonce, single use, expiring', () => {
    const store = createStateStore();
    const now = 1_000_000;
    const { state, nonce } = createState(SECRET, now);
    assert.equal(store.consume(state, 'wrong-nonce', SECRET, now), false, 'nonce mismatch');
    assert.equal(store.consume(state, nonce, 'other-secret'.repeat(3), now), false, 'bad signature');
    assert.equal(store.consume(state, nonce, SECRET, now), true);
    assert.equal(store.consume(state, nonce, SECRET, now), false, 'single use');
    const late = createState(SECRET, now);
    assert.equal(store.consume(late.state, late.nonce, SECRET, now + 11 * 60 * 1000), false, 'expired');
    assert.equal(store.consume('garbage.sig', 'n', SECRET, now), false);
});

test('session store (fake): hashed ids, expiry, rotation, destroy', async () => {
    const store = createMemorySessionStore({ ttlMs: 1000 });
    const session = await store.create({ userId: ADMIN, username: 'a' }, 0);
    assert.match(session.id, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(session.csrf);
    assert.deepEqual(store.hashes(), [hashSessionId(session.id)], 'only the hash is kept');
    assert.ok(!store.hashes().includes(session.id));
    assert.equal((await store.get(session.id, 500)).userId, ADMIN);
    assert.equal(await store.get(session.id, 1000), null, 'expired');
    const first = await store.create({ userId: ADMIN }, 0);
    const second = await store.rotate(first.id, { userId: ADMIN }, 1);
    assert.notEqual(second.id, first.id);
    assert.equal(await store.get(first.id, 2), null, 'old id dropped on rotation');
    assert.ok(await store.get(second.id, 2));
    await store.destroy(second.id);
    assert.equal(await store.get(second.id, 3), null);
});

test('rate limiter: sliding window per key', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i += 1) assert.equal(limiter.allow('a', i), true);
    assert.equal(limiter.allow('a', 10), false);
    assert.equal(limiter.allow('b', 10), true, 'keys are separate');
    assert.equal(limiter.allow('a', 1500), true);
});

test('the global per-IP limiter skips /dashboard only', () => {
    assert.equal(isGlobalRateLimitExempt({ path: '/dashboard' }), true);
    assert.equal(isGlobalRateLimitExempt({ path: '/dashboard/cases/abc' }), true);
    assert.equal(isGlobalRateLimitExempt({ path: '/dashboardx' }), false);
    assert.equal(isGlobalRateLimitExempt({ path: '/oauth/callback' }), false);
    assert.equal(isGlobalRateLimitExempt({ path: '/staff' }), false);
    assert.equal(isGlobalRateLimitExempt({}), false);
});

test('cookies: parse and serialize with the security flags and the dashboard path', () => {
    assert.deepEqual(parseCookies('a=1; b=x%20y; a=2; bad'), { a: '1', b: 'x y' });
    const cookie = serializeCookie('n', 'v', { maxAgeMs: 60000, secure: true });
    assert.equal(cookie, 'n=v; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=60; Secure');
    assert.equal(serializeCookie('n', 'v', { path: '/x' }), 'n=v; Path=/x; HttpOnly; SameSite=Lax');
    assert.ok(!serializeCookie('n', 'v').includes('Secure'));
    assert.equal(isSnowflake('123456789012345678'), true);
    assert.equal(isSnowflake('12345'), false);
    assert.equal(isSnowflake('123456789012345678 OR 1=1'), false);
});

// ── access ────────────────────────────────────────────────────────────────

test('access: current main-server administrators act; OWNER_IDS view only; staff role no longer enough', () => {
    const admin = decideAccess({ inGuild: true, isAdmin: true });
    assert.deepEqual([admin.allowed, admin.canView, admin.canAct, admin.role], [true, true, true, 'admin']);
    const owner = decideAccess({ inGuild: false, isOwnerId: true });
    assert.deepEqual([owner.allowed, owner.canView, owner.canAct, owner.role], [true, true, false, 'owner']);
    const ownerMember = decideAccess({ inGuild: true, isAdmin: false, isOwnerId: true });
    assert.equal(ownerMember.canAct, false, 'owner without Administrator cannot act');
    assert.equal(decideAccess({ inGuild: true, isAdmin: true, isOwnerId: true }).canAct, true);
    assert.equal(decideAccess({ inGuild: false, isAdmin: true }).allowed, false, 'admin elsewhere does not count');
    // The old rule let the ticket staff role in: those facts are ignored now.
    assert.equal(decideAccess({ inGuild: true, roleIds: ['5'], staffRoleId: '5' }).allowed, false);
    assert.equal(decideAccess({}).allowed, false);
});

test('access facts: Administrator in MAIN_GUILD_ID only, OWNER_IDS from config', async () => {
    const { memberFacts } = await import('../src/services/dashboard/access.js');
    const member = (admin) => ({ permissions: { has: () => admin } });
    const guild = { members: { fetch: async ({ user }) => (user === ADMIN ? member(true) : user === STRANGER ? member(false) : null) } };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } };
    assert.deepEqual(await memberFacts(client, ADMIN, GUILD, []), { inGuild: true, isAdmin: true, isOwnerId: false });
    assert.deepEqual(await memberFacts(client, STRANGER, GUILD, [STRANGER]), { inGuild: true, isAdmin: false, isOwnerId: true });
    assert.deepEqual(await memberFacts(client, ADMIN, '999999999999999999', []), { inGuild: false, isAdmin: false, isOwnerId: false }, 'other guilds are never consulted');
});

test('access checks are cached for 60 seconds', async () => {
    let calls = 0;
    let admin = true;
    const checker = createAccessChecker({}, { facts: async () => { calls += 1; return { inGuild: true, isAdmin: admin }; } });
    assert.equal((await checker.check(ADMIN, 0)).allowed, true);
    admin = false;
    assert.equal((await checker.check(ADMIN, 30_000)).allowed, true, 'cached');
    assert.equal(calls, 1);
    assert.equal((await checker.check(ADMIN, 61_000)).allowed, false, 're-checked after 60 s');
    checker.forget(ADMIN);
    await checker.check(ADMIN, 61_001);
    assert.equal(calls, 3);
});

// ── settings ──────────────────────────────────────────────────────────────

const ENV = {
    DASHBOARD_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: 'https://bot.example/', MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};

test('settings: off by default; DASHBOARD_ENABLED or the old STAFF_DASHBOARD_ENABLED; needs a long SESSION_SECRET', () => {
    assert.equal(dashboardSettings({}).enabled, false);
    assert.equal(dashboardSettings({}).requested, false);
    const ok = dashboardSettings(ENV);
    assert.equal(ok.enabled, true);
    assert.equal(ok.redirectUri, 'https://bot.example/dashboard/oauth/callback');
    assert.equal(ok.secure, true, 'https public URL → Secure cookies');
    assert.equal(ok.publicOrigin, 'https://bot.example');
    assert.equal(dashboardSettings({ ...ENV, DASHBOARD_ENABLED: undefined, STAFF_DASHBOARD_ENABLED: 'true' }).enabled, true, 'old flag is an alias');
    const short = dashboardSettings({ ...ENV, SESSION_SECRET: 'short' });
    assert.equal(short.enabled, false);
    assert.match(short.problems.join(), /SESSION_SECRET/);
    assert.equal(dashboardSettings({ ...ENV, SESSION_SECRET: undefined }).enabled, false);
    assert.equal(dashboardSettings({ ...ENV, DISCORD_CLIENT_SECRET: '' }).enabled, false);
    assert.equal(dashboardSettings({ ...ENV, MAIN_GUILD_ID: '' }).enabled, false);
    assert.equal(dashboardSettings({ ...ENV, PUBLIC_URL: 'http://127.0.0.1:3100', NODE_ENV: 'development' }).secure, false);
});

test('registerDashboard: not mounted when off or misconfigured; mounted with the /staff redirect when on', () => {
    const mounted = [];
    const app = { use: (p) => mounted.push(p) };
    assert.equal(registerDashboard(app, {}, {}), false);
    assert.equal(registerDashboard(app, {}, { ...ENV, SESSION_SECRET: 'short' }), false);
    assert.deepEqual(mounted, []);
    assert.equal(registerDashboard(app, {}, ENV, { sessions: createMemorySessionStore() }), true);
    assert.deepEqual(mounted, ['/dashboard', '/staff']);
});

test('evidence upload: an anonymous request is refused before the (up to 8 MB) body is read', async () => {
    const express = (await import('express')).default;
    const http = await import('node:http');
    const app = express();
    registerDashboard(app, {}, ENV, { sessions: createMemorySessionStore() });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const status = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/dashboard/cases/abc2345/evidence/upload',
                headers: { 'Content-Type': 'multipart/form-data; boundary=a', 'Content-Length': String(8 * 1024 * 1024) },
            }, (res) => { res.resume(); resolve(res.statusCode); });
            req.on('error', (error) => (error.code === 'ECONNRESET' || error.code === 'EPIPE' ? null : reject(error)));
            req.write(Buffer.alloc(1024)); // only 1 kB of the announced 8 MB: an answer proves the body was not awaited
            setTimeout(() => reject(new Error('no answer: the body is being read before login')), 2000).unref();
        });
        assert.ok(status === 401 || status === 403, `status ${status}`);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

// ── route handlers with fake req/res ──────────────────────────────────────

function fakeRes() {
    const res = {
        statusCode: 200, headers: {}, cookies: [], body: null, redirectedTo: null, contentType: null,
        status(code) { this.statusCode = code; return this; },
        type(t) { this.contentType = t; return this; },
        send(body) { this.body = body; return this; },
        set(name, value) {
            if (typeof name === 'object') Object.assign(this.headers, name);
            else this.headers[name] = value;
            return this;
        },
        append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
    return res;
}

const cookieValue = (res, name) => {
    const line = res.cookies.find((c) => c.startsWith(`${name}=`) && !c.includes('Max-Age=0'));
    return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : null;
};

const OVERVIEW_DATA = {
    getGuildConfig: async () => ({ logging: { enabled: true }, verification: { enabled: false } }),
    getWelcomeConfig: async () => ({ enabled: false, channelId: null }),
    countOpenTickets: async () => 2,
    listPendingAppeals: async () => [{}, {}, {}],
    searchCaseRecords: async () => ({ rows: [], total: 0 }),
    countActiveSanctions: async (guildId) => { assert.equal(guildId, GUILD); return { ban: 4, mute: 1 }; },
    casesPerDay: async (guildId, days) => { assert.equal(days, 7); return { [new Date().toISOString().slice(0, 10)]: 2 }; },
    getLockdownState: async () => ({ active: false }),
    findMutedRole: async () => null,
};

function makeDashboard({ me = { id: ADMIN, username: 'admin' }, data = {}, sessions = createMemorySessionStore(), limits, allowed = new Set([ADMIN]), owners = new Set() } = {}) {
    const settings = dashboardSettings(ENV);
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
        fetchCalls.push({ url, options });
        const body = url.includes('/token') ? { access_token: 'tok', token_type: 'Bearer' } : me;
        return { ok: true, status: 200, json: async () => body };
    };
    const access = createAccessChecker({}, { facts: async (client, userId) => ({ inGuild: true, isAdmin: allowed.has(userId), isOwnerId: owners.has(userId) }) });
    const d = createDashboard({
        client: { user: { id: '999999999999999999' }, guilds: { cache: new Map() }, isReady: () => true, ws: { ping: 42 } },
        settings, access, fetchImpl, sessions, ...(limits ? { limits } : {}),
        data: {
            searchCaseRecords: async () => ({ rows: [], total: 0 }),
            getLatestAppealStatusesForCases: async () => new Map(),
            getCaseByCode: async () => null,
            overview: OVERVIEW_DATA,
            ...data,
        },
    });
    return { d, fetchCalls, sessions };
}

async function login(d, { cookie = '' } = {}) {
    const start = fakeRes();
    await d.index({ headers: {}, ip: '1.1.1.1' }, start);
    const authorize = new URL(start.redirectedTo);
    const nonce = cookieValue(start, STATE_COOKIE);
    const res = fakeRes();
    await d.callback({ headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(nonce)}${cookie ? `; ${cookie}` : ''}` }, query: { code: 'c', state: authorize.searchParams.get('state') } }, res);
    return { start, authorize, res, cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookieValue(res, SESSION_COOKIE) || '')}` };
}

async function runProtected(d, handler, req) {
    const res = fakeRes();
    let passed = false;
    await d.requireUser(req, res, () => { passed = true; });
    if (passed) await handler(req, res);
    return res;
}

test('/dashboard without a session redirects to Discord with scope identify and a state cookie', async () => {
    const { d } = makeDashboard();
    const res = fakeRes();
    await d.index({ headers: {} }, res);
    assert.equal(res.statusCode, 302);
    const url = new URL(res.redirectedTo);
    assert.equal(url.origin, 'https://discord.com');
    assert.equal(url.searchParams.get('scope'), 'identify');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://bot.example/dashboard/oauth/callback');
    assert.ok(url.searchParams.get('state'));
    const stateCookie = res.cookies.find((c) => c.startsWith(`${STATE_COOKIE}=`));
    assert.match(stateCookie, /Path=\/dashboard; HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
});

test('OAuth callback logs an admin in with a signed session cookie; no token reaches the browser', async () => {
    const { d, fetchCalls, sessions } = makeDashboard();
    const { res, cookie } = await login(d);
    assert.equal(res.statusCode, 303);
    assert.equal(res.redirectedTo, '/dashboard/overview');
    const sessionCookie = res.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    assert.match(sessionCookie, /Path=\/dashboard; HttpOnly; SameSite=Lax; Max-Age=43200; Secure/);
    assert.ok(!res.cookies.join().includes('tok'), 'access token never set as cookie');
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].options.body.get('redirect_uri'), 'https://bot.example/dashboard/oauth/callback');
    assert.equal(sessions.size(), 1);
    const again = fakeRes();
    await d.index({ headers: { cookie } }, again);
    assert.equal(again.redirectedTo, '/dashboard/overview');
    // Logging in again from the same browser rotates the id: the old session is gone.
    const second = await login(d, { cookie });
    assert.notEqual(second.cookie, cookie);
    assert.equal(sessions.size(), 1, 'old session deleted on rotation');
    const old = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    assert.equal(old.redirectedTo, '/dashboard');
});

test('OAuth callback refuses replayed or cookie-less states and users without access', async () => {
    const { d } = makeDashboard();
    const start = fakeRes();
    await d.index({ headers: {} }, start);
    const state = new URL(start.redirectedTo).searchParams.get('state');
    const noCookie = fakeRes();
    await d.callback({ headers: {}, query: { code: 'c', state } }, noCookie);
    assert.equal(noCookie.statusCode, 400);

    const stranger = makeDashboard({ me: { id: STRANGER, username: 'x' } });
    const { res } = await login(stranger.d);
    assert.equal(res.statusCode, 403);
    assert.equal(cookieValue(res, SESSION_COOKIE), null);

    const cancelled = fakeRes();
    await d.callback({ headers: {}, query: { error: 'access_denied' } }, cancelled);
    assert.equal(cancelled.statusCode, 400);
});

test('OWNER_IDS without Administrator get in with view-only access', async () => {
    const { d } = makeDashboard({ me: { id: STRANGER, username: 'owner' }, allowed: new Set(), owners: new Set([STRANGER]) });
    const { res, cookie } = await login(d);
    assert.equal(res.statusCode, 303);
    const req = { method: 'GET', headers: { cookie }, query: {} };
    const page = await runProtected(d, d.overview, req);
    assert.equal(page.statusCode, 200);
    assert.equal(req.dashboard.access.canAct, false);
    assert.equal(req.dashboard.access.canView, true);
    assert.match(page.body, /View and settings/i);
});

test('protected pages: redirect without a session, 403 once access is lost, 429 over the per-session limit', async () => {
    const { d } = makeDashboard({ limits: { session: { limit: 5, windowMs: 60000 }, ip: { limit: 30, windowMs: 60000 }, static: { limit: 30, windowMs: 60000 } } });
    const anon = await runProtected(d, d.cases, { method: 'GET', headers: {}, query: {} });
    assert.equal(anon.redirectedTo, '/dashboard');

    const forged = await runProtected(d, d.cases, { method: 'GET', headers: { cookie: `${SESSION_COOKIE}=abc.def` }, query: {} });
    assert.equal(forged.redirectedTo, '/dashboard');

    const { cookie } = await login(d);
    const ok = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /<p class="empty">No cases yet\./, 'no filters: the plain empty state');

    for (let i = 0; i < 5; i += 1) await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    const limited = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    assert.equal(limited.statusCode, 429);

    // Access lost (Administrator removed): a checker that now says no, sharing the session store.
    const second = makeDashboard();
    const login2 = await login(second.d);
    const res = fakeRes();
    const checker = createAccessChecker({}, { facts: async () => ({ inGuild: true, isAdmin: false }) });
    const d3 = createDashboard({ client: {}, settings: dashboardSettings(ENV), access: checker, sessions: second.sessions });
    let passed = false;
    await d3.requireUser({ method: 'GET', headers: { cookie: login2.cookie } }, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
    assert.ok(res.cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`)), 'session cookie cleared');
    assert.equal(second.sessions.size(), 0, 'session destroyed');
});

test('login routes have a per-IP limit', async () => {
    const { d } = makeDashboard({ limits: { session: { limit: 300, windowMs: 60000 }, ip: { limit: 2, windowMs: 60000 }, static: { limit: 30, windowMs: 60000 } } });
    const run = () => { const res = fakeRes(); let passed = false; d.limitByIp({ ip: '9.9.9.9', headers: {} }, res, () => { passed = true; }); return { res, passed }; };
    assert.equal(run().passed, true);
    assert.equal(run().passed, true);
    const blocked = run();
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.statusCode, 429);
});

test('stylesheet is served as text/css', async () => {
    const { d } = makeDashboard();
    const res = fakeRes();
    d.stylesheet({ ip: '1.2.3.4' }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.contentType, 'text/css');
    assert.match(res.body, /--accent/);
});

test('static files: the script is served as text/javascript; nothing else is served; CSP allows only self scripts', async () => {
    const { d } = makeDashboard();
    const js = fakeRes();
    d.staticFile({ ip: '1.2.3.4', params: { file: 'dashboard.js' } }, js);
    assert.equal(js.statusCode, 200);
    assert.equal(js.contentType, 'text/javascript');
    assert.match(js.body, /data-confirm/);
    for (const file of ['../routes.js', 'routes.js', '.env', '', 'dashboard.css.map']) {
        const res = fakeRes();
        d.staticFile({ ip: '1.2.3.4', params: { file } }, res);
        assert.equal(res.statusCode, 404, file);
    }
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    // The script never talks to the network and never evaluates strings.
    const source = readFileSync(new URL('../src/services/dashboard/static/dashboard.js', import.meta.url), 'utf8');
    assert.ok(!/\bfetch\(|XMLHttpRequest|eval\(|new Function|innerHTML|document\.write/.test(source));
});

test('overview: status, counts, checklist and recent actions; read-only', async () => {
    const { d } = makeDashboard({
        data: {
            overview: {
                ...OVERVIEW_DATA,
                searchCaseRecords: async (guildId, filters, opts) => {
                    assert.deepEqual(opts, { page: 0, pageSize: 10 });
                    return { rows: [{ case_code: 'abcde', type: 'ban', target_username: '<t>', target_user_id: STRANGER, moderator_username: 'm', reason: 'r', created_at: new Date(0) }], total: 1 };
                },
                listPendingAppeals: async (limit, guildId) => { assert.equal(guildId, GUILD); return [{}, {}, {}]; },
            },
        },
    });
    const { cookie } = await login(d);
    const res = await runProtected(d, d.overview, { method: 'GET', headers: { cookie }, query: {} });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<span class="dot dot-on" aria-hidden="true"><\/span>Online · 42 ms</);
    assert.match(res.body, /Open tickets<\/h2><span class="kpi-num">2</);
    assert.match(res.body, /Pending appeals<\/h2><a class="kpi-num" href="\/dashboard\/appeals">3<\/a>/, 'pending appeals of the main guild');
    assert.match(res.body, /Active sanctions<\/h2><span class="kpi-num">5<\/span><p class="kpi-sub">4 bans · 1 mute</);
    assert.match(res.body, /<div class="chart" role="img" aria-label="Enforcement actions per day: [^"]*Today 2">/, 'chart with a text alternative');
    assert.match(res.body, /<div class="bar today"><span class="bar-count">2<\/span><i class="h-10"><\/i>/, 'the busiest day is the full height');
    assert.match(res.body, /<a class="setup-link" href="\/dashboard\/automod">Set up<span class="sr"> Automod review channel<\/span><\/a>/);
    assert.match(res.body, /<span class="type type-ban"><svg class="icon"[^>]*><use href="#i-nocontact"><\/use><\/svg>Ban<\/span>/, 'action badge with an icon');
    assert.match(res.body, /Getting started/);
    assert.match(res.body, /Mod log channel/);
    assert.match(res.body, /&lt;t&gt;/);
    // Read-only: no POST form besides logout (the top bar search is a GET to /dashboard/modules).
    assert.ok(!/<form method="post"(?![^>]*logout)/.test(res.body), 'no POST forms besides logout');
    assert.match(res.body, /<form class="quick-find" role="search" method="get" action="\/dashboard\/modules">/);
});

test('overview survives failing sources (shows unavailable)', async () => {
    const boom = async () => { throw new Error('db down'); };
    const o = await collectOverview({
        client: { guilds: { cache: new Map() }, isReady: () => false },
        guildId: GUILD,
        data: { ...OVERVIEW_DATA, countOpenTickets: boom, listPendingAppeals: boom, searchCaseRecords: boom, getLockdownState: boom, getGuildConfig: boom, countActiveSanctions: boom },
    });
    assert.equal(o.openTickets, undefined);
    assert.equal(o.activeBans, undefined);
    assert.equal(o.recent, undefined);
    const page = overviewPage({ session: { username: 'a', csrf: 't' }, overview: o });
    assert.match(page, /unavailable/);
    assert.match(page, /<span class="dot dot-bad" aria-hidden="true"><\/span>Offline</);
});

test('getting started lists what is not configured; module states for the sidebar', () => {
    const items = gettingStarted({
        config: { ticketCategoryId: '1', verification: { enabled: true } },
        welcome: { enabled: true, channelId: '2' },
        settings: { modLogChannelId: null },
        mutedRole: { id: '3' },
    });
    const todo = items.filter((i) => !i.done).map((i) => i.label);
    assert.ok(todo.includes('Mod log channel'));
    assert.ok(todo.includes('Ticket staff role'));
    assert.ok(!todo.includes('Muted role'));
    assert.ok(!todo.includes('Appeals category'), 'ticket category covers appeals');
    assert.ok(items.every((i) => i.href.startsWith('/dashboard/')));
    assert.deepEqual(moduleStatesFrom({ logging: { enabled: true }, verification: {} }, { enabled: true, channelId: '1' }),
        { logging: true, tickets: false, leveling: true, verification: false, birthdays: false, welcome: true });
});

test('cases page validates filters (snowflakes, dates) and pages through the search service', async () => {
    let seen = null;
    const { d } = makeDashboard({
        data: {
            searchCaseRecords: async (guildId, filters, opts) => {
                seen = { guildId, filters, opts };
                return { rows: [{ case_code: 'abcde', type: 'ban', target_username: 't', target_user_id: STRANGER, moderator_username: 'm', reason: 'r', created_at: new Date(0), status: 'active' }], total: 60 };
            },
        },
    });
    const { cookie } = await login(d);
    const bad = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: { member: '1 OR 1=1' } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /member must be a Discord user/);
    const badDate = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: { from: '2026-13-01' } });
    assert.equal(badDate.statusCode, 400);

    const res = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: { member: STRANGER, type: 'ban', page: '1', text: ['a', 'b'] } });
    assert.equal(res.statusCode, 200);
    assert.equal(seen.guildId, GUILD);
    assert.deepEqual(seen.filters, { memberId: STRANGER, type: 'ban' }, 'array query values are ignored');
    assert.deepEqual(seen.opts, { page: 1, pageSize: 25 });
    assert.match(res.body, /Page 2 of 3/);
    assert.match(res.body, /href="\/dashboard\/cases\/abcde"/);
});

test('case detail: invalid or other-guild codes are 404; evidence images use fresh URLs', async () => {
    const record = {
        case_code: 'abcde', guild_id: GUILD, type: 'warn', name: 'n', target_username: 't', target_user_id: STRANGER,
        moderator_username: 'm', moderator_id: ADMIN, reason: 'r', created_at: new Date(0), status: 'active',
    };
    let resolvedWith = null;
    const { d } = makeDashboard({
        data: {
            getCaseByCode: async (code) => (code === 'abcde' ? record : code === 'fghjk' ? { ...record, guild_id: 'other' } : null),
            getCaseEdits: async () => [{ edited_at: new Date(0), edited_by_username: 'e', field: 'reason', old_value: '<a>', new_value: 'b' }],
            listEvidence: async () => [{ id: 7, kind: 'image', store_channel_id: '1', store_message_id: '2', added_by_username: 'm', added_at: new Date(0) }],
            resolveImageUrls: async (client, rows) => { resolvedWith = rows; return new Map([['7', 'https://cdn.discordapp.com/x.png']]); },
            getAppealHistory: async () => [],
        },
    });
    const { cookie } = await login(d);
    const notCode = await runProtected(d, d.caseDetail, { method: 'GET', headers: { cookie }, params: { code: '../etc' } });
    assert.equal(notCode.statusCode, 404);
    const other = await runProtected(d, d.caseDetail, { method: 'GET', headers: { cookie }, params: { code: 'fghjk' } });
    assert.equal(other.statusCode, 404);
    const res = await runProtected(d, d.caseDetail, { method: 'GET', headers: { cookie }, params: { code: 'ABCDE' } });
    assert.equal(res.statusCode, 200);
    assert.equal(resolvedWith.length, 1);
    assert.match(res.body, /<img src="https:\/\/cdn\.discordapp\.com\/x\.png"/);
    assert.match(res.body, /&lt;a&gt;/);
});

test('module pages render the module; unknown modules fall through', async () => {
    const { d } = makeDashboard();
    const { cookie } = await login(d);
    const res = await runProtected(d, d.modulePage, { method: 'GET', headers: { cookie }, params: { module: 'support' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Support server/);
    assert.match(res.body, /Read-only: editing from the dashboard is turned off/, 'DASHBOARD_EDIT_ENABLED is not set in ENV');
    let next = false;
    const req = { method: 'GET', headers: { cookie }, params: { module: 'nope' } };
    await d.requireUser(req, fakeRes(), () => {});
    await d.modulePage(req, fakeRes(), () => { next = true; });
    assert.equal(next, true);
});

test('logout needs the CSRF token and a same-origin request', async () => {
    const { d } = makeDashboard();
    const { cookie } = await login(d);
    const noToken = await runProtected(d, d.logout, { method: 'POST', headers: { cookie }, body: {} });
    assert.equal(noToken.statusCode, 403);
    const page = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
    const crossSite = await runProtected(d, d.logout, { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: { csrf } });
    assert.equal(crossSite.statusCode, 403);
    const crossFetch = await runProtected(d, d.logout, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' }, body: { csrf } });
    assert.equal(crossFetch.statusCode, 403);
    const ok = await runProtected(d, d.logout, { method: 'POST', headers: { cookie, origin: 'https://bot.example' }, body: { csrf } });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /logged out/);
    const after = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    assert.equal(after.redirectedTo, '/dashboard', 'session destroyed server-side');
});

test('security headers: CSP without unsafe-inline, frame denial, no referrer, no caching', () => {
    const { d } = makeDashboard();
    const res = fakeRes();
    let called = false;
    d.securityHeaders({}, res, () => { called = true; });
    assert.equal(called, true);
    const { 'Strict-Transport-Security': hsts, ...rest } = res.headers;
    assert.deepEqual(rest, SECURITY_HEADERS);
    assert.equal(hsts, 'max-age=31536000', 'HTTPS public URL: HSTS on');
    const local = createDashboard({ client: {}, settings: dashboardSettings({ ...ENV, PUBLIC_URL: 'http://127.0.0.1:5055/' }), access: async () => ({}), sessions: createMemorySessionStore() });
    const localRes = fakeRes();
    local.securityHeaders({}, localRes, () => {});
    assert.equal(localRes.headers['Strict-Transport-Security'], undefined, 'plain http preview: no HSTS');
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    assert.ok(!csp.includes('unsafe-inline'));
    assert.ok(!csp.includes('unsafe-eval'));
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
});

// ── Design: theme switch, page shell, collapsible records sections ─────────

test('theme: the cookie sets data-theme on <html> server-side; unknown values mean system (follow the device)', () => {
    assert.equal(themeFrom('dark'), 'dark');
    assert.equal(themeFrom('"><script>'), 'system');
    assert.equal(themeFrom(undefined), 'system');
    const session = { username: 'a', csrf: 't' };
    assert.match(layout({ title: 'x', session: { ...session, theme: 'dark' }, body: html`` }), /^<!doctype html><html lang="en" data-theme="dark">/);
    assert.match(layout({ title: 'x', session: { ...session, theme: 'nope' }, body: html`` }), /^<!doctype html><html lang="en"><head>/);
    assert.match(layout({ title: 'x', body: html`` }), /^<!doctype html><html lang="en"><head>/, 'pages without a session (login, errors) follow the device');
    assert.equal(themeFrom('light'), 'white', 'old cookies keep a light theme');
    for (const theme of ['white', 'gray', 'black', 'paper', 'sage', 'sand']) assert.equal(themeFrom(theme), theme);
    // The picker: a radio group of plain links (works without JS), back to this page; the current one checked.
    const page = layout({ title: 'x', active: 'cases', session: { ...session, theme: 'sage', path: '/dashboard/cases?page=2' }, body: html`` });
    assert.match(page, /^<!doctype html><html lang="en" data-theme="sage">/);
    const menu = page.slice(page.indexOf('<div class="theme-grid" role="radiogroup" aria-labelledby="theme-menu">'));
    const options = [...menu.slice(0, menu.indexOf('</div>')).matchAll(/data-theme-pick="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(options, ['system', 'white', 'gray', 'dark', 'black', 'paper', 'sage', 'sand']);
    assert.ok(page.includes('href="/dashboard/theme?mode=paper&amp;next=%2Fdashboard%2Fcases%3Fpage%3D2" role="radio" aria-checked="false" tabindex="-1" data-theme-pick="paper"'));
    assert.match(page, /role="radio" aria-checked="true" tabindex="0" data-theme-pick="sage">/);
    assert.ok(page.includes('aria-labelledby="theme-sheet"'), 'the phone sheet has its own picker');
    assert.ok(!page.includes('style='), 'swatches use classes (CSP)');
});

test('theme: GET /dashboard/theme sets a non-HttpOnly cookie and only redirects inside the dashboard', () => {
    const { d } = makeDashboard();
    const res = fakeRes();
    d.setTheme({ headers: {}, query: { mode: 'sand', next: '/dashboard/automod' } }, res);
    assert.equal(res.statusCode, 303);
    assert.equal(res.redirectedTo, '/dashboard/automod');
    const cookie = res.cookies.find((c) => c.startsWith(`${THEME_COOKIE}=`));
    assert.match(cookie, /^meowist_theme=sand; Path=\/dashboard; SameSite=Lax; Max-Age=31536000; Secure$/);
    const bad = fakeRes();
    d.setTheme({ headers: {}, query: { mode: 'x', next: 'https://evil.example/' } }, bad);
    assert.equal(bad.redirectedTo, '/dashboard/overview');
    assert.match(bad.cookies[0], /^meowist_theme=system;/);
    for (const next of ['//evil.example', '/dashboard//evil.example', '/dashboardx', '/dashboard/a b', 'javascript:alert(1)', '/dashboard/x?a=<b>']) {
        assert.equal(safeBackPath(next), '/dashboard/overview', next);
    }
    assert.equal(safeBackPath('/dashboard/cases?member=123&page=2'), '/dashboard/cases?member=123&page=2');
});

test('case page: history, evidence and appeals are collapsible sections (history closed)', () => {
    const page = caseDetailPage({
        session: { username: 'a', csrf: 't' }, statusLabel: 'active',
        record: { case_code: 'abcdefg', type: 'warn', name: 'n', target_user_id: '1', target_username: 'u', moderator_id: '2', moderator_username: 'm', reason: 'r', created_at: new Date(0) },
        edits: [{ edited_at: new Date(0), edited_by_username: 'm', field: 'reason', old_value: 'a', new_value: 'b' }],
    });
    assert.match(page, /<details class="card section" id="s-case-history" data-key="case-history"><summary><h2>History \(1\)<\/h2>/);
    assert.match(page, /<details class="card section" id="s-case-evidence" data-key="case-evidence" open>/);
    assert.match(page, /<details class="card section" id="s-case-appeals" data-key="case-appeals"><summary><h2>Appeals \(0\)/);
});

test('layout v3: rail with the sections, section pages as tabs, phone tab bar with a More sheet', () => {
    const page = layout({ title: 'x', active: 'tickets', session: { username: 'a', csrf: 't', server: { name: 'Cats <3', iconUrl: null } }, body: html`` });
    assert.match(page, /<details class="server-switch menu-wrap"><summary aria-label="Server: Cats &lt;3">/);
    assert.ok(page.includes('Only this server can be managed for now.'));
    const rail = page.slice(page.indexOf('<nav class="rail"'), page.indexOf('</nav>', page.indexOf('<nav class="rail"')));
    const tips = [...rail.matchAll(/<span class="rail-tip">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(tips, ['Overview', 'Modules', 'Moderation', 'Community', 'Server']);
    assert.match(rail, /<a class="rail-item on" href="\/dashboard\/welcome" aria-current="true">.*Community/, 'tickets is in Community');
    const tabs = page.slice(page.indexOf('<nav class="section-tabs"'), page.indexOf('</nav>', page.indexOf('<nav class="section-tabs"')));
    assert.match(tabs, /<a href="\/dashboard\/tickets" class="on" aria-current="page">.*Tickets &amp; modmail/);
    assert.ok(!tabs.includes('/dashboard/cases'), 'only the current section');
    assert.match(page, /<nav class="tabbar" aria-label="Sections">/);
    assert.match(page, /<details class="more menu-wrap"><summary>.*More<\/span><\/summary><div class="more-sheet">/);
    assert.ok(page.includes('href="/dashboard/audit"'), 'Audit log reachable from the More sheet');
    assert.ok(page.includes('class="icon-button find-link" href="/dashboard/modules" aria-label="Find a setting"'), 'phones get a search icon');
    assert.ok(!/class="sidebar"|class="topbar"|nav-toggle/.test(page), 'old shell gone');
});

test('overview week chart: the last 7 UTC days, oldest first, today last, missing days 0', async () => {
    const { weekSeries } = await import('../src/services/dashboard/overview.js');
    const now = Date.UTC(2026, 9, 28, 23, 30); // Wednesday 28 Oct 2026, late UTC evening
    const week = weekSeries({ '2026-10-28': 3, '2026-10-22': 1, '2026-10-21': 9 }, now);
    assert.deepEqual(week.map((d) => d.day), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
    assert.deepEqual(week.map((d) => d.label), ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Today']);
    assert.deepEqual(week.map((d) => d.count), [1, 0, 0, 0, 0, 0, 3], 'the 8th day back is not counted');
    assert.equal(week.filter((d) => d.today).length, 1);
});
