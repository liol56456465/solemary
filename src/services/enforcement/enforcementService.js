// enforcementService.js — executes panel actions: ban, kick, mute, warn, unban,
// unmute, remove warn. Every action is serialized per guild + user, records a
// case, DMs the user before a kick or ban, and logs through loggingService.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { ModerationService } from '../moderation/moderationService.js';
import { logEvent, EVENT_TYPES, resolveLogChannel } from '../loggingService.js';
import { logForumId, sendToLogForum } from '../logForum.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { Mutex } from '../../utils/mutex.js';
import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { query, withTransaction, T } from './db.js';
import { insertCase, setDmDelivered, setEndDmDelivered, countUncountedWarns, getActiveCase, nextDefaultName, OPEN_STATUSES } from './caseService.js';
import { ensureMutedRole, addMutedRole, removeMutedRole, findMutedRole, mutedRoleGaps, mutedRoleGapNotes } from './muteService.js';
import { contestComponents } from './dmTemplates.js';
import { addMonths, formatDuration, dateStamp, ladderStageShort } from './format.js';
import { ladderStageIn } from './precedentService.js';
import { durationIn } from './dmTemplates.js';
import { botText } from '../../utils/botText.js';
import { syncBannedRoleQuietly } from './bannedRoleService.js';
import { syncWarnRolesQuietly } from './warnRoleService.js';
import { enforceMassActionGuard } from './massActionGuard.js';
import { endTempRoles } from '../members/tempRoleService.js';
import { createEmbed } from '../../utils/embeds.js';
import { ACTION_KINDS, channelPurposeFor, formatModLogLine, resolveChannelId, staffGuildId } from '../automod/channelRouting.js';
import { guildSetting, isSettingsUnavailable, noteSettingsUnavailable } from '../settings/guildScoped.js';
import { alertWatched } from './watchlistService.js';
import { isWarnLadderEnabled, warnCountsOnLadder } from './ladderPolicy.js';
import { clearPostFailures, recordPostFailure, recordSendError } from '../automod/postFailures.js';
import { sendLoggedDm } from '../botDm/dmLog.js';
import { caseParams } from '../botDm/dmRenderers.js';

/**
 * A punishment DM from its template (botDm/dmRenderers.js 'enf.*'), logged so a language change can
 * edit it later (botDm/dmLog.js). The language: resolveBotLanguage purpose 'dm' (the member's
 * language role, else the server's). Returns true when delivered; never throws on a failed send.
 */
export function sendCaseDm(user, key, record, { guild = null, guildId = null, member = null, components = null, ...extra } = {}) {
    const gid = guildId ?? guild?.id ?? record?.guild_id ?? null;
    // The "Contest this" button is rendered from the stored params (contestCode), not passed as
    // extra components, so the DM language re-edit (dmRelang.js) translates its label too.
    const contestCode = components?.contestCode ?? null;
    return sendLoggedDm(user, {
        key,
        params: { rec: caseParams(record), guildId: gid, serverName: guild?.name ?? null, ...(contestCode ? { contestCode } : {}), ...extra },
        guildId: gid, member, components: contestCode ? null : components, label: `${key}${record?.case_code ? ` (${record.case_code})` : ''}`,
    });
}

/** Every server permission some panel action needs (the union of ACTION_BOT_PERMISSIONS). */
export const REQUIRED_BOT_PERMISSIONS = [
    ['BanMembers', 'Ban Members'],
    ['KickMembers', 'Kick Members'],
    ['ManageRoles', 'Manage Roles'],
    ['ManageChannels', 'Manage Channels'],
    ['CreateInstantInvite', 'Create Invite'],
];

/**
 * What Mewvo itself needs per action (audit 3.6): a warn or a removed warn needs nothing beyond
 * answering; a mute needs Manage Roles + Manage Channels (the muted role and its channel
 * overwrites); an unmute Manage Roles; a kick Kick Members + Create Invite (the one-time rejoin
 * invite); a ban or unban Ban Members.
 */
export const ACTION_BOT_PERMISSIONS = Object.freeze({
    warn: [],
    removewarn: [],
    mute: ['ManageRoles', 'ManageChannels'],
    unmute: ['ManageRoles'],
    kick: ['KickMembers', 'CreateInstantInvite'],
    ban: ['BanMembers'],
    unban: ['BanMembers'],
});

/** Discord's "Missing Permissions" error code. */
export const MISSING_PERMISSIONS = 50013;

function userError(message, type = ErrorTypes.VALIDATION) {
    return createError(message, type, message, { expected: true });
}

/** A permission's name as Discord shows it, in a language. */
export function permissionLabel(flag, lang = 'en') {
    return botText(lang).t(`staff.enfCheck.perm.${flag}`);
}

export function isAdministrator(member) {
    if (!member) return false;
    if (member.guild?.ownerId === member.id) return true;
    return Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));
}

/**
 * The permissions Mewvo lacks for `action` (labels in `lang`). `action` null: every permission
 * any action needs (REQUIRED_BOT_PERMISSIONS), for a setup overview.
 */
export function getMissingBotPermissions(guild, action = null, { lang = 'en' } = {}) {
    const me = guild.members.me;
    const flags = action ? (ACTION_BOT_PERMISSIONS[action] ?? []) : REQUIRED_BOT_PERMISSIONS.map(([flag]) => flag);
    return flags
        .filter((flag) => !me?.permissions?.has(PermissionFlagsBits[flag]))
        .map((flag) => permissionLabel(flag, lang));
}

/** Refuses with what to fix when Mewvo lacks a permission `action` needs (nothing for a warn). */
export function assertBotPermissions(guild, action = null, { lang = 'en' } = {}) {
    const missing = getMissingBotPermissions(guild, action, { lang });
    if (missing.length > 0) {
        throw userError(botText(lang).t('staff.enfCheck.missingPerms', { list: missing.join(', ') }), ErrorTypes.PERMISSION);
    }
}

/**
 * Refuses the owner, the bot, yourself, and anyone with an equal or higher role
 * than the moderator (or the bot). Non-members can only be checked by ID.
 * The texts are action-neutral, so they translate; `action` stays for the callers.
 */
export function assertCanTarget(guild, moderator, targetUserId, targetMember, action, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (targetUserId === moderator.id) {
        throw userError(tr.t('staff.enfCheck.self'));
    }
    if (targetUserId === guild.client.user.id) {
        throw userError(tr.t('staff.enfCheck.bot'));
    }
    if (targetUserId === guild.ownerId) {
        throw userError(tr.t('staff.enfCheck.owner'));
    }
    if (targetMember) {
        ModerationService.assertModerationHierarchy(moderator, targetMember, action, { lang });
    }
}

