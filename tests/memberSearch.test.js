// Find a member (memberSearch.js): the search (cache + Discord search + ban list, short cache),
// the results page and the type-ahead JSON behind the login (auth, cross-site refusal, rate
// limit, escaped names), and the member fields that replaced the typed user IDs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard, dashboardSettings, safeBackPath } from '../src/services/dashboard/routes.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import { SESSION_COOKIE, signValue } from '../src/services/dashboard/security.js';
import {
    createMemberSearch, memberField, parseUserRef, pickedFromQuery, searchJson, searchParams, useHref,
} from '../src/services/dashboard/memberSearch.js';
import { routeKey, requiredLevel } from '../src/services/dashboard/permissions.js';
import { userIdField } from '../src/services/dashboard/forms.js';

const SECRET = 'z'.repeat(64);
const GUILD = '100000000000000001';
const ADMIN = '200000000000000002';
const STRANGER = '200000000000000009';
const ALICE = '300000000000000001';
const BOB = '300000000000000002';
const EVIL = '300000000000000003';
const BANNED = '300000000000000004';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};

const member = (id, username, nickname = null, globalName = null) => ({ id, nickname, user: { id, username, globalName, bot: false } });

/** A guild with a member cache, Discord's search (prefix, recorded) and a ban list. */
function makeGuild({ searchFails = false } = {}) {
    const searches = [];
    const banFetches = [];
    const cache = new Map([[ALICE, member(ALICE, 'alice', 'Ally')], [BOB, member(BOB, 'bob')]]);
    const remote = [member(EVIL, 'bobevil', '<img src=x onerror=alert(1)>')];
    const guild = {
        id: GUILD, name: 'Main',
        members: {
            cache,
            search: async ({ query, limit }) => {
                searches.push({ query, limit });
                if (searchFails) throw new Error('rate limited');
                return new Map(remote.filter((m) => m.user.username.startsWith(query.toLowerCase()) || String(m.nickname).toLowerCase().startsWith(query.toLowerCase())).map((m) => [m.id, m]));
            },
            fetch: async (id) => (id === EVIL ? remote[0] : null),
        },
        bans: {
            cache: new Map(),
            fetch: async (arg) => {
                banFetches.push(arg);
                const ban = { user: { id: BANNED, username: 'bobspammer', globalName: null } };
                if (typeof arg === 'string') return arg === BANNED ? ban : null;
                return new Map([[BANNED, ban]]);
            },
        },
    };
    return { guild, searches, banFetches };
}

test('parseUserRef: an ID or a mention, nothing else', () => {
    assert.equal(parseUserRef(ALICE), ALICE);
    assert.equal(parseUserRef(` <@${ALICE}> `), ALICE);
    assert.equal(parseUserRef(`<@!${ALICE}>`), ALICE);
    for (const bad of ['alice', '123', `<@&${ALICE}>`, `<#${ALICE}>`, `${ALICE}x`, null, undefined, 42]) assert.equal(parseUserRef(bad), null, String(bad));
    assert.equal(pickedFromQuery({ a: ALICE, b: 'x<b>', c: [ALICE] }, 'a'), ALICE);
    assert.equal(pickedFromQuery({ b: 'x<b>' }, 'b'), '');
    assert.equal(pickedFromQuery({ c: [ALICE] }, 'c'), '', 'arrays never pass');
    // The module forms' userIdField takes a mention too.
    assert.equal(userIdField({ id: `<@${BOB}>` }, 'id', 'User'), BOB);
    assert.throws(() => userIdField({ id: 'bob' }, 'id', 'User'));
});

test('search: cache (any part of a name) + Discord search (prefix) merged, exact/prefix first; IDs looked up; short cache', async () => {
    let now = 1000;
    const { guild, searches } = makeGuild();
    const s = createMemberSearch({ now: () => now });
    const { results, error } = await s.search(guild, 'bob');
    assert.equal(error, null);
    assert.deepEqual(results.map((r) => r.id), [BOB, EVIL], 'exact name first, then prefix matches');
    assert.equal(results[1].name, '<img src=x onerror=alert(1)>', 'raw here; escaped where shown');
    assert.deepEqual(searches, [{ query: 'bob', limit: 10 }]);
    assert.deepEqual((await s.search(guild, 'ALL')).results.map((r) => r.id), [ALICE], 'nickname, any case');
    await s.search(guild, 'bob');
    assert.equal(searches.filter((q) => q.query === 'bob').length, 1, 'cached');
    now += 31_000;
    await s.search(guild, 'bob');
    assert.equal(searches.filter((q) => q.query === 'bob').length, 2, 'cache expires after 30 s');
    // IDs and mentions: one member lookup, no name search.
    assert.deepEqual((await s.search(guild, `<@${EVIL}>`)).results.map((r) => r.id), [EVIL]);
    assert.deepEqual((await s.search(guild, BANNED)).results, [], 'not a member, bans not asked for');
    assert.match((await s.search(guild, 'b')).error, /at least 2 letters/);
    assert.deepEqual(await s.search(null, 'bob'), { results: [], error: null });
});

