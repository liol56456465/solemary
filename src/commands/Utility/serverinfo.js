import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { localized, publicText } from '../Core/modules/commandText.js';

export default {
    data: new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Get detailed information about the server")
    .setDescriptionLocalizations(localized('utility.slash.serverinfo.description')),

  async execute(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`ServerInfo interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'serverinfo'
      });
      return;
    }

    const guild = interaction.guild;
    const owner = await guild.fetchOwner();

    const createdTimestamp = Math.floor(guild.createdAt.getTime() / 1000);

    // A public answer: the server's language.
    const tr = publicText(interaction);
    const embed = createEmbed({ title: tr.t('utility.serverinfo.title', { name: guild.name }), description: tr.t('utility.serverinfo.id', { id: guild.id }) })
      .setThumbnail(guild.iconURL({ size: 256 }))
      .addFields(
        { name: tr.t('utility.serverinfo.owner'), value: owner.user.tag, inline: true },
        { name: tr.t('utility.serverinfo.members'), value: `${guild.memberCount}`, inline: true },
        {
          name: tr.t('utility.serverinfo.channels'),
          value: `${guild.channels.cache.size}`,
          inline: true,
        },
        { name: tr.t('utility.serverinfo.roles'), value: `${guild.roles.cache.size}`, inline: true },
        {
          name: tr.t('utility.serverinfo.boosts'),
          value: tr.t('utility.serverinfo.boostValue', { tier: guild.premiumTier, count: guild.premiumSubscriptionCount }),
          inline: true,
        },
        {
          name: tr.t('utility.serverinfo.created'),
          value: `<t:${createdTimestamp}:R>`,
          inline: true,
        },
      );

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    logger.info(`ServerInfo command executed`, {
      userId: interaction.user.id,
      guildId: guild.id,
      guildName: guild.name,
      memberCount: guild.memberCount
    });
  },
};