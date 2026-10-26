// appealService.js — appeals and staff reports filed in the support server,
// and the /appeals accept|deny decision.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { createEmbed } from '../../utils/embeds.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { Mutex } from '../../utils/mutex.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { query, withTransaction, T, isUniqueViolation } from './db.js';
import { getCaseByCode, OPEN_STATUSES } from './caseService.js';
import { createRejoinInvite, revokeWarn, sendDm } from './enforcementService.js';
import { removeMutedRole } from './muteService.js';
import { appealAcceptedDm, appealDeniedDm } from './dmTemplates.js';
import { dateStamp, formatDuration, stamp, truncate } from './format.js';

const UNKNOWN_BAN = 10026;

function userError(message) {
    return createError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

function isStillInEffect(record) {
    return OPEN_STATUSES.includes(record.status)
        && (!record.expires_at || new Date(record.expires_at) > new Date());
}

/** Throws a user-facing error when this user may not appeal this case right now. */
export async function assertAppealable(record, userId) {
    // The same message for "no such code" and "not yours" so codes can't be probed.
    if (!record || record.target_user_id !== userId) {
        throw userError('That case code was not found for your account. Check the code in your DM.');
    }
    if (record.unappealable) {
        throw userError('This case cannot be appealed.');
    }
    if (record.status === 'revoked') {
        throw userError('This case has already been lifted.');
    }

    const now = Date.now();
    if (record.type === 'ban' || record.type === 'mute') {
        if (!isStillInEffect(record)) {
            throw userError(`This ${record.type} has already ended, so there is nothing to appeal.`);
        }
        if (record.appeal_deadline && new Date(record.appeal_deadline).getTime() <= now) {
            throw userError('The appeal window for this ban has closed.');
        }
    } else if (now - new Date(record.created_at).getTime() > enforcementConfig.appealWindowMs) {
        throw userError(`${record.type === 'kick' ? 'Kicks' : 'Warnings'} can only be appealed within 30 days.`);
    }

    const { rows } = await query(
        `SELECT status, decided_at FROM ${T.appeals}
         WHERE case_code = $1 AND kind = 'appeal' AND status IN ('pending', 'denied')
         ORDER BY created_at DESC LIMIT 1`,
        [record.case_code]
    );
    const last = rows[0];
    if (last?.status === 'pending') {
        throw userError('You already have a pending appeal for this case. You will get a DM with the decision.');
    }
    if (last?.status === 'denied') {
        const retryAt = new Date(last.decided_at).getTime() + enforcementConfig.appealCooldownMs;
        if (retryAt > now) {
            throw userError(`Your last appeal for this case was denied. You can appeal again <t:${Math.floor(retryAt / 1000)}:R>.`);
        }
    }
}

function privateOverwrites(guild) {
    // Administrators see every channel anyway; the appealing user is never added.
    return [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
            id: guild.client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ReadMessageHistory,
            ],
        },
    ];
}

async function createPrivateChannel(guild, name) {
    const category = guild.channels.cache.get(enforcementConfig.appealsCategoryId)
        || await guild.channels.fetch(enforcementConfig.appealsCategoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
        throw createError('Appeals category missing', ErrorTypes.CONFIGURATION,
            'Appeals are not set up correctly right now. Please try again later.', { expected: true });
    }
    return guild.channels.create({
        name: name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: privateOverwrites(guild),
        reason: 'Appeal / staff report',
    });
}

function caseDetailsLines(record) {
    const lines = [
        `**Case code:** \`${record.case_code}\``,
        `**Type:** ${record.type}${record.is_auto ? ' (automatic, warn ladder)' : ''}`,
        `**Name:** ${record.name}`,
        `**User:** ${record.target_username} (\`${record.target_user_id}\`)`,
        `**By:** ${record.moderator_username}`,
        `**Date:** ${dateStamp(record.created_at)}`,
        `**Reason:** ${record.reason}`,
    ];
    if (record.type === 'ban' || record.type === 'mute') {
        lines.push(record.expires_at
            ? `**Duration:** ${formatDuration(Number(record.duration_ms))} — ends ${stamp(record.expires_at)}`
            : '**Duration:** Permanent');
    }
    if (record.appeal_deadline) {
        lines.push(`**Appeal deadline:** ${dateStamp(record.appeal_deadline)}`);
    }
    lines.push(`**Ladder level after:** ${record.ladder_level_after}`);
    return lines;
}

