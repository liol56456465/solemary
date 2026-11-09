// inviteStore.js — the invite tracking tables (schema v14), every SQL statement in one place.
//
//   invite_tracking  the per-code cache (code → creator, uses); deleted_at marks a code Discord
//                    deleted. invite_code is VARCHAR(20): longer codes (some vanity URLs) are
//                    never written here, only to invite_joins.invite_code (VARCHAR(32)).
//   invite_joins     one row per member join; `counted` FALSE = a repeat rejoin through the same
//                    inviter (owner decision 3: rejoins count once per inviter).
//   invite_inviters  per inviter: staff bonus and reset_at (a reset never deletes joins).
//
// Data-layer rules: every read and write throws on a database error (callers say "database not
// responding, nothing was changed"); nothing here returns defaults on an error. `deps.query`
// (text, params) → { rows, rowCount } replaces the pool in tests.

import { pgConfig } from '../../config/database/postgres.js';
import { query as dbQuery, withTransaction as dbTransaction } from '../enforcement/db.js';

export const TRACKING_CODE_MAX = 20; // invite_tracking.invite_code
export const JOIN_CODE_MAX = 32; // invite_joins.invite_code
export const BONUS_LIMIT = 100000; // invite_inviters CHECK
const ID = /^\d{17,20}$/;

const tables = () => pgConfig.tables;
const q = (deps) => deps?.query || dbQuery;

function requireId(value, what) {
    const id = String(value ?? '');
    if (!ID.test(id)) throw new TypeError(`inviteStore: bad ${what}`);
    return id;
}

/** A code that fits invite_joins (else null: never cut a code into a different one). */
export function joinCode(code) {
    return typeof code === 'string' && code && code.length <= JOIN_CODE_MAX ? code : null;
}

/** invite_joins / invite_tracking reference guilds(id): make sure the row is there (idempotent). */
export async function ensureGuildRow(guildId, deps = {}) {
    await q(deps)(`INSERT INTO ${tables().guilds} (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [requireId(guildId, 'guild id')]);
}

// ── invite_tracking (code cache) ──────────────────────────────────────────

/**
 * Stores the server's current codes (from a full fetch): upserts each code that fits
 * VARCHAR(20) and marks every other stored code of the server as deleted. One transaction.
 * codes: [{ code, inviterId, uses, maxUses, expiresAt }].
 */
export async function saveCodes(guildId, codes, deps = {}) {
    const id = requireId(guildId, 'guild id');
    const fit = (codes || []).filter((c) => typeof c?.code === 'string' && c.code && c.code.length <= TRACKING_CODE_MAX);
    const run = async (query) => {
        await query(`INSERT INTO ${tables().guilds} (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [id]);
        if (fit.length) {
            await query(
                `INSERT INTO ${tables().invite_tracking} (guild_id, inviter_id, invite_code, uses, data, updated_at, deleted_at)
                 SELECT $1, x.inviter_id, x.code, x.uses, jsonb_build_object('maxUses', x.max_uses, 'expiresAt', x.expires_at), NOW(), NULL
                 FROM unnest($2::varchar[], $3::varchar[], $4::int[], $5::int[], $6::text[]) AS x(code, inviter_id, uses, max_uses, expires_at)
                 ON CONFLICT (guild_id, invite_code) DO UPDATE
                    SET inviter_id = EXCLUDED.inviter_id, uses = EXCLUDED.uses, data = EXCLUDED.data, updated_at = NOW(), deleted_at = NULL`,
                [id, fit.map((c) => c.code), fit.map((c) => (c.inviterId && ID.test(c.inviterId) ? c.inviterId : null)),
                    fit.map((c) => Math.max(0, Number(c.uses) || 0)), fit.map((c) => Math.max(0, Number(c.maxUses) || 0)),
                    fit.map((c) => (Number.isFinite(c.expiresAt) ? new Date(c.expiresAt).toISOString() : null))]);
        }
        await query(
            `UPDATE ${tables().invite_tracking} SET deleted_at = NOW(), updated_at = NOW()
             WHERE guild_id = $1 AND deleted_at IS NULL AND NOT (invite_code = ANY($2::varchar[]))`,
            [id, fit.map((c) => c.code)]);
    };
    if (deps.query) return run(deps.query);
    return (deps.withTransaction || dbTransaction)((client) => run((text, params) => client.query(text, params)));
}

