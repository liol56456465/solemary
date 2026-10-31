import { EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { getTicketData, saveTicketData } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { logTicketFeedback } from '../../../utils/ticket/ticketLogging.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';

const STAR_LABELS = {
    '1': '1/5 - Bad',
    '2': '2/5 - Not great',
    '3': '3/5 - Okay',
    '4': '4/5 - Good',
    '5': '5/5 - Great',
};

const feedbackHandler = {
    name: 'ticket_feedback',

    async execute(interaction, client, args) {
        
        const [guildId, channelId, ratingStr] = args;

        if (!guildId || !channelId || !ratingStr) {
            await InteractionHelper.safeReply(interaction, {
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

        try {
            await interaction.deferUpdate();
        } catch (err) {
            logger.warn('ticketFeedback: interaction expired before deferUpdate', { guildId, channelId, error: err.message });
            return;
        }

        let ticketData;
        try {
            ticketData = await getTicketData(guildId, channelId);
        } catch (err) {
            logger.warn('ticketFeedback: failed to load ticket data', { guildId, channelId, error: err.message });
        }

        if (!ticketData) {
            await InteractionHelper.safeEditReply(interaction, {
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
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Not your ticket')
                        .setDescription('Only the person who opened this ticket can rate it.')
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        if (ticketData.feedback?.rating) {
            await InteractionHelper.safeEditReply(interaction, {
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

        const rating = Number(ratingStr);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            await InteractionHelper.safeEditReply(interaction, {
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
            await InteractionHelper.safeEditReply(interaction, {
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

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                new EmbedBuilder()
                    .setTitle('Rating saved')
                    .setDescription(`You rated this ticket **${ratingLabel}**.`)
                    .setColor(getColor('success'))
                    .setFooter({ text: 'Thanks for rating.' })
                    .setTimestamp(),
            ],
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

const commentHandler = {
    name: 'ticket_feedback_comment',

    async execute(interaction, client, args) {
        const [guildId, channelId] = args;

        if (!guildId || !channelId) {
            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Broken link')
                        .setDescription('This feedback button doesn\'t work.')
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId(`ticket_feedback_comment_modal:${guildId}:${channelId}`)
            .setTitle('Ticket feedback');

        const commentInput = new TextInputBuilder()
            .setCustomId('feedback_comment')
            .setLabel('Your comment')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('What went well, what could be better?')
            .setRequired(true)
            .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(commentInput));

        await interaction.showModal(modal);
    },
};

const declineHandler = {
    name: 'ticket_feedback_decline',

    async execute(interaction) {
        await interaction.update({
            embeds: [
                new EmbedBuilder()
                    .setTitle('No problem')
                    .setDescription('Open a new ticket any time you need help.')
                    .setColor(getColor('default')),
            ],
            components: [],
        });
    },
};

export default [feedbackHandler, commentHandler, declineHandler];