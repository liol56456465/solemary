import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { activeCountdowns, startCountdownMessage } from '../../services/botMessageService.js';
import { localized, publicText, replyText } from '../Core/modules/commandText.js';

// The map lives in the service (the dashboard starts countdowns too); the buttons import it from here.
export { activeCountdowns };

export default {
    data: new SlashCommandBuilder()
        .setName("countdown")
        .setDescription("Start a countdown timer")
        .setDescriptionLocalizations(localized('tools.slash.countdown.description'))
        .addIntegerOption((option) =>
            option
                .setName("minutes")
                .setDescription("Number of minutes to count down (0-1440)")
                .setDescriptionLocalizations(localized('tools.slash.countdown.options.minutes'))
                .setMinValue(0)
                .setMaxValue(1440)
                .setRequired(false),
        )
        .addIntegerOption((option) =>
            option
                .setName("seconds")
                .setDescription("Number of seconds to count down (0-59)")
                .setDescriptionLocalizations(localized('tools.slash.countdown.options.seconds'))
                .setMinValue(0)
                .setMaxValue(59)
                .setRequired(false),
        )
        .addStringOption((option) =>
            option
                .setName("title")
                .setDescription("Optional title for the countdown")
                .setDescriptionLocalizations(localized('tools.slash.countdown.options.title'))
                .setRequired(false),
        ),

    async execute(interaction) {
        const tr = replyText(interaction);
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn(`Countdown interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'countdown'
            });
            return;
        }

        const minutes = interaction.options.getInteger("minutes") || 0;
        const seconds = interaction.options.getInteger("seconds") || 0;
        // The default title goes on the public countdown message: the server's language.
        const title = interaction.options.getString("title") || publicText(interaction).t('tools.countdown.defaultTitle');

        const totalSeconds = minutes * 60 + seconds;

        if (totalSeconds <= 0) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('tools.countdown.tooShort'), context: { lang: tr.lang } });
        }

        if (totalSeconds > 86400) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('tools.countdown.tooLong'), context: { lang: tr.lang } });
        }

        await startCountdownMessage(interaction.guild, { channel: interaction.channel, totalSeconds, title });

        await InteractionHelper.safeEditReply(interaction, {
            content: tr.t('tools.countdown.started'),
            flags: MessageFlags.Ephemeral,
        });
    },
};