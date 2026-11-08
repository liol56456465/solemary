// Multi-server B3 (A2): dashboard access levels per server. decideAccess's role matrix (admin,
// owner, manager, moderator, nobody) and its contract fields, memberFacts in a home server vs
// another server (OWNER_IDS count only where hasOwnerPower says so), the 30-second cache keyed
// per (user, server) with forget/checkFresh, permissions.js for the Manage Server level, and the
// enforcement routes' owner checks bound to the dashboard's server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

const HOME = '100000000000000001';
process.env.MAIN_GUILD_ID ??= HOME;
const MAIN = process.env.MAIN_GUILD_ID;
const OTHER = '100000000000000099';

const { ACCESS_CACHE_MS, createAccessChecker, decideAccess, memberFacts } = await import('../src/services/dashboard/access.js');
const { MANAGER, MANAGER_PAGES, MODERATOR, allows, levelLabel, managerAllows, mayRun, routeKey } = await import('../src/services/dashboard/permissions.js');
const { createEnforcementHandlers } = await import('../src/services/dashboard/enforcementRoutes.js');
const { defaultEnforcement } = await import('../src/services/dashboard/enforcementData.js');

const ADMIN = '200000000000000002';
const OWNER = '200000000000000003';
const MANAGERID = '200000000000000004';
const MOD = '200000000000000005';
const BOTH = '200000000000000006'; // moderator role + Manage Server
const STRANGER = '200000000000000007';
const MODROLE = '600000000000000050';

const fields = (d) => [d.allowed, d.canView, d.canAct, d.canEditSettings, d.role];

test('decideAccess: the role matrix and the contract fields', () => {
    assert.deepEqual(fields(decideAccess({ inGuild: true, isAdmin: true })), [true, true, true, true, 'admin']);
    assert.deepEqual(fields(decideAccess({ inGuild: true, isOwnerId: true })), [true, true, false, true, 'owner']);
    assert.deepEqual(fields(decideAccess({ inGuild: true, isManager: true })), [true, true, false, true, 'manager']);
    assert.deepEqual(fields(decideAccess({ inGuild: true, isModerator: true })), [true, false, false, false, 'moderator']);
    assert.deepEqual(fields(decideAccess({ inGuild: true })), [false, false, false, false, null]);
    assert.deepEqual(fields(decideAccess({})), [false, false, false, false, null]);
    // Order: Administrator beats everything; owner power beats Manage Server.
    assert.equal(decideAccess({ inGuild: true, isAdmin: true, isManager: true, isOwnerId: true }).role, 'admin');
    assert.equal(decideAccess({ inGuild: true, isOwnerId: true, isManager: true }).role, 'owner');
    // Manage Server elsewhere does not count.
    assert.equal(decideAccess({ inGuild: false, isManager: true }).allowed, false);
    // Moderator role + Manage Server: still a moderator (keeps the moderator filters), settings on top.
    const both = decideAccess({ inGuild: true, isModerator: true, isManager: true });
    assert.deepEqual([...fields(both), both.manager], [true, true, false, true, 'moderator', true]);
});

/** A fake server: members with a permission set and roles. */
function fakeGuild(id, members) {
    return {
        id,
        members: {
            fetch: async ({ user }) => {
                const m = members[user];
                if (!m) return null;
                const bits = new Set(m.perms || []);
                return { permissions: { has: (bit) => bits.has(bit) }, roles: { cache: new Map((m.roles || []).map((r) => [r, { id: r }])) } };
            },
        },
    };
}

const client = {
    guilds: {
        cache: new Map([
            [MAIN, fakeGuild(MAIN, {
                [ADMIN]: { perms: [PermissionFlagsBits.Administrator] },
                [OWNER]: {},
                [MANAGERID]: { perms: [PermissionFlagsBits.ManageGuild] },
                [MOD]: { roles: [MODROLE] },
                [BOTH]: { perms: [PermissionFlagsBits.ManageGuild], roles: [MODROLE] },
                [STRANGER]: {},
            })],
            [OTHER, fakeGuild(OTHER, {
                [OWNER]: {}, // a plain member there
                [ADMIN]: {}, // no permissions in the other server
                [MANAGERID]: { perms: [PermissionFlagsBits.ManageGuild] },
            })],
        ]),
    },
};
const config = async () => ({ modRole: MODROLE });
const isHome = (id) => id === MAIN;
const decide = async (userId, guildId, owners = [OWNER]) => decideAccess(await memberFacts(client, userId, guildId, owners, config, { isHome }));

