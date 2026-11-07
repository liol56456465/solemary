// premiumEffects.js — what an active plan does in Discord (TEST CHECKOUT ONLY; premiumService.js).
//
//   - Cache: active plans in memory (user id → plan, end), loaded at startup and refreshed by
//     every change and by the cron, so limit checks stay synchronous and cheap.
//   - Limits: a server's tags, sticky messages, YouTube feeds and scheduled messages are capped
//     by the plan of the server's OWNER (plans.js `limits`; Free = the old fixed numbers).
//   - Supporter role: setting premiumRoleIds { normal, pro, max } in the main server. An active
//     plan gives its role and takes the other tier roles off; no plan → all tier roles off.
//     Synced right after a change, on rejoin and every 5 minutes (also catches expiry).
//   - DMs: "your plan is active" after a purchase / key / owner grant, "ends in 3 days" and
//     "has ended" from the cron (once per end date; an extension re-arms them). A failed DM is
//     logged, never an error for the purchase.
// Every Discord step is best effort: the subscription in the database is the truth.

import { PLANS } from '../../config/site/plans.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { getRoleAssignmentProblem } from '../../utils/roleSafety.js';
import { getConfiguredSetting } from '../settings/guildSettings.js';
import { PERIODS, WITHDRAWAL_DAYS, isActive, orderCurrency, planName, withdrawalDeadline } from './premiumService.js';
import { formatPrice } from '../../config/site/plans.js';

export const REMINDER_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
const FREE = PLANS.find((plan) => plan.id === 'free');
const PAID_IDS = ['normal', 'pro', 'max'];

// ── Cache ─────────────────────────────────────────────────────────────────

const cache = new Map(); // user id → { planId, expiresAt (ms) }
let loaded = false;

export function setPremiumCache(rows = []) {
    cache.clear();
    for (const row of rows) notePremium(row);
    loaded = true;
}

/** One subscription row (user_id, plan_id, expires_at) into the cache; ended rows are dropped. */
export function notePremium(row, now = Date.now()) {
    if (!row?.user_id) return;
    if (isActive(row, now) && row.plan_id) cache.set(String(row.user_id), { planId: row.plan_id, expiresAt: new Date(row.expires_at).getTime() });
    else cache.delete(String(row.user_id));
}

export const isPremiumCacheLoaded = () => loaded;

/** The active plan id of a user ('free' when none). */
export function planOf(userId, now = Date.now()) {
    const hit = userId ? cache.get(String(userId)) : null;
    return hit && hit.expiresAt > now ? hit.planId : 'free';
}

export async function loadPremiumCache(store) {
    setPremiumCache(await store.listActiveSubscriptions(5000));
    return cache.size;
}

// ── Limits ────────────────────────────────────────────────────────────────

let ownerOfGuild = () => null;

/** app.js: how to find a server's owner id (from the gateway cache). */
export function setGuildOwnerResolver(fn) {
    ownerOfGuild = typeof fn === 'function' ? fn : () => null;
}

/** The plan that sets a server's limits: its owner's. */
export function guildPlan(guildId, now = Date.now()) {
    let ownerId = null;
    try { ownerId = ownerOfGuild(guildId); } catch { ownerId = null; }
    return planOf(ownerId, now);
}

/** A server's limit for `kind` (tags | stickies | feeds | scheduled | customRules). */
export function planLimit(guildId, kind, now = Date.now()) {
    const plan = PLANS.find((p) => p.id === guildPlan(guildId, now)) || FREE;
    return plan.limits?.[kind] ?? FREE.limits[kind];
}

/** The refusal text when a limit is reached, with a hint at the next plan. */
export function limitMessage(guildId, kind, noun) {
    const limit = planLimit(guildId, kind);
    const current = guildPlan(guildId);
    const higher = PLANS.find((p) => (p.limits?.[kind] ?? 0) > limit);
    const plan = current === 'free' ? 'Free' : planName(current);
    return `A server can have at most ${limit} ${noun} on the ${plan} plan.${higher ? ` ${higher.name} raises it to ${higher.limits[kind]}.` : ''}`;
}

// ── Roles ─────────────────────────────────────────────────────────────────

/**
 * The configured tier roles: { normal, pro, max } (ids or null). Home-only by design (multi-server
 * B0b): supporter roles live in Mewvo's main server, whatever server the subscription is for.
 */
export function tierRoles(read = () => getConfiguredSetting('premiumRoleIds')) {
    let value = null;
    try { value = read(); } catch { value = null; }
    return Object.fromEntries(PAID_IDS.map((id) => [id, value?.[id] || null]));
}

/** Which tier roles to add and remove for this member: { add: [ids], remove: [ids] }. Pure. */
export function roleChanges(heldRoleIds, planId, roles) {
    const held = new Set(heldRoleIds);
    const want = planId && planId !== 'free' ? roles[planId] || null : null;
    const remove = Object.values(roles).filter((id) => id && id !== want && held.has(id));
    return { add: want && !held.has(want) ? [want] : [], remove: [...new Set(remove)] };
}

