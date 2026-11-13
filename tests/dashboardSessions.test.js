// Long sliding sessions, "Log out on all devices", the server list across restarts and the
// website → dashboard handoff (ssoHandoff.js), owner request 2026-11-13. A real Express app on
// 127.0.0.1 with the member portal (/me) and the multi-server dashboard (/dashboard) side by side,
// as in app.js, in-memory session and account stores, a fake Discord and a fake bot client.
// No database, no network. Every behaviour has a control case next to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import {
    createMemorySessionStore, hashSessionId, renewalFor, sessionLifetime, slidingExpiry,
} from '../src/services/dashboard/sessionStore.js';
import {
    SESSION_COOKIE, SESSION_IDLE_MS, SESSION_MAX_AGE_MS, SESSION_RENEW_MS, sessionCookieAge, signValue,
} from '../src/services/dashboard/security.js';
import { SSO_COOKIE, SSO_HINT_COOKIE, SSO_TTL_MS, createHandoffStore, handoffReturnPath } from '../src/services/dashboard/ssoHandoff.js';
import {
    PICKER_MAX_CHECKS, buildBotGuildList, createGuildListCache, createGuildListStore, guildListKey,
} from '../src/services/dashboard/serverPicker.js';
import { defaultServices } from '../src/services/dashboard/services.js';
import { createDashboardApp, dashboardSettings } from '../src/services/dashboard/routes.js';
import { MEMBER_SESSION_COOKIE, registerMemberPortal } from '../src/services/site/memberPortal.js';
import { base32Decode, totp } from '../src/services/accounts/accountCore.js';
import { createMemoryAccountStore } from '../src/services/accounts/memoryAccountStore.js';
import { OWNER_SESSION_MAX_AGE_MS, isSessionFresh } from '../src/services/dashboard/ownerRoutes.js';

const SECRET = 'x'.repeat(64);
const MAIN = '100000000000000001';
const SUPPORT = '100000000000000009';
const A = '110000000000000011';
const B = '120000000000000012';
const ADMIN = '200000000000000002'; // Administrator in MAIN and A; a member of B (no rights there)
const OTHER = '300000000000000003';
const BLOCKED = '700000000000000007';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, NODE_ENV: 'test',
    MEMBER_PORTAL_ENABLED: 'true',
};
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const PASSWORD = 'a long password 1';
const LOW = { N: 1024, r: 8, p: 1 };
const OPEN = { limit: 1000, windowMs: 60000 };

// ── 1. sliding expiry (pure + memory store) ────────────────────────────────

test('sliding sessions: renewed at most hourly to now + 7 days, never past created + 30 days; idle 7 days ends it', async () => {
    const life = sessionLifetime();
    assert.deepEqual(life, { idleMs: SESSION_IDLE_MS, maxAgeMs: SESSION_MAX_AGE_MS, renewEveryMs: SESSION_RENEW_MS });
    assert.equal(SESSION_IDLE_MS, 7 * DAY);
    assert.equal(SESSION_MAX_AGE_MS, 30 * DAY);
    assert.equal(slidingExpiry(0, 0, life), 7 * DAY);
    assert.equal(slidingExpiry(0, 28 * DAY, life), 30 * DAY, 'the absolute cap wins near the end');
    // Control: within the hour no renewal (no write, no new cookie).
    assert.equal(renewalFor({ createdAt: 0, expiresAt: 7 * DAY }, 30 * 60 * 1000, life), null);
    assert.equal(renewalFor({ createdAt: 0, expiresAt: 7 * DAY }, HOUR, life), 7 * DAY + HOUR);

    const store = createMemorySessionStore();
    const s = await store.create({ userId: ADMIN, username: 'a' }, 0);
    assert.equal(s.expiresAt, 7 * DAY);
    const early = await store.get(s.id, 10 * 60 * 1000);
    assert.equal(early.renewed, false, 'control: 10 minutes later, not renewed');
    assert.equal(early.expiresAt, 7 * DAY);
    const later = await store.get(s.id, 2 * HOUR);
    assert.equal(later.renewed, true);
    assert.equal(later.expiresAt, 7 * DAY + 2 * HOUR);
    assert.equal(sessionCookieAge(later, 2 * HOUR), 7 * DAY, 'the cookie gets the new Max-Age');
    // Used every 6 days: it keeps going, but not past day 30.
    let t = 2 * HOUR;
    for (let i = 0; i < 4; i += 1) {
        t += 6 * DAY;
        assert.ok(await store.get(s.id, t), `alive on day ${(t / DAY).toFixed(1)}`);
    }
    assert.equal((await store.get(s.id, 30 * DAY - 1)).expiresAt, 30 * DAY, 'control: alive just before day 30, capped there');
    assert.equal(await store.get(s.id, 30 * DAY), null, 'the absolute cap: 30 days after the login');

    // Idle: 7 days without use ends it; control: 1 ms before, it still works.
    const idle = await store.create({ userId: ADMIN }, 0);
    assert.ok(await store.get(idle.id, 7 * DAY - 1), 'control: just before 7 idle days');
    const idle2 = await store.create({ userId: ADMIN }, 0);
    assert.equal(await store.get(idle2.id, 7 * DAY), null, '7 days without use');

    // authAt (a website login handed over): created_at is that login, so the cap counts from it.
    const handed = await store.create({ userId: ADMIN, authAt: 20 * DAY }, 25 * DAY);
    assert.equal(handed.createdAt, 20 * DAY);
    assert.equal(handed.expiresAt, 32 * DAY, 'min(now + 7 days, login + 30 days)');
    const nearCap = await store.create({ userId: ADMIN, authAt: 0 }, 28 * DAY);
    assert.equal(nearCap.expiresAt, 30 * DAY, 'a handover near the cap gets only what is left');
    const future = await store.create({ userId: ADMIN, authAt: 99 * DAY }, DAY);
    assert.equal(future.createdAt, DAY, 'an implausible authAt (future) is ignored');
    // Legacy fixed lifetime (ttlMs): no sliding.
    const fixed = createMemorySessionStore({ ttlMs: 2 * HOUR });
    const f = await fixed.create({ userId: ADMIN }, 0);
    assert.equal((await fixed.get(f.id, 90 * 60 * 1000)).renewed, false);
    assert.equal(await fixed.get(f.id, 2 * HOUR), null);
});

