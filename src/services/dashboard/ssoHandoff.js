// ssoHandoff.js — website login → dashboard without a second Discord login (owner, 2026-11-13,
// option B).
//
// The member cookie (mewvo_me) is scoped to Path=/me, so the dashboard never reads it. Instead:
//   1. GET  /me/dashboard            "Continue as <name>" (a member session with a Discord id:
//                                    a Discord login, or a Mewvo account with Discord linked)
//   2. POST /me/dashboard-handoff    same origin + the session's CSRF token + the shown user id;
//                                    issue() makes a one-time grant (60 s) bound to that Discord
//                                    id and sets it as the cookie mewvo_dash_sso (HttpOnly,
//                                    SameSite=Lax, Path=/dashboard/sso, Max-Age 60), then 303 →
//   3. GET  /dashboard/sso           take() consumes the grant (single use) and the dashboard
//                                    makes its own session for that user (routes.js).
// The grant never travels in a URL (no logs, history or Referer), only in a cookie this browser
// got from the POST's own response. The cookie value is "<token>.<userId>" signed with a random
// key made when the process starts: a forged or edited value, another user's id, a reused or
// expired token, or any grant from before a restart is refused. Grants are kept in memory only
// (bounded); nothing is stored or logged.
//
// A small hint cookie (mewvo_dash_hint, Path=/dashboard, value "1", no personal data) tells
// GET /dashboard that this browser has a website login, so it offers /me/dashboard instead of
// starting Discord OAuth. It is only a hint: everything is checked again on /me.

import crypto from 'node:crypto';
import { safeEqual } from './security.js';

export const SSO_COOKIE = 'mewvo_dash_sso';
export const SSO_PATH = '/dashboard/sso';
export const SSO_HINT_COOKIE = 'mewvo_dash_hint';
export const SSO_TTL_MS = 60 * 1000;
const MAX_GRANTS = 10000;
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * A dashboard path to return to after the handoff, or null: the same rule as routes.js
 * safeReturnPath (checked there again).
 */
export function handoffReturnPath(value) {
    const text = typeof value === 'string' ? value : '';
    if (text.length > 300 || text.includes('//')) return null;
    return /^\/dashboard(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&%.]*)?$/.test(text) ? text : null;
}

/** The in-memory grant store shared by /me (issue) and /dashboard (take). */
export function createHandoffStore({ ttlMs = SSO_TTL_MS, max = MAX_GRANTS } = {}) {
    const key = crypto.randomBytes(32);
    const grants = new Map(); // token → { userId, accountId, username, authAt, returnTo, expiresAt }
    const sign = (value) => crypto.createHmac('sha256', key).update(value).digest('base64url');

    function sweep(now) {
        for (const [token, grant] of grants) if (grant.expiresAt <= now) grants.delete(token);
        while (grants.size >= max) grants.delete(grants.keys().next().value);
    }

    /**
     * A new grant for this Discord user: returns the cookie value. `authAt`: when the website
     * session was created (the dashboard session's created_at, so its 30-day cap counts from there).
     */
    function issue({ userId, accountId = null, username = null, authAt = null, returnTo = null }, now = Date.now()) {
        if (!SNOWFLAKE.test(String(userId || ''))) throw new Error('handoff: a Discord user id is required');
        sweep(now);
        const token = crypto.randomBytes(32).toString('base64url');
        grants.set(token, {
            userId: String(userId), accountId: accountId != null ? String(accountId) : null, username: username ? String(username).slice(0, 100) : null,
            authAt: Number.isFinite(Number(authAt)) ? Number(authAt) : null, returnTo: handoffReturnPath(returnTo), expiresAt: now + ttlMs,
        });
        const value = `${token}.${userId}`;
        return `${value}.${sign(value)}`;
    }

    /** The grant for this cookie value, used up (single use); null when unknown, expired, forged or for another user. */
    function take(cookieValue, now = Date.now()) {
        const parts = String(cookieValue || '').split('.');
        if (parts.length !== 3) return null;
        const [token, userId, signature] = parts;
        if (!token || !SNOWFLAKE.test(userId) || !safeEqual(signature, sign(`${token}.${userId}`))) return null;
        const grant = grants.get(token);
        if (!grant) return null;
        grants.delete(token);
        if (grant.expiresAt <= now || grant.userId !== userId) return null;
        return { ...grant };
    }

    return { issue, take, size: () => grants.size };
}
