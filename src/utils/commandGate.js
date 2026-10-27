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
// Message components (buttons, selects, modals) are not gated here: the appeal
// panel and verification must work for everyone, and each admin-only panel
// re-checks Administrator itself.

import { PermissionFlagsBits } from 'discord.js';
import { isBotOwner } from '../config/bot.js';
import { enforcementConfig } from '../config/enforcement.js';
import { isEveryoneCommand } from '../config/commands/commandAccess.js';

export function getAdminRequiredMessage() {
    return `You need the Administrator role to use this command. Request a mod/admin role here: <#${enforcementConfig.adminRequestChannelId}>`;
}

/** True when the command exists in this guild: all commands in the main server, all but scope 'main' in the support server. */
export function isCommandAvailableInGuild(command, guildId) {
    if (!guildId) return false;
    if (guildId === enforcementConfig.mainGuildId) return true;
    return guildId === enforcementConfig.supportGuildId && command?.scope !== 'main';
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
 * @returns {{ allowed: true } | { allowed: false, message: string }}
 */
export function checkCommandAccess({ command, accessKey, guild, userId, permissions }) {
    if (!guild) {
        return { allowed: false, message: 'This bot only works in servers.' };
    }
    if (!isCommandAvailableInGuild(command, guild.id)) {
        return {
            allowed: false,
            message: guild.id === enforcementConfig.supportGuildId
                ? 'This command only works in the main Meowist server.'
                : 'Commands only work in the Meowist servers.',
        };
    }
    if (isEveryoneCommand(accessKey) || isBotOwner(userId) || hasAdministrator({ guild, userId, permissions })) {
        return { allowed: true };
    }
    return { allowed: false, message: getAdminRequiredMessage() };
}
