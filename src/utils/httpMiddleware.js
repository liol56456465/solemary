// httpMiddleware.js — the web server's app-wide middleware (app.js startWebServer), kept here so
// tests can mount it on a bare Express app:
//
//   createCors         CORS only for PUBLIC_URL (and CORS_ORIGIN, never "*"); always Vary: Origin.
//                      Nothing on the site calls it cross-origin today (the dashboard script fetches
//                      its own origin), so this only answers browsers that ask.
//   createRateLimit    per IP, 400 requests per 15 minutes for pages; static assets, /health, /ready
//                      and the dashboard (own per-session / per-IP limits) are not counted. Over the
//                      limit: 429 + Retry-After, a small HTML page (JSON for API requests).
//   hsts               Strict-Transport-Security in production only (180 days, no preload).
//   createCompression  gzip/brotli for text responses (site, dashboard, portal); images that are
//                      already compressed (PNG, JPEG, WebP, GIF…) are sent as they are.
//   databaseHealthy    the database wrapper is not on the memory fallback AND PostgreSQL is not
//                      known to be down (pool error / failed health check after boot).
//   createReadyHandler /ready: { status: ok|degraded, schemaVersion } for everyone (200 / 503);
//                      the details (counts, database mode, reason) only for a request made on this
//                      machine (loopback socket, no proxy header).

import compression from 'compression';
import { html } from '../services/dashboard/html.js';
import { CSS_PATH } from '../services/site/shell.js';
import { isGlobalRateLimitExempt } from '../services/dashboard/security.js';

// ── CORS ──────────────────────────────────────────────────────────────────

/** The allowed origins: PUBLIC_URL's origin plus CORS_ORIGIN's (comma-separated) http(s) origins; "*" is ignored. */
export function corsOrigins(env = process.env) {
    const out = new Set();
    const add = (value) => {
        const text = String(value || '').trim();
        if (!text || text === '*') return;
        try {
            const url = new URL(text);
            if (url.protocol === 'https:' || url.protocol === 'http:') out.add(url.origin);
        } catch { /* not a URL: ignored */ }
    };
    add(env.PUBLIC_URL);
    for (const part of String(env.CORS_ORIGIN || '').split(',')) add(part);
    return [...out];
}

export function createCors({ origins = [] } = {}) {
    const allowed = new Set(origins);
    return (req, res, next) => {
        res.vary('Origin');
        const origin = req.headers.origin;
        if (!origin || !allowed.has(origin)) return next();
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        return next();
    };
}

// ── Rate limit ────────────────────────────────────────────────────────────

export const RATE_LIMIT_DEFAULTS = Object.freeze({ windowMs: 15 * 60 * 1000, max: 400 });

// Static files never count: one page view loads the stylesheet, the script, the logo and images.
const STATIC_EXACT = new Set(['/site.css', '/site.js', '/health', '/ready', '/robots.txt']);

/** True for requests the global limit does not count (static assets, health checks, the dashboard). */
export function isRateLimitExempt(req) {
    const path = String(req?.path || '');
    if (STATIC_EXACT.has(path)) return true;
    if (path.startsWith('/img/') || path.startsWith('/favicon')) return true;
    // The dashboard (its pages and /dashboard/static/…) has its own limits (dashboard/routes.js).
    return isGlobalRateLimitExempt(req);
}

/** API-style requests get JSON; browsers (anything that accepts HTML) get the small page. */
function wantsJson(req) {
    const path = String(req.path || '');
    if (path.startsWith('/api/') || path === '/api') return true;
    return req.accepts(['html', 'json']) === 'json';
}

