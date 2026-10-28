// modmailLinks.js — which member each modmail channel belongs to, stored in modmail_links.
// The database is the only source of truth; the channel topic is never trusted (anyone with
// Manage Channels could create a channel whose topic names another member and receive that
// member's DMs to the bot). The rows are mirrored in memory after they are read or written,
// because the relay checks every message in the main server.
//
// Channels opened before this table existed carried "modmail:<userId>" in the topic. They are
// imported once (logged per channel), then a flag stops any later import, so a topic faked
// afterwards changes nothing. Even that one import only takes channels that look bot-made: a
// text channel in the modmail or ticket category, @everyone denied, the bot allowed Manage
// Channels. Two channels claiming the same member: neither is imported and staff are alerted.

import { query, T } from './enforcement/db.js';
import { db } from '../utils/database/wrapper.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { enforcementConfig } from '../config/enforcement.js';
import { getGuildConfig } from './config/guildConfig.js';

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
    const config = await getGuildConfig(guild.client, guild.id).catch(() => ({}));
    const parents = new Set([enforcementConfig.modmailCategoryId, config?.ticketCategoryId].filter(Boolean));
    const botId = guild.members?.me?.id || guild.client?.user?.id;
    const looksBotMade = (channel) => {
        const overwrites = channel.permissionOverwrites?.cache;
        return channel.type === ChannelType.GuildText && parents.has(channel.parentId)
            && Boolean(overwrites?.get(guild.id)?.deny?.has?.(PermissionFlagsBits.ViewChannel))
            && Boolean(overwrites?.get(botId)?.allow?.has?.(PermissionFlagsBits.ManageChannels));
    };

    const claims = new Map(); // userId → [channel]
    for (const channel of guild.channels.cache.values()) {
        const match = LEGACY_TOPIC.exec(String(channel.topic || '').trim());
        if (!match || byChannel.has(channel.id)) continue;
        if (!looksBotMade(channel)) {
            logger.warn(`Modmail import: skipped #${channel.name} (${channel.id}): its topic names ${match[1]} but it does not look like a channel the bot opened`);
            continue;
        }
        claims.set(match[1], [...(claims.get(match[1]) || []), channel]);
    }
    let imported = 0;
    const disputed = [];
    for (const [userId, channels] of claims) {
        if (byUser.has(`${guild.id}:${userId}`)) continue;
        if (channels.length > 1) {
            disputed.push(`member ${userId}: ${channels.map((c) => `#${c.name} (${c.id})`).join(', ')}`);
            continue;
        }
        await linkModmailChannel(guild.id, channels[0].id, userId);
        logger.warn(`Modmail import: channel ${channels[0].id} (#${channels[0].name}) linked to member ${userId} from its topic (one-time import)`);
        imported += 1;
    }
    if (disputed.length) {
        logger.warn(`Modmail import: not imported, several channels claim the same member: ${disputed.join('; ')}`);
        const { postModLog } = await import('./enforcement/enforcementService.js');
        await postModLog(guild.client, 'system', [
            { name: 'Not imported', value: disputed.join('\n').slice(0, 1000) },
            { name: 'Why', value: 'Several channels name the same member in their topic, so none is trusted. Close the extra channels by hand; the member can open a new conversation.' },
        ], { title: '📬 Modmail import: conflicting channels' }).catch(() => {});
    }
    await db.set(importFlagKey(guild.id), { at: new Date().toISOString(), imported, disputed: disputed.length });
    logger.info(`Modmail import done in ${guild.id}: ${imported} open channel(s) linked; from now on only modmail_links counts`);
    return imported;
}

/** Channel ids of every modmail conversation in this server. */
export async function linkedChannelIds(guildId) {
    await loadModmailLinks();
    return [...byChannel.entries()].filter(([, link]) => link.guildId === guildId).map(([channelId]) => channelId);
}

/** Tests only: forget the in-memory mirror. */
export function resetModmailLinksForTests() {
    byChannel.clear();
    byUser.clear();
    loading = null;
}