/**
 * Before the ban/kick DM (audit 1.3): Mewvo must hold the permission and be able to act on this
 * member (role order), else nothing is sent and the moderator is told what to fix.
 * `targetMember` null: not in the server (a ban by ID; only the permission counts).
 */
export function assertBotCanRemove(guild, kind, targetMember, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const flag = kind === 'ban' ? 'BanMembers' : 'KickMembers';
    if (!guild.members?.me?.permissions?.has?.(PermissionFlagsBits[flag])) {
        throw userError(tr.t(kind === 'ban' ? 'staff.enfCheck.cannotBanPerm' : 'staff.enfCheck.cannotKickPerm'), ErrorTypes.PERMISSION);
    }
    // discord.js: bannable / kickable = the permission + Mewvo's highest role above theirs (+ not the owner).
    const able = kind === 'ban' ? targetMember?.bannable : targetMember?.kickable;
    if (targetMember && able === false) {
        const role = targetMember.roles?.highest?.name ?? '?';
        throw userError(tr.t(kind === 'ban' ? 'staff.enfCheck.cannotBanRole' : 'staff.enfCheck.cannotKickRole', { role }), ErrorTypes.PERMISSION);
    }
}

/**
 * Discord refused `kind` (ban, kick, mute, unban, unmute): an actionable, translated message.
 * 50013 (Missing Permissions) names the permission and, when known, the role to move above.
 */
export function refusalMessage(kind, error, { lang = 'en', role = null } = {}) {
    const tr = botText(lang);
    if (error?.code === MISSING_PERMISSIONS) {
        const flags = { ban: 'BanMembers', unban: 'BanMembers', kick: 'KickMembers', mute: 'ManageRoles', unmute: 'ManageRoles' };
        const permission = permissionLabel(flags[kind] ?? 'BanMembers', lang);
        return role
            ? tr.t('staff.enfCheck.refusedMissingRole', { permission, role })
            : tr.t('staff.enfCheck.refusedMissing', { permission });
    }
    return tr.t(`staff.enfCheck.refused.${kind}`, { error: error?.message || String(error) });
}

/** Serializes every enforcement change to one user in one guild (panel, expiry, appeals, /case). */
export async function lockFor(guildId, userId, task) {
    return Mutex.runExclusive(`enforcement:${guildId}:${userId}`, task);
}

export async function sendDm(user, content, components = null) {
    try {
        await user.send({ content, allowedMentions: { parse: [] }, ...(components?.length ? { components } : {}) });
        return true;
    } catch (error) {
        logger.info(`Enforcement DM to ${user.id} failed: ${error.message}`);
        return false;
    }
}

/** One-time invite to the guild: 1 use, expires in 7 days. */
export async function createRejoinInvite(guild, reason) {
    const me = guild.members.me;
    const candidates = [guild.rulesChannel, guild.systemChannel, ...guild.channels.cache.values()];
    const channel = candidates.find((c) => c
        && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        && c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite));

    if (!channel) {
        logger.warn(`No channel available for a rejoin invite in guild ${guild.id}`);
        return null;
    }

    try {
        const invite = await guild.invites.create(channel, {
            maxUses: 1,
            maxAge: guildSetting(guild.id, 'rejoinInviteMaxAgeSeconds', enforcementConfig),
            unique: true,
            reason,
        });
        return invite.url;
    } catch (error) {
        logger.warn(`Could not create rejoin invite in guild ${guild.id}: ${error.message}`);
        return null;
    }
}

/**
 * DMs "your ban/mute has ended" once and records the outcome on the given cases
 * (end_dm_delivered). A banned user often shares no server with the bot, so the DM
 * may fail: that is logged and recorded, never retried. Never throws.
 * `type` is 'ban' or 'mute'; `early` means a moderator lifted it before it expired.
 */
export async function notifyPunishmentEnded(client, guild, { type, userId, records = [], early = false }) {
    try {
        const record = records[0] || null;
        const user = await client.users.fetch(userId).catch(() => null);
        let delivered = false;
        if (user) {
            if (type === 'ban') {
                const invite = guild ? await createRejoinInvite(guild, `Ban ended${record ? ` (${record.case_code})` : ''}`) : null;
                delivered = await sendCaseDm(user, 'enf.banEnded', record, { guild, invite, early });
            } else {
                delivered = await sendCaseDm(user, 'enf.muteEnded', record, { guild, early });
            }
        }
        if (!delivered) {
            logger.info(`"${type} ended" DM to ${userId} not delivered${record ? ` (${record.case_code})` : ''}; not retrying`);
        }
        await setEndDmDelivered(records.map((row) => row.id), delivered);
        return delivered;
    } catch (error) {
        logger.warn(`"${type} ended" DM for ${userId} failed: ${error.message}`);
        return false;
    }
}

const LOG_TYPES = {
    ban: EVENT_TYPES.MODERATION_BAN,
    kick: EVENT_TYPES.MODERATION_KICK,
    mute: EVENT_TYPES.MODERATION_MUTE,
    warn: EVENT_TYPES.MODERATION_WARN,
    unban: EVENT_TYPES.MODERATION_UNBAN,
    unmute: EVENT_TYPES.MODERATION_UNMUTE,
    removewarn: EVENT_TYPES.MODERATION_WARN_REMOVE,
};

const MOD_LOG_TITLES = {
    ban: ['Ban', 'error'],
    kick: ['Kick', 'warning'],
    mute: ['Mute', 'warning'],
    warn: ['Warning', 'warning'],
    unban: ['Unban', 'success'],
    unmute: ['Unmute', 'success'],
    removewarn: ['Warning removed', 'success'],
    nocontact: ['Keep apart', 'warning'],
    watch: ['Watchlist', 'warning'],
    caseedit: ['Case edited', 'secondary'],
    casevoid: ['Case removed (a mistake)', 'secondary'],
    appeal: ['Appeal decided', 'primary'],
    raid: ['Join raid', 'error'],
    staff: ['Staff guard', 'error'],
    massguard: ['Safety limit (too many bans, kicks or mutes)', 'error'],
    automod: ['Automod', 'primary'],
    'automod-report': ['Automod report', 'primary'],
    'server-digest': ['Weekly server digest', 'primary'],
    slowmode: ['Auto slowmode', 'info'],
    digest: ['Daily automod digest', 'primary'],
    system: ['Bot problem', 'error'],
    revert: ['Server structure reverted', 'success'],
    dashboard: ['Dashboard change', 'secondary'],
    logDeleted: ['Log message deleted', 'warning'],
};

