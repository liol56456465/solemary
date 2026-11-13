// sessionStore.js — dashboard sessions (and the website's member sessions, same shape).
//
// createPgSessionStore: the real store, table dashboard_sessions (or member_sessions). Sessions
// survive a restart or Republish. Only a SHA-256 hash of the session id is stored, so a
// database leak does not hand out logins. A new id is issued on every login (the old one is
// deleted: rotation), and expired rows are deleted lazily (at most every 10 minutes, on a
// login) and hourly (pruneExpiredSessions, app.js).
//
// Sliding expiry (no extra column): expires_at is the session's end. A session ends after
// `idleMs` (7 days) without use and at the latest `maxAgeMs` (30 days) after created_at. A read
// that would move expires_at forward by at least `renewEveryMs` (1 hour) moves it to
// min(now + idleMs, created_at + maxAgeMs) and marks the session `renewed`, so the caller
// re-sends the cookie with the new Max-Age (security.js sessionCookieAge). The legacy option
// `ttlMs` (older tests) means a fixed lifetime: idle = max = ttlMs.
//
// createMemorySessionStore: same async interface, in memory, for tests.
//
// A session: { id, idHash, userId, username, avatar, csrf, flash, createdAt, expiresAt, lastSeen,
// accountId, renewed }.
// accountId: only in member_sessions (a Mewvo account login on /me, schema v7; the store is
// made with { accounts: true }); userId is then the linked Discord id, or null before linking.
// `flash` is a one-shot message shown on the next page after a saved form
// (setFlash(id, text); setFlash(id, null) clears it).
// create(user, now): user.authAt (ms, optional) is when the person really authenticated (a
// website session handed over to the dashboard, ssoHandoff.js): created_at is set to it, so the
// 30-day cap and the Owner area's "login younger than 12 h" count from that login.

import crypto from 'crypto';
import { SESSION_IDLE_MS, SESSION_MAX_AGE_MS, SESSION_RENEW_MS } from './security.js';
import { pgConfig } from '../../config/database/postgres.js';

const CLEANUP_EVERY_MS = 10 * 60 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export function hashSessionId(id) {
    return crypto.createHash('sha256').update(String(id)).digest('hex');
}

function newIds() {
    return {
        id: crypto.randomBytes(32).toString('base64url'),
        csrf: crypto.randomBytes(24).toString('base64url'),
    };
}

const clip = (value, max) => (value == null ? null : String(value).slice(0, max));

