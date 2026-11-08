// access.js — who may use the dashboard of ONE server (multi-server B3, docs/multi-server-b3.md §2).
//
// Levels, checked against the server the dashboard is bound to (guildId):
//   admin      Administrator in that server: view, change settings and run enforcement actions.
//   owner      OWNER_IDS, but only where hasOwnerPower(userId, guildId) is true (Mewvo's own
//              servers, utils/ownerPower.js). Without Administrator: view + settings, no actions.
//              In any other server an OWNER_IDS account is an ordinary member there.
//   manager    Manage Server without Administrator: settings pages and settings forms, and view
//              what Moderators view except the Inbox (staff reports), the watchlist and staff
//              discipline. Never moderation actions (canAct false). permissions.js decides keys.
//   moderator  the server's own configured moderator role (guild config `modRole`): only what
//              permissions.js marks MODERATOR. A moderator who also has Manage Server stays a
//              moderator (`manager: true` on the decision) and gets the manager's keys on top.
//
// CONTRACT (other modules rely on it):
//   decideAccess(facts) → { allowed, canView, canAct, canEditSettings, role, reason[, manager] }
//     admin     { canView: true,  canAct: true,  canEditSettings: true }
//     owner     { canView: true,  canAct: false, canEditSettings: true }
//     manager   { canView: true,  canAct: false, canEditSettings: true }
//     moderator { canView: false, canAct: false, canEditSettings: false } (with Manage Server:
//               canView: true, canEditSettings: true, manager: true)
//     none      { allowed: false, everything false, role: null }
//   Module/form actions marked `admin: true` stay Administrator-only (canAct), whatever the level.
//   createAccessChecker(client, { guildId }) → { check, checkFresh, forget }:
//     check(userId, { guildId, now })   cached 30 s per (user, server)
//     checkFresh(userId, { guildId })   drops the cached answer and asks Discord again (every POST)
//     forget(userId[, guildId])         drops one server's answer, or every server's for that user
//   check(userId, now) with a number still works (older callers and tests).

import { PermissionFlagsBits } from 'discord.js';
import { getBotOwners } from '../../config/bot.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { memberHasConfiguredModeratorRole } from '../../utils/permissionGuard.js';
import { hasOwnerPower, isMewvoServer } from '../../utils/ownerPower.js';

export const ACCESS_CACHE_MS = 30 * 1000;
/** Bound on cached (user, server) answers; expired ones go first, then the oldest. */
export const ACCESS_CACHE_MAX = 5000;

/**
 * Pure: the decision from what is known about the user in this server.
 * facts: { inGuild, isAdmin, isOwnerId, isManager, isModerator }; isOwnerId means owner power
 * HERE (hasOwnerPower), not just "listed in OWNER_IDS".
 * Order: Administrator, then owner power, then the moderator role, then Manage Server.
 */
export function decideAccess({ inGuild = false, isAdmin = false, isOwnerId = false, isManager = false, isModerator = false } = {}) {
    if (inGuild && isAdmin) {
        return { allowed: true, canView: true, canAct: true, canEditSettings: true, role: 'admin', reason: 'administrator in this server' };
    }
    if (isOwnerId) {
        return { allowed: true, canView: true, canAct: false, canEditSettings: true, role: 'owner', reason: 'bot owner (OWNER_IDS) in a Mewvo server, view and settings only' };
    }
    if (inGuild && isModerator) {
        // canView false: settings forms check canView; the Moderator pages come from permissions.js.
        // With Manage Server too: the settings pages on top (permissions.js allows, decision.manager).
        if (isManager) {
            return { allowed: true, canView: true, canAct: false, canEditSettings: true, role: 'moderator', manager: true, reason: 'moderator role and Manage Server in this server' };
        }
        return { allowed: true, canView: false, canAct: false, canEditSettings: false, role: 'moderator', reason: 'moderator role in this server' };
    }
    if (inGuild && isManager) {
        return { allowed: true, canView: true, canAct: false, canEditSettings: true, role: 'manager', reason: 'Manage Server in this server, settings only' };
    }
    return {
        allowed: false, canView: false, canAct: false, canEditSettings: false, role: null,
        reason: inGuild ? 'no Administrator, Manage Server or moderator role in this server' : 'not a member of this server',
    };
}

