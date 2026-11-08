// structureBackupService.js — daily snapshots of a server's roles, categories and channels
// (with their role permission overwrites), and rebuilding them in another server, so a nuked
// server can be recreated: /backup rebuild after /backup restore.
//
// Which servers (anti-nuke "Wick-style extras"): the main and support servers, and every server
// where the staff guard runs (staffGuardOn: automod on + staff guard on). One SQL query finds
// them (guildScan.js), the job pauses between servers, and each keeps its newest KEEP_SNAPSHOTS.
// A nuke alert also takes one at once (snapshotIfStale) when the newest is over an hour old.
//
// Rebuild only adds: it never deletes or edits what the target server already has,
// and refuses to run on the main server itself. Member-specific overwrites, managed
// (bot/integration) roles, emojis, webhooks and messages are not part of a snapshot.
//
// Undo the nuke (/backup changes, /backup revert, "Show what changed" / "Revert" on staff-guard
// alerts in any server with the guard on): diffStructure compares a snapshot with the live
// server; revertToSnapshot
// recreates deleted roles and channels (with their role overwrites, in order) and puts
// back changed role permissions and channel overwrites. Roles and channels created
// since the snapshot are listed but never deleted. Members do not get recreated roles
// back (a snapshot has no member list).

import { ChannelType, Routes } from 'discord.js';
import { isBotOwner } from '../config/bot.js';
import { enforcementConfig } from '../config/enforcement.js';
import { logger } from '../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from './enforcement/db.js';
import { GUILD_SQL, guildIdsFromSql } from './scheduling/guildScan.js';
import { getAutomodSettings } from './automod/automodSettings.js';

export const KEEP_SNAPSHOTS = 7;
const PAUSE_MS = 400;
/** Pause between servers in the daily snapshot job (reading the cache is cheap; the DB write is not). */
export const SNAPSHOT_PAUSE_MS = 1500;
/** A nuke alert takes a fresh snapshot when the newest one is older than this. */
export const STALE_SNAPSHOT_MS = 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REBUILDABLE_CHANNELS = new Set([
    ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement,
    ChannelType.GuildStageVoice, ChannelType.GuildForum,
]);

// One rebuild or revert at a time per server (the target's id), so two servers can recover at once
// but one server never runs two that fight over the same channels.
const busy = new Set();
function claim(guildId) {
    if (busy.has(guildId)) throw new Error('A rebuild or revert is already running for this server.');
    busy.add(guildId);
}

/** Test hook. */
export function resetStructureBackupState() {
    busy.clear();
    staleChecks.clear();
}