test('destroyForUser ends one Discord user\'s sessions only (keepId kept)', async () => {
    const store = createMemorySessionStore();
    const a1 = await store.create({ userId: ADMIN });
    const a2 = await store.create({ userId: ADMIN });
    const o = await store.create({ userId: OTHER });
    assert.equal(await store.destroyForUser(ADMIN, a2.id), 1);
    assert.equal(await store.get(a1.id), null);
    assert.ok(await store.get(a2.id), 'kept');
    assert.ok(await store.get(o.id), 'control: another user is untouched');
    assert.equal(await store.destroyForUser(null), 0);
});

// ── 2. the server list store ───────────────────────────────────────────────

function fakeKv() {
    const rows = new Map();
    const calls = [];
    return {
        rows, calls, down: false,
        async get(key) { calls.push(['get', key]); if (this.down) throw new Error('db down'); return rows.has(key) ? structuredClone(rows.get(key)) : null; },
        async set(key, value, ttl) { calls.push(['set', key, ttl]); if (this.down) throw new Error('db down'); rows.set(key, structuredClone(value)); },
        async delete(key) { calls.push(['delete', key]); rows.delete(key); },
    };
}

test('server list: survives a restart through the key-value store (30-day TTL); memory in front; junk dropped', async () => {
    const kv = fakeKv();
    const list = [{ id: A, name: 'Alpha', icon: 'a'.repeat(32), canManage: true }, { id: B, name: 'Bravo', icon: null, canManage: false, owner: true, listedAt: 5 }];
    const first = createGuildListStore({ kv });
    await first.remember(ADMIN, list);
    assert.deepEqual(kv.calls.at(-1), ['set', guildListKey(ADMIN), 30 * 24 * 60 * 60], 'TTL = the longest session');
    assert.deepEqual(Object.keys(kv.rows.get(guildListKey(ADMIN))[0]).sort(), ['canManage', 'icon', 'id', 'name']);
    // "Restart": a new memory cache, the same store.
    const second = createGuildListStore({ kv, memory: createGuildListCache() });
    assert.deepEqual(await second.load(ADMIN), list);
    kv.calls.length = 0;
    await second.load(ADMIN);
    assert.deepEqual(kv.calls, [], 'then answered from memory');
    // Control: without the key-value store a restart loses the list.
    assert.equal(await createGuildListStore().load(ADMIN), null);
    // A store that does not answer: no list (Refresh), never a crash.
    const down = fakeKv();
    down.down = true;
    assert.equal(await createGuildListStore({ kv: down }).load(ADMIN), null);
    // Stored junk is cleaned on the way back.
    kv.rows.set(guildListKey(OTHER), [{ id: 'nope' }, { id: A, name: 'x'.repeat(300), icon: 'javascript:1', canManage: 'yes', token: 'tok' }]);
    assert.deepEqual(await createGuildListStore({ kv }).load(OTHER), [{ id: A, name: 'x'.repeat(100), icon: null, canManage: false }]);
    await second.forget(ADMIN);
    assert.equal(kv.rows.has(guildListKey(ADMIN)), false, 'logout deletes it');
});

// ── 3. the handoff store ───────────────────────────────────────────────────

