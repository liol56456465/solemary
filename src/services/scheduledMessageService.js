// scheduledMessageService.js — scheduled and recurring bot messages (dashboard Messages page).
//
// A scheduled post is exactly a "Send a message" post: botMessageService.postBotMessage
// (text and/or embed, allowedMentions { parse: [] }, the bot's permissions checked at
// send time). Table scheduled_messages; the cron in app.js calls runDueScheduledMessages
// once a minute.
//
// Schedules (JSON, all times are wall-clock times in the message's IANA time zone):
//   { kind: 'once', date: 'YYYY-MM-DD', time: 'HH:MM' }
//   { kind: 'weekly', time: 'HH:MM', days: [0..6] }     (0 = Sunday; all seven = every day)
//   { kind: 'interval', hours: 1..168, date, time }     (first post at date+time, then every N hours)
// Wall-clock times are converted with Intl only (no packages). A time that does not
// exist on a DST change day (spring forward) moves forward by the gap; a time that
// happens twice (fall back) uses the first one. "Every N hours" counts real hours.
//
// A due row is claimed first (next_run_at moved on with a compare-and-set), then posted:
// a crash mid-post never posts twice. A run more than MAX_LATE_MS late (bot was offline)
// is skipped, not posted. A failed post records last_error; after FAILURE_LIMIT failures
// in a row the message is paused and the alerts channel is told (postModLog 'system').
// A one-time message that fails is retried after RETRY_MS until then.

import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';
import { pgConfig } from '../config/database/postgres.js';
import { canonicalTimeZone } from '../utils/timezone.js';
import { postBotMessage } from './botMessageService.js';

export const SCHEDULED_MAX_PER_GUILD = 50;
export const FAILURE_LIMIT = 3;
export const INTERVAL_MAX_HOURS = 168;
export const MAX_LATE_MS = 6 * 60 * 60 * 1000;
export const RETRY_MS = 5 * 60 * 1000;
const DUE_BATCH = 25;
const ERROR_MAX = 300;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const userError = (message) => createError(message, ErrorTypes.USER_INPUT, message, { expected: true });

// ── Time zone maths (pure) ───────────────────────────────────────────────

const formatters = new Map();
function formatter(timeZone) {
    let f = formatters.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', weekday: 'short',
            year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
        });
        formatters.set(timeZone, f);
    }
    return f;
}

/** Wall-clock parts of the instant `ms` in `timeZone`: { year, month, day, hour, minute, second, weekday }. */
export function zonedParts(ms, timeZone) {
    const parts = formatter(timeZone).formatToParts(new Date(ms));
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
        year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
        hour: Number(get('hour')) % 24, minute: Number(get('minute')), second: Number(get('second')),
        weekday: WEEKDAYS.indexOf(get('weekday')),
    };
}

/** The zone's offset from UTC at instant `ms`, in ms (e.g. +3 h → 10800000). */
export function zoneOffsetMs(ms, timeZone) {
    const p = zonedParts(ms, timeZone);
    const whole = Math.floor(ms / 1000) * 1000;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * The UTC instant (ms) of wall-clock y-m-d h:min in `timeZone`. Spring-forward gap → shifted
 * forward by the gap; fall-back repeat → the earlier instant.
 */
export function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
    const local = Date.UTC(year, month - 1, day, hour, minute);
    const before = local - zoneOffsetMs(local - DAY_MS, timeZone);
    const after = local - zoneOffsetMs(local + DAY_MS, timeZone);
    const matches = (t) => {
        const p = zonedParts(t, timeZone);
        return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    };
    const valid = [before, after].filter(matches);
    if (valid.length) return Math.min(...valid);
    return before; // in the gap: the old offset lands just after it
}

function parseTime(time) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time ?? ''));
    return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

function parseDate(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
    if (!m) return null;
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return { year, month, day };
}

/** The instant of a schedule's date + time in `timeZone`, or null when either is invalid. */
export function startInstant(schedule, timeZone) {
    const d = parseDate(schedule?.date);
    const t = parseTime(schedule?.time);
    return d && t ? zonedTimeToUtc(d.year, d.month, d.day, t.hour, t.minute, timeZone) : null;
}

/**
 * The next run strictly after `afterMs` (ms), or null when there is none (a past one-time
 * message). Throws on an invalid schedule or time zone.
 */
