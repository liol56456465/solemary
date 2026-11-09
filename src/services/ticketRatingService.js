// ticketRatingService.js — ticket and modmail ratings (schema v14, table ticket_ratings;
// docs/features-v14.md section 3). The table is the single source of truth:
//
// - At close a "pending" row is written (createPendingRating) with the handling staff member:
//   the claimer at close, else the closer (modmail: the closer). A re-close after a reopen
//   refreshes the pending row only while it is not rated yet; a rated ticket keeps its rating.
// - A star click is ONE atomic UPDATE (submitRating): opener only, not rated yet, window open.
//   Two clicks at once: exactly one succeeds (the second sees rating IS NOT NULL).
// - A comment (submitComment): once, only after the stars, inside the window, max 1000
//   characters, run through the automod word/insult filters (flagged, never blocked).
// - Old surveys sent before this table existed: the buttons are the same, so a click on one
//   finds no row; materializeLegacyRating copies that ticket's JSONB (ticket_data) into a row
//   first. backfillLegacyRatings copies every old rated ticket once (idempotent, at startup).
//
// Reads throw on a database error (never a default); a write that changes nothing returns a
// reason, never a fake success. Discord side effects live in ticketRatingEffects.js.

import { pgConfig } from '../config/database/postgres.js';
import { query as dbQuery } from './enforcement/db.js';
import { sanitizeInput } from '../utils/validation.js';
import { logger } from '../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ID = /^\d{17,20}$/;
export const COMMENT_MAX = 1000;
export const WINDOW_DAYS_DEFAULT = 7;
export const WINDOW_DAYS_MIN = 1;
export const WINDOW_DAYS_MAX = 30;
export const LOW_RATING_MAX = 2;
/** Retention (privacy/retentionService.js): comments, rows, never-rated rows after their window. */
export const RATING_RETENTION_DAYS = Object.freeze({ comments: 180, rows: 730, unrated: 30 });

const table = (tables = pgConfig.tables) => tables.ticket_ratings;
/** The visible ticket number ("012") or null: never the channel id. */
const numberOrNull = (value) => (/^\d{1,10}$/.test(String(value ?? '')) ? String(value) : null);

/** The rating settings of a server from its guild config (ticketSettingsService keys), with the defaults. */
export function ratingSettings(config = {}) {
    const days = Number(config?.ticketRatingWindowDays);
    return {
        ticketsEnabled: config?.ticketRatingsEnabled !== false,
        modmailEnabled: config?.modmailRatingsEnabled === true,
        windowDays: Number.isInteger(days) && days >= WINDOW_DAYS_MIN && days <= WINDOW_DAYS_MAX ? days : WINDOW_DAYS_DEFAULT,
        lowRatingAlert: config?.ticketLowRatingAlert !== false,
    };
}

/**
 * Who handled a ticket: the claimer at close, else the closer. Never the opener (an opener may
 * close their own unclaimed ticket: then nobody handled it, null).
 */
export function handlingStaffId(ticketData, closerId) {
    const opener = String(ticketData?.userId ?? '');
    const claimed = ticketData?.claimedBy && ID.test(String(ticketData.claimedBy)) ? String(ticketData.claimedBy) : null;
    const staff = claimed || (closerId ? String(closerId) : null);
    return staff && staff !== opener ? staff : null;
}

