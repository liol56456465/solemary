import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { publicText } from '../../Core/modules/commandText.js';
export default {
    data: new SlashCommandBuilder()
    .setName("flip")
    .setDescription("Flips a coin (Heads or Tails)."),
  category: 'Fun',

  async execute(interaction, config, client) {
    // A public reply: the server's language.
    const tr = publicText(interaction);
    const result = Math.random() < 0.5 ? tr.t('fun.flip.heads') : tr.t('fun.flip.tails');
    const embed = successEmbed(
      tr.t('fun.flip.title'),
      tr.t('fun.flip.result', { result }),
    );

    await InteractionHelper.safeReply(interaction, { embeds: [embed] });
    logger.debug(`Flip command executed by user ${interaction.user.id} in guild ${interaction.guildId}`);
  },
};