/**
 * Posts one staff log entry. Routed by kind (services/automod/channelRouting.js):
 * enforcement actions go to the mod log as one line; raids, staff guard, slowmode,
 * digests and reports go to the alerts channel (falls back to the mod log).
 * `guildId`: the server the entry is about. Home servers (main + support) post in the main
 * server's channels, as before; any other server only in its own (not set: recorded, skipped).
 * Its settings not readable (database down at boot): skipped, logged once in a while.
 */
const SUBJECT_FIELDS = new Set(['User', 'Member', 'Target', 'Appellant']);

/** { id, username } from a "User" / "Member" / "Target" / "Appellant" field shaped "name (id)" or "<@id> (id)", else null. Pure. */
export function subjectFromFields(fields) {
    for (const field of Array.isArray(fields) ? fields : []) {
        if (!SUBJECT_FIELDS.has(field?.name)) continue;
        const match = /^([^()]*?)\s*\((\d{17,20})\)\s*$/.exec(String(field.value || ''));
        if (!match) continue;
        const name = match[1].trim();
        return { id: match[2], username: name && !/^<@!?\d+>$/.test(name) ? name : null };
    }
    return null;
}

export async function postModLog(client, action, fields, {
    title = null, files = [], description = null, footer = null, guildId: sourceGuildId = enforcementConfig.mainGuildId,
    // { id, username } of the member the entry is about (the punished member, the dashboard user):
    // picks their post when this kind is "Advanced" (logForum.js); without it the "Server logs" post.
    subject = null,
} = {}) {
    const purpose = channelPurposeFor(action);
    let channelId;
    let forumId = null;
    try {
        channelId = resolveChannelId(sourceGuildId, purpose);
        // Records in the mod log (punishments, case edits, appeals) and dashboard/website changes may
        // be "Advanced" (a forum, one post per member; Logging page). A config read error keeps the normal channel.
        const forumKind = action === 'dashboard' ? 'dashboard' : purpose === 'modlog' ? 'modlog' : null;
        if (forumKind) {
            const config = await getGuildConfig(client, staffGuildId(sourceGuildId)).catch(() => null);
            // Dashboard/website changes: their own log channel when one is set (Logging page).
            if (action === 'dashboard') {
                const own = config ? resolveLogChannel(config, 'dashboard') : null;
                if (own) channelId = own;
            }
            forumId = logForumId(config, forumKind);
        }
    } catch (error) {
        if (!isSettingsUnavailable(error)) throw error;
        noteSettingsUnavailable(sourceGuildId, `staff ${purpose} post (${action})`);
        return false;
    }
    const guildId = staffGuildId(sourceGuildId);
    // No subject passed (appeals, case edits, watchlist…): the member of the usual "User: name (id)" field.
    const about = subject || subjectFromFields(fields);
    const [defaultTitle, color] = MOD_LOG_TITLES[action] || [action, 'primary'];
    const embed = ACTION_KINDS.has(action) && !title
        ? createEmbed({ description: formatModLogLine(action, fields), color, timestamp: true })
        : createEmbed({ title: title || defaultTitle, description, fields, color, footer, timestamp: true });
    if (forumId) {
        const forumGuild = client.guilds?.cache?.get(guildId);
        const posted = forumGuild ? await sendToLogForum({ guild: forumGuild, forumId, subject: about, payload: { embeds: [embed], files } }) : null;
        if (posted) {
            clearPostFailures(guildId, purpose);
            return true;
        }
        // Not possible (missing forum, permissions): the normal channel below.
    }
    // Not posting is recorded (postFailures.js), so the dashboard Overview can show it.
    if (!channelId) {
        recordPostFailure({ guildId, purpose, reason: 'notSet' });
        return false;
    }
    const guild = client.guilds.cache.get(guildId);
    const channel = guild && (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased?.()) {
        logger.warn(`Staff ${purpose} channel ${channelId} is not a text channel in guild ${guildId}`);
        if (guild) recordPostFailure({ guildId, purpose, channelId, reason: 'missing' });
        return false;
    }
    return channel.send({
        embeds: [embed],
        files,
        allowedMentions: { parse: [] },
    }).then(() => {
        clearPostFailures(guildId, purpose);
        return true;
    }, (error) => {
        logger.warn(`Staff ${purpose} post failed: ${error.message}`);
        recordSendError({ guildId, purpose, channel, error, files: files.length > 0 });
        return false;
    });
}

export async function logEnforcement(client, guildId, action, { record = null, target, moderatorLabel, extra = [] }) {
    const fields = [
        { name: 'User', value: `${target.username} (${target.id})` },
        { name: 'Moderator', value: moderatorLabel },
    ];
    if (record) {
        fields.push(
            { name: 'Case', value: `\`${record.case_code}\` · ${record.name}` },
            { name: 'Reason', value: record.reason },
        );
        if (record.type === 'ban' || record.type === 'mute') {
            fields.push({
                name: 'Duration',
                value: record.expires_at
                    ? `${formatDuration(Number(record.duration_ms))} (ends ${dateStamp(record.expires_at)})`
                    : 'Permanent',
            });
        }
        if (!record.dm_delivered && ['ban', 'kick', 'mute', 'warn'].includes(record.type)) {
            fields.push({ name: 'DM', value: 'Not delivered' });
        }
    }
    fields.push(...extra);

    // Owner (2026-11-10): enforcements belong in the staff mod log only. The general log
    // channel gets a copy only when no mod log channel is set (or for test records, which
    // never reach the mod log), so nothing is posted twice.
    let hasModLog = false;
    try {
        hasModLog = Boolean(resolveChannelId(guildId, channelPurposeFor(action)));
    } catch {
        hasModLog = false;
    }
    // An "Advanced" mod log (a forum, Logging page) counts as a mod log too.
    if (!hasModLog) {
        hasModLog = Boolean(logForumId(await getGuildConfig(client, staffGuildId(guildId)).catch(() => null), 'modlog'));
    }
    // The member's post when the mod log is "Advanced" (logForum.js).
    const subject = { id: target.id, username: target.username };
    // Posted in the mod log: done. Not posted (channel gone, no access): the general log copy.
    if (hasModLog && !record?.is_test && await postModLog(client, action, fields, { guildId, subject })) return;
    await logEvent({
        client,
        guildId,
        eventType: LOG_TYPES[action],
        data: { userId: target.id, username: target.username, fields },
    }).catch((error) => logger.warn(`Enforcement log failed: ${error.message}`));
    if (record?.is_test) return;
    await postModLog(client, action, fields, { guildId, subject });
}

