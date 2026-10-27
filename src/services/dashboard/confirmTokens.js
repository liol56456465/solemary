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

/** A stable hash of a flow / decision (Maps and undefined values left out). */
export function flowHash(payload) {
    const json = JSON.stringify(payload, (key, value) => (value instanceof Map ? undefined : value));
    return crypto.createHash('sha256').update(json || '').digest('base64url').slice(0, 32);
}

export function createConfirmStore({ ttlMs = CONFIRM_TTL_MS, maxTokens = MAX_TOKENS } = {}) {
    const tokens = new Map(); // token → { session, subject, hash, payload, expiresAt }

    function sweep(now) {
        for (const [token, entry] of tokens) if (entry.expiresAt <= now) tokens.delete(token);
        while (tokens.size >= maxTokens) tokens.delete(tokens.keys().next().value);
    }

    return {
        /** Stores `payload`; returns { token, hash } for the confirm page. */
        issue({ session, subject, payload }, now = Date.now()) {
            sweep(now);
            const token = crypto.randomBytes(24).toString('base64url');
            const hash = flowHash(payload);
            tokens.set(token, { session: String(session), subject: String(subject), hash, payload, expiresAt: now + ttlMs });
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
            tokens.delete(key);
            if (entry.expiresAt <= now) return null;
            if (!safeEqual(entry.session, String(session)) || entry.subject !== String(subject) || !safeEqual(entry.hash, String(hash || ''))) return null;
            return entry.payload;
        },
        size: () => tokens.size,
    };
}
