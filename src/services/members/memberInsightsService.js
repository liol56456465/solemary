// memberInsightsService.js — dashboard Members → Insights.
//
//   joins and leaves per day   member_events (written on guildMemberAdd / guildMemberRemove,
//                              kept RETENTION_DAYS, pruned daily by the cron)
//   no roles after 24 h        the member cache (joined in the last 30 days, > 24 h ago, no role)
//   repeat offenders           mod_cases of the last 90 days (voided, imported and /test cases left out)
//   inactive members           user_levels.last_message: the last time leveling gave the member
//                              XP. It is the only activity time the bot stores, so it says nothing
//                              while leveling is off, and nothing about members who never earned XP.

import { query, T } from '../enforcement/db.js';
import { pgConfig } from '../../config/database/postgres.js';

export const RETENTION_DAYS = 90;
export const CHART_DAYS = 30;
export const OFFENDER_DAYS = 90;
export const INACTIVE_DAYS = 30;
export const LIST_LIMIT = 25;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ── member_events ────────────────────────────────────────────────────────

export async function recordMemberEvent(guildId, userId, kind, at = new Date()) {
    if (kind !== 'join' && kind !== 'leave') throw new Error(`Unknown member event ${kind}`);
    await query(`INSERT INTO ${T.memberEvents} (guild_id, user_id, kind, created_at) VALUES ($1, $2, $3, $4)`, [guildId, userId, kind, at]);
}

/** Deletes events older than RETENTION_DAYS. Returns the number deleted. */
export async function pruneMemberEvents(now = new Date(), days = RETENTION_DAYS) {
    const { rowCount } = await query(`DELETE FROM ${T.memberEvents} WHERE created_at < $1`, [new Date(now.getTime() - days * DAY_MS)]);
    return rowCount || 0;
}

/** 'YYYY-MM-DD' of a time, in UTC. */
export function utcDay(value) {
    return new Date(value).toISOString().slice(0, 10);
}

/**
 * The last `days` UTC days (oldest first, today last), each { day, joins, leaves }, from
 * grouped rows [{ day: 'YYYY-MM-DD', kind, n }]. Days without rows are zero.
 */
export function fillDays(rows, { days = CHART_DAYS, now = Date.now() } = {}) {
    const counts = new Map();
    for (const row of rows) {
        const entry = counts.get(row.day) || { joins: 0, leaves: 0 };
        if (row.kind === 'join') entry.joins += Number(row.n) || 0;
        if (row.kind === 'leave') entry.leaves += Number(row.n) || 0;
        counts.set(row.day, entry);
    }
    const out = [];
    const today = Date.parse(`${utcDay(now)}T00:00:00Z`);
    for (let i = days - 1; i >= 0; i -= 1) {
        const day = utcDay(today - i * DAY_MS);
        out.push({ day, ...(counts.get(day) || { joins: 0, leaves: 0 }) });
    }
    return out;
}

/** { days: [{ day, joins, leaves }], since: Date | null (first stored event of the server) }. */
export async function joinsLeavesPerDay(guildId, { days = CHART_DAYS, now = Date.now() } = {}) {
    const from = new Date(Date.parse(`${utcDay(now)}T00:00:00Z`) - (days - 1) * DAY_MS);
    const [{ rows }, first] = await Promise.all([
        query(
            `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, kind, COUNT(*)::int AS n
             FROM ${T.memberEvents} WHERE guild_id = $1 AND created_at >= $2 GROUP BY 1, 2`, [guildId, from]),
        query(`SELECT MIN(created_at) AS since FROM ${T.memberEvents} WHERE guild_id = $1`, [guildId]),
    ]);
    return { days: fillDays(rows, { days, now }), since: first.rows[0]?.since || null };
}

// ── Repeat offenders ─────────────────────────────────────────────────────

