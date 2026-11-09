import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyText } from '../../../utils/commandLocalizations.js';
export default {
    data: new SlashCommandBuilder()
        .setName('unixtime')
        .setDescription('Get the current Unix timestamp'),

    async execute(interaction) {
        const tr = replyText(interaction);
        await InteractionHelper.safeExecute(
            interaction,
            async () => {
                const now = new Date();
                const unixTimestamp = Math.floor(now.getTime() / 1000);

                const embed = successEmbed(
                    tr.t('tools.unixtime.title'),
                    tr.t('tools.unixtime.body', { seconds: unixTimestamp, ms: now.getTime(), utc: now.toUTCString(), iso: now.toISOString() }),
                );
                embed.setColor(getColor('success'));

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [embed],
                });
            },
            tr.t('tools.unixtime.failed'),
            {
                autoDefer: true,
                deferOptions: { flags: MessageFlags.Ephemeral }
            }
        );
    },
};