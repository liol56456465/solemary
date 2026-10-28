// appealService.js — appeals (filed from the /setappeal panels) and staff reports,
// and the /appeals view and accept|deny decision.
//
// Every appeal and staff report opens a channel in the main server's ticket category
// (the one set in /ticket; MAIN_APPEALS_CATEGORY_ID when none is set), visible to
// administrators only. The user is never added; they get the decision by DM.

import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { createEmbed } from '../../utils/embeds.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { Mutex } from '../../utils/mutex.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { query, withTransaction, T, isUniqueViolation } from './db.js';
import { getCaseByCode, listCasesForUser, setEndDmDelivered, OPEN_STATUSES } from './caseService.js';
import { getGuildConfig } from '../config/guildConfig.js';
import {
    createRejoinInvite, getLadder, liftLadderBanForWarn, logEnforcement, postModLog, revokeWarn, sendDm,
} from './enforcementService.js';
import { syncWarnRolesQuietly } from './warnRoleService.js';
import { generateTranscript } from '../ticket.js';
import { removeMutedRole } from './muteService.js';
import { syncBannedRoleQuietly } from './bannedRoleService.js';
import { appealAcceptedDm, appealDeniedDm } from './dmTemplates.js';
import { dateStamp, formatDuration, stamp, truncate } from './format.js';
import { evidenceDisplay } from './evidenceService.js';

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
    // Administrators see every channel anyway; the user is never added.
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

function configError(message) {
    return createError(message, ErrorTypes.CONFIGURATION,
        'Appeals are not set up correctly right now. Please try again later.', { expected: true });
}

async function fetchCategory(guild, categoryId) {
    if (!categoryId) return null;
    const category = guild.channels.cache.get(categoryId) || await guild.channels.fetch(categoryId).catch(() => null);
    return category?.type === ChannelType.GuildCategory ? category : null;
}

/** Where appeals open: the main server's ticket category from /ticket, else MAIN_APPEALS_CATEGORY_ID. */
export async function getAppealsCategory(mainGuild) {
    const config = await getGuildConfig(mainGuild.client, mainGuild.id).catch(() => ({}));
    return await fetchCategory(mainGuild, config?.ticketCategoryId)
        || fetchCategory(mainGuild, enforcementConfig.appealsCategoryId);
}

function channelName(name) {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);
}

/** An admin-only channel in the main server's appeals category. */
async function createPrivateChannel(client, name, reason) {
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!guild) throw configError('Main guild unavailable for appeals');
    const category = await getAppealsCategory(guild);
    if (!category) throw configError('No ticket category (or MAIN_APPEALS_CATEGORY_ID) in the main server for appeals');
    return guild.channels.create({
        name: channelName(name),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: privateOverwrites(guild),
        reason,
    });
}

// Labels for the stored answers. punished/didIt come from the older form.
const ANSWER_LABELS = {
    punished: 'Why did you get punished?',
    reason: 'Why should it be lifted?',
    didIt: 'Did you do it?',
    moreInfo: 'More info',
};

const DID_IT_LABELS = {
    yes: 'Yes, I did it',
    partly: 'Partly',
    no: "No, I didn't do it",
};

const CASE_STATUS_LABELS = {
    active: 'Active',
    appeal_pending: 'Active, appeal pending',
    expired: 'Ended',
    revoked: 'Lifted',
};

const APPEAL_STATUS_LABELS = {
    pending: 'pending',
    accepted: 'accepted',
    denied: 'denied',
    closed: 'closed',
};

function parseBody(body) {
    if (!body) return {};
    return typeof body === 'string' ? JSON.parse(body) : body;
}

