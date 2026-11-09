import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, AttachmentBuilder, MessageFlags, PermissionFlagsBits, ChannelType } from 'discord.js';
import { createEmbed, successEmbed } from '../utils/embeds.js';
import { createTicket, closeTicket, closedReplyText, claimTicket, updateTicketPriority } from '../services/ticket.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { replyUserError, ErrorTypes, handleInteractionError, createError, TitanBotError } from '../utils/errorHandler.js';
import { getTicketPermissionContext } from '../utils/ticket/ticketPermissions.js';
import { botText, textForInteraction } from '../utils/botText.js';
import { priorityLabel } from '../services/ticket.js';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function ensureGuildContext(interaction) {
  if (interaction.inGuild()) {
    return true;
  }

  if (!interaction.replied && !interaction.deferred) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: textForInteraction(interaction).t('ticket.buttons.guildOnly') });
  }

  return false;
}

// Every reply here is ephemeral: the clicker's Discord language (docs/bot-i18n.md).
const PERMISSION_LABELS = {
  ViewChannel: 'ticket.permission.viewChannel',
  SendMessages: 'ticket.permission.sendMessages',
  ReadMessageHistory: 'ticket.permission.readMessageHistory',
  EmbedLinks: 'ticket.permission.embedLinks',
  ManageChannels: 'ticket.permission.manageChannels',
  ManageRoles: 'ticket.permission.manageRoles'
};

// The action named in an access refusal (English label → catalog key; the label stays the API).
const ACTION_KEYS = {
  'create your ticket': 'ticket.action.createYour',
  'close this ticket': 'ticket.action.closeThis',
  'claim this ticket': 'ticket.action.claimThis',
  'claim tickets': 'ticket.action.claimAny',
  'change the priority': 'ticket.action.changeThePriority',
  'change ticket priority': 'ticket.action.changePriority',
  'pin this ticket': 'ticket.action.pinThis',
  'pin tickets': 'ticket.action.pinAny',
  'unclaim this ticket': 'ticket.action.unclaimThis',
  'unclaim tickets': 'ticket.action.unclaimAny',
  'reopen this ticket': 'ticket.action.reopenThis',
  'reopen tickets': 'ticket.action.reopenAny',
  'delete this ticket': 'ticket.action.deleteThis',
  'delete tickets': 'ticket.action.deleteAny',
};
const actionText = (tr, label) => (ACTION_KEYS[label] ? tr.t(ACTION_KEYS[label]) : label);

// Errors whose message is meant for the user (denied access, wrong channel, too fast).
const USER_FACING_TYPES = new Set([ErrorTypes.PERMISSION, ErrorTypes.VALIDATION, ErrorTypes.RATE_LIMIT, ErrorTypes.USER_INPUT]);

// Discord refused one of the bot's own requests: either the raw API error (50001 Missing
// Access, 50013 Missing Permissions) or the ticket service's wrapped copy of it, which keeps
// type PERMISSION but is marked unexpected (user denials from assertTicketPermission are not).
function isBotPermissionError(error) {
  if (error?.code === 50001 || error?.code === 50013) return true;
  return error instanceof TitanBotError && error.type === ErrorTypes.PERMISSION && error.context?.expected === false;
}

function missingBotPermissions(interaction, channel, required) {
  const me = interaction.guild?.members?.me;
  const permissions = me ? channel?.permissionsFor?.(me) : null;
  if (!permissions) return [];
  return required.filter(name => !permissions.has(PermissionFlagsBits[name]));
}

/**
 * Replies to a failed ticket action. Permission problems get a specific message
 * (the user's access or the bot's missing permissions in this category); anything
 * else falls back to the generic message.
 */
