import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { shortenUrl } from '../../services/urlShortener.js';

export default {
    data: new SlashCommandBuilder()
        .setName("shorten")
        .setDescription("Shorten a URL using is.gd")
        .addStringOption(option =>
            option
                .setName("url")
                .setDescription("The URL to shorten")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("custom")
                .setDescription("Custom URL ending (optional)")
                .setRequired(false)
        )
        .setDMPermission(false),
    category: "Tools",

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral
        });
        if (!deferSuccess) {
            logger.warn(`Shorten interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'shorten'
            });
            return;
        }

        const url = interaction.options.getString("url");
        const custom = interaction.options.getString("custom");

        let shortUrl;
        try {
            shortUrl = await shortenUrl(url, custom || '');
        } catch (error) {
            return replyUserError(interaction, {
                type: error?.type || ErrorTypes.UNKNOWN,
                message: error?.userMessage || 'URL shortening failed. Please try again later.',
            });
        }

        const embed = successEmbed('URL Shortened', `Here's your shortened URL: ${shortUrl}`);
        embed.setColor(getColor('success'));
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed],
        });
    },
};