function moderatorFields(moderator) {
    return { moderatorId: moderator.id, moderatorUsername: moderator.user.username };
}

async function isBanned(guild, userId) {
    return Boolean(await guild.bans.fetch({ user: userId, force: true }).catch(() => null));
}

// ── Actions ────────────────────────────────────────────────────────────────

/**
 * flow: { type, targetId, reason, reasonSource, reasonKey, durationMs, name, unappealable }
 * staffRole (dashboard Moderator level only): { roleId, actions } — a moderator without
 * Administrator may run flow.type when it is in `actions` and they hold `roleId` right now.
 * Returns { record, dmDelivered, notes[] } for the moderator's confirmation message.
 */
export async function executeAction({ guild, moderator, targetUser, flow, staffRole = null, lang = 'en' }) {
    const tr = botText(lang);
    const asModerator = Boolean(staffRole?.roleId && Array.isArray(staffRole.actions) && staffRole.actions.includes(flow?.type)
        && moderator?.roles?.cache?.has?.(staffRole.roleId));
    if (!isAdministrator(moderator) && !asModerator) {
        throw userError(tr.t('staff.enforcements.noAdmin'), ErrorTypes.PERMISSION);
    }
    // Only what this action needs (audit 3.6): a warn needs no Ban/Kick/Roles/Channels/Invite.
    assertBotPermissions(guild, flow?.type, { lang });
    // One action at a time per moderator, so the mass-action count can't be raced
    // by clicking several panels at once.
    return Mutex.runExclusive(`panel-mod:${guild.id}:${moderator.id}`, async () => {
        // Checked under the target's lock (see runAction), so the ladder read here is the one the
        // warn will use: a warn that escalates bans the member, so it counts as a ban.
        let guardNote = null;
        const guard = async () => {
            const guardType = flow.type === 'warn' && previewWarn(await getLadder(guild.id, targetUser.id)).escalates ? 'ban' : flow.type;
            // A moderator (dashboard, or the Discord Moderator role) may not ban, so not through the warn ladder either.
            if (guardType === 'ban' && !isAdministrator(moderator) && !staffRole?.actions?.includes?.('ban')) {
                throw userError(tr.t('staff.enfCheck.ladderNeedsAdmin', { name: targetUser.username }), ErrorTypes.PERMISSION);
            }
            // The refusal and the "one more" heads-up: the panel user's language.
            guardNote = (await enforceMassActionGuard(guild, moderator, guardType, { lang }))?.warning ?? null;
        };
        const result = await runAction({ guild, moderator, targetUser, flow, guard, lang });
        if (guardNote && Array.isArray(result?.notes)) result.notes.push(guardNote);
        return result;
    });
}

/**
 * The same actions taken by the bot itself (automod, staff-applied automod flags):
 * the bot is the moderator, so there is no Administrator check, but the lock,
 * hierarchy checks, DMs, cases and logs are identical.
 */
export async function executeSystemAction({ guild, targetUser, flow }) {
    assertBotPermissions(guild, flow?.type);
    const moderator = guild.members.me || await guild.members.fetchMe();
    return runAction({ guild, moderator, targetUser, flow: withSystemLadderDecision(guild.id, flow) });
}

/**
 * Warn ladder decision for the bot's own warns (owner decision D4, ladderPolicy.js): in a server
 * where automod warns do not count (default outside Mewvo's home servers) or the ladder is off,
 * the warn is recorded without moving the ladder. Throws when the settings cannot be read.
 */
function withSystemLadderDecision(guildId, flow) {
    if (flow?.type !== 'warn') return flow;
    return { ...flow, countsOnLadder: warnCountsOnLadder(guildId, { system: true }) };
}

const CASE_TYPES = new Set(['ban', 'kick', 'mute', 'warn']);

async function runAction({ guild, moderator, targetUser, flow, guard = null, lang = 'en' }) {
    const result = await runActionLocked({ guild, moderator, targetUser, flow, guard, lang });
    // Staff watchlist: a new case for a watched member → one mod log line (memory lookup; never throws).
    if (CASE_TYPES.has(flow.type) && result?.record?.case_code) {
        void alertWatched(guild.client, {
            guildId: guild.id,
            userId: targetUser.id,
            username: targetUser.username,
            kind: 'case',
            event: `new case \`${result.record.case_code}\` (${flow.type}) by ${moderator?.user?.username || moderator?.id || 'unknown'}`,
        });
    }
    return result;
}

async function runActionLocked({ guild, moderator, targetUser, flow, guard = null, lang = 'en' }) {
    return lockFor(guild.id, targetUser.id, async () => {
        if (guard) await guard();
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        assertCanTarget(guild, moderator, targetUser.id, targetMember, flow.type, { lang });

        // Default names are re-picked under the lock so two panels can't claim the same number.
        if (flow.nameIsDefault && ['ban', 'kick', 'mute', 'warn'].includes(flow.type)) {
            flow.name = await nextDefaultName(guild.id, targetUser.id, targetUser.username, flow.type);
        }

        switch (flow.type) {
            case 'ban': return doBan({ guild, moderator, targetUser, targetMember, flow, lang });
            case 'kick': return doKick({ guild, moderator, targetUser, targetMember, flow, lang });
            case 'mute': return doMute({ guild, moderator, targetUser, targetMember, flow, lang });
            case 'warn': return doWarn({ guild, moderator, targetUser, targetMember, flow, lang });
            case 'unban': return doUnban({ guild, moderator, targetUser, flow, lang });
            case 'unmute': return doUnmute({ guild, moderator, targetUser, flow, lang });
            case 'removewarn': return doRemoveWarn({ guild, moderator, targetUser, flow, lang });
            default: throw userError(botText(lang).t('staff.enfCheck.unknownAction', { action: String(flow.type) }));
        }
    });
}

function baseRecord(guild, targetUser, flow, moderatorInfo) {
    return {
        guildId: guild.id,
        targetUserId: targetUser.id,
        targetUsername: targetUser.username,
        ...moderatorInfo,
        name: flow.name,
        reason: flow.reason,
        reasonSource: flow.reasonSource,
        reasonKey: flow.reasonKey,
    };
}

/**
 * DM components for an action: the "Contest this" button when automod deleted the
 * member's message (flow.contestable, set by automodService.applyStep). A function of the DM's
 * language: sendLoggedDm builds it once it knows the language (the button label follows it).
 */
