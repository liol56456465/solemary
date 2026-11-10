// dmRenderers.js — the bot DMs that can be rendered again in another language (schema v13,
// bot_dm_log). One renderer per template key: render(params, lang) → the message payload
// ({ content } or { embeds[, components] }). sendLoggedDm (dmLog.js) sends the first rendering
// and stores key + params; a language change (dmRelang.js) renders the same params in the new
// language and edits the DM in place.
//
// Only our own text is re-rendered. Text staff or a member wrote (a reason, a note, a suggestion,
// a gift message) is a param and comes back exactly as the first DM showed it. Params hold only
// what that DM showed; nothing else about the member.
//
// Keys and where they are sent from:
//   enf.ban / enf.kick / enf.mute / enf.warn          enforcementService.js (the punishment DMs)
//   enf.banEnded / enf.muteEnded                      enforcementService.js notifyPunishmentEnded
//   enf.appealAccepted / enf.appealDenied             appealService.js
//   enf.caseVoided                                    caseEditService.js (/case remove)
//   ticket.closed / ticket.feedback / ticket.transcript  services/ticket.js (ticket.feedback also
//                                                     modmailService.js, kind 'modmail'; on close the
//                                                     transcript rides on ticket.closed, transcript: true)
//   giveaway.won                                      giveawayService.js (winner DMs)
//   application.result                                applicationReviewService.js
//   verification.approved / verification.denied       handlers/verificationReview.js
//   suggestion.status                                 community/suggestionService.js
//   premium.gift                                      commands/Core/premium.js
//
// Callers with many imports of their own (suggestions, premium) are loaded lazily, so this module
// never forms an import cycle with them.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
    appealAcceptedDm, appealDeniedDm, banDm, banEndedDm, caseVoidedDm, kickDm, muteDm, muteEndedDm, warnDm, contestComponents } from '../enforcement/dmTemplates.js';
import { botText } from '../../utils/botText.js';
import { createEmbed } from '../../utils/embeds.js';
import { getApplicationStatusColor } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';

/** The case fields the punishment DMs read (dmTemplates.js); the rest of the row is not stored. */
const CASE_FIELDS = [
    'guild_id', 'guild_name', 'type', 'case_code', 'moderator_username', 'reason', 'reason_key',
    'created_at', 'expires_at', 'duration_ms', 'is_auto', 'unappealable', 'ladder_level_after', 'appeal_deadline',
];

