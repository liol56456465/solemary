// voiceStore.js — the voice_activity table (schema v14): per server and member, the total
// counted voice time (voice_seconds), the XP voice gave (voice_xp), and the counted minutes
// of the current UTC day (day, day_minutes) for the daily cap. Only minutes are stored: never
// who someone talked with, never audio.
//
// Direct Postgres (services/enforcement/db.js): every function throws on a database error
// (data layer rule: reads never fall back to defaults on an error). There is no memory fallback.

import { pgConfig } from '../../config/database/postgres.js';
import { query as defaultQuery, withTransaction as defaultTransaction } from '../enforcement/db.js';

const table = () => pgConfig.tables.voice_activity;

/** 'YYYY-MM-DD' of a time in UTC (the cap's day). */
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Counted minutes today (UTC) for one member; 0 without a row or when the row is from another day. */
export async function readDayMinutes(guildId, userId, day, { query = defaultQuery } = {}) {
    const { rows } = await query(
        `SELECT day_minutes FROM ${table()} WHERE guild_id = $1 AND user_id = $2 AND day = $3::date`,
        [guildId, userId, day],
    );
    return rows[0] ? Number(rows[0].day_minutes) || 0 : 0;
}

/**
 * Adds one counted minute (`seconds` of voice time and `xp` voice XP) for a member. A row
 * from an earlier day starts the day count again at 1. The guilds and users rows are made first
 * (foreign keys), like the other row writers. Returns the day's counted minutes after the write.
 * Throws on any error (nothing is half written: one transaction).
 */
export async function upsertMinutes(guildId, userId, { day, seconds = 60, xp = 0 }, { transaction = defaultTransaction } = {}) {
    return transaction(async (client) => {
        await client.query(`INSERT INTO ${pgConfig.tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [guildId]);
        await client.query(`INSERT INTO ${pgConfig.tables.users} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [userId]);
        const t = table();
        const { rows } = await client.query(
            `INSERT INTO ${t} (guild_id, user_id, voice_seconds, voice_xp, day, day_minutes, updated_at)
             VALUES ($1, $2, $3, $4, $5::date, 1, NOW())
             ON CONFLICT (guild_id, user_id) DO UPDATE SET
                voice_seconds = ${t}.voice_seconds + EXCLUDED.voice_seconds,
                voice_xp = ${t}.voice_xp + EXCLUDED.voice_xp,
                day_minutes = CASE WHEN ${t}.day = EXCLUDED.day THEN LEAST(${t}.day_minutes + 1, 1440) ELSE 1 END,
                day = EXCLUDED.day,
                updated_at = NOW()
             RETURNING day_minutes`,
            [guildId, userId, Math.max(0, Math.floor(seconds)), Math.max(0, Math.floor(xp)), day],
        );
        if (!rows[0]) throw new Error('voice_activity upsert returned no row');
        return Number(rows[0].day_minutes);
    });
}

/** Adds XP that addXp gave to the member's voice_xp total (after upsertMinutes). Throws on error. */
export async function addVoiceXp(guildId, userId, xp, { query = defaultQuery } = {}) {
    const { rowCount } = await query(
        `UPDATE ${table()} SET voice_xp = voice_xp + $3, updated_at = NOW() WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, Math.max(0, Math.floor(xp))],
    );
    if (rowCount !== 1) throw new Error('voice_activity row missing for the XP update');
}

/** { seconds, xp } for one member in one server, or null when nothing is stored. */
export async function readVoiceStats(guildId, userId, { query = defaultQuery } = {}) {
    const { rows } = await query(
        `SELECT voice_seconds, voice_xp FROM ${table()} WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId],
    );
    return rows[0] ? { seconds: Number(rows[0].voice_seconds) || 0, xp: Number(rows[0].voice_xp) || 0 } : null;
}

/** One page of the voice leaderboard (most voice time first), the shape getLeaderboard reads. */
export async function topVoiceRows(guildId, limit = 10, offset = 0, { query = defaultQuery } = {}) {
    const { rows } = await query(
        `SELECT user_id, voice_seconds, voice_xp FROM ${table()}
         WHERE guild_id = $1 AND voice_seconds > 0
         ORDER BY voice_seconds DESC, user_id
         LIMIT $2 OFFSET $3`,
        [guildId, limit, offset],
    );
    return rows.map((row) => ({ userId: row.user_id, voiceSeconds: Number(row.voice_seconds) || 0, voiceXp: Number(row.voice_xp) || 0 }));
}

/** Deletes one member's voice row in one server (level reset, /wipedata). Throws on error. */
export async function deleteVoiceActivity(guildId, userId, { query = defaultQuery } = {}) {
    const { rowCount } = await query(`DELETE FROM ${table()} WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
    return rowCount > 0;
}
