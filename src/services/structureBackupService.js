// structureBackupService.js — daily snapshots of the main server's roles, categories
// and channels (with their role permission overwrites), and rebuilding them in another
// server, so a nuked server can be recreated: /backup rebuild after /backup restore.
//
// Rebuild only adds: it never deletes or edits what the target server already has,
// and refuses to run on the main server itself. Member-specific overwrites, managed
// (bot/integration) roles, emojis, webhooks and messages are not part of a snapshot.

import { ChannelType } from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { logger } from '../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from './enforcement/db.js';

const KEEP_SNAPSHOTS = 7;
const PAUSE_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REBUILDABLE_CHANNELS = new Set([
    ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement,
    ChannelType.GuildStageVoice, ChannelType.GuildForum,
]);

let rebuilding = false;

/** A plain-JSON description of the guild's structure. */
export function captureStructure(guild) {
    const roles = [...guild.roles.cache.values()]
        .filter((role) => !role.managed && role.id !== guild.id)
        .sort((a, b) => a.position - b.position)
        .map((role) => ({
            id: role.id,
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            mentionable: role.mentionable,
            permissions: role.permissions.bitfield.toString(),
            position: role.position,
        }));

    const overwritesOf = (channel) => [...channel.permissionOverwrites.cache.values()]
        .filter((overwrite) => overwrite.type === 0) // role overwrites; member ones would point at nobody
        .map((overwrite) => ({ roleId: overwrite.id, allow: overwrite.allow.bitfield.toString(), deny: overwrite.deny.bitfield.toString() }));

    const channels = [...guild.channels.cache.values()]
        .filter((channel) => channel.type === ChannelType.GuildCategory || REBUILDABLE_CHANNELS.has(channel.type))
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
        .map((channel) => ({
            id: channel.id,
            name: channel.name,
            type: channel.type,
            parentId: channel.parentId || null,
            position: channel.rawPosition ?? 0,
            topic: channel.topic || null,
            nsfw: Boolean(channel.nsfw),
            rateLimitPerUser: channel.rateLimitPerUser || 0,
            bitrate: channel.bitrate || null,
            userLimit: channel.userLimit || null,
            overwrites: overwritesOf(channel),
        }));

    return {
        guildId: guild.id,
        guildName: guild.name,
        everyonePermissions: guild.roles.everyone.permissions.bitfield.toString(),
        roles,
        channels,
    };
}

/** Takes and stores a snapshot, keeping the latest KEEP_SNAPSHOTS. Returns the stored row. */
export async function takeSnapshot(guild) {
    if (!isEnforcementDbAvailable()) throw new Error('The database is unavailable');
    const data = captureStructure(guild);
    const categories = data.channels.filter((c) => c.type === ChannelType.GuildCategory).length;
    const summary = `${data.roles.length} roles, ${categories} categories, ${data.channels.length - categories} channels`;
    const { rows } = await query(
        `INSERT INTO ${T.serverSnapshots} (guild_id, summary, data) VALUES ($1, $2, $3) RETURNING id, created_at, summary`,
        [guild.id, summary, data]
    );
    await query(
        `DELETE FROM ${T.serverSnapshots} WHERE guild_id = $1 AND id NOT IN (
             SELECT id FROM ${T.serverSnapshots} WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2)`,
        [guild.id, KEEP_SNAPSHOTS]
    );
    return rows[0];
}

/** The daily job: snapshot the main server. */
export async function snapshotMainServer(client) {
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!guild || !isEnforcementDbAvailable()) return;
    const row = await takeSnapshot(guild);
    logger.info(`Server structure snapshot #${row.id}: ${row.summary}`);
}

export async function listSnapshots(guildId) {
    const { rows } = await query(
        `SELECT id, created_at, summary FROM ${T.serverSnapshots} WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [guildId, KEEP_SNAPSHOTS]
    );
    return rows;
}

export async function getSnapshot(guildId, id = null) {
    const { rows } = id
        ? await query(`SELECT * FROM ${T.serverSnapshots} WHERE guild_id = $1 AND id = $2`, [guildId, id])
        : await query(`SELECT * FROM ${T.serverSnapshots} WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 1`, [guildId]);
    return rows[0] || null;
}

/**
 * Creates the snapshot's roles, categories and channels in `target`. `report(text)`
 * receives progress lines. Returns { roles, channels, failed }.
 */
export async function rebuildFromSnapshot(target, snapshot, report) {
    if (target.id === enforcementConfig.mainGuildId || target.id === snapshot.guild_id) {
        throw new Error('Rebuild only works into a different server than the one the snapshot is of.');
    }
    if (rebuilding) throw new Error('A rebuild is already running.');
    rebuilding = true;
    const data = snapshot.data;
    const counts = { roles: 0, channels: 0, failed: 0 };
    const roleMap = new Map(); // snapshot role id → new role id
    roleMap.set(data.guildId, target.id); // @everyone

    try {
        await target.roles.everyone.setPermissions(BigInt(data.everyonePermissions), 'Rebuild from snapshot').catch(() => { counts.failed += 1; });

        // Lowest first: each new role is created above the previous one, keeping the order.
        for (const role of data.roles) {
            try {
                const created = await target.roles.create({
                    name: role.name,
                    color: role.color,
                    hoist: role.hoist,
                    mentionable: role.mentionable,
                    permissions: BigInt(role.permissions),
                    reason: 'Rebuild from snapshot',
                });
                roleMap.set(role.id, created.id);
                counts.roles += 1;
            } catch (error) {
                counts.failed += 1;
                logger.warn(`Rebuild: role ${role.name} failed: ${error.message}`);
            }
            await sleep(PAUSE_MS);
        }
        await report(`Roles: ${counts.roles}/${data.roles.length} created. Creating channels…`).catch(() => {});

        const overwrites = (channel) => channel.overwrites
            .filter((overwrite) => roleMap.has(overwrite.roleId))
            .map((overwrite) => ({ id: roleMap.get(overwrite.roleId), allow: BigInt(overwrite.allow), deny: BigInt(overwrite.deny), type: 0 }));

        const channelMap = new Map();
        const ordered = [
            ...data.channels.filter((c) => c.type === ChannelType.GuildCategory),
            ...data.channels.filter((c) => c.type !== ChannelType.GuildCategory),
        ];
        for (const channel of ordered) {
            try {
                const created = await target.channels.create({
                    name: channel.name,
                    type: channel.type,
                    parent: channel.parentId ? channelMap.get(channel.parentId) : undefined,
                    topic: channel.topic || undefined,
                    nsfw: channel.nsfw,
                    rateLimitPerUser: channel.rateLimitPerUser || undefined,
                    bitrate: channel.bitrate ? Math.min(channel.bitrate, target.maximumBitrate || 96000) : undefined,
                    userLimit: channel.userLimit || undefined,
                    permissionOverwrites: overwrites(channel),
                    reason: 'Rebuild from snapshot',
                });
                channelMap.set(channel.id, created.id);
                counts.channels += 1;
            } catch (error) {
                counts.failed += 1;
                logger.warn(`Rebuild: channel ${channel.name} failed: ${error.message}`);
            }
            await sleep(PAUSE_MS);
        }
        return counts;
    } finally {
        rebuilding = false;
    }
}
