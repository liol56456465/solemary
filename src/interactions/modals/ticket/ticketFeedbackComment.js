import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getTicketData } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { textForInteraction } from '../../../utils/botText.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import {
    cleanComment, isCommentFlagged, materializeLegacyRating, ratingSettings, submitComment,
} from '../../../services/ticketRatingService.js';
import { afterComment } from '../../../services/ticketRatingEffects.js';

// The rating comment form (ticketRatingService.js): once, only after the stars, inside the
// window, only by the opener. Everything is checked again here (the button did no database work).

const NO_MENTIONS = Object.freeze({ parse: [] });

function buildEmbed(title, description, color) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color);
}

const REFUSALS = {
    missing: ['ticket.feedback.notFoundTitle', 'ticket.feedback.notFoundComment'],
    notYours: ['ticket.feedback.notYoursTitle', 'ticket.feedback.notYoursComment'],
    notRated: ['ticket.rating.rateFirstTitle', 'ticket.rating.rateFirstBody'],
    already: ['ticket.rating.commentAlreadyTitle', 'ticket.rating.commentAlreadyBody'],
    expired: ['ticket.rating.closedTitle', 'ticket.rating.closedBody'],
    empty: ['ticket.feedback.emptyTitle', 'ticket.feedback.emptyBody'],
};

/** `deps` for tests: { submit, loadTicket, loadConfig, materialize, flag, effects }. */
export async function handleCommentSubmit(interaction, args, deps = {}) {
    const {
        submit = submitComment, loadTicket = getTicketData, loadConfig = getGuildConfig,
        materialize = materializeLegacyRating, flag = isCommentFlagged, effects = afterComment,
    } = deps;
    const tr = textForInteraction(interaction);
    const [guildId, channelId] = args;

    if (!guildId || !channelId) {
        await InteractionHelper.safeReply(interaction, {
            embeds: [buildEmbed(tr.t('ticket.feedback.brokenFormTitle'), tr.t('ticket.feedback.brokenFormBody'), getColor('error'))],
            flags: MessageFlags.Ephemeral,
        });
        return { ok: false, reason: 'broken' };
    }

    const comment = cleanComment(interaction.fields.getTextInputValue('feedback_comment'));
    if (!comment) {
        await InteractionHelper.safeReply(interaction, {
            embeds: [buildEmbed(tr.t('ticket.feedback.emptyTitle'), tr.t('ticket.feedback.emptyBody'), getColor('warning'))],
            flags: MessageFlags.Ephemeral,
        });
        return { ok: false, reason: 'empty' };
    }

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return { ok: false, reason: 'expired-interaction' };

    let result;
    try {
        const flagged = await flag(comment, guildId);
        const userId = interaction.user.id;
        result = await submit({ guildId, refId: channelId, userId, comment, flagged });
        if (!result.ok && result.reason === 'missing') {
            const ticket = await loadTicket(guildId, channelId);
            if (ticket) {
                const { windowDays } = ratingSettings(await loadConfig(interaction.client, guildId));
                const row = await materialize(guildId, channelId, ticket, { windowDays });
                result = row ? await submit({ guildId, refId: channelId, userId, comment, flagged }) : { ok: false, reason: 'expired' };
            }
        }
    } catch (err) {
        logger.error('ticketFeedbackComment: comment not saved', { guildId, channelId, error: err.message });
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [buildEmbed(tr.t('ticket.feedback.notSavedTitle'), tr.t('ticket.feedback.notSavedComment'), getColor('error'))],
        });
        return { ok: false, reason: 'error' };
    }

    if (!result.ok) {
        const [title, body] = REFUSALS[result.reason] || REFUSALS.missing;
        await InteractionHelper.safeEditReply(interaction, { embeds: [buildEmbed(tr.t(title), tr.t(body), getColor('error'))], allowedMentions: NO_MENTIONS });
        return result;
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildEmbed(tr.t('ticket.feedback.sentTitle'), tr.t('ticket.feedback.sentBody'), getColor('success'))],
        allowedMentions: NO_MENTIONS,
    });
    // The survey message loses its last button (the comment is in).
    await interaction.message?.edit?.({ components: [], allowedMentions: NO_MENTIONS })
        .catch((error) => logger.debug(`ticketFeedbackComment: survey buttons not removed: ${error.message}`));
    logger.info('Ticket rating comment saved', { guildId, channelId, flagged: result.row.comment_flagged });
    await effects(interaction.client, result.row);
    return result;
}

export default {
    name: 'ticket_feedback_comment_modal',

    async execute(interaction, client, args) {
        await handleCommentSubmit(interaction, args);
    },
};