export function nextRunAfter(schedule, timeZone, afterMs) {
    const zone = canonicalTimeZone(timeZone);
    if (!zone) throw new Error(`Unknown time zone ${timeZone}`);
    const kind = schedule?.kind;
    if (kind === 'once') {
        const at = startInstant(schedule, zone);
        if (at === null) throw new Error('Invalid one-time schedule');
        return at > afterMs ? at : null;
    }
    if (kind === 'interval') {
        const hours = Number(schedule.hours);
        if (!Number.isInteger(hours) || hours < 1 || hours > INTERVAL_MAX_HOURS) throw new Error('Invalid interval');
        const anchor = startInstant(schedule, zone);
        if (anchor === null) throw new Error('Invalid interval start');
        if (anchor > afterMs) return anchor;
        const step = hours * HOUR_MS;
        return anchor + (Math.floor((afterMs - anchor) / step) + 1) * step;
    }
    if (kind === 'weekly') {
        const t = parseTime(schedule.time);
        const days = new Set((schedule.days || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
        if (!t || !days.size) throw new Error('Invalid weekly schedule');
        const today = zonedParts(afterMs, zone);
        for (let i = 0; i <= 8; i += 1) {
            const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
            if (!days.has(date.getUTCDay())) continue;
            const at = zonedTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), t.hour, t.minute, zone);
            if (at > afterMs) return at;
        }
        return null;
    }
    throw new Error(`Unknown schedule kind ${kind}`);
}

