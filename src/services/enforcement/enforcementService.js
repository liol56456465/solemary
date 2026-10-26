// enforcementService.js — executes panel actions: ban, kick, mute, warn, unban,
// unmute, remove warn. Every action is serialized per guild + user, records a
// case, DMs the user before a kick or ban, and logs through loggingService.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { ModerationService } from '../moderation/moderationService.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { Mutex } from '../../utils/mutex.js';
import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { query, withTransaction, T } from './db.js';
import { insertCase, setDmDelivered, getActiveCase, nextDefaultName, OPEN_STATUSES } from './caseService.js';
import { ensureMutedRole, addMutedRole, removeMutedRole, findMutedRole } from './muteService.js';
import { banDm, kickDm, muteDm, warnDm } from './dmTemplates.js';
import { addMonths, formatDuration, dateStamp } from './format.js';

export const REQUIRED_BOT_PERMISSIONS = [
    ['BanMembers', 'Ban Members'],
    ['KickMembers', 'Kick Members'],
    ['ManageRoles', 'Manage Roles'],
    ['ManageChannels', 'Manage Channels'],
    ['CreateInstantInvite', 'Create Invite'],
];

function userError(message, type = ErrorTypes.VALIDATION) {
    return createError(message, type, message, { expected: true });
}

export function isAdministrator(member) {
    if (!member) return false;
    if (member.guild?.ownerId === member.id) return true;
    return Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));
}

export function getMissingBotPermissions(guild) {
    const me = guild.members.me;
    return REQUIRED_BOT_PERMISSIONS
        .filter(([flag]) => !me?.permissions?.has(PermissionFlagsBits[flag]))
        .map(([, label]) => label);
}

export function assertBotPermissions(guild) {
    const missing = getMissingBotPermissions(guild);
    if (missing.length > 0) {
        throw userError(
            `I'm missing these server permissions: **${missing.join(', ')}**. ` +
            'Grant them to my role in Server Settings → Roles, then try again.',
            ErrorTypes.PERMISSION
        );
    }
}

/**
 * Refuses the owner, the bot, yourself, and anyone with an equal or higher role
 * than the moderator (or the bot). Non-members can only be checked by ID.
 */
export function assertCanTarget(guild, moderator, targetUserId, targetMember, action) {
    if (targetUserId === moderator.id) {
        throw userError(`You cannot ${action} yourself.`);
    }
    if (targetUserId === guild.client.user.id) {
        throw userError(`I cannot ${action} myself.`);
    }
    if (targetUserId === guild.ownerId) {
        throw userError(`You cannot ${action} the server owner.`);
    }
    if (targetMember) {
        ModerationService.assertModerationHierarchy(moderator, targetMember, action);
    }
}

async function lockFor(guildId, userId, task) {
    return Mutex.runExclusive(`enforcement:${guildId}:${userId}`, task);
}

