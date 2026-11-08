// Multi-server B3 (A5): the cross-server / IDOR suite (docs/multi-server-b3.md section 5).
// A real Express app on 127.0.0.1 (createDashboardApp) with fake servers: MAIN and SUPPORT
// (Mewvo's own), A (ADMIN is an Administrator there), B (someone else's server: who has what
// there is set per test) and C (the bot is not in it). Access uses the real memberFacts on fake
// Discord members, so taking a permission away mid-session works like in Discord. Every data
// and service dependency is a recording spy: a call that a test did not plan for is logged as
// unexpected and throws (a 500), so "nothing was read or written" is checked, not assumed.
// No Discord, no database. The pure helpers and the basic routing are in dashboardRouting.test.js.

import { test } from 'node:test';
import { MEWVO_TEMPLATES } from '../src/config/mewvoTemplates.js';
import assert from 'node:assert/strict';
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000009';
// Mewvo's own servers for hasOwnerPower / isMewvoServer (read from the env at import time).
Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT });

const { createAccessChecker, memberFacts } = await import('../src/services/dashboard/access.js');
const { createMemorySessionStore } = await import('../src/services/dashboard/sessionStore.js');
const { SESSION_COOKIE, STATE_COOKIE, signValue } = await import('../src/services/dashboard/security.js');
const { OWNER_AREA, ROUTES, routeKey } = await import('../src/services/dashboard/permissions.js');
const { MODULES, getAction } = await import('../src/services/dashboard/modules/index.js');
const { FIELD_LEVEL, MANAGER_ACTIONS, PRIVILEGE_PATTERN } = await import('./helpers/privilegedActions.js');
const { createConfirmStore } = await import('../src/services/dashboard/confirmTokens.js');
const { scopedConfirms, createLruCache } = await import('../src/services/dashboard/guildDashboards.js');
const { MAX_ADDABLE_GUILDS, createGuildListCache, guildListFrom } = await import('../src/services/dashboard/serverPicker.js');
const { createDashboardApp, dashboardSettings } = await import('../src/services/dashboard/routes.js');
const { createAuditStore } = await import('../src/services/dashboard/audit.js');
const { hasOwnerPower } = await import('../src/utils/ownerPower.js');
const { setSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');

const SECRET = 'x'.repeat(64);
const A = '110000000000000011';
const B = '120000000000000012';
const C = '130000000000000013'; // the bot is not here
const ADMIN = '200000000000000002'; // Administrator in MAIN and A (in B only when a test says so)
const MANAGER = '220000000000000022'; // Manage Server in B (when a test says so)
const OWNER = '500000000000000005'; // OWNER_IDS
const GUILD_OWNER = '600000000000000006';
const BOT = '999999999999999999';
const A_MEMBER = '310000000000000031';
const B_MEMBER = '320000000000000032';
const A_CHANNEL = '410000000000000041';
const B_CHANNEL = '420000000000000042';
const A_ROLE = '510000000000000051';
const B_ROLE = '520000000000000052';
const A_CASE = 'abcde';
const B_CASE = 'bcdfg';
const A_RULE = '7';
const A_INCIDENT = '5';
const MOD_ROLE = '530000000000000053';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: `${ORIGIN}/`, MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, NODE_ENV: 'test',
};
// No rate limit gets in the way of the sweeps (the limits have their own tests).
const NO_LIMITS = Object.fromEntries(['session', 'ip', 'static', 'post'].map((k) => [k, { limit: 1e9, windowMs: 60_000 }]));

// Settings rows exist for the non-home servers (resolveSetting throws for a server never read).
setSettingsCacheForTests(A, {});
setSettingsCacheForTests(B, {});

// ── fake Discord ────────────────────────────────────────────────────────

function permissionSet(flags) {
    const bits = new Set(flags.map((name) => PermissionFlagsBits[name]));
    const one = (bit) => bits.has(typeof bit === 'string' ? PermissionFlagsBits[bit] : bit);
    return {
        bits,
        has: (bit) => bits.has(PermissionFlagsBits.Administrator) || [bit].flat().every(one),
        toArray: () => [...bits].map(String),
    };
}

function fakeWorld() {
    const discord = []; // every change made in Discord: [what, guildId, id]
    const users = new Map();
    const guilds = new Map();
    function addGuild(id, name) {
        const guild = {
            id, name, ownerId: GUILD_OWNER, memberCount: 0, iconURL: () => null,
            channels: { cache: new Map() },
            roles: { cache: new Map() },
            bans: { fetch: async () => new Map() },
            fetches: 0,
        };
        guild.roles.cache.set(id, { id, name: '@everyone', position: 0, managed: false, guild, permissions: permissionSet([]) });
        const cache = new Map();
        guild.members = {
            cache,
            fetch: async (arg) => {
                if (arg === undefined) return cache;
                guild.fetches += 1;
                const userId = typeof arg === 'string' ? arg : arg?.user;
                const member = cache.get(userId);
                if (!member) throw new Error('Unknown Member');
                return member;
            },
        };
        guilds.set(id, guild);
        return guild;
    }
    function addMember(guild, userId, { perms = [], position = 1 } = {}) {
        const user = users.get(userId) || { id: userId, username: `user${userId.slice(-3)}`, globalName: null, bot: userId === BOT, createdAt: new Date(0), displayAvatarURL: () => null };
        users.set(userId, user);
        const member = {
            id: userId, user, guild, nickname: null, joinedAt: new Date(0), joinedTimestamp: 0, displayName: user.username,
            permissions: permissionSet(perms), communicationDisabledUntilTimestamp: null,
            roles: {
                highest: { position }, cache: new Map(),
                add: async (roleId) => { discord.push(['roles.add', guild.id, userId, roleId]); },
                remove: async (roleId) => { discord.push(['roles.remove', guild.id, userId, roleId]); },
            },
            timeout: async (ms) => { discord.push(['timeout', guild.id, userId, ms]); },
            setNickname: async (nick) => { discord.push(['setNickname', guild.id, userId, nick]); },
        };
        guild.members.cache.set(userId, member);
        guild.memberCount = guild.members.cache.size;
        return member;
    }
    function addChannel(guild, id, name) {
        const channel = {
            id, name, type: ChannelType.GuildText, guild,
            send: async () => { discord.push(['send', guild.id, id]); return { id: '1' }; },
            messages: { fetch: async () => new Map() },
            permissionsFor: () => permissionSet(['Administrator']),
        };
        guild.channels.cache.set(id, channel);
        return channel;
    }
    function addRole(guild, id, name, position = 2) {
        const role = { id, name, position, managed: false, guild, permissions: permissionSet([]) };
        guild.roles.cache.set(id, role);
        return role;
    }
    for (const [id, name] of [[MAIN, 'Mewvo'], [SUPPORT, 'Support'], [A, 'Alpha'], [B, 'Bravo']]) {
        const guild = addGuild(id, name);
        guild.members.me = addMember(guild, BOT, { perms: ['Administrator'], position: 50 });
        addMember(guild, GUILD_OWNER, { position: 60 });
    }
    addMember(guilds.get(MAIN), ADMIN, { perms: ['Administrator'], position: 10 });
    addMember(guilds.get(MAIN), OWNER, { position: 1 });
    addMember(guilds.get(A), ADMIN, { perms: ['Administrator'], position: 10 });
    addMember(guilds.get(A), A_MEMBER, { position: 1 });
    addMember(guilds.get(B), B_MEMBER, { position: 1 });
    addChannel(guilds.get(A), A_CHANNEL, 'alpha-chat');
    addChannel(guilds.get(B), B_CHANNEL, 'bravo-chat');
    addRole(guilds.get(A), A_ROLE, 'Alpha role');
    addRole(guilds.get(B), B_ROLE, 'Bravo role');
    const client = {
        user: { id: BOT },
        guilds: { cache: guilds },
        users: {
            cache: users,
            fetch: async (id) => {
                const user = users.get(String(id));
                if (!user) throw new Error('Unknown User');
                return user;
            },
        },
    };
    return { client, guilds, discord, addMember, guild: (id) => guilds.get(id) };
}

