// premiumService.js — subscriptions, orders and premium keys (TEST CHECKOUT ONLY).
//
// No payment provider is connected: a "purchase" is a test order (amount from
// config/site/plans.js, `test = true`) and no card details are ever asked for or stored.
// The whole flow is off unless PREMIUM_TEST_CHECKOUT=true (see premiumSettings).
//
// Model (owner, 2026-10-31):
//   - A subscription belongs to a Discord ACCOUNT (premium_subscriptions, one row per user):
//     plan + paid-until. Nothing in the bot reads it yet (every paid perk is still Planned).
//   - "Buy for me": a test order that starts or extends the buyer's own subscription.
//   - "Buy as a gift": a test order that creates a premium key; ANYONE logged in can redeem it.
//   - Owner keys: generated in the dashboard (Owner → Premium keys), same redeem path.
//   - Redeem / buy on the SAME plan adds the time to the current end date. A DIFFERENT active
//     plan is refused (the key stays unused) so no paid time is ever thrown away.
//   - Durations are days: monthly = 30, yearly = 365.
//
// Keys look like MEWVO-7K3M-Q9TX-2HDP: 12 random characters from an alphabet without
// look-alikes (no 0 O 1 I L), ~59 bits. Stored in plain text (owner and buyer must be able to
// see their keys again); only the last four characters go into audit rows and logs.
// Every multi-step change runs in one transaction with the key / subscription row locked.

import { randomInt } from 'node:crypto';
import { PLANS, euros, yearlyCents } from '../../config/site/plans.js';
import { pgConfig } from '../../config/database/postgres.js';

export const KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const KEY_PREFIX = 'MEWVO';
export const KEY_GROUPS = 3;
export const KEY_GROUP_LENGTH = 4;
export const PERIODS = {
    monthly: { label: 'Monthly', days: 30 },
    yearly: { label: 'Yearly', days: 365 },
};
/** Durations the owner can pick for generated keys (days → label). */
export const KEY_DURATIONS = [
    { days: 7, label: '7 days' },
    { days: 30, label: '1 month (30 days)' },
    { days: 90, label: '3 months (90 days)' },
    { days: 180, label: '6 months (180 days)' },
    { days: 365, label: '1 year (365 days)' },
];
export const MAX_KEYS_PER_BATCH = 50;
export const NOTE_MAX = 200;
export const ORDER_KINDS = ['personal', 'gift'];
const DAY_MS = 24 * 60 * 60 * 1000;
const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim());

export class PremiumError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'PremiumError';
        this.userMessage = message;
        this.type = 'validation';
        this.status = status;
    }
}

/** { testCheckout } from the environment. Off by default. */
export function premiumSettings(env = process.env) {
    return { testCheckout: truthy(env.PREMIUM_TEST_CHECKOUT) };
}

// ── Pure helpers (tested) ─────────────────────────────────────────────────

/** The paid plans (Free excluded). */
export const PAID_PLANS = PLANS.filter((plan) => plan.monthlyCents > 0);

export function paidPlan(planId) {
    return PAID_PLANS.find((plan) => plan.id === planId) || null;
}

export function planName(planId) {
    return PLANS.find((plan) => plan.id === planId)?.name || String(planId || '');
}

/** Price in cents for a paid plan and period, or null when either is unknown. */
export function priceCents(planId, period) {
    const plan = paidPlan(planId);
    if (!plan || !PERIODS[period]) return null;
    return period === 'yearly' ? yearlyCents(plan) : plan.monthlyCents;
}

/** The order summary for checkout: { plan, period, kind, days, amountCents, amountText } or a PremiumError. */
export function quote({ planId, period, kind }) {
    const plan = paidPlan(planId);
    if (!plan) throw new PremiumError('Choose a paid plan (Normal, Pro or Max).');
    if (!PERIODS[period]) throw new PremiumError('Choose monthly or yearly billing.');
    if (!ORDER_KINDS.includes(kind)) throw new PremiumError('Choose whether this is for you or a gift.');
    const amountCents = priceCents(planId, period);
    return { plan, period, kind, days: PERIODS[period].days, amountCents, amountText: euros(amountCents) };
}