test('memberFacts per server: admin, manager, moderator, owner at home vs elsewhere, stranger', async () => {
    assert.equal((await decide(ADMIN, MAIN)).role, 'admin');
    assert.equal((await decide(MANAGERID, MAIN)).role, 'manager');
    assert.equal((await decide(MOD, MAIN)).role, 'moderator');
    assert.equal((await decide(BOTH, MAIN)).manager, true);
    assert.equal((await decide(OWNER, MAIN)).role, 'owner', 'OWNER_IDS in a Mewvo server');
    assert.equal((await decide(STRANGER, MAIN)).allowed, false);

    assert.equal((await decide(OWNER, OTHER)).allowed, false, 'OWNER_IDS elsewhere are ordinary members');
    assert.equal((await decide(ADMIN, OTHER)).allowed, false, 'Administrator at home does not carry over');
    assert.equal((await decide(MANAGERID, OTHER)).role, 'manager');
    assert.equal((await decide(OWNER, '100000000000000077')).allowed, false, 'a server the bot is not in');
    // An OWNER_IDS account that is Administrator elsewhere is an admin there, nothing more.
    const facts = await memberFacts({ guilds: { cache: new Map([[OTHER, fakeGuild(OTHER, { [OWNER]: { perms: [PermissionFlagsBits.Administrator] } })]]) } }, OWNER, OTHER, [OWNER], config, { isHome });
    assert.equal(facts.isOwnerId, false);
    assert.equal(decideAccess(facts).role, 'admin');
    // Facts include isManager (false for Administrators).
    assert.equal((await memberFacts(client, ADMIN, MAIN, [], config, { isHome })).isManager, false);
    assert.equal((await memberFacts(client, MANAGERID, MAIN, [], config, { isHome })).isManager, true);
});

test('access cache: 30 s per (user, server); forget one server or all; checkFresh always asks', async () => {
    assert.equal(ACCESS_CACHE_MS, 30_000);
    const calls = [];
    const admins = new Set([`${ADMIN}:${MAIN}`]);
    const checker = createAccessChecker({}, {
        guildId: MAIN,
        facts: async (c, userId, guildId) => { calls.push(guildId); return { inGuild: true, isAdmin: admins.has(`${userId}:${guildId}`) }; },
    });
    assert.equal((await checker.check(ADMIN, { now: 0 })).role, 'admin', 'default server');
    assert.equal((await checker.check(ADMIN, { guildId: OTHER, now: 0 })).allowed, false, 'other server: its own answer');
    assert.deepEqual(calls, [MAIN, OTHER]);
    assert.equal((await checker.check(ADMIN, { guildId: MAIN, now: 29_000 })).role, 'admin', 'cached');
    assert.equal(calls.length, 2);

    admins.add(`${ADMIN}:${OTHER}`);
    checker.forget(ADMIN, OTHER);
    assert.equal((await checker.check(ADMIN, { guildId: OTHER, now: 1000 })).role, 'admin', 'forgot only OTHER');
    await checker.check(ADMIN, { guildId: MAIN, now: 1000 });
    assert.equal(calls.length, 3, 'MAIN still cached');

    checker.forget(ADMIN);
    assert.equal(checker.size(), 0, 'forget(user) drops every server');

    await checker.check(ADMIN, { guildId: MAIN, now: 2000 });
    admins.delete(`${ADMIN}:${MAIN}`);
    assert.equal((await checker.check(ADMIN, { guildId: MAIN, now: 2001 })).role, 'admin', 'cache hit');
    assert.equal((await checker.checkFresh(ADMIN, { guildId: MAIN, now: 2002 })).allowed, false, 'a POST sees the removal at once');
    assert.equal((await checker.check(ADMIN, 2003)).allowed, false, 'the fresh answer is cached (legacy numeric now)');
});

test('access cache is bounded', async () => {
    const checker = createAccessChecker({}, { maxEntries: 3, facts: async () => ({ inGuild: true, isAdmin: true }) });
    for (let i = 0; i < 6; i += 1) await checker.check(`2000000000000000${10 + i}`, { guildId: MAIN, now: i });
    assert.equal(checker.size(), 3);
});

test('permissions: Manage Server opens settings and the Moderator pages, not moderation or staff', () => {
    const manager = decideAccess({ inGuild: true, isManager: true });
    assert.equal(manager.role, MANAGER);
    for (const key of MANAGER_PAGES) assert.equal(allows(manager, key), true, key);
    for (const key of ['settings.edit', 'session.logout', 'page:overview', 'page:users', 'page:cases', 'page:appeals', 'page:bans', 'page:nocontact', 'page:help']) {
        assert.equal(allows(manager, key), true, key);
    }
    const refused = [
        'page:inbox', 'page:staff', 'page:activity', 'page:incidents', 'page:channels', 'page:audit', 'page:backup', 'page:member-insights',
        'watchlist.view', 'watchlist.edit', 'staff.manage', 'staff.handover', 'case.searches', 'case.edit', 'case.export', 'appeal.decide',
        'action:warn', 'action:mute', 'action:kick', 'action:ban', 'member.action', 'member.timeout', 'member.roles', 'member.search', 'members.rules',
        'inbox.reply', 'inbox.close', 'permissions.fix', 'nocontact.edit', 'page:brand-new-module', null, undefined,
    ];
    for (const key of refused) assert.equal(allows(manager, key), false, String(key));
    for (const key of ['action:warn', 'member.timeout', 'settings.edit', 'watchlist.view']) assert.equal(mayRun(manager, key), false, key);
    assert.equal(allows(manager, routeKey('POST', '/welcome/save')), true, 'settings forms');
    assert.equal(allows(manager, routeKey('GET', '/owner/servers')), false);
    assert.equal(managerAllows('page:welcome'), true);
    assert.equal(levelLabel(manager), 'Manage Server');

    // Moderator + Manage Server: the moderator's keys and the manager's.
    const both = decideAccess({ inGuild: true, isModerator: true, isManager: true });
    assert.equal(allows(both, 'page:inbox'), true);
    assert.equal(allows(both, 'page:welcome'), true);
    assert.equal(allows(both, 'settings.edit'), true);
    assert.equal(allows(both, 'page:staff'), false);
    assert.equal(mayRun(both, 'action:warn'), true);
    assert.equal(mayRun(both, 'action:ban'), false);
    assert.equal(levelLabel(both), 'Moderator');

    // Plain moderators unchanged: no settings.
    const mod = decideAccess({ inGuild: true, isModerator: true });
    assert.equal(mod.role, MODERATOR);
    assert.equal(allows(mod, 'settings.edit'), false);
    assert.equal(allows(mod, 'page:welcome'), false);
});

