// staffGuardService.js — protects a server from its own staff.
//
// Multi-server (B1): the main server as before (always on); any other server only while its
// automod is on AND its staff guard is turned on (both off by default: kicking bots and
// removing staff roles must never surprise a server that just added the bot).
//
// Abuse guard: an admin who bans or kicks guardBanKickLimit members, or deletes
// guardDeleteLimit channels/roles, within guardWindowMs loses their staff roles at
// once. The owner is alerted by DM and in the mod log and can restore the roles with
// /staff restore. The server owner and the bot are never affected.
//
// Anti-nuke (same exemptions): a bot added by anyone but the owner is kicked; 3+
// webhooks created by one member within the window are deleted and that member is
// demoted; dangerous permissions granted to @everyone, or Administrator granted to
// any role, are reverted and the member who did it is demoted. The owner is alerted.
//
// Nuke alerts (any server with the guard on): the server's structure is snapshotted at once
// when its newest snapshot is over an hour old (captured before the guard acts), and the alert
// gets "Show what changed", "Revert…" and "Lock down (panic)" buttons (backupRevert.js). The
// member the guard acted on is remembered (recentOffenders) and refused by those buttons.
//
// Staff warnings: /staff warn (owner only) records a warning that expires after
// staffWarnExpiryMs; at staffWarnLimit active warnings the staff roles are removed
// the same way.

import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { automodConfig } from '../../config/automod.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { getAutomodSettings, isLegacyAutomodGuild } from './automodSettings.js';
import { db, getFromDb, setInDb, deleteFromDb } from '../../utils/database.js';
import { query, T } from '../enforcement/db.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { dateStamp } from '../enforcement/format.js';
import { nukeAlertRow, postAlert } from './alertPost.js';
import { snapshotIfStale } from '../structureBackupService.js';

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

// Permissions that must never reach @everyone (and Administrator must reach no role) without the owner.
const DANGEROUS_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.MentionEveryone,
];
const WEBHOOK_LIMIT = 3;
// Audit log actions handleNukeEntry looks at (others never need the settings read).
const NUKE_ACTIONS = new Set([AuditLogEvent.BotAdd, AuditLogEvent.WebhookCreate, AuditLogEvent.RoleUpdate, AuditLogEvent.RoleCreate]);

export const GUARD_ACTIVITY_MAX = 5000;
const activity = new BoundedMap(GUARD_ACTIVITY_MAX); // guildId:executorId:kind → [at]

// Members the guard acted on in a nuke (guildId:userId → at): the nuke buttons refuse them even
// when their customId does not name them (another alert, or one from before a restart names them).
export const OFFENDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const recentOffenders = new BoundedMap(GUARD_ACTIVITY_MAX);

/** Remembers `userId` as the offender of a nuke in `guildId`. */
export function noteOffender(guildId, userId, at = Date.now()) {
    if (guildId && userId) recentOffenders.set(`${guildId}:${userId}`, at);
}

/** True when the guard acted on `userId` in `guildId` within OFFENDER_TTL_MS. */
export function isRecentOffender(guildId, userId, now = Date.now()) {
    const at = recentOffenders.get(`${guildId}:${userId}`);
    return Boolean(at && now - at < OFFENDER_TTL_MS);
}

/** Test hook. */
export function resetStaffGuardState() {
    activity.clear();
    recentOffenders.clear();
}

/** Test hook: how many executor windows are tracked. */
export function staffGuardStateSize() {
    return activity.size;
}

/**
 * Whether the guard runs in this server: always in the main server (as before); elsewhere only
 * with automod on and the staff guard turned on. Throws on a database error.
 */
export async function staffGuardOn(guildId) {
    if (isLegacyAutomodGuild(guildId)) return true;
    const settings = await getAutomodSettings(guildId);
    return Boolean(settings.enabled && settings.staffGuard);
}
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

/**
 * The roles saved for a /staff restore that still exist in the server (Role objects), or null
 * when nothing is saved. Read only. Throws on a DB error.
 */
export async function savedStaffRoles(guild, userId) {
    const backup = await getFromDb(backupKey(guild.id, userId), null);
    if (!backup?.roleIds?.length) return null;
    return backup.roleIds.map((id) => guild.roles.cache.get(id)).filter(Boolean);
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
    ], { guildId: guild.id, title: 'Staff roles restored' });
    return roles;
}

/**
 * Everyone whose removed staff roles are saved for a restore: [{ userId, roleIds, reason, at }],
 * newest first (for the dashboard). Throws on a DB error.
 */
