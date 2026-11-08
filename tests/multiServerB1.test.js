// Multi-server B1: moderation, appeals, staff reports and modmail work in every server.
// Each test uses a server that is not one of Mewvo's (OTHER) and checks that Mewvo's own
// servers (MAIN, SUPPORT) behave as before: the enforcement panel,
// the expiry cron, the mass-action alert, the OWNER_IDS override, staff reports and the
// modmail "which server?" choice.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000777';
const OTHER_2 = '100000000000000778';
const OTHER_3 = '100000000000000779';
const OWNER_ID = '199999999999999991'; // in OWNER_IDS
const SERVER_OWNER = '199999999999999992'; // OTHER's guild.ownerId
const MODERATOR = '500000000000000001';
const CATEGORY = '600000000000000001';

Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, MASS_ACTION_LIMIT: '2', MASS_MUTE_LIMIT: '2' });

const { pgDb } = await import('../src/utils/postgresDatabase.js');
const { db: kv } = await import('../src/utils/database/wrapper.js');
const { botConfig } = await import('../src/config/bot.js');
const { enforcementConfig } = await import('../src/config/enforcement.js');
const { resetSettingsCacheForTests, setSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
const { handleEnforcementButton } = await import('../src/handlers/enforcementPanel.js');
const { runEnforcementExpiry } = await import('../src/services/enforcement/expiryService.js');
const { enforceMassActionGuard, massAlertRecipients } = await import('../src/services/enforcement/massActionGuard.js');
const { hasOwnerPower } = await import('../src/utils/ownerPower.js');
const { checkCommandAccess, canSeeAdminCommands } = await import('../src/utils/commandGate.js');
const { checkAppealReviewer } = await import('../src/services/enforcement/appealReviewer.js');
const { isOwner: isStaffOwner } = await import('../src/commands/Enforcement/staff.js');
const { REPORTS_NOT_SET_UP, reportGuildId, submitStaffReport } = await import('../src/services/enforcement/appealService.js');
const { panelServer } = await import('../src/handlers/appealsHandler.js');
const modmail = await import('../src/services/modmailService.js');
const { openFromPrompt } = await import('../src/handlers/modmailButtons.js');

const savedOwners = botConfig.commands.owners;
botConfig.commands.owners = [OWNER_ID];
process.on('exit', () => { botConfig.commands.owners = savedOwners; });

afterEach(() => {
    resetSettingsCacheForTests();
    delete kv.get;
    delete kv.set;
});

/** A fake pg pool; `answer(sql, params)` returns rows, every query is recorded. */
async function withPool(answer, fn) {
    const queries = [];
    const saved = { pool: pgDb.pool, isConnected: pgDb.isConnected };
    const run = async (sql, params = []) => {
        queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return { rows: (await answer(String(sql), params)) || [], rowCount: 1 };
    };
    pgDb.pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    pgDb.isConnected = true;
    try {
        return await fn(queries);
    } finally {
        pgDb.pool = saved.pool;
        pgDb.isConnected = saved.isConnected;
    }
}

/** The key/value store: nothing stored, writes recorded. */
function emptyKv() {
    const writes = [];
    kv.get = async (key, fallback = null) => fallback;
    kv.set = async (key, value) => { writes.push({ key, value }); return true; };
    return writes;
}

const perms = (admin) => ({ has: (flag) => admin && (flag === PermissionFlagsBits.Administrator || Array.isArray(flag)) });

// ── Enforcement panel ─────────────────────────────────────────────────────

function panelClick(guildId, { admin = true } = {}) {
    const updates = [];
    const replies = [];
    const interaction = {
        user: { id: MODERATOR },
        guildId,
        inGuild: () => Boolean(guildId),
        member: { id: MODERATOR, guild: { ownerId: SERVER_OWNER }, permissions: perms(admin) },
        update: async (payload) => { updates.push(payload); },
        reply: async (payload) => { replies.push(payload); },
        followUp: async (payload) => { replies.push(payload); },
        isRepliable: () => true,
        deferred: false,
        replied: false,
    };
    return { interaction, updates, replies };
}

test('panel: an administrator of another server can use the /enforcements panel there (no main-server guard)', async () => {
    for (const guildId of [OTHER, MAIN]) {
        const { interaction, updates } = panelClick(guildId);
        await handleEnforcementButton(interaction, {}, ['cancel', MODERATOR, 'nonce']);
        assert.equal(updates.length, 1, `${guildId}: the click went through`);
        assert.equal(updates[0].embeds[0].data.title, 'Cancelled');
    }
});

test('panel: still refused for a non-administrator in another server and outside a server', async () => {
    const nonAdmin = panelClick(OTHER, { admin: false });
    await handleEnforcementButton(nonAdmin.interaction, {}, ['cancel', MODERATOR, 'nonce']);
    assert.equal(nonAdmin.updates.length, 0);
    const dm = panelClick(null);
    await handleEnforcementButton(dm.interaction, {}, ['cancel', MODERATOR, 'nonce']);
    assert.equal(dm.updates.length, 0);
});

// ── Expiry cron ───────────────────────────────────────────────────────────

test('expiry: a temporary ban of another server is lifted in that server; the Support banned role is not touched', async () => {
    emptyKv();
    setSettingsCacheForTests(OTHER, {});
    const unbanned = [];
    const otherGuild = { id: OTHER, name: 'Other', members: { unban: async (id) => { unbanned.push([OTHER, id]); } }, channels: { cache: new Map() } };
    const supportTouched = [];
    const client = {
        isReady: () => true,
        user: { id: '900000000000000001', username: 'Mewvo' },
        guilds: { cache: new Map([[OTHER, otherGuild]]) },
        users: { fetch: async () => ({ send: async () => ({}) }) },
        channels: { cache: new Map() },
        db: { get: async () => null },
    };
    // A support guild lookup would show up here.
    client.guilds.cache.get = new Proxy(Map.prototype.get, {
        apply(target, thisArg, args) {
            if (args[0] === SUPPORT) supportTouched.push(args[0]);
            return Reflect.apply(target, client.guilds.cache, args);
        },
    });
    const row = {
        id: 1, guild_id: OTHER, case_code: 'abc2345', type: 'ban', target_user_id: '500000000000000009',
        target_username: 'kit', is_test: false, expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 86_400_000),
    };
    await withPool((sql) => (/SELECT \* FROM/.test(sql) && /expires_at <= NOW\(\)/.test(sql) ? [row] : []), async (queries) => {
        await runEnforcementExpiry(client);
        assert.deepEqual(unbanned, [[OTHER, row.target_user_id]], 'unbanned in its own server');
        assert.ok(queries.some((q) => /SET status = \$2/.test(q.sql) && q.params[0] === 1), 'the case was closed');
    });
    assert.deepEqual(supportTouched, [], 'the Support server\'s banned role is home-only');
});

