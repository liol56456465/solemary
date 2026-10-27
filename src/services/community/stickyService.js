// stickyService.js — sticky messages (/community sticky set | remove | list).
//
// A sticky is a short bot message kept at the bottom of a channel: after a
// member posts there, the bot deletes its previous copy and posts it again.
// Reposts are debounced per channel (at most one every STICKY_MIN_INTERVAL_MS,
// and a burst of messages coalesces into one repost).
//
// All stickies are held in memory (loaded at startup, updated on every change),
// so messageCreate never reads the database. The table is written when a sticky
// is set/removed and when it is reposted (its new message id).

import { logger } from '../../utils/logger.js';
import { createEmbed } from '../../utils/embeds.js';
import { CT, query, isCommunityDbAvailable, userError } from './db.js';

export const STICKY_MAX_LENGTH = 1800;
export const STICKY_MIN_INTERVAL_MS = 15_000;
// A short wait after the last message even when the interval has passed, so a
// burst of messages produces one repost instead of several.
export const STICKY_SETTLE_MS = 2_000;
export const STICKY_MAX_PER_GUILD = 10;

// channelId → { guildId, content, lastMessageId, lastPostAt, timer }
const stickies = new Map();
let loaded = false;

/** How long to wait before reposting; pure. */
export function nextRepostDelay(now, lastPostAt, interval = STICKY_MIN_INTERVAL_MS, settle = STICKY_SETTLE_MS) {
    return Math.max(settle, (lastPostAt || 0) + interval - now);
}

export function buildStickyPayload(content) {
    return {
        embeds: [createEmbed({ description: content, color: 'primary', footer: { text: '📌 Sticky message' } })],
        allowedMentions: { parse: [] },
    };
}

function toEntry(row, previous) {
    return {
        guildId: row.guild_id,
        content: row.content,
        lastMessageId: row.last_message_id || null,
        lastPostAt: previous?.lastPostAt || 0,
        timer: previous?.timer || null,
    };
}

export async function loadStickies() {
    if (!isCommunityDbAvailable()) return null;
    const { rows } = await query(`SELECT channel_id, guild_id, content, last_message_id FROM ${CT.sticky}`);
    for (const row of rows) stickies.set(row.channel_id, toEntry(row, stickies.get(row.channel_id)));
    loaded = true;
    return rows.length;
}

export function isStickyCacheLoaded() {
    return loaded;
}

/** Stickies of a guild, from memory: [{ channelId, content, lastMessageId }]. */
export function listStickies(guildId) {
    return [...stickies.entries()]
        .filter(([, entry]) => entry.guildId === guildId)
        .map(([channelId, entry]) => ({ channelId, content: entry.content, lastMessageId: entry.lastMessageId }));
}

export function getSticky(channelId) {
    return stickies.get(channelId) || null;
}

async function deletePosted(channel, messageId) {
    if (!messageId) return;
    await channel.messages.delete(messageId).catch((error) => {
        if (error?.code !== 10008) logger.debug(`Sticky: could not delete ${messageId} in ${channel.id}: ${error.message}`);
    });
}

/** Deletes the previous copy and posts the sticky again; records the new id. */
async function repost(channel) {
    const entry = stickies.get(channel.id);
    if (!entry) return false;
    entry.timer = null;
    const previous = entry.lastMessageId;
    entry.lastPostAt = Date.now();
    const sent = await channel.send(buildStickyPayload(entry.content)).catch((error) => {
        logger.warn(`Sticky: could not post in ${channel.id}: ${error.message}`);
        return null;
    });
    if (!sent) return false;
    // The sticky may have been removed while the message was being sent.
    if (stickies.get(channel.id) !== entry) {
        await deletePosted(channel, sent.id);
        return false;
    }
    entry.lastMessageId = sent.id;
    await deletePosted(channel, previous);
    await query(`UPDATE ${CT.sticky} SET last_message_id = $2 WHERE channel_id = $1`, [channel.id, sent.id])
        .catch((error) => logger.warn(`Sticky: could not save message id for ${channel.id}: ${error.message}`));
    return true;
}

/**
 * messageCreate hook (member messages only): schedules a repost for a channel
 * with a sticky. One Map lookup when the channel has none; never throws.
 */
export function noteStickyActivity(message) {
    try {
        const entry = stickies.get(message.channel?.id);
        if (!entry || entry.timer || message.author?.bot) return false;
        const channel = message.channel;
        entry.timer = setTimeout(() => {
            repost(channel).catch((error) => logger.warn(`Sticky repost failed in ${channel.id}: ${error.message}`));
        }, nextRepostDelay(Date.now(), entry.lastPostAt));
        entry.timer.unref?.();
        return true;
    } catch (error) {
        logger.warn(`Sticky check failed: ${error.message}`);
        return false;
    }
}

/** Creates or replaces the sticky of a channel and posts it now. */
export async function setSticky({ guildId, channel, content, updatedBy }) {
    const text = String(content || '').trim();
    if (!text) throw userError('The sticky message cannot be empty.');
    if (text.length > STICKY_MAX_LENGTH) throw userError(`Sticky messages are limited to ${STICKY_MAX_LENGTH} characters.`);
    if (!stickies.has(channel.id) && listStickies(guildId).length >= STICKY_MAX_PER_GUILD) {
        throw userError(`A server can have at most ${STICKY_MAX_PER_GUILD} sticky messages. Remove one first.`);
    }
    const { rows: [row] } = await query(
        `INSERT INTO ${CT.sticky} (channel_id, guild_id, content, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (channel_id) DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING channel_id, guild_id, content, last_message_id`,
        [channel.id, guildId, text, updatedBy]
    );
    const previous = stickies.get(channel.id);
    if (previous?.timer) clearTimeout(previous.timer);
    stickies.set(channel.id, { ...toEntry(row, previous), timer: null });
    const posted = await repost(channel);
    return { posted };
}

/** Removes the sticky of a channel; true when there was one. */
export async function removeSticky({ channelId, channel = null }) {
    const { rows: [row] } = await query(`DELETE FROM ${CT.sticky} WHERE channel_id = $1 RETURNING last_message_id`, [channelId]);
    const entry = stickies.get(channelId);
    if (entry?.timer) clearTimeout(entry.timer);
    stickies.delete(channelId);
    if (channel) await deletePosted(channel, row?.last_message_id || entry?.lastMessageId);
    return Boolean(row || entry);
}

/** For tests: replace the in-memory stickies. */
export function setStickiesForTests(rows) {
    for (const entry of stickies.values()) if (entry.timer) clearTimeout(entry.timer);
    stickies.clear();
    for (const row of rows) stickies.set(row.channel_id, toEntry(row));
    loaded = true;
}
