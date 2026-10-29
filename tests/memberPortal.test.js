// "My record" (/me, src/services/site/memberPortal.js): Discord login with a checked state,
// cookies scoped to /me, a session that is never a dashboard session (and the other way
// round), only the logged-in member's own record with member-safe fields, 503 on a
// database error, CSRF + same origin on logout, 404 when switched off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
    MEMBER_SECURITY_HEADERS, MEMBER_SESSION_COOKIE, MEMBER_STATE_COOKIE, appealInfo, buildRecordView,
    memberPortalSettings, memberSigningKey, registerMemberPortal,
} from '../src/services/site/memberPortal.js';
import { registerDashboard } from '../src/services/dashboard/routes.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { SESSION_COOKIE, signValue } from '../src/services/dashboard/security.js';
import { createSite } from '../src/services/site/site.js';

const SECRET = 'x'.repeat(64);
const GUILD = '100000000000000001';
const MEMBER = '200000000000000002';
const OTHER = '300000000000000003';
const ORIGIN = 'https://bot.example';
const ENV = {
    MEMBER_PORTAL_ENABLED: 'true', DASHBOARD_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: `${ORIGIN}/`, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};
const DAY = 24 * 3600 * 1000;
const future = (days) => new Date(Date.now() + days * DAY);
const past = (days) => new Date(Date.now() - days * DAY);

function caseRow(overrides) {
    return {
        id: 1, guild_id: GUILD, target_user_id: MEMBER, target_username: 'member', moderator_id: '555555555555555555',
        moderator_username: 'ModAlice', type: 'warn', name: 'member warn 1', reason: 'Spam', status: 'active',
        created_at: past(1), expires_at: null, unappealable: false, appeal_deadline: null, is_imported: false, is_test: false,
        voided_at: null, voided_by: null, void_reason: null, revoked_by: null, revoke_reason: null, counts_toward_level: 0,
        ...overrides,
    };
}

const CASES = [
    caseRow({ case_code: 'wwarn2', reason: '<b>Spam</b> in #general', created_at: past(2) }),
    caseRow({ case_code: 'bban23', type: 'ban', reason: 'Raiding', expires_at: future(5), created_at: past(2), duration_ms: 7 * DAY }),
    caseRow({ case_code: 'vvoid2', type: 'mute', status: 'revoked', voided_at: past(1), voided_by: '555555555555555555', void_reason: 'SECRET-VOID-NOTE', revoke_reason: 'Voided: SECRET-REVOKE' }),
    caseRow({ case_code: 'ttest2', type: 'kick', is_test: true, reason: 'SIMULATION-REASON' }),
    caseRow({ case_code: 'iimp23', is_imported: true, created_at: past(400), reason: 'Old warn' }),
];
const STANDING = {
    ladder: { level: 0, warns_since_level: 1 },
    warns: [CASES[0]],
    activeBan: CASES[1],
    activeMute: null,
    appeals: [],
};
const APPEALS = [
    { case_code: 'bban23', status: 'pending', created_at: past(1), decided_at: null, type: 'ban', name: 'n' },
    { case_code: 'xother', status: 'denied', created_at: past(1), decided_at: past(1), type: 'warn', name: 'n' },
];

function fakeData({ fail = false } = {}) {
    const calls = [];
    const guard = (name, userId) => {
        calls.push({ name, userId });
        if (fail) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    };
    return {
        calls,
        data: {
            getMemberStanding: async (guildId, userId) => { guard('standing', userId); assert.equal(guildId, GUILD); return STANDING; },
            listCasesForUser: async (guildId, userId) => { guard('cases', userId); assert.equal(guildId, GUILD); return { rows: CASES, total: CASES.length }; },
            listUserAppeals: async (userId) => { guard('appeals', userId); return APPEALS; },
        },
    };
}

function fakeDiscord(me = { id: MEMBER, username: 'member', global_name: 'Member <One>' }) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        const body = url.includes('/token') ? { access_token: 'tok', token_type: 'Bearer' } : me;
        return { ok: true, status: 200, json: async () => body };
    };
    return { calls, fetchImpl };
}

