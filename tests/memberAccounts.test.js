// Mewvo accounts on the website (/me/signup …, src/services/site/accountRoutes.js) end to end
// on a bare Express app with an in-memory account store and a fake Discord. No email at all:
// sign up (username + password) → forced Discord link (bonus: 6 months of Pro, 1-letter name)
// → log in → 2FA → "Forgot password?" through a Discord login → delete, plus CSRF / origin /
// rate-limit refusals, no account enumeration, accounts on by default, and the bonus limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { MEMBER_FORGOT_COOKIE, MEMBER_SESSION_COOKIE, memberAccountsOn, memberPortalSettings, registerMemberPortal } from '../src/services/site/memberPortal.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createSite } from '../src/services/site/site.js';
import { createMemoryAccountStore } from '../src/services/accounts/memoryAccountStore.js';
import { base32Decode, totp } from '../src/services/accounts/accountCore.js';
import { PremiumError } from '../src/services/billing/premiumService.js';
import { RESET_COOKIE, bonusText, memberAccountSettings } from '../src/services/site/accountRoutes.js';
import { bonusStatusText, daysLeftText } from '../src/services/site/accountPages.js';

const ORIGIN = 'https://bot.example';
const GUILD = '100000000000000001';
const ENV = {
    MEMBER_PORTAL_ENABLED: 'true', SESSION_SECRET: 'y'.repeat(64), CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};
const LOW = { N: 1024, r: 8, p: 1 };
const DISCORD_A = '200000000000000002';
const DISCORD_B = '300000000000000003';
const DISCORD_C = '500000000000000005';
const PASSWORD = 'a long password 1';

const DATA = {
    getMemberStanding: async () => ({ ladder: { level: 0, warns_since_level: 0 }, warns: [], activeBan: null, activeMute: null }),
    listCasesForUser: async () => ({ rows: [], total: 0 }),
    listUserAppeals: async () => [],
    exportData: async (userId) => ({ format: 'mewvo-data-export-v1', userId, mewvoAccount: [] }),
};

const OPEN = { limit: 1000, windowMs: 60000 };
const ROOMY = { loginIp: OPEN, loginName: OPEN, code: OPEN, signupIp: OPEN, resetIp: OPEN };

