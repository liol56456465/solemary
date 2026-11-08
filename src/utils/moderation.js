// moderation.js

import { logEvent as logAuditEvent, EVENT_TYPES } from '../services/loggingService.js';
import { formatLogLine } from './logging/logEmbeds.js';
import { logger } from './logger.js';

const ACTION_TO_EVENT_TYPE = {
  'Member Banned': EVENT_TYPES.MODERATION_BAN,
  'Member Kicked': EVENT_TYPES.MODERATION_KICK,
  'Member Timed Out': EVENT_TYPES.MODERATION_TIMEOUT,
  'Member Untimeouted': EVENT_TYPES.MODERATION_UNTIMEOUT,
  'Member Unbanned': EVENT_TYPES.MODERATION_UNBAN,
  'User Warned': EVENT_TYPES.MODERATION_WARN,
  'Warnings Viewed': EVENT_TYPES.MODERATION_WARN,
  'Messages Purged': EVENT_TYPES.MODERATION_PURGE,
  'Channel Locked': EVENT_TYPES.MODERATION_LOCK,
  'Channel Unlocked': EVENT_TYPES.MODERATION_UNLOCK,
  'DM Sent': EVENT_TYPES.MODERATION_DM,
  'Bot Message Sent': EVENT_TYPES.MODERATION_CONFIG,
  'Log Channel Activated': EVENT_TYPES.MODERATION_CONFIG,
  'Log Filter Updated': EVENT_TYPES.MODERATION_CONFIG,
  'Case Created': EVENT_TYPES.MODERATION_CONFIG,
  'Case Updated': EVENT_TYPES.MODERATION_CONFIG,
};

function buildModerationLogData(event) {
  const targetIdMatch = event.target?.match(/\((\d+)\)/);
  const targetId = targetIdMatch?.[1];
  const executorIdMatch = event.executor?.match(/\((\d+)\)/);
  const executorTag = event.executor?.split(' (')[0] || 'Moderator';

  const lines = [];
  if (event.target) {
    lines.push(formatLogLine('User', event.target));
  }
  if (event.reason) {
    const reason = event.reason.length > 900
      ? `${event.reason.substring(0, 897)}...`
      : event.reason;
    lines.push(formatLogLine('Reason', reason));
  }
  if (event.duration) {
    lines.push(formatLogLine('Duration', event.duration));
  }
  if (event.caseId) {
    lines.push(formatLogLine('Case', `\`${event.caseId}\``));
  }

  const meta = [];
  if (event.metadata) {
    Object.entries(event.metadata).forEach(([key, value]) => {
      if (value !== undefined && value !== null && key !== 'userId' && key !== 'moderatorId') {
        meta.push([key.charAt(0).toUpperCase() + key.slice(1), String(value)]);
      }
    });
  }

  const title = event.caseId ? `${event.action} · Case #${event.caseId}` : event.action;

  return {
    title,
    lines,
    meta,
    userId: event.metadata?.userId || targetId || undefined,
    thumbnail: targetId ? `https://cdn.discordapp.com/embed/avatars/${Number(targetId) % 5}.png` : undefined,
    footer: executorIdMatch
      ? { text: executorTag, iconURL: undefined }
      : undefined,
  };
}

export async function logEvent({ client, guild, guildId, event }) {
  try {
    if (!guild && guildId) {
      guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    }
    if (!guild) {
      logger.warn('logEvent invoked without valid guild or guildId');
      return;
    }

    const eventType = ACTION_TO_EVENT_TYPE[event.action] || EVENT_TYPES.MODERATION_CONFIG;
    const data = buildModerationLogData(event);

    await logAuditEvent({
      client,
      guildId: guild.id,
      eventType,
      data,
    });

    logger.info(`Moderation action logged: ${event.action} by ${event.executor} on ${event.target} in guild ${guild.id}`);
  } catch (error) {
    logger.error('Error logging moderation event:', error);
  }
}
