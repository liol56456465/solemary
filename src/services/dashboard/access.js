// access.js — who may use the dashboard (owner decision 4):
//   - members who CURRENTLY have Administrator in the main server (MAIN_GUILD_ID):
//     view, change settings and (Phase 3) run enforcement actions — canAct
//   - OWNER_IDS without Administrator there: view and change settings, never
//     enforcement actions — canView only
//   - members with the configured moderator role (guild config `modRole`, the Commands
//     page "Moderator role"): the Moderator level — only what permissions.js marks
//     MODERATOR (canView and canAct stay false; the table grants the rest)
// The ticket staff role no longer grants access; other servers are never consulted.
// Checked on every request; the answer is cached for 60 seconds, so a removed
// Administrator permission locks the dashboard within a minute.

import { PermissionFlagsBits } from 'discord.js';
import { getBotOwners } from '../../config/bot.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { memberHasConfiguredModeratorRole } from '../../utils/permissionGuard.js';

export const ACCESS_CACHE_MS = 60 * 1000;

/**
 * Pure: the decision from what is known about the user.
 * facts: { inGuild, isAdmin, isOwnerId, isModerator }.
 * Returns { allowed, canView, canAct, role: 'admin' | 'owner' | 'moderator' | null, reason }.
 * Order: Administrator, then OWNER_IDS (as before), then the moderator role.
 */
export function decideAccess({ inGuild = false, isAdmin = false, isOwnerId = false, isModerator = false } = {}) {
    if (inGuild && isAdmin) {
        return { allowed: true, canView: true, canAct: true, role: 'admin', reason: 'administrator in the main server' };
    }
    if (isOwnerId) {
        return { allowed: true, canView: true, canAct: false, role: 'owner', reason: 'bot owner (OWNER_IDS), view and settings only' };
    }
    if (inGuild && isModerator) {
        // canView false: settings forms check canView; the Moderator pages come from permissions.js.
        return { allowed: true, canView: false, canAct: false, role: 'moderator', reason: 'moderator role in the main server' };
    }
    return {
        allowed: false, canView: false, canAct: false, role: null,
        reason: inGuild ? 'not an administrator or moderator in the main server' : 'not a member of the main server',
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

/** The facts for decideAccess, fetched from Discord. */
export async function memberFacts(client, userId, guildId, owners = getBotOwners(), loadConfig = getGuildConfig) {
    const isOwnerId = owners.includes(String(userId));
    const guild = guildId ? client.guilds?.cache?.get(guildId) : null;
    if (!guild) return { inGuild: false, isAdmin: false, isOwnerId, isModerator: false };
    // force: true so permission and role changes are seen (the cache answers otherwise until the next event).
    const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
    if (!member) return { inGuild: false, isAdmin: false, isOwnerId, isModerator: false };
    // GuildMember#permissions includes every permission for the server owner.
    const isAdmin = Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));
    return { inGuild: true, isAdmin, isOwnerId, isModerator: isAdmin ? false : await hasModeratorRole(client, guildId, member, loadConfig) };
}

/** A checker with a 60-second cache: check(userId) → decision. `facts` is injectable for tests. */
export function createAccessChecker(client, { guildId = null, facts = memberFacts, ttlMs = ACCESS_CACHE_MS } = {}) {
    const cache = new Map(); // userId → { decision, at }
    return {
        async check(userId, now = Date.now()) {
            const hit = cache.get(userId);
            if (hit && now - hit.at < ttlMs) return hit.decision;
            const decision = decideAccess(await facts(client, userId, guildId));
            cache.set(userId, { decision, at: now });
            if (cache.size > 1000) for (const [id, entry] of cache) if (now - entry.at >= ttlMs) cache.delete(id);
            return decision;
        },
        forget(userId) {
            cache.delete(userId);
        },
    };
}
