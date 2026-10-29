// Dashboard staff access levels (permissions.js): the one permission table, the Moderator
// level (moderator role = guild config modRole), the route gate in requireUser, the second
// check in every enforcement POST (fresh member fetch), the service's own check, the
// sidebar and the account menu. Administrators and the Owner area stay as they were.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { createDashboard, dashboardSettings, registerDashboard } from '../src/services/dashboard/routes.js';
import { defaultOwnerDeps } from '../src/services/dashboard/ownerRoutes.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createAccessChecker, decideAccess, hasModeratorRole } from '../src/services/dashboard/access.js';
import { SESSION_COOKIE, signValue } from '../src/services/dashboard/security.js';
import { createConfirmStore } from '../src/services/dashboard/confirmTokens.js';
import { NAV, OWNER_NAV, html, layout, navGroups, navItems } from '../src/services/dashboard/html.js';
import {
    ADMIN as ADMIN_LEVEL, MODERATOR, OWNER_AREA, PERMISSIONS, ROUTES, allows, levelLabel, mayRun, moderatorActionTypes, requiredLevel, routeKey,
} from '../src/services/dashboard/permissions.js';
import { completeFlowDetails } from '../src/services/enforcement/flowBuilder.js';
import { executeAction } from '../src/services/enforcement/enforcementService.js';
import { overviewPage } from '../src/services/dashboard/overview.js';
import { createError, ErrorTypes } from '../src/utils/errorHandler.js';

const SECRET = 'z'.repeat(64);
const GUILD = '100000000000000001';
const ADMIN = '200000000000000002';
const OWNER = '200000000000000003';
const MOD = '200000000000000007';
const TARGET = '300000000000000004';
const OTHER = '300000000000000005';
const HIGH = '300000000000000008';
const MODROLE = '600000000000000050';
const ORIGIN = 'https://bot.example';
const CODE = 'abc234x';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};
const MOD_DECISION = decideAccess({ inGuild: true, isModerator: true });
const ADMIN_DECISION = decideAccess({ inGuild: true, isAdmin: true });
const OWNER_DECISION = decideAccess({ inGuild: true, isOwnerId: true });

// ── the table ─────────────────────────────────────────────────────────────

test('matrix: every sidebar page has an entry; unknown pages, keys and paths are Administrator-only', () => {
    for (const item of navItems()) {
        assert.ok(Object.hasOwn(PERMISSIONS, `page:${item.key}`), `no entry for page ${item.key}`);
        assert.equal(routeKey('GET', `/${item.key}`), `page:${item.key}`, item.key);
    }
    for (const value of Object.values(PERMISSIONS)) assert.ok(value === ADMIN_LEVEL || value === MODERATOR);
    assert.equal(requiredLevel('page:some-new-page'), ADMIN_LEVEL);
    assert.equal(requiredLevel(null), ADMIN_LEVEL);
    assert.equal(requiredLevel('toString'), ADMIN_LEVEL, 'no prototype keys');
    assert.equal(routeKey('GET', '/a/b/c'), null);
    assert.equal(allows(MOD_DECISION, routeKey('GET', '/a/b/c')), false);
    assert.equal(allows(MOD_DECISION, routeKey('GET', '/brand-new-module')), false);
    assert.equal(allows(MOD_DECISION, routeKey('POST', '/brand-new/thing')), false);
    assert.equal(routeKey('GET', '/owner/servers/1'), OWNER_AREA);
    assert.equal(routeKey('POST', '/owner/announce/send'), OWNER_AREA);
    assert.equal(routeKey('POST', '/automod/enabled'), 'settings.edit');
    assert.equal(routeKey('GET', '/users/bulk/abc'), 'member.bulk', 'before /users/:id');
    assert.equal(routeKey('HEAD', '/cases'), 'page:cases');
});

