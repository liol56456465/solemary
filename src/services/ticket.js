// ticket.js

import {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  AttachmentBuilder,
} from 'discord.js';
import { buildStandardLogEmbed, formatLogLine } from '../utils/logging/logEmbeds.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getTicketData, saveTicketData, deleteTicketData, getOpenTicketCountForUser, incrementTicketCounter } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { createEmbed, errorEmbed } from '../utils/embeds.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { noteTicketClaim } from './staffActivityService.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { ensureTypedServiceError, wrapServiceBoundary } from '../utils/serviceErrorBoundary.js';
import { PRIORITY_MAP } from '../utils/helpers.js';
import { LANG_CODES, botText, textForGuild } from '../utils/botText.js';
import { sendLoggedDm } from './botDm/dmLog.js';
import { createPendingRating, handlingStaffId, ratingSettings, setRatingDelivery } from './ticketRatingService.js';
import { channelSurveyPayload } from './ticketRatingEffects.js';
const TICKET_DELETE_DELAY_MS = 3000;
const TICKET_DELETE_DELAY_SECONDS = Math.floor(TICKET_DELETE_DELAY_MS / 1000);
const TICKET_SERVICE = 'ticketService';

function ticketUserError(message, userMessage, type = ErrorTypes.VALIDATION, context = {}) {
  throw createError(message, type, userMessage, { service: TICKET_SERVICE, ...context });
}

// Language (docs/bot-i18n.md, "mixed" rule): a refusal goes to the person who acted, so it is in
// their language (`{ lang }` from the caller, default English); posts in the ticket channel and
// DMs to the ticket creator are in the server's language.
const publicText = (guild) => textForGuild(guild?.id ?? null, { purpose: 'public' });

// The same text in every language: the ticket's own messages are found again by their title or
// field name, also when they were posted in another language (before the server switched).
const allLanguages = (key, params) => new Set(LANG_CODES.map((lang) => botText(lang).t(key, params)));
const lazy = (make) => { let value; return () => (value ??= make()); };
const OPENING_TITLE_PREFIXES = lazy(() => [...allLanguages('ticket.opening.title', { number: '' })].filter(Boolean));
const STATUS_FIELD_NAMES = lazy(() => allLanguages('ticket.opening.status'));
const CLAIMED_FIELD_NAMES = lazy(() => allLanguages('ticket.opening.claimedBy'));
const CLAIM_STATUS_TITLES = lazy(() => new Set([...allLanguages('ticket.post.claimedTitle'), ...allLanguages('ticket.post.unclaimedTitle')]));
const CLOSED_TITLES = lazy(() => allLanguages('ticket.post.closedTitle'));
const PRIORITY_LINE_PREFIXES = lazy(() => [...allLanguages('ticket.opening.priorityLine', { priority: '' })]);

/** True for the ticket's opening message ("Ticket #12" in any language). */
export function isOpeningMessage(message) {
  const title = message?.embeds?.[0]?.title;
  return typeof title === 'string' && OPENING_TITLE_PREFIXES().some((prefix) => title.startsWith(prefix));
}

/** The opening message's description without its priority line (any language). */
export function withoutPriorityLine(description) {
  const text = String(description ?? '');
  const cuts = PRIORITY_LINE_PREFIXES().map((prefix) => text.indexOf(prefix)).filter((index) => index >= 0);
  return cuts.length ? text.slice(0, Math.min(...cuts)) : text;
}

const PRIORITY_KEYS = {
  none: 'ticket.priority.none',
  low: 'ticket.priority.low',
  medium: 'ticket.priority.medium',
  high: 'ticket.priority.high',
  urgent: 'ticket.priority.urgent',
};

/** A priority's name in `tr`'s language ("High"); an unknown value as it is. */
export function priorityLabel(priority, tr = botText('en')) {
  return PRIORITY_KEYS[priority] ? tr.t(PRIORITY_KEYS[priority]) : (PRIORITY_MAP[priority]?.label ?? String(priority));
}

function requireTicket(ticketData, channel, tr = botText('en')) {
  if (!ticketData) {
    ticketUserError(
      'Not a ticket channel',
      tr.t('ticket.service.notTicket'),
      ErrorTypes.VALIDATION,
      { channelId: channel?.id, guildId: channel?.guild?.id }
    );
  }
  return ticketData;
}

function rethrowTicketError(error, operation, userMessage, context = {}) {
  throw ensureTypedServiceError(error, {
    service: TICKET_SERVICE,
    operation,
    message: `Ticket operation failed: ${operation}`,
    userMessage,
    context,
  });
}



function buildTicketControlRow({ claimedBy = null } = {}, tr = botText('en')) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel(claimedBy ? tr.t('ticket.control.claimed') : tr.t('ticket.control.claim'))
      .setStyle(claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(!!claimedBy),
    new ButtonBuilder()
      .setCustomId('ticket_pin')
      .setLabel(tr.t('ticket.control.pin'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel(tr.t('ticket.control.close'))
      .setStyle(ButtonStyle.Danger),
  );
}

const TICKET_MEMBER_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
];

// The bot needs its own overwrite: @everyone is denied ViewChannel, and a bot without
// Administrator would otherwise be locked out of the channel it just made.
const TICKET_BOT_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageChannels,
];