test('handoff grant: single use, 60 seconds, bound to the user, forged values refused', () => {
    const store = createHandoffStore();
    const value = store.issue({ userId: ADMIN, accountId: '7', username: 'adm', authAt: 1000, returnTo: `/dashboard/${A}/cases` }, 0);
    assert.ok(!value.includes('adm'), 'no name in the cookie');
    const grant = store.take(value, 1000);
    assert.deepEqual([grant.userId, grant.accountId, grant.authAt, grant.returnTo], [ADMIN, '7', 1000, `/dashboard/${A}/cases`]);
    assert.equal(store.take(value, 1000), null, 'single use');
    const late = store.issue({ userId: ADMIN }, 0);
    assert.ok(store.take(store.issue({ userId: ADMIN }, 0), SSO_TTL_MS - 1), 'control: just inside the minute');
    assert.equal(store.take(late, SSO_TTL_MS), null, 'expired after 60 s');
    // Another user's id with the same token: the signature fails.
    const mine = store.issue({ userId: ADMIN }, 0);
    const [token] = mine.split('.');
    assert.equal(store.take(`${token}.${OTHER}.${mine.split('.')[2]}`, 0), null, 'wrong user');
    assert.ok(store.take(mine, 0), 'control: the untouched value still works once');
    // A value signed by another process (restart) or garbage.
    const elsewhere = createHandoffStore().issue({ userId: ADMIN }, 0);
    assert.equal(store.take(elsewhere, 0), null);
    for (const junk of ['', 'a.b', 'a.b.c', null, `${'a'.repeat(43)}.${ADMIN}.x`]) assert.equal(store.take(junk, 0), null);
    assert.throws(() => store.issue({ userId: 'nope' }));
    // Return paths: only dashboard paths.
    assert.equal(handoffReturnPath('/dashboard/123/cases?x=1'), '/dashboard/123/cases?x=1');
    for (const bad of ['https://evil.example/', '//evil.example', '/dashboard//evil.example', '/me', '/dashboard/../x']) assert.equal(handoffReturnPath(bad), null, bad);
});

// ── 4. the bot-built server list ───────────────────────────────────────────

function fakeGuild(id, name, { members = [], fetchable = [], delay = 0, track = null } = {}) {
    const cache = new Map(members.map((m) => [m, { id: m }]));
    return {
        id, name, iconURL: () => null, channels: { cache: new Map() }, roles: { cache: new Map() },
        fetches: 0,
        members: {
            cache,
            async fetch(arg) {
                this.owner.fetches += 1;
                if (track) { track.now += 1; track.max = Math.max(track.max, track.now); }
                await new Promise((r) => setTimeout(r, delay));
                if (track) track.now -= 1;
                const userId = typeof arg === 'string' ? arg : arg?.user;
                if (cache.has(userId) || fetchable.includes(userId)) return { id: userId };
                throw new Error('Unknown Member');
            },
        },
    };
}
function withOwner(guild) { guild.members.owner = guild; return guild; }

test('SSO server list: Mewvo servers where the user is a member, cache first, at most 50 live checks, 5 at a time', async () => {
    const track = { now: 0, max: 0 };
    const guilds = [
        withOwner(fakeGuild(A, 'Alpha', { members: [ADMIN] })),
        withOwner(fakeGuild(MAIN, 'Mewvo', { fetchable: [ADMIN] })),
        withOwner(fakeGuild(B, 'Bravo', {})),
    ];
    for (let i = 0; i < 60; i += 1) guilds.push(withOwner(fakeGuild(`15${String(i).padStart(16, '0')}`, `G${i}`, { delay: 2, track, fetchable: i === 3 ? [ADMIN] : [] })));
    const client = { guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } };
    const list = await buildBotGuildList(client, ADMIN, { mainGuildId: MAIN });
    assert.deepEqual(list.map((g) => g.id), [MAIN, A, `15${'3'.padStart(16, '0')}`], 'main first; the member cache and live fetches; B (not a member) left out');
    assert.ok(list.every((g) => g.fromBot === true && g.canManage === false && g.icon === null));
    assert.equal(guilds.find((g) => g.id === A).fetches, 0, 'a cache hit is not fetched again');
    assert.equal(guilds.reduce((n, g) => n + g.fetches, 0), PICKER_MAX_CHECKS, 'at most 50 live checks');
    assert.ok(track.max <= 5, `at most 5 at a time (saw ${track.max})`);
    assert.deepEqual(await buildBotGuildList(client, 'nope'), [], 'control: no valid user, nothing asked');
});

// ── 5. end to end: /me + /dashboard ────────────────────────────────────────