// ── Mass-action guard ─────────────────────────────────────────────────────

test('mass-action alert: another server DMs its owner, not OWNER_IDS; home servers keep OWNER_IDS', () => {
    const owners = [OWNER_ID];
    assert.deepEqual(massAlertRecipients({ id: OTHER, ownerId: SERVER_OWNER }, MODERATOR, { owners }), [SERVER_OWNER]);
    assert.deepEqual(massAlertRecipients({ id: MAIN, ownerId: SERVER_OWNER }, MODERATOR, { owners }), [OWNER_ID]);
    assert.deepEqual(massAlertRecipients({ id: SUPPORT, ownerId: SERVER_OWNER }, MODERATOR, { owners }), [OWNER_ID]);
    assert.deepEqual(massAlertRecipients({ id: OTHER, ownerId: SERVER_OWNER }, SERVER_OWNER, { owners }), [], 'the owner tripped it: the refusal tells them');
    assert.deepEqual(massAlertRecipients({ id: OTHER, ownerId: null }, MODERATOR, { owners }), []);
});

function guardWorld(guildId) {
    const dms = [];
    const client = {
        guilds: { cache: new Map() },
        channels: { cache: new Map() },
        users: { fetch: async (id) => ({ send: async (msg) => { dms.push({ id, msg }); } }) },
    };
    return { dms, guild: { id: guildId, name: 'Some server', ownerId: SERVER_OWNER, client } };
}

