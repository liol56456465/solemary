// loggingService.js

import { ChannelType } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { updateGuildConfigAtomic } from '../utils/database/guildConfigStorage.js';
import { LOG_CHANNEL_KEYS } from '../utils/schemas.js';
import { LOG_FORUM_KINDS, logForumId, sendToLogForum } from './logForum.js';
import { logger } from '../utils/logger.js';
import { BoundedMap } from '../utils/boundedMap.js';
import {
  appendContentSection,
  buildLogDescription,
  buildStandardLogEmbed,
  fieldsToLines,
  splitComparisonFields,
} from '../utils/logging/logEmbeds.js';

// Owner (2026-11-10): a channel per kind of log. Not set: the main log channel (audit).
// 'dashboard' = web dashboard / website changes (postModLog kind 'dashboard', else the mod log).
// One list with the config schema (schemas.js), so a destination can never be saved and then dropped.
const LOG_DESTINATIONS = LOG_CHANNEL_KEYS;

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
  MEMBER_SELF_COOLDOWN: 'member.selfcooldown',

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
  'member.selfcooldown': 0x95a5a6,
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

// Default embed titles when a caller passes none. Plain sentence case, no emoji.
const EVENT_TITLES = {
  'moderation.ban': 'Member banned',
  'moderation.kick': 'Member kicked',
  'moderation.mute': 'Member muted',
  'moderation.warn': 'Member warned',
  'moderation.purge': 'Messages purged',
  'moderation.timeout': 'Member timed out',
  'moderation.untimeout': 'Timeout removed',
  'moderation.unban': 'Member unbanned',
  'moderation.lock': 'Channel locked',
  'moderation.unlock': 'Channel unlocked',
  'moderation.dm': 'DM sent',
  'moderation.config': 'Moderation settings changed',
  'moderation.unmute': 'Member unmuted',
  'moderation.warnremove': 'Warn removed',
  'moderation.appeal': 'Appeal',
  'moderation.staffreport': 'Staff report',
  'moderation.owneroverride': 'Owner override',
  'leveling.levelup': 'Level up',
  'leveling.milestone': 'Level milestone',
  'message.delete': 'Message deleted',
  'message.edit': 'Message edited',
  'message.bulkdelete': 'Messages bulk deleted',
  'role.create': 'Role created',
  'role.delete': 'Role deleted',
  'role.update': 'Role updated',
  'member.join': 'Member joined',
  'member.leave': 'Member left',
  'member.namechange': 'Name changed',
  'member.selfcooldown': 'Self-cooldown started',
  'reactionrole.add': 'Reaction role added',
  'reactionrole.remove': 'Reaction role removed',
  'reactionrole.create': 'Reaction role panel created',
  'reactionrole.delete': 'Reaction role panel deleted',
  'reactionrole.update': 'Reaction role panel updated',
  'giveaway.create': 'Giveaway started',
  'giveaway.winner': 'Giveaway winner',
  'giveaway.reroll': 'Giveaway rerolled',
  'giveaway.delete': 'Giveaway deleted',
  'counter.update': 'Counter updated',
  'counter.config': 'Counter settings changed',
  'application.submit': 'Application submitted',
  'application.review': 'Application reviewed',
  'report.file': 'Report filed',
  'channel.create': 'Channel created',
  'channel.delete': 'Channel deleted',
  'channel.update': 'Channel updated',
  'channel.threadcreate': 'Thread created',
  'channel.threaddelete': 'Thread deleted',
  'channel.threadupdate': 'Thread updated',
  'server.emojicreate': 'Emoji added',
  'server.emojidelete': 'Emoji deleted',
  'server.emojiupdate': 'Emoji updated',
  'server.stickercreate': 'Sticker added',
  'server.stickerdelete': 'Sticker deleted',
  'server.stickerupdate': 'Sticker updated',
  'server.eventcreate': 'Event created',
  'server.eventdelete': 'Event deleted',
  'server.eventupdate': 'Event updated',
  'server.webhookcreate': 'Webhook created',
  'server.webhookdelete': 'Webhook deleted',
  'server.webhookupdate': 'Webhook updated',
  'server.invitecreate': 'Invite created',
  'server.invitedelete': 'Invite deleted',
  'server.automodcreate': 'AutoMod rule created',
  'server.automoddelete': 'AutoMod rule deleted',
  'server.automodupdate': 'AutoMod rule updated',
};