async function serve({ env = ENV, store = createMemoryAccountStore(), accountLimits = ROOMY } = {}) {
    const app = express();
    const sessions = createMemorySessionStore({ ttlMs: 3600 * 1000 });
    const discord = { me: { id: DISCORD_A, username: 'discorda' } };
    const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/token') ? { access_token: 't' } : discord.me) });
    const after = [];
    const enabled = registerMemberPortal(app, {
        env, sessions, data: DATA, fetchImpl, accountStore: store, hashParams: LOW, accountLimits,
        accountAfter: async (result, from) => { after.push({ result, from }); },
    });
    app.use(createSite({ client: { commands: null }, env, dashboardEnabled: false, memberPortalEnabled: enabled, memberAccountsEnabled: enabled && memberAccountsOn(env), supportInvite: () => null }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base, store, sessions, discord, after,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

/** A browser: keeps cookies, sends Origin on POST, reads the csrf field of the last page. */
function browser(app) {
    const jar = new Map();
    let csrf = '';
    async function request(path, { method = 'GET', form = null, origin = ORIGIN, withCsrf = true } = {}) {
        const headers = {};
        if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
        let body;
        if (form) {
            headers['content-type'] = 'application/x-www-form-urlencoded';
            if (origin) headers.origin = origin;
            body = new URLSearchParams({ ...(withCsrf ? { csrf } : {}), ...form }).toString();
        }
        const res = await fetch(app.base + path, { method: form ? 'POST' : method, headers, body, redirect: 'manual' });
        for (const line of res.headers.getSetCookie()) {
            const [pair] = line.split(';');
            const name = pair.slice(0, pair.indexOf('='));
            const value = decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
            if (/Max-Age=0/.test(line)) jar.delete(name); else jar.set(name, value);
        }
        const text = await res.text();
        // The page's own form, not the top bar's logout form (which comes first).
        const all = [...text.matchAll(/name="csrf" value="([^"]+)"/g)];
        if (all.length) csrf = all[all.length - 1][1];
        return { status: res.status, location: res.headers.get('location'), body: text, headers: res.headers };
    }
    return { request, jar, get csrf() { return csrf; }, set csrf(v) { csrf = v; } };
}

async function signup(app, b, { username = 'cool_cat', birth = '2000-05-05', password = PASSWORD, extra = {} } = {}) {
    await b.request('/me/signup');
    return b.request('/me/signup', { form: { username, password, birth_date: birth, accept: 'yes', ...extra } });
}

/** Discord's answer for a login started by `start` (a 302 to discord.com with a state). */
const discordBack = (b, start) => {
    assert.equal(start.status, 302);
    assert.match(start.location, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
    const state = new URL(start.location).searchParams.get('state');
    return b.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`);
};

async function linkDiscord(app, b) {
    await b.request('/me/link');
    return discordBack(b, await b.request('/me/link', { form: {} }));
}

/** Signed up and linked (to app.discord.me). */
async function member(app, b, values = {}) {
    const res = await signup(app, b, values);
    assert.equal(res.status, 303);
    const linked = await linkDiscord(app, b);
    assert.equal(linked.status, 303);
    assert.equal(linked.location, '/me/linked');
    return linked;
}

async function passwordLogin(b, identifier, password = PASSWORD) {
    await b.request('/me/login-password');
    return b.request('/me/login-password', { form: { identifier, password } });
}

async function forgot(b) {
    await b.request('/me/forgot');
    return discordBack(b, await b.request('/me/forgot', { form: {} }));
}

test('top bar: Log in and Sign up on the website; on /me pages a logged-in member gets a menu instead', async () => {
    const app = await serve();
    const b = browser(app);
    try {
        const topbar = (body) => body.slice(body.indexOf('<div class="topbar-actions">'), body.indexOf('</header>'));
        for (const path of ['/', '/features', '/me', '/me/signup']) {
            const bar = topbar((await b.request(path)).body);
            assert.ok(bar.includes('<a class="button button-quiet" href="/me">Log in</a>'), `${path}: Log in`);
            assert.ok(bar.includes('<a class="button" href="/me/signup">Sign up</a>'), `${path}: Sign up`);
        }
        await member(app, b);
        for (const path of ['/me', '/me/account']) {
            const bar = topbar((await b.request(path)).body);
            assert.ok(!bar.includes('>Log in<') && !bar.includes('>Sign up<'), `${path}: no Log in / Sign up once logged in`);
            assert.ok(bar.includes('<summary class="account-chip">'), `${path}: account menu`);
            assert.ok(bar.includes('cool_cat'), `${path}: the account name`);
            assert.ok(bar.includes('href="/me/account"') && bar.includes('action="/me/logout"') && /name="csrf" value="[^"]+"/.test(bar), `${path}: settings + logout form`);
        }
        // The session cookie is scoped to /me, so the website itself still offers Log in.
        assert.ok(topbar((await b.request('/')).body).includes('>Log in</a>'));
    } finally {
        await app.close();
    }
});

test('sign up without email: username + password only, logged in at once, then the link step', async () => {
    const app = await serve();
    const b = browser(app);
    try {
        const form = await b.request('/me/signup');
        assert.equal(form.status, 200);
        assert.doesNotMatch(form.body, /type="email"|name="email"/, 'no email field');
        assert.match(form.body, /name="username"/);
        assert.match(form.body, /name="password"/);
        assert.match(form.body, /name="birth_date"/);
        assert.match(form.body, /name="accept"/);
        assert.match(form.body, /No email is needed/);
        // An email sent anyway is ignored.
        const res = await signup(app, b, { extra: { email: 'cat@example.com' } });
        assert.equal(res.status, 303);
        assert.equal(res.location, '/me/link');
        assert.ok(b.jar.has(MEMBER_SESSION_COOKIE), 'logged in right after sign-up');
        const [account] = [...app.store._accounts.values()];
        assert.equal(account.username, 'cool_cat');
        assert.equal(account.email, null);
        assert.ok(!JSON.stringify(account).includes('cat@example.com'), 'no email stored');
        assert.ok(account.age_confirmed_at instanceof Date);
        assert.ok(!JSON.stringify(account).includes('2000-05-05'), 'the date of birth is never stored');
        assert.ok(account.password_hash.startsWith('scrypt$') && !account.password_hash.includes(PASSWORD));
        const step = await b.request('/me/link');
        assert.equal(step.status, 200);
        assert.match(step.body, /Link your Discord account/);
        assert.match(step.body, /Mewvo Pro for 6 months/);
        assert.doesNotMatch(step.body, /check your (inbox|email)/i);
        // The email pages are gone.
        for (const path of ['/me/confirm', '/me/resend']) assert.equal((await browser(app).request(path)).status, 404, path);
    } finally {
        await app.close();
    }
});

test('forced Discord link: every page except the link step, callback, logout and delete redirects to /me/link', async () => {
    const app = await serve();
    const b = browser(app);
    try {
        await signup(app, b);
        for (const path of ['/me', '/me/account', '/me/data', '/me/linked', '/me/signup', '/me/login-password', '/me/forgot', '/me/reset', '/me/billing', '/me/login', '/me/nope']) {
            const res = await b.request(path);
            assert.equal(res.status, 303, path);
            assert.equal(res.location, '/me/link', path);
        }
        await b.request('/me/link');
        for (const path of ['/me/account/password', '/me/account/2fa/start', '/me/account/unlink', '/me/letter']) {
            const res = await b.request(path, { form: { password: PASSWORD, new_password: 'another long one' } });
            assert.equal(res.status, 303, path);
            assert.equal(res.location, '/me/link', path);
        }
        assert.equal(app.store._accounts.get('1').password_hash.includes('another'), false);
        // The link step itself, logout and delete still work (below), and the link goes through.
        assert.equal((await b.request('/me/link')).status, 200);
        const linked = await linkDiscord(app, b);
        assert.equal(linked.location, '/me/linked');
        assert.equal((await b.request('/me')).status, 200);
        assert.equal((await b.request('/me/account')).status, 200);
        // A Discord-only login (no Mewvo account) is never sent to the link step.
        const discordOnly = browser(app);
        app.discord.me = { id: DISCORD_B, username: 'discordb' };
        const start = await discordOnly.request('/me/login');
        await discordBack(discordOnly, start);
        const record = await discordOnly.request('/me');
        assert.equal(record.status, 200);
        assert.match(record.body, /Warning ladder/);
    } finally {
        await app.close();
    }
});

test('Link Discord and Forgot password: the page policy lets their forms go on to Discord (Chrome checks form-action on the redirect)', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        await signup(app, b);
        const step = await b.request('/me/link');
        const csp = step.headers.get('content-security-policy');
        const formAction = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('form-action'));
        assert.equal(formAction, "form-action 'self' https://discord.com", 'our forms plus Discord only, no wildcard');
        const go = await b.request('/me/link', { form: {} });
        assert.equal(go.status, 302);
        assert.ok(go.location.startsWith('https://discord.com/'), `the link form redirects to ${go.location}`);
        const other = browser(app);
        await other.request('/me/forgot');
        const reset = await other.request('/me/forgot', { form: {} });
        assert.ok(reset.location.startsWith('https://discord.com/'), `the forgot form redirects to ${reset.location}`);
        assert.equal(reset.headers.get('content-security-policy'), csp);
    } finally {
        await app.close();
    }
});

test('logging in to an account without Discord lands on the link step; logout and delete work from there', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        await signup(app, b);
        await b.request('/me/link');
        assert.equal((await b.request('/me/logout', { form: {} })).status, 303);
        const login = await passwordLogin(b, 'COOL_CAT');
        assert.equal(login.status, 303);
        assert.equal(login.location, '/me/link');
        const step = await b.request('/me/link');
        assert.match(step.body, /Delete this account/);
        assert.equal((await b.request('/me/account/delete', { form: { password: 'wrong password!', sure: 'yes' } })).status, 401);
        assert.match((await b.request('/me/link')).body, /Link your Discord account/);
        const deleted = await b.request('/me/account/delete', { form: { password: PASSWORD, sure: 'yes' } });
        assert.equal(deleted.status, 200);
        assert.match(deleted.body, /Your account was deleted/);
        assert.equal(app.store._accounts.size, 0);
        assert.equal(app.sessions.size(), 0);
    } finally {
        await app.close();
    }
});

test('the whole flow: sign up, link Discord with 6 months of Pro, 1-letter name, 2FA, reset through Discord, delete', async () => {
    const app = await serve();
    const b = browser(app);
    try {
        await signup(app, b);
        const [account] = [...app.store._accounts.values()];

        // Link Discord: first link → number 1 → Pro for 6 months (premium follow-up called) + letter offer.
        const linked = await linkDiscord(app, b);
        assert.equal(linked.status, 303);
        assert.equal(linked.location, '/me/linked');
        const result = await b.request('/me/linked');
        assert.match(result.body, /You are number 1 to link/);
        assert.match(result.body, /Mewvo Pro for 6 months/);
        assert.match(result.body, /Pick a 1-letter username/);
        assert.equal(app.after.length, 1);
        assert.equal(app.after[0].from, 'bonus');
        const record = await b.request('/me');
        assert.match(record.body, /Warning ladder/);
        assert.match(record.body, /Account settings/);
        const settings0 = await b.request('/me/account');
        assert.doesNotMatch(settings0.body, /Change email|name="email"|<dt>Email<\/dt>/, 'no email in settings');

        // Claim "q".
        const claim = await b.request('/me/letter', { form: { letter: 'Q' } });
        assert.equal(claim.status, 303);
        const settings = await b.request('/me/account');
        assert.match(settings.body, /Your username is now q/);
        const twice = await b.request('/me/letter', { form: { letter: 'z' } });
        assert.equal(twice.status, 409, 'only once');

        // Log out, log in with the new name.
        await b.request('/me/logout', { form: {} });
        assert.match((await b.request('/me')).body, /Log in with a Mewvo account/);
        const login = await passwordLogin(b, 'Q');
        assert.equal(login.status, 303);
        assert.equal(login.location, '/me');
        assert.match((await b.request('/me')).body, /Warning ladder/);

        // 2FA on: the key on the page works, then 8 recovery codes are shown once.
        await b.request('/me/account');
        const setup = await b.request('/me/account/2fa/start', { form: {} });
        assert.equal(setup.status, 200);
        const key = /<code class="key-code">([A-Z2-7 ]+)<\/code>/.exec(setup.body)[1];
        assert.match(setup.body, /otpauth:\/\/totp\/Mewvo%3Aq\?secret=/);
        const pending = /name="pending" value="([^"]+)"/.exec(setup.body)[1];
        const secret = base32Decode(key);
        const wrongCode = await b.request('/me/account/2fa/enable', { form: { pending, code: '000000' === totp(secret) ? '111111' : '000000' } });
        assert.equal(wrongCode.status, 400);
        const on = await b.request('/me/account/2fa/enable', { form: { pending, code: totp(secret) } });
        assert.equal(on.status, 200);
        const codes = [...on.body.matchAll(/<li><code>([a-z0-9-]+)<\/code><\/li>/g)].map((m) => m[1]);
        assert.equal(codes.length, 8);
        assert.ok(app.store._accounts.get(account.id).totp_secret_enc.startsWith('v1.'));
        assert.ok(!app.store._accounts.get(account.id).totp_secret_enc.includes(key.replace(/ /g, '')), 'stored encrypted');

        // Log in again: password, then the code step. The code used to turn 2FA on cannot be reused.
        await b.request('/me/logout', { form: {} });
        const step1 = await passwordLogin(b, 'q');
        assert.equal(step1.status, 303);
        assert.equal(step1.location, '/me/login-2fa');
        await b.request('/me/login-2fa');
        assert.equal((await b.request('/me/login-2fa', { form: { code: totp(secret) } })).status, 401, 'replayed step refused');
        assert.equal((await b.request('/me/login-2fa', { form: { code: codes[0] } })).status, 303, 'a recovery code works');
        await b.request('/me/logout', { form: {} });
        await passwordLogin(b, 'q');
        await b.request('/me/login-2fa');
        assert.equal((await b.request('/me/login-2fa', { form: { code: codes[0] } })).status, 401, 'a recovery code works once');
        assert.equal((await b.request('/me/login-2fa', { form: { code: totp(secret, Date.now() + 30000) } })).status, 303, 'a newer app code works');

        // Forgot password with 2FA on: Discord login → the reset form asks for the code before anything changes.
        const other = browser(app);
        const back = await forgot(other);
        assert.equal(back.status, 303);
        assert.equal(back.location, '/me/reset');
        const form = (await other.request('/me/reset')).body;
        assert.match(form, /For the Mewvo account <strong>q<\/strong>/);
        assert.match(form, /name="code"/, 'the reset form asks for the 2FA code');
        const noCode = await other.request('/me/reset', { form: { password: 'a brand new password' } });
        assert.equal(noCode.status, 400, 'no code, no reset');
        assert.equal((await other.request('/me/reset', { form: { password: 'a brand new password', code: '000000' } })).status, 400, 'wrong code, no reset');
        assert.match((await b.request('/me')).body, /Warning ladder/, 'a refused reset ends no session');
        assert.equal((await b.request('/me/logout', { form: {} })).status, 303);
        assert.equal((await passwordLogin(b, 'q')).status, 303, 'a refused reset keeps the old password');
        await b.request('/me/login-2fa');
        await b.request('/me/login-2fa', { form: { code: totp(secret, Date.now() + 60000) } });
        const reset = await other.request('/me/reset', { form: { password: 'a brand new password', code: codes[1] } });
        assert.equal(reset.status, 303);
        assert.equal(reset.location, '/me/account', 'code checked on the form, so no second code step');
        assert.match((await b.request('/me')).body, /Log in with Discord/, 'the old session ended');
        assert.match((await other.request('/me')).body, /Warning ladder/);
        assert.equal((await passwordLogin(b, 'q')).status, 401, 'the old password no longer works');

        // Delete: password + code needed; the bonus row stays with the Discord id.
        await passwordLogin(b, 'q', 'a brand new password');
        await b.request('/me/login-2fa');
        await b.request('/me/login-2fa', { form: { code: codes[2] } });
        await b.request('/me/account');
        assert.equal((await b.request('/me/account/delete', { form: { password: 'wrong password!', code: codes[3], sure: 'yes' } })).status, 401);
        const deleted = await b.request('/me/account/delete', { form: { password: 'a brand new password', code: codes[4], sure: 'yes' } });
        assert.equal(deleted.status, 200);
        assert.match(deleted.body, /Your account was deleted/);
        assert.equal(app.store._accounts.size, 0);
        assert.equal(app.store._bonuses.get(DISCORD_A).account_id, null);
        assert.equal(app.sessions.size(), 0);

        // A new account with the same Discord id gets no second bonus.
        const b2 = browser(app);
        await member(app, b2, { username: 'second' });
        assert.match((await b2.request('/me/linked')).body, /does not get the early-account bonus again/);
        assert.equal(app.after.length, 1, 'no second Pro bonus');
        assert.equal(app.store._bonuses.get(DISCORD_A).account_id, (await app.store.findByLogin('second')).id, 'the bonus row points at the current account again');
    } finally {
        await app.close();
    }
});

test('forgot password through Discord: new password, everyone else logged out, single use, only the linked account', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        await member(app, b);
        const page = await browser(app).request('/me/forgot');
        assert.equal(page.status, 200);
        assert.match(page.body, /Log in with Discord/);
        assert.doesNotMatch(page.body, /type="email"|name="email"/);

        const other = browser(app);
        const back = await forgot(other);
        assert.equal(back.location, '/me/reset');
        assert.ok(other.jar.has(RESET_COOKIE));
        assert.ok(!other.jar.has(MEMBER_FORGOT_COOKIE), 'the forgot cookie is cleared by the callback');
        assert.ok(!other.jar.has(MEMBER_SESSION_COOKIE), 'the Discord login alone does not log in');
        await other.request('/me/reset');
        const grantCookie = other.jar.get(RESET_COOKIE);
        assert.equal((await other.request('/me/reset', { form: { password: 'short' } })).status, 400);
        const done = await other.request('/me/reset', { form: { password: 'a brand new password' } });
        assert.equal(done.status, 303);
        assert.equal(done.location, '/me/account');
        assert.match((await other.request('/me/account')).body, /Your new password is saved/);
        assert.match((await b.request('/me')).body, /Log in with Discord/, 'the other session ended');
        assert.equal((await passwordLogin(browser(app), 'cool_cat')).status, 401, 'old password gone');
        assert.equal((await passwordLogin(browser(app), 'cool_cat', 'a brand new password')).status, 303);
        // Single use: the same reset cookie again does nothing.
        assert.ok(!other.jar.has(RESET_COOKIE), 'cleared after use');
        other.jar.set(RESET_COOKIE, grantCookie);
        assert.match((await other.request('/me/reset')).body, /Start again/);
        assert.notEqual((await other.request('/me/reset', { form: { password: 'third new password' } })).status, 303);
        assert.equal((await passwordLogin(browser(app), 'cool_cat', 'third new password')).status, 401, 'not changed again');

        // A Discord account without a Mewvo account: told so, nothing changes.
        app.discord.me = { id: DISCORD_C, username: 'nobody' };
        const stranger = browser(app);
        const none = await forgot(stranger);
        assert.equal(none.status, 404);
        assert.match(none.body, /No Mewvo account is linked to this Discord account/);
        assert.ok(!stranger.jar.has(RESET_COOKIE));
        assert.match((await stranger.request('/me/reset')).body, /Start again/);

        // A plain Discord login (no forgot cookie) is a normal login, never a reset.
        app.discord.me = { id: DISCORD_A, username: 'discorda' };
        const plain = browser(app);
        const login = await discordBack(plain, await plain.request('/me/login'));
        assert.equal(login.status, 303);
        assert.equal(login.location, '/me');
        assert.ok(!plain.jar.has(RESET_COOKIE));

        // The reset form refuses when the account was unlinked after the Discord login.
        const late = browser(app);
        await forgot(late);
        await late.request('/me/reset');
        await app.store.unlinkDiscord('1');
        const refused = await late.request('/me/reset', { form: { password: 'yet another password' } });
        assert.equal(refused.status, 400);
        assert.match(refused.body, /Start again/);
    } finally {
        await app.close();
    }
});

test('forgot password refusals: CSRF, another origin, the IP limit', async () => {
    const app = await serve({ accountLimits: { ...ROOMY, resetIp: { limit: 2, windowMs: 60000 } } });
    try {
        const b = browser(app);
        await b.request('/me/forgot');
        assert.equal((await b.request('/me/forgot', { form: {}, withCsrf: false })).status, 403);
        assert.equal((await b.request('/me/forgot', { form: {}, origin: 'https://evil.example' })).status, 403);
        assert.equal((await b.request('/me/forgot', { form: {} })).status, 302);
        assert.equal((await b.request('/me/forgot', { form: {} })).status, 302);
        assert.equal((await b.request('/me/forgot', { form: {} })).status, 429);
        // The reset form needs the form cookie + same origin too.
        const c = browser(app);
        assert.equal((await c.request('/me/reset', { form: { password: 'a brand new password' }, withCsrf: false })).status, 403);
    } finally {
        await app.close();
    }
});

test('no enumeration: login answers the same for unknown accounts and wrong passwords', async () => {
    const app = await serve();
    try {
        await signup(app, browser(app));
        const b = browser(app);
        const unknown = await passwordLogin(b, 'nobody_here');
        const wrong = await passwordLogin(b, 'cool_cat', 'not the password');
        assert.equal(unknown.status, 401);
        assert.equal(wrong.status, 401);
        const errorOf = (body) => /<p class="error" role="alert">([^<]+)</.exec(body)[1];
        assert.equal(errorOf(unknown.body), 'Wrong username or password.');
        assert.equal(errorOf(wrong.body), errorOf(unknown.body));
    } finally {
        await app.close();
    }
});

test('sign-up checks: under 14, bad username, reserved name, taken username, terms not accepted', async () => {
    const app = await serve();
    try {
        const b = () => browser(app);
        const today = new Date();
        const young = `${today.getUTCFullYear() - 13}-12-31`; // 12 or 13: under MIN_AGE (14)
        assert.match((await signup(app, b(), { birth: young })).body, /at least 14/);
        assert.match((await signup(app, b(), { username: 'a' })).body, /2 to 30 characters/);
        assert.match((await signup(app, b(), { username: 'x'.repeat(31) })).body, /2 to 30 characters/);
        assert.match((await signup(app, b(), { username: 'bad name' })).body, /letters \(a-z\), numbers and underscores/);
        assert.match((await signup(app, b(), { username: 'Support' })).body, /reserved/);
        assert.match((await signup(app, b(), { password: 'short' })).body, /at least 10 characters/);
        const c = b();
        await c.request('/me/signup');
        const noTerms = await c.request('/me/signup', { form: { username: 'okname', password: PASSWORD, birth_date: '2000-01-01' } });
        assert.equal(noTerms.status, 400);
        assert.equal(app.store._accounts.size, 0);
        assert.equal((await signup(app, b(), { username: 'taken_one' })).status, 303);
        const taken = await signup(app, b(), { username: 'TAKEN_ONE' });
        assert.equal(taken.status, 409);
        assert.match(taken.body, /already taken/);
    } finally {
        await app.close();
    }
});

test('refusals: missing CSRF, another origin, and too many logins', async () => {
    const app = await serve({ accountLimits: { ...ROOMY, loginIp: { limit: 3, windowMs: 60000 }, loginName: { limit: 3, windowMs: 60000 } } });
    try {
        const b = browser(app);
        await b.request('/me/signup');
        const form = { username: 'x_y', password: PASSWORD, birth_date: '2000-01-01', accept: 'yes' };
        assert.equal((await b.request('/me/signup', { form, withCsrf: false })).status, 403);
        assert.equal((await b.request('/me/signup', { form, origin: 'https://evil.example' })).status, 403);
        const stranger = browser(app);
        stranger.csrf = b.csrf; // the token without its cookie
        assert.equal((await stranger.request('/me/login-password', { form: { identifier: 'a', password: 'b' } })).status, 403);
        assert.equal(app.store._accounts.size, 0);

        // The link step and the settings forms need the session's token.
        const c = browser(app);
        await signup(app, c);
        await c.request('/me/link');
        const good = c.csrf;
        c.csrf = 'wrong';
        assert.equal((await c.request('/me/link', { form: {} })).status, 403);
        c.csrf = good;
        await linkDiscord(app, c);
        await c.request('/me/account');
        const good2 = c.csrf;
        c.csrf = 'wrong';
        assert.equal((await c.request('/me/account/unlink', { form: {} })).status, 403);
        c.csrf = good2;
        assert.equal((await c.request('/me/account/password', { form: { password: PASSWORD, new_password: 'x' }, origin: 'https://evil.example' })).status, 403);

        const d = browser(app);
        for (let i = 0; i < 3; i += 1) assert.equal((await passwordLogin(d, 'cool_cat', 'wrong password')).status, 401);
        const limited = await passwordLogin(d, 'cool_cat', PASSWORD);
        assert.equal(limited.status, 429, 'even the right password waits');
    } finally {
        await app.close();
    }
});

test('Discord link rules: one account per Discord id; unlink sends back to the link step, relink gets no new bonus; 101st gets nothing', async () => {
    const store = createMemoryAccountStore();
    const app = await serve({ store });
    try {
        const a = browser(app);
        await member(app, a);
        // The same Discord id on a second account is refused.
        const b = browser(app);
        await signup(app, b, { username: 'other_cat' });
        const refused = await linkDiscord(app, b);
        assert.equal(refused.status, 409);
        assert.match(refused.body, /already linked to another Mewvo account/);
        assert.equal((await b.request('/me')).location, '/me/link', 'still on the link step');

        // Unlink: back to the link step; link again: no second bonus.
        await a.request('/me/account');
        const unlinked = await a.request('/me/account/unlink', { form: {} });
        assert.equal(unlinked.status, 303);
        assert.equal(unlinked.location, '/me/link');
        assert.match((await a.request('/me/link')).body, /Your Discord account was unlinked/);
        assert.equal((await a.request('/me')).location, '/me/link');
        await linkDiscord(app, a);
        assert.match((await a.request('/me/linked')).body, /does not get the early-account bonus again/);

        // Number 101: nothing (no Pro, no letter).
        store.setCounter(100);
        app.discord.me = { id: DISCORD_B, username: 'discordb' };
        await linkDiscord(app, b);
        const page = await b.request('/me/linked');
        assert.match(page.body, /You are number 101/);
        assert.match(page.body, /no bonus for this one/);
        assert.doesNotMatch(page.body, /Pick a 1-letter username/);
        assert.equal(app.after.length, 1);
        assert.equal(store._bonuses.get(DISCORD_B).link_number, 101);
    } finally {
        await app.close();
    }
});

test('download my data: the account fields without any email field, never the password hash or 2FA secret', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        await member(app, b);
        const res = await b.request('/me/data');
        assert.equal(res.status, 200);
        const file = JSON.parse(res.body);
        assert.equal(file.mewvoAccount[0].username, 'cool_cat');
        assert.equal(file.mewvoAccount[0].discord_user_id, DISCORD_A);
        assert.ok(!('email' in file.mewvoAccount[0]) && !('pending_email' in file.mewvoAccount[0]) && !('email_confirmed_at' in file.mewvoAccount[0]));
        assert.ok(!res.body.includes('scrypt$') && !res.body.includes('password_hash') && !res.body.includes('totp_secret'));
        // An older account (before schema v8) still sees the email it gave then.
        app.store._accounts.get('1').email = 'old@example.com';
        const old = JSON.parse((await b.request('/me/data')).body);
        assert.equal(old.mewvoAccount[0].email, 'old@example.com');
    } finally {
        await app.close();
    }
});

test('accounts are on by default with the member portal; MEMBER_ACCOUNTS_ENABLED=false turns them off; no email settings needed', async () => {
    assert.equal(ENV.MEMBER_ACCOUNTS_ENABLED, undefined);
    assert.equal(ENV.RESEND_API_KEY, undefined);
    assert.equal(memberAccountsOn(ENV), true);
    for (const off of ['false', 'FALSE', '0', 'no', 'off']) assert.equal(memberAccountsOn({ ...ENV, MEMBER_ACCOUNTS_ENABLED: off }), false, off);
    for (const on of ['', 'true', '1']) assert.equal(memberAccountsOn({ ...ENV, MEMBER_ACCOUNTS_ENABLED: on }), true, on);
    assert.equal(memberAccountsOn({ ...ENV, MEMBER_PORTAL_ENABLED: 'false' }), false, 'never without the portal');
    const settings = memberAccountSettings(ENV, memberPortalSettings(ENV));
    assert.deepEqual(settings.problems, []);

    const app = await serve();
    try {
        const b = browser(app);
        assert.equal((await b.request('/me/signup')).status, 200);
        assert.equal((await b.request('/me/login-password')).status, 200);
        assert.match((await b.request('/me')).body, /Log in with a Mewvo account/);
        assert.match((await b.request('/')).body, /href="\/me\/signup">Sign up</);
    } finally {
        await app.close();
    }
    const offApp = await serve({ env: { ...ENV, MEMBER_ACCOUNTS_ENABLED: 'false' } });
    try {
        const b = browser(offApp);
        assert.equal((await b.request('/me/signup')).status, 404);
        assert.equal((await b.request('/me/login-password')).status, 404);
        assert.equal((await b.request('/me/forgot')).status, 404);
        assert.doesNotMatch((await b.request('/me')).body, /Mewvo account/);
        assert.doesNotMatch((await b.request('/')).body, /href="\/me\/signup"/);
    } finally {
        await offApp.close();
    }
});

test('bonus counting in the store: 30 letters, 100 Pro bonuses of 6 months, a higher plan is reported, concurrent links for slot 100', async () => {
    const granted = [];
    const store = createMemoryAccountStore({
        grantPro: async (userId) => {
            if (userId === '900000000000000099') throw new PremiumError('You already have Max.', 409);
            granted.push(userId);
            return { subscription: { user_id: userId } };
        },
    });
    const make = async (i) => (await store.createAccount({ username: `user_${i}`, passwordHash: 'h' })).account;
    const results = [];
    for (let i = 1; i <= 98; i += 1) {
        const account = await make(i);
        results.push((await store.linkDiscord({ accountId: account.id, discordUserId: `9000000000000${String(i).padStart(5, '0')}` })).bonus);
    }
    assert.equal(results.filter((r) => r.letter).length, 30);
    assert.equal(results[29].letter, true);
    assert.equal(results[30].letter, false);
    assert.equal(results[97].linkNumber, 98);
    assert.match(bonusText(results[0]), /Mewvo Pro for 6 months, and you can pick a 1-letter username/);
    assert.match(bonusText(results[40]), /Mewvo Pro for 6 months\.$/);
    // #99 already has a higher plan: the slot is used, the reason is shown, nothing granted.
    const a99 = await make(99);
    const r99 = (await store.linkDiscord({ accountId: a99.id, discordUserId: '900000000000000099' })).bonus;
    assert.equal(r99.pro, false);
    assert.match(bonusText(r99), /6 months of Pro were due, but they could not be added: You already have Max/);
    // Two links at the same moment for slot 100: exactly one gets it.
    const [x, y] = [await make(100), await make(101)];
    const both = await Promise.all([
        store.linkDiscord({ accountId: x.id, discordUserId: '910000000000000001' }),
        store.linkDiscord({ accountId: y.id, discordUserId: '910000000000000002' }),
    ]);
    assert.deepEqual(both.map((r) => r.bonus.linkNumber).sort(), [100, 101]);
    assert.equal(both.filter((r) => r.bonus.pro).length, 1);
    assert.equal(granted.length, 98 + 1);
    // The letter claim: eligible once, unique letters.
    const first = await store.findById('1');
    const bonus = await store.bonusOf(first.discord_user_id);
    assert.equal(store.canClaimLetter(bonus, first), true);
    await store.claimLetter({ accountId: '1', letter: 'a' });
    await assert.rejects(store.claimLetter({ accountId: '2', letter: 'a' }), /just took that letter/);
    await assert.rejects(store.claimLetter({ accountId: '31', letter: 'b' }), /cannot claim/);
    assert.ok(!(await store.freeLetters()).includes('a'));
    assert.equal((await store.findByDiscordId('900000000000000001')).username, 'a');
    assert.equal(await store.findByDiscordId('123'), null);
});

test('prune: accounts that never linked Discord are deleted after 7 days; linked, unlinked-later and email-confirmed ones stay', async () => {
    let now = Date.now();
    const store = createMemoryAccountStore({ now: () => now });
    const { account: never } = await store.createAccount({ username: 'never_linked', passwordHash: 'h' });
    const { account: linked } = await store.createAccount({ username: 'linked_one', passwordHash: 'h' });
    const { account: unlinked } = await store.createAccount({ username: 'unlinked_one', passwordHash: 'h' });
    const { account: legacy } = await store.createAccount({ username: 'legacy_one', passwordHash: 'h' });
    const { account: fresh } = await store.createAccount({ username: 'fresh_one', passwordHash: 'h' });
    await store.linkDiscord({ accountId: linked.id, discordUserId: DISCORD_A });
    await store.linkDiscord({ accountId: unlinked.id, discordUserId: DISCORD_B });
    await store.unlinkDiscord(unlinked.id);
    store._accounts.get(legacy.id).email_confirmed_at = new Date(now);
    now += 7 * 24 * 3600 * 1000 + 1;
    store._accounts.get(fresh.id).created_at = new Date(now);
    assert.deepEqual(await store.prune(), { accounts: 1, tokens: 0 });
    assert.equal(await store.findById(never.id), null);
    for (const kept of [linked, unlinked, legacy, fresh]) assert.ok(await store.findById(kept.id), kept.username);
});

test('Account settings: Your plan shows the bonus Pro with its end date and days left, then Free when it is gone', async () => {
    const app = await serve();
    const b = browser(app);
    try {
        await member(app, b);
        const plan = (body) => body.slice(body.indexOf('<h2>Your plan</h2>'), body.indexOf('<h2>Change password</h2>'));
        const withPro = plan((await b.request('/me/account')).body);
        assert.match(withPro, /<dt>Plan<\/dt><dd><strong>Pro<\/strong>/);
        assert.match(withPro, /<dt>Active until<\/dt><dd><time datetime="[^"]+">[^<]+<\/time> <small class="note">\(18[23] days left\)<\/small>/);
        assert.match(withPro, /<dt>Last added by<\/dt><dd>Early-account bonus/);
        assert.match(withPro, /<dt>Early-account bonus<\/dt><dd>Link #1: 6 months of Pro, added <time/);
        assert.match(withPro, /href="\/pricing">See plans/, 'no test checkout: link to the plans page');

        // A later purchase: the source changes, the bonus line stays.
        app.store.setPlan(DISCORD_A, { plan_id: 'max', source: 'purchase', expires_at: new Date(Date.now() + 10.5 * 24 * 3600 * 1000) });
        const bought = plan((await b.request('/me/account')).body);
        assert.match(bought, /<strong>Max<\/strong>/);
        assert.match(bought, /\(10 days left\)/);
        assert.match(bought, /Last added by<\/dt><dd>A purchase/);
        assert.match(bought, /Link #1: 6 months of Pro/);

        // Ended: Free, no end date.
        app.store.setPlan(DISCORD_A, { plan_id: 'pro', source: 'bonus', expires_at: new Date(Date.now() - 1000) });
        const ended = plan((await b.request('/me/account')).body);
        assert.match(ended, /<dt>Plan<\/dt><dd>Free<\/dd>/);
        assert.doesNotMatch(ended, /Active until|Last added by/);
        assert.match(ended, /Link #1: 6 months of Pro/);
    } finally {
        await app.close();
    }
});

test('Account settings: Your plan without a Pro bonus (slot 101, or a higher plan already running)', async () => {
    const store = createMemoryAccountStore({
        grantPro: async () => { throw new PremiumError('You already have Max until 2027-01-01, which is more than Pro.', 409); },
    });
    const app = await serve({ store });
    const b = browser(app);
    try {
        await member(app, b);
        const body = (await b.request('/me/account')).body;
        assert.match(body, /<dt>Plan<\/dt><dd>Free<\/dd>/);
        assert.match(body, /Link #1: 6 months of Pro were due but not added\. You already have Max until 2027-01-01/);
    } finally {
        await app.close();
    }
    assert.equal(bonusStatusText(null), null);
    assert.equal(bonusStatusText({ link_number: 101 }), 'Link #101: no Pro bonus (it went to the first 100 links).');
    const now = Date.UTC(2026, 10, 2, 12);
    const day = 24 * 3600 * 1000;
    assert.equal(daysLeftText(new Date(now + 183 * day), now), '183 days left');
    assert.equal(daysLeftText(new Date(now + 1.9 * day), now), '1 day left');
    assert.equal(daysLeftText(new Date(now + 3600 * 1000), now), 'Ends today');
});
