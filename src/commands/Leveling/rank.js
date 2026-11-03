import { SlashCommandBuilder, EmbedBuilder, MessageFlags, escapeMarkdown } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getUserLevelData, getLevelingConfig, getXpForLevel } from '../../services/leveling/leveling.js';
import { TOTAL_MULTIPLIER_CAP, xpBoostBreakdown } from '../../services/leveling/levelBoosts.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { hasAdministrator } from '../../utils/commandGate.js';
import { isBotOwner } from '../../config/bot.js';
import { CARD_FILE_NAME, cardAvatarUrl, tryLevelCard } from '../../services/leveling/levelCard.js';

/**
 * "x2 (role Booster) in <#channel>" for an xpBoostBreakdown result, or null. With more than
 * one source each shows its own multiplier. roleName = the boosting role's name. Pure.
 */
export function xpBoostLine(boost, { hereId = null, roleName = null } = {}) {
  if (!boost || !(boost.multiplier > 1)) return null;
  const sources = [];
  if (boost.role > 1) sources.push([`role ${roleName ? escapeMarkdown(roleName) : 'boost'}`, boost.role]);
  if (boost.channel > 1) sources.push(['channel boost', boost.channel]);
  if (boost.global > 1) sources.push(['server-wide', boost.global]);
  const parts = sources.length > 1 ? sources.map(([label, value]) => `${label} x${value}`) : sources.map(([label]) => label);
  if (boost.capped) parts.push(`capped at x${TOTAL_MULTIPLIER_CAP}`);
  const where = hereId ? ` in <#${hereId}>` : '';
  return `x${boost.multiplier}${parts.length ? ` (${parts.join(', ')})` : ''}${where}`;
}

/**
 * The member's XP boost where the command was run (a thread counts as its parent), or null.
 * Also null where the member earns no XP at all (ignored channel or role, blacklisted), the
 * same checks messageCreate makes before it gives XP.
 */
export function rankBoostLine(levelingConfig, member, channel) {
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
  return xpBoostLine(boost, { hereId: channel?.id ?? null, roleName });
}

export default {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription("Check your or another user's rank and level")
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to check the rank of')
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName('card')
        .setDescription('Show the rank as an image card')
        .setRequired(false)
    )
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

    const targetUser = interaction.options.getUser('user') || interaction.user;
    // Everyone may check their own rank; other members' ranks are admin-only (commandAccess.js).
    if (targetUser.id !== interaction.user.id
      && !isBotOwner(interaction.user.id)
      && !hasAdministrator({ guild: interaction.guild, userId: interaction.user.id, permissions: interaction.memberPermissions })) {
      throw new TitanBotError(
        `Non-admin ${interaction.user.id} tried to view rank of ${targetUser.id}`,
        ErrorTypes.PERMISSION,
        'Only admins can check another member\'s rank. Use `/rank` without a user to see your own.'
      );
    }
    const member = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (!member) {
      throw new TitanBotError(
        `User ${targetUser.id} not found in guild`,
        ErrorTypes.USER_INPUT,
        'Could not find the specified user in this server.'
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
    if (interaction.options.getBoolean('card') === true) {
      const png = await tryLevelCard({
        avatarUrl: cardAvatarUrl(member.user),
        name: member.displayName,
        serverName: interaction.guild.name,
        level: safeUserData.level,
        xp: safeUserData.xp,
        xpNeeded: safeUserData.level >= 1000 ? 0 : xpNeeded,
        accent: levelingConfig.cardAccent,
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
      .setTitle(`${member.displayName}'s rank`)
      .setThumbnail(member.displayAvatarURL({ dynamic: true }))
      .addFields(
        {
          name: 'Level',
          value: safeUserData.level.toString(),
          inline: true
        },
        {
          name: 'XP',
          value: `${safeUserData.xp}/${xpNeeded}`,
          inline: true
        },
        {
          name: 'Total XP',
          value: safeUserData.totalXp.toString(),
          inline: true
        },
        {
          name: `Progress to Level ${safeUserData.level + 1}`,
          value: `${progressBar} ${progress}%`
        }
      )
      .setColor('#2ecc71')
      .setTimestamp();

    // Shown only when the member's boost here is above x1 (the same math as messageCreate).
    const boostLine = rankBoostLine(levelingConfig, member, interaction.channel);
    if (boostLine) embed.addFields({ name: 'XP boost', value: boostLine });

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