/** One new or changed code (inviteCreate, a join that used it). Codes over 20 characters are skipped. */
export async function saveCode(guildId, { code, inviterId = null, uses = 0, maxUses = 0, expiresAt = null }, deps = {}) {
    const id = requireId(guildId, 'guild id');
    if (typeof code !== 'string' || !code || code.length > TRACKING_CODE_MAX) return false;
    await ensureGuildRow(id, deps);
    await q(deps)(
        `INSERT INTO ${tables().invite_tracking} (guild_id, inviter_id, invite_code, uses, data, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, jsonb_build_object('maxUses', $5::int, 'expiresAt', $6::text), NOW(), NULL)
         ON CONFLICT (guild_id, invite_code) DO UPDATE
            SET inviter_id = EXCLUDED.inviter_id, uses = EXCLUDED.uses, data = EXCLUDED.data, updated_at = NOW(), deleted_at = NULL`,
        [id, inviterId && ID.test(inviterId) ? inviterId : null, code, Math.max(0, Number(uses) || 0), Math.max(0, Number(maxUses) || 0),
            Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null]);
    return true;
}

/** Discord deleted a code (inviteDelete): kept, marked deleted. */
export async function markCodeDeleted(guildId, code, deps = {}) {
    const id = requireId(guildId, 'guild id');
    if (typeof code !== 'string' || !code || code.length > TRACKING_CODE_MAX) return 0;
    const result = await q(deps)(
        `UPDATE ${tables().invite_tracking} SET deleted_at = NOW(), updated_at = NOW() WHERE guild_id = $1 AND invite_code = $2 AND deleted_at IS NULL`,
        [id, code]);
    return result?.rowCount || 0;
}

/** The stored codes of a server (dashboard, when the live cache is not loaded): newest first. */
export async function listStoredCodes(guildId, { limit = 50 } = {}, deps = {}) {
    const { rows } = await q(deps)(
        `SELECT invite_code AS code, inviter_id, uses, data, deleted_at, updated_at FROM ${tables().invite_tracking}
         WHERE guild_id = $1 ORDER BY (deleted_at IS NULL) DESC, uses DESC, invite_code LIMIT $2`,
        [requireId(guildId, 'guild id'), limit]);
    return rows.map((r) => ({
        code: r.code, inviterId: r.inviter_id || null, uses: Number(r.uses) || 0, maxUses: Number(r.data?.maxUses) || 0,
        deleted: Boolean(r.deleted_at),
    }));
}

// ── invite_joins ──────────────────────────────────────────────────────────

/**
 * Records one join. Any still-open row of this member in this server (they left while Mewvo was
 * offline) is closed at this join's time. counted is FALSE when the member already has a counted
 * join through the same inviter since that inviter's reset (and the server's resetAt).
 * Returns { id, counted }.
 */
export async function insertJoin({
    guildId, userId, inviterId = null, code = null, source, accountCreatedAt = null, joinedAt = new Date(), serverResetAt = null,
}, deps = {}) {
    const gid = requireId(guildId, 'guild id');
    const uid = requireId(userId, 'user id');
    const inviter = inviterId && ID.test(String(inviterId)) ? String(inviterId) : null;
    const t = tables();
    await ensureGuildRow(gid, deps);
    const { rows } = await q(deps)(
        `WITH closed AS (
             UPDATE ${t.invite_joins} SET left_at = $7 WHERE guild_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING id
         )
         INSERT INTO ${t.invite_joins} (guild_id, user_id, inviter_id, invite_code, source, account_created_at, joined_at, counted)
         SELECT $1, $2, $3::varchar, $4, $5, $6, $7,
             CASE WHEN $3::varchar IS NULL THEN TRUE ELSE NOT EXISTS (
                 SELECT 1 FROM ${t.invite_joins} p
                 LEFT JOIN ${t.invite_inviters} r ON r.guild_id = p.guild_id AND r.user_id = p.inviter_id
                 WHERE p.guild_id = $1 AND p.user_id = $2 AND p.inviter_id = $3::varchar AND p.counted
                   AND p.joined_at > GREATEST(COALESCE(r.reset_at, '-infinity'::timestamptz), COALESCE($8::timestamptz, '-infinity'::timestamptz))
             ) END
         RETURNING id, counted`,
        [gid, uid, inviter, joinCode(code), source, accountCreatedAt ? new Date(accountCreatedAt) : null, new Date(joinedAt), serverResetAt ? new Date(serverResetAt) : null]);
    return { id: rows[0]?.id ?? null, counted: rows[0]?.counted !== false };
}