/** Bot owners (OWNER_IDS) or the main server's owner: who may use /backup. */
export function isBackupOwner(client, userId) {
    const main = client.guilds.cache.get(enforcementConfig.mainGuildId);
    return isBotOwner(userId) || main?.ownerId === userId;
}

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
export async function takeSnapshot(guild, data = captureStructure(guild)) {
    if (!isEnforcementDbAvailable()) throw new Error('The database is unavailable');
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

/**
 * The servers the daily job snapshots (ids, in the bot's cache): main + support, plus every
 * server with automod and the staff guard on. One SQL query; without SQL (in-memory storage)
 * each cached server's settings are read. Throws on a database error (the job skips the run).
 */
export async function snapshotGuildIds(client, { query: runQuery } = {}) {
    const cached = client.guilds.cache;
    const ids = [enforcementConfig.mainGuildId, enforcementConfig.supportGuildId].filter((id) => id && cached.has(id));
    const found = await guildIdsFromSql(client, GUILD_SQL.staffGuard, [], { query: runQuery });
    if (found) {
        for (const id of found) if (cached.has(id) && !ids.includes(id)) ids.push(id);
        return ids;
    }
    for (const id of cached.keys()) {
        if (ids.includes(id)) continue;
        const settings = await getAutomodSettings(id);
        if (settings.enabled && settings.staffGuard) ids.push(id);
    }
    return ids;
}

/**
 * The daily job: snapshot every server from snapshotGuildIds, pausing between them. One failing
 * server is logged and skipped. Returns { taken, failed }. (Still named for app.js's cron.)
 */
export async function snapshotMainServer(client, { pauseMs = SNAPSHOT_PAUSE_MS, query: runQuery, snapshot = takeSnapshot } = {}) {
    if (!runQuery && !isEnforcementDbAvailable()) return { taken: 0, failed: 0 };
    let ids;
    try {
        ids = await snapshotGuildIds(client, { query: runQuery });
    } catch (error) {
        logger.warn(`Server structure snapshots skipped: could not read which servers use the staff guard: ${error.message}`);
        return { taken: 0, failed: 0 };
    }
    const result = { taken: 0, failed: 0 };
    for (const [index, guildId] of ids.entries()) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        if (index > 0 && pauseMs) await sleep(pauseMs);
        try {
            const row = await snapshot(guild);
            result.taken += 1;
            logger.info(`Server structure snapshot #${row.id} of ${guild.id}: ${row.summary}`);
        } catch (error) {
            result.failed += 1;
            logger.warn(`Server structure snapshot of ${guild.id} failed: ${error.message}`);
        }
    }
    return result;
}
export const snapshotGuardedServers = snapshotMainServer;

const staleChecks = new Map(); // guildId → running snapshotIfStale promise

/**
 * Takes a snapshot of `guild` when its newest one is older than `maxAgeMs` (or there is none).
 * For nuke alerts: called first, before the guard acts. Concurrent calls for one server share
 * one check. Resolves the new row, or null when a fresh one exists / it failed (logged; never
 * throws, it must not hold up the guard).
 */
export function snapshotIfStale(guild, { maxAgeMs = STALE_SNAPSHOT_MS, now = Date.now() } = {}) {
    if (staleChecks.has(guild.id)) return staleChecks.get(guild.id);
    let data;
    try {
        data = captureStructure(guild); // now, before the guard (or the nuker) changes anything else
    } catch (error) {
        logger.warn(`Snapshot at a nuke alert in ${guild.id} failed: ${error.message}`);
        return Promise.resolve(null);
    }
    const run = (async () => {
        try {
            if (!isEnforcementDbAvailable()) return null;
            const { rows } = await query(`SELECT MAX(created_at) AS newest FROM ${T.serverSnapshots} WHERE guild_id = $1`, [guild.id]);
            const newest = rows[0]?.newest ? new Date(rows[0].newest).getTime() : 0;
            if (newest && now - newest < maxAgeMs) return null;
            const row = await takeSnapshot(guild, data);
            logger.info(`Server structure snapshot #${row.id} of ${guild.id} at a nuke alert: ${row.summary}`);
            return row;
        } catch (error) {
            logger.warn(`Snapshot at a nuke alert in ${guild.id} failed: ${error.message}`);
            return null;
        } finally {
            staleChecks.delete(guild.id);
        }
    })();
    staleChecks.set(guild.id, run);
    return run;
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

/** The newest snapshot taken before `before` (a Date), or null. For "Show diff" on a nuke alert. */
export async function getSnapshotBefore(guildId, before) {
    const { rows } = await query(
        `SELECT * FROM ${T.serverSnapshots} WHERE guild_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT 1`,
        [guildId, before]
    );
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
    claim(target.id);
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
        busy.delete(target.id);
    }
}

const sameOverwrite = (a, b) => Boolean(a && b && a.allow === b.allow && a.deny === b.deny);

/**
 * What changed between a snapshot (captureStructure data) and the live structure.
 * Pure. Returns {
 *   everyone: { before, after } | null,
 *   deletedRoles, deletedChannels,              // snapshot entries missing now (roles lowest first, categories first)
 *   changedRoles: [{ id, name, before, after }], // permission bitfields
 *   overwriteChanges: [{ channelId, name, changes: [{ roleId, roleName, before, after, deletedRole }] }],
 *   addedRoles, addedChannels,                   // live entries not in the snapshot (listed, never deleted)
 * }
 */
