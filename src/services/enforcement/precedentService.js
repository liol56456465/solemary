// precedentService.js — the consistency hints on the panel's and the dashboard's
// confirm step: how the newest cases with the same prebuilt reason were handled in
// this server (last 180 days, at most 200 cases), and where the target stands on
// the warn ladder.
//
//   Similar cases (reason "Spam", last 180 days, 23 cases): 15 warns · 5 mutes ·
//   2 kicks · 1 ban. Most common: warn. 2 overturned on appeal.
//   This member: 1 of 3 counted warnings, ladder level 0.
//
// One aggregate query per guild + reason, cached for a few minutes. The callers wait
// at most PRECEDENT_TIMEOUT_MS and show "unavailable right now" on a timeout or an
// error, so a hint never blocks or breaks an action.

import { logger } from '../../utils/logger.js';
import { query, T } from './db.js';
import { CUSTOM_REASON_KEY, enforcementConfig } from '../../config/enforcement.js';
import { formatDuration } from './format.js';

export const PRECEDENT_DAYS = 180;
export const PRECEDENT_MAX_CASES = 200;
export const PRECEDENT_CACHE_MS = 5 * 60 * 1000;
export const PRECEDENT_TIMEOUT_MS = 1500;
export const CUSTOM_REASON_HINT = 'Custom reason: no comparison.';
export const PRECEDENT_UNAVAILABLE = 'Similar cases: unavailable right now.';
export const MEMBER_UNAVAILABLE = 'This member: ladder unavailable right now.';
const MAX_CACHE_ENTRIES = 200;

const cache = new Map(); // guildId:reasonKey → { at, promise }

/** Display order (lightest first); also breaks ties for "most common". */
const TYPES = ['warn', 'mute', 'kick', 'ban'];
const PLURAL = { warn: 'warns', mute: 'mutes', kick: 'kicks', ban: 'bans' };

/**
 * Rows: { type, duration_ms, count, overturned }, over the newest `limit` human cases
 * (no /test simulations, no voided cases, no imported legacy warns) with this reason
 * key in the window. One query: the newest rows in a subquery, grouped outside it.
 */
export async function loadPrecedent(guildId, reasonKey, { days = PRECEDENT_DAYS, limit = PRECEDENT_MAX_CASES, run = query } = {}) {
    const { rows } = await run(
        `SELECT recent.type, recent.duration_ms, COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE recent.overturned)::int AS overturned
         FROM (
             SELECT c.type, c.duration_ms, EXISTS (
                        SELECT 1 FROM ${T.appeals} a
                        WHERE a.case_code = c.case_code AND a.kind = 'appeal' AND a.status = 'accepted'
                    ) AS overturned
             FROM ${T.cases} c
             WHERE c.guild_id = $1 AND c.reason_key = $2 AND c.created_at >= NOW() - make_interval(days => $3)
               AND c.is_test = FALSE AND c.voided_at IS NULL AND c.is_imported = FALSE
             ORDER BY c.created_at DESC, c.id DESC
             LIMIT $4
         ) recent
         GROUP BY recent.type, recent.duration_ms`,
        [guildId, reasonKey, days, limit]
    );
    return rows.map((row) => ({
        type: row.type,
        duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
        count: Number(row.count) || 0,
        overturned: Number(row.overturned) || 0,
    }));
}

/** The usual length of the most common mute/ban, e.g. "1 hour" or "permanent"; else null. */
function usualLength(rows, type) {
    if (type !== 'mute' && type !== 'ban') return null;
    const top = rows.filter((row) => row.type === type)
        .sort((a, b) => b.count - a.count || (a.duration_ms ?? Infinity) - (b.duration_ms ?? Infinity))[0];
    if (!top) return null;
    return top.duration_ms == null ? 'permanent' : formatDuration(top.duration_ms);
}