/** Overwrites for a new ticket channel: @everyone denied; the opener, the bot and the staff role allowed. */
export function buildTicketPermissionOverwrites({ guildId, memberId, botId = null, staffRoleId = null }) {
  return [
    { id: guildId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: memberId, allow: [...TICKET_MEMBER_ALLOW] },
    ...(botId ? [{ id: botId, allow: [...TICKET_BOT_ALLOW] }] : []),
    ...(staffRoleId ? [{ id: staffRoleId, allow: [...TICKET_MEMBER_ALLOW] }] : []),
  ];
}

/**
 * Saves the ticket row, then posts the opening message. When either step fails the channel is
 * deleted and the row removed (best effort), and the original error is rethrown.
 */
export async function saveAndPostTicketOpening({ channel, save, removeRow, payload }) {
  try {
    await save();
    return await channel.send(payload);
  } catch (error) {
    // Removing a row that was never written is harmless; a save that threw may have written it.
    await Promise.resolve().then(removeRow).catch((cleanupError) => {
      logger.warn('Could not remove the row of a ticket that failed to open', { channelId: channel?.id, error: cleanupError?.message });
    });
    await Promise.resolve().then(() => channel.delete('Ticket could not be opened')).catch((cleanupError) => {
      logger.warn('Could not delete a ticket channel that failed to open', { channelId: channel?.id, error: cleanupError?.message });
    });
    throw error;
  }
}

export const getUserTicketCount = wrapServiceBoundary(async function getUserTicketCount(guildId, userId) {
  return await getOpenTicketCountForUser(guildId, userId);
}, {
  service: TICKET_SERVICE,
  operation: 'getUserTicketCount',
  userMessage: 'Failed to count open tickets.',
  context: {},
});

// The default reason is stored on the ticket record and goes into the logs: kept in English.
export async function createTicket(guild, member, categoryId, reason = 'No reason provided', priority = 'none', { lang = 'en' } = {}) {
  const tr = botText(lang);
  try {
    const config = await getGuildConfig(guild.client, guild.id);
    const ticketConfig = config.tickets || {};
    
    const maxTicketsPerUser = config.maxTicketsPerUser ?? 3;
    const currentTicketCount = await getUserTicketCount(guild.id, member.id);
    
    if (currentTicketCount >= maxTicketsPerUser) {
      ticketUserError(
        `Max open tickets reached for ${member.id}`,
        tr.t('ticket.service.maxTickets', { max: maxTicketsPerUser }),
        ErrorTypes.VALIDATION,
        { guildId: guild.id, userId: member.id, operation: 'createTicket' }
      );
    }
    
    let category = categoryId ? 
      guild.channels.cache.get(categoryId) :
      guild.channels.cache.find(c => 
        c.type === ChannelType.GuildCategory && 
        c.name.toLowerCase().includes('tickets')
      );
    
    if (!category && !categoryId) {
      category = await guild.channels.create({
        name: 'Tickets',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          ...((guild.members?.me?.id ?? guild.client?.user?.id)
            ? [{ id: guild.members?.me?.id ?? guild.client.user.id, allow: [...TICKET_BOT_ALLOW] }]
            : []),
        ],
      });
    }
    
    const ticketNumber = await getNextTicketNumber(guild.id);
    
    let channelName = `ticket-${ticketNumber}`;
    
    if (priority !== 'none') {
      const priorityInfo = PRIORITY_MAP[priority];
      if (priorityInfo) {
        channelName = `${priorityInfo.emoji} ${channelName}`;
      }
    }
    
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: buildTicketPermissionOverwrites({
        guildId: guild.id,
        memberId: member.id,
        botId: guild.members?.me?.id ?? guild.client?.user?.id ?? null,
        staffRoleId: config.ticketStaffRoleId || null,
      }),
    });
    
    const ticketData = {
      id: channel.id,
      userId: member.id,
      guildId: guild.id,
      createdAt: new Date().toISOString(),
      status: 'open',
      claimedBy: null,
      priority: priority || 'none',
      reason,
      // The visible number (ticket-012): ratings and their stats show it.
      number: ticketNumber,
    };
    
    const priorityInfo = PRIORITY_MAP[priority] || PRIORITY_MAP.none;
    const pub = publicText(guild);

    const embed = createEmbed({
      title: pub.t('ticket.opening.title', { number: ticketNumber }),
      description: pub.t('ticket.opening.body', { member: member.toString(), reason })
        + pub.t('ticket.opening.priorityLine', { priority: priorityLabel(PRIORITY_MAP[priority] ? priority : 'none', pub) }),
      color: priorityInfo.color,
      fields: [
        { name: pub.t('ticket.opening.status'), value: pub.t('ticket.opening.statusOpen'), inline: true },
        { name: pub.t('ticket.opening.claimedBy'), value: pub.t('ticket.opening.notClaimed'), inline: true },
        { name: pub.t('ticket.opening.created'), value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
      ],
    });

    const row = buildTicketControlRow({}, pub);

    if (ticketConfig.enablePriority) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_priority:low')
          .setLabel(priorityLabel('low', pub))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('ticket_priority:high')
          .setLabel(priorityLabel('high', pub))
          .setStyle(ButtonStyle.Danger)
      );
    }
    
    const staffMention = config.ticketStaffRoleId ? ` <@&${config.ticketStaffRoleId}>` : '';
    const messageContent = `${member.toString()}${staffMention}`;
    
    // The row is saved and the opening message posted together: if either fails the channel and
    // the row go again, so a half-made ticket never counts against maxTicketsPerUser.
    const ticketMessage = await saveAndPostTicketOpening({
      channel,
      save: () => saveTicketData(guild.id, channel.id, ticketData),
      removeRow: () => deleteTicketData(guild.id, channel.id),
      payload: {
        content: messageContent,
        embeds: [embed],
        components: [row],
        // The client default pings no roles; the staff role is pinged here on purpose.
        allowedMentions: { users: [member.id], roles: config.ticketStaffRoleId ? [config.ticketStaffRoleId] : [] },
      },
    });

    await ticketMessage.pin().catch(() => {});
    
    await logTicketEvent({
      client: guild.client,
      guildId: guild.id,
      event: {
        type: 'open',
        ticketId: channel.id,
        ticketNumber: ticketNumber,
        userId: member.id,
        executorId: member.id,
        reason: reason,
        priority: priority || 'none',
        metadata: {
          channelId: channel.id,
          categoryName: category?.name || 'Default'
        }
      }
    });
    
    return { channel, ticketData };
    
  } catch (error) {
    rethrowTicketError(error, 'createTicket', tr.t('ticket.service.createFailed'), { guildId: guild?.id, userId: member?.id });
  }
}

