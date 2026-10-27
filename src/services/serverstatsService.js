// serverstatsService.js

import { ChannelType } from 'discord.js';
import { logger } from '../utils/logger.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';
import { getServerCountersKey } from '../utils/database/keys.js';
import botConfig from '../config/bot.js';

export const COUNTER_TYPE_CONFIG = {
  members: {
    label: 'Members + Bots',
    baseName: 'Members & Bots',
    emoji: '👥'
  },
  members_only: {
    label: 'Members Only',
    baseName: 'Members',
    emoji: '👤'
  },
  bots: {
    label: 'Bots Only',
    baseName: 'Bots',
    emoji: '🤖'
  }
};

function getCounterConfig(type) {
  return COUNTER_TYPE_CONFIG[type] || {
    label: 'Unknown',
    baseName: 'Counter',
    emoji: '❓'
  };
}

export function getCounterTypeLabel(type) {
  return getCounterConfig(type).label;
}

export function getCounterBaseName(type) {
  return getCounterConfig(type).baseName;
}

export function getCounterEmoji(type) {
  return getCounterConfig(type).emoji;
}

export function formatCounterChannelName(type, count) {
  const template = botConfig.counters?.defaults?.channelName || '{name}-{count}';
  const baseName = getCounterBaseName(type);
  return template
    .replaceAll('{name}', baseName)
    .replaceAll('{count}', String(count));
}

export function getCounterActionMessage(action, values = {}) {
  const template = botConfig.counters?.messages?.[action];
  if (!template) {
    return null;
  }

  return Object.entries(values).reduce(
    (message, [key, value]) => message.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export async function getGuildCounterStats(guild) {
  let memberCollection = guild.members.cache;

  try {
    memberCollection = await guild.members.fetch();
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      logger.debug(`Failed to fetch all guild members for ${guild.id}, using cache only`, error);
    }
  }

  const botCount = memberCollection.filter((member) => member.user.bot).size;
  const totalCount = typeof guild.memberCount === 'number' ? guild.memberCount : memberCollection.size;
  const humanCount = Math.max(totalCount - botCount, 0);

  return {
    totalCount,
    botCount,
    humanCount
  };
}

export async function getCounterCount(guild, type) {
  const stats = await getGuildCounterStats(guild);

  switch (type) {
    case 'members':
      return stats.totalCount;
    case 'bots':
      return stats.botCount;
    case 'members_only':
      return stats.humanCount;
    default:
      return null;
  }
}

function isValidCounterShape(counter) {
  return Boolean(
    counter &&
    typeof counter === 'object' &&
    typeof counter.id === 'string' &&
    counter.id.length > 0 &&
    typeof counter.type === 'string' &&
    typeof counter.channelId === 'string' &&
    counter.channelId.length > 0
  );
}

function normalizeCounter(counter, guildId) {
  const normalized = {
    id: String(counter.id),
    type: String(counter.type),
    channelId: String(counter.channelId),
    guildId: String(counter.guildId || guildId),
    createdAt: counter.createdAt || new Date().toISOString(),
    enabled: typeof counter.enabled === 'boolean' ? counter.enabled : true
  };

  if (counter.updatedAt) {
    normalized.updatedAt = counter.updatedAt;
  }

  return normalized;
}

function sanitizeCounters(counters, guildId) {
  if (!Array.isArray(counters)) {
    return [];
  }

  return counters
    .filter(isValidCounterShape)
    .map(counter => normalizeCounter(counter, guildId));
}

export async function updateCounter(client, guild, counter) {
  try {
    if (!counter || !counter.type || !counter.channelId) {
      logger.warn('Skipping invalid counter in updateCounter:', counter);
      return false;
    }
    
    const { type, channelId } = counter;
    let channel = guild.channels.cache.get(channelId);
    if (!channel) {
      try {
        channel = await guild.channels.fetch(channelId);
      } catch {
        channel = null;
      }
    }
    if (!channel) {
      logger.warn(`Counter channel ${channelId} not found in guild ${guild.id}, skipping update`);
      return false;
    }

    const count = await getCounterCount(guild, type);
    if (count === null) {
      logger.error('Unknown counter type:', type);
      return false;
    }

    const baseName = getCounterBaseName(type);
    if (process.env.NODE_ENV !== 'production') {
      logger.debug(`Base name: "${baseName}", Current name: "${channel.name}"`);
    }
    
    const newName = formatCounterChannelName(type, count);
    if (process.env.NODE_ENV !== 'production') {
      logger.debug(`New name would be: "${newName}"`);
    }
    
    if (channel.name !== newName) {
      try {
        await channel.setName(newName);
        if (process.env.NODE_ENV !== 'production') {
          logger.debug(`Updated channel name to: "${newName}"`);
        }

        try {
          await logEvent({
            client,
            guildId: guild.id,
            eventType: EVENT_TYPES.COUNTER_UPDATE,
            data: {
              title: 'Counter Updated',
              lines: [
                formatLogLine('Type', getCounterTypeLabel(type)),
                formatLogLine('Count', count.toString()),
                formatLogLine('Channel', channel.toString()),
              ],
              channelId: channel.id,
            },
          });
        } catch (error) {
          logger.debug('Error logging counter update:', error);
        }

      } catch (error) {
        logger.error(`Failed to update channel name for ${channel.id}:`, error);
        return false;
      }
    } else {
      if (process.env.NODE_ENV !== 'production') {
        logger.debug('Channel name already correct, no update needed');
      }
    }
    return true;
  } catch (error) {
    logger.error("Error updating counter:", error);
    return false;
  }
}

export async function getServerCounters(client, guildId) {
  try {
    if (!client || !client.db) {
      throw new Error('Database not available for getServerCounters');
    }
    
    const data = await client.db.get(getServerCountersKey(guildId));
    
    let counters = [];
    
    if (data && typeof data === 'object' && data.ok && Array.isArray(data.value)) {
      counters = data.value;
    } else if (Array.isArray(data)) {
      counters = data;
    } else if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        counters = Array.isArray(parsed) ? parsed : [];
      } catch {
        counters = [];
      }
    } else if (data && typeof data === 'object' && !data.ok && isValidCounterShape(data)) {
      counters = [data];
    } else {
      if (process.env.NODE_ENV !== 'production') {
        logger.debug('No counter data found, returning empty array');
      }
      return [];
    }

    return sanitizeCounters(counters, guildId);
  } catch (error) {
    logger.error("Error getting server counters:", error);
    throw error;
  }
}