/**
 * Whether this member holds the configured moderator role (guild config `modRole`). A config
 * read that fails counts as no (fail closed: Administrators are not affected).
 */
export async function hasModeratorRole(client, guildId, member, loadConfig = getGuildConfig) {
    if (!member) return false;
    const config = await Promise.resolve().then(() => loadConfig(client, guildId)).catch(() => null);
    return memberHasConfiguredModeratorRole(member, config);
}

/**
 * The facts for decideAccess, fetched from Discord for one server. `owners` and `isHome` are
 * injectable for tests; isOwnerId = hasOwnerPower(userId, guildId).
 */
export async function memberFacts(client, userId, guildId, owners = getBotOwners(), loadConfig = getGuildConfig, { isHome = isMewvoServer } = {}) {
    const isOwnerId = hasOwnerPower(userId, guildId, { isOwner: (id) => owners.includes(id), isHome });
    const none = { inGuild: false, isAdmin: false, isOwnerId, isManager: false, isModerator: false };
    const guild = guildId ? client.guilds?.cache?.get(guildId) : null;
    if (!guild) return none;
    // force: true so permission and role changes are seen (the cache answers otherwise until the next event).
    const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
    if (!member) return none;
    // GuildMember#permissions includes every permission for the server owner.
    const isAdmin = Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));
    const isManager = !isAdmin && Boolean(member.permissions?.has?.(PermissionFlagsBits.ManageGuild));
    return { inGuild: true, isAdmin, isOwnerId, isManager, isModerator: isAdmin ? false : await hasModeratorRole(client, guildId, member, loadConfig) };
}

const cacheKey = (userId, guildId) => `${userId}:${guildId || '-'}`;

/** check(userId, now) (legacy) or check(userId, { guildId, now }). */
function options(arg, defaultGuildId) {
    if (typeof arg === 'number') return { guildId: defaultGuildId, now: arg };
    return { guildId: arg?.guildId ?? defaultGuildId, now: arg?.now ?? Date.now() };
}

/**
 * A checker with a 30-second cache per (user, server). `guildId` is the default server
 * (the main server today); `facts` is injectable for tests.
 */
export function createAccessChecker(client, { guildId = null, facts = memberFacts, ttlMs = ACCESS_CACHE_MS, maxEntries = ACCESS_CACHE_MAX } = {}) {
    const cache = new Map(); // `${userId}:${guildId}` → { decision, at }

    function prune(now) {
        if (cache.size <= maxEntries) return;
        for (const [key, entry] of cache) if (now - entry.at >= ttlMs) cache.delete(key);
        // Still too many: drop the oldest (Map keeps insertion order; a refresh re-inserts).
        for (const key of cache.keys()) {
            if (cache.size <= maxEntries) break;
            cache.delete(key);
        }
    }

    async function check(userId, arg) {
        const { guildId: gid, now } = options(arg, guildId);
        const key = cacheKey(userId, gid);
        const hit = cache.get(key);
        if (hit && now - hit.at < ttlMs) return hit.decision;
        const decision = decideAccess(await facts(client, userId, gid));
        cache.delete(key);
        cache.set(key, { decision, at: now });
        prune(now);
        return decision;
    }

    function forget(userId, gid) {
        if (gid !== undefined) {
            cache.delete(cacheKey(userId, gid));
            return;
        }
        const prefix = `${userId}:`;
        for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
    }

    return {
        check,
        /** Always asks Discord (the cached answer is replaced). For every POST. */
        async checkFresh(userId, arg) {
            const { guildId: gid, now } = options(arg, guildId);
            forget(userId, gid);
            return check(userId, { guildId: gid, now });
        },
        forget,
        /** For tests: how many answers are cached. */
        size: () => cache.size,
    };
}
