// loggingService.js

import { ChannelType } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { updateGuildConfigAtomic } from '../utils/database/guildConfigStorage.js';
import { logger } from '../utils/logger.js';
import {
  appendContentSection,
  buildLogDescription,
  buildStandardLogEmbed,
  fieldsToLines,
  splitComparisonFields,
} from '../utils/logging/logEmbeds.js';

const LOG_DESTINATIONS = ['audit', 'applications', 'reports'];

const EVENT_TYPES = {
  MODERATION_BAN: 'moderation.ban',
  MODERATION_KICK: 'moderation.kick',
  MODERATION_MUTE: 'moderation.mute',
  MODERATION_WARN: 'moderation.warn',
  MODERATION_PURGE: 'moderation.purge',
  MODERATION_TIMEOUT: 'moderation.timeout',
  MODERATION_UNTIMEOUT: 'moderation.untimeout',
  MODERATION_UNBAN: 'moderation.unban',
  MODERATION_LOCK: 'moderation.lock',
  MODERATION_UNLOCK: 'moderation.unlock',
  MODERATION_DM: 'moderation.dm',
  MODERATION_CONFIG: 'moderation.config',
  MODERATION_UNMUTE: 'moderation.unmute',
  MODERATION_WARN_REMOVE: 'moderation.warnremove',
  MODERATION_APPEAL: 'moderation.appeal',
  MODERATION_STAFF_REPORT: 'moderation.staffreport',
  MODERATION_OWNER_OVERRIDE: 'moderation.owneroverride',

  LEVELING_LEVELUP: 'leveling.levelup',
  LEVELING_MILESTONE: 'leveling.milestone',

  MESSAGE_DELETE: 'message.delete',
  MESSAGE_EDIT: 'message.edit',
  MESSAGE_BULK_DELETE: 'message.bulkdelete',

  ROLE_CREATE: 'role.create',
  ROLE_DELETE: 'role.delete',
  ROLE_UPDATE: 'role.update',

  MEMBER_JOIN: 'member.join',
  MEMBER_LEAVE: 'member.leave',
  MEMBER_NAME_CHANGE: 'member.namechange',

  REACTION_ROLE_ADD: 'reactionrole.add',
  REACTION_ROLE_REMOVE: 'reactionrole.remove',
  REACTION_ROLE_CREATE: 'reactionrole.create',
  REACTION_ROLE_DELETE: 'reactionrole.delete',
  REACTION_ROLE_UPDATE: 'reactionrole.update',

  GIVEAWAY_CREATE: 'giveaway.create',
  GIVEAWAY_WINNER: 'giveaway.winner',
  GIVEAWAY_REROLL: 'giveaway.reroll',
  GIVEAWAY_DELETE: 'giveaway.delete',

  COUNTER_UPDATE: 'counter.update',
  COUNTER_CONFIG: 'counter.config',

  APPLICATION_SUBMIT: 'application.submit',
  APPLICATION_REVIEW: 'application.review',

  REPORT_FILE: 'report.file',

  CHANNEL_CREATE: 'channel.create',
  CHANNEL_DELETE: 'channel.delete',
  CHANNEL_UPDATE: 'channel.update',
  THREAD_CREATE: 'channel.threadcreate',
  THREAD_DELETE: 'channel.threaddelete',
  THREAD_UPDATE: 'channel.threadupdate',

  // From audit log entries (services/auditLogLogging.js): no extra gateway intents.
  EMOJI_CREATE: 'server.emojicreate',
  EMOJI_DELETE: 'server.emojidelete',
  EMOJI_UPDATE: 'server.emojiupdate',
  STICKER_CREATE: 'server.stickercreate',
  STICKER_DELETE: 'server.stickerdelete',
  STICKER_UPDATE: 'server.stickerupdate',
  EVENT_CREATE: 'server.eventcreate',
  EVENT_DELETE: 'server.eventdelete',
  EVENT_UPDATE: 'server.eventupdate',
  WEBHOOK_CREATE: 'server.webhookcreate',
  WEBHOOK_DELETE: 'server.webhookdelete',
  WEBHOOK_UPDATE: 'server.webhookupdate',
  INVITE_CREATE: 'server.invitecreate',
  INVITE_DELETE: 'server.invitedelete',
  AUTOMOD_RULE_CREATE: 'server.automodcreate',
  AUTOMOD_RULE_DELETE: 'server.automoddelete',
  AUTOMOD_RULE_UPDATE: 'server.automodupdate',
};

