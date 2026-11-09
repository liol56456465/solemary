// Enforcement checks and access (owner decision D1; audit 1.3, 1.4, 3.5, 3.6, 3.10):
//   - the access matrix: home servers stay Administrator-only; in another server the configured
//     Moderator role may Warn / Mute / Kick / Unmute / Remove warn, never Ban / Unban; re-checked
//     on every panel interaction
//   - Mewvo's own permissions are checked per action (a warn needs none), before any form
//   - a ban/kick DM is never sent when Mewvo cannot act; Discord's 50013 → what to fix
//   - the early role-order check (read-only panel)
//   - the mass-action guard: undo always works, the limit−1 heads-up, "alerted" only when a DM went out
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000777';
const SERVER_OWNER = '199999999999999992';
const MODERATOR = '500000000000000001';
const TARGET = '500000000000000002';
const BOT_ID = '900000000000000001';
const MOD_ROLE = '600000000000000010';

Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT });

const { pgDb } = await import('../src/utils/postgresDatabase.js');
const { db: kv } = await import('../src/utils/database/wrapper.js');
const { resetSettingsCacheForTests, setSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
const { botText } = await import('../src/utils/botText.js');
const { checkCommandAccess } = await import('../src/utils/commandGate.js');
const { MODERATOR_PANEL_COMMANDS } = await import('../src/config/commands/commandAccess.js');
const access = await import('../src/services/enforcement/panelAccess.js');
const enf = await import('../src/services/enforcement/enforcementService.js');
const { handleEnforcementButton, readOnlyIfUntargetable } = await import('../src/handlers/enforcementPanel.js');
const { createFlow } = await import('../src/services/enforcement/panelState.js');
const guardMod = await import('../src/services/enforcement/massActionGuard.js');
const { ModerationService } = await import('../src/services/moderation/moderationService.js');

const en = botText('en');

afterEach(() => {
    resetSettingsCacheForTests();
    delete kv.get;
    delete kv.set;
});

/** Permissions: Administrator when `admin`; `bits` the flags the member has otherwise. */
function perms({ admin = false, bits = [] } = {}) {
    return { has: (flag) => (admin && (flag === PermissionFlagsBits.Administrator || Array.isArray(flag))) || bits.includes(flag) };
}

function role(id, position, name = `role${position}`) {
    return { id, position, name };
}

function member(id, { admin = false, roleIds = [], top = 1, guild = null, bits = [] } = {}) {
    const highest = role(`r${top}`, top);
    const cache = new Map([[highest.id, highest], ...roleIds.map((r) => [r, role(r, 2)])]);
    return { id, guild, user: { id, username: `u${id.slice(-2)}` }, permissions: perms({ admin, bits }), roles: { highest, cache } };
}

/** A client whose guild config holds `modRole` (the real readGuildConfig path, its own cache). */
function clientWithConfig(config = { modRole: MOD_ROLE }, { fail = false, slowMs = 0 } = {}) {
    return {
        db: {
            get: async () => {
                if (slowMs) await new Promise((resolve) => setTimeout(resolve, slowMs));
                if (fail) throw new Error('database down');
                return config;
            },
        },
    };
}

/** A fake pg pool; `answer(sql, params)` returns rows. */
async function withPool(answer, fn) {
    const saved = { pool: pgDb.pool, isConnected: pgDb.isConnected };
    const run = async (sql, params = []) => ({ rows: (await answer(String(sql), params)) || [], rowCount: 1 });
    pgDb.pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    pgDb.isConnected = true;
    try {
        return await fn();
    } finally {
        pgDb.pool = saved.pool;
        pgDb.isConnected = saved.isConnected;
    }
}

// ── The access matrix ─────────────────────────────────────────────────────

test('access: Administrator everywhere; Moderator role only outside home servers and only for the five actions', async () => {
    const client = clientWithConfig();
    const admin = member(MODERATOR, { admin: true });
    const mod = member(MODERATOR, { roleIds: [MOD_ROLE] });
    const plain = member(MODERATOR);

    for (const gid of [MAIN, SUPPORT, OTHER]) {
        const a = await access.panelAccessFor(admin, gid, { client });
        assert.equal(a.level, 'admin', gid);
        assert.deepEqual([...a.actions].sort(), ['ban', 'kick', 'mute', 'removewarn', 'unban', 'unmute', 'warn']);
    }
    for (const gid of [MAIN, SUPPORT]) {
        assert.equal((await access.panelAccessFor(mod, gid, { client })).level, null, `${gid}: home stays Administrator-only`);
    }
    const other = await access.panelAccessFor(mod, OTHER, { client });
    assert.equal(other.level, 'moderator');
    assert.equal(other.roleId, MOD_ROLE);
    for (const action of ['warn', 'mute', 'kick', 'unmute', 'removewarn']) assert.ok(access.panelActionAllowed(other, action), action);
    for (const action of ['ban', 'unban']) assert.equal(access.panelActionAllowed(other, action), false, action);
    assert.deepEqual(access.staffRoleFor(other), { roleId: MOD_ROLE, actions: ['warn', 'mute', 'kick', 'unmute', 'removewarn'] });
    assert.equal((await access.panelAccessFor(plain, OTHER, { client })).level, null, 'no role, no panel');
    assert.equal((await access.panelAccessFor(mod, OTHER, { client: clientWithConfig({ modRole: null }) })).level, null, 'no role configured');
});

test('access: a failed or slow config read refuses with its own message (fail closed, within the 3 s window)', async () => {
    const mod = member(MODERATOR, { roleIds: [MOD_ROLE] });
    const failed = await access.panelAccessFor(mod, OTHER, { client: clientWithConfig(undefined, { fail: true }) });
    assert.deepEqual([failed.level, failed.reason], [null, 'unavailable']);
    const started = Date.now();
    const slow = await access.panelAccessFor(mod, OTHER, { client: clientWithConfig(undefined, { slowMs: 500 }), budgetMs: 50 });
    assert.equal(slow.reason, 'unavailable');
    assert.ok(Date.now() - started < 400, 'gave up at the budget');
    assert.equal(access.refusalKey(failed, OTHER), 'staff.enforcements.accessUnavailable');
    assert.equal(access.refusalKey({ level: null }, MAIN), 'staff.enforcements.noAdmin');
    assert.equal(access.refusalKey({ level: null }, OTHER), 'staff.enforcements.noAdminOrMod');
    assert.equal(access.refusalKey({ level: null }, OTHER, { forWarn: true }), 'staff.warnmessage.noAdminOrMod');
    assert.equal(access.refusalKey({ level: null }, OTHER, { closed: true }), 'errors.panel.noAccess');
});

test('gate: the three panel entry points pass to their own role check in other servers only; others stay Administrator', () => {
    assert.deepEqual([...MODERATOR_PANEL_COMMANDS].sort(), ['Moderate', 'Warn for this message', 'enforcements']);
    const ask = (gid, key) => checkCommandAccess({ command: {}, accessKey: key, guild: { id: gid, ownerId: SERVER_OWNER }, userId: MODERATOR, permissions: perms() });
    for (const key of MODERATOR_PANEL_COMMANDS) {
        assert.deepEqual(ask(OTHER, key), { allowed: true, moderatorCheck: true }, key);
        assert.equal(ask(MAIN, key).allowed, false, `${key} at home`);
        assert.equal(ask(SUPPORT, key).allowed, false, `${key} in support`);
    }
    for (const key of ['case edit', 'automod panic', 'staff restore', 'setappeal', 'appeals', 'background']) {
        assert.equal(ask(OTHER, key).allowed, false, `${key} stays Administrator`);
    }
});

// ── The panel guard, re-checked on every interaction ──────────────────────

function panelClick(guildId, memberObj, { client = clientWithConfig(), me = member(BOT_ID, { top: 50, bits: Object.values(PermissionFlagsBits) }) } = {}) {
    const replies = [];
    const updates = [];
    const edits = [];
    const guild = { id: guildId, ownerId: SERVER_OWNER, members: { me }, client: { user: { id: BOT_ID } } };
    memberObj.guild = guild;
    const interaction = {
        id: `i${Math.random()}`,
        user: { id: memberObj.id, username: 'mod' },
        guildId,
        guild,
        client: { ...client, users: { fetch: async (id) => ({ id, username: 'target' }), cache: new Map() } },
        inGuild: () => true,
        member: memberObj,
        locale: 'en-US',
        deferred: false,
        replied: false,
        isRepliable: () => true,
        update: async (payload) => { updates.push(payload); },
        reply: async (payload) => { interaction.replied = true; replies.push(payload); },
        followUp: async (payload) => { replies.push(payload); },
        deferUpdate: async () => { interaction.deferred = true; },
        editReply: async (payload) => { edits.push(payload); },
    };
    return { interaction, replies, updates, edits };
}

const textOf = (payload) => JSON.stringify(payload);

test('panel: a moderator in another server may cancel and start a warn; ban/unban are refused naming Administrator', async () => {
    const mod = member(MODERATOR, { roleIds: [MOD_ROLE] });
    const cancel = panelClick(OTHER, mod);
    await handleEnforcementButton(cancel.interaction, {}, ['cancel', MODERATOR, 'nonce']);
    assert.equal(cancel.updates.length, 1, 'cancel went through');

    const warn = panelClick(OTHER, member(MODERATOR, { roleIds: [MOD_ROLE] }));
    await handleEnforcementButton(warn.interaction, {}, ['act', MODERATOR, TARGET, 'warn']);
    assert.equal(warn.replies.length, 0, 'no refusal');
    assert.equal(warn.edits.length, 1, 'the reason step opened');
    assert.match(textOf(warn.edits[0]), /enfsel:reason/);

    for (const action of ['ban', 'unban']) {
        const click = panelClick(OTHER, member(MODERATOR, { roleIds: [MOD_ROLE] }));
        await handleEnforcementButton(click.interaction, {}, ['act', MODERATOR, TARGET, action]);
        assert.equal(click.edits.length, 0, `${action}: nothing opened`);
        assert.match(textOf(click.replies), /needs the Administrator permission/, action);
    }
});

test('panel: the same moderator in a home server is refused; losing the role closes the panel on the next click', async () => {
    const home = panelClick(MAIN, member(MODERATOR, { roleIds: [MOD_ROLE] }));
    await handleEnforcementButton(home.interaction, {}, ['cancel', MODERATOR, 'nonce']);
    assert.equal(home.updates.length, 0);
    assert.match(textOf(home.replies), /no longer have the Administrator permission/);

    // A flow opened while they had the role; the confirm click comes after it was removed.
    const nonce = createFlow({ type: 'warn', moderatorId: MODERATOR, targetId: TARGET, targetUsername: 'target' });
    const lost = panelClick(OTHER, member(MODERATOR));
    await handleEnforcementButton(lost.interaction, {}, ['confirm', MODERATOR, nonce]);
    assert.equal(lost.edits.length, 0, 'nothing executed');
    assert.match(textOf(lost.replies), /or the Moderator role, so this panel is closed/);
});

test('panel: a confirm for a ban flow by a moderator is refused before anything runs (the flow type is re-checked)', async () => {
    const nonce = createFlow({ type: 'ban', moderatorId: MODERATOR, targetId: TARGET, targetUsername: 'target' });
    const click = panelClick(OTHER, member(MODERATOR, { roleIds: [MOD_ROLE] }));
    await handleEnforcementButton(click.interaction, {}, ['confirm', MODERATOR, nonce]);
    assert.equal(click.edits.length, 0);
    assert.match(textOf(click.replies), /\*\*Ban\*\* needs the Administrator permission/);
});

test('panel: Mewvo\'s missing permission for the clicked action is reported before the form (a warn needs none)', async () => {
    const bare = member(BOT_ID, { top: 50 });
    const mute = panelClick(OTHER, member(MODERATOR, { admin: true }), { me: bare });
    await handleEnforcementButton(mute.interaction, {}, ['act', MODERATOR, TARGET, 'mute']);
    assert.equal(mute.edits.length, 0, 'no reason form');
    assert.match(textOf(mute.replies), /Manage Roles, Manage Channels/);

    const warn = panelClick(OTHER, member(MODERATOR, { admin: true }), { me: member(BOT_ID, { top: 50 }) });
    await handleEnforcementButton(warn.interaction, {}, ['act', MODERATOR, TARGET, 'warn']);
    assert.equal(warn.replies.length, 0);
    assert.equal(warn.edits.length, 1, 'the warn reason step opened without any permission');
});

test('executeAction: the Moderator role passes only for its actions and only while held', async () => {
    const guild = { id: OTHER, ownerId: SERVER_OWNER, members: { me: member(BOT_ID, { top: 50, bits: Object.values(PermissionFlagsBits) }) } };
    const staffRole = { roleId: MOD_ROLE, actions: [...access.MODERATOR_PANEL_ACTIONS] };
    const target = { id: TARGET, username: 'target' };
    await assert.rejects(enf.executeAction({ guild, moderator: member(MODERATOR), targetUser: target, flow: { type: 'warn' }, staffRole }),
        (error) => /Only server admins/.test(error.userMessage), 'role removed: refused');
    await assert.rejects(enf.executeAction({ guild, moderator: member(MODERATOR, { roleIds: [MOD_ROLE] }), targetUser: target, flow: { type: 'ban' }, staffRole }),
        (error) => /Only server admins/.test(error.userMessage), 'ban is not a moderator action');
    await assert.rejects(enf.executeAction({ guild, moderator: member(MODERATOR, { roleIds: [MOD_ROLE] }), targetUser: target, flow: { type: 'unban' }, staffRole }),
        (error) => /Only server admins/.test(error.userMessage), 'unban is not a moderator action');
});

// ── Per-action bot permissions (3.6) ──────────────────────────────────────

test('bot permissions: each action checks only what it needs', () => {
    const guildWith = (...flags) => ({ members: { me: { permissions: perms({ bits: flags.map((f) => PermissionFlagsBits[f]) }) } } });
    const none = guildWith();
    for (const action of ['warn', 'removewarn']) assert.doesNotThrow(() => enf.assertBotPermissions(none, action), action);
    assert.throws(() => enf.assertBotPermissions(none, 'mute'), (e) => /Manage Roles, Manage Channels/.test(e.userMessage));
    assert.doesNotThrow(() => enf.assertBotPermissions(guildWith('ManageRoles', 'ManageChannels'), 'mute'));
    assert.doesNotThrow(() => enf.assertBotPermissions(guildWith('ManageRoles'), 'unmute'));
    assert.throws(() => enf.assertBotPermissions(guildWith('KickMembers'), 'kick'), (e) => /Create Invite/.test(e.userMessage) && !/Kick Members/.test(e.userMessage));
    assert.doesNotThrow(() => enf.assertBotPermissions(guildWith('KickMembers', 'CreateInstantInvite'), 'kick'));
    assert.throws(() => enf.assertBotPermissions(guildWith('KickMembers', 'ManageRoles'), 'ban'), (e) => /\*\*Ban Members\*\*/.test(e.userMessage));
    assert.doesNotThrow(() => enf.assertBotPermissions(guildWith('BanMembers'), 'unban'));
    // Translated: German permission names.
    assert.throws(() => enf.assertBotPermissions(none, 'ban', { lang: 'de' }), (e) => /Mitglieder bannen/.test(e.userMessage));
});

// ── The ban/kick DM only when Mewvo can act (1.3) and 50013 (3.10) ───────

function actionWorld({ botBits = Object.values(PermissionFlagsBits), bannable = true, kickable = true } = {}) {
    const dms = [];
    const banned = [];
    const guild = {
        id: OTHER, name: 'Other', ownerId: SERVER_OWNER,
        client: { user: { id: BOT_ID, username: 'Mewvo' }, guilds: { cache: new Map() } },
        bans: { fetch: async () => { throw Object.assign(new Error('Unknown Ban'), { code: 10026 }); } },
    };
    const me = member(BOT_ID, { top: 50, bits: botBits, guild });
    const targetMember = { ...member(TARGET, { top: 1, guild }), bannable, kickable, kick: async () => { banned.push('kick'); } };
    guild.members = {
        me,
        fetch: async (id) => (id === TARGET ? targetMember : null),
        ban: async () => { banned.push('ban'); },
    };
    const targetUser = { id: TARGET, username: 'target', send: async (msg) => { dms.push(msg); return {}; } };
    const moderator = member(MODERATOR, { admin: true, top: 20, guild });
    return { guild, moderator, targetUser, dms, banned };
}

test('ban/kick: Mewvo below the member → refused before the case and before any DM, with the role to move', async () => {
    emptyKv();
    setSettingsCacheForTests(OTHER, {});
    const queries = [];
    await withPool((sql) => { queries.push(sql); return /COUNT\(\*\)/.test(sql) ? [{ n: 0 }] : []; }, async () => {
        for (const type of ['ban', 'kick']) {
            const w = actionWorld({ bannable: false, kickable: false });
            await assert.rejects(enf.executeAction({ guild: w.guild, moderator: w.moderator, targetUser: w.targetUser, flow: { type, reason: 'r', name: 'n' } }),
                (error) => error.userMessage.includes("move Mewvo's role above **role1**") && /Nothing was sent to the member/.test(error.userMessage), type);
            assert.deepEqual(w.dms, [], `${type}: no DM`);
            assert.deepEqual(w.banned, [], `${type}: nothing done`);
        }
    });
    assert.ok(!queries.some((sql) => /INSERT INTO/i.test(sql)), 'no case was written');
});

test('ban without Ban Members: refused before any DM with "Give Mewvo the Ban Members permission"', async () => {
    const w = actionWorld({ botBits: [PermissionFlagsBits.KickMembers] });
    await assert.rejects(enf.executeAction({ guild: w.guild, moderator: w.moderator, targetUser: w.targetUser, flow: { type: 'ban' } }),
        (error) => /\*\*Ban Members\*\*/.test(error.userMessage));
    assert.deepEqual(w.dms, []);
    assert.throws(() => enf.assertBotCanRemove({ members: { me: { permissions: perms() } } }, 'ban', null),
        (e) => e.userMessage.startsWith('Give Mewvo the **Ban Members** permission'));
    assert.throws(() => enf.assertBotCanRemove({ members: { me: { permissions: perms() } } }, 'kick', null, { lang: 'pl' }),
        (e) => /Wyrzucanie członków/.test(e.userMessage));
});

test('50013 Missing Permissions → what to fix (permission + role), translated; other errors keep Discord\'s text', () => {
    const missing = Object.assign(new Error('Missing Permissions'), { code: enf.MISSING_PERMISSIONS });
    assert.equal(enf.MISSING_PERMISSIONS, 50013);
    const ban = enf.refusalMessage('ban', missing, { role: 'Mods' });
    assert.match(ban, /Give Mewvo the \*\*Ban Members\*\* permission and move Mewvo's role above \*\*Mods\*\*/);
    assert.match(enf.refusalMessage('kick', missing), /\*\*Kick Members\*\*/);
    assert.match(enf.refusalMessage('mute', missing), /\*\*Manage Roles\*\*/);
    assert.match(enf.refusalMessage('unban', missing, { lang: 'fr' }), /Bannir des membres/);
    assert.equal(enf.refusalMessage('ban', new Error('Unknown User')), 'Discord refused the ban: Unknown User');
    assert.equal(enf.refusalMessage('mute', new Error('x')), 'Could not add the muted role: x');
});

test('warn that would ladder-ban while Mewvo cannot ban: refused, rolled back, nothing recorded or sent', async () => {
    emptyKv();
    setSettingsCacheForTests(OTHER, {});
    const queries = [];
    const w = actionWorld({ botBits: [], bannable: false });
    await withPool((sql) => {
        queries.push(sql);
        if (/COUNT\(\*\)/.test(sql)) return [{ n: 0 }];
        if (/SELECT level, warns_since_level/.test(sql)) return [{ level: 0, warns_since_level: 2 }];
        return [];
    }, async () => {
        await assert.rejects(enf.executeAction({ guild: w.guild, moderator: w.moderator, targetUser: w.targetUser, flow: { type: 'warn', reason: 'r', name: 'n' } }),
            (error) => /Ban Members/.test(error.userMessage));
    });
    assert.ok(!queries.some((sql) => /INSERT INTO mod_cases|INSERT INTO .*cases/i.test(sql)), 'no case inserted');
    assert.ok(queries.some((sql) => /ROLLBACK/i.test(sql)), 'the transaction rolled back');
    assert.deepEqual(w.dms, []);
});

// ── Early role-order check (3.5) and translated hierarchy texts ───────────

test('early check: a member at or above the moderator makes the panel read-only before any form', async () => {
    const guild = { id: OTHER, ownerId: SERVER_OWNER, client: { user: { id: BOT_ID } } };
    guild.members = { me: member(BOT_ID, { top: 50, guild }) };
    const moderator = member(MODERATOR, { top: 10, guild });
    const higher = member(TARGET, { top: 20, guild });
    const panel = { embeds: ['e'], components: ['buttons'] };
    await readOnlyIfUntargetable(panel, { guild, moderator, targetUser: { id: TARGET }, targetMember: higher });
    assert.deepEqual(panel.components, []);
    assert.match(panel.content, /You cannot act on .*equal to or above yours.*The panel is read-only\./s);

    const lower = member(TARGET, { top: 2, guild });
    const fine = { embeds: ['e'], components: ['buttons'] };
    await readOnlyIfUntargetable(fine, { guild, moderator, targetUser: { id: TARGET }, targetMember: lower });
    assert.deepEqual(fine.components, ['buttons']);
    assert.equal(fine.content, undefined);

    const self = { components: ['b'] };
    await readOnlyIfUntargetable(self, { guild, moderator, targetUser: { id: MODERATOR }, targetMember: null, lang: 'de' });
    assert.match(self.content, /bei dir selbst/);
});

test('hierarchy texts: action-neutral and translated; Mewvo too low says to move its role', () => {
    const guild = { ownerId: SERVER_OWNER };
    const me = { roles: { highest: role('b', 5, 'Mewvo') } };
    guild.members = { me };
    const target = { guild, user: { tag: 'kit' }, roles: { highest: role('t', 9, 'Admins') } };
    assert.throws(() => ModerationService.assertModerationHierarchy({ id: MODERATOR, guild, roles: { highest: role('m', 20, 'Mods') } }, target, 'ban'),
        (e) => e.userMessage.includes("move Mewvo's role above **Admins**") && e.context?.expected === true);
    assert.throws(() => ModerationService.assertModerationHierarchy({ id: MODERATOR, guild, roles: { highest: role('m', 20, 'Mods') } }, target, 'ban', { lang: 'es' }),
        (e) => /mueve el rol de Mewvo por encima de \*\*Admins\*\*/.test(e.userMessage));
});

// ── Mass-action guard (1.4) ───────────────────────────────────────────────

/** The key/value store in memory (`stored` preloaded); writes are recorded and read back. */
function emptyKv(stored = null) {
    const writes = [];
    const data = new Map(Object.entries(stored || {}));
    kv.get = async (key, fallback = null) => (data.has(key) ? data.get(key) : fallback);
    kv.set = async (key, value) => { writes.push({ key, value }); data.set(key, value); return true; };
    writes.data = data;
    return writes;
}

function guardWorld(guildId, { sendFails = false } = {}) {
    const dms = [];
    const client = {
        guilds: { cache: new Map() },
        channels: { cache: new Map() },
        users: { fetch: async (id) => ({ send: async (msg) => { if (sendFails) throw new Error('Cannot send messages to this user'); dms.push({ id, msg }); } }) },
    };
    return { dms, guild: { id: guildId, name: 'Some server', ownerId: SERVER_OWNER, client } };
}

test('guard: Unban and Unmute always pass, also while blocked (nothing is even read)', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    emptyKv({ [`enforcement:massguard:${OTHER}:${MODERATOR}`]: { until, count: 5, attempted: 'ban', alerted: 'owner' } });
    setSettingsCacheForTests(OTHER, {});
    const { guild } = guardWorld(OTHER);
    for (const type of ['unban', 'unmute']) {
        assert.equal(await guardMod.enforceMassActionGuard(guild, { id: MODERATOR }, type), undefined, type);
    }
    await assert.rejects(guardMod.enforceMassActionGuard(guild, { id: MODERATOR }, 'warn'), (e) => e.type === 'permission', 'other actions stay blocked');
});

test('guard: the action that reaches the limit gets the "1 more … pauses your panel" heads-up', async () => {
    emptyKv();
    setSettingsCacheForTests(OTHER, { massActionLimit: 5, massMuteLimit: 10 });
    const { guild } = guardWorld(OTHER);
    let n = 4;
    await withPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ n }] : []), async () => {
        const last = await guardMod.enforceMassActionGuard(guild, { id: MODERATOR }, 'kick');
        assert.match(last.warning, /^Heads-up: 1 more ban or kick within 10 minutes pauses your panel for 60 minutes\.$/);
        n = 3;
        assert.equal(await guardMod.enforceMassActionGuard(guild, { id: MODERATOR }, 'ban'), undefined, 'two left: no heads-up');
        n = 9;
        assert.match((await guardMod.enforceMassActionGuard(guild, { id: MODERATOR }, 'mute', { lang: 'de' })).warning, /Noch 1 Stummschaltung/);
    });
});

