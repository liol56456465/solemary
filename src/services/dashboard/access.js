// access.js — who may use the dashboard (owner decision 4):
//   - members who CURRENTLY have Administrator in the main server (MAIN_GUILD_ID):
//     view, change settings and (Phase 3) run enforcement actions — canAct
//   - OWNER_IDS without Administrator there: view and change settings, never
//     enforcement actions — canView only
// The ticket staff role no longer grants access; other servers are never consulted.
// Checked on every request; the answer is cached for 60 seconds, so a removed
// Administrator permission locks the dashboard within a minute.

import { PermissionFlagsBits } from 'discord.js';
import { getBotOwners } from '../../config/bot.js';

export const ACCESS_CACHE_MS = 60 * 1000;

/**
 * Pure: the decision from what is known about the user.
 * facts: { inGuild, isAdmin, isOwnerId }.
 * Returns { allowed, canView, canAct, role: 'admin' | 'owner' | null, reason }.
 */
export function decideAccess({ inGuild = false, isAdmin = false, isOwnerId = false } = {}) {
    if (inGuild && isAdmin) {
        return { allowed: true, canView: true, canAct: true, role: 'admin', reason: 'administrator in the main server' };
    }
    if (isOwnerId) {
        return { allowed: true, canView: true, canAct: false, role: 'owner', reason: 'bot owner (OWNER_IDS), view and settings only' };
    }
    return {
        allowed: false, canView: false, canAct: false, role: null,
        reason: inGuild ? 'not an administrator in the main server' : 'not a member of the main server',
    };
}

/** The facts for decideAccess, fetched from Discord. */
export async function memberFacts(client, userId, guildId, owners = getBotOwners()) {
    const isOwnerId = owners.includes(String(userId));
    const guild = guildId ? client.guilds?.cache?.get(guildId) : null;
    if (!guild) return { inGuild: false, isAdmin: false, isOwnerId };
    // force: true so permission changes are seen (the cache answers otherwise until the next event).
    const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
    if (!member) return { inGuild: false, isAdmin: false, isOwnerId };
    // GuildMember#permissions includes every permission for the server owner.
    return { inGuild: true, isAdmin: Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator)), isOwnerId };
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
