// Dashboard Owner area: live OWNER_IDS check (non-owners get 404), the 12-hour login rule,
// CSRF / Origin / edit switch on owner POSTs, the global blacklist in the command gate and
// for components, the invite rules on a server page, leave refused for the main and support
// server, and announcements that never ping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';

const { createDashboard, dashboardSettings } = await import('../src/services/dashboard/routes.js');
const { createMemorySessionStore } = await import('../src/services/dashboard/sessionStore.js');
const { createAccessChecker } = await import('../src/services/dashboard/access.js');
const { SESSION_COOKIE, signValue } = await import('../src/services/dashboard/security.js');
const { layout, JS_PATH } = await import('../src/services/dashboard/html.js');
const {
    announcePayload, canLeaveGuild, fetchImageFromUrl, inviteOptions, isSessionFresh, OWNER_SESSION_MAX_AGE_MS,
} = await import('../src/services/dashboard/ownerRoutes.js');
const { BLACKLIST_MESSAGE, blacklistHit, setBlacklistCache } = await import('../src/services/owner/blacklistCache.js');
const { blacklistProblem } = await import('../src/services/owner/blacklistService.js');
const { parsePresence, presenceData } = await import('../src/services/owner/botStateService.js');
const { checkCommandAccess } = await import('../src/utils/commandGate.js');
const { enforcementConfig } = await import('../src/config/enforcement.js');
const { botConfig } = await import('../src/config/bot.js');

const ALLOWED_SCRIPT = `<script src="${JS_PATH}" defer></script>`;
const SECRET = 'z'.repeat(64);
const MAIN = enforcementConfig.mainGuildId;
const SUPPORT = enforcementConfig.supportGuildId;
const OTHER_GUILD = '100000000000000077';
const OWNER = '200000000000000003';
const ADMIN = '200000000000000002';
const STRANGER_GUILD_OWNER = '200000000000000055';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: MAIN, NODE_ENV: 'test',
};

// ── fakes ─────────────────────────────────────────────────────────────────

function makeGuild(id, { name = `Guild ${id.slice(-2)}`, ownerId = STRANGER_GUILD_OWNER, vanity = null, admins = new Set() } = {}) {
    const sent = [];
    const me = { id: '999999999999999998' };
    const perms = { has: () => true };
    const channel = {
        id: `${id.slice(0, 15)}501`, name: 'mod-log', type: ChannelType.GuildText, parentId: null, position: 0,
        isTextBased: () => true, isThread: () => false, permissionsFor: () => perms,
        send: async (payload) => { sent.push(payload); return { id: '1' }; },
        createInvite: async (options) => { guild.invites.push(options); return { code: 'abcInvite' }; },
    };
    const guild = {
        id, name, ownerId, memberCount: 12, joinedTimestamp: Date.parse('2026-01-01T00:00:00Z'), vanityURLCode: vanity,
        sent, invites: [], left: 0, channel,
        iconURL: () => null,
        channels: { cache: new Map([[channel.id, channel]]) },
        roles: { cache: new Map([['r1', { name: 'Mods', hexColor: '#ff0000', position: 2, members: new Map([['a', 1]]) }]]) },
        systemChannel: channel, rulesChannel: null,
        members: {
            me: { ...me, permissions: { toArray: () => ['SendMessages', 'CreateInstantInvite'] } },
            cache: new Map(),
            fetch: async (arg) => {
                const userId = typeof arg === 'string' ? arg : arg?.user;
                return { id: userId, permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator && admins.has(userId) } };
            },
        },
        leave: async () => { guild.left += 1; },
    };
    return guild;
}

function fakeRes() {
    return {
        statusCode: 200, headers: {}, cookies: [], body: null, redirectedTo: null,
        status(code) { this.statusCode = code; return this; },
        type() { return this; },
        send(body) { this.body = body; return this; },
        set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; },
        append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
}

