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
import { adminCommandsRetired, isKeptAdminCommand, isOwnerKit, retiredMessage } from '../config/commands/retirement.js';
import { BLACKLIST_MESSAGE, blacklistHit } from '../services/owner/blacklistCache.js';
import { getStoredSetting, isHomeGuild, resolveSetting } from '../services/settings/guildSettings.js';
import { botText } from './botText.js';

/**
 * A server's own admin request channel. The support server (a home server, so resolveSetting
 * would lend it the main server's env value) only uses what it stored itself; any other server
 * goes through resolveSetting (its stored value, else null; never the main server's).
 */
function ownRequestChannel(guildId, key) {
    return isHomeGuild(guildId) ? getStoredSetting(guildId, key) : resolveSetting(guildId, key);
}

/**
 * The refusal for a non-admin. The main server (or no server given) keeps its wording and its
 * admin request channel. Any other server only names a request channel it set up itself, never
 * the main server's channel (that link would lead nowhere there); otherwise a neutral line.
 * A read that fails (database down at boot: SettingsUnavailableError) also gives the neutral
 * line: it is only the wording of a refusal, the command is refused either way.
 * `stored` is for tests. `lang`: the language of the person asking (utils/botText.js); English by default.
 */
export function getAdminRequiredMessage(guildId = null, { stored = ownRequestChannel, lang = 'en' } = {}) {
    const isMain = !guildId || guildId === enforcementConfig.mainGuildId;
    let channelId = null;
    if (isMain) {
        // The main server's own value: the config getter is getConfiguredSetting, i.e. resolveSetting(MAIN_GUILD_ID).
        channelId = enforcementConfig.adminRequestChannelId;
    } else {
        try {
            channelId = stored(guildId, 'adminRequestChannelId') || null;
        } catch {
            channelId = null;
        }
    }
    const tr = botText(lang);
    if (channelId) return tr.t('errors.access.adminChannel', { channelId });
    return isMain ? tr.t('errors.access.admin') : tr.t('errors.access.adminOther');
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
 * @param {string} [p.lang]  language of the refusal (utils/botText.js resolveBotLanguage); English by default
 * @returns {{ allowed: true, ownerOverride?: true } | { allowed: false, message: string, silent?: true }}
 *   ownerOverride: allowed only because the user is in OWNER_IDS (the caller records it).
 *   silent: a blacklisted server; the caller does not answer at all.
 */
export function checkCommandAccess({ command, accessKey, guild, userId, permissions, lang = 'en' }) {
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
    if (adminCommandsRetired() && !isKeptAdminCommand(accessKey)) {
        if (isOwnerKit(accessKey) && isBotOwner(userId)) {
            return hasAdministrator({ guild, userId, permissions }) ? { allowed: true } : { allowed: true, ownerOverride: true };
        }
        return { allowed: false, message: retiredMessage(accessKey) };
    }
    if (hasAdministrator({ guild, userId, permissions })) return { allowed: true };
    if (isBotOwner(userId)) return { allowed: true, ownerOverride: true };
    return { allowed: false, message: getAdminRequiredMessage(guild.id, { lang }) };
}