function caseDetailsLines(record) {
    const lines = [
        ...(record.is_test ? ['**Test case** created with /test. Nothing was executed, and accepting it changes nothing.'] : []),
        `**Case code:** \`${record.case_code}\``,
        `**Type:** ${record.type}${record.is_auto ? ' (automatic, warn ladder)' : ''}`,
        `**Status:** ${CASE_STATUS_LABELS[record.status] || record.status}`,
        `**Name:** ${record.name}`,
        `**User:** <@${record.target_user_id}> ${record.target_username} (\`${record.target_user_id}\`)`,
        `**By:** <@${record.moderator_id}> ${record.moderator_username}`,
        `**When:** ${stamp(record.created_at)}`,
        `**Reason:** ${truncate(record.reason, 500)}`,
    ];
    if (record.type === 'ban' || record.type === 'mute') {
        lines.push(record.expires_at
            ? `**Duration:** ${formatDuration(Number(record.duration_ms))}, ends ${stamp(record.expires_at)}`
            : '**Duration:** Permanent');
    }
    if (record.appeal_deadline) {
        lines.push(`**Appeal deadline:** ${dateStamp(record.appeal_deadline)}`);
    }
    if (record.unappealable) {
        lines.push('**Unappealable:** yes');
    }
    if (record.status === 'revoked' && record.revoked_at) {
        lines.push(`**Lifted:** ${dateStamp(record.revoked_at)}${record.revoke_reason ? `, ${record.revoke_reason}` : ''}`);
    }
    lines.push(`**DM delivered:** ${record.dm_delivered ? 'yes' : 'no'}`);
    lines.push(`**Ladder level after:** ${record.ladder_level_after}`);
    return lines;
}

/** An appeal's answers as [{ label, value }] (the dashboard shows them too). */
export function appealAnswers(body) {
    return Object.entries(parseBody(body))
        .filter(([, value]) => value)
        .map(([key, value]) => ({
            label: ANSWER_LABELS[key] || key,
            value: String(key === 'didIt' ? (DID_IT_LABELS[value] || value) : value),
        }));
}

function answerFields(body) {
    return appealAnswers(body).map(({ label, value }) => ({ name: label, value: truncate(value, 1024) }));
}

function appealLine(appeal) {
    const status = APPEAL_STATUS_LABELS[appeal.status] || appeal.status;
    const decided = appeal.decided_at
        ? `, ${status} by ${appeal.decided_by_username || 'unknown'} ${dateStamp(appeal.decided_at)}`
        : `, ${status}`;
    const note = appeal.note ? ` (note: ${truncate(appeal.note, 120)})` : '';
    return `Filed ${dateStamp(appeal.created_at)}${decided}${note}`;
}

/**
 * Embeds describing a case for administrators: the case itself, the appeal being
 * looked at (if any), earlier appeals on this case, and the user's other cases.
 * Used in the appeal channel and by /appeals.
 */
export async function buildCaseDossier(record, { appeal = null, client = null } = {}) {
    const [{ rows: caseAppeals }, { rows: userAppeals }, { rows: [appealCount] }, { rows: otherCases, total }, ladder, evidence] = await Promise.all([
        query(
            `SELECT * FROM ${T.appeals} WHERE case_code = $1 AND kind = 'appeal' ORDER BY created_at DESC LIMIT 10`,
            [record.case_code]
        ),
        query(
            `SELECT DISTINCT ON (case_code) case_code, status FROM ${T.appeals}
             WHERE user_id = $1 AND kind = 'appeal' ORDER BY case_code, created_at DESC`,
            [record.target_user_id]
        ),
        query(
            `SELECT COUNT(*)::int AS count FROM ${T.appeals} WHERE user_id = $1 AND kind = 'appeal'`,
            [record.target_user_id]
        ),
        listCasesForUser(record.guild_id, record.target_user_id, { limit: 16 }),
        getLadder(record.guild_id, record.target_user_id).catch(() => null),
        // Appeal channels are staff-only, so excerpts and images can be shown.
        evidenceDisplay(client, record.case_code).catch(() => ({ field: null, imageUrl: null })),
    ]);

    const current = appeal || caseAppeals.find((row) => row.status === 'pending') || null;
    const embeds = [createEmbed({
        title: truncate(`${record.is_test ? 'Test case' : 'Case'} ${record.case_code}: ${record.name}`, 256),
        description: truncate(caseDetailsLines(record).join('\n'), 4096),
        fields: evidence.field ? [evidence.field] : [],
        image: evidence.imageUrl,
        color: 'primary',
    })];

    if (current) {
        embeds.push(createEmbed({
            title: `Appeal (${APPEAL_STATUS_LABELS[current.status] || current.status})`,
            description: `Filed by ${current.username} ${stamp(current.created_at)}${current.channel_id ? ` in <#${current.channel_id}>` : ''}`,
            fields: answerFields(current.body),
            color: 'secondary',
        }));
    }

    const earlier = caseAppeals.filter((row) => row.id !== current?.id);
    const latestAppealByCase = new Map(userAppeals.map((row) => [row.case_code, row.status]));
    const others = otherCases.filter((row) => row.case_code !== record.case_code).slice(0, 15);
    const otherLines = others.map((row) => {
        const appealStatus = latestAppealByCase.get(row.case_code);
        return `\`${row.case_code}\` **${row.type}**${row.is_test ? ' (test)' : ''} ${dateStamp(row.created_at)}, ${CASE_STATUS_LABELS[row.status] || row.status}`
            + `${appealStatus ? `, appeal ${APPEAL_STATUS_LABELS[appealStatus] || appealStatus}` : ''}`
            + `: ${truncate(row.reason, 80)}`;
    });
    const moreCount = Math.max(0, total - 1 - others.length);

    embeds.push(createEmbed({
        title: 'History',
        fields: [
            {
                name: 'Earlier appeals on this case',
                value: truncate(earlier.length ? earlier.map(appealLine).join('\n') : 'None', 700),
            },
            {
                name: `Other enforcements (${Math.max(0, total - 1)})`,
                value: truncate(otherLines.length
                    ? otherLines.join('\n') + (moreCount ? `\n…and ${moreCount} more` : '')
                    : 'None', 700),
            },
            {
                name: 'Appeals filed in total',
                value: String(appealCount?.count ?? 0),
                inline: true,
            },
            ...(ladder ? [{ name: 'Warn ladder', value: `Level ${ladder.level}, ${ladder.warns_since_level} warn(s) since`, inline: true }] : []),
        ],
        color: 'secondary',
    }));

    return embeds;
}