/** A bare app as in app.js: dashboard, member portal, then the site with its 404 catch-all. */
async function serve({ env = ENV, data = fakeData().data, fetchImpl = fakeDiscord().fetchImpl, limits } = {}) {
    const app = express();
    const memberSessions = createMemorySessionStore({ ttlMs: 3600 * 1000 });
    const dashSessions = createMemorySessionStore();
    const dashboardEnabled = registerDashboard(app, {}, env, { sessions: dashSessions });
    const memberPortalEnabled = registerMemberPortal(app, { env, dashboardEnabled, supportInvite: () => 'https://discord.gg/7Ckv9Bt577', sessions: memberSessions, data, fetchImpl, limits });
    app.use(createSite({ client: { commands: null }, env, dashboardEnabled, memberPortalEnabled, supportInvite: () => null }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, { method = 'GET', cookie = '', headers = {}, body } = {}) => {
        const res = await fetch(base + path, {
            method, redirect: 'manual', body,
            headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        });
        return { status: res.status, headers: res.headers, cookies: res.headers.getSetCookie(), body: await res.text() };
    };
    return {
        request, memberSessions, dashSessions, memberPortalEnabled, dashboardEnabled,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

const cookieLine = (cookies, name) => cookies.find((c) => c.startsWith(`${name}=`) && !c.includes('Max-Age=0'));
const cookieVal = (cookies, name) => {
    const line = cookieLine(cookies, name);
    return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : null;
};

async function login(app) {
    const start = await app.request('/me/login');
    const authorize = new URL(start.headers.get('location'));
    const nonce = cookieVal(start.cookies, MEMBER_STATE_COOKIE);
    const state = authorize.searchParams.get('state');
    const res = await app.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: `${MEMBER_STATE_COOKIE}=${encodeURIComponent(nonce)}` });
    const value = cookieVal(res.cookies, MEMBER_SESSION_COOKIE);
    return { start, authorize, nonce, state, res, value, cookie: `${MEMBER_SESSION_COOKIE}=${encodeURIComponent(value || '')}` };
}

// ── settings ──────────────────────────────────────────────────────────────

test('settings: off by default; needs the same secrets as the dashboard; own redirect URI', () => {
    assert.equal(memberPortalSettings({}).requested, false);
    assert.equal(memberPortalSettings({}).enabled, false);
    const ok = memberPortalSettings(ENV);
    assert.equal(ok.enabled, true);
    assert.equal(ok.redirectUri, `${ORIGIN}/me/callback`);
    assert.equal(ok.publicOrigin, ORIGIN);
    assert.equal(ok.secure, true);
    assert.notEqual(ok.signingKey, SECRET, 'a derived key, never the dashboard secret itself');
    assert.equal(ok.signingKey, memberSigningKey(SECRET));
    for (const [name, value] of [['SESSION_SECRET', 'short'], ['DISCORD_CLIENT_SECRET', ''], ['PUBLIC_URL', ''], ['CLIENT_ID', ''], ['MAIN_GUILD_ID', '']]) {
        const s = memberPortalSettings({ ...ENV, [name]: value });
        assert.equal(s.enabled, false, name);
        assert.ok(s.problems.some((p) => p.includes(name)), name);
    }
});

test('disabled or misconfigured: /me is a 404 and there is no "My record" link', async () => {
    for (const env of [{ ...ENV, MEMBER_PORTAL_ENABLED: 'false' }, { ...ENV, SESSION_SECRET: 'short', DASHBOARD_ENABLED: 'false' }]) {
        const app = await serve({ env });
        try {
            assert.equal(app.memberPortalEnabled, false);
            for (const path of ['/me', '/me/login', '/me/callback?code=c&state=s']) {
                assert.equal((await app.request(path)).status, 404, path);
            }
            const home = await app.request('/');
            assert.equal(home.status, 200);
            assert.ok(!home.body.includes('href="/me"'));
            assert.ok(!home.body.includes('My record'));
        } finally {
            await app.close();
        }
    }
});

test('enabled: "My record" in the top bar of the site; /me without a session is a login page', async () => {
    const { data, calls } = fakeData();
    const app = await serve({ data });
    try {
        assert.equal(app.memberPortalEnabled, true);
        const home = await app.request('/about');
        assert.ok(home.body.includes('<a href="/me">My record</a>'));
        const page = await app.request('/me');
        assert.equal(page.status, 200);
        assert.ok(page.body.includes('href="/me/login"'));
        assert.ok(page.body.includes('<a href="/me" aria-current="page">My record</a>'));
        assert.equal(calls.length, 0, 'no record is read without a session');
        for (const [name, value] of Object.entries(MEMBER_SECURITY_HEADERS)) assert.equal(page.headers.get(name), value, name);
        assert.match(page.headers.get('content-security-policy'), /script-src 'none'/);
        assert.ok(!/<script|\sstyle=|<style/i.test(page.body), 'no scripts or inline styles');
    } finally {
        await app.close();
    }
});

// ── login ─────────────────────────────────────────────────────────────────

test('login: redirect to Discord with scope identify, the /me redirect URI and a /me state cookie', async () => {
    const app = await serve();
    try {
        const res = await app.request('/me/login');
        assert.equal(res.status, 302);
        const url = new URL(res.headers.get('location'));
        assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
        assert.equal(url.searchParams.get('scope'), 'identify');
        assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/me/callback`);
        assert.ok(url.searchParams.get('state'));
        assert.match(cookieLine(res.cookies, MEMBER_STATE_COOKIE), /^mewvo_me_state=[^;]+; Path=\/me; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
    } finally {
        await app.close();
    }
});

test('callback: a member session cookie scoped to /me, 1 hour, HttpOnly, Secure; the access token is not kept', async () => {
    const discord = fakeDiscord();
    const app = await serve({ fetchImpl: discord.fetchImpl });
    try {
        const { res, value } = await login(app);
        assert.equal(res.status, 303);
        assert.equal(res.headers.get('location'), '/me');
        assert.match(cookieLine(res.cookies, MEMBER_SESSION_COOKIE), /^mewvo_me=[^;]+; Path=\/me; HttpOnly; SameSite=Lax; Max-Age=3600; Secure$/);
        assert.ok(res.cookies.some((c) => c.startsWith(`${MEMBER_STATE_COOKIE}=;`) && c.includes('Max-Age=0')), 'state cookie cleared');
        assert.ok(!res.cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`)), 'no dashboard cookie');
        assert.equal(app.memberSessions.size(), 1);
        assert.equal(app.dashSessions.size(), 0, 'nothing in the dashboard session store');
        assert.ok(!value.includes('tok'));
        assert.equal(discord.calls.length, 2, 'token exchange + /users/@me only');
        assert.equal(new URLSearchParams(discord.calls[0].options.body).get('redirect_uri'), `${ORIGIN}/me/callback`);
        // Logging in again rotates: the old session is gone.
        const again = await login(app);
        assert.notEqual(again.value, value);
    } finally {
        await app.close();
    }
});

