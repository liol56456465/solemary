import { escapeMarkdown } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';

// User text goes into embed markdown; escape it (escapeMarkdown also escapes backslashes) so it
// cannot form masked links or formatting.
function escapeUserText(text) {
    return escapeMarkdown(String(text ?? '')).replace(/[[\]()]/g, '\\$&');
}

export default {
    async execute(interaction) {
        const query = interaction.options.getString('query');
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

        const embed = createEmbed({
            title: 'Google Search',
            description: `[Search for "${escapeUserText(query)}"](${searchUrl})`,
            color: 'info'
        })
        .setFooter({ text: 'Google Search Results' });

        await InteractionHelper.safeReply(interaction, { embeds: [embed] });

        logger.info('Google search link generated', {
            userId: interaction.user.id,
            query: query,
            guildId: interaction.guildId,
            commandName: 'google'
        });
    },
};