// ── recording spies ─────────────────────────────────────────────────────

/**
 * An object whose functions are recorded in `log` ({ fn, args }); any other property is a
 * function that records `unexpected: true` and throws (the route then answers 500).
 */
function spyDeps(name, impl, log) {
    return new Proxy(impl, {
        get(target, prop) {
            if (typeof prop === 'symbol') return target[prop];
            if (Object.hasOwn(target, prop)) {
                const value = target[prop];
                if (typeof value !== 'function') return value;
                return (...args) => {
                    log.push({ fn: `${name}.${prop}`, args });
                    return value(...args);
                };
            }
            if (prop === 'then' || prop === 'toJSON') return undefined;
            return (...args) => {
                log.push({ fn: `${name}.${prop}`, args, unexpected: true });
                throw new Error(`unexpected call ${name}.${prop}`);
            };
        },
    });
}

/** True when `id` is one of the arguments: a string, or an object (guild, record) whose id / guild_id / guildId it is. */
function mentions(args, id, depth = 0) {
    for (const arg of args) {
        if (arg === id) return true;
        if (!arg || typeof arg !== 'object' || depth > 1) continue;
        if (arg.id === id || arg.guild_id === id || arg.guildId === id || arg.guild?.id === id) return true;
        if (Array.isArray(arg) && mentions(arg, id, depth + 1)) return true;
        if (Object.getPrototypeOf(arg) === Object.prototype && mentions(Object.values(arg), id, depth + 1)) return true;
    }
    return false;
}

const WRITES = /\.(update|set|save|add|remove|delete|disable|edit|void|decide|execute|send|close|fix|end|clear|create|write|record|post|erase|lift|restore|warn|start|apply)/i;

// ── the app ─────────────────────────────────────────────────────────────

const caseRecord = (code, guildId, extra = {}) => ({
    case_code: code, guild_id: guildId, type: 'ban', name: 'Ban', reason: 'spam', target_user_id: A_MEMBER, target_username: 'target',
    moderator_id: ADMIN, moderator_username: 'admin', created_at: new Date(0), expires_at: null, voided_at: null, is_auto: false, ...extra,
});

/**
 * owners: OWNER_IDS. Members of B are added per test: bMembers = { userId: { perms, position } }.
 * cases: code → record (getCaseByCode answers it whatever server asks: the route must check).
 */
