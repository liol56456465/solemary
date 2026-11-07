// warnRoleService.js — the "Warning 1/2/3" roles of a server (warnRoleIds; WARN_ROLE_IDS for the main server).
//
// A member has exactly one of these roles, matching how many active warnings they
// have (capped at the last role), or none without active warnings. Test cases and
// imported legacy warnings don't count. syncWarnRoles() re-derives that for one user
// and is called after every warn, removed warn and accepted warn appeal, and when a
// member rejoins.

import { logger } from '../../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from './db.js';
import { guildRole, resolveSetting } from '../settings/guildSettings.js';
import { OPEN_STATUSES } from './caseService.js';

export async function countActiveWarns(guildId, userId) {
    const { rows } = await query(
        `SELECT COUNT(*)::int AS count FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND type = 'warn' AND status = ANY($3)
           AND is_imported = FALSE AND is_test = FALSE`,
        [guildId, userId, OPEN_STATUSES]
    );
    return rows[0]?.count || 0;
}

/**
 * Gives the member the warning role for their active warn count and removes the others.
 * Uses this server's own warnRoleIds (none set up: nothing to do). The support server has no
 * warning roles (as before: its warns never touched roles).
 */
export async function syncWarnRoles(guild, userId) {
    if (!guild?.id || guildRole(guild.id) === 'support' || !isEnforcementDbAvailable()) return;
    const roleIds = resolveSetting(guild.id, 'warnRoleIds');
    if (!Array.isArray(roleIds) || !roleIds.length) return;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const count = await countActiveWarns(guild.id, userId);
    const wanted = count > 0 ? roleIds[Math.min(count, roleIds.length) - 1] : null;
    const toRemove = roleIds.filter((id) => id !== wanted && member.roles.cache.has(id));

    if (toRemove.length) {
        await member.roles.remove(toRemove, `Active warnings: ${count}`);
    }
    if (wanted && !member.roles.cache.has(wanted)) {
        await member.roles.add(wanted, `Active warnings: ${count}`);
    }
}

/** Runs syncWarnRoles and only logs failures, for callers that must not fail on it. */
export function syncWarnRolesQuietly(guild, userId) {
    return syncWarnRoles(guild, userId).catch((error) => {
        logger.warn(`Warning roles not synced for ${userId}: ${error.message}`);
    });
}
