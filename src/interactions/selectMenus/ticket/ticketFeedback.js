import { EmbedBuilder } from 'discord.js';
import { getColor } from '../../../config/bot.js';
import { textForInteraction } from '../../../utils/botText.js';
import { logger } from '../../../utils/logger.js';
import { handleRatingClick } from '../../buttons/ticket/ticketFeedback.js';

// The old select-menu survey (`ticket_feedback:<guild>:<channel>`, value 1–5), from before the
// star buttons. Same rules as the buttons (ticketRatingService.js: one atomic rating).
export default {
    name: 'ticket_feedback',

    async execute(interaction, client, args) {
        const [guildId, channelId] = args;

        if (!guildId || !channelId) {
            const tr = textForInteraction(interaction);
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

        try {
            await interaction.deferUpdate();
        } catch (err) {
            logger.warn('ticketFeedback (menu): interaction expired before deferUpdate', { guildId, channelId, error: err.message });
            return;
        }
        await handleRatingClick(interaction, { guildId, refId: channelId, rating: parseInt(interaction.values?.[0], 10) });
    },
};