/** A new random key: MEWVO-XXXX-XXXX-XXXX. `pick(n)` returns 0…n-1 (crypto by default). */
export function generateKeyCode(pick = randomInt) {
    const groups = [];
    for (let g = 0; g < KEY_GROUPS; g += 1) {
        let part = '';
        for (let i = 0; i < KEY_GROUP_LENGTH; i += 1) part += KEY_ALPHABET[pick(KEY_ALPHABET.length)];
        groups.push(part);
    }
    return [KEY_PREFIX, ...groups].join('-');
}

/**
 * What someone typed → the stored form, or null when it cannot be a key. Accepts lower case,
 * spaces, missing dashes and a missing MEWVO prefix.
 */
export function normalizeKeyCode(input) {
    let s = String(input || '').toUpperCase().replace(/[\s-]+/g, '');
    if (s.startsWith(KEY_PREFIX)) s = s.slice(KEY_PREFIX.length);
    const length = KEY_GROUPS * KEY_GROUP_LENGTH;
    if (s.length !== length || [...s].some((c) => !KEY_ALPHABET.includes(c))) return null;
    const groups = s.match(new RegExp(`.{${KEY_GROUP_LENGTH}}`, 'g'));
    return [KEY_PREFIX, ...groups].join('-');
}

/** "…2HDP": the only part of a key that goes into audit rows and logs. */
export function keyHint(code) {
    return `…${String(code || '').slice(-4)}`;
}

/** A key's state for lists: 'revoked' | 'redeemed' | 'unused'. */
export function keyStatus(row) {
    if (row?.revoked_at) return 'revoked';
    if (row?.redeemed_at) return 'redeemed';
    return 'unused';
}

/** True while the subscription row is paid up. */
export function isActive(subscription, now = Date.now()) {
    return Boolean(subscription?.expires_at) && new Date(subscription.expires_at).getTime() > now;
}

/**
 * The subscription after adding `days` of `planId`: { planId, startedAt, expiresAt, extended }.
 * No or expired subscription → starts now. Same plan → added to the end date. A different
 * active plan → PremiumError (nothing changes, a key stays unused).
 */
export function applyTime(current, planId, days, now = Date.now()) {
    if (!Number.isInteger(days) || days < 1) throw new PremiumError('The duration must be at least one day.');
    if (isActive(current, now)) {
        if (current.plan_id !== planId) {
            throw new PremiumError(`You already have ${planName(current.plan_id)} until ${new Date(current.expires_at).toISOString().slice(0, 10)}. A ${planName(planId)} key or purchase can be used after it ends; nothing was changed.`, 409);
        }
        return {
            planId, startedAt: new Date(current.started_at), extended: true,
            expiresAt: new Date(new Date(current.expires_at).getTime() + days * DAY_MS),
        };
    }
    return { planId, startedAt: new Date(now), expiresAt: new Date(now + days * DAY_MS), extended: false };
}

const clip = (value, max) => String(value ?? '').slice(0, max);
const snowflake = /^\d{17,20}$/;

// ── Store ─────────────────────────────────────────────────────────────────

/**
 * The SQL, with injectable `query` / `withTransaction` (the enforcement pool helpers by
 * default, imported lazily so unit tests stay DB-free) and `now` / `makeCode` for tests.
 */
