// levelBoosts.js — pure leveling math: XP multipliers (channel and role boosts) and which
// reward roles a member should hold for a level (reward mode). No Discord or DB calls,
// so messageCreate, the role sync and the dashboard share one tested rule set.
//
// Config fields (inside the leveling config, services/leveling/leveling.js):
//   channelMultipliers: { [channelId]: 1.1..5 }   a thread counts as its parent channel
//   roleMultipliers:    { [roleId]: 1.1..5 }      the highest matching role wins (no stacking)
//   xpMultiplier:       number                     the older global multiplier (only > 1 counts)
//   rewardMode:         'keep' | 'highest'         keep all earned reward roles, or only the top one

export const BOOST_MIN = 1.1;
export const BOOST_MAX = 5;
/** Channel x role x global never goes above this. */
export const TOTAL_MULTIPLIER_CAP = 5;
/** Most boosts per kind (channels, roles) a server can store. */
export const MAX_BOOSTS = 50;

export const REWARD_MODES = Object.freeze(['keep', 'highest']);

/** A stored or typed boost value is valid: a number from 1.1 to 5 with at most one decimal. */
export function isValidBoost(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (value < BOOST_MIN - 1e-9 || value > BOOST_MAX + 1e-9) return false;
    return Math.abs(Math.round(value * 10) - value * 10) < 1e-6;
}

function boostOf(map, id) {
    if (!id || !map || typeof map !== 'object') return 1;
    const value = map[id];
    return isValidBoost(value) ? value : 1;
}

/**
 * The XP multiplier for one message.
 * channelId: where the message was sent. threadParentId: the parent channel when that is a
 * thread (forum posts too), else null; a thread uses its parent's boost.
 * roleIds: the member's role ids.
 * Returns { multiplier, channel, role, global, capped }.
 */
export function computeXpMultiplier(config, { channelId = null, threadParentId = null, roleIds = [] } = {}) {
    const cfg = config && typeof config === 'object' ? config : {};
    const channel = boostOf(cfg.channelMultipliers, threadParentId || channelId);
    let role = 1;
    for (const id of roleIds || []) role = Math.max(role, boostOf(cfg.roleMultipliers, id));
    const rawGlobal = Number(cfg.xpMultiplier);
    const global = Number.isFinite(rawGlobal) && rawGlobal > 1 ? rawGlobal : 1;
    const product = channel * role * global;
    const capped = product > TOTAL_MULTIPLIER_CAP;
    // Rounded so 1.1 x 1.1 is 1.21, not 1.2100000000000002.
    const multiplier = Math.round(Math.min(product, TOTAL_MULTIPLIER_CAP) * 10000) / 10000;
    return { multiplier, channel, role, global, capped };
}

/**
 * The boost a member gets in one place, for showing it (/rank): computeXpMultiplier's result
 * plus `roleId` (the role whose boost counts, the first one when several tie) and `channelId`
 * (the boosted channel: a thread's parent), or null when the total is not above x1.
 */
export function xpBoostBreakdown(config, { channelId = null, threadParentId = null, roleIds = [] } = {}) {
    const result = computeXpMultiplier(config, { channelId, threadParentId, roleIds });
    if (!(result.multiplier > 1)) return null;
    const roles = config && typeof config === 'object' ? config.roleMultipliers : null;
    const roleId = result.role > 1 ? (roleIds || []).find((id) => boostOf(roles, id) === result.role) || null : null;
    return { ...result, roleId, channelId: result.channel > 1 ? (threadParentId || channelId) : null };
}

/** XP after the multiplier, rounded down (as before). Never less than the base amount. */
export function applyXpMultiplier(baseXp, multiplier) {
    const base = Math.max(0, Math.floor(Number(baseXp) || 0));
    const m = Number.isFinite(multiplier) && multiplier > 1 ? multiplier : 1;
    return Math.max(base, Math.floor(base * m + 1e-9));
}

export function rewardModeOf(config) {
    return config?.rewardMode === 'highest' ? 'highest' : 'keep';
}

/** [[level, roleId], ...] sorted by level, invalid entries left out. */
export function sortedRewards(roleRewards) {
    return Object.entries(roleRewards || {})
        .map(([level, roleId]) => [Number(level), roleId])
        .filter(([level, roleId]) => Number.isInteger(level) && level >= 1 && typeof roleId === 'string' && roleId)
        .sort((a, b) => a[0] - b[0]);
}

/**
 * Which reward roles to add and remove so a member at `level` holds what the mode says.
 * keep: every earned reward role. highest: only the reward role of the highest earned level,
 * lower reward roles are removed. removeUnearned (an admin changed the level by hand): reward
 * roles above the level are removed too. A role used for several levels is never removed
 * while one of its levels still wants it.
 * Returns { add: roleId[], remove: roleId[], want: roleId[] }.
 */
export function planRewardRoles({ roleRewards, level, mode = 'keep', heldRoleIds = [], removeUnearned = false }) {
    const rewards = sortedRewards(roleRewards);
    const lvl = Number.isFinite(level) ? level : 0;
    const earned = rewards.filter(([l]) => l <= lvl);
    const unearned = rewards.filter(([l]) => l > lvl);
    const held = new Set(heldRoleIds);

    const want = new Set(mode === 'highest'
        ? (earned.length ? [earned[earned.length - 1][1]] : [])
        : earned.map(([, id]) => id));

    const removable = new Set();
    if (mode === 'highest') for (const [, id] of earned) removable.add(id);
    if (removeUnearned) for (const [, id] of unearned) removable.add(id);

    return {
        add: [...want].filter((id) => !held.has(id)),
        remove: [...removable].filter((id) => !want.has(id) && held.has(id)),
        want: [...want],
    };
}
