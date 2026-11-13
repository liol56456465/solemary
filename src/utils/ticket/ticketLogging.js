// ticketLogging.js

import { ChannelType } from 'discord.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { logger } from '../logger.js';
import {
  buildStandardLogEmbed,
  formatRatingStars,
  resolveUserAuthor,
} from '../logging/logEmbeds.js';
import { LOW_RATING_MAX, commentFieldName, commentFieldValue } from '../../services/ticketRatingService.js';
import { logForumId, sendToLogForum } from '../../services/logForum.js';

export async function logTicketEvent({ client, guildId, event }) {
  try {
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      logger.warn(`logTicketEvent invoked without valid guild: ${guildId}`);
      return;
    }

    const config = await getGuildConfig(client, guildId);

    // Advanced (logForum.js, owner 2026-11-13): the tickets forum keeps only a member's useful ticket
    // history in their post: reviews here, the close summary + transcript in ticket.js. Routine events
    // (opened, claimed, pinned, priority, deleted…) are not posted anywhere then, not even the channel.
    const forumId = logForumId(config, 'tickets');
    if (forumId && !FORUM_EVENTS.has(event.type)) {
      return null;
    }
    const logChannelId = getLogChannelForEventType(config, event.type);
    if (!logChannelId && !forumId) {
      return null;
    }

    const embed = await createTicketLogEmbed(guild, event, { forum: Boolean(forumId) });
    const files = event.attachments?.length > 0 ? event.attachments : null;

    if (forumId) {
      // The member the ticket is about: its opener. On any failure the normal channel below.
      const subjectId = event.userId || null;
      const posted = await sendToLogForum({
        guild, forumId,
        subject: subjectId ? { id: String(subjectId) } : null,
        payload: { embeds: [embed], ...(files ? { files } : {}) },
      });
      if (posted) {
        logger.info(`Ticket event logged in the log forum: ${event.type} in guild ${guildId}`);
        return posted;
      }
    }
    if (!logChannelId) {
      return null;
    }

    const channel = guild.channels.cache.get(logChannelId) || await guild.channels.fetch(logChannelId).catch(() => null);
    if (!channel) {
      logger.warn(`Ticket log channel not found: ${logChannelId} for event type: ${event.type}`);
      return null;
    }

    const permissions = channel.permissionsFor(guild.members.me);
    if (!permissions.has(['SendMessages', 'EmbedLinks'])) {
      logger.warn(`Missing permissions in ticket log channel: ${logChannelId}`);
      return null;
    }

    // Log embeds name members as mentions; nothing in a log ever pings.
    const messageOptions = { embeds: [embed], allowedMentions: { parse: [] } };

    if (files) {
      messageOptions.files = files;
    }

    const sent = await channel.send(messageOptions);
    logger.info(`Ticket event logged: ${event.type} in guild ${guildId}`);
    return sent;
  } catch (error) {
    logger.error('Error logging ticket event:', error);
    return null;
  }
}

export async function logTicketFeedback({
  client,
  guildId,
  ticketNumber,
  ticketChannelId,
  userId,
  rating = null,
  comment = null,
  flagged = false,
  staffId = null,
  kind = 'ticket',
}) {
  await logTicketEvent({
    client,
    guildId,
    event: {
      type: 'feedback',
      ticketId: ticketChannelId,
      ticketNumber,
      userId,
      metadata: {
        rating,
        comment,
        flagged: Boolean(flagged),
        staffId,
        kind,
      },
    },
  });
}

/** Ticket events that go in the member's post when the tickets log is Advanced (the rest are skipped). */
const FORUM_EVENTS = new Set(['feedback', 'transcript']);

function getLogChannelForEventType(config, eventType) {
  switch (eventType) {
    case 'transcript':
      return config.ticketTranscriptChannelId || null;

    case 'open':
    case 'close':
    case 'delete':
    case 'claim':
    case 'unclaim':
    case 'priority':
    case 'pin':
    case 'unpin':
    case 'feedback':
      return config.ticketLogsChannelId || null;

    default:
      return null;
  }
}

const TICKET_EVENT_STYLES = {
  open: { color: 0x5865F2, title: 'Ticket opened' },
  close: { color: 0xED4245, title: 'Ticket closed' },
  delete: { color: 0x8b0000, title: 'Ticket deleted' },
  claim: { color: 0x5865F2, title: 'Ticket claimed' },
  unclaim: { color: 0xFAA61A, title: 'Ticket unclaimed' },
  priority: { color: 0x9b59b6, title: 'Priority changed' },
  transcript: { color: 0x57F287, title: 'Transcript saved' },
  feedback: { color: 0x57F287, title: 'Ticket feedback' },
};

