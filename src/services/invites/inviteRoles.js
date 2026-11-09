// inviteRoles.js — invite milestone roles: up to 10 { count → role } per server (setting
// inviteTracking.milestones). Reaching a count gives its role. By default every reached role is
// kept (stackRoles); with stacking off only the highest reached one is kept and lower milestone
// roles are taken away when a higher one is given. A count that drops (a leave, a reset, a
// negative bonus) never takes a role away (owner decision 5).
//
// Every role is checked before it is handed out (utils/roleSafety.js getRoleAssignmentProblem:
// exists, not @everyone, not managed, no staff permissions, below Mewvo's highest role); a refused
// role is logged and skipped. Without Manage Roles nothing is changed.

import { PermissionFlagsBits } from 'discord.js';
import { getRoleAssignmentProblem } from '../../utils/roleSafety.js';
import { logger } from '../../utils/logger.js';

/** The milestone role ids a member with `total` invites should have; pure. */
export function milestoneRolesFor(total, milestones, stackRoles = true) {
    const reached = (milestones || []).filter((m) => Number(total) >= m.count).sort((a, b) => a.count - b.count);
    if (!reached.length) return [];
    return stackRoles ? reached.map((m) => m.roleId) : [reached[reached.length - 1].roleId];
}

/**
 * Gives the inviter the milestone roles their total reached. Returns { added, removed, refused }.
 * Never removes a role because the count dropped.
 */
export async function applyMilestoneRoles(guild, member, total, settings, { reason = 'Invite milestone' } = {}) {
    const out = { added: [], removed: [], refused: [] };
    const milestones = settings?.milestones || [];
    if (!guild || !member?.roles?.cache || !milestones.length) return out;
    const me = guild.members?.me;
    if (!me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return out;
    const wanted = milestoneRolesFor(total, milestones, settings.stackRoles !== false);
    if (!wanted.length) return out;
    for (const roleId of wanted) {
        if (member.roles.cache.has(roleId)) continue;
        const role = guild.roles.cache.get(roleId);
        const problem = getRoleAssignmentProblem(role, me);
        if (problem) {
            out.refused.push(roleId);
            logger.warn(`Invite milestone role ${roleId} not given in guild ${guild.id}: ${problem}`);
            continue;
        }
        try {
            await member.roles.add(role, reason);
            out.added.push(roleId);
        } catch (error) {
            out.refused.push(roleId);
            logger.warn(`Invite milestone role ${roleId} not given in guild ${guild.id}: ${error.message}`);
        }
    }
    if (settings.stackRoles === false && out.added.length) {
        // Only the highest reached role stays: lower milestone roles go (only when a higher one was just given).
        const keep = new Set(wanted);
        for (const { roleId } of milestones) {
            if (keep.has(roleId) || !member.roles.cache.has(roleId)) continue;
            const role = guild.roles.cache.get(roleId);
            if (getRoleAssignmentProblem(role, me)) continue;
            try {
                await member.roles.remove(role, reason);
                out.removed.push(roleId);
            } catch (error) {
                logger.warn(`Lower invite milestone role ${roleId} not removed in guild ${guild.id}: ${error.message}`);
            }
        }
    }
    return out;
}