test('mass-action guard: in another server OWNER_IDS are not exempt and the server owner gets the DM', async () => {
    const writes = emptyKv();
    setSettingsCacheForTests(OTHER, { massActionLimit: 2 });
    const { dms, guild } = guardWorld(OTHER);
    await withPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ n: 2 }] : []), async () => {
        await assert.rejects(enforceMassActionGuard(guild, { id: OWNER_ID, user: { username: 'owner' } }, 'ban'),
            (error) => error.type === 'permission' && /The server owner was alerted/.test(error.userMessage));
    });
    assert.ok(writes.some((w) => w.key === `enforcement:massguard:${OTHER}:${OWNER_ID}`), 'the bot owner is blocked like anyone else there');
    assert.deepEqual(dms.map((d) => d.id), [SERVER_OWNER], 'only the server owner, never OWNER_IDS');
    assert.match(dms[0].msg.content, /Some server/);
});

test('mass-action guard: in the main server OWNER_IDS stay exempt and others alert OWNER_IDS (unchanged)', async () => {
    emptyKv();
    const { dms, guild } = guardWorld(MAIN);
    await withPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ n: 99 }] : []), async (queries) => {
        await enforceMassActionGuard(guild, { id: OWNER_ID }, 'ban');
        assert.equal(queries.length, 0, 'OWNER_IDS are not even counted at home');
        await assert.rejects(enforceMassActionGuard(guild, { id: MODERATOR, user: { username: 'mod' } }, 'ban'),
            (error) => /The bot owners were alerted/.test(error.userMessage));
    });
    assert.deepEqual(dms.map((d) => d.id), [OWNER_ID]);
});

// ── OWNER_IDS override ────────────────────────────────────────────────────

test('owner override: full power only in Mewvo\'s own servers', () => {
    assert.equal(hasOwnerPower(OWNER_ID, MAIN), true);
    assert.equal(hasOwnerPower(OWNER_ID, SUPPORT), true);
    assert.equal(hasOwnerPower(OWNER_ID, OTHER), false);
    assert.equal(hasOwnerPower(MODERATOR, MAIN), false);
    assert.equal(hasOwnerPower(OWNER_ID, null), false);

    const noAdmin = { has: () => false };
    const main = checkCommandAccess({ command: {}, accessKey: 'enforcements', guild: { id: MAIN, ownerId: SERVER_OWNER }, userId: OWNER_ID, permissions: noAdmin });
    assert.deepEqual(main, { allowed: true, ownerOverride: true }, 'home: unchanged');
    const other = checkCommandAccess({ command: {}, accessKey: 'enforcements', guild: { id: OTHER, ownerId: SERVER_OWNER }, userId: OWNER_ID, permissions: noAdmin });
    assert.equal(other.allowed, false, 'another server: no override');
    assert.equal(other.ownerOverride, undefined);

    const helpAsk = (guildId) => canSeeAdminCommands({ user: { id: OWNER_ID }, guildId, guild: { id: guildId, ownerId: SERVER_OWNER }, memberPermissions: noAdmin });
    assert.equal(helpAsk(MAIN), true);
    assert.equal(helpAsk(OTHER), false);

    const staff = (guildId, userId) => isStaffOwner({ user: { id: userId }, guildId, guild: { id: guildId, ownerId: SERVER_OWNER } });
    assert.equal(staff(MAIN, OWNER_ID), true);
    assert.equal(staff(OTHER, OWNER_ID), false, '/staff owner subcommands: the server owner only');
    assert.equal(staff(OTHER, SERVER_OWNER), true);

    const issued = (guildId) => ({ guild_id: guildId, moderator_id: OWNER_ID, is_auto: false, type: 'ban' });
    assert.deepEqual(checkAppealReviewer(issued(MAIN), OWNER_ID, { enabled: true }), { allowed: true, ownerOverride: true });
    assert.equal(checkAppealReviewer(issued(OTHER), OWNER_ID, { enabled: true }).allowed, false, 'independent review binds bot owners elsewhere');
});

