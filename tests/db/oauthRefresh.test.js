// OAuth token refresh against the local test database (npm run test:db): two lookups at the
// same moment refresh once. Discord rotates the refresh token, so a second refresh with the
// old one gets invalid_grant, which used to delete the tokens the first refresh had stored.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const runId = String(Date.now()).slice(-9);
const userId = `6${runId}00000077`;
const KEY_HEX = crypto.randomBytes(32).toString('hex');
let pgDb, dbApi, oauth;
const saved = {};

const encrypt = (text, key) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
};

before(async () => {
    if (skip) return;
    for (const name of ['OAUTH_TOKEN_KEY', 'CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'PUBLIC_URL']) saved[name] = process.env[name];
    Object.assign(process.env, { OAUTH_TOKEN_KEY: KEY_HEX, CLIENT_ID: '400000000000000004', DISCORD_CLIENT_SECRET: 'test', PUBLIC_URL: 'https://bot.example' });
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    dbApi = await import('../../src/utils/database.js');
    oauth = await import('../../src/services/oauthVerification.js');
});

after(async () => {
    if (skip) return;
    await dbApi.deleteFromDb(`oauth:tokens:${userId}`).catch(() => {});
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await pgDb.disconnect();
});

test('two token lookups at once refresh once; the rotated tokens survive', { skip }, async () => {
    const key = Buffer.from(KEY_HEX, 'hex');
    await dbApi.setInDb(`oauth:tokens:${userId}`, {
        scope: 'identify guilds.join', expiresAt: Date.now() - 1000,
        tokens: encrypt(JSON.stringify({ access: 'old-access', refresh: 'refresh-1' }), key), updatedAt: new Date().toISOString(),
    });
    // A fake Discord token endpoint that rotates refresh tokens like the real one.
    let valid = 'refresh-1';
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (target, options) => {
        assert.match(String(target), /discord\.com\/api\/.*oauth2\/token/);
        calls += 1;
        const sent = new URLSearchParams(String(options.body)).get('refresh_token');
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (sent !== valid) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        valid = `refresh-${calls + 1}`;
        return new Response(JSON.stringify({ access_token: `access-${calls}`, refresh_token: valid, expires_in: 604800, scope: 'identify guilds.join' }), { status: 200 });
    };
    try {
        const [a, b] = await Promise.all([oauth.getUsableAccessToken(userId), oauth.getUsableAccessToken(userId)]);
        assert.equal(calls, 1, 'one refresh for both lookups');
        assert.equal(a, 'access-1');
        assert.equal(b, 'access-1');
        const stored = await dbApi.getFromDb(`oauth:tokens:${userId}`, null);
        assert.ok(stored, 'the tokens were not deleted');
        assert.equal(await oauth.getUsableAccessToken(userId), 'access-1', 'the stored token is fresh now; no further refresh');
        assert.equal(calls, 1);
    } finally {
        globalThis.fetch = realFetch;
    }
});