async function serve({ owners = [OWNER], bMembers = {}, mainMembers = {}, cases = null, blocked = { users: new Set(), guilds: new Set() }, guildsAnswer = null } = {}) {
    const world = fakeWorld();
    for (const [userId, spec] of Object.entries(bMembers)) world.addMember(world.guild(B), userId, spec);
    for (const [userId, spec] of Object.entries(mainMembers)) world.addMember(world.guild(MAIN), userId, spec);
    const { client } = world;
    const log = [];
    const caseMap = new Map(Object.entries(cases || { [A_CASE]: caseRecord(A_CASE, A) }));
    const lookup = async (code) => caseMap.get(code) || null;
    const rules = new Map([[A, [{ id: Number(A_RULE), name: 'Alpha rule', trigger: 'days_in_server', threshold: 1, roleId: A_ROLE, enabled: true }]]]);
    const ruleOf = (guildId, id) => (rules.get(guildId) || []).find((r) => r.id === Number(id)) || null;
    const massBlocks = new Map(); // `${guildId}:${userId}` → block
    const auditRows = [];
    const auditQuery = async (sql, params) => {
        log.push({ fn: 'auditQuery', args: params });
        if (/^\s*INSERT/i.test(sql)) {
            auditRows.push({ id: auditRows.length + 1, guild_id: params[0], user_id: params[1], username: params[2], module: params[3], key: params[4], old: JSON.parse(params[5]), new: JSON.parse(params[6]), created_at: new Date(0) });
            return { rows: [] };
        }
        const rows = auditRows.filter((r) => r.guild_id === params[0]);
        if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: rows.length }] };
        if (/GROUP BY user_id/.test(sql)) return { rows: rows.map((r) => ({ user_id: r.user_id, username: r.username })) };
        return { rows: [...rows].reverse() };
    };
    const isOwner = (id) => owners.includes(String(id));
    const services = spyDeps('services', {
        getAutomodSettings: async () => null, getJoinToCreateConfiguration: async () => null, getApplicationSettings: async () => null,
        getGuildConfig: async () => ({ birthdayChannelId: null, birthdayTimezone: 'UTC', birthdayRoleId: null }),
        updateBirthdaySettings: async (c, guildId, patch) => ({ before: {}, after: patch }),
        updateSettings: async (guildId, patch) => ({ changes: Object.entries(patch).map(([key, value]) => ({ key, old: null, new: value })) }),
        postModLog: async () => {},
        getCommandAccessSnapshot: () => ({}),
        // Messages page (home-only announcement templates).
        listScheduledMessages: async () => [], openPollsFor: async () => ({ polls: [], partial: false }),
        getSetting: async () => 'en',
        postBotMessage: async () => ({ message: { id: '790000000000000001' } }),
    }, log);
    const data = spyDeps('data', {
        getCaseByCode: lookup,
        getCaseEdits: async () => [], listEvidence: async () => [], getAppealHistory: async () => [], listCaseNotes: async () => [],
        resolveImageUrls: async () => new Map(),
        searchCaseRecords: async () => ({ rows: [], total: 0 }), getLatestAppealStatusesForCases: async () => new Map(),
        overview: { getGuildConfig: async () => null, getWelcomeConfig: async () => null },
    }, log);
    const enforcement = spyDeps('enforcement', {
        getCaseByCode: lookup,
        getAppealHistory: async () => [{ status: 'pending', body: '{}', created_at: new Date(0) }],
        listCasesForUser: async () => ({ rows: [], total: 0 }), getLadder: async () => null, listEvidence: async () => [], resolveImageUrls: async () => new Map(),
        getGuildConfig: async () => ({ modRole: MOD_ROLE }),
        hasOwnerPower: (userId, guildId) => hasOwnerPower(userId, guildId, { isOwner }),
        isBotOwner: isOwner,
        getMassActionBlock: async (guildId, userId) => massBlocks.get(`${guildId}:${userId}`) || null,
        recentBanKickCount: async () => 0,
        memberStandings: async () => new Map(),
        getTargetState: async (guild, userId) => ({ member: guild.members.cache.get(userId) || null, ladder: { level: 0, warnCount: 0 }, active: [], banned: false, muted: false }),
        getLatestAppealStatuses: async () => new Map(), getCountedWarns: async () => 0, listNotes: async () => [],
        memberTimeline: async () => [], getActiveOrdersFor: () => [], listTempRoles: async () => [],
    }, log);
    const memberTools = spyDeps('memberTools', {
        listRoleRules: async (guildId) => rules.get(guildId) || [],
        disableRoleRule: async (guildId, id) => ruleOf(guildId, id),
        deleteRoleRule: async (guildId, id) => ruleOf(guildId, id),
        saveRoleRule: async () => ({ before: null, after: null }),
        levelingEnabled: async () => false, loadLevels: async () => new Map(),
    }, log);
    const inbox = spyDeps('inbox', {
        // A's modmail channel: found only when looked up in A's own channel cache.
        modmailUserId: async (channel) => (channel.id === A_CHANNEL ? A_MEMBER : null),
        getTicketData: async (guildId, channelId) => (guildId === A && channelId === A_CHANNEL ? { status: 'open', userId: A_MEMBER } : null),
    }, log);
    const incidents = spyDeps('incidents', {
        list: async () => [],
        get: async (guildId, id) => (guildId === A && id === A_INCIDENT ? { id: A_INCIDENT, guild_id: A, started_at: new Date(0), ended_at: new Date(0) } : null),
        events: async () => [], sources: async () => ({}), activeId: async () => null,
    }, log);
    const settings = dashboardSettings(ENV);
    const sessions = createMemorySessionStore();
    const fetchImpl = async (url) => {
        if (url.includes('/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
        if (url.endsWith('/users/@me/guilds')) return { ok: true, status: 200, json: async () => guildsAnswer || [] };
        return { ok: true, status: 200, json: async () => ({ id: ADMIN, username: 'admin' }) };
    };
    const app = express();
    const dashboard = createDashboardApp({
        client, settings, env: ENV, sessions, fetchImpl, limits: NO_LIMITS,
        owners: () => owners,
        // The real facts (fresh member fetch, Administrator / Manage Server / moderator role, owner power here).
        accessFor: (guildId) => createAccessChecker(client, {
            guildId, facts: (c, userId, gid, opts) => memberFacts(c, userId, gid, owners, async () => ({ modRole: MOD_ROLE }), opts),
        }),
        blacklist: ({ userId, guildId } = {}) => (userId && blocked.users.has(userId) ? { kind: 'user' } : guildId && blocked.guilds.has(guildId) ? { kind: 'guild' } : null),
        settingsReady: async (guildId) => { log.push({ fn: 'settingsReady', args: [guildId] }); },
        owner: { isBotOwner: isOwner },
        services, data, enforcement, memberTools, inbox, incidents,
        auditStore: spyDeps('audit', createAuditStore({ query: auditQuery, table: 'audit' }), log),
    });
    app.use('/dashboard', dashboard.router);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function loginAs(userId = ADMIN) {
        const session = await sessions.create({ userId, username: `u${userId.slice(-2)}` });
        return { session, csrf: session.csrf, cookie: `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}` };
    }
    async function request(pathname, { method = 'GET', cookie = '', form = null, origin = ORIGIN, body = null, contentType = null } = {}) {
        const headers = { ...(cookie ? { cookie } : {}) };
        let payload = body;
        if (form) {
            headers['content-type'] = 'application/x-www-form-urlencoded';
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(form)) for (const v of [value].flat()) params.append(key, v);
            payload = params.toString();
        }
        if (contentType) headers['content-type'] = contentType;
        if (method === 'POST' && origin) headers.origin = origin;
        const res = await fetch(`${base}${pathname}`, { method, headers, body: payload, redirect: 'manual' });
        return { status: res.status, location: res.headers.get('location'), body: await res.text(), headers: res.headers };
    }
    const callsWith = (id) => log.filter((c) => c.fn !== 'settingsReady' && mentions(c.args, id));
    const writes = () => log.filter((c) => WRITES.test(c.fn) && c.fn !== 'auditQuery');
    const unexpected = () => log.filter((c) => c.unexpected);
    return {
        ...world, dashboard, sessions, log, rules, massBlocks, auditRows, caseMap, loginAs, request, callsWith, writes, unexpected, settings,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

const hidden = (body, name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(body)?.[1] ?? null;

/** Every ROUTES entry as concrete requests: [{ method, path, key }]. `/:module` and `/:module/:action` expand to every module and action. */
function concreteRoutes({ id = A_MEMBER, code = A_CASE, channel = A_CHANNEL } = {}) {
    const out = [];
    for (const [method, pattern, key] of ROUTES) {
        const methods = method === '*' ? ['GET', 'POST'] : [method];
        let paths;
        if (pattern === '/:module') paths = [...MODULES.map((m) => `/${m.key}`), '/no-such-page'];
        else if (pattern === '/:module/:action') paths = [...MODULES.flatMap((m) => Object.keys(m.actions || {}).map((a) => `/${m.key}/${a}`)), '/no-such/save'];
        else if (pattern === '/owner/*') paths = ['/owner/servers'];
        else {
            paths = [pattern
                .replace('/inbox/:kind/:id', `/inbox/modmail/${channel}`)
                .replace('/incidents/:id', `/incidents/${A_INCIDENT}`)
                .replace(':rid', A_RULE).replace(':code', code).replace(':job', 'job-1').replace(':id', id)];
        }
        for (const m of methods) for (const p of paths) out.push({ method: m, path: p, key, pattern });
    }
    return out;
}

/** A form that would pass every check of the route if access were there (valid CSRF, A's ids). */
const fullForm = (csrf) => ({
    csrf, text: 'x', reason: 'r', name: 'n', note: 'n', type: 'warn', action: 'timeout', timeout: '60s', ids: A_MEMBER, codes: A_CASE,
    channel: A_CHANNEL, channelId: A_CHANNEL, roleId: A_ROLE, id: '1', decision: 'accept', token: 'tok', fh: 'hash', enabled: 'false',
});

// ── tests ───────────────────────────────────────────────────────────────

test('the route sweep covers every ROUTES entry and each concrete path maps back to its key', () => {
    const all = concreteRoutes();
    const patterns = new Set(all.map((r) => r.pattern));
    for (const [, pattern] of ROUTES) assert.ok(patterns.has(pattern), pattern);
    for (const r of all) {
        const expected = typeof r.key === 'function' ? r.key({ module: r.path.slice(1) }) : r.key;
        // First match wins: a concrete path may hit an earlier, more specific entry (never a looser one).
        const got = routeKey(r.method, r.path);
        if (r.pattern === '/:module/:action' || r.pattern === '/:module') continue;
        assert.equal(got, expected, `${r.method} ${r.path}`);
    }
    assert.ok(all.length > 200, `${all.length} requests`);
});

test('IDOR sweep: every GET and POST of the ROUTES table under B → the uniform 404 for an admin of A only; nothing is called', async () => {
    const h = await serve();
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const reference = await h.request(`/dashboard/${C}/help`, { cookie });
        assert.equal(reference.status, 404);
        for (const r of concreteRoutes()) {
            const url = `/dashboard/${B}${r.path}${r.method === 'GET' && r.path === '/fix-permissions' ? `?channel=${A_CHANNEL}` : ''}`;
            const res = r.method === 'GET'
                ? await h.request(url, { cookie })
                : await h.request(url, { method: 'POST', cookie, form: fullForm(csrf) });
            assert.equal(res.status, 404, `${r.method} ${url}`);
            assert.equal(res.body, reference.body, `${r.method} ${url}: the same page as a server the bot is not in`);
        }
        // Also HEAD / PUT and a few spellings.
        for (const [method, p] of [['HEAD', '/cases'], ['PUT', '/handover'], ['DELETE', '/users/rules/7/delete'], ['GET', '/'], ['GET', ''], ['GET', '/CASES/ABCDE'], ['GET', '/Users/' + A_MEMBER]]) {
            const res = await h.request(`/dashboard/${B}${p}`, { method, cookie });
            assert.equal(res.status, 404, `${method} ${p}`);
        }
        assert.deepEqual(h.log, [], 'no service, data, audit or settings call at all');
        assert.equal(h.guild(B).fetches > 0, true, 'access was checked live against B');
        assert.deepEqual(h.discord, []);
    } finally {
        await h.close();
    }
});

test("A's case code under B (admin in both): page, edit, void, evidence, notes, tags, appeal page / preview / decide → 404, looked up only in B, no write", async () => {
    const h = await serve({ bMembers: { [ADMIN]: { perms: ['Administrator'], position: 10 } } });
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const gets = [`/cases/${A_CASE}`, `/appeals/${A_CASE}`];
        const posts = [
            [`/cases/${A_CASE}/edit`, { reason: 'new reason' }], [`/cases/${A_CASE}/void`, { reason: 'mistake' }], [`/cases/${A_CASE}/void`, { reason: 'x', token: 't', fh: 'h' }],
            [`/cases/${A_CASE}/evidence/add`, { link: 'https://example.com/x.png' }], [`/cases/${A_CASE}/evidence/remove`, { id: '1' }],
            [`/cases/${A_CASE}/notes`, { note: 'hello' }], [`/cases/${A_CASE}/tags`, { tags: 'spam' }],
            [`/appeals/${A_CASE}/preview`, { decision: 'accept' }], [`/appeals/${A_CASE}/decide`, { token: 't', fh: 'h' }],
        ];
        for (const p of gets) assert.equal((await h.request(`/dashboard/${B}${p}`, { cookie })).status, 404, p);
        for (const [p, form] of posts) assert.equal((await h.request(`/dashboard/${B}${p}`, { method: 'POST', cookie, form: { csrf, ...form } })).status, 404, `POST ${p}`);
        // The image upload (multipart).
        const boundary = 'xBOUNDARYx';
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
            png, Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const upload = await h.request(`/dashboard/${B}/cases/${A_CASE}/evidence/upload`, { method: 'POST', cookie, body, contentType: `multipart/form-data; boundary=${boundary}` });
        assert.equal(upload.status, 404, 'upload');
        // Bulk on the Cases page: A's code is skipped, nothing tagged or voided.
        const bulk = await h.request(`/dashboard/${B}/cases/bulk`, { method: 'POST', cookie, form: { csrf, codes: A_CASE, action: 'tag-add', tag: 'spam' } });
        assert.notEqual(bulk.status, 303);
        const lookups = h.log.filter((c) => c.fn.endsWith('.getCaseByCode'));
        assert.ok(lookups.length >= gets.length + posts.length);
        assert.ok(lookups.every((c) => c.args[1] === B), `every lookup in B: ${JSON.stringify(lookups.map((c) => c.args[1]))}`);
        assert.deepEqual(h.writes().map((c) => c.fn), [], 'nothing written');
        assert.deepEqual(h.unexpected().map((c) => c.fn), []);
        assert.deepEqual(h.callsWith(A), [], "nothing asked about A");
        // The same case in A opens (the fake is right; B is refused by the server check).
        assert.equal((await h.request(`/dashboard/${A}/cases/${A_CASE}`, { cookie })).status, 200);
    } finally {
        await h.close();
    }
});

test("A's role-rule id, inbox channel, incident id and Fix-permissions channel under B → 404, nothing written", async () => {
    const h = await serve({ bMembers: { [ADMIN]: { perms: ['Administrator'], position: 10 } } });
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        for (const p of [`/users/rules/${A_RULE}/disable`, `/users/rules/${A_RULE}/delete`]) {
            const res = await h.request(`/dashboard/${B}${p}`, { method: 'POST', cookie, form: { csrf } });
            assert.equal(res.status, 404, p);
        }
        assert.equal(h.rules.get(A).length, 1, "A's rule is untouched");
        const ruleCalls = h.log.filter((c) => c.fn.startsWith('memberTools.'));
        assert.ok(ruleCalls.length >= 2 && ruleCalls.every((c) => mentions(c.args, B) && !mentions(c.args, A)), 'role rules looked up in B only');
        // A's role in B's rule form: 400 on the role field; A's rule id with B's own role: not found in B.
        const roleA = await h.request(`/dashboard/${B}/users/rules/preview`, { method: 'POST', cookie, form: { csrf, name: 'r', trigger: 'days_in_server', threshold: '1', roleId: A_ROLE } });
        assert.equal(roleA.status, 400);
        const idA = await h.request(`/dashboard/${B}/users/rules/preview`, { method: 'POST', cookie, form: { csrf, name: 'r', trigger: 'days_in_server', threshold: '1', roleId: B_ROLE, id: A_RULE } });
        assert.equal(idA.status, 404);

        // Inbox: A's modmail channel under B.
        assert.equal((await h.request(`/dashboard/${B}/inbox/modmail/${A_CHANNEL}`, { cookie })).status, 404);
        assert.equal((await h.request(`/dashboard/${B}/inbox/ticket/${A_CHANNEL}`, { cookie })).status, 404);
        for (const p of ['reply', 'close/preview', 'close']) {
            const res = await h.request(`/dashboard/${B}/inbox/modmail/${A_CHANNEL}/${p}`, { method: 'POST', cookie, form: { csrf, text: 'hello', reason: 'done', token: 't', fh: 'h' } });
            assert.equal(res.status, 404, p);
        }
        assert.equal(h.log.filter((c) => c.fn === 'inbox.modmailUserId').length, 0, 'the channel is not in B, so never asked about');
        // The Raid timeline: A's incident under B.
        assert.equal((await h.request(`/dashboard/${B}/incidents/${A_INCIDENT}`, { cookie })).status, 404);
        assert.deepEqual(h.log.filter((c) => c.fn === 'incidents.get').map((c) => c.args[0]), [B]);
        // Fix permissions: A's channel under B.
        assert.equal((await h.request(`/dashboard/${B}/fix-permissions?channel=${A_CHANNEL}`, { cookie })).status, 404);
        assert.equal((await h.request(`/dashboard/${B}/fix-permissions`, { method: 'POST', cookie, form: { csrf, channel: A_CHANNEL, token: 't', fh: 'h' } })).status, 404);

        // The rule changes ran only as "WHERE guild_id = B AND id = 7" (roleRuleService.js), which found nothing.
        assert.deepEqual(h.writes().map((c) => [c.fn, c.args[0], c.args[1]]), [['memberTools.disableRoleRule', B, 7], ['memberTools.deleteRoleRule', B, 7]]);
        assert.deepEqual(h.unexpected().map((c) => c.fn), []);
        assert.deepEqual(h.discord, [], 'nothing sent or changed in Discord');
        // Positive control: the same ids work in A.
        assert.equal((await h.request(`/dashboard/${A}/inbox/modmail/${A_CHANNEL}`, { cookie })).status, 200);
        assert.equal((await h.request(`/dashboard/${A}/incidents/${A_INCIDENT}`, { cookie })).status, 200);
    } finally {
        await h.close();
    }
});