/** "★★★★☆" for 1–5; '' otherwise. */
export function starsText(rating) {
    const n = Number(rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) return '';
    return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** "★4.6 (5)" for an average and a count; '' without ratings. */
export function ratingBadge(avg, count) {
    const n = Number(count) || 0;
    if (!n || avg === null || avg === undefined || !Number.isFinite(Number(avg))) return '';
    return `★${(Math.round(Number(avg) * 10) / 10).toFixed(1)} (${n})`;
}

/** The comment as stored: one line per paragraph kept as spaces, control characters removed, max 1000. */
export function cleanComment(text) {
    return sanitizeInput(String(text ?? '').replace(/\r?\n/g, ' '), COMMENT_MAX).trim();
}

/**
 * True when the automod word list or the insult list matches. Never throws: filters that can't
 * read the server's settings count as "not flagged" (the comment is only shown, never acted on).
 */
export async function isCommentFlagged(text, guildId, { filters } = {}) {
    try {
        const f = filters || await import('./automod/filters.js');
        return Boolean(f.findBlockedWord(text, guildId) || f.findInsult(text));
    } catch (error) {
        logger.warn(`Ticket rating comment filter skipped: ${error.message}`);
        return false;
    }
}

/**
 * The pending row at close. Returns the row, or null when this ticket is already rated (a
 * re-close after a reopen keeps the rating and sends no new survey). Throws on a database error.
 */
export async function createPendingRating({
    guildId, kind = 'ticket', refId, ticketNumber = null, openerId, staffId = null, closerId = null,
    priority = null, windowDays = WINDOW_DAYS_DEFAULT, now = Date.now(),
}, { query = dbQuery, tables } = {}) {
    if (!ID.test(String(guildId)) || !ID.test(String(refId)) || !ID.test(String(openerId))) {
        throw new Error('createPendingRating: bad ids');
    }
    if (kind !== 'ticket' && kind !== 'modmail') throw new Error('createPendingRating: bad kind');
    const t = table(tables);
    // The FK needs the server row (tickets have one already; modmail may not).
    await query(`INSERT INTO ${(tables || pgConfig.tables).guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [String(guildId)]);
    const promptedAt = new Date(now);
    const expiresAt = new Date(now + windowDays * DAY_MS);
    const { rows } = await query(
        `INSERT INTO ${t} (guild_id, kind, ref_id, ticket_number, opener_id, staff_id, closer_id, priority, prompted_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (guild_id, kind, ref_id) DO UPDATE SET
             ticket_number = EXCLUDED.ticket_number, opener_id = EXCLUDED.opener_id, staff_id = EXCLUDED.staff_id,
             closer_id = EXCLUDED.closer_id, priority = EXCLUDED.priority, prompted_at = EXCLUDED.prompted_at,
             expires_at = EXCLUDED.expires_at, delivery = NULL
         WHERE ${t}.rating IS NULL
         RETURNING *`,
        [String(guildId), kind, String(refId), numberOrNull(ticketNumber),
            String(openerId), staffId ? String(staffId) : null, closerId ? String(closerId) : null,
            priority ? String(priority).slice(0, 10) : null, promptedAt, expiresAt]);
    return rows[0] || null;
}

/** How the survey reached the opener: 'dm' | 'channel' | 'failed'. Throws on a database error. */
export async function setRatingDelivery(id, delivery, { query = dbQuery, tables } = {}) {
    if (!['dm', 'channel', 'failed'].includes(delivery)) throw new Error('setRatingDelivery: bad delivery');
    await query(`UPDATE ${table(tables)} SET delivery = $2 WHERE id = $1`, [id, delivery]);
}

/** The row of a ticket / modmail conversation (ticket and modmail channel ids never collide). */
export async function findRating(guildId, refId, { query = dbQuery, tables } = {}) {
    const { rows } = await query(
        `SELECT * FROM ${table(tables)} WHERE guild_id = $1 AND ref_id = $2 ORDER BY id LIMIT 1`,
        [String(guildId), String(refId)]);
    return rows[0] || null;
}

function refusalFor(row, userId, now) {
    if (!row) return 'missing';
    if (!row.opener_id || row.opener_id !== String(userId)) return 'notYours';
    if (row.rating !== null && row.rating !== undefined) return 'already';
    if (new Date(row.expires_at).getTime() <= now) return 'expired';
    return 'missing'; // changed between the two statements; treat as gone
}

/**
 * One atomic rating. Returns { ok: true, row } or { ok: false, reason, row } with reason
 * 'missing' | 'notYours' | 'already' | 'expired' | 'invalid'. Throws on a database error.
 */
export async function submitRating({ guildId, refId, userId, rating, now = Date.now() }, { query = dbQuery, tables } = {}) {
    const stars = Number(rating);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { ok: false, reason: 'invalid', row: null };
    const { rows } = await query(
        `UPDATE ${table(tables)} SET rating = $4, rated_at = $5
         WHERE guild_id = $1 AND ref_id = $2 AND opener_id = $3 AND rating IS NULL AND expires_at > $5
         RETURNING *`,
        [String(guildId), String(refId), String(userId), stars, new Date(now)]);
    if (rows[0]) return { ok: true, row: rows[0] };
    const row = await findRating(guildId, refId, { query, tables });
    return { ok: false, reason: refusalFor(row, userId, now), row };
}

/**
 * The comment: once, only after a rating, inside the window. Returns { ok, reason, row } with
 * reason 'missing' | 'notYours' | 'notRated' | 'already' | 'expired' | 'empty'. Throws on a database error.
 */
export async function submitComment({ guildId, refId, userId, comment, flagged = false, now = Date.now() }, { query = dbQuery, tables } = {}) {
    const text = cleanComment(comment);
    if (!text) return { ok: false, reason: 'empty', row: null };
    const { rows } = await query(
        `UPDATE ${table(tables)} SET comment = $4, comment_at = $5, comment_flagged = $6
         WHERE guild_id = $1 AND ref_id = $2 AND opener_id = $3 AND rating IS NOT NULL
           AND comment_at IS NULL AND expires_at > $5
         RETURNING *`,
        [String(guildId), String(refId), String(userId), text, new Date(now), Boolean(flagged)]);
    if (rows[0]) return { ok: true, row: rows[0] };
    const row = await findRating(guildId, refId, { query, tables });
    let reason;
    if (!row) reason = 'missing';
    else if (!row.opener_id || row.opener_id !== String(userId)) reason = 'notYours';
    else if (row.rating === null || row.rating === undefined) reason = new Date(row.expires_at).getTime() <= now ? 'expired' : 'notRated';
    else if (row.comment_at) reason = 'already';
    else if (new Date(row.expires_at).getTime() <= now) reason = 'expired';
    else reason = 'missing';
    return { ok: false, reason, row };
}

const isoOrNull = (value) => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms) : null;
};

/**
 * A click on a survey sent before ticket_ratings existed: copies the ticket's JSONB into a row
 * (an old rating as rated; else a pending row while the window since the close is still open).
 * Returns the row, or null when there is nothing to rate any more. Throws on a database error.
 */
export async function materializeLegacyRating(guildId, refId, ticketData, { windowDays = WINDOW_DAYS_DEFAULT, now = Date.now(), query = dbQuery, tables } = {}) {
    if (!ticketData || !ID.test(String(ticketData.userId || ''))) return null;
    const closedAt = isoOrNull(ticketData.closedAt);
    const legacyRating = Number(ticketData.feedback?.rating);
    const rated = Number.isInteger(legacyRating) && legacyRating >= 1 && legacyRating <= 5;
    const promptedAt = closedAt || isoOrNull(ticketData.feedback?.submittedAt) || new Date(now);
    const expiresAt = new Date(promptedAt.getTime() + windowDays * DAY_MS);
    if (!rated && expiresAt.getTime() <= now) return null;
    const ratedAt = rated ? (isoOrNull(ticketData.feedback?.submittedAt) || promptedAt) : null;
    // The retention rules hold for old data too: a rating past 2 years is gone, a comment past 180 days too.
    if (rated && ratedAt.getTime() < now - RATING_RETENTION_DAYS.rows * DAY_MS) return null;
    const commentAt = isoOrNull(ticketData.feedback?.commentSubmittedAt) || ratedAt;
    const commentKept = commentAt && commentAt.getTime() >= now - RATING_RETENTION_DAYS.comments * DAY_MS;
    const comment = rated && commentKept && ticketData.feedback?.comment ? cleanComment(ticketData.feedback.comment) || null : null;
    await query(
        `INSERT INTO ${table(tables)} (guild_id, kind, ref_id, ticket_number, opener_id, staff_id, closer_id, priority,
             prompted_at, expires_at, delivery, rating, rated_at, comment, comment_at)
         VALUES ($1, 'ticket', $2, $3, $4, $5, $6, $7, $8, $9, 'dm', $10, $11, $12, $13)
         ON CONFLICT (guild_id, kind, ref_id) DO NOTHING`,
        [String(guildId), String(refId), numberOrNull(ticketData.number), String(ticketData.userId),
            handlingStaffId(ticketData, ticketData.closedBy), ID.test(String(ticketData.closedBy || '')) ? String(ticketData.closedBy) : null,
            ticketData.priority ? String(ticketData.priority).slice(0, 10) : null, promptedAt, expiresAt,
            rated ? legacyRating : null, ratedAt, comment, comment ? commentAt : null]);
    return findRating(guildId, refId, { query, tables });
}

// A JSONB text → timestamptz only when it is a full ISO date-time (month 01–12, day 01–31, time
// 00:00–23:59): one bad value must not fail the whole statement. [A day the month does not have,
// e.g. 02-30, still would; the bot only ever wrote toISOString() values there.]
const ISO_SQL = "'^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$'";
const tsOf = (expr) => `CASE WHEN (${expr}) ~ ${ISO_SQL} THEN (${expr})::timestamptz END`;

/**
 * O4: every old rated ticket (ticket_data.data->feedback->rating 1–5) into ticket_ratings.
 * INSERT … SELECT … ON CONFLICT DO NOTHING: additive and idempotent (a second run adds nothing,
 * a row rated the new way is never touched). Staff = claimedBy else closedBy, never the opener.
 * The retention rules hold here too, so a restart never brings back what retention removed:
 * ratings older than 2 years are not copied, comments older than 180 days are copied without
 * the comment. Returns rows added.
 */
export async function backfillLegacyRatings({ query = dbQuery, tables = pgConfig.tables } = {}) {
    const closed = tsOf("d.data->>'closedAt'");
    const submitted = tsOf("d.data->'feedback'->>'submittedAt'");
    const commented = tsOf("d.data->'feedback'->>'commentSubmittedAt'");
    const idOrNull = (expr) => `CASE WHEN (${expr}) ~ '^\\d{17,20}$' THEN (${expr}) END`;
    const result = await query(
        `WITH src AS (
             SELECT d.guild_id, d.channel_id,
                    CASE WHEN (d.data->>'number') ~ '^\\d{1,10}$' THEN d.data->>'number' END AS ticket_number,
                    d.data->>'userId' AS opener_id,
                    NULLIF(COALESCE(${idOrNull("d.data->>'claimedBy'")}, ${idOrNull("d.data->>'closedBy'")}), d.data->>'userId') AS staff_id,
                    ${idOrNull("d.data->>'closedBy'")} AS closer_id, LEFT(d.data->>'priority', 10) AS priority,
                    COALESCE(${closed}, ${submitted}, d.created_at::timestamptz) AS prompted_at,
                    (d.data->'feedback'->>'rating')::smallint AS rating,
                    COALESCE(${submitted}, ${closed}, d.created_at::timestamptz) AS rated_at,
                    NULLIF(LEFT(d.data->'feedback'->>'comment', ${COMMENT_MAX}), '') AS comment,
                    COALESCE(${commented}, ${submitted}, ${closed}, d.created_at::timestamptz) AS comment_at
             FROM ${tables.tickets} d
             WHERE d.guild_id IS NOT NULL AND d.channel_id ~ '^\\d{17,20}$'
               AND (d.data->>'userId') ~ '^\\d{17,20}$'
               AND (d.data->'feedback'->>'rating') ~ '^[1-5]$'
               AND EXISTS (SELECT 1 FROM ${tables.guilds} g WHERE g.id = d.guild_id)
         )
         INSERT INTO ${tables.ticket_ratings} (guild_id, kind, ref_id, ticket_number, opener_id, staff_id, closer_id, priority,
             prompted_at, expires_at, delivery, rating, rated_at, comment, comment_at)
         SELECT guild_id, 'ticket', channel_id, ticket_number, opener_id, staff_id, closer_id, priority,
                prompted_at, prompted_at + INTERVAL '${WINDOW_DAYS_DEFAULT} days', 'dm', rating, rated_at,
                CASE WHEN comment_at >= NOW() - INTERVAL '${RATING_RETENTION_DAYS.comments} days' THEN comment END,
                CASE WHEN comment IS NOT NULL AND comment_at >= NOW() - INTERVAL '${RATING_RETENTION_DAYS.comments} days' THEN comment_at END
         FROM src
         WHERE rated_at >= NOW() - INTERVAL '${RATING_RETENTION_DAYS.rows} days'
         ON CONFLICT (guild_id, kind, ref_id) DO NOTHING`);
    return result?.rowCount || 0;
}

const EMBED_FIELD_MAX = 1024;

/** A comment for a staff embed field: a flagged one inside a spoiler (pipes escaped), max 1024. */
export function commentFieldValue(comment, flagged) {
    const text = String(comment ?? '');
    if (!flagged) return text.slice(0, EMBED_FIELD_MAX) || '-';
    let inner = text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').slice(0, EMBED_FIELD_MAX - 4);
    // A cut in the middle of an escape would open the closing spoiler.
    const trailing = inner.match(/\\+$/);
    if (trailing && trailing[0].length % 2 === 1) inner = inner.slice(0, -1);
    return `||${inner}||`;
}

/** The field name of a comment: "Comment" or "Comment (flagged)". */
export const commentFieldName = (flagged) => (flagged ? 'Comment (flagged)' : 'Comment');

// ── stats (all: rated rows only; throw on a database error) ─────────────────

const avgOf = (value) => (value === null || value === undefined ? null : Math.round(Number(value) * 100) / 100);

/** Per staff member: [{ staffId, avg, count }] (rated in the period; since null = all time). */
export async function ratingsByStaff(guildId, { since = null, until = null, staffId = null } = {}, { query = dbQuery, tables } = {}) {
    const { rows } = await query(
        `SELECT staff_id, AVG(rating)::float AS avg, COUNT(*)::int AS count FROM ${table(tables)}
         WHERE guild_id = $1 AND rating IS NOT NULL AND staff_id IS NOT NULL
           AND ($2::timestamptz IS NULL OR rated_at >= $2) AND ($3::timestamptz IS NULL OR rated_at < $3)
           AND ($4::varchar IS NULL OR staff_id = $4)
         GROUP BY staff_id ORDER BY COUNT(*) DESC, staff_id LIMIT 200`,
        [String(guildId), since, until, staffId]);
    return rows.map((r) => ({ staffId: r.staff_id, avg: avgOf(r.avg), count: r.count }));
}

/** Per kind and priority: [{ kind, priority, avg, count }]. */
export async function ratingsByPriority(guildId, { since = null } = {}, { query = dbQuery, tables } = {}) {
    const { rows } = await query(
        `SELECT kind, COALESCE(priority, 'none') AS priority, AVG(rating)::float AS avg, COUNT(*)::int AS count FROM ${table(tables)}
         WHERE guild_id = $1 AND rating IS NOT NULL AND ($2::timestamptz IS NULL OR rated_at >= $2)
         GROUP BY kind, COALESCE(priority, 'none') ORDER BY kind, priority`,
        [String(guildId), since]);
    return rows.map((r) => ({ kind: r.kind, priority: r.priority, avg: avgOf(r.avg), count: r.count }));
}

/** Monday 00:00 UTC of the week of `ms`. */
function weekStartMs(ms) {
    const d = new Date(ms);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
}

/** The last `weeks` weeks (Monday UTC), oldest first: [{ week: 'YYYY-MM-DD', avg, count }]; empty weeks count 0. */
export async function weeklyRatingTrend(guildId, { weeks = 8, now = Date.now() } = {}, { query = dbQuery, tables } = {}) {
    const first = weekStartMs(now) - (weeks - 1) * 7 * DAY_MS;
    const { rows } = await query(
        `SELECT FLOOR(EXTRACT(EPOCH FROM (rated_at - $2::timestamptz)) / 604800)::int AS bucket,
                AVG(rating)::float AS avg, COUNT(*)::int AS count
         FROM ${table(tables)} WHERE guild_id = $1 AND rating IS NOT NULL AND rated_at >= $2
         GROUP BY bucket`,
        [String(guildId), new Date(first)]);
    const byBucket = new Map(rows.map((r) => [Number(r.bucket), r]));
    return Array.from({ length: weeks }, (_, i) => {
        const r = byBucket.get(i);
        return { week: new Date(first + i * 7 * DAY_MS).toISOString().slice(0, 10), avg: r ? avgOf(r.avg) : null, count: r ? r.count : 0 };
    });
}

/**
 * Of the surveys sent in the period whose answer is in (rated, or window over): how many were
 * rated. { prompted, rated, pending, rate (0–1 or null) }.
 */
export async function ratingResponseRate(guildId, { since = null, now = Date.now() } = {}, { query = dbQuery, tables } = {}) {
    const { rows } = await query(
        `SELECT COUNT(*) FILTER (WHERE rating IS NOT NULL OR expires_at <= $3)::int AS decided,
                COUNT(*) FILTER (WHERE rating IS NOT NULL)::int AS rated,
                COUNT(*) FILTER (WHERE rating IS NULL AND expires_at > $3)::int AS pending
         FROM ${table(tables)} WHERE guild_id = $1 AND ($2::timestamptz IS NULL OR prompted_at >= $2)`,
        [String(guildId), since, new Date(now)]);
    const r = rows[0] || { decided: 0, rated: 0, pending: 0 };
    return { prompted: r.decided, rated: r.rated, pending: r.pending, rate: r.decided ? r.rated / r.decided : null };
}

/** The newest ratings of `max` stars or fewer, with their comments (staff view). */
export async function recentLowRatings(guildId, { max = LOW_RATING_MAX, limit = 10 } = {}, { query = dbQuery, tables } = {}) {
    const { rows } = await query(
        `SELECT kind, ticket_number, staff_id, rating, rated_at, comment, comment_flagged FROM ${table(tables)}
         WHERE guild_id = $1 AND rating IS NOT NULL AND rating <= $2
         ORDER BY rated_at DESC, id DESC LIMIT $3`,
        [String(guildId), max, limit]);
    return rows;
}

/** All-time count and average of one server ({ count, avg }), for /ticket dashboard. */
export async function guildRatingSummary(guildId, { query = dbQuery, tables } = {}) {
    const { rows } = await query(
        `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg FROM ${table(tables)} WHERE guild_id = $1 AND rating IS NOT NULL`,
        [String(guildId)]);
    const r = rows[0] || { count: 0, avg: null };
    return { count: r.count, avg: r.count ? Math.round(Number(r.avg) * 10) / 10 : null };
}

/** Everything the dashboard Tickets page shows (last 90 days; the trend: 8 weeks). */
export async function ratingDashboard(guildId, { now = Date.now() } = {}, deps = {}) {
    const since = new Date(now - 90 * DAY_MS);
    const [byStaff, byPriority, trend, response, low] = await Promise.all([
        ratingsByStaff(guildId, { since }, deps),
        ratingsByPriority(guildId, { since }, deps),
        weeklyRatingTrend(guildId, { weeks: 8, now }, deps),
        ratingResponseRate(guildId, { since, now }, deps),
        recentLowRatings(guildId, {}, deps),
    ]);
    return { byStaff, byPriority, trend, response, low };
}

// ── privacy ───────────────────────────────────────────────────────────────

/** /wipedata: the ratings this member gave (every server) lose their opener and comment; the stars stay. */
export async function clearRatingsGivenBy(userId, { query = dbQuery, tables } = {}) {
    if (!ID.test(String(userId))) throw new Error('clearRatingsGivenBy: bad id');
    const result = await query(
        `UPDATE ${table(tables)} SET opener_id = NULL, comment = NULL WHERE opener_id = $1`, [String(userId)]);
    return result?.rowCount || 0;
}

const cutoff = (now, days) => new Date(now - days * DAY_MS);

/** Retention: comments older than 180 days are cleared (the stars stay). */
export async function pruneRatingComments({ query = dbQuery, tables, now = Date.now(), limit = 5000 } = {}) {
    const t = table(tables);
    const result = await query(
        `UPDATE ${t} SET comment = NULL WHERE id IN (
             SELECT id FROM ${t} WHERE comment IS NOT NULL AND comment_at < $1 LIMIT $2)`,
        [cutoff(now, RATING_RETENTION_DAYS.comments), limit]);
    return result?.rowCount || 0;
}

/** Retention: rows rated (or, never rated, prompted) more than 2 years ago are deleted. */
export async function pruneOldRatings({ query = dbQuery, tables, now = Date.now(), limit = 5000 } = {}) {
    const t = table(tables);
    const result = await query(
        `DELETE FROM ${t} WHERE id IN (
             SELECT id FROM ${t} WHERE COALESCE(rated_at, prompted_at) < $1 LIMIT $2)`,
        [cutoff(now, RATING_RETENTION_DAYS.rows), limit]);
    return result?.rowCount || 0;
}

/** Retention: never-rated rows 30 days after their window closed are deleted. */
export async function pruneUnratedRatings({ query = dbQuery, tables, now = Date.now(), limit = 5000 } = {}) {
    const t = table(tables);
    const result = await query(
        `DELETE FROM ${t} WHERE id IN (
             SELECT id FROM ${t} WHERE rating IS NULL AND expires_at < $1 LIMIT $2)`,
        [cutoff(now, RATING_RETENTION_DAYS.unrated), limit]);
    return result?.rowCount || 0;
}
