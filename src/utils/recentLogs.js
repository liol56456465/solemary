// recentLogs.js — the last warnings and errors, kept in memory for the dashboard's owner
// Health page (bot owners only), so a problem can be seen without opening the host's logs.
// Nothing is written anywhere: a ring buffer of RECENT_LOG_MAX lines, lost on restart.
// Each line is cut to its first line and RECENT_LOG_TEXT_MAX characters, and anything that
// looks like a secret (bot token, password in a database URL, bearer token, long hex/base64
// key) is masked before it is stored.

import winston from 'winston';

export const RECENT_LOG_MAX = 50;
export const RECENT_LOG_TEXT_MAX = 500;

const MASKS = [
    // Discord bot tokens: three dot-separated base64url parts.
    [/[\w-]{23,30}\.[\w-]{6,7}\.[\w-]{27,}/g, '[token]'],
    // user:password@ in any URL (postgres://, https://, …).
    [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[credentials]@'],
    [/\b(Bearer|Bot)\s+[\w.~+/=-]{16,}/g, '$1 [secret]'],
    // Long hex or base64 runs (keys, session secrets); snowflake IDs (17–20 digits) stay.
    [/\b[a-f0-9]{32,}\b/gi, '[secret]'],
    // (no "/" in the run, so file paths in messages stay readable)
    [/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '[secret]'],
];

/** The text as it may be shown: first line, secrets masked, at most RECENT_LOG_TEXT_MAX characters. */
export function maskLogText(value) {
    let text = String(value ?? '').split('\n')[0];
    for (const [pattern, replacement] of MASKS) text = text.replace(pattern, replacement);
    return text.length > RECENT_LOG_TEXT_MAX ? `${text.slice(0, RECENT_LOG_TEXT_MAX)}…` : text;
}

/** A ring buffer of { at, level, text, traceId }, newest last. */
export function createRecentLogBuffer(max = RECENT_LOG_MAX) {
    const lines = [];
    return {
        push(info, now = Date.now()) {
            lines.push({
                at: new Date(now),
                level: info?.level === 'error' ? 'error' : 'warn',
                text: maskLogText(info?.stack || info?.message),
                traceId: typeof info?.traceId === 'string' ? info.traceId.slice(0, 60) : null,
            });
            if (lines.length > max) lines.splice(0, lines.length - max);
        },
        /** Newest first, copies. */
        list() {
            return lines.slice().reverse().map((line) => ({ ...line }));
        },
        clear() {
            lines.length = 0;
        },
    };
}

export const recentLogs = createRecentLogBuffer();

/** The winston transport: warnings and errors only. */
export class RecentLogTransport extends winston.Transport {
    constructor({ buffer = recentLogs, ...options } = {}) {
        super({ level: 'warn', ...options });
        this.buffer = buffer;
    }

    log(info, callback) {
        try {
            this.buffer.push(info);
        } catch {
            // Never let the dashboard buffer break logging.
        }
        callback();
    }
}

export function getRecentLogs() {
    return recentLogs.list();
}
