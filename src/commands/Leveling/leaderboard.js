import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getLeaderboard, getLevelingConfig, getXpForLevel } from '../../services/leveling/leveling.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
/**
 * The reply for one leaderboard page. An empty page (nobody has XP yet, or a page past the
 * end) is a normal notice: before, it was thrown as a DATABASE error and showed a
 * "Database Error" embed with an error reference, although the database was fine.
 */
export function buildLeaderboardReply(leaderboard, { page, offset }) {
  if (leaderboard.length === 0) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor('#f1c40f')
          .setDescription(page > 1
            ? `There are no members on page ${page} of the leaderboard.`
            : 'Nobody has any XP yet. Chat a bit and check back.')
      ]
    };
  }

  // getLeaderboard already resolved the page's members; a mention needs no lookup.
  const leaderboardText = leaderboard.map((user) =>
    `**${user.rank}.** <@${user.userId}> - Level ${user.level} (${user.xp}/${getXpForLevel(user.level)} XP)`);

  const embed = new EmbedBuilder()
    .setTitle('Level Leaderboard')
    .setColor('#2ecc71')
    .setDescription(page > 1
      ? `Ranks ${offset + 1}-${offset + leaderboard.length} in this server:`
      : 'Top 10 in this server:')
    .addFields({ name: 'Rankings', value: leaderboardText.join('\n') })
    .setTimestamp();
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription("Shows the server's level leaderboard")
    .addIntegerOption(option =>
      option
        .setName('page')
        .setDescription('Page to show (10 members per page)')
        .setMinValue(1)
        .setMaxValue(50)
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

    await InteractionHelper.safeEditReply(interaction, buildLeaderboardReply(leaderboard, { page, offset }));
    logger.debug(`Leaderboard displayed for guild ${interaction.guildId}`);
  }
};