export async function sendDm(user, content) {
    try {
        await user.send({ content, allowedMentions: { parse: [] } });
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
            maxAge: enforcementConfig.rejoinInviteMaxAgeSeconds,
            unique: true,
            reason,
        });
        return invite.url;
    } catch (error) {
        logger.warn(`Could not create rejoin invite in guild ${guild.id}: ${error.message}`);
        return null;
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

export async function logEnforcement(client, guildId, action, { record = null, target, moderatorLabel, extra = [] }) {
    const fields = [
        { name: 'User', value: `${target.username} (${target.id})` },
        { name: 'Moderator', value: moderatorLabel },
    ];
    if (record) {
        fields.push(
            { name: 'Case', value: `\`${record.case_code}\` — ${record.name}` },
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

    await logEvent({
        client,
        guildId,
        eventType: LOG_TYPES[action],
        data: { userId: target.id, fields },
    }).catch((error) => logger.warn(`Enforcement log failed: ${error.message}`));
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
 * Returns { record, dmDelivered, notes[] } for the moderator's confirmation message.
 */
export async function executeAction({ guild, moderator, targetUser, flow }) {
    assertBotPermissions(guild);
    if (!isAdministrator(moderator)) {
        throw userError('You need the Administrator permission to use this panel.', ErrorTypes.PERMISSION);
    }

    return lockFor(guild.id, targetUser.id, async () => {
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        assertCanTarget(guild, moderator, targetUser.id, targetMember, flow.type);

        // Default names are re-picked under the lock so two panels can't claim the same number.
        if (flow.nameIsDefault && ['ban', 'kick', 'mute', 'warn'].includes(flow.type)) {
            flow.name = await nextDefaultName(guild.id, targetUser.id, targetUser.username, flow.type);
        }

        switch (flow.type) {
            case 'ban': return doBan({ guild, moderator, targetUser, flow });
            case 'kick': return doKick({ guild, moderator, targetUser, targetMember, flow });
            case 'mute': return doMute({ guild, moderator, targetUser, targetMember, flow });
            case 'warn': return doWarn({ guild, moderator, targetUser, targetMember, flow });
            case 'unban': return doUnban({ guild, moderator, targetUser, flow });
            case 'unmute': return doUnmute({ guild, moderator, targetUser, flow });
            case 'removewarn': return doRemoveWarn({ guild, moderator, targetUser, flow });
            default: throw userError(`Unknown action: ${flow.type}`);
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

/** Records the case, DMs first, then bans. Rolls the case back if the ban fails. */
async function banWithRecord({ guild, targetUser, record, auditReason }) {
    const dmDelivered = await sendDm(targetUser, banDm(record));
    try {
        await guild.members.ban(targetUser.id, { reason: auditReason.slice(0, 512) });
    } catch (error) {
        await query(`DELETE FROM ${T.cases} WHERE id = $1`, [record.id]).catch(() => {});
        throw createError(`Ban failed: ${error.message}`, ErrorTypes.DISCORD_API,
            `Discord refused the ban: ${error.message}`, { expected: true });
    }
    await setDmDelivered(record.id, dmDelivered);
    return { ...record, dm_delivered: dmDelivered };
}

async function doBan({ guild, moderator, targetUser, flow }) {
    if (await isBanned(guild, targetUser.id)) {
        throw userError(`**${targetUser.username}** is already banned.`);
    }

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
        guild, targetUser, record,
        auditReason: `${record.case_code}: ${record.reason} (by ${moderator.user.username})`,
    });
    await logEnforcement(guild.client, guild.id, 'ban', { record, target: targetUser, moderatorLabel: moderatorLabel(moderator) });
    return { record, dmDelivered: record.dm_delivered, notes: [] };
}

async function doKick({ guild, moderator, targetUser, targetMember, flow }) {
    if (!targetMember) {
        throw userError(`**${targetUser.username}** is not in the server.`);
    }

    let record = await insertCase(null, {
        ...baseRecord(guild, targetUser, flow, moderatorFields(moderator)),
        type: 'kick',
        ladderLevelAfter: await getLadderLevel(guild.id, targetUser.id),
    });

    const invite = await createRejoinInvite(guild, `Rejoin invite for kick ${record.case_code}`);
    const dmDelivered = await sendDm(targetUser, kickDm(record, invite));

    try {
        await targetMember.kick(`${record.case_code}: ${record.reason} (by ${moderator.user.username})`.slice(0, 512));
    } catch (error) {
        await query(`DELETE FROM ${T.cases} WHERE id = $1`, [record.id]).catch(() => {});
        throw createError(`Kick failed: ${error.message}`, ErrorTypes.DISCORD_API,
            `Discord refused the kick: ${error.message}`, { expected: true });
    }

    await setDmDelivered(record.id, dmDelivered);
    record = { ...record, dm_delivered: dmDelivered };
    const notes = invite ? [] : ['No rejoin invite could be created (no channel where I can create invites).'];
    await logEnforcement(guild.client, guild.id, 'kick', { record, target: targetUser, moderatorLabel: moderatorLabel(moderator) });
    return { record, dmDelivered, notes };
}

async function doMute({ guild, moderator, targetUser, targetMember, flow }) {
    if (!targetMember) {
        throw userError(`**${targetUser.username}** is not in the server.`);
    }
    if (await getActiveCase(guild.id, targetUser.id, 'mute')) {
        throw userError(`**${targetUser.username}** is already muted. Unmute first to change the duration.`);
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
        await query(`DELETE FROM ${T.cases} WHERE id = $1`, [record.id]).catch(() => {});
        throw createError(`Mute failed: ${error.message}`, ErrorTypes.DISCORD_API,
            `Could not add the muted role: ${error.message}`, { expected: true });
    }

    const dmDelivered = await sendDm(targetUser, muteDm(record));
    await setDmDelivered(record.id, dmDelivered);
    record = { ...record, dm_delivered: dmDelivered };
    await logEnforcement(guild.client, guild.id, 'mute', { record, target: targetUser, moderatorLabel: moderatorLabel(moderator) });
    return { record, dmDelivered, notes: [] };
}

// ── Warn ladder ────────────────────────────────────────────────────────────

export async function getLadder(guildId, userId) {
    const { rows } = await query(
        `SELECT level, warns_since_level FROM ${T.ladder} WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
    );
    return rows[0] || { level: 0, warns_since_level: 0 };
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

/** What the next warn does at this ladder state. */
export function previewWarn(ladder) {
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

async function doWarn({ guild, moderator, targetUser, targetMember, flow }) {
    if (!targetMember) {
        throw userError(`**${targetUser.username}** is not in the server, so a warning can't reach them.`);
    }

    const botUser = guild.client.user;
    const { warnRecord, banRecord, preview } = await withTransaction(async (client) => {
        const ladder = await lockLadderRow(client, guild.id, targetUser.id);
        const step = previewWarn(ladder);

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
        const dmDelivered = await sendDm(targetUser, warnDm(warnRecord, preview.warnNumber));
        await setDmDelivered(warnRecord.id, dmDelivered);
        const record = { ...warnRecord, dm_delivered: dmDelivered };
        await logEnforcement(guild.client, guild.id, 'warn', { record, target: targetUser, moderatorLabel: label });
        return { record, dmDelivered, notes, warnNumber: preview.warnNumber };
    }

    // The escalating warn is announced by the ban DM alone (one DM, not two).
    let record = { ...warnRecord };
    let ban = banRecord;
    try {
        ban = await banWithRecord({
            guild, targetUser, record: banRecord,
            auditReason: `${banRecord.case_code}: ${enforcementConfig.ladderReason} (warn ${warnRecord.case_code})`,
        });
        await setDmDelivered(warnRecord.id, ban.dm_delivered);
        record = { ...warnRecord, dm_delivered: ban.dm_delivered };
        notes.push(`Warning limit reached: automatic ${ban.expires_at ? formatDuration(Number(ban.duration_ms)) : 'permanent'} ban \`${ban.case_code}\` (ladder level ${preview.nextLevel}).`);
    } catch (error) {
        // banWithRecord removed the ban row; the warn and the ladder step stay recorded.
        notes.push(`⚠️ Warning limit reached but the automatic ban failed: ${error.userMessage || error.message}. Ladder level is now ${preview.nextLevel}; ban manually.`);
        ban = null;
    }

    await logEnforcement(guild.client, guild.id, 'warn', { record, target: targetUser, moderatorLabel: label });
    if (ban) {
        await logEnforcement(guild.client, guild.id, 'ban', {
            record: ban, target: targetUser, moderatorLabel: `${botUser.username} (automatic, warn \`${warnRecord.case_code}\`)`,
            extra: [{ name: 'Ladder level', value: String(preview.nextLevel) }],
        });
    }
    return { record, dmDelivered: record.dm_delivered, notes, warnNumber: preview.warnNumber, banRecord: ban };
}

async function nextAutoBanName(client, guildId, targetUser) {
    const { rows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND type = 'ban' AND is_imported = FALSE`,
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
         WHERE guild_id = $1 AND target_user_id = $2 AND type = $3 AND status = ANY($6)
         RETURNING *`,
        [guildId, userId, type, revokedBy, reason, OPEN_STATUSES]
    );
    return rows;
}

async function doUnban({ guild, moderator, targetUser, flow }) {
    if (!(await isBanned(guild, targetUser.id))) {
        throw userError(`**${targetUser.username}** is not banned.`);
    }
    await guild.members.unban(targetUser.id, `${flow.reason} (by ${moderator.user.username})`.slice(0, 512));
    const revoked = await revokeOpenCases(guild.id, targetUser.id, 'ban', moderator.id, flow.reason);
    await logEnforcement(guild.client, guild.id, 'unban', {
        target: targetUser, moderatorLabel: moderatorLabel(moderator),
        extra: [
            { name: 'Reason', value: flow.reason },
            ...(revoked.length ? [{ name: 'Lifted cases', value: revoked.map((r) => `\`${r.case_code}\``).join(', ') }] : []),
        ],
    });
    return { record: null, dmDelivered: null, notes: revoked.length ? [`Lifted: ${revoked.map((r) => `\`${r.case_code}\``).join(', ')}`] : [] };
}

async function doUnmute({ guild, moderator, targetUser, flow }) {
    const removed = await removeMutedRole(guild, targetUser.id, `${flow.reason} (by ${moderator.user.username})`.slice(0, 512));
    const revoked = await revokeOpenCases(guild.id, targetUser.id, 'mute', moderator.id, flow.reason);
    if (!removed && revoked.length === 0) {
        throw userError(`**${targetUser.username}** is not muted.`);
    }
    await logEnforcement(guild.client, guild.id, 'unmute', {
        target: targetUser, moderatorLabel: moderatorLabel(moderator),
        extra: [
            { name: 'Reason', value: flow.reason },
            ...(revoked.length ? [{ name: 'Lifted cases', value: revoked.map((r) => `\`${r.case_code}\``).join(', ') }] : []),
        ],
    });
    const notes = removed ? [] : ['The user was not in the server or no longer had the role; the record was still lifted.'];
    return { record: null, dmDelivered: null, notes };
}