async function setup({ env = ENV, userId = OWNER, owners = new Set([OWNER]), admins = new Set([ADMIN]), createdAt = Date.now(), guildOpts = {} } = {}) {
    const guilds = new Map([
        [MAIN, makeGuild(MAIN, { name: 'Main', ownerId: '999999999999999990' })],
        [SUPPORT, makeGuild(SUPPORT, { name: 'Support', ownerId: '999999999999999990' })],
        [OTHER_GUILD, makeGuild(OTHER_GUILD, { name: 'Other', ...guildOpts })],
    ]);
    const client = {
        user: { id: '999999999999999998', username: 'Meowist', setUsername: async () => {}, displayAvatarURL: () => null, bannerURL: () => null },
        guilds: { cache: guilds },
        users: { cache: new Map(), fetch: async (id) => ({ id, username: `user${id.slice(-2)}` }) },
        ws: { ping: 42 }, uptime: 1000,
    };
    const calls = [];
    const rec = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };
    let maintenance = false;
    const owner = {
        isBotOwner: (id) => owners.has(id),
        blacklist: {
            list: rec('list', async () => ({ active: [], removed: [] })),
            add: rec('add', async (entry) => ({ id: 1, kind: entry.kind, target_id: entry.targetId, reason: entry.reason })),
            remove: rec('remove', async () => null),
        },
        getStoredPresence: async () => null,
        savePresence: rec('savePresence', async (c, p) => p),
        setMaintenance: rec('setMaintenance', async (on) => { maintenance = on; return on; }),
        isMaintenanceOn: () => maintenance,
        fetchImage: rec('fetchImage', async () => ({ data: Buffer.alloc(1), type: 'image/png' })),
        announceChannelId: async (c, guild) => (guild.id === SUPPORT ? null : guild.channel.id),
        protectedGuildIds: [MAIN, SUPPORT],
        dbStatus: () => ({ connectionType: 'postgresql', isDegraded: false }),
    };
    const sessions = createMemorySessionStore({ ttlMs: 48 * 3600 * 1000 });
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: admins.has(id), isOwnerId: owners.has(id) }) });
    const auditRows = [];
    const auditStore = {
        writeRows: async (g, actor, module, changes) => { for (const c of changes) auditRows.push({ actor, module, ...c }); return changes.length; },
        list: async () => ({ rows: [], total: 0 }), users: async () => [],
    };
    const services = { postModLog: async () => {}, getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) };
    const data = { overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) } };
    const d = createDashboard({ client, settings: dashboardSettings(env), sessions, access, services, auditStore, env, data, owner });
    const session = await sessions.create({ userId, username: 'owner' }, createdAt);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, calls, session, cookie, auditRows, guilds, client, ow: d.owner };
}

async function run(h, handler, req) {
    const res = fakeRes();
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (!passed) return res;
    let ownerOk = false;
    await h.ow.requireOwner(req, res, () => { ownerOk = true; });
    if (ownerOk) await handler(req, res, () => { res.fellThrough = true; });
    return res;
}

const get = (h, handler, { params = {}, query = {} } = {}) => run(h, handler, { method: 'GET', params, query, headers: { cookie: h.cookie } });

function post(h, handler, { params = {}, form = {}, origin = ORIGIN, csrf = h.session.csrf } = {}) {
    return run(h, handler, {
        method: 'POST', params, query: {}, path: '/owner/x',
        headers: { cookie: h.cookie, ...(origin ? { origin } : {}) },
        body: { ...(csrf === null ? {} : { csrf }), ...form },
    });
}

const tokenOf = (body) => ({ token: body.match(/name="token" value="([^"]+)"/)?.[1], fh: body.match(/name="fh" value="([^"]+)"/)?.[1] });

// ── access ────────────────────────────────────────────────────────────────

