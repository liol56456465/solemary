// Web appeals on the member portal (multi-server B4a, src/services/site/portalAppeals.js):
// Discord login required, only the logged-in member's own cases (from any server, each named by
// its server), the same rules as the bot (one pending appeal per case, the cooldown after a
// denial, unappealable / ended cases), CSRF + same origin, a per-member limit, no moderator names
// or notes on the page, and the punishment DMs of other servers link here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { MEMBER_SESSION_COOKIE, MEMBER_STATE_COOKIE, registerMemberPortal } from '../src/services/site/memberPortal.js';
import { buildAppealsView, parseAppealForm } from '../src/services/site/portalAppeals.js';
import { appealInfo } from '../src/services/site/memberPortal.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';
import { createError, ErrorTypes } from '../src/utils/errorHandler.js';
import { appealDeniedDm, banDm, kickDm, warnDm, webAppealUrl } from '../src/services/enforcement/dmTemplates.js';

const SECRET = 'y'.repeat(64);
const GUILD_A = '100000000000000011';
const GUILD_B = '100000000000000022';
const MEMBER = '200000000000000002';
const OTHER = '300000000000000003';
const ORIGIN = 'https://bot.example';
// Neither server is a home server here (no MAIN_GUILD_ID in process.env): each reads its own
// appeal settings, the defaults (30-day window, 7-day cooldown).
setSettingsCacheForTests(GUILD_A, {});
setSettingsCacheForTests(GUILD_B, {});
const ENV = {
    MEMBER_PORTAL_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: `${ORIGIN}/`, MAIN_GUILD_ID: '100000000000000099', NODE_ENV: 'test',
    MEMBER_ACCOUNTS_ENABLED: 'false',
};
const DAY = 24 * 3600 * 1000;
const future = (days) => new Date(Date.now() + days * DAY);
const past = (days) => new Date(Date.now() - days * DAY);

function caseRow(overrides) {
    return {
        id: 1, guild_id: GUILD_A, target_user_id: MEMBER, target_username: 'member', moderator_id: '555555555555555555',
        moderator_username: 'SecretModName', type: 'warn', name: 'member warn 1', reason: 'Spam', status: 'active',
        created_at: past(1), expires_at: null, unappealable: false, appeal_deadline: null, is_imported: false, is_test: false,
        voided_at: null, revoke_reason: null, ...overrides,
    };
}

const CASES = [
    caseRow({ case_code: 'bana22', type: 'ban', reason: 'Raiding', expires_at: future(5), guild_id: GUILD_A }),
    caseRow({ case_code: 'warnb2', reason: '<b>Spam</b>', guild_id: GUILD_B }),
    caseRow({ case_code: 'pend22', guild_id: GUILD_A }),
    caseRow({ case_code: 'deny22', guild_id: GUILD_B }),
    caseRow({ case_code: 'deny33', guild_id: GUILD_B }),
    caseRow({ case_code: 'endb22', type: 'ban', status: 'expired', expires_at: past(1) }),
    caseRow({ case_code: 'unap22', type: 'ban', unappealable: true }),
    caseRow({ case_code: 'testx2', is_test: true }),
    // A stray row of somebody else (a data-layer bug must still never show it).
    caseRow({ case_code: 'xyzab2', target_user_id: OTHER }),
];
const APPEALS = [
    { case_code: 'pend22', status: 'pending', created_at: past(1), decided_at: null, claimed_at: null, type: 'warn', guild_id: GUILD_A },
    { case_code: 'deny22', status: 'denied', created_at: past(2), decided_at: past(1), type: 'warn', guild_id: GUILD_B, note: 'SECRET-STAFF-NOTE', decided_by_username: 'SecretDecider' },
    { case_code: 'deny33', status: 'denied', created_at: past(20), decided_at: past(10), type: 'warn', guild_id: GUILD_B },
];
const NAMES = { [GUILD_A]: 'Alpha **Server**', [GUILD_B]: 'Beta <script>' };

function fakeData({ fail = false, submitError = null } = {}) {
    const calls = [];
    const guard = (name, arg) => {
        calls.push({ name, arg });
        if (fail) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    };
    return {
        calls,
        appeals: {
            listCases: async (userId) => { guard('cases', userId); return CASES; },
            listUserAppeals: async (userId) => { guard('appeals', userId); return userId === MEMBER ? APPEALS : []; },
            getCase: async (code) => { guard('case', code); return CASES.find((c) => c.case_code === code) || null; },
            guildName: (guildId) => NAMES[guildId] || null,
            submitAppeal: async (args) => {
                calls.push({ name: 'submit', arg: args });
                if (submitError) throw submitError;
                return { record: CASES.find((c) => c.case_code === args.caseCode), storedOnly: true };
            },
        },
    };
}