/**
 * The pending rating row of a ticket that is being closed, or null: ratings off in this server,
 * the ticket already rated (a re-close after a reopen keeps it), or the database down (logged;
 * the close goes on without a survey). `deps` for tests: { create }.
 */
export async function prepareTicketRating(channel, ticketData, closer, config, { create = createPendingRating } = {}) {
  const settings = ratingSettings(config);
  if (!settings.ticketsEnabled) return null;
  try {
    return await create({
      guildId: channel.guild.id, kind: 'ticket', refId: channel.id, ticketNumber: ticketNumberOf(ticketData, channel),
      openerId: ticketData.userId, staffId: handlingStaffId(ticketData, closer.id), closerId: closer.id,
      priority: ticketData.priority || null, windowDays: settings.windowDays,
    });
  } catch (error) {
    logger.warn(`Ticket rating row not written for ${channel.id}; no survey this time: ${error.message}`);
    return null;
  }
}

/** The visible ticket number: stored since the ratings upgrade, else from the channel name (ticket-012). */
export function ticketNumberOf(ticketData, channel) {
  const stored = String(ticketData?.number ?? '');
  if (/^\d{1,10}$/.test(stored)) return stored;
  return String(channel?.name ?? '').match(/ticket-(\d{1,10})/)?.[1] ?? null;
}

/**
 * The opener's overwrite on a closed ticket: read-only while the rating survey waits there (O2), else
 * hidden. The read-only view is taken away once the survey is done (ticketRatingEffects.js
 * hideClosedTicketFromOpener + the 10-minute sweep).
 */
export function closedOpenerAccess(surveyInChannel) {
  return surveyInChannel
    ? { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }
    : { ViewChannel: false, SendMessages: false };
}

/**
 * O2: the survey DM failed, so it is posted in the ticket channel (no pings), and the delivery
 * saved ('channel'). When even that fails: 'failed', and the opener loses the view like any closed
 * ticket. Returns the delivery. Never throws. `deps` for tests: { payload, setDelivery }.
 */
export async function postChannelSurvey(channel, ticketData, row, { payload = channelSurveyPayload, setDelivery = setRatingDelivery } = {}) {
  let posted = null;
  try {
    posted = await channel.send(await payload({
      guildId: channel.guild.id, channelId: channel.id, channelName: channel.name, openerId: ticketData.userId,
    }));
  } catch (error) {
    logger.warn(`Ticket rating survey not posted in ${channel.id}: ${error.message}`);
  }
  const delivery = posted ? 'channel' : 'failed';
  await noteRatingDelivery(row, delivery, setDelivery);
  if (!posted) {
    await channel.permissionOverwrites.edit(ticketData.userId, closedOpenerAccess(false))
      .catch((error) => logger.warn(`Could not hide closed ticket ${channel.id} from its opener: ${error.message}`));
  }
  return delivery;
}

async function noteRatingDelivery(row, delivery, setDelivery = setRatingDelivery) {
  if (!row?.id) return;
  await setDelivery(row.id, delivery).catch((error) => logger.warn(`Ticket rating delivery not saved: ${error.message}`));
}

