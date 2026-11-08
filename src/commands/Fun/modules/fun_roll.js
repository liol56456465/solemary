import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { localized, publicText, replyText } from '../../Core/modules/commandText.js';
export default {
    data: new SlashCommandBuilder()
    .setName("roll")
    .setDescription("Rolls dice using standard notation (e.g., 2d20, 1d6 + 5).")
    .addStringOption((option) =>
      option
        .setName("notation")
        .setDescription("The dice notation (e.g., 2d6, 1d20 + 4)")
        .setDescriptionLocalizations(localized('fun.slash.fun.sub.roll.options.notation'))
        .setRequired(true)
        .setMaxLength(50),
    ),
  category: 'Fun',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);

    const notation = interaction.options
      .getString("notation")
      .toLowerCase()
      .replace(/\s/g, "");

    // Errors are private answers (the user's language); the result is a public reply (the server's).
    const err = replyText(interaction);
    const match = notation.match(/^(\d*)d(\d+)([\+\-]\d+)?$/);

    if (!match) {
      throw new TitanBotError(
        `Invalid dice notation: ${notation}`,
        ErrorTypes.USER_INPUT,
        err.t('fun.roll.invalid')
      );
    }

    const numDice = parseInt(match[1] || "1", 10);
    const numSides = parseInt(match[2], 10);
    const modifier = parseInt(match[3] || "0", 10);

    if (numDice < 1 || numDice > 20) {
      throw new TitanBotError(
        `Too many dice requested: ${numDice}`,
        ErrorTypes.VALIDATION,
        err.t('fun.roll.diceRange')
      );
    }

    if (numSides < 1 || numSides > 1000) {
      throw new TitanBotError(
        `Invalid number of sides: ${numSides}`,
        ErrorTypes.VALIDATION,
        err.t('fun.roll.sidesRange')
      );
    }

    let rolls = [];
    let totalRoll = 0;

    for (let i = 0; i < numDice; i++) {
      const roll = Math.floor(Math.random() * numSides) + 1;
      rolls.push(roll);
      totalRoll += roll;
    }

    const finalTotal = totalRoll + modifier;

    const tr = publicText(interaction);
    const resultsDetail =
      numDice > 1 ? tr.t('fun.roll.rolls', { rolls: rolls.join(" + ") }) : "";
    const modifierText = modifier !== 0 ? `+ (${modifier})` : "";

    const embed = successEmbed(
      tr.t('fun.roll.title', { dice: `${numDice}d${numSides}${modifier !== 0 ? match[3] : ""}` }),
      `${resultsDetail}${tr.t('fun.roll.total', { total: `${totalRoll}${modifierText}`, final: finalTotal })}`,
    );

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    logger.debug(`Roll command executed by user ${interaction.user.id} with notation ${notation} in guild ${interaction.guildId}`);
  },
};