function fakeDiscord(me = { id: MEMBER, username: 'member', global_name: 'Member One' }) {
    return async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/token') ? { access_token: 'tok' } : me) });
}

const standing = { ladder: { level: 0, warns_since_level: 0 }, warns: [], activeBan: null, activeMute: null };
async function serve({ appeals = fakeData().appeals, limits, me } = {}) {
    const app = express();
    const sessions = createMemorySessionStore({ ttlMs: 3600 * 1000 });
    const data = { getMemberStanding: async () => standing, listCasesForUser: async () => ({ rows: [], total: 0 }), listUserAppeals: async () => [] };
    registerMemberPortal(app, { env: ENV, sessions, data, fetchImpl: fakeDiscord(me), limits, ...(appeals ? { appeals } : {}) });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, { method = 'GET', cookie = '', headers = {}, body } = {}) => {
        const res = await fetch(base + path, {
            method, redirect: 'manual', body,
            headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        });
        return { status: res.status, headers: res.headers, cookies: res.headers.getSetCookie(), body: await res.text() };
    };
    return { request, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const cookieVal = (cookies, name) => {
    const line = cookies.find((c) => c.startsWith(`${name}=`) && !c.includes('Max-Age=0'));
    return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : null;
};

async function login(app) {
    const start = await app.request('/me/login');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const nonce = cookieVal(start.cookies, MEMBER_STATE_COOKIE);
    const res = await app.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: `${MEMBER_STATE_COOKIE}=${encodeURIComponent(nonce)}` });
    return `${MEMBER_SESSION_COOKIE}=${encodeURIComponent(cookieVal(res.cookies, MEMBER_SESSION_COOKIE))}`;
}

const GOOD = { punished: 'I posted links in #general', reason: 'I did not know the rule and it will not happen again.', didIt: 'partly' };
const form = (values) => new URLSearchParams(values).toString();

async function csrfOf(app, cookie, code) {
    const page = await app.request(`/me/appeal/${code}`, { cookie });
    assert.equal(page.status, 200, page.body);
    return page.body.match(/name="csrf" value="([^"]+)"/)[1];
}

// ── auth ──────────────────────────────────────────────────────────────────

test('logged out: the pages ask for a Discord login that comes back to them; a POST is refused', async () => {
    const { appeals, calls } = fakeData();
    const app = await serve({ appeals });
    try {
        const list = await app.request('/me/appeals');
        assert.equal(list.status, 200);
        assert.ok(list.body.includes('href="/me/login?next=%2Fme%2Fappeals"'), 'login returns to the list');
        const one = await app.request('/me/appeal/bana22');
        assert.ok(one.body.includes('href="/me/login?next=%2Fme%2Fappeal%2Fbana22"'), 'login returns to the form (the DM link)');
        assert.ok(!one.body.includes('Raiding'), 'nothing about the case before login');
        // The login keeps the return path and lands on the form.
        const start = await app.request('/me/login?next=%2Fme%2Fappeal%2Fbana22');
        assert.equal(start.status, 302);
        const post = await app.request('/me/appeal/bana22', { method: 'POST', body: form({ ...GOOD, csrf: 'x' }), headers: { origin: ORIGIN } });
        assert.equal(post.status, 401);
        assert.equal(calls.filter((c) => c.name === 'submit').length, 0);
    } finally {
        await app.close();
    }
});

test('without the bot client the web appeal pages are not mounted (404)', async () => {
    const app = await serve({ appeals: null });
    try {
        const cookie = await login(app);
        assert.equal((await app.request('/me/appeals', { cookie })).status, 404);
        assert.equal((await app.request('/me/appeal/bana22', { cookie })).status, 404);
        const record = await app.request('/me', { cookie });
        assert.ok(!record.body.includes('/me/appeals'), 'no link to them');
    } finally {
        await app.close();
    }
});

// ── only your own cases, every server, member-safe ────────────────────────