test('guard: "alerted" only when a DM was delivered; the server owner tripping it gets no "owner was alerted"; /staff restore named', async () => {
    setSettingsCacheForTests(OTHER, { massActionLimit: 2 });
    // The server owner trips it: nobody to DM.
    let writes = emptyKv();
    let world = guardWorld(OTHER);
    await withPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ n: 2 }] : []), async () => {
        await assert.rejects(guardMod.enforceMassActionGuard(world.guild, { id: SERVER_OWNER, user: { username: 'owner' } }, 'ban'),
            (e) => !/alerted/.test(e.userMessage) && /An administrator can lift it early with `\/staff restore`\./.test(e.userMessage));
    });
    assert.deepEqual(world.dms, []);
    assert.ok(writes.every((w) => w.value.alerted === undefined), 'no alert recorded');

    // A moderator trips it but the owner's DMs are closed.
    writes = emptyKv();
    world = guardWorld(OTHER, { sendFails: true });
    await withPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ n: 2 }] : []), async () => {
        await assert.rejects(guardMod.enforceMassActionGuard(world.guild, { id: MODERATOR, user: { username: 'mod' } }, 'ban'),
            (e) => !/alerted/.test(e.userMessage));
    });

    // Delivered: said, and stored for the later refusals.
    writes = emptyKv();
    world = guardWorld(OTHER);
    await withPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ n: 2 }] : []), async () => {
        await assert.rejects(guardMod.enforceMassActionGuard(world.guild, { id: MODERATOR, user: { username: 'mod' } }, 'ban'),
            (e) => /The server owner was alerted\. An administrator can lift it early/.test(e.userMessage));
    });
    assert.equal(world.dms.length, 1);
    assert.equal(writes.at(-1).value.alerted, 'owner');

    // /staff restore while the DMs were going out: the alert note does not bring the block back.
    writes = emptyKv();
    world = guardWorld(OTHER);
    world.guild.client.users.fetch = async (id) => ({ send: async (msg) => { writes.data.clear(); world.dms.push({ id, msg }); } });
    await withPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ n: 2 }] : []), async () => {
        await assert.rejects(guardMod.enforceMassActionGuard(world.guild, { id: MODERATOR, user: { username: 'mod' } }, 'ban'));
    });
    assert.equal(writes.data.size, 0, 'the lifted block stays lifted');

    // A stored block without the field (older) never claims an alert; home servers name the owner.
    const block = { until: new Date(Date.now() + 60_000).toISOString(), count: 5, attempted: 'ban' };
    assert.ok(!/alerted/.test(guardMod.blockedError(block, OTHER).userMessage));
    assert.match(guardMod.blockedError({ ...block, alerted: 'owners' }, MAIN).userMessage, /The bot owners were alerted\. The server owner can lift it early with `\/staff restore`\./);
});

// ── Texts ─────────────────────────────────────────────────────────────────

test('texts: no "main server" wording in the new keys; every new key in all 8 languages (parity is the global catalog test)', () => {
    const keys = [
        'staff.enforcements.noAdminOrMod', 'staff.enforcements.modNotAllowed', 'staff.enforcements.accessUnavailable',
        'staff.warnmessage.noAdminOrMod', 'errors.panel.noAccess', 'staff.enfCheck.cannotBanRole', 'staff.enfCheck.refusedMissingRole',
        'staff.staff.massGuard.lastOneBans', 'staff.staff.massGuard.liftOther', 'staff.enfCheck.note.ladderBan',
    ];
    for (const lang of ['en', 'de', 'ru', 'fr', 'it', 'pl', 'es', 'pt-BR']) {
        const tr = botText(lang);
        for (const key of keys) assert.ok(tr.has(key), `${lang}: ${key}`);
    }
    for (const key of keys) assert.ok(!/main server/i.test(en.t(key, { action: 'Ban', role: 'r', permission: 'p', minutes: 1, block: 1, length: '1 day', code: 'c', stage: 's' })), key);
});