function dmComponentsFor(flow, record) {
    if (!(flow?.contestable && record?.case_code)) return null;
    const build = (lang) => contestComponents(record.case_code, { lang });
    // Marks the button as the renderer's (dmRenderers withContest): a language re-edit relabels it.
    build.contestCode = record.case_code;
    return build;
}

/** Rolls back a case whose Discord action failed (never throws: the action's error matters). */
async function deleteCaseQuietly(record) {
    await query(`DELETE FROM ${T.cases} WHERE id = $1`, [record.id])
        .catch((error) => logger.warn(`Could not roll back case ${record.case_code}: ${error.message}`));
}

/**
 * Records the case, DMs first, then bans. Rolls the case back if the ban fails. Mewvo's Ban
 * Members permission and role order are checked BEFORE the DM (audit 1.3): a member is never
 * told "you are banned" when the ban cannot happen. `targetMember`: null when not in the server.
 */
async function banWithRecord({ guild, targetUser, targetMember = null, record, auditReason, dmComponents = null, lang = 'en' }) {
    try {
        assertBotCanRemove(guild, 'ban', targetMember, { lang });
    } catch (error) {
        await deleteCaseQuietly(record);
        throw error;
    }
    const dmDelivered = await sendCaseDm(targetUser, 'enf.ban', record, { guild, components: dmComponents });
    try {
        await guild.members.ban(targetUser.id, { reason: auditReason.slice(0, 512) });
    } catch (error) {
        await deleteCaseQuietly(record);
        throw createError(`Ban failed: ${error.message}`, ErrorTypes.DISCORD_API,
            refusalMessage('ban', error, { lang, role: targetMember?.roles?.highest?.name ?? null }), { expected: true });
    }
    await setDmDelivered(record.id, dmDelivered);
    await syncBannedRoleQuietly(guild.client, targetUser.id);
    // Main-server bans: into Support (appeal + Banned role there), in the background.
    // Lazy import: a static one creates an import cycle (supportAutoJoin → oauthVerification → …).
    void import('../supportAutoJoin.js')
        .then((m) => m.joinSupportQuietly(guild.client, targetUser.id, { guildId: guild.id, why: 'ban' }))
        .catch((error) => logger.warn(`Support auto-join failed: ${error.message}`));
    return { ...record, dm_delivered: dmDelivered };
}

async function doBan({ guild, moderator, targetUser, targetMember = null, flow, lang = 'en' }) {
    if (await isBanned(guild, targetUser.id)) {
        throw userError(botText(lang).t('staff.enfCheck.alreadyBanned', { name: targetUser.username }));
    }
    // Before the case is written: nothing to roll back, nothing sent.
    assertBotCanRemove(guild, 'ban', targetMember, { lang });

    const now = new Date();
    let record = await insertCase(null, {
        ...baseRecord(guild, targetUser, flow, moderatorFields(moderator)),
        type: 'ban',
        durationMs: flow.durationMs,
        expiresAt: flow.durationMs ? new Date(now.getTime() + flow.durationMs) : null,
        unappealable: flow.unappealable,
        ladderLevelAfter: await getLadderLevel(guild.id, targetUser.id),
    });

    record = await banWithRecord({
        guild, targetUser, targetMember, record, lang,
        auditReason: `${record.case_code}: ${record.reason} (by ${moderator.user.username})`,
        dmComponents: dmComponentsFor(flow, record),
    });
    await logEnforcement(guild.client, guild.id, 'ban', { record, target: targetUser, moderatorLabel: moderatorLabel(moderator) });
    return { record, dmDelivered: record.dm_delivered, notes: [] };
}

async function doKick({ guild, moderator, targetUser, targetMember, flow, lang = 'en' }) {
    const tr = botText(lang);
    if (!targetMember) {
        throw userError(tr.t('staff.enfCheck.notInServer', { name: targetUser.username }));
    }
    // Before the case and the DM (audit 1.3): never "you were kicked" when the kick cannot happen.
    assertBotCanRemove(guild, 'kick', targetMember, { lang });

    let record = await insertCase(null, {
        ...baseRecord(guild, targetUser, flow, moderatorFields(moderator)),
        type: 'kick',
        ladderLevelAfter: await getLadderLevel(guild.id, targetUser.id),
    });

    const invite = await createRejoinInvite(guild, `Rejoin invite for kick ${record.case_code}`);
    const dmDelivered = await sendCaseDm(targetUser, 'enf.kick', record, { guild, member: targetMember, components: dmComponentsFor(flow, record), invite });

    try {
        await targetMember.kick(`${record.case_code}: ${record.reason} (by ${moderator.user.username})`.slice(0, 512));
    } catch (error) {
        await deleteCaseQuietly(record);
        throw createError(`Kick failed: ${error.message}`, ErrorTypes.DISCORD_API,
            refusalMessage('kick', error, { lang, role: targetMember.roles?.highest?.name ?? null }), { expected: true });
    }

    await setDmDelivered(record.id, dmDelivered);
    record = { ...record, dm_delivered: dmDelivered };
    // A kicked member gets no temporary role back when they rejoin.
    await endTempRoles(guild.id, targetUser.id).catch((error) => logger.warn(`Temporary roles not ended after kick ${record.case_code}: ${error.message}`));
    const notes = invite ? [] : [tr.t('staff.enfCheck.note.noInvite')];
    await logEnforcement(guild.client, guild.id, 'kick', { record, target: targetUser, moderatorLabel: moderatorLabel(moderator) });
    return { record, dmDelivered, notes };
}

