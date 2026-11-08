import { EmbedBuilder } from 'discord.js';
import { getTicketData, saveTicketData } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { logTicketFeedback } from '../../../utils/ticket/ticketLogging.js';
import { textForInteraction } from '../../../utils/botText.js';

// Replies to the person rating (in a DM): their Discord language.
const STAR_LABELS = {
    '1': 'ticket.feedback.rating1',
    '2': 'ticket.feedback.rating2',
    '3': 'ticket.feedback.rating3',
    '4': 'ticket.feedback.rating4',
    '5': 'ticket.feedback.rating5',
};
const ratingText = (tr, rating) => (STAR_LABELS[String(rating)] ? tr.t(STAR_LABELS[String(rating)]) : `${rating}/5`);

export default {
    name: 'ticket_feedback',

    async execute(interaction, client, args) {
        const tr = textForInteraction(interaction);
        
        const [guildId, channelId] = args;

        if (!guildId || !channelId) {
            // Not yet acknowledged here, so editReply would throw; update the survey message instead.
            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(tr.t('ticket.feedback.brokenTitle'))
                        .setDescription(tr.t('ticket.feedback.brokenLink'))
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        await interaction.deferUpdate();

        let ticketData;
        try {
            ticketData = await getTicketData(guildId, channelId);
        } catch (err) {
            logger.warn('ticketFeedback: failed to load ticket data', { guildId, channelId, error: err.message });
        }

        if (!ticketData) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(tr.t('ticket.feedback.notFoundTitle'))
                        .setDescription(tr.t('ticket.feedback.notFoundRating'))
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        if (interaction.user.id !== ticketData.userId) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(tr.t('ticket.feedback.notYoursTitle'))
                        .setDescription(tr.t('ticket.feedback.notYoursRating'))
                        .setColor(getColor('error')),
                ],
            });
            return;
        }

        if (ticketData.feedback?.rating) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(tr.t('ticket.feedback.alreadyTitle'))
                        .setDescription(tr.t('ticket.feedback.alreadyBody', { rating: ratingText(tr, ticketData.feedback.rating) }))
                        .setColor(getColor('success')),
                ],
                components: [],
            });
            return;
        }

        const rating = parseInt(interaction.values[0], 10);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(tr.t('ticket.feedback.invalidTitle'))
                        .setDescription(tr.t('ticket.feedback.invalidBody'))
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        const ratingLabel = ratingText(tr, rating);

        try {
            ticketData.feedback = {
                ...ticketData.feedback,
                rating,
                submittedAt: new Date().toISOString(),
            };
            await saveTicketData(guildId, channelId, ticketData);
        } catch (err) {
            logger.error('ticketFeedback: failed to save feedback', { guildId, channelId, rating, error: err.message });
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(tr.t('ticket.feedback.notSavedTitle'))
                        .setDescription(tr.t('ticket.feedback.notSavedRating'))
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        try {
            await logTicketFeedback({
                client: interaction.client,
                guildId,
                ticketNumber: ticketData.id,
                ticketChannelId: channelId,
                userId: interaction.user.id,
                rating,
            });
        } catch (err) {
            logger.warn('ticketFeedback: failed to send log', { guildId, channelId, error: err.message });
        }

        const thankYouEmbed = new EmbedBuilder()
            .setTitle(tr.t('ticket.feedback.savedTitle'))
            .setDescription(tr.t('ticket.feedback.savedBody', { rating: ratingLabel }))
            .setColor(getColor('success'))
            .setFooter({ text: tr.t('ticket.feedback.savedFooter') })
            .setTimestamp();

        await interaction.editReply({
            embeds: [thankYouEmbed],
            components: [],
        });

        logger.info('Ticket feedback submitted', {
            guildId,
            channelId,
            userId: interaction.user.id,
            rating,
        });
    },
};