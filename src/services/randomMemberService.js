// randomMemberService.js — picks a random member with the /tools randomuser filters
// (role, bots, online only). Shared by the command and the dashboard Giveaways page.
// The pick uses crypto.randomInt (uniform, not Math.random).

import { randomInt } from 'node:crypto';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { fetchAllMembers } from '../utils/memberFetchGate.js';

// Anyone can run /tools randomuser: refresh the list at most every 10 minutes, and only in
// servers up to this size; bigger servers pick from the member cache.
export const RANDOM_MEMBER_FETCH_MAX = 5_000;
export const RANDOM_MEMBER_MAX_AGE_MS = 10 * 60_000;

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
 * Completes the member list through the member fetch gate (cache-only in big servers or when
 * the gate says later), filters it and picks one.
 * Returns { member, poolSize, partial }; partial = picked from cached members only.
 * Throws USER_INPUT when nobody matches.
 */
export async function pickRandomMember(guild, { roleId = null, includeBots = false, onlineOnly = false } = {}, { pick = randomInt, fetchMembers = fetchAllMembers } = {}) {
    const { partial } = await fetchMembers(guild, { maxAgeMs: RANDOM_MEMBER_MAX_AGE_MS, maxMembers: RANDOM_MEMBER_FETCH_MAX, timeoutMs: 10_000, waitMs: 5_000 });
    const pool = filterRandomMemberPool(guild.members.cache.values(), { roleId, includeBots, onlineOnly });
    if (!pool.length) {
        const roleName = roleId ? guild.roles?.cache?.get(roleId)?.name || roleId : null;
        const message = emptyPoolMessage({ roleName, onlineOnly });
        throw createError('No member matches the filters', ErrorTypes.USER_INPUT, message);
    }
    return { member: pickFromPool(pool, pick), poolSize: pool.length, partial: Boolean(partial) };
}