test("bulk jobs and confirm tokens stay in their server: A's job 404s in B, A's bulk token is refused in B", async () => {
    const h = await serve({ bMembers: { [ADMIN]: { perms: ['Administrator'], position: 10 } } });
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const preview = async (guildId) => h.request(`/dashboard/${guildId}/users/bulk/preview`, { method: 'POST', cookie, form: { csrf, action: 'timeout', timeout: '60s', ids: A_MEMBER } });
        const first = await preview(A);
        assert.equal(first.status, 200, first.body.slice(0, 300));
        const token = hidden(first.body, 'token');
        const fh = hidden(first.body, 'fh');
        assert.ok(token && fh);
        // A's token replayed in B: refused (scoped confirm store), no job, nothing changed.
        const replay = await h.request(`/dashboard/${B}/users/bulk/execute`, { method: 'POST', cookie, form: { csrf, token, fh } });
        assert.equal(replay.status, 400);
        assert.match(replay.body, /expired|again/i);
        assert.deepEqual(h.discord, []);
        // A fresh token runs in A.
        const second = await preview(A);
        const run = await h.request(`/dashboard/${A}/users/bulk/execute`, { method: 'POST', cookie, form: { csrf, token: hidden(second.body, 'token'), fh: hidden(second.body, 'fh') } });
        assert.equal(run.status, 303);
        const jobPath = run.location;
        assert.match(jobPath, new RegExp(`^/dashboard/${A}/users/bulk/[0-9a-f-]{36}$`));
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(h.discord, [['timeout', A, A_MEMBER, 60_000]]);
        assert.equal((await h.request(jobPath, { cookie })).status, 200);
        assert.equal((await h.request(jobPath.replace(A, B), { cookie })).status, 404, "A's job is not B's");
        // A's member ids posted to B's bulk form: not B's members, nobody planned.
        const inB = await preview(B);
        assert.equal(inB.status, 200);
        assert.doesNotMatch(inB.body, new RegExp(A_MEMBER));
        assert.equal(h.discord.length, 1);
        // The audit row of the job is A's.
        assert.deepEqual([...new Set(h.auditRows.map((r) => r.guild_id))], [A]);
    } finally {
        await h.close();
    }
});

