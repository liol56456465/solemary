// ticketRatingEffects.js — what happens on Discord around a ticket / modmail rating
// (ticketRatingService.js holds the data):
//   - the survey in the ticket channel when the DM fails (O2; the opener keeps a read-only view only
//     until the survey is done: decline/comment at once, 30 min after a rating, or at the window end),
//   - after a rating: the `feedback` ticket log event, a Rating field on the transcript log
//     message (its id is saved in the ticket JSONB as transcriptLog), and the low-rating alert
//     (≤2★, alerts channel, staff shown as text),
//   - after a comment: the `feedback` log event with the comment (a flagged one in a spoiler).
// Nothing here pings anyone: every send has allowedMentions { parse: [] }. Each step is logged
// and skipped on failure; the rating itself is already saved.

import { getTicketData } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { logTicketFeedback } from '../utils/ticket/ticketLogging.js';
import { fetchStaffChannel } from './automod/channelRouting.js';
import { getGuildConfig } from './config/guildConfig.js';
import { renderDm } from './botDm/dmRenderers.js';
import { textForGuild } from '../utils/botText.js';
import { LOW_RATING_MAX, channelSurveysDone, ratingSettings, starsText } from './ticketRatingService.js';

export { commentFieldName, commentFieldValue } from './ticketRatingService.js';

export const NO_MENTIONS = Object.freeze({ parse: [] });
const FIELD_MAX = 1024;

/** The staff member as text for an alert: "name (id)", never a mention. */
async function staffAsText(client, staffId) {
    if (!staffId) return 'Unknown';
    const user = await client.users?.fetch?.(staffId).catch(() => null);
    return user?.username ? `${user.username} (${staffId})` : String(staffId);
}

/** The survey payload for the ticket channel (server language), no pings. */
export async function channelSurveyPayload({ guildId, channelId, channelName, openerId }) {
    const lang = textForGuild(guildId, { purpose: 'public' }).lang;
    const payload = await renderDm('ticket.feedback', { channelName, guildId, channelId }, lang);
    const tr = textForGuild(guildId, { purpose: 'public' });
    return {
        ...payload,
        content: tr.t('ticket.rating.channelPrompt', { user: `<@${openerId}>` }),
        allowedMentions: NO_MENTIONS,
    };
}

/** Adds (or replaces) a Rating field on the transcript log message of a ticket. Never throws. */
export async function editTranscriptLogRating(client, row, { loadTicket = getTicketData } = {}) {
    if (row?.kind !== 'ticket') return false;
    try {
        const ticket = await loadTicket(row.guild_id, row.ref_id);
        const ref = ticket?.transcriptLog;
        if (!ref?.channelId || !ref?.messageId) return false;
        const channel = await client.channels.fetch(ref.channelId).catch(() => null);
        if (!channel?.messages || channel.guildId !== row.guild_id) return false;
        const message = await channel.messages.fetch(ref.messageId).catch(() => null);
        const embed = message?.embeds?.[0];
        if (!embed) return false;
        const data = embed.toJSON ? embed.toJSON() : { ...embed };
        const fields = (data.fields || []).filter((f) => f.name !== 'Rating');
        fields.push({ name: 'Rating', value: `${starsText(row.rating)} ${row.rating}/5`, inline: true });
        await message.edit({ embeds: [{ ...data, fields: fields.slice(0, 25) }], allowedMentions: NO_MENTIONS });
        return true;
    } catch (error) {
        logger.warn(`Ticket rating: transcript log not edited: ${error.message}`);
        return false;
    }
}

/** The low-rating alert in the server's alerts channel (O5). Returns true when posted. Never throws. */
export async function postLowRatingAlert(client, row, { config = null } = {}) {
    try {
        if (!row || row.rating > LOW_RATING_MAX) return false;
        const settings = ratingSettings(config ?? await getGuildConfig(client, row.guild_id));
        if (!settings.lowRatingAlert) return false;
        const channel = await fetchStaffChannel(client, row.guild_id, 'alerts');
        if (!channel?.send) return false;
        const what = row.kind === 'modmail' ? 'Modmail' : `Ticket${row.ticket_number ? ` #${row.ticket_number}` : ''}`;
        await channel.send({
            embeds: [{
                title: 'Low ticket rating',
                color: 0xED4245,
                fields: [
                    { name: 'Rating', value: `${starsText(row.rating)} ${row.rating}/5`, inline: true },
                    { name: 'Conversation', value: what, inline: true },
                    { name: 'Handled by', value: (await staffAsText(client, row.staff_id)).slice(0, FIELD_MAX), inline: true },
                ],
                footer: { text: 'A comment, if one follows, goes to the ticket log.' },
                timestamp: new Date().toISOString(),
            }],
            allowedMentions: NO_MENTIONS,
        });
        return true;
    } catch (error) {
        logger.warn(`Ticket rating: low-rating alert not posted: ${error.message}`);
        return false;
    }
}