const EVENT_COLORS = {
  'moderation.ban': 0x721919,
  'moderation.kick': 0xFFA500,
  'moderation.mute': 0xF1C40F,
  'moderation.warn': 0xFEE75C,
  'moderation.purge': 0xE67E22,
  'moderation.timeout': 0xF1C40F,
  'moderation.untimeout': 0x2ecc71,
  'moderation.unban': 0x3498db,
  'moderation.lock': 0xE67E22,
  'moderation.unlock': 0x2ecc71,
  'moderation.dm': 0x3498db,
  'moderation.config': 0x5865F2,
  'moderation.unmute': 0x2ecc71,
  'moderation.warnremove': 0x2ecc71,
  'moderation.appeal': 0x5865F2,
  'moderation.staffreport': 0xED4245,
  'moderation.owneroverride': 0xE67E22,
  'leveling.levelup': 0x00ff00,
  'leveling.milestone': 0xFFD700,
  'message.delete': 0x8b0000,
  'message.edit': 0xFFA500,
  'message.bulkdelete': 0xFF0000,
  'role.create': 0x2ecc71,
  'role.delete': 0xe74c3c,
  'role.update': 0x3498db,
  'member.join': 0x2ecc71,
  'member.leave': 0xe74c3c,
  'member.namechange': 0x3498db,
  'reactionrole.add': 0x2ecc71,
  'reactionrole.remove': 0xe74c3c,
  'reactionrole.create': 0x3498db,
  'reactionrole.delete': 0x8b0000,
  'reactionrole.update': 0xFFA500,
  'giveaway.create': 0x57F287,
  'giveaway.winner': 0xFEE75C,
  'giveaway.reroll': 0x3498DB,
  'giveaway.delete': 0xE74C3C,
  'counter.update': 0x0099ff,
  'counter.config': 0x5865F2,
  'application.submit': 0x5865F2,
  'application.review': 0x57F287,
  'report.file': 0xED4245,
  'channel.create': 0x2ecc71,
  'channel.delete': 0xe74c3c,
  'channel.update': 0x3498db,
  'channel.threadcreate': 0x2ecc71,
  'channel.threaddelete': 0xe74c3c,
  'channel.threadupdate': 0x3498db,
  'server.emojicreate': 0x2ecc71,
  'server.emojidelete': 0xe74c3c,
  'server.emojiupdate': 0x3498db,
  'server.stickercreate': 0x2ecc71,
  'server.stickerdelete': 0xe74c3c,
  'server.stickerupdate': 0x3498db,
  'server.eventcreate': 0x2ecc71,
  'server.eventdelete': 0xe74c3c,
  'server.eventupdate': 0x3498db,
  'server.webhookcreate': 0xE67E22,
  'server.webhookdelete': 0xe74c3c,
  'server.webhookupdate': 0x3498db,
  'server.invitecreate': 0x2ecc71,
  'server.invitedelete': 0xe74c3c,
  'server.automodcreate': 0x5865F2,
  'server.automoddelete': 0xe74c3c,
  'server.automodupdate': 0x5865F2,
};

