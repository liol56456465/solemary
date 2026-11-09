import { SlashCommandBuilder, EmbedBuilder, MessageFlags, escapeMarkdown } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getUserLevelData, getLevelingConfig, getXpForLevel } from '../../services/leveling/leveling.js';
import { TOTAL_MULTIPLIER_CAP, xpBoostBreakdown } from '../../services/leveling/levelBoosts.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { hasAdministrator } from '../../utils/commandGate.js';
import { hasOwnerPower } from '../../utils/ownerPower.js';
import { CARD_FILE_NAME, cardAvatarUrl, tryLevelCard } from '../../services/leveling/levelCard.js';
import { botText, textForInteraction } from '../../utils/botText.js';
import { describe } from '../../utils/commandLocalizations.js';
import { readVoiceStats } from '../../services/leveling/voiceStore.js';
import { voiceConfigOf } from '../../services/leveling/voiceConfig.js';
import { voiceTimeValue } from '../../services/leveling/voiceText.js';

/**
 * "x2 (role Booster) in <#channel>" for an xpBoostBreakdown result, or null. With more than
 * one source each shows its own multiplier. roleName = the boosting role's name. lang = the
 * reply's language (default English). Pure.
 */
export function xpBoostLine(boost, { hereId = null, roleName = null, lang = 'en' } = {}) {
  if (!boost || !(boost.multiplier > 1)) return null;
  const tr = botText(lang);
  const sources = [];
  if (boost.role > 1) sources.push([roleName ? tr.t('leveling.boost.role', { name: escapeMarkdown(roleName) }) : tr.t('leveling.boost.roleUnnamed'), boost.role]);
  if (boost.channel > 1) sources.push([tr.t('leveling.boost.channel'), boost.channel]);
  if (boost.global > 1) sources.push([tr.t('leveling.boost.global'), boost.global]);
  const parts = sources.length > 1 ? sources.map(([label, value]) => `${label} x${value}`) : sources.map(([label]) => label);
  if (boost.capped) parts.push(tr.t('leveling.boost.capped', { cap: TOTAL_MULTIPLIER_CAP }));
  const where = hereId ? tr.t('leveling.boost.where', { channelId: hereId }) : '';
  return `x${boost.multiplier}${parts.length ? ` (${parts.join(', ')})` : ''}${where}`;
}

/**
 * The member's XP boost where the command was run (a thread counts as its parent), or null.
 * Also null where the member earns no XP at all (ignored channel or role, blacklisted), the
 * same checks messageCreate makes before it gives XP.
 */
export function rankBoostLine(levelingConfig, member, channel, { lang = 'en' } = {}) {
  const roleIds = member?.roles?.cache ? [...member.roles.cache.keys()] : [];
  if (channel?.id && levelingConfig?.ignoredChannels?.includes(channel.id)) return null;
  if (levelingConfig?.ignoredRoles?.length && roleIds.some((id) => levelingConfig.ignoredRoles.includes(id))) return null;
  if (member?.id && levelingConfig?.blacklistedUsers?.includes(member.id)) return null;
  const boost = xpBoostBreakdown(levelingConfig, {
    channelId: channel?.id ?? null,
    threadParentId: channel?.isThread?.() ? channel.parentId : null,
    roleIds,
  });
  if (!boost) return null;
  const roleName = boost.roleId ? member.roles.cache.get(boost.roleId)?.name ?? null : null;
  return xpBoostLine(boost, { hereId: channel?.id ?? null, roleName, lang });
}