export async function submitAppeal({ guild, user, caseCode, reason }) {
    return Mutex.runExclusive(`appeal:${caseCode}`, async () => {
        const record = await getCaseByCode(caseCode);
        await assertAppealable(record, user.id);

        let appeal;
        try {
            appeal = await withTransaction(async (client) => {
                const { rows } = await client.query(
                    `INSERT INTO ${T.appeals} (kind, case_code, user_id, username, guild_id, body)
                     VALUES ('appeal', $1, $2, $3, $4, $5) RETURNING *`,
                    [record.case_code, user.id, user.username, guild.id, JSON.stringify({ reason })]
                );
                await client.query(
                    `UPDATE ${T.cases} SET status = 'appeal_pending' WHERE id = $1 AND status = 'active'`,
                    [record.id]
                );
                return rows[0];
            });
        } catch (error) {
            if (isUniqueViolation(error, 'one_pending')) {
                throw userError('You already have a pending appeal for this case. You will get a DM with the decision.');
            }
            throw error;
        }

        let channel;
        try {
            channel = await createPrivateChannel(guild, `appeal-${record.case_code}`);
        } catch (error) {
            // Undo so the user can try again once the channel can be created.
            await withTransaction(async (client) => {
                await client.query(`DELETE FROM ${T.appeals} WHERE id = $1`, [appeal.id]);
                await client.query(`UPDATE ${T.cases} SET status = 'active' WHERE id = $1 AND status = 'appeal_pending'`, [record.id]);
            }).catch(() => {});
            throw error;
        }

        await query(`UPDATE ${T.appeals} SET channel_id = $2 WHERE id = $1`, [appeal.id, channel.id]);

        await channel.send({
            embeds: [
                createEmbed({
                    title: truncate(`Appeal — ${record.name}`, 256),
                    description: truncate(caseDetailsLines(record).join('\n'), 4096),
                    color: 'primary',
                }),
                createEmbed({
                    title: 'Why should this be lifted?',
                    description: truncate(reason, 4096),
                    footer: { text: `Decide with /appeals code:${record.case_code} decision:accept|deny` },
                    color: 'secondary',
                }),
            ],
            allowedMentions: { parse: [] },
        });

        await logEvent({
            client: guild.client,
            guildId: enforcementConfig.mainGuildId,
            eventType: EVENT_TYPES.MODERATION_APPEAL,
            data: {
                userId: user.id,
                fields: [
                    { name: 'Appeal submitted', value: `\`${record.case_code}\` — ${record.name}` },
                    { name: 'User', value: `${user.username} (${user.id})` },
                    { name: 'Channel', value: `<#${channel.id}>` },
                ],
            },
        }).catch(() => {});

        return { record, channel };
    });
}

export async function submitStaffReport({ guild, user, staffMember, details, proof }) {
    const { rows } = await query(
        `INSERT INTO ${T.appeals} (kind, user_id, username, guild_id, body)
         VALUES ('report', $1, $2, $3, $4) RETURNING *`,
        [user.id, user.username, guild.id, JSON.stringify({ staffMember, details, proof })]
    );
    const report = rows[0];

    let channel;
    try {
        channel = await createPrivateChannel(guild, `report-${user.username}`);
    } catch (error) {
        await query(`DELETE FROM ${T.appeals} WHERE id = $1`, [report.id]).catch(() => {});
        throw error;
    }
    await query(`UPDATE ${T.appeals} SET channel_id = $2 WHERE id = $1`, [report.id, channel.id]);

    await channel.send({
        embeds: [createEmbed({
            title: 'Staff report',
            description: truncate([
                `**Reported by:** ${user.username} (\`${user.id}\`)`,
                `**Staff member:** ${staffMember}`,
                `**Filed:** ${dateStamp(new Date())}`,
            ].join('\n'), 4096),
            fields: [
                { name: 'What happened', value: truncate(details, 1024) },
                { name: 'Proof links', value: truncate(proof || 'None given', 1024) },
            ],
            footer: { text: `Report #${report.id}. Ask the reporter for screenshot proof in DMs if needed.` },
            color: 'error',
        })],
        allowedMentions: { parse: [] },
    });

    await logEvent({
        client: guild.client,
        guildId: enforcementConfig.mainGuildId,
        eventType: EVENT_TYPES.MODERATION_STAFF_REPORT,
        data: {
            userId: user.id,
            fields: [
                { name: 'Staff report', value: `#${report.id} about ${truncate(staffMember, 200)}` },
                { name: 'Reporter', value: `${user.username} (${user.id})` },
                { name: 'Channel', value: `<#${channel.id}>` },
            ],
        },
    }).catch(() => {});

    return { report, channel };
}

// ── Decisions ──────────────────────────────────────────────────────────────

async function liftForAcceptedAppeal(client, record, admin) {
    const mainGuild = client.guilds.cache.get(record.guild_id);
    const reason = `Appeal accepted by ${admin.username}`;

    if (record.type === 'ban' && isStillInEffect(record)) {
        if (!mainGuild) throw createError('Main guild unavailable', ErrorTypes.CONFIGURATION, 'I cannot reach the main server to unban.');
        await mainGuild.members.unban(record.target_user_id, reason).catch((error) => {
            if (error?.code !== UNKNOWN_BAN) throw error;
        });
    }
    if (record.type === 'mute' && isStillInEffect(record) && mainGuild) {
        await removeMutedRole(mainGuild, record.target_user_id, reason);
    }
    if (record.type === 'warn') {
        // Lowers the counted warns when this warn still counts at the current level.
        await revokeWarn(record.guild_id, record.case_code, admin.id, reason);
    }

    await withTransaction(async (db) => {
        await db.query(
            `UPDATE ${T.cases} SET status = 'revoked', revoked_by = $2, revoked_at = NOW(), revoke_reason = $3
             WHERE id = $1 AND status <> 'revoked'`,
            [record.id, admin.id, reason]
        );
        if (record.type === 'ban' && record.is_auto) {
            // An accepted ladder ban steps the ladder back by one.
            await db.query(
                `UPDATE ${T.ladder} SET level = GREATEST(0, level - 1), warns_since_level = 0, updated_at = NOW()
                 WHERE guild_id = $1 AND user_id = $2`,
                [record.guild_id, record.target_user_id]
            );
        }
    });
}

