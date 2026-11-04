// watchlistService.js — the staff watchlist (/case watch add | list | end).
//
// Staff put a member on the watchlist with a reason; the member is NEVER told. While
// an entry is active, the mod log gets one 'watch' line when the member
//   - joins or rejoins the server (events/guildMemberAdd.js),
//   - gets a new mod case (enforcementService.runAction),
//   - trips automod (automod/reviewCards.js, where a hit is recorded).
// At most one alert per member per minute and per kind (join / case / automod), so a
// join alert never swallows the ban that follows it.
//
// Active entries are held in memory (loaded at startup, updated directly by every
// change, and reloaded after changes and by the expiry job), so the hot paths never
// read the database. A reload that started before a local change is discarded, so an
// older snapshot can never undo an add or an end. An entry past
// its `until` stops alerting at once, even before the expiry job marks it ended.
// until NULL = no end date (the default).

import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { query, T, isUniqueViolation, isEnforcementDbAvailable } from './db.js';
import { postModLog } from './enforcementService.js';
import { truncate } from './format.js';

export const WATCH_MAX_DAYS = 365;
export const WATCH_REASON_MAX = 500;
export const ALERT_COOLDOWN_MS = 60 * 1000;

// guildId:userId → { id, reason, createdAt (ms), until (ms | null) }
let byMember = new Map();
let loaded = false;
let changeSeq = 0; // bumped by every local change; a reload that saw an older value is dropped
const lastAlerted = new Map(); // guildId:userId:kind → ms

