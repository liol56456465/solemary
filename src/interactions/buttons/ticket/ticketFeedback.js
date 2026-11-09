import { EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getTicketData } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { textForInteraction } from '../../../utils/botText.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import {
    COMMENT_MAX, findRating, materializeLegacyRating, ratingSettings, submitRating,
} from '../../../services/ticketRatingService.js';
import { afterRating } from '../../../services/ticketRatingEffects.js';

// Ticket / modmail rating survey (ticketRatingService.js). The buttons are the ones sent since
// before ticket_ratings existed (`ticket_feedback:<guild>:<channel>:<n>`), so old DMs keep
// working: a click without a row copies that ticket's old JSONB into the table first.
// Replies go to the person rating (a DM, or the ticket channel when the DM failed): their language.

const STAR_LABELS = {
    '1': 'ticket.feedback.rating1',
    '2': 'ticket.feedback.rating2',
    '3': 'ticket.feedback.rating3',
    '4': 'ticket.feedback.rating4',
    '5': 'ticket.feedback.rating5',
};
export const ratingText = (tr, rating) => (STAR_LABELS[String(rating)] ? tr.t(STAR_LABELS[String(rating)]) : `${rating}/5`);
const NO_MENTIONS = Object.freeze({ parse: [] });

const embed = (title, description, color) => new EmbedBuilder().setTitle(title).setDescription(description).setColor(getColor(color));