async function doMute({ guild, moderator, targetUser, targetMember, flow, lang = 'en' }) {
    const tr = botText(lang);
    if (!targetMember) {
        throw userError(tr.t('staff.enfCheck.notInServer', { name: targetUser.username }));
    }
    if (await getActiveCase(guild.id, targetUser.id, 'mute')) {
        throw userError(tr.t('staff.enfCheck.alreadyMuted', { name: targetUser.username }));
    }

    const role = await ensureMutedRole(guild);
    const now = new Date();
    let record = await insertCase(null, {
        ...baseRecord(guild, targetUser, flow, moderatorFields(moderator)),
        type: 'mute',
        durationMs: flow.durationMs,
        expiresAt: new Date(now.getTime() + flow.durationMs),
        ladderLevelAfter: await getLadderLevel(guild.id, targetUser.id),
    });

    try {
        await addMutedRole(targetMember, role, `${record.case_code}: ${record.reason}`.slice(0, 512));
    } catch (error) {
        await deleteCaseQuietly(record);
        throw createError(`Mute failed: ${error.message}`, ErrorTypes.DISCORD_API,
            refusalMessage('mute', error, { lang, role: targetMember.roles?.highest?.name ?? null }), { expected: true });
    }

    const dmDelivered = await sendCaseDm(targetUser, 'enf.mute', record, { guild, member: targetMember, components: dmComponentsFor(flow, record) });
    await setDmDelivered(record.id, dmDelivered);
    record = { ...record, dm_delivered: dmDelivered };
    await logEnforcement(guild.client, guild.id, 'mute', { record, target: targetUser, moderatorLabel: moderatorLabel(moderator) });
    // Where the Muted role cannot stop them (a role allow on a channel, Administrator): told, not refused.
    let notes = [];
    try {
        notes = mutedRoleGapNotes(tr, mutedRoleGaps(guild, targetMember, role.id), targetUser.username);
    } catch (error) {
        logger.debug(`Mute gap check skipped: ${error.message}`);
    }
    return { record, dmDelivered, notes };
}

// ── Warn ladder ────────────────────────────────────────────────────────────

export async function getLadder(guildId, userId) {
    const { rows } = await query(
        `SELECT level, warns_since_level FROM ${T.ladder} WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
    );
    // enabled: false when the server turned the warn ladder off (previewWarn then never escalates).
    return { ...(rows[0] || { level: 0, warns_since_level: 0 }), enabled: isWarnLadderEnabled(guildId) };
}

async function getLadderLevel(guildId, userId) {
    return (await getLadder(guildId, userId)).level;
}

async function lockLadderRow(client, guildId, userId) {
    await client.query(
        `INSERT INTO ${T.ladder} (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [guildId, userId]
    );
    const { rows } = await client.query(
        `SELECT level, warns_since_level FROM ${T.ladder} WHERE guild_id = $1 AND user_id = $2 FOR UPDATE`,
        [guildId, userId]
    );
    return rows[0];
}

/**
 * What the next warn does at this ladder state. A ladder with `enabled: false` (warn ladder off in
 * that server, getLadder) never escalates: { ladderOff: true, warnNumber: null, escalates: false }.
 */
export function previewWarn(ladder) {
    if (ladder?.enabled === false) {
        return {
            warnNumber: null, threshold: null, escalates: false, nextLevel: ladder.level, banDurationMs: null, ladderOff: true,
        };
    }
    const threshold = ladder.level === 0 ? enforcementConfig.warnsPerLevel : 1;
    const warnNumber = ladder.warns_since_level + 1;
    const escalates = warnNumber >= threshold;
    const nextLevel = escalates ? Math.min(ladder.level + 1, 3) : ladder.level;
    return {
        warnNumber,
        threshold,
        escalates,
        nextLevel,
        banDurationMs: escalates ? enforcementConfig.ladderBans[nextLevel] : null,
    };
}

async function doWarn({ guild, moderator, targetUser, targetMember, flow, lang = 'en' }) {
    const tr = botText(lang);
    if (!targetMember) {
        throw userError(tr.t('staff.enfCheck.warnNotInServer', { name: targetUser.username }));
    }

    const botUser = guild.client.user;
    // D4 (ladderPolicy.js): automod warns pass the decision in (executeSystemAction); staff warns
    // count unless the server turned the ladder off. Uncounted: counts_toward_level NULL, no step.
    const counts = flow.countsOnLadder ?? isWarnLadderEnabled(guild.id);
    const { warnRecord, banRecord, preview } = await withTransaction(async (client) => {
        const ladder = await lockLadderRow(client, guild.id, targetUser.id);
        if (!counts) {
            const warn = await insertCase(client, {
                ...baseRecord(guild, targetUser, flow, moderatorFields(moderator)),
                type: 'warn',
                ladderLevelAfter: ladder.level,
                countsTowardLevel: null,
            });
            return { warnRecord: warn, banRecord: null, preview: { warnNumber: null, uncounted: true } };
        }
        const step = previewWarn(ladder);
        // A warn that escalates bans: when Mewvo cannot ban this member, refuse the whole warn here
        // (the throw rolls back the warn and the ladder step), so no half-done ladder ban is recorded.
        if (step.escalates) assertBotCanRemove(guild, 'ban', targetMember, { lang });

        const warn = await insertCase(client, {
            ...baseRecord(guild, targetUser, flow, moderatorFields(moderator)),
            type: 'warn',
            ladderLevelAfter: step.nextLevel,
            countsTowardLevel: ladder.level,
        });

        let ban = null;
        if (step.escalates) {
            const now = new Date();
            const permanent = step.banDurationMs == null;
            ban = await insertCase(client, {
                guildId: guild.id,
                targetUserId: targetUser.id,
                targetUsername: targetUser.username,
                moderatorId: botUser.id,
                moderatorUsername: botUser.username,
                type: 'ban',
                name: await nextAutoBanName(client, guild.id, targetUser),
                reason: enforcementConfig.ladderReason,
                reasonSource: 'prebuilt',
                reasonKey: 'warn_ladder',
                durationMs: step.banDurationMs,
                expiresAt: permanent ? null : new Date(now.getTime() + step.banDurationMs),
                appealDeadline: step.nextLevel === 3 ? addMonths(now, enforcementConfig.level3AppealMonths) : null,
                ladderLevelAfter: step.nextLevel,
                isAuto: true,
            });
        }

        await client.query(
            `UPDATE ${T.ladder} SET level = $3, warns_since_level = $4, updated_at = NOW()
             WHERE guild_id = $1 AND user_id = $2`,
            [guild.id, targetUser.id, step.nextLevel, step.escalates ? 0 : step.warnNumber]
        );

        return { warnRecord: warn, banRecord: ban, preview: step };
    });

    const label = moderatorLabel(moderator);
    const notes = [];

    if (!banRecord) {
        const dmDelivered = await sendCaseDm(targetUser, 'enf.warn', warnRecord, { guild, member: targetMember, components: dmComponentsFor(flow, warnRecord), warnNumber: preview.warnNumber });
        await setDmDelivered(warnRecord.id, dmDelivered);
        const record = { ...warnRecord, dm_delivered: dmDelivered };
        await syncWarnRolesQuietly(guild, targetUser.id);
        await logEnforcement(guild.client, guild.id, 'warn', { record, target: targetUser, moderatorLabel: label });
        if (preview.uncounted) notes.push(tr.t('staff.enfCheck.note.warnUncounted'));
        return { record, dmDelivered, notes, warnNumber: preview.warnNumber, countsOnLadder: !preview.uncounted };
    }

    // The escalating warn is announced by the ban DM alone (one DM, not two).
    let record = { ...warnRecord };
    let ban = banRecord;
    try {
        ban = await banWithRecord({
            guild, targetUser, targetMember, record: banRecord, lang,
            auditReason: `${banRecord.case_code}: ${enforcementConfig.ladderReason} (warn ${warnRecord.case_code})`,
            // The automod warn is what the member contests (the review card carries its code).
            dmComponents: dmComponentsFor(flow, warnRecord),
        });
        await setDmDelivered(warnRecord.id, ban.dm_delivered);
        record = { ...warnRecord, dm_delivered: ban.dm_delivered };
        const stage = ladderStageIn(preview.nextLevel, { lang });
        notes.push(ban.expires_at
            ? tr.t('staff.enfCheck.note.ladderBan', { length: durationIn(Number(ban.duration_ms), lang), code: ban.case_code, stage })
            : tr.t('staff.enfCheck.note.ladderBanPermanent', { code: ban.case_code, stage }));
    } catch (error) {
        // banWithRecord removed the ban row (and sent no DM when Mewvo could not ban); the warn and the ladder step stay recorded.
        notes.push(tr.t('staff.enfCheck.note.ladderBanFailed', { error: error.userMessage || error.message, stage: ladderStageIn(preview.nextLevel, { lang }) }));
        ban = null;
    }

    // Only reaches members still in the server (the ban failed); banned users get it on rejoin.
    await syncWarnRolesQuietly(guild, targetUser.id);
    await logEnforcement(guild.client, guild.id, 'warn', { record, target: targetUser, moderatorLabel: label });
    if (ban) {
        await logEnforcement(guild.client, guild.id, 'ban', {
            record: ban, target: targetUser, moderatorLabel: `${botUser.username} (automatic, warn \`${warnRecord.case_code}\`)`,
            extra: [{ name: 'Warning stage', value: ladderStageShort(preview.nextLevel) }],
        });
    }
    return { record, dmDelivered: record.dm_delivered, notes, warnNumber: preview.warnNumber, banRecord: ban };
}

async function nextAutoBanName(client, guildId, targetUser) {
    const { rows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND type = 'ban' AND is_imported = FALSE AND is_test = FALSE`,
        [guildId, targetUser.id]
    );
    let n = (rows[0]?.count || 0) + 1;
    for (let guard = 0; guard < 50; guard += 1, n += 1) {
        const candidate = `${targetUser.username} ban ${n}`;
        const taken = await client.query(
            `SELECT 1 FROM ${T.cases} WHERE guild_id = $1 AND lower(name) = lower($2)`,
            [guildId, candidate]
        );
        if (taken.rowCount === 0) return candidate;
    }
    return `${targetUser.username} ban ${Date.now()}`;
}

// ── Reversals ──────────────────────────────────────────────────────────────

async function revokeOpenCases(guildId, userId, type, revokedBy, reason) {
    const { rows } = await query(
        `UPDATE ${T.cases}
         SET status = 'revoked', revoked_by = $4, revoked_at = NOW(), revoke_reason = $5
         WHERE guild_id = $1 AND target_user_id = $2 AND type = $3 AND status = ANY($6) AND is_test = FALSE
         RETURNING *`,
        [guildId, userId, type, revokedBy, reason, OPEN_STATUSES]
    );
    return rows;
}

async function doUnban({ guild, moderator, targetUser, flow, lang = 'en' }) {
    const tr = botText(lang);
    if (!(await isBanned(guild, targetUser.id))) {
        throw userError(tr.t('staff.enfCheck.notBanned', { name: targetUser.username }));
    }
    try {
        await guild.members.unban(targetUser.id, `${flow.reason} (by ${moderator.user.username})`.slice(0, 512));
    } catch (error) {
        throw createError(`Unban failed: ${error.message}`, ErrorTypes.DISCORD_API, refusalMessage('unban', error, { lang }), { expected: true });
    }
    const revoked = await revokeOpenCases(guild.id, targetUser.id, 'ban', moderator.id, flow.reason);
    await syncBannedRoleQuietly(guild.client, targetUser.id);
    const endDm = await notifyPunishmentEnded(guild.client, guild, { type: 'ban', userId: targetUser.id, records: revoked, early: true });
    await logEnforcement(guild.client, guild.id, 'unban', {
        target: targetUser, moderatorLabel: moderatorLabel(moderator),
        extra: [
            { name: 'Reason', value: flow.reason },
            ...(revoked.length ? [{ name: 'Lifted cases', value: revoked.map((r) => `\`${r.case_code}\``).join(', ') }] : []),
        ],
    });
    const notes = revoked.length ? [tr.t('staff.enfCheck.note.lifted', { codes: revoked.map((r) => `\`${r.case_code}\``).join(', ') })] : [];
    notes.push(endDm ? tr.t('staff.enfCheck.note.unbanDm') : tr.t('staff.enfCheck.note.unbanDmFailed'));
    return { record: null, dmDelivered: null, notes };
}

