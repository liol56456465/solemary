// inviteStats.js — invite counts, computed at read time from invite_joins (never stored).
//
//   invited  counted joins through the inviter since their reset (and the server's resetAt)
//   fake     of those: account younger than fakeAccountDays at join, OR left within fakeLeaveHours
//   left     of those: left the server and not fake (a fake leaver is subtracted once, as fake)
//   bonus    staff bonus (+/-); a bonus last set before the server-wide reset counts as 0
//   total    invited − left − fake + bonus
//
// Changing the fake rule recounts history (owner decision 2). Rows with no inviter (another
// source, or blanked by /wipedata) never count. Reads throw on a database error.
//
// Also the settings helper every invite module uses: inviteSettings(guildId) — the stored value
// merged over the defaults (a value saved by an older version may lack newer keys).

import { pgConfig } from '../../config/database/postgres.js';
import { query as dbQuery } from '../enforcement/db.js';
import { guildRole, resolveSetting, settingGuildId } from '../settings/guildSettings.js';
import { INVITE_TRACKING_DEFAULT } from '../settings/settingsRegistry.js';
import { BoundedMap } from '../../utils/boundedMap.js';

export const INVITE_SETTING_KEY = 'inviteTracking';
export const LEADERBOARD_PAGE_SIZE = 10;
export const LEADERBOARD_CACHE_MS = 60_000;
const ID = /^\d{17,20}$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Stored value over the defaults; pure. */
export function normalizeInviteSettings(value) {
    const v = value && typeof value === 'object' ? value : {};
    const num = (x, fallback, max) => (Number.isInteger(x) && x >= 0 && x <= max ? x : fallback);
    return {
        enabled: v.enabled === true,
        fakeAccountDays: num(v.fakeAccountDays, INVITE_TRACKING_DEFAULT.fakeAccountDays, 365),
        fakeLeaveHours: num(v.fakeLeaveHours, INVITE_TRACKING_DEFAULT.fakeLeaveHours, 720),
        milestones: Array.isArray(v.milestones)
            ? v.milestones.filter((m) => Number.isInteger(m?.count) && m.count > 0 && ID.test(String(m?.roleId || '')))
                .map((m) => ({ count: m.count, roleId: String(m.roleId) })).sort((a, b) => a.count - b.count)
            : [],
        stackRoles: v.stackRoles !== false,
        resetAt: typeof v.resetAt === 'string' && Number.isFinite(Date.parse(v.resetAt)) ? v.resetAt : null,
    };
}

/**
 * The server's invite settings, from the row its dashboard saves to (settingGuildId: the server
 * itself; for Mewvo's home servers the main server's row). The support server never tracks
 * invites (its joins are appeals and Mewvo's own re-adds): always off there.
 * Throws SettingsUnavailableError when they cannot be read.
 */
export function inviteSettings(guildId, { resolve = resolveSetting, env = process.env } = {}) {
    const id = String(guildId);
    if (guildRole(id, env) === 'support') return normalizeInviteSettings({ ...INVITE_TRACKING_DEFAULT, enabled: false });
    let rowGuild = id;
    try {
        rowGuild = settingGuildId(id, INVITE_SETTING_KEY, env) || id;
    } catch {
        rowGuild = id;
    }
    return normalizeInviteSettings(resolve(rowGuild, INVITE_SETTING_KEY));
}

/** True when the feature is on; false (never throws) when the settings cannot be read. */
export function inviteTrackingOn(guildId, deps = {}) {
    try {
        return inviteSettings(guildId, deps).enabled;
    } catch {
        return false;
    }
}

/**
 * Is this join fake under the rule? Pure (the JS twin of FAKE_SQL, for the join log and tests).
 * accountCreatedAt / joinedAt / leftAt: Date | ms | null.
 */