export async function listRemovedStaffRoles(guildId) {
    const prefix = backupKey(guildId, '');
    const keys = await db.list(prefix);
    const out = [];
    for (const key of keys || []) {
        const userId = String(key).slice(prefix.length);
        if (!/^\d{17,20}$/.test(userId)) continue;
        const backup = await getFromDb(backupKey(guildId, userId), null);
        if (backup?.roleIds?.length) out.push({ userId, roleIds: backup.roleIds, reason: backup.reason || null, at: backup.at || null });
    }
    return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/**
 * The first step of a nuke alert: remember the offender and snapshot the server if its newest
 * snapshot is stale (the structure is captured right now, stored in the background: it never
 * delays the guard). Returns the detection time for the alert's buttons.
 */
function onNukeDetected(guild, offenderId) {
    const at = Date.now();
    noteOffender(guild.id, offenderId, at);
    snapshotIfStale(guild).catch(() => {});
    return at;
}

/** `nuke`: the alert gets the nuke buttons (nukeAlertRow); `at` from onNukeDetected. */
async function demote(guild, member, why, { nuke = false, at = Date.now() } = {}) {
    const { removed, kept } = await stripStaffRoles(member, `Staff guard: ${why}`);
    const summary = [
        `**Staff member:** ${member.user.username} (\`${member.id}\`)`,
        `**Why:** ${why}`,
        `**Removed roles:** ${removed.map((role) => role.name).join(', ') || 'none'}`,
        kept.length ? `**Could not remove (above my role):** ${kept.map((role) => role.name).join(', ')}` : null,
        'Restore with `/staff restore`.',
        nuke ? 'Undo the damage: **Show what changed**, then **Revert…** on the alert.' : null,
    ].filter(Boolean).join('\n');
    const fields = [
        { name: 'Staff member', value: `<@${member.id}> ${member.user.username} (\`${member.id}\`)` },
        { name: 'Why', value: why },
        { name: 'Removed roles', value: removed.map((role) => role.name).join(', ') || 'none' },
        ...(kept.length ? [{ name: 'Could not remove (above my role)', value: kept.map((role) => role.name).join(', ') }] : []),
        { name: 'Restore', value: nuke ? '`/staff restore` · damage: **Show what changed**, then **Revert…** · **Lock down (panic)** pauses invites and DMs' : '`/staff restore`' },
    ];
    if (nuke) await postAlert(guild.client, 'staff', { guildId: guild.id, title: 'Staff roles removed', fields, components: [nukeAlertRow(at, guild.id, member.id)] });
    else await postModLog(guild.client, 'staff', fields, { guildId: guild.id, title: 'Staff roles removed' });
    await alertOwner(guild, `**Staff guard in ${guild.name}**\n${summary}`);
    logger.warn(`Staff guard removed roles from ${member.id}: ${why}`);
}

async function alertNuke(guild, title, fields, { offenderId, at }) {
    await postAlert(guild.client, 'staff', { guildId: guild.id, title, fields, components: [nukeAlertRow(at, guild.id, offenderId)] });
    await alertOwner(guild, `**${title} in ${guild.name}**\n${fields.map((f) => `**${f.name}:** ${f.value}`).join('\n')}`);
}

function grantedBits(entry) {
    const change = entry.changes?.find((c) => c.key === 'permissions');
    if (!change) return 0n;
    const before = BigInt(change.old ?? 0);
    const after = BigInt(change.new ?? 0);
    return after & ~before;
}

async function demoteExecutor(guild, executorId, why, at) {
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (member) await demote(guild, member, why, { nuke: true, at }).catch((error) => logger.error(`Staff guard could not demote ${executorId}: ${error.message}`));
}

/** Anti-nuke checks for one audit log entry. Returns true when it handled the entry. */
async function handleNukeEntry(entry, guild) {
    const executorId = entry.executorId;
    const executor = `<@${executorId}> (\`${executorId}\`)`;

    if (entry.action === AuditLogEvent.BotAdd) {
        const botId = entry.targetId;
        const at = onNukeDetected(guild, executorId);
        const kicked = await guild.members.kick(botId, 'Anti-nuke: bot added without the owner').then(() => true).catch(() => false);
        await alertNuke(guild, 'Unapproved bot removed', [
            { name: 'Bot', value: `<@${botId}> (\`${botId}\`)` },
            { name: 'Added by', value: executor },
            { name: 'Result', value: kicked ? 'Kicked. The owner can add it again if it is wanted.' : 'Could not kick it (it may be above my role). Remove it by hand.' },
        ], { offenderId: executorId, at });
        return true;
    }

    if (entry.action === AuditLogEvent.WebhookCreate) {
        const now = Date.now();
        const key = `${guild.id}:${executorId}:webhook`;
        const times = (activity.get(key) || []).filter((at) => now - at <= automodConfig.guardWindowMs);
        times.push(now);
        activity.set(key, times);
        if (times.length < WEBHOOK_LIMIT) return true;
        activity.delete(key);

        const at = onNukeDetected(guild, executorId);
        const webhooks = await guild.fetchWebhooks().catch(() => null);
        const theirs = webhooks ? [...webhooks.values()].filter((hook) => hook.owner?.id === executorId) : [];
        for (const hook of theirs) await hook.delete('Anti-nuke: webhook spam').catch(() => {});
        await alertNuke(guild, 'Webhook spam stopped', [
            { name: 'Created by', value: executor },
            { name: 'Webhooks deleted', value: String(theirs.length) },
        ], { offenderId: executorId, at });
        await demoteExecutor(guild, executorId, `${times.length} webhooks created within ${automodConfig.guardWindowMs / 60000} minutes`, at);
        return true;
    }

    if (entry.action === AuditLogEvent.RoleUpdate || entry.action === AuditLogEvent.RoleCreate) {
        const granted = grantedBits(entry);
        if (!granted) return false;
        const role = guild.roles.cache.get(entry.targetId) || await guild.roles.fetch(entry.targetId).catch(() => null);
        if (!role) return false;
        const isEveryone = role.id === guild.id;
        const dangerous = DANGEROUS_PERMISSIONS.filter((flag) => (granted & flag) === flag);
        const flagged = isEveryone ? dangerous : dangerous.filter((flag) => flag === PermissionFlagsBits.Administrator);
        if (!flagged.length) return false;

        const at = onNukeDetected(guild, executorId);
        const reverted = flagged.reduce((bits, flag) => bits & ~flag, role.permissions.bitfield);
        const ok = await role.setPermissions(reverted, 'Anti-nuke: dangerous permission granted without the owner').then(() => true).catch(() => false);
        const names = flagged.map((flag) => Object.entries(PermissionFlagsBits).find(([, bit]) => bit === flag)?.[0]).join(', ');
        await alertNuke(guild, 'Dangerous permission reverted', [
            { name: 'Role', value: isEveryone ? '@everyone' : `${role.name} (\`${role.id}\`)` },
            { name: 'Granted', value: names },
            { name: 'By', value: executor },
            { name: 'Result', value: ok ? 'Reverted.' : 'Could not revert (the role may be above mine). Fix it by hand.' },
        ], { offenderId: executorId, at });
        await demoteExecutor(guild, executorId, `gave ${names} to ${isEveryone ? '@everyone' : role.name}`, at);
        return true;
    }
    return false;
}

/** Call for every audit log entry, in any server (staffGuardOn decides). */
export async function handleAuditLogEntry(entry, guild) {
    if (!guild?.id) return;
    const executorId = entry.executorId;
    if (!executorId || executorId === guild.ownerId || executorId === guild.client.user.id) return;
    if (!WATCHED[entry.action] && !NUKE_ACTIONS.has(entry.action)) return;
    if (!await staffGuardOn(guild.id)) return;
    if (await handleNukeEntry(entry, guild)) return;

    const kind = WATCHED[entry.action];
    if (!kind) return;

    const now = Date.now();
    const key = `${guild.id}:${executorId}:${kind}`;
    const times = (activity.get(key) || []).filter((at) => now - at <= automodConfig.guardWindowMs);
    times.push(now);
    activity.set(key, times);

    const limit = kind === 'banKick' ? automodConfig.guardBanKickLimit : automodConfig.guardDeleteLimit;
    if (times.length < limit) return;
    activity.delete(key);

    const at = kind === 'delete' ? onNukeDetected(guild, executorId) : Date.now();
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return;
    const minutes = automodConfig.guardWindowMs / 60000;
    const why = kind === 'banKick'
        ? `${times.length} bans/kicks within ${minutes} minutes`
        : `${times.length} channel/role deletions within ${minutes} minutes`;
    await demote(guild, member, why, { nuke: kind === 'delete', at }).catch((error) => logger.error(`Staff guard could not demote ${executorId}: ${error.message}`));
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
    ], { guildId: guild.id, title: 'Staff warning' });
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