test('the list: own appealable cases of every server, named by server; no other member, no test, no moderator, no notes', async () => {
    const { appeals, calls } = fakeData();
    const app = await serve({ appeals });
    try {
        const cookie = await login(app);
        const res = await app.request('/me/appeals', { cookie });
        assert.equal(res.status, 200);
        const { body } = res;
        assert.ok(calls.filter((c) => c.name === 'cases' || c.name === 'appeals').every((c) => c.arg === MEMBER), 'read for the session user only');
        for (const code of ['bana22', 'warnb2', 'deny33']) assert.ok(body.includes(`href="/me/appeal/${code}"`), `${code} can be appealed`);
        for (const code of ['pend22', 'deny22', 'endb22', 'unap22', 'testx2', 'xyzab2']) assert.ok(!body.includes(`href="/me/appeal/${code}"`), `${code} cannot`);
        assert.ok(!body.includes('xyzab2') && !body.includes('testx2'), 'other member / test case never shown');
        assert.ok(body.includes('Alpha **Server**'), 'server name, as plain text (no markup)');
        assert.ok(body.includes('Beta &lt;script&gt;') && !body.includes('<script>'), 'server name escaped');
        assert.ok(body.includes('&lt;b&gt;Spam&lt;/b&gt;'), 'reason escaped');
        assert.ok(!body.includes('SecretModName') && !body.includes('555555555555555555'), 'no moderator');
        assert.ok(!body.includes('SECRET-STAFF-NOTE') && !body.includes('SecretDecider'), 'no decision note or decider');
        assert.ok(body.includes('Pending: the administrators have not decided yet') && body.includes('Denied'), 'appeal status shown');
        // The record page links here, and its appealable cases link to the form.
        const record = await app.request('/me', { cookie });
        assert.ok(record.body.includes('href="/me/appeals"'));
    } finally {
        await app.close();
    }
});

test('the form: somebody else\'s code, a test case and an unknown code are the same 404', async () => {
    const app = await serve();
    try {
        const cookie = await login(app);
        const pages = await Promise.all(['xyzab2', 'testx2', 'zzzzz2', 'not-a-code'].map((code) => app.request(`/me/appeal/${code}`, { cookie })));
        for (const page of pages) {
            assert.equal(page.status, 404);
            assert.ok(page.body.includes('That case code was not found for your account.'));
        }
        assert.ok(!pages[0].body.includes('Spam'), 'nothing of the other case');
        const own = await app.request('/me/appeal/bana22', { cookie });
        assert.equal(own.status, 200);
        assert.ok(own.body.includes('Alpha **Server**') && own.body.includes('Raiding'));
        assert.ok(!own.body.includes('SecretModName'), 'no moderator name');
        for (const value of ['yes', 'partly', 'no']) assert.ok(own.body.includes(`name="didIt" type="radio" value="${value}"`));
        assert.ok(own.body.includes('name="punished"') && own.body.includes('name="reason"'));
    } finally {
        await app.close();
    }
});

// ── submitting ───────────────────────────────────────────────────────────

test('submit: needs the CSRF token and the same origin; then the normal appeal flow with the session user', async () => {
    const { appeals, calls } = fakeData();
    const app = await serve({ appeals });
    try {
        const cookie = await login(app);
        const csrf = await csrfOf(app, cookie, 'warnb2');
        const post = (values, headers = { origin: ORIGIN }) => app.request('/me/appeal/warnb2', { method: 'POST', cookie, body: form(values), headers });
        assert.equal((await post({ ...GOOD, csrf: 'wrong' })).status, 403, 'bad token');
        assert.equal((await post({ ...GOOD })).status, 403, 'no token');
        assert.equal((await post({ ...GOOD, csrf }, { origin: 'https://evil.example' })).status, 403, 'other origin');
        assert.equal(calls.filter((c) => c.name === 'submit').length, 0);
        const ok = await post({ ...GOOD, csrf, userId: OTHER, caseCode: 'xyzab2' });
        assert.equal(ok.status, 303);
        assert.equal(ok.headers.get('location'), '/me/appeals?sent=warnb2');
        const submits = calls.filter((c) => c.name === 'submit');
        assert.equal(submits.length, 1);
        assert.deepEqual(submits[0].arg, { user: { id: MEMBER, username: 'Member One' }, caseCode: 'warnb2', answers: GOOD }, 'only the session user, the URL case and the three answers');
        // The list then shows the confirmation with the server name (only for an own appeal).
        const after = await app.request('/me/appeals?sent=deny22', { cookie });
        assert.ok(after.body.includes('Your appeal for deny22 was sent to the staff of Beta &lt;script&gt;.'));
        const stranger = await app.request('/me/appeals?sent=xyzab2', { cookie });
        assert.ok(!stranger.body.includes('Your appeal for'), 'no flash for a case that is not theirs');
    } finally {
        await app.close();
    }
});