async function serve({ blocked = new Set() } = {}) {
    const settings = dashboardSettings(ENV);
    const admins = new Map([[MAIN, new Set([ADMIN])], [A, new Set([ADMIN])], [B, new Set()]]);
    const guilds = [
        withOwner(fakeGuild(MAIN, 'Mewvo', { members: [ADMIN] })),
        withOwner(fakeGuild(A, 'Alpha', { members: [ADMIN, BLOCKED] })),
        withOwner(fakeGuild(B, 'Bravo', { members: [ADMIN] })),
    ];
    const client = { user: { id: '999999999999999999' }, guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } };
    const dashSessions = createMemorySessionStore();
    const memberSessions = createMemorySessionStore();
    const handoffs = createHandoffStore();
    const kv = fakeKv();
    const discord = { me: { id: ADMIN, username: 'admin' }, guilds: [{ id: A, name: 'Alpha', permissions: '8' }] };
    const fetchImpl = async (url) => ({
        ok: true, status: 200,
        json: async () => (url.includes('/oauth2/token') ? { access_token: 'tok' } : url.endsWith('/users/@me/guilds') ? discord.guilds : discord.me),
    });
    const app = express();
    const dashboard = createDashboardApp({
        client, settings, env: ENV, sessions: dashSessions, fetchImpl, sso: handoffs, guildListKv: kv, memberSessions,
        owners: () => [],
        accessFor: (guildId) => createAccessChecker(client, {
            guildId,
            facts: async (c, userId, gid) => ({ inGuild: Boolean(c.guilds.cache.get(gid)?.members.cache.has(userId)), isAdmin: Boolean(admins.get(gid)?.has(userId)), isOwnerId: false }),
        }),
        blacklist: ({ userId } = {}) => (userId && blocked.has(userId) ? { kind: 'user' } : null),
        settingsReady: async () => {},
        services: { ...defaultServices, getAutomodSettings: async () => null, getJoinToCreateConfiguration: async () => null, getApplicationSettings: async () => null },
        data: { overview: { getGuildConfig: async () => null, getWelcomeConfig: async () => null } },
    });
    app.use('/dashboard', dashboard.router);
    const store = createMemoryAccountStore();
    registerMemberPortal(app, {
        env: ENV, dashboardEnabled: true, sessions: memberSessions, fetchImpl, accountStore: store, hashParams: LOW,
        accountLimits: { loginIp: OPEN, loginName: OPEN, code: OPEN, signupIp: OPEN, resetIp: OPEN },
        accountAfter: async () => {}, personalLanguage: { read: async () => null, save: async () => null, clear: async () => true },
        data: { getMemberStanding: async () => ({ ladder: { level: 0, warns_since_level: 0 }, warns: [], activeBan: null, activeMute: null }), listCasesAllServers: async () => [], listUserAppeals: async () => [] },
        sso: handoffs, dashboardSessions: dashSessions, guildLists: dashboard.guildListStore,
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base, dashboard, dashSessions, memberSessions, handoffs, kv, discord, store, client, admins,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

/** A browser: a cookie jar (names only; paths are not modelled), Origin on POST, the page's last csrf. */
function browser(app) {
    const jar = new Map();
    let csrf = '';
    async function request(path, { form = null, origin = ORIGIN, withCsrf = true } = {}) {
        const headers = {};
        if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
        let body;
        if (form) {
            headers['content-type'] = 'application/x-www-form-urlencoded';
            if (origin) headers.origin = origin;
            body = new URLSearchParams({ ...(withCsrf ? { csrf } : {}), ...form }).toString();
        }
        const res = await fetch(app.base + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
        const setCookies = res.headers.getSetCookie();
        for (const line of setCookies) {
            const [pair] = line.split(';');
            const name = pair.slice(0, pair.indexOf('='));
            const value = decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
            if (/Max-Age=0/.test(line)) jar.delete(name); else jar.set(name, value);
        }
        const text = await res.text();
        const all = [...text.matchAll(/name="csrf" value="([^"]+)"/g)];
        if (all.length) csrf = all[all.length - 1][1];
        return { status: res.status, location: res.headers.get('location'), body: text, cookies: setCookies };
    }
    return { request, jar, get csrf() { return csrf; }, set csrf(v) { csrf = v; } };
}

/** "Log in with Discord" on /me (the fake Discord answers app.discord.me). */
async function memberDiscordLogin(b) {
    const start = await b.request('/me/login');
    const state = new URL(start.location).searchParams.get('state');
    return b.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`);
}

/** The whole handoff: /me → /me/dashboard → POST → /dashboard/sso. Returns the last response. */
async function handoff(b, { returnTo = null } = {}) {
    const page = await b.request(`/me/dashboard${returnTo ? `?r=${encodeURIComponent(returnTo)}` : ''}`);
    assert.equal(page.status, 200);
    const uid = /name="uid" value="([^"]+)"/.exec(page.body)?.[1];
    const r = /name="r" value="([^"]+)"/.exec(page.body)?.[1];
    const post = await b.request('/me/dashboard-handoff', { form: { uid, ...(r ? { r } : {}) } });
    assert.equal(post.status, 303);
    assert.equal(post.location, '/dashboard/sso');
    return b.request('/dashboard/sso');
}

test('SSO: a Discord website login opens the dashboard without OAuth; the grant works once; the list comes from the bot; Refresh uses OAuth', async () => {
    const app = await serve();
    const b = browser(app);
    try {
        // Control: no website login → /dashboard starts Discord OAuth as before.
        const plain = await b.request('/dashboard');
        assert.equal(plain.status, 302);
        assert.match(plain.location, /^https:\/\/discord\.com\/oauth2\/authorize\?/);

        const login = await memberDiscordLogin(b);
        assert.equal(login.status, 303);
        assert.match(login.cookies.find((c) => c.startsWith(`${SSO_HINT_COOKIE}=`)), /^mewvo_dash_hint=1; Path=\/dashboard; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/,
            'the hint cookie is set with the login, for /dashboard only, holding only "1"');
        assert.equal(b.jar.get(SSO_HINT_COOKIE), '1');
        assert.ok((await b.request('/me')).cookies.every((c) => !c.startsWith(`${SSO_HINT_COOKIE}=`)), 'not re-sent on every page');

        const offer = await b.request(`/dashboard?r=${encodeURIComponent(`/dashboard/${A}/cases`)}`);
        assert.deepEqual([offer.status, offer.location], [302, `/me/dashboard?r=${encodeURIComponent(`/dashboard/${A}/cases`)}`]);
        const page = await b.request(offer.location);
        assert.match(page.body, /Continue as admin/);
        assert.match(page.body, new RegExp(`href="/dashboard\\?discord=1&amp;r=`), 'Log in with Discord instead');
        const discordInstead = await b.request('/dashboard?discord=1');
        assert.match(discordInstead.location, /^https:\/\/discord\.com\/oauth2\/authorize\?/, '?discord=1 always uses Discord');

        const sso = await handoff(b, { returnTo: `/dashboard/${A}/cases` });
        assert.deepEqual([sso.status, sso.location], [303, `/dashboard/${A}/cases`]);
        assert.ok(sso.cookies.some((c) => c.startsWith(`${SSO_COOKIE}=;`) && /Path=\/dashboard\/sso/.test(c)), 'the grant cookie is cleared');
        const dashCookie = sso.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
        assert.match(dashCookie, /Path=\/dashboard; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
        assert.equal(app.dashSessions.size(), 1);
        assert.ok(!app.kv.rows.get(guildListKey(ADMIN)).some((g) => 'token' in g));

        // The picker: servers from the bot (MAIN, A; not B: no rights there), with Refresh from Discord.
        const picker = await b.request('/dashboard');
        assert.equal(picker.status, 200);
        assert.ok(picker.body.includes(`href="/dashboard/${A}/overview"`));
        assert.ok(picker.body.includes(`href="/dashboard/${MAIN}/overview"`));
        assert.ok(!picker.body.includes(`/dashboard/${B}/overview`), 'B: a member without rights is not listed');
        assert.match(picker.body, /Servers found through Mewvo/);
        assert.match(picker.body, /Refresh server list from Discord/);
        assert.deepEqual(app.kv.rows.get(guildListKey(ADMIN)).map((g) => g.id), [MAIN, A, B], 'stored: every bot server the user is in');
        const refresh = await b.request('/dashboard?refresh=1');
        assert.equal(refresh.status, 302);
        const authorize = new URL(refresh.location);
        assert.equal(authorize.origin + authorize.pathname, 'https://discord.com/oauth2/authorize');
        assert.equal(authorize.searchParams.get('prompt'), 'none', 'Refresh still runs Discord OAuth');
        assert.equal(authorize.searchParams.get('scope'), 'identify guilds');

        // Single use: the same grant cookie again → refused, no new session.
        const value = app.handoffs.issue({ userId: ADMIN }, Date.now());
        const c2 = browser(app);
        c2.jar.set(SSO_COOKIE, value);
        assert.equal((await c2.request('/dashboard/sso')).status, 303);
        c2.jar.set(SSO_COOKIE, value);
        const again = await c2.request('/dashboard/sso');
        assert.equal(again.status, 400, 'a used grant is refused');
        assert.match(again.body, /works once and for one minute/);
        // No grant cookie at all → refused.
        assert.equal((await browser(app).request('/dashboard/sso')).status, 400);
    } finally {
        await app.close();
    }
});

test('SSO refusals: no CSRF, bad Origin, another user id, a blacklisted user, an account without Discord', async () => {
    const app = await serve({ blocked: new Set([BLOCKED]) });
    try {
        const b = browser(app);
        await memberDiscordLogin(b);
        const page = await b.request('/me/dashboard');
        const csrf = b.csrf;
        const tries = [
            ['no CSRF', { form: { uid: ADMIN }, withCsrf: false }],
            ['wrong CSRF', { form: { uid: ADMIN, csrf: 'w'.repeat(32) }, withCsrf: false }],
            ['foreign Origin', { form: { uid: ADMIN }, origin: 'https://evil.example' }],
            ['no Origin', { form: { uid: ADMIN }, origin: null }],
            ['another user id', { form: { uid: OTHER } }],
        ];
        assert.match(page.body, /Continue as/);
        for (const [label, options] of tries) {
            b.csrf = csrf;
            const res = await b.request('/me/dashboard-handoff', options);
            assert.equal(res.status, 403, label);
            assert.ok(!b.jar.has(SSO_COOKIE), `${label}: no grant`);
        }
        assert.equal(app.handoffs.size(), 0, 'nothing issued');
        b.csrf = csrf;
        assert.equal((await b.request('/me/dashboard-handoff', { form: { uid: ADMIN } })).status, 303, 'control: the real form works');

        // A blacklisted user: refused at /dashboard/sso, no dashboard session.
        app.discord.me = { id: BLOCKED, username: 'blocked' };
        const blocked = browser(app);
        await memberDiscordLogin(blocked);
        const before = app.dashSessions.size();
        const res = await handoff(blocked);
        assert.equal(res.status, 403);
        assert.match(res.body, /No access/);
        assert.equal(app.dashSessions.size(), before, 'no session for a blacklisted user');
        assert.ok(!blocked.jar.has(SESSION_COOKIE));

        // A Mewvo account without a linked Discord: no handoff (the link step instead).
        const acc = browser(app);
        await acc.request('/me/signup');
        await acc.request('/me/signup', { form: { username: 'nolink_cat', password: PASSWORD, birth_date: '2000-05-05', accept: 'yes' } });
        const issued = app.handoffs.size();
        const view = await acc.request('/me/dashboard');
        assert.deepEqual([view.status, view.location], [303, '/me/link']);
        const post = await acc.request('/me/dashboard-handoff', { form: { uid: ADMIN } });
        assert.deepEqual([post.status, post.location], [303, '/me/link']);
        assert.equal(app.handoffs.size(), issued, 'nothing issued');
        assert.ok(!acc.jar.has(SSO_HINT_COOKIE), 'no hint without Discord');
    } finally {
        await app.close();
    }
});

test('SSO with a Mewvo account (linked Discord): the dashboard session is that Discord user, its cap counts from the website login', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        await b.request('/me/signup');
        await b.request('/me/signup', { form: { username: 'linked_cat', password: PASSWORD, birth_date: '2000-05-05', accept: 'yes' } });
        await b.request('/me/link');
        const start = await b.request('/me/link', { form: {} });
        const state = new URL(start.location).searchParams.get('state');
        assert.equal((await b.request(`/me/callback?code=c&state=${encodeURIComponent(state)}`)).location, '/me/linked');
        const res = await handoff(b);
        assert.deepEqual([res.status, res.location], [303, '/dashboard']);
        const member = await app.memberSessions.get(b.jar.get(MEMBER_SESSION_COOKIE).split('.')[0]);
        const dash = await app.dashSessions.get(b.jar.get(SESSION_COOKIE).split('.')[0]);
        assert.equal(dash.userId, ADMIN);
        assert.ok(dash.createdAt <= member.createdAt - OWNER_SESSION_MAX_AGE_MS, 'an account login never counts as a fresh Discord login');
        assert.equal(isSessionFresh(dash), false, 'Owner-area POSTs still need a Discord login');
        assert.ok(dash.expiresAt > Date.now() + 6 * DAY, 'the session itself works as usual');
        // Control: a Discord website login handed over is a fresh Discord login (created_at = that login).
        app.discord.me = { id: OTHER, username: 'other' };
        const d = browser(app);
        await memberDiscordLogin(d);
        await handoff(d);
        const dm = await app.memberSessions.get(d.jar.get(MEMBER_SESSION_COOKIE).split('.')[0]);
        const dd = await app.dashSessions.get(d.jar.get(SESSION_COOKIE).split('.')[0]);
        assert.equal(dd.createdAt, dm.createdAt);
        assert.equal(isSessionFresh(dd), true);
    } finally {
        await app.close();
    }
});