const CATEGORY_DESTINATION = {
  application: 'applications',
  report: 'reports',
  moderation: 'moderation',
  member: 'members',
  message: 'messages',
  channel: 'server',
  role: 'server',
  leveling: 'community',
  giveaway: 'community',
  counter: 'community',
  reactionrole: 'community',
};

export function resolveLogChannel(config, destination) {
  const channels = config?.logging?.channels || {};
  if (destination && channels[destination]) {
    return channels[destination];
  }
  if (destination === 'audit') {
    return channels.audit ?? config?.logging?.channelId ?? config?.logChannelId ?? null;
  }
  if (destination === 'applications' || destination === 'reports' || destination === 'dashboard') {
    return channels[destination] ?? null;
  }
  // A per-kind channel not set: the main log channel, as before.
  return channels[destination] ?? resolveLogChannel(config, 'audit');
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

/** The Logging page destination of an event type ('audit' when its category has none). */
function destinationForEvent(eventType) {
  const category = eventType?.split('.')[0];
  return CATEGORY_DESTINATION[category] || 'audit';
}

function getLogChannelForEvent(config, eventType, overrideChannelId = null) {
  if (overrideChannelId) {
    return overrideChannelId;
  }
  return resolveLogChannel(config, destinationForEvent(eventType));
}

/** "Advanced" log kind (logForum.js): the forum of this event's kind, or null (each kind on its own). */
function forumForEvent(config, eventType) {
  return logForumId(config, destinationForEvent(eventType));
}

// 403 backoff (B5): a log channel Mewvo can't see or post in is skipped for a while instead of
// being tried (and warned about) on every event. Discord bans an IP for a time after 10,000
// invalid (401/403/429) requests in 10 minutes. Per channel, in memory, bounded.
export const LOG_CHANNEL_BACKOFF_MS = 10 * 60 * 1000;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const UNKNOWN_CHANNEL = 10003;
// Keyed by server AND channel: a server that points its log at another server's channel id must not
// pause that other server's logs (security review, B5).
const logChannelBackoff = new BoundedMap(5000); // `${guildId}:${channelId}` → { until, reason }
const backoffKey = (guildId, channelId) => `${guildId}:${channelId}`;

/** True while posts to this log channel are paused after a refusal. */
export function isLogChannelBackedOff(guildId, channelId, now = Date.now()) {
  const key = backoffKey(guildId, channelId);
  const entry = logChannelBackoff.get(key);
  if (!entry) return false;
  if (entry.until > now) return true;
  logChannelBackoff.delete(key);
  return false;
}

function backOffLogChannel(guildId, channelId, reason, now = Date.now()) {
  logChannelBackoff.set(backoffKey(guildId, channelId), { until: now + LOG_CHANNEL_BACKOFF_MS, reason });
  logger.warn(`logEvent: ${reason} for log channel ${channelId} in guild ${guildId}; pausing posts there for ${LOG_CHANNEL_BACKOFF_MS / 60000} min`);
}

const permissionWarnedAt = new BoundedMap(5000); // `${guildId}:${channelId}` → last warn (ms)
function warnThrottled(guildId, channelId, message, now = Date.now()) {
  const key = backoffKey(guildId, channelId);
  const last = permissionWarnedAt.get(key);
  if (last && now - last < LOG_CHANNEL_BACKOFF_MS) return;
  permissionWarnedAt.set(key, now);
  logger.warn(message);
}

/** A Discord refusal that counts as an invalid request (401/403, Missing Access/Permissions). */
export function isForbiddenError(error) {
  const status = Number(error?.status);
  const code = Number(error?.code);
  return status === 401 || status === 403 || code === MISSING_ACCESS || code === MISSING_PERMISSIONS;
}

/** Tests only. */
export function resetLogChannelBackoff() {
  logChannelBackoff.clear();
  permissionWarnedAt.clear();
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

    // Advanced (a forum with one post per member): tried first; on any failure the normal channel below.
    const forumId = overrideChannelId ? null : forumForEvent(config, eventType);
    if (forumId) {
      const payload = { embeds: [createLogEmbed(guild, eventType, data)] };
      if (content) payload.content = content;
      if (attachments.length > 0) payload.files = attachments;
      const subjectId = data?.userId ? String(data.userId) : null;
      const posted = await sendToLogForum({
        guild, forumId, payload,
        subject: subjectId ? { id: subjectId, username: data?.username || client.users?.cache?.get(subjectId)?.username || null } : null,
      });
      if (posted) return posted;
    }

    const logChannelId = getLogChannelForEvent(config, eventType, overrideChannelId);
    if (!logChannelId) {
      return null;
    }

    if (isLogChannelBackedOff(guildId, logChannelId)) {
      return null;
    }

    // Only a confirmed refusal pauses posting (Unknown Channel, Missing Access, 401/403, or a channel
    // of another server). A network error or Discord outage must not silence the logs (security review).
    let fetchRefused = false;
    const channel = guild.channels.cache.get(logChannelId) ||
      await guild.channels.fetch(logChannelId).catch((error) => {
        if (Number(error?.code) === UNKNOWN_CHANNEL || isForbiddenError(error) || error?.code === 'GuildChannelUnowned') fetchRefused = true;
        return null;
      });
    if (!channel && !fetchRefused) {
      warnThrottled(guildId, logChannelId, `logEvent: could not load log channel ${logChannelId} for guild ${guildId} (temporary error, not paused)`);
      return null;
    }

    // Text and announcement channels (the dashboard and /logging channel allow both), and only
    // channels of this server (a foreign channel id is a misconfiguration of this server only).
    if (!channel || (channel.guildId && String(channel.guildId) !== String(guildId)) || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      backOffLogChannel(guildId, logChannelId, 'missing or not a text channel');
      return null;
    }

    const permissions = channel.permissionsFor(guild.members.me);
    if (!permissions || !permissions.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      // Checked locally (no request), so no pause: a fix works on the next event. Warned once per pause period.
      warnThrottled(guildId, logChannelId, `logEvent: Missing permissions in channel ${logChannelId} for guild ${guildId}`);
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

    let sent;
    try {
      sent = await channel.send(messageOptions);
    } catch (error) {
      if (!isForbiddenError(error)) throw error;
      backOffLogChannel(guildId, logChannelId, `Discord refused the post (${error.code || error.status})`);
      return null;
    }
    logger.debug(`Event logged: ${eventType} in guild ${guildId}`);
    return sent;
  } catch (error) {
    logger.error('Error in logEvent:', error);
    return null;
  }
}

function createLogEmbed(guild, eventType, data) {
  const color = data.color ?? EVENT_COLORS[eventType] ?? 0x0099ff;
  const title = data.title || EVENT_TITLES[eventType] || formatEventType(eventType);

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
    return 'Log event';
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
    // Advanced kinds: kind → forum channel id (logForum.js); a kind without one is normal.
    forums: Object.fromEntries(LOG_FORUM_KINDS.map((kind) => [kind, logForumId(config, kind)])),
  };
}