test('enforcementData exports hasOwnerPower (Mewvo servers only)', () => {
    assert.equal(typeof defaultEnforcement.hasOwnerPower, 'function');
    assert.equal(defaultEnforcement.hasOwnerPower('200000000000000003', OTHER), false);
});

// ── the enforcement routes' owner checks use the dashboard's server ──

function handlersFor(guildId, { ownerId = '999999999999999990', overrides = {} } = {}) {
    const calls = [];
    const e = {
        isBotOwner: (id) => id === OWNER,
        getMassActionBlock: async () => ({ until: new Date(Date.now() + 60000).toISOString() }),
        clearMassActionBlock: async (g, id) => { calls.push(['clear', g, id]); },
        ...overrides,
    };
    const core = {
        client: { guilds: { cache: new Map([[guildId, { id: guildId, ownerId }]]) }, users: { cache: new Map() } },
        guildId,
        settings: { editEnabled: true },
        sessions: { setFlash: async () => {} },
        audits: { writeRows: async () => {} },
        services: {},
        enforcement: e,
        confirms: {},
        sendHtml: (res, status, body) => { res.statusCode = status; res.body = body; return res; },
        fail: (res, status, title, text) => { res.statusCode = status; res.body = `${title}: ${text}`; return res; },
        shellOf: () => ({}),
        checkPost: () => true,
        postLimiter: { allow: () => true },
        recordDashboardChange: async () => {},
        renderStaff: (req, res, status, { error }) => { res.statusCode = status; res.body = error; return res; },
    };
    return { h: createEnforcementHandlers(core), calls };
}

const reqOf = (userId, guildId) => ({
    method: 'POST', path: '/staff/blocks/lift', body: { moderator: '200000000000000042', csrf: 'x' },
    // canAct true: an Administrator, so the owner-override log is not involved here.
    dashboard: { session: { userId, username: 'u', idHash: 'h', id: 's', csrf: 'x' }, access: decideAccess({ inGuild: true, isAdmin: true }), guildId },
});
const resOf = () => ({ statusCode: 200, headers: {}, set() {}, redirect(status, location) { this.statusCode = status; this.location = location; return this; } });

test('enforcement: OWNER_IDS lift mass-action blocks only in a Mewvo server; the server owner anywhere', async () => {
    const home = handlersFor(MAIN);
    assert.equal(home.h.helpers.isOwner(reqOf(OWNER, MAIN)), true, 'OWNER_IDS at home');
    let res = await home.h.blockLift(reqOf(OWNER, MAIN), resOf());
    assert.equal(res.statusCode, 303);
    assert.deepEqual(home.calls, [['clear', MAIN, '200000000000000042']]);

    const other = handlersFor(OTHER);
    assert.equal(other.h.helpers.isOwner(reqOf(OWNER, OTHER)), false, 'OWNER_IDS elsewhere: no override');
    res = await other.h.blockLift(reqOf(OWNER, OTHER), resOf());
    assert.equal(res.statusCode, 403);
    assert.deepEqual(other.calls, [], 'nothing lifted');

    const own = handlersFor(OTHER, { ownerId: STRANGER });
    assert.equal(own.h.helpers.isOwner(reqOf(STRANGER, OTHER)), true, "that server's owner");
    res = await own.h.blockLift(reqOf(STRANGER, OTHER), resOf());
    assert.equal(res.statusCode, 303);

    // An injected hasOwnerPower wins over isBotOwner (enforcementData's default).
    const injected = handlersFor(OTHER, { overrides: { hasOwnerPower: (u, g) => u === OWNER && g === OTHER } });
    assert.equal(injected.h.helpers.isOwner(reqOf(OWNER, OTHER)), true);
});
