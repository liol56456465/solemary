import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { localized, replyText } from '../../Core/modules/commandText.js';
export default {
    data: new SlashCommandBuilder()
        .setName('time')
        .setDescription('Get the current time in different timezones')
        .addStringOption(option =>
            option.setName('timezone')
                .setDescription('The timezone to display (e.g., UTC, America/New_York)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.time.options.timezone'))
                .setRequired(false)),

    async execute(interaction) {
        const tr = replyText(interaction);
        await InteractionHelper.safeExecute(
            interaction,
            async () => {
                const timezone = interaction.options.getString('timezone') || 'UTC';

                let timeString;
                try {
                    // English keeps the US format; other languages write the date their way.
                    timeString = new Date().toLocaleString(tr.lang === 'en' ? 'en-US' : tr.lang, {
                        timeZone: timezone,
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        timeZoneName: 'short'
                    });
                } catch (error) {
                    logger.warn(`Invalid timezone requested: ${timezone}`);
                    await replyUserError(interaction, {
                        type: ErrorTypes.VALIDATION,
                        message: tr.t('tools.time.unknownZone'),
                        context: { lang: tr.lang },
                    });
                    return;
                }

                const now = new Date();
                const unixTimestamp = Math.floor(now.getTime() / 1000);

                const embed = successEmbed(
                    tr.t('tools.time.title'),
                    tr.t('tools.time.body', { zone: timezone, time: timeString, unix: unixTimestamp, iso: now.toISOString() }),
                );

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            },
            tr.t('tools.time.failed'),
            {
                autoDefer: true,
                deferOptions: { flags: MessageFlags.Ephemeral }
            }
        );
    },
};