// Mewvo accounts on the website (/me/signup …, src/services/site/accountRoutes.js) end to end
// on a bare Express app with an in-memory account store, a fake email sender and a fake
// Discord: sign up → email → confirm → link Discord (bonus) → log in → 2FA → reset → delete,
// plus CSRF / origin / rate-limit refusals, no account enumeration, and the bonus limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { MEMBER_SESSION_COOKIE, registerMemberPortal } from '../src/services/site/memberPortal.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createSite } from '../src/services/site/site.js';
import { createMemoryAccountStore } from '../src/services/accounts/memoryAccountStore.js';
import { createFakeEmailSender } from '../src/services/accounts/emailSender.js';
import { base32Decode, totp } from '../src/services/accounts/accountCore.js';
import { PremiumError } from '../src/services/billing/premiumService.js';
import { bonusText } from '../src/services/site/accountRoutes.js';

const ORIGIN = 'https://bot.example';
const GUILD = '100000000000000001';
const ENV = {
    MEMBER_PORTAL_ENABLED: 'true', MEMBER_ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'y'.repeat(64), CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};
const LOW = { N: 1024, r: 8, p: 1 };
const DISCORD_A = '200000000000000002';
const DISCORD_B = '300000000000000003';
const PASSWORD = 'a long password 1';

const DATA = {
    getMemberStanding: async () => ({ ladder: { level: 0, warns_since_level: 0 }, warns: [], activeBan: null, activeMute: null }),
    listCasesForUser: async () => ({ rows: [], total: 0 }),
    listUserAppeals: async () => [],
    exportData: async (userId) => ({ format: 'mewvo-data-export-v1', userId, mewvoAccount: [] }),
};

const OPEN = { limit: 1000, windowMs: 60000 };
const ROOMY = { loginIp: OPEN, loginName: OPEN, code: OPEN, signupIp: OPEN, emailIp: OPEN, emailAddress: OPEN };

async function serve({ env = ENV, store = createMemoryAccountStore(), accountLimits = ROOMY } = {}) {
    const app = express();
    const sessions = createMemorySessionStore({ ttlMs: 3600 * 1000 });
    const mailer = createFakeEmailSender();
    const discord = { me: { id: DISCORD_A, username: 'discorda' } };
    const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/token') ? { access_token: 't' } : discord.me) });
    const after = [];
    const enabled = registerMemberPortal(app, {
        env, sessions, data: DATA, fetchImpl, accountStore: store, mailer, hashParams: LOW, accountLimits,
        accountAfter: async (result, from) => { after.push({ result, from }); },
    });
    app.use(createSite({ client: { commands: null }, env, dashboardEnabled: false, memberPortalEnabled: enabled, supportInvite: () => null }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base, store, sessions, mailer, discord, after,
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
        const match = /name="csrf" value="([^"]+)"/.exec(text);
        if (match) csrf = match[1];
        return { status: res.status, location: res.headers.get('location'), body: text, headers: res.headers };
    }
    return { request, jar, get csrf() { return csrf; }, set csrf(v) { csrf = v; } };
}

const linkFrom = (mail, path) => {
    const match = new RegExp(`${ORIGIN.replace(/\./g, '\\.')}(${path}\\?token=[A-Za-z0-9_-]+)`).exec(mail.text);
    assert.ok(match, `link ${path} in the email`);
    return match[1];
};

async function signup(app, b, { username = 'cool_cat', email = 'cat@example.com', birth = '2000-05-05', password = PASSWORD } = {}) {
    await b.request('/me/signup');
    return b.request('/me/signup', { form: { username, email, password, birth_date: birth, accept: 'yes' } });
}

async function confirmed(app, b, values = {}) {
    const res = await signup(app, b, values);
    assert.equal(res.status, 200);
    const path = linkFrom(app.mailer.last(), '/me/confirm');
    await b.request(path);
    const done = await b.request('/me/confirm', { form: { token: new URL(ORIGIN + path).searchParams.get('token') } });
    assert.equal(done.status, 303);
    return done;
}