export default {
  data: describe(new SlashCommandBuilder().setName('rank'), 'leveling.cmd.rank.description')
    .addUserOption((option) =>
      describe(option.setName('user'), 'leveling.cmd.rank.user')
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      describe(option.setName('card'), 'leveling.cmd.rank.card')
        .setRequired(false)
    )
    .setDMPermission(false),
  category: 'Leveling',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);
    // The rank is posted in the channel (server language); refusals go to the user (their language).
    const pub = textForInteraction(interaction, { purpose: 'public' });
    const tr = textForInteraction(interaction);

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

    const targetUser = interaction.options.getUser('user') || interaction.user;
    // Everyone may check their own rank; other members' ranks are admin-only (commandAccess.js).
    if (targetUser.id !== interaction.user.id
      && !hasOwnerPower(interaction.user.id, interaction.guildId)
      && !hasAdministrator({ guild: interaction.guild, userId: interaction.user.id, permissions: interaction.memberPermissions })) {
      throw new TitanBotError(
        `Non-admin ${interaction.user.id} tried to view rank of ${targetUser.id}`,
        ErrorTypes.PERMISSION,
        tr.t('leveling.rank.othersAdminOnly')
      );
    }
    const member = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (!member) {
      throw new TitanBotError(
        `User ${targetUser.id} not found in guild`,
        ErrorTypes.USER_INPUT,
        tr.t('leveling.notFound')
      );
    }

    const userData = await getUserLevelData(client, interaction.guildId, targetUser.id);

    const safeUserData = {
      level: userData?.level ?? 0,
      xp: userData?.xp ?? 0,
      totalXp: userData?.totalXp ?? 0
    };

    // addXp levels a user up once xp reaches getXpForLevel(currentLevel).
    const xpNeeded = getXpForLevel(safeUserData.level);

    // card:true → the image card (same look as the level-up card). If it can't be made
    // right now (busy or an error), the embed below is shown instead.
    if (interaction.options.getBoolean?.('card') === true) {
      const png = await tryLevelCard({
        avatarUrl: cardAvatarUrl(member.user),
        name: member.displayName,
        altName: member.user?.username,
        serverName: interaction.guild.name,
        level: safeUserData.level,
        xp: safeUserData.xp,
        xpNeeded: safeUserData.level >= 1000 ? 0 : xpNeeded,
        accent: levelingConfig.cardAccent,
        lang: pub.lang,
      });
      if (png) {
        await InteractionHelper.safeEditReply(interaction, { files: [{ attachment: png, name: CARD_FILE_NAME }], allowedMentions: { parse: [] } });
        logger.debug(`Rank card shown for user ${targetUser.id} in guild ${interaction.guildId}`);
        return;
      }
    }
    const progress = xpNeeded > 0 ? Math.floor((safeUserData.xp / xpNeeded) * 100) : 0;
    const progressBar = createProgressBar(progress, 20);

    const embed = new EmbedBuilder()
      .setTitle(pub.t('leveling.rank.title', { name: member.displayName }))
      .setThumbnail(member.displayAvatarURL({ dynamic: true }))
      .addFields(
        {
          name: pub.t('leveling.rank.level'),
          value: safeUserData.level.toString(),
          inline: true
        },
        {
          name: pub.t('leveling.rank.xp'),
          value: `${safeUserData.xp}/${xpNeeded}`,
          inline: true
        },
        {
          name: pub.t('leveling.rank.totalXp'),
          value: safeUserData.totalXp.toString(),
          inline: true
        },
        {
          name: pub.t('leveling.rank.progress', { level: safeUserData.level + 1 }),
          value: `${progressBar} ${progress}%`
        }
      )
      .setColor('#2ecc71')
      .setTimestamp();

    // Shown only when the member's boost here is above x1 (the same math as messageCreate).
    const boostLine = rankBoostLine(levelingConfig, member, interaction.channel, { lang: pub.lang });
    if (boostLine) embed.addFields({ name: pub.t('leveling.rank.boost'), value: boostLine });

    // Voice time (Voice XP): an extra line; if it can't be read it is left out, never shown as 0.
    const voiceStats = await readVoiceStats(interaction.guildId, targetUser.id).then((stats) => ({ stats }), (error) => {
      logger.warn(`/rank: voice time not available: ${error.message}`);
      return null;
    });
    const voiceValue = voiceStats ? voiceTimeValue(voiceStats.stats, voiceConfigOf(levelingConfig).enabled, pub.lang) : null;
    if (voiceValue) embed.addFields({ name: pub.t('leveling.rank.voice'), value: voiceValue, inline: true });

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
    logger.debug(`Rank checked for user ${targetUser.id} in guild ${interaction.guildId}`);
  }
};

function createProgressBar(percentage, length = 10) {
  if (percentage < 0 || percentage > 100) {
    percentage = Math.max(0, Math.min(100, percentage));
  }
  const filled = Math.round((percentage / 100) * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}