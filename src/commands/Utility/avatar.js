import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { localized, publicText } from '../../utils/commandLocalizations.js';

export default {
    data: new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Display a user's avatar image")
    .setDescriptionLocalizations(localized('utility.slash.avatar.description'))
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription(
          "The user whose avatar you want to see (defaults to you)",
        )
        .setDescriptionLocalizations(localized('utility.slash.avatar.options.target')),
    ),

  async execute(interaction) {
    const user = interaction.options.getUser("target") || interaction.user;
    const avatarUrl = user.displayAvatarURL({ size: 2048, dynamic: true });

    // Posted in the channel: the server's language.
    const tr = publicText(interaction);
    const embed = createEmbed({
      title: tr.t('utility.avatar.title', { name: user.username }),
      description: tr.t('utility.avatar.download', { url: avatarUrl }),
    })
      .setImage(avatarUrl);

    await InteractionHelper.safeReply(interaction, { embeds: [embed] });
    logger.info(`Avatar command executed`, {
      userId: interaction.user.id,
      targetUserId: user.id,
      guildId: interaction.guildId
    });
  }
};