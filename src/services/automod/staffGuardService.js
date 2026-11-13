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
//
// Quarantine (enforcement/quarantineService.js): when the server has a quarantine role Mewvo can
// give, an offender the guard catches (bans/kicks, deletes, webhooks, dangerous permissions) is
// quarantined instead: every role saved and removed, the quarantine role given, head admins
// pinged, a Release button on the alert (next to the nuke buttons). Refused (no role, offender at
// or above Mewvo, a bot) or failed: the staff roles are stripped as before. Staff warnings never
// quarantine (a warning limit is no attack). /staff restore (restoreStaffRoles) also lifts a
// staff guard quarantine, so both restore paths keep working.

import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { automodConfig } from '../../config/automod.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { getAutomodSettings, isLegacyAutomodGuild } from './automodSettings.js';
import { db, getFromDb, setInDb, deleteFromDb } from '../../utils/database.js';
import { query, T } from '../enforcement/db.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { dateStamp, truncate } from '../enforcement/format.js';
import { durationIn } from '../enforcement/dmTemplates.js';
import { botText, textForGuild } from '../../utils/botText.js';
import { nukeAlertRow, postAlert } from './alertPost.js';
import { snapshotIfStale } from '../structureBackupService.js';
import { getQuarantine, listQuarantines, quarantineMember, quarantineReady, releaseQuarantine } from '../enforcement/quarantineService.js';

// Quarantine (enforcement/quarantineService.js), replaceable in tests (setStaffGuardDepsForTest).
const defaultGuardDeps = {
    quarantineReady: (...args) => quarantineReady(...args),
    quarantineMember: (...args) => quarantineMember(...args),
    getQuarantine: (...args) => getQuarantine(...args),
    listQuarantines: (...args) => listQuarantines(...args),
    releaseQuarantine: (...args) => releaseQuarantine(...args),
};
let guardDeps = { ...defaultGuardDeps };

/** Test hook: replace the quarantine calls (no argument restores them). */
export function setStaffGuardDepsForTest(overrides = null) {
    guardDeps = overrides ? { ...defaultGuardDeps, ...overrides } : { ...defaultGuardDeps };
}

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

// Language (docs/bot-i18n.md): staff-channel posts and the owner's DM are in the server's language
// (the same setting today; the DM asks with purpose 'dm' so a later member preference applies).
// What is stored (the saved-roles reason, Discord audit log reasons) stays English.
const postText = (guild) => textForGuild(guild.id, { purpose: 'public' });

/** `build(tr)` → the DM text in the owner's language (cut to Discord's 2000). */
async function alertOwner(guild, build) {
    const owner = await guild.fetchOwner().catch(() => null);
    if (!owner) return;
    const tr = textForGuild(guild.id, { member: owner, userId: owner.id, purpose: 'dm' });
    await owner.send({ content: truncate(build(tr), 2000), allowedMentions: { parse: [] } }).catch(() => {});
}

/**
 * Why the guard acted, as { en, text(tr) }: `en` is stored with the saved roles and in the audit
 * log; text(tr) is shown. kind: banKick | deletes | webhooks | permission | staffWarnings.
 */
export function guardWhy(kind, { count = 0, permissions = '', role = '' } = {}) {
    const text = (tr) => {
        const window = durationIn(automodConfig.guardWindowMs, tr.lang);
        if (kind === 'banKick') return tr.tp('automod.guard.why.banKick', count, { window });
        if (kind === 'deletes') return tr.tp('automod.guard.why.deletes', count, { window });
        if (kind === 'webhooks') return tr.tp('automod.guard.why.webhooks', count, { window });
        if (kind === 'permission') return tr.t('automod.guard.why.permission', { permissions, role });
        return tr.tp('automod.guard.why.staffWarnings', count);
    };
    return { en: text(botText('en')), text };
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
    const quarantined = await guardQuarantine(guild.id, userId);
    const roleIds = [...new Set([...(backup?.roleIds || []), ...(quarantined?.roles || [])])];
    if (!backup?.roleIds?.length && !quarantined) return null;
    return roleIds.map((id) => guild.roles.cache.get(id)).filter(Boolean);
}

/** The member's quarantine record when the staff guard made it, else null. Throws on a DB error. */
async function guardQuarantine(guildId, userId) {
    const record = await guardDeps.getQuarantine(guildId, userId);
    return record?.trigger === 'staffGuard' ? record : null;
}

