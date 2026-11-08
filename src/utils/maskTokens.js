// maskTokens.js — hides anything shaped like a Discord bot token (id.timestamp.hmac) or a
// "Bot …" / "Bearer …" authorization value before a string goes to the log.

const BOT_TOKEN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g;
const AUTH_HEADER = /\b(Bot|Bearer)\s+[A-Za-z0-9._-]{10,}/g;

export function maskTokens(text) {
    return String(text ?? '').replace(BOT_TOKEN, '[token]').replace(AUTH_HEADER, '$1 [token]');
}