export function diffStructure(snapshot, live) {
    const liveRoles = new Map(live.roles.map((role) => [role.id, role]));
    const liveChannels = new Map(live.channels.map((channel) => [channel.id, channel]));
    const snapRoles = new Map(snapshot.roles.map((role) => [role.id, role]));
    const snapChannels = new Set(snapshot.channels.map((channel) => channel.id));
    const roleName = (id) => (id === snapshot.guildId ? '@everyone' : snapRoles.get(id)?.name || liveRoles.get(id)?.name || id);

    const deletedRoles = snapshot.roles.filter((role) => !liveRoles.has(role.id)).sort((a, b) => a.position - b.position);
    const deletedRoleIds = new Set(deletedRoles.map((role) => role.id));
    const changedRoles = snapshot.roles
        .filter((role) => liveRoles.has(role.id) && liveRoles.get(role.id).permissions !== role.permissions)
        .map((role) => ({ id: role.id, name: role.name, before: role.permissions, after: liveRoles.get(role.id).permissions }));

    const missing = snapshot.channels.filter((c) => !liveChannels.has(c.id));
    const deletedChannels = [
        ...missing.filter((c) => c.type === ChannelType.GuildCategory),
        ...missing.filter((c) => c.type !== ChannelType.GuildCategory),
    ];

    const knownRole = (id) => id === snapshot.guildId || snapRoles.has(id);
    const overwriteChanges = [];
    for (const channel of snapshot.channels) {
        const current = liveChannels.get(channel.id);
        if (!current) continue;
        const before = new Map(channel.overwrites.map((o) => [o.roleId, o]));
        const after = new Map(current.overwrites.map((o) => [o.roleId, o]));
        const changes = [];
        for (const [roleId, overwrite] of before) {
            if (sameOverwrite(overwrite, after.get(roleId))) continue;
            const now = after.get(roleId);
            changes.push({
                roleId, roleName: roleName(roleId), deletedRole: deletedRoleIds.has(roleId),
                before: { allow: overwrite.allow, deny: overwrite.deny },
                after: now ? { allow: now.allow, deny: now.deny } : null,
            });
        }
        for (const [roleId, overwrite] of after) {
            // Overwrites for roles made after the snapshot are left alone.
            if (!before.has(roleId) && knownRole(roleId)) {
                changes.push({ roleId, roleName: roleName(roleId), deletedRole: false, before: null, after: { allow: overwrite.allow, deny: overwrite.deny } });
            }
        }
        if (changes.length) overwriteChanges.push({ channelId: channel.id, name: channel.name, changes });
    }

    return {
        everyone: snapshot.everyonePermissions !== live.everyonePermissions
            ? { before: snapshot.everyonePermissions, after: live.everyonePermissions } : null,
        deletedRoles,
        deletedChannels,
        changedRoles,
        overwriteChanges,
        addedRoles: live.roles.filter((role) => !snapRoles.has(role.id)),
        addedChannels: live.channels.filter((channel) => !snapChannels.has(channel.id)),
    };
}

/** True when a revert would change something. */
export function diffHasChanges(diff) {
    return Boolean(diff.everyone || diff.deletedRoles.length || diff.deletedChannels.length
        || diff.changedRoles.length || diff.overwriteChanges.length);
}

const CHANNEL_KIND = {
    [ChannelType.GuildCategory]: 'category', [ChannelType.GuildVoice]: 'voice', [ChannelType.GuildStageVoice]: 'stage', [ChannelType.GuildForum]: 'forum',
};

