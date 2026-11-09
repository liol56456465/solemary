import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getLeaderboard, getLevelingConfig, getXpForLevel } from '../../services/leveling/leveling.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botText, textForInteraction } from '../../utils/botText.js';
import { describe, descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { voiceConfigOf } from '../../services/leveling/voiceConfig.js';
import { voiceTimeText } from '../../services/leveling/voiceText.js';

/** type:voice → time in voice (Voice XP); type:xp (default) → level and XP. */
export const LEADERBOARD_TYPES = Object.freeze(['xp', 'voice']);
/**
 * The reply for one leaderboard page. An empty page (nobody has XP yet, or a page past the
 * end) is a normal notice: before, it was thrown as a DATABASE error and showed a
 * "Database Error" embed with an error reference, although the database was fine.
 */
export function buildLeaderboardReply(leaderboard, { page, offset, lang = 'en', type = 'xp', voiceEnabled = true }) {
  const tr = botText(lang);
  const voice = type === 'voice';
  if (leaderboard.length === 0) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor('#f1c40f')
          .setDescription(page > 1
            ? tr.t('leveling.leaderboard.emptyPage', { page })
            : voice
              ? tr.t(voiceEnabled ? 'leveling.leaderboard.voiceEmpty' : 'leveling.leaderboard.voiceOff')
              : tr.t('leveling.leaderboard.empty'))
      ]
    };
  }

  // getLeaderboard already resolved the page's members; a mention needs no lookup.
  const leaderboardText = leaderboard.map((user) => (voice
    ? tr.t('leveling.leaderboard.voiceLine', { rank: user.rank, userId: user.userId, time: voiceTimeText(user.voiceSeconds, tr.lang) })
    : tr.t('leveling.leaderboard.line', { rank: user.rank, userId: user.userId, level: user.level, xp: user.xp, needed: getXpForLevel(user.level) })));

  const embed = new EmbedBuilder()
    .setTitle(tr.t(voice ? 'leveling.leaderboard.voiceTitle' : 'leveling.leaderboard.title'))
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
    .addStringOption(option =>
      describe(option.setName('type'), 'leveling.cmd.leaderboard.type')
        .addChoices(
          { name: 'XP', name_localizations: descriptionLocalizations('leveling.cmd.leaderboard.typeXp'), value: 'xp' },
          { name: 'Voice time', name_localizations: descriptionLocalizations('leveling.cmd.leaderboard.typeVoice'), value: 'voice' },
        )
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
    const rawType = interaction.options.getString?.('type');
    const type = LEADERBOARD_TYPES.includes(rawType) ? rawType : 'xp';
    const leaderboard = await getLeaderboard(client, interaction.guildId, pageSize, offset, { type });

    await InteractionHelper.safeEditReply(interaction, buildLeaderboardReply(leaderboard, {
      page, offset, lang: pub.lang, type, voiceEnabled: voiceConfigOf(levelingConfig).enabled,
    }));
    logger.debug(`Leaderboard displayed for guild ${interaction.guildId}`);
  }
};