// fallback: a catalog key; action: an English action label (ACTION_KEYS).
async function replyTicketActionError(interaction, error, { fallback, action, botPermissions = ['ManageChannels'], channel = interaction.channel }) {
  if (interaction.replied && !interaction.deferred) return;
  const tr = textForInteraction(interaction);

  if (isBotPermissionError(error)) {
    const missing = missingBotPermissions(interaction, channel, botPermissions);
    // If every listed permission looks granted, a channel overwrite is likely blocking; name them all.
    const shown = missing.length > 0 ? missing : botPermissions;
    const names = shown.map(name => `**${PERMISSION_LABELS[name] ? tr.t(PERMISSION_LABELS[name]) : name}**`).join(', ');
    const category = channel?.type === ChannelType.GuildCategory ? channel : channel?.parent;
    const where = category ? tr.t('ticket.buttons.whereCategory', { category: category.name }) : tr.t('ticket.buttons.whereServer');
    await replyUserError(interaction, {
      type: ErrorTypes.PERMISSION,
      message: tr.tp('ticket.buttons.botMissing', shown.length, { names, where, action: actionText(tr, action) })
    });
    return;
  }

  if (error instanceof TitanBotError && USER_FACING_TYPES.has(error.type) && error.userMessage) {
    await replyUserError(interaction, { type: error.type, message: error.userMessage });
    return;
  }

  await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t(fallback) });
}

function ticketAccessMessage(context, actionLabel, allowTicketCreator, { lang = 'en' } = {}) {
  const tr = botText(lang);
  const staffRole = context.config?.ticketStaffRoleId ? tr.t('ticket.buttons.staffRole') : tr.t('ticket.buttons.staffRoleNone');
  const action = actionText(tr, actionLabel);
  return allowTicketCreator
    ? tr.t('ticket.buttons.accessWithCreator', { staffRole, action })
    : tr.t('ticket.buttons.accessStaff', { staffRole, action });
}

// The permission check reads the ticket record. Before a form it must leave time for the form
// itself; after a defer the interaction has 15 minutes.
const TICKET_PERMISSION_TIMEOUT_BEFORE_MODAL_MS = 1500;
const TICKET_PERMISSION_TIMEOUT_AFTER_DEFER_MS = 8000;
// Before the ticket form: the open-ticket count gets this long, then it is checked again on submit.
const TICKET_COUNT_BUDGET_BEFORE_MODAL_MS = 1200;

/** The promise's value, or null when it takes longer than ms (its error propagates). */
async function withinBudget(promise, ms) {
  let timer;
  promise.catch(() => {}); // a late failure after the budget is not an unhandled rejection
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertTicketPermission(interaction, client, actionLabel, options = {}, timeoutMs = 2500) {
  const { allowTicketCreator = false } = options;
  const tr = textForInteraction(interaction);

  let context;
  try {
    const contextPromise = getTicketPermissionContext({ client, interaction });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    );
    context = await Promise.race([contextPromise, timeoutPromise]);
  } catch (error) {
    if (error.message === 'Timeout') {
      throw createError(
        'Ticket permission timeout',
        ErrorTypes.RATE_LIMIT,
        tr.t('ticket.buttons.permTimeout')
      );
    }
    throw createError(
      'Ticket permission check failed',
      ErrorTypes.UNKNOWN,
      tr.t('ticket.buttons.permFailed', { error: error.message })
    );
  }

  if (!context.ticketData) {
    throw createError(
      'Not a ticket channel',
      ErrorTypes.VALIDATION,
      tr.t('ticket.buttons.notTicketChannel')
    );
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    throw createError(
      'Ticket permission denied',
      ErrorTypes.PERMISSION,
      ticketAccessMessage(context, actionLabel, allowTicketCreator, { lang: tr.lang })
    );
  }

  return context;
}

async function ensureTicketPermission(interaction, client, actionLabel, options = {}) {
  const { allowTicketCreator = false } = options;

  const context = await getTicketPermissionContext({ client, interaction });
  const tr = textForInteraction(interaction);

  if (!context.ticketData) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('ticket.buttons.notTicketChannel') });
    return null;
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: ticketAccessMessage(context, actionLabel, allowTicketCreator, { lang: tr.lang }) });
    return null;
  }

  return context;
}