export function createPremiumStore({
    query = null, withTransaction = null, tables = pgConfig.tables, now = () => Date.now(), makeCode = generateKeyCode,
} = {}) {
    const S = tables.premium_subscriptions;
    const O = tables.premium_orders;
    const K = tables.premium_keys;
    let helpers = null;
    async function db() {
        if (helpers) return helpers;
        if (query && withTransaction) helpers = { query, withTransaction };
        else {
            const mod = await import('../enforcement/db.js');
            helpers = { query: query || mod.query, withTransaction: withTransaction || mod.withTransaction };
        }
        return helpers;
    }

    async function lockedSubscription(client, userId) {
        // Make sure the row exists so it can be locked (concurrent redeems wait on it).
        await client.query(`INSERT INTO ${S} (user_id, plan_id, started_at, expires_at) VALUES ($1, NULL, NULL, NULL) ON CONFLICT (user_id) DO NOTHING`, [userId]);
        const { rows: [row] } = await client.query(`SELECT * FROM ${S} WHERE user_id = $1 FOR UPDATE`, [userId]);
        return row;
    }

    async function writeSubscription(client, userId, username, next, source) {
        const { rows: [row] } = await client.query(
            `UPDATE ${S} SET plan_id = $2, started_at = $3, expires_at = $4, source = $5, username = COALESCE($6, username), updated_at = NOW()
             WHERE user_id = $1 RETURNING *`,
            [userId, next.planId, next.startedAt, next.expiresAt, source, username]);
        if (!row) throw new Error('subscription update returned no row');
        return row;
    }

    async function insertKey(client, { planId, days, source, createdBy, createdByUsername, orderId = null, note = null }) {
        // A collision in ~59 bits is practically impossible; retry a few times anyway.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const code = makeCode();
            const { rows: [row] } = await client.query(
                `INSERT INTO ${K} (code, plan_id, duration_days, source, created_by, created_by_username, order_id, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (code) DO NOTHING RETURNING *`,
                [code, planId, days, source, createdBy, createdByUsername, orderId, note]);
            if (row) return row;
        }
        throw new Error('could not create a unique premium key');
    }

    /**
     * A test purchase: { userId, username, planId, period, kind }. Personal → the buyer's
     * subscription is started/extended; gift → a key is created. One transaction.
     * Returns { order, subscription|null, key|null }.
     */
    async function purchase({ userId, username = null, planId, period, kind }) {
        if (!snowflake.test(String(userId || ''))) throw new PremiumError('Log in first.', 401);
        const q = quote({ planId, period, kind });
        const name = username ? clip(username, 100) : null;
        const { withTransaction: tx } = await db();
        return tx(async (client) => {
            let subscription = null;
            let next = null;
            if (kind === 'personal') {
                const current = await lockedSubscription(client, userId);
                next = applyTime(current, planId, q.days, now()); // throws before anything is written
            }
            const { rows: [order] } = await client.query(
                `INSERT INTO ${O} (user_id, username, plan_id, period, kind, amount_cents, currency, test)
                 VALUES ($1, $2, $3, $4, $5, $6, 'EUR', TRUE) RETURNING *`,
                [userId, name, planId, period, kind, q.amountCents]);
            if (!order) throw new Error('order insert returned no row');
            let key = null;
            if (kind === 'personal') {
                subscription = await writeSubscription(client, userId, name, next, 'purchase');
            } else {
                key = await insertKey(client, { planId, days: q.days, source: 'gift', createdBy: userId, createdByUsername: name, orderId: order.id });
                await client.query(`UPDATE ${O} SET key_code = $2 WHERE id = $1`, [order.id, key.code]);
                order.key_code = key.code;
            }
            return { order, subscription, key };
        });
    }

    /** Redeems a key for userId. Returns { key, subscription }. Refusals throw PremiumError. */
    async function redeem({ code, userId, username = null }) {
        if (!snowflake.test(String(userId || ''))) throw new PremiumError('Log in first.', 401);
        const normalized = normalizeKeyCode(code);
        if (!normalized) throw new PremiumError('That is not a Mewvo key. Keys look like MEWVO-ABCD-EFGH-JKMN.');
        const name = username ? clip(username, 100) : null;
        const { withTransaction: tx } = await db();
        return tx(async (client) => {
            const { rows: [key] } = await client.query(`SELECT * FROM ${K} WHERE code = $1 FOR UPDATE`, [normalized]);
            if (!key) throw new PremiumError('That key does not exist. Check it for typos.', 404);
            if (key.revoked_at) throw new PremiumError('That key was cancelled and cannot be used.', 409);
            if (key.redeemed_at) throw new PremiumError('That key has already been used.', 409);
            const current = await lockedSubscription(client, userId);
            const next = applyTime(current, key.plan_id, key.duration_days, now());
            const subscription = await writeSubscription(client, userId, name, next, 'key');
            const { rows: [used] } = await client.query(
                `UPDATE ${K} SET redeemed_by = $2, redeemed_by_username = $3, redeemed_at = NOW()
                 WHERE code = $1 AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING *`,
                [normalized, userId, name]);
            if (!used) throw new Error('premium key changed while it was being redeemed');
            return { key: used, subscription };
        });
    }

    /** Owner: `count` keys of planId for `days`. Returns the rows (newest code order). */
    async function generateKeys({ planId, days, count = 1, note = '', actor }) {
        if (!paidPlan(planId)) throw new PremiumError('Choose a paid plan (Normal, Pro or Max).');
        if (!KEY_DURATIONS.some((d) => d.days === days)) throw new PremiumError('Choose one of the listed durations.');
        if (!Number.isInteger(count) || count < 1 || count > MAX_KEYS_PER_BATCH) throw new PremiumError(`Create between 1 and ${MAX_KEYS_PER_BATCH} keys at a time.`);
        if (String(note || '').length > NOTE_MAX) throw new PremiumError(`The note is longer than ${NOTE_MAX} characters.`);
        if (!snowflake.test(String(actor?.userId || ''))) throw new Error('generateKeys needs the owner as actor');
        const { withTransaction: tx } = await db();
        return tx(async (client) => {
            const rows = [];
            for (let i = 0; i < count; i += 1) {
                rows.push(await insertKey(client, {
                    planId, days, source: 'owner', createdBy: String(actor.userId),
                    createdByUsername: actor.username ? clip(actor.username, 100) : null, note: String(note || '').trim() || null,
                }));
            }
            return rows;
        });
    }

    /** Owner: cancels an unused key. Returns the row, or null when it is not unused any more. */
    async function revokeKey(code, actor) {
        const normalized = normalizeKeyCode(code);
        if (!normalized) return null;
        const { query: q } = await db();
        const { rows: [row] } = await q(
            `UPDATE ${K} SET revoked_at = NOW(), revoked_by = $2 WHERE code = $1 AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING *`,
            [normalized, String(actor.userId)]);
        return row || null;
    }

    /** Owner: keys, newest first. status: 'unused' | 'redeemed' | 'revoked' | 'all'. */
    async function listKeys({ status = 'all', limit = 200 } = {}) {
        const where = {
            unused: 'WHERE redeemed_at IS NULL AND revoked_at IS NULL',
            redeemed: 'WHERE redeemed_at IS NOT NULL',
            revoked: 'WHERE revoked_at IS NOT NULL',
            all: '',
        }[status] ?? '';
        const { query: q } = await db();
        const { rows } = await q(`SELECT * FROM ${K} ${where} ORDER BY created_at DESC, code LIMIT $1`, [Math.min(Math.max(1, limit), 500)]);
        const { rows: [counts] } = await q(
            `SELECT COUNT(*) FILTER (WHERE redeemed_at IS NULL AND revoked_at IS NULL)::int AS unused,
                    COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL)::int AS redeemed,
                    COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
                    COUNT(*)::int AS total FROM ${K}`);
        return { rows, counts };
    }

    /** Owner: subscriptions that are paid up now, soonest end first. */
    async function listActiveSubscriptions(limit = 200) {
        const { query: q } = await db();
        const { rows } = await q(`SELECT * FROM ${S} WHERE expires_at > $1 ORDER BY expires_at ASC LIMIT $2`, [new Date(now()), limit]);
        return rows;
    }

    /** Owner: the newest orders (all test orders). */
    async function listOrders(limit = 50) {
        const { query: q } = await db();
        const { rows } = await q(`SELECT * FROM ${O} ORDER BY created_at DESC, id DESC LIMIT $1`, [limit]);
        return rows;
    }

    /** Owner: ends a subscription now. Returns the old row, or null when none was active. */
    async function endSubscription(userId, actor) {
        if (!snowflake.test(String(userId || ''))) return null;
        const { withTransaction: tx } = await db();
        return tx(async (client) => {
            const { rows: [row] } = await client.query(`SELECT * FROM ${S} WHERE user_id = $1 FOR UPDATE`, [String(userId)]);
            if (!isActive(row, now())) return null;
            await client.query(`UPDATE ${S} SET expires_at = $2, source = $3, updated_at = NOW() WHERE user_id = $1`,
                [String(userId), new Date(now()), `ended by ${String(actor.userId)}`]);
            return row;
        });
    }

    /** One member's billing page: { subscription|null (only when active), orders, gifts }. */
    async function accountOf(userId) {
        const { query: q } = await db();
        const [{ rows: [subscription] }, { rows: orders }, { rows: gifts }] = await Promise.all([
            q(`SELECT * FROM ${S} WHERE user_id = $1`, [userId]),
            q(`SELECT * FROM ${O} WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`, [userId]),
            q(`SELECT * FROM ${K} WHERE created_by = $1 AND source = 'gift' ORDER BY created_at DESC LIMIT 50`, [userId]),
        ]);
        return { subscription: isActive(subscription, now()) ? subscription : null, orders, gifts };
    }

    return { purchase, redeem, generateKeys, revokeKey, listKeys, listActiveSubscriptions, listOrders, endSubscription, accountOf };
}

export const premiumStore = createPremiumStore();
