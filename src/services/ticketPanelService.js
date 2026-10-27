// ticketPanelService.js — the ticket panel message: building it, first-time setup
// (/ticket setup), reposting and refreshing it. Shared by /ticket setup, /ticket
// dashboard (Repost Panel, text edits) and the web dashboard, so the panel looks and
// behaves the same whoever posts it.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { getColor } from '../config/bot.js';
import { getGuildConfig } from './config/guildConfig.js';
import { updateTicketSettings, validateTicketSettingsPatch } from './ticketSettingsService.js';
import { getTicketPanelStatus } from '../utils/panelStatus.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_TICKET_PANEL_MESSAGE = 'Click the button below to create a support ticket.';
export const DEFAULT_TICKET_BUTTON_LABEL = 'Create Ticket';
const PANEL_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks'];

function refused(message, type = ErrorTypes.CONFIGURATION) {
    return createError(message, type, message, { expected: true });
}

/** The panel message (embed + "create_ticket" button) for the stored ticket settings. */
export function buildTicketPanelPayload(config = {}) {
    return {
        embeds: [new EmbedBuilder()
            .setTitle('Support Tickets')
            .setDescription(config.ticketPanelMessage || DEFAULT_TICKET_PANEL_MESSAGE)
            .setColor(getColor('info'))],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel(config.ticketButtonLabel || DEFAULT_TICKET_BUTTON_LABEL)
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📩'),
        )],
    };
}

/** Throws (PERMISSION) when the bot cannot post the panel in `channel`. */
export function assertCanPostPanel(guild, channel) {
    const me = guild?.members?.me;
    const granted = me && typeof channel?.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (!granted?.has?.(PANEL_PERMISSIONS)) {
        throw refused(`I need View Channel, Send Messages and Embed Links in <#${channel?.id}> to post the panel.`, ErrorTypes.PERMISSION);
    }
}

/**
 * First-time setup (one ticket system per server): validates every option BEFORE the
 * panel is posted, posts it, saves the settings with the panel message id.
 * options: { panelChannel, panelMessage, buttonLabel, categoryId, closedCategoryId,
 * staffRoleId, maxTicketsPerUser, dmOnClose }. Resolves { message, settings }.
 */
export async function setupTicketSystem(client, guild, {
    panelChannel, panelMessage, buttonLabel, categoryId = null, closedCategoryId = null, staffRoleId = null,
    maxTicketsPerUser = 3, dmOnClose = true,
}) {
    const existing = await getGuildConfig(client, guild.id);
    if (existing?.ticketPanelChannelId) {
        throw refused(`This server already has a ticket system set up (panel in <#${existing.ticketPanelChannelId}>).\n\nOnly one ticket system is supported per server. Edit or repost the existing panel, or delete the system first.`);
    }
    const patch = validateTicketSettingsPatch({
        ticketCategoryId: categoryId,
        ticketClosedCategoryId: closedCategoryId,
        ticketStaffRoleId: staffRoleId,
        ticketPanelChannelId: panelChannel?.id,
        ticketPanelMessage: panelMessage || DEFAULT_TICKET_PANEL_MESSAGE,
        ticketButtonLabel: buttonLabel || DEFAULT_TICKET_BUTTON_LABEL,
        maxTicketsPerUser,
        dmOnClose,
    }, guild.id);
    assertCanPostPanel(guild, panelChannel);

    const message = await panelChannel.send(buildTicketPanelPayload(patch));
    if (!client.db) {
        logger.error('Ticket setup: database unavailable, panel sent but configuration was NOT saved', { guildId: guild.id });
        return { message, settings: null };
    }
    const { after } = await updateTicketSettings(client, guild.id, { ...patch, ticketPanelMessageId: message.id });
    return { message, settings: after };
}

/** Status of the live panel; a panel found by scanning gets its id saved. */
export async function ticketPanelStatus(client, guild, config = null) {
    const settings = config || await getGuildConfig(client, guild.id);
    const status = await getTicketPanelStatus(client, guild, settings);
    if (status.recoveredId && status.recoveredId !== settings.ticketPanelMessageId && client.db) {
        await updateTicketSettings(client, guild.id, { ticketPanelMessageId: status.recoveredId });
        settings.ticketPanelMessageId = status.recoveredId;
    }
    return status;
}

/** Posts a new panel in the configured channel and saves its id. Resolves the message. */
export async function repostTicketPanel(client, guild, config = null) {
    const settings = config || await getGuildConfig(client, guild.id);
    const channel = settings.ticketPanelChannelId ? await guild.channels.fetch(settings.ticketPanelChannelId).catch(() => null) : null;
    if (!channel) {
        throw refused('The configured ticket panel channel no longer exists. Set a new panel channel first.');
    }
    assertCanPostPanel(guild, channel);
    const message = await channel.send(buildTicketPanelPayload(settings));
    if (client.db && settings.ticketPanelMessageId !== message.id) {
        await updateTicketSettings(client, guild.id, { ticketPanelMessageId: message.id });
        settings.ticketPanelMessageId = message.id;
    }
    return message;
}

/** Rewrites the live panel with the stored text; false when there is no live panel. */
export async function refreshTicketPanel(client, guild, config = null) {
    const settings = config || await getGuildConfig(client, guild.id);
    if (!settings.ticketPanelChannelId) return false;
    try {
        const status = await ticketPanelStatus(client, guild, settings);
        if (!status.exists || !status.message) return false;
        await status.message.edit(buildTicketPanelPayload(settings));
        return true;
    } catch (error) {
        logger.warn('Failed to update live ticket panel:', error.message);
        return false;
    }
}

/**
 * The web dashboard's "Post / update panel": refreshes the live panel when it is
 * there, else posts a new one. Resolves { action: 'updated' | 'posted', message? }.
 */
export async function publishTicketPanel(client, guild) {
    const settings = await getGuildConfig(client, guild.id);
    if (!settings.ticketPanelChannelId) {
        throw refused('The ticket system is not set up yet: set it up first (panel channel and text).');
    }
    if (await refreshTicketPanel(client, guild, settings)) return { action: 'updated' };
    const message = await repostTicketPanel(client, guild, settings);
    return { action: 'posted', message };
}