// ── Staff reports ─────────────────────────────────────────────────────────

test('staff reports: Mewvo\'s servers file into the main server; another server into itself', () => {
    assert.equal(reportGuildId(SUPPORT), MAIN);
    assert.equal(reportGuildId(MAIN), MAIN);
    assert.equal(reportGuildId(null), MAIN);
    assert.equal(reportGuildId(OTHER), OTHER);
    const at = (guildId) => panelServer({ inGuild: () => Boolean(guildId), guildId });
    assert.deepEqual([at(MAIN), at(SUPPORT), at(OTHER), at(null)], ['main', 'support', 'other', null]);
});

function reportGuild(id, { category = false } = {}) {
    const created = [];
    const channels = new Map();
    if (category) {
        channels.set(CATEGORY, { id: CATEGORY, type: ChannelType.GuildCategory, name: 'Staff' });
    }
    const guild = {
        id, name: 'Other', ownerId: SERVER_OWNER,
        channels: {
            cache: channels,
            fetch: async (cid) => channels.get(cid) || null,
            create: async (options) => {
                const channel = { id: `80000000000000000${created.length}`, ...options, send: async () => ({}) };
                created.push(channel);
                channels.set(channel.id, channel);
                return channel;
            },
        },
    };
    guild.client = {
        user: { id: '900000000000000001' }, guilds: { cache: new Map([[id, guild]]) }, channels: { cache: new Map() },
        db: { get: async () => null }, // no guild config stored: no /ticket category
    };
    return { guild, created };
}

const report = { user: { id: '500000000000000003', username: 'reporter' }, staffMember: 'someone', details: 'bad', proof: '' };

test('staff reports: another server without a reports/ticket/appeals category gets a clear "not set up" message', async () => {
    setSettingsCacheForTests(OTHER, {});
    const { guild, created } = reportGuild(OTHER);
    await withPool(() => [], async (queries) => {
        await assert.rejects(submitStaffReport({ client: guild.client, guildId: OTHER, ...report }),
            (error) => error.userMessage === REPORTS_NOT_SET_UP);
        assert.equal(queries.filter((q) => /INSERT INTO/.test(q.sql)).length, 0, 'nothing stored');
    });
    assert.equal(created.length, 0);
});

test('staff reports: filed in the server the member is in, in that server\'s reports category; limits count per server', async () => {
    setSettingsCacheForTests(OTHER, { reportsCategoryId: CATEGORY });
    const { guild, created } = reportGuild(OTHER, { category: true });
    await withPool((sql) => (/INSERT INTO/.test(sql) && /'report'/.test(sql) ? [{ id: 7 }] : []), async (queries) => {
        const result = await submitStaffReport({ client: guild.client, guildId: OTHER, ...report });
        assert.equal(result.channel.parent, CATEGORY);
        const insert = queries.find((q) => /INSERT INTO/.test(q.sql) && /'report'/.test(q.sql));
        assert.equal(insert.params[2], OTHER, 'stored with guild_id = that server');
        const limit = queries.find((q) => /kind = 'report' AND user_id = \$1 AND guild_id = \$2/.test(q.sql));
        assert.deepEqual(limit.params, [report.user.id, OTHER], 'one open / three a day, per server');
    });
    assert.equal(created.length, 1);
});

// ── Modmail ───────────────────────────────────────────────────────────────

function mmGuild(id, name, { member = true, category = false } = {}) {
    const channels = new Map();
    if (category) channels.set(`${id}9`, { id: `${id}9`, type: ChannelType.GuildCategory });
    return {
        id, name,
        channels: { cache: channels },
        members: { cache: new Map(), fetch: async () => (member ? { id: 'm' } : null) },
    };
}

function mmClient(guilds, storedConfig = {}) {
    return { guilds: { cache: new Map(guilds.map((g) => [g.id, g])) }, db: { get: async () => storedConfig } };
}

