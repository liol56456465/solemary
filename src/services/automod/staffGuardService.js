// staffGuardService.js — protects the main server from its own staff.
//
// Abuse guard: an admin who bans or kicks guardBanKickLimit members, or deletes
// guardDeleteLimit channels/roles, within guardWindowMs loses their staff roles at
// once. The owner is alerted by DM and in the mod log and can restore the roles with
// /staff restore. The server owner and the bot are never affected.
//
// Staff warnings: /staff warn (owner only) records a warning that expires after
// staffWarnExpiryMs; at staffWarnLimit active warnings the staff roles are removed
// the same way.

import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { getFromDb, setInDb, deleteFromDb } from '../../utils/database.js';
import { query, T } from '../enforcement/db.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { dateStamp } from '../enforcement/format.js';

const STAFF_ROLE_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageMessages,
];

const WATCHED = {
    [AuditLogEvent.MemberBanAdd]: 'banKick',
    [AuditLogEvent.MemberKick]: 'banKick',
    [AuditLogEvent.ChannelDelete]: 'delete',
    [AuditLogEvent.RoleDelete]: 'delete',
};

const activity = new Map(); // guildId:executorId:kind → [at]
const backupKey = (guildId, userId) => `staffguard:removed:${guildId}:${userId}`;

function isStaffRole(role) {
    return role.id !== role.guild.id && !role.managed
        && STAFF_ROLE_PERMISSIONS.some((flag) => role.permissions.has(flag));
}

