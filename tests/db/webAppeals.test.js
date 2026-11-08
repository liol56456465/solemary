// Web appeals on the member portal against the local test database (npm run test:db): the real
// data path (listCasesForUserAllServers, listUserAppeals, submitAppeal) behind /me/appeals and
// /me/appeal/:code. Only the logged-in member's cases, from every server; the appeal lands in the
// case's own server (stored for the dashboard when it has no appeals category); one pending
// appeal per case; the cooldown after a denial. Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const skip = isLocalDatabaseUrl(process.env.POSTGRES_URL || '') ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
const runId = String(Date.now()).slice(-9);
const id = (prefix, n) => `${prefix}${runId}${String(n).padStart(8, '0')}`;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
let seq = Number(runId) * 11;
const caseCode = () => { let out = ''; let x = (seq += 17); for (let i = 0; i < 7; i += 1) { out += ALPHA[x % ALPHA.length]; x = Math.floor(x / ALPHA.length); } return out; };
const GUILD_X = id('5', 21); // not a home server, no appeals category
const GUILD_Y = id('5', 22); // not a home server either
const MEMBER = id('6', 21);
const OTHER = id('6', 22);
const ORIGIN = 'https://bot.example';
let pgDb, portal, settings, sessionStore;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    portal = await import('../../src/services/site/memberPortal.js');
    settings = await import('../../src/services/settings/guildSettings.js');
    sessionStore = await import('../../src/services/dashboard/sessionStore.js');
    settings.setSettingsCacheForTests(GUILD_X, {});
    settings.setSettingsCacheForTests(GUILD_Y, {});
});

after(async () => {
    if (skip) return;
    settings.setSettingsCacheForTests(GUILD_X, null);
    settings.setSettingsCacheForTests(GUILD_Y, null);
    await pgDb.pool.query(`DELETE FROM mod_appeals WHERE user_id LIKE $1`, [`6${runId}%`]);
    await pgDb.pool.query(`DELETE FROM mod_cases WHERE target_user_id LIKE $1`, [`6${runId}%`]);
    await pgDb.disconnect();
});

async function insertCase(type, target, guildId) {
    const code = caseCode();
    await pgDb.pool.query(
        `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, status, expires_at)
         VALUES ($1, $2, $3, 'appellant', $4, 'secretmod', $5, $6, 'Spam', 'prebuilt', 'active', $7)`,
        [guildId, code, target, id('6', 999), type, `appellant ${type} ${code}`, type === 'ban' ? new Date(Date.now() + 5 * 86400000) : null]);
    return code;
}

/** The bot client as the portal sees it: GUILD_X is cached (no appeals or ticket category), GUILD_Y is not. */
function fakeClient() {
    const guildX = { id: GUILD_X, name: 'Xenon Lounge', channels: { cache: new Map(), fetch: async () => null, create: async () => { throw new Error('no channel expected'); } } };
    const client = { user: { id: '999999999999999998' }, guilds: { cache: new Map([[GUILD_X, guildX]]) }, channels: { fetch: async () => null }, db: { get: async (key, fallback) => fallback } };
    guildX.client = client;
    return client;
}