/**
 * Revokes one warn. If it still counts toward the current ladder level, the
 * counted warns go down by one. Shared with appeal acceptance.
 */
export async function revokeWarn(guildId, caseCode, revokedBy, reason) {
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT * FROM ${T.cases} WHERE case_code = $1 AND guild_id = $2 AND type = 'warn' FOR UPDATE`,
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

async function doRemoveWarn({ guild, moderator, targetUser, flow }) {
    const result = await revokeWarn(guild.id, flow.warnCode, moderator.id, flow.reason);
    if (!result) {
        throw userError('That warning is no longer active.');
    }
    const ladder = await getLadder(guild.id, targetUser.id);
    await logEnforcement(guild.client, guild.id, 'removewarn', {
        target: targetUser, moderatorLabel: moderatorLabel(moderator),
        extra: [
            { name: 'Warning', value: `\`${result.case_code}\` — ${result.name}` },
            { name: 'Reason', value: flow.reason },
            { name: 'Counted warns now', value: `${ladder.warns_since_level} (ladder level ${ladder.level})` },
        ],
    });
    return { record: null, dmDelivered: null, notes: [`Removed \`${result.case_code}\`. Counted warns: ${ladder.warns_since_level}.`] };
}

function moderatorLabel(moderator) {
    return `${moderator.user.username} (${moderator.id})`;
}

// ── Member state for the panel ─────────────────────────────────────────────

export async function getTargetState(guild, userId) {
    const [member, banned, ladder, activeBan, activeMute, role] = await Promise.all([
        guild.members.fetch(userId).catch(() => null),
        isBanned(guild, userId),
        getLadder(guild.id, userId),
        getActiveCase(guild.id, userId, 'ban'),
        getActiveCase(guild.id, userId, 'mute'),
        findMutedRole(guild),
    ]);
    const hasMutedRole = Boolean(member && role && member.roles.cache.has(role.id));
    return { member, banned, ladder, activeBan, activeMute, muted: Boolean(activeMute) || hasMutedRole };
}

/** Re-applies the muted role when a muted member rejoins. */
export async function reapplyMuteOnJoin(member) {
    if (member.guild.id !== enforcementConfig.mainGuildId) return;
    const mute = await getActiveCase(member.guild.id, member.id, 'mute');
    if (!mute) return;
    const role = await findMutedRole(member.guild);
    if (!role) return;
    await member.roles.add(role, `Rejoined while muted (${mute.case_code})`).catch((error) => {
        logger.warn(`Could not re-apply muted role to ${member.id}: ${error.message}`);
    });
}
