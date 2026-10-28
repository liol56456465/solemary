// verificationPanelService.js — the verification panel message: building it,
// first-time setup (/verification setup), reposting and refreshing it. Shared by
// /verification setup, /verification dashboard and the web dashboard.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { botConfig, getColor } from '../config/bot.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getVerificationSettings, setVerificationSettings, updateVerificationSettings } from './verificationSettingsService.js';
import { getWelcomeConfig } from '../utils/database.js';
import { getVerificationPanelStatus } from '../utils/panelStatus.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';

const PANEL_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

function refused(message, type = ErrorTypes.CONFIGURATION) {
    return createError(message, type, message, { expected: true, suppressErrorLog: true });
}

/** The panel message (embed + "verify_user" button) for the stored settings. */
export function buildVerificationPanelPayload(cfg = {}) {
    return {
        embeds: [new EmbedBuilder()
            .setTitle('Server Verification')
            .setDescription(cfg.message || botConfig.verification?.defaultMessage || 'Press the button to verify.')
            .setColor(getColor('success'))],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('verify_user')
                .setLabel(cfg.buttonText || botConfig.verification?.defaultButtonText || 'Verify')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
        )],
    };
}

function assertCanPost(guild, channel) {
    const me = guild?.members?.me;
    const granted = me && typeof channel?.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (!PANEL_PERMISSIONS.every((perm) => granted?.has?.(perm))) {
        throw refused('I need **View Channel**, **Send Messages**, and **Embed Links** in the verification channel.', ErrorTypes.PERMISSION);
    }
}

/**
 * Checks /verification setup does before posting: the bot's permissions in the channel
 * and Manage Roles, an assignable verified role (not @everyone, not managed, below my
 * highest role), and no AutoVerify / AutoRole configured. Throws with the message.
 */
export async function checkVerificationSetup(client, guild, { channel, role }) {
    const me = guild.members?.me;
    if (!me) throw refused('I could not verify my permissions in this server. Please try again in a moment.');
    assertCanPost(guild, channel);
    if (!me.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
        throw refused("I need the 'Manage Roles' permission to give verified roles.", ErrorTypes.PERMISSION);
    }
    if (!role || role.id === guild.id || role.managed) {
        throw refused('Please choose a normal assignable role (not @everyone or an integration-managed role).', ErrorTypes.VALIDATION);
    }
    if (role.position >= (me.roles?.highest?.position ?? 0)) {
        throw refused('The verified role must be below my highest role in the server role hierarchy.', ErrorTypes.PERMISSION);
    }
    const [guildConfig, welcomeConfig] = await Promise.all([getGuildConfig(client, guild.id), getWelcomeConfig(client, guild.id)]);
    const autoVerify = Boolean(guildConfig.verification?.autoVerify?.enabled);
    const autoRole = Boolean(guildConfig.autoRole) || (Array.isArray(welcomeConfig?.roleIds) && welcomeConfig.roleIds.length > 0);
    if (autoVerify || autoRole) {
        throw refused('You cannot enable the verification system while **AutoVerify** or **AutoRole** is configured. Disable those first.');
    }
}

/**
 * /verification setup: checks, posts the panel and saves the settings (enabled).
 * Resolves { message, settings }.
 */
export async function setupVerification(client, guild, { channel, role, message, buttonText }) {
    await checkVerificationSetup(client, guild, { channel, role });
    const cfg = {
        message: message || botConfig.verification?.defaultMessage,
        buttonText: buttonText || botConfig.verification?.defaultButtonText,
    };
    const sent = await channel.send(buildVerificationPanelPayload(cfg));
    const settings = {
        enabled: true,
        channelId: channel.id,
        messageId: sent.id,
        roleId: role.id,
        message: cfg.message,
        buttonText: cfg.buttonText,
    };
    await setVerificationSettings(client, guild.id, settings);
    return { message: sent, settings };
}

/** Posts a new panel in the configured channel and saves its id. Resolves the message. */
export async function repostVerificationPanel(client, guild, cfg = null) {
    const settings = cfg || await getVerificationSettings(client, guild.id);
    const channel = settings.channelId ? await guild.channels.fetch(settings.channelId).catch(() => null) : null;
    if (!channel) throw refused('The configured verification channel no longer exists. Set a new channel first.');
    assertCanPost(guild, channel);
    const sent = await channel.send(buildVerificationPanelPayload(settings));
    if (client?.db) await updateVerificationSettings(client, guild.id, { messageId: sent.id });
    settings.messageId = sent.id;
    return sent;
}

/** Rewrites the live panel with the stored text; false when there is no live panel. Never throws. */
export async function refreshVerificationPanel(guild, cfg) {
    if (!cfg?.channelId || !cfg?.messageId) return false;
    try {
        const channel = guild.channels.cache.get(cfg.channelId);
        if (!channel) return false;
        const msg = await channel.messages.fetch(cfg.messageId).catch(() => null);
        if (!msg) return false;
        await msg.edit(buildVerificationPanelPayload(cfg));
        return true;
    } catch (error) {
        logger.warn('Could not update live verification panel:', error.message);
        return false;
    }
}

/**
 * The web dashboard's "Post / update panel": refreshes the live panel (found by id or
 * by scanning the channel), else posts a new one. Resolves { action }.
 */
export async function publishVerificationPanel(client, guild) {
    const settings = await getVerificationSettings(client, guild.id);
    if (!settings.channelId) throw refused('The verification panel is not set up yet: set it up first (channel and role).');
    const status = await getVerificationPanelStatus(client, guild, settings);
    if (status.exists && status.message) {
        if (status.recoveredId && status.recoveredId !== settings.messageId) {
            await updateVerificationSettings(client, guild.id, { messageId: status.recoveredId });
        }
        await status.message.edit(buildVerificationPanelPayload(settings));
        return { action: 'updated' };
    }
    const message = await repostVerificationPanel(client, guild, settings);
    return { action: 'posted', message };
}
