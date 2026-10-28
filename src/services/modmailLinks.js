// modmailLinks.js — which member each modmail channel belongs to, stored in modmail_links.
// The database is the only source of truth; the channel topic is never trusted (anyone with
// Manage Channels could create a channel whose topic names another member and receive that
// member's DMs to the bot). The rows are mirrored in memory after they are read or written,
// because the relay checks every message in the main server.
//
// Channels opened before this table existed carried "modmail:<userId>" in the topic. They are
// imported once (logged per channel), then a flag stops any later import, so a topic faked
// afterwards changes nothing.

import { query, T } from './enforcement/db.js';
import { db } from '../utils/database/wrapper.js';
import { logger } from '../utils/logger.js';

const LEGACY_TOPIC = /^modmail:(\d{17,20})$/;
const importFlagKey = (guildId) => `modmail:links:imported:${guildId}`;

const byChannel = new Map(); // channelId → { guildId, userId }
const byUser = new Map(); // `${guildId}:${userId}` → channelId
let loading = null;

function remember(guildId, channelId, userId) {
    byChannel.set(channelId, { guildId, userId });
    byUser.set(`${guildId}:${userId}`, channelId);
}

function forget(channelId) {
    const link = byChannel.get(channelId);
    if (!link) return;
    byChannel.delete(channelId);
    if (byUser.get(`${link.guildId}:${link.userId}`) === channelId) byUser.delete(`${link.guildId}:${link.userId}`);
}

/** Reads every link once (later calls wait for the same read). */
export function loadModmailLinks() {
    loading ??= (async () => {
        const { rows } = await query(`SELECT channel_id, guild_id, user_id FROM ${T.modmailLinks}`);
        for (const row of rows) remember(row.guild_id, row.channel_id, row.user_id);
    })().catch((error) => {
        loading = null; // try again on the next call
        throw error;
    });
    return loading;
}

/** The member this channel belongs to, or null. */
export async function linkedUserId(channel) {
    if (!channel?.id) return null;
    await loadModmailLinks();
    return byChannel.get(channel.id)?.userId ?? null;
}

/** The member's modmail channel id in this server, or null. */
export async function linkedChannelId(guildId, userId) {
    await loadModmailLinks();
    return byUser.get(`${guildId}:${userId}`) ?? null;
}

export async function linkModmailChannel(guildId, channelId, userId) {
    await loadModmailLinks();
    await query(`INSERT INTO ${T.modmailLinks} (channel_id, guild_id, user_id) VALUES ($1, $2, $3)`, [channelId, guildId, userId]);
    remember(guildId, channelId, userId);
}

export async function unlinkModmailChannel(channelId) {
    await loadModmailLinks();
    await query(`DELETE FROM ${T.modmailLinks} WHERE channel_id = $1`, [channelId]);
    forget(channelId);
}

/**
 * One time per server: links channels opened before modmail_links existed, from their
 * "modmail:<userId>" topic. Returns the number imported, or null when it already ran.
 */
export async function importModmailTopicsOnce(guild) {
    if (!guild) return null;
    if (await db.get(importFlagKey(guild.id), null)) return null;
    await loadModmailLinks();
    let imported = 0;
    for (const channel of guild.channels.cache.values()) {
        const match = LEGACY_TOPIC.exec(String(channel.topic || '').trim());
        if (!match || byChannel.has(channel.id) || byUser.has(`${guild.id}:${match[1]}`)) continue;
        await linkModmailChannel(guild.id, channel.id, match[1]);
        logger.warn(`Modmail import: channel ${channel.id} (#${channel.name}) linked to member ${match[1]} from its topic (one-time import)`);
        imported += 1;
    }
    await db.set(importFlagKey(guild.id), { at: new Date().toISOString(), imported });
    logger.info(`Modmail import done in ${guild.id}: ${imported} open channel(s) linked; from now on only modmail_links counts`);
    return imported;
}

/** Tests only: forget the in-memory mirror. */
export function resetModmailLinksForTests() {
    byChannel.clear();
    byUser.clear();
    loading = null;
}