export function isFakeJoin({ accountCreatedAt, joinedAt, leftAt = null }, { fakeAccountDays, fakeLeaveHours }) {
    const ms = (v) => (v == null ? null : v instanceof Date ? v.getTime() : Number.isFinite(Number(v)) ? Number(v) : Date.parse(v));
    const created = ms(accountCreatedAt);
    const joined = ms(joinedAt);
    const left = ms(leftAt);
    if (!Number.isFinite(joined)) return false;
    if (fakeAccountDays > 0 && Number.isFinite(created) && created > joined - fakeAccountDays * DAY_MS) return true;
    if (fakeLeaveHours > 0 && Number.isFinite(left) && left < joined + fakeLeaveHours * HOUR_MS) return true;
    return false;
}

/** Total from the parts; pure. */
export function inviteTotal({ invited = 0, left = 0, fake = 0, bonus = 0 }) {
    return invited - left - fake + bonus;
}

// $2 = fakeAccountDays, $3 = fakeLeaveHours, $4 = server resetAt (or NULL); x = invite_joins, r = invite_inviters.
const FAKE_SQL = `(($2::int > 0 AND x.account_created_at IS NOT NULL AND x.account_created_at > x.joined_at - make_interval(days => $2::int))
    OR ($3::int > 0 AND x.left_at IS NOT NULL AND x.left_at < x.joined_at + make_interval(hours => $3::int)))`;
const SINCE_SQL = `x.joined_at > GREATEST(COALESCE(r.reset_at, '-infinity'::timestamptz), COALESCE($4::timestamptz, '-infinity'::timestamptz))`;
const BONUS_SQL = `CASE WHEN $4::timestamptz IS NULL OR b.updated_at > $4::timestamptz THEN b.bonus ELSE 0 END`;

/** SQL of the per-inviter counts; `single` filters both sides to one inviter ($5). */
function countsSql(t, { single }) {
    const inviterFilter = single ? 'AND x.inviter_id = $5' : '';
    const bonusFilter = single ? 'AND b.user_id = $5' : '';
    return `WITH j AS (
        SELECT y.inviter_id AS user_id,
            COUNT(*) AS invited,
            COUNT(*) FILTER (WHERE NOT y.fake AND y.left_at IS NOT NULL) AS left_count,
            COUNT(*) FILTER (WHERE y.fake) AS fake_count
        FROM (
            SELECT x.inviter_id, x.left_at, ${FAKE_SQL} AS fake
            FROM ${t.invite_joins} x
            LEFT JOIN ${t.invite_inviters} r ON r.guild_id = x.guild_id AND r.user_id = x.inviter_id
            WHERE x.guild_id = $1 AND x.inviter_id IS NOT NULL AND x.counted ${inviterFilter} AND ${SINCE_SQL}
        ) y
        GROUP BY y.inviter_id
    ), bo AS (
        SELECT b.user_id, ${BONUS_SQL} AS bonus FROM ${t.invite_inviters} b WHERE b.guild_id = $1 ${bonusFilter}
    )
    SELECT COALESCE(j.user_id, bo.user_id) AS user_id,
        COALESCE(j.invited, 0)::int AS invited, COALESCE(j.left_count, 0)::int AS left_count,
        COALESCE(j.fake_count, 0)::int AS fake_count, COALESCE(bo.bonus, 0)::int AS bonus,
        (COALESCE(j.invited, 0) - COALESCE(j.left_count, 0) - COALESCE(j.fake_count, 0) + COALESCE(bo.bonus, 0))::int AS total
    FROM j FULL OUTER JOIN bo ON bo.user_id = j.user_id
    WHERE COALESCE(j.invited, 0) > 0 OR COALESCE(bo.bonus, 0) <> 0`;
}

const rowCounts = (r) => ({
    userId: r.user_id, invited: Number(r.invited) || 0, left: Number(r.left_count) || 0, fake: Number(r.fake_count) || 0,
    bonus: Number(r.bonus) || 0, total: Number(r.total) || 0,
});

const baseParams = (guildId, settings) => [String(guildId), settings.fakeAccountDays, settings.fakeLeaveHours, settings.resetAt ? new Date(settings.resetAt) : null];

