// memberActions.js — checks for changing a member from the dashboard (roles, nickname, timeout).
// Pure functions: the routes pass in the guild, the moderator and the bot member. Same hierarchy
// rule as enforcement (never the server owner, the bot, yourself, or someone with an equal or
// higher role), plus Discord's own limits (the bot's highest role, managed roles, @everyone).
// The reasons are shown to the moderator in the request's language (memberActions.json; English
// outside a request). Timeout labels stay English here (they go into the audit log); pages show
// timeoutLabel(key).

import { getDangerousPermissions } from '../../utils/roleSafety.js';
import { currentText } from './language.js';

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

/** A timeout length for a page: TIMEOUTS[key].label in English, memberActions.timeout.<key> otherwise. */
export function timeoutLabel(key, tr = currentText()) {
    const k = `memberActions.timeout.${key}`;
    return tr.lang !== 'en' && tr.has(k) ? tr.t(k) : TIMEOUTS[key]?.label;
}

const highest = (member) => member?.roles?.highest?.position ?? 0;

/**
 * Why this moderator may not change this member, or null.
 * actorIsOwner: the server owner or a bot owner (OWNER_IDS): above the role hierarchy here.
 */
export function targetProblem({ guild, target, actorId, actorMember, actorIsOwner = false, botMember }) {
    const tr = currentText();
    if (!target) return tr.t('memberActions.problem.notInServer');
    const id = target.id || target.user?.id;
    if (id === guild.ownerId) return tr.t('memberActions.problem.serverOwner');
    if (id === botMember?.id || id === botMember?.user?.id) return tr.t('memberActions.problem.itself');
    if (id === actorId) return tr.t('memberActions.problem.yourself');
    const name = target.user?.username || tr.t('memberActions.problem.thisMember');
    if (highest(target) >= highest(botMember)) return tr.t('memberActions.problem.aboveBot', { name });
    if (!actorIsOwner && highest(target) >= highest(actorMember)) return tr.t('memberActions.problem.aboveYou', { name });
    return null;
}

/** Why this role may not be given or taken here, or null. */
export function roleProblem({ guild, role, actorMember, actorIsOwner = false, botMember }) {
    const tr = currentText();
    if (!role) return tr.t('memberActions.problem.roleGone');
    if (role.id === guild.id) return tr.t('memberActions.problem.everyone');
    if (role.managed) return tr.t('memberActions.problem.managed', { role: role.name });
    if ((role.position ?? 0) >= highest(botMember)) return tr.t('memberActions.problem.roleAboveBot', { role: role.name });
    if (!actorIsOwner && (role.position ?? 0) >= highest(actorMember)) return tr.t('memberActions.problem.roleAboveYou', { role: role.name });
    const dangerous = getDangerousPermissions(role);
    if (dangerous.length && !actorIsOwner) {
        return tr.t('memberActions.problem.staffRole', { role: role.name, permissions: dangerous.join(', ') });
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

/** The reason shown in Discord's audit log for a dashboard change (English: it is stored in Discord). */
export function auditReason(moderatorName, reason) {
    const text = `Dashboard (${moderatorName})${reason ? `: ${reason}` : ''}`;
    return text.slice(0, 512);
}