const configFor = (blocked = {}) => async (client, guildId) => ({ ticketCategoryId: `${guildId}9`, modmailBlocked: blocked[guildId] || [] });

test('modmail: servers to choose from: shared, set up, not blocked; never the Support server', async () => {
    for (const id of [OTHER, OTHER_2, OTHER_3]) setSettingsCacheForTests(id, {});
    const client = mmClient([
        mmGuild(MAIN, 'Mewvo'),
        mmGuild(SUPPORT, 'Mewvo Support'),
        mmGuild(OTHER, 'Zeta', { category: true }),
        mmGuild(OTHER_2, 'Alpha', { category: true }),
        mmGuild(OTHER_3, 'No category'),
        mmGuild('100000000000000780', 'Not a member', { category: true, member: false }),
    ]);
    const { servers, blockedSomewhere } = await modmail.modmailServersFor(client, '500000000000000004', { getConfig: configFor({ [OTHER]: ['500000000000000004'] }) });
    assert.deepEqual(servers.map((g) => g.id), [MAIN, OTHER_2], 'main first, then by name; blocked, unset, support and non-member servers left out');
    assert.equal(blockedSomewhere, true);
});

test('modmail prompt: none → a clear message; one → straight to that server; several → "Which server?" menu (max 25)', () => {
    const none = modmail.modmailPromptPayload([], '300000000000000001');
    assert.equal(none.content, modmail.NO_MODMAIL_SERVER);
    assert.equal(none.components.length, 0);
    assert.equal(modmail.modmailPromptPayload([], '300000000000000001', { blockedSomewhere: true }).content, modmail.MODMAIL_BLOCKED);

    const main = modmail.modmailPromptPayload([{ id: MAIN, name: 'Mewvo' }], '300000000000000001');
    assert.match(main.content, /^Do you want to send this message to the Mewvo staff\?/, 'home wording unchanged');
    assert.equal(main.components[0].components[0].data.custom_id, `modmail_open:300000000000000001:${MAIN}`);

    const one = modmail.modmailPromptPayload([{ id: OTHER, name: 'Zeta' }], '300000000000000001');
    assert.match(one.content, /the staff of Zeta/);
    assert.equal(one.components[0].components[0].data.custom_id, `modmail_open:300000000000000001:${OTHER}`);

    const many = Array.from({ length: 30 }, (_, i) => ({ id: `1000000000000010${String(i).padStart(2, '0')}`, name: `S${i}` }));
    const several = modmail.modmailPromptPayload(many, '300000000000000001');
    const menu = several.components[0].components[0];
    assert.equal(menu.data.custom_id, 'modmail_pick:300000000000000001');
    assert.equal(menu.options.length, 25);
    assert.equal(menu.options[0].data.value, many[0].id);
    assert.match(several.content, /Which server/);
    assert.match(several.content, /first 25/);
    assert.equal(several.components[1].components[0].data.custom_id, 'modmail_cancel');
});

function dm(userId) {
    const replies = [];
    return {
        replies,
        message: { id: '300000000000000002', author: { id: userId, username: 'kit' }, reply: async (payload) => { replies.push(payload); return {}; } },
    };
}

test('modmail DM: 0, 1 or several servers', async () => {
    for (const id of [OTHER, OTHER_2]) setSettingsCacheForTests(id, {});
    await withPool(() => [], async () => {
        const none = dm('500000000000000011');
        await modmail.handleModmailDm(none.message, mmClient([mmGuild(OTHER, 'Zeta')]), { getConfig: async () => ({}) });
        assert.equal(none.replies[0].content, modmail.NO_MODMAIL_SERVER);

        const one = dm('500000000000000012');
        await modmail.handleModmailDm(one.message, mmClient([mmGuild(OTHER, 'Zeta', { category: true }), mmGuild(OTHER_2, 'Alpha')]), { getConfig: configFor() });
        assert.equal(one.replies[0].components[0].components[0].data.custom_id, `modmail_open:${one.message.id}:${OTHER}`);

        const several = dm('500000000000000013');
        await modmail.handleModmailDm(several.message, mmClient([mmGuild(OTHER, 'Zeta', { category: true }), mmGuild(OTHER_2, 'Alpha', { category: true })]), { getConfig: configFor() });
        const menu = several.replies[0].components[0].components[0];
        assert.deepEqual(menu.options.map((o) => o.data.value), [OTHER_2, OTHER]);
    });
});

