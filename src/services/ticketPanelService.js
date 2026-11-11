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
import { botText, textForGuild } from '../utils/botText.js';

// English defaults (saved with the settings at setup). The panel itself shows a missing text in the
// server's language (catalog ticket.panel.*).
export const DEFAULT_TICKET_PANEL_MESSAGE = 'Need help from staff? Press the button below to open a private ticket.';
export const DEFAULT_TICKET_BUTTON_LABEL = 'Open ticket';
const PANEL_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks'];

function refused(message, type = ErrorTypes.CONFIGURATION) {
    return createError(message, type, message, { expected: true });
}

/** The server's language for the panel (a public post). */
const panelLang = (guild) => textForGuild(guild?.id ?? null, { purpose: 'public' }).lang;

/**
 * The panel message (embed + "create_ticket" button) for the stored ticket settings. The title and
 * any missing text are the bot's own, in `lang` (default English); the admin's own text stays as written.
 */
export function buildTicketPanelPayload(config = {}, { lang = 'en' } = {}) {
    const tr = botText(lang);
    return {
        embeds: [new EmbedBuilder()
            .setTitle(tr.t('ticket.panel.title'))
            .setDescription(config.ticketPanelMessage || tr.t('ticket.panel.defaultMessage'))
            .setColor(getColor('info'))],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel(config.ticketButtonLabel || tr.t('ticket.panel.defaultButton'))
                .setStyle(ButtonStyle.Primary),
        )],
    };
}

/** Throws (PERMISSION) when the bot cannot post the panel in `channel`. `lang`: the message's language. */
export function assertCanPostPanel(guild, channel, { lang = 'en' } = {}) {
    const me = guild?.members?.me;
    const granted = me && typeof channel?.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (!granted?.has?.(PANEL_PERMISSIONS)) {
        throw refused(botText(lang).t('ticket.panel.cannotPost', { channelId: channel?.id }), ErrorTypes.PERMISSION);
    }
}

/**
 * First-time setup (one ticket system per server): validates every option BEFORE the
 * panel is posted, posts it, saves the settings with the panel message id.
 * options: { panelChannel, panelMessage, buttonLabel, categoryId, closedCategoryId,
 * staffRoleId | staffRoleIds, maxTicketsPerUser, dmOnClose, lang }. Resolves { message, settings }.
 * `lang`: the language of a refusal (the person setting it up); the panel is in the server's language.
 */
export async function setupTicketSystem(client, guild, {
    panelChannel, panelMessage, buttonLabel, categoryId = null, closedCategoryId = null, staffRoleId = null, staffRoleIds = null,
    maxTicketsPerUser = 3, dmOnClose = true, lang = 'en',
}) {
    // @everyone (every member holds it) or a bot's role would make the wrong people ticket staff.
    const staffIds = Array.isArray(staffRoleIds) ? staffRoleIds : [staffRoleId].filter(Boolean);
    for (const id of staffIds) {
        if (id === guild.id || guild.roles?.cache?.get(id)?.managed) throw refused(botText(lang).t('ticket.dash.staffRoleNone'));
    }
    const existing = await getGuildConfig(client, guild.id);
    if (existing?.ticketPanelChannelId) {
        throw refused(botText(lang).t('ticket.panel.exists', { channelId: existing.ticketPanelChannelId }));
    }
    const patch = validateTicketSettingsPatch({
        ticketCategoryId: categoryId,
        ticketClosedCategoryId: closedCategoryId,
        // A list (dashboard) wins over the single role (/ticket setup); the service keeps both keys in step.
        ...(Array.isArray(staffRoleIds) ? { ticketStaffRoleIds: staffRoleIds } : { ticketStaffRoleId: staffRoleId }),
        ticketPanelChannelId: panelChannel?.id,
        ticketPanelMessage: panelMessage || DEFAULT_TICKET_PANEL_MESSAGE,
        ticketButtonLabel: buttonLabel || DEFAULT_TICKET_BUTTON_LABEL,
        maxTicketsPerUser,
        dmOnClose,
    }, guild.id);
    assertCanPostPanel(guild, panelChannel, { lang });

    const message = await panelChannel.send(buildTicketPanelPayload(patch, { lang: panelLang(guild) }));
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

/** Posts a new panel in the configured channel and saves its id. Resolves the message. `lang`: a refusal's language. */
export async function repostTicketPanel(client, guild, config = null, { lang = 'en' } = {}) {
    const settings = config || await getGuildConfig(client, guild.id);
    const channel = settings.ticketPanelChannelId ? await guild.channels.fetch(settings.ticketPanelChannelId).catch(() => null) : null;
    if (!channel) {
        throw refused(botText(lang).t('ticket.panel.channelGone'));
    }
    assertCanPostPanel(guild, channel, { lang });
    const message = await channel.send(buildTicketPanelPayload(settings, { lang: panelLang(guild) }));
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
        await status.message.edit(buildTicketPanelPayload(settings, { lang: panelLang(guild) }));
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
