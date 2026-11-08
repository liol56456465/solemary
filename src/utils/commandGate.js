// commandGate.js — who may run a command, checked centrally for slash and prefix
// commands alike.
//
// 1. Every command runs in every server the bot is in (public bot, multi-server B2),
//    except the owner tools (rule 3).
// 2. Everything requires Administrator (the server owner counts), except the
//    access keys listed in config/commands/commandAccess.js (everyone, or
//    Administrator or Manage Server). OWNER_IDS is an emergency override for rule 2 only,
//    and only in Mewvo's own servers (main + support, utils/ownerPower.js); in any other
//    server they need Administrator (or Manage Server) like everyone else.
// Commands stay visible to everyone (no default_member_permissions), so
// non-admins see this message instead of an empty command list.
//
// 3. Owner tools (scope 'owner', /database): only in OWNER_TOOLS_GUILD_ID (config/ownerTools.js)
//    and only for OWNER_IDS. Stricter than Administrator; nothing else lets anyone in.
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
import { isEveryoneCommand, isManageServerCommand } from '../config/commands/commandAccess.js';
import { adminCommandsRetired, isKeptAdminCommand, isOwnerKit, retiredMessage } from '../config/commands/retirement.js';
import { BLACKLIST_MESSAGE, blacklistHit } from '../services/owner/blacklistCache.js';
import { getStoredSetting, isHomeGuild, resolveSetting } from '../services/settings/guildSettings.js';
import { botText } from './botText.js';
import { ownerToolsGuildId } from '../config/ownerTools.js';
import { hasOwnerPower } from './ownerPower.js';

export const OWNER_TOOLS_REFUSAL = 'This command is only for the bot owner.';

/**
 * True when an owner-tools command may run: the user is in OWNER_IDS and it runs inside
 * OWNER_TOOLS_GUILD_ID. `ownerGuildId` and `isOwner` are injectable for tests.
 */
export function canUseOwnerTools({ guildId, userId, ownerGuildId = ownerToolsGuildId(), isOwner = isBotOwner } = {}) {
    return Boolean(ownerGuildId) && String(guildId || '') === ownerGuildId && Boolean(userId) && isOwner(String(userId));
}

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

/** True when the command exists in this guild: every command in every server, the owner tools in the owner-tools server only. */
export function isCommandAvailableInGuild(command, guildId) {
    if (!guildId) return false;
    // Owner tools exist in the owner-tools server only (never in the main or support server).
    if (command?.scope === 'owner') return guildId === ownerToolsGuildId();
    return true;
}

/** True for Administrator (or the server owner) and for Manage Server. */
export function hasManageServer({ guild, userId, permissions }) {
    return hasAdministrator({ guild, userId, permissions }) || Boolean(permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

export function hasAdministrator({ guild, userId, permissions }) {
    if (guild?.ownerId && guild.ownerId === userId) return true;
    return Boolean(permissions?.has?.(PermissionFlagsBits.Administrator));
}

/**
 * True when this user passes the Administrator gate here: Administrator, the server owner, or
 * OWNER_IDS in Mewvo's own servers. For re-checks inside admin commands and their buttons and
 * modals (components are not gated centrally), so they match the gate exactly.
 */
export function hasAdminAccess(interaction) {
    if (!interaction?.user) return false;
    return hasOwnerPower(interaction.user.id, interaction.guildId)
        || hasAdministrator({ guild: interaction.guild, userId: interaction.user.id, permissions: interaction.memberPermissions ?? interaction.member?.permissions });
}

/** True when this user sees admin-only commands in /help (admins, the owner, OWNER_IDS in Mewvo's own servers). */
export function canSeeAdminCommands(interaction) {
    return hasAdminAccess(interaction);
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
    if (command?.scope === 'owner') {
        return canUseOwnerTools({ guildId: guild.id, userId })
            ? { allowed: true }
            : { allowed: false, message: OWNER_TOOLS_REFUSAL };
    }
    if (isEveryoneCommand(accessKey)) return { allowed: true };
    // Administrator or Manage Server (/setup); checked before retirement, so it stays usable then.
    if (isManageServerCommand(accessKey)) {
        if (hasManageServer({ guild, userId, permissions })) return { allowed: true };
        if (hasOwnerPower(userId, guild.id)) return { allowed: true, ownerOverride: true };
        return { allowed: false, message: botText(lang).t('errors.access.manageServer') };
    }
    // Retired admin commands (RETIRE_ADMIN_COMMANDS): the dashboard does them; the emergency kit
    // is for OWNER_IDS only (an owner without Administrator is still an override, logged).
    if (adminCommandsRetired() && !isKeptAdminCommand(accessKey)) {
        if (isOwnerKit(accessKey) && hasOwnerPower(userId, guild.id)) {
            return hasAdministrator({ guild, userId, permissions }) ? { allowed: true } : { allowed: true, ownerOverride: true };
        }
        return { allowed: false, message: retiredMessage(accessKey, guild.id) };
    }
    if (hasAdministrator({ guild, userId, permissions })) return { allowed: true };
    // OWNER_IDS override Administrator in Mewvo's own servers only (multi-server B1, utils/ownerPower.js).
    if (hasOwnerPower(userId, guild.id)) return { allowed: true, ownerOverride: true };
    return { allowed: false, message: getAdminRequiredMessage(guild.id, { lang }) };
}
