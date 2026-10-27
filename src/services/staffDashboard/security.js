// security.js — signing, OAuth state, sessions, cookies and rate limits for the
// staff dashboard. Pure apart from crypto randomness and the in-memory maps.
//
// Sessions live only in this process (a restart logs everyone out). The browser gets
// an opaque random id plus its HMAC (SESSION_SECRET); no tokens or user data.

import crypto from 'crypto';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;
export const SESSION_COOKIE = 'meowist_staff';
export const STATE_COOKIE = 'meowist_staff_state';
export const MIN_SECRET_LENGTH = 32;
const MAX_SESSIONS = 500;
const SNOWFLAKE = /^\d{17,20}$/;

export function isSnowflake(value) {
    return typeof value === 'string' && SNOWFLAKE.test(value);
}

export function hmac(value, secret) {
    return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url');
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** "<value>.<hmac>" */
export function signValue(value, secret) {
    return `${value}.${hmac(value, secret)}`;
}

/** The value of a signed string, or null when the signature does not match. */
export function verifySignedValue(signed, secret) {
    const text = String(signed || '');
    const dot = text.lastIndexOf('.');
    if (dot <= 0) return null;
    const value = text.slice(0, dot);
    return safeEqual(text.slice(dot + 1), hmac(value, secret)) ? value : null;
}

// ── OAuth state: signed, expiring, single use, bound to the browser by a nonce cookie ──

/** { state, nonce }: put `nonce` in the state cookie, `state` in the authorize URL. */
export function createState(secret, now = Date.now()) {
    const nonce = crypto.randomBytes(16).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ n: nonce, e: now + STATE_TTL_MS })).toString('base64url');
    return { state: signValue(payload, secret), nonce };
}

export function createStateStore() {
    const used = new Map(); // nonce → expiry
    return {
        /**
         * True for a correctly signed, unexpired, unused state whose nonce matches the
         * browser's cookie. Marks it used.
         */
        consume(state, cookieNonce, secret, now = Date.now()) {
            const payload = verifySignedValue(state, secret);
            if (!payload) return false;
            let data;
            try {
                data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            } catch {
                return false;
            }
            for (const [nonce, expiresAt] of used) if (expiresAt <= now) used.delete(nonce);
            if (!data?.n || !(data.e > now) || used.has(data.n)) return false;
            if (!cookieNonce || !safeEqual(data.n, cookieNonce)) return false;
            used.set(data.n, data.e);
            return true;
        },
        size: () => used.size,
    };
}

// ── Sessions ──────────────────────────────────────────────────────────────

export function createSessionStore({ ttlMs = SESSION_TTL_MS, max = MAX_SESSIONS } = {}) {
    const sessions = new Map(); // id → { id, userId, username, csrf, createdAt, expiresAt, hits }

    const prune = (now) => {
        for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
        while (sessions.size > max) sessions.delete(sessions.keys().next().value);
    };

    return {
        create({ userId, username }, now = Date.now()) {
            prune(now);
            const session = {
                id: crypto.randomBytes(32).toString('base64url'),
                userId,
                username: String(username || '').slice(0, 100),
                csrf: crypto.randomBytes(16).toString('base64url'),
                createdAt: now,
                expiresAt: now + ttlMs,
                hits: [],
            };
            sessions.set(session.id, session);
            return session;
        },
        get(id, now = Date.now()) {
            const session = sessions.get(id);
            if (!session) return null;
            if (session.expiresAt <= now) {
                sessions.delete(id);
                return null;
            }
            return session;
        },
        destroy(id) {
            return sessions.delete(id);
        },
        size: () => sessions.size,
    };
}

/** Sliding-window rate limit kept on the session: true when this request is allowed. */
export function allowRequest(session, { limit = 60, windowMs = 60 * 1000 } = {}, now = Date.now()) {
    session.hits = (session.hits || []).filter((at) => now - at < windowMs);
    if (session.hits.length >= limit) return false;
    session.hits.push(now);
    return true;
}

// ── Cookies ───────────────────────────────────────────────────────────────

export function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (!name || Object.hasOwn(out, name)) continue;
        try {
            out[name] = decodeURIComponent(value);
        } catch {
            out[name] = value;
        }
    }
    return out;
}

/** A Set-Cookie value: HttpOnly, SameSite=Lax, Path=/staff, Secure when asked. */
export function serializeCookie(name, value, { maxAgeMs = null, secure = false, path = '/staff' } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
    if (maxAgeMs !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

export function clearCookie(name, { secure = false } = {}) {
    return serializeCookie(name, '', { maxAgeMs: 0, secure });
}