/** Members with at least two real cases in the last `days`, most cases first. */
export async function repeatOffenders(guildId, { days = OFFENDER_DAYS, limit = LIST_LIMIT, now = Date.now() } = {}) {
    const { rows } = await query(
        `SELECT target_user_id, (ARRAY_AGG(target_username ORDER BY created_at DESC))[1] AS username,
                COUNT(*)::int AS cases,
                COUNT(*) FILTER (WHERE type = 'warn')::int AS warns,
                COUNT(*) FILTER (WHERE type = 'mute')::int AS mutes,
                COUNT(*) FILTER (WHERE type = 'kick')::int AS kicks,
                COUNT(*) FILTER (WHERE type = 'ban')::int AS bans,
                MAX(created_at) AS last_at
         FROM ${T.cases}
         WHERE guild_id = $1 AND created_at >= $2 AND voided_at IS NULL AND NOT is_imported AND NOT is_test
         GROUP BY target_user_id HAVING COUNT(*) >= 2
         ORDER BY cases DESC, last_at DESC LIMIT $3`, [guildId, new Date(now - days * DAY_MS), limit]);
    return rows.map((r) => ({
        userId: r.target_user_id, username: r.username, cases: r.cases, warns: r.warns, mutes: r.mutes, kicks: r.kicks, bans: r.bans, lastAt: r.last_at,
    }));
}

// ── From the member cache ────────────────────────────────────────────────

const joinedAt = (m) => m.joinedTimestamp ?? (m.joinedAt ? new Date(m.joinedAt).getTime() : null);
const roleCount = (m, guildId) => [...(m.roles?.cache?.keys?.() || [])].filter((id) => id !== guildId).length;
const nameOf = (m) => ({ id: m.id || m.user?.id, username: m.user?.username || m.id, displayName: m.nickname || m.user?.globalName || m.user?.username || m.id });

/**
 * Members (not bots) who joined in the last `maxDays` days, more than `minHours` ago, and still
 * have no role. { total, rows: [{ id, username, displayName, joinedAt }] } (longest waiting first).
 */
export function membersWithoutRoles(guild, { now = Date.now(), minHours = 24, maxDays = 30, limit = LIST_LIMIT } = {}) {
    const found = [];
    for (const m of guild?.members?.cache?.values?.() || []) {
        if (m.user?.bot) continue;
        const at = joinedAt(m);
        if (!Number.isFinite(at) || now - at < minHours * HOUR_MS || now - at > maxDays * DAY_MS) continue;
        if (roleCount(m, guild.id) > 0) continue;
        found.push({ ...nameOf(m), joinedAt: new Date(at) });
    }
    found.sort((a, b) => a.joinedAt - b.joinedAt);
    return { total: found.length, rows: found.slice(0, limit) };
}

/** user_levels.last_message per member: Map userId → ms. */
export async function loadLastActivity(guildId) {
    const { rows } = await query(
        `SELECT user_id, last_message FROM ${pgConfig.tables.user_levels} WHERE guild_id = $1 AND last_message IS NOT NULL`, [guildId]);
    return new Map(rows.map((r) => [r.user_id, new Date(r.last_message).getTime()]).filter(([, at]) => Number.isFinite(at)));
}

/**
 * Members (not bots, in the server for at least `days`) whose last XP is older than `days`.
 * Members without any leveling record are counted apart (noRecord): the bot cannot tell
 * whether they were quiet or joined before leveling was on.
 */
export function inactiveMembers(guild, lastActivity, { now = Date.now(), days = INACTIVE_DAYS, limit = LIST_LIMIT } = {}) {
    const found = [];
    let noRecord = 0;
    for (const m of guild?.members?.cache?.values?.() || []) {
        if (m.user?.bot) continue;
        const at = joinedAt(m);
        if (Number.isFinite(at) && now - at < days * DAY_MS) continue;
        const id = m.id || m.user?.id;
        const last = lastActivity.get(id);
        if (last === undefined) { noRecord += 1; continue; }
        if (now - last >= days * DAY_MS) found.push({ ...nameOf(m), lastActiveAt: new Date(last) });
    }
    found.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    return { total: found.length, noRecord, rows: found.slice(0, limit) };
}
