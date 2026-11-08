// ownerPower.js — where OWNER_IDS keep their emergency override (owner decision, plan.md B3:
// "full power only in Mewvo's own servers").
//
// In Mewvo's own servers (MAIN_GUILD_ID / SUPPORT_GUILD_ID) an OWNER_IDS account may act without
// Administrator (logged as an owner override) and is exempt from the mass-action guard, as before.
// In any other server it is an ordinary member there: no Administrator override, no exemption.
// Owner tools (/database in OWNER_TOOLS_GUILD_ID) and the blacklist exemption are separate rules.

import { isBotOwner } from '../config/bot.js';
import { enforcementConfig } from '../config/enforcement.js';
import { isHomeGuild } from '../services/settings/guildSettings.js';

/** Mewvo's own servers: the configured main/support ids (env, or the loaded enforcement config). */
export function isMewvoServer(guildId) {
    if (!guildId) return false;
    return isHomeGuild(guildId) || guildId === enforcementConfig.mainGuildId || guildId === enforcementConfig.supportGuildId;
}

/**
 * True when `userId` is in OWNER_IDS and `guildId` is one of Mewvo's own servers.
 * `isOwner` / `isHome` are injectable for tests.
 */
export function hasOwnerPower(userId, guildId, { isOwner = isBotOwner, isHome = isMewvoServer } = {}) {
    if (!userId || !guildId) return false;
    return isHome(String(guildId)) && isOwner(String(userId));
}