const EVENT_ICONS = {
  'moderation.ban': '🔨',
  'moderation.kick': '👢',
  'moderation.mute': '🔇',
  'moderation.warn': '⚠️',
  'moderation.purge': '🗑️',
  'moderation.timeout': '⏳',
  'moderation.untimeout': '✅',
  'moderation.unban': '🔓',
  'moderation.lock': '🔒',
  'moderation.unlock': '🔓',
  'moderation.dm': '✉️',
  'moderation.config': '⚙️',
  'moderation.unmute': '🔊',
  'moderation.warnremove': '🧹',
  'moderation.appeal': '📨',
  'moderation.staffreport': '🚨',
  'moderation.owneroverride': '🗝️',
  'leveling.levelup': '📈',
  'leveling.milestone': '🏆',
  'message.delete': '❌',
  'message.edit': '✏️',
  'message.bulkdelete': '🗑️',
  'role.create': '➕',
  'role.delete': '➖',
  'role.update': '🔄',
  'member.join': '👋',
  'member.leave': '👋',
  'member.namechange': '🏷️',
  'reactionrole.add': '✅',
  'reactionrole.remove': '❌',
  'reactionrole.create': '🎭',
  'reactionrole.delete': '🗑️',
  'reactionrole.update': '🔄',
  'giveaway.create': '🎁',
  'giveaway.winner': '🎉',
  'giveaway.reroll': '🔄',
  'giveaway.delete': '🗑️',
  'counter.update': '📊',
  'counter.config': '⚙️',
  'application.submit': '📝',
  'application.review': '📋',
  'report.file': '🚨',
  'channel.create': '➕',
  'channel.delete': '➖',
  'channel.update': '🔄',
  'channel.threadcreate': '🧵',
  'channel.threaddelete': '🧵',
  'channel.threadupdate': '🧵',
  'server.emojicreate': '😀',
  'server.emojidelete': '😀',
  'server.emojiupdate': '😀',
  'server.stickercreate': '🏷️',
  'server.stickerdelete': '🏷️',
  'server.stickerupdate': '🏷️',
  'server.eventcreate': '📅',
  'server.eventdelete': '📅',
  'server.eventupdate': '📅',
  'server.webhookcreate': '🪝',
  'server.webhookdelete': '🪝',
  'server.webhookupdate': '🪝',
  'server.invitecreate': '✉️',
  'server.invitedelete': '✉️',
  'server.automodcreate': '🛡️',
  'server.automoddelete': '🛡️',
  'server.automodupdate': '🛡️',
};

const CATEGORY_DESTINATION = {
  application: 'applications',
  report: 'reports',
};

export function resolveLogChannel(config, destination) {
  const channels = config?.logging?.channels || {};
  if (destination && channels[destination]) {
    return channels[destination];
  }
  if (destination === 'audit') {
    return channels.audit ?? config?.logging?.channelId ?? config?.logChannelId ?? null;
  }
  return channels[destination] ?? null;
}

export function getIgnoreList(config) {
  const ignore = config?.logging?.ignore ?? config?.logIgnore ?? {};
  return { users: ignore.users || [], channels: ignore.channels || [], roles: ignore.roles || [] };
}

/**
 * True when a log entry is on the ignore lists: its user, its channel or any parent
 * of it (thread → channel → category), or one of the user's roles. Pure.
 */
export function isIgnoredLog(ignore, { userId = null, channelIds = [], roleIds = [] } = {}) {
  if (userId && ignore.users?.includes(userId)) return true;
  if (channelIds.some((id) => id && ignore.channels?.includes(id))) return true;
  if (roleIds.some((id) => ignore.roles?.includes(id))) return true;
  return false;
}

/** The channel and its parents (thread → channel → category), from the cache. */
export function channelAncestry(guild, channelId) {
  const ids = [];
  let channel = channelId ? guild.channels.cache.get(channelId) : null;
  if (channelId && !channel) ids.push(channelId);
  for (let depth = 0; channel && depth < 3; depth += 1) {
    ids.push(channel.id);
    channel = channel.parentId ? guild.channels.cache.get(channel.parentId) : null;
  }
  return ids;
}

async function memberRoleIds(guild, userId, ignore) {
  if (!userId || !ignore.roles?.length) return [];
  const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  return member ? [...member.roles.cache.keys()] : [];
}

export function isEventEnabled(config, eventType) {
  if (!config?.logging?.enabled) {
    return false;
  }

  if (!eventType || typeof eventType !== 'string') {
    return false;
  }

  const category = eventType.split('.')[0];
  const enabledEvents = config.logging.enabledEvents || {};

  if (enabledEvents[eventType] === false) {
    return false;
  }

  if (enabledEvents[`${category}.*`] === false) {
    return false;
  }

  return true;
}

function getLogChannelForEvent(config, eventType, overrideChannelId = null) {
  if (overrideChannelId) {
    return overrideChannelId;
  }

  const category = eventType?.split('.')[0];
  const destination = CATEGORY_DESTINATION[category] || 'audit';
  return resolveLogChannel(config, destination);
}