/** The "similar cases" line from aggregate rows; pure. */
export function formatPrecedent(reasonLabel, rows, { days = PRECEDENT_DAYS, limit = PRECEDENT_MAX_CASES } = {}) {
    const byType = new Map(TYPES.map((type) => [type, 0]));
    for (const row of rows) byType.set(row.type, (byType.get(row.type) || 0) + row.count);
    const total = [...byType.values()].reduce((sum, n) => sum + n, 0);
    const scope = `reason "${reasonLabel}", last ${days} days`;
    if (!total) return `Similar cases (${scope}): No similar cases yet.`;

    const counts = [...byType].filter(([, n]) => n > 0);
    const parts = counts.map(([type, n]) => `${n} ${n === 1 ? type : (PLURAL[type] || `${type}s`)}`);
    // Ties go to the lighter action (TYPES order; Map keeps it, sort is stable).
    const [topType] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const length = usualLength(rows, topType);
    const overturned = rows.reduce((sum, row) => sum + row.overturned, 0);
    const casesText = total >= limit ? `newest ${limit} cases` : `${total} case${total === 1 ? '' : 's'}`;
    return `Similar cases (${scope}, ${casesText}): ${parts.join(' · ')}. `
        + `Most common: ${topType}${length ? `, usually ${length}` : ''}.`
        + `${overturned ? ` ${overturned} overturned on appeal.` : ''}`;
}

function cached(guildId, reasonKey) {
    const key = `${guildId}:${reasonKey}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < PRECEDENT_CACHE_MS) return hit.promise;
    const promise = loadPrecedent(guildId, reasonKey);
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    return promise;
}

/** Resolves to the promise's value, or rejects with a timeout after `ms`. */
export async function withTimeout(promise, ms) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The "similar cases" line for a reason: null without a reason key (lift actions),
 * CUSTOM_REASON_HINT for a custom reason, PRECEDENT_UNAVAILABLE on a slow database or
 * an error. Never throws and never waits longer than timeoutMs. `load` is for tests.
 */
export async function precedentHint(guildId, reasonKey, reasonLabel, { timeoutMs = PRECEDENT_TIMEOUT_MS, load = cached } = {}) {
    if (!reasonKey) return null;
    if (reasonKey === CUSTOM_REASON_KEY) return CUSTOM_REASON_HINT;
    try {
        const rows = await withTimeout(Promise.resolve().then(() => load(guildId, reasonKey)), timeoutMs);
        return formatPrecedent(reasonLabel, rows);
    } catch (error) {
        logger.warn(`Precedent hint failed for ${reasonKey}: ${error.message}`);
        return PRECEDENT_UNAVAILABLE;
    }
}

/** Starts (or reuses) the cached query without waiting, so the confirm step finds it ready. */
export function warmPrecedent(guildId, reasonKey) {
    if (!reasonKey || reasonKey === CUSTOM_REASON_KEY) return;
    try {
        cached(guildId, reasonKey).catch(() => {});
    } catch {
        // A warm-up is best effort only.
    }
}

/** "This member: 1 of 3 counted warnings, ladder level 0." from a ladder row; pure. */
export function memberLadderLine(ladder) {
    const level = Number(ladder?.level) || 0;
    const warns = Number(ladder?.warns_since_level) || 0;
    if (level === 0) {
        return `This member: ${warns} of ${enforcementConfig.warnsPerLevel} counted warning${enforcementConfig.warnsPerLevel === 1 ? '' : 's'}, ladder level 0.`;
    }
    return `This member: ${warns} counted warning${warns === 1 ? '' : 's'}, ladder level ${level} (the next warning bans).`;
}

/**
 * The target's ladder line. Uses `ladder` when the caller already has it; otherwise
 * loads it with getLadder, waiting at most timeoutMs. Never throws.
 */
export async function memberLadderHint(guildId, userId, { ladder = null, getLadder, timeoutMs = PRECEDENT_TIMEOUT_MS } = {}) {
    if (ladder) return memberLadderLine(ladder);
    try {
        return memberLadderLine(await withTimeout(Promise.resolve().then(() => getLadder(guildId, userId)), timeoutMs));
    } catch (error) {
        logger.warn(`Member ladder hint failed: ${error.message}`);
        return MEMBER_UNAVAILABLE;
    }
}

export function clearPrecedentCache() {
    cache.clear();
}
