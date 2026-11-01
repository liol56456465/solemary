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
//   - Redeem / buy on the SAME plan adds the time to the current end date.
//   - A HIGHER plan while one is active = upgrade: the remaining time is converted at the
//     monthly-price ratio (20 days of Normal €1.99 → 7.97 days of Pro €4.99), then the new time
//     is added. A LOWER plan while a higher one is active is refused (the key stays unused).
//   - Durations are days: monthly = 30, yearly = 365.
//   - Unused keys expire: gift keys 1 year after the purchase, owner keys after the time the
//     owner picks (or never). A gift can carry a "to" name and a short message.
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
export const GIFT_TO_MAX = 50;
export const GIFT_MESSAGE_MAX = 300;
export const GIFT_KEY_VALID_DAYS = 365;
/** How long an owner key can be redeemed (0 = never expires). */
export const KEY_VALIDITY = [
    { days: 0, label: 'Never expires' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 365, label: '1 year' },
];
/** Ways a plan can be given: 'purchase' | 'key' | 'owner' | 'bonus' (early Mewvo account). */
export const SUBSCRIPTION_SOURCES = ['purchase', 'key', 'owner', 'bonus'];
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

/** A key's state for lists: 'revoked' | 'redeemed' | 'expired' | 'unused'. */
export function keyStatus(row, now = Date.now()) {
    if (row?.revoked_at) return 'revoked';
    if (row?.redeemed_at) return 'redeemed';
    if (row?.expires_at && new Date(row.expires_at).getTime() <= now) return 'expired';
    return 'unused';
}

/** The plan's rank (Free 0, Normal 1, …) from its order in plans.js. */
export function planRank(planId) {
    return PLANS.findIndex((plan) => plan.id === planId);
}

/** True while the subscription row is paid up. */
export function isActive(subscription, now = Date.now()) {
    return Boolean(subscription?.expires_at) && new Date(subscription.expires_at).getTime() > now;
}

/**
 * An upgrade preview: the remaining time of the current plan converted to `planId` at the
 * monthly-price ratio. { fromPlanId, remainingMs, convertedMs } or null when there is nothing
 * to convert (no active plan, same plan). Throws for a lower plan. Pure.
 */
export function conversion(current, planId, now = Date.now()) {
    if (!isActive(current, now) || current.plan_id === planId) return null;
    const from = paidPlan(current.plan_id);
    const to = paidPlan(planId);
    if (!to) throw new PremiumError('Choose a paid plan (Normal, Pro or Max).');
    if (from && planRank(planId) < planRank(current.plan_id)) {
        throw new PremiumError(`You already have ${planName(current.plan_id)} until ${new Date(current.expires_at).toISOString().slice(0, 10)}, which is more than ${planName(planId)}. A ${planName(planId)} key or purchase can be used after it ends; nothing was changed.`, 409);
    }
    const remainingMs = new Date(current.expires_at).getTime() - now;
    // A plan that is no longer for sale converts 1:1.
    const convertedMs = from ? Math.floor(remainingMs * from.monthlyCents / to.monthlyCents) : remainingMs;
    return { fromPlanId: current.plan_id, remainingMs, convertedMs };
}

/**
 * The subscription after adding `days` of `planId`:
 * { planId, startedAt, expiresAt, extended, converted (conversion() or null) }.
 * No or expired subscription → starts now. Same plan → added to the end date. Higher plan →
 * upgrade (remaining time converted, then the days added). Lower plan → PremiumError.
 */
export function applyTime(current, planId, days, now = Date.now()) {
    if (!Number.isInteger(days) || days < 1) throw new PremiumError('The duration must be at least one day.');
    if (isActive(current, now)) {
        if (current.plan_id === planId) {
            return {
                planId, startedAt: new Date(current.started_at), extended: true, converted: null,
                expiresAt: new Date(new Date(current.expires_at).getTime() + days * DAY_MS),
            };
        }
        const converted = conversion(current, planId, now);
        return { planId, startedAt: new Date(now), extended: false, converted, expiresAt: new Date(now + converted.convertedMs + days * DAY_MS) };
    }
    return { planId, startedAt: new Date(now), expiresAt: new Date(now + days * DAY_MS), extended: false, converted: null };
}

/** A gift's optional "to" and message, trimmed; too long is refused. Pure. */
export function giftDetails({ to = '', message = '' } = {}) {
    const giftTo = String(to ?? '').trim();
    const giftMessage = String(message ?? '').trim().replace(/\r\n?/g, '\n');
    if (giftTo.length > GIFT_TO_MAX) throw new PremiumError(`"To" is limited to ${GIFT_TO_MAX} characters.`);
    if (giftMessage.length > GIFT_MESSAGE_MAX) throw new PremiumError(`The message is limited to ${GIFT_MESSAGE_MAX} characters.`);
    return { giftTo: giftTo || null, giftMessage: giftMessage || null };
}

