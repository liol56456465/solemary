// caseExport.js: Cases → Download CSV, a paid perk that follows the server owner's plan
// (premiumEffects.guildPlan): Normal = the last 90 days, Pro and Max = the full history,
// Free = none. /test cases are left out. Cells that a spreadsheet would run as a formula
// (=, +, -, @ at the start) get a leading apostrophe.

import { pgConfig } from '../../config/database/postgres.js';
import { query as defaultQuery } from './db.js';

export const EXPORT_MAX_ROWS = 50000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a plan may export: null (nothing), 90 (days) or Infinity (everything). */
export function exportWindowDays(planId) {
    if (planId === 'normal') return 90;
    if (planId === 'pro' || planId === 'max') return Infinity;
    return null;
}

/** One CSV cell: quoted, quotes doubled, formula starts neutralised. */
export function csvCell(value) {
    if (value === null || value === undefined) return '';
    let text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(' ') : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

export const CSV_COLUMNS = ['case_code', 'created_at', 'type', 'member_id', 'member', 'moderator', 'automatic', 'reason', 'reason_key', 'duration_ms', 'expires_at', 'status', 'voided_at', 'tags'];

export function casesCsv(rows) {
    const lines = [CSV_COLUMNS.join(',')];
    for (const r of rows) {
        lines.push([r.case_code, r.created_at, r.type, r.target_user_id, r.target_username, r.moderator_username, r.is_auto ? 'yes' : 'no',
            r.reason, r.reason_key, r.duration_ms, r.expires_at, r.status, r.voided_at, r.tags].map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
}

/** The rows a plan may export, newest first. Throws on a database error. */
export async function exportCases(guildId, planId, { query = defaultQuery, now = Date.now() } = {}) {
    const days = exportWindowDays(planId);
    if (days === null) return null;
    const t = pgConfig.tables.mod_cases;
    const since = Number.isFinite(days) ? new Date(now - days * DAY_MS) : new Date(0);
    const { rows } = await query(
        `SELECT case_code, created_at, type, target_user_id, target_username, moderator_username, is_auto, reason, reason_key,
                duration_ms, expires_at, status, voided_at, tags
         FROM ${t} WHERE guild_id = $1 AND is_test IS NOT TRUE AND created_at >= $2 ORDER BY created_at DESC LIMIT ${EXPORT_MAX_ROWS}`,
        [guildId, since],
    );
    return rows;
}