test("A's member page under B (admin in both): no 404 for a real Discord user (pre-ban by id), but only B's data and no member card", async () => {
    const h = await serve({ bMembers: { [ADMIN]: { perms: ['Administrator'], position: 10 } } });
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const page = await h.request(`/dashboard/${B}/users/${A_MEMBER}`, { cookie });
        assert.equal(page.status, 200);
        assert.doesNotMatch(page.body, /Alpha/, "nothing of A's server on the page");
        const enforcementCalls = h.log.filter((c) => c.fn.startsWith('enforcement.') && !['enforcement.hasOwnerPower', 'enforcement.isBotOwner'].includes(c.fn));
        assert.ok(enforcementCalls.length > 3);
        assert.deepEqual(h.callsWith(A), [], 'nothing read with A');
        // Changing A's member from B: refused (not in this server), nothing changed in Discord.
        for (const [p, form] of [['/roles/add', { roleId: B_ROLE }], ['/nickname', { nickname: 'x' }], ['/timeout', { timeout: '60s' }]]) {
            const res = await h.request(`/dashboard/${B}/users/${A_MEMBER}${p}`, { method: 'POST', cookie, form: { csrf, ...form } });
            assert.ok(res.status >= 400 && res.status < 500, `${p}: ${res.status}`);
        }
        assert.deepEqual(h.discord, []);
        // An id that is no Discord user: 404.
        assert.equal((await h.request(`/dashboard/${B}/users/330000000000000033`, { cookie })).status, 404);
    } finally {
        await h.close();
    }
});

test("B's audit page lists only B's rows; a change saved in B is audited in B", async () => {
    const h = await serve({ bMembers: { [ADMIN]: { perms: ['Administrator'], position: 10 } } });
    try {
        h.auditRows.push({ id: 1, guild_id: A, user_id: ADMIN, username: 'alpha-admin', module: 'welcome', key: 'alphaSecretKey', old: null, new: 'alpha', created_at: new Date(0) });
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const save = await h.request(`/dashboard/${B}/birthdays/settings`, { method: 'POST', cookie, form: { csrf, timezone: 'Europe/London' } });
        assert.equal(save.status, 303);
        assert.equal(save.location, `/dashboard/${B}/birthdays`);
        assert.deepEqual(h.log.filter((c) => c.fn === 'services.updateBirthdaySettings').map((c) => c.args[1]), [B]);
        assert.deepEqual(h.auditRows.filter((r) => r.guild_id === B).map((r) => r.key), ['timezone']);
        const audit = await h.request(`/dashboard/${B}/audit`, { cookie });
        assert.equal(audit.status, 200);
        assert.match(audit.body, /timezone/);
        assert.doesNotMatch(audit.body, /alphaSecretKey|alpha-admin/);
        assert.deepEqual(h.log.filter((c) => c.fn === 'audit.list' || c.fn === 'audit.users').map((c) => c.args[0]), [B, B]);
        const inA = await h.request(`/dashboard/${A}/audit`, { cookie });
        assert.match(inA.body, /alphaSecretKey/);
        assert.doesNotMatch(inA.body, /Europe\/London/);
    } finally {
        await h.close();
    }
});

test('bad ids and variants → 404; bot not in the server or blacklisted → 404; blacklisted user → 403; the support id → main', async () => {
    const h = await serve();
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const reference = await h.request(`/dashboard/${C}/help`, { cookie });
        const variants = [
            `/dashboard/${A.slice(0, 16)}/help`, `/dashboard/${A}1234/help`, `/dashboard/${A.slice(0, 17)}x/help`, `/dashboard/-${A.slice(1)}/help`,
            `/dashboard/${A} /help`, `/dashboard/0x${A.slice(2)}/help`, `/dashboard/${B}/`, `/dashboard/${B}/HELP`, `/dashboard/${B}/Cases/ABCDE`,
            `/dashboard/${C}/overview`, `/dashboard/${C}/`, `/dashboard/1e17/help`,
        ];
        for (const url of variants) {
            const res = await h.request(url, { cookie });
            assert.equal(res.status, 404, url);
            assert.equal(res.body, reference.body, url);
        }
        assert.equal((await h.request(`/dashboard/${A}/help/`, { cookie })).status, 200, 'a trailing slash on a real page of a real server is that page');
        // Blacklisted server: 404 also for its admin; a POST too, nothing saved.
    } finally {
        await h.close();
    }
    const blocked = { users: new Set(), guilds: new Set([A]) };
    const g = await serve({ blocked });
    try {
        const { cookie, csrf } = await g.loginAs(ADMIN);
        const reference = await g.request(`/dashboard/${C}/help`, { cookie });
        assert.equal((await g.request(`/dashboard/${A}/help`, { cookie })).body, reference.body);
        const post = await g.request(`/dashboard/${A}/handover`, { method: 'POST', cookie, form: { csrf, text: 'x' } });
        assert.equal(post.status, 404);
        blocked.guilds.clear();
        blocked.users.add(ADMIN);
        assert.equal((await g.request(`/dashboard/${A}/help`, { cookie })).status, 403);
        assert.equal((await g.request(`/dashboard/${A}/handover`, { method: 'POST', cookie, form: { csrf, text: 'x' } })).status, 403);
        blocked.users.clear();
        // Support id: GET 302 and POST 307 to the same page of the main server.
        const get = await g.request(`/dashboard/${SUPPORT}/cases?member=${A_MEMBER}`, { cookie });
        assert.equal(get.status, 302);
        assert.equal(get.location, `/dashboard/${MAIN}/cases?member=${A_MEMBER}`);
        const post307 = await g.request(`/dashboard/${SUPPORT}/handover`, { method: 'POST', cookie, form: { csrf, text: 'x' } });
        assert.equal(post307.status, 307);
        assert.equal(post307.location, `/dashboard/${MAIN}/handover`);
        assert.equal((await g.request(`/dashboard/${SUPPORT}//evil.example`, { cookie })).location, `/dashboard/${MAIN}`, 'never //host after the redirect');
        assert.deepEqual(g.writes().map((c) => c.fn), []);
    } finally {
        await g.close();
    }
});

test('OWNER_IDS: nothing in B without a permission there; Administrator in B is a plain admin (mass-action guard, appeal reviewer); main as before', async () => {
    // OWNER without any permission in B: the whole table 404s, like any stranger.
    const stranger = await serve({ bMembers: { [OWNER]: { position: 1 } } });
    try {
        const { cookie, csrf } = await stranger.loginAs(OWNER);
        for (const r of concreteRoutes().filter((x, i) => i % 3 === 0 || x.method === 'POST')) {
            const url = `/dashboard/${B}${r.path}`;
            const res = r.method === 'GET' ? await stranger.request(url, { cookie }) : await stranger.request(url, { method: 'POST', cookie, form: fullForm(csrf) });
            assert.equal(res.status, 404, `${r.method} ${url}`);
        }
        assert.deepEqual(stranger.log, []);
        // In the main server the owner still opens the dashboard without Administrator (view + settings, no actions).
        const main = await stranger.request(`/dashboard/${MAIN}/help`, { cookie });
        assert.equal(main.status, 200);
        assert.match(main.body, /bot owner/i);
        const act = await stranger.request(`/dashboard/${MAIN}/users/bulk/preview`, { method: 'POST', cookie, form: { csrf, action: 'timeout', timeout: '60s', ids: A_MEMBER } });
        assert.equal(act.status, 403, 'no enforcement actions without Administrator, even for owners');
        const command = await stranger.request(`/dashboard/${MAIN}/commands/command`, { method: 'POST', cookie, form: { csrf, command: 'help', enabled: 'false' } });
        assert.equal(command.status, 403, 'without Administrator only `manager` actions run, also for owners at home');
    } finally {
        await stranger.close();
    }

    const bCase = caseRecord(B_CASE, B, { moderator_id: OWNER, moderator_username: 'owner' });
    const mainCase = caseRecord('mcdfg', MAIN, { moderator_id: OWNER, moderator_username: 'owner' });
    const h = await serve({
        bMembers: { [OWNER]: { perms: ['Administrator'], position: 10 } },
        cases: { [B_CASE]: bCase, mcdfg: mainCase },
    });
    // OWNER is a plain member in MAIN in fakeWorld; make them Administrator there for the comparison.
    h.guild(MAIN).members.cache.get(OWNER).permissions = permissionSet(['Administrator']);
    setSettingsCacheForTests(B, { independentAppealReview: true });
    try {
        const { cookie, csrf } = await h.loginAs(OWNER);
        const help = await h.request(`/dashboard/${B}/help`, { cookie });
        assert.equal(help.status, 200);
        assert.doesNotMatch(help.body, /bot owner\)/i, 'an Administrator there, not the owner level');
        // Mass-action guard: OWNER is blocked in B like any admin; in the main server the guard does not apply to them.
        h.massBlocks.set(`${B}:${OWNER}`, { until: new Date(Date.now() + 3600_000) });
        h.massBlocks.set(`${MAIN}:${OWNER}`, { until: new Date(Date.now() + 3600_000) });
        const kickForm = { csrf, action: 'kick', ids: '330000000000000033', reasonKey: 'spam' };
        const inB = await h.request(`/dashboard/${B}/users/bulk/preview`, { method: 'POST', cookie, form: kickForm });
        assert.equal(inB.status, 400);
        assert.match(inB.body, /block|stopp|paused|limit/i);
        const inMain = await h.request(`/dashboard/${MAIN}/users/bulk/preview`, { method: 'POST', cookie, form: kickForm });
        assert.equal(inMain.status, 200, 'OWNER_IDS are exempt in the main server');
        assert.deepEqual(h.log.filter((c) => c.fn === 'enforcement.getMassActionBlock').map((c) => c.args[0]), [B], 'the guard is only read in B');
        // Appeal reviewer: OWNER issued the case in B and independent review is on there → refused, no confirm token.
        const appealB = await h.request(`/dashboard/${B}/appeals/${B_CASE}/preview`, { method: 'POST', cookie, form: { csrf, decision: 'accept' } });
        assert.ok(appealB.status === 400 || appealB.status === 403, String(appealB.status));
        assert.equal(hidden(appealB.body, 'token'), null);
        const page = await h.request(`/dashboard/${B}/appeals/${B_CASE}`, { cookie });
        assert.equal(page.status, 200);
        assert.doesNotMatch(page.body, /owner override/i);
    } finally {
        setSettingsCacheForTests(B, {});
        await h.close();
    }
});

