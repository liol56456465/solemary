// serverstatsService.js

import { ChannelType } from 'discord.js';
import { logger } from '../utils/logger.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { getServerCountersKey } from '../utils/database/keys.js';
import { GUILD_SQL, sleep } from './scheduling/guildScan.js';
import botConfig from '../config/bot.js';
import { BoundedMap } from '../utils/boundedMap.js';

export const COUNTER_TYPE_CONFIG = {
  members: {
    label: 'Members + Bots',
    baseName: 'Members & Bots',
  },
  members_only: {
    label: 'Members Only',
    baseName: 'Members',
  },
  bots: {
    label: 'Bots Only',
    baseName: 'Bots',
  }
};

function getCounterConfig(type) {
  return COUNTER_TYPE_CONFIG[type] || {
    label: 'Unknown',
    baseName: 'Counter',
  };
}

export function getCounterTypeLabel(type) {
  return getCounterConfig(type).label;
}

export function getCounterBaseName(type) {
  return getCounterConfig(type).baseName;
}

export function getCounterEmoji(type) {
  return getCounterConfig(type).emoji || '';
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

/**
 * Member stats of a server without a member fetch: the total is Discord's own count
 * (guild.memberCount, kept current by the gateway); bots are counted from the member cache
 * (bots are few and usually cached). This replaced a full member fetch per counter per server
 * every 15 minutes. Compute once per server per run and pass it to updateCounter.
 */
export function getGuildCounterStats(guild) {
  const cache = guild.members?.cache;
  const botCount = cache ? cache.filter((member) => member.user?.bot).size : 0;
  const totalCount = typeof guild.memberCount === 'number' ? guild.memberCount : (cache?.size ?? 0);
  const humanCount = Math.max(totalCount - botCount, 0);

  return {
    totalCount,
    botCount,
    humanCount
  };
}

/** The number a counter of `type` shows, from getGuildCounterStats; null for an unknown type. */
export function counterCountFromStats(stats, type) {
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

export async function getCounterCount(guild, type) {
  return counterCountFromStats(getGuildCounterStats(guild), type);
}

// ── 403 backoff ──────────────────────────────────────────────────────────
// A channel the bot may not rename (Missing Access / Missing Permissions) is skipped for a while
// instead of failing every 15 minutes: Discord bans an IP for a time after 10,000 invalid
// (401/403/429) requests in 10 minutes. 1 h, doubling up to 24 h; a successful rename clears it.
const RENAME_BACKOFF_START_MS = 60 * 60 * 1000;
const RENAME_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const RENAME_BACKOFF_MAX_ENTRIES = 5000;
const renameBackoff = new Map(); // channelId → { until, delay }

/** True for a Discord "not allowed" answer (HTTP 403, Missing Access 50001, Missing Permissions 50013). */
export function isForbiddenError(error) {
  return error?.status === 403 || error?.code === 50001 || error?.code === 50013;
}

/** Milliseconds this channel is still skipped for (0 = not skipped). */
export function renameBackoffRemaining(channelId, now = Date.now()) {
  const entry = renameBackoff.get(channelId);
  return entry ? Math.max(0, entry.until - now) : 0;
}

function noteForbidden(channelId, now) {
  const previous = renameBackoff.get(channelId);
  const delay = previous ? Math.min(previous.delay * 2, RENAME_BACKOFF_MAX_MS) : RENAME_BACKOFF_START_MS;
  renameBackoff.delete(channelId);
  if (renameBackoff.size >= RENAME_BACKOFF_MAX_ENTRIES) renameBackoff.delete(renameBackoff.keys().next().value);
  renameBackoff.set(channelId, { until: now + delay, delay });
  return delay;
}

/** For tests. */
export function _resetRenameBackoff() {
  renameBackoff.clear();
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

/**
 * Renames a counter's channel to its current count. `stats` (getGuildCounterStats) lets a caller
 * that updates several counters of one server compute them once. Routine renames are not sent to
 * the server's log channel any more (one log line per counter every 15 minutes was noise). A
 * channel the bot may not rename is skipped for a while (403 backoff above).
 * Returns true when the channel shows the right count.
 */
export async function updateCounter(client, guild, counter, { stats = null, now = Date.now() } = {}) {
  try {
    if (!counter || !counter.type || !counter.channelId) {
      logger.warn('Skipping invalid counter in updateCounter:', counter);
      return false;
    }

    const { type, channelId } = counter;
    if (renameBackoffRemaining(channelId, now) > 0) {
      return false;
    }
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

    const count = counterCountFromStats(stats || getGuildCounterStats(guild), type);
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
        renameBackoff.delete(channelId);
        if (process.env.NODE_ENV !== 'production') {
          logger.debug(`Updated channel name to: "${newName}"`);
        }
      } catch (error) {
        if (isForbiddenError(error)) {
          const delay = noteForbidden(channelId, now);
          logger.warn(`Counter channel ${channel.id} in guild ${guild.id} cannot be renamed (${error.message}); skipped for ${Math.round(delay / 60000)} min`);
          return false;
        }
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

// ── Join/leave refresh ───────────────────────────────────────────────────
// A join or leave renames the server's counters at most once per 5 minutes: Discord allows two
// channel renames per 10 minutes, and a raid or a mass kick would otherwise queue hundreds. The
// 15-minute cron (updateAllServerCounters) catches up whatever a skipped event missed.
export const MEMBER_CHANGE_RENAME_INTERVAL_MS = 5 * 60 * 1000;
const memberChangeRefresh = new BoundedMap(5000); // guildId → time of the last event-driven refresh

/**
 * Called by guildMemberAdd / guildMemberRemove. Returns at once (the renames run in the
 * background, errors only logged); true when a refresh was started, false when debounced.
 * `deps` is for tests.
 */
export function refreshCountersOnMemberChange(client, guild, { now = Date.now(), deps = {} } = {}) {
  if (!guild?.id) return false;
  const last = memberChangeRefresh.get(guild.id);
  if (last !== undefined && now - last < MEMBER_CHANGE_RENAME_INTERVAL_MS) return false;
  memberChangeRefresh.set(guild.id, now);
  const load = deps.getServerCounters || getServerCounters;
  const rename = deps.updateCounter || updateCounter;
  void (async () => {
    const counters = await load(client, guild.id);
    const stats = getGuildCounterStats(guild);
    for (const counter of counters) {
      if (counter && counter.type && counter.channelId && counter.enabled !== false) {
        await rename(client, guild, counter, { stats, now });
      }
    }
  })().catch((error) => logger.debug(`Counters of ${guild.id} not refreshed after a join/leave: ${error.message}`));
  return true;
}

/** For tests. */
export function _resetMemberChangeRefresh() {
  memberChangeRefresh.clear();
}

/**
 * Every server's counters in one query: Map guildId → counters (sanitized, non-empty lists only).
 * Null when the bot runs on in-memory storage (no SQL; the caller reads each server instead).
 * Throws on a database error. `query` is for tests.
 */
export async function listGuildCounters(client, { query } = {}) {
  if (!query && !client?.db?.rows?.()) return null;
  const run = query || (await import('./enforcement/db.js')).query;
  const { rows } = await run(GUILD_SQL.counters, []);
  const out = new Map();
  for (const row of rows) {
    const guildId = String(row.id);
    const counters = sanitizeCounters(row.counters, guildId);
    if (counters.length) out.set(guildId, counters);
  }
  return out;
}

export const COUNTER_SERVER_PAUSE_MS = 250;

/**
 * The 15-minute counter cron: only servers that have counters (one query), member stats computed
 * once per server (no member fetch), a short pause between servers. Counters whose channel is
 * gone are removed under the row lock (disabled counters are kept). A database error on the
 * list query throws (the cron logs it and tries again next run). Returns
 * { servers, renamedOk, removed, errors }. `query`, `pauseMs`, `sleepFn` are for tests.
 */
export async function updateAllServerCounters(client, { query, pauseMs = COUNTER_SERVER_PAUSE_MS, sleepFn = sleep } = {}) {
  const summary = { servers: 0, renamedOk: 0, removed: 0, errors: 0 };
  let byGuild = await listGuildCounters(client, { query });
  const readEach = byGuild === null; // in-memory storage: no SQL, read each server
  if (readEach) byGuild = new Map([...client.guilds.cache.keys()].map((id) => [id, null]));

  let first = true;
  for (const [guildId, listed] of byGuild) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue; // the bot left; the stored counters stay until the server's data is deleted
    try {
      const counters = listed || await getServerCounters(client, guildId);
      if (!counters.length) continue;
      if (!first) await sleepFn(pauseMs);
      first = false;
      summary.servers += 1;

      const stats = getGuildCounterStats(guild);
      const orphaned = new Set();
      for (const counter of counters) {
        if (counter.enabled === false) continue;
        if (!guild.channels.cache.get(counter.channelId)) {
          orphaned.add(counter.id);
          logger.info(`Removing orphaned counter ${counter.id} (type: ${counter.type}, deleted channel: ${counter.channelId}) from guild ${guildId}`);
          continue;
        }
        if (await updateCounter(client, guild, counter, { stats })) summary.renamedOk += 1;
      }
      if (orphaned.size) {
        await mutateServerCounters(client, guildId, (current) => current.filter((c) => !orphaned.has(c.id)));
        summary.removed += orphaned.size;
        logger.info(`Cleaned up ${orphaned.size} orphaned counter(s) from guild ${guildId} during scheduled update`);
      }
    } catch (error) {
      summary.errors += 1;
      logger.error(`Error updating counters for guild ${guildId}:`, error);
    }
  }
  return summary;
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
    throw createError('Not a category', ErrorTypes.USER_INPUT, 'Pick a category for the counter channel.', { type });
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
    throw createError('Counter save failed', ErrorTypes.USER_INPUT, 'Couldn\'t save the counter. Try again.', { type, cause: error.message });
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