/** The row under a saved rating: only "Add a comment" (the comment can follow the stars once). */
export function commentRow(tr, guildId, refId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_feedback_comment:${guildId}:${refId}`)
            .setLabel(tr.t('ticket.dm.feedbackComment')).setStyle(ButtonStyle.Secondary),
    );
}

/**
 * A rating click (button or the old select menu), already acknowledged with deferUpdate.
 * `deps` for tests: { submit, loadTicket, loadConfig, materialize, effects }.
 */
export async function handleRatingClick(interaction, { guildId, refId, rating }, deps = {}) {
    const {
        submit = submitRating, loadTicket = getTicketData, loadConfig = getGuildConfig,
        materialize = materializeLegacyRating, effects = afterRating,
    } = deps;
    const tr = textForInteraction(interaction);
    const userId = interaction.user.id;
    const edit = (payload) => InteractionHelper.safeEditReply(interaction, { allowedMentions: NO_MENTIONS, ...payload });
    // In the ticket channel (O2 fallback) the survey is shared: a refusal that only concerns the
    // clicker is a private follow-up, and the survey stays as it is.
    const inChannel = Boolean(interaction.guildId);
    const refuse = (payload) => (inChannel
        ? interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS }).catch(() => null)
        : edit(payload));

    let result;
    try {
        result = await submit({ guildId, refId, userId, rating });
        if (!result.ok && result.reason === 'missing') {
            // A survey sent before ticket_ratings: copy its ticket in, then try once more.
            const ticket = await loadTicket(guildId, refId);
            if (ticket) {
                const { windowDays } = ratingSettings(await loadConfig(interaction.client, guildId));
                const row = await materialize(guildId, refId, ticket, { windowDays });
                if (row) result = await submit({ guildId, refId, userId, rating });
                else result = { ok: false, reason: 'expired', row: null };
            }
        }
    } catch (error) {
        logger.error('ticketFeedback: rating not saved', { guildId, refId, error: error.message });
        await refuse({ embeds: [embed(tr.t('ticket.feedback.notSavedTitle'), tr.t('ticket.feedback.notSavedRating'), 'error')] });
        return { ok: false, reason: 'error' };
    }

    if (!result.ok) {
        const answers = {
            invalid: ['ticket.feedback.invalidTitle', 'ticket.feedback.invalidBody', 'error', false],
            missing: ['ticket.feedback.notFoundTitle', 'ticket.feedback.notFoundRating', 'error', true],
            notYours: ['ticket.feedback.notYoursTitle', 'ticket.feedback.notYoursRating', 'error', false],
            expired: ['ticket.rating.closedTitle', 'ticket.rating.closedBody', 'default', true],
        };
        if (result.reason === 'already') {
            await edit({
                embeds: [embed(tr.t('ticket.feedback.alreadyTitle'), tr.t('ticket.feedback.alreadyBody', { rating: ratingText(tr, result.row?.rating) }), 'success')],
                components: [],
            });
            return result;
        }
        const [title, body, color, final] = answers[result.reason] || answers.missing;
        const payload = { embeds: [embed(tr.t(title), tr.t(body), color)] };
        // Gone or window over: true for everyone, the buttons go. Otherwise only the clicker is told.
        if (final) await edit({ ...payload, components: [] });
        else await refuse(payload);
        return result;
    }

    const row = result.row;
    await edit({
        embeds: [embed(tr.t('ticket.feedback.savedTitle'), tr.t('ticket.feedback.savedBody', { rating: ratingText(tr, row.rating) }), 'success')
            .setFooter({ text: tr.t('ticket.rating.savedFooterComment') })
            .setTimestamp()],
        components: [commentRow(tr, guildId, refId)],
    });
    logger.info('Ticket rating saved', { guildId, refId, kind: row.kind, rating: row.rating });
    await effects(interaction.client, row);
    return result;
}

const feedbackHandler = {
    name: 'ticket_feedback',

    // `deps`: tests only (handleRatingClick's); the router passes three arguments.
    async execute(interaction, client, args, deps = {}) {
        const [guildId, channelId, ratingStr] = args;

        if (!guildId || !channelId || !ratingStr) {
            const tr = textForInteraction(interaction);
            await InteractionHelper.safeReply(interaction, {
                embeds: [embed(tr.t('ticket.feedback.brokenTitle'), tr.t('ticket.feedback.brokenLink'), 'error')],
                components: [],
            });
            return;
        }

        // Acknowledge first (3 s), then the database.
        try {
            await interaction.deferUpdate();
        } catch (err) {
            logger.warn('ticketFeedback: interaction expired before deferUpdate', { guildId, channelId, error: err.message });
            return;
        }

        await handleRatingClick(interaction, { guildId, refId: channelId, rating: Number(ratingStr) }, deps);
    },
};

const commentHandler = {
    name: 'ticket_feedback_comment',
    opensModal: true,

    // No database work before showModal (3 s); the form re-checks everything on submit.
    async execute(interaction, client, args) {
        const tr = textForInteraction(interaction);
        const [guildId, channelId] = args;

        if (!guildId || !channelId) {
            await interaction.update({
                embeds: [embed(tr.t('ticket.feedback.brokenTitle'), tr.t('ticket.feedback.brokenButton'), 'error')],
                components: [],
            });
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId(`ticket_feedback_comment_modal:${guildId}:${channelId}`)
            .setTitle(tr.t('ticket.feedback.modalTitle'));

        const commentInput = new TextInputBuilder()
            .setCustomId('feedback_comment')
            .setLabel(tr.t('ticket.feedback.modalLabel'))
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(tr.t('ticket.feedback.modalPlaceholder'))
            .setRequired(true)
            .setMaxLength(COMMENT_MAX);

        modal.addComponents(new ActionRowBuilder().addComponents(commentInput));

        await interaction.showModal(modal);
    },
};

/** "No thanks". In a DM: closes the survey. In the ticket channel: only the opener can. `deps`: { find }. */
export async function handleDecline(interaction, args = [], { find = findRating } = {}) {
    const tr = textForInteraction(interaction);
    const declined = { embeds: [embed(tr.t('ticket.feedback.declineTitle'), tr.t('ticket.feedback.declineBody'), 'default')], components: [] };
    if (!interaction.guildId) {
        await interaction.update(declined);
        return true;
    }
    const [guildId, refId] = args;
    try {
        await interaction.deferUpdate();
    } catch (err) {
        logger.warn('ticketFeedback: interaction expired before deferUpdate (decline)', { guildId, refId, error: err.message });
        return false;
    }
    let row = null;
    try {
        row = guildId && refId ? await find(guildId, refId) : null;
    } catch (error) {
        // A read error is said as such (never as "not yours"); the survey stays.
        logger.warn('ticketFeedback: decline lookup failed', { guildId, refId, error: error.message });
        await interaction.followUp({
            embeds: [embed(tr.t('ticket.feedback.notSavedTitle'), tr.t('ticket.feedback.notSavedRating'), 'error')],
            flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS,
        }).catch(() => null);
        return false;
    }
    if (!row || row.opener_id !== interaction.user.id) {
        await interaction.followUp({
            embeds: [embed(tr.t('ticket.feedback.notYoursTitle'), tr.t('ticket.feedback.notYoursRating'), 'error')],
            flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS,
        }).catch(() => null);
        return false;
    }
    await InteractionHelper.safeEditReply(interaction, declined);
    return true;
}

const declineHandler = {
    name: 'ticket_feedback_decline',

    async execute(interaction, client, args) {
        await handleDecline(interaction, args);
    },
};

export default [feedbackHandler, commentHandler, declineHandler];