test('modmail open: the chosen server is re-checked (not set up / not a member) before anything is created', async () => {
    setSettingsCacheForTests(OTHER, {});
    const user = { id: '500000000000000014', username: 'kit' };
    await withPool(() => [], async () => {
        const unset = mmClient([mmGuild(OTHER, 'Zeta')]);
        unset.guilds.cache.get(OTHER).members.fetch = async () => ({ id: user.id });
        assert.equal(await modmail.openModmail(unset, user, {}, '300000000000000003', OTHER, { getConfig: async () => ({ modmailBlocked: [] }) }),
            'Zeta does not take modmail right now.');
        const notMember = mmClient([mmGuild(OTHER, 'Zeta', { category: true, member: false })]);
        assert.match(await modmail.openModmail(notMember, user, {}, '300000000000000003', OTHER, { getConfig: configFor() }), /not a member of Zeta/);
        const blocked = mmClient([mmGuild(OTHER, 'Zeta', { category: true })], { modmailBlocked: [user.id] });
        assert.equal(await modmail.openModmail(blocked, user, {}, '300000000000000003', OTHER, { getConfig: configFor({ [OTHER]: [user.id] }) }), modmail.MODMAIL_BLOCKED);
    });
});

test('modmail buttons: the pick menu and the button pass the server; an old button without one means the main server', async () => {
    const calls = [];
    const open = async (...args) => { calls.push(args.slice(3)); return 'ok'; };
    const interaction = { user: { id: '500000000000000015' }, channel: {}, deferUpdate: async () => {}, editReply: async () => {} };
    await openFromPrompt(interaction, {}, '300000000000000004', OTHER, { open });
    await openFromPrompt(interaction, {}, '300000000000000004', undefined, { open });
    await openFromPrompt(interaction, {}, '300000000000000004', 'not-a-server', { open });
    assert.deepEqual(calls, [['300000000000000004', OTHER], ['300000000000000004']], 'a broken server id never opens anything');
});

test('enforcement config: tests run with the expected home ids', () => {
    assert.equal(enforcementConfig.mainGuildId, MAIN);
});

// ── Leftovers: Manage Server commands, prefix permission guard, /appeals, /case, panel texts ──

test('owner override: Manage Server commands (/setup) and the prefix permission guard follow the same rule', async () => {
    const noPerms = { has: () => false };
    const setup = (guildId) => checkCommandAccess({ command: {}, accessKey: 'setup', guild: { id: guildId, ownerId: SERVER_OWNER }, userId: OWNER_ID, permissions: noPerms });
    assert.deepEqual(setup(MAIN), { allowed: true, ownerOverride: true }, 'home: OWNER_IDS keep the override');
    assert.equal(setup(SUPPORT).allowed, true);
    assert.equal(setup(OTHER).allowed, false, 'another server: OWNER_IDS need Manage Server like everyone else');
    const manager = checkCommandAccess({ command: {}, accessKey: 'setup', guild: { id: OTHER, ownerId: SERVER_OWNER }, userId: MODERATOR, permissions: { has: (flag) => flag === PermissionFlagsBits.ManageGuild } });
    assert.deepEqual(manager, { allowed: true });

    const { enforceDefaultCommandPermissions } = await import('../src/utils/permissionGuard.js');
    const command = { data: { name: 'x', default_member_permissions: String(PermissionFlagsBits.Administrator) } };
    const replies = [];
    const prefixCall = (guildId) => ({
        user: { id: OWNER_ID }, guildId, commandName: 'x',
        member: { id: OWNER_ID, guild: { id: guildId, ownerId: SERVER_OWNER }, permissions: noPerms, roles: { cache: new Map() } },
        reply: async (payload) => { replies.push(payload); }, followUp: async (payload) => { replies.push(payload); },
        editReply: async (payload) => { replies.push(payload); }, isRepliable: () => true, deferred: false, replied: false,
    });
    assert.equal(await enforceDefaultCommandPermissions(prefixCall(MAIN), command), true);
    assert.equal(await enforceDefaultCommandPermissions(prefixCall(OTHER), command), false);
});

