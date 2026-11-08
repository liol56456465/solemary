// confirmTokens.js — the confirm step of dashboard enforcement actions and appeal
// decisions. The preview POST stores what will happen (the flow) server-side and
// hands the confirm page a random token; the execute POST must bring back that token
// with the flow hash shown on the page, from the same session, for the same subject
// (user or case), within 5 minutes. A token works once: it is deleted on its first
// use, matching or not. Kept in memory (a restart only means "preview again").

import crypto from 'crypto';
import { safeEqual } from './security.js';

export const CONFIRM_TTL_MS = 5 * 60 * 1000;
const MAX_TOKENS = 2000;
/** Per scope (one server, guildDashboards.js scopedConfirms): one busy server can't evict another's confirmations. */
export const MAX_TOKENS_PER_SCOPE = 200;

/** A stable hash of a flow / decision (Maps and undefined values left out). */
export function flowHash(payload) {
    const json = JSON.stringify(payload, (key, value) => (value instanceof Map ? undefined : value));
    return crypto.createHash('sha256').update(json || '').digest('base64url').slice(0, 32);
}

export function createConfirmStore({ ttlMs = CONFIRM_TTL_MS, maxTokens = MAX_TOKENS, maxPerScope = MAX_TOKENS_PER_SCOPE } = {}) {
    const tokens = new Map(); // token → { session, subject, hash, payload, expiresAt, scope }
    const scopes = new Map(); // scope → Set of its tokens (insertion order = oldest first)

    function drop(token) {
        const entry = tokens.get(token);
        if (!entry) return;
        tokens.delete(token);
        const set = scopes.get(entry.scope);
        set?.delete(token);
        if (set && !set.size) scopes.delete(entry.scope);
    }

    function sweep(now) {
        for (const [token, entry] of tokens) if (entry.expiresAt <= now) drop(token);
        while (tokens.size >= maxTokens) drop(tokens.keys().next().value);
    }

    return {
        /**
         * Stores `payload`; returns { token, hash } for the confirm page. `scope` (a server id,
         * set by scopedConfirms) caps that server's tokens at `maxPerScope`: its oldest go first.
         */
        issue({ session, subject, payload, scope = '' }, now = Date.now()) {
            sweep(now);
            const key = String(scope);
            const own = scopes.get(key);
            while (own && own.size >= maxPerScope) drop(own.values().next().value);
            const token = crypto.randomBytes(24).toString('base64url');
            const hash = flowHash(payload);
            tokens.set(token, { session: String(session), subject: String(subject), hash, payload, expiresAt: now + ttlMs, scope: key });
            if (!scopes.has(key)) scopes.set(key, new Set());
            scopes.get(key).add(token);
            return { token, hash };
        },
        /**
         * The stored payload when the token exists, is unexpired, and matches the
         * session, subject and hash; otherwise null. The token is gone afterwards.
         */
        consume(token, { session, subject, hash }, now = Date.now()) {
            const key = String(token || '');
            const entry = key ? tokens.get(key) : null;
            if (!entry) return null;
            drop(key);
            if (entry.expiresAt <= now) return null;
            if (!safeEqual(entry.session, String(session)) || entry.subject !== String(subject) || !safeEqual(entry.hash, String(hash || ''))) return null;
            return entry.payload;
        },
        size: () => tokens.size,
    };
}
