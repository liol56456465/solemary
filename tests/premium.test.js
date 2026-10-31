// Subscriptions in TEST CHECKOUT mode (premiumService.js, site/billing.js, /me routes):
// key format and parsing, prices from plans.js, the time rules (same plan adds, other active
// plan refused), the login return path, and the whole flow over HTTP with an in-memory store:
// pricing buttons, checkout for me / as a gift, receipt, redeem by another account, refusals,
// CSRF + origin, other people's orders, and everything off without PREMIUM_TEST_CHECKOUT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
    KEY_ALPHABET, PremiumError, applyTime, giftDetails, generateKeyCode, isActive, keyHint, keyStatus, normalizeKeyCode, priceCents, quote,
} from '../src/services/billing/premiumService.js';
import { checkoutChoice } from '../src/services/site/billing.js';
import {
    MEMBER_NEXT_COOKIE, MEMBER_SESSION_COOKIE, MEMBER_STATE_COOKIE, registerMemberPortal, safeNextPath,
} from '../src/services/site/memberPortal.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createSite } from '../src/services/site/site.js';

const DAY = 24 * 3600 * 1000;
const ORIGIN = 'https://bot.example';
const GUILD = '100000000000000001';
const ALICE = '200000000000000002';
const BOB = '300000000000000003';
const ENV = {
    MEMBER_PORTAL_ENABLED: 'true', PREMIUM_TEST_CHECKOUT: 'true', SESSION_SECRET: 'x'.repeat(64), CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: `${ORIGIN}/`, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};

// ── Pure rules ────────────────────────────────────────────────────────────

