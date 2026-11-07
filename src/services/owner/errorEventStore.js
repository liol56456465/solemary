// errorEventStore.js — the error_events table (schema v11): written by utils/errorEvents.js,
// read by the dashboard's Owner → Recent errors page (dashboard/ownerErrors.js).
//
// Data-layer rules: the insert succeeds or throws (the recorder swallows it and warns); the read
// throws on a database error, so the page shows "database not responding", never an empty list.

import { pgConfig } from '../../config/database/postgres.js';
import { query as defaultQuery } from '../enforcement/db.js';
import { KEEP_ROWS } from '../../utils/errorEvents.js';

const TABLE = pgConfig.tables.error_events;
export const GROUP_LIMIT = 50;

/** Inserts one row (errorEventRow shape), then keeps only the newest `keep` rows. */
export async function insertErrorEvent(row, { query = defaultQuery, keep = KEEP_ROWS } = {}) {
    await query(
        `INSERT INTO ${TABLE} (error_code, error_type, source, guild_id, trace_id, message) VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.error_code, row.error_type, row.source, row.guild_id, row.trace_id, row.message],
    );
    await query(
        `DELETE FROM ${TABLE} WHERE id < (SELECT id FROM ${TABLE} ORDER BY id DESC OFFSET $1 LIMIT 1)`,
        [Math.max(0, keep - 1)],
    );
}

/**
 * A search box value → { trace, code }: a pasted Ref ("COMMAND_ERROR · int_ab12"), a trace
 * ("int_ab12", any start of it; hex after the "_", so TASK_ERROR stays a code) or an error code. Anything else is ignored (both null).
 */
export function parseErrorSearch(value) {
    const out = { trace: null, code: null };
    for (const token of String(value ?? '').slice(0, 100).split(/[\s·`|,]+/).filter(Boolean)) {
        if (/^[a-z]{2,5}_[0-9a-f]{0,32}$/i.test(token)) out.trace = token.toLowerCase().slice(0, 8);
        else if (/^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(token)) out.code = token.toUpperCase();
    }
    return out;
}

/**
 * The page's groups: rows grouped by error code + source, newest first, at most 50, each with
 * count, last seen, how many servers, and the newest row's trace, server, type and message.
 * `total` = rows kept. Throws on a database error.
 */
export async function listErrorGroups({ trace = null, code = null } = {}, { query = defaultQuery, limit = GROUP_LIMIT } = {}) {
    const params = [];
    const where = [];
    if (trace) { params.push(trace); where.push(`left(trace_id, length($${params.length})) = $${params.length}`); }
    if (code) { params.push(code); where.push(`error_code = $${params.length}`); }
    params.push(limit);
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const groups = await query(
        `SELECT error_code, source, COUNT(*)::int AS count, MAX(created_at) AS last_seen,
                COUNT(DISTINCT guild_id)::int AS servers,
                (array_agg(error_type ORDER BY id DESC))[1] AS error_type,
                (array_agg(trace_id ORDER BY id DESC) FILTER (WHERE trace_id IS NOT NULL))[1] AS sample_trace,
                (array_agg(guild_id ORDER BY id DESC))[1] AS guild_id,
                (array_agg(message ORDER BY id DESC))[1] AS message
           FROM ${TABLE} ${filter}
          GROUP BY error_code, source
          ORDER BY MAX(id) DESC
          LIMIT $${params.length}`,
        params,
    );
    const total = await query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
    return { groups: groups.rows, total: Number(total.rows[0]?.n ?? 0) };
}

export const errorEventStore = { list: (filter) => listErrorGroups(filter) };