/** A case row cut down to what its DM shows (dates as ISO strings: JSON). Null stays null. */
export function caseParams(record) {
    if (!record) return null;
    const out = {};
    for (const field of CASE_FIELDS) {
        const value = record[field];
        if (value === undefined || value === null) continue;
        out[field] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
}

/**
 * " in **Server**" for a ticket DM (audit 4.5: the DM names the server it is about); '' for a DM
 * logged before serverName was stored, or the survey posted in the ticket channel itself.
 * `serverName` is stored already made safe (dmTemplates.safeServerName).
 */
const whereOf = (tr, p) => (p.serverName ? tr.t('ticket.dm.inServer', { server: p.serverName }) : '');

const opts = (p, lang, extra = {}) => ({ guildId: p.guildId ?? undefined, serverName: p.serverName ?? undefined, lang, ...extra });

/** The feedback survey's buttons (ticket.js sends them; the handlers read these customIds). */
export function ticketFeedbackRows(tr, guildId, channelId) {
    const base = `ticket_feedback:${guildId}:${channelId}`;
    const starsRow = new ActionRowBuilder().addComponents(
        [1, 2, 3, 4, 5].map((n) => new ButtonBuilder().setCustomId(`${base}:${n}`).setLabel(String(n))
            .setStyle(n === 5 ? ButtonStyle.Primary : ButtonStyle.Secondary)),
    );
    const declineRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_feedback_comment:${guildId}:${channelId}`)
            .setLabel(tr.t('ticket.dm.feedbackComment')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`ticket_feedback_decline:${guildId}:${channelId}`)
            .setLabel(tr.t('ticket.dm.feedbackDecline')).setStyle(ButtonStyle.Secondary),
    );
    return [starsRow, declineRow];
}

/**
 * key → { render(params, lang), stillCurrent?(message) }. stillCurrent: false when the DM has
 * moved on since it was sent (the feedback survey after an answer: its buttons are gone) and
 * must not be put back.
 */
/** The automod "Contest this" button under a punishment DM, in the DM's language (contestCode in params). */
function withContest(payload, p, lang) {
    return p?.contestCode ? { ...payload, components: contestComponents(p.contestCode, { lang }) } : payload;
}

export const DM_RENDERERS = Object.freeze({
    'enf.ban': { render: (p, lang) => withContest({ content: banDm(p.rec, opts(p, lang)) }, p, lang) },
    'enf.kick': { render: (p, lang) => withContest({ content: kickDm(p.rec, p.invite ?? null, opts(p, lang)) }, p, lang) },
    'enf.mute': { render: (p, lang) => withContest({ content: muteDm(p.rec, opts(p, lang)) }, p, lang) },
    'enf.warn': { render: (p, lang) => withContest({ content: warnDm(p.rec, p.warnNumber, opts(p, lang)) }, p, lang) },
    'enf.banEnded': { render: (p, lang) => ({ content: banEndedDm(p.rec ?? null, p.invite ?? null, opts(p, lang, { early: Boolean(p.early) })) }) },
    'enf.muteEnded': { render: (p, lang) => ({ content: muteEndedDm(p.rec ?? null, opts(p, lang, { early: Boolean(p.early) })) }) },
    'enf.appealAccepted': { render: (p, lang) => ({ content: appealAcceptedDm(p.adminUsername, p.invite ?? null, opts(p, lang, { rec: p.rec ?? null })) }) },
    'enf.appealDenied': { render: (p, lang) => ({ content: appealDeniedDm({ guildId: p.guildId ?? undefined, lang }) }) },
    'enf.caseVoided': { render: (p, lang) => ({ content: caseVoidedDm(p.rec, p.reason, p.invite ?? null, opts(p, lang)) }) },

    'ticket.closed': {
        render: (p, lang) => {
            const tr = botText(lang);
            return { embeds: [createEmbed({
                title: tr.t('ticket.dm.closedTitle'),
                // transcript: the closure DM carries the transcript file (one DM instead of two, audit 4.5).
                description: tr.t('ticket.dm.closedBody', { channel: p.channelName, where: whereOf(tr, p), reason: p.reason, closer: p.closer, time: p.time })
                    + (p.transcript ? `\n\n${tr.t('ticket.dm.transcriptAttached')}` : ''),
                color: '#e74c3c',
                footer: { text: tr.t('ticket.post.ticketId', { id: p.ticketId }) },
            })] };
        },
    },
    'ticket.feedback': {
        render: (p, lang) => {
            const tr = botText(lang);
            return {
                embeds: [createEmbed({
                    title: tr.t('ticket.dm.feedbackTitle'),
                    // kind 'modmail': a closed modmail conversation (modmailService.js), same buttons.
                    description: p.kind === 'modmail'
                        ? tr.t('ticket.dm.modmailFeedbackBody')
                        : tr.t('ticket.dm.feedbackBody', { channel: p.channelName, where: whereOf(tr, p) }),
                    color: '#F1C40F',
                    footer: { text: tr.t('ticket.dm.feedbackFooter') },
                })],
                components: ticketFeedbackRows(tr, p.guildId, p.channelId),
            };
        },
        // Answered or declined: the handlers replaced the survey and removed its buttons. Rated with
        // only "Add a comment" left (ticketRatingService.js): moved on too, the stars must not come back.
        stillCurrent: (message) => Array.isArray(message?.components) && message.components.length > 0
            && !message.components.every((row) => Array.isArray(row?.components) && row.components.length > 0
                && row.components.every((c) => String(c?.customId ?? c?.custom_id ?? '').startsWith('ticket_feedback_comment:'))),
    },
    'ticket.transcript': {
        render: (p, lang) => {
            const tr = botText(lang);
            return { embeds: [createEmbed({
                title: tr.t('ticket.dm.transcriptTitle'),
                description: tr.t('ticket.dm.transcriptBody', { channel: p.channelName, where: whereOf(tr, p) }),
                color: '#3498db',
                footer: { text: tr.t('ticket.post.ticketId', { id: p.ticketId }) },
            })] };
        },
    },

    // A giveaway winner (audit 4.7). prize: the host's text as the giveaway showed it; serverName
    // made safe; url: the giveaway message link (or null). Sent with no mentions (sendLoggedDm).
    'giveaway.won': {
        render: (p, lang) => {
            const tr = botText(lang);
            return { content: [
                tr.t('giveaway.dm.won', { prize: p.prize, server: p.serverName || tr.t('enforcement.dm.thisServer') }),
                p.hostId ? tr.t('giveaway.dm.claimHost', { hostId: p.hostId }) : tr.t('giveaway.dm.claimStaff'),
                p.url ? tr.t('giveaway.dm.link', { url: p.url }) : null,
            ].filter(Boolean).join('\n') };
        },
    },

    'application.result': {
        render: (p, lang) => {
            const tr = botText(lang);
            // note null = no note given: "No reason given" in the DM's language; a note stays as written.
            const params = { name: p.roleName, note: p.note ?? tr.t('community.apply.dm.noReason'), id: p.id };
            return { embeds: [createEmbed({
                title: p.approved ? tr.t('community.apply.dm.approvedTitle') : tr.t('community.apply.dm.deniedTitle'),
                description: p.approved ? tr.t('community.apply.dm.approvedBody', params) : tr.t('community.apply.dm.deniedBody', params),
            }).setColor(getApplicationStatusColor(p.approved ? 'approved' : 'denied'))] };
        },
    },

    'verification.approved': {
        render: (p, lang) => {
            const tr = botText(lang);
            return { content: tr.t('verification.review.dmApproved', { server: p.serverName || tr.t('verification.review.theServer') }) };
        },
    },
    'verification.denied': {
        render: (p, lang) => {
            const tr = botText(lang);
            return { content: tr.t('verification.review.dmDenied', { server: p.serverName || tr.t('verification.review.theServer') }) };
        },
    },

    'suggestion.status': {
        render: async (p, lang) => {
            const { suggestionDmPayload } = await import('../community/suggestionService.js');
            return suggestionDmPayload(p, lang);
        },
    },

    'premium.gift': {
        render: async (p, lang) => {
            const { giftDm } = await import('../../commands/Core/premium.js');
            return { content: giftDm({ ...p, lang }) };
        },
    },
});

export function hasDmRenderer(key) {
    return Object.prototype.hasOwnProperty.call(DM_RENDERERS, key);
}

/**
 * The payload of a template in a language. A non-English rendering that throws (a broken catalog
 * entry) is logged and rendered in English, so a DM is never lost to a translation; English
 * failing is a code bug and throws. Unknown key: throws.
 */
export async function renderDm(key, params, lang = 'en', { renderers = DM_RENDERERS } = {}) {
    const renderer = renderers[key];
    if (!renderer) throw new Error(`renderDm: unknown template ${key}`);
    try {
        return await renderer.render(params || {}, lang || 'en');
    } catch (error) {
        if (!lang || lang === 'en') throw error;
        logger.warn(`DM template ${key} failed in ${lang} (${error?.message || error}); rendered in English.`);
        return renderer.render(params || {}, 'en');
    }
}
