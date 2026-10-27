// sessionStore.js — dashboard sessions.
//
// createPgSessionStore: the real store, table dashboard_sessions. Sessions survive a
// restart or Republish. Only a SHA-256 hash of the session id is stored, so a
// database leak does not hand out logins. A new id is issued on every login (the old
// one is deleted: rotation), sessions end after 12 h, and expired rows are deleted
// lazily (at most every 10 minutes, on a login).
//
// createMemorySessionStore: same async interface, in memory, for tests.
//
// A session: { id, idHash, userId, username, avatar, csrf, createdAt, expiresAt }.

import crypto from 'crypto';
import { SESSION_TTL_MS } from './security.js';

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
        userId: row.user_id,
        username: row.username || row.user_id,
        avatar: row.avatar || null,
        csrf: row.csrf,
        createdAt: new Date(row.created_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
        lastSeen: new Date(row.last_seen).getTime(),
    };
}

/** query(text, params) → { rows }: the enforcement pool helper (throws when the database is down). */
export function createPgSessionStore({ query, table = 'dashboard_sessions', ttlMs = SESSION_TTL_MS } = {}) {
    let lastCleanup = 0;

    async function cleanup(now = Date.now(), force = false) {
        if (!force && now - lastCleanup < CLEANUP_EVERY_MS) return 0;
        lastCleanup = now;
        const { rowCount } = await query(`DELETE FROM ${table} WHERE expires_at <= $1`, [new Date(now)]);
        return rowCount || 0;
    }

    async function create({ userId, username, avatar = null }, now = Date.now()) {
        await cleanup(now).catch(() => {});
        const { id, csrf } = newIds();
        const { rows: [row] } = await query(
            `INSERT INTO ${table} (id_hash, user_id, username, avatar, csrf, created_at, expires_at, last_seen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $6) RETURNING *`,
            [hashSessionId(id), userId, clip(username, 100), clip(avatar, 100), csrf, new Date(now), new Date(now + ttlMs)]
        );
        return toSession(id, row);
    }

    async function get(id, now = Date.now()) {
        if (!id) return null;
        const { rows: [row] } = await query(
            `SELECT * FROM ${table} WHERE id_hash = $1 AND expires_at > $2`, [hashSessionId(id), new Date(now)]);
        if (!row) return null;
        const session = toSession(id, row);
        if (now - session.lastSeen > TOUCH_EVERY_MS) {
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

    return { create, get, destroy, rotate, cleanup };
}

export function createMemorySessionStore({ ttlMs = SESSION_TTL_MS } = {}) {
    const rows = new Map(); // idHash → row

    async function create({ userId, username, avatar = null }, now = Date.now()) {
        const { id, csrf } = newIds();
        const row = {
            id_hash: hashSessionId(id), user_id: userId, username: clip(username, 100), avatar: clip(avatar, 100), csrf,
            created_at: now, expires_at: now + ttlMs, last_seen: now,
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
        row.last_seen = now;
        return toSession(id, row);
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

    return { create, get, destroy, rotate, cleanup, size: () => rows.size, hashes: () => [...rows.keys()] };
}