test('submit: somebody else\'s case is a 404 and is never sent', async () => {
    const { appeals, calls } = fakeData();
    const app = await serve({ appeals });
    try {
        const cookie = await login(app);
        const csrf = await csrfOf(app, cookie, 'warnb2');
        const res = await app.request('/me/appeal/xyzab2', { method: 'POST', cookie, body: form({ ...GOOD, csrf }), headers: { origin: ORIGIN } });
        assert.equal(res.status, 404);
        assert.equal(calls.filter((c) => c.name === 'submit').length, 0);
    } finally {
        await app.close();
    }
});

test('submit: the answers are checked (form kept, nothing sent)', async () => {
    const { appeals, calls } = fakeData();
    const app = await serve({ appeals });
    try {
        const cookie = await login(app);
        const csrf = await csrfOf(app, cookie, 'warnb2');
        const post = (values) => app.request('/me/appeal/warnb2', { method: 'POST', cookie, body: form({ csrf, ...values }), headers: { origin: ORIGIN } });
        const short = await post({ ...GOOD, reason: 'too short' });
        assert.equal(short.status, 400);
        assert.ok(short.body.includes('at least 20 characters'));
        assert.ok(short.body.includes('I posted links in #general'), 'own words kept');
        assert.equal((await post({ ...GOOD, didIt: 'maybe' })).status, 400, 'only yes / partly / no');
        assert.equal((await post({ ...GOOD, punished: '   ' })).status, 400);
        assert.equal(calls.filter((c) => c.name === 'submit').length, 0);
    } finally {
        await app.close();
    }
});

test('submit: one pending appeal per case, the cooldown after a denial, unappealable and ended cases', async () => {
    const { appeals, calls } = fakeData();
    const app = await serve({ appeals });
    try {
        const cookie = await login(app);
        const csrf = await csrfOf(app, cookie, 'warnb2');
        for (const code of ['pend22', 'deny22', 'unap22', 'endb22']) {
            const page = await app.request(`/me/appeal/${code}`, { cookie });
            assert.equal(page.status, 200);
            assert.ok(!page.body.includes('name="punished"'), `${code}: no form`);
            assert.ok(page.body.includes('This case cannot be appealed right now:'));
            const res = await app.request(`/me/appeal/${code}`, { method: 'POST', cookie, body: form({ ...GOOD, csrf }), headers: { origin: ORIGIN } });
            assert.equal(res.status, 409, code);
        }
        assert.equal(calls.filter((c) => c.name === 'submit').length, 0);
        // Denied 10 days ago (cooldown 7 days): may appeal again.
        const again = await app.request('/me/appeal/deny33', { method: 'POST', cookie, body: form({ ...GOOD, csrf }), headers: { origin: ORIGIN } });
        assert.equal(again.status, 303);
    } finally {
        await app.close();
    }
});

test('submit: a refusal of the appeal flow (a second tab won) is a 409 with the answers kept', async () => {
    const refused = createError('pending', ErrorTypes.VALIDATION, 'You already have a pending appeal for this case.', { expected: true });
    const { appeals } = fakeData({ submitError: refused });
    const app = await serve({ appeals });
    try {
        const cookie = await login(app);
        const csrf = await csrfOf(app, cookie, 'warnb2');
        const res = await app.request('/me/appeal/warnb2', { method: 'POST', cookie, body: form({ ...GOOD, csrf }), headers: { origin: ORIGIN } });
        assert.equal(res.status, 409);
        assert.ok(res.body.includes('Your appeal was not sent'));
        assert.ok(res.body.includes('I posted links in #general'));
    } finally {
        await app.close();
    }
});

test('submit: an unexpected error is a 503, never a success', async () => {
    const { appeals } = fakeData({ submitError: new Error('Discord down') });
    const app = await serve({ appeals });
    try {
        const cookie = await login(app);
        const csrf = await csrfOf(app, cookie, 'warnb2');
        const res = await app.request('/me/appeal/warnb2', { method: 'POST', cookie, body: form({ ...GOOD, csrf }), headers: { origin: ORIGIN } });
        assert.equal(res.status, 503);
        assert.ok(!res.body.includes('was sent'));
    } finally {
        await app.close();
    }
});