export async function closeTicket(channel, closer, reason = 'No reason provided', { lang = 'en' } = {}) {
  const tr = botText(lang);
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel, tr);
    if (ticketData.status === 'closed') {
      ticketUserError(
        'Ticket is already closed',
        tr.t('ticket.service.alreadyClosed'),
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'closeTicket' }
      );
    }
    
    const config = await getGuildConfig(channel.client, channel.guild.id);
    const dmOnClose = config.dmOnClose !== false;
    const closedCategoryId = config.ticketClosedCategoryId || null;
    let movedToClosedCategory = false;
    
    ticketData.status = 'closed';
    ticketData.closedBy = closer.id;
    ticketData.closedAt = new Date().toISOString();
    ticketData.closeReason = reason;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    if (closedCategoryId && channel.parentId !== closedCategoryId) {
      const closedCategory = channel.guild.channels.cache.get(closedCategoryId)
        || await channel.guild.channels.fetch(closedCategoryId).catch(() => null);

      if (closedCategory?.type === ChannelType.GuildCategory) {
        try {
          await channel.setParent(closedCategoryId, { lockPermissions: false });
          movedToClosedCategory = true;
        } catch (moveError) {
            logger.warn(`Could not move ticket ${channel.id} to closed category ${closedCategoryId}: ${moveError.message}`);
        }
      } else {
        logger.warn(`Configured closed category is invalid for guild ${channel.guild.id}: ${closedCategoryId}`);
      }
    }
    
    let ticketCreator = null;
    let closeNotificationSent = false;
    let feedbackSurveySent = false;
    try {
      ticketCreator = await channel.client.users.fetch(ticketData.userId).catch(() => null);
    } catch (dmError) {
      logger.warn(`Could not fetch ticket creator ${ticketData.userId}: ${dmError.message}`);
    }

    // DMs to the ticket creator (their language role, else the server's language; logged so a
    // language change can edit them: services/botDm/) and posts in the ticket channel (the server's).
    const pub = publicText(channel.guild);
    const creatorMember = channel.guild.members?.cache?.get?.(ticketData.userId) ?? null;
    if (dmOnClose && ticketCreator) {
      closeNotificationSent = await sendLoggedDm(ticketCreator, {
        key: 'ticket.closed',
        params: { channelName: channel.name, reason, closer: closer.tag, time: Math.floor(Date.now() / 1000), ticketId: ticketData.id },
        guildId: channel.guild.id, member: creatorMember, label: 'ticket closure',
      }).catch((error) => {
        logger.warn(`Ticket DM to ${ticketData.userId} not built: ${error.message}`);
        return false;
      });
    }

    // Rating survey (ticketRatingService.js): a pending row first (the claimer at close, else the
    // closer), then the DM. No row (ratings off, already rated before a reopen, database down): no survey.
    const rating = await prepareTicketRating(channel, ticketData, closer, config);
    if (rating && ticketCreator) {
      feedbackSurveySent = await sendLoggedDm(ticketCreator, {
        key: 'ticket.feedback',
        params: { channelName: channel.name, guildId: channel.guild.id, channelId: channel.id },
        guildId: channel.guild.id, member: creatorMember, label: 'ticket feedback survey',
      }).catch((error) => {
        logger.warn(`Ticket DM to ${ticketData.userId} not built: ${error.message}`);
        return false;
      });
    } else if (rating) {
      logger.warn(`Could not deliver feedback survey by DM; ticket creator ${ticketData.userId} could not be fetched`);
    }
    // O2: the DM failed → the survey goes into the ticket channel, the opener keeps a read-only view.
    const surveyInChannel = Boolean(rating && !feedbackSurveySent);
    if (rating && feedbackSurveySent) await noteRatingDelivery(rating, 'dm');
    
    try {
      const user = await channel.guild.members.fetch(ticketData.userId).catch(() => null);
      const targetUser = user?.user || await channel.client.users.fetch(ticketData.userId).catch(() => null);
      
      if (targetUser) {
        const closedAccess = closedOpenerAccess(surveyInChannel);
        const overwrite = channel.permissionOverwrites.cache.get(ticketData.userId);
        if (overwrite) {
          await overwrite.edit(closedAccess);
        } else {
          await channel.permissionOverwrites.create(targetUser, closedAccess);
        }
      }
    } catch (permError) {
        logger.warn(`Could not update user permissions for closed ticket: ${permError.message}`);
    }
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(isOpeningMessage);

    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const statusField = embed.fields?.find(f => STATUS_FIELD_NAMES().has(f.name));

      if (statusField) {
        statusField.value = pub.t('ticket.opening.statusClosed');
      }

      const updatedEmbed = createEmbed({
        title: embed.title || pub.t('ticket.opening.fallbackTitle'),
        description: embed.description || pub.t('ticket.opening.fallbackDescription'),
        color: '#e74c3c',
        fields: embed.fields || [],
        footer: embed.footer
      });
      
      await ticketMessage.edit({ 
        embeds: [updatedEmbed],
components: []
      });
    }
    
    const closeEmbed = createEmbed({
      title: pub.t('ticket.post.closedTitle'),
      description: pub.t('ticket.post.closedBody', { closer: String(closer), reason })
        + (closeNotificationSent ? pub.t('ticket.post.closedDmSent') : dmOnClose ? pub.t('ticket.post.closedDmFailed') : ''),
      color: '#e74c3c',
      footer: { text: pub.t('ticket.post.ticketId', { id: ticketData.id }) }
    });

    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_reopen')
        .setLabel(pub.t('ticket.control.reopen'))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('ticket_delete')
        .setLabel(pub.t('ticket.control.delete'))
        .setStyle(ButtonStyle.Danger)
    );
    
    await channel.send({ embeds: [closeEmbed], components: [controlRow] });

    if (surveyInChannel) await postChannelSurvey(channel, ticketData, rating);
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'close',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: closer.id,
        reason: reason,
        metadata: {
          dmSent: closeNotificationSent,
          feedbackSurveySent,
          closedAt: ticketData.closedAt,
          movedToClosedCategory
        }
      }
    });

    try {
      await deliverTicketTranscript(channel, ticketData, closer, { persist: true });
    } catch (transcriptError) {
      logger.error('Ticket closed, but transcript delivery failed', {
        guildId: channel.guild.id,
        channelId: channel.id,
        ticketNumber: ticketData.id,
        error: transcriptError.message,
      });
    }
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'closeTicket', tr.t('ticket.service.closeFailed'), { guildId: channel?.guild?.id, channelId: channel?.id, closerId: closer?.id });
  }
}

