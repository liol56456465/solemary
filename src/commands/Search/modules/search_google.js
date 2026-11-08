import { escapeMarkdown } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { publicText } from '../../Core/modules/commandText.js';

// User text goes into embed markdown; escape it (escapeMarkdown also escapes backslashes) so it
// cannot form masked links or formatting.
function escapeUserText(text) {
    return escapeMarkdown(String(text ?? '')).replace(/[[\]()]/g, '\\$&');
}

export default {
    async execute(interaction) {
        const query = interaction.options.getString('query');
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

        // A public reply: the server's language.
        const tr = publicText(interaction);
        const embed = createEmbed({
            title: tr.t('search.google.title'),
            description: tr.t('search.google.link', { query: escapeUserText(query), url: searchUrl }),
            color: 'info'
        })
        .setFooter({ text: tr.t('search.google.footer') });

        await InteractionHelper.safeReply(interaction, { embeds: [embed] });

        // Never log the query (member text), and not at info: ids only.
        logger.debug('Google search link generated', {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            commandName: 'google'
        });
    },
};
