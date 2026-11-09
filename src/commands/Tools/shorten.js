import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { shortenUrl } from '../../services/urlShortener.js';
import { localized, replyText } from '../../utils/commandLocalizations.js';

export default {
    data: new SlashCommandBuilder()
        .setName("shorten")
        .setDescription("Shorten a URL using is.gd")
        .setDescriptionLocalizations(localized('tools.slash.shorten.description'))
        .addStringOption(option =>
            option
                .setName("url")
                .setDescription("The URL to shorten")
                .setDescriptionLocalizations(localized('tools.slash.shorten.options.url'))
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("custom")
                .setDescription("Custom URL ending (optional)")
                .setDescriptionLocalizations(localized('tools.slash.shorten.options.custom'))
                .setRequired(false)
        )
        .setDMPermission(false),
    category: "Tools",

    async execute(interaction) {
        const tr = replyText(interaction);
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
                message: error?.userMessage || tr.t('tools.shorten.failed'),
                context: { lang: tr.lang },
            });
        }

        const embed = successEmbed(tr.t('tools.shorten.title'), tr.t('tools.shorten.body', { url: shortUrl }));
        embed.setColor(getColor('success'));
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed],
        });
    },
};