function slashCall(guildId, { admin = false } = {}) {
    return {
        user: { id: MODERATOR, username: 'mod' }, guildId, guild: guildId ? { id: guildId, ownerId: SERVER_OWNER } : null,
        member: guildId ? { id: MODERATOR, guild: { ownerId: SERVER_OWNER }, permissions: perms(admin) } : null,
        options: { getString: () => null, getSubcommand: () => 'search', getSubcommandGroup: () => null },
    };
}

test('/appeals and /case: open in any server (each only for its own cases); /appeals refused in the Support server', async () => {
    const { default: appeals } = await import('../src/commands/Enforcement/appeals.js');
    const { default: caseCommand } = await import('../src/commands/Enforcement/case.js');
    const userMessage = (pattern) => (error) => pattern.test(error.userMessage);
    // Another server: past the server check, stopped only by the Administrator check.
    await assert.rejects(appeals.execute(slashCall(OTHER), {}, {}), userMessage(/Administrator/));
    await assert.rejects(caseCommand.execute(slashCall(OTHER), {}, {}), userMessage(/Administrator/));
    await assert.rejects(appeals.execute(slashCall(SUPPORT, { admin: true }), {}, {}), userMessage(/main server/));
    await assert.rejects(appeals.execute(slashCall(null), {}, {}), userMessage(/in a server/));
    await assert.rejects(caseCommand.execute(slashCall(null), {}, {}), userMessage(/in a server/));
});

test('/appeals list: only the calling server\'s pending appeals are read', async () => {
    const { listPendingAppeals } = await import('../src/services/enforcement/appealService.js');
    await withPool(() => [], async (queries) => {
        await listPendingAppeals(20, OTHER);
        assert.match(queries[0].sql, /c\.guild_id = \$2/);
        assert.deepEqual(queries[0].params, [20, OTHER]);
    });
});

test('appeal panel: the refusal text no longer says "Mewvo servers" to other servers', async () => {
    const { wrongPlaceMessage } = await import('../src/handlers/appealsHandler.js');
    assert.equal(wrongPlaceMessage(null, 'open'), 'Use the appeal panel in a server.');
    assert.match(wrongPlaceMessage('main', 'report'), /support server/);
});

test('staff activity: staff messages are counted per server, in every server', async () => {
    const { noteStaffMessage, flushStaffMessages } = await import('../src/services/staffActivityService.js');
    const staffMessage = (guildId) => ({
        guildId, author: { id: MODERATOR },
        member: { id: MODERATOR, guild: { ownerId: SERVER_OWNER }, permissions: perms(true) },
    });
    noteStaffMessage(staffMessage(OTHER));
    noteStaffMessage(staffMessage(MAIN));
    noteStaffMessage({ ...staffMessage(null), member: null });
    await withPool(() => [], async (queries) => {
        await flushStaffMessages();
        const servers = queries.filter((q) => /staff_activity/i.test(q.sql)).map((q) => q.params[0]).sort();
        assert.deepEqual(servers, [MAIN, OTHER].sort());
    });
});

test('modmail close: the transcript only goes to a channel of the conversation\'s own server', () => {
    const at = (guildId, sendable = true) => ({ guildId, isSendable: () => sendable });
    assert.equal(modmail.isOwnTranscriptChannel(at(OTHER), OTHER), true);
    assert.equal(modmail.isOwnTranscriptChannel(at(OTHER_2), OTHER), false, 'another server\'s channel id is ignored');
    assert.equal(modmail.isOwnTranscriptChannel(at(OTHER, false), OTHER), false);
    assert.equal(modmail.isOwnTranscriptChannel(null, OTHER), false);
});