const createTicketHandler = {
  name: 'create_ticket',
  opensModal: true,
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const tr = textForInteraction(interaction);

      const rateLimitKey = `${interaction.user.id}:create_ticket`;
      const allowed = await checkRateLimit(rateLimitKey, 3, 60000);
      if (!allowed) {
        await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: tr.t('ticket.buttons.rateLimited') });
        return;
      }

      // The early "limit reached" answer is a courtesy: the form must open within 3 s, so the
      // config + count reads get TICKET_COUNT_BUDGET_BEFORE_MODAL_MS. When they are slower the
      // form opens anyway; createTicket() checks the limit again on submit.
      const early = await withinBudget((async () => {
        const config = await getGuildConfig(client, interaction.guildId);
        const { getUserTicketCount } = await import('../services/ticket.js');
        return { max: config.maxTicketsPerUser || 3, count: await getUserTicketCount(interaction.guildId, interaction.user.id) };
      })(), TICKET_COUNT_BUDGET_BEFORE_MODAL_MS);
      const maxTicketsPerUser = early?.max;
      const currentTicketCount = early?.count;

      if (early && currentTicketCount >= maxTicketsPerUser) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('ticket.buttons.limitReached', { count: currentTicketCount, max: maxTicketsPerUser }) });
      }

      const modal = new ModalBuilder()
        .setCustomId('create_ticket_modal')
        .setTitle(tr.t('ticket.buttons.openModalTitle'));

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel(tr.t('ticket.buttons.openModalLabel'))
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder(tr.t('ticket.buttons.openModalPlaceholder'))
        .setRequired(true)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error creating ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: textForInteraction(interaction).t('ticket.buttons.openFormFailed') });
      }
    }
  }
};

const createTicketModalHandler = {
  name: 'create_ticket_modal',
  async execute(interaction, client) {
    let categoryId = null;
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const tr = textForInteraction(interaction);
      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      categoryId = config.ticketCategoryId || null;

      const { channel } = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
        undefined,
        { lang: tr.lang }
      );
      await interaction.editReply({
        embeds: [successEmbed(
          tr.t('ticket.buttons.openedTitle'),
          tr.t('ticket.buttons.openedBody', { channel: String(channel) })
        )]
      });
    } catch (error) {
      if (isBotPermissionError(error)) {
        const category = categoryId ? interaction.guild?.channels?.cache?.get(categoryId) : null;
        await replyTicketActionError(interaction, error, {
          fallback: 'ticket.service.createFailed',
          action: 'create your ticket',
          botPermissions: ['ViewChannel', 'ManageChannels', 'ManageRoles'],
          channel: category ?? interaction.channel
        });
        return;
      }
      await handleInteractionError(interaction, error, { type: 'button', handler: 'ticket', customId: interaction.customId });
    }
  }
};

const closeTicketHandler = {
  name: 'ticket_close',
  opensModal: true,
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Runs before the form (a modal must be the first response), so it gets a short budget.
      await assertTicketPermission(interaction, client, 'close this ticket', { allowTicketCreator: true }, TICKET_PERMISSION_TIMEOUT_BEFORE_MODAL_MS);
      const tr = textForInteraction(interaction);

      const modal = new ModalBuilder()
        .setCustomId('ticket_close_modal')
        .setTitle(tr.t('ticket.buttons.closeModalTitle'));

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel(tr.t('ticket.buttons.closeModalLabel'))
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder(tr.t('ticket.buttons.closeModalPlaceholder'))
        .setRequired(false)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error closing ticket:', error);

      await replyTicketActionError(interaction, error, { fallback: 'ticket.buttons.closeFormFailed', action: 'close this ticket' });
    }
  }
};