export async function saveServerCounters(client, guildId, counters) {
  try {
    if (!client || !client.db) {
      throw new Error('Database not available for saveServerCounters');
    }
    
    const sanitizedCounters = sanitizeCounters(counters, guildId);

    if (process.env.NODE_ENV !== 'production') {
      logger.debug(`Saving ${sanitizedCounters.length} counters for guild ${guildId}:`, sanitizedCounters);
    }

    await client.db.set(getServerCountersKey(guildId), sanitizedCounters);
    if (process.env.NODE_ENV !== 'production') {
      logger.debug('Counters saved successfully');
    }
    return true;
  } catch (error) {
    logger.error("Error saving server counters:", error);
    throw error;
  }
}
/**
 * Locked read-modify-write of a guild's counters: change(counters) returns the new list
 * (or throws to abort). Resolves the saved (sanitized) list.
 */
export async function mutateServerCounters(client, guildId, change) {
  if (!client?.db?.update) {
    throw new Error('Database not available for mutateServerCounters');
  }
  let saved = [];
  await client.db.update(getServerCountersKey(guildId), async (raw) => {
    const current = sanitizeCounters(Array.isArray(raw) ? raw : (raw && Array.isArray(raw.value) ? raw.value : []), guildId);
    saved = sanitizeCounters(await change(current), guildId);
    return saved;
  }, []);
  return saved;
}

/**
 * Creates a counter (shared by /serverstats create and the web dashboard): one counter
 * per type, a new voice or text channel in `category`, saved under the row lock, then
 * named with the current count. Returns { counter, channel, renamed }. Throws USER_INPUT
 * errors with the /serverstats messages (unknown type, not a category, type in use);
 * when saving fails the new channel is deleted again.
 */