test('permission lost mid-session in B: B 404s at once on POST and after the cache on GET; A still works; the session is kept', async () => {
    const h = await serve({ bMembers: { [ADMIN]: { perms: ['Administrator'], position: 10 } } });
    try {
        const { session, cookie, csrf } = await h.loginAs(ADMIN);
        assert.equal((await h.request(`/dashboard/${B}/help`, { cookie })).status, 200);
        h.guild(B).members.cache.get(ADMIN).permissions = permissionSet([]);
        assert.equal((await h.request(`/dashboard/${B}/help`, { cookie })).status, 200, 'GET: cached for 30 s');
        const post = await h.request(`/dashboard/${B}/handover`, { method: 'POST', cookie, form: { csrf, text: 'x' } });
        assert.equal(post.status, 404, 'POST: checked fresh');
        assert.equal((await h.request(`/dashboard/${B}/help`, { cookie })).status, 404, 'the fresh answer replaces the cache');
        assert.equal((await h.request(`/dashboard/${A}/help`, { cookie })).status, 200);
        assert.ok(await h.sessions.get(session.id));
        // Kicked out of B entirely: the same.
        h.guild(B).members.cache.delete(ADMIN);
        assert.equal((await h.request(`/dashboard/${B}/overview`, { cookie })).status, 404);
        assert.deepEqual(h.writes().map((c) => c.fn), []);
    } finally {
        await h.close();
    }
});

test('a POST re-checks access with Discord even when the cached answer is fresh', async () => {
    const h = await serve({ bMembers: { [ADMIN]: { perms: ['Administrator'], position: 10 } } });
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        await h.request(`/dashboard/${B}/help`, { cookie });
        const afterGet = h.guild(B).fetches;
        await h.request(`/dashboard/${B}/help`, { cookie });
        assert.equal(h.guild(B).fetches, afterGet, 'the second GET uses the cache');
        const post = await h.request(`/dashboard/${B}/handover`, { method: 'POST', cookie, form: { csrf, text: 'hi' } });
        assert.equal(post.status, 303);
        assert.ok(h.guild(B).fetches > afterGet, 'the POST fetched the member again');
        const before = h.guild(B).fetches;
        await h.request(`/dashboard/${B}/handover`, { method: 'POST', cookie, form: { csrf, text: 'again' } });
        assert.ok(h.guild(B).fetches > before, 'every POST');
        assert.deepEqual(h.log.filter((c) => c.fn === 'services.updateSettings').map((c) => c.args[0]), [B, B]);
    } finally {
        await h.close();
    }
});

test('Manage Server (manager) in B: community settings save; safety modules, moderation, role-granting and staff POSTs → 403, nothing written', async () => {
    const h = await serve({ bMembers: { [MANAGER]: { perms: ['ManageGuild'], position: 5 } } });
    try {
        const { cookie, csrf } = await h.loginAs(MANAGER);
        assert.equal((await h.request(`/dashboard/${B}/birthdays`, { cookie })).status, 200);
        const save = await h.request(`/dashboard/${B}/birthdays/settings`, { method: 'POST', cookie, form: { csrf, timezone: 'Europe/Vilnius' } });
        assert.equal(save.status, 303, 'a community module setting');
        assert.deepEqual(h.log.filter((c) => c.fn === 'services.updateBirthdaySettings').map((c) => [c.args[1], c.args[2]]), [[B, { timezone: 'Europe/Vilnius' }]]);
        const writesBefore = h.writes().length;
        // Every Administrator-only module action (safety modules, roles, permissions, posting as the bot).
        const adminActions = MODULES.flatMap((m) => Object.entries(m.actions || {}).filter(([, a]) => a.admin).map(([name]) => `/${m.key}/${name}`))
            .filter((p) => !p.startsWith('/support/'));
        for (const key of ['automod', 'logging', 'enforcement']) {
            const mod = MODULES.find((m) => m.key === key);
            for (const name of Object.keys(mod.actions)) assert.ok(adminActions.includes(`/${key}/${name}`), `${key}/${name} is Administrator-only`);
        }
        // Closed by default: every action not marked `manager` (not only the admin: true ones) → 403.
        const notManager = MODULES.flatMap((m) => Object.keys(m.actions || {}).filter((name) => !getAction(m, name).manager).map((name) => `/${m.key}/${name}`))
            .filter((p) => !p.startsWith('/support/'));
        for (const p of adminActions) assert.ok(notManager.includes(p), p);
        for (const p of ['/commands/command', '/commands/category', '/tickets/unblock', '/tickets/settings', '/applications/settings', '/welcome/logs',
            '/community/sticky-set', '/community/tag-create', '/community/tag-edit', '/community/feed-add']) assert.ok(notManager.includes(p), `${p} is not manager-runnable`);
        for (const p of notManager) {
            const res = await h.request(`/dashboard/${B}${p}`, { method: 'POST', cookie, form: fullForm(csrf) });
            assert.equal(res.status, 403, `POST ${p}`);
        }
        // Every other POST of the table that is not a settings form: moderation, role rules, staff, records.
        const others = concreteRoutes({ id: B_MEMBER, code: B_CASE, channel: B_CHANNEL })
            .filter((r) => r.method === 'POST' && r.key !== 'settings.edit' && r.key !== 'session.logout' && r.key !== OWNER_AREA);
        assert.ok(others.length > 30);
        for (const r of others) {
            const res = await h.request(`/dashboard/${B}${r.path}`, { method: 'POST', cookie, form: fullForm(csrf) });
            assert.equal(res.status, r.path.startsWith('/backup') ? 404 : 403, `POST ${r.path} (${r.key})`);
        }
        // And the moderation pages a manager may not open (watchlist and staff discipline are Administrator keys).
        for (const p of ['/staff', '/activity', '/incidents', '/audit', '/inbox', '/users/rules', '/users/insights', '/members/search', '/cases/export.csv']) {
            assert.equal((await h.request(`/dashboard/${B}${p}`, { cookie })).status, 403, p);
        }
        assert.equal(h.writes().length, writesBefore, 'nothing written by any refused POST');
        assert.deepEqual(h.discord, []);
    } finally {
        await h.close();
    }
});

