import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { localized, publicText } from './modules/commandText.js';
export default {
    data: new SlashCommandBuilder()
    .setName("uptime")
    .setDescription("Check how long the bot has been online")
    .setDescriptionLocalizations(localized('core.slash.uptime.description')),

  async execute(interaction) {
    // A public answer (deferred without ephemeral): the server's language.
    const tr = publicText(interaction);
    try {
      await InteractionHelper.safeDefer(interaction);
      
      let totalSeconds = interaction.client.uptime / 1000;
      let days = Math.floor(totalSeconds / 86400);
      totalSeconds %= 86400;
      let hours = Math.floor(totalSeconds / 3600);
      totalSeconds %= 3600;
      let minutes = Math.floor(totalSeconds / 60);
      let seconds = Math.floor(totalSeconds % 60);

      const uptimeStr = tr.t('core.uptime.value', { days, hours, minutes, seconds });

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({ 
          title: tr.t('core.uptime.title'), 
          description: `\`\`\`${uptimeStr}\`\`\`` 
        })],
      });
    } catch (error) {
      logger.error('Uptime command error:', error);
      
      try {
        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [createEmbed({ title: tr.t('core.uptime.errorTitle'), description: tr.t('core.uptime.error'), color: 'error' })],
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        logger.error('Failed to send error reply:', replyError);
      }
    }
  },
};