test('matrix: the final Moderator level', () => {
    const moderatorKeys = Object.keys(PERMISSIONS).filter((key) => PERMISSIONS[key] === MODERATOR).sort();
    assert.deepEqual(moderatorKeys, [
        'action:kick', 'action:mute', 'action:unmute', 'action:warn', 'inbox.close', 'inbox.reply', 'member.action', 'member.timeout',
        'page:appeals', 'page:bans', 'page:cases', 'page:inbox', 'page:nocontact', 'page:overview', 'page:users', 'session.logout',
    ]);
    assert.deepEqual(moderatorActionTypes().sort(), ['kick', 'mute', 'unmute', 'warn']);
    // Admins and owners are not restricted by the table (their existing checks apply); moderators only by it.
    for (const key of Object.keys(PERMISSIONS)) {
        assert.equal(allows(ADMIN_DECISION, key), true);
        assert.equal(allows(OWNER_DECISION, key), true);
        assert.equal(allows(MOD_DECISION, key), PERMISSIONS[key] === MODERATOR, key);
        assert.equal(mayRun(ADMIN_DECISION, key), true);
        assert.equal(mayRun(OWNER_DECISION, key), false, 'owners still cannot run enforcement actions');
    }
    assert.equal(allows(decideAccess({ inGuild: true }), 'page:overview'), false);
    assert.equal(levelLabel(MOD_DECISION), 'Moderator');
    assert.equal(levelLabel(ADMIN_DECISION), 'Administrator');
    assert.equal(levelLabel(OWNER_DECISION), 'View and settings (bot owner)');
});

test('access: Administrator, then OWNER_IDS, then the moderator role; the role read fails closed', async () => {
    assert.equal(decideAccess({ inGuild: true, isAdmin: true, isModerator: true }).role, 'admin');
    assert.equal(decideAccess({ inGuild: true, isOwnerId: true, isModerator: true }).role, 'owner');
    assert.deepEqual(MOD_DECISION, { allowed: true, canView: false, canAct: false, role: 'moderator', reason: 'moderator role in the main server' });
    assert.equal(decideAccess({ inGuild: false, isModerator: true }).allowed, false, 'must be in the main server');
    const member = (roles) => ({ roles: { cache: new Map(roles.map((id) => [id, { id }])) } });
    assert.equal(await hasModeratorRole({}, GUILD, member([MODROLE]), async () => ({ modRole: MODROLE })), true);
    assert.equal(await hasModeratorRole({}, GUILD, member([MODROLE]), async () => ({ modRole: { id: MODROLE } })), true);
    assert.equal(await hasModeratorRole({}, GUILD, member([]), async () => ({ modRole: MODROLE })), false);
    assert.equal(await hasModeratorRole({}, GUILD, member([MODROLE]), async () => ({})), false, 'no role configured');
    assert.equal(await hasModeratorRole({}, GUILD, member([MODROLE]), async () => { throw new Error('db down'); }), false);
});

test('every registered dashboard route has a table entry (the gate never falls back for a known route)', () => {
    const mounted = [];
    const app = { use: (base, router) => mounted.push({ base, router }) };
    assert.equal(registerDashboard(app, {}, ENV, { sessions: createMemorySessionStore() }), true);
    const { router } = mounted.find((m) => m.base === '/dashboard');
    const routes = router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods).map((m) => [m.toUpperCase(), layer.route.path]));
    assert.ok(routes.length > 50, `found ${routes.length}`);
    const open = new Set(['/static/:file', '/theme', '/', '/oauth/callback']); // no login: never behind requireUser
    const sample = (p) => p.replace(':id', TARGET).replace(':code', CODE).replace(':module', 'automod').replace(':action', 'enabled').replace(':job', 'j1').replace(':file', 'x');
    for (const [method, routePath] of routes) {
        if (open.has(routePath)) continue;
        const key = routeKey(method, sample(routePath));
        assert.ok(key, `${method} ${routePath} has no entry`);
        assert.ok(ROUTES.some(([m, p]) => (m === method || m === '*') && (p === routePath || p === '/owner/*' || p === '/:module' || p === '/:module/:action')), `${method} ${routePath} not listed in ROUTES`);
    }
});

// ── fakes ─────────────────────────────────────────────────────────────────