function listOf(items, format, max) {
    const shown = items.slice(0, max).map(format).join(', ');
    return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** The diff as text (at most 3800 characters) for an embed description. */
export function formatDiff(diff, { max = 15 } = {}) {
    const lines = [];
    if (diff.deletedRoles.length) lines.push(`**Deleted roles (${diff.deletedRoles.length}):** ${listOf(diff.deletedRoles, (r) => `\`${r.name}\``, max)}`);
    if (diff.deletedChannels.length) {
        lines.push(`**Deleted channels (${diff.deletedChannels.length}):** ${listOf(diff.deletedChannels, (c) => (CHANNEL_KIND[c.type] ? `\`${c.name}\` (${CHANNEL_KIND[c.type]})` : `#\`${c.name}\``), max)}`);
    }
    if (diff.everyone) lines.push('**@everyone permissions:** changed');
    if (diff.changedRoles.length) lines.push(`**Role permissions changed (${diff.changedRoles.length}):** ${listOf(diff.changedRoles, (r) => `\`${r.name}\``, max)}`);
    const visible = diff.overwriteChanges
        .map((entry) => ({ ...entry, changes: entry.changes.filter((change) => !change.deletedRole) }))
        .filter((entry) => entry.changes.length);
    const ofDeletedRoles = diff.overwriteChanges.reduce((n, entry) => n + entry.changes.filter((c) => c.deletedRole).length, 0);
    if (visible.length) {
        const describe = (entry) => `#${entry.name} (${entry.changes.map((c) => `${c.roleName} ${c.before ? (c.after ? 'changed' : 'removed') : 'added'}`).join(', ')})`;
        lines.push(`**Channel overwrites changed (${visible.length} channel${visible.length === 1 ? '' : 's'}):** ${listOf(visible, describe, Math.min(max, 8))}`);
    }
    if (ofDeletedRoles) lines.push(`-# Plus ${ofDeletedRoles} overwrite(s) of deleted roles on existing channels, restored with the roles.`);
    if (diff.addedRoles.length || diff.addedChannels.length) {
        const added = [
            diff.addedRoles.length ? `${diff.addedRoles.length} role(s): ${listOf(diff.addedRoles, (r) => `\`${r.name}\``, 8)}` : null,
            diff.addedChannels.length ? `${diff.addedChannels.length} channel(s): ${listOf(diff.addedChannels, (c) => `\`${c.name}\``, 8)}` : null,
        ].filter(Boolean).join('; ');
        lines.push(`**Created since the snapshot (left alone):** ${added}`);
    }
    const text = lines.length ? lines.join('\n') : 'No differences: the server matches the snapshot.';
    return text.length > 3800 ? `${text.slice(0, 3799)}…` : text;
}

/** Diff of a stored snapshot row against the live server. */
export function diffAgainstLive(guild, snapshot) {
    return diffStructure(snapshot.data, captureStructure(guild));
}

/**
 * What a revert from `diff` would do, for the confirm step (pure). Nothing created since the
 * snapshot is deleted: those roles and channels are only listed (`leftAlone`).
 */
export function revertPlan(diff) {
    const overwrites = diff.overwriteChanges.reduce((n, entry) => n + entry.changes.length, 0);
    return {
        recreateRoles: diff.deletedRoles.map((role) => role.name),
        recreateCategories: diff.deletedChannels.filter((c) => c.type === ChannelType.GuildCategory).map((c) => c.name),
        recreateChannels: diff.deletedChannels.filter((c) => c.type !== ChannelType.GuildCategory).map((c) => c.name),
        fixRolePermissions: [...(diff.everyone ? ['@everyone'] : []), ...diff.changedRoles.map((role) => role.name)],
        fixOverwrites: overwrites,
        leftAlone: diff.addedRoles.length + diff.addedChannels.length,
        empty: !diffHasChanges(diff),
    };
}

/** The confirm text for a revert plan (at most ~1500 characters). */
export function formatRevertPlan(plan) {
    if (plan.empty) return 'Nothing to revert: the server matches the snapshot.';
    const few = (names) => listOf(names, (name) => `\`${name}\``, 10);
    return [
        plan.recreateRoles.length ? `- Recreate **${plan.recreateRoles.length}** role(s): ${few(plan.recreateRoles)} (members do not get them back)` : null,
        plan.recreateCategories.length ? `- Recreate **${plan.recreateCategories.length}** categor${plan.recreateCategories.length === 1 ? 'y' : 'ies'}: ${few(plan.recreateCategories)}` : null,
        plan.recreateChannels.length ? `- Recreate **${plan.recreateChannels.length}** channel(s) with their category, position and role permissions: ${few(plan.recreateChannels)}` : null,
        plan.fixRolePermissions.length ? `- Put back the permissions of ${few(plan.fixRolePermissions)}` : null,
        plan.fixOverwrites ? `- Put back **${plan.fixOverwrites}** channel permission overwrite(s)` : null,
        plan.leftAlone ? `- Leave alone **${plan.leftAlone}** role(s)/channel(s) created since the snapshot (nothing is deleted)` : null,
        '-# Paced to stay inside Discord\'s rate limits: a big server takes a few minutes.',
    ].filter(Boolean).join('\n').slice(0, 1500);
}

