// security.js — signing, OAuth state, cookies and rate limits for the web dashboard.
// Pure apart from crypto randomness and the in-memory maps.
//
// The browser gets an opaque random session id plus its HMAC (SESSION_SECRET); no
// tokens or user data. Sessions themselves are in Postgres (sessionStore.js).

import crypto from 'crypto';

export const BASE_PATH = '/dashboard';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;
export const SESSION_COOKIE = 'mewvo_dash';
export const STATE_COOKIE = 'mewvo_dash_state';
export const MIN_SECRET_LENGTH = 32;
const SNOWFLAKE = /^\d{17,20}$/;

export function isSnowflake(value) {
    return typeof value === 'string' && SNOWFLAKE.test(value);
}

/**
 * The first path segment below /dashboard when it names a server: a snowflake ('/123…/cases' →
 * '123…'), else null. Anything digit-like that is not a valid id (16 or 21 digits, '123abc') is
 * `invalid` (one uniform 404); a lowercase word is an old link or a global route.
 */
export function guildSegment(segment) {
    const text = typeof segment === 'string' ? segment : '';
    if (isSnowflake(text)) return { guildId: text, invalid: false };
    return { guildId: null, invalid: !/^[a-z][a-z0-9-]*$/.test(text) };
}

export function hmac(value, secret) {
    return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url');
}

export function safeEqual(a, b) {
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

/** The longest return path a login state carries (longer ones are dropped: back to the picker). */
export const MAX_RETURN_PATH = 300;

/**
 * { state, nonce }: put `nonce` in the state cookie, `state` in the authorize URL. `returnTo`
 * (optional) is the dashboard page to open after the login: signed inside the state, so it
 * cannot be changed on the way; the callback still checks it again (safeBackPath).
 */
export function createState(secret, now = Date.now(), { returnTo = null } = {}) {
    const nonce = crypto.randomBytes(16).toString('base64url');
    const data = { n: nonce, e: now + STATE_TTL_MS };
    if (typeof returnTo === 'string' && returnTo && returnTo.length <= MAX_RETURN_PATH) data.r = returnTo;
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return { state: signValue(payload, secret), nonce };
}

export function createStateStore() {
    const used = new Map(); // nonce → expiry
    /**
     * { returnTo } for a correctly signed, unexpired, unused state whose nonce matches the
     * browser's cookie (returnTo is null when the state has none); marks it used. Else null.
     */
    function take(state, cookieNonce, secret, now = Date.now()) {
        const payload = verifySignedValue(state, secret);
        if (!payload) return null;
        let data;
        try {
            data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch {
            return null;
        }
        for (const [nonce, expiresAt] of used) if (expiresAt <= now) used.delete(nonce);
        if (!data?.n || !(data.e > now) || used.has(data.n)) return null;
        if (!cookieNonce || !safeEqual(data.n, cookieNonce)) return null;
        used.set(data.n, data.e);
        return { returnTo: typeof data.r === 'string' ? data.r : null };
    }
    return {
        take,
        /** take() as a yes/no. */
        consume(state, cookieNonce, secret, now = Date.now()) {
            return take(state, cookieNonce, secret, now) !== null;
        },
        size: () => used.size,
    };
}

// ── Rate limits ───────────────────────────────────────────────────────────

/**
 * Sliding-window limiter keyed by any string (session hash, IP). allow(key) is true
 * when this request is allowed. Idle keys are dropped so the map stays bounded.
 */
export function createRateLimiter({ limit, windowMs = 60 * 1000, maxKeys = 10000 } = {}) {
    const hits = new Map(); // key → timestamps
    let lastSweep = 0;
    return {
        allow(key, now = Date.now()) {
            if (now - lastSweep > windowMs || hits.size > maxKeys) {
                lastSweep = now;
                for (const [k, times] of hits) if (!times.some((at) => now - at < windowMs)) hits.delete(k);
                while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
            }
            const times = (hits.get(key) || []).filter((at) => now - at < windowMs);
            if (times.length >= limit) {
                hits.set(key, times);
                return false;
            }
            times.push(now);
            hits.set(key, times);
            return true;
        },
        size: () => hits.size,
    };
}

/** Paths the app-wide per-IP limiter skips: the dashboard has its own limits (owner decision 7). */
export function isGlobalRateLimitExempt(req) {
    const path = String(req?.path || '');
    return path === BASE_PATH || path.startsWith(`${BASE_PATH}/`);
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

/** A Set-Cookie value: HttpOnly, SameSite=Lax, Path=<base path>, Secure when asked. */
export function serializeCookie(name, value, { maxAgeMs = null, secure = false, path = BASE_PATH, httpOnly = true } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, ...(httpOnly ? ['HttpOnly'] : []), 'SameSite=Lax'];
    if (maxAgeMs !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

export function clearCookie(name, { secure = false, path = BASE_PATH } = {}) {
    return serializeCookie(name, '', { maxAgeMs: 0, secure, path });
}

/**
 * True when a state-changing request comes from this dashboard: the Origin header
 * must be our PUBLIC_URL origin; without an Origin, the Referer's origin must be; with
 * neither, Sec-Fetch-Site must say same-origin. A request with none of them is refused
 * (every current browser sends Origin on a form POST; the pages use Referrer-Policy
 * same-origin, so "no-referrer" never turns the Origin into "null"). The CSRF token is
 * checked separately.
 */
export function isSameOrigin(req, publicOrigin) {
    if (!publicOrigin) return false;
    const headers = req.headers || {};
    const origin = headers.origin;
    if (origin) return origin === publicOrigin;
    const referer = headers.referer || headers.referrer;
    if (referer) {
        try {
            return new URL(String(referer)).origin === publicOrigin;
        } catch {
            return false;
        }
    }
    return headers['sec-fetch-site'] === 'same-origin';
}