async function closeAppealChannel(guild, channelId, decisionLabel) {
    const channel = channelId
        ? guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null)
        : null;
    if (!channel) return;

    try {
        await channel.edit({
            name: `closed-${channel.name}`.slice(0, 100),
            ...(enforcementConfig.appealsArchiveCategoryId ? { parent: enforcementConfig.appealsArchiveCategoryId, lockPermissions: false } : {}),
            reason: `Appeal ${decisionLabel}`,
        });
    } catch (error) {
        logger.warn(`Could not close appeal channel ${channelId}: ${error.message}`);
    }
}

export async function decideAppeal({ client, supportGuild, admin, caseCode, decision, note }) {
    const record = await getCaseByCode(caseCode);
    if (!record) {
        throw userError(`No case with code \`${caseCode}\`.`);
    }

    return Mutex.runExclusive(`enforcement:${record.guild_id}:${record.target_user_id}`, async () => {
        const { rows } = await query(
            `SELECT * FROM ${T.appeals} WHERE case_code = $1 AND kind = 'appeal' AND status = 'pending'
             ORDER BY created_at DESC LIMIT 1`,
            [caseCode]
        );
        const appeal = rows[0];
        if (!appeal) {
            throw userError(`There is no pending appeal for \`${caseCode}\`.`);
        }

        const mainGuild = client.guilds.cache.get(record.guild_id);
        const appellant = await client.users.fetch(record.target_user_id).catch(() => null);
        let dmDelivered = false;

        if (decision === 'accept') {
            await liftForAcceptedAppeal(client, record, admin);
            const invite = mainGuild ? await createRejoinInvite(mainGuild, `Appeal accepted for ${caseCode}`) : null;
            if (appellant) dmDelivered = await sendDm(appellant, appealAcceptedDm(admin.username, invite));
        } else {
            await withTransaction(async (db) => {
                await db.query(`UPDATE ${T.cases} SET status = 'active' WHERE id = $1 AND status = 'appeal_pending'`, [record.id]);
                if (record.type === 'ban' && record.is_auto && record.ladder_level_after === 3) {
                    await db.query(`UPDATE ${T.cases} SET unappealable = TRUE WHERE id = $1`, [record.id]);
                }
            });
            if (appellant) dmDelivered = await sendDm(appellant, appealDeniedDm());
        }

        await query(
            `UPDATE ${T.appeals} SET status = $2, decided_by = $3, decided_by_username = $4, decided_at = NOW(), note = $5
             WHERE id = $1`,
            [appeal.id, decision === 'accept' ? 'accepted' : 'denied', admin.id, admin.username, note || null]
        );

        const label = decision === 'accept' ? 'accepted' : 'denied';
        const channel = appeal.channel_id
            ? supportGuild.channels.cache.get(appeal.channel_id) || await supportGuild.channels.fetch(appeal.channel_id).catch(() => null)
            : null;
        await channel?.send({
            embeds: [createEmbed({
                title: `Appeal ${label}`,
                description: truncate([
                    `**By:** ${admin.username}`,
                    note ? `**Note:** ${note}` : null,
                    `**DM to user:** ${dmDelivered ? 'delivered' : 'not delivered'}`,
                    decision === 'deny' && record.is_auto && record.ladder_level_after === 3 ? 'This level-3 ladder ban is now unappealable.' : null,
                ].filter(Boolean).join('\n'), 4096),
                color: decision === 'accept' ? 'success' : 'error',
            })],
            allowedMentions: { parse: [] },
        }).catch(() => {});

        await logEvent({
            client,
            guildId: record.guild_id,
            eventType: EVENT_TYPES.MODERATION_APPEAL,
            data: {
                userId: record.target_user_id,
                fields: [
                    { name: `Appeal ${label}`, value: `\`${record.case_code}\` — ${record.name}` },
                    { name: 'User', value: `${record.target_username} (${record.target_user_id})` },
                    { name: 'Decided by', value: `${admin.username} (${admin.id})` },
                    ...(note ? [{ name: 'Note', value: note }] : []),
                ],
            },
        }).catch(() => {});

        await closeAppealChannel(supportGuild, appeal.channel_id, label);
        return { record, dmDelivered, label };
    });
}