/** One inviter's counts { invited, left, fake, bonus, total } (zeros when they invited nobody). */
export async function inviteCounts(guildId, userId, settings, { query = dbQuery, tables = pgConfig.tables } = {}) {
    if (!ID.test(String(userId))) throw new TypeError('inviteCounts: bad user id');
    const { rows } = await query(countsSql(tables, { single: true }), [...baseParams(guildId, settings), String(userId)]);
    return rows[0] ? rowCounts(rows[0]) : { userId: String(userId), invited: 0, left: 0, fake: 0, bonus: 0, total: 0 };
}

/** One page of the leaderboard (highest total first; ties by id). */
export async function inviteLeaderboard(guildId, settings, { page = 1, pageSize = LEADERBOARD_PAGE_SIZE, query = dbQuery, tables = pgConfig.tables } = {}) {
    const p = Math.max(1, Math.floor(Number(page) || 1));
    const { rows } = await query(`${countsSql(tables, { single: false })} ORDER BY total DESC, user_id ASC LIMIT $5 OFFSET $6`,
        [...baseParams(guildId, settings), pageSize, (p - 1) * pageSize]);
    return rows.map((r, i) => ({ rank: (p - 1) * pageSize + i + 1, ...rowCounts(r) }));
}

// The leaderboard costs one grouped query; cached 60 s per server, page and rule.
const boardCache = new BoundedMap(2000);

/** inviteLeaderboard through a 60-second cache. */
export async function cachedLeaderboard(guildId, settings, { page = 1, now = Date.now(), ...deps } = {}) {
    const key = `${guildId}:${page}:${settings.fakeAccountDays}:${settings.fakeLeaveHours}:${settings.resetAt || ''}`;
    const hit = boardCache.get(key);
    if (hit && hit.until > now) return hit.rows;
    const rows = await inviteLeaderboard(guildId, settings, { page, ...deps });
    boardCache.set(key, { rows, until: now + LEADERBOARD_CACHE_MS });
    return rows;
}

/** Drops a server's cached leaderboard pages (after a bonus change or a reset). */
export function forgetLeaderboard(guildId) {
    for (const key of [...boardCache.keys()]) if (key.startsWith(`${guildId}:`)) boardCache.delete(key);
}

export function resetInviteStatsCacheForTests() {
    boardCache.clear();
}

/** The members someone invited (newest first), with the fake / left marks. Staff only. */
export async function joinsByInviter(guildId, inviterId, settings, { limit = 25, query = dbQuery, tables = pgConfig.tables } = {}) {
    if (!ID.test(String(inviterId))) throw new TypeError('joinsByInviter: bad user id');
    const { rows } = await query(
        `SELECT x.user_id, x.invite_code, x.joined_at, x.left_at, x.counted, x.account_created_at,
                ${FAKE_SQL} AS fake, (${SINCE_SQL}) AS current
         FROM ${tables.invite_joins} x
         LEFT JOIN ${tables.invite_inviters} r ON r.guild_id = x.guild_id AND r.user_id = x.inviter_id
         WHERE x.guild_id = $1 AND x.inviter_id = $5
         ORDER BY x.joined_at DESC, x.id DESC LIMIT $6`,
        [...baseParams(guildId, settings), String(inviterId), limit]);
    return rows.map((r) => ({
        userId: r.user_id, code: r.invite_code || null, joinedAt: r.joined_at, leftAt: r.left_at, counted: r.counted,
        fake: Boolean(r.fake), current: Boolean(r.current),
    }));
}

/** The latest joins of the server (dashboard). */
export async function recentJoins(guildId, settings, { limit = 25, query = dbQuery, tables = pgConfig.tables } = {}) {
    const { rows } = await query(
        `SELECT x.user_id, x.inviter_id, x.invite_code, x.source, x.joined_at, x.left_at, x.counted, ${FAKE_SQL} AS fake
         FROM ${tables.invite_joins} x
         WHERE x.guild_id = $1
         ORDER BY x.joined_at DESC, x.id DESC LIMIT $4`,
        [String(guildId), settings.fakeAccountDays, settings.fakeLeaveHours, limit]);
    return rows.map((r) => ({
        userId: r.user_id, inviterId: r.inviter_id || null, code: r.invite_code || null, source: r.source,
        joinedAt: r.joined_at, leftAt: r.left_at, counted: r.counted, fake: Boolean(r.fake),
    }));
}