test('owner area: a non-owner (even an Administrator) gets the normal 404 page; an owner gets the page', async () => {
    const admin = await setup({ userId: ADMIN });
    for (const handler of ['profile', 'servers', 'blacklist', 'health', 'announce']) {
        const res = await get(admin, admin.ow[handler]);
        assert.equal(res.statusCode, 404, handler);
        assert.match(res.body, /Not found/);
    }
    const res = await post(admin, admin.ow.maintenance, { form: { enabled: 'on' } });
    assert.equal(res.statusCode, 404, 'owner POST refused for non-owners too');
    assert.equal(admin.calls.length, 0);

    const owner = await setup();
    for (const handler of ['profile', 'servers', 'blacklist', 'health', 'announce']) {
        const page = await get(owner, owner.ow[handler]);
        assert.equal(page.statusCode, 200, handler);
        assert.ok(!/<style|style=|<script/i.test(page.body.replace(ALLOWED_SCRIPT, '')), `${handler}: no inline styles or scripts`);
    }
});

test('owner area: the check is live (removing the owner takes effect on the next request)', async () => {
    const owners = new Set([OWNER]);
    const h = await setup({ owners });
    assert.equal((await get(h, h.ow.health)).statusCode, 200);
    owners.delete(OWNER);
    // The general access decision is cached for 60 s; the owner check never uses that cache.
    const res = fakeRes();
    const req = { method: 'GET', params: {}, query: {}, headers: { cookie: h.cookie }, dashboard: { session: h.session } };
    let ok = false;
    h.ow.requireOwner(req, res, () => { ok = true; });
    assert.equal(ok, false);
    assert.equal(res.statusCode, 404);
});

test('sidebar: the Owner group is shown only to owners', () => {
    const base = { username: 'a', csrf: 't' };
    const owner = layout({ title: 'x', session: { ...base, isOwner: true }, body: '' });
    const other = layout({ title: 'x', session: { ...base, isOwner: false }, body: '' });
    assert.ok(owner.includes('href="/dashboard/owner/servers"'));
    assert.ok(owner.includes('>Owner</p>'));
    assert.ok(!other.includes('/dashboard/owner/'));
});

test('owner POST: stale login (over 12 h) refused; fresh login works and is audited', async () => {
    const stale = await setup({ createdAt: Date.now() - OWNER_SESSION_MAX_AGE_MS - 60000 });
    const refused = await post(stale, stale.ow.maintenance, { form: { enabled: 'on' } });
    assert.equal(refused.statusCode, 401);
    assert.match(refused.body, /Log in again/);
    assert.equal(stale.calls.length, 0, 'nothing changed');

    const h = await setup();
    const ok = await post(h, h.ow.maintenance, { form: { enabled: 'on' } });
    assert.equal(ok.statusCode, 303);
    assert.equal(ok.redirectedTo, '/dashboard/owner/health');
    assert.deepEqual(h.calls.map((c) => c.name), ['setMaintenance']);
    assert.deepEqual(h.auditRows.map((r) => [r.module, r.key, r.old, r.new]), [['owner', 'maintenance', false, true]]);
    assert.equal(isSessionFresh({ createdAt: Date.now() - 1000 }), true);
    assert.equal(isSessionFresh({ createdAt: undefined }), false);
});

test('owner POST: CSRF, Origin and the edit switch are checked; nothing changes when refused', async () => {
    let h = await setup();
    assert.equal((await post(h, h.ow.maintenance, { csrf: null, form: { enabled: 'on' } })).statusCode, 403, 'no CSRF');
    assert.equal((await post(h, h.ow.maintenance, { csrf: 'wrong', form: { enabled: 'on' } })).statusCode, 403, 'wrong CSRF');
    assert.equal((await post(h, h.ow.maintenance, { origin: 'https://evil.example', form: { enabled: 'on' } })).statusCode, 403, 'bad Origin');
    assert.equal(h.calls.length, 0);
    h = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    const off = await post(h, h.ow.blacklistAdd, { form: { kind: 'user', id: '300000000000000009', reason: 'spam' } });
    assert.equal(off.statusCode, 403);
    assert.match(off.body, /Editing is off/);
    assert.equal(h.calls.length, 0);
});