test('renewal over HTTP: an hour-old dashboard session gets a new cookie Max-Age; a fresh one does not', async () => {
    const app = await serve();
    try {
        const old = await app.dashSessions.create({ userId: ADMIN, username: 'a' }, Date.now() - 2 * HOUR);
        const cookieOf = (s) => `${SESSION_COOKIE}=${encodeURIComponent(signValue(s.id, SECRET))}`;
        const res = await fetch(`${app.base}/dashboard`, { headers: { cookie: cookieOf(old) }, redirect: 'manual' });
        const line = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
        assert.match(line, /Max-Age=604800;/, 'renewed: 7 days from now');
        const fresh = await app.dashSessions.create({ userId: ADMIN, username: 'a' });
        const res2 = await fetch(`${app.base}/dashboard`, { headers: { cookie: cookieOf(fresh) }, redirect: 'manual' });
        assert.ok(!res2.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`)), 'control: not renewed within the hour');
        // The website cookie too (the top bar reads the session on every /me page).
        const member = await app.memberSessions.create({ userId: ADMIN, username: 'a' }, Date.now() - 3 * HOUR);
        const me = await fetch(`${app.base}/me`, { headers: { cookie: `${MEMBER_SESSION_COOKIE}=${encodeURIComponent(signValue(member.id, (await import('../src/services/site/memberPortal.js')).memberSigningKey(SECRET)))}` }, redirect: 'manual' });
        assert.match(me.headers.getSetCookie().find((c) => c.startsWith(`${MEMBER_SESSION_COOKIE}=`)), /Path=\/me; HttpOnly; SameSite=Lax; Max-Age=604800;/);
    } finally {
        await app.close();
    }
});

test('dashboard "Log out on all devices": every session of that Discord user ends; CSRF and Origin checked; others untouched', async () => {
    const app = await serve();
    try {
        const mine = await app.dashSessions.create({ userId: ADMIN, username: 'a' });
        const phone = await app.dashSessions.create({ userId: ADMIN, username: 'a' });
        const other = await app.dashSessions.create({ userId: OTHER, username: 'o' });
        const website = await app.memberSessions.create({ userId: ADMIN, username: 'a' });
        const otherWebsite = await app.memberSessions.create({ userId: OTHER, username: 'o' });
        await app.dashboard.guildListStore.remember(ADMIN, [{ id: A, name: 'Alpha' }]);
        const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(mine.id, SECRET))}`;
        const post = (form, origin = ORIGIN) => fetch(`${app.base}/dashboard/logout-all`, {
            method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
            headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
        });
        assert.equal((await post({})).status, 403, 'no CSRF');
        assert.equal((await post({ csrf: other.csrf })).status, 403, "another session's token");
        assert.equal((await post({ csrf: mine.csrf }, 'https://evil.example')).status, 403, 'foreign Origin');
        assert.equal(app.dashSessions.size(), 3, 'nothing ended by the refused POSTs');
        // The picker shows the button.
        const picker = await fetch(`${app.base}/dashboard`, { headers: { cookie } });
        assert.match(await picker.text(), /action="\/dashboard\/logout-all"/);
        const res = await post({ csrf: mine.csrf });
        assert.deepEqual([res.status, res.headers.get('location')], [303, '/']);
        assert.ok(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && c.includes('Max-Age=0')));
        assert.equal(await app.dashSessions.get(mine.id), null);
        assert.equal(await app.dashSessions.get(phone.id), null, 'the other device too');
        assert.ok(await app.dashSessions.get(other.id), 'control: another user stays logged in');
        assert.equal(await app.memberSessions.get(website.id), null, 'the website login of that Discord id too (it could open the dashboard again)');
        assert.ok(await app.memberSessions.get(otherWebsite.id), 'control: another user\'s website login stays');
        assert.ok(res.headers.getSetCookie().some((c) => c.startsWith(`${SSO_HINT_COOKIE}=;`)), 'the hint is cleared');
        assert.equal(app.kv.rows.has(guildListKey(ADMIN)), false, 'the stored server list is gone');
    } finally {
        await app.close();
    }
});

