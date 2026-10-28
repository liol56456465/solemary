// randomMemberService.js — picks a random member with the /tools randomuser filters
// (role, bots, online only). Shared by the command and the dashboard Giveaways page.
// The pick uses crypto.randomInt (uniform, not Math.random).

import { randomInt } from 'node:crypto';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';

/** The members that pass the filters (bots excluded unless includeBots). */
export function filterRandomMemberPool(members, { roleId = null, includeBots = false, onlineOnly = false } = {}) {
    return [...members].filter((member) => {
        if (!member?.user) return false;
        if (member.user.bot && !includeBots) return false;
        if (onlineOnly && (!member.presence || member.presence.status === 'offline')) return false;
        if (roleId && !member.roles?.cache?.has(roleId)) return false;
        return true;
    });
}

/** The /tools randomuser message when nobody matches. */
export function emptyPoolMessage({ roleName = null, onlineOnly = false } = {}) {
    let message = 'Could not find any users matching your filters:';
    if (roleName) message = `No users have the **${roleName}** role.`;
    if (onlineOnly) message = 'No users are currently online.';
    if (roleName && onlineOnly) message = `No **${roleName}** members are online.`;
    return `${message}\n\nTry adjusting your filters.`;
}

/** One member of `pool`, chosen uniformly; `pick(n)` → 0..n-1 is injectable for tests. */
export function pickFromPool(pool, pick = randomInt) {
    return pool.length ? pool[pick(pool.length)] : null;
}

/**
 * Fetches the member list (falls back to the cache), filters it and picks one.
 * Returns { member, poolSize }; throws USER_INPUT when nobody matches.
 */
export async function pickRandomMember(guild, { roleId = null, includeBots = false, onlineOnly = false } = {}, { pick = randomInt } = {}) {
    await guild.members.fetch().catch((error) => {
        logger.debug('randomuser: member fetch failed, using cache', { error: error?.message });
    });
    const pool = filterRandomMemberPool(guild.members.cache.values(), { roleId, includeBots, onlineOnly });
    if (!pool.length) {
        const roleName = roleId ? guild.roles?.cache?.get(roleId)?.name || roleId : null;
        const message = emptyPoolMessage({ roleName, onlineOnly });
        throw createError('No member matches the filters', ErrorTypes.USER_INPUT, message);
    }
    return { member: pickFromPool(pool, pick), poolSize: pool.length };
}