test('owner POST: blacklist add goes to the store and is audited; bad input re-renders with 400', async () => {
    const h = await setup();
    const ok = await post(h, h.ow.blacklistAdd, { form: { kind: 'user', id: '300000000000000009', reason: 'spam' } });
    assert.equal(ok.statusCode, 303);
    assert.equal(h.calls.find((c) => c.name === 'add').args[0].targetId, '300000000000000009');
    assert.equal(h.auditRows[0].key, 'blacklist.user.300000000000000009');
    const missing = await post(h, h.ow.blacklistRemove, { form: { entry: '5' } });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.body, /not on the blacklist/);
});

// ── blacklist rules and enforcement ───────────────────────────────────────

test('blacklist: owners, the main and the support server can never be added; IDs and reasons are checked', () => {
    const opts = { isOwner: (id) => id === OWNER, protectedGuildIds: [MAIN, SUPPORT] };
    assert.match(blacklistProblem({ kind: 'user', targetId: OWNER, reason: 'x' }, opts), /never be blacklisted/);
    assert.match(blacklistProblem({ kind: 'guild', targetId: MAIN, reason: 'x' }, opts), /cannot be blacklisted/);
    assert.match(blacklistProblem({ kind: 'guild', targetId: SUPPORT, reason: 'x' }, opts), /cannot be blacklisted/);
    assert.match(blacklistProblem({ kind: 'user', targetId: '12', reason: 'x' }, opts), /Discord ID/);
    assert.match(blacklistProblem({ kind: 'user', targetId: '300000000000000009', reason: ' ' }, opts), /reason/);
    assert.match(blacklistProblem({ kind: 'role', targetId: '300000000000000009', reason: 'x' }, opts), /user or server/);
    assert.equal(blacklistProblem({ kind: 'guild', targetId: OTHER_GUILD, reason: 'raids' }, opts), null);
});

test('gate: a blacklisted user is refused with a short message; a blacklisted server is ignored; OWNER_IDS pass', () => {
    const owners = botConfig.commands.owners;
    botConfig.commands.owners = [...(owners || []), OWNER];
    const user = '300000000000000009';
    setBlacklistCache([{ kind: 'user', target_id: user }, { kind: 'user', target_id: OWNER }, { kind: 'guild', target_id: SUPPORT }]);
    try {
        const guild = { id: MAIN, ownerId: user };
        const check = (userId, g = guild, accessKey = 'help') => checkCommandAccess({ command: {}, accessKey, guild: g, userId, permissions: { has: () => true } });
        assert.deepEqual(check(user), { allowed: false, message: BLACKLIST_MESSAGE }, 'even the server owner / an admin, even an open command');
        assert.equal(check('300000000000000010').allowed, true);
        assert.equal(check(OWNER).allowed, true, 'owners are never blocked');
        const ignored = check('300000000000000010', { id: SUPPORT, ownerId: 'x' });
        assert.equal(ignored.allowed, false);
        assert.equal(ignored.silent, true, 'the caller sends nothing');
        assert.equal(checkCommandAccess({ command: {}, accessKey: 'help', guild: null, userId: user }).message, BLACKLIST_MESSAGE, 'also in DMs');
        assert.equal(blacklistHit({ userId: OWNER, guildId: SUPPORT }), null);
    } finally {
        setBlacklistCache([]);
        botConfig.commands.owners = owners;
    }
});

test('components: a blacklisted user gets an ephemeral "You can\'t use this bot."; a blacklisted server is ignored', async () => {
    const { refuseBlacklistedComponent } = await import('../src/events/interactionCreate.js');
    const user = '300000000000000009';
    setBlacklistCache([{ kind: 'user', target_id: user }, { kind: 'guild', target_id: OTHER_GUILD }]);
    const fake = (userId, guildId) => {
        const replies = [];
        return {
            replies, id: '1', user: { id: userId }, guildId, createdTimestamp: Date.now(), deferred: false, replied: false,
            isMessageComponent: () => true, isModalSubmit: () => false, isRepliable: () => true,
            reply: async (options) => { replies.push(options); },
        };
    };
    try {
        const blocked = fake(user, MAIN);
        assert.equal(await refuseBlacklistedComponent(blocked), true);
        assert.equal(blocked.replies.length, 1);
        assert.equal(blocked.replies[0].content, BLACKLIST_MESSAGE);
        assert.ok(blocked.replies[0].flags, 'ephemeral');
        const server = fake('300000000000000010', OTHER_GUILD);
        assert.equal(await refuseBlacklistedComponent(server), true);
        assert.equal(server.replies.length, 0, 'ignored without an answer');
        const fine = fake('300000000000000010', MAIN);
        assert.equal(await refuseBlacklistedComponent(fine), false);
        const command = { ...fake(user, MAIN), isMessageComponent: () => false, isModalSubmit: () => false };
        assert.equal(await refuseBlacklistedComponent(command), false, 'commands are left to the gate');
    } finally {
        setBlacklistCache([]);
    }
});