async function doUnmute({ guild, moderator, targetUser, flow, lang = 'en' }) {
    const tr = botText(lang);
    let removed;
    try {
        removed = await removeMutedRole(guild, targetUser.id, `${flow.reason} (by ${moderator.user.username})`.slice(0, 512));
    } catch (error) {
        if (error?.code !== MISSING_PERMISSIONS) throw error;
        throw createError(`Unmute failed: ${error.message}`, ErrorTypes.DISCORD_API, refusalMessage('unmute', error, { lang }), { expected: true });
    }
    const revoked = await revokeOpenCases(guild.id, targetUser.id, 'mute', moderator.id, flow.reason);
    if (!removed && revoked.length === 0) {
        throw userError(tr.t('staff.enfCheck.notMuted', { name: targetUser.username }));
    }
    const endDm = await notifyPunishmentEnded(guild.client, guild, { type: 'mute', userId: targetUser.id, records: revoked, early: true });
    await logEnforcement(guild.client, guild.id, 'unmute', {
        target: targetUser, moderatorLabel: moderatorLabel(moderator),
        extra: [
            { name: 'Reason', value: flow.reason },
            ...(revoked.length ? [{ name: 'Lifted cases', value: revoked.map((r) => `\`${r.case_code}\``).join(', ') }] : []),
        ],
    });
    const notes = removed ? [] : [tr.t('staff.enfCheck.note.unmuteNoRole')];
    if (!endDm) notes.push(tr.t('staff.enfCheck.note.unmuteDmFailed'));
    return { record: null, dmDelivered: null, notes };
}