export async function claimTicket(channel, claimer, { lang = 'en' } = {}) {
  const tr = botText(lang);
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel, tr);

    if (ticketData.claimedBy) {
      ticketUserError(
        'Ticket already claimed',
        tr.t('ticket.service.alreadyClaimed', { userId: ticketData.claimedBy }),
        ErrorTypes.VALIDATION,
        { channelId: channel.id, claimedBy: ticketData.claimedBy, operation: 'claimTicket' }
      );
    }
    
    ticketData.claimedBy = claimer.id;
    ticketData.claimedAt = new Date().toISOString();
    noteTicketClaim(channel.guild.id, claimer.id);
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);
    const pub = publicText(channel.guild);

    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(isOpeningMessage);

    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const claimedField = embed.fields?.find(f => CLAIMED_FIELD_NAMES().has(f.name));

      if (claimedField) {
        claimedField.value = claimer.toString();
      }

      const row = buildTicketControlRow({ claimedBy: claimer.id }, pub);
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const claimEmbed = createEmbed({
      title: pub.t('ticket.post.claimedTitle'),
      description: pub.t('ticket.post.claimedBody', { user: String(claimer) }),
      color: '#2ecc71'
    });

    const unclaimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_unclaim')
        .setLabel(pub.t('ticket.control.unclaim'))
        .setStyle(ButtonStyle.Secondary)
    );

    const claimStatusMessage = messages.find(m =>
      m.embeds.length > 0 &&
      CLAIM_STATUS_TITLES().has(m.embeds[0].title)
    );

    if (claimStatusMessage) {
      await claimStatusMessage.edit({ embeds: [claimEmbed], components: [unclaimRow] });
    } else {
      await channel.send({ embeds: [claimEmbed], components: [unclaimRow] });
    }
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'claim',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: claimer.id,
        metadata: {
          claimedAt: ticketData.claimedAt
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'claimTicket', tr.t('ticket.service.claimFailed'), { guildId: channel?.guild?.id, channelId: channel?.id, claimerId: claimer?.id });
  }
}

export async function reopenTicket(channel, reopener, { lang = 'en' } = {}) {
  const tr = botText(lang);
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel, tr);

    if (ticketData.status !== 'closed') {
      ticketUserError(
        'Ticket not closed',
        tr.t('ticket.service.notClosed'),
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'reopenTicket' }
      );
    }

    const config = await getGuildConfig(channel.client, channel.guild.id);
    const openCategoryId = config.ticketCategoryId || null;
    let movedToOpenCategory = false;
    let openCategoryMoveFailed = false;
    
    ticketData.status = 'open';
    ticketData.closedBy = null;
    ticketData.closedAt = null;
    ticketData.closeReason = null;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    if (openCategoryId && channel.parentId !== openCategoryId) {
      const openCategory = channel.guild.channels.cache.get(openCategoryId)
        || await channel.guild.channels.fetch(openCategoryId).catch(() => null);

      if (openCategory?.type === ChannelType.GuildCategory) {
        try {
          await channel.setParent(openCategoryId, { lockPermissions: false });
          movedToOpenCategory = true;
        } catch (moveError) {
          openCategoryMoveFailed = true;
          logger.warn(`Could not move reopened ticket ${channel.id} to open category ${openCategoryId}: ${moveError.message}`);
        }
      } else {
        openCategoryMoveFailed = true;
        logger.warn(`Configured open ticket category is invalid for guild ${channel.guild.id}: ${openCategoryId}`);
      }
    }
    
    try {
      const user = await channel.guild.members.fetch(ticketData.userId).catch(() => null);
      if (user) {
        await channel.permissionOverwrites.create(user, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true
        });
      }
    } catch (error) {
      logger.warn(`Could not restore access for user ${ticketData.userId}:`, error.message);
    }
    
    const pub = publicText(channel.guild);
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(isOpeningMessage);

    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const statusField = embed.fields?.find(f => STATUS_FIELD_NAMES().has(f.name));

      if (statusField) {
        statusField.value = pub.t('ticket.opening.statusOpen');
      }

      const row = buildTicketControlRow({ claimedBy: ticketData.claimedBy }, pub);
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const reopenEmbed = createEmbed({
      title: pub.t('ticket.reply.reopenedTitle'),
      description: pub.t('ticket.post.reopenedBody', { user: String(reopener) }),
      color: '#2ecc71'
    });

    const closeStatusMessage = messages.find(m =>
      m.embeds.length > 0 &&
      CLOSED_TITLES().has(m.embeds[0].title) &&
      m.components.length > 0 &&
      m.components[0].components.some(c => c.customId === 'ticket_reopen')
    );

    if (closeStatusMessage) {
      await closeStatusMessage.edit({ embeds: [reopenEmbed], components: [] });
    } else {
      await channel.send({ embeds: [reopenEmbed] });
    }
    
    return { ticketData, movedToOpenCategory, openCategoryMoveFailed };
    
  } catch (error) {
    rethrowTicketError(error, 'reopenTicket', tr.t('ticket.service.reopenFailed'), { guildId: channel?.guild?.id, channelId: channel?.id, reopenerId: reopener?.id });
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? escapeHtml(url.toString()) : '';
  } catch {
    return '';
  }
}

