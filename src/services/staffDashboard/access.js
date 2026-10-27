// access.js — who may use the staff dashboard: members of the main server who are
// Administrators (or the owner) or hold the ticket staff role (/ticket setup
// staff_role). Checked on every request; the answer is cached for 60 seconds so a
// removed role locks the dashboard within a minute.

import { PermissionFlagsBits } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { getGuildConfig } from '../config/guildConfig.js';

export const ACCESS_CACHE_MS = 60 * 1000;

/**
 * Pure: the decision from what is known about the member.
 * facts: { inGuild, isOwner, isAdmin, roleIds: string[], staffRoleId }.
 * Returns { allowed, role: 'admin' | 'staff' | null, reason }.
 */
export function decideAccess({ inGuild, isOwner = false, isAdmin = false, roleIds = [], staffRoleId = null }) {
    if (!inGuild) return { allowed: false, role: null, reason: 'not a member of the main server' };
    if (isOwner || isAdmin) return { allowed: true, role: 'admin', reason: 'administrator' };
    if (staffRoleId && roleIds.includes(staffRoleId)) return { allowed: true, role: 'staff', reason: 'ticket staff role' };
    return { allowed: false, role: null, reason: 'not an administrator and no staff role' };
}

/** The facts for decideAccess, fetched from Discord. Throws only on unexpected errors. */
export async function memberFacts(client, userId, guildId = enforcementConfig.mainGuildId) {
    const guild = guildId ? client.guilds.cache.get(guildId) : null;
    if (!guild) return { inGuild: false };
    // force: true so role changes are seen (the cache answers otherwise until the next event).
    const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
    if (!member) return { inGuild: false };
    const config = await getGuildConfig(client, guild.id).catch(() => null);
    return {
        inGuild: true,
        isOwner: guild.ownerId === userId,
        isAdmin: Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator)),
        roleIds: [...(member.roles?.cache?.keys?.() || [])],
        staffRoleId: config?.ticketStaffRoleId || null,
    };
}

/** A checker with a 60-second cache: check(userId) → decision. `facts` is injectable for tests. */
export function createAccessChecker(client, { facts = memberFacts, ttlMs = ACCESS_CACHE_MS } = {}) {
    const cache = new Map(); // userId → { decision, at }
    return {
        async check(userId, now = Date.now()) {
            const hit = cache.get(userId);
            if (hit && now - hit.at < ttlMs) return hit.decision;
            const decision = decideAccess(await facts(client, userId));
            cache.set(userId, { decision, at: now });
            if (cache.size > 1000) for (const [id, entry] of cache) if (now - entry.at >= ttlMs) cache.delete(id);
            return decision;
        },
        forget(userId) {
            cache.delete(userId);
        },
    };
}
