// automodContest.js — "Contest this" on automod DMs.
//
// When automod deletes a member's message and punishes them, the DM carries a
// "Contest this" button (dmTemplates.contestComponents). Pressing it opens a short
// modal ("Why was this OK?"); submitting it marks the matching review card with a
// "🙋 Member disputes" field and raises it to a full card, so staff decide with the
// existing Keep / Undo buttons. When no open card is found (restart, card already
// kept), a new line "🙋 Member disputes · case X" with Keep / Undo is posted in the
// review channel instead.
//
//   amcontest:open:<code>     button in the DM: checks and opens the modal
//   amcontest:submit:<code>   the modal
//
// One contest per case: the key-value store keeps automod:contest:<code> for 30 days.
// When staff undo a contested case, the deleted message is reposted in its channel as
// "Restored message from @user: …" (mentions disabled) if the card still has its text
// (cards live in memory, so not after a restart). The undo itself already feeds the
// self-tuning counts (revoke_reason "Automod decision reversed…").

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import { AUTOMOD_RULES } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { Mutex } from '../../utils/mutex.js';
import { truncate } from '../enforcement/format.js';
import { fetchStaffChannel } from './channelRouting.js';
import { buildCardPayload } from './reviewFormat.js';
import { findCardByCase, findCardForMember } from './reviewRegistry.js';

export const CONTEST_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CONTEST_MAX_CHARS = 500;
export const CONTEST_MIN_CHARS = 3;

export const contestKey = (caseCode) => `automod:contest:${caseCode}`;

const ATTACHMENT_SUFFIX = /\s*\[\d+ attachment\(s\)\]$/;

/**
 * Pure: may this user contest this case? Returns { ok: true } or { ok: false, message }.
 * Only the member the case is against, only automod cases in the main server, and
 * only while the case still stands.
 */
export function checkContestTarget(record, userId, mainGuildId = enforcementConfig.mainGuildId) {
    if (!record || (mainGuildId && record.guild_id !== mainGuildId)) {
        return { ok: false, message: 'That case no longer exists.' };
    }
    if (String(record.target_user_id) !== String(userId)) {
        return { ok: false, message: 'Only the member this decision was about can contest it.' };
    }
    if (!String(record.reason_key || '').startsWith('automod:')) {
        return { ok: false, message: 'Only automatic decisions can be contested here. Use the appeal form instead.' };
    }
    if (record.voided_at || record.status === 'revoked') {
        return { ok: false, message: 'This decision was already reversed.' };
    }
    return { ok: true };
}

/** Pure: the member's reason, trimmed and cut to CONTEST_MAX_CHARS. */
export function cleanContestReason(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, CONTEST_MAX_CHARS);
}

/** Pure: the automod group of a case ("automod:spam" → "spam"). */
export function caseGroup(record) {
    const key = String(record?.reason_key || '');
    return key.startsWith('automod:') ? key.slice('automod:'.length) : null;
}

/**
 * Pure: the review-channel line when no open card could be marked:
 * "🙋 **Member disputes** · case `abc12` · <@1> · Automod: Spam\n> their reason".
 */
export function contestLine(record, reason, cardUrl = null) {
    const quoted = escapeMarkdown(cleanContestReason(reason)).split('\n').map((line) => `> ${line}`).join('\n');
    const head = [
        '🙋 **Member disputes**',
        `case \`${record.case_code}\``,
        `<@${record.target_user_id}>`,
        record.type ? record.type : null,
        record.reason ? truncate(escapeMarkdown(String(record.reason)), 120) : null,
        cardUrl ? `[original card](${cardUrl})` : null,
    ].filter(Boolean).join(' · ');
    return truncate(`${head}\n${quoted}`, 2000);
}

/** Keep / Undo for a contested case on the fallback line (handled by amreview:…). */
export function contestLineComponents(caseCode) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`amreview:keep:${caseCode}`).setLabel('Keep').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`amreview:undo:${caseCode}`).setLabel('Undo').setStyle(ButtonStyle.Danger),
    )];
}

/**
 * Pure: the repost of a deleted message after a contested case is undone, or null
 * when there is no text to restore. The text is quoted; mentions are disabled by the
 * caller (allowedMentions: { parse: [] }).
 */
