// noContactService.js — no-contact orders (/case nocontact add | list | end).
//
// While an order is active, neither member may mention or reply to the other:
// such a message is deleted, the author gets a short notice that deletes itself,
// and the mod log gets one 'nocontact' line. Both members are DMed when an order
// starts and when it ends (early by staff, or on expiry).
//
// Active orders are held in memory (loaded at startup, reloaded after every
// change and by the expiry job), so messageCreate never reads the database. An
// order past its `until` stops being enforced at once, even before the expiry job
// marks it ended.

import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { query, T, isUniqueViolation, isEnforcementDbAvailable } from './db.js';
import { postModLog, sendDm } from './enforcementService.js';
import { noContactEndedDm, noContactStartedDm } from './dmTemplates.js';
import { truncate } from './format.js';

export const NO_CONTACT_MAX_DAYS = 365;
const NOTICE_DELETE_MS = 8000;
const LOG_COOLDOWN_MS = 60 * 1000;

// guildId:userId → [{ id, otherId, until (ms) }]
let byMember = new Map();
let loaded = false;
const lastLogged = new Map(); // orderId:authorId → ms

function userError(message) {
    return createError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** The pair in storage order (smaller ID first). */
export function orderedPair(a, b) {
    return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/** Builds the member → orders index from active rows; pure. */
export function buildIndex(rows) {
    const index = new Map();
    const push = (guildId, userId, entry) => {
        const key = `${guildId}:${userId}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(entry);
    };
    for (const row of rows) {
        const until = new Date(row.until).getTime();
        push(row.guild_id, row.user_a, { id: Number(row.id), otherId: row.user_b, until });
        push(row.guild_id, row.user_b, { id: Number(row.id), otherId: row.user_a, until });
    }
    return index;
}

/** Reloads the active orders into memory. Keeps the old cache when the database fails. */
export async function refreshNoContactCache() {
    const { rows } = await query(
        `SELECT id, guild_id, user_a, user_b, until FROM ${T.noContact} WHERE ended_at IS NULL AND until > NOW()`
    );
    byMember = buildIndex(rows);
    loaded = true;
    return rows.length;
}

export async function loadNoContactOrders() {
    if (!isEnforcementDbAvailable()) return null;
    return refreshNoContactCache();
}

async function refreshQuietly() {
    await refreshNoContactCache().catch((error) => logger.warn(`No-contact cache refresh failed: ${error.message}`));
}

export function isNoContactCacheLoaded() {
    return loaded;
}

/** Active orders for a member, from memory: [{ id, otherId, until }]. */
export function getActiveOrdersFor(guildId, userId, now = Date.now()) {
    return (byMember.get(`${guildId}:${userId}`) || []).filter((order) => order.until > now);
}

/**
 * The order a message breaks, or null: the author mentions or replies to the
 * other member of one of their active orders. `orders` from getActiveOrdersFor.
 */
export function findViolation(message, orders) {
    if (!orders.length) return null;
    const mentioned = message.mentions?.users;
    const repliedTo = message.mentions?.repliedUser?.id
        || (message.reference?.messageId && message.channel?.messages?.cache?.get(message.reference.messageId)?.author?.id)
        || null;
    for (const order of orders) {
        if (repliedTo === order.otherId) return { order, how: 'replied to' };
        if (mentioned?.has?.(order.otherId)) return { order, how: 'mentioned' };
    }
    return null;
}

/**
 * messageCreate hook: deletes a message that breaks a no-contact order. Returns
 * true when the message was removed. Cheap when the author has no order (one Map
 * lookup); never throws.
 */
export async function enforceNoContact(message) {
    try {
        if (!message.guild || message.author?.bot) return false;
        const orders = getActiveOrdersFor(message.guild.id, message.author.id);
        const violation = findViolation(message, orders);
        if (!violation) return false;

        const { order, how } = violation;
        const deleted = await message.delete().then(() => true).catch((error) => {
            logger.warn(`No-contact: could not delete message ${message.id}: ${error.message}`);
            return false;
        });
        const other = message.client.users.cache.get(order.otherId);
        const notice = await message.channel.send({
            content: `<@${message.author.id}> you have a no-contact order with **${other ? truncate(other.username, 50) : 'that member'}** `
                + `until <t:${Math.floor(order.until / 1000)}:f>. Don't mention or reply to them${deleted ? '; your message was removed' : ''}.`,
            allowedMentions: { users: [message.author.id], parse: [] },
        }).catch(() => null);
        if (notice) setTimeout(() => notice.delete().catch(() => {}), NOTICE_DELETE_MS).unref?.();

        const key = `${order.id}:${message.author.id}`;
        if (Date.now() - (lastLogged.get(key) || 0) >= LOG_COOLDOWN_MS) {
            lastLogged.set(key, Date.now());
            if (lastLogged.size > 1000) lastLogged.delete(lastLogged.keys().next().value);
            await postModLog(message.client, 'nocontact', [
                { name: 'User', value: `${message.author.username} (${message.author.id})` },
                { name: 'Note', value: `${deleted ? 'message removed' : 'message could NOT be removed'}: ${how} <@${order.otherId}> in <#${message.channel.id}>` },
                { name: 'Order', value: `#${order.id}` },
            ]);
        }
        return deleted;
    } catch (error) {
        logger.warn(`No-contact check failed: ${error.message}`);
        return false;
    }
}

