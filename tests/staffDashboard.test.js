import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatAge, html, queryString, raw } from '../src/services/staffDashboard/html.js';
import {
    SESSION_COOKIE, STATE_COOKIE, allowRequest, createSessionStore, createState, createStateStore,
    isSnowflake, parseCookies, serializeCookie, signValue, verifySignedValue,
} from '../src/services/staffDashboard/security.js';
import { createAccessChecker, decideAccess } from '../src/services/staffDashboard/access.js';
import { caseDetailPage, casesPage, isAllowedImageUrl, isSafeLink } from '../src/services/staffDashboard/pages.js';
import { SECURITY_HEADERS, createDashboard, dashboardSettings } from '../src/services/staffDashboard/routes.js';

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

test('sessions expire after their TTL and can be destroyed', () => {
    const store = createSessionStore({ ttlMs: 1000 });
    const session = store.create({ userId: ADMIN, username: 'a' }, 0);
    assert.match(session.id, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(session.csrf);
    assert.equal(store.get(session.id, 500), session);
    assert.equal(store.get(session.id, 1000), null);
    const other = store.create({ userId: ADMIN }, 0);
    store.destroy(other.id);
    assert.equal(store.get(other.id, 1), null);
});

test('rate limit per session: sliding window', () => {
    const session = {};
    for (let i = 0; i < 3; i += 1) assert.equal(allowRequest(session, { limit: 3, windowMs: 1000 }, i), true);
    assert.equal(allowRequest(session, { limit: 3, windowMs: 1000 }, 10), false);
    assert.equal(allowRequest(session, { limit: 3, windowMs: 1000 }, 1500), true);
});

test('cookies: parse and serialize with the security flags', () => {
    assert.deepEqual(parseCookies('a=1; b=x%20y; a=2; bad'), { a: '1', b: 'x y' });
    const cookie = serializeCookie('n', 'v', { maxAgeMs: 60000, secure: true });
    assert.equal(cookie, 'n=v; Path=/staff; HttpOnly; SameSite=Lax; Max-Age=60; Secure');
    assert.ok(!serializeCookie('n', 'v').includes('Secure'));
    assert.equal(isSnowflake('123456789012345678'), true);
    assert.equal(isSnowflake('12345'), false);
    assert.equal(isSnowflake('123456789012345678 OR 1=1'), false);
});

// ── access ────────────────────────────────────────────────────────────────

test('access: main-server administrators and ticket staff only', () => {
    assert.equal(decideAccess({ inGuild: false, isAdmin: true }).allowed, false);
    assert.equal(decideAccess({ inGuild: true, isAdmin: true }).role, 'admin');
    assert.equal(decideAccess({ inGuild: true, isOwner: true }).role, 'admin');
    assert.equal(decideAccess({ inGuild: true, roleIds: ['5'], staffRoleId: '5' }).role, 'staff');
    assert.equal(decideAccess({ inGuild: true, roleIds: ['5'], staffRoleId: null }).allowed, false);
    assert.equal(decideAccess({ inGuild: true, roleIds: ['6'], staffRoleId: '5' }).allowed, false);
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
    STAFF_DASHBOARD_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: 'https://bot.example/', MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};

test('settings: off by default; refuses to enable without a long SESSION_SECRET', () => {
    assert.equal(dashboardSettings({}).enabled, false);
    assert.equal(dashboardSettings({}).requested, false);
    const ok = dashboardSettings(ENV);
    assert.equal(ok.enabled, true);
    assert.equal(ok.redirectUri, 'https://bot.example/staff/oauth/callback');
    assert.equal(ok.secure, true, 'https public URL → Secure cookies');
    assert.equal(ok.publicOrigin, 'https://bot.example');
    const short = dashboardSettings({ ...ENV, SESSION_SECRET: 'short' });
    assert.equal(short.enabled, false);
    assert.match(short.problems.join(), /SESSION_SECRET/);
    assert.equal(dashboardSettings({ ...ENV, SESSION_SECRET: undefined }).enabled, false);
    assert.equal(dashboardSettings({ ...ENV, DISCORD_CLIENT_SECRET: '' }).enabled, false);
    assert.equal(dashboardSettings({ ...ENV, PUBLIC_URL: 'http://127.0.0.1:3100', NODE_ENV: 'development' }).secure, false);
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

function makeDashboard({ me = { id: ADMIN, username: 'admin' }, data = {} } = {}) {
    const allowed = new Set([ADMIN]);
    const settings = dashboardSettings(ENV);
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
        fetchCalls.push({ url, options });
        const body = url.includes('/token') ? { access_token: 'tok', token_type: 'Bearer' } : me;
        return { ok: true, status: 200, json: async () => body };
    };
    const access = createAccessChecker({}, { facts: async (client, userId) => ({ inGuild: true, isAdmin: allowed.has(userId) }) });
    const d = createDashboard({
        client: { user: { id: '999999999999999999' } }, settings, access, fetchImpl,
        data: {
            searchCaseRecords: async () => ({ rows: [], total: 0 }),
            getLatestAppealStatusesForCases: async () => new Map(),
            getCaseByCode: async () => null,
            ...data,
        },
    });
    return { d, fetchCalls };
}

async function login(d) {
    const start = fakeRes();
    await d.index({ headers: {} }, start);
    const authorize = new URL(start.redirectedTo);
    const nonce = cookieValue(start, STATE_COOKIE);
    const res = fakeRes();
    await d.callback({ headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(nonce)}` }, query: { code: 'c', state: authorize.searchParams.get('state') } }, res);
    return { start, authorize, res, cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookieValue(res, SESSION_COOKIE) || '')}` };
}

async function runProtected(d, handler, req) {
    const res = fakeRes();
    let passed = false;
    await d.requireStaff(req, res, () => { passed = true; });
    if (passed) await handler(req, res);
    return res;
}

test('/staff without a session redirects to Discord with scope identify and a state cookie', async () => {
    const { d } = makeDashboard();
    const res = fakeRes();
    await d.index({ headers: {} }, res);
    assert.equal(res.statusCode, 302);
    const url = new URL(res.redirectedTo);
    assert.equal(url.origin, 'https://discord.com');
    assert.equal(url.searchParams.get('scope'), 'identify');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://bot.example/staff/oauth/callback');
    assert.ok(url.searchParams.get('state'));
    const stateCookie = res.cookies.find((c) => c.startsWith(`${STATE_COOKIE}=`));
    assert.match(stateCookie, /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
});

test('OAuth callback logs an admin in with a signed session cookie; no token reaches the browser', async () => {
    const { d, fetchCalls } = makeDashboard();
    const { res, cookie } = await login(d);
    assert.equal(res.statusCode, 303);
    assert.equal(res.redirectedTo, '/staff/cases');
    const sessionCookie = res.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    assert.match(sessionCookie, /HttpOnly; SameSite=Lax; Max-Age=43200; Secure/);
    assert.ok(!res.cookies.join().includes('tok'), 'access token never set as cookie');
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].options.body.get('redirect_uri'), 'https://bot.example/staff/oauth/callback');
    // Logged in: /staff goes to the cases page.
    const again = fakeRes();
    await d.index({ headers: { cookie } }, again);
    assert.equal(again.redirectedTo, '/staff/cases');
});

test('OAuth callback refuses replayed or cookie-less states and non-staff users', async () => {
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

test('protected pages: redirect without a session, 403 once access is lost, 429 over the limit', async () => {
    const { d } = makeDashboard();
    const anon = await runProtected(d, d.cases, { method: 'GET', headers: {}, query: {} });
    assert.equal(anon.redirectedTo, '/staff');

    const forged = await runProtected(d, d.cases, { method: 'GET', headers: { cookie: `${SESSION_COOKIE}=abc.def` }, query: {} });
    assert.equal(forged.redirectedTo, '/staff');

    const { cookie } = await login(d);
    const ok = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /No cases match/);

    for (let i = 0; i < 70; i += 1) await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    const limited = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    assert.equal(limited.statusCode, 429);

    // Access lost (role removed): a checker that now says no, sharing the session store.
    const second = makeDashboard();
    const login2 = await login(second.d);
    const res = fakeRes();
    const checker = createAccessChecker({}, { facts: async () => ({ inGuild: true, isAdmin: false }) });
    const d3 = createDashboard({ client: {}, settings: dashboardSettings(ENV), access: checker, sessions: second.d.sessions });
    let passed = false;
    await d3.requireStaff({ method: 'GET', headers: { cookie: login2.cookie } }, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
    assert.ok(res.cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`)), 'session cookie cleared');
    assert.equal(second.d.sessions.size(), 0, 'session destroyed');
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
    assert.match(res.body, /href="\/staff\/cases\/abcde"/);
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

test('logout needs the CSRF token and a same-origin request', async () => {
    const { d } = makeDashboard();
    const { cookie } = await login(d);
    const noToken = await runProtected(d, d.logout, { method: 'POST', headers: { cookie }, body: {} });
    assert.equal(noToken.statusCode, 403);
    // Find the csrf token through a rendered page.
    const page = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
    const crossSite = await runProtected(d, d.logout, { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: { csrf } });
    assert.equal(crossSite.statusCode, 403);
    const ok = await runProtected(d, d.logout, { method: 'POST', headers: { cookie, origin: 'https://bot.example' }, body: { csrf } });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /logged out/);
    const after = await runProtected(d, d.cases, { method: 'GET', headers: { cookie }, query: {} });
    assert.equal(after.redirectedTo, '/staff', 'session destroyed server-side');
});

test('security headers: CSP, frame denial, no referrer, no caching', () => {
    const { d } = makeDashboard();
    const res = fakeRes();
    let called = false;
    d.securityHeaders({}, res, () => { called = true; });
    assert.equal(called, true);
    assert.deepEqual(res.headers, SECURITY_HEADERS);
    assert.match(SECURITY_HEADERS['Content-Security-Policy'], /^default-src 'self'; img-src 'self' https:\/\/cdn\.discordapp\.com https:\/\/media\.discordapp\.net; style-src 'self' 'unsafe-inline'/);
    assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
});
