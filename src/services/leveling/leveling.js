// leveling.js

import { EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { updateGuildConfigAtomic } from '../../utils/database/guildConfigStorage.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { addXp } from './xpSystem.js';
import { getUserLevelKey, getUserLevelPrefix } from '../../utils/database/keys.js';

const BASE_XP = 100;
const XP_MULTIPLIER = 1.5;
const MAX_LEVEL = 1000;
const MIN_LEVEL = 0;

export function getXpForLevel(level) {
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) {
    throw new TitanBotError(
      `Invalid level: ${level}. Must be between ${MIN_LEVEL} and ${MAX_LEVEL}`,
      ErrorTypes.VALIDATION,
      'The level must be a valid number.'
    );
  }
  return 5 * Math.pow(level, 2) + 50 * level + 50;
}

export function getLevelFromXp(xp) {
  if (!Number.isInteger(xp) || xp < 0) {
    throw new TitanBotError(
      `Invalid XP: ${xp}`,
      ErrorTypes.VALIDATION,
      'XP must be a non-negative number.'
    );
  }

  let level = 0;
  let xpNeeded = 0;
  
  while (xp >= getXpForLevel(level) && level < MAX_LEVEL) {
    xpNeeded = getXpForLevel(level);
    xp -= xpNeeded;
    level++;
  }
  
  return {
    level: Math.min(level, MAX_LEVEL),
    currentXp: xp,
    xpNeeded: getXpForLevel(Math.min(level, MAX_LEVEL))
  };
}

export function calculateTotalXp(level, currentXp = 0) {
  let total = currentXp;
  for (let i = 0; i < level; i++) {
    total += getXpForLevel(i);
  }
  return total;
}

/** Orders level rows the way the leaderboard shows them and cuts out one page. */
export function rankLevelRows(rows, limit = 10, offset = 0) {
  return rows
    .filter(row => row && (row.totalXp > 0 || row.level > 0))
    .sort((a, b) =>
      (b.level - a.level) ||
      (b.totalXp - a.totalXp) ||
      (b.xp - a.xp) ||
      String(a.userId).localeCompare(String(b.userId))
    )
    .slice(offset, offset + limit)
    .map((row, index) => ({ ...row, rank: offset + index + 1 }));
}

// Memory-store fallback: no SQL there, so read every level key for the guild.
async function readAllLevelRows(client, guildId) {
  const prefix = getUserLevelPrefix(guildId);
  const keys = await client.db.list(prefix);
  const rows = await Promise.all(keys.map(async key => {
    const data = await client.db.get(key);
    if (!data) return null;
    return {
      userId: key.slice(prefix.length),
      xp: data.xp || 0,
      level: data.level || 0,
      totalXp: data.totalXp || 0
    };
  }));
  return rows.filter(Boolean);
}

/**
 * One page of the guild leaderboard. On Postgres this is a single query against
 * user_levels; only the members on the page are looked up (cache first, then one
 * fetch for the rest). Users who left the guild keep their rank and show by ID.
 */
export async function getLeaderboard(client, guildId, limit = 10, offset = 0) {
  try {
    
    if (!guildId || typeof guildId !== 'string') {
      throw new TitanBotError(
        'Invalid guild ID',
        ErrorTypes.VALIDATION,
        'Guild ID is required.'
      );
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      limit = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 100);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      offset = 0;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      logger.warn(`Guild ${guildId} not found in cache`);
      return [];
    }

    const pg = client.db.rows?.();
    const page = typeof pg?.topUserLevels === 'function'
      ? (await pg.topUserLevels(guildId, limit, offset)).map((row, index) => ({ ...row, rank: offset + index + 1 }))
      : rankLevelRows(await readAllLevelRows(client, guildId), limit, offset);

    const missing = page.map(entry => entry.userId).filter(id => !guild.members.cache.has(id));
    if (missing.length > 0) {
      await guild.members.fetch({ user: missing }).catch(error => {
        logger.warn(`Failed to fetch leaderboard members for guild ${guildId}:`, error);
      });
    }

    return page.map(entry => {
      const user = guild.members.cache.get(entry.userId)?.user ?? client.users.cache.get(entry.userId);
      return {
        ...entry,
        username: user?.username ?? `Unknown user (${entry.userId})`,
        discriminator: user?.discriminator
      };
    });
    
  } catch (error) {
    logger.error('Error getting leaderboard:', error);
    if (error instanceof TitanBotError) throw error;
    throw new TitanBotError(
      `Failed to fetch leaderboard: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not fetch the leaderboard at this time.'
    );
  }
}

export function createLeaderboardEmbed(leaderboard, guild) {
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${guild.name} Leaderboard`)
    .setColor('#2ecc71')
    .setTimestamp();
    
  if (!leaderboard || leaderboard.length === 0) {
    embed.setDescription('No users on the leaderboard yet!');
    return embed;
  }
  
  const top3 = leaderboard.slice(0, 3);
  const rest = leaderboard.slice(3);
  
  const top3Text = top3.map((user, index) => {
    const medal = ['🥇', '🥈', '🥉'][index];
    return `${medal} **#${user.rank}** ${user.username} - Level ${user.level} (${user.totalXp} XP)`;
  }).join('\n');
  
  const restText = rest.map(user => {
    return `**#${user.rank}** ${user.username} - Level ${user.level} (${user.totalXp} XP)`;
  }).join('\n');
  
  embed.setDescription(
    `**Top Members**\n${top3Text}${restText ? '\n\n' + restText : ''}`
  );
  
  return embed;
}