async function linkDiscord(app, b) {
    await b.request('/me');
    const start = await b.request('/me/link', { form: {} });
    assert.equal(start.status, 302);
    const state = new URL(start.location).searchParams.get('state');
    return b.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`);
}

async function passwordLogin(b, identifier, password = PASSWORD) {
    await b.request('/me/login-password');
    return b.request('/me/login-password', { form: { identifier, password } });
}

test('the whole flow: sign up, confirm, link Discord with the bonus, 1-letter name, 2FA, reset, delete', async () => {
    const app = await serve();
    const b = browser(app);
    try {
        // Sign up: "check your email", one email with a confirmation link; the birth date is not kept.
        const res = await signup(app, b);
        assert.equal(res.status, 200);
        assert.match(res.body, /Check your email/);
        assert.equal(app.mailer.sent.length, 1);
        assert.equal(app.mailer.sent[0].to, 'cat@example.com');
        assert.match(app.mailer.sent[0].subject, /Confirm/);
        const [account] = [...app.store._accounts.values()];
        assert.equal(account.username, 'cool_cat');
        assert.ok(account.age_confirmed_at instanceof Date);
        assert.ok(!JSON.stringify(account).includes('2000-05-05'), 'the date of birth is never stored');
        assert.ok(account.password_hash.startsWith('scrypt$') && !account.password_hash.includes(PASSWORD));
        assert.ok(![...app.store._tokens.values()].some((t) => app.mailer.sent[0].text.includes(t.token_hash)), 'only the hash is stored');

        // Not confirmed yet: the right password still cannot log in.
        const early = await passwordLogin(b, 'cool_cat');
        assert.equal(early.status, 403);
        assert.match(early.body, /not confirmed yet/);

        // Confirm: GET shows a button (link scanners do not use it up), POST confirms and logs in.
        const path = linkFrom(app.mailer.sent[0], '/me/confirm');
        const token = new URL(ORIGIN + path).searchParams.get('token');
        const show = await b.request(path);
        assert.equal(show.status, 200);
        assert.match(show.body, /Confirm my email/);
        const done = await b.request('/me/confirm', { form: { token } });
        assert.equal(done.status, 303);
        assert.equal(done.location, '/me');
        assert.ok(b.jar.has(MEMBER_SESSION_COOKIE));
        const again = await b.request('/me/confirm', { form: { token } });
        assert.equal(again.status, 400, 'single use');

        // Without Discord: /me only offers "Link your Discord".
        const me = await b.request('/me');
        assert.match(me.body, /Link your Discord account/);
        assert.doesNotMatch(me.body, /Warning ladder/);

        // Link Discord: first link → number 1 → Pro month (premium follow-up called) + letter offer.
        const linked = await linkDiscord(app, b);
        assert.equal(linked.status, 303);
        assert.equal(linked.location, '/me/linked');
        const result = await b.request('/me/linked');
        assert.match(result.body, /You are number 1 to link/);
        assert.match(result.body, /Mewvo Pro for 30 days/);
        assert.match(result.body, /Pick a 1-letter username/);
        assert.equal(app.after.length, 1);
        assert.equal(app.after[0].from, 'bonus');
        const record = await b.request('/me');
        assert.match(record.body, /Warning ladder/);
        assert.match(record.body, /Account settings/);

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
        const step1 = await passwordLogin(b, 'cat@example.com');
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

        // Forgot password: generic answer, a reset link; resetting ends every session.
        const other = browser(app);
        await other.request('/me/forgot');
        const forgot = await other.request('/me/forgot', { form: { email: 'CAT@example.com' } });
        assert.match(forgot.body, /If that email has an account/);
        await waitFor(() => app.mailer.last()?.subject.includes('Reset'));
        const resetPath = linkFrom(app.mailer.last(), '/me/reset');
        const resetToken = new URL(ORIGIN + resetPath).searchParams.get('token');
        assert.equal((await other.request(resetPath)).status, 200);
        assert.equal((await other.request('/me/reset', { form: { token: resetToken, password: 'short' } })).status, 400);
        const reset = await other.request('/me/reset', { form: { token: resetToken, password: 'a brand new password' } });
        assert.equal(reset.status, 200);
        assert.match((await b.request('/me')).body, /Log in with Discord/, 'the old session ended');
        assert.equal((await other.request('/me/reset', { form: { token: resetToken, password: 'another new password' } })).status, 400, 'single use');
        assert.equal((await passwordLogin(b, 'q')).status, 401, 'the old password no longer works');

        // Delete: password + code needed; the bonus row stays with the Discord id.
        await passwordLogin(b, 'q', 'a brand new password');
        await b.request('/me/login-2fa');
        await b.request('/me/login-2fa', { form: { code: codes[1] } });
        await b.request('/me/account');
        assert.equal((await b.request('/me/account/delete', { form: { password: 'wrong password!', code: codes[2], sure: 'yes' } })).status, 401);
        const deleted = await b.request('/me/account/delete', { form: { password: 'a brand new password', code: codes[3], sure: 'yes' } });
        assert.equal(deleted.status, 200);
        assert.match(deleted.body, /Your account was deleted/);
        assert.equal(app.store._accounts.size, 0);
        assert.equal(app.store._bonuses.get(DISCORD_A).account_id, null);
        assert.equal(app.sessions.size(), 0);

        // A new account with the same Discord id gets no second bonus.
        const b2 = browser(app);
        await confirmed(app, b2, { username: 'second', email: 'second@example.com' });
        await linkDiscord(app, b2);
        assert.match((await b2.request('/me/linked')).body, /does not get the early-account bonus again/);
        assert.equal(app.after.length, 1, 'no second Pro month');
    } finally {
        await app.close();
    }
});

async function waitFor(check, tries = 50) {
    for (let i = 0; i < tries; i += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('timed out');
}

test('no enumeration: login, forgot and sign-up answer the same for known and unknown accounts', async () => {
    const app = await serve();
    try {
        await confirmed(app, browser(app));
        const b = browser(app);
        const unknown = await passwordLogin(b, 'nobody_here');
        const wrong = await passwordLogin(b, 'cool_cat', 'not the password');
        assert.equal(unknown.status, 401);
        assert.equal(wrong.status, 401);
        const errorOf = (body) => /<p class="error" role="alert">([^<]+)</.exec(body)[1];
        assert.equal(errorOf(unknown.body), 'Wrong username/email or password.');
        assert.equal(errorOf(wrong.body), errorOf(unknown.body));

        await b.request('/me/forgot');
        const known = await b.request('/me/forgot', { form: { email: 'cat@example.com' } });
        const notKnown = await b.request('/me/forgot', { form: { email: 'ghost@example.com' } });
        assert.equal(known.status, notKnown.status);
        assert.equal(known.body, notKnown.body);

        // Sign-up with a taken email: the same "check your email" page, a notice to the owner, no new account.
        const before = app.mailer.sent.length;
        const dupe = await signup(app, browser(app), { username: 'someone_new', email: 'cat@example.com' });
        assert.equal(dupe.status, 200);
        assert.match(dupe.body, /Check your email/);
        assert.equal(app.store._accounts.size, 1);
        await waitFor(() => app.mailer.sent.length > before);
        assert.match(app.mailer.last().subject, /tried to sign up/);
        assert.doesNotMatch(app.mailer.last().text, /token=/);

        // Resend: generic too.
        await b.request('/me/resend');
        const r1 = await b.request('/me/resend', { form: { email: 'cat@example.com' } });
        const r2 = await b.request('/me/resend', { form: { email: 'ghost@example.com' } });
        assert.equal(r1.body, r2.body);
    } finally {
        await app.close();
    }
});

test('sign-up checks: under 13, bad username, reserved name, taken username, terms not accepted', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        const today = new Date();
        const young = `${today.getUTCFullYear() - 12}-01-01`;
        assert.match((await signup(app, b, { birth: young })).body, /at least 13/);
        assert.match((await signup(app, b, { username: 'a' })).body, /2 to 30 characters/);
        assert.match((await signup(app, b, { username: 'bad name' })).body, /letters \(a-z\), numbers and underscores/);
        assert.match((await signup(app, b, { username: 'Support' })).body, /reserved/);
        await b.request('/me/signup');
        const noTerms = await b.request('/me/signup', { form: { username: 'okname', email: 'ok@example.com', password: PASSWORD, birth_date: '2000-01-01' } });
        assert.equal(noTerms.status, 400);
        assert.equal(app.store._accounts.size, 0);
        assert.equal((await signup(app, b, { username: 'taken_one' })).status, 200);
        const taken = await signup(app, b, { username: 'TAKEN_ONE', email: 'other@example.com' });
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
        assert.equal((await b.request('/me/signup', { form: { username: 'x_y', email: 'x@example.com', password: PASSWORD, birth_date: '2000-01-01', accept: 'yes' }, withCsrf: false })).status, 403);
        assert.equal((await b.request('/me/signup', { form: { username: 'x_y', email: 'x@example.com', password: PASSWORD, birth_date: '2000-01-01', accept: 'yes' }, origin: 'https://evil.example' })).status, 403);
        const stranger = browser(app);
        stranger.csrf = b.csrf; // the token without its cookie
        assert.equal((await stranger.request('/me/login-password', { form: { identifier: 'a', password: 'b' } })).status, 403);
        assert.equal(app.store._accounts.size, 0);

        // Logged-in settings forms need the session's token.
        const c = browser(app);
        await confirmed(app, c);
        await c.request('/me/account');
        const good = c.csrf;
        c.csrf = 'wrong';
        assert.equal((await c.request('/me/account/unlink', { form: {} })).status, 403);
        c.csrf = good;
        assert.equal((await c.request('/me/account/password', { form: { password: PASSWORD, new_password: 'x' }, origin: 'https://evil.example' })).status, 403);

        const d = browser(app);
        for (let i = 0; i < 3; i += 1) assert.equal((await passwordLogin(d, 'cool_cat', 'wrong password')).status, 401);
        const limited = await passwordLogin(d, 'cool_cat', PASSWORD);
        assert.equal(limited.status, 429, 'even the right password waits');
    } finally {
        await app.close();
    }
});

test('Discord link rules: one account per Discord id; unlink and relink gets no new bonus; 101st gets nothing', async () => {
    const store = createMemoryAccountStore();
    const app = await serve({ store });
    try {
        const a = browser(app);
        await confirmed(app, a);
        await linkDiscord(app, a);
        // The same Discord id on a second account is refused.
        const b = browser(app);
        await confirmed(app, b, { username: 'other_cat', email: 'other@example.com' });
        const refused = await linkDiscord(app, b);
        assert.equal(refused.status, 409);
        assert.match(refused.body, /already linked to another Mewvo account/);

        // Unlink and link again: no second bonus.
        await a.request('/me/account');
        assert.equal((await a.request('/me/account/unlink', { form: {} })).status, 303);
        assert.match((await a.request('/me')).body, /Link your Discord account/);
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

test('email change: needs the password, confirmed from the new address, old address told', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        await confirmed(app, b);
        await b.request('/me/account');
        assert.equal((await b.request('/me/account/email', { form: { email: 'new@example.com', password: 'wrong password' } })).status, 401);
        assert.equal((await b.request('/me/account/email', { form: { email: 'new@example.com', password: PASSWORD } })).status, 303);
        await waitFor(() => app.mailer.last()?.to === 'new@example.com');
        const path = linkFrom(app.mailer.last(), '/me/confirm');
        await b.request(path);
        const done = await b.request('/me/confirm', { form: { token: new URL(ORIGIN + path).searchParams.get('token') } });
        assert.match(done.body, /Your email address is now new@example.com/);
        await waitFor(() => app.mailer.last()?.to === 'cat@example.com');
        assert.match(app.mailer.last().subject, /email was changed/);
        assert.equal(await (await app.store.findByLogin('new@example.com')).username, 'cool_cat');
    } finally {
        await app.close();
    }
});

test('download my data without Discord: the account fields, never the password hash or 2FA secret', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        await confirmed(app, b);
        const res = await b.request('/me/data');
        assert.equal(res.status, 200);
        const file = JSON.parse(res.body);
        assert.equal(file.mewvoAccount[0].username, 'cool_cat');
        assert.equal(file.mewvoAccount[0].email, 'cat@example.com');
        assert.ok(!res.body.includes('scrypt$') && !res.body.includes('password_hash') && !res.body.includes('totp_secret'));
    } finally {
        await app.close();
    }
});

test('accounts are off unless MEMBER_ACCOUNTS_ENABLED=true', async () => {
    const env = { ...ENV };
    delete env.MEMBER_ACCOUNTS_ENABLED;
    const app = await serve({ env });
    try {
        const b = browser(app);
        assert.equal((await b.request('/me/signup')).status, 404);
        assert.equal((await b.request('/me/login-password')).status, 404);
        assert.doesNotMatch((await b.request('/me')).body, /Mewvo account/);
    } finally {
        await app.close();
    }
});

test('bonus counting in the store: 30 letters, 100 Pro months, a higher plan is reported, concurrent links for slot 100', async () => {
    const granted = [];
    const store = createMemoryAccountStore({
        grantPro: async (userId) => {
            if (userId === '900000000000000099') throw new PremiumError('You already have Max.', 409);
            granted.push(userId);
            return { subscription: { user_id: userId } };
        },
    });
    const make = async (i) => (await store.createAccount({ username: `user_${i}`, email: `u${i}@example.com`, passwordHash: 'h' })).account;
    const results = [];
    for (let i = 1; i <= 98; i += 1) {
        const account = await make(i);
        results.push((await store.linkDiscord({ accountId: account.id, discordUserId: `9000000000000${String(i).padStart(5, '0')}` })).bonus);
    }
    assert.equal(results.filter((r) => r.letter).length, 30);
    assert.equal(results[29].letter, true);
    assert.equal(results[30].letter, false);
    assert.equal(results[97].linkNumber, 98);
    // #99 already has a higher plan: the slot is used, the reason is shown, nothing granted.
    const a99 = await make(99);
    const r99 = (await store.linkDiscord({ accountId: a99.id, discordUserId: '900000000000000099' })).bonus;
    assert.equal(r99.pro, false);
    assert.match(bonusText(r99), /could not be added: You already have Max/);
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
});

test('prune: unconfirmed accounts older than 7 days are deleted', async () => {
    let now = Date.now();
    const store = createMemoryAccountStore({ now: () => now });
    const { account } = await store.createAccount({ username: 'old_one', email: 'old@example.com', passwordHash: 'h' });
    const { account: kept } = await store.createAccount({ username: 'kept_one', email: 'kept@example.com', passwordHash: 'h' });
    await store.saveToken({ accountId: kept.id, purpose: 'confirm', hash: 'x'.repeat(64), ttlMs: 1000 });
    store._accounts.get(kept.id).email_confirmed_at = new Date(now);
    now += 7 * 24 * 3600 * 1000 + 1;
    assert.deepEqual(await store.prune(), { accounts: 1, tokens: 0 });
    assert.equal(await store.findById(account.id), null);
    assert.ok(await store.findById(kept.id));
});