export async function generateTranscript(channel) {
  try {
    logger.debug('Generating transcript for channel', {
      channelId: channel.id,
      channelName: channel.name
    });

    const messages = [];
    let before = undefined;
    let batch;
    do {
      batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      messages.push(...batch.values());
      before = batch.last()?.id;
    } while (batch.size === 100);

    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const rows = messages.map((msg) => {
      const ts = new Date(msg.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
      const author = escapeHtml(msg.author?.tag ?? msg.author?.username ?? 'Unknown');
      const avatar = safeExternalUrl(msg.author?.displayAvatarURL?.({ size: 64 }) || '');
      const avatarHtml = avatar
        ? `<img class="avatar" src="${avatar}" alt="">`
        : '';
      const content = msg.content
        ? `<div class="content">${escapeHtml(msg.content)}</div>`
        : '';
      const embeds = msg.embeds.map((embed) => {
        const parts = [
          embed.title ? `<strong>${escapeHtml(embed.title)}</strong>` : '',
          embed.description ? `<div>${escapeHtml(embed.description)}</div>` : '',
          ...(embed.fields || []).map((field) =>
            `<div><strong>${escapeHtml(field.name)}</strong><br>${escapeHtml(field.value)}</div>`),
          safeExternalUrl(embed.url)
            ? `<div><a href="${safeExternalUrl(embed.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(embed.url)}</a></div>`
            : '',
        ].filter(Boolean);
        return `<div class="embed">${parts.join('')}</div>`;
      }).join('');
      const attachments = [...msg.attachments.values()].map((attachment) => {
        const url = safeExternalUrl(attachment.url);
        const name = escapeHtml(attachment.name || 'attachment');
        return url
          ? `<div class="attachment"><a href="${url}" target="_blank" rel="noopener noreferrer">${name}</a></div>`
          : `<div class="attachment">${name} (unsafe link omitted)</div>`;
      }).join('');
      const messageBody = content || embeds || attachments
        ? `${content}${embeds}${attachments}`
        : '<span class="muted">[No text content]</span>';
      return `<tr><td class="ts">${ts}</td><td class="author">${avatarHtml}${author}</td><td class="msg">${messageBody}</td></tr>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transcript – #${escapeHtml(channel.name)}</title>
<style>
body{font-family:sans-serif;background:#36393f;color:#dcddde;margin:0;padding:16px}
h1{color:#fff;font-size:1.2rem;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th{background:#2f3136;color:#8e9297;padding:6px 8px;text-align:left;border-bottom:2px solid #202225}
td{padding:4px 8px;border-bottom:1px solid #40444b;vertical-align:top}
.ts{color:#72767d;white-space:nowrap;width:160px}
.author{color:#7289da;white-space:nowrap;width:180px}
.msg{word-break:break-word;white-space:normal}
.content{white-space:pre-wrap}
.avatar{width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:8px}
.embed{border-left:4px solid #5865f2;background:#2f3136;padding:8px;margin:6px 0;display:grid;gap:6px}
.attachment{margin-top:5px}
.muted{color:#8e9297}
a{color:#00aff4}
</style>
</head>
<body>
<h1>Transcript: #${escapeHtml(channel.name)}</h1>
<p style="color:#72767d">${messages.length} message(s) exported on ${new Date().toUTCString()}</p>
<table>
<thead><tr><th>Timestamp (UTC)</th><th>Author</th><th>Message</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;

    const buffer = Buffer.from(html, 'utf8');
    const fileName = `ticket-${channel.id}.html`;

    logger.info('✅ Successfully generated transcript', {
      channelId: channel.id,
      channelName: channel.name,
      messageCount: messages.length,
      size: buffer.length
    });

    return {
      buffer,
      fileName,
      messageCount: messages.length,
    };
  } catch (error) {
    logger.error('❌ Failed to generate transcript:', {
      channelId: channel.id,
      channelName: channel.name,
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack
    });
    return null;
  }
}

function buildTranscriptAttachment(transcript) {
  return new AttachmentBuilder(transcript.buffer, { name: transcript.fileName });
}

async function deliverTicketTranscript(channel, ticketData, executor, { persist = false } = {}) {
  const transcript = await generateTranscript(channel);
  if (!transcript) {
    return { generated: false, channelSent: false, dmSent: false };
  }

  let config = {};
  try {
    config = await getGuildConfig(channel.client, channel.guild.id);
  } catch (error) {
    logger.warn('Could not load ticket transcript channel configuration; continuing with DM delivery', {
      guildId: channel.guild.id,
      ticketId: ticketData.id,
      error: error.message,
    });
  }
  let channelSent = false;
  let dmSent = false;

  if (config.ticketTranscriptChannelId) {
    try {
      const transcriptChannel = await channel.client.channels
        .fetch(config.ticketTranscriptChannelId)
        .catch(() => null);

      if (!transcriptChannel) {
        logger.warn('Could not fetch configured transcript channel', {
          guildId: channel.guild.id,
          transcriptChannelId: config.ticketTranscriptChannelId,
        });
      } else if (!transcriptChannel.isSendable()) {
        logger.warn('Configured transcript channel is not sendable', {
          guildId: channel.guild.id,
          transcriptChannelId: transcriptChannel.id,
        });
      } else {
        const transcriptEmbed = buildStandardLogEmbed({
          color: 0x3498db,
          title: 'Ticket transcript',
          description: [
            formatLogLine('Ticket', `#${ticketData.id}`),
            formatLogLine('Channel', `#${channel.name}`),
            formatLogLine('Generated', `<t:${Math.floor(Date.now() / 1000)}:F>`),
          ].join('\n'),
          footer: executor?.username
            ? { text: `Generated by ${executor.username}`, iconURL: executor.displayAvatarURL?.() }
            : undefined,
          timestamp: true,
        });

        const transcriptMessage = await transcriptChannel.send({
          embeds: [transcriptEmbed],
          files: [buildTranscriptAttachment(transcript)],
          allowedMentions: { parse: [] },
        });
        channelSent = true;
        // A rating given later is added to this message (ticketRatingEffects.js).
        if (transcriptMessage?.id) ticketData.transcriptLog = { channelId: transcriptChannel.id, messageId: transcriptMessage.id };
      }
    } catch (error) {
      logger.error('Failed to send transcript to configured channel', {
        guildId: channel.guild.id,
        channelId: channel.id,
        transcriptChannelId: config.ticketTranscriptChannelId,
        error: error.message,
      });
    }
  } else {
    logger.warn('No transcript channel configured; transcript will only be delivered by DM when allowed', {
      guildId: channel.guild.id,
      ticketNumber: ticketData.id,
    });
  }

    try {
      const ticketCreator = await channel.client.users.fetch(ticketData.userId).catch(() => null);
      if (ticketCreator) {
        dmSent = await sendLoggedDm(ticketCreator, {
          key: 'ticket.transcript',
          params: { channelName: channel.name, ticketId: ticketData.id },
          guildId: channel.guild.id,
          member: channel.guild.members?.cache?.get?.(ticketData.userId) ?? null,
          files: [buildTranscriptAttachment(transcript)],
          label: 'ticket transcript',
        });
      }
    } catch (error) {
      logger.warn('Could not DM ticket transcript to creator', {
        guildId: channel.guild.id,
        ticketId: ticketData.id,
        userId: ticketData.userId,
        error: error.message,
      });
    }

  if (persist && (channelSent || dmSent)) {
    ticketData.transcriptSentAt = new Date().toISOString();
    ticketData.transcriptMessageCount = transcript.messageCount;
    ticketData.transcriptDelivery = { channel: channelSent, dm: dmSent };
    await saveTicketData(channel.guild.id, channel.id, ticketData).catch((error) => {
      logger.warn('Transcript was delivered but ticket metadata could not be saved', {
        guildId: channel.guild.id,
        ticketId: ticketData.id,
        error: error.message,
      });
    });
  }

  logger.info('Ticket transcript delivery complete', {
    guildId: channel.guild.id,
    channelId: channel.id,
    ticketNumber: ticketData.id,
    messageCount: transcript.messageCount,
    channelSent,
    dmSent,
  });

  return {
    generated: true,
    channelSent,
    dmSent,
    messageCount: transcript.messageCount,
  };
}