export async function logEvent({
  client,
  guildId,
  eventType,
  data = {},
  attachments = [],
  content = null,
  channelId: overrideChannelId = null,
}) {
  try {
    const guild = client.guilds.cache.get(guildId) ||
      await client.guilds.fetch(guildId).catch(() => null);

    if (!guild) {
      logger.warn(`logEvent: Guild not found: ${guildId}`);
      return null;
    }

    const config = await getGuildConfig(client, guildId);
    const ignore = getIgnoreList(config);

    const ignored = isIgnoredLog(ignore, {
      userId: data?.userId,
      channelIds: data?.channelId ? channelAncestry(guild, data.channelId) : [],
      roleIds: await memberRoleIds(guild, data?.userId, ignore),
    });
    if (ignored) {
      return null;
    }

    if (!isEventEnabled(config, eventType)) {
      return null;
    }

    const logChannelId = getLogChannelForEvent(config, eventType, overrideChannelId);
    if (!logChannelId) {
      return null;
    }

    const channel = guild.channels.cache.get(logChannelId) ||
      await guild.channels.fetch(logChannelId).catch(() => null);

    if (!channel || channel.type !== ChannelType.GuildText) {
      logger.warn(`logEvent: Invalid log channel ${logChannelId} for guild ${guildId}`);
      return null;
    }

    const permissions = channel.permissionsFor(guild.members.me);
    if (!permissions || !permissions.has(['SendMessages', 'EmbedLinks'])) {
      logger.warn(`logEvent: Missing permissions in channel ${logChannelId}`);
      return null;
    }

    const embed = createLogEmbed(guild, eventType, data);

    const messageOptions = { embeds: [embed] };
    if (content) {
      messageOptions.content = content;
    }
    if (attachments.length > 0) {
      messageOptions.files = attachments;
    }

    const sent = await channel.send(messageOptions);
    logger.info(`Event logged: ${eventType} in guild ${guildId}`);
    return sent;
  } catch (error) {
    logger.error('Error in logEvent:', error);
    return null;
  }
}

function createLogEmbed(guild, eventType, data) {
  const color = data.color ?? EVENT_COLORS[eventType] ?? 0x0099ff;
  const icon = EVENT_ICONS[eventType] || '📌';
  const title = data.title || `${icon} ${formatEventType(eventType)}`;

  const inlineFields = [];
  let description = data.description || '';

  if (data.lines?.length) {
    description = buildLogDescription({
      headline: data.headline || description || undefined,
      lines: data.lines,
      quoted: data.quoted !== false,
      meta: data.meta,
    });

    if (data.fields?.length) {
      const { before, after } = splitComparisonFields(data.fields);
      if (before !== null) inlineFields.push({ name: 'Before', value: before, inline: true });
      if (after !== null) inlineFields.push({ name: 'After', value: after, inline: true });
    }
  } else if (data.fields?.length) {
    const { before, after, rest } = splitComparisonFields(data.fields);

    if (before !== null || after !== null) {
      const metaLines = fieldsToLines(rest);
      description = buildLogDescription({
        headline: description || undefined,
        lines: metaLines,
        quoted: true,
      });

      if (before !== null) {
        inlineFields.push({ name: 'Before', value: before, inline: true });
      }
      if (after !== null) {
        inlineFields.push({ name: 'After', value: after, inline: true });
      }
    } else {
      description = buildLogDescription({
        headline: description || undefined,
        lines: fieldsToLines(data.fields),
        quoted: data.quoted ?? !description,
      });
    }
  } else if (data.meta?.length) {
    description = buildLogDescription({
      headline: description || undefined,
      meta: data.meta,
    });
  }

  if (data.section?.body) {
    description = appendContentSection(description, data.section.title || 'Message', data.section.body);
  }

  if (data.inlineFields?.length) {
    inlineFields.push(...data.inlineFields);
  }

  return buildStandardLogEmbed({
    color,
    title,
    description: description || undefined,
    thumbnail: data.thumbnail || undefined,
    inlineFields,
    fields: data.blockFields || [],
    author: data.author || null,
    timestamp: true,
    footer: data.footer || { text: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined },
  });
}