/** After a successful rating: log event, transcript log edit, low-rating alert. Never throws. */
export async function afterRating(client, row, deps = {}) {
    await logTicketFeedback({
        client, guildId: row.guild_id, ticketNumber: row.ticket_number, ticketChannelId: row.ref_id,
        userId: row.opener_id, rating: row.rating, staffId: row.staff_id, kind: row.kind,
    }).catch((error) => logger.warn(`Ticket rating: log not sent: ${error.message}`));
    await editTranscriptLogRating(client, row, deps);
    await postLowRatingAlert(client, row, deps);
}

/** After a successful comment: the log event with the comment; a channel survey is then done. Never throws. */
export async function afterComment(client, row, deps = {}) {
    await logTicketFeedback({
        client, guildId: row.guild_id, ticketNumber: row.ticket_number, ticketChannelId: row.ref_id,
        userId: row.opener_id, rating: row.rating, comment: row.comment, flagged: row.comment_flagged,
        staffId: row.staff_id, kind: row.kind,
    }).catch((error) => logger.warn(`Ticket rating: comment log not sent: ${error.message}`));
    if (row.kind === 'ticket' && row.delivery === 'channel') {
        await hideClosedTicketFromOpener(client, row.guild_id, row.ref_id, row.opener_id, deps);
    }
}

// O2 read-only view ends once the survey is answered: right after a decline or a comment, 30 minutes
// after a rating without a comment (time to add one), and when the window closes. Staff may keep
// writing in a closed ticket that stays undeleted, so the opener must not keep reading it.
const HIDDEN = Object.freeze({ ViewChannel: false, SendMessages: false });
export const RATED_GRACE_MS = 30 * 60 * 1000;

/**
 * Hides a CLOSED ticket channel from its opener. Skips a reopened ticket (the opener belongs there
 * again), a gone channel and an overwrite that already denies View (no API call). Never throws.
 * Returns true when it changed the overwrite. `deps`: { loadTicket }.
 */
export async function hideClosedTicketFromOpener(client, guildId, channelId, openerId, { loadTicket = getTicketData } = {}) {
    if (!guildId || !channelId || !openerId) return false;
    try {
        const channel = client.channels?.cache?.get(channelId)
            ?? await client.channels?.fetch?.(channelId).catch(() => null);
        if (!channel?.permissionOverwrites || channel.guildId !== guildId) return false;
        // Already hidden first: repeats of the sweep then cost neither an API call nor a DB read.
        const current = channel.permissionOverwrites.cache?.get(openerId);
        if (current?.deny?.has?.('ViewChannel')) return false;
        const ticket = await loadTicket(guildId, channelId).catch(() => null);
        if (ticket?.status !== 'closed') return false;
        await channel.permissionOverwrites.edit(openerId, HIDDEN);
        return true;
    } catch (error) {
        logger.warn(`Could not hide closed ticket ${channelId} from its opener: ${error.message}`);
        return false;
    }
}

/**
 * Every 10 minutes: channel surveys (O2) that are done — rated more than 30 minutes ago, or past their
 * window — lose the opener's view. Rows from the last 40 days (window max 30 + margin), walked page by
 * page (keyset on id, at most `maxPages` x 500 per run) so a large backlog never starves newer rows; an
 * already hidden overwrite costs no API call or DB read. `deps`: { query, tables, now, hide, maxPages }.
 */
export async function sweepChannelSurveyAccess(client, { query, tables, now = Date.now(), hide = hideClosedTicketFromOpener, loadTicket, maxPages = 20 } = {}) {
    let hidden = 0;
    let afterId = 0;
    for (let page = 0; page < maxPages; page += 1) {
        const batch = await channelSurveysDone({ query, tables, now, graceMs: RATED_GRACE_MS, afterId });
        for (const row of batch) {
            if (await hide(client, row.guild_id, row.ref_id, row.opener_id, loadTicket ? { loadTicket } : {})) hidden += 1;
        }
        if (batch.length < 500) break;
        afterId = batch.at(-1).id;
    }
    return hidden;
}