test('submit: a per-member limit', async () => {
    const { appeals, calls } = fakeData();
    const app = await serve({ appeals, limits: { login: { limit: 30 }, page: { limit: 60 }, appealSubmit: { limit: 1, windowMs: 3600 * 1000 } } });
    try {
        const cookie = await login(app);
        const csrf = await csrfOf(app, cookie, 'warnb2');
        const post = (code) => app.request(`/me/appeal/${code}`, { method: 'POST', cookie, body: form({ ...GOOD, csrf }), headers: { origin: ORIGIN } });
        assert.equal((await post('warnb2')).status, 303);
        const second = await post('bana22');
        assert.equal(second.status, 429);
        assert.ok(second.body.includes('too many appeals'));
        assert.equal(calls.filter((c) => c.name === 'submit').length, 1);
    } finally {
        await app.close();
    }
});

test('a database error is a 503 page, not an empty list', async () => {
    const { appeals } = fakeData({ fail: true });
    const app = await serve({ appeals });
    try {
        const cookie = await login(app);
        const res = await app.request('/me/appeals', { cookie });
        assert.equal(res.status, 503);
        assert.ok(res.body.includes('Appeals unavailable'));
    } finally {
        await app.close();
    }
});

// ── pure parts ───────────────────────────────────────────────────────────

test('buildAppealsView drops rows of other members and keeps each appeal on its own server', () => {
    const view = buildAppealsView({ userId: MEMBER, cases: CASES, appeals: APPEALS, guildName: (g) => NAMES[g], appealInfo });
    assert.deepEqual(view.appealable.map((c) => c.code).sort(), ['bana22', 'deny33', 'warnb2']);
    assert.deepEqual(view.appeals.map((a) => [a.code, a.server]), [['pend22', 'Alpha **Server**'], ['deny22', 'Beta <script>'], ['deny33', 'Beta <script>']]);
    assert.ok(!JSON.stringify(view).includes('SecretModName'));
    const otherView = buildAppealsView({ userId: OTHER, cases: CASES, appeals: APPEALS, guildName: () => null, appealInfo });
    assert.deepEqual(otherView.appealable.map((c) => c.code), ['xyzab2'], 'another member sees only their own case');
    assert.deepEqual(otherView.appeals, [], 'and none of this member\'s appeals');
    assert.equal(otherView.appealable[0].server, 'Unknown server');
});

test('parseAppealForm: the three questions, trimmed and capped', () => {
    assert.deepEqual(parseAppealForm(GOOD).answers, GOOD);
    assert.equal(parseAppealForm({ ...GOOD, reason: 'x'.repeat(5000) }).answers.reason.length, 1000);
    assert.equal(parseAppealForm({ ...GOOD, didIt: 'YES' }).field, 'didIt');
    assert.equal(parseAppealForm({ ...GOOD, punished: ['a'] }).field, 'punished', 'arrays are not text');
});

// ── DMs of other servers link to the web appeal ──────────────────────────

test('punishment DMs of another server link to the web appeal page; home DMs and unappealable cases do not', () => {
    const env = { MEMBER_PORTAL_ENABLED: 'true', PUBLIC_URL: ORIGIN };
    const saved = { MEMBER_PORTAL_ENABLED: process.env.MEMBER_PORTAL_ENABLED, PUBLIC_URL: process.env.PUBLIC_URL };
    Object.assign(process.env, env);
    try {
        assert.equal(webAppealUrl(GUILD_A, 'bana22', env), `${ORIGIN}/me/appeal/bana22`);
        assert.equal(webAppealUrl(GUILD_A, null, env), `${ORIGIN}/me/appeals`);
        assert.equal(webAppealUrl(null, 'bana22', env), null, 'no server named: unchanged');
        assert.equal(webAppealUrl(GUILD_A, 'bana22', {}), null, 'portal off');
        const ban = caseRow({ case_code: 'bana22', type: 'ban', expires_at: future(5), duration_ms: 7 * DAY });
        assert.ok(banDm(ban, { serverName: 'Alpha' }).includes(`**Appeal online:** <${ORIGIN}/me/appeal/bana22>`));
        assert.ok(kickDm({ ...ban, type: 'kick' }, null, { serverName: 'Alpha' }).includes('/me/appeal/bana22'));
        assert.ok(warnDm({ ...ban, type: 'warn' }, 1, { serverName: 'Alpha' }).includes('/me/appeal/bana22'));
        assert.ok(!banDm({ ...ban, unappealable: true }, { serverName: 'Alpha' }).includes('/me/appeal'), 'unappealable: no link');
        assert.ok(appealDeniedDm({ guildId: GUILD_A }).includes(`${ORIGIN}/me/appeals`));
        assert.ok(!appealDeniedDm({}).includes('/me/appeals'), 'no server named: unchanged');
    } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
});
