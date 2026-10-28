import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getLeaderboard, getLevelingConfig, getXpForLevel } from '../../services/leveling/leveling.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription("Shows the server's level leaderboard")
    .addIntegerOption(option =>
      option
        .setName('page')
        .setDescription('Page to show (10 members per page)')
        .setMinValue(1)
        .setRequired(false))
    .setDMPermission(false),
  category: 'Leveling',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);

    const levelingConfig = await getLevelingConfig(client, interaction.guildId);

    if (!levelingConfig?.enabled) {
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setColor('#f1c40f')
            .setDescription('The leveling system is currently disabled on this server.')
        ],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const pageSize = 10;
    const page = interaction.options.getInteger?.('page') ?? 1;
    const offset = (page - 1) * pageSize;
    const leaderboard = await getLeaderboard(client, interaction.guildId, pageSize, offset);

    if (leaderboard.length === 0) {
      throw new TitanBotError(
        'No leaderboard data found',
        ErrorTypes.DATABASE,
        page > 1 ? `There are no members on page ${page} of the leaderboard.` : 'No level data found yet. Start chatting to gain XP!'
      );
    }

    const embed = new EmbedBuilder()
      .setTitle('Level Leaderboard')
      .setColor('#2ecc71')
      .setDescription(page > 1
        ? `Ranks ${offset + 1}-${offset + leaderboard.length} in this server:`
        : "Top 10 most active members in this server:")
      .setTimestamp();

    // getLeaderboard already resolved the page's members; a mention needs no lookup.
    const leaderboardText = leaderboard.map((user) => {
      const xpForNextLevel = getXpForLevel(user.level);

      let rankPrefix;
      if (user.rank === 1) rankPrefix = '🥇';
      else if (user.rank === 2) rankPrefix = '🥈';
      else if (user.rank === 3) rankPrefix = '🥉';
      else rankPrefix = `**${user.rank}.**`;

      return `${rankPrefix} <@${user.userId}> - Level ${user.level} (${user.xp}/${xpForNextLevel} XP)`;
    });

    embed.addFields({
      name: 'Rankings',
      value: leaderboardText.join('\n')
    });

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    logger.debug(`Leaderboard displayed for guild ${interaction.guildId}`);
  }
};