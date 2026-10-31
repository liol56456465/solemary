import { EmbedBuilder } from 'discord.js';
import { getTicketData, saveTicketData } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { logTicketFeedback } from '../../../utils/ticket/ticketLogging.js';

const STAR_LABELS = {
    '1': '1/5 - Bad',
    '2': '2/5 - Not great',
    '3': '3/5 - Okay',
    '4': '4/5 - Good',
    '5': '5/5 - Great',
};

export default {
    name: 'ticket_feedback',

    async execute(interaction, client, args) {
        
        const [guildId, channelId] = args;

        if (!guildId || !channelId) {
            // Not yet acknowledged here, so editReply would throw; update the survey message instead.
            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Broken link')
                        .setDescription('This feedback link doesn\'t work.')
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
                        .setTitle('Ticket not found')
                        .setDescription('Couldn\'t find the ticket for this rating.')
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
                        .setTitle('Not your ticket')
                        .setDescription('Only the person who opened this ticket can rate it.')
                        .setColor(getColor('error')),
                ],
            });
            return;
        }

        if (ticketData.feedback?.rating) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Already rated')
                        .setDescription(`You already rated this ticket **${STAR_LABELS[String(ticketData.feedback.rating)]}**.`)
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
                        .setTitle('Invalid rating')
                        .setDescription('Pick a rating from 1 to 5.')
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        const ratingLabel = STAR_LABELS[String(rating)] ?? `${rating}/5`;

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
                        .setTitle('Not saved')
                        .setDescription('Couldn\'t save your rating right now. Try again later.')
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
            .setTitle('Rating saved')
            .setDescription(`You rated this ticket **${ratingLabel}**.`)
            .setColor(getColor('success'))
            .setFooter({ text: 'Thanks for rating.' })
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