export async function createServerCounter(client, guild, { type, channelType = 'voice', category, actorTag = 'dashboard' }) {
  if (!COUNTER_TYPE_CONFIG[type]) {
    throw createError('Unknown counter type', ErrorTypes.USER_INPUT, 'Unknown counter type.', { type });
  }
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw createError('Not a category', ErrorTypes.USER_INPUT, 'Please select a valid category for the counter channel.', { type });
  }
  const existing = (await getServerCounters(client, guild.id)).find((c) => c.type === type);
  if (existing) {
    const channel = guild.channels.cache.get(existing.channelId);
    throw createError('Counter type in use', ErrorTypes.USER_INPUT,
      `A **${getCounterTypeLabel(type)}** counter already exists for this server${channel ? ` in ${channel}` : ''}. Delete it first before creating another.`, { type });
  }

  const channel = await guild.channels.create({
    name: getCounterBaseName(type),
    type: channelType === 'text' ? ChannelType.GuildText : ChannelType.GuildVoice,
    parent: category.id,
    reason: `Counter channel created by ${actorTag}`,
  });

  const counter = {
    id: Date.now().toString(),
    type,
    channelId: channel.id,
    guildId: guild.id,
    createdAt: new Date().toISOString(),
    enabled: true,
  };
  try {
    await mutateServerCounters(client, guild.id, (counters) => {
      if (counters.some((c) => c.type === type)) {
        throw createError('Counter type in use', ErrorTypes.USER_INPUT,
          `A **${getCounterTypeLabel(type)}** counter already exists for this server. Delete it first before creating another.`, { type });
      }
      return [...counters, counter];
    });
  } catch (error) {
    await channel.delete('Counter creation failed during save').catch(() => null);
    if (error.type === ErrorTypes.USER_INPUT) throw error;
    throw createError('Counter save failed', ErrorTypes.USER_INPUT, 'Failed to save counter data. Please try again.', { type, cause: error.message });
  }
  const renamed = await updateCounter(client, guild, counter);
  return { counter, channel, renamed };
}

/**
 * Removes a counter from the list (atomic) and deletes its channel. Returns
 * { counter, channel, channelDeleted }. Throws a USER_INPUT error when there is no such counter.
 */
export async function removeServerCounter(client, guild, counterId) {
  let removed = null;
  await mutateServerCounters(client, guild.id, (counters) => {
    removed = counters.find((c) => c.id === counterId) || null;
    if (!removed) {
      throw createError('Counter not found', ErrorTypes.USER_INPUT, `Counter with ID \`${counterId}\` was not found.`,
        { guildId: guild.id, counterId, operation: 'removeServerCounter' });
    }
    return counters.filter((c) => c.id !== counterId);
  });
  const channel = guild.channels.cache.get(removed.channelId) || null;
  let channelDeleted = false;
  if (channel) {
    try {
      await channel.delete(`Counter deleted - removing channel: ${removed.id}`);
      channelDeleted = true;
    } catch (error) {
      logger.error('Error deleting channel:', error);
    }
  }
  return { counter: removed, channel, channelDeleted };
}

/**
 * Changes a counter's type (atomic; one counter per type) and renames its channel.
 * Returns { counter, oldType, renamed }. Throws USER_INPUT errors with the /serverstats messages.
 */
export async function changeCounterType(client, guild, counterId, newType) {
  if (!COUNTER_TYPE_CONFIG[newType]) {
    throw createError('Unknown counter type', ErrorTypes.USER_INPUT, 'Unknown counter type.', { newType });
  }
  let oldType = null;
  let updated = null;
  await mutateServerCounters(client, guild.id, (counters) => {
    const counter = counters.find((c) => c.id === counterId);
    if (!counter) {
      throw createError('Counter not found', ErrorTypes.USER_INPUT,
        `Counter with ID \`${counterId}\` not found. Use \`/serverstats list\` to see all counters.`, { counterId });
    }
    if (!guild.channels.cache.get(counter.channelId)) {
      throw createError('Counter channel missing', ErrorTypes.USER_INPUT,
        'The channel for this counter no longer exists. You cannot update a counter for a deleted channel.', { counterId });
    }
    if (newType !== counter.type) {
      const existing = counters.find((c) => c.type === newType && c.id !== counter.id);
      if (existing) {
        const existingChannel = guild.channels.cache.get(existing.channelId);
        throw createError('Counter type in use', ErrorTypes.USER_INPUT,
          `A **${getCounterTypeLabel(newType)}** counter already exists for this server${existingChannel ? ` in ${existingChannel}` : ''}. Delete it first before reusing that type.`, { counterId });
      }
    }
    oldType = counter.type;
    counter.type = newType;
    counter.updatedAt = new Date().toISOString();
    updated = { ...counter };
    return counters;
  });
  const renamed = await updateCounter(client, guild, updated);
  return { counter: updated, oldType, renamed };
}
