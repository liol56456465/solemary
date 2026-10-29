// commandGate.js — who may run a command, checked centrally for slash and prefix
// commands alike.
//
// 1. Commands run in the main server and the support server. Commands with
//    scope 'main' (enforcement, appeals, /background, /test) run in the main server only.
// 2. Everything requires Administrator (the server owner counts), except the
//    access keys listed in config/commands/commandAccess.js. OWNER_IDS is an
//    emergency override for rule 2 only.
// Commands stay visible to everyone (no default_member_permissions), so
// non-admins see this message instead of an empty command list.
//
// 0. The global blacklist (dashboard Owner area) comes first: a blacklisted user gets
//    "You can't use this bot."; a blacklisted server is ignored (silent: true, the caller
//    sends nothing). OWNER_IDS are never blocked.
// Message components (buttons, selects, modals) are not gated here: the appeal
// panel and verification must work for everyone, and each admin-only panel
// re-checks Administrator itself. interactionCreate applies the blacklist to them.

import { PermissionFlagsBits } from 'discord.js';
import { isBotOwner } from '../config/bot.js';
import { enforcementConfig } from '../config/enforcement.js';
import { isEveryoneCommand, isSupportServerCommand } from '../config/commands/commandAccess.js';
import { adminCommandsRetired, isOwnerKit, retiredMessage } from '../config/commands/retirement.js';
import { BLACKLIST_MESSAGE, blacklistHit } from '../services/owner/blacklistCache.js';

export function getAdminRequiredMessage() {
    const channelId = enforcementConfig.adminRequestChannelId;
    return channelId
        ? `You need the Administrator role to use this command. Request a mod/admin role here: <#${channelId}>`
        : 'You need the Administrator role to use this command.';
}

/** True when the command exists in this guild: all commands in the main server, the support list in the support server. */
export function isCommandAvailableInGuild(command, guildId) {
    if (!guildId) return false;
    if (guildId === enforcementConfig.mainGuildId) return true;
    return guildId === enforcementConfig.supportGuildId && command?.scope !== 'main' && isSupportServerCommand(command?.data?.name);
}

export function hasAdministrator({ guild, userId, permissions }) {
    if (guild?.ownerId && guild.ownerId === userId) return true;
    return Boolean(permissions?.has?.(PermissionFlagsBits.Administrator));
}

/** True when this user sees admin-only commands in /help (admins, the owner, OWNER_IDS). */
export function canSeeAdminCommands(interaction) {
    return isBotOwner(interaction.user.id)
        || hasAdministrator({ guild: interaction.guild, userId: interaction.user.id, permissions: interaction.memberPermissions });
}

/**
 * @param {object} p
 * @param {object} p.command      loaded command module
 * @param {string|null} p.accessKey  "command" or "command subcommand" (see commandAccess.js)
 * @param {object|null} p.guild
 * @param {string} p.userId
 * @param {object|null} p.permissions  PermissionsBitField of the member in this guild
 * @returns {{ allowed: true, ownerOverride?: true } | { allowed: false, message: string, silent?: true }}
 *   ownerOverride: allowed only because the user is in OWNER_IDS (the caller records it).
 *   silent: a blacklisted server; the caller does not answer at all.
 */
export function checkCommandAccess({ command, accessKey, guild, userId, permissions }) {
    const blocked = blacklistHit({ userId, guildId: guild?.id || null });
    if (blocked) {
        return blocked.kind === 'guild'
            ? { allowed: false, silent: true, message: BLACKLIST_MESSAGE }
            : { allowed: false, message: BLACKLIST_MESSAGE };
    }
    if (!guild) {
        return { allowed: false, message: 'This bot only works in servers.' };
    }
    if (!isCommandAvailableInGuild(command, guild.id)) {
        return {
            allowed: false,
            message: guild.id === enforcementConfig.supportGuildId
                ? 'This command only works in the main Mewvo server.'
                : 'Commands only work in the Mewvo servers.',
        };
    }
    if (isEveryoneCommand(accessKey)) return { allowed: true };
    // Retired admin commands (RETIRE_ADMIN_COMMANDS): the dashboard does them; the emergency kit
    // is for OWNER_IDS only (an owner without Administrator is still an override, logged).
    if (adminCommandsRetired()) {
        if (isOwnerKit(accessKey) && isBotOwner(userId)) {
            return hasAdministrator({ guild, userId, permissions }) ? { allowed: true } : { allowed: true, ownerOverride: true };
        }
        return { allowed: false, message: retiredMessage(accessKey) };
    }
    if (hasAdministrator({ guild, userId, permissions })) return { allowed: true };
    if (isBotOwner(userId)) return { allowed: true, ownerOverride: true };
    return { allowed: false, message: getAdminRequiredMessage() };
}