const closeTicketModalHandler = {
  name: 'ticket_close_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Acknowledge first: the permission check reads the database (ticket record).
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      await assertTicketPermission(interaction, client, 'close this ticket', { allowTicketCreator: true }, TICKET_PERMISSION_TIMEOUT_AFTER_DEFER_MS);

      const tr = textForInteraction(interaction);
      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();
      // The default reason is stored on the ticket record and goes into the logs: kept in English.
      const reason = providedReason || 'Closed via ticket button without a specific reason.';

      const closed = await closeTicket(interaction.channel, interaction.user, reason, { lang: tr.lang });
      await interaction.editReply({ embeds: [successEmbed(tr.t('ticket.reply.closedTitle'), closedReplyText(tr, closed))] });
    } catch (error) {
      logger.error('Error submitting close ticket modal:', error);
      await replyTicketActionError(interaction, error, { fallback: 'ticket.buttons.closeError', action: 'close this ticket', botPermissions: ['ManageChannels', 'ManageRoles'] });
    }
  }
};

const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Acknowledge first: the permission check reads the database (ticket record).
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      await assertTicketPermission(interaction, client, 'claim tickets', {}, TICKET_PERMISSION_TIMEOUT_AFTER_DEFER_MS);
      
      const tr = textForInteraction(interaction);
      await claimTicket(interaction.channel, interaction.user, { lang: tr.lang });
      await interaction.editReply({ embeds: [successEmbed(tr.t('ticket.reply.claimedTitle'), tr.t('ticket.reply.claimedBody'))] });
    } catch (error) {
      logger.error('Error claiming ticket:', error);
      await replyTicketActionError(interaction, error, { fallback: 'ticket.buttons.claimError', action: 'claim this ticket', botPermissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks'] });
    }
  }
};

const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Acknowledge first: the permission check reads the database (ticket record).
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      await assertTicketPermission(interaction, client, 'change ticket priority', {}, TICKET_PERMISSION_TIMEOUT_AFTER_DEFER_MS);
      
      const tr = textForInteraction(interaction);
      const priority = args?.[0];
      if (!priority) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('ticket.buttons.priorityRequired') });
        return;
      }

      await updateTicketPriority(interaction.channel, priority, interaction.user, { lang: tr.lang });
      // English keeps the raw value as before ("low"); other languages name the level.
      const shown = tr.lang === 'en' ? priority : priorityLabel(priority, tr);
      await interaction.editReply({ embeds: [successEmbed(tr.t('ticket.reply.priorityChanged'), tr.t('ticket.buttons.priorityBody', { priority: shown }))] });
    } catch (error) {
      logger.error('Error updating ticket priority:', error);
      await replyTicketActionError(interaction, error, { fallback: 'ticket.buttons.priorityError', action: 'change the priority', botPermissions: ['ManageChannels'] });
    }
  }
};

