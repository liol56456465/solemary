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
import { withOpenChannelSlot } from '../openChannelCap.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { query, withTransaction, T, isUniqueViolation } from './db.js';
import { getCaseByCode, getCaseByCodeAnyServer, listCasesForUser, setEndDmDelivered, OPEN_STATUSES } from './caseService.js';
import { getGuildConfig } from '../config/guildConfig.js';
import {
    createRejoinInvite, getLadder, liftLadderBanForWarn, logEnforcement, postModLog, revokeWarn, sendCaseDm,
} from './enforcementService.js';
import { syncWarnRolesQuietly } from './warnRoleService.js';
import { generateTranscript } from '../ticket.js';
import { removeMutedRole } from './muteService.js';
import { syncBannedRoleQuietly } from './bannedRoleService.js';
import { durationIn } from './dmTemplates.js';
import { botText, resolveBotLanguage, textForGuild } from '../../utils/botText.js';
import { LADDER_STAGE_BANS, dateStamp, ladderStage, ladderStageShort, stamp, truncate } from './format.js';
import { evidenceDisplay } from './evidenceService.js';
import { SECOND_REVIEWER_MESSAGE, checkAppealReviewer, needsSecondReviewer } from './appealReviewer.js';
import { recordOwnerOverride } from '../ownerOverride.js';
import { homeSettingsGuild, isHomeGuild, resolveSetting } from '../settings/guildSettings.js';

const UNKNOWN_BAN = 10026;
const DAY_MS = 24 * 60 * 60 * 1000;