test('account "Log out on all devices" ends the account\'s website sessions, its Discord id\'s, and its dashboard sessions; password change ends dashboard sessions', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        await b.request('/me/signup');
        await b.request('/me/signup', { form: { username: 'away_cat', password: PASSWORD, birth_date: '2000-05-05', accept: 'yes' } });
        await b.request('/me/link');
        const start = await b.request('/me/link', { form: {} });
        await b.request(`/me/callback?code=c&state=${encodeURIComponent(new URL(start.location).searchParams.get('state'))}`);
        await handoff(b); // a dashboard session made from this account
        const discordOnly = browser(app);
        await memberDiscordLogin(discordOnly); // the same Discord id, logged in with Discord on another device
        const otherDash = await app.dashSessions.create({ userId: OTHER, username: 'o' });
        const settings = await b.request('/me/account');
        assert.match(settings.body, /action="\/me\/account\/logout-all"/);
        const csrf = b.csrf;

        // Password change (control for the flow below): the dashboard sessions of the Discord id end, this website login stays.
        const extraDash = await app.dashSessions.create({ userId: ADMIN, username: 'a' });
        const changed = await b.request('/me/account/password', { form: { password: PASSWORD, new_password: `${PASSWORD}x` } });
        assert.equal(changed.status, 303);
        assert.equal(await app.dashSessions.get(extraDash.id), null, 'password change: dashboard sessions of the Discord id end');
        assert.ok(await app.dashSessions.get(otherDash.id), 'another user stays');
        assert.ok(b.jar.has(MEMBER_SESSION_COOKIE) && (await app.memberSessions.get(b.jar.get(MEMBER_SESSION_COOKIE).split('.')[0])), 'this login stays');
        assert.equal(app.memberSessions.size(), 1, 'the Discord-login website session of the same Discord id ended too');

        await handoff(b);
        assert.ok(app.dashSessions.size() >= 2);
        b.csrf = 'w'.repeat(32);
        assert.equal((await b.request('/me/account/logout-all', { form: {} })).status, 403, 'no valid CSRF');
        assert.equal(app.memberSessions.size(), 1, 'nothing ended by the refused POST');
        b.csrf = csrf;
        await b.request('/me/account');
        const bad = await b.request('/me/account/logout-all', { form: {}, origin: 'https://evil.example' });
        assert.equal(bad.status, 403, 'foreign Origin');
        await b.request('/me/account');
        const done = await b.request('/me/account/logout-all', { form: {} });
        assert.equal(done.status, 200);
        assert.match(done.body, /Logged out everywhere/);
        assert.ok(!b.jar.has(MEMBER_SESSION_COOKIE));
        assert.equal(app.memberSessions.size(), 0, 'every website session of the account and of its Discord id');
        assert.equal(app.dashSessions.size(), 1, 'only the other user\'s dashboard session is left');
        assert.ok(await app.dashSessions.get(otherDash.id));
        assert.equal((await discordOnly.request('/me')).body.includes('Log in with Discord'), true, 'the other device is logged out');
        assert.ok(app.dashSessions.hashes().every((h) => h === hashSessionId(otherDash.id)));
        assert.equal(app.kv.rows.has(guildListKey(ADMIN)), false, 'the stored dashboard server list is forgotten');
    } finally {
        await app.close();
    }
});