/**
 * The member left: stamps left_at on their open join rows. Returns the latest of them
 * ({ inviterId, code, source, joinedAt }) or null when there was none.
 */
export async function stampLeft(guildId, userId, leftAt = new Date(), deps = {}) {
    const { rows } = await q(deps)(
        `UPDATE ${tables().invite_joins} SET left_at = $3
         WHERE guild_id = $1 AND user_id = $2 AND left_at IS NULL
         RETURNING inviter_id, invite_code, source, joined_at`,
        [requireId(guildId, 'guild id'), requireId(userId, 'user id'), new Date(leftAt)]);
    if (!rows.length) return null;
    const latest = rows.reduce((a, b) => (new Date(b.joined_at) > new Date(a.joined_at) ? b : a));
    return { inviterId: latest.inviter_id || null, code: latest.invite_code || null, source: latest.source, joinedAt: latest.joined_at };
}

/**
 * Leave reconcile (inviteReconcile.js): one page of the server's open join rows (left_at IS NULL,
 * counted or not) that joined more than `minAgeHours` ago, by id after `afterId`. [{ id, userId }].
 */
export async function listOpenJoins(guildId, { minAgeHours, afterId = 0, limit = 5000 } = {}, deps = {}) {
    const { rows } = await q(deps)(
        `SELECT id, user_id FROM ${tables().invite_joins}
         WHERE guild_id = $1 AND left_at IS NULL AND joined_at < NOW() - make_interval(hours => $2::int) AND id > $3::bigint
         ORDER BY id LIMIT $4`,
        [requireId(guildId, 'guild id'), Math.max(0, Math.floor(Number(minAgeHours) || 0)), String(afterId || 0), limit]);
    return rows.map((r) => ({ id: String(r.id), userId: r.user_id }));
}

/**
 * Leave reconcile: stamps left_at = NOW() on the given open rows of this server (the real leave
 * time is unknown). The age condition is repeated so a reconciled row is never a "quick leave"
 * (see inviteReconcile.js). Returns the number of rows closed; throws on a database error.
 */
export async function closeOpenJoins(guildId, ids, { minAgeHours } = {}, deps = {}) {
    const list = [...new Set((ids || []).map(String).filter((id) => /^\d{1,19}$/.test(id)))];
    if (!list.length) return 0;
    const result = await q(deps)(
        `UPDATE ${tables().invite_joins} SET left_at = NOW()
         WHERE guild_id = $1 AND id = ANY($2::bigint[]) AND left_at IS NULL
           AND joined_at < NOW() - make_interval(hours => $3::int)`,
        [requireId(guildId, 'guild id'), list, Math.max(0, Math.floor(Number(minAgeHours) || 0))]);
    if (!result || typeof result.rowCount !== 'number') throw new Error('invite_joins leave reconcile: no result from the database');
    return result.rowCount;
}