/**
 * enabledEvents with `types` switched to `enabled` (pure). A category wildcard ("message.*")
 * sets every event of the category and the wildcard itself.
 */
export function applyEventToggle(enabledEvents, types, enabled) {
  const next = { ...(enabledEvents || {}) };
  for (const type of types) {
    if (type.endsWith('.*')) {
      const category = type.replace('.*', '');
      for (const eventType of Object.values(EVENT_TYPES)) {
        if (typeof eventType === 'string' && eventType.startsWith(`${category}.`)) next[eventType] = enabled;
      }
    }
    next[type] = enabled;
  }
  return next;
}

export async function toggleEventLogging(client, guildId, eventTypes, enabled) {
  try {
    const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    await updateGuildConfigAtomic(client, guildId, (config) => {
      const logging = { ...config.logging, enabledEvents: applyEventToggle(config.logging?.enabledEvents, types, enabled) };
      return { ...config, logging };
    });
    return true;
  } catch (error) {
    logger.error('Error toggling event logging:', error);
    return false;
  }
}

/**
 * The dashboard's event form in ONE locked write: plan(enabledEvents) gets the locked current
 * toggles and returns [{ types, enabled }]; they are applied in order and saved together (all
 * or nothing). Returns the applied steps. Throws on a database error (nothing is saved then).
 */
