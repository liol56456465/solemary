// precedentService.js — the "similar cases" hint on the panel's confirm step:
// how cases with the same prebuilt reason were handled in the last 180 days,
// and how many of them were overturned on appeal.
//
//   Similar cases (reason "Spam", last 180 days): 14 — usually Mute 1 hour (9),
//   Warn (4); 2 overturned on appeal.
//
// One aggregate query per guild + reason, cached for a few minutes. The panel
// waits at most PRECEDENT_TIMEOUT_MS for it and shows nothing on a timeout or error,
// so the hint never blocks or breaks an action.

import { logger } from '../../utils/logger.js';
import { query, T } from './db.js';
import { CUSTOM_REASON_KEY } from '../../config/enforcement.js';
import { formatDuration } from './format.js';

export const PRECEDENT_DAYS = 180;
export const PRECEDENT_CACHE_MS = 5 * 60 * 1000;
export const PRECEDENT_TIMEOUT_MS = 1500;
const MAX_CACHE_ENTRIES = 200;

const cache = new Map(); // guildId:reasonKey → { at, promise }

const TYPE_LABEL = { ban: 'Ban', kick: 'Kick', mute: 'Mute', warn: 'Warn' };

/** Rows: { type, duration_ms, count, overturned }. Human cases only (no tests, no voided). */
export async function loadPrecedent(guildId, reasonKey, days = PRECEDENT_DAYS) {
    const { rows } = await query(
        `SELECT c.type, c.duration_ms, COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM ${T.appeals} a
                    WHERE a.case_code = c.case_code AND a.kind = 'appeal' AND a.status = 'accepted'
                ))::int AS overturned
         FROM ${T.cases} c
         WHERE c.guild_id = $1 AND c.reason_key = $2 AND c.created_at >= NOW() - make_interval(days => $3)
           AND c.is_test = FALSE AND c.voided_at IS NULL AND c.is_imported = FALSE
         GROUP BY c.type, c.duration_ms`,
        [guildId, reasonKey, days]
    );
    return rows.map((row) => ({ ...row, duration_ms: row.duration_ms == null ? null : Number(row.duration_ms) }));
}

function bucketLabel(row) {
    const label = TYPE_LABEL[row.type] || row.type;
    if (row.type === 'mute') return `${label} ${formatDuration(row.duration_ms)}`;
    if (row.type === 'ban') return row.duration_ms == null ? `${label} (permanent)` : `${label} ${formatDuration(row.duration_ms)}`;
    return label;
}

/** The hint text from aggregate rows; pure. */
export function formatPrecedent(reasonLabel, rows, days = PRECEDENT_DAYS) {
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const head = `Similar cases (reason "${reasonLabel}", last ${days} days)`;
    if (!total) return `${head}: none yet.`;
    const top = [...rows]
        .sort((a, b) => b.count - a.count || bucketLabel(a).localeCompare(bucketLabel(b)))
        .slice(0, 3)
        .map((row) => `${bucketLabel(row)} (${row.count})`);
    const overturned = rows.reduce((sum, row) => sum + row.overturned, 0);
    return `${head}: ${total} — usually ${top.join(', ')}; ${overturned ? `${overturned} overturned on appeal` : 'none overturned on appeal'}.`;
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

/**
 * The hint for the confirm step, or null (custom reason, slow database, error).
 * Never throws and never waits longer than timeoutMs.
 */
export async function precedentHint(guildId, reasonKey, reasonLabel, { timeoutMs = PRECEDENT_TIMEOUT_MS } = {}) {
    if (!reasonKey || reasonKey === CUSTOM_REASON_KEY) return null;
    let timer;
    try {
        const rows = await Promise.race([
            cached(guildId, reasonKey),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
        return rows ? formatPrecedent(reasonLabel, rows) : null;
    } catch (error) {
        logger.warn(`Precedent hint failed for ${reasonKey}: ${error.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export function clearPrecedentCache() {
    cache.clear();
}