// Leveling config as used when a guild has none saved yet.
function defaultLevelingConfig() {
  return {
    enabled: true,
    xpPerMessage: { min: 15, max: 25 },
    xpCooldown: 20,
    levelUpMessage: '{user} has leveled up to level {level}!',
    levelUpChannel: null,
    ignoredChannels: [],
    ignoredRoles: [],
    blacklistedUsers: [],
    roleRewards: {},
    announceLevelUp: true,
    xpMultiplier: 1
  };
}

export async function getLevelingConfig(client, guildId) {
  try {
    const guildConfig = await getGuildConfig(client, guildId);
    return guildConfig.leveling || defaultLevelingConfig();
  } catch (error) {
    logger.error(`Error getting leveling config for guild ${guildId}:`, error);
    throw error;
  }
}

export async function getUserLevelData(client, guildId, userId) {
  try {
    if (!guildId || !userId) {
      throw new TitanBotError(
        'Guild ID and User ID are required',
        ErrorTypes.VALIDATION
      );
    }

    const key = getUserLevelKey(guildId, userId);
    const data = await client.db.get(key);
    
    if (!data) {
      return {
        xp: 0,
        level: 0,
        totalXp: 0,
        lastMessage: 0,
        rank: 0
      };
    }
    
    return {
      xp: Math.max(0, data.xp || 0),
      level: Math.max(0, Math.min(data.level || 0, MAX_LEVEL)),
      totalXp: Math.max(0, data.totalXp || 0),
      lastMessage: data.lastMessage || 0,
      rank: data.rank || 0
    };
  } catch (error) {
    logger.error(`Error getting user level data for ${userId}:`, error);
    if (error instanceof TitanBotError) throw error;
    throw new TitanBotError(
      `Failed to fetch user data: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not fetch level data at this time.'
    );
  }
}

export async function saveUserLevelData(client, guildId, userId, data) {
  try {
    if (!guildId || !userId) {
      throw new TitanBotError(
        'Guild ID and User ID are required',
        ErrorTypes.VALIDATION
      );
    }

    if (!data || typeof data !== 'object') {
      throw new TitanBotError(
        'Invalid user level data',
        ErrorTypes.VALIDATION
      );
    }

    const sanitizedData = {
      xp: Math.max(0, Number(data.xp) || 0),
      level: Math.max(0, Math.min(Number(data.level) || 0, MAX_LEVEL)),
      totalXp: Math.max(0, Number(data.totalXp) || 0),
      lastMessage: Number(data.lastMessage) || 0,
      rank: Number(data.rank) || 0
    };

    const key = getUserLevelKey(guildId, userId);
    await client.db.set(key, sanitizedData);
  } catch (error) {
    logger.error(`Error saving user level data for ${userId}:`, error);
    if (error instanceof TitanBotError) throw error;
    throw new TitanBotError(
      `Failed to save user data: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not save level data at this time.'
    );
  }
}

function validationError(message, userMessage) {
  return new TitanBotError(message, ErrorTypes.VALIDATION, userMessage);
}