// ── servers: invites and leaving ──────────────────────────────────────────

test('invite rules: vanity URL shown; the button only for that server\'s owner or an Administrator there', async () => {
    assert.deepEqual(inviteOptions({ vanityCode: 'cats' }), { vanityUrl: 'https://discord.gg/cats', canCreateInvite: false });
    assert.deepEqual(inviteOptions({ isGuildOwner: true }), { vanityUrl: null, canCreateInvite: true });
    assert.deepEqual(inviteOptions({ isAdmin: true }), { vanityUrl: null, canCreateInvite: true });
    assert.deepEqual(inviteOptions({}), { vanityUrl: null, canCreateInvite: false });

    const none = await setup();
    const plain = await get(none, none.ow.server, { params: { id: OTHER_GUILD } });
    assert.equal(plain.statusCode, 200);
    assert.ok(!/Create invite|discord\.gg/.test(plain.body), 'no invite option at all');
    assert.ok(plain.body.includes('Mods') && plain.body.includes('#ff0000') && plain.body.includes('mod-log'));
    const refused = await post(none, none.ow.invite, { params: { id: OTHER_GUILD } });
    assert.equal(refused.statusCode, 403, 'the POST is refused too');
    assert.equal(none.guilds.get(OTHER_GUILD).invites.length, 0);

    const vanity = await setup({ guildOpts: { vanity: 'cats' } });
    const vbody = (await get(vanity, vanity.ow.server, { params: { id: OTHER_GUILD } })).body;
    assert.ok(vbody.includes('https://discord.gg/cats'));
    assert.ok(!vbody.includes('Create invite'));

    for (const guildOpts of [{ ownerId: OWNER }, { admins: new Set([OWNER]) }]) {
        const h = await setup({ guildOpts });
        assert.ok((await get(h, h.ow.server, { params: { id: OTHER_GUILD } })).body.includes('Create invite'));
        const res = await post(h, h.ow.invite, { params: { id: OTHER_GUILD } });
        assert.equal(res.statusCode, 303);
        assert.deepEqual(h.guilds.get(OTHER_GUILD).invites.map((i) => [i.maxUses, i.maxAge]), [[1, 3600]]);
        assert.equal(h.auditRows[0].key, `servers.${OTHER_GUILD}.invite`);
    }
});

test('leave: refused for the main and support server; other servers need the token and the tick-box', async () => {
    assert.equal(canLeaveGuild(MAIN, [MAIN, SUPPORT]), false);
    assert.equal(canLeaveGuild(SUPPORT, [MAIN, SUPPORT]), false);
    assert.equal(canLeaveGuild(OTHER_GUILD, [MAIN, SUPPORT]), true);
    const h = await setup();
    for (const id of [MAIN, SUPPORT]) {
        assert.ok(!(await get(h, h.ow.server, { params: { id } })).body.includes('Leave server…'));
        assert.equal((await post(h, h.ow.leavePreview, { params: { id } })).statusCode, 403);
        assert.equal((await post(h, h.ow.leave, { params: { id }, form: { token: 'x', fh: 'y', confirm: '1' } })).statusCode, 403);
        assert.equal(h.guilds.get(id).left, 0);
    }
    const preview = await post(h, h.ow.leavePreview, { params: { id: OTHER_GUILD } });
    assert.equal(preview.statusCode, 200);
    const { token, fh } = tokenOf(preview.body);
    assert.ok(token && fh);
    const noTick = await post(h, h.ow.leave, { params: { id: OTHER_GUILD }, form: { token, fh } });
    assert.equal(noTick.statusCode, 400);
    assert.equal(h.guilds.get(OTHER_GUILD).left, 0);
    const again = tokenOf((await post(h, h.ow.leavePreview, { params: { id: OTHER_GUILD } })).body);
    const done = await post(h, h.ow.leave, { params: { id: OTHER_GUILD }, form: { ...again, confirm: '1' } });
    assert.equal(done.statusCode, 303);
    assert.equal(h.guilds.get(OTHER_GUILD).left, 1);
    assert.equal(h.auditRows.at(-1).key, `servers.${OTHER_GUILD}.leave`);
    const reused = await post(h, h.ow.leave, { params: { id: OTHER_GUILD }, form: { ...again, confirm: '1' } });
    assert.equal(reused.statusCode, 400, 'a token works once');
});