test('keys: MEWVO-XXXX-XXXX-XXXX from an alphabet without look-alikes; parsing is forgiving', () => {
    for (let i = 0; i < 200; i += 1) {
        const code = generateKeyCode();
        assert.match(code, /^MEWVO-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
        assert.equal(normalizeKeyCode(code), code);
    }
    for (const c of '01OIL') assert.ok(!KEY_ALPHABET.includes(c), `no ${c}`);
    assert.equal(generateKeyCode(() => 0), 'MEWVO-2222-2222-2222');
    assert.equal(normalizeKeyCode(' mewvo 7k3m-q9tx 2hdp '), 'MEWVO-7K3M-Q9TX-2HDP');
    assert.equal(normalizeKeyCode('7K3MQ9TX2HDP'), 'MEWVO-7K3M-Q9TX-2HDP', 'prefix optional');
    assert.equal(normalizeKeyCode('MEWVO-7K3M-Q9TX-2HD0'), null, 'look-alike 0 refused');
    assert.equal(normalizeKeyCode('MEWVO-7K3M-Q9TX'), null, 'too short');
    assert.equal(normalizeKeyCode(''), null);
    assert.equal(normalizeKeyCode(null), null);
    assert.equal(keyHint('MEWVO-7K3M-Q9TX-2HDP'), '…2HDP');
    assert.equal(keyStatus({}), 'unused');
    assert.equal(keyStatus({ redeemed_at: new Date() }), 'redeemed');
    assert.equal(keyStatus({ revoked_at: new Date(), redeemed_at: null }), 'revoked');
});

test('prices come from plans.js: monthly, yearly = 10 × monthly; Free and unknown plans refused', () => {
    assert.equal(priceCents('normal', 'monthly'), 199);
    assert.equal(priceCents('normal', 'yearly'), 1990);
    assert.equal(priceCents('pro', 'monthly'), 499);
    assert.equal(priceCents('pro', 'yearly'), 4990);
    assert.equal(priceCents('max', 'yearly'), 9990);
    assert.equal(priceCents('free', 'monthly'), null);
    assert.equal(priceCents('pro', 'weekly'), null);
    const q = quote({ planId: 'max', period: 'yearly', kind: 'gift' });
    assert.equal(q.days, 365);
    assert.equal(q.amountText, '€99.90');
    assert.throws(() => quote({ planId: 'free', period: 'monthly', kind: 'personal' }), PremiumError);
    assert.throws(() => quote({ planId: 'pro', period: 'monthly', kind: 'friend' }), PremiumError);
});

test('time: starts now when none or expired; same plan adds to the end; another active plan is refused', () => {
    const now = Date.UTC(2026, 9, 31);
    const fresh = applyTime(null, 'pro', 30, now);
    assert.equal(fresh.expiresAt.getTime(), now + 30 * DAY);
    assert.equal(fresh.extended, false);
    const expired = { plan_id: 'max', started_at: new Date(now - 90 * DAY), expires_at: new Date(now - DAY) };
    assert.equal(applyTime(expired, 'pro', 30, now).expiresAt.getTime(), now + 30 * DAY, 'expired other plan: no conflict');
    const active = { plan_id: 'pro', started_at: new Date(now - 10 * DAY), expires_at: new Date(now + 20 * DAY) };
    const more = applyTime(active, 'pro', 365, now);
    assert.equal(more.expiresAt.getTime(), now + 385 * DAY);
    assert.equal(more.startedAt.getTime(), now - 10 * DAY, 'start date kept');
    assert.equal(more.extended, true);
    // Higher plan: upgrade. 20 days of Pro (€4.99) → 20 × 4.99 / 9.99 ≈ 9.99 days of Max, then + 30.
    const up = applyTime(active, 'max', 30, now);
    assert.equal(up.planId, 'max');
    assert.equal(up.converted.fromPlanId, 'pro');
    assert.equal(up.converted.convertedMs, Math.floor(20 * DAY * 499 / 999));
    assert.equal(up.expiresAt.getTime(), now + Math.floor(20 * DAY * 499 / 999) + 30 * DAY);
    assert.equal(up.startedAt.getTime(), now, 'a new plan starts now');
    // Lower plan while a higher one runs: refused.
    assert.throws(() => applyTime(active, 'normal', 30, now), (e) => e instanceof PremiumError && e.status === 409 && /already have Pro/.test(e.message));
    assert.throws(() => applyTime(null, 'pro', 0, now), PremiumError);
    assert.equal(isActive(active, now), true);
    assert.equal(isActive(expired, now), false);
    assert.equal(isActive({ expires_at: null }, now), false);
});

test('login return path: only /me pages; anything else falls back to /me', () => {
    assert.equal(safeNextPath('/me/checkout?plan=pro&period=yearly&for=gift'), '/me/checkout?plan=pro&period=yearly&for=gift');
    assert.equal(safeNextPath('/me/redeem?code=MEWVO-2222-2222-2222'), '/me/redeem?code=MEWVO-2222-2222-2222');
    assert.equal(safeNextPath('/me'), '/me');
    for (const bad of ['https://evil.example/me', '//evil.example', '/me//evil.example', '/me\\evil', '/dashboard', '/meow', '/me/x\ny', '', null, `/me/${'a'.repeat(300)}`]) {
        assert.equal(safeNextPath(bad), '/me', String(bad));
    }
});

test('checkout choice: unknown values fall back to Pro, monthly, for me', () => {
    assert.deepEqual(checkoutChoice({}), { planId: 'pro', period: 'monthly', kind: 'personal' });
    assert.deepEqual(checkoutChoice({ plan: 'max', period: 'yearly', for: 'gift' }), { planId: 'max', period: 'yearly', kind: 'gift' });
    assert.deepEqual(checkoutChoice({ plan: 'free', period: 'x', for: ['gift'] }), { planId: 'pro', period: 'monthly', kind: 'personal' });
});

// ── The flow over HTTP (in-memory store with the same rules) ──────────────

function memoryStore() {
    const subs = new Map();
    const orders = [];
    const keys = new Map();
    let orderId = 0;
    let keyN = 0;
    const makeKey = (fields) => {
        keyN += 1;
        const code = normalizeKeyCode(`MEWVO${String(keyN).padStart(12, '2').replace(/[01]/g, '9')}`);
        const row = { code, created_at: new Date(), redeemed_at: null, revoked_at: null, ...fields };
        keys.set(code, row);
        return row;
    };
    const setSub = (userId, username, next, source) => {
        const row = { user_id: userId, username, plan_id: next.planId, started_at: next.startedAt, expires_at: next.expiresAt, source };
        subs.set(userId, row);
        return row;
    };
    return {
        subs, orders, keys,
        async purchase({ userId, username, planId, period, kind, giftTo, giftMessage }) {
            const q = quote({ planId, period, kind });
            const gift = kind === 'gift' ? giftDetails({ to: giftTo, message: giftMessage }) : null;
            const next = kind === 'personal' ? applyTime(subs.get(userId), planId, q.days) : null;
            orderId += 1;
            const order = { id: orderId, user_id: userId, username, plan_id: planId, period, kind, amount_cents: q.amountCents, test: true, created_at: new Date(), key_code: null };
            orders.unshift(order);
            if (next) return { order, subscription: setSub(userId, username, next, 'purchase'), key: null };
            const key = makeKey({ plan_id: planId, duration_days: q.days, source: 'gift', created_by: userId, created_by_username: username, order_id: order.id, gift_to: gift.giftTo, gift_message: gift.giftMessage, expires_at: new Date(Date.now() + 365 * DAY) });
            order.key_code = key.code;
            return { order, subscription: null, key };
        },
        async redeem({ code, userId, username }) {
            const normalized = normalizeKeyCode(code);
            if (!normalized) throw new PremiumError('That is not a Mewvo key.');
            const key = keys.get(normalized);
            if (!key) throw new PremiumError('That key does not exist.', 404);
            if (key.revoked_at) throw new PremiumError('That key was cancelled and cannot be used.', 409);
            if (key.redeemed_at) throw new PremiumError('That key has already been used.', 409);
            const next = applyTime(subs.get(userId), key.plan_id, key.duration_days);
            const subscription = setSub(userId, username, next, 'key');
            Object.assign(key, { redeemed_at: new Date(), redeemed_by: userId, redeemed_by_username: username });
            return { key, subscription };
        },
        async peekKey(code) {
            const key = keys.get(normalizeKeyCode(code));
            if (!key || keyStatus(key) !== 'unused') return null;
            return { planId: key.plan_id, days: key.duration_days, from: key.created_by_username, giftTo: key.gift_to, giftMessage: key.gift_message, expiresAt: key.expires_at };
        },
        async accountOf(userId) {
            const sub = subs.get(userId);
            return {
                subscription: isActive(sub) ? sub : null,
                orders: orders.filter((o) => o.user_id === userId),
                gifts: [...keys.values()].filter((k) => k.created_by === userId && k.source === 'gift'),
            };
        },
    };
}

function fakeDiscord() {
    let me = { id: ALICE, username: 'alice', global_name: 'Alice' };
    const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/token') ? { access_token: 'tok' } : me) });
    return { fetchImpl, as: (user) => { me = user; } };
}

async function serve({ env = ENV, premium = memoryStore() } = {}) {
    const app = express();
    const discord = fakeDiscord();
    const memberSessions = createMemorySessionStore({ ttlMs: 3600 * 1000 });
    const data = {
        getMemberStanding: async () => ({ ladder: { level: 0, warns_since_level: 0 }, warns: [], activeBan: null, activeMute: null }),
        listCasesForUser: async () => ({ rows: [] }),
        listUserAppeals: async () => [],
    };
    const memberPortalEnabled = registerMemberPortal(app, { env, sessions: memberSessions, data, fetchImpl: discord.fetchImpl, premium });
    app.use(createSite({ client: { commands: null }, env, memberPortalEnabled, billingEnabled: env.PREMIUM_TEST_CHECKOUT === 'true' }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, { method = 'GET', cookie = '', headers = {}, body } = {}) => {
        const res = await fetch(base + path, {
            method, redirect: 'manual', body,
            headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        });
        return { status: res.status, headers: res.headers, cookies: res.headers.getSetCookie(), body: await res.text() };
    };
    return { request, discord, premium, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const cookieVal = (cookies, name) => {
    const line = cookies.find((c) => c.startsWith(`${name}=`) && !c.includes('Max-Age=0'));
    return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : null;
};

/** Logs in as `user`; `next` = the page to come back to. Returns { cookie, location }. */
async function login(app, user, next = '') {
    app.discord.as(user);
    const start = await app.request(`/me/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cookies = [`${MEMBER_STATE_COOKIE}=${encodeURIComponent(cookieVal(start.cookies, MEMBER_STATE_COOKIE))}`];
    const nextCookie = cookieVal(start.cookies, MEMBER_NEXT_COOKIE);
    if (nextCookie) cookies.push(`${MEMBER_NEXT_COOKIE}=${encodeURIComponent(nextCookie)}`);
    const res = await app.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: cookies.join('; ') });
    return { cookie: `${MEMBER_SESSION_COOKIE}=${encodeURIComponent(cookieVal(res.cookies, MEMBER_SESSION_COOKIE))}`, location: res.headers.get('location') };
}

const csrfOf = (body) => body.match(/name="csrf" value="([^"]+)"/)[1];
const form = (fields) => new URLSearchParams(fields).toString();

test('pricing: Buy and Gift for monthly and yearly when test checkout is on; "Coming soon" when off', async () => {
    const on = await serve();
    const off = await serve({ env: { ...ENV, PREMIUM_TEST_CHECKOUT: 'false' } });
    try {
        const page = (await on.request('/pricing')).body;
        for (const href of ['/me/checkout?plan=normal&amp;period=monthly&amp;for=personal', '/me/checkout?plan=max&amp;period=yearly&amp;for=gift']) {
            assert.ok(page.includes(href), href);
        }
        assert.ok(page.includes('Test mode'));
        assert.ok(!page.includes('Coming soon'));
        const closed = (await off.request('/pricing')).body;
        assert.ok(closed.includes('Coming soon'));
        assert.ok(!closed.includes('/me/checkout'));
        for (const path of ['/me/billing', '/me/checkout', '/me/redeem']) assert.equal((await off.request(path)).status, 404, path);
    } finally {
        await on.close();
        await off.close();
    }
});

test('checkout logged out → login → back to the same checkout; buying for me activates the plan', async () => {
    const app = await serve();
    try {
        const start = await app.request('/me/checkout?plan=normal&period=yearly&for=personal');
        assert.equal(start.status, 200);
        assert.ok(start.body.includes('/me/login?next=%2Fme%2Fcheckout%3Fplan%3Dnormal%26period%3Dyearly%26for%3Dpersonal'));
        const { cookie, location } = await login(app, { id: ALICE, username: 'alice', global_name: 'Alice' }, '/me/checkout?plan=normal&period=yearly&for=personal');
        assert.equal(location, '/me/checkout?plan=normal&period=yearly&for=personal');

        const page = await app.request(location, { cookie });
        assert.ok(page.body.includes('€19.90'), 'yearly Normal price');
        assert.ok(page.body.includes('Complete test purchase'));
        const csrf = csrfOf(page.body);
        const body = form({ csrf, plan: 'normal', period: 'yearly', for: 'personal' });
        assert.equal((await app.request('/me/checkout', { method: 'POST', cookie, body, headers: { origin: 'https://evil.example' } })).status, 403);
        assert.equal((await app.request('/me/checkout', { method: 'POST', cookie, body: form({ csrf: 'no', plan: 'normal', period: 'yearly', for: 'personal' }), headers: { origin: ORIGIN } })).status, 403);
        assert.equal(app.premium.orders.length, 0, 'refused posts bought nothing');

        const bought = await app.request('/me/checkout', { method: 'POST', cookie, body, headers: { origin: ORIGIN } });
        assert.equal(bought.status, 303);
        assert.equal(bought.headers.get('location'), '/me/billing/orders/1');
        const receipt = await app.request('/me/billing/orders/1', { cookie });
        assert.ok(receipt.body.includes('your plan is active'));
        assert.ok(receipt.body.includes('€19.90 (test, not charged)'));
        const billing = await app.request('/me/billing', { cookie });
        assert.ok(billing.body.includes('Normal'));
        assert.ok(billing.body.includes('Active until'));
        assert.equal(app.premium.subs.get(ALICE).plan_id, 'normal');

        // Upgrade preview, then the upgrade to Max.
        const preview = await app.request('/me/checkout?plan=max&period=monthly&for=personal', { cookie });
        assert.match(preview.body, /Upgrade: your remaining 365 days of Normal become [\d.]+ days of Max/);
        const up = await app.request('/me/checkout', { method: 'POST', cookie, body: form({ csrf, plan: 'max', period: 'monthly', for: 'personal' }), headers: { origin: ORIGIN } });
        assert.equal(up.status, 303);
        assert.equal(app.premium.subs.get(ALICE).plan_id, 'max');
        // A lower plan while Max runs: the checkout says so and a post is refused; nothing bought.
        const lower = await app.request('/me/checkout?plan=normal&period=monthly&for=personal', { cookie });
        assert.match(lower.body, /Not available while your plan runs/);
        const clash = await app.request('/me/checkout', { method: 'POST', cookie, body: form({ csrf, plan: 'normal', period: 'monthly', for: 'personal' }), headers: { origin: ORIGIN } });
        assert.equal(clash.status, 409);
        assert.ok(clash.body.includes('already have Max'));
        assert.equal(app.premium.orders.length, 2);
    } finally {
        await app.close();
    }
});

test('gift: the buyer gets a key; another account redeems it once; the buyer sees it as redeemed', async () => {
    const app = await serve();
    try {
        const alice = await login(app, { id: ALICE, username: 'alice' });
        const csrf = csrfOf((await app.request('/me/checkout?plan=pro&period=monthly&for=gift', { cookie: alice.cookie })).body);
        const bought = await app.request('/me/checkout', { method: 'POST', cookie: alice.cookie, body: form({ csrf, plan: 'pro', period: 'monthly', for: 'gift' }), headers: { origin: ORIGIN } });
        assert.equal(bought.status, 303);
        assert.equal(app.premium.subs.get(ALICE), undefined, 'a gift does not touch the buyer\'s plan');
        const receipt = await app.request(bought.headers.get('location'), { cookie: alice.cookie });
        const code = receipt.body.match(/MEWVO-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)[0];
        assert.ok(receipt.body.includes('gift key is ready'));
        assert.ok(receipt.body.includes(`${ORIGIN}/me/redeem?code=${code}`), 'shareable redeem link');

        // Bob cannot open Alice's receipt.
        const bob = await login(app, { id: BOB, username: 'bob' });
        assert.equal((await app.request(bought.headers.get('location'), { cookie: bob.cookie })).status, 404);

        // Gift link pre-fills the code (logged out: login with return).
        const out = await app.request(`/me/redeem?code=${code.toLowerCase()}`);
        assert.ok(out.body.includes(encodeURIComponent(`/me/redeem?code=${code}`)));
        const page = await app.request(`/me/redeem?code=${code}`, { cookie: bob.cookie });
        assert.ok(page.body.includes(`value="${code}"`));
        const bobCsrf = csrfOf(page.body);
        const redeem = (cookie, csrfValue, c) => app.request('/me/redeem', { method: 'POST', cookie, body: form({ csrf: csrfValue, code: c }), headers: { origin: ORIGIN } });

        assert.equal((await redeem(bob.cookie, 'wrong', code)).status, 403);
        const ok = await redeem(bob.cookie, bobCsrf, code.toLowerCase().replace(/-/g, ' '));
        assert.equal(ok.status, 303);
        const bobBilling = await app.request('/me/billing', { cookie: bob.cookie });
        assert.ok(bobBilling.body.includes('Key redeemed: Mewvo Pro, 30 days added'), 'flash shown once');
        assert.ok(!(await app.request('/me/billing', { cookie: bob.cookie })).body.includes('Key redeemed'), 'flash cleared');
        assert.equal(app.premium.subs.get(BOB).plan_id, 'pro');

        const again = await redeem(alice.cookie, csrfOf((await app.request('/me/billing', { cookie: alice.cookie })).body), code);
        assert.equal(again.status, 409);
        assert.ok(again.body.includes('already been used'));
        assert.ok((await app.request('/me/billing', { cookie: alice.cookie })).body.includes('Redeemed'), 'buyer sees the status');

        const junk = await redeem(bob.cookie, bobCsrf, 'not a key');
        assert.equal(junk.status, 400);
    } finally {
        await app.close();
    }
});

test('redeem is rate limited per address and account', async () => {
    const app = await serve();
    try {
        const bob = await login(app, { id: BOB, username: 'bob' });
        const csrf = csrfOf((await app.request('/me/billing', { cookie: bob.cookie })).body);
        let last;
        for (let i = 0; i < 11; i += 1) {
            last = await app.request('/me/redeem', { method: 'POST', cookie: bob.cookie, body: form({ csrf, code: 'MEWVO-2222-2222-2223' }), headers: { origin: ORIGIN } });
        }
        assert.equal(last.status, 429);
        assert.equal(last.headers.get('retry-after'), '60');
    } finally {
        await app.close();
    }
});

test('gift with a name and message: shown on the receipt and as a card on the gift link (escaped); too long refused', async () => {
    const app = await serve();
    try {
        const alice = await login(app, { id: ALICE, username: 'alice', global_name: 'Alice' });
        const csrf = csrfOf((await app.request('/me/checkout?plan=max&period=monthly&for=gift', { cookie: alice.cookie })).body);
        const post = (fields) => app.request('/me/checkout', { method: 'POST', cookie: alice.cookie, body: form({ csrf, plan: 'max', period: 'monthly', for: 'gift', ...fields }), headers: { origin: ORIGIN } });
        const tooLong = await post({ gift_to: 'x'.repeat(51) });
        assert.equal(tooLong.status, 400);
        assert.match(tooLong.body, /limited to 50 characters/);
        assert.ok(tooLong.body.includes('value="xxxxx'), 'typed values kept');
        assert.equal(app.premium.orders.length, 0);

        const bought = await post({ gift_to: 'Sam', gift_message: 'Happy <b>birthday</b>!' });
        assert.equal(bought.status, 303);
        const receipt = (await app.request(bought.headers.get('location'), { cookie: alice.cookie })).body;
        assert.ok(receipt.includes('to Sam'));
        assert.ok(receipt.includes('Happy &lt;b&gt;birthday&lt;/b&gt;!'), 'message escaped');
        assert.ok(receipt.includes('Redeem by'), 'gift keys expire');
        const code = receipt.match(/MEWVO-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)[0];

        const bob = await login(app, { id: BOB, username: 'bob' });
        const page = (await app.request(`/me/redeem?code=${code}`, { cookie: bob.cookie })).body;
        assert.match(page, /You got a gift/);
        assert.match(page, /A gift from Alice for Sam/);
        assert.match(page, /Mewvo Max · 30 days/);
        assert.ok(page.includes('Happy &lt;b&gt;birthday&lt;/b&gt;!'));
        const unknown = (await app.request('/me/redeem?code=MEWVO-2222-2222-2222', { cookie: bob.cookie })).body;
        assert.ok(!unknown.includes('gift-card'), 'no card for an unknown key');
    } finally {
        await app.close();
    }
});
