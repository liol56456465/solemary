// xpSystem.js

import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getXpForLevel, getUserLevelData, saveUserLevelData } from './leveling.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';
import { Mutex } from '../../utils/mutex.js';
import { wrapServiceBoundary } from '../../utils/errorHandler.js';
import { applyRoleRulesToMember } from '../members/roleRuleService.js';
import { syncLevelRolesForMember } from './levelRoleSyncService.js';
import { CARD_FILE_NAME, cardAvatarUrl, tryLevelCard } from './levelCard.js';

/**
 * Award XP to a member. Returns null when XP is skipped (disabled/invalid amount).
 * Throws on storage or unexpected failures.
 */
export const addXp = wrapServiceBoundary(async function addXp(client, guild, member, xpToAdd) {
  const lockKey = `leveling:${guild.id}:${member.user.id}`;
  // The level-up post is sent after the level is saved and the lock is released, so a slow
  // card (avatar fetch, upload) never delays the save or other XP for this member.
  let announcement = null;
  const result = await Mutex.runExclusive(lockKey, async () => {
    if (!xpToAdd || xpToAdd <= 0) {
      return null;
    }

    const config = await getLevelingConfig(client, guild.id);

    if (!config.enabled) {
      return null;
    }

    const levelData = await getUserLevelData(client, guild.id, member.user.id);

    levelData.xp += xpToAdd;
    levelData.totalXp += xpToAdd;
    levelData.lastMessage = Date.now();

    let xpNeededForNextLevel = getXpForLevel(levelData.level);
    let didLevelUp = false;
    const initialLevel = levelData.level;

    while (levelData.xp >= xpNeededForNextLevel && levelData.level < 1000) {
      levelData.xp -= xpNeededForNextLevel;
      levelData.level += 1;
      didLevelUp = true;
      xpNeededForNextLevel = getXpForLevel(levelData.level);

      logger.info(`🎉 ${member.user.tag} leveled up to level ${levelData.level} in ${guild.name}`);

    }

    if (didLevelUp) {
      try {
        await logEvent({
          client,
          guildId: guild.id,
          eventType: EVENT_TYPES.LEVELING_LEVELUP,
          data: {
            title: 'Level Up',
            lines: [
              formatLogLine('Member', `${member.user.tag} (\`${member.user.id}\`)`),
              formatLogLine('New Level', levelData.level.toString()),
              formatLogLine('Levels Gained', (levelData.level - initialLevel).toString()),
              formatLogLine('Total XP', levelData.totalXp.toString()),
            ],
            userId: member.user.id,
          },
        });
      } catch (logError) {
        logger.debug('Failed to log leveling event:', logError.message);
      }
    }

    await saveUserLevelData(client, guild.id, member.user.id, levelData);

    // Reward roles after the level is saved: "keep all" adds every earned role, "highest only"
    // adds the top one and takes off lower ones. Never throws for Discord errors.
    if (didLevelUp && config.roleRewards && Object.keys(config.roleRewards).length > 0) {
      await syncLevelRolesForMember(client, member, {
        config,
        level: levelData.level,
        reason: `Level ${levelData.level} reward`,
      }).catch((error) => {
        logger.warn(`Level reward roles not synced for ${member.user.id} in guild ${guild.id}: ${error.message}`);
      });
    }

    // Role rules with a level trigger (dashboard Members); the 10-minute run catches up on a miss.
    if (didLevelUp) {
      await applyRoleRulesToMember(member, { triggers: ['level_reached'], level: levelData.level }).catch((error) => {
        logger.warn(`Role rules not applied to ${member.user.id} after level-up: ${error.message}`);
      });
    }

    if (didLevelUp && config.announceLevelUp) {
      announcement = { levelData: { ...levelData }, config };
    }

    return {
      level: levelData.level,
      xp: levelData.xp,
      totalXp: levelData.totalXp,
      xpNeeded: getXpForLevel(levelData.level),
      leveledUp: didLevelUp,
    };
  });
  if (announcement) {
    await sendLevelUpAnnouncement(guild, member, announcement.levelData, announcement.config);
  }
  return result;
}, {
  service: 'xpSystem',
  operation: 'addXp',
  userMessage: 'Failed to award XP. Please try again.',
});

/**
 * The level-up card PNG when the server turned cards on and the bot may attach files there,
 * else null (the plain text line is sent). Never throws.
 */
export async function levelUpCardFor(guild, member, levelData, config, permissions, makeCard = tryLevelCard) {
  try {
    if (config?.levelUpCard !== true) return null;
    if (!permissions?.has?.('AttachFiles')) return null;
    return await makeCard({
      avatarUrl: cardAvatarUrl(member.user),
      name: member.displayName || member.user?.username,
      serverName: guild.name,
      level: levelData.level,
      xp: levelData.xp,
      xpNeeded: levelData.level >= 1000 ? 0 : getXpForLevel(levelData.level),
      accent: config.cardAccent,
    });
  } catch {
    return null;
  }
}

export async function sendLevelUpAnnouncement(guild, member, levelData, config, { makeCard } = {}) {
  try {
    const levelUpChannel = config.levelUpChannel
      ? guild.channels.cache.get(config.levelUpChannel)
      : guild.systemChannel;

    if (!levelUpChannel || !levelUpChannel.isTextBased()) {
      return;
    }

    const permissions = levelUpChannel.permissionsFor(guild.members.me);
    if (!permissions || !permissions.has(['SendMessages', 'EmbedLinks'])) {
      logger.warn(`Missing permissions to send levelup message in ${levelUpChannel.id}`);
      return;
    }

    const message = config.levelUpMessage
      .replace(/{user}/g, member.toString())
      .replace(/{level}/g, levelData.level)
      .replace(/{xp}/g, levelData.xp)
      .replace(/{xpNeeded}/g, getXpForLevel(levelData.level));

    const card = await levelUpCardFor(guild, member, levelData, config, permissions, makeCard);
    if (card) {
      // Same mentions as the text line. If the send with the card fails, the text line is sent.
      const sent = await levelUpChannel.send({ content: message, allowedMentions: { parse: ['users'] }, files: [{ attachment: card, name: CARD_FILE_NAME }] })
        .then(() => true)
        .catch((error) => {
          // Only a clear refusal from Discord (4xx) means nothing was posted. On a network error
          // or timeout the card may have gone through, so no second post (no duplicate).
          const refused = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
          logger.warn(`Level-up card not sent in channel ${levelUpChannel.id}${refused ? ', sending text' : ''}: ${error.message}`);
          return refused ? false : null;
        });
      if (sent !== false) return;
    }

    // The template documents {user} and {level} only: ping the member, never a role or @everyone.
    await levelUpChannel.send({ content: message, allowedMentions: { parse: ['users'] } }).catch(error => {
      logger.error(`Failed to send level up message in channel ${levelUpChannel.id}:`, error);
    });
  } catch (error) {
    logger.error('Error sending level up announcement:', error);
  }
}
