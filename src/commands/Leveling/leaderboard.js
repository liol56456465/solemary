import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getLeaderboard, getLevelingConfig, getXpForLevel } from '../../services/leveling/leveling.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botText, textForInteraction } from '../../utils/botText.js';
import { describe } from '../../utils/commandLocalizations.js';
/**
 * The reply for one leaderboard page. An empty page (nobody has XP yet, or a page past the
 * end) is a normal notice: before, it was thrown as a DATABASE error and showed a
 * "Database Error" embed with an error reference, although the database was fine.
 */
export function buildLeaderboardReply(leaderboard, { page, offset, lang = 'en' }) {
  const tr = botText(lang);
  if (leaderboard.length === 0) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor('#f1c40f')
          .setDescription(page > 1
            ? tr.t('leveling.leaderboard.emptyPage', { page })
            : tr.t('leveling.leaderboard.empty'))
      ]
    };
  }

  // getLeaderboard already resolved the page's members; a mention needs no lookup.
  const leaderboardText = leaderboard.map((user) =>
    tr.t('leveling.leaderboard.line', { rank: user.rank, userId: user.userId, level: user.level, xp: user.xp, needed: getXpForLevel(user.level) }));

  const embed = new EmbedBuilder()
    .setTitle(tr.t('leveling.leaderboard.title'))
    .setColor('#2ecc71')
    .setDescription(page > 1
      ? tr.t('leveling.leaderboard.ranks', { from: offset + 1, to: offset + leaderboard.length })
      : tr.t('leveling.leaderboard.top'))
    .addFields({ name: tr.t('leveling.leaderboard.rankings'), value: leaderboardText.join('\n') })
    .setTimestamp();
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

export default {
  data: describe(new SlashCommandBuilder().setName('leaderboard'), 'leveling.cmd.leaderboard.description')
    .addIntegerOption(option =>
      describe(option.setName('page'), 'leveling.cmd.leaderboard.page')
        .setMinValue(1)
        .setMaxValue(50)
        .setRequired(false))
    .setDMPermission(false),
  category: 'Leveling',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);
    // Posted in the channel: the server's language.
    const pub = textForInteraction(interaction, { purpose: 'public' });

    const levelingConfig = await getLevelingConfig(client, interaction.guildId);

    if (!levelingConfig?.enabled) {
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setColor('#f1c40f')
            .setDescription(pub.t('leveling.disabled'))
        ],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const pageSize = 10;
    const page = interaction.options.getInteger?.('page') ?? 1;
    const offset = (page - 1) * pageSize;
    const leaderboard = await getLeaderboard(client, interaction.guildId, pageSize, offset);

    await InteractionHelper.safeEditReply(interaction, buildLeaderboardReply(leaderboard, { page, offset, lang: pub.lang }));
    logger.debug(`Leaderboard displayed for guild ${interaction.guildId}`);
  }
};