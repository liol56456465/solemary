// src/utils/canonicalHost.js: old host → PUBLIC_URL for GET/HEAD only, off by default,
// health checks and OAuth callbacks exempt, never an open redirect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { EXEMPT_PATHS, canonicalSettings, createCanonicalHostRedirect, redirectTarget } from '../src/utils/canonicalHost.js';

const PUBLIC_URL = 'https://app.mewvo.com';
const OLD_HOST = 'meowist--sxexx.replit.app';
const ON = { PUBLIC_URL, CANONICAL_REDIRECT: 'true', NODE_ENV: 'production' };

const req = (originalUrl, { method = 'GET', hostname = OLD_HOST, host = hostname } = {}) => ({ method, hostname, headers: { host }, originalUrl });
const on = canonicalSettings(ON);

test('off by default: no CANONICAL_REDIRECT, or anything but "true"', () => {
    for (const value of [undefined, '', 'false', '1', 'yes']) {
        const settings = canonicalSettings({ PUBLIC_URL, NODE_ENV: 'production', CANONICAL_REDIRECT: value });
        assert.equal(settings.enabled, false, String(value));
        assert.equal(redirectTarget(req('/features'), settings), null);
    }
    assert.equal(canonicalSettings({ PUBLIC_URL, CANONICAL_REDIRECT: 'TRUE' }).enabled, true);
});

test('off without a usable PUBLIC_URL and in NODE_ENV=test', () => {
    assert.equal(canonicalSettings({ CANONICAL_REDIRECT: 'true' }).enabled, false);
    assert.equal(canonicalSettings({ CANONICAL_REDIRECT: 'true', PUBLIC_URL: 'not a url' }).enabled, false);
    assert.equal(canonicalSettings({ CANONICAL_REDIRECT: 'true', PUBLIC_URL: 'javascript:alert(1)' }).enabled, false);
    assert.equal(canonicalSettings({ ...ON, NODE_ENV: 'test' }).enabled, false);
});

test('no-op on the PUBLIC_URL host (any case)', () => {
    assert.equal(redirectTarget(req('/dashboard', { hostname: 'app.mewvo.com' }), on), null);
    assert.equal(redirectTarget(req('/dashboard', { hostname: 'APP.Mewvo.com' }), on), null);
});

test('no-op for localhost, 127.0.0.1 and ::1', () => {
    for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]']) {
        assert.equal(redirectTarget(req('/features', { hostname }), on), null, hostname);
    }
});

test('GET and HEAD redirect to the same path and query on PUBLIC_URL', () => {
    assert.equal(redirectTarget(req('/leaderboard?page=2&sort=xp'), on), 'https://app.mewvo.com/leaderboard?page=2&sort=xp');
    assert.equal(redirectTarget(req('/'), on), 'https://app.mewvo.com/');
    assert.equal(redirectTarget(req('/dashboard/cases/abc12', { method: 'HEAD' }), on), 'https://app.mewvo.com/dashboard/cases/abc12');
    assert.equal(redirectTarget(req('/site.css'), on), 'https://app.mewvo.com/site.css');
});

test('a PUBLIC_URL with a path or trailing slash still targets its origin only', () => {
    const settings = canonicalSettings({ ...ON, PUBLIC_URL: 'https://app.mewvo.com/' });
    assert.equal(redirectTarget(req('/me'), settings), 'https://app.mewvo.com/me');
});

test('POST, PUT, DELETE, PATCH and OPTIONS pass through', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        assert.equal(redirectTarget(req('/dashboard/logout', { method }), on), null, method);
    }
});

test('every exempt path passes, also with a trailing slash, other case or a query', () => {
    assert.deepEqual([...EXEMPT_PATHS].sort(), ['/dashboard/oauth/callback', '/health', '/me/callback', '/oauth/callback', '/ready']);
    for (const path of EXEMPT_PATHS) {
        for (const variant of [path, `${path}/`, path.toUpperCase(), `${path}?code=abc&state=xyz`]) {
            assert.equal(redirectTarget(req(variant), on), null, variant);
        }
    }
    // Only the exact paths: neighbours still redirect.
    assert.equal(redirectTarget(req('/healthz'), on), 'https://app.mewvo.com/healthz');
    assert.equal(redirectTarget(req('/me/callbacks'), on), 'https://app.mewvo.com/me/callbacks');
});