const pinTicketHandler = {
  name: 'ticket_pin',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Acknowledge first: the permission check reads the database (ticket record).
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      await assertTicketPermission(interaction, client, 'pin tickets', {}, TICKET_PERMISSION_TIMEOUT_AFTER_DEFER_MS);

      const tr = textForInteraction(interaction);
      const channel = interaction.channel;
      const category = channel.parent;

      if (!category) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('ticket.buttons.notInCategory') });
        return;
      }

      const hasPingEmoji = channel.name.startsWith('📌');
      
      if (hasPingEmoji) {
        
        const newName = channel.name.replace(/^📌\s*/, '');
        await channel.edit({
          name: newName,
          position: 999 
        });

        await interaction.editReply({
          embeds: [createEmbed({
            title: tr.t('ticket.buttons.unpinnedTitle'),
            description: tr.t('ticket.buttons.unpinnedBody'),
            color: 0x95A5A6
          })],
          flags: MessageFlags.Ephemeral
        });

        logger.info('Ticket unpinned', {
          guildId: interaction.guildId,
          channelId: channel.id,
          channelName: newName,
          userId: interaction.user.id
        });
      } else {
        
        const pinnedName = `📌 ${channel.name}`;
        await channel.edit({
          name: pinnedName,
          position: 0 
        });

        await interaction.editReply({
          embeds: [createEmbed({
            title: tr.t('ticket.buttons.pinnedTitle'),
            description: tr.t('ticket.buttons.pinnedBody'),
            color: 0x3498db
          })],
          flags: MessageFlags.Ephemeral
        });

        logger.info('Ticket pinned', {
          guildId: interaction.guildId,
          channelId: channel.id,
          channelName: pinnedName,
          userId: interaction.user.id
        });
      }

      await logTicketEvent({
        client: interaction.client,
        guildId: interaction.guildId,
        event: {
          type: hasPingEmoji ? 'unpin' : 'pin',
          ticketId: channel.id,
          ticketNumber: channel.name.replace(/[^0-9]/g, ''),
          userId: interaction.user.id,
          executorId: interaction.user.id,
          metadata: {
            isPinned: !hasPingEmoji,
            newChannelName: hasPingEmoji ? channel.name.replace(/^📌\s*/, '') : `📌 ${channel.name}`
          }
        }
      });

    } catch (error) {
      logger.error('Error pinning/unpinning ticket:', error);
      await replyTicketActionError(interaction, error, { fallback: 'ticket.buttons.pinError', action: 'pin this ticket', botPermissions: ['ManageChannels'] });
    }
  }
};

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Acknowledge first: the permission check reads the database (ticket record).
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      await assertTicketPermission(interaction, client, 'unclaim tickets', {}, TICKET_PERMISSION_TIMEOUT_AFTER_DEFER_MS);
      
      const tr = textForInteraction(interaction);
      const { unclaimTicket } = await import('../services/ticket.js');
      await unclaimTicket(interaction.channel, interaction.member, { lang: tr.lang });
      await interaction.editReply({ embeds: [successEmbed(tr.t('ticket.buttons.unclaimedTitle'), tr.t('ticket.buttons.unclaimedBody'))] });
    } catch (error) {
      logger.error('Error unclaiming ticket:', error);
      await replyTicketActionError(interaction, error, { fallback: 'ticket.buttons.unclaimError', action: 'unclaim this ticket', botPermissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks'] });
    }
  }
};

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Acknowledge first: the permission check reads the database (ticket record).
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      await assertTicketPermission(interaction, client, 'reopen tickets', {}, TICKET_PERMISSION_TIMEOUT_AFTER_DEFER_MS);
      
      const tr = textForInteraction(interaction);
      const { reopenTicket } = await import('../services/ticket.js');
      const { movedToOpenCategory, openCategoryMoveFailed } = await reopenTicket(interaction.channel, interaction.member, { lang: tr.lang });
      let reopenMessage = tr.t('ticket.buttons.reopenedBody');
      if (openCategoryMoveFailed) {
        reopenMessage += tr.t('ticket.buttons.reopenMoveFailed');
      }
      await interaction.editReply({ embeds: [successEmbed(tr.t('ticket.reply.reopenedTitle'), reopenMessage)] });
    } catch (error) {
      logger.error('Error reopening ticket:', error);
      await replyTicketActionError(interaction, error, { fallback: 'ticket.buttons.reopenError', action: 'reopen this ticket', botPermissions: ['ManageChannels', 'ManageRoles'] });
    }
  }
};

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Acknowledge first: the permission check reads the database (ticket record).
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      await assertTicketPermission(interaction, client, 'delete tickets', {}, TICKET_PERMISSION_TIMEOUT_AFTER_DEFER_MS);
      
      const tr = textForInteraction(interaction);
      const { deleteTicket } = await import('../services/ticket.js');
      await deleteTicket(interaction.channel, interaction.member, { lang: tr.lang });
      await interaction.editReply({ embeds: [successEmbed(tr.t('ticket.reply.deletedTitle'), tr.t('ticket.buttons.deletedBody'))] });
    } catch (error) {
      logger.error('Error deleting ticket:', error);
      await replyTicketActionError(interaction, error, { fallback: 'ticket.buttons.deleteError', action: 'delete this ticket', botPermissions: ['ManageChannels'] });
    }
  }
};

export default createTicketHandler;
export { 
  createTicketModalHandler, 
  closeTicketModalHandler,
  closeTicketHandler, 
  claimTicketHandler, 
  priorityTicketHandler,
  pinTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler,
  isBotPermissionError,
  ticketAccessMessage
};