// ── announce ──────────────────────────────────────────────────────────────

test('announce: preview lists targets and skipped servers; send posts with mentions disabled and is audited', async () => {
    assert.deepEqual(announcePayload('@everyone hi <@&1>'), { content: '@everyone hi <@&1>', allowedMentions: { parse: [] } });
    const h = await setup();
    const preview = await post(h, h.ow.announcePreview, { form: { message: '@everyone Update tonight' } });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.body, /Skipped \(1\)/);
    assert.match(preview.body, /no log channel configured/);
    assert.equal(h.guilds.get(MAIN).sent.length, 0, 'nothing sent before confirming');
    const { token, fh } = tokenOf(preview.body);
    const sent = await post(h, h.ow.announceSend, { form: { token, fh, confirm: '1' } });
    assert.equal(sent.statusCode, 200);
    assert.match(sent.body, /Posted \(2\)/);
    for (const id of [MAIN, OTHER_GUILD]) {
        assert.deepEqual(h.guilds.get(id).sent, [{ content: '@everyone Update tonight', allowedMentions: { parse: [] } }]);
    }
    assert.equal(h.guilds.get(SUPPORT).sent.length, 0);
    assert.deepEqual(h.auditRows.at(-1).new.skipped, [SUPPORT]);
    const empty = await post(h, h.ow.announcePreview, { form: { message: '   ' } });
    assert.equal(empty.statusCode, 400);
});

// ── profile helpers ───────────────────────────────────────────────────────

test('presence: parsed strictly and turned into discord.js presence data', () => {
    assert.equal(typeof parsePresence({ status: 'busy' }), 'string');
    assert.equal(typeof parsePresence({ status: 'online', activityType: 'playing', activityText: '' }), 'string');
    assert.deepEqual(parsePresence({ status: 'dnd', activityType: 'none', activityText: 'x' }), { status: 'dnd', activityType: 'none', activityText: '' });
    assert.deepEqual(presenceData({ status: 'idle', activityType: 'watching', activityText: 'cats' }), { status: 'idle', activities: [{ name: 'cats', type: 3 }] });
    assert.deepEqual(presenceData({ status: 'online', activityType: 'custom', activityText: 'hi' }).activities[0].state, 'hi');
});

test('image URL: https only, no localhost / IP hosts, must really be an image', async () => {
    await assert.rejects(fetchImageFromUrl('http://example.com/a.png', { fetchImpl: async () => { throw new Error('no'); } }), /https/);
    await assert.rejects(fetchImageFromUrl('https://127.0.0.1/a.png', { fetchImpl: async () => { throw new Error('no'); } }), /public host/);
    await assert.rejects(fetchImageFromUrl('https://localhost/a.png', { fetchImpl: async () => { throw new Error('no'); } }), /public host/);
    const response = (bytes) => async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes });
    await assert.rejects(fetchImageFromUrl('https://img.example/a.png', { fetchImpl: response(Buffer.from('<html>')) }), /not a PNG/);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    assert.equal((await fetchImageFromUrl('https://img.example/a.png', { fetchImpl: response(png) })).type, 'image/png');
});
