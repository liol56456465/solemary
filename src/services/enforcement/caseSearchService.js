// caseSearchService.js — /case search: filtered, paged lists of mod_cases.
//
// Filters (all optional): member, moderator, type, reason key, status, date
// range (YYYY-MM-DD, UTC, both ends inclusive) and free text (ILIKE on name and
// reason). Paging is offset-based, newest first. The filter set travels with the
// result message (encodeSearchFilters → embed footer), so the Older/Newer buttons
// need no server-side state and keep working after a restart.

import { query, T } from './db.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';

export const SEARCH_PAGE_SIZE = 10;
export const SEARCH_TYPES = ['ban', 'kick', 'mute', 'warn'];
export const SEARCH_STATUSES = ['active', 'ended', 'revoked', 'voided'];
export const SEARCH_TEXT_MAX = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const SNOWFLAKE = /^\d{17,20}$/;
const REASON_KEY = /^[a-z0-9_]{1,50}$/;

function userError(message) {
    return createError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** "2026-10-27" → Date at 00:00 UTC; throws a user error on anything else. */
export function parseSearchDate(input, label = 'date') {
    const text = String(input || '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    if (!date || date.toISOString().slice(0, 10) !== text) {
        throw userError(`\`${text.slice(0, 20)}\` is not a valid ${label}. Use YYYY-MM-DD, e.g. 2026-10-27.`);
    }
    return date;
}

/**
 * Validates raw option values into a filter object (unset filters are omitted).
 * raw: { memberId, moderatorId, type, reasonKey, status, from, to, text }.
 */
export function normalizeSearchFilters(raw = {}) {
    const filters = {};
    if (raw.memberId) {
        if (!SNOWFLAKE.test(raw.memberId)) throw userError('member must be a Discord user.');
        filters.memberId = raw.memberId;
    }
    if (raw.moderatorId) {
        if (!SNOWFLAKE.test(raw.moderatorId)) throw userError('moderator must be a Discord user.');
        filters.moderatorId = raw.moderatorId;
    }
    if (raw.type) {
        if (!SEARCH_TYPES.includes(raw.type)) throw userError(`type must be one of ${SEARCH_TYPES.join(', ')}.`);
        filters.type = raw.type;
    }
    if (raw.reasonKey) {
        const key = String(raw.reasonKey).trim().toLowerCase();
        if (!REASON_KEY.test(key)) throw userError('Pick a reason key from the list.');
        filters.reasonKey = key;
    }
    if (raw.status) {
        if (!SEARCH_STATUSES.includes(raw.status)) throw userError(`status must be one of ${SEARCH_STATUSES.join(', ')}.`);
        filters.status = raw.status;
    }
    if (raw.from) filters.from = parseSearchDate(raw.from, 'from date').toISOString().slice(0, 10);
    if (raw.to) filters.to = parseSearchDate(raw.to, 'to date').toISOString().slice(0, 10);
    if (filters.from && filters.to && filters.from > filters.to) {
        throw userError('The from date is after the to date.');
    }
    const text = String(raw.text || '').trim();
    if (text) filters.text = text.slice(0, SEARCH_TEXT_MAX);
    return filters;
}

const KEYS = { memberId: 'm', moderatorId: 'o', type: 't', reasonKey: 'r', status: 's', from: 'f', to: 'u', text: 'x' };
const FROM_KEYS = Object.fromEntries(Object.entries(KEYS).map(([long, short]) => [short, long]));

/** Compact, URL-safe encoding of a filter object (for the result message). */
export function encodeSearchFilters(filters) {
    const short = {};
    for (const [key, value] of Object.entries(filters)) {
        if (KEYS[key] && value) short[KEYS[key]] = value;
    }
    return Buffer.from(JSON.stringify(short), 'utf8').toString('base64url');
}

/** Inverse of encodeSearchFilters; re-validated. Returns null when it can't be read. */
export function decodeSearchFilters(token) {
    try {
        const short = JSON.parse(Buffer.from(String(token || ''), 'base64url').toString('utf8'));
        if (!short || typeof short !== 'object' || Array.isArray(short)) return null;
        const raw = {};
        for (const [key, value] of Object.entries(short)) {
            if (FROM_KEYS[key] && typeof value === 'string') raw[FROM_KEYS[key]] = value;
        }
        return normalizeSearchFilters(raw);
    } catch {
        return null;
    }
}

function escapeLike(text) {
    return String(text).replace(/[%_\\]/g, (c) => `\\${c}`);
}

/**
 * The WHERE clause and parameters for a filter set. Status:
 *   active  open (active / appeal pending), not voided, not past its end
 *   ended   expired, or still marked active but past its end
 *   revoked lifted early (unban/unmute, accepted appeal, removed warn), not voided
 *   voided  marked as a mistake with /case void
 */
export function buildSearchWhere(guildId, filters = {}, now = new Date()) {
    const params = [guildId];
    const where = ['guild_id = $1'];
    const add = (sql, value) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
    };
    if (filters.memberId) add('target_user_id = ?', filters.memberId);
    if (filters.moderatorId) add('moderator_id = ?', filters.moderatorId);
    if (filters.type) add('type = ?', filters.type);
    if (filters.reasonKey) add('reason_key = ?', filters.reasonKey);
    if (filters.from) add('created_at >= ?', `${filters.from}T00:00:00Z`);
    if (filters.to) add('created_at < ?', new Date(Date.parse(`${filters.to}T00:00:00Z`) + DAY_MS).toISOString());
    if (filters.text) {
        params.push(`%${escapeLike(filters.text)}%`);
        where.push(`(name ILIKE $${params.length} OR reason ILIKE $${params.length})`);
    }
    if (filters.status === 'revoked') where.push(`status = 'revoked' AND voided_at IS NULL`);
    if (filters.status === 'voided') where.push('voided_at IS NOT NULL');
    if (filters.status === 'active' || filters.status === 'ended') {
        params.push(now.toISOString());
        const n = `$${params.length}`;
        where.push(filters.status === 'active'
            ? `status IN ('active', 'appeal_pending') AND voided_at IS NULL AND (expires_at IS NULL OR expires_at > ${n})`
            : `voided_at IS NULL AND (status = 'expired' OR (status IN ('active', 'appeal_pending') AND expires_at <= ${n}))`);
    }
    return { where: where.join(' AND '), params };
}

/** One page of matching cases, newest first: { rows, total }. */
export async function searchCaseRecords(guildId, filters, { page = 0, pageSize = SEARCH_PAGE_SIZE } = {}) {
    const { where, params } = buildSearchWhere(guildId, filters);
    const { rows } = await query(
        `SELECT *, COUNT(*) OVER() AS total_count FROM ${T.cases}
         WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, Math.max(0, page) * pageSize]
    );
    let total = rows.length ? Number(rows[0].total_count) : 0;
    if (!rows.length && page > 0) {
        // Past the last page (cases were voided or removed meanwhile): count separately.
        const { rows: [count] } = await query(`SELECT COUNT(*)::int AS count FROM ${T.cases} WHERE ${where}`, params);
        total = count?.count || 0;
    }
    return { rows, total };
}

/** Distinct reason keys used in this guild, for autocomplete. */
export async function listReasonKeys(guildId, prefix = '', limit = 25) {
    const { rows } = await query(
        `SELECT reason_key, COUNT(*)::int AS count FROM ${T.cases}
         WHERE guild_id = $1 AND reason_key IS NOT NULL AND reason_key ILIKE $2
         GROUP BY reason_key ORDER BY count DESC, reason_key LIMIT $3`,
        [guildId, `%${escapeLike(prefix)}%`, limit]
    );
    return rows;
}