async function createTicketLogEmbed(guild, event, { forum = false } = {}) {
  const style = TICKET_EVENT_STYLES[event.type] || { color: 0x95a5a6, title: 'Ticket event' };
  const ticketNumber = event.ticketNumber || event.ticketId;
  const ticketRef = ticketNumber ? `#${ticketNumber}` : 'Unknown';
  const channelMention = event.ticketId ? `<#${event.ticketId}>` : null;
  const executorMention = event.executorId ? `<@${event.executorId}>` : null;
  const userMention = event.userId ? `<@${event.userId}>` : null;

  let inlineFields = [];
  let fields = [];
  let author = null;
  let footer = { text: 'Mewvo tickets' };

  switch (event.type) {
    case 'open':
      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Creator', value: userMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      if (event.reason) {
        fields.push({ name: 'Reason', value: String(event.reason).slice(0, 1024), inline: false });
      }
      break;

    case 'close':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Closed by', value: executorMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      if (event.reason) {
        fields.push({ name: 'Reason', value: String(event.reason).slice(0, 1024), inline: false });
      }
      break;

    case 'delete':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Deleted by', value: executorMention || 'Unknown', inline: true },
      ];
      break;

    case 'claim':
    case 'unclaim':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        {
          name: event.type === 'claim' ? 'Claimed by' : 'Unclaimed by',
          value: executorMention || 'Unknown',
          inline: true,
        },
      ];
      break;

    case 'priority': {
      const priorityLabel = event.priority
        ? `${event.priority.charAt(0).toUpperCase()}${event.priority.slice(1)}`
        : 'Unknown';
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Priority', value: priorityLabel, inline: true },
        { name: 'Updated by', value: executorMention || 'Unknown', inline: true },
      ];
      break;
    }

    case 'transcript':
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Creator', value: userMention || 'Unknown', inline: true },
      ];
      if (event.metadata?.messageCount) {
        inlineFields.push({ name: 'Messages', value: String(event.metadata.messageCount), inline: true });
      }
      if (event.metadata?.duration) {
        fields.push({ name: 'Duration', value: String(event.metadata.duration), inline: false });
      }
      if (event.metadata?.subject || event.reason) {
        fields.push({
          name: 'Subject',
          value: String(event.metadata?.subject || event.reason).slice(0, 1024),
          inline: false,
        });
      }
      break;

    case 'feedback': {
      const rating = event.metadata?.rating ?? event.rating;
      const comment = event.metadata?.comment;
      const ratingDisplay = formatRatingStars(rating) || 'No rating';

      const staffId = event.metadata?.staffId;
      const flagged = Boolean(event.metadata?.flagged);

      // A rating whose opener ran /wipedata has no user any more.
      author = event.userId ? await resolveUserAuthor(guild.client, event.userId) : null;
      inlineFields = [
        { name: event.metadata?.kind === 'modmail' ? 'Modmail' : 'Ticket', value: event.metadata?.kind === 'modmail' ? (channelMention || 'Modmail') : ticketRef, inline: true },
        { name: 'Rating', value: ratingDisplay, inline: true },
      ];
      if (staffId) {
        inlineFields.push({ name: 'Handled by', value: `<@${staffId}>`, inline: true });
      }
      // Advanced: the member's post is their record, so a low rating is said in so many words (the
      // alert itself goes to the alerts channel, ticketRatingEffects.postLowRatingAlert).
      if (forum && rating !== null && rating !== undefined && Number(rating) <= LOW_RATING_MAX) {
        inlineFields.push({ name: 'Low rating', value: `Yes (${LOW_RATING_MAX}/5 or less)`, inline: true });
      }

      if (comment) {
        fields.push({
          name: commentFieldName(flagged),
          value: commentFieldValue(comment, flagged),
          inline: false,
        });
      }
      break;
    }

    default:
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
      ];
      if (event.reason) {
        fields.push({ name: 'Details', value: String(event.reason).slice(0, 1024), inline: false });
      }
  }

  return buildStandardLogEmbed({
    color: style.color,
    title: style.title,
    inlineFields,
    fields,
    author,
    footer,
  });
}

export async function getTicketLoggingConfig(client, guildId) {
  const config = await getGuildConfig(client, guildId);
  return {
    enabled: !!(config.ticketLogsChannelId || config.ticketTranscriptChannelId),
    lifecycleChannelId: config.ticketLogsChannelId || null,
    transcriptChannelId: config.ticketTranscriptChannelId || null,
  };
}

export function validateLogChannel(channel, botMember) {
  if (!channel || channel.type !== ChannelType.GuildText) {
    return {
      valid: false,
      error: 'Channel must be a text channel.',
    };
  }

  const permissions = channel.permissionsFor(botMember);
  const requiredPermissions = ['SendMessages', 'EmbedLinks'];

  const missing = requiredPermissions.filter((perm) => !permissions.has(perm));

  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing permissions: ${missing.join(', ')}`,
    };
  }

  return { valid: true };
}