/** Gives back the roles removed by the guard or by staff warnings. Returns the restored roles. */
export async function restoreStaffRoles(guild, userId, restoredBy) {
    const backup = await getFromDb(backupKey(guild.id, userId), null);
    const quarantined = await guardQuarantine(guild.id, userId);
    if (!backup?.roleIds?.length && !quarantined) return null;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return null;
    let roles = [];
    if (quarantined) {
        // A staff guard quarantine: released (all saved roles back, the quarantine role off).
        const released = await guardDeps.releaseQuarantine(guild, userId, { by: { id: restoredBy.id, username: restoredBy.username } });
        if (released?.ok) roles = released.restored || [];
    }
    if (backup?.roleIds?.length) {
        const saved = backup.roleIds.map((id) => guild.roles.cache.get(id)).filter((role) => role?.editable && !roles.some((r) => r.id === role.id));
        if (saved.length) await member.roles.add(saved, `Staff roles restored by ${restoredBy.username}`);
        roles = [...roles, ...saved];
        await deleteFromDb(backupKey(guild.id, userId));
    }
    const tr = postText(guild);
    await postModLog(guild.client, 'staff', [
        { name: tr.t('automod.guard.field.staffMember'), value: `<@${userId}> ${member.user.username} (\`${userId}\`)` },
        { name: tr.t('automod.guard.field.restoredBy'), value: `${restoredBy.username} (${restoredBy.id})` },
        { name: tr.t('automod.guard.field.roles'), value: roles.map((role) => role.name).join(', ') || tr.t('automod.guard.noneRestored') },
    ], { guildId: guild.id, title: tr.t('automod.guard.title.restored') });
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
    // Staff guard quarantines: their saved roles come back with /staff restore too.
    for (const record of await guardDeps.listQuarantines(guildId)) {
        if (record.trigger !== 'staffGuard') continue;
        const existing = out.find((row) => row.userId === record.userId);
        if (existing) existing.roleIds = [...new Set([...existing.roleIds, ...(record.roles || [])])];
        else out.push({ userId: record.userId, roleIds: record.roles || [], reason: record.reason || null, at: record.at || null });
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

/** `nuke`: the alert gets the nuke buttons (nukeAlertRow); `at` from onNukeDetected. `why`: guardWhy(). */
/**
 * The "Staff roles removed" post and the owner's DM text, in one language (pure, for tests):
 * { title, fields, summary }. `member`: { id, user: { username } }; `why`: guardWhy(); role names.
 */
export function staffRemovedContent({ member, why, removedNames = '', keptNames = '', nuke = false }, { lang = 'en' } = {}) {
    const tr = botText(lang);
    // The nuke alert's button labels (alertPost.js nukeAlertRow), so the text names them as shown.
    const buttons = { showDiff: tr.t('automod.alert.showDiff'), revert: tr.t('automod.alert.revert'), panic: tr.t('automod.alert.panic') };
    const summary = [
        tr.t('automod.guard.summary.staffMember', { name: member.user.username, id: member.id }),
        tr.t('automod.guard.summary.why', { why: why.text(tr) }),
        tr.t('automod.guard.summary.removed', { roles: removedNames || tr.t('automod.guard.none') }),
        keptNames ? tr.t('automod.guard.summary.couldNot', { roles: keptNames }) : null,
        tr.t('automod.guard.summary.restore'),
        nuke ? tr.t('automod.guard.summary.nukeUndo', buttons) : null,
    ].filter(Boolean).join('\n');
    const fields = [
        { name: tr.t('automod.guard.field.staffMember'), value: `<@${member.id}> ${member.user.username} (\`${member.id}\`)` },
        { name: tr.t('automod.guard.field.why'), value: why.text(tr) },
        { name: tr.t('automod.guard.field.removedRoles'), value: removedNames || tr.t('automod.guard.none') },
        ...(keptNames ? [{ name: tr.t('automod.guard.field.couldNot'), value: keptNames }] : []),
        { name: tr.t('automod.guard.field.restore'), value: nuke ? tr.t('automod.guard.restoreNuke', buttons) : '`/staff restore`' },
    ];
    return { title: tr.t('automod.guard.title.removed'), fields, summary };
}

async function demote(guild, member, why, { nuke = false, at = Date.now(), quarantine = true } = {}) {
    if (quarantine && guardDeps.quarantineReady(guild)) {
        const quarantined = await guardDeps.quarantineMember(member, `Staff guard: ${why.en}`, {
            automated: true, trigger: 'staffGuard', reasonText: why.text,
            extraComponents: nuke ? [nukeAlertRow(at, guild.id, member.id)] : [],
        }).catch((error) => ({ ok: false, code: 'error', error }));
        if (quarantined.ok) {
            const removedNames = quarantined.removed.map((role) => role.name).join(', ');
            await alertOwner(guild, (dmTr) => [
                dmTr.t('automod.guard.dm.header', { server: guild.name }),
                staffRemovedContent({ member, why, nuke, removedNames }, { lang: dmTr.lang }).summary,
                dmTr.t('enforcement.quarantine.ownerDm'),
            ].join('\n'));
            logger.warn(`Staff guard quarantined ${member.id}: ${why.en}`);
            return;
        }
        logger.warn(`Staff guard: quarantine of ${member.id} not done (${quarantined.code}); removing staff roles instead`);
    }
    const { removed, kept } = await stripStaffRoles(member, `Staff guard: ${why.en}`);
    const names = { removedNames: removed.map((role) => role.name).join(', '), keptNames: kept.map((role) => role.name).join(', ') };
    const { title, fields } = staffRemovedContent({ member, why, nuke, ...names }, { lang: postText(guild).lang });
    if (nuke) await postAlert(guild.client, 'staff', { guildId: guild.id, title, fields, components: [nukeAlertRow(at, guild.id, member.id)] });
    else await postModLog(guild.client, 'staff', fields, { guildId: guild.id, title });
    await alertOwner(guild, (dmTr) => `${dmTr.t('automod.guard.dm.header', { server: guild.name })}\n${staffRemovedContent({ member, why, nuke, ...names }, { lang: dmTr.lang }).summary}`);
    logger.warn(`Staff guard removed roles from ${member.id}: ${why.en}`);
}

/**
 * A nuke alert's { title, fields } in one language (pure, for tests). kind: botAdded
 * { botId, executor, kicked } | webhooks { executor, deleted } | permission { roleText, names, executor, ok }.
 */
export function nukeAlertContent(kind, d, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (kind === 'botAdded') {
        return {
            title: tr.t('automod.guard.title.botRemoved'),
            fields: [
                { name: tr.t('automod.guard.field.bot'), value: `<@${d.botId}> (\`${d.botId}\`)` },
                { name: tr.t('automod.guard.field.addedBy'), value: d.executor },
                { name: tr.t('automod.guard.field.result'), value: d.kicked ? tr.t('automod.guard.result.kicked') : tr.t('automod.guard.result.kickFailed') },
            ],
        };
    }
    if (kind === 'webhooks') {
        return {
            title: tr.t('automod.guard.title.webhookSpam'),
            fields: [
                { name: tr.t('automod.guard.field.createdBy'), value: d.executor },
                { name: tr.t('automod.guard.field.webhooksDeleted'), value: String(d.deleted) },
            ],
        };
    }
    return {
        title: tr.t('automod.guard.title.permissionReverted'),
        fields: [
            { name: tr.t('automod.guard.field.role'), value: d.roleText },
            { name: tr.t('automod.guard.field.granted'), value: d.names },
            { name: tr.t('automod.guard.field.by'), value: d.executor },
            { name: tr.t('automod.guard.field.result'), value: d.ok ? tr.t('automod.guard.result.reverted') : tr.t('automod.guard.result.revertFailed') },
        ],
    };
}

/** `build(tr)` → { title, fields } in a language: the alert (server's) and the owner's DM. */
async function alertNuke(guild, build, { offenderId, at }) {
    const { title, fields } = build(postText(guild));
    await postAlert(guild.client, 'staff', { guildId: guild.id, title, fields, components: [nukeAlertRow(at, guild.id, offenderId)] });
    await alertOwner(guild, (tr) => {
        const dm = build(tr);
        return `${tr.t('automod.guard.dm.nukeHeader', { title: dm.title, server: guild.name })}\n${dm.fields.map((f) => `**${f.name}:** ${f.value}`).join('\n')}`;
    });
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
        await alertNuke(guild, (tr) => nukeAlertContent('botAdded', { botId, executor, kicked }, { lang: tr.lang }), { offenderId: executorId, at });
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
        await alertNuke(guild, (tr) => nukeAlertContent('webhooks', { executor, deleted: theirs.length }, { lang: tr.lang }), { offenderId: executorId, at });
        await demoteExecutor(guild, executorId, guardWhy('webhooks', { count: times.length }), at);
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
        const roleText = isEveryone ? '@everyone' : `${role.name} (\`${role.id}\`)`;
        await alertNuke(guild, (tr) => nukeAlertContent('permission', { roleText, names, executor, ok }, { lang: tr.lang }), { offenderId: executorId, at });
        await demoteExecutor(guild, executorId, guardWhy('permission', { permissions: names, role: isEveryone ? '@everyone' : role.name }), at);
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
    const why = guardWhy(kind === 'banKick' ? 'banKick' : 'deletes', { count: times.length });
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

    const limit = automodConfig.staffWarnLimit;
    const tr = postText(guild);
    await postModLog(guild.client, 'staff', [
        { name: tr.t('automod.guard.field.staffMember'), value: `<@${member.id}> ${member.user.username} (\`${member.id}\`)` },
        { name: tr.t('automod.guard.field.givenBy'), value: `${giver.username} (${giver.id})` },
        { name: tr.t('automod.guard.field.reason'), value: reason },
        { name: tr.t('automod.guard.field.activeWarnings'), value: tr.t('automod.guard.ofLimit', { active, limit }), inline: true },
        { name: tr.t('automod.guard.field.expires'), value: dateStamp(expiresAt), inline: true },
    ], { guildId: guild.id, title: tr.t('automod.guard.title.staffWarning') });
    // DM to the staff member: the server's language.
    const dmTr = textForGuild(guild.id, { member, userId: member.id, purpose: 'dm' });
    await member.send({
        content: truncate([
            dmTr.t('automod.guard.warnDm.header', { server: guild.name, active, limit }),
            dmTr.t('enforcement.dm.reason', { reason }),
            dmTr.t('automod.guard.warnDm.expires', { date: dateStamp(expiresAt), limit }),
        ].join('\n'), 2000),
        allowedMentions: { parse: [] },
    }).catch(() => {});

    let demoted = false;
    if (active >= automodConfig.staffWarnLimit) {
        await demote(guild, member, guardWhy('staffWarnings', { count: active }), { quarantine: false });
        demoted = true;
    }
    return { active, demoted };
}