test('"//evil.com" and other non-local paths never produce a redirect off PUBLIC_URL', () => {
    for (const path of ['//evil.com', '//evil.com/x?y=1', '/\\evil.com', 'evil.com', 'https://evil.com/', '']) {
        assert.equal(redirectTarget(req(path), on), null, JSON.stringify(path));
    }
    // A host-looking path segment after a single "/" stays on our origin.
    const target = redirectTarget(req('/@evil.com'), on);
    assert.equal(new URL(target).origin, 'https://app.mewvo.com');
});

test('the target ignores Host / X-Forwarded-Host: only PUBLIC_URL decides', () => {
    // Express derives hostname from X-Forwarded-Host (trust proxy); it is only compared, never used as the target.
    assert.equal(redirectTarget(req('/x', { hostname: 'evil.com' }), on), 'https://app.mewvo.com/x');
});

test('raw Host already canonical: a forged X-Forwarded-Host never makes the page redirect to itself', () => {
    assert.equal(redirectTarget(req('/x', { hostname: 'evil.com', host: 'app.mewvo.com' }), on), null);
    assert.equal(redirectTarget(req('/x', { hostname: 'evil.com', host: 'APP.mewvo.com:443' }), on), null);
    assert.equal(redirectTarget(req('/x', { hostname: 'evil.com', host: '127.0.0.1:5000' }), on), null);
});

// ── Through Express, with a real Host header ──────────────────────────────

async function withApp(env, run) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(createCanonicalHostRedirect(env));
    app.get('/{*any}', (request, response) => response.status(200).send('page'));
    app.post('/{*any}', (request, response) => response.status(200).send('posted'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        await run(server.address().port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function send(port, { method = 'GET', path = '/', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
            response.resume();
            response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location, cache: response.headers['cache-control'], vary: response.headers.vary }));
        });
        request.on('error', reject);
        request.end();
    });
}

test('express: old host GET → 301 with path and query; POST and callbacks untouched', async () => {
    await withApp(ON, async (port) => {
        const old = { host: OLD_HOST };
        const get = await send(port, { path: '/docs/appeals?x=1', headers: old });
        assert.equal(get.status, 301);
        assert.equal(get.location, 'https://app.mewvo.com/docs/appeals?x=1');
        assert.equal(get.cache, 'private, max-age=3600');
        assert.match(get.vary || '', /Host/i);
        assert.match(get.vary || '', /X-Forwarded-Host/i);

        assert.equal((await send(port, { method: 'POST', path: '/dashboard/logout', headers: old })).status, 200);
        assert.equal((await send(port, { path: '/dashboard/oauth/callback?code=a&state=b', headers: old })).status, 200);
        assert.equal((await send(port, { path: '/health', headers: old })).status, 200);
        assert.equal((await send(port, { path: '/features', headers: { host: 'app.mewvo.com' } })).status, 200);
        assert.equal((await send(port, { path: '/features', headers: { host: `127.0.0.1:${port}` } })).status, 200);

        const sneaky = await send(port, { path: '//evil.com/x', headers: old });
        assert.notEqual(sneaky.status, 301);
        assert.equal(sneaky.location, undefined);

        // A forged X-Forwarded-Host on the canonical host must not make it redirect to itself (loop / cache poisoning).
        const forged = await send(port, { path: '/x', headers: { host: 'app.mewvo.com', 'x-forwarded-host': 'evil.com' } });
        assert.notEqual(forged.status, 301);
        assert.equal(forged.location, undefined);
    });
});

test('express: switched off, the old host serves pages as before', async () => {
    await withApp({ PUBLIC_URL, NODE_ENV: 'production' }, async (port) => {
        assert.equal((await send(port, { path: '/features', headers: { host: OLD_HOST } })).status, 200);
    });
});
