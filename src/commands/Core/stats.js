import { SlashCommandBuilder, version, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { localized, publicText } from './modules/commandText.js';
export default {
    data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("View bot statistics")
    .setDescriptionLocalizations(localized('core.slash.stats.description')),

  async execute(interaction) {
    // A public answer (deferred without ephemeral): the server's language.
    const tr = publicText(interaction);
    try {
      await InteractionHelper.safeDefer(interaction);
      
      const totalGuilds = interaction.client.guilds.cache.size;
      const totalMembers = interaction.client.guilds.cache.reduce(
        (acc, guild) => acc + guild.memberCount,
        0,
      );
      const nodeVersion = process.version;

      const embed = createEmbed({ title: tr.t('core.stats.title'), description: null }).addFields(
        { name: tr.t('core.stats.servers'), value: `${totalGuilds}`, inline: true },
        { name: tr.t('core.stats.users'), value: `${totalMembers}`, inline: true },
        { name: "Node.js", value: `${nodeVersion}`, inline: true },
        { name: "Discord.js", value: `v${version}`, inline: true },
        {
          name: tr.t('core.stats.memory'),
          value: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
          inline: true,
        },
      );

      await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    } catch (error) {
      logger.error('Stats command error:', error);
      return InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({ title: tr.t('core.stats.errorTitle'), description: tr.t('core.stats.error'), color: 'error' })],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};