async function serve() {
    const app = express();
    const sessions = sessionStore.createMemorySessionStore({ ttlMs: 3600 * 1000 });
    const env = {
        MEMBER_PORTAL_ENABLED: 'true', SESSION_SECRET: 'z'.repeat(64), CLIENT_ID: '400000000000000004', DISCORD_CLIENT_SECRET: 'cs',
        PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: process.env.MAIN_GUILD_ID || '100000000000000099', NODE_ENV: 'test', MEMBER_ACCOUNTS_ENABLED: 'false',
    };
    const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/token') ? { access_token: 't' } : { id: MEMBER, username: 'appellant' }) });
    assert.equal(portal.registerMemberPortal(app, { env, sessions, fetchImpl, client: fakeClient() }), true);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, { method = 'GET', cookie = '', body } = {}) => {
        const res = await fetch(base + path, {
            method, redirect: 'manual', body,
            headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } : {}) },
        });
        return { status: res.status, headers: res.headers, cookies: res.headers.getSetCookie(), body: await res.text() };
    };
    const value = (cookies, name) => decodeURIComponent((cookies.find((c) => c.startsWith(`${name}=`) && !c.includes('Max-Age=0')) || '').split(';')[0].slice(name.length + 1));
    const start = await request('/me/login');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const res = await request(`/me/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: `${portal.MEMBER_STATE_COOKIE}=${encodeURIComponent(value(start.cookies, portal.MEMBER_STATE_COOKIE))}` });
    const cookie = `${portal.MEMBER_SESSION_COOKIE}=${encodeURIComponent(value(res.cookies, portal.MEMBER_SESSION_COOKIE))}`;
    return { request, cookie, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const ANSWERS = { punished: 'For posting links', reason: 'It was a misunderstanding and it will not happen again.', didIt: 'no' };

test('web appeal: own cases of every server; stored in the case\'s own server; one pending; cooldown after a denial', { skip }, async () => {
    const banX = await insertCase('ban', MEMBER, GUILD_X);
    const warnY = await insertCase('warn', MEMBER, GUILD_Y);
    const otherX = await insertCase('warn', OTHER, GUILD_X);
    const app = await serve();
    try {
        const list = await app.request('/me/appeals', { cookie: app.cookie });
        assert.equal(list.status, 200);
        assert.ok(list.body.includes(`/me/appeal/${banX}`) && list.body.includes(`/me/appeal/${warnY}`), 'both servers');
        assert.ok(!list.body.includes(otherX), 'never another member\'s case');
        assert.ok(list.body.includes('Xenon Lounge'), 'server name from the bot');
        assert.ok(!list.body.includes('secretmod'), 'no moderator name');
        assert.equal((await app.request(`/me/appeal/${otherX}`, { cookie: app.cookie })).status, 404);

        const page = await app.request(`/me/appeal/${banX}`, { cookie: app.cookie });
        const csrf = page.body.match(/name="csrf" value="([^"]+)"/)[1];
        const post = (code) => app.request(`/me/appeal/${code}`, { method: 'POST', cookie: app.cookie, body: new URLSearchParams({ ...ANSWERS, csrf }).toString() });

        const sent = await post(banX);
        assert.equal(sent.status, 303, sent.body);
        const rows = async () => (await pgDb.pool.query(`SELECT guild_id, status, user_id, channel_id, body FROM mod_appeals WHERE case_code = $1 ORDER BY id`, [banX])).rows;
        let all = await rows();
        assert.equal(all.length, 1);
        assert.equal(all[0].guild_id, GUILD_X, 'the case\'s own server decides');
        assert.equal(all[0].user_id, MEMBER);
        assert.equal(all[0].channel_id, null, 'no appeals category: stored for the dashboard');
        assert.deepEqual(all[0].body, ANSWERS);

        const shown = await app.request(`/me/appeals?sent=${banX}`, { cookie: app.cookie });
        assert.ok(shown.body.includes(`Your appeal for ${banX} was sent to the staff of Xenon Lounge.`));
        assert.ok(!shown.body.includes(`href="/me/appeal/${banX}"`), 'pending: not appealable again');

        assert.equal((await post(banX)).status, 409, 'one pending appeal per case');
        assert.equal((await rows()).length, 1);

        await pgDb.pool.query(`UPDATE mod_appeals SET status = 'denied', decided_at = NOW() WHERE case_code = $1`, [banX]);
        assert.equal((await post(banX)).status, 409, 'cooldown after a denial');
        assert.equal((await rows()).length, 1);

        await pgDb.pool.query(`UPDATE mod_appeals SET decided_at = NOW() - INTERVAL '8 days' WHERE case_code = $1`, [banX]);
        assert.equal((await post(banX)).status, 303, 'after the cooldown');
        all = await rows();
        assert.deepEqual(all.map((r) => r.status), ['denied', 'pending']);

        // GUILD_Y: the bot is not in it (not cached): stored as well, in GUILD_Y.
        assert.equal((await post(warnY)).status, 303);
        const { rows: [y] } = await pgDb.pool.query(`SELECT guild_id FROM mod_appeals WHERE case_code = $1`, [warnY]);
        assert.equal(y.guild_id, GUILD_Y);
    } finally {
        await app.close();
    }
});