test('CSRF and Origin on every per-server POST: missing, wrong or another session\'s token, foreign or no Origin → 403; the 307 legacy POST too', async () => {
    const h = await serve();
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const other = await h.loginAs(ADMIN);
        // /logout is global (below); /backup is home-only (404 in A).
        const posts = concreteRoutes().filter((r) => r.method === 'POST' && r.key !== OWNER_AREA && r.path !== '/logout' && !r.path.startsWith('/backup'));
        const bad = [
            ['no token', { form: { ...fullForm(csrf), csrf: undefined } }],
            ['wrong token', { form: { ...fullForm(csrf), csrf: 'w'.repeat(43) } }],
            ["another session's token", { form: fullForm(other.csrf) }],
            ['foreign Origin', { form: fullForm(csrf), origin: 'https://evil.example' }],
            ['no Origin', { form: fullForm(csrf), origin: null }],
        ];
        for (const r of posts) {
            for (const [label, options] of bad) {
                const form = Object.fromEntries(Object.entries(options.form).filter(([, v]) => v !== undefined));
                const res = await h.request(`/dashboard/${A}${r.path}`, { method: 'POST', cookie, ...options, form });
                // A module or form that does not exist may say so first (404, nothing runs); everything else 403.
                // The image upload refuses a non-multipart body before reading it (400, nothing runs).
                if (res.status === 404) assert.ok(r.path === '/no-such/save' || r.path.startsWith('/support/'), `${label}: POST ${r.path} → 404 (home-only or no such form)`);
                else if (res.status === 400) assert.ok(r.path.endsWith('/evidence/upload'), `${label}: POST ${r.path} → 400`);
                else assert.equal(res.status, 403, `${label}: POST ${r.path}`);
            }
        }
        assert.deepEqual(h.writes().map((c) => c.fn), [], 'nothing written');
        assert.deepEqual(h.unexpected().map((c) => c.fn), []);
        assert.deepEqual(h.discord, []);
        // The legacy link: 307 to the main server, where the same checks run.
        for (const p of ['/handover', '/users/bulk/execute', '/cases/abcde/void', '/leveling/settings', '/inbox/modmail/1/close']) {
            const legacy = await h.request(`/dashboard${p}`, { method: 'POST', cookie, form: { csrf, text: 'x' } });
            assert.equal(legacy.status, 307, p);
            assert.equal(legacy.location, `/dashboard/${MAIN}${p}`);
            for (const [label, options] of bad) {
                const form = Object.fromEntries(Object.entries(options.form).filter(([, v]) => v !== undefined));
                const res = await h.request(legacy.location, { method: 'POST', cookie, ...options, form });
                assert.equal(res.status, 403, `${label}: 307 target ${p}`);
            }
        }
        assert.deepEqual(h.writes().map((c) => c.fn), []);
    } finally {
        await h.close();
    }
});

test('tampered login return paths → the picker; a good one comes back to its server page', async () => {
    const h = await serve({ guildsAnswer: [{ id: A, name: 'Alpha', permissions: '8' }] });
    try {
        const login = async (r) => {
            const start = await h.request(`/dashboard?r=${encodeURIComponent(r)}`);
            assert.equal(start.status, 302, r);
            const url = new URL(start.location);
            const nonce = decodeURIComponent(/mewvo_dash_state=([^;]+)/.exec(start.headers.get('set-cookie'))[1]);
            const back = await h.request(`/dashboard/oauth/callback?code=c&state=${encodeURIComponent(url.searchParams.get('state'))}`, { cookie: `${STATE_COOKIE}=${encodeURIComponent(nonce)}` });
            assert.equal(back.status, 303, r);
            return back.location;
        };
        assert.equal(await login(`/dashboard/${A}/cases?member=${A_MEMBER}`), `/dashboard/${A}/cases?member=${A_MEMBER}`);
        for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', '\\\\evil.example', `/dashboard/${A}/../../owner`, `/dashboard/${A}/%2e%2e/owner`,
            '/dashboard//evil.example', '/dashboard/\\evil', 'javascript:alert(1)', `${ORIGIN}/dashboard/${A}/cases`, '/dashboardevil', `/dashboard/${A}/cases\r\nSet-Cookie: x=1`]) {
            assert.equal(await login(bad), '/dashboard', JSON.stringify(bad));
        }
    } finally {
        await h.close();
    }
});

test("A's channel or role id posted to B's module → 400, nothing saved; B's own ids save", async () => {
    const h = await serve({ bMembers: { [ADMIN]: { perms: ['Administrator'], position: 10 } } });
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const channel = await h.request(`/dashboard/${B}/birthdays/settings`, { method: 'POST', cookie, form: { csrf, channelId: A_CHANNEL } });
        assert.equal(channel.status, 400);
        const role = await h.request(`/dashboard/${B}/birthdays/settings`, { method: 'POST', cookie, form: { csrf, roleId: A_ROLE } });
        assert.equal(role.status, 400);
        assert.equal(h.log.filter((c) => c.fn === 'services.updateBirthdaySettings').length, 0, 'nothing saved');
        const own = await h.request(`/dashboard/${B}/birthdays/settings`, { method: 'POST', cookie, form: { csrf, channelId: B_CHANNEL, roleId: B_ROLE } });
        assert.equal(own.status, 303);
        assert.deepEqual(h.log.filter((c) => c.fn === 'services.updateBirthdaySettings').map((c) => [c.args[1], c.args[2]]), [[B, { channelId: B_CHANNEL, roleId: B_ROLE }]]);
    } finally {
        await h.close();
    }
});

test('Words explained: the Support server link only in the home servers (the page 404s elsewhere)', async () => {
    const h = await serve();
    try {
        const { cookie } = await h.loginAs(ADMIN);
        const inA = await h.request(`/dashboard/${A}/help`, { cookie });
        assert.equal(inA.status, 200);
        assert.ok(!inA.body.includes(`/dashboard/${A}/support`), 'no link to a page that 404s in A');
        assert.ok(!inA.body.includes(`/dashboard/${A}/backup`));
        assert.ok(inA.body.includes(`href="/dashboard/${A}/inbox"`), 'the other words keep their links');
        assert.equal((await h.request(`/dashboard/${A}/support`, { cookie })).status, 404);
        const inMain = await h.request(`/dashboard/${MAIN}/help`, { cookie });
        assert.ok(inMain.body.includes(`href="/dashboard/${MAIN}/support"`));
    } finally {
        await h.close();
    }
});