test('callback: rejects a missing, wrong-nonce, forged, dashboard-signed or replayed state', async () => {
    const app = await serve();
    try {
        const start = await app.request('/me/login');
        const state = new URL(start.headers.get('location')).searchParams.get('state');
        const nonce = cookieVal(start.cookies, MEMBER_STATE_COOKIE);
        const cookie = `${MEMBER_STATE_COOKIE}=${encodeURIComponent(nonce)}`;
        assert.equal((await app.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`)).status, 400, 'no state cookie');
        assert.equal((await app.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: `${MEMBER_STATE_COOKIE}=other` })).status, 400, 'wrong nonce');
        assert.equal((await app.request(`/me/callback?code=c&state=${encodeURIComponent(`${state}x`)}`, { cookie })).status, 400, 'forged');
        assert.equal((await app.request(`/me/callback?state=${encodeURIComponent(state)}`, { cookie })).status, 400, 'no code');
        // A state the dashboard issued (signed with SESSION_SECRET) is not valid here.
        const dash = await app.request('/dashboard');
        const dashState = new URL(dash.headers.get('location')).searchParams.get('state');
        const dashNonce = cookieVal(dash.cookies, 'mewvo_dash_state');
        assert.equal((await app.request(`/me/callback?code=c&state=${encodeURIComponent(dashState)}`, { cookie: `${MEMBER_STATE_COOKIE}=${encodeURIComponent(dashNonce)}` })).status, 400, 'dashboard state');
        const ok = await app.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`, { cookie });
        assert.equal(ok.status, 303);
        const replay = await app.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`, { cookie });
        assert.equal(replay.status, 400, 'single use');
        assert.ok(!cookieLine(replay.cookies, MEMBER_SESSION_COOKIE));
        assert.equal((await app.request('/me/callback?error=access_denied')).status, 400);
    } finally {
        await app.close();
    }
});

test('login and callback are rate limited per IP', async () => {
    const app = await serve({ limits: { login: { limit: 2, windowMs: 60000 }, page: { limit: 100, windowMs: 60000 } } });
    try {
        assert.equal((await app.request('/me/login')).status, 302);
        assert.equal((await app.request('/me/login')).status, 302);
        const third = await app.request('/me/callback?code=c&state=s');
        assert.equal(third.status, 429);
        assert.equal(third.headers.get('retry-after'), '60');
    } finally {
        await app.close();
    }
});

// ── separation from the dashboard ─────────────────────────────────────────

test('a dashboard session is never accepted at /me', async () => {
    const { data, calls } = fakeData();
    const app = await serve({ data });
    try {
        const dash = await app.dashSessions.create({ userId: MEMBER, username: 'admin' });
        const signed = signValue(dash.id, SECRET);
        for (const cookie of [`${SESSION_COOKIE}=${encodeURIComponent(signed)}`, `${MEMBER_SESSION_COOKIE}=${encodeURIComponent(signed)}`,
            // Even signed with the member key, the id is not in the member session table.
            `${MEMBER_SESSION_COOKIE}=${encodeURIComponent(signValue(dash.id, memberSigningKey(SECRET)))}`]) {
            const res = await app.request('/me', { cookie });
            assert.equal(res.status, 200);
            assert.ok(res.body.includes('href="/me/login"'), cookie);
            assert.ok(!res.body.includes('Log out'));
        }
        assert.equal(calls.length, 0, 'no record read');
    } finally {
        await app.close();
    }
});

test('a member session is never accepted at /dashboard', async () => {
    const app = await serve();
    try {
        const { value, cookie } = await login(app);
        const id = value.slice(0, value.lastIndexOf('.'));
        // Positive control: a real dashboard session is recognised (then refused by access: 403, not a login redirect).
        const dash = await app.dashSessions.create({ userId: MEMBER, username: 'm' });
        const control = await app.request('/dashboard/overview', { cookie: `${SESSION_COOKIE}=${encodeURIComponent(signValue(dash.id, SECRET))}` });
        assert.equal(control.status, 403);
        for (const c of [cookie, `${SESSION_COOKIE}=${encodeURIComponent(value)}`, `${SESSION_COOKIE}=${encodeURIComponent(signValue(id, SECRET))}`]) {
            const res = await app.request('/dashboard/overview', { cookie: c });
            assert.equal(res.status, 302, c);
            assert.equal(res.headers.get('location'), '/dashboard');
        }
    } finally {
        await app.close();
    }
});

// ── the record ────────────────────────────────────────────────────────────

test('the record: only the logged-in member, member-safe fields, test cases left out', async () => {
    const { data, calls } = fakeData();
    const app = await serve({ data });
    try {
        const { cookie } = await login(app);
        const res = await app.request(`/me?user=${OTHER}&id=${OTHER}`, { cookie });
        assert.equal(res.status, 200);
        assert.ok(calls.length >= 3);
        assert.ok(calls.every((c) => c.userId === MEMBER), 'the user id comes from the session, never the query');
        const body = res.body;
        assert.ok(body.includes('1 of 3'), 'warnings X of 3');
        assert.ok(body.includes('Level 0 of 3'));
        assert.ok(body.includes('It would be warning 2 of 3.'), 'the My standing next-warning text');
        assert.ok(body.includes('Ban <code>bban23</code>: ends <time'), 'active ban with its end');
        assert.ok(body.includes('Member &lt;One&gt;'), 'name escaped');
        assert.ok(body.includes('&lt;b&gt;Spam&lt;/b&gt;'), 'reason escaped');
        assert.ok(body.includes('ModAlice'), 'the moderator name, as the DM shows it');
        assert.ok(body.includes('counts now'));
        assert.ok(body.includes('voided: no longer counts'));
        assert.ok(body.includes('history only (imported, does not count)'));
        assert.ok(body.includes('Appeal pending'));
        assert.ok(body.includes('Pending: the administrators have not decided yet'));
        assert.ok(body.includes('Appeal from the appeal panel in Discord'));
        assert.ok(body.includes('href="https://discord.gg/7Ckv9Bt577"'));
        for (const hidden of ['ttest2', 'SIMULATION-REASON', 'SECRET-VOID-NOTE', 'SECRET-REVOKE', '555555555555555555', 'xother', 'member warn 1']) {
            assert.ok(!body.includes(hidden), `hidden: ${hidden}`);
        }
        assert.ok(!/<script|\sstyle=|<style/i.test(body));
        assert.ok(body.includes('<form method="post" action="/me/logout">'));
    } finally {
        await app.close();
    }
});

test('a database error is a 503 page, never an empty record', async () => {
    const { data } = fakeData({ fail: true });
    const app = await serve({ data });
    try {
        const { cookie } = await login(app);
        const res = await app.request('/me', { cookie });
        assert.equal(res.status, 503);
        assert.ok(res.body.includes('does not mean your record is clean'));
        assert.ok(!res.body.includes('no cases'));
        assert.ok(!res.body.includes('ECONNREFUSED') && !res.body.includes('connection refused'), 'no internals');
        // The session store failing is a 503 too.
        app.memberSessions.get = async () => { throw new Error('db down'); };
        assert.equal((await app.request('/me', { cookie })).status, 503);
    } finally {
        await app.close();
    }
});

test('logout: needs the CSRF token and the same origin; then the session is gone', async () => {
    const app = await serve();
    try {
        const { cookie } = await login(app);
        const page = await app.request('/me', { cookie });
        const csrf = page.body.match(/name="csrf" value="([^"]+)"/)[1];
        const post = (body, headers) => app.request('/me/logout', { method: 'POST', cookie, body, headers });
        assert.equal((await post('csrf=wrong', { origin: ORIGIN })).status, 403, 'bad token');
        assert.equal((await post(`csrf=${encodeURIComponent(csrf)}`, { origin: 'https://evil.example' })).status, 403, 'other origin');
        assert.equal(app.memberSessions.size(), 1);
        const ok = await post(`csrf=${encodeURIComponent(csrf)}`, { origin: ORIGIN });
        assert.equal(ok.status, 303);
        assert.equal(ok.headers.get('location'), '/me');
        assert.ok(ok.cookies.some((c) => c.startsWith(`${MEMBER_SESSION_COOKIE}=;`) && c.includes('Path=/me') && c.includes('Max-Age=0')));
        assert.equal(app.memberSessions.size(), 0);
        const after = await app.request('/me', { cookie });
        assert.ok(after.body.includes('href="/me/login"'), 'logged out');
        assert.equal((await app.request('/me/logout', { method: 'POST', body: 'csrf=x', headers: { origin: ORIGIN } })).status, 401);
    } finally {
        await app.close();
    }
});

test('unknown /me paths are a 404 under the portal headers', async () => {
    const app = await serve();
    try {
        const res = await app.request('/me/anything');
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('cache-control'), 'no-store');
    } finally {
        await app.close();
    }
});

// ── pure parts ────────────────────────────────────────────────────────────

test('appealInfo mirrors assertAppealable', () => {
    const config = { appealWindowMs: 30 * DAY, appealCooldownMs: 7 * DAY };
    const now = Date.now();
    const at = (record, last) => appealInfo(caseRow(record), last, { now, config });
    assert.equal(at({ type: 'warn' }).appealable, true);
    assert.equal(at({ type: 'warn', created_at: past(31) }).appealable, false);
    assert.equal(at({ type: 'kick', unappealable: true }).text, 'Cannot be appealed');
    assert.equal(at({ type: 'warn', status: 'revoked' }).text, 'Already lifted');
    assert.equal(at({ type: 'mute', expires_at: past(1) }).text, 'Ended: nothing to appeal');
    assert.equal(at({ type: 'ban', expires_at: null, appeal_deadline: past(1) }).text, 'The appeal window has closed');
    const perm = at({ type: 'ban', expires_at: null, appeal_deadline: future(100) });
    assert.equal(perm.appealable, true);
    assert.ok(Math.abs(perm.until.getTime() - future(100).getTime()) < 5000);
    assert.equal(at({ type: 'ban', expires_at: future(3) }, { status: 'pending' }).text, 'Appeal pending');
    const denied = at({ type: 'ban', expires_at: future(30) }, { status: 'denied', decided_at: past(1) });
    assert.equal(denied.appealable, false);
    assert.ok(denied.from instanceof Date);
    assert.equal(at({ type: 'ban', expires_at: future(30) }, { status: 'denied', decided_at: past(8) }).appealable, true);
});

test('buildRecordView keeps only member-safe fields', () => {
    const view = buildRecordView({ standing: STANDING, cases: CASES, appeals: APPEALS });
    const allowed = ['code', 'type', 'reason', 'by', 'createdAt', 'endsAt', 'permanent', 'status', 'appeal'];
    for (const c of view.cases) assert.deepEqual(Object.keys(c).sort(), [...allowed].sort());
    assert.deepEqual(view.cases.map((c) => c.code), ['wwarn2', 'bban23', 'vvoid2', 'iimp23']);
    assert.deepEqual(view.appeals.map((a) => a.code), ['bban23'], 'appeals only for this member\'s listed cases');
    assert.deepEqual(view.warnings, { count: 1, threshold: 3 });
    assert.equal(view.activeBan.code, 'bban23');
    assert.equal(view.activeMute, null);
    const level2 = buildRecordView({ standing: { ...STANDING, ladder: { level: 2, warns_since_level: 0 } }, cases: [], appeals: [] });
    assert.deepEqual(level2.warnings, { count: 0, threshold: 1 });
});