/**
 * Revokes one warn. If it still counts toward the current ladder level, the
 * counted warns go down by one. Shared with appeal acceptance.
 */
export async function revokeWarn(guildId, caseCode, revokedBy, reason) {
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT * FROM ${T.cases} WHERE case_code = $1 AND guild_id = $2 AND type = 'warn' AND is_test = FALSE FOR UPDATE`,
            [caseCode, guildId]
        );
        const warn = rows[0];
        if (!warn || !OPEN_STATUSES.includes(warn.status)) {
            return null;
        }

        const ladder = await lockLadderRow(client, guildId, warn.target_user_id);
        await client.query(
            `UPDATE ${T.cases} SET status = 'revoked', revoked_by = $2, revoked_at = NOW(), revoke_reason = $3 WHERE id = $1`,
            [warn.id, revokedBy, reason]
        );

        // An escalating warn already reset the counter, so it has nothing left to subtract.
        const stillCounted = !warn.is_imported
            && warn.counts_toward_level === ladder.level
            && warn.ladder_level_after === ladder.level;
        if (stillCounted) {
            await client.query(
                `UPDATE ${T.ladder} SET warns_since_level = GREATEST(0, warns_since_level - 1), updated_at = NOW()
                 WHERE guild_id = $1 AND user_id = $2`,
                [guildId, warn.target_user_id]
            );
        }
        return { ...warn, status: 'revoked', lowered: stillCounted };
    });
}

/**
 * After a warn was revoked by an accepted appeal: if that warn was one of the warns
 * that triggered the user's current automatic ladder ban, the limit was never really
 * reached, so the ban is lifted and the ladder steps back one level, keeping the
 * other warns of that level counted. Returns the lifted ban case, or null.
 */
export async function liftLadderBanForWarn(guild, warn, admin, reason) {
    // A warn that never counted toward the ladder (D4) cannot have triggered a ladder ban.
    if (warn?.counts_toward_level === null || warn?.counts_toward_level === undefined) return null;
    const ban = await withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT * FROM ${T.cases}
             WHERE guild_id = $1 AND target_user_id = $2 AND type = 'ban' AND is_auto = TRUE AND is_test = FALSE
               AND status = ANY($3) AND (expires_at IS NULL OR expires_at > NOW())
               AND created_at >= $4 AND ladder_level_after = $5
             ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
            [guild.id, warn.target_user_id, OPEN_STATUSES, warn.created_at, Number(warn.counts_toward_level) + 1]
        );
        const found = rows[0];
        if (!found) return null;

        await client.query(
            `UPDATE ${T.cases} SET status = 'revoked', revoked_by = $2, revoked_at = NOW(), revoke_reason = $3 WHERE id = $1`,
            [found.id, admin.id, reason]
        );
        const previousLevel = Math.max(0, found.ladder_level_after - 1);
        const { rows: [counted] } = await client.query(
            `SELECT COUNT(*)::int AS count FROM ${T.cases}
             WHERE guild_id = $1 AND target_user_id = $2 AND type = 'warn' AND status = ANY($3)
               AND is_imported = FALSE AND is_test = FALSE AND counts_toward_level = $4`,
            [guild.id, warn.target_user_id, OPEN_STATUSES, previousLevel]
        );
        await lockLadderRow(client, guild.id, warn.target_user_id);
        await client.query(
            `UPDATE ${T.ladder} SET level = $3, warns_since_level = $4, updated_at = NOW()
             WHERE guild_id = $1 AND user_id = $2`,
            [guild.id, warn.target_user_id, previousLevel, counted?.count || 0]
        );
        return found;
    });
    if (!ban) return null;

    await guild.members.unban(ban.target_user_id, reason.slice(0, 512)).catch((error) => {
        if (error?.code !== 10026) throw error;
    });
    await syncBannedRoleQuietly(guild.client, ban.target_user_id);
    return ban;
}

async function doRemoveWarn({ guild, moderator, targetUser, flow, lang = 'en' }) {
    const result = await revokeWarn(guild.id, flow.warnCode, moderator.id, flow.reason);
    if (!result) {
        throw userError(botText(lang).t('staff.enfCheck.warnGone'));
    }
    const ladder = await getLadder(guild.id, targetUser.id);
    await syncWarnRolesQuietly(guild, targetUser.id);
    await logEnforcement(guild.client, guild.id, 'removewarn', {
        target: targetUser, moderatorLabel: moderatorLabel(moderator),
        extra: [
            { name: 'Warning', value: `\`${result.case_code}\` · ${result.name}` },
            { name: 'Reason', value: flow.reason },
            { name: 'Counted warns now', value: `${ladder.warns_since_level} (${ladderStageIn(ladder.level)})` },
        ],
    });
    return { record: null, dmDelivered: null, notes: [botText(lang).t('staff.enfCheck.note.removed', { code: result.case_code, count: ladder.warns_since_level })] };
}

function moderatorLabel(moderator) {
    return `${moderator.user.username} (${moderator.id})`;
}

// ── Member state for the panel ─────────────────────────────────────────────

export async function getTargetState(guild, userId) {
    const [member, banned, ladder, activeBan, activeMute, role, uncounted] = await Promise.all([
        guild.members.fetch(userId).catch(() => null),
        isBanned(guild, userId),
        getLadder(guild.id, userId),
        getActiveCase(guild.id, userId, 'ban'),
        getActiveCase(guild.id, userId, 'mute'),
        findMutedRole(guild),
        countUncountedWarns(guild.id, userId),
    ]);
    const hasMutedRole = Boolean(member && role && member.roles.cache.has(role.id));
    // uncountedWarns: open warns that do not count toward the ladder (ladderPolicy.js, D4).
    return { member, banned, ladder, activeBan, activeMute, muted: Boolean(activeMute) || hasMutedRole, uncountedWarns: uncounted };
}

/** Re-applies the muted role when a muted member rejoins (any server: its own mute cases and role). */
export async function reapplyMuteOnJoin(member) {
    const mute = await getActiveCase(member.guild.id, member.id, 'mute');
    if (!mute) return;
    const role = await findMutedRole(member.guild);
    if (!role) return;
    await member.roles.add(role, `Rejoined while muted (${mute.case_code})`).catch((error) => {
        logger.warn(`Could not re-apply muted role to ${member.id}: ${error.message}`);
    });
}
