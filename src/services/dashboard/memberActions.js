// memberActions.js — checks for changing a member from the dashboard (roles, nickname, timeout).
// Pure functions: the routes pass in the guild, the moderator and the bot member. Same hierarchy
// rule as enforcement (never the server owner, the bot, yourself, or someone with an equal or
// higher role), plus Discord's own limits (the bot's highest role, managed roles, @everyone).

import { getDangerousPermissions } from '../../utils/roleSafety.js';

/** Timeout lengths offered (Discord allows at most 28 days). */
export const TIMEOUTS = {
    '60s': { label: '60 seconds', ms: 60_000 },
    '5m': { label: '5 minutes', ms: 5 * 60_000 },
    '10m': { label: '10 minutes', ms: 10 * 60_000 },
    '1h': { label: '1 hour', ms: 3_600_000 },
    '1d': { label: '1 day', ms: 86_400_000 },
    '1w': { label: '1 week', ms: 7 * 86_400_000 },
    '28d': { label: '28 days', ms: 28 * 86_400_000 },
};
export const NICKNAME_MAX = 32;
export const REASON_MAX = 200;

const highest = (member) => member?.roles?.highest?.position ?? 0;

/**
 * Why this moderator may not change this member, or null.
 * actorIsOwner: the server owner or a bot owner (OWNER_IDS): above the role hierarchy here.
 */
export function targetProblem({ guild, target, actorId, actorMember, actorIsOwner = false, botMember }) {
    if (!target) return 'That user is not in the server.';
    const id = target.id || target.user?.id;
    if (id === guild.ownerId) return 'The server owner cannot be changed from here.';
    if (id === botMember?.id || id === botMember?.user?.id) return 'Meowist cannot change itself.';
    if (id === actorId) return 'You cannot change your own roles or timeout from here.';
    if (highest(target) >= highest(botMember)) return `${target.user?.username || 'This member'} has a role at or above Meowist's highest role, so Discord does not let the bot change them.`;
    if (!actorIsOwner && highest(target) >= highest(actorMember)) return `${target.user?.username || 'This member'} has a role at or above your highest role.`;
    return null;
}

/** Why this role may not be given or taken here, or null. */
export function roleProblem({ guild, role, actorMember, actorIsOwner = false, botMember }) {
    if (!role) return 'That role no longer exists.';
    if (role.id === guild.id) return 'The @everyone role cannot be given or taken.';
    if (role.managed) return `@${role.name} is managed by an integration or bot; Discord does not allow changing it by hand.`;
    if ((role.position ?? 0) >= highest(botMember)) return `@${role.name} is not below Meowist's highest role, so Discord does not let the bot give or take it.`;
    if (!actorIsOwner && (role.position ?? 0) >= highest(actorMember)) return `@${role.name} is not below your highest role.`;
    const dangerous = getDangerousPermissions(role);
    if (dangerous.length && !actorIsOwner) {
        return `@${role.name} has staff permissions (${dangerous.join(', ')}); only the server owner or the bot owners can give or take it here.`;
    }
    return null;
}

/** Roles this moderator may give (for the picker): [{ id, name }], highest first. */
export function assignableRoles({ guild, actorMember, actorIsOwner = false, botMember }) {
    return [...(guild.roles?.cache?.values?.() || [])]
        .filter((role) => !roleProblem({ guild, role, actorMember, actorIsOwner, botMember }))
        .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
        .map((role) => ({ id: role.id, name: role.name }));
}

/** The reason shown in Discord's audit log for a dashboard change. */
export function auditReason(moderatorName, reason) {
    const text = `Dashboard (${moderatorName})${reason ? `: ${reason}` : ''}`;
    return text.slice(0, 512);
}
