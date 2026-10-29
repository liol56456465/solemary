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
    accountCreatedAt, announcePayload, commandCounts, commandDiff, missingPermissions, rolesAboveBot, canLeaveGuild, canOfferUserBlacklist, fetchImageFromUrl, userBlacklistState, inviteOptions, isSessionFresh, OWNER_SESSION_MAX_AGE_MS,
    serverTagsFor, serverTotals, sortServers,
} = await import('../src/services/dashboard/ownerRoutes.js');
const { ownerActionText } = await import('../src/services/dashboard/ownerPages.js');
const { INSTALL_PERMISSIONS } = await import('../src/services/site/site.js');
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

async function setup({
    env = ENV, userId = OWNER, owners = new Set([OWNER]), admins = new Set([ADMIN]), createdAt = Date.now(), guildOpts = {},
    blacklistActive = [], auditList = async () => ({ rows: [], total: 0 }), recentLogLines = [],
    moderationRecord = async () => ({ ladder: { level: 0, warns_since_level: 0 }, caseCount: 0, activeBan: null, activeMute: null }),
    blacklistList = null, managedRoles = async () => [],
    expectedCommands = async () => [{ name: 'help' }, { name: 'rank' }, { name: 'Moderate', type: 2 }],
    registeredCommands = async () => [{ name: 'help', type: 1 }, { name: 'rank', type: 1 }, { name: 'Moderate', type: 2 }],
    registerMainCommands = async () => ({ guildId: '100000000000000001', count: 3 }), retired = false,
} = {}) {
    const guilds = new Map([
        [MAIN, makeGuild(MAIN, { name: 'Main', ownerId: '999999999999999990' })],
        [SUPPORT, makeGuild(SUPPORT, { name: 'Support', ownerId: '999999999999999990' })],
        [OTHER_GUILD, makeGuild(OTHER_GUILD, { name: 'Other', ...guildOpts })],
    ]);
    const client = {
        user: { id: '999999999999999998', username: 'Mewvo', setUsername: async () => {}, displayAvatarURL: () => null, bannerURL: () => null },
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
            list: rec('list', blacklistList || (async () => ({ active: blacklistActive, removed: [] }))),
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
        recentLogs: () => recentLogLines,
        moderationRecord: rec('moderationRecord', moderationRecord),
        managedRoles,
        expectedCommands: rec('expectedCommands', expectedCommands),
        registeredCommands: rec('registeredCommands', registeredCommands),
        registerMainCommands: rec('registerMainCommands', registerMainCommands),
        commandsRetired: () => retired,
    };
    const sessions = createMemorySessionStore({ ttlMs: 48 * 3600 * 1000 });
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: admins.has(id), isOwnerId: owners.has(id) }) });
    const auditRows = [];
    const auditStore = {
        writeRows: async (g, actor, module, changes) => { for (const c of changes) auditRows.push({ actor, module, ...c }); return changes.length; },
        list: auditList, users: async () => [],
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
    for (const handler of ['home', 'activity', 'profile', 'servers', 'users', 'blacklist', 'health', 'commands', 'announce']) {
        const res = await get(admin, admin.ow[handler], { query: { q: OWNER } });
        assert.equal(res.statusCode, 404, handler);
        assert.match(res.body, /Not found/);
    }
    const res = await post(admin, admin.ow.maintenance, { form: { enabled: 'on' } });
    assert.equal(res.statusCode, 404, 'owner POST refused for non-owners too');
    assert.equal(admin.calls.length, 0);

    const owner = await setup();
    for (const handler of ['home', 'activity', 'profile', 'servers', 'users', 'blacklist', 'health', 'commands', 'announce']) {
        const page = await get(owner, owner.ow[handler], handler === 'users' ? { query: { q: '300000000000000009' } } : {});
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
    assert.ok(owner.includes('href="/dashboard/owner/users"'));
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

test('blacklist at startup: a failed load is retried with backoff until it succeeds (no fail-open until restart)', async () => {
    const { loadBlacklistWithRetry } = await import('../src/services/owner/blacklistService.js');
    let calls = 0;
    const timers = [];
    const load = async () => { calls += 1; if (calls < 3) throw new Error('db down'); return 4; };
    const queue = [];
    const first = await loadBlacklistWithRetry({ load, schedule: (fn, ms) => { timers.push(ms); queue.push(fn); return null; } });
    assert.equal(first, null, 'the first try failed');
    // Run the scheduled retries by hand (no timers), letting each failed load reschedule.
    while (queue.length) {
        queue.shift()();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }
    assert.equal(calls, 3, 'retried until it loaded');
    assert.deepEqual(timers, [15000, 30000], 'backoff doubles');
});

test('owner image URLs: private, loopback and internal addresses are refused after DNS', async () => {
    const { isPrivateAddress, pinnedFetch } = await import('../src/services/owner/safeImageFetch.js');
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'ff02::1', '224.0.0.1']) {
        assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['1.1.1.1', '151.101.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
    // A public-looking name that resolves to an internal address never gets a connection.
    const resolve = (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    await assert.rejects(pinnedFetch('https://looks-public.example/a.png', { resolve }), (error) => error.code === 'EPRIVATE');
});

// ── overview, activity, servers list, server facts ────────────────────────

test('owner overview: totals, newest and largest servers, blacklist count, recent actions in words', async () => {
    const auditCalls = [];
    const h = await setup({
        blacklistActive: [{ id: 1, kind: 'guild', target_id: OTHER_GUILD, reason: 'spam' }, { id: 2, kind: 'user', target_id: '300000000000000001', reason: 'x' }],
        auditList: async (g, opts) => {
            auditCalls.push({ g, opts });
            return { rows: [{ user_id: OWNER, username: 'owner', key: `servers.${OTHER_GUILD}.leave`, old: { name: 'Other' }, new: null, created_at: new Date() }], total: 1 };
        },
    });
    h.guilds.get(OTHER_GUILD).memberCount = 500;
    h.guilds.get(OTHER_GUILD).joinedTimestamp = Date.now() - 1000;
    const res = await get(h, h.ow.home);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('<h1>Owner overview</h1>'));
    assert.match(res.body, /<a class="kpi-num" href="\/dashboard\/owner\/servers">3<\/a>/, 'server count links to the list');
    assert.ok(res.body.includes('524 members in total · 1 new this week'));
    assert.match(res.body, /<a class="kpi-num" href="\/dashboard\/owner\/blacklist">2<\/a>/);
    assert.ok(res.body.includes('Left Other'), 'audit key shown in words with the server name');
    assert.deepEqual(auditCalls[0].opts, { module: 'owner', page: 0, pageSize: 8 }, 'only owner rows');
    const largest = res.body.slice(res.body.indexOf('Largest servers'));
    assert.match(largest, /<b>Other<\/b>/, 'largest first');
    assert.ok(res.body.includes('Blacklisted</span>'), 'blacklisted server is tagged');

    const broken = await setup({ auditList: async () => { throw new Error('db down'); } });
    const page = await get(broken, broken.ow.home);
    assert.equal(page.statusCode, 200, 'the overview still renders without the audit store');
    assert.ok(page.body.includes('Unavailable (database).'));

    const redirect = await get(h, h.ow.index);
    assert.equal(redirect.redirectedTo, '/dashboard/owner/home');
});

test('owner activity: owner rows only, paged, a database error is shown instead of an empty list', async () => {
    const seen = [];
    const h = await setup({
        auditList: async (g, opts) => {
            seen.push(opts);
            return { rows: [{ user_id: OWNER, username: 'owner', key: 'maintenance', old: false, new: true, created_at: new Date() }], total: 120 };
        },
    });
    const res = await get(h, h.ow.activity, { query: { page: '1' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen[0], { module: 'owner', page: 1, pageSize: 50 });
    assert.ok(res.body.includes('Maintenance mode'));
    assert.ok(res.body.includes('Page 2 of 3 · 120 actions'));
    assert.ok(res.body.includes('href="/dashboard/owner/activity?page=0"') && res.body.includes('href="/dashboard/owner/activity?page=2"'));
    const bad = await get(h, h.ow.activity, { query: { page: '-5' } });
    assert.equal(seen[1].page, 0, 'bad page numbers fall back to the first page');
    assert.equal(bad.statusCode, 200);

    const broken = await setup({ auditList: async () => { throw new Error('down'); } });
    const err = await get(broken, broken.ow.activity);
    assert.equal(err.statusCode, 200);
    assert.ok(err.body.includes('could not be loaded (database)'));
    assert.ok(!err.body.includes('No owner actions yet'), 'an error is not shown as "nothing"');
});

test('servers list: sort, totals over every server, Main / Support / Blacklisted tags', async () => {
    const h = await setup({ blacklistActive: [{ id: 1, kind: 'guild', target_id: OTHER_GUILD, reason: 'r' }] });
    h.guilds.get(SUPPORT).memberCount = 900;
    const byMembers = await get(h, h.ow.servers, { query: { sort: 'members' } });
    const order = [...byMembers.body.matchAll(/<b>(Main|Support|Other)<\/b>/g)].map((m) => m[1]);
    assert.deepEqual(order, ['Support', 'Main', 'Other']);
    assert.ok(byMembers.body.includes('<option value="members" selected>'));
    assert.ok(byMembers.body.includes('3 servers, 924 members in total'));
    assert.match(byMembers.body, /<b>Main<\/b> <span class="state-word is-on">.*Main<\/span>/);
    assert.match(byMembers.body, /<b>Other<\/b> <span class="state-word is-bad">.*Blacklisted<\/span>/);
    const odd = await get(h, h.ow.servers, { query: { sort: '<script>' } });
    assert.ok(odd.body.includes('<option value="name" selected>'), 'unknown sort → name');
    assert.ok(!odd.body.includes('<script>'));
});

test('server page: facts, and "Blacklist this server" only pre-fills the form (never for main / support)', async () => {
    const h = await setup();
    Object.assign(h.guilds.get(OTHER_GUILD), { createdTimestamp: Date.parse('2024-05-01T00:00:00Z'), premiumSubscriptionCount: 7, premiumTier: 2, verificationLevel: 3 });
    const other = await get(h, h.ow.server, { params: { id: OTHER_GUILD } });
    assert.ok(other.body.includes('<dt>Boosts</dt><dd>7 (level 2)</dd>'));
    assert.ok(other.body.includes('<dt>Verification level</dt><dd>High</dd>'));
    assert.ok(other.body.includes(`href="/dashboard/owner/blacklist?kind=guild&amp;id=${OTHER_GUILD}"`));
    const main = await get(h, h.ow.server, { params: { id: MAIN } });
    assert.ok(!main.body.includes('/owner/blacklist?'), 'no blacklist link for the main server');
    assert.ok(main.body.includes('cannot be blacklisted'));

    const form = await get(h, h.ow.blacklist, { query: { kind: 'guild', id: OTHER_GUILD } });
    assert.ok(form.body.includes(`name="id" inputmode="numeric" maxlength="20" required value="${OTHER_GUILD}"`));
    assert.ok(form.body.includes('<option value="guild" selected>'));
    assert.ok(!h.calls.some((c) => c.name === 'add'), 'a GET never adds anything');
    const junk = await get(h, h.ow.blacklist, { query: { kind: 'guild', id: '"><b>x' } });
    assert.ok(!junk.body.includes('<b>x') && junk.body.includes('required value=""'), 'a bad id is ignored');

    const listed = await setup({ blacklistActive: [{ id: 1, kind: 'guild', target_id: OTHER_GUILD, reason: 'r' }] });
    const page = await get(listed, listed.ow.server, { params: { id: OTHER_GUILD } });
    assert.ok(page.body.includes('Blacklisted: the bot ignores this server'));
});

test('server rules: sort orders, totals and tags', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    const g = (name, memberCount, daysAgo) => ({ id: name, name, memberCount, joinedTimestamp: now - daysAgo * 86400000 });
    const list = [g('b', 5, 1), g('a', 50, 30), g('c', 5, 3)];
    assert.deepEqual(sortServers(list, 'name').map((x) => x.name), ['a', 'b', 'c']);
    assert.deepEqual(sortServers(list, 'members').map((x) => x.name), ['a', 'b', 'c'], 'ties by name');
    assert.deepEqual(sortServers(list, 'newest').map((x) => x.name), ['b', 'c', 'a']);
    assert.deepEqual(sortServers(list, 'oldest').map((x) => x.name), ['a', 'c', 'b']);
    assert.deepEqual(sortServers(list, 'nope').map((x) => x.name), ['a', 'b', 'c']);
    assert.deepEqual(list.map((x) => x.name), ['b', 'a', 'c'], 'the input is not changed');
    assert.deepEqual(serverTotals(list, now), { servers: 3, members: 60, joinedWeek: 2 });
    assert.deepEqual(serverTagsFor('1', { mainId: '1', supportId: '2', blacklisted: new Set(['1']) }), ['Main', 'Blacklisted']);
    assert.deepEqual(serverTagsFor('3', { mainId: '1', supportId: '2' }), []);
});

test('owner action text: every audit key the owner area writes reads as words', () => {
    const names = new Map([['100000000000000077', 'Other']]);
    assert.equal(ownerActionText('maintenance'), 'Maintenance mode');
    assert.equal(ownerActionText('announce'), 'Announcement to every server');
    assert.equal(ownerActionText('commands.register'), 'Commands re-registered in the main server');
    assert.equal(ownerActionText('profile.presence'), 'Bot profile: status');
    assert.equal(ownerActionText('servers.100000000000000077.invite', names), 'Invite created in Other');
    assert.equal(ownerActionText('servers.100000000000000099.leave', names), 'Left 100000000000000099');
    assert.equal(ownerActionText('blacklist.guild.100000000000000077', names), 'Blacklist: server Other');
    assert.equal(ownerActionText('blacklist.user.300000000000000001'), 'Blacklist: user 300000000000000001');
    assert.equal(ownerActionText('something.else'), 'something.else');
});

test('health: recent warnings and errors are listed (escaped); none → a plain "no warnings" line', async () => {
    const h = await setup({ recentLogLines: [
        { at: new Date(), level: 'error', text: 'Database <b>down</b>', traceId: 'trc_abc' },
        { at: new Date(), level: 'warn', text: 'slow', traceId: null },
    ] });
    const res = await get(h, h.ow.health);
    assert.ok(res.body.includes('Recent warnings and errors'));
    assert.ok(res.body.includes('Database &lt;b&gt;down&lt;/b&gt;'), 'escaped');
    assert.ok(res.body.includes('trc_abc'));
    assert.ok(res.body.includes('(2, 1 error)'));
    const empty = await setup();
    assert.ok((await get(empty, empty.ow.health)).body.includes('No warnings or errors since the last restart.'));
});

// ── user lookup ───────────────────────────────────────────────────────────

test('user lookup rules: account date from the ID, blacklist state (unknown is never "clear"), no link for owners', () => {
    assert.equal(accountCreatedAt('175928847299117063').toISOString(), '2016-04-30T11:18:25.796Z');
    assert.equal(accountCreatedAt('abc'), null);
    assert.deepEqual(userBlacklistState(null, '1'), { state: 'unknown', entry: null });
    const entry = { kind: 'user', target_id: '300000000000000009', reason: 'spam' };
    assert.deepEqual(userBlacklistState([entry, { kind: 'guild', target_id: '300000000000000010' }], '300000000000000009'), { state: 'listed', entry });
    assert.deepEqual(userBlacklistState([{ kind: 'guild', target_id: '300000000000000009' }], '300000000000000009'), { state: 'clear', entry: null }, 'a server entry with the same id is not the user');
    assert.equal(canOfferUserBlacklist({ state: 'clear', isOwner: false }), true);
    assert.equal(canOfferUserBlacklist({ state: 'clear', isOwner: true }), false);
    assert.equal(canOfferUserBlacklist({ state: 'unknown', isOwner: false }), false);
    assert.equal(canOfferUserBlacklist({ state: 'listed', isOwner: false }), false);
});

test('user lookup: account, shared servers (cache + main/support fetch only), blacklist link, record with links', async () => {
    const USER = '300000000000000009';
    const h = await setup({
        moderationRecord: async () => ({
            ladder: { level: 1, warns_since_level: 0 }, caseCount: 4,
            activeBan: null, activeMute: { case_code: 'mute7k', expires_at: new Date('2026-11-01T00:00:00Z') },
        }),
    });
    const fetched = [];
    for (const g of h.guilds.values()) {
        g.members.fetch = async (arg) => { fetched.push(g.id); return g.id === MAIN ? { id: arg.user, nickname: 'Kitty', joinedTimestamp: Date.parse('2025-01-01T00:00:00Z') } : null; };
    }
    h.guilds.get(OTHER_GUILD).members.cache.set(USER, { id: USER, nickname: null, joinedTimestamp: Date.parse('2025-06-01T00:00:00Z') });
    const res = await get(h, h.ow.users, { query: { q: USER } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(fetched.sort(), [MAIN, SUPPORT].sort(), 'only the main and the support server are fetched');
    assert.ok(res.body.includes('user09'), 'username');
    assert.ok(res.body.includes('Shared servers (2)'));
    assert.ok(res.body.includes('Kitty'));
    assert.ok(res.body.includes(`href="/dashboard/owner/servers/${OTHER_GUILD}"`));
    assert.ok(res.body.includes('member cache'), 'the limit is explained');
    assert.ok(res.body.includes(`href="/dashboard/owner/blacklist?kind=user&amp;id=${USER}"`), 'pre-fill link');
    assert.ok(res.body.includes('Level 1 · counted warns 0 (next warn bans)'));
    assert.ok(res.body.includes(`href="/dashboard/cases?member=${USER}"`));
    assert.ok(res.body.includes('href="/dashboard/cases/mute7k"'));
    assert.ok(res.body.includes(`href="/dashboard/users/${USER}"`));
    assert.deepEqual(h.calls.find((c) => c.name === 'moderationRecord').args, [MAIN, USER], 'the main server record');
    assert.ok(!/<style|style=|<script/i.test(res.body.replace(ALLOWED_SCRIPT, '')));

    const own = await get(h, h.ow.users, { query: { q: OWNER } });
    assert.ok(own.body.includes('Yes (OWNER_IDS)'));
    assert.ok(!own.body.includes('/owner/blacklist?'), 'owners cannot be blacklisted: no link');

    const listed = await setup({ blacklistActive: [{ id: 1, kind: 'user', target_id: USER, reason: 'raids' }] });
    const lb = (await get(listed, listed.ow.users, { query: { q: USER } })).body;
    assert.ok(lb.includes('Blacklisted</span> raids'));
    assert.ok(!lb.includes('/owner/blacklist?'));
});

test('user lookup: bad or unknown IDs, and database errors are shown as errors (never as a clean record)', async () => {
    const h = await setup();
    const empty = await get(h, h.ow.users);
    assert.equal(empty.statusCode, 200);
    assert.ok(!h.calls.some((c) => c.name === 'moderationRecord'), 'no lookup without a query');
    const bad = await get(h, h.ow.users, { query: { q: '"><b>x' } });
    assert.equal(bad.statusCode, 400);
    assert.ok(!bad.body.includes('<b>x'));
    h.client.users.fetch = async () => { throw new Error('Unknown User'); };
    assert.equal((await get(h, h.ow.users, { query: { q: '300000000000000009' } })).statusCode, 404);

    const broken = await setup({
        moderationRecord: async () => { throw new Error('db down'); },
        blacklistList: async () => { throw new Error('db down'); },
    });
    const res = await get(broken, broken.ow.users, { query: { q: '300000000000000009' } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('moderation record could not be loaded'));
    assert.ok(res.body.includes('blacklist could not be read'));
    assert.ok(!res.body.includes('Not blacklisted') && !res.body.includes('<dt>Active ban</dt>'), 'an error is not shown as "clean"');
    assert.ok(!res.body.includes('/owner/blacklist?'));
});

// ── server permission check ───────────────────────────────────────────────

test('permission check rules: missing permissions in plain words, Administrator covers all, roles above the bot', () => {
    assert.deepEqual(missingPermissions(INSTALL_PERMISSIONS), []);
    assert.deepEqual(missingPermissions(['Administrator']), []);
    const missing = missingPermissions(INSTALL_PERMISSIONS.filter((p) => !['BanMembers', 'ManageRoles'].includes(p)));
    assert.deepEqual(missing.map((m) => `${m.label} — ${m.why}`), [
        'Manage Roles — needed for the Muted role and giving or removing roles', 'Ban Members — needed for bans',
    ], 'INSTALL_PERMISSIONS order');
    assert.equal(missingPermissions([]).length, INSTALL_PERMISSIONS.length);
    assert.ok(missingPermissions([]).every((m) => m.label !== m.name || m.name === 'Connect'), 'every permission has a plain name');
    assert.equal(missingPermissions(null, ['Speak'])[0].why, 'needed by the bot', 'unknown names still listed');

    const top = { name: 'Mewvo', position: 5 };
    const roles = [
        { id: 'a', name: 'Muted', position: 7, why: 'the Muted role (mutes)' }, { id: 'a', name: 'Muted', position: 7, why: 'dup' },
        { id: 'b', name: 'Warning 1', position: 5, why: 'a warning role' }, { id: 'c', name: 'Low', position: 2, why: 'x' },
    ];
    assert.deepEqual(rolesAboveBot(top, roles).map((r) => r.name), ['Muted', 'Warning 1'], 'at or above, each role once');
    assert.deepEqual(rolesAboveBot(null, roles), []);
});

test('server page: lists missing permissions and roles above the bot; a full set says so', async () => {
    const h = await setup({ managedRoles: async () => [{ id: 'm', name: 'Muted', position: 9, why: 'the Muted role (mutes)' }] });
    const me = h.guilds.get(OTHER_GUILD).members.me;
    me.roles = { highest: { name: 'Mewvo', position: 3 } };
    const res = await get(h, h.ow.server, { params: { id: OTHER_GUILD } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('Permission check'));
    assert.ok(res.body.includes('<b>Ban Members</b> <span class="muted">— needed for bans</span>'));
    assert.ok(!res.body.includes('<b>Send Messages</b>'), 'granted permissions are not listed as missing');
    assert.match(res.body, /at or above the bot's highest role \(Mewvo\)/);
    assert.ok(res.body.includes('<b>Muted</b> <span class="muted">— the Muted role (mutes)</span>'));
    assert.ok(!/<style|style=|<script/i.test(res.body.replace(ALLOWED_SCRIPT, '')));

    const full = await setup({ managedRoles: async () => { throw new Error('db down'); } });
    const fme = full.guilds.get(OTHER_GUILD).members.me;
    fme.permissions = { toArray: () => [...INSTALL_PERMISSIONS] };
    fme.roles = { highest: { name: 'Mewvo', position: 3 } };
    const ok = await get(full, full.ow.server, { params: { id: OTHER_GUILD } });
    assert.equal(ok.statusCode, 200, 'an unreadable role list does not break the page');
    assert.ok(ok.body.includes('The bot has every permission it asks for when added.'));
    assert.ok(ok.body.includes('No known role the bot manages'));
});

// ── command sync ──────────────────────────────────────────────────────────

test('command sync rules: counts and mismatches by name and type', () => {
    assert.deepEqual(commandCounts([{ name: 'a' }, { name: 'b', type: 1 }, { name: 'M', type: 3 }]), { slash: 2, menus: 1 });
    const same = commandDiff([{ name: 'help' }, { name: 'Moderate', type: 2 }], [{ name: 'Moderate', type: 2 }, { name: 'help', type: 1 }]);
    assert.deepEqual(same, { missing: [], extra: [], inSync: true }, 'type 1 is the default');
    const diff = commandDiff(
        [{ name: 'rank' }, { name: 'help' }, { name: 'Moderate', type: 2 }],
        [{ name: 'help', type: 1 }, { name: 'Moderate', type: 1 }, { name: 'purge', type: 1 }],
    );
    assert.deepEqual(diff.missing, [{ name: 'Moderate', type: 'User menu' }, { name: 'rank', type: 'Slash command' }]);
    assert.deepEqual(diff.extra, [{ name: 'Moderate', type: 'Slash command' }, { name: 'purge', type: 'Slash command' }]);
    assert.equal(diff.inSync, false);
});

test('command sync page: counts, mismatches by name, errors never shown as "in sync"', async () => {
    const h = await setup({ registeredCommands: async () => [{ name: 'help', type: 1 }, { name: 'purge', type: 1 }] });
    h.client.commands = new Map([['help', {}], ['rank', {}], ['purge', {}], ['Moderate', {}]]);
    const res = await get(h, h.ow.commands);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('4 command files'), 'loaded count');
    assert.ok(res.body.includes('2 slash commands + 1 context menu'), 'what startup registers');
    assert.ok(res.body.includes('2 slash commands + 0 context menus'), 'what Discord has');
    assert.ok(res.body.includes('Missing on Discord (2)') && res.body.includes('<b>rank</b>') && res.body.includes('<b>Moderate</b>'));
    assert.match(res.body, /not in the bot(&#39;|&#x27;|')s list \(1\)/);
    assert.deepEqual(h.calls.find((c) => c.name === 'registeredCommands').args[1], MAIN, 'the main server is read');
    assert.ok(!h.calls.some((c) => c.name === 'registerMainCommands'), 'a GET never registers');

    const synced = await setup({ retired: true });
    const ok = (await get(synced, synced.ow.commands)).body;
    assert.ok(ok.includes('In sync'));
    assert.ok(ok.includes('RETIRE_ADMIN_COMMANDS is on'));

    const broken = await setup({ registeredCommands: async () => { throw new Error('Missing Access'); } });
    const err = (await get(broken, broken.ow.commands)).body;
    assert.ok(err.includes('list could not be read: Missing Access'));
    assert.ok(!err.includes('In sync') && !err.includes('Out of sync'));
});

test('command re-register: owner POST checks, token + tick-box, the injected registration runs once and is audited', async () => {
    const admin = await setup({ userId: ADMIN });
    assert.equal((await post(admin, admin.ow.registerPreview)).statusCode, 404);
    assert.equal((await post(admin, admin.ow.register, { form: { token: 'x', fh: 'y', confirm: '1' } })).statusCode, 404);
    const stale = await setup({ createdAt: Date.now() - OWNER_SESSION_MAX_AGE_MS - 60000 });
    assert.equal((await post(stale, stale.ow.registerPreview)).statusCode, 401);
    const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    assert.equal((await post(off, off.ow.registerPreview)).statusCode, 403);

    const h = await setup();
    assert.equal((await post(h, h.ow.registerPreview, { csrf: 'wrong' })).statusCode, 403, 'CSRF');
    assert.equal((await post(h, h.ow.registerPreview, { origin: 'https://evil.example' })).statusCode, 403, 'Origin');
    const preview = await post(h, h.ow.registerPreview);
    assert.equal(preview.statusCode, 200);
    assert.ok(preview.body.includes('Confirm: re-register commands in the main server'));
    assert.ok(!/<style|style=|<script/i.test(preview.body.replace(ALLOWED_SCRIPT, '')));
    const { token, fh } = tokenOf(preview.body);
    const noTick = await post(h, h.ow.register, { form: { token, fh } });
    assert.equal(noTick.statusCode, 400);
    assert.ok(!h.calls.some((c) => c.name === 'registerMainCommands'), 'nothing registered without the tick-box');

    const again = tokenOf((await post(h, h.ow.registerPreview)).body);
    const done = await post(h, h.ow.register, { form: { ...again, confirm: '1' } });
    assert.equal(done.statusCode, 303);
    assert.equal(done.redirectedTo, '/dashboard/owner/commands');
    assert.equal(h.calls.filter((c) => c.name === 'registerMainCommands').length, 1);
    assert.deepEqual(h.auditRows.map((r) => [r.module, r.key, r.old, r.new]), [['owner', 'commands.register', { count: 3 }, { count: 3, retired: false }]]);
    const reused = await post(h, h.ow.register, { form: { ...again, confirm: '1' } });
    assert.equal(reused.statusCode, 400, 'a token works once');
    assert.equal(h.calls.filter((c) => c.name === 'registerMainCommands').length, 1);

    const failing = await setup({ registerMainCommands: async () => { throw new Error('Missing Access'); } });
    const t = tokenOf((await post(failing, failing.ow.registerPreview)).body);
    const failed = await post(failing, failing.ow.register, { form: { ...t, confirm: '1' } });
    assert.equal(failed.statusCode, 400);
    assert.match(failed.body, /Registration failed; the main server(&#39;|&#x27;|')s list was not changed: Missing Access/);
    assert.equal(failing.auditRows.length, 0, 'a failed registration is not audited as done');
});