export async function updateEventLogging(client, guildId, plan) {
  let steps = [];
  await updateGuildConfigAtomic(client, guildId, async (config) => {
    const current = { ...(config.logging?.enabledEvents || {}) };
    steps = (await plan(structuredClone(current))) || [];
    if (!steps.length) return config;
    let enabledEvents = current;
    for (const step of steps) enabledEvents = applyEventToggle(enabledEvents, step.types, step.enabled);
    return { ...config, logging: { ...config.logging, enabledEvents } };
  }, { operation: 'updateEventLogging' });
  return steps;
}

/**
 * Several log channels in ONE locked write (the dashboard's channels form): wanted =
 * { destination: channelId | null }. Returns [{ destination, old, new }] for the ones that
 * changed, compared with the locked stored value. Throws on a database error (nothing saved).
 */
export async function setLogChannels(client, guildId, wanted) {
  for (const destination of Object.keys(wanted)) {
    if (!LOG_DESTINATIONS.includes(destination)) throw new Error(`Invalid log destination: ${destination}`);
  }
  let changes = [];
  await updateGuildConfigAtomic(client, guildId, (config) => {
    const channels = { ...(config.logging?.channels || {}) };
    changes = [];
    for (const [destination, channelId] of Object.entries(wanted)) {
      const old = channels[destination] || null;
      if ((channelId || null) === old) continue;
      channels[destination] = channelId || null;
      changes.push({ destination, old, new: channelId || null });
    }
    if (!changes.length) return config;
    const logging = { ...config.logging, channels };
    if (changes.some((c) => c.new)) logging.enabled = true;
    return { ...config, logging };
  }, { operation: 'setLogChannels' });
  // A newly chosen channel is tried right away, even if it was paused after a refusal.
  for (const change of changes) if (change.new) logChannelBackoff.delete(backoffKey(guildId, change.new));
  return changes;
}

/**
 * "Advanced" (forum) log kinds in ONE locked write (the dashboard's Advanced logs form):
 * wanted = { kind: forumChannelId | null } (null = normal). Returns [{ kind, old, new }] for the
 * ones that changed against the locked stored value. Throws on a database error (nothing saved).
 */
export async function setLogForums(client, guildId, wanted) {
  for (const kind of Object.keys(wanted)) {
    if (!LOG_FORUM_KINDS.includes(kind)) throw new Error(`Invalid log forum kind: ${kind}`);
  }
  let changes = [];
  await updateGuildConfigAtomic(client, guildId, (config) => {
    const forums = { ...(config.logging?.forums || {}) };
    changes = [];
    for (const [kind, forumId] of Object.entries(wanted)) {
      const old = forums[kind] || null;
      if ((forumId || null) === old) continue;
      if (forumId) forums[kind] = forumId; else delete forums[kind];
      changes.push({ kind, old, new: forumId || null });
    }
    if (!changes.length) return config;
    return { ...config, logging: { ...config.logging, forums } };
  }, { operation: 'setLogForums' });
  return changes;
}

export async function setLogChannel(client, guildId, destination, channelId) {
  if (!LOG_DESTINATIONS.includes(destination)) {
    throw new Error(`Invalid log destination: ${destination}`);
  }

  // A log channel must be a channel of this server (the commands and the dashboard only offer
  // those; this also refuses an id of another server's channel from any other caller).
  const guild = client?.guilds?.cache?.get?.(guildId);
  if (channelId && guild?.channels?.cache && !guild.channels.cache.has(String(channelId))) {
    logger.warn(`setLogChannel: ${channelId} is not a channel of guild ${guildId}; not saved`);
    return false;
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
    // A newly chosen channel is tried right away, even if it was paused after a refusal.
    if (channelId) logChannelBackoff.delete(backoffKey(guildId, channelId));
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

export { EVENT_TYPES, EVENT_COLORS, EVENT_TITLES, LOG_DESTINATIONS };