function makeWorld(state) {
    const guild = { id: GUILD, ownerId: '999999999999999990', name: 'Main', memberCalls: [] };
    const roleMap = (id) => {
        const roles = [[GUILD, { id: GUILD, name: '@everyone', position: 0 }], ['600000000000000001', { id: '600000000000000001', name: 'Member', position: 1 }]];
        if (id === MOD && state.modHasRole) roles.push([MODROLE, { id: MODROLE, name: 'Moderator', position: 4 }]);
        return new Map(roles);
    };
    const highest = (id) => ({ [ADMIN]: 5, [MOD]: state.modHasRole ? 4 : 1, [HIGH]: 6 }[id] ?? 1);
    const memberOf = (id) => ({
        id, guild, nickname: null, joinedAt: new Date('2025-01-01T00:00:00Z'),
        user: { id, username: `user${id.slice(-2)}`, globalName: null },
        permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator && state.admins.has(id) },
        roles: {
            cache: roleMap(id), highest: { position: highest(id) },
            add: async (roleId) => { guild.memberCalls.push({ id, call: 'roles.add', roleId }); },
            remove: async (roleId) => { guild.memberCalls.push({ id, call: 'roles.remove', roleId }); },
        },
        setNickname: async (nick) => { guild.memberCalls.push({ id, call: 'setNickname', nick }); },
        timeout: async (ms) => { guild.memberCalls.push({ id, call: 'timeout', ms }); },
        communicationDisabledUntilTimestamp: null,
    });
    const cache = new Map([[TARGET, memberOf(TARGET)], [OTHER, memberOf(OTHER)], [HIGH, memberOf(HIGH)]]);
    guild.roles = { cache: new Map([[GUILD, { id: GUILD, name: '@everyone', position: 0 }], ['600000000000000001', { id: '600000000000000001', name: 'Member', position: 1 }],
        ['600000000000000002', { id: '600000000000000002', name: 'Helper', position: 2 }], [MODROLE, { id: MODROLE, name: 'Moderator', position: 4 }]]) };
    guild.members = {
        cache,
        me: { id: '999999999999999998', user: { id: '999999999999999998' }, permissions: { has: () => true }, roles: { highest: { position: 10 } } },
        fetch: async (arg) => {
            const id = typeof arg === 'string' ? arg : arg?.user;
            if (id === ADMIN || id === OWNER || id === MOD) return memberOf(id);
            return cache.get(id) || null;
        },
    };
    const users = new Map([[TARGET, 'target'], [OTHER, 'other'], [HIGH, 'high'], [ADMIN, 'admin'], [OWNER, 'owner'], [MOD, 'mod']]);
    const client = {
        user: { id: '999999999999999998', username: 'bot' },
        guilds: { cache: new Map([[GUILD, guild]]) },
        users: {
            cache: new Map(),
            fetch: async (id) => (users.has(id) ? { id, username: users.get(id), globalName: null, bot: false, createdAt: new Date('2020-01-01T00:00:00Z'), displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/x.png` } : null),
        },
    };
    return { guild, client };
}

const fakeDeps = {
    isNameTaken: async () => false,
    nextDefaultName: async (guildId, userId, username, type) => `${username} ${type} 1`,
    assertBotPermissions: () => {},
    assertCanTarget: (guild, moderator, targetId) => {
        if (targetId === moderator.id) throw createError('self', ErrorTypes.VALIDATION, 'You cannot warn yourself.', { expected: true });
    },
    getTargetState: async () => ({ ladder: { level: 0, warns_since_level: 1 } }),
    captureLinks: async (guild, entries) => entries.map(({ url }) => ({ url, sourceMessageUrl: null, excerpt: null })),
    precedentHint: async () => null,
    getLadder: async () => ({ level: 0, warns_since_level: 1 }),
};

function makeEnforcement(state) {
    const calls = [];
    const rec = (name, value) => (...args) => { calls.push({ name, args }); return typeof value === 'function' ? value(...args) : value; };
    const record = { id: 1, case_code: CODE, guild_id: GUILD, target_user_id: TARGET, target_username: 'target', type: 'ban', status: 'active', reason: 'r', name: 'target ban 1', moderator_username: 'mod', created_at: new Date(), duration_ms: 3600000, expires_at: new Date(Date.now() + 3600000) };
    const e = {
        memberStandings: rec('memberStandings', async () => ({ ladder: new Map(), muted: new Set() })),
        getTargetState: rec('getTargetState', async (guild, id) => ({ member: guild.members.cache.get(id) || null, banned: false, muted: id === OTHER, ladder: { level: 0, warns_since_level: 1 }, activeBan: null, activeMute: null })),
        getLadder: rec('getLadder', async () => ({ level: 0, warns_since_level: 1 })),
        getCountedWarns: rec('getCountedWarns', async () => [{ case_code: 'wrn2345', name: 'w', reason: 'Spam' }]),
        listCasesForUser: rec('listCasesForUser', async () => ({ rows: [], total: 0 })),
        getLatestAppealStatuses: rec('getLatestAppealStatuses', async () => new Map()),
        getActiveOrdersFor: rec('getActiveOrdersFor', () => []),
        listNotes: rec('listNotes', async () => []),
        addNote: rec('addNote', async (g, u, content) => ({ id: 1, content })),
        precedentHint: rec('precedentHint', async () => null),
        completeFlowDetails: rec('completeFlowDetails', (args) => completeFlowDetails({ ...args, deps: fakeDeps })),
        executeAction: rec('executeAction', async () => (state.guardBlocks
            ? Promise.reject(createError('blocked', ErrorTypes.PERMISSION, 'You are blocked by the mass-action guard for 60 minutes.', { expected: true }))
            : { record: null, dmDelivered: true, notes: [] })),
        attachFlowEvidence: rec('attachFlowEvidence', async () => []),
        recentBanKickCount: rec('recentBanKickCount', async () => 0),
        activeBanCases: rec('activeBanCases', async () => new Map()),
        listTempRoles: rec('listTempRoles', async () => []),
        getMassActionBlock: rec('getMassActionBlock', async () => null),
        getCaseByCode: rec('getCaseByCode', async (code) => (code === CODE ? { ...record } : null)),
        getAppealHistory: rec('getAppealHistory', async () => [{ id: 3, status: 'pending', created_at: new Date(), body: { reason: 'sorry', didIt: 'yes' } }]),
        listEvidence: rec('listEvidence', async () => []),
        resolveImageUrls: rec('resolveImageUrls', async () => new Map()),
        decideAppeal: rec('decideAppeal', async () => ({ record, dmDelivered: true, label: 'accepted', notes: [] })),
        listActiveNoContactOrders: rec('listActiveNoContactOrders', async () => []),
        addNoContactOrder: rec('addNoContactOrder', async () => ({ order: { id: 8 }, delivered: [true, true] })),
        listMassActionBlocks: rec('listMassActionBlocks', async () => []),
        loadCoverageCounts: rec('loadCoverageCounts', async () => ({ incidents: [], staff: [] })),
        getGuildConfig: rec('getGuildConfig', async () => ({ modRole: MODROLE, birthdayTimezone: 'UTC' })),
        isBotOwner: (id) => id === OWNER,
    };
    return { e, calls };
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

/** userId logs in; the access facts follow `state` (admins, modHasRole) like Discord would. */
async function setup({ userId = MOD, admins = new Set([ADMIN]), owners = new Set([OWNER]) } = {}) {
    const state = { admins, modHasRole: true, guardBlocks: false };
    const { guild, client } = makeWorld(state);
    const { e, calls } = makeEnforcement(state);
    const sessions = createMemorySessionStore();
    const access = createAccessChecker(client, {
        facts: async (c, id) => ({ inGuild: true, isAdmin: state.admins.has(id), isOwnerId: owners.has(id), isModerator: id === MOD && state.modHasRole }),
    });
    const auditRows = [];
    const auditStore = {
        writeRows: async (g, actor, module, changes) => { for (const c of changes) auditRows.push({ actor, module, ...c }); return changes.length; },
        list: async () => ({ rows: [], total: 0 }), users: async () => [],
    };
    const services = { postModLog: async () => {}, getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) };
    const data = {
        overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) },
        getCaseByCode: e.getCaseByCode, getCaseEdits: async () => [], listEvidence: async () => [],
        resolveImageUrls: async () => new Map(), getAppealHistory: async () => [],
        listPendingAppeals: async () => [{ case_code: CODE, type: 'ban', username: 'target', user_id: TARGET, created_at: new Date() }],
        staffModerationStats: async () => [], searchCaseRecords: async () => ({ rows: [], total: 0 }), getLatestAppealStatusesForCases: async () => new Map(),
    };
    const d = createDashboard({ client, settings: dashboardSettings(ENV), sessions, access, services, auditStore, env: ENV, enforcement: e, confirms: createConfirmStore(), data,
        owner: { ...defaultOwnerDeps, isBotOwner: (id) => owners.has(id) } });
    const session = await sessions.create({ userId, username: 'staff' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, e, calls, sessions, session, cookie, auditRows, guild, client, state, access };
}

/** requireUser, then the handler when it let the request through. */
async function run(h, handler, req) {
    const res = fakeRes();
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (passed && handler) await handler(req, res, () => { res.fellThrough = true; });
    res.passed = passed;
    return res;
}

const get = (h, handler, reqPath, params = {}) => run(h, handler, { method: 'GET', path: reqPath, params, query: {}, headers: { cookie: h.cookie } });
const post = (h, handler, reqPath, { params = {}, form = {} } = {}) => run(h, handler, {
    method: 'POST', path: reqPath, params, query: {}, headers: { cookie: h.cookie, origin: ORIGIN }, body: { csrf: h.session.csrf, ...form },
});
const tokenFrom = (body) => ({ token: /name="token" value="([^"]+)"/.exec(body)?.[1], fh: /name="fh" value="([^"]+)"/.exec(body)?.[1] });
const sample = (p) => p.replace(':id', TARGET).replace(':code', CODE).replace(':module', 'automod').replace(':action', 'enabled').replace(':job', 'j1');

// ── the Moderator level, end to end ───────────────────────────────────────

test('moderator: may GET Overview, Members, a member, Banned, Cases, a case, Appeals, an appeal, No-contact', async () => {
    const h = await setup();
    const en = h.d.enforcement;
    const pages = [
        ['/users', en.users], [`/users/${TARGET}`, en.userPage, { id: TARGET }], ['/bans', en.bans],
        ['/cases', h.d.cases], [`/cases/${CODE}`, h.d.caseDetail, { code: CODE }],
        ['/appeals', h.d.appeals], [`/appeals/${CODE}`, en.appealDetail, { code: CODE }], ['/nocontact', en.noContact],
    ];
    h.guild.bans = { fetch: async () => new Map() };
    for (const [p, handler, params] of pages) {
        const res = await get(h, handler, p, params);
        assert.equal(res.statusCode, 200, `${p}: ${String(res.body).slice(0, 300)}`);
        assert.match(res.body, /<span class="muted">Moderator<\/span>/, `${p}: account menu shows the level`);
    }
    const overview = await get(h, null, '/overview');
    assert.equal(overview.passed, true, 'the Overview passes the gate');
});

test('moderator: every Administrator-only page gets 403 with a clear message (sidebar pages, new pages, unknown paths)', async () => {
    const h = await setup();
    const forbidden = [...navItems().filter((item) => PERMISSIONS[`page:${item.key}`] !== MODERATOR).map((item) => `/${item.key}`), '/users/bulk/j1', '/brand-new-page', '/a/b/c'];
    assert.ok(forbidden.includes('/staff') && forbidden.includes('/messages') && forbidden.includes('/channels') && forbidden.includes('/commands') && forbidden.includes('/audit'));
    for (const p of forbidden) {
        const res = await get(h, h.d.modulePage, p, { module: p.slice(1) });
        assert.equal(res.statusCode, 403, p);
        assert.equal(res.passed, false, `${p}: no handler ran`);
        assert.match(res.body, /This needs Administrator in the main server\. As a moderator you can use/);
    }
    assert.ok(await h.sessions.get(h.session.id), 'a forbidden page does not log the moderator out');
});

test('moderator: every Administrator-only POST route gets 403 before any handler (loop over the table)', async () => {
    const h = await setup();
    const posts = ROUTES.filter(([m, , key]) => m === 'POST' && typeof key === 'string' && key !== OWNER_AREA && requiredLevel(key) !== MODERATOR);
    assert.ok(posts.length >= 20, `${posts.length} forbidden POST routes`);
    for (const [, pattern] of posts) {
        const res = await post(h, h.d.moduleAction, sample(pattern), { params: { module: 'automod', action: 'enabled' } });
        assert.equal(res.statusCode, 403, pattern);
        assert.equal(res.passed, false, pattern);
    }
    assert.equal(h.calls.filter((c) => !['getGuildConfig'].includes(c.name)).length, 0, 'no service was called');
    assert.equal(h.guild.memberCalls.length, 0, 'nothing reached Discord');
});

test('moderator: the handlers refuse on their own too (second check behind the route gate)', async () => {
    const h = await setup();
    const en = h.d.enforcement;
    // Through an allowed route path, but the handler of a forbidden action.
    const handlers = [en.roleAdd, en.roleRemove, en.nickname, en.unverify, en.noteAdd, en.noteRemove, en.bulkPreview, en.bulkExecute,
        en.caseEdit, en.caseVoid, en.evidenceAdd, en.evidenceRemove, en.appealPreview, en.appealDecide, en.noContactAdd, en.noContactEnd,
        en.blockLift, en.staffWarn, en.staffRestore, h.d.moduleAction];
    for (const handler of handlers) {
        const res = await post(h, handler, `/users/${TARGET}/timeout`, { params: { id: TARGET, code: CODE, module: 'automod', action: 'enabled' }, form: { roleId: '600000000000000002', note: 'x' } });
        assert.equal(res.statusCode, 403, handler.name || 'handler');
    }
    assert.equal(h.guild.memberCalls.length, 0);
    assert.equal(h.calls.filter((c) => ['executeAction', 'addNote', 'editCase', 'decideAppeal', 'addNoContactOrder'].includes(c.name)).length, 0);
});

test('moderator: warn / mute / unmute / kick preview and execute; executeAction gets the fresh role for its own check', async () => {
    const h = await setup();
    const en = h.d.enforcement;
    const forms = { warn: { reason: 'spam' }, mute: { reason: 'spam', duration: '1h' }, kick: { reason: 'spam' }, unmute: { reason: 'ok' } };
    for (const [type, form] of Object.entries(forms)) {
        const target = type === 'unmute' ? OTHER : TARGET;
        const preview = await post(h, en.actionPreview, `/users/${target}/action/preview`, { params: { id: target }, form: { type, ...form } });
        assert.equal(preview.statusCode, 200, `${type}: ${String(preview.body).slice(-400)}`);
        const { token, fh } = tokenFrom(preview.body);
        const done = await post(h, en.actionExecute, `/users/${target}/action/execute`, { params: { id: target }, form: { token, fh } });
        assert.equal(done.statusCode, 303, type);
    }
    const executed = h.calls.filter((c) => c.name === 'executeAction');
    assert.deepEqual(executed.map((c) => c.args[0].flow.type), ['warn', 'mute', 'kick', 'unmute']);
    for (const call of executed) {
        assert.equal(call.args[0].moderator.id, MOD);
        assert.deepEqual(call.args[0].staffRole, { roleId: MODROLE, actions: moderatorActionTypes() });
    }
    assert.equal(h.auditRows.filter((r) => r.module === 'actions').length, 4);
});

test('moderator: ban, unban and remove warn are refused (403) and run nothing', async () => {
    const h = await setup();
    for (const type of ['ban', 'unban', 'removewarn']) {
        const res = await post(h, h.d.enforcement.actionPreview, `/users/${TARGET}/action/preview`, { params: { id: TARGET }, form: { type, reason: 'spam', warn: 'wrn2345' } });
        assert.equal(res.statusCode, 403, type);
        assert.match(res.body, /needs Administrator in the main server/);
    }
    assert.equal(h.calls.filter((c) => c.name === 'executeAction' || c.name === 'completeFlowDetails').length, 0);
});

test('moderator: a ban token issued while they were Administrator is refused once they are a moderator', async () => {
    const h = await setup();
    h.state.admins.add(MOD);
    h.access.forget(MOD);
    const preview = await post(h, h.d.enforcement.actionPreview, `/users/${TARGET}/action/preview`, { params: { id: TARGET }, form: { type: 'ban', reason: 'spam' } });
    assert.equal(preview.statusCode, 200);
    const { token, fh } = tokenFrom(preview.body);
    h.state.admins.delete(MOD);
    h.access.forget(MOD);
    const done = await post(h, h.d.enforcement.actionExecute, `/users/${TARGET}/action/execute`, { params: { id: TARGET }, form: { token, fh } });
    assert.equal(done.statusCode, 403);
    assert.equal(h.calls.filter((c) => c.name === 'executeAction').length, 0);
});

test('moderator: timeout works; hierarchy (equal or higher role) still refuses; the mass-action guard message comes through', async () => {
    const h = await setup();
    const en = h.d.enforcement;
    const ok = await post(h, en.timeout, `/users/${TARGET}/timeout`, { params: { id: TARGET }, form: { duration: '1h' } });
    assert.equal(ok.statusCode, 303, ok.body);
    assert.deepEqual(h.guild.memberCalls.map((c) => [c.id, c.call]), [[TARGET, 'timeout']]);
    const high = await post(h, en.timeout, `/users/${HIGH}/timeout`, { params: { id: HIGH }, form: { duration: '1h' } });
    assert.equal(high.statusCode, 400);
    assert.match(high.body, /at or above/);
    assert.equal(h.guild.memberCalls.length, 1, 'nothing more reached Discord');
    h.state.guardBlocks = true;
    const preview = await post(h, en.actionPreview, `/users/${TARGET}/action/preview`, { params: { id: TARGET }, form: { type: 'kick', reason: 'spam' } });
    const { token, fh } = tokenFrom(preview.body);
    const blocked = await post(h, en.actionExecute, `/users/${TARGET}/action/execute`, { params: { id: TARGET }, form: { token, fh } });
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.body, /mass-action guard/);
});

test('moderator: role removed since login → POSTs refused on the fresh fetch; then the whole dashboard once the cache expires', async () => {
    const h = await setup();
    assert.equal((await get(h, null, '/overview')).passed, true);
    h.state.modHasRole = false; // removed in Discord; the access decision is still cached (60 s)
    const timeout = await post(h, h.d.enforcement.timeout, `/users/${TARGET}/timeout`, { params: { id: TARGET }, form: { duration: '1h' } });
    assert.equal(timeout.statusCode, 403);
    assert.match(timeout.body, /moderator role or Administrator/);
    const preview = await post(h, h.d.enforcement.actionPreview, `/users/${TARGET}/action/preview`, { params: { id: TARGET }, form: { type: 'warn', reason: 'spam' } });
    assert.equal(preview.statusCode, 403);
    assert.equal(h.guild.memberCalls.length, 0);
    h.access.forget(MOD);
    const after = await get(h, null, '/overview');
    assert.equal(after.statusCode, 403);
    assert.match(after.body, /no longer an administrator or moderator/);
    assert.equal(await h.sessions.get(h.session.id), null, 'session ended');
});

test('Owner area unaffected: 404 for a moderator, still open to OWNER_IDS', async () => {
    const h = await setup();
    const res = await get(h, h.d.owner.requireOwner, '/owner/profile');
    assert.equal(res.passed, true, 'the table leaves the Owner area to requireOwner');
    assert.equal(res.statusCode, 404);
    const o = await setup({ userId: OWNER });
    let reached = false;
    const ownerRes = await get(o, (req, r, next) => o.d.owner.requireOwner(req, r, () => { reached = true; next(); }), '/owner/profile');
    assert.equal(ownerRes.statusCode, 200);
    assert.equal(reached, true);
});

test('Administrators and bot owners: every page and route passes the gate as before', async () => {
    for (const userId of [ADMIN, OWNER]) {
        const h = await setup({ userId });
        for (const item of navItems()) assert.equal((await get(h, null, `/${item.key}`)).passed, true, `${userId} ${item.key}`);
        for (const [m, pattern] of ROUTES) {
            if (m !== 'POST' && m !== 'GET') continue;
            const res = await run(h, null, { method: m, path: sample(pattern), params: {}, query: {}, headers: { cookie: h.cookie, origin: ORIGIN }, body: { csrf: h.session.csrf } });
            assert.equal(res.passed, true, `${userId} ${m} ${pattern}`);
        }
    }
});

test('executeAction (service): a non-Administrator runs only the listed types while holding the role', async () => {
    const guild = { id: GUILD, members: { me: { permissions: { has: () => true } } } };
    const mod = (roles) => ({ id: MOD, guild, user: { username: 'mod' }, permissions: { has: () => false }, roles: { cache: new Map(roles.map((id) => [id, { id }])) } });
    const target = { id: TARGET, username: 'target' };
    const staffRole = { roleId: MODROLE, actions: moderatorActionTypes() };
    await assert.rejects(executeAction({ guild, moderator: mod([MODROLE]), targetUser: target, flow: { type: 'warn' } }), /Administrator/, 'no staffRole: Administrator only, as before');
    await assert.rejects(executeAction({ guild, moderator: mod([MODROLE]), targetUser: target, flow: { type: 'ban' }, staffRole }), /Administrator/);
    await assert.rejects(executeAction({ guild, moderator: mod([]), targetUser: target, flow: { type: 'warn' }, staffRole }), /Administrator/);
});

test('moderator: a warn that would trigger the automatic ladder ban is refused (no ban by the back door)', async () => {
    const h = await setup();
    h.e.getTargetState = async (guild, id) => ({ member: guild.members.cache.get(id) || null, banned: false, muted: false, ladder: { level: 0, warns_since_level: 2 }, activeBan: null, activeMute: null });
    const preview = await post(h, h.d.enforcement.actionPreview, `/users/${TARGET}/action/preview`, { params: { id: TARGET }, form: { type: 'warn', reason: 'spam' } });
    assert.equal(preview.statusCode, 403);
    assert.match(preview.body, /would automatically ban .* needs an Administrator/);
    assert.equal(h.calls.filter((c) => c.name === 'executeAction').length, 0);
    // An Administrator may still give that warn.
    const admin = await setup({ userId: ADMIN });
    admin.e.getTargetState = h.e.getTargetState;
    const ok = await post(admin, admin.d.enforcement.actionPreview, `/users/${TARGET}/action/preview`, { params: { id: TARGET }, form: { type: 'warn', reason: 'spam' } });
    assert.equal(ok.statusCode, 200);
});

// ── sidebar and shell ─────────────────────────────────────────────────────

test('sidebar: a moderator sees only their pages; no "Find a setting"; Administrators see everything', () => {
    const groups = navGroups({}, MOD_DECISION);
    assert.deepEqual(groups.flatMap((g) => g.items.map((i) => i.key)), ['overview', 'inbox', 'users', 'bans', 'cases', 'appeals', 'nocontact']);
    assert.deepEqual(groups.map((g) => g.group), ['Moderate'], 'empty groups dropped');
    assert.deepEqual(navGroups({ isOwner: true }, OWNER_DECISION).map((g) => g.group), [...NAV.map((g) => g.group), OWNER_NAV.group]);
    assert.equal(navGroups({}, ADMIN_DECISION).flatMap((g) => g.items).length, navItems().length);
    const session = { username: 'mod', csrf: 't' };
    const page = String(layout({ title: 'x', active: 'users', session, access: MOD_DECISION, body: html`` }));
    for (const item of navItems()) {
        const linked = page.includes(`href="/dashboard/${item.key}"`);
        assert.equal(linked, PERMISSIONS[`page:${item.key}`] === MODERATOR, `${item.key} in the moderator's sidebar`);
    }
    assert.ok(!page.includes('Find a setting'));
    assert.match(page, /<span class="muted">Moderator<\/span>/);
    const admin = String(layout({ title: 'x', active: 'users', session, access: ADMIN_DECISION, body: html`` }));
    for (const item of navItems()) assert.ok(admin.includes(`href="/dashboard/${item.key}"`), item.key);
    assert.ok(admin.includes('Find a setting'));
    assert.match(admin, /<span class="muted">Administrator<\/span>/);
});

test('Overview for a moderator: no setup, modules, tickets or audit parts', () => {
    const o = { checklist: [{ label: 'Mod log channel', done: false, href: '/dashboard/enforcement', hint: 'h' }], bot: { ready: true, ping: null }, database: null, guild: null, recent: [], openTickets: 2, pendingAppeals: 0, lockdown: { active: true } };
    const mod = String(overviewPage({ session: { username: 'm', csrf: 't' }, access: MOD_DECISION, overview: o, recentChanges: [], editEnabled: true }));
    for (const href of ['/dashboard/enforcement', '/dashboard/tickets', '/dashboard/automod', '/dashboard/modules', '/dashboard/audit']) assert.ok(!mod.includes(`href="${href}"`), href);
    assert.ok(!mod.includes('Recent dashboard changes'));
    const admin = String(overviewPage({ session: { username: 'a', csrf: 't' }, access: ADMIN_DECISION, overview: o, recentChanges: [], editEnabled: true }));
    assert.ok(admin.includes('href="/dashboard/tickets"') && admin.includes('Recent dashboard changes'));
});

test('inbox for moderators: staff reports (complaints about staff) are filtered out', async () => {
    const { inboxForModerator } = await import('../src/services/dashboard/inboxData.js');
    const full = {
        items: [{ kind: 'appeal' }, { kind: 'report' }, { kind: 'ticket' }],
        counts: { appeal: 1, report: 1, ticket: 1, modmail: 0, review: 0 }, failed: ['report'], total: 3,
    };
    const mod = inboxForModerator(full);
    assert.deepEqual(mod.items.map((i) => i.kind), ['appeal', 'ticket']);
    assert.equal(mod.counts.report, 0);
    assert.equal(mod.total, 2);
    assert.deepEqual(mod.failed, []);
});

test('role rules and insights are Administrator-only (their paths are not swallowed by /users/:id)', async () => {
    const { routeKey, requiredLevel, ADMIN } = await import('../src/services/dashboard/permissions.js');
    for (const [method, path] of [['GET', '/users/rules'], ['GET', '/users/insights'], ['POST', '/users/rules/save'], ['POST', '/users/rules/12/delete'],
        ['GET', '/users/RULES'], ['GET', '/Users/Insights'], ['GET', '/AUDIT'], ['GET', '/Staff']]) { // Express routes ignore case; so must the gate
        assert.equal(requiredLevel(routeKey(method, path)), ADMIN, `${method} ${path}`);
    }
});