const DECISION_BUTTON_ID = 'appealdecide';

/** Accept / Deny buttons under an appeal; each decides that case's appeal straight away. */
export function appealDecisionRow(caseCode, { disabled = false } = {}) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${DECISION_BUTTON_ID}:accept:${caseCode}`)
            .setLabel('Accept').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`${DECISION_BUTTON_ID}:deny:${caseCode}`)
            .setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    );
}

/** Disables the Accept / Deny buttons on the bot's messages in an appeal channel. */
async function disableDecisionButtons(channel, caseCode) {
    const messages = await channel.messages?.fetch({ limit: 20 }).catch(() => null);
    if (!messages) return;
    for (const message of messages.values()) {
        const hasButtons = message.author?.id === channel.client.user.id
            && message.components.some((row) => row.components?.some((c) => c.customId?.startsWith(`${DECISION_BUTTON_ID}:`)));
        if (hasButtons) {
            await message.edit({ components: [appealDecisionRow(caseCode, { disabled: true })] })
                .catch((error) => logger.warn(`Could not disable appeal buttons in ${channel.id}: ${error.message}`));
        }
    }
}

/** Pending appeals of one server's cases (the main server by default), oldest first, with their case. */
export async function listPendingAppeals(limit = 20, guildId = enforcementConfig.mainGuildId) {
    const { rows } = await query(
        `SELECT a.case_code, a.username, a.user_id, a.channel_id, a.created_at, c.type, c.name, c.is_test
         FROM ${T.appeals} a JOIN ${T.cases} c ON c.case_code = a.case_code
         WHERE a.kind = 'appeal' AND a.status = 'pending' AND c.guild_id = $2
         ORDER BY a.created_at ASC LIMIT $1`,
        [limit, guildId]
    );
    return rows;
}

/**
 * @param {object} p
 * @param {import('discord.js').Client} p.client
 * @param {import('discord.js').User} p.user
 * @param {string} p.caseCode
 * @param {{ reason: string, moreInfo: string }} p.answers
 */
export async function submitAppeal({ client, user, caseCode, answers }) {
    const record = await getCaseByCode(caseCode);
    return Mutex.runExclusive(`appeal:${caseCode}`, async () => {
        await assertAppealable(record, user.id);
        const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
        if (!guild) throw configError('Main guild unavailable for appeals');

        let appeal;
        try {
            appeal = await withTransaction(async (client) => {
                const { rows } = await client.query(
                    `INSERT INTO ${T.appeals} (kind, case_code, user_id, username, guild_id, body)
                     VALUES ('appeal', $1, $2, $3, $4, $5) RETURNING *`,
                    [record.case_code, user.id, user.username, guild.id, JSON.stringify(answers)]
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
            channel = await createPrivateChannel(client, `appeal-${record.case_code}`, `Appeal ${record.case_code}`);
        } catch (error) {
            // Undo so the user can try again once the channel can be created.
            await withTransaction(async (client) => {
                await client.query(`DELETE FROM ${T.appeals} WHERE id = $1`, [appeal.id]);
                await client.query(`UPDATE ${T.cases} SET status = 'active' WHERE id = $1 AND status = 'appeal_pending'`, [record.id]);
            }).catch(() => {});
            throw error;
        }

        await query(`UPDATE ${T.appeals} SET channel_id = $2 WHERE id = $1`, [appeal.id, channel.id]);

        const pendingRecord = { ...record, status: record.status === 'active' ? 'appeal_pending' : record.status };
        const embeds = await buildCaseDossier(pendingRecord, { appeal: { ...appeal, channel_id: channel.id }, client })
            .catch((error) => {
                logger.warn(`Could not build the case summary for appeal ${record.case_code}: ${error.message}`);
                return [createEmbed({
                    title: truncate(`Appeal: ${record.name}`, 256),
                    description: truncate(caseDetailsLines(pendingRecord).join('\n'), 4096),
                    fields: answerFields(answers),
                    color: 'primary',
                })];
            });
        await channel.send({
            content: `New appeal from ${user.username} for \`${record.case_code}\`. Decide with the buttons below or \`/appeals\`.`,
            embeds,
            components: [appealDecisionRow(record.case_code)],
            allowedMentions: { parse: [] },
        });

        await logEvent({
            client,
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

const MAX_REPORTS_PER_DAY = 3;

/** Each report opens a channel, so cap them: one open at a time, three a day. */
async function assertCanReport(guild, userId) {
    const { rows } = await query(
        `SELECT channel_id, created_at > NOW() - INTERVAL '1 day' AS today FROM ${T.appeals}
         WHERE kind = 'report' AND user_id = $1`,
        [userId]
    );
    if (rows.filter((row) => row.today).length >= MAX_REPORTS_PER_DAY) {
        throw userError('You have sent the maximum number of staff reports for today. Please try again tomorrow.');
    }
    const open = rows.find((row) => row.channel_id && guild.channels.cache.has(row.channel_id));
    if (open) throw userError('You already have an open staff report. The administrators will contact you about it.');
}

export async function submitStaffReport({ client, user, staffMember, details, proof }) {
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!guild) throw configError('Main guild unavailable for staff reports');
    // One submission per member at a time: two forms sent at once must not both pass the
    // "one open report" check (the new row only counts as open once its channel exists).
    return Mutex.runExclusive(`report:${user.id}`, () => openStaffReport({ client, guild, user, staffMember, details, proof }));
}

async function openStaffReport({ client, guild, user, staffMember, details, proof }) {
    await assertCanReport(guild, user.id);
    const { rows } = await query(
        `INSERT INTO ${T.appeals} (kind, user_id, username, guild_id, body)
         VALUES ('report', $1, $2, $3, $4) RETURNING *`,
        [user.id, user.username, guild.id, JSON.stringify({ staffMember, details, proof })]
    );
    const report = rows[0];

    let channel;
    try {
        channel = await createPrivateChannel(client, `report-${user.username}`, 'Staff report');
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
        client,
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

/**
 * Lifts a case and logs it like the matching manual action (unban, unmute, warning
 * removed): used for accepted appeals and for automod decisions a moderator reverses.
 * `reason` is stored as the revoke reason; `via` is shown next to the moderator in
 * the logs. Returns notes for the decision message.
 */
export async function liftCase(client, record, admin, { reason, via }) {
    const mainGuild = client.guilds.cache.get(record.guild_id);
    const notes = [];

    if (record.is_test) {
        // A /test case was never executed: only the record is closed.
        await query(
            `UPDATE ${T.cases} SET status = 'revoked', revoked_by = $2, revoked_at = NOW(), revoke_reason = $3
             WHERE id = $1 AND status <> 'revoked'`,
            [record.id, admin.id, reason]
        );
        return notes;
    }

    const target = { id: record.target_user_id, username: record.target_username };
    const moderatorLabel = `${admin.username} (${admin.id}), ${via}`;
    const liftedBan = record.type === 'ban' && isStillInEffect(record);
    const liftedMute = record.type === 'mute' && isStillInEffect(record);
    let ladderBan = null;

    if (liftedBan) {
        if (!mainGuild) throw createError('Main guild unavailable', ErrorTypes.CONFIGURATION, 'I cannot reach the main server to unban.');
        await mainGuild.members.unban(record.target_user_id, reason).catch((error) => {
            if (error?.code !== UNKNOWN_BAN) throw error;
        });
    }
    if (liftedMute && mainGuild) {
        await removeMutedRole(mainGuild, record.target_user_id, reason);
    }
    if (record.type === 'warn') {
        // Lowers the counted warns when this warn still counts at the current level.
        const warn = await revokeWarn(record.guild_id, record.case_code, admin.id, reason);
        // If this warn helped trigger the current ladder ban, the limit was never reached.
        if (warn && mainGuild) {
            ladderBan = await liftLadderBanForWarn(mainGuild, warn, admin, `${reason} (warn ${record.case_code})`);
        }
    }

    const triggerWarn = await withTransaction(async (db) => {
        await db.query(
            `UPDATE ${T.cases} SET status = 'revoked', revoked_by = $2, revoked_at = NOW(), revoke_reason = $3
             WHERE id = $1 AND status <> 'revoked'`,
            [record.id, admin.id, reason]
        );
        if (!(record.type === 'ban' && record.is_auto)) return null;

        // The ladder ban's code also covers the warn that triggered it: that warn is
        // removed and the ladder steps back one level, keeping the level's other warns.
        const previousLevel = Math.max(0, record.ladder_level_after - 1);
        const { rows: [warn] } = await db.query(
            `UPDATE ${T.cases} SET status = 'revoked', revoked_by = $1, revoked_at = NOW(), revoke_reason = $2
             WHERE id = (
                 SELECT id FROM ${T.cases}
                 WHERE guild_id = $3 AND target_user_id = $4 AND type = 'warn' AND status = ANY($5)
                   AND is_test = FALSE AND ladder_level_after = $6 AND counts_toward_level = $7 AND created_at <= $8
                 ORDER BY created_at DESC LIMIT 1
             )
             RETURNING *`,
            [admin.id, `${reason} (ban ${record.case_code})`, record.guild_id, record.target_user_id,
                OPEN_STATUSES, record.ladder_level_after, previousLevel, record.created_at]
        );
        const { rows: [counted] } = await db.query(
            `SELECT COUNT(*)::int AS count FROM ${T.cases}
             WHERE guild_id = $1 AND target_user_id = $2 AND type = 'warn' AND status = ANY($3)
               AND is_imported = FALSE AND is_test = FALSE AND counts_toward_level = $4`,
            [record.guild_id, record.target_user_id, OPEN_STATUSES, previousLevel]
        );
        await db.query(
            `UPDATE ${T.ladder} SET level = $3, warns_since_level = $4, updated_at = NOW()
             WHERE guild_id = $1 AND user_id = $2`,
            [record.guild_id, record.target_user_id, previousLevel, counted?.count || 0]
        );
        return warn || null;
    });
    if (record.type === 'ban') await syncBannedRoleQuietly(client, record.target_user_id);
    if ((record.type === 'warn' || triggerWarn) && mainGuild) await syncWarnRolesQuietly(mainGuild, record.target_user_id);

    const extra = [{ name: 'Reason', value: reason }];
    if (liftedBan) {
        await logEnforcement(client, record.guild_id, 'unban', { target, moderatorLabel, extra: [...extra, { name: 'Lifted cases', value: `\`${record.case_code}\`` }] });
        notes.push('The user was unbanned.');
    }
    if (liftedMute) {
        await logEnforcement(client, record.guild_id, 'unmute', { target, moderatorLabel, extra: [...extra, { name: 'Lifted cases', value: `\`${record.case_code}\`` }] });
        notes.push('The user was unmuted.');
    }
    if (record.type === 'warn') {
        const ladder = await getLadder(record.guild_id, record.target_user_id).catch(() => null);
        await logEnforcement(client, record.guild_id, 'removewarn', {
            target, moderatorLabel,
            extra: [
                { name: 'Warning', value: `\`${record.case_code}\` — ${record.name}` },
                ...extra,
                ...(ladder ? [{ name: 'Counted warns now', value: `${ladder.warns_since_level} (ladder level ${ladder.level})` }] : []),
            ],
        });
        notes.push('The warning was removed.');
    }
    if (triggerWarn) {
        await logEnforcement(client, record.guild_id, 'removewarn', {
            target, moderatorLabel,
            extra: [
                { name: 'Warning', value: `\`${triggerWarn.case_code}\` — ${triggerWarn.name}` },
                { name: 'Reason', value: `${reason} (it triggered the automatic ban \`${record.case_code}\`)` },
            ],
        });
        notes.push(`The warning that triggered this automatic ban (\`${triggerWarn.case_code}\`) was removed too.`);
    }
    if (ladderBan) {
        await logEnforcement(client, record.guild_id, 'unban', {
            target, moderatorLabel,
            extra: [...extra, { name: 'Lifted cases', value: `\`${ladderBan.case_code}\` (automatic ban from the warning limit)` }],
        });
        notes.push(`This warning was part of the automatic ban \`${ladderBan.case_code}\`, so the user was unbanned and the warning level stepped back.`);
    }
    return notes;
}

const APPEAL_CHANNEL_DELETE_DELAY_MS = 10 * 1000;

/** Deletes a decided appeal's channel after a short delay, so the decision can be read first. */
function scheduleAppealChannelDelete(channel, decisionLabel) {
    setTimeout(() => {
        channel.delete(`Appeal ${decisionLabel}`).catch((error) =>
            logger.warn(`Could not delete appeal channel ${channel.id}: ${error.message}`));
    }, APPEAL_CHANNEL_DELETE_DELAY_MS).unref?.();
}

export async function decideAppeal({ client, admin, caseCode, decision, note }) {
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
        let notes = [];

        if (decision === 'accept') {
            notes = await liftCase(client, record, admin, {
                reason: `Appeal accepted by ${admin.username}`,
                via: `appeal \`${record.case_code}\``,
            });
            const invite = mainGuild ? await createRejoinInvite(mainGuild, `Appeal accepted for ${caseCode}`) : null;
            if (appellant) dmDelivered = await sendDm(appellant, appealAcceptedDm(admin.username, invite));
            // The acceptance DM is also the "ban/mute ended" notice: no second DM.
            if (!record.is_test && (record.type === 'ban' || record.type === 'mute') && isStillInEffect(record)) {
                await setEndDmDelivered([record.id], dmDelivered).catch((error) =>
                    logger.warn(`Could not record end DM for ${caseCode}: ${error.message}`));
            }
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
        // The appeal row's guild is the server its channel was opened in.
        const channelGuild = client.guilds.cache.get(appeal.guild_id);
        const channel = appeal.channel_id && channelGuild
            ? channelGuild.channels.cache.get(appeal.channel_id) || await channelGuild.channels.fetch(appeal.channel_id).catch(() => null)
            : null;
        await channel?.send({
            embeds: [createEmbed({
                title: `Appeal ${label}`,
                description: truncate([
                    `**By:** ${admin.username}`,
                    note ? `**Note:** ${note}` : null,
                    `**DM to user:** ${dmDelivered ? 'delivered' : 'not delivered'}`,
                    decision === 'deny' && record.is_auto && record.ladder_level_after === 3 ? 'This level-3 ladder ban is now unappealable.' : null,
                    ...notes,
                    '',
                    `-# This channel is deleted in ${APPEAL_CHANNEL_DELETE_DELAY_MS / 1000} seconds. The appeal stays in /appeals code:${record.case_code}.`,
                ].filter((line) => line !== null).join('\n'), 4096),
                color: decision === 'accept' ? 'success' : 'error',
            })],
            allowedMentions: { parse: [] },
        }).catch(() => {});
        if (channel) await disableDecisionButtons(channel, caseCode);

        // The channel is deleted shortly; keep what was said in it.
        const transcript = channel ? await generateTranscript(channel).catch(() => null) : null;
        const logFields = [
            { name: `Appeal ${label}`, value: `\`${record.case_code}\` — ${record.name}` },
            { name: 'User', value: `${record.target_username} (${record.target_user_id})` },
            { name: 'Decided by', value: `${admin.username} (${admin.id})` },
            ...(note ? [{ name: 'Note', value: note }] : []),
        ];
        await logEvent({
            client,
            guildId: record.guild_id,
            eventType: EVENT_TYPES.MODERATION_APPEAL,
            data: { userId: record.target_user_id, fields: logFields },
        }).catch(() => {});
        if (!record.is_test || transcript) {
            await postModLog(client, 'appeal', logFields, {
                title: `Appeal ${label}${record.is_test ? ' (test case)' : ''}`,
                files: transcript ? [new AttachmentBuilder(transcript.buffer, { name: `appeal-${record.case_code}.html` })] : [],
            });
        }

        if (channel) scheduleAppealChannelDelete(channel, label);
        return { record, dmDelivered, label, notes };
    });
}