export async function deleteTicket(channel, deleter, { lang = 'en' } = {}) {
  const tr = botText(lang);
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel, tr);
    const pub = publicText(channel.guild);

    const deleteEmbed = createEmbed({
      title: pub.t('ticket.reply.deletedTitle'),
      description: pub.tp('ticket.post.deletedBody', TICKET_DELETE_DELAY_SECONDS),
      color: '#e74c3c',
      footer: { text: pub.t('ticket.post.ticketId', { id: ticketData.id }) }
    });
    
    await channel.send({ embeds: [deleteEmbed] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'delete',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: deleter.id,
        metadata: {
          deletedAt: new Date().toISOString()
        }
      }
    });

    setTimeout(async () => {
      try {
        logger.debug('Starting ticket deletion process', {
          channelId: channel.id,
          ticketId: ticketData.id
        });

        if (!ticketData.transcriptSentAt) {
          try {
            await deliverTicketTranscript(channel, ticketData, deleter, { persist: true });
          } catch (transcriptError) {
            logger.error('Error during fallback transcript delivery', {
              channelId: channel.id,
              ticketNumber: ticketData.id,
              error: transcriptError.message
            });
          }
        }

        try {
          await channel.delete('Ticket deleted permanently');
          logger.info('✅ Channel deleted', {
            channelId: channel.id,
            channelName: channel.name,
            ticketNumber: ticketData.id
          });
        } catch (deleteError) {
          logger.error('❌ Failed to delete ticket channel:', {
            channelId: channel.id,
            channelName: channel.name,
            ticketNumber: ticketData.id,
            errorMessage: deleteError.message,
            errorCode: deleteError.code,
            errorName: deleteError.name
          });
        }
      } catch (error) {
        logger.error('❌ Unexpected error during ticket deletion:', {
          channelId: channel.id,
          channelName: channel?.name,
          ticketNumber: ticketData?.id,
          errorMessage: error.message,
          errorName: error.name,
          errorStack: error.stack
        });
      }
    }, TICKET_DELETE_DELAY_MS);
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'deleteTicket', tr.t('ticket.service.deleteFailed'), { guildId: channel?.guild?.id, channelId: channel?.id, deleterId: deleter?.id });
  }
}