test('search: banned users only where asked for (ban list cached); a Discord failure keeps the cached members and is not cached', async () => {
    const { guild, banFetches } = makeGuild();
    const s = createMemberSearch();
    assert.ok(!(await s.search(guild, 'bobs')).results.length);
    const withBans = await s.search(guild, 'bobs', { includeBans: true });
    assert.deepEqual(withBans.results.map((r) => [r.id, r.banned]), [[BANNED, true]]);
    await s.search(guild, 'spam', { includeBans: true });
    assert.equal(banFetches.filter((a) => typeof a === 'object').length, 1, 'ban list fetched once');
    assert.deepEqual((await s.search(guild, BANNED, { includeBans: true })).results.map((r) => r.id), [BANNED], 'a banned ID');

    const broken = makeGuild({ searchFails: true });
    const t = createMemberSearch();
    const first = await t.search(broken.guild, 'bob');
    assert.deepEqual(first.results.map((r) => r.id), [BOB]);
    assert.match(first.error, /Discord did not answer/);
    await t.search(broken.guild, 'bob');
    assert.equal(broken.searches.length, 2, 'a failed search is tried again');
});

test('search page params: unknown field names, outside paths and odd anchors are dropped; Use goes back with the ID set', () => {
    const p = searchParams({ q: ' bob ', for: 'user_b', back: '/dashboard/nocontact?user_a=300000000000000001', at: 'nocontact-start', bans: '1' }, safeBackPath);
    assert.deepEqual(p, { q: 'bob', pick: 'user_b', back: '/dashboard/nocontact?user_a=300000000000000001', anchor: 'nocontact-start', bans: true });
    assert.equal(useHref(p, BOB), `/dashboard/nocontact?user_a=${ALICE}&user_b=${BOB}#s-nocontact-start`);
    assert.equal(useHref({ ...p, back: `/dashboard/nocontact?user_b=${ALICE}` }, BOB), `/dashboard/nocontact?user_b=${BOB}#s-nocontact-start`, 'an old pick is replaced');
    const bad = searchParams({ for: 'x"><script>', back: 'https://evil.example/', at: '"><b>', q: ['a'] }, safeBackPath);
    assert.deepEqual(bad, { q: '', pick: '', back: '/dashboard/overview', anchor: '', bans: false });
});

test('member field: still takes an ID or mention; Find link and type-ahead attribute; escaped values; picked name shown', () => {
    const { guild } = makeGuild();
    const field = String(memberField({ name: 'user_a', label: 'First member', value: ALICE, required: true, back: '/dashboard/nocontact', anchor: 'nocontact-start', guild }));
    assert.match(field, /name="user_a"/);
    assert.match(field, /data-member-search="\/dashboard\/members\/search\.json"/);
    assert.match(field, /Picked: <b>Ally<\/b> \(@alice\)/);
    assert.ok(field.includes('href="/dashboard/members/search?for=user_a&amp;back=%2Fdashboard%2Fnocontact&amp;at=nocontact-start"'));
    assert.ok(!/inputmode="numeric"/.test(field), 'not a number field any more');
    const typed = String(memberField({ name: 'id', label: 'x', value: '"><script>', back: '/dashboard/logging', bans: true }));
    assert.ok(typed.includes('value="&quot;&gt;&lt;script&gt;"') && !typed.includes('"><script>'));
    assert.match(typed, /search\.json\?bans=1/);
    assert.match(typed, /bans=1/);
});

test('routes: Administrator-only keys for the search page and JSON (moderators and unknown levels refused by the gate)', () => {
    assert.equal(routeKey('GET', '/members/search'), 'member.search');
    assert.equal(routeKey('GET', '/members/search.json'), 'member.search');
    assert.equal(requiredLevel('member.search'), 'admin');
});

// ── through the dashboard (requireUser → handler) ────────────────────────

function fakeRes() {
    return {
        statusCode: 200, headers: {}, cookies: [], body: null, redirectedTo: null, contentType: null,
        status(code) { this.statusCode = code; return this; },
        type(t) { this.contentType = t; return this; },
        send(body) { this.body = body; return this; },
        set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; },
        append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
}