test('turning two-step login on ends the account\'s other logins (website and dashboard); this one stays', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        await b.request('/me/signup');
        await b.request('/me/signup', { form: { username: 'safe_cat', password: PASSWORD, birth_date: '2000-05-05', accept: 'yes' } });
        await b.request('/me/link');
        const start = await b.request('/me/link', { form: {} });
        await b.request(`/me/callback?code=c&state=${encodeURIComponent(new URL(start.location).searchParams.get('state'))}`);
        await handoff(b); // a dashboard session made from this account
        const discordOnly = browser(app);
        await memberDiscordLogin(discordOnly); // the same Discord id on another device
        const otherDash = await app.dashSessions.create({ userId: OTHER, username: 'o' });
        assert.ok(app.memberSessions.size() >= 2 && app.dashSessions.size() >= 2);
        await b.request('/me/account');
        const setup = await b.request('/me/account/2fa/start', { form: {} });
        assert.equal(setup.status, 200);
        const key = /<code class="key-code">([A-Z2-7 ]+)<\/code>/.exec(setup.body)[1];
        const pending = /name="pending" value="([^"]+)"/.exec(setup.body)[1];
        // Control: a wrong code turns nothing on and ends nothing.
        const secret = base32Decode(key);
        const wrong = '000000' === totp(secret) ? '111111' : '000000';
        await b.request('/me/account/2fa/enable', { form: { pending, password: PASSWORD, code: wrong } });
        assert.ok(app.memberSessions.size() >= 2, 'a refused code ends nothing');
        // A stolen login without the password: refused, nothing ends (the owner is not locked out).
        const noPassword = await b.request('/me/account/2fa/enable', { form: { pending, password: 'guess', code: totp(secret) } });
        assert.equal(noPassword.status, 401);
        assert.ok(app.memberSessions.size() >= 2 && app.dashSessions.size() >= 2, 'a wrong password ends nothing');
        const on = await b.request('/me/account/2fa/enable', { form: { pending, password: PASSWORD, code: totp(secret) } });
        assert.equal(on.status, 200);
        assert.equal(app.memberSessions.size(), 1, 'only this website login is left');
        assert.ok(await app.memberSessions.get(b.jar.get(MEMBER_SESSION_COOKIE).split('.')[0]), 'this login stays');
        assert.equal(app.dashSessions.size(), 1, 'the Discord id\'s dashboard sessions ended');
        assert.ok(await app.dashSessions.get(otherDash.id), 'another user stays');
    } finally {
        await app.close();
    }
});