test('home-only announcement templates: listed in the main server only; in another server the page and the POST refuse them by id, nothing posted', async () => {
    const h = await serve();
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const inMain = await h.request(`/dashboard/${MAIN}/messages`, { cookie });
        assert.equal(inMain.status, 200);
        assert.ok(inMain.body.includes('value="mewvo-new-mods"') && inMain.body.includes('value="mewvo-changelog"'), 'listed at home');
        const inA = await h.request(`/dashboard/${A}/messages`, { cookie });
        assert.equal(inA.status, 200);
        for (const t of MEWVO_TEMPLATES) assert.ok(!inA.body.includes(`value="${t.id}"`), `${t.id}: not listed elsewhere`);
        assert.ok(inA.body.includes('value="game-night"'), 'the general templates are there');
        const asked = await h.request(`/dashboard/${A}/messages?template=mewvo-changelog`, { cookie });
        assert.equal(asked.status, 200);
        assert.match(asked.body, /That template is only for Mewvo(?:'|&#39;)s own servers/);
        assert.ok(!asked.body.includes('Mewvo update'), 'nothing filled');
        for (const action of ['send', 'schedule']) {
            const res = await h.request(`/dashboard/${A}/messages/${action}`, {
                method: 'POST', cookie, form: { csrf, template: 'mewvo-new-mods', channelId: A_CHANNEL, content: 'Hello', repeat: 'daily', time: '10:00', timezone: 'UTC' },
            });
            assert.equal(res.status, 403, action);
            assert.match(res.body, /only for Mewvo&#39;s own servers\. Nothing was posted/);
        }
        assert.equal(h.log.filter((c) => c.fn === 'services.postBotMessage').length, 0, 'nothing posted');
    } finally {
        await h.close();
    }
});

// ── reviewer follow-ups (B3) ────────────────────────────────────────────

test('manager actions: closed by default; exactly the reviewed list is `manager: true`, none grants a role or permission', () => {
    const marked = new Set();
    for (const m of MODULES) {
        for (const name of Object.keys(m.actions || {})) {
            const action = getAction(m, name);
            if (!action.manager) continue;
            const id = `${m.key}/${name}`;
            marked.add(id);
            assert.equal(action.admin, false, `${id}: admin wins over manager`);
            if (!FIELD_LEVEL.has(id)) assert.doesNotMatch(String(action.run), PRIVILEGE_PATTERN, `${id} touches a privileged setting`);
        }
    }
    // A new manager-runnable action must be added to MANAGER_ACTIONS (tests/helpers/privilegedActions.js) on purpose.
    assert.deepEqual([...marked].sort(), [...MANAGER_ACTIONS].sort());
    assert.equal(getAction({ actions: { x: async () => {} } }, 'x').manager, false, 'a plain function is not manager-runnable');
    assert.equal(getAction({ actions: { x: { run: async () => {}, admin: true, manager: true } } }, 'x').manager, false);
});

test('confirm tokens: each server has its own cap, so one busy server cannot evict another\'s confirmations', () => {
    const store = createConfirmStore({ maxPerScope: 3, maxTokens: 100 });
    const inA = scopedConfirms(store, A);
    const inB = scopedConfirms(store, B);
    const kept = inB.issue({ session: 's', subject: 'bulk', payload: { b: 1 } });
    const fromA = Array.from({ length: 10 }, (_, i) => inA.issue({ session: 's', subject: 'bulk', payload: { a: i } }));
    assert.equal(store.size(), 4, "A keeps only its newest 3; B's token stays");
    assert.deepEqual(inB.consume(kept.token, { session: 's', subject: 'bulk', hash: kept.hash }), { b: 1 });
    assert.equal(inA.consume(fromA[0].token, { session: 's', subject: 'bulk', hash: fromA[0].hash }), null, "A's oldest went first");
    assert.deepEqual(inA.consume(fromA[9].token, { session: 's', subject: 'bulk', hash: fromA[9].hash }), { a: 9 });
    assert.equal(store.size(), 2);
});

test('server list: keyed by the user (a new login replaces it), an absolute 12 h, at most 50 "Add Mewvo" servers', async () => {
    let now = 0;
    const cache = createGuildListCache({ ttlMs: 1000, now: () => now });
    cache.set(ADMIN, [{ id: A }]);
    now = 900;
    assert.ok(cache.get(ADMIN), 'still there');
    now = 1000;
    assert.equal(cache.get(ADMIN), undefined, 'reading did not extend it');
    const idle = createLruCache({ ttlMs: 1000, now: () => now, sweepMs: 0 });
    idle.set('x', 1);
    idle.set('y', 2);
    now = 1500;
    idle.get('x');
    now = 2100;
    assert.equal(idle.get('x'), 1, 'idle timeout refreshed by get');
    assert.equal(idle.has('y'), false, 'swept on get, not only on set');
    const many = Array.from({ length: 80 }, (_, i) => ({ id: String(150000000000000100n + BigInt(i)), name: `S${i}`, permissions: '8' }));
    const list = guildListFrom([{ id: A, name: 'Alpha', permissions: '0' }, ...many], { botHas: (id) => id === A });
    assert.equal(list.length, 1 + MAX_ADDABLE_GUILDS);
    assert.equal(list[0].id, A, 'servers with the bot are never cut');

    const h = await serve({ guildsAnswer: [{ id: A, name: 'Alpha', permissions: '8' }] });
    try {
        for (let i = 0; i < 2; i += 1) {
            const start = await h.request('/dashboard');
            const url = new URL(start.location);
            const nonce = decodeURIComponent(/mewvo_dash_state=([^;]+)/.exec(start.headers.get('set-cookie'))[1]);
            await h.request(`/dashboard/oauth/callback?code=c&state=${encodeURIComponent(url.searchParams.get('state'))}`, { cookie: `${STATE_COOKIE}=${encodeURIComponent(nonce)}` });
        }
        assert.deepEqual(h.dashboard.guildLists.keys(), [ADMIN], 'two logins, one list');
    } finally {
        await h.close();
    }
});

test('picker re-check: cached access, no forced member fetch, and the answer is not stored for pages', async () => {
    const seen = [];
    const checker = createAccessChecker({}, { guildId: A, facts: async (c, userId, gid, opts) => { seen.push(opts?.force ?? true); return { inGuild: true, isAdmin: true }; } });
    assert.equal((await checker.check(ADMIN, { guildId: A, force: false })).allowed, true);
    assert.equal(checker.size(), 0, 'not cached');
    await checker.check(ADMIN, { guildId: A });
    await checker.check(ADMIN, { guildId: A, force: false });
    assert.deepEqual(seen, [false, true], 'the second picker check used the cached page answer');
    // memberFacts passes force through to Discord.
    const calls = [];
    const guild = { members: { fetch: async (arg) => { calls.push(arg); return null; } } };
    await memberFacts({ guilds: { cache: new Map([[A, guild]]) } }, ADMIN, A, [], async () => null, { force: false });
    await memberFacts({ guilds: { cache: new Map([[A, guild]]) } }, ADMIN, A, [], async () => null);
    assert.deepEqual(calls.map((c) => c.force), [false, true]);
});

test('a stranger never builds or refreshes a server instance; the bare server URL is the same 404', async () => {
    const h = await serve();
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        const before = h.dashboard.registry.size();
        const reference = await h.request(`/dashboard/${C}/help`, { cookie });
        for (const p of ['', '/', '/help', '/cases/abcde']) assert.equal((await h.request(`/dashboard/${B}${p}`, { cookie })).body, reference.body, p);
        assert.equal((await h.request(`/dashboard/${B}/handover`, { method: 'POST', cookie, form: { csrf, text: 'x' } })).status, 404);
        assert.equal(h.dashboard.registry.size(), before, 'no instance for B');
        assert.equal(h.dashboard.registry.peek(B), null);
        await h.request(`/dashboard/${A}/help`, { cookie });
        assert.ok(h.dashboard.registry.peek(A), 'with access the instance is built');
    } finally {
        await h.close();
    }
});

test('saved case searches: an unreadable setting refuses the save (never a write over a guessed empty list)', async () => {
    const h = await serve({ bMembers: { [ADMIN]: { perms: ['Administrator'], position: 10 } } });
    try {
        const { cookie, csrf } = await h.loginAs(ADMIN);
        setSettingsCacheForTests(B, null); // B's settings row was never read
        const res = await h.request(`/dashboard/${B}/cases/searches/save`, { method: 'POST', cookie, form: { csrf, name: 'mine', type: 'ban' } });
        assert.equal(res.status, 500);
        assert.equal(h.log.filter((c) => c.fn === 'services.updateSettings').length, 0);
        setSettingsCacheForTests(B, {});
        const ok = await h.request(`/dashboard/${B}/cases/searches/save`, { method: 'POST', cookie, form: { csrf, name: 'mine', type: 'ban' } });
        assert.equal(ok.status, 303);
        assert.deepEqual(h.log.filter((c) => c.fn === 'services.updateSettings').map((c) => [c.args[0], c.args[1]]), [[B, { savedCaseSearches: [{ name: 'mine', query: { type: 'ban' } }] }]]);
    } finally {
        setSettingsCacheForTests(B, {});
        await h.close();
    }
});

test('global logout: CSRF and Origin checked; the session survives a forged logout', async () => {
    const h = await serve();
    try {
        const { session, cookie, csrf } = await h.loginAs(ADMIN);
        const other = await h.loginAs(ADMIN);
        for (const [form, origin] of [[{}, ORIGIN], [{ csrf: other.csrf }, ORIGIN], [{ csrf }, 'https://evil.example'], [{ csrf }, null]]) {
            assert.equal((await h.request('/dashboard/logout', { method: 'POST', cookie, form, origin })).status, 403);
        }
        assert.ok(await h.sessions.get(session.id));
        assert.equal((await h.request('/dashboard/logout', { method: 'POST', cookie, form: { csrf } })).status, 303);
        assert.equal(await h.sessions.get(session.id), null);
    } finally {
        await h.close();
    }
});
