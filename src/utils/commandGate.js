// commandGate.js — who may run a command, checked centrally for slash and prefix
// commands alike.
//
// 1. Every command only runs in the main server (the support server only has the
//    appeal panel's buttons).
// 2. Everything requires Administrator (the server owner counts). OWNER_IDS is an
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

export function getAdminRequiredMessage() {
    return `You need the Administrator role to use this bot. Request a mod/admin role here: <#${enforcementConfig.adminRequestChannelId}>`;
}

/** True when the command exists in this guild: every command lives in the main server only. */
export function isCommandAvailableInGuild(command, guildId) {
    return Boolean(guildId) && guildId === enforcementConfig.mainGuildId;
}

function hasAdministrator({ guild, userId, permissions }) {
    if (guild?.ownerId && guild.ownerId === userId) return true;
    return Boolean(permissions?.has?.(PermissionFlagsBits.Administrator));
}

/**
 * @param {object} p
 * @param {object} p.command      loaded command module
 * @param {object|null} p.guild
 * @param {string} p.userId
 * @param {object|null} p.permissions  PermissionsBitField of the member in this guild
 * @returns {{ allowed: true } | { allowed: false, message: string }}
 */
export function checkCommandAccess({ command, guild, userId, permissions }) {
    if (!guild) {
        return { allowed: false, message: 'This bot only works in servers.' };
    }
    if (!isCommandAvailableInGuild(command, guild.id)) {
        return { allowed: false, message: 'Commands only work in the main Meowist server.' };
    }
    if (isBotOwner(userId) || hasAdministrator({ guild, userId, permissions })) {
        return { allowed: true };
    }
    return { allowed: false, message: getAdminRequiredMessage() };
}