function userError(message) {
    return createError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

const unix = (ms) => Math.floor(ms / 1000);

function entryOf(row) {
    return {
        id: Number(row.id),
        reason: row.reason,
        createdAt: new Date(row.created_at).getTime(),
        until: row.until == null ? null : new Date(row.until).getTime(),
    };
}

/** Builds the member → entry index from active rows; pure. */
export function buildWatchIndex(rows) {
    const index = new Map();
    for (const row of rows) index.set(`${row.guild_id}:${row.user_id}`, entryOf(row));
    return index;
}

/** Applies one committed change to the in-memory index right away (no reload needed). */
function applyLocal(row, { ended }) {
    const key = `${row.guild_id}:${row.user_id}`;
    if (ended) {
        if (byMember.get(key)?.id === Number(row.id)) byMember.delete(key);
    } else {
        byMember.set(key, entryOf(row));
    }
    changeSeq += 1;
}

/** Reloads the active entries into memory. Throws (and keeps the old cache) when the database fails. */
export async function refreshWatchlistCache() {
    const seenSeq = changeSeq;
    const { rows } = await query(
        `SELECT id, guild_id, user_id, reason, created_at, until FROM ${T.watchlist}
         WHERE ended_at IS NULL AND (until IS NULL OR until > NOW())`
    );
    // A change committed while this SELECT ran is already in the map; this snapshot may predate it.
    if (seenSeq !== changeSeq && loaded) return rows.length;
    byMember = buildWatchIndex(rows);
    loaded = true;
    return rows.length;
}

export async function loadWatchlist() {
    if (!isEnforcementDbAvailable()) return null;
    return refreshWatchlistCache();
}

async function refreshQuietly() {
    await refreshWatchlistCache().catch((error) => logger.warn(`Watchlist cache refresh failed: ${error.message}`));
}

export function isWatchlistCacheLoaded() {
    return loaded;
}

/** The member's active entry, from memory, or null. Expired entries count as gone at once. */
export function getActiveWatch(guildId, userId, now = Date.now()) {
    const entry = byMember.get(`${guildId}:${userId}`);
    if (!entry) return null;
    return entry.until == null || entry.until > now ? entry : null;
}

/**
 * Like getActiveWatch, but reads the database when the cache never loaded (e.g. the
 * database was down at startup). Throws when the database fails, never guesses "not watched".
 */
export async function getActiveWatchChecked(guildId, userId, now = Date.now()) {
    if (loaded) return getActiveWatch(guildId, userId, now);
    const { rows: [row] } = await query(
        `SELECT id, guild_id, user_id, reason, created_at, until FROM ${T.watchlist}
         WHERE guild_id = $1 AND user_id = $2 AND ended_at IS NULL AND (until IS NULL OR until > NOW())`,
        [guildId, userId]
    );
    return row ? entryOf(row) : null;
}

/**
 * Checks the input of a new entry; pure. Returns { days (null = no limit), reason }.
 * Throws a user error for: a bot, the invoker themselves, days out of range, no reason.
 */
export function validateWatchInput({ userId, createdById, isBot = false, days = null, reason }) {
    if (isBot) throw userError('Bots cannot be put on the watchlist.');
    if (userId && createdById && userId === createdById) throw userError('You cannot put yourself on the watchlist.');
    if (days != null && (!Number.isInteger(days) || days < 1 || days > WATCH_MAX_DAYS)) {
        throw userError(`days must be between 1 and ${WATCH_MAX_DAYS} (leave it empty for no end date).`);
    }
    const text = String(reason || '').trim();
    if (!text) throw userError('A reason is required.');
    return { days: days ?? null, reason: text.slice(0, WATCH_REASON_MAX) };
}

/** "since <t:…:R> · until <t:…:f>" (or "no end date"); pure. */
function periodText(entry) {
    const created = new Date(entry.createdAt ?? entry.created_at).getTime();
    const until = entry.until == null ? null : new Date(entry.until).getTime();
    return `since <t:${unix(created)}:R> · ${until == null ? 'no end date' : `until <t:${unix(until)}:f>`}`;
}

/** "On watchlist since <t:…:R> — reason" for /background; pure. `entry` from getActiveWatch. */
export function watchlistLine(entry) {
    return `On watchlist since <t:${unix(entry.createdAt)}:R> — ${entry.reason}${entry.until == null ? '' : ` (until <t:${unix(entry.until)}:f>)`} (entry #${entry.id})`;
}

/** Adds a member. Returns the row. `isBot` comes from the caller's user object. */
export async function addWatch(client, { guildId, userId, username = null, isBot = false, days = null, reason, createdBy }) {
    const input = validateWatchInput({ userId, createdById: createdBy?.id, isBot, days, reason });

    // An entry that already ran out but was not marked ended yet must not block a new one.
    await query(
        `UPDATE ${T.watchlist} SET ended_at = until WHERE guild_id = $1 AND user_id = $2
           AND ended_at IS NULL AND until IS NOT NULL AND until <= NOW()`,
        [guildId, userId]
    );
    let row;
    try {
        ({ rows: [row] } = await query(
            `INSERT INTO ${T.watchlist} (guild_id, user_id, reason, created_by, until)
             VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $5::int) END)
             RETURNING *`,
            [guildId, userId, input.reason, createdBy.id, input.days]
        ));
    } catch (error) {
        if (isUniqueViolation(error, 'mod_watchlist')) {
            const { rows: [open] } = await query(
                `SELECT id FROM ${T.watchlist} WHERE guild_id = $1 AND user_id = $2 AND ended_at IS NULL`,
                [guildId, userId]
            );
            throw userError(`This member is already on the watchlist (#${open?.id ?? '?'}). End that entry first to change it.`);
        }
        throw error;
    }
    applyLocal(row, { ended: false });
    await refreshQuietly();
    await postModLog(client, 'watch', [
        { name: 'User', value: `${username || userId} (${userId})` },
        { name: 'Moderator', value: `${createdBy.username} (${createdBy.id})` },
        { name: 'Note', value: `added to the watchlist (#${row.id}), ${row.until ? `until <t:${unix(new Date(row.until).getTime())}:f>` : 'no end date'}` },
        { name: 'Reason', value: row.reason },
    ]);
    return row;
}

/** Ends an active entry early. Returns the row, or null when there is no such active entry. */
export async function endWatch(client, { guildId, id, endedBy }) {
    const { rows: [row] } = await query(
        `UPDATE ${T.watchlist} SET ended_at = NOW(), ended_by = $3
         WHERE guild_id = $1 AND id = $2 AND ended_at IS NULL RETURNING *`,
        [guildId, id, endedBy.id]
    );
    if (!row) return null;
    applyLocal(row, { ended: true });
    await refreshQuietly();
    await postModLog(client, 'watch', [
        { name: 'User', value: `<@${row.user_id}> (${row.user_id})` },
        { name: 'Moderator', value: `${endedBy.username} (${endedBy.id})` },
        { name: 'Note', value: `watchlist entry #${row.id} ended` },
    ]);
    return row;
}

/** Marks entries past their end as ended; run every minute. Returns how many ended. */
export async function expireWatchlist(client) {
    if (!isEnforcementDbAvailable()) return 0;
    // The startup load may have missed the database; catch up here.
    if (!loaded) await refreshQuietly();
    const { rows } = await query(
        `UPDATE ${T.watchlist} SET ended_at = NOW()
         WHERE ended_at IS NULL AND until IS NOT NULL AND until <= NOW() RETURNING *`
    );
    if (!rows.length) return 0;
    for (const row of rows) applyLocal(row, { ended: true });
    await refreshQuietly();
    for (const row of rows) {
        await postModLog(client, 'watch', [
            { name: 'User', value: `<@${row.user_id}> (${row.user_id})` },
            { name: 'Note', value: `watchlist entry #${row.id} expired` },
        ]);
    }
    return rows.length;
}

/** Active entries in a guild, newest first (from the database). */
export async function listActiveWatches(guildId, limit = 25) {
    const { rows } = await query(
        `SELECT * FROM ${T.watchlist} WHERE guild_id = $1 AND ended_at IS NULL AND (until IS NULL OR until > NOW())
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [guildId, limit]
    );
    return rows;
}

/** "#3 <@id> · since … · until … · by <@mod> · reason" for /case watch list; pure. */
export function watchListLine(row) {
    return `**#${row.id}** <@${row.user_id}> · ${periodText(row)} · by <@${row.created_by}> · ${truncate(row.reason, 120)}`;
}

/**
 * The /case watch list embed description: whole lines only, at most `max` characters, with
 * "…and N more" when they do not all fit (25 long lines would pass 4096 and get cut mid-line,
 * hiding entries and breaking a mention). Pure.
 */
export function watchListDescription(rows, max = 4096) {
    if (!rows.length) return 'Nobody. Add someone with `/case watch add`.';
    const out = [];
    let length = 0;
    for (let i = 0; i < rows.length; i += 1) {
        const line = watchListLine(rows[i]);
        const more = `…and ${rows.length - i} more`;
        const reserve = i < rows.length - 1 ? more.length + 1 : 0;
        const sep = out.length ? 1 : 0;
        if (length + sep + line.length + reserve > max) {
            out.push(more);
            break;
        }
        out.push(line);
        length += sep + line.length;
    }
    return out.join('\n');
}

/** True (and records the time) when this member may get an alert of this kind now; at most one per minute per kind. */
export function takeAlertSlot(guildId, userId, now = Date.now(), kind = 'event') {
    const key = `${guildId}:${userId}:${kind}`;
    if (now - (lastAlerted.get(key) ?? -Infinity) < ALERT_COOLDOWN_MS) return false;
    lastAlerted.delete(key);
    lastAlerted.set(key, now);
    if (lastAlerted.size > 1000) lastAlerted.delete(lastAlerted.keys().next().value);
    return true;
}

/**
 * Posts one mod log line when a watched member does something: { guildId, userId,
 * username, event } where `event` is plain text with an optional link/jump. Cheap when
 * the member is not watched (one Map lookup); never throws. Returns true when posted.
 * `post` is for tests.
 */
export async function alertWatched(client, { guildId, userId, username = null, event, kind = 'event' }, { post = postModLog, now = Date.now() } = {}) {
    try {
        if (!guildId || !userId) return false;
        const entry = getActiveWatch(guildId, userId, now);
        if (!entry) return false;
        if (!takeAlertSlot(guildId, userId, now, kind)) return false;
        await post(client, 'watch', [
            { name: 'User', value: `${username ? `${username} ` : ''}<@${userId}> (${userId})` },
            { name: 'Note', value: event },
            { name: 'Watched for', value: truncate(entry.reason, 300) },
            { name: 'Entry', value: `#${entry.id}` },
        ]);
        return true;
    } catch (error) {
        logger.warn(`Watchlist alert failed: ${error.message}`);
        return false;
    }
}

/** For tests: replace the in-memory index and clear the alert throttle. */
export function setWatchlistCacheForTests(rows) {
    byMember = buildWatchIndex(rows);
    loaded = true;
    changeSeq = 0;
    lastAlerted.clear();
}

/** For tests: forget the cache, as if the startup load never succeeded. */
export function resetWatchlistCacheForTests() {
    byMember = new Map();
    loaded = false;
    changeSeq = 0;
    lastAlerted.clear();
}