function assertLevelingConfigValid(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw validationError('Leveling config must be an object', 'Invalid leveling configuration.');
  }

  if (config.xpCooldown !== undefined && config.xpCooldown !== null) {
    if (typeof config.xpCooldown !== 'number' || !Number.isFinite(config.xpCooldown) || config.xpCooldown < 0 || config.xpCooldown > 3600) {
      throw validationError(
        'XP cooldown must be between 0 and 3600 seconds',
        'Cooldown must be between 0 and 3600 seconds.'
      );
    }
  }

  for (const field of ['xpRange', 'xpPerMessage']) {
    const range = config[field];
    if (range === undefined || range === null) continue;
    // Older stored configs may hold a plain number here; only ranges are checked.
    if (field === 'xpPerMessage' && typeof range !== 'object') continue;
    const ok = typeof range === 'object'
      && Number.isFinite(range.min) && Number.isFinite(range.max)
      && range.min >= 1 && range.max >= 1 && range.min <= range.max;
    if (!ok) {
      throw validationError(
        `Invalid XP range configuration (${field})`,
        'Minimum XP must be less than maximum XP, and both must be positive.'
      );
    }
  }
}

function wrapSaveError(error, guildId) {
  logger.error(`Error saving leveling config for guild ${guildId}:`, error);
  if (error instanceof TitanBotError) return error;
  return new TitanBotError(
    `Failed to save config: ${error.message}`,
    ErrorTypes.DATABASE,
    'Could not save configuration at this time.'
  );
}