test('a dashboard restart keeps the OAuth server list: the picker after a new app instance still lists the servers', async () => {
    const app = await serve();
    try {
        const b = browser(app);
        const start = await b.request('/dashboard?discord=1');
        const state = new URL(start.location).searchParams.get('state');
        const cb = await b.request(`/dashboard/oauth/callback?code=c&state=${encodeURIComponent(state)}`);
        assert.equal(cb.status, 303);
        assert.deepEqual(app.kv.rows.get(guildListKey(ADMIN)), [{ id: A, name: 'Alpha', icon: null, canManage: true }], 'stored without the token');
        // "Restart": wipe the memory cache only.
        app.dashboard.guildLists.clear();
        const picker = await b.request('/dashboard');
        assert.ok(picker.body.includes(`href="/dashboard/${A}/overview"`), 'A is listed from the store');
        assert.doesNotMatch(picker.body, /Server list not loaded/);
        // Control: with the stored list gone too, the picker asks for a refresh.
        app.dashboard.guildLists.clear();
        app.kv.rows.clear();
        assert.match((await b.request('/dashboard')).body, /Server list not loaded/);
    } finally {
        await app.close();
    }
});

test('SSO while the key-value store does not answer: the bot list is kept in memory only, the stored OAuth list is not overwritten', async () => {
    const app = await serve();
    try {
        const oauthList = [{ id: A, name: 'Alpha', icon: null, canManage: true, owner: true, listedAt: 5 }];
        app.kv.rows.set(guildListKey(ADMIN), oauthList);
        app.kv.down = true;
        const b = browser(app);
        await memberDiscordLogin(b);
        assert.equal((await handoff(b)).status, 303);
        app.kv.down = false;
        assert.deepEqual(app.kv.rows.get(guildListKey(ADMIN)), oauthList, 'the stored list is untouched');
        assert.ok(app.dashboard.guildLists.get(ADMIN).every((g) => g.fromBot), 'this run uses the bot list from memory');
        // Control: with the store answering and no list stored, the bot list is stored.
        app.kv.rows.clear();
        app.dashboard.guildLists.clear();
        const c = browser(app);
        await memberDiscordLogin(c);
        await handoff(c);
        assert.ok(app.kv.rows.get(guildListKey(ADMIN)).every((g) => g.fromBot));
    } finally {
        await app.close();
    }
});
