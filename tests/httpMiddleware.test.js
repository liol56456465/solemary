// App-wide web middleware (src/utils/httpMiddleware.js, mounted in app.js startWebServer):
// the per-IP page limit (static assets, health checks and the dashboard not counted; a small
// HTML 429 page or JSON, with Retry-After), compression (never for already-compressed images),
// CORS only for PUBLIC_URL with Vary: Origin, HSTS in production only, and /ready (status +
// schema version publicly, details only locally; a database that went down after boot is degraded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import http from 'node:http';
import express from 'express';
import {
    HSTS_VALUE, RATE_LIMIT_DEFAULTS, corsOrigins, createCompression, createCors, createRateLimit, createReadyHandler,
    databaseHealthy, hsts, isRateLimitExempt,
} from '../src/utils/httpMiddleware.js';

async function listen(app) {
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** A raw GET (no automatic decompression), so the Content-Encoding and bytes can be checked. */
function rawGet(base, path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(`${base}${path}`, { headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

// ── Rate limit ────────────────────────────────────────────────────────────

test('rate limit: 400 pages per 15 minutes by default (config/application.js)', async () => {
    assert.deepEqual({ ...RATE_LIMIT_DEFAULTS }, { windowMs: 15 * 60 * 1000, max: 400 });
    const { default: config } = await import('../src/config/application.js');
    assert.equal(config.api.rateLimit.max, 400);
    assert.equal(config.api.rateLimit.windowMs, 15 * 60 * 1000);
});

test('rate limit: static assets, /health, /ready and the dashboard are not counted', () => {
    for (const path of ['/site.css', '/site.js', '/img/og.png', '/img/cat/kitten-happy.png', '/favicon.png', '/favicon.ico', '/health', '/ready',
        '/dashboard', '/dashboard/static/dashboard.css', '/dashboard/123456789012345678/cases']) {
        assert.equal(isRateLimitExempt({ path }), true, path);
    }
    for (const path of ['/', '/features', '/de/features', '/me', '/me/appeals', '/oauth/callback', '/de/site.css', '/imgx']) {
        assert.equal(isRateLimitExempt({ path }), false, path);
    }
});

test('rate limit: over the limit → 429 with Retry-After, a small HTML page for browsers and JSON for API requests', async () => {
    let now = 1_000_000;
    const limit = createRateLimit({ windowMs: 60_000, max: 3, now: () => now, timer: false });
    const app = express();
    app.use(limit);
    app.get(/.*/, (req, res) => res.type('text/plain').send('ok'));
    const { base, close } = await listen(app);
    try {
        for (let i = 0; i < 3; i += 1) assert.equal((await fetch(`${base}/features`)).status, 200);
        // Assets never count, even past the limit.
        for (let i = 0; i < 10; i += 1) assert.equal((await fetch(`${base}/site.css?v=abc`)).status, 200);
        now += 20_000;
        const page = await fetch(`${base}/features`, { headers: { accept: 'text/html,application/xhtml+xml' } });
        assert.equal(page.status, 429);
        assert.equal(page.headers.get('retry-after'), '40', 'seconds until the oldest request leaves the window');
        assert.match(page.headers.get('content-type'), /text\/html/);
        assert.equal(page.headers.get('cache-control'), 'no-store');
        const body = await page.text();
        assert.match(body, /<h1>Too many requests<\/h1>/);
        assert.ok(body.length < 2000, 'a small page');
        assert.ok(!/<script/i.test(body), 'no script');
        const api = await fetch(`${base}/api/anything`);
        assert.equal(api.status, 429);
        assert.ok(api.headers.get('retry-after'));
        assert.deepEqual(await api.json(), { error: 'Too many requests', retryAfterSeconds: 40 });
        const json = await fetch(`${base}/features`, { headers: { accept: 'application/json' } });
        assert.equal(json.status, 429);
        assert.match(json.headers.get('content-type'), /application\/json/);
        // The window slides: once the first requests are older than a minute, pages work again.
        now += 41_000;
        assert.equal((await fetch(`${base}/features`)).status, 200);
        limit.sweep();
        assert.equal(limit.size(), 1);
        now += 120_000;
        limit.sweep();
        assert.equal(limit.size(), 0, 'idle addresses are dropped');
    } finally { await close(); }
});

test('app.js mounts the middleware and keeps the temporary proxy check and trust proxy', () => {
    const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
    for (const part of ['app.use(hsts())', 'app.use(createCompression())', 'app.use(createCors({ origins: corsOrigins(process.env) }))', 'app.use(createRateLimit({',
        "app.get('/ready', createReadyHandler(this", "app.set('trust proxy', 1);", 'Proxy check (first HTTP request)']) {
        assert.ok(app.includes(part), part);
    }
    assert.ok(!app.includes("Access-Control-Allow-Origin', origin || '*'"), 'the old wildcard CORS is gone');
    assert.ok(app.indexOf('createRateLimit({') < app.indexOf("app.get('/health'"), 'the limit runs before the routes');
});

// ── Compression ───────────────────────────────────────────────────────────

test('compression: pages, CSS and JS are gzipped; PNG/JPEG/WebP images are sent as they are', async () => {
    const page = `<!doctype html><p>${'Mewvo moderation '.repeat(500)}</p>`;
    const png = Buffer.alloc(4096, 7);
    const app = express();
    app.use(createCompression());
    app.get('/page', (req, res) => res.type('html').send(page));
    app.get('/site.css', (req, res) => res.type('text/css').send('a{color:red}'.repeat(400)));
    app.get('/img/x.png', (req, res) => res.type('image/png').send(png));
    app.get('/img/x.webp', (req, res) => res.type('image/webp').send(png));
    app.get('/img/x.svg', (req, res) => res.type('image/svg+xml').send(`<svg>${'<g/>'.repeat(500)}</svg>`));
    const { base, close } = await listen(app);
    try {
        const html = await rawGet(base, '/page', { 'accept-encoding': 'gzip' });
        assert.equal(html.headers['content-encoding'], 'gzip');
        assert.match(String(html.headers.vary), /Accept-Encoding/i);
        assert.equal(gunzipSync(html.body).toString(), page);
        assert.ok(html.body.length < page.length / 5);
        assert.equal((await rawGet(base, '/site.css', { 'accept-encoding': 'gzip' })).headers['content-encoding'], 'gzip');
        assert.equal((await rawGet(base, '/img/x.svg', { 'accept-encoding': 'gzip' })).headers['content-encoding'], 'gzip', 'SVG is text');
        for (const path of ['/img/x.png', '/img/x.webp']) {
            const image = await rawGet(base, path, { 'accept-encoding': 'gzip' });
            assert.equal(image.headers['content-encoding'], undefined, path);
            assert.deepEqual(image.body, png, path);
        }
        const plain = await rawGet(base, '/page', {});
        assert.equal(plain.headers['content-encoding'], undefined, 'no Accept-Encoding: plain');
    } finally { await close(); }
});

test('compression is a maintained dependency', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(pkg.dependencies.compression, /^\^1\.8\./);
});

// ── CORS ──────────────────────────────────────────────────────────────────

test('CORS: only PUBLIC_URL (and CORS_ORIGIN origins, never "*"); Vary: Origin on every response', async () => {
    assert.deepEqual(corsOrigins({ PUBLIC_URL: 'https://mewvo.example/', CORS_ORIGIN: '*, https://docs.example/x, not a url, ftp://x.example' }),
        ['https://mewvo.example', 'https://docs.example']);
    assert.deepEqual(corsOrigins({ CORS_ORIGIN: '*' }), []);
    const app = express();
    app.use(createCors({ origins: corsOrigins({ PUBLIC_URL: 'https://mewvo.example' }) }));
    app.get('/x', (req, res) => res.send('ok'));
    const { base, close } = await listen(app);
    try {
        const same = await fetch(`${base}/x`, { headers: { origin: 'https://mewvo.example' } });
        assert.equal(same.headers.get('access-control-allow-origin'), 'https://mewvo.example');
        assert.match(same.headers.get('vary'), /Origin/);
        const evil = await fetch(`${base}/x`, { headers: { origin: 'https://evil.example' } });
        assert.equal(evil.status, 200);
        assert.equal(evil.headers.get('access-control-allow-origin'), null, 'another site gets no CORS header');
        assert.match(evil.headers.get('vary'), /Origin/);
        const none = await fetch(`${base}/x`);
        assert.equal(none.headers.get('access-control-allow-origin'), null);
        assert.match(none.headers.get('vary'), /Origin/);
        const preflight = await fetch(`${base}/x`, { method: 'OPTIONS', headers: { origin: 'https://mewvo.example' } });
        assert.equal(preflight.status, 204);
        const evilPreflight = await fetch(`${base}/x`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
        assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null);
    } finally { await close(); }
});

// ── HSTS ──────────────────────────────────────────────────────────────────

test('HSTS: 180 days in production only, no preload', async () => {
    assert.equal(HSTS_VALUE, 'max-age=15552000');
    for (const [production, expected] of [[true, HSTS_VALUE], [false, null]]) {
        const app = express();
        app.use(hsts({ production }));
        app.get('/', (req, res) => res.send('ok'));
        const { base, close } = await listen(app);
        try {
            assert.equal((await fetch(base)).headers.get('strict-transport-security'), expected);
        } finally { await close(); }
    }
});

// ── /ready ────────────────────────────────────────────────────────────────

function fakeClient({ ready = true, fallback = false, pgAvailable = true } = {}) {
    return {
        isReady: () => ready,
        guilds: { cache: { size: 3 } },
        commands: { size: 61 },
        db: {
            db: { isAvailable: () => pgAvailable },
            getStatus: () => ({ connectionType: fallback ? 'memory' : 'postgresql', isDegraded: fallback, degradedReason: fallback ? 'boot fallback' : null }),
        },
    };
}

async function readyOf(client, headers = {}) {
    const app = express();
    app.get('/ready', createReadyHandler(client, { schemaVersion: 12, schemaLabel: 'baseline-v12' }));
    const { base, close } = await listen(app);
    try {
        const res = await fetch(`${base}/ready`, { headers });
        return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
    } finally { await close(); }
}

test('/ready: publicly only ok/degraded and the schema version; details only for a local request', async () => {
    const proxied = { 'x-forwarded-for': '203.0.113.9' };
    const pub = await readyOf(fakeClient(), proxied);
    assert.equal(pub.status, 200);
    assert.deepEqual(pub.body, { status: 'ok', schemaVersion: 12 });
    assert.equal(pub.cache, 'no-store');
    const local = await readyOf(fakeClient());
    assert.equal(local.status, 200);
    assert.equal(local.body.status, 'ok');
    assert.equal(local.body.details.guildCount, 3);
    assert.equal(local.body.details.commandCount, 61);
    assert.equal(local.body.details.database.mode, 'postgresql');
    assert.equal(local.body.details.schemaLabel, 'baseline-v12');
    const starting = await readyOf(fakeClient({ ready: false }), proxied);
    assert.equal(starting.status, 503);
    assert.deepEqual(starting.body, { status: 'degraded', schemaVersion: 12 });
});

test('/ready: a database that went down after boot (PostgreSQL known down) is degraded, not only the startup fallback', async () => {
    const down = await readyOf(fakeClient({ pgAvailable: false }));
    assert.equal(down.status, 503);
    assert.equal(down.body.status, 'degraded');
    assert.equal(down.body.details.reason, 'Database degraded');
    assert.equal(down.body.details.database.available, false);
    const fallback = await readyOf(fakeClient({ fallback: true }), { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(fallback.status, 503);
    assert.deepEqual(fallback.body, { status: 'degraded', schemaVersion: 12 });
    assert.equal(databaseHealthy(fakeClient().db), true);
    assert.equal(databaseHealthy(fakeClient({ pgAvailable: false }).db), false);
    assert.equal(databaseHealthy(null), false);
});

test('the status page uses the same database test as /ready', async () => {
    const { botStatus } = await import('../src/services/site/site.js');
    const client = (pgAvailable) => ({ ...fakeClient({ pgAvailable }), uptime: 60_000 });
    assert.equal(botStatus(client(true)).state, 'online');
    assert.equal(botStatus(client(false)).state, 'degraded');
});