function toSession(id, row) {
    return {
        id,
        idHash: row.id_hash,
        userId: row.user_id || null,
        username: row.username || row.user_id,
        accountId: row.account_id != null ? String(row.account_id) : null,
        avatar: row.avatar || null,
        csrf: row.csrf,
        flash: row.flash || null,
        createdAt: new Date(row.created_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
        lastSeen: new Date(row.last_seen).getTime(),
        renewed: false,
    };
}

/** The lifetime rules: { idleMs, maxAgeMs, renewEveryMs }; a legacy `ttlMs` is a fixed lifetime. */
export function sessionLifetime({ ttlMs = null, idleMs = null, maxAgeMs = null, renewEveryMs = null } = {}) {
    if (ttlMs != null && idleMs == null && maxAgeMs == null) return { idleMs: ttlMs, maxAgeMs: ttlMs, renewEveryMs: renewEveryMs ?? SESSION_RENEW_MS };
    return { idleMs: idleMs ?? SESSION_IDLE_MS, maxAgeMs: maxAgeMs ?? SESSION_MAX_AGE_MS, renewEveryMs: renewEveryMs ?? SESSION_RENEW_MS };
}

/** Pure: the created_at of a new session (authAt when it is a plausible past time, else now). */
function createdAtFor(authAt, now, maxAgeMs) {
    const at = Number(authAt);
    return Number.isFinite(at) && at <= now && now - at < maxAgeMs ? at : now;
}

/** Pure: the end a session gets when used at `now`: min(now + idle, created + max). */
export function slidingExpiry(createdAt, now, { idleMs, maxAgeMs }) {
    return Math.min(now + idleMs, createdAt + maxAgeMs);
}

/** Pure: the new expires_at when this use should renew the session, else null. */
export function renewalFor(session, now, life) {
    const target = slidingExpiry(session.createdAt, now, life);
    return target - session.expiresAt >= life.renewEveryMs ? target : null;
}

/** query(text, params) → { rows }: the enforcement pool helper (throws when the database is down). */
export function createPgSessionStore({ query, table = 'dashboard_sessions', accounts = false, ...lifetime } = {}) {
    const life = sessionLifetime(lifetime);
    let lastCleanup = 0;

    async function cleanup(now = Date.now(), force = false) {
        if (!force && now - lastCleanup < CLEANUP_EVERY_MS) return 0;
        lastCleanup = now;
        const { rowCount } = await query(`DELETE FROM ${table} WHERE expires_at <= $1`, [new Date(now)]);
        return rowCount || 0;
    }

    async function create({ userId, username, avatar = null, accountId = null, authAt = null }, now = Date.now()) {
        await cleanup(now).catch(() => {});
        const { id, csrf } = newIds();
        const createdAt = createdAtFor(authAt, now, life.maxAgeMs);
        const params = [hashSessionId(id), userId || null, clip(username, 100), clip(avatar, 100), csrf, new Date(createdAt),
            new Date(slidingExpiry(createdAt, now, life)), new Date(now)];
        const { rows: [row] } = accounts
            ? await query(
                `INSERT INTO ${table} (id_hash, user_id, username, avatar, csrf, created_at, expires_at, last_seen, account_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [...params, accountId || null])
            : await query(
                `INSERT INTO ${table} (id_hash, user_id, username, avatar, csrf, created_at, expires_at, last_seen)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, params);
        return toSession(id, row);
    }

    /** Ends every session of a Mewvo account (password reset, unlink, delete), except `keepId`. */
    async function destroyForAccount(accountId, keepId = null) {
        if (!accounts || !accountId) return 0;
        const { rowCount } = await query(`DELETE FROM ${table} WHERE account_id = $1 AND id_hash <> $2`, [String(accountId), keepId ? hashSessionId(keepId) : '']);
        return rowCount || 0;
    }

    /** Ends every session of a Discord user id ("Log out on all devices"), except `keepId`. */
    async function destroyForUser(userId, keepId = null) {
        if (!userId) return 0;
        const { rowCount } = await query(`DELETE FROM ${table} WHERE user_id = $1 AND id_hash <> $2`, [String(userId), keepId ? hashSessionId(keepId) : '']);
        return rowCount || 0;
    }

    async function get(id, now = Date.now()) {
        if (!id) return null;
        const { rows: [row] } = await query(
            `SELECT * FROM ${table} WHERE id_hash = $1 AND expires_at > $2`, [hashSessionId(id), new Date(now)]);
        if (!row) return null;
        const session = toSession(id, row);
        const renewTo = renewalFor(session, now, life);
        if (renewTo !== null) {
            // Only while the row still exists and has not been renewed meanwhile (parallel requests).
            const { rowCount } = await query(
                `UPDATE ${table} SET expires_at = $3, last_seen = $2 WHERE id_hash = $1 AND expires_at > $2 AND expires_at < $3`,
                [row.id_hash, new Date(now), new Date(renewTo)]).catch(() => ({ rowCount: 0 }));
            if (rowCount > 0) Object.assign(session, { expiresAt: renewTo, lastSeen: now, renewed: true });
        } else if (now - session.lastSeen > TOUCH_EVERY_MS) {
            await query(`UPDATE ${table} SET last_seen = $2 WHERE id_hash = $1`, [row.id_hash, new Date(now)]).catch(() => {});
        }
        return session;
    }

    async function destroy(id) {
        if (!id) return false;
        const { rowCount } = await query(`DELETE FROM ${table} WHERE id_hash = $1`, [hashSessionId(id)]);
        return rowCount > 0;
    }

    /** Login: drops the browser's previous session (if any) and issues a new id. */
    async function rotate(oldId, user, now = Date.now()) {
        if (oldId) await destroy(oldId);
        return create(user, now);
    }

    /** Stores (or with null clears) the one-shot message of a session. */
    async function setFlash(id, text) {
        if (!id) return false;
        const { rowCount } = await query(`UPDATE ${table} SET flash = $2 WHERE id_hash = $1`, [hashSessionId(id), clip(text, 1000)]);
        return rowCount > 0;
    }

    return { create, get, destroy, rotate, cleanup, setFlash, destroyForAccount, destroyForUser, lifetime: life };
}

export function createMemorySessionStore(lifetime = {}) {
    const life = sessionLifetime(lifetime);
    const rows = new Map(); // idHash → row

    async function create({ userId, username, avatar = null, accountId = null, authAt = null }, now = Date.now()) {
        const { id, csrf } = newIds();
        const createdAt = createdAtFor(authAt, now, life.maxAgeMs);
        const row = {
            id_hash: hashSessionId(id), user_id: userId || null, username: clip(username, 100), avatar: clip(avatar, 100), csrf,
            created_at: createdAt, expires_at: slidingExpiry(createdAt, now, life), last_seen: now, account_id: accountId || null,
        };
        rows.set(row.id_hash, row);
        return toSession(id, row);
    }

    async function get(id, now = Date.now()) {
        const row = id ? rows.get(hashSessionId(id)) : null;
        if (!row) return null;
        if (row.expires_at <= now) {
            rows.delete(row.id_hash);
            return null;
        }
        const session = toSession(id, row);
        const renewTo = renewalFor(session, now, life);
        if (renewTo !== null) {
            row.expires_at = renewTo;
            Object.assign(session, { expiresAt: renewTo, renewed: true });
        }
        row.last_seen = now;
        session.lastSeen = now;
        return session;
    }

    async function destroy(id) {
        return rows.delete(hashSessionId(id));
    }

    async function rotate(oldId, user, now = Date.now()) {
        if (oldId) await destroy(oldId);
        return create(user, now);
    }

    async function cleanup(now = Date.now()) {
        let removed = 0;
        for (const [hash, row] of rows) if (row.expires_at <= now) { rows.delete(hash); removed += 1; }
        return removed;
    }

    async function setFlash(id, text) {
        const row = id ? rows.get(hashSessionId(id)) : null;
        if (!row) return false;
        row.flash = clip(text, 1000);
        return true;
    }

    function destroyWhere(match, keepId) {
        let removed = 0;
        const keep = keepId ? hashSessionId(keepId) : null;
        for (const [hash, row] of rows) {
            if (match(row) && hash !== keep) { rows.delete(hash); removed += 1; }
        }
        return removed;
    }

    async function destroyForAccount(accountId, keepId = null) {
        return destroyWhere((row) => row.account_id && String(row.account_id) === String(accountId), keepId);
    }

    async function destroyForUser(userId, keepId = null) {
        if (!userId) return 0;
        return destroyWhere((row) => row.user_id && String(row.user_id) === String(userId), keepId);
    }

    return {
        create, get, destroy, rotate, cleanup, setFlash, destroyForAccount, destroyForUser, lifetime: life,
        size: () => rows.size, hashes: () => [...rows.keys()],
    };
}

/**
 * Deletes expired sessions from both login tables (dashboard and My record), so they are
 * gone when the Privacy Policy says (7 days unused, 30 days at most), not only when someone
 * logs in again. Hourly from app.js. Returns the number deleted.
 */
export async function pruneExpiredSessions(query, tables = [pgConfig.tables.dashboard_sessions, pgConfig.tables.member_sessions], now = new Date()) {
    let total = 0;
    for (const table of tables) {
        const { rowCount } = await query(`DELETE FROM ${table} WHERE expires_at <= $1`, [now]);
        total += rowCount || 0;
    }
    return total;
}