export function restoredMessageText(userId, content) {
    const text = String(content ?? '').replace(ATTACHMENT_SUFFIX, '').trim();
    if (!text) return null;
    const quoted = text.split('\n').map((line) => `> ${line}`).join('\n');
    return truncate(`↩️ Restored message from <@${userId}> (a moderator reversed the automatic deletion):\n${quoted}`, 2000);
}

/** The card for a case: by its code, else by guild + member + rule group around the case time. */
export function findCardForCase(record) {
    return findCardByCase(record.case_code) || findCardForMember({
        guildId: record.guild_id,
        userId: record.target_user_id,
        group: caseGroup(record),
        at: record.created_at ? new Date(record.created_at).getTime() : null,
        ruleGroup: (rule) => AUTOMOD_RULES[rule]?.group,
    });
}

/**
 * Marks the review card for a contested case: adds the field and raises it to a full
 * card while it is still open; otherwise posts a new line with Keep / Undo.
 * Returns 'card' | 'line' | 'none'.
 */
export async function markReviewCard(client, record, contest) {
    const entry = findCardForCase(record);
    if (entry?.open && entry.message) {
        entry.contest = contest;
        entry.tier = 'full';
        const edited = await entry.message.edit({ ...buildCardPayload(entry), allowedMentions: { parse: [] } })
            .then(() => true)
            .catch((error) => {
                logger.warn(`Could not mark review card ${entry.messageId} as contested: ${error.message}`);
                return false;
            });
        if (edited) return 'card';
    }
    const channel = await fetchStaffChannel(client, 'review');
    if (!channel) {
        logger.warn(`Automod contest for ${record.case_code} not posted (no review channel)`);
        return 'none';
    }
    const sent = await channel.send({
        content: contestLine(record, contest.reason, entry?.url || null),
        components: contestLineComponents(record.case_code),
        allowedMentions: { parse: [] },
    }).catch((error) => {
        logger.warn(`Automod contest line for ${record.case_code} failed: ${error.message}`);
        return null;
    });
    return sent ? 'line' : 'none';
}

/** The stored contest for a case, or null. Throws on a database error. */
export async function getContest(caseCode) {
    return getFromDb(contestKey(caseCode), null);
}

/**
 * Records a contest (once per case, serialized per case) and marks the review card.
 * Returns { ok: true, marked } or { ok: false, message } when one already exists.
 * Throws on a database error.
 */
export async function recordContest(client, record, userId, reason, now = Date.now()) {
    return Mutex.runExclusive(`amcontest:${record.case_code}`, async () => {
        if (await getContest(record.case_code)) {
            return { ok: false, message: 'You already contested this decision. The moderators will look at it.' };
        }
        const contest = { caseCode: record.case_code, userId, reason: cleanContestReason(reason), at: now };
        await setInDb(contestKey(record.case_code), contest, CONTEST_TTL_SECONDS);
        const marked = await markReviewCard(client, record, contest);
        logger.info(`Automod case ${record.case_code} contested by ${userId} (${marked})`);
        return { ok: true, marked };
    });
}

/**
 * After staff undo a case: when it was contested and the card still has the deleted
 * message's text, reposts it in the original channel. Returns a note for the moderator,
 * or null. Never throws.
 */
export async function restoreIfContested(client, record) {
    try {
        const contest = await getContest(record.case_code);
        if (!contest) return null;
        const entry = findCardByCase(record.case_code);
        const action = entry?.actions?.find((a) => a.caseCode === record.case_code);
        const text = action?.deleted ? restoredMessageText(record.target_user_id, action.content) : null;
        if (!text || !action.channelId) return 'The member had contested it; the message text is no longer available to restore.';
        const guild = client.guilds.cache.get(record.guild_id);
        const channel = guild
            ? guild.channels.cache.get(action.channelId) || await guild.channels.fetch(action.channelId).catch(() => null)
            : null;
        if (!channel?.isTextBased?.()) return 'The member had contested it; the original channel is gone, so the message was not restored.';
        const sent = await channel.send({ content: text, allowedMentions: { parse: [] } }).catch((error) => {
            logger.warn(`Restoring contested message ${record.case_code} failed: ${error.message}`);
            return null;
        });
        return sent ? `Contested message restored in <#${channel.id}>.` : 'The member had contested it; restoring the message failed.';
    } catch (error) {
        logger.warn(`Contest restore check for ${record.case_code} failed: ${error.message}`);
        return null;
    }
}