async function alertOwner(guild, text) {
    const owner = await guild.fetchOwner().catch(() => null);
    await owner?.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

/**
 * Removes every staff role the bot can manage and remembers them for /staff restore.
 * Returns { removed: Role[], kept: Role[] } (kept = above the bot, so not removable).
 */
export async function stripStaffRoles(member, reason) {
    const staffRoles = member.roles.cache.filter(isStaffRole);
    const removable = staffRoles.filter((role) => role.editable);
    const kept = staffRoles.filter((role) => !role.editable);
    if (removable.size) {
        await member.roles.remove([...removable.keys()], reason.slice(0, 512));
        const previous = await getFromDb(backupKey(member.guild.id, member.id), null);
        const roleIds = [...new Set([...(previous?.roleIds || []), ...removable.keys()])];
        await setInDb(backupKey(member.guild.id, member.id), { roleIds, reason, at: new Date().toISOString() });
    }
    return { removed: [...removable.values()], kept: [...kept.values()] };
}

/** Gives back the roles removed by the guard or by staff warnings. Returns the restored roles. */
export async function restoreStaffRoles(guild, userId, restoredBy) {
    const backup = await getFromDb(backupKey(guild.id, userId), null);
    if (!backup?.roleIds?.length) return null;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return null;
    const roles = backup.roleIds.map((id) => guild.roles.cache.get(id)).filter((role) => role?.editable);
    if (roles.length) await member.roles.add(roles, `Staff roles restored by ${restoredBy.username}`);
    await deleteFromDb(backupKey(guild.id, userId));
    await postModLog(guild.client, 'staff', [
        { name: 'Staff member', value: `<@${userId}> ${member.user.username} (\`${userId}\`)` },
        { name: 'Restored by', value: `${restoredBy.username} (${restoredBy.id})` },
        { name: 'Roles', value: roles.map((role) => role.name).join(', ') || 'None could be restored' },
    ], { title: 'Staff roles restored' });
    return roles;
}

async function demote(guild, member, why) {
    const { removed, kept } = await stripStaffRoles(member, `Staff guard: ${why}`);
    const summary = [
        `**Staff member:** ${member.user.username} (\`${member.id}\`)`,
        `**Why:** ${why}`,
        `**Removed roles:** ${removed.map((role) => role.name).join(', ') || 'none'}`,
        kept.length ? `**Could not remove (above my role):** ${kept.map((role) => role.name).join(', ')}` : null,
        'Restore with `/staff restore`.',
    ].filter(Boolean).join('\n');
    await postModLog(guild.client, 'staff', [
        { name: 'Staff member', value: `<@${member.id}> ${member.user.username} (\`${member.id}\`)` },
        { name: 'Why', value: why },
        { name: 'Removed roles', value: removed.map((role) => role.name).join(', ') || 'none' },
        ...(kept.length ? [{ name: 'Could not remove (above my role)', value: kept.map((role) => role.name).join(', ') }] : []),
        { name: 'Restore', value: '`/staff restore`' },
    ], { title: 'Staff roles removed' });
    await alertOwner(guild, `**Staff guard in ${guild.name}**\n${summary}`);
    logger.warn(`Staff guard removed roles from ${member.id}: ${why}`);
}

/** Call for every audit log entry in the main server. */
export async function handleAuditLogEntry(entry, guild) {
    if (guild.id !== enforcementConfig.mainGuildId) return;
    const kind = WATCHED[entry.action];
    const executorId = entry.executorId;
    if (!kind || !executorId || executorId === guild.ownerId || executorId === guild.client.user.id) return;

    const now = Date.now();
    const key = `${guild.id}:${executorId}:${kind}`;
    const times = (activity.get(key) || []).filter((at) => now - at <= automodConfig.guardWindowMs);
    times.push(now);
    activity.set(key, times);

    const limit = kind === 'banKick' ? automodConfig.guardBanKickLimit : automodConfig.guardDeleteLimit;
    if (times.length < limit) return;
    activity.delete(key);

    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return;
    const minutes = automodConfig.guardWindowMs / 60000;
    const why = kind === 'banKick'
        ? `${times.length} bans/kicks within ${minutes} minutes`
        : `${times.length} channel/role deletions within ${minutes} minutes`;
    await demote(guild, member, why).catch((error) => logger.error(`Staff guard could not demote ${executorId}: ${error.message}`));
}

export async function listStaffWarnings(guildId, userId) {
    const { rows } = await query(
        `SELECT * FROM ${T.staffWarnings} WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 25`,
        [guildId, userId]
    );
    return rows;
}

export async function countActiveStaffWarnings(guildId, userId) {
    const { rows } = await query(
        `SELECT COUNT(*)::int AS count FROM ${T.staffWarnings} WHERE guild_id = $1 AND user_id = $2 AND expires_at > NOW()`,
        [guildId, userId]
    );
    return rows[0]?.count || 0;
}

/** Records a staff warning, DMs the staff member, and demotes at the limit. Returns { active, demoted }. */
export async function giveStaffWarning(guild, member, giver, reason) {
    const expiresAt = new Date(Date.now() + automodConfig.staffWarnExpiryMs);
    await query(
        `INSERT INTO ${T.staffWarnings} (guild_id, user_id, username, reason, given_by, given_by_username, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [guild.id, member.id, member.user.username, reason, giver.id, giver.username, expiresAt]
    );
    const active = await countActiveStaffWarnings(guild.id, member.id);

    await postModLog(guild.client, 'staff', [
        { name: 'Staff member', value: `<@${member.id}> ${member.user.username} (\`${member.id}\`)` },
        { name: 'Given by', value: `${giver.username} (${giver.id})` },
        { name: 'Reason', value: reason },
        { name: 'Active staff warnings', value: `${active} of ${automodConfig.staffWarnLimit}`, inline: true },
        { name: 'Expires', value: dateStamp(expiresAt), inline: true },
    ], { title: 'Staff warning' });
    await member.send({
        content: [
            `**Staff warning in ${guild.name}** (${active} of ${automodConfig.staffWarnLimit})`,
            `Reason: ${reason}`,
            `It expires ${dateStamp(expiresAt)}. At ${automodConfig.staffWarnLimit} active warnings you lose your staff role.`,
        ].join('\n'),
        allowedMentions: { parse: [] },
    }).catch(() => {});

    let demoted = false;
    if (active >= automodConfig.staffWarnLimit) {
        await demote(guild, member, `${active} active staff warnings`);
        demoted = true;
    }
    return { active, demoted };
}