function formatEventType(eventType) {
  if (!eventType || typeof eventType !== 'string') {
    return 'Unknown Event';
  }

  return eventType
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export async function getLoggingStatus(client, guildId) {
  const config = await getGuildConfig(client, guildId);
  const logging = config.logging || {};

  return {
    enabled: logging.enabled || false,
    channels: logging.channels || { audit: null, applications: null, reports: null },
    channelId: logging.channels?.audit ?? null,
    ignore: getIgnoreList(config),
    enabledEvents: logging.enabledEvents || {},
    allEventTypes: EVENT_TYPES,
  };
}

export async function toggleEventLogging(client, guildId, eventTypes, enabled) {
  try {
    const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    await updateGuildConfigAtomic(client, guildId, (config) => {
      const logging = { ...config.logging, enabledEvents: { ...(config.logging?.enabledEvents || {}) } };
      types.forEach((type) => {
        if (type.endsWith('.*')) {
          const category = type.replace('.*', '');
          const matchingTypes = Object.values(EVENT_TYPES).filter(
            (eventType) => eventType.startsWith(`${category}.`),
          );
          matchingTypes.forEach((eventType) => {
            logging.enabledEvents[eventType] = enabled;
          });
          logging.enabledEvents[type] = enabled;
        } else {
          logging.enabledEvents[type] = enabled;
        }
      });
      return { ...config, logging };
    });
    return true;
  } catch (error) {
    logger.error('Error toggling event logging:', error);
    return false;
  }
}

export async function setLogChannel(client, guildId, destination, channelId) {
  if (!LOG_DESTINATIONS.includes(destination)) {
    throw new Error(`Invalid log destination: ${destination}`);
  }

  try {
    await updateGuildConfigAtomic(client, guildId, (config) => {
      const logging = {
        ...config.logging,
        channels: { ...(config.logging?.channels || {}), [destination]: channelId },
      };
      if (channelId) {
        logging.enabled = true;
      }
      return { ...config, logging };
    });
    return true;
  } catch (error) {
    logger.error('Error setting log channel:', error);
    return false;
  }
}

/** @deprecated Use setLogChannel(client, guildId, 'audit', channelId) */
export async function setLoggingChannel(client, guildId, channelId) {
  return setLogChannel(client, guildId, 'audit', channelId);
}

export async function setLoggingEnabled(client, guildId, enabled) {
  try {
    await updateGuildConfigAtomic(client, guildId, (config) => ({
      ...config,
      logging: { ...config.logging, enabled },
    }));
    return true;
  } catch (error) {
    logger.error('Error setting logging enabled:', error);
    return false;
  }
}

const IGNORE_LIST_KEYS = { user: 'users', channel: 'channels', role: 'roles' };

/**
 * Adds to, removes from or toggles an ignore list (type: user | channel | role),
 * under the guild config's row lock. Returns true, or false on a failure (logged).
 * With action 'toggle', `result.added` tells which way it went.
 */
export async function updateIgnoreList(client, guildId, { action, type, id }, result = {}) {
  try {
    const listKey = IGNORE_LIST_KEYS[type];
    if (!listKey) throw new Error(`Unknown ignore list type: ${type}`);
    await updateGuildConfigAtomic(client, guildId, (config) => {
      const ignore = getIgnoreList(config);
      const current = [...ignore[listKey]];
      const has = current.includes(id);
      const add = action === 'add' || (action === 'toggle' && !has);
      result.added = add;
      const next = add ? (has ? current : [...current, id]) : current.filter((entry) => entry !== id);
      return { ...config, logging: { ...config.logging, ignore: { ...ignore, [listKey]: next } } };
    });
    return true;
  } catch (error) {
    logger.error('Error updating ignore list:', error);
    return false;
  }
}

export function resolveApplicationLogChannel(config, roleSettings = {}, appSettings = {}) {
  return roleSettings.logChannelId
    || config?.logging?.channels?.applications
    || appSettings.logChannelId
    || null;
}

export { EVENT_TYPES, EVENT_COLORS, EVENT_ICONS, LOG_DESTINATIONS };