async function setup({ userId = ADMIN, rate } = {}) {
    const world = makeGuild();
    const client = { user: { id: '999999999999999998' }, guilds: { cache: new Map([[GUILD, world.guild]]) }, users: { cache: new Map() } };
    const sessions = createMemorySessionStore();
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: id === ADMIN, isOwnerId: false }) });
    const auditStore = { writeRows: async () => 0, list: async () => ({ rows: [], total: 0 }), users: async () => [] };
    const d = createDashboard({
        client, settings: dashboardSettings(ENV), sessions, access, auditStore, env: ENV,
        services: { getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) },
        data: { overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) } },
        memberSearch: createMemberSearch(rate ? { rate } : {}),
    });
    const session = await sessions.create({ userId, username: 'admin' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, cookie, world };
}

async function get(h, handler, query = {}, headers = {}, path = '/members/search') {
    const res = fakeRes();
    const req = { method: 'GET', path, query, headers: { cookie: h.cookie, ...headers } };
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (passed) await handler(req, res);
    return res;
}

test('search page: logged out → login; not an Administrator → refused; no query → just the form', async () => {
    const h = await setup();
    const out = fakeRes();
    await h.d.requireUser({ method: 'GET', path: '/members/search', query: {}, headers: {} }, out, () => assert.fail('passed'));
    assert.equal(out.statusCode, 302);
    const stranger = await setup({ userId: STRANGER });
    const refused = await get(stranger, stranger.d.memberSearch, { q: 'bob' });
    assert.equal(refused.statusCode, 403);
    assert.equal(stranger.world.searches.length, 0, 'no Discord call');
    const empty = await get(h, h.d.memberSearch, { for: 'user_a', back: '/dashboard/nocontact' });
    assert.equal(empty.statusCode, 200);
    assert.match(empty.body, /<form method="get" action="\/dashboard\/members\/search"/);
    assert.equal(h.world.searches.length, 0);
});

test('search page: results escaped, each with a Use link back to the form; works without JS (plain links and a GET form)', async () => {
    const h = await setup();
    const res = await get(h, h.d.memberSearch, { q: 'bob', for: 'user_b', back: `/dashboard/nocontact?user_a=${ALICE}`, at: 'nocontact-start' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!res.body.includes('<img src=x onerror'), 'names escaped');
    assert.ok(res.body.includes(`href="/dashboard/nocontact?user_a=${ALICE}&amp;user_b=${EVIL}#s-nocontact-start"`));
    assert.ok(!/<script>(?!<\/script>)|style=/.test(res.body.replace(/<script src="[^"]+" defer><\/script>/, '')), 'no inline script or style');
    const none = await get(h, h.d.memberSearch, { q: 'zzz' });
    assert.match(none.body, /No member matches "zzz"/);
});

test('search page and JSON: a cross-site request is refused; the per-user limit answers 429', async () => {
    const h = await setup({ rate: { limit: 2, windowMs: 60_000 } });
    const cross = await get(h, h.d.memberSearch, { q: 'bob' }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(cross.statusCode, 403);
    const crossJson = await get(h, h.d.memberSearchJson, { q: 'bob' }, { 'sec-fetch-site': 'cross-site' }, '/members/search.json');
    assert.equal(crossJson.statusCode, 403);
    assert.equal(h.world.searches.length, 0);
    assert.equal((await get(h, h.d.memberSearchJson, { q: 'bob' }, {}, '/members/search.json')).statusCode, 200);
    assert.equal((await get(h, h.d.memberSearch, { q: 'ali' })).statusCode, 200);
    const limited = await get(h, h.d.memberSearchJson, { q: 'bo' }, {}, '/members/search.json');
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['Retry-After'], '60');
    assert.equal((await get(h, h.d.memberSearch, { q: 'carl' })).statusCode, 429, 'the page shares the limit');
});

test('JSON: results as JSON (application/json, no-store headers come from the router), <, > and & escaped', async () => {
    const h = await setup();
    const res = await get(h, h.d.memberSearchJson, { q: 'bob' }, {}, '/members/search.json');
    assert.equal(res.statusCode, 200);
    assert.equal(res.contentType, 'application/json');
    assert.ok(!/[<>]/.test(res.body), 'no raw angle brackets');
    const body = JSON.parse(res.body);
    assert.deepEqual(body.results.map((r) => r.id), [BOB, EVIL]);
    assert.equal(body.results[1].name, '<img src=x onerror=alert(1)>');
    assert.deepEqual(Object.keys(body.results[0]).sort(), ['banned', 'bot', 'id', 'name', 'username']);
    assert.deepEqual(JSON.parse((await get(h, h.d.memberSearchJson, {}, {}, '/members/search.json')).body), { results: [] });
    assert.equal(searchJson({ a: '</script>&' }), '{"a":"\\u003c/script\\u003e\\u0026"}');
    const stranger = await setup({ userId: STRANGER });
    assert.equal((await get(stranger, stranger.d.memberSearchJson, { q: 'bob' }, {}, '/members/search.json')).statusCode, 403);
});