const clip = (value, max) => String(value ?? '').slice(0, max);
const snowflake = /^\d{17,20}$/;

// ── Store ─────────────────────────────────────────────────────────────────

/**
 * The SQL, with injectable `query` / `withTransaction` (the enforcement pool helpers by
 * default, imported lazily so unit tests stay DB-free) and `now` / `makeCode` for tests.
 * Every change that touches a subscription returns { subscription, previous, next } so the
 * caller can update the cache, the role and send the DM (premiumEffects.js).
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
    const at = (ms) => new Date(ms);

    async function lockedSubscription(client, userId) {
        // Make sure the row exists so it can be locked (concurrent changes wait on it).
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

    async function insertKey(client, { planId, days, source, createdBy, createdByUsername, orderId = null, note = null, giftTo = null, giftMessage = null, expiresAt = null }) {
        // A collision in ~59 bits is practically impossible; retry a few times anyway.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const code = makeCode();
            const { rows: [row] } = await client.query(
                `INSERT INTO ${K} (code, plan_id, duration_days, source, created_by, created_by_username, order_id, note, gift_to, gift_message, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (code) DO NOTHING RETURNING *`,
                [code, planId, days, source, createdBy, createdByUsername, orderId, note, giftTo, giftMessage, expiresAt]);
            if (row) return row;
        }
        throw new Error('could not create a unique premium key');
    }

    /**
     * A test purchase: { userId, username, planId, period, kind, giftTo, giftMessage }.
     * Personal → the buyer's subscription is started / extended / upgraded; gift → a key
     * (valid GIFT_KEY_VALID_DAYS) is created. One transaction.
     * Returns { order, subscription|null, previous|null, next|null, key|null }.
     */
    async function purchase({ userId, username = null, planId, period, kind, giftTo = '', giftMessage = '' }) {
        if (!snowflake.test(String(userId || ''))) throw new PremiumError('Log in first.', 401);
        const q = quote({ planId, period, kind });
        const gift = kind === 'gift' ? giftDetails({ to: giftTo, message: giftMessage }) : null;
        const name = username ? clip(username, 100) : null;
        const { withTransaction: tx } = await db();
        return tx(async (client) => {
            let previous = null;
            let next = null;
            if (kind === 'personal') {
                previous = await lockedSubscription(client, userId);
                next = applyTime(previous, planId, q.days, now()); // throws before anything is written
            }
            const { rows: [order] } = await client.query(
                `INSERT INTO ${O} (user_id, username, plan_id, period, kind, amount_cents, currency, test)
                 VALUES ($1, $2, $3, $4, $5, $6, 'EUR', TRUE) RETURNING *`,
                [userId, name, planId, period, kind, q.amountCents]);
            if (!order) throw new Error('order insert returned no row');
            if (kind === 'personal') {
                const subscription = await writeSubscription(client, userId, name, next, 'purchase');
                return { order, subscription, previous, next, key: null };
            }
            const key = await insertKey(client, {
                planId, days: q.days, source: 'gift', createdBy: userId, createdByUsername: name, orderId: order.id,
                giftTo: gift.giftTo, giftMessage: gift.giftMessage, expiresAt: at(now() + GIFT_KEY_VALID_DAYS * DAY_MS),
            });
            await client.query(`UPDATE ${O} SET key_code = $2 WHERE id = $1`, [order.id, key.code]);
            order.key_code = key.code;
            return { order, subscription: null, previous: null, next: null, key };
        });
    }

    /** Redeems a key for userId. Returns { key, subscription, previous, next }. Refusals throw PremiumError. */
    async function redeem({ code, userId, username = null }) {
        if (!snowflake.test(String(userId || ''))) throw new PremiumError('Log in first.', 401);
        const normalized = normalizeKeyCode(code);
        if (!normalized) throw new PremiumError('That is not a Mewvo key. Keys look like MEWVO-ABCD-EFGH-JKMN.');
        const name = username ? clip(username, 100) : null;
        const { withTransaction: tx } = await db();
        return tx(async (client) => {
            const { rows: [key] } = await client.query(`SELECT * FROM ${K} WHERE code = $1 FOR UPDATE`, [normalized]);
            if (!key) throw new PremiumError('That key does not exist. Check it for typos.', 404);
            const status = keyStatus(key, now());
            if (status === 'revoked') throw new PremiumError('That key was cancelled and cannot be used.', 409);
            if (status === 'redeemed') throw new PremiumError('That key has already been used.', 409);
            if (status === 'expired') throw new PremiumError(`That key expired on ${new Date(key.expires_at).toISOString().slice(0, 10)}.`, 409);
            const previous = await lockedSubscription(client, userId);
            const next = applyTime(previous, key.plan_id, key.duration_days, now());
            const subscription = await writeSubscription(client, userId, name, next, 'key');
            const { rows: [used] } = await client.query(
                `UPDATE ${K} SET redeemed_by = $2, redeemed_by_username = $3, redeemed_at = NOW()
                 WHERE code = $1 AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING *`,
                [normalized, userId, name]);
            if (!used) throw new Error('premium key changed while it was being redeemed');
            return { key: used, subscription, previous, next };
        });
    }

    /**
     * What an unused key gives, for the redeem page (a gift link): { planId, days, from, giftTo,
     * giftMessage, expiresAt } or null (unknown, used, cancelled or expired: no details).
     */
    async function peekKey(code) {
        const normalized = normalizeKeyCode(code);
        if (!normalized) return null;
        const { query: q } = await db();
        const { rows: [key] } = await q(`SELECT * FROM ${K} WHERE code = $1`, [normalized]);
        if (!key || keyStatus(key, now()) !== 'unused') return null;
        return {
            planId: key.plan_id, days: key.duration_days, from: key.source === 'gift' ? key.created_by_username || null : null,
            giftTo: key.gift_to || null, giftMessage: key.gift_message || null, expiresAt: key.expires_at || null,
        };
    }

    /** Owner: `count` keys of planId for `days`, redeemable for `validDays` (0 = never). */
    async function generateKeys({ planId, days, count = 1, note = '', validDays = 0, actor }) {
        if (!paidPlan(planId)) throw new PremiumError('Choose a paid plan (Normal, Pro or Max).');
        if (!KEY_DURATIONS.some((d) => d.days === days)) throw new PremiumError('Choose one of the listed durations.');
        if (!KEY_VALIDITY.some((v) => v.days === validDays)) throw new PremiumError('Choose how long the keys can be redeemed.');
        if (!Number.isInteger(count) || count < 1 || count > MAX_KEYS_PER_BATCH) throw new PremiumError(`Create between 1 and ${MAX_KEYS_PER_BATCH} keys at a time.`);
        if (String(note || '').length > NOTE_MAX) throw new PremiumError(`The note is longer than ${NOTE_MAX} characters.`);
        if (!snowflake.test(String(actor?.userId || ''))) throw new Error('generateKeys needs the owner as actor');
        const expiresAt = validDays ? at(now() + validDays * DAY_MS) : null;
        const { withTransaction: tx } = await db();
        return tx(async (client) => {
            const rows = [];
            for (let i = 0; i < count; i += 1) {
                rows.push(await insertKey(client, {
                    planId, days, source: 'owner', createdBy: String(actor.userId),
                    createdByUsername: actor.username ? clip(actor.username, 100) : null, note: String(note || '').trim() || null, expiresAt,
                }));
            }
            return rows;
        });
    }

    /**
     * Owner: gives a plan straight to an account (same rules as a key). Returns { subscription, previous, next }.
     * source 'bonus': the early-account bonus (services/accounts/accountStore.js), otherwise 'owner'.
     */
    async function grant({ userId, planId, days, actor, source = 'owner' }) {
        if (!snowflake.test(String(userId || ''))) throw new PremiumError('Enter a Discord user ID (17–20 digits).');
        if (!paidPlan(planId)) throw new PremiumError('Choose a paid plan (Normal, Pro or Max).');
        // The early-account bonus has its own length (6 months = 183 days, accountCore.js); the owner picks a listed one.
        const durationOk = source === 'bonus' ? Number.isInteger(days) && days >= 1 && days <= 366 : KEY_DURATIONS.some((d) => d.days === days);
        if (!durationOk) throw new PremiumError('Choose one of the listed durations.');
        const { withTransaction: tx } = await db();
        return tx(async (client) => {
            const previous = await lockedSubscription(client, String(userId));
            const next = applyTime(previous, planId, days, now());
            const subscription = await writeSubscription(client, String(userId), null, next, source === 'bonus' ? 'bonus' : 'owner');
            return { subscription, previous, next, actor };
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

    /** Owner: keys, newest first. status: 'unused' | 'redeemed' | 'expired' | 'revoked' | 'all'. */
    async function listKeys({ status = 'all', limit = 200 } = {}) {
        const open = 'redeemed_at IS NULL AND revoked_at IS NULL';
        const where = {
            unused: `WHERE ${open} AND (expires_at IS NULL OR expires_at > $2)`,
            expired: `WHERE ${open} AND expires_at <= $2`,
            redeemed: 'WHERE redeemed_at IS NOT NULL AND $2::timestamptz IS NOT NULL',
            revoked: 'WHERE revoked_at IS NOT NULL AND $2::timestamptz IS NOT NULL',
            all: 'WHERE $2::timestamptz IS NOT NULL',
        }[status] ?? 'WHERE $2::timestamptz IS NOT NULL';
        const { query: q } = await db();
        const { rows } = await q(`SELECT * FROM ${K} ${where} ORDER BY created_at DESC, code LIMIT $1`, [Math.min(Math.max(1, limit), 500), at(now())]);
        const { rows: [counts] } = await q(
            `SELECT COUNT(*) FILTER (WHERE ${open} AND (expires_at IS NULL OR expires_at > $1))::int AS unused,
                    COUNT(*) FILTER (WHERE ${open} AND expires_at <= $1)::int AS expired,
                    COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL)::int AS redeemed,
                    COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
                    COUNT(*)::int AS total FROM ${K}`, [at(now())]);
        return { rows, counts };
    }

    /** Owner: subscriptions that are paid up now, soonest end first. */
    async function listActiveSubscriptions(limit = 500) {
        const { query: q } = await db();
        const { rows } = await q(`SELECT * FROM ${S} WHERE expires_at > $1 ORDER BY expires_at ASC LIMIT $2`, [at(now()), limit]);
        return rows;
    }

    /** Owner: the newest orders (all test orders). */
    async function listOrders(limit = 50) {
        const { query: q } = await db();
        const { rows } = await q(`SELECT * FROM ${O} ORDER BY created_at DESC, id DESC LIMIT $1`, [limit]);
        return rows;
    }

    /** Owner: numbers for the Premium page: active per plan, orders and amount in the last 30 days. */
    async function stats() {
        const { query: q } = await db();
        const since = at(now() - 30 * DAY_MS);
        const [{ rows: perPlan }, { rows: [orders] }] = await Promise.all([
            q(`SELECT plan_id, COUNT(*)::int AS n FROM ${S} WHERE expires_at > $1 GROUP BY plan_id`, [at(now())]),
            q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents), 0)::int AS cents,
                      COUNT(*) FILTER (WHERE kind = 'gift')::int AS gifts FROM ${O} WHERE created_at > $1`, [since]),
        ]);
        return {
            active: Object.fromEntries(perPlan.map((r) => [r.plan_id, r.n])),
            activeTotal: perPlan.reduce((sum, r) => sum + r.n, 0),
            orders30: orders?.n || 0, cents30: orders?.cents || 0, gifts30: orders?.gifts || 0,
        };
    }

    /** Owner: ends a subscription now. Returns the old row, or null when none was active. */
    async function endSubscription(userId, actor) {
        if (!snowflake.test(String(userId || ''))) return null;
        const { withTransaction: tx } = await db();
        return tx(async (client) => {
            const { rows: [row] } = await client.query(`SELECT * FROM ${S} WHERE user_id = $1 FOR UPDATE`, [String(userId)]);
            if (!isActive(row, now())) return null;
            await client.query(`UPDATE ${S} SET expires_at = $2, source = $3, ended_notified_for = $2, updated_at = NOW() WHERE user_id = $1`,
                [String(userId), at(now()), `ended by ${String(actor.userId)}`]);
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

    /** The cron: active plans ending within `withinMs` that have not had a reminder for this end date. */
    async function dueReminders(withinMs) {
        const { query: q } = await db();
        const { rows } = await q(
            `SELECT * FROM ${S} WHERE expires_at > $1 AND expires_at <= $2
             AND (reminded_for IS NULL OR reminded_for <> expires_at) ORDER BY expires_at LIMIT 100`,
            [at(now()), at(now() + withinMs)]);
        return rows;
    }

    /** The cron: plans that ended and were not announced for this end date. */
    async function dueEndings() {
        const { query: q } = await db();
        const { rows } = await q(
            `SELECT * FROM ${S} WHERE expires_at <= $1 AND plan_id IS NOT NULL
             AND (ended_notified_for IS NULL OR ended_notified_for <> expires_at) ORDER BY expires_at LIMIT 100`, [at(now())]);
        return rows;
    }

    /** Marks a reminder / ending as handled for this exact end date (an extension re-arms it). */
    async function markNotified(userId, kind, expiresAt) {
        const column = kind === 'ended' ? 'ended_notified_for' : 'reminded_for';
        const { query: q } = await db();
        // Copies the stored end date itself: a JS Date has milliseconds, Postgres keeps microseconds,
        // so "= $2" could miss and the DM would repeat. Within 1 ms counts as the same end date.
        await q(`UPDATE ${S} SET ${column} = expires_at WHERE user_id = $1 AND ABS(EXTRACT(EPOCH FROM (expires_at - $2::timestamptz))) < 0.001`, [String(userId), expiresAt]);
    }

    return {
        purchase, redeem, peekKey, generateKeys, grant, revokeKey, listKeys, listActiveSubscriptions, listOrders, stats,
        endSubscription, accountOf, dueReminders, dueEndings, markNotified,
    };
}

export const premiumStore = createPremiumStore();