export async function unclaimTicket(channel, unclaimer, { lang = 'en' } = {}) {
  const tr = botText(lang);
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel, tr);

    if (!ticketData.claimedBy) {
      ticketUserError(
        'Ticket not claimed',
        tr.t('ticket.service.notClaimed'),
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'unclaimTicket' }
      );
    }
    
    if (ticketData.claimedBy !== unclaimer.id && !unclaimer.permissions.has(PermissionFlagsBits.ManageChannels)) {
      ticketUserError(
        'Cannot unclaim ticket',
        tr.t('ticket.service.unclaimOwn'),
        ErrorTypes.PERMISSION,
        { channelId: channel.id, operation: 'unclaimTicket' }
      );
    }
    
    const previousClaimer = ticketData.claimedBy;
    ticketData.claimedBy = null;
    ticketData.claimedAt = null;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);
    const pub = publicText(channel.guild);

    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(isOpeningMessage);

    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const claimedField = embed.fields?.find(f => CLAIMED_FIELD_NAMES().has(f.name));

      if (claimedField) {
        claimedField.value = pub.t('ticket.opening.notClaimed');
      }

      const row = buildTicketControlRow({}, pub);
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const claimMessage = messages.find(m =>
      m.embeds.length > 0 &&
      CLAIM_STATUS_TITLES().has(m.embeds[0].title)
    );

    if (claimMessage) {
      const unclaimEmbed = createEmbed({
        title: pub.t('ticket.post.unclaimedTitle'),
        description: pub.t('ticket.post.unclaimedBody', { user: String(unclaimer) }),
        color: '#f39c12'
      });
      
      await claimMessage.edit({ 
        embeds: [unclaimEmbed],
        components: []
      });
    } else {
      const unclaimEmbed = createEmbed({
        title: pub.t('ticket.post.unclaimedTitle'),
        description: pub.t('ticket.post.unclaimedBody', { user: String(unclaimer) }),
        color: '#f39c12'
      });
      
      await channel.send({ embeds: [unclaimEmbed] });
    }
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'unclaim',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: unclaimer.id,
        metadata: {
          previousClaimer: previousClaimer
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'unclaimTicket', tr.t('ticket.service.unclaimFailed'), { guildId: channel?.guild?.id, channelId: channel?.id, unclaimerId: unclaimer?.id });
  }
}

async function getNextTicketNumber(guildId) {
  return await incrementTicketCounter(guildId);
}

export async function updateTicketPriority(channel, priority, updater, { lang = 'en' } = {}) {
  const tr = botText(lang);
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel, tr);

    const priorityInfo = PRIORITY_MAP[priority];
    if (!priorityInfo) {
      ticketUserError(
      'Invalid priority level',
      tr.t('ticket.service.invalidPriority'),
      ErrorTypes.VALIDATION,
      { channelId: channel.id, priority, operation: 'updateTicketPriority' }
    );
    }
    
    ticketData.priority = priority;
    ticketData.priorityUpdatedBy = updater.id;
    ticketData.priorityUpdatedAt = new Date().toISOString();
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const currentName = channel.name;
    const priorityEmojis = [...new Set(Object.values(PRIORITY_MAP).map((item) => item.emoji).filter(Boolean))];
    const escapedPriorityEmojis = priorityEmojis.map((emoji) => emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const cleanName = escapedPriorityEmojis.length > 0
      ? currentName.replace(new RegExp(`(?:${escapedPriorityEmojis.join('|')})`, 'g'), '').trim()
      : currentName.trim();
    const newName = priority === 'none' ? cleanName : `${priorityInfo.emoji} ${cleanName}`;

    if (newName && newName !== currentName) {
      try {
        await channel.setName(newName);
      } catch (nameError) {
        logger.warn(`Could not update channel name for priority: ${nameError.message}`);
      }
    }
    
    const pub = publicText(channel.guild);
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(isOpeningMessage);

    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];

      const updatedEmbed = createEmbed({
        title: embed.title || pub.t('ticket.opening.fallbackTitle'),
        description: withoutPriorityLine(embed.description) + pub.t('ticket.opening.priorityLine', { priority: priorityLabel(priority, pub) }),
        color: priorityInfo.color,
        fields: embed.fields || [],
        footer: embed.footer
      });
      
      await ticketMessage.edit({ embeds: [updatedEmbed] });
    }
    
    const updateEmbed = createEmbed({
      title: pub.t('ticket.reply.priorityChanged'),
      description: pub.t('ticket.post.priorityBody', { user: String(updater), priority: priorityLabel(priority, pub) }),
      color: priorityInfo.color
    });
    
    await channel.send({ embeds: [updateEmbed] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'priority',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: updater.id,
        priority: priority,
        metadata: {
          previousPriority: ticketData.priority,
          updatedAt: ticketData.priorityUpdatedAt
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'updateTicketPriority', tr.t('ticket.service.priorityFailed'), { guildId: channel?.guild?.id, channelId: channel?.id, updaterId: updater?.id, priority });
  }
}