export function tooManyRequestsPage(retryAfterSeconds) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="robots" content="noindex, nofollow"><title>Too many requests · Mewvo</title><link rel="stylesheet" href="${CSS_PATH}"></head>
<body><main id="main"><div class="wrap page prose"><h1>Too many requests</h1>
<p class="lead">Too many pages were opened from your address in a short time. Wait ${String(minutes)} minute${minutes === 1 ? '' : 's'} and try again.</p>
<p><a class="button" href="/">Go to the home page</a></p></div></main></body></html>`.text;
}

/**
 * Per-IP sliding window. `now` and `exempt` are injectable for tests. The map of IPs is swept every
 * window so it cannot grow without bound on an internet-facing port (`sweep()` runs it by hand).
 */
export function createRateLimit({ windowMs = RATE_LIMIT_DEFAULTS.windowMs, max = RATE_LIMIT_DEFAULTS.max, exempt = isRateLimitExempt, now = () => Date.now(), timer = true } = {}) {
    const requests = new Map();
    const sweep = () => {
        const windowStart = now() - windowMs;
        for (const [ip, times] of requests) {
            if (!times.some((t) => t > windowStart)) requests.delete(ip);
        }
    };
    if (timer) setInterval(sweep, windowMs).unref();
    const middleware = (req, res, next) => {
        if (exempt(req)) return next();
        const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
        const at = now();
        const times = (requests.get(ip) || []).filter((t) => t > at - windowMs);
        if (times.length >= max) {
            requests.set(ip, times);
            const retryAfter = Math.max(1, Math.ceil((times[0] + windowMs - at) / 1000));
            res.set('Retry-After', String(retryAfter));
            res.set('Cache-Control', 'no-store');
            if (wantsJson(req)) return res.status(429).json({ error: 'Too many requests', retryAfterSeconds: retryAfter });
            res.set('Content-Security-Policy', "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
            res.set('X-Content-Type-Options', 'nosniff');
            return res.status(429).type('html').send(tooManyRequestsPage(retryAfter));
        }
        times.push(at);
        requests.set(ip, times);
        return next();
    };
    middleware.sweep = sweep;
    middleware.size = () => requests.size;
    return middleware;
}

// ── HSTS ──────────────────────────────────────────────────────────────────

export const HSTS_VALUE = 'max-age=15552000';

/** Every response in production says "HTTPS only" for 180 days (no includeSubDomains, no preload). */
export function hsts({ production = process.env.NODE_ENV === 'production' } = {}) {
    return (req, res, next) => {
        if (production) res.set('Strict-Transport-Security', HSTS_VALUE);
        next();
    };
}

// ── Compression ───────────────────────────────────────────────────────────

const PRECOMPRESSED = /^(image\/(?!svg\+xml)|video\/|audio\/|font\/woff2?|application\/(zip|gzip|x-gzip|pdf|octet-stream))/i;

/** Compress unless the body is already compressed (images other than SVG, video, archives). */
export function shouldCompress(req, res) {
    const type = String(res.getHeader('Content-Type') || '');
    if (PRECOMPRESSED.test(type)) return false;
    return compression.filter(req, res);
}

export function createCompression() {
    return compression({ filter: shouldCompress });
}

// ── /ready ────────────────────────────────────────────────────────────────

/**
 * The database is usable: the wrapper is not on its memory fallback and PostgreSQL (wrapper.db)
 * does not report itself down. A database that went away after boot (pool error, failed health
 * check: postgresDatabase.js knownDown) therefore counts as degraded, not only the startup fallback.
 */
export function databaseHealthy(db) {
    const status = db?.getStatus?.();
    if (!status || status.isDegraded) return false;
    const inner = db?.db;
    if (inner && typeof inner.isAvailable === 'function' && !inner.isAvailable()) return false;
    return true;
}

/** A request made on this machine: a loopback socket without a proxy in front (no X-Forwarded-For). */
export function isLocalRequest(req) {
    if (req.headers?.['x-forwarded-for'] || req.headers?.forwarded) return false;
    const address = String(req.socket?.remoteAddress || '');
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * GET /ready. `client`: { isReady(), db, guilds, commands }. Public answer: status + schema version
 * only (200 ok / 503 degraded). The details are for local checks (scripts, the host's shell).
 */
export function createReadyHandler(client, { schemaVersion, schemaLabel }) {
    return (req, res) => {
        const botReady = Boolean(client.isReady?.());
        const dbOk = databaseHealthy(client.db);
        const ok = botReady && dbOk;
        res.set('Cache-Control', 'no-store');
        const body = { status: ok ? 'ok' : 'degraded', schemaVersion };
        if (isLocalRequest(req)) {
            const dbStatus = client.db?.getStatus?.() || { isDegraded: true, connectionType: 'none' };
            body.details = {
                botReady,
                reason: ok ? null : !botReady ? 'Bot not ready' : 'Database degraded',
                guildCount: client.guilds?.cache?.size ?? 0,
                commandCount: client.commands?.size ?? 0,
                database: {
                    mode: dbStatus.connectionType,
                    fallback: Boolean(dbStatus.isDegraded),
                    available: dbOk,
                    degradedReason: dbStatus.degradedReason ?? null,
                },
                schemaLabel,
            };
        }
        return res.status(ok ? 200 : 503).json(body);
    };
}