/** Brings one member's tier roles in line with their plan. Returns the changes made (or null). */
export async function syncPremiumRole(client, userId, { now = Date.now(), roles = tierRoles() } = {}) {
    if (!Object.values(roles).some(Boolean)) return null;
    const guild = client?.guilds?.cache?.get(enforcementConfig.mainGuildId);
    if (!guild) return null;
    const member = await guild.members.fetch(String(userId)).catch(() => null);
    if (!member) return null;
    const changes = roleChanges([...member.roles.cache.keys()], planOf(userId, now), roles);
    for (const roleId of changes.add) {
        const role = guild.roles.cache.get(roleId);
        const problem = getRoleAssignmentProblem(role, guild.members.me);
        if (problem) {
            logger.warn(`Supporter role ${roleId} not given to ${userId}: ${problem}`);
            continue;
        }
        await member.roles.add(roleId, 'Mewvo plan active').catch((error) => logger.warn(`Supporter role not given to ${userId}: ${error.message}`));
    }
    for (const roleId of changes.remove) {
        await member.roles.remove(roleId, 'Mewvo plan ended or changed').catch((error) => logger.warn(`Supporter role not removed from ${userId}: ${error.message}`));
    }
    return changes;
}

// ── DMs ───────────────────────────────────────────────────────────────────

const ts = (date, style) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

/** The DM texts. Pure. */
export function premiumDm(kind, { planId, expiresAt, converted = null, from = null }) {
    const plan = `Mewvo ${planName(planId)}`;
    const until = `${ts(expiresAt, 'F')} (${ts(expiresAt, 'R')})`;
    if (kind === 'active') {
        const how = from === 'key' ? 'A key was redeemed on your account.' : from === 'owner' ? 'The bot owner gave you a plan.'
            : from === 'bonus' ? 'A bonus for being one of the first 100 Mewvo accounts to link Discord.' : 'Thanks for your purchase (test order).';
        const up = converted ? ` Your remaining ${planName(converted.fromPlanId)} time was converted into ${planName(planId)} time.` : '';
        return `**${plan} is active** until ${until}.\n${how}${up}\nSee it any time with \`/premium status\`.`;
    }
    if (kind === 'reminder') return `**${plan} ends soon:** ${until}.\nAdd time on the website (Pricing) or redeem a key with \`/premium redeem\`.`;
    return `**${plan} has ended.** Your account is on Free again; nothing was deleted.\nYou can start a plan again from the website (Pricing) or with a key.`;
}

/** An amount in the order's own payment currency (never an approximation). */
const price = (order, cents) => formatPrice(cents, orderCurrency(order));
const sellerText = (seller) => [seller?.operator || 'Mewvo', seller?.email || null].filter(Boolean).join(', ');

/**
 * The order confirmation sent as a Discord DM (CRD Art. 8(7), confirmation on a durable
 * medium): order, plan, price + VAT line, dates, the consent given, terms version, how to
 * withdraw. Pure; stays well under Discord's 2000 characters.
 */
export function orderConfirmationDm({ order, subscription = null, key = null, origin = '', seller = null, vatText = '', termsVersion = '' }) {
    const gift = order.kind === 'gift';
    const created = order.created_at || new Date();
    const lines = [
        `**Order confirmation #${order.id}**${order.test ? ' (TEST ORDER: no money was taken)' : ''}`,
        `Seller: ${sellerText(seller)}${origin ? ` (${origin}/legal)` : ''}`,
        `Plan: Mewvo ${planName(order.plan_id)}, ${PERIODS[order.period]?.label || order.period} (${PERIODS[order.period]?.days || '?'} days)${gift ? ', as a gift key' : ''}`,
        `Total: ${price(order, order.amount_cents)}. ${vatText}`.trim(),
        'No automatic renewal: the plan ends unless you buy more time.',
        `Ordered: ${ts(created, 'F')}`,
    ];
    if (!gift && subscription?.expires_at) lines.push(`Your plan runs until ${ts(subscription.expires_at, 'F')}.`);
    if (gift && key?.code) lines.push(`Gift key: ending ${String(key.code).slice(-4)} (the full key is on your receipt page).`);
    const consent = order.legal?.consent;
    if (consent) lines.push(`You confirmed: "${consent.texts?.[0] || ''}" (${consent.version})`);
    lines.push(`Terms and Conditions version ${termsVersion || '-'}${origin ? `: ${origin}/terms` : ''}`);
    lines.push(`Right of withdrawal: ${WITHDRAWAL_DAYS} days, until ${ts(withdrawalDeadline({ created_at: created }), 'F')}.${gift ? ' The right is yours as the buyer, not the recipient\'s.' : ''} How: ${origin ? `${origin}/withdrawal` : '/withdrawal'}`);
    if (origin) lines.push(`Receipt: ${origin}/me/billing/orders/${order.id}`);
    return lines.join('\n').slice(0, 1900);
}