async function dmBoth(client, row, build) {
    const [a, b] = await Promise.all([
        client.users.fetch(row.user_a).catch(() => null),
        client.users.fetch(row.user_b).catch(() => null),
    ]);
    const results = await Promise.all([
        a ? sendDm(a, build(row, b)) : false,
        b ? sendDm(b, build(row, a)) : false,
    ]);
    return { a, b, delivered: results };
}

function pairLabel(a, b, row) {
    return `${a?.username || row.user_a} (${row.user_a}) ↔ ${b?.username || row.user_b} (${row.user_b})`;
}

/** Starts an order. Returns { order, delivered: [bool, bool] }. */
export async function addNoContactOrder(client, { guildId, userA, userB, days, reason, createdBy }) {
    if (userA === userB) throw userError('Pick two different members.');
    if (!Number.isInteger(days) || days < 1 || days > NO_CONTACT_MAX_DAYS) {
        throw userError(`days must be between 1 and ${NO_CONTACT_MAX_DAYS}.`);
    }
    const text = String(reason || '').trim();
    if (!text) throw userError('A reason is required.');
    const [a, b] = orderedPair(userA, userB);

    // An order that already ran out but was not marked ended yet must not block a new one.
    await query(
        `UPDATE ${T.noContact} SET ended_at = until WHERE guild_id = $1 AND user_a = $2 AND user_b = $3
           AND ended_at IS NULL AND until <= NOW()`,
        [guildId, a, b]
    );
    let row;
    try {
        ({ rows: [row] } = await query(
            `INSERT INTO ${T.noContact} (guild_id, user_a, user_b, until, created_by, reason)
             VALUES ($1, $2, $3, NOW() + make_interval(days => $4), $5, $6) RETURNING *`,
            [guildId, a, b, days, createdBy.id, text.slice(0, 500)]
        ));
    } catch (error) {
        if (isUniqueViolation(error, 'no_contact')) {
            const { rows: [open] } = await query(
                `SELECT id FROM ${T.noContact} WHERE guild_id = $1 AND user_a = $2 AND user_b = $3 AND ended_at IS NULL`,
                [guildId, a, b]
            );
            throw userError(`These two already have an active no-contact order (#${open?.id ?? '?'}). End it first to change it.`);
        }
        throw error;
    }
    await refreshQuietly();

    const { a: userObjA, b: userObjB, delivered } = await dmBoth(client, row, noContactStartedDm);
    await postModLog(client, 'nocontact', [
        { name: 'User', value: pairLabel(userObjA, userObjB, row) },
        { name: 'Moderator', value: `${createdBy.username} (${createdBy.id})` },
        { name: 'Note', value: `order #${row.id} started, until <t:${Math.floor(new Date(row.until).getTime() / 1000)}:f>` },
        { name: 'Reason', value: row.reason },
    ]);
    return { order: row, delivered };
}

/** Ends an active order early. Returns { order, delivered } or null when there is no such active order. */
export async function endNoContactOrder(client, { guildId, id, endedBy }) {
    const { rows: [row] } = await query(
        `UPDATE ${T.noContact} SET ended_at = NOW(), ended_by = $3
         WHERE guild_id = $1 AND id = $2 AND ended_at IS NULL RETURNING *`,
        [guildId, id, endedBy.id]
    );
    if (!row) return null;
    await refreshQuietly();
    const { a, b, delivered } = await dmBoth(client, row, (order, other) => noContactEndedDm(order, other, { early: true }));
    await postModLog(client, 'nocontact', [
        { name: 'User', value: pairLabel(a, b, row) },
        { name: 'Moderator', value: `${endedBy.username} (${endedBy.id})` },
        { name: 'Note', value: `order #${row.id} ended early` },
    ]);
    return { order: row, delivered };
}

/** Marks orders past their end as ended and DMs both members; run every minute. */
export async function expireNoContactOrders(client) {
    if (!isEnforcementDbAvailable()) return 0;
    // The startup load may have missed the database; catch up here.
    if (!loaded) await refreshQuietly();
    const { rows } = await query(
        `UPDATE ${T.noContact} SET ended_at = NOW() WHERE ended_at IS NULL AND until <= NOW() RETURNING *`
    );
    if (!rows.length) return 0;
    await refreshQuietly();
    for (const row of rows) {
        const { a, b } = await dmBoth(client, row, (order, other) => noContactEndedDm(order, other, { early: false }));
        if (row.guild_id === enforcementConfig.mainGuildId) {
            await postModLog(client, 'nocontact', [
                { name: 'User', value: pairLabel(a, b, row) },
                { name: 'Note', value: `order #${row.id} expired` },
            ]);
        }
    }
    return rows.length;
}

/** Active orders in a guild, newest first (from the database). */
export async function listActiveNoContactOrders(guildId, limit = 25) {
    const { rows } = await query(
        `SELECT * FROM ${T.noContact} WHERE guild_id = $1 AND ended_at IS NULL AND until > NOW()
         ORDER BY created_at DESC LIMIT $2`,
        [guildId, limit]
    );
    return rows;
}

/** "No-contact: with <@id> until … (#3)" lines for the panel and /background; pure. */
export function noContactLines(orders) {
    return orders.map((order) => `with <@${order.otherId}> until <t:${Math.floor(order.until / 1000)}:f> (order #${order.id})`);
}

/** For tests: replace the in-memory index. */
export function setNoContactCacheForTests(rows) {
    byMember = buildIndex(rows);
    loaded = true;
}