/** "2026-11-01 09:00" in `timeZone`. */
export function formatInZone(ms, timeZone) {
    if (ms === null || ms === undefined) return '—';
    const zone = canonicalTimeZone(timeZone) || 'UTC';
    const p = zonedParts(Number(ms), zone);
    const pad = (n) => String(n).padStart(2, '0');
    return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Once on 2026-11-01 at 09:00", "Every day at 09:00", "Mon, Fri at 09:00", "Every 6 hours from …". */
export function describeSchedule(schedule) {
    switch (schedule?.kind) {
        case 'once': return `Once on ${schedule.date} at ${schedule.time}`;
        case 'weekly': {
            const days = [...new Set(schedule.days || [])].sort();
            if (days.length === 7) return `Every day at ${schedule.time}`;
            return `${[1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => WEEKDAYS[d]).join(', ')} at ${schedule.time}`;
        }
        case 'interval': return `Every ${schedule.hours} hour${schedule.hours === 1 ? '' : 's'} from ${schedule.date} ${schedule.time}`;
        default: return 'Unknown schedule';
    }
}

/** A schedule checked and normalised (throws a user error), from the dashboard form's values. */
export function cleanSchedule(input) {
    const kind = input?.kind;
    const time = parseTime(input?.time) ? input.time : null;
    if (kind === 'weekly') {
        if (!time) throw userError('Time: use HH:MM (24-hour clock).');
        const days = [...new Set((input.days || []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
        if (!days.length) throw userError('Days: pick at least one weekday.');
        return { kind, time, days };
    }
    if (kind === 'once' || kind === 'interval') {
        if (!parseDate(input?.date)) throw userError('Date: use YYYY-MM-DD.');
        if (!time) throw userError('Time: use HH:MM (24-hour clock).');
        if (kind === 'once') return { kind, date: input.date, time };
        const hours = Number(input.hours);
        if (!Number.isInteger(hours) || hours < 1 || hours > INTERVAL_MAX_HOURS) throw userError(`Every N hours: N must be between 1 and ${INTERVAL_MAX_HOURS}.`);
        return { kind, date: input.date, time, hours };
    }
    throw userError('Repeat: unknown choice.');
}

// ── Store (PostgreSQL) ───────────────────────────────────────────────────

function toMessage(row) {
    return {
        id: Number(row.id),
        guildId: row.guild_id,
        channelId: row.channel_id,
        payload: row.payload,
        schedule: row.schedule,
        timezone: row.timezone,
        nextRunAt: row.next_run_at ? new Date(row.next_run_at).getTime() : null,
        lastRunAt: row.last_run_at ? new Date(row.last_run_at).getTime() : null,
        lastError: row.last_error || null,
        lastMessageId: row.last_message_id || null,
        failureCount: Number(row.failure_count || 0),
        paused: Boolean(row.paused),
        createdBy: row.created_by,
    };
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** SQL for the table; `query` / `withTransaction` are the enforcement pool helpers (lazy import keeps unit tests DB-free). */
export function createScheduledMessageStore({ query, withTransaction, table = pgConfig.tables.scheduled_messages } = {}) {
    const db = async () => {
        if (query && withTransaction) return { query, withTransaction };
        const mod = await import('./enforcement/db.js');
        return { query: query || mod.query, withTransaction: withTransaction || mod.withTransaction, available: mod.isEnforcementDbAvailable };
    };
    return {
        async available() {
            const d = await db();
            return d.available ? d.available() : true;
        },
        async list(guildId) {
            const { rows } = await (await db()).query(`SELECT * FROM ${table} WHERE guild_id = $1 ORDER BY paused, next_run_at NULLS LAST, id`, [guildId]);
            return rows.map(toMessage);
        },
        async get(guildId, id) {
            const { rows: [row] } = await (await db()).query(`SELECT * FROM ${table} WHERE guild_id = $1 AND id = $2`, [guildId, id]);
            return row ? toMessage(row) : null;
        },
        /** Inserts unless the guild already has `max` rows (checked under a per-guild lock); null when full. */
        async insert({ guildId, channelId, payload, schedule, timezone, nextRunAt, createdBy }, max) {
            return (await db()).withTransaction(async (client) => {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`scheduled_messages:${guildId}`]);
                const { rows: [{ count }] } = await client.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE guild_id = $1`, [guildId]);
                if (count >= max) return null;
                const { rows: [row] } = await client.query(
                    `INSERT INTO ${table} (guild_id, channel_id, payload, schedule, timezone, next_run_at, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                    [guildId, channelId, JSON.stringify(payload), JSON.stringify(schedule), timezone, iso(nextRunAt), createdBy]
                );
                return toMessage(row);
            });
        },
        async update(guildId, id, { channelId, payload, schedule, timezone, nextRunAt }) {
            const { rows: [row] } = await (await db()).query(
                `UPDATE ${table} SET channel_id = $3, payload = $4, schedule = $5, timezone = $6, next_run_at = $7,
                        failure_count = 0, last_error = NULL, updated_at = NOW()
                 WHERE guild_id = $1 AND id = $2 RETURNING *`,
                [guildId, id, channelId, JSON.stringify(payload), JSON.stringify(schedule), timezone, iso(nextRunAt)]
            );
            return row ? toMessage(row) : null;
        },
        async setPaused(guildId, id, paused, nextRunAt) {
            const { rows: [row] } = await (await db()).query(
                `UPDATE ${table} SET paused = $3, next_run_at = $4, failure_count = CASE WHEN $3 THEN failure_count ELSE 0 END, updated_at = NOW()
                 WHERE guild_id = $1 AND id = $2 RETURNING *`,
                [guildId, id, paused, iso(nextRunAt)]
            );
            return row ? toMessage(row) : null;
        },
        async remove(guildId, id) {
            const { rowCount } = await (await db()).query(`DELETE FROM ${table} WHERE guild_id = $1 AND id = $2`, [guildId, id]);
            return rowCount > 0;
        },
        async due(nowMs, limit = DUE_BATCH) {
            const { rows } = await (await db()).query(
                `SELECT * FROM ${table} WHERE paused = FALSE AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT $2`,
                [iso(nowMs), limit]
            );
            return rows.map(toMessage);
        },
        /** Moves next_run_at from `expected` to `next`; false when someone else already did. */
        async claim(id, expectedMs, nextMs) {
            const { rowCount } = await (await db()).query(
                `UPDATE ${table} SET next_run_at = $3, updated_at = NOW() WHERE id = $1 AND next_run_at = $2 AND paused = FALSE`,
                [id, iso(expectedMs), iso(nextMs)]
            );
            return rowCount === 1;
        },
        async recordSuccess(id, atMs, messageId) {
            await (await db()).query(
                `UPDATE ${table} SET last_run_at = $2, last_error = NULL, last_message_id = $3, failure_count = 0, updated_at = NOW() WHERE id = $1`,
                [id, iso(atMs), messageId]
            );
        },
        /** Records a note (skipped run) without counting a failure. */
        async recordNote(id, atMs, note) {
            await (await db()).query(`UPDATE ${table} SET last_run_at = $2, last_error = $3, updated_at = NOW() WHERE id = $1`, [id, iso(atMs), note]);
        },
        /** Counts a failure; pauses at `limit`. `retryMs` (one-time messages) replaces next_run_at. Returns { failureCount, paused }. */
        async recordFailure(id, atMs, error, limit, retryMs = null) {
            const { rows: [row] } = await (await db()).query(
                `UPDATE ${table} SET last_run_at = $2, last_error = $3, failure_count = failure_count + 1,
                        paused = paused OR failure_count + 1 >= $4,
                        next_run_at = CASE WHEN $5::timestamptz IS NOT NULL THEN $5::timestamptz ELSE next_run_at END,
                        updated_at = NOW()
                 WHERE id = $1 RETURNING failure_count, paused`,
                [id, iso(atMs), error, limit, iso(retryMs)]
            );
            return row ? { failureCount: Number(row.failure_count), paused: Boolean(row.paused) } : { failureCount: 0, paused: false };
        },
    };
}

let defaultStore = null;
const storeOf = (store) => store || (defaultStore ||= createScheduledMessageStore());

// ── Payload ──────────────────────────────────────────────────────────────

/** { content, embed } kept for the post: only the fields postBotMessage reads. */
export function cleanPayload({ content = '', embed = null } = {}) {
    const e = embed ? {
        title: String(embed.title || ''), description: String(embed.description || ''), imageUrl: String(embed.imageUrl || ''),
        footer: String(embed.footer || ''), colour: Number.isInteger(embed.colour) ? embed.colour : null,
    } : null;
    return { content: String(content || ''), embed: e };
}

function errorText(error) {
    return String(error?.userMessage || error?.message || 'Unknown error').replace(/\s+/g, ' ').slice(0, ERROR_MAX);
}

function timeZoneOrThrow(timeZone) {
    const zone = canonicalTimeZone(timeZone);
    if (!zone) throw userError(`Time zone: ${String(timeZone).slice(0, 64)} is not a known time zone. Use an IANA name such as Europe/London or UTC.`);
    return zone;
}

// ── Service (dashboard) ──────────────────────────────────────────────────

export async function listScheduledMessages(guildId, { store } = {}) {
    return storeOf(store).list(guildId);
}

/** Creates a scheduled message; the first run must be in the future. */
export async function createScheduledMessage({ guildId, channelId, payload, schedule, timezone, createdBy }, { store, now = Date.now() } = {}) {
    const zone = timeZoneOrThrow(timezone);
    const clean = cleanSchedule(schedule);
    const nextRunAt = nextRunAfter(clean, zone, now);
    if (nextRunAt === null) throw userError('That time has already passed: pick a time in the future.');
    const row = await storeOf(store).insert({ guildId, channelId, payload: cleanPayload(payload), schedule: clean, timezone: zone, nextRunAt, createdBy }, SCHEDULED_MAX_PER_GUILD);
    if (!row) throw userError(`A server can have at most ${SCHEDULED_MAX_PER_GUILD} scheduled messages. Delete one first.`);
    return row;
}

/** Replaces channel, message and schedule; clears the failure count. Returns { before, after }. */
export async function updateScheduledMessage(guildId, id, { channelId, payload, schedule, timezone }, { store, now = Date.now() } = {}) {
    const s = storeOf(store);
    const before = await s.get(guildId, id);
    if (!before) throw userError(`There is no scheduled message #${id}.`);
    const zone = timeZoneOrThrow(timezone);
    const clean = cleanSchedule(schedule);
    const nextRunAt = nextRunAfter(clean, zone, now);
    if (nextRunAt === null) throw userError('That time has already passed: pick a time in the future.');
    const after = await s.update(guildId, id, { channelId, payload: cleanPayload(payload), schedule: clean, timezone: zone, nextRunAt });
    if (!after) throw userError(`There is no scheduled message #${id}.`);
    return { before, after };
}

/** Pause (keeps next run) or resume (next run from now, failures reset). Returns { before, after }. */
export async function setScheduledMessagePaused(guildId, id, paused, { store, now = Date.now() } = {}) {
    const s = storeOf(store);
    const before = await s.get(guildId, id);
    if (!before) throw userError(`There is no scheduled message #${id}.`);
    let nextRunAt = before.nextRunAt;
    if (!paused) {
        nextRunAt = nextRunAfter(before.schedule, before.timezone, now);
        if (nextRunAt === null) throw userError('That one-time message has no future time left: edit it and pick a new time.');
    }
    const after = await s.setPaused(guildId, id, paused, nextRunAt);
    return { before, after };
}

export async function deleteScheduledMessage(guildId, id, { store } = {}) {
    const s = storeOf(store);
    const before = await s.get(guildId, id);
    if (!before) return null;
    return (await s.remove(guildId, id)) ? before : null;
}

async function resolveChannel(guild, channelId) {
    if (!guild) throw userError('The bot is not in that server any more.');
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch?.(channelId).catch(() => null);
    if (!channel) throw userError('The channel no longer exists.');
    return channel;
}

/**
 * Posts it now. A repeating message keeps its schedule; a one-time message is finished
 * (next_run_at cleared). A failure is recorded (not counted) and thrown.
 */
export async function runScheduledMessageNow(guild, id, { store, now = Date.now(), post = postBotMessage } = {}) {
    const s = storeOf(store);
    const row = await s.get(guild.id, id);
    if (!row) throw userError(`There is no scheduled message #${id}.`);
    try {
        const channel = await resolveChannel(guild, row.channelId);
        const { message } = await post(guild, { channel, content: row.payload?.content || '', embed: row.payload?.embed || null });
        await s.recordSuccess(row.id, now, message?.id || null);
        if (row.schedule?.kind === 'once') await s.setPaused(guild.id, row.id, false, null);
        return { row, message, channel };
    } catch (error) {
        await s.recordNote(row.id, now, errorText(error)).catch(() => {});
        throw error;
    }
}

// ── Cron ─────────────────────────────────────────────────────────────────

async function alertPaused(client, row, error, postModLog) {
    const log = postModLog || (await import('./enforcement/enforcementService.js')).postModLog;
    await log(client, 'system', [
        { name: 'Scheduled message', value: `#${row.id} in <#${row.channelId}>` },
        { name: 'Last error', value: error },
        { name: 'What to do', value: `It failed ${FAILURE_LIMIT} times in a row and is paused. Fix the channel or the bot's permissions, then Resume it on the dashboard Messages page.` },
    ], { title: '⏰ Scheduled message paused' });
}

/**
 * Posts every due message, moves its next run on, records the result. Returns
 * { posted, failed, skipped, paused }.
 */
export async function runDueScheduledMessages(client, { store, now = Date.now(), post = postBotMessage, postModLog = null } = {}) {
    const s = storeOf(store);
    const summary = { posted: 0, failed: 0, skipped: 0, paused: 0 };
    if (typeof client?.isReady === 'function' && !client.isReady()) return summary;
    if (!(await s.available())) return summary;
    const due = await s.due(now);
    for (const row of due) {
        let next;
        try {
            next = nextRunAfter(row.schedule, row.timezone, now);
        } catch (error) {
            next = null;
            logger.warn(`Scheduled message #${row.id}: bad schedule (${error.message})`);
        }
        if (!(await s.claim(row.id, row.nextRunAt, next))) continue;
        if (now - row.nextRunAt > MAX_LATE_MS) {
            summary.skipped += 1;
            await s.recordNote(row.id, now, `Skipped the run of ${formatInZone(row.nextRunAt, row.timezone)} (${row.timezone}): the bot was offline.`);
            continue;
        }
        try {
            const guild = client.guilds?.cache?.get(row.guildId);
            const channel = await resolveChannel(guild, row.channelId);
            const { message } = await post(guild, { channel, content: row.payload?.content || '', embed: row.payload?.embed || null });
            await s.recordSuccess(row.id, now, message?.id || null);
            summary.posted += 1;
        } catch (error) {
            const text = errorText(error);
            summary.failed += 1;
            const retry = row.schedule?.kind === 'once' ? now + RETRY_MS : null;
            const result = await s.recordFailure(row.id, now, text, FAILURE_LIMIT, retry);
            logger.warn(`Scheduled message #${row.id} in ${row.guildId} failed (${result.failureCount}/${FAILURE_LIMIT}): ${text}`);
            if (result.paused) {
                summary.paused += 1;
                await alertPaused(client, row, text, postModLog).catch((e) => logger.warn(`Scheduled message alert failed: ${e.message}`));
            }
        }
    }
    return summary;
}