/** The member's latest join row in this server, or null. */
export async function latestJoin(guildId, userId, deps = {}) {
    const { rows } = await q(deps)(
        `SELECT inviter_id, invite_code, source, account_created_at, joined_at, left_at, counted FROM ${tables().invite_joins}
         WHERE guild_id = $1 AND user_id = $2 ORDER BY joined_at DESC, id DESC LIMIT 1`,
        [requireId(guildId, 'guild id'), requireId(userId, 'user id')]);
    const r = rows[0];
    return r ? {
        inviterId: r.inviter_id || null, code: r.invite_code || null, source: r.source, accountCreatedAt: r.account_created_at,
        joinedAt: r.joined_at, leftAt: r.left_at, counted: r.counted,
    } : null;
}

// ── invite_inviters (bonus, reset) ────────────────────────────────────────

/**
 * Adds `delta` to an inviter's bonus (negative removes). A bonus set before the server-wide
 * reset counts as 0. Returns the new bonus. Throws a RangeError past ±100,000 (nothing changed).
 */
export async function changeBonus(guildId, userId, delta, { actorId = null, serverResetAt = null } = {}, deps = {}) {
    const gid = requireId(guildId, 'guild id');
    const uid = requireId(userId, 'user id');
    const step = Number(delta);
    if (!Number.isInteger(step) || step === 0) throw new RangeError('bonus change must be a whole number');
    await ensureGuildRow(gid, deps);
    let result;
    try {
        result = await q(deps)(
            `INSERT INTO ${tables().invite_inviters} AS i (guild_id, user_id, bonus, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (guild_id, user_id) DO UPDATE
                SET bonus = CASE WHEN $5::timestamptz IS NOT NULL AND i.updated_at <= $5::timestamptz THEN 0 ELSE i.bonus END + EXCLUDED.bonus,
                    updated_by = EXCLUDED.updated_by, updated_at = NOW()
             RETURNING bonus`,
            [gid, uid, step, actorId && ID.test(String(actorId)) ? String(actorId) : null, serverResetAt ? new Date(serverResetAt) : null]);
    } catch (error) {
        if (error?.code === '23514') throw Object.assign(new RangeError('bonus out of range'), { code: 'bonusRange' });
        throw error;
    }
    return Number(result.rows[0]?.bonus ?? 0);
}

/** Resets one inviter: only joins after now count, bonus back to 0. Nothing is deleted. */
export async function resetInviter(guildId, userId, { actorId = null, at = new Date() } = {}, deps = {}) {
    const gid = requireId(guildId, 'guild id');
    await ensureGuildRow(gid, deps);
    await q(deps)(
        `INSERT INTO ${tables().invite_inviters} (guild_id, user_id, bonus, reset_at, updated_by, updated_at)
         VALUES ($1, $2, 0, $3, $4, NOW())
         ON CONFLICT (guild_id, user_id) DO UPDATE SET bonus = 0, reset_at = EXCLUDED.reset_at, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [gid, requireId(userId, 'user id'), new Date(at), actorId && ID.test(String(actorId)) ? String(actorId) : null]);
}

// ── /wipedata (owner decision 4) ──────────────────────────────────────────

/**
 * The member's own invite data in one server: their join rows and their invite_inviters row
 * are deleted; in other members' rows (and the code cache) they are blanked as the inviter.
 * One transaction: all or nothing.
 */
export async function wipeInviteData(guildId, userId, deps = {}) {
    const gid = requireId(guildId, 'guild id');
    const uid = requireId(userId, 'user id');
    const t = tables();
    const run = async (query) => {
        await query(`DELETE FROM ${t.invite_joins} WHERE guild_id = $1 AND user_id = $2`, [gid, uid]);
        await query(`UPDATE ${t.invite_joins} SET inviter_id = NULL WHERE guild_id = $1 AND inviter_id = $2`, [gid, uid]);
        await query(`DELETE FROM ${t.invite_inviters} WHERE guild_id = $1 AND user_id = $2`, [gid, uid]);
        await query(`UPDATE ${t.invite_tracking} SET inviter_id = NULL WHERE guild_id = $1 AND inviter_id = $2`, [gid, uid]);
    };
    if (deps.query) return run(deps.query);
    return (deps.withTransaction || dbTransaction)((client) => run((text, params) => client.query(text, params)));
}
