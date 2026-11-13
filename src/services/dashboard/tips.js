// tips.js — short how-to boxes on dashboard pages that a user can hide for good ("Don't show
// again"), per dashboard user (key-value, no table). "Close" only hides it on the page (static script).
// Tips: logForum (Logging page, Advanced logs).

import { getFromDb, setInDb } from '../../utils/database.js';

export const TIPS = Object.freeze(['logForum']);
const tipsKey = (userId) => `dashboard:tips:${userId}`;

/** Whether this user hid the tip for good. Throws on a database error (the caller decides). */
export async function isTipHidden(userId, tip) {
    if (!userId || !TIPS.includes(tip)) return false;
    const stored = await getFromDb(tipsKey(userId), null);
    return Array.isArray(stored?.hidden) && stored.hidden.includes(tip);
}

/** Hides the tip for this user for good. Resolves true, or throws (nothing saved). */
export async function hideTip(userId, tip) {
    if (!userId || !TIPS.includes(tip)) throw new Error(`Unknown tip: ${tip}`);
    const stored = await getFromDb(tipsKey(userId), null);
    const hidden = new Set(Array.isArray(stored?.hidden) ? stored.hidden.filter((t) => TIPS.includes(t)) : []);
    hidden.add(tip);
    const ok = await setInDb(tipsKey(userId), { hidden: [...hidden] });
    if (ok === false) throw new Error('The tip setting could not be saved');
    return true;
}
