import { EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { getTicketData, saveTicketData } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { logTicketFeedback } from '../../../utils/ticket/ticketLogging.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
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

const feedbackHandler = {
    name: 'ticket_feedback',

    async execute(interaction, client, args) {
        const tr = textForInteraction(interaction);
        
        const [guildId, channelId, ratingStr] = args;

        if (!guildId || !channelId || !ratingStr) {
            await InteractionHelper.safeReply(interaction, {
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
                        .setTitle(tr.t('ticket.feedback.notFoundTitle'))
                        .setDescription(tr.t('ticket.feedback.notFoundRating'))
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
                        .setTitle(tr.t('ticket.feedback.notYoursTitle'))
                        .setDescription(tr.t('ticket.feedback.notYoursRating'))
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
                        .setTitle(tr.t('ticket.feedback.alreadyTitle'))
                        .setDescription(tr.t('ticket.feedback.alreadyBody', { rating: ratingText(tr, ticketData.feedback.rating) }))
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
            await InteractionHelper.safeEditReply(interaction, {
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

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                new EmbedBuilder()
                    .setTitle(tr.t('ticket.feedback.savedTitle'))
                    .setDescription(tr.t('ticket.feedback.savedBody', { rating: ratingLabel }))
                    .setColor(getColor('success'))
                    .setFooter({ text: tr.t('ticket.feedback.savedFooter') })
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
        const tr = textForInteraction(interaction);
        const [guildId, channelId] = args;

        if (!guildId || !channelId) {
            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(tr.t('ticket.feedback.brokenTitle'))
                        .setDescription(tr.t('ticket.feedback.brokenButton'))
                        .setColor(getColor('error')),
                ],
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
            .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(commentInput));

        await interaction.showModal(modal);
    },
};

const declineHandler = {
    name: 'ticket_feedback_decline',

    async execute(interaction) {
        const tr = textForInteraction(interaction);
        await interaction.update({
            embeds: [
                new EmbedBuilder()
                    .setTitle(tr.t('ticket.feedback.declineTitle'))
                    .setDescription(tr.t('ticket.feedback.declineBody'))
                    .setColor(getColor('default')),
            ],
            components: [],
        });
    },
};

export default [feedbackHandler, commentHandler, declineHandler];