function cloneConfig(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * Locked change of the stored leveling config: change(current) returns the new
 * leveling object. Runs inside the guild-config row lock so concurrent writers
 * (commands, web dashboard) can't overwrite each other's fields.
 */
async function mutateLevelingConfig(client, guildId, change) {
  let before;
  let after;
  await updateGuildConfigAtomic(client, guildId, async (current) => {
    const stored = current.leveling && typeof current.leveling === 'object'
      ? current.leveling
      : defaultLevelingConfig();
    before = cloneConfig(stored);
    const next = await change(cloneConfig(stored));
    after = cloneConfig(next);
    return { ...current, leveling: next };
  }, { operation: 'updateLevelingConfig' });
  return { before, after };
}

/**
 * Replaces the stored leveling config (kept for compatibility). Atomic: only the
 * leveling key is written, under the guild-config lock.
 */
export async function saveLevelingConfig(client, guildId, config) {
  try {
    if (!guildId || !config) {
      throw new TitanBotError(
        'Guild ID and config are required',
        ErrorTypes.VALIDATION
      );
    }
    assertLevelingConfigValid(config);
    await mutateLevelingConfig(client, guildId, () => ({ ...config }));
    logger.info(`Leveling config updated for guild ${guildId}`);
  } catch (error) {
    throw wrapSaveError(error, guildId);
  }
}

/**
 * Atomically merges `patch` into the stored leveling config (defaults when none
 * is stored). `roleRewards` in a patch replaces the whole map; use
 * setLevelRoleReward to change one level. Returns { before, after }.
 */
export async function updateLevelingConfig(client, guildId, patch) {
  try {
    if (!guildId || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw validationError('Guild ID and patch object are required', 'Invalid leveling configuration update.');
    }
    assertLevelingConfigValid(patch);
    const result = await mutateLevelingConfig(client, guildId, (current) => ({ ...current, ...cloneConfig(patch) }));
    logger.info(`Leveling config updated for guild ${guildId}`, { fields: Object.keys(patch) });
    return result;
  } catch (error) {
    throw wrapSaveError(error, guildId);
  }
}

/**
 * Atomically sets (roleId) or removes (roleId === null) the role reward for one
 * level, leaving the other rewards as stored. Returns { before, after }.
 */
export async function setLevelRoleReward(client, guildId, level, roleId) {
  try {
    const lvl = Number(level);
    if (!guildId || !Number.isInteger(lvl) || lvl < 1 || lvl > MAX_LEVEL) {
      throw validationError(`Invalid reward level: ${level}`, `Level must be a whole number between 1 and ${MAX_LEVEL}.`);
    }
    if (roleId !== null && !(typeof roleId === 'string' && /^\d{17,20}$/.test(roleId))) {
      throw validationError(`Invalid reward role id: ${roleId}`, 'The reward role is not a valid role.');
    }
    return await mutateLevelingConfig(client, guildId, (current) => {
      const roleRewards = { ...(current.roleRewards || {}) };
      if (roleId === null) {
        delete roleRewards[lvl];
      } else {
        roleRewards[lvl] = roleId;
      }
      return { ...current, roleRewards };
    });
  } catch (error) {
    throw wrapSaveError(error, guildId);
  }
}

export async function addLevels(client, guildId, userId, levels) {
  try {
    const levelingConfig = await getLevelingConfig(client, guildId);
    if (!levelingConfig?.enabled) {
      throw new TitanBotError(
        'Leveling system is disabled on this server',
        ErrorTypes.CONFIGURATION,
        'The leveling system is currently disabled on this server.'
      );
    }

    if (!Number.isInteger(levels) || levels <= 0) {
      throw new TitanBotError(
        `Invalid level amount: ${levels}`,
        ErrorTypes.VALIDATION,
        'You must add a positive number of levels.'
      );
    }

    const userData = await getUserLevelData(client, guildId, userId);
    const newLevel = userData.level + levels;

    if (newLevel > MAX_LEVEL) {
      throw new TitanBotError(
        `Level ${newLevel} exceeds maximum level ${MAX_LEVEL}`,
        ErrorTypes.VALIDATION,
        `Maximum level is ${MAX_LEVEL}.`
      );
    }

    const newXp = 0;
    const newTotalXp = calculateTotalXp(newLevel, newXp);

    userData.level = newLevel;
    userData.xp = newXp;
    userData.totalXp = newTotalXp;

    await saveUserLevelData(client, guildId, userId, userData);
    
    logger.info(`Added ${levels} levels to user ${userId} in guild ${guildId}`);
    return userData;
  } catch (error) {
    logger.error(`Error adding levels for user ${userId}:`, error);
    if (error instanceof TitanBotError) throw error;
    throw new TitanBotError(
      `Failed to add levels: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not add levels at this time.'
    );
  }
}

export async function removeLevels(client, guildId, userId, levels) {
  try {
    const levelingConfig = await getLevelingConfig(client, guildId);
    if (!levelingConfig?.enabled) {
      throw new TitanBotError(
        'Leveling system is disabled on this server',
        ErrorTypes.CONFIGURATION,
        'The leveling system is currently disabled on this server.'
      );
    }

    if (!Number.isInteger(levels) || levels <= 0) {
      throw new TitanBotError(
        `Invalid level amount: ${levels}`,
        ErrorTypes.VALIDATION,
        'You must remove a positive number of levels.'
      );
    }

    const userData = await getUserLevelData(client, guildId, userId);
    const newLevel = Math.max(MIN_LEVEL, userData.level - levels);

    const newXp = 0;
    const newTotalXp = calculateTotalXp(newLevel, newXp);

    userData.level = newLevel;
    userData.xp = newXp;
    userData.totalXp = newTotalXp;

    await saveUserLevelData(client, guildId, userId, userData);
    
    logger.info(`Removed ${levels} levels from user ${userId} in guild ${guildId}`);
    return userData;
  } catch (error) {
    logger.error(`Error removing levels for user ${userId}:`, error);
    if (error instanceof TitanBotError) throw error;
    throw new TitanBotError(
      `Failed to remove levels: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not remove levels at this time.'
    );
  }
}

export async function setUserLevel(client, guildId, userId, level) {
  try {
    const levelingConfig = await getLevelingConfig(client, guildId);
    if (!levelingConfig?.enabled) {
      throw new TitanBotError(
        'Leveling system is disabled on this server',
        ErrorTypes.CONFIGURATION,
        'The leveling system is currently disabled on this server.'
      );
    }

    if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
      throw new TitanBotError(
        `Invalid level: ${level}`,
        ErrorTypes.VALIDATION,
        `Level must be between ${MIN_LEVEL} and ${MAX_LEVEL}.`
      );
    }

    const userData = await getUserLevelData(client, guildId, userId);
    
    const newXp = 0;
    const newTotalXp = calculateTotalXp(level, newXp);

    userData.level = level;
    userData.xp = newXp;
    userData.totalXp = newTotalXp;

    await saveUserLevelData(client, guildId, userId, userData);
    
    logger.info(`Set level for user ${userId} to ${level} in guild ${guildId}`);
    return userData;
  } catch (error) {
    logger.error(`Error setting level for user ${userId}:`, error);
    if (error instanceof TitanBotError) throw error;
    throw new TitanBotError(
      `Failed to set level: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not set level at this time.'
    );
  }
}

export async function deleteUserLevelData(client, guildId, userId) {
  try {
    if (!guildId || !userId) {
      throw new TitanBotError(
        'Guild ID and User ID are required',
        ErrorTypes.VALIDATION
      );
    }

    const key = getUserLevelKey(guildId, userId);
    await client.db.delete(key);
    
    logger.debug(`Deleted level data for user ${userId} in guild ${guildId}`);
  } catch (error) {
    logger.error(`Error deleting level data for user ${userId}:`, error);
    if (error instanceof TitanBotError) throw error;
    logger.warn(`Could not delete level data for user ${userId} in guild ${guildId}`);
  }
}