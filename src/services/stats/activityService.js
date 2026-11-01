// activityService.js: the numbers behind Dashboard → Activity.
//
//   messages per day   counted here (in memory per server and UTC day, written once a minute
//                      to guild_daily_stats). Only a count: no content, no authors.
//   joins / leaves     member_events (kept 90 days by memberInsightsService)
//   cases              mod_cases (no /test cases, no imported history)
//
// Daily message counts are kept 400 days.

import { pgConfig } from '../../config/database/postgres.js';
import { query as defaultQuery } from '../enforcement/db.js';
import { logger } from '../../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_DAYS = 30;
const KEEP_DAYS = 400;
const pending = new Map(); // `${guildId}|${YYYY-MM-DD}` → count

const dayOf = (date) => new Date(date).toISOString().slice(0, 10);

/** Counts one message (bots and DMs are not counted). Cheap: memory only. */
export function noteMessage(message, now = Date.now()) {
    if (!message?.guildId || message.author?.bot) return;
    const key = `${message.guildId}|${dayOf(now)}`;
    pending.set(key, (pending.get(key) || 0) + 1);
}

/** Writes the buffered counts; every minute. A failed write is put back for the next run. */
export async function flushActivity({ query = defaultQuery, table = pgConfig.tables.guild_daily_stats } = {}) {
    const entries = [...pending];
    pending.clear();
    for (const [key, count] of entries) {
        const [guildId, day] = key.split('|');
        try {
            await query(
                `INSERT INTO ${table} (guild_id, day, messages) VALUES ($1, $2, $3)
                 ON CONFLICT (guild_id, day) DO UPDATE SET messages = ${table}.messages + EXCLUDED.messages`,
                [guildId, day, count],
            );
        } catch (error) {
            pending.set(key, (pending.get(key) || 0) + count);
            logger.warn(`Activity flush failed: ${error.message}`);
            return;
        }
    }
}

export async function pruneActivity({ query = defaultQuery, table = pgConfig.tables.guild_daily_stats, now = Date.now() } = {}) {
    const { rowCount } = await query(`DELETE FROM ${table} WHERE day < $1`, [dayOf(now - KEEP_DAYS * DAY_MS)]);
    return rowCount || 0;
}

/** The last `days` UTC days, oldest first, as 'YYYY-MM-DD'. */
export function lastDays(days = ACTIVITY_DAYS, now = Date.now()) {
    return Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * DAY_MS));
}

/**
 * [{ day, messages, joins, leaves, cases }] for the last `days` days, oldest first.
 * Today's messages include what is still buffered. Throws on a database error.
 */
export async function activitySeries(guildId, { days = ACTIVITY_DAYS, now = Date.now(), query = defaultQuery } = {}) {
    const t = pgConfig.tables;
    const range = lastDays(days, now);
    const from = range[0];
    const [messages, events, cases] = await Promise.all([
        query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, messages FROM ${t.guild_daily_stats} WHERE guild_id = $1 AND day >= $2`, [guildId, from]),
        query(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, kind, COUNT(*)::int AS n FROM ${t.member_events}
               WHERE guild_id = $1 AND created_at >= $2::date GROUP BY 1, 2`, [guildId, from]),
        query(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n FROM ${t.mod_cases}
               WHERE guild_id = $1 AND created_at >= $2::date AND is_test IS NOT TRUE AND is_imported IS NOT TRUE GROUP BY 1`, [guildId, from]),
    ]);
    const byDay = new Map(range.map((day) => [day, { day, messages: 0, joins: 0, leaves: 0, cases: 0 }]));
    for (const r of messages.rows) if (byDay.has(r.day)) byDay.get(r.day).messages += Number(r.messages);
    for (const r of events.rows) if (byDay.has(r.day)) byDay.get(r.day)[r.kind === 'join' ? 'joins' : 'leaves'] += r.n;
    for (const r of cases.rows) if (byDay.has(r.day)) byDay.get(r.day).cases += r.n;
    for (const [key, count] of pending) {
        const [g, day] = key.split('|');
        if (g === String(guildId) && byDay.has(day)) byDay.get(day).messages += count;
    }
    return [...byDay.values()];
}

/** Messages of a server still buffered (not written yet): [{ day: 'YYYY-MM-DD', count }]. */
export function pendingMessages(guildId) {
    const out = [];
    for (const [key, count] of pending) {
        const [g, day] = key.split('|');
        if (g === String(guildId)) out.push({ day, count });
    }
    return out;
}

/** For tests. */
export function _pendingActivity() { return pending; }

/**
 * Pro and Max (by the server owner's plan): the last `days` days per moderator and per
 * automod rule. { moderators: [{ name, total, ban, kick, mute, warn, voided }],
 * rules: [{ key, total, undone }] }. Throws on a database error.
 */
export async function staffAnalytics(guildId, { days = ACTIVITY_DAYS, now = Date.now(), query = defaultQuery } = {}) {
    const t = pgConfig.tables.mod_cases;
    const since = new Date(now - days * DAY_MS);
    const [mods, rules] = await Promise.all([
        query(`SELECT moderator_username AS name, COUNT(*)::int AS total,
                      COUNT(*) FILTER (WHERE type = 'ban')::int AS ban, COUNT(*) FILTER (WHERE type = 'kick')::int AS kick,
                      COUNT(*) FILTER (WHERE type = 'mute')::int AS mute, COUNT(*) FILTER (WHERE type = 'warn')::int AS warn,
                      COUNT(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided
               FROM ${t} WHERE guild_id = $1 AND created_at >= $2 AND is_auto IS NOT TRUE AND is_test IS NOT TRUE AND is_imported IS NOT TRUE
               GROUP BY moderator_username ORDER BY total DESC LIMIT 50`, [guildId, since]),
        query(`SELECT reason_key AS key, COUNT(*)::int AS total,
                      COUNT(*) FILTER (WHERE voided_at IS NOT NULL OR status = 'revoked')::int AS undone
               FROM ${t} WHERE guild_id = $1 AND created_at >= $2 AND reason_key LIKE 'automod:%' AND is_test IS NOT TRUE
               GROUP BY reason_key ORDER BY total DESC LIMIT 50`, [guildId, since]),
    ]);
    return { moderators: mods.rows, rules: rules.rows };
}