/** The acknowledgement of a withdrawal (CRD Art. 11a(4)): its content and date and time. Pure. */
export function withdrawalAckDm({ order, withdrawal, origin = '', seller = null }) {
    const lines = [
        `**We received your withdrawal from order #${order.id}**${order.test ? ' (TEST ORDER)' : ''}`,
        `Received: ${ts(withdrawal.at, 'F')} (${new Date(withdrawal.at).toISOString().replace('T', ' ').slice(0, 19)} UTC)`,
        `Name given: ${withdrawal.name}`,
        `Contract: Mewvo ${planName(order.plan_id)}, ${PERIODS[order.period]?.label || order.period}, ordered ${ts(order.created_at, 'F')}, ${price(order, order.amount_cents)}`,
        'Statement: I withdraw from my contract for this order.',
        `Days used: ${withdrawal.usedDays} of ${withdrawal.totalDays}. Refund due: ${price(order, withdrawal.refundCents)}${withdrawal.refundStatus === 'test-not-paid' ? ' (test order: nothing was charged, so nothing is paid back)' : ', paid back within 14 days with the payment method you used'}.`,
        `Seller: ${sellerText(seller)}`,
    ];
    if (origin) lines.push(`Details: ${origin}/me/billing/orders/${order.id}/withdrawal`);
    return lines.join('\n').slice(0, 1900);
}

/** A DM with no pings (allowedMentions none). true when delivered; never throws. */
export async function sendPremiumDm(userId, content, { client = premiumClient } = {}) {
    if (!client) return false;
    return dm(client, userId, content);
}

async function dm(client, userId, content) {
    try {
        const user = await client.users.fetch(String(userId));
        await user.send({ content, allowedMentions: { parse: [] } });
        return true;
    } catch (error) {
        logger.info(`Premium DM to ${userId} not delivered: ${error.message}`);
        return false;
    }
}

// ── After a change (purchase, key, grant, end) ────────────────────────────

let premiumClient = null;

/** app.js: the logged-in client, so changes made on the website reach Discord. */
export function setPremiumClient(client) {
    premiumClient = client || null;
}

/**
 * Cache + role + DM after a change. result: { subscription, next } from the store; from:
 * 'purchase' | 'key' | 'owner' | 'bonus' | 'ended'. Never throws.
 */
export async function afterPremiumChange(result, from, { client = premiumClient, sendDm = true } = {}) {
    try {
        const row = result?.subscription;
        if (!row) return;
        notePremium(from === 'ended' ? { ...row, expires_at: new Date(0) } : row);
        if (!client) return;
        await syncPremiumRole(client, row.user_id);
        if (from !== 'ended' && sendDm) await dm(client, row.user_id, premiumDm('active', { planId: row.plan_id, expiresAt: row.expires_at, converted: result.next?.converted || null, from }));
    } catch (error) {
        logger.warn(`Premium follow-up for ${result?.subscription?.user_id} failed: ${error.message}`);
    }
}

// ── Cron (every 5 minutes) ────────────────────────────────────────────────

/**
 * Reminders 3 days before the end, "has ended" DMs, the cache from the database, and the
 * tier roles of everyone holding one or having a plan. Returns counts.
 */
export async function runPremiumCron(client, store, { now = Date.now() } = {}) {
    const out = { reminded: 0, ended: 0, synced: 0 };
    for (const row of await store.dueReminders(REMINDER_BEFORE_MS)) {
        await dm(client, row.user_id, premiumDm('reminder', { planId: row.plan_id, expiresAt: row.expires_at }));
        await store.markNotified(row.user_id, 'reminder', row.expires_at);
        out.reminded += 1;
    }
    for (const row of await store.dueEndings()) {
        await dm(client, row.user_id, premiumDm('ended', { planId: row.plan_id, expiresAt: row.expires_at }));
        await store.markNotified(row.user_id, 'ended', row.expires_at);
        out.ended += 1;
    }
    setPremiumCache(await store.listActiveSubscriptions(5000));
    const roles = tierRoles();
    if (!Object.values(roles).some(Boolean)) return out;
    const guild = client?.guilds?.cache?.get(enforcementConfig.mainGuildId);
    if (!guild) return out;
    const users = new Set(cache.keys());
    for (const roleId of Object.values(roles).filter(Boolean)) {
        for (const memberId of guild.roles.cache.get(roleId)?.members?.keys?.() || []) users.add(memberId);
    }
    for (const userId of users) {
        const changes = await syncPremiumRole(client, userId, { now, roles });
        if (changes && (changes.add.length || changes.remove.length)) out.synced += 1;
    }
    return out;
}