/**
 * Undo the nuke: puts the snapshot's deleted roles and channels, role permissions and
 * channel overwrites back in the live server (any server, from one of its own snapshots),
 * pausing between calls (discord.js also waits out rate limits). It never deletes a role or a
 * channel. `report(text)` gets progress lines.
 * Returns { rolesCreated, rolesFixed, channelsCreated, overwritesFixed, failed, skipped: string[], failedItems: string[] }.
 */
export async function revertToSnapshot(guild, snapshot, report = async () => {}, { pauseMs = PAUSE_MS } = {}) {
    if (!snapshot || String(snapshot.guild_id) !== guild.id || snapshot.data?.guildId !== guild.id) {
        throw new Error('Revert only works from one of this server\'s own snapshots.');
    }
    claim(guild.id);
    const data = snapshot.data;
    const counts = { rolesCreated: 0, rolesFixed: 0, channelsCreated: 0, overwritesFixed: 0, failed: 0, skipped: [], failedItems: [] };
    const fail = (what, error) => {
        counts.failed += 1;
        if (counts.failedItems.length < 50) counts.failedItems.push(what);
        logger.warn(`Revert: ${what} failed: ${error.message}`);
    };
    const pause = () => (pauseMs ? sleep(pauseMs) : null);

    try {
        const diff = diffAgainstLive(guild, snapshot);
        const top = guild.members.me?.roles.highest.position ?? 0;
        const roleMap = new Map(); // snapshot role id → recreated role id
        const liveRoleId = (id) => {
            if (id === data.guildId) return guild.id;
            return roleMap.get(id) || (guild.roles.cache.has(id) ? id : null);
        };

        if (diff.everyone) {
            await guild.roles.everyone.setPermissions(BigInt(diff.everyone.before), 'Revert to snapshot')
                .then(() => { counts.rolesFixed += 1; }).catch((error) => fail('@everyone permissions', error));
        }

        for (const role of diff.deletedRoles) {
            try {
                const created = await guild.roles.create({
                    name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable,
                    permissions: BigInt(role.permissions), reason: 'Revert to snapshot: role was deleted',
                });
                roleMap.set(role.id, created.id);
                counts.rolesCreated += 1;
            } catch (error) {
                fail(`role ${role.name}`, error);
            }
            await pause();
        }
        // Recreated roles back at their old height, below my own role.
        const rolePositions = diff.deletedRoles.filter((role) => roleMap.has(role.id))
            .map((role) => ({ role: roleMap.get(role.id), position: Math.max(1, Math.min(role.position, top - 1)) }));
        if (rolePositions.length) await guild.roles.setPositions(rolePositions).catch((error) => fail('role order', error));

        for (const role of diff.changedRoles) {
            const live = guild.roles.cache.get(role.id);
            if (!live?.editable) {
                counts.skipped.push(`role ${role.name} (above my role)`);
                continue;
            }
            await live.setPermissions(BigInt(role.before), 'Revert to snapshot: permissions changed')
                .then(() => { counts.rolesFixed += 1; }).catch((error) => fail(`permissions of ${role.name}`, error));
            await pause();
        }
        await report(`Roles: ${counts.rolesCreated} recreated, ${counts.rolesFixed} fixed. Restoring channels…`).catch(() => {});

        const overwritesFor = (channel) => channel.overwrites
            .map((o) => ({ id: liveRoleId(o.roleId), allow: BigInt(o.allow), deny: BigInt(o.deny), type: 0 }))
            .filter((o) => o.id);
        const channelMap = new Map();
        const channelPositions = [];
        for (const channel of diff.deletedChannels) {
            const parent = channel.parentId
                ? channelMap.get(channel.parentId) || (guild.channels.cache.has(channel.parentId) ? channel.parentId : undefined)
                : undefined;
            if (channel.parentId && !parent) counts.skipped.push(`category of #${channel.name} (it could not be recreated)`);
            try {
                const created = await guild.channels.create({
                    name: channel.name,
                    type: channel.type,
                    parent,
                    topic: channel.topic || undefined,
                    nsfw: channel.nsfw,
                    rateLimitPerUser: channel.rateLimitPerUser || undefined,
                    bitrate: channel.bitrate ? Math.min(channel.bitrate, guild.maximumBitrate || 96000) : undefined,
                    userLimit: channel.userLimit || undefined,
                    permissionOverwrites: overwritesFor(channel),
                    reason: 'Revert to snapshot: channel was deleted',
                });
                channelMap.set(channel.id, created.id);
                channelPositions.push({ channel: created.id, position: channel.position });
                counts.channelsCreated += 1;
            } catch (error) {
                fail(`channel ${channel.name}`, error);
            }
            await pause();
        }
        if (channelPositions.length) await guild.channels.setPositions(channelPositions).catch((error) => fail('channel order', error));

        for (const entry of diff.overwriteChanges) {
            for (const change of entry.changes) {
                const roleId = liveRoleId(change.roleId);
                if (!roleId) continue; // the role could not be recreated
                try {
                    if (change.before) {
                        await guild.client.rest.put(Routes.channelPermission(entry.channelId, roleId), {
                            body: { type: 0, allow: change.before.allow, deny: change.before.deny },
                            reason: 'Revert to snapshot: overwrite changed',
                        });
                    } else {
                        await guild.client.rest.delete(Routes.channelPermission(entry.channelId, roleId), { reason: 'Revert to snapshot: overwrite added' });
                    }
                    counts.overwritesFixed += 1;
                } catch (error) {
                    fail(`overwrite of ${change.roleName} on #${entry.name}`, error);
                }
                await pause();
            }
        }
        return counts;
    } finally {
        busy.delete(guild.id);
    }
}

/** The closing summary of a revert. */
export function formatRevertSummary(counts) {
    return [
        `${counts.rolesCreated} role(s) recreated, ${counts.rolesFixed} role permission(s) fixed,`,
        `${counts.channelsCreated} channel(s) recreated, ${counts.overwritesFixed} overwrite(s) fixed, ${counts.failed} failed.`,
        counts.failedItems?.length ? `Could not restore: ${counts.failedItems.slice(0, 10).join(', ')}${counts.failedItems.length > 10 ? ` and ${counts.failedItems.length - 10} more` : ''}.` : null,
        counts.skipped.length ? `Skipped: ${counts.skipped.slice(0, 10).join(', ')}.` : null,
        counts.rolesCreated ? 'Recreated roles are empty: give them back to members by hand.' : null,
    ].filter(Boolean).join(' ');
}
