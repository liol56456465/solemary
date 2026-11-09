import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { localized, publicText } from '../../../utils/commandLocalizations.js';
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const EMBED_DESCRIPTION_LIMIT = 4096;

export default {
    data: new SlashCommandBuilder()
    .setName("fight")
    .setDescription("Starts a simulated 1v1 text-based battle.")
    .addUserOption((option) =>
      option
        .setName("opponent")
        .setDescription("The user to fight.")
        .setDescriptionLocalizations(localized('fun.slash.fun.sub.fight.options.opponent'))
        .setRequired(true),
    ),
  category: 'Fun',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);

    // A public reply (the defer is public): the server's language.
    const tr = publicText(interaction);
    const challenger = interaction.user;
    const opponent = interaction.options.getUser("opponent");

    if (challenger.id === opponent.id) {
      const embed = warningEmbed(
        tr.t('fun.fight.selfTitle'),
        tr.t('fun.fight.selfText', { name: challenger.username })
      );
      return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }

    if (opponent.bot) {
      const embed = warningEmbed(
        tr.t('fun.fight.botTitle'),
        tr.t('fun.fight.botText')
      );
      return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }

    const winner = rand(0, 1) === 0 ? challenger : opponent;
    const loser = winner.id === challenger.id ? opponent : challenger;
    const rounds = rand(3, 7);
    const damage = rand(10, 50);

    const log = [];
    log.push(
      tr.t('fun.fight.start', { challenger: challenger.username, opponent: opponent.username, rounds }),
    );

    for (let i = 1; i <= rounds; i++) {
      const attacker = rand(0, 1) === 0 ? challenger : opponent;
      const target = attacker.id === challenger.id ? opponent : challenger;
      const action = [
        'fun.fight.action.punch',
        'fun.fight.action.critical',
        'fun.fight.action.spell',
        'fun.fight.action.parry',
      ][rand(0, 3)];
      log.push(
        `\n${tr.t(action, { round: i, attacker: attacker.username, target: target.username, damage: rand(1, damage) })}`,
      );
    }

    const outcomeText = log.join("\n");
    const winnerText = tr.t('fun.fight.winner', { winner: winner.username, loser: loser.username });
    const fullDescription = `${outcomeText}\n\n${winnerText}`;

    const description = fullDescription.length <= EMBED_DESCRIPTION_LIMIT
      ? fullDescription
      : `${fullDescription.slice(0, EMBED_DESCRIPTION_LIMIT - 15)}\n\n...`;

    const embed = successEmbed(
      tr.t('fun.fight.title'),
      description
    );

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    logger.debug(`Fight command executed between ${challenger.id} and ${opponent.id} in guild ${interaction.guildId}`);
  },
};