function userError(message) {
    return createError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

/**
 * The server whose appeal settings apply to a case. Home cases (main or support server) read
 * the main server's settings, exactly as before multi-server; any other server reads its own
 * (resolveSetting: its stored value or the neutral default, never Mewvo's).
 */
export function appealSettingsGuild(guildId) {
    return homeSettingsGuild(guildId);
}

/**
 * The server an appeal's staff channel and appeal row belong to: the main server for home
 * cases (as before), the case's own server otherwise, never one of Mewvo's servers.
 */
export function appealStaffGuildId(record) {
    return isHomeGuild(record.guild_id) ? enforcementConfig.mainGuildId : record.guild_id;
}

/**
 * Whether staff working in `callerGuildId` may see or decide this case's appeal: the caller's
 * server must be the case's appeal staff server. Mewvo's two servers count as one (the main
 * server), so home behaviour is unchanged; any other server only its own cases. No owner
 * exception: OWNER_IDS act from the case's own server like everyone else.
 */
export function isCaseOfCallerServer(record, callerGuildId) {
    if (!record || !callerGuildId) return false;
    const callerStaff = isHomeGuild(callerGuildId) ? enforcementConfig.mainGuildId : callerGuildId;
    return appealStaffGuildId(record) === callerStaff;
}

export const OTHER_SERVER_CASE = 'That case belongs to another server.';

/** Throws the plain "belongs to another server" user error when the caller's server may not act on it. */
export function assertCaseOfCallerServer(record, callerGuildId) {
    if (!isCaseOfCallerServer(record, callerGuildId)) throw userError(OTHER_SERVER_CASE);
}

function isStillInEffect(record) {
    return OPEN_STATUSES.includes(record.status)
        && (!record.expires_at || new Date(record.expires_at) > new Date());
}

/**
 * Throws a user-facing error when this user may not appeal this case right now. The text is in
 * `lang` (the member's language; the appeal form passes it), English by default.
 */
export async function assertAppealable(record, userId, { lang = 'en' } = {}) {
    const tr = botText(lang);
    // The same message for "no such code" and "not yours" so codes can't be probed.
    if (!record || record.target_user_id !== userId) {
        throw userError(tr.t('member.appeal.error.notFound'));
    }
    if (record.unappealable) {
        throw userError(tr.t('member.appeal.error.unappealable'));
    }
    if (record.status === 'revoked') {
        throw userError(tr.t('member.appeal.error.lifted'));
    }

    const now = Date.now();
    if (record.type === 'ban' || record.type === 'mute') {
        if (!isStillInEffect(record)) {
            throw userError(tr.t(record.type === 'ban' ? 'member.appeal.error.endedBan' : 'member.appeal.error.endedMute'));
        }
        if (record.appeal_deadline && new Date(record.appeal_deadline).getTime() <= now) {
            throw userError(tr.t('member.appeal.error.windowClosed'));
        }
    } else {
        const windowMs = resolveSetting(appealSettingsGuild(record.guild_id), 'appealWindowMs');
        if (now - new Date(record.created_at).getTime() > windowMs) {
            const days = Math.round(windowMs / DAY_MS);
            throw userError(tr.tp(record.type === 'kick' ? 'member.appeal.error.windowKick' : 'member.appeal.error.windowWarn', days));
        }
    }

    const { rows } = await query(
        `SELECT status, decided_at FROM ${T.appeals}
         WHERE case_code = $1 AND kind = 'appeal' AND status IN ('pending', 'denied')
         ORDER BY created_at DESC LIMIT 1`,
        [record.case_code]
    );
    const last = rows[0];
    if (last?.status === 'pending') {
        throw userError(tr.t('member.appeal.error.pending'));
    }
    if (last?.status === 'denied') {
        const retryAt = new Date(last.decided_at).getTime() + resolveSetting(appealSettingsGuild(record.guild_id), 'appealCooldownMs');
        if (retryAt > now) {
            throw userError(tr.t('member.appeal.error.cooldown', { when: `<t:${Math.floor(retryAt / 1000)}:R>` }));
        }
    }
}

/** Admin-only overwrites: @everyone cannot see it, the bot can (also for an auto-created appeals category). */
export function privateOverwrites(guild) {
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

/**
 * The server's guild config for the /ticket category fallback. Home servers keep the old
 * behaviour (a failed read means "no ticket category"); for any other server a failed read
 * throws, so a database error never quietly turns an appeal into store-only.
 */
async function ticketConfig(guild) {
    return getGuildConfig(guild.client, guild.id).catch((error) => {
        if (!isHomeGuild(guild.id)) throw error;
        return {};
    });
}

/** Where appeals open in this server: its own appeals category, else its /ticket category. */
export async function getAppealsCategory(guild) {
    const config = await ticketConfig(guild);
    return await fetchCategory(guild, resolveSetting(guild.id, 'appealsCategoryId'))
        || fetchCategory(guild, config?.ticketCategoryId);
}

/** Where staff reports open in this server: its own category, else the /ticket category, else the appeals one. */
export async function getReportsCategory(guild) {
    const config = await ticketConfig(guild);
    return await fetchCategory(guild, resolveSetting(guild.id, 'reportsCategoryId'))
        || await fetchCategory(guild, config?.ticketCategoryId)
        || fetchCategory(guild, resolveSetting(guild.id, 'appealsCategoryId'));
}

function channelName(name) {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);
}

/**
 * An admin-only channel in `guild` (the main server for home cases and reports), in the appeals
 * category (or the one findCategory picks).
 */
async function createPrivateChannel(guild, name, reason, findCategory = getAppealsCategory) {
    const category = await findCategory(guild);
    if (!category) throw configError(`No category for this channel in ${isHomeGuild(guild.id) ? 'the main server' : 'this server'}: set it in the dashboard (Enforcement & appeals) or set the /ticket category`);
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

/**
 * The staff-facing labels in one language (src/content/bot/<lang>/staff.json → dossier). Literal
 * keys on purpose: tests/botI18nUsage.test.js checks every key used here exists.
 */
function staffLabels(tr) {
    return {
        answer: {
            punished: tr.t('staff.dossier.answer.punished'),
            reason: tr.t('staff.dossier.answer.reason'),
            didIt: tr.t('staff.dossier.answer.didIt'),
            moreInfo: tr.t('staff.dossier.answer.moreInfo'),
        },
        didIt: {
            yes: tr.t('staff.dossier.didIt.yes'),
            partly: tr.t('staff.dossier.didIt.partly'),
            no: tr.t('staff.dossier.didIt.no'),
        },
        caseStatus: {
            active: tr.t('staff.dossier.caseStatus.active'),
            appeal_pending: tr.t('staff.dossier.caseStatus.appealPending'),
            expired: tr.t('staff.dossier.caseStatus.expired'),
            revoked: tr.t('staff.dossier.caseStatus.revoked'),
        },
        appealStatus: {
            pending: tr.t('staff.dossier.appealStatus.pending'),
            accepted: tr.t('staff.dossier.appealStatus.accepted'),
            denied: tr.t('staff.dossier.appealStatus.denied'),
            closed: tr.t('staff.dossier.appealStatus.closed'),
        },
        type: {
            ban: tr.t('staff.dossier.caseType.ban'),
            kick: tr.t('staff.dossier.caseType.kick'),
            mute: tr.t('staff.dossier.caseType.mute'),
            warn: tr.t('staff.dossier.caseType.warn'),
        },
    };
}

/** The case type (ban, kick, mute, warn) in a language; anything else as stored. */
export function caseTypeIn(type, { lang = 'en' } = {}) {
    return staffLabels(botText(lang)).type[type] || type;
}

/** "1 of 3 (7-day ban)" in a language (English: format.js ladderStageShort, unchanged). */
export function ladderStageShortIn(level, { lang = 'en' } = {}) {
    if (lang === 'en') return ladderStageShort(level);
    const tr = botText(lang);
    const n = Math.max(0, Math.min(3, Number(level) || 0));
    if (n === 0) return tr.t('staff.dossier.stage.none');
    const ms = LADDER_STAGE_BANS[n];
    const ban = ms == null ? tr.t('staff.dossier.stage.permanentBan') : tr.t('staff.dossier.stage.dayBan', { days: Math.round(ms / (24 * 60 * 60 * 1000)) });
    return tr.t('staff.dossier.stage.level', { level: n, ban });
}

/** "warning stage 1 of 3 (7-day ban)" in a language (English: format.js ladderStage). */
function ladderStageIn(level, lang = 'en') {
    if (lang === 'en') return ladderStage(level);
    return botText(lang).t('staff.dossier.stage.full', { stage: ladderStageShortIn(level, { lang }) });
}

function parseBody(body) {
    if (!body) return {};
    return typeof body === 'string' ? JSON.parse(body) : body;
}

function caseDetailsLines(record, lang = 'en') {
    const tr = botText(lang);
    const labels = staffLabels(tr);
    const lines = [
        ...(record.is_test ? [tr.t('staff.dossier.testCase')] : []),
        tr.t('staff.dossier.caseCode', { code: record.case_code }),
        record.is_auto
            ? tr.t('staff.dossier.typeAuto', { type: labels.type[record.type] || record.type })
            : tr.t('staff.dossier.type', { type: labels.type[record.type] || record.type }),
        tr.t('staff.dossier.status', { status: labels.caseStatus[record.status] || record.status }),
        tr.t('staff.dossier.name', { name: record.name }),
        tr.t('staff.dossier.user', { userId: record.target_user_id, username: record.target_username }),
        tr.t('staff.dossier.by', { moderatorId: record.moderator_id, moderator: record.moderator_username }),
        tr.t('staff.dossier.when', { when: stamp(record.created_at) }),
        tr.t('staff.dossier.reason', { reason: truncate(record.reason, 500) }),
    ];
    if (record.type === 'ban' || record.type === 'mute') {
        lines.push(record.expires_at
            ? tr.t('staff.dossier.duration', { duration: durationIn(Number(record.duration_ms), tr.lang), end: stamp(record.expires_at) })
            : tr.t('staff.dossier.durationPermanent'));
    }
    if (record.appeal_deadline) {
        lines.push(tr.t('staff.dossier.appealDeadline', { date: dateStamp(record.appeal_deadline) }));
    }
    if (record.unappealable) {
        lines.push(tr.t('staff.dossier.cannotAppeal'));
    }
    if (record.status === 'revoked' && record.revoked_at) {
        lines.push(record.revoke_reason
            ? tr.t('staff.dossier.liftedEarlyReason', { date: dateStamp(record.revoked_at), reason: record.revoke_reason })
            : tr.t('staff.dossier.liftedEarly', { date: dateStamp(record.revoked_at) }));
    }
    lines.push(tr.t(record.dm_delivered ? 'staff.dossier.dmYes' : 'staff.dossier.dmNo'));
    lines.push(tr.t('staff.dossier.stageAfter', { stage: ladderStageShortIn(record.ladder_level_after, { lang: tr.lang }) }));
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

/** The answers as embed fields: labels in `lang`, the answers as the member wrote them. */
function answerFields(body, lang = 'en') {
    const labels = staffLabels(botText(lang));
    return Object.entries(parseBody(body))
        .filter(([, value]) => value)
        .map(([key, value]) => ({
            name: labels.answer[key] || key,
            value: truncate(String(key === 'didIt' ? (labels.didIt[value] || value) : value), 1024),
        }));
}

function appealLine(appeal, tr) {
    const status = staffLabels(tr).appealStatus[appeal.status] || appeal.status;
    const decided = appeal.decided_at
        ? tr.t('staff.dossier.appealLine.decided', { status, name: appeal.decided_by_username || tr.t('staff.dossier.appealLine.unknown'), date: dateStamp(appeal.decided_at) })
        : tr.t('staff.dossier.appealLine.status', { status });
    const note = appeal.note ? tr.t('staff.dossier.appealLine.note', { note: truncate(appeal.note, 120) }) : '';
    return tr.t('staff.dossier.appealLine.filed', { date: dateStamp(appeal.created_at), decided, note });
}

/**
 * Embeds describing a case for administrators: the case itself, the appeal being
 * looked at (if any), earlier appeals on this case, and the user's other cases.
 * Used in the appeal channel (the server's language) and by /appeals (the admin's):
 * `lang`, default English (the web dashboard does not use it).
 */
export async function buildCaseDossier(record, { appeal = null, client = null, lang = 'en' } = {}) {
    const tr = botText(lang);
    const labels = staffLabels(tr);
    // The member's appeals in this case's server only (an appeal row's guild_id is its staff
    // server): appeals they filed in other servers are never counted or shown here.
    const staffGuildId = appealStaffGuildId(record);
    const [{ rows: caseAppeals }, { rows: userAppeals }, { rows: [appealCount] }, { rows: otherCases, total }, ladder, evidence] = await Promise.all([
        query(
            `SELECT * FROM ${T.appeals} WHERE case_code = $1 AND kind = 'appeal' ORDER BY created_at DESC LIMIT 10`,
            [record.case_code]
        ),
        query(
            `SELECT DISTINCT ON (case_code) case_code, status FROM ${T.appeals}
             WHERE user_id = $1 AND kind = 'appeal' AND guild_id = $2 ORDER BY case_code, created_at DESC`,
            [record.target_user_id, staffGuildId]
        ),
        query(
            `SELECT COUNT(*)::int AS count FROM ${T.appeals} WHERE user_id = $1 AND kind = 'appeal' AND guild_id = $2`,
            [record.target_user_id, staffGuildId]
        ),
        listCasesForUser(record.guild_id, record.target_user_id, { limit: 16 }),
        getLadder(record.guild_id, record.target_user_id).catch(() => null),
        // Appeal channels are staff-only, so excerpts and images can be shown.
        evidenceDisplay(client, record.case_code, { lang: tr.lang }).catch(() => ({ field: null, imageUrl: null })),
    ]);

    const current = appeal || caseAppeals.find((row) => row.status === 'pending') || null;
    const embeds = [createEmbed({
        title: truncate(tr.t(record.is_test ? 'staff.dossier.title.test' : 'staff.dossier.title.case', { code: record.case_code, name: record.name }), 256),
        description: truncate(caseDetailsLines(record, tr.lang).join('\n'), 4096),
        fields: [
            ...(needsSecondReviewer(record, { botUserId: client?.user?.id || null }) ? [{
                name: tr.t('staff.dossier.independent.name'),
                value: truncate(tr.t('staff.dossier.independent.value', { moderator: record.moderator_username }), 1024),
            }] : []),
            ...(evidence.field ? [evidence.field] : []),
        ],
        image: evidence.imageUrl,
        color: 'primary',
    })];

    if (current) {
        embeds.push(createEmbed({
            title: truncate(tr.t('staff.dossier.appeal.title', { status: labels.appealStatus[current.status] || current.status }), 256),
            description: current.channel_id
                ? tr.t('staff.dossier.appeal.filedByIn', { name: current.username, when: stamp(current.created_at), channelId: current.channel_id })
                : tr.t('staff.dossier.appeal.filedBy', { name: current.username, when: stamp(current.created_at) }),
            fields: answerFields(current.body, tr.lang),
            color: 'secondary',
        }));
    }

    const earlier = caseAppeals.filter((row) => row.id !== current?.id);
    const latestAppealByCase = new Map(userAppeals.map((row) => [row.case_code, row.status]));
    const others = otherCases.filter((row) => row.case_code !== record.case_code).slice(0, 15);
    const otherLines = others.map((row) => {
        const appealStatus = latestAppealByCase.get(row.case_code);
        return tr.t('staff.dossier.otherLine', {
            code: row.case_code,
            type: labels.type[row.type] || row.type,
            test: row.is_test ? tr.t('staff.dossier.testSuffix') : '',
            date: dateStamp(row.created_at),
            status: labels.caseStatus[row.status] || row.status,
            appeal: appealStatus ? tr.t('staff.dossier.otherLineAppeal', { status: labels.appealStatus[appealStatus] || appealStatus }) : '',
            reason: truncate(row.reason, 80),
        });
    });
    const moreCount = Math.max(0, total - 1 - others.length);

    embeds.push(createEmbed({
        title: tr.t('staff.dossier.history.title'),
        fields: [
            {
                name: tr.t('staff.dossier.history.earlier'),
                value: truncate(earlier.length ? earlier.map((row) => appealLine(row, tr)).join('\n') : tr.t('staff.dossier.history.none'), 700),
            },
            {
                name: tr.t('staff.dossier.history.others', { count: Math.max(0, total - 1) }),
                value: truncate(otherLines.length
                    ? otherLines.join('\n') + (moreCount ? `\n${tr.t('staff.dossier.history.more', { count: moreCount })}` : '')
                    : tr.t('staff.dossier.history.none'), 700),
            },
            {
                name: tr.t('staff.dossier.history.appealsTotal'),
                value: String(appealCount?.count ?? 0),
                inline: true,
            },
            ...(ladder ? [{ name: tr.t('staff.dossier.history.ladder'), value: tr.t('staff.dossier.history.ladderValue', { level: ladder.level, warns: ladder.warns_since_level }), inline: true }] : []),
        ],
        color: 'secondary',
    }));

    return embeds;
}

const DECISION_BUTTON_ID = 'appealdecide';

/** Accept / Deny under an appeal (each decides it straight away), plus "I'm looking at it" (appealStatusService). */
export function appealDecisionRow(caseCode, { disabled = false, lang = 'en' } = {}) {
    const tr = botText(lang);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${DECISION_BUTTON_ID}:accept:${caseCode}`)
            .setLabel(tr.t('staff.dossier.button.accept')).setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`${DECISION_BUTTON_ID}:deny:${caseCode}`)
            .setLabel(tr.t('staff.dossier.button.deny')).setStyle(ButtonStyle.Danger).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`${DECISION_BUTTON_ID}:claim:${caseCode}`)
            .setLabel(tr.t('staff.dossier.button.claim')).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    );
}

/** Disables the Accept / Deny buttons on the bot's messages in an appeal channel. */
async function disableDecisionButtons(channel, caseCode, lang = 'en') {
    const messages = await channel.messages?.fetch({ limit: 20 }).catch(() => null);
    if (!messages) return;
    for (const message of messages.values()) {
        const hasButtons = message.author?.id === channel.client.user.id
            && message.components.some((row) => row.components?.some((c) => c.customId?.startsWith(`${DECISION_BUTTON_ID}:`)));
        if (hasButtons) {
            await message.edit({ components: [appealDecisionRow(caseCode, { disabled: true, lang })] })
                .catch((error) => logger.warn(`Could not disable appeal buttons in ${channel.id}: ${error.message}`));
        }
    }
}

/** Pending appeals of one server's cases (the main server by default), oldest first, with their case. */
export async function listPendingAppeals(limit = 20, guildId = enforcementConfig.mainGuildId) {
    const { rows } = await query(
        `SELECT a.case_code, a.username, a.user_id, a.channel_id, a.created_at, c.type, c.name, c.is_test,
                c.guild_id, c.moderator_id, c.moderator_username, c.is_auto
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
// Ban and kick appeals get a conversation channel in the support server, because the appellant
// cannot see the main one: they are added to it and see only a member-safe summary (no
// moderator, no evidence, no other cases). The full dossier and Accept / Deny go to an
// admin-only staff channel in the main server's appeals category, like every other appeal, so
// only main-server admins ever see them (owner decision: no private thread in the support
// server, where anyone with Manage Threads could read it). Mute and warn appeals have only the
// staff channel. If the support channel cannot be opened (category not set, appellant not in
// the support server, Discord refuses), the appeal still opens staff-only: never lost.
const SUPPORT_APPEAL_TYPES = new Set(['ban', 'kick']);

/** Shown where the appeal channel would be when another server has no appeals category. */
export const STORE_ONLY_NOTE = 'No appeal channel: this server has no appeals category (or ticket category) set. '
    + 'The appeal is saved; decide it in the dashboard (Appeals), or set an appeals category so new appeals get a channel.';

async function openSupportAppealChannel(client, record, user) {
    if (!SUPPORT_APPEAL_TYPES.has(record.type)) return null;
    // Home-only (multi-server B0b): Mewvo's Support server hosts appeals of Mewvo's own servers
    // only. Another server's ban/kick appeal never opens a channel there; batch 4 adds the
    // per-server choice ("Mewvo support" or "our own server"). supportAppealsCategoryId is
    // therefore always the Support server's own (home) value.
    if (!isHomeGuild(record.guild_id)) return null;
    const supportGuild = client.guilds.cache.get(enforcementConfig.supportGuildId);
    if (!supportGuild) return null;
    const category = await fetchCategory(supportGuild, enforcementConfig.supportAppealsCategoryId);
    if (!category) {
        logger.warn(`Ban/kick appeal ${record.case_code} opens in the main server: no support-server appeals category (APPEALS_CATEGORY_ID / dashboard Support server)`);
        return null;
    }
    const member = await supportGuild.members.fetch({ user: user.id, force: true }).catch(() => null);
    if (!member) {
        logger.warn(`Ban/kick appeal ${record.case_code} opens in the main server: ${user.id} is not in the support server`);
        return null;
    }
    let channel = null;
    try {
        channel = await supportGuild.channels.create({
            name: channelName(`appeal-${record.case_code}`),
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: [
                { id: supportGuild.id, deny: [PermissionFlagsBits.ViewChannel] },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
                        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels,
                    ],
                },
                {
                    id: user.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
                    deny: [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.MentionEveryone],
                },
            ],
            reason: `Appeal ${record.case_code}`,
        });
        return { channel, guildId: supportGuild.id };
    } catch (error) {
        logger.warn(`Ban/kick appeal ${record.case_code} opens in the main server: support channel failed (${error.message})`);
        if (channel) await channel.delete('Appeal channel setup failed').catch(() => {});
        return null;
    }
}

/** A case type (ban, kick, mute, warn) for the member, in a language; anything else as stored. */
function memberCaseType(type, tr) {
    const key = `member.appeal.type.${type}`;
    return tr.has(key) ? tr.t(key) : String(type ?? '');
}

/**
 * The appellant's language in an appeal channel they read: their language role in that channel's
 * server (cached member), else their personal language, else that server's language.
 */
export function appellantLanguage(client, guildId, userId) {
    const member = client?.guilds?.cache?.get?.(guildId)?.members?.cache?.get?.(userId) ?? null;
    return resolveBotLanguage({ guildId, member, userId, purpose: 'dm' });
}

/** What the appellant sees in their support-server appeal channel (in their language). Exported for tests. */
export function memberAppealSummary(record, answers, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const lines = [
        tr.t('member.appeal.channel.caseCode', { code: record.case_code }),
        tr.t('member.appeal.channel.type', { type: memberCaseType(record.type, tr) }),
        tr.t('member.appeal.channel.when', { date: stamp(record.created_at) }),
        tr.t('member.appeal.channel.reason', { reason: truncate(record.reason, 500) }),
    ];
    if (record.type === 'ban') {
        lines.push(record.expires_at ? tr.t('member.appeal.channel.ends', { date: stamp(record.expires_at) }) : tr.t('member.appeal.channel.permanent'));
    }
    return createEmbed({
        title: truncate(tr.t('member.appeal.channel.title', { code: record.case_code }), 256),
        description: truncate(lines.join('\n'), 4096),
        fields: answerFields(answers, tr.lang),
        footer: { text: truncate(tr.t('member.appeal.channel.footer'), 2048) },
        color: 'primary',
    });
}

/**
 * The note in the appellant's channel after a decision (no admin name, no note). English is the
 * text as before. Pure (tests).
 */
export function memberDecisionEmbed({ caseCode, decision, dmDelivered, seconds }, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const accepted = decision === 'accept';
    return createEmbed({
        title: tr.t(accepted ? 'member.appeal.result.acceptedTitle' : 'member.appeal.result.deniedTitle'),
        description: truncate(`${tr.t(accepted ? 'member.appeal.result.accepted' : 'member.appeal.result.denied', { code: caseCode })} `
            + `${tr.t(dmDelivered ? 'member.appeal.result.dm' : 'member.appeal.result.noDm')}\n\n`
            + tr.t('member.appeal.result.deleted', { seconds }), 4096),
        color: accepted ? 'success' : 'error',
    });
}

export async function submitAppeal({ client, user, caseCode, answers, lang = 'en' }) {
    // Any server: the member appeals their own case (assertAppealable checks the user id, with the
    // same "not found" text for unknown and other people's codes), wherever it was issued.
    // `lang`: the member's language for the refusals (the appeal form passes it).
    const record = await getCaseByCodeAnyServer(caseCode);
    return Mutex.runExclusive(`appeal:${caseCode}`, async () => {
        await assertAppealable(record, user.id, { lang });
        // Home cases: the main server, as before. Another server's case: that server only; when it
        // has no appeals (or ticket) category, or the bot is not in it, the appeal is stored
        // without a channel and handled from the dashboard / web form.
        const home = isHomeGuild(record.guild_id);
        const staffGuildId = appealStaffGuildId(record);
        const guild = client.guilds.cache.get(staffGuildId) || null;
        if (home && !guild) throw configError('Main guild unavailable for appeals');
        const storeOnly = !home && !(guild && await getAppealsCategory(guild));

        let appeal;
        try {
            appeal = await withTransaction(async (client) => {
                const { rows } = await client.query(
                    `INSERT INTO ${T.appeals} (kind, case_code, user_id, username, guild_id, body)
                     VALUES ('appeal', $1, $2, $3, $4, $5) RETURNING *`,
                    [record.case_code, user.id, user.username, staffGuildId, JSON.stringify(answers)]
                );
                await client.query(
                    `UPDATE ${T.cases} SET status = 'appeal_pending' WHERE id = $1 AND status = 'active'`,
                    [record.id]
                );
                return rows[0];
            });
        } catch (error) {
            if (isUniqueViolation(error, 'one_pending')) {
                throw userError(botText(lang).t('member.appeal.error.pending'));
            }
            throw error;
        }

        // Staff posts and the log: the staff server's language (purpose 'public').
        const staffTr = textForGuild(staffGuildId, { userId: user.id, purpose: 'public' });
        if (storeOnly) {
            const where = guild ? 'it has no appeals category or ticket category' : 'the bot is not in that server';
            logger.warn(`Appeal ${record.case_code} of guild ${record.guild_id} stored without a channel: ${where}`);
            await logEvent({
                client,
                guildId: staffGuildId,
                eventType: EVENT_TYPES.MODERATION_APPEAL,
                data: {
                    userId: user.id,
                    fields: [
                        { name: staffTr.t('staff.dossier.log.submitted'), value: `\`${record.case_code}\` · ${record.name}` },
                        { name: staffTr.t('staff.dossier.log.user'), value: `${user.username} (${user.id})` },
                        { name: staffTr.t('staff.dossier.log.channel'), value: staffTr.t('staff.dossier.storeOnly') },
                    ],
                },
            }).catch(() => {});
            return { record, channel: null, staffChannel: null, storedOnly: true };
        }

        // Always an admin-only staff channel (the main server for home cases, the case's own server
        // otherwise); ban/kick appeals of home cases also get a conversation channel with the
        // appellant in the support server.
        let channel;
        let staffChannel;
        let channelGuildId;
        let support = null;
        try {
            support = await openSupportAppealChannel(client, record, user);
            staffChannel = await createPrivateChannel(guild, `appeal-${record.case_code}`, `Appeal ${record.case_code}`);
            channel = support?.channel || staffChannel;
            channelGuildId = support?.guildId || guild.id;
        } catch (error) {
            if (support) await support.channel.delete('Appeal staff channel could not be opened').catch(() => {});
            // Undo so the user can try again once the channel can be created.
            await withTransaction(async (client) => {
                await client.query(`DELETE FROM ${T.appeals} WHERE id = $1`, [appeal.id]);
                await client.query(`UPDATE ${T.cases} SET status = 'active' WHERE id = $1 AND status = 'appeal_pending'`, [record.id]);
            }).catch(() => {});
            throw error;
        }
        const inSupport = staffChannel !== channel;

        // channel_id: where the appellant is (support) or the staff channel; staff_channel_id: the
        // main-server staff channel when the two differ.
        await query(`UPDATE ${T.appeals} SET channel_id = $2, channel_guild_id = $3, staff_channel_id = $4 WHERE id = $1`,
            [appeal.id, channel.id, channelGuildId, inSupport ? staffChannel.id : null]);
        if (inSupport) {
            // The appellant reads this channel: their language there (role, personal, server).
            const memberLang = appellantLanguage(client, channelGuildId, user.id);
            await channel.send({
                content: botText(memberLang).t('member.appeal.channel.received', { userId: user.id }),
                embeds: [memberAppealSummary(record, answers, { lang: memberLang })],
                allowedMentions: { users: [user.id] },
            });
        }

        const pendingRecord = { ...record, status: record.status === 'active' ? 'appeal_pending' : record.status };
        const embeds = await buildCaseDossier(pendingRecord, { appeal: { ...appeal, channel_id: channel.id }, client, lang: staffTr.lang })
            .catch((error) => {
                logger.warn(`Could not build the case summary for appeal ${record.case_code}: ${error.message}`);
                return [createEmbed({
                    title: truncate(staffTr.t('staff.dossier.title.fallback', { name: record.name }), 256),
                    description: truncate(caseDetailsLines(pendingRecord, staffTr.lang).join('\n'), 4096),
                    fields: answerFields(answers, staffTr.lang),
                    color: 'primary',
                })];
            });
        await staffChannel.send({
            // /appeals works in every server (B2 global commands), each for its own cases.
            content: staffTr.t('staff.dossier.newAppeal', { username: user.username, code: record.case_code })
                + (inSupport ? staffTr.t('staff.dossier.newAppealSupport', { channelId: channel.id }) : ''),
            embeds,
            components: [appealDecisionRow(record.case_code, { lang: staffTr.lang })],
            allowedMentions: { parse: [] },
        });

        await logEvent({
            client,
            guildId: staffGuildId,
            eventType: EVENT_TYPES.MODERATION_APPEAL,
            data: {
                userId: user.id,
                fields: [
                    { name: staffTr.t('staff.dossier.log.submitted'), value: `\`${record.case_code}\` · ${record.name}` },
                    { name: staffTr.t('staff.dossier.log.user'), value: `${user.username} (${user.id})` },
                    { name: staffTr.t('staff.dossier.log.channel'), value: `<#${staffChannel.id}>${inSupport ? staffTr.t('staff.dossier.log.supportConversation', { channelId: channel.id }) : ''}` },
                ],
            },
        }).catch(() => {});

        return { record, channel, staffChannel };
    });
}

const MAX_REPORTS_PER_DAY = 3;

/** Each report opens a channel, so cap them per server: one open at a time, three a day. */
async function assertCanReport(guild, userId, lang = 'en') {
    const tr = botText(lang);
    const { rows } = await query(
        `SELECT channel_id, created_at > NOW() - INTERVAL '1 day' AS today FROM ${T.appeals}
         WHERE kind = 'report' AND user_id = $1 AND guild_id = $2`,
        [userId, guild.id]
    );
    if (rows.filter((row) => row.today).length >= MAX_REPORTS_PER_DAY) {
        throw userError(tr.t('member.appeal.error.reportsToday'));
    }
    const open = rows.find((row) => row.channel_id && guild.channels.cache.has(row.channel_id));
    if (open) throw userError(tr.t('member.appeal.error.reportOpen'));
}

/** Shown when a server without any category for reports gets one. */
export const REPORTS_NOT_SET_UP = 'Staff reports are not set up in this server yet: it has no reports, ticket or appeals category. '
    + 'Ask an administrator to set one up (for example with /ticket), then try again. Nothing was sent.';

/**
 * The server a staff report is filed in: Mewvo's two servers file into the main server (as
 * before: the report button sits in the support server); any other server into itself.
 */
export function reportGuildId(guildId) {
    return !guildId || isHomeGuild(guildId) ? enforcementConfig.mainGuildId : guildId;
}

/**
 * Files a staff report from the panel in `guildId` (the server the member pressed the button
 * in; default: the main server). Its channel opens in that server's reports category (else its
 * ticket, else its appeals category); a server without one gets REPORTS_NOT_SET_UP.
 */
export async function submitStaffReport({ client, user, staffMember, details, proof, guildId = null, lang = 'en' }) {
    const targetId = reportGuildId(guildId);
    const home = isHomeGuild(targetId);
    const guild = client.guilds.cache.get(targetId);
    if (!guild) {
        if (home) throw configError('Main guild unavailable for staff reports');
        throw userError(botText(lang).t('member.appeal.error.serverUnavailable'));
    }
    if (!home && !(await getReportsCategory(guild))) throw userError(REPORTS_NOT_SET_UP);
    // One submission per member and server at a time: two forms sent at once must not both pass
    // the "one open report" check (the new row only counts as open once its channel exists).
    return Mutex.runExclusive(`report:${guild.id}:${user.id}`, () => openStaffReport({ client, guild, user, staffMember, details, proof, lang }));
}

async function openStaffReport({ client, guild, user, staffMember, details, proof, lang = 'en' }) {
    await assertCanReport(guild, user.id, lang);
    // Reports count toward the open-channel cap (with modmail); appeals never do.
    const slot = await withOpenChannelSlot(guild, 'staff report', async () => {
        const { rows } = await query(
            `INSERT INTO ${T.appeals} (kind, user_id, username, guild_id, body)
             VALUES ('report', $1, $2, $3, $4) RETURNING *`,
            [user.id, user.username, guild.id, JSON.stringify({ staffMember, details, proof })]
        );
        const created = rows[0];
        try {
            const opened = await createPrivateChannel(guild, `report-${user.username}`, 'Staff report', getReportsCategory);
            await query(`UPDATE ${T.appeals} SET channel_id = $2 WHERE id = $1`, [created.id, opened.id]);
            return { report: created, channel: opened };
        } catch (error) {
            await query(`DELETE FROM ${T.appeals} WHERE id = $1`, [created.id]).catch(() => {});
            throw error;
        }
    });
    if (slot.refused) throw userError(slot.refused);
    const { report, channel } = slot;

    // The admin-only report channel and the log: the server's language.
    const tr = textForGuild(guild.id, { userId: user.id, purpose: 'public' });
    await channel.send({
        embeds: [createEmbed({
            title: tr.t('staff.dossier.report.title'),
            description: truncate([
                tr.t('staff.dossier.report.reportedBy', { username: user.username, userId: user.id }),
                tr.t('staff.dossier.report.staffMember', { name: staffMember }),
                tr.t('staff.dossier.report.filed', { date: dateStamp(new Date()) }),
            ].join('\n'), 4096),
            fields: [
                { name: tr.t('staff.dossier.report.whatHappened'), value: truncate(details, 1024) },
                { name: tr.t('staff.dossier.report.proof'), value: truncate(proof || tr.t('staff.dossier.report.proofNone'), 1024) },
            ],
            footer: { text: tr.t('staff.dossier.report.footer', { id: report.id }) },
            color: 'error',
        })],
        allowedMentions: { parse: [] },
    });

    await logEvent({
        client,
        guildId: guild.id,
        eventType: EVENT_TYPES.MODERATION_STAFF_REPORT,
        data: {
            userId: user.id,
            fields: [
                { name: tr.t('staff.dossier.report.title'), value: tr.t('staff.dossier.report.logValue', { id: report.id, name: truncate(staffMember, 200) }) },
                { name: tr.t('staff.dossier.report.reporter'), value: `${user.username} (${user.id})` },
                { name: tr.t('staff.dossier.log.channel'), value: `<#${channel.id}>` },
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
 * the logs. Returns notes for the decision message, in `lang` (default English); with
 * `entries: true` the notes come back as [{ key, params }] for liftNoteText (one decision can
 * show them in two languages: the staff channel's and the deciding admin's). The mod-log
 * entries are in the server's language.
 */
export async function liftCase(client, record, admin, { reason, via, lang = 'en', entries = false }) {
    const found = await liftCaseEntries(client, record, admin, { reason, via });
    return entries ? found : found.map((entry) => liftNoteText(entry, lang));
}

/** One note from liftCase({ entries: true }) as text in `lang`. */
export function liftNoteText({ key, params }, lang = 'en') {
    const tr = botText(lang);
    const notes = {
        unbanned: () => tr.t('staff.dossier.lift.unbanned'),
        unmuted: () => tr.t('staff.dossier.lift.unmuted'),
        warnRemoved: () => tr.t('staff.dossier.lift.warnRemoved'),
        triggerRemoved: () => tr.t('staff.dossier.lift.triggerRemoved', params),
        ladderBanLifted: () => tr.t('staff.dossier.lift.ladderBanLifted', params),
    };
    return notes[key]();
}

async function liftCaseEntries(client, record, admin, { reason, via }) {
    const mainGuild = client.guilds.cache.get(record.guild_id);
    const notes = [];
    // The mod-log entries below: the server's language.
    const logTr = textForGuild(record.guild_id, { userId: record.target_user_id, purpose: 'public' });

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
        if (!mainGuild) throw createError('Main guild unavailable', ErrorTypes.CONFIGURATION, isHomeGuild(record.guild_id) ? 'I cannot reach the main server to unban.' : 'I cannot reach this server to unban.');
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
        // The ban's own created_at from the row, not the JS Date: a Date keeps milliseconds only, and
        // the trigger warn shares the ban's transaction timestamp (microseconds), so `<= Date` missed it.
        const { rows: [warn] } = await db.query(
            `UPDATE ${T.cases} SET status = 'revoked', revoked_by = $1, revoked_at = NOW(), revoke_reason = $2
             WHERE id = (
                 SELECT id FROM ${T.cases}
                 WHERE guild_id = $3 AND target_user_id = $4 AND type = 'warn' AND status = ANY($5)
                   AND is_test = FALSE AND ladder_level_after = $6 AND counts_toward_level = $7
                   AND created_at <= (SELECT created_at FROM ${T.cases} WHERE id = $8)
                 ORDER BY created_at DESC LIMIT 1
             )
             RETURNING *`,
            [admin.id, `${reason} (ban ${record.case_code})`, record.guild_id, record.target_user_id,
                OPEN_STATUSES, record.ladder_level_after, previousLevel, record.id]
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

    // 'Reason' stays the English field name: formatModLogLine (channelRouting.js) picks it by name and
    // shows it as “…” on the one-line mod log entry.
    const extra = [{ name: 'Reason', value: reason }];
    const liftedName = logTr.t('staff.dossier.lift.liftedCases');
    if (liftedBan) {
        await logEnforcement(client, record.guild_id, 'unban', { target, moderatorLabel, extra: [...extra, { name: liftedName, value: `\`${record.case_code}\`` }] });
        notes.push({ key: 'unbanned' });
    }
    if (liftedMute) {
        await logEnforcement(client, record.guild_id, 'unmute', { target, moderatorLabel, extra: [...extra, { name: liftedName, value: `\`${record.case_code}\`` }] });
        notes.push({ key: 'unmuted' });
    }
    if (record.type === 'warn') {
        const ladder = await getLadder(record.guild_id, record.target_user_id).catch(() => null);
        await logEnforcement(client, record.guild_id, 'removewarn', {
            target, moderatorLabel,
            extra: [
                { name: logTr.t('staff.dossier.lift.warning'), value: `\`${record.case_code}\` · ${record.name}` },
                ...extra,
                ...(ladder ? [{ name: logTr.t('staff.dossier.lift.countedNow'), value: `${ladder.warns_since_level} (${ladderStageIn(ladder.level, logTr.lang)})` }] : []),
            ],
        });
        notes.push({ key: 'warnRemoved' });
    }
    if (triggerWarn) {
        await logEnforcement(client, record.guild_id, 'removewarn', {
            target, moderatorLabel,
            extra: [
                { name: logTr.t('staff.dossier.lift.warning'), value: `\`${triggerWarn.case_code}\` · ${triggerWarn.name}` },
                { name: 'Reason', value: logTr.t('staff.dossier.lift.triggerReason', { reason, code: record.case_code }) },
            ],
        });
        notes.push({ key: 'triggerRemoved', params: { code: triggerWarn.case_code } });
    }
    if (ladderBan) {
        await logEnforcement(client, record.guild_id, 'unban', {
            target, moderatorLabel,
            extra: [...extra, { name: liftedName, value: logTr.t('staff.dossier.lift.ladderLiftedCase', { code: ladderBan.case_code }) }],
        });
        notes.push({ key: 'ladderBanLifted', params: { code: ladderBan.case_code } });
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

/**
 * Independent appeal review: throws the "another staff member has to decide" error when
 * `deciderId` issued the case and the setting is on. Returns { ownerOverride } (true when a
 * bot owner decides their own case anyway). Every decision path goes through decideAppeal,
 * which calls this; the dashboard also calls it before its confirm step.
 */
export function assertAppealReviewer(record, deciderId, { client = null, ...options } = {}) {
    const check = checkAppealReviewer(record, deciderId, { botUserId: client?.user?.id || null, ...options });
    if (!check.allowed) throw userError(check.message);
    return { ownerOverride: Boolean(check.ownerOverride) };
}

/**
 * `callerGuildId` (required): the server the decision is made from (the slash command's or
 * button's guild, the dashboard's server). Another server's case is refused before anything is
 * read or changed, so no server can lift a punishment of another one.
 * `lang`: the deciding admin's language for the refusals and the returned notes (the slash
 * command and the buttons pass it; the dashboard keeps English). Staff-channel posts use the
 * server's language.
 */
export async function decideAppeal({ client, admin, caseCode, decision, note, via = 'unknown', callerGuildId, lang = 'en' }) {
    if (!callerGuildId) throw new Error('decideAppeal: callerGuildId is required');
    const tr = botText(lang);
    // Another server's case reads as unknown (nothing about it is shown or changed).
    const record = await getCaseByCode(caseCode, callerGuildId);
    if (!record) {
        throw userError(tr.t('staff.appeals.unknownCase', { code: caseCode }));
    }
    if (!isCaseOfCallerServer(record, callerGuildId)) throw userError(tr.t('staff.appeals.otherServer'));
    // Before anything changes: the issuing moderator may not decide (when the setting is on).
    const check = checkAppealReviewer(record, admin.id, { botUserId: client?.user?.id || null });
    if (!check.allowed) throw userError(check.message === SECOND_REVIEWER_MESSAGE ? tr.t('staff.appeals.secondReviewer') : check.message);
    const ownerOverride = Boolean(check.ownerOverride);

    const result = await decideAppealLocked({ client, admin, caseCode, decision, note, record, lang: tr.lang });
    if (ownerOverride) {
        await recordOwnerOverride({
            client, guildId: record.guild_id, userId: admin.id, username: admin.username,
            action: `appeal ${result.label} on \`${record.case_code}\``, via,
            reason: 'who issued this punishment themselves (independent appeal review is on)',
        }).catch(() => {});
    }
    return { ...result, ownerOverride };
}

async function decideAppealLocked({ client, admin, caseCode, decision, note, record, lang = 'en' }) {
    return Mutex.runExclusive(`enforcement:${record.guild_id}:${record.target_user_id}`, async () => {
        const { rows } = await query(
            `SELECT * FROM ${T.appeals} WHERE case_code = $1 AND kind = 'appeal' AND status = 'pending'
             ORDER BY created_at DESC LIMIT 1`,
            [caseCode]
        );
        const appeal = rows[0];
        if (!appeal) {
            throw userError(botText(lang).t('staff.appeals.noPending', { code: caseCode }));
        }

        const mainGuild = client.guilds.cache.get(record.guild_id);
        const appellant = await client.users.fetch(record.target_user_id).catch(() => null);
        let dmDelivered = false;
        let noteEntries = [];

        if (decision === 'accept') {
            noteEntries = await liftCase(client, record, admin, {
                reason: `Appeal accepted by ${admin.username}`,
                via: `appeal \`${record.case_code}\``,
                entries: true,
            });
            const invite = mainGuild ? await createRejoinInvite(mainGuild, `Appeal accepted for ${caseCode}`) : null;
            // Another server's DM names that server and the case; without an invite it never points to Mewvo Support.
            if (appellant) {
                dmDelivered = await sendCaseDm(appellant, 'enf.appealAccepted', record, {
                    guild: mainGuild ?? null, guildId: record.guild_id, adminUsername: admin.username, invite,
                });
            }
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
            if (appellant) dmDelivered = await sendCaseDm(appellant, 'enf.appealDenied', null, { guild: mainGuild ?? null, guildId: record.guild_id });
        }

        await query(
            `UPDATE ${T.appeals} SET status = $2, decided_by = $3, decided_by_username = $4, decided_at = NOW(), note = $5
             WHERE id = $1`,
            [appeal.id, decision === 'accept' ? 'accepted' : 'denied', admin.id, admin.username, note || null]
        );

        const label = decision === 'accept' ? 'accepted' : 'denied';
        // channel: where the appellant talks (support server for ban/kick; else the staff channel).
        // staffChannel: the admin-only main-server channel with the dossier and buttons.
        const fetchIn = async (guildId, id) => {
            const g = client.guilds.cache.get(guildId);
            return id && g ? g.channels.cache.get(id) || await g.channels.fetch(id).catch(() => null) : null;
        };
        const channel = await fetchIn(appeal.channel_guild_id || appeal.guild_id, appeal.channel_id);
        const separateStaff = Boolean(appeal.staff_channel_id);
        const staffChannel = separateStaff ? await fetchIn(appeal.guild_id, appeal.staff_channel_id) : channel;
        if (separateStaff && channel) {
            // The appellant reads the channel: no admin name, no note, no internal notes; their language.
            const memberLang = appellantLanguage(client, channel.guildId ?? appeal.channel_guild_id, record.target_user_id);
            await channel.send({
                embeds: [memberDecisionEmbed({ caseCode: record.case_code, decision, dmDelivered, seconds: APPEAL_CHANNEL_DELETE_DELAY_MS / 1000 }, { lang: memberLang })],
                allowedMentions: { parse: [] },
            }).catch(() => {});
        }
        // The staff channel and the logs: the staff server's language.
        const staffTr = textForGuild(appealStaffGuildId(record), { userId: record.target_user_id, purpose: 'public' });
        const decidedTitle = staffTr.t(decision === 'accept' ? 'staff.dossier.decision.accepted' : 'staff.dossier.decision.denied');
        const seconds = APPEAL_CHANNEL_DELETE_DELAY_MS / 1000;
        await staffChannel?.send({
            embeds: [createEmbed({
                title: decidedTitle,
                description: truncate([
                    staffTr.t('staff.dossier.decision.by', { name: admin.username }),
                    note ? staffTr.t('staff.dossier.decision.note', { note }) : null,
                    staffTr.t(dmDelivered ? 'staff.dossier.decision.dmDelivered' : 'staff.dossier.decision.dmNotDelivered'),
                    decision === 'deny' && record.is_auto && record.ladder_level_after === 3 ? staffTr.t('staff.dossier.decision.stage3') : null,
                    ...noteEntries.map((entry) => liftNoteText(entry, staffTr.lang)),
                    '',
                    isHomeGuild(record.guild_id)
                        ? staffTr.t('staff.dossier.decision.deletedStays', { seconds, code: record.case_code })
                        : staffTr.t('staff.dossier.decision.deleted', { seconds }),
                ].filter((line) => line !== null).join('\n'), 4096),
                color: decision === 'accept' ? 'success' : 'error',
            })],
            allowedMentions: { parse: [] },
        }).catch(() => {});
        if (staffChannel) await disableDecisionButtons(staffChannel, caseCode, staffTr.lang);

        // The channels are deleted shortly; keep what was said in them.
        const transcript = channel ? await generateTranscript(channel).catch(() => null) : null;
        const staffTranscript = separateStaff && staffChannel ? await generateTranscript(staffChannel).catch(() => null) : null;
        const logFields = [
            { name: decidedTitle, value: `\`${record.case_code}\` · ${record.name}` },
            { name: staffTr.t('staff.dossier.log.user'), value: `${record.target_username} (${record.target_user_id})` },
            { name: staffTr.t('staff.dossier.log.decidedBy'), value: `${admin.username} (${admin.id})` },
            ...(note ? [{ name: staffTr.t('staff.dossier.log.note'), value: truncate(note, 1024) }] : []),
        ];
        await logEvent({
            client,
            guildId: record.guild_id,
            eventType: EVENT_TYPES.MODERATION_APPEAL,
            data: { userId: record.target_user_id, fields: logFields },
        }).catch(() => {});
        if (!record.is_test || transcript) {
            await postModLog(client, 'appeal', logFields, {
                title: record.is_test ? staffTr.t('staff.dossier.decision.testTitle', { title: decidedTitle }) : decidedTitle,
                // The main server for home cases (as before), the case's own server otherwise.
                guildId: appealStaffGuildId(record),
                files: [
                    ...(transcript ? [new AttachmentBuilder(transcript.buffer, { name: `appeal-${record.case_code}.html` })] : []),
                    ...(staffTranscript ? [new AttachmentBuilder(staffTranscript.buffer, { name: `appeal-${record.case_code}-staff.html` })] : []),
                ],
            });
        }

        if (channel) scheduleAppealChannelDelete(channel, label);
        if (separateStaff && staffChannel) scheduleAppealChannelDelete(staffChannel, label);
        return { record, dmDelivered, label, notes: noteEntries.map((entry) => liftNoteText(entry, lang)) };
    });
}
