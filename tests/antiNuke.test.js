// Anti-nuke "Wick-style extras": daily snapshots of every server with the staff guard on (paced,
// one query), a snapshot at the nuke alert when the newest is stale, the nuke alert's buttons
// (Show what changed / Revert… / Lock down) in any server, the revert plan, the revert itself
// (any server from its own snapshot, never deletes), and who may press what.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000881';
const OTHER_2 = '100000000000000882';
const IDLE = '100000000000000883';
const SERVER_OWNER = '199999999999999992';
const ADMIN = '500000000000000001';
const OFFENDER = '500000000000000066';
const MEMBER = '500000000000000077';

Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT });

const { pgDb } = await import('../src/utils/postgresDatabase.js');
const { GUILD_SQL } = await import('../src/services/scheduling/guildScan.js');
const backup = await import('../src/services/structureBackupService.js');
const { nukeAlertRow } = await import('../src/services/automod/alertPost.js');
const guard = await import('../src/services/automod/staffGuardService.js');
const handlers = await import('../src/handlers/backupRevert.js');

afterEach(() => {
    guard.resetStaffGuardState();
    backup.resetStructureBackupState();
});

/** A fake pg pool; `answer(sql, params)` returns rows; every query is recorded. */
async function withPool(answer, fn) {
    const queries = [];
    const saved = { pool: pgDb.pool, isConnected: pgDb.isConnected, isAvailable: pgDb.isAvailable };
    const run = async (sql, params = []) => {
        queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return { rows: (await answer(String(sql), params)) || [], rowCount: 1 };
    };
    pgDb.pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    pgDb.isConnected = true;
    pgDb.isAvailable = () => true;
    try {
        return await fn(queries);
    } finally {
        Object.assign(pgDb, saved);
    }
}

// ── A live fake guild built from snapshot-like descriptors ────────────────

const bits = (value) => ({ bitfield: BigInt(value) });

function liveGuild(id, { roles = [], channels = [], everyone = '0', ownerId = SERVER_OWNER, failChannel = null } = {}) {
    const calls = { rolesCreated: [], channelsCreated: [], deleted: [], rest: [], positions: [] };
    let next = 1;
    const guild = { id, name: `Server ${id}`, ownerId, maximumBitrate: 96000, calls };
    const makeRole = (r) => ({ id: r.id, name: r.name, color: 0, hoist: false, mentionable: false, managed: false, position: r.position, permissions: bits(r.permissions || '0'), editable: true, guild,
        setPermissions: async (p) => { calls.rest.push(['rolePerms', r.id, String(p)]); }, delete: async () => { calls.deleted.push(r.id); } });
    const roleCache = new Map(roles.map((r) => [r.id, makeRole(r)]));
    const everyoneRole = { id, permissions: bits(everyone), setPermissions: async (p) => { calls.rest.push(['everyone', String(p)]); } };
    const makeChannel = (c) => ({
        id: c.id, name: c.name, type: c.type, parentId: c.parentId || null, rawPosition: c.position || 0,
        topic: null, nsfw: false, rateLimitPerUser: 0, bitrate: null, userLimit: null,
        permissionOverwrites: { cache: new Map((c.overwrites || []).map((o) => [o.roleId, { id: o.roleId, type: 0, allow: bits(o.allow), deny: bits(o.deny) }])) },
        delete: async () => { calls.deleted.push(c.id); },
    });
    const channelCache = new Map(channels.map((c) => [c.id, makeChannel(c)]));
    guild.roles = {
        cache: roleCache, everyone: everyoneRole,
        create: async (options) => { const created = { id: `new-role-${next++}`, ...options }; calls.rolesCreated.push(created); return created; },
        setPositions: async (list) => { calls.positions.push(['roles', list]); },
    };
    guild.channels = {
        cache: channelCache,
        create: async (options) => {
            if (options.name === failChannel) throw new Error('Missing Access');
            const created = { id: `new-channel-${next++}`, ...options };
            calls.channelsCreated.push(created);
            return created;
        },
        setPositions: async (list) => { calls.positions.push(['channels', list]); },
    };
    guild.members = { me: { roles: { highest: { position: 50 } }, permissions: { has: () => true } } };
    guild.client = { rest: { put: async (route) => calls.rest.push(['put', route]), delete: async (route) => calls.rest.push(['delete', route]) } };
    return guild;
}

const role = (id, name, position, permissions = '0') => ({ id, name, position, permissions });
const channel = (id, name, type, { parentId = null, overwrites = [], position = 0 } = {}) => ({ id, name, type, parentId, overwrites, position });

/** The snapshot of `guildId` before a nuke: 2 roles, a category with a channel, a lone channel. */
function snapshotRow(guildId, id = 11) {
    const before = liveGuild(guildId, {
        roles: [role('600000000000000001', 'Member', 1, '1024'), role('600000000000000002', 'Mod', 2, '8192')],
        channels: [
            channel('700000000000000001', 'Info', ChannelType.GuildCategory),
            channel('700000000000000002', 'rules', ChannelType.GuildText, { parentId: '700000000000000001', position: 1, overwrites: [{ roleId: '600000000000000002', allow: '2048', deny: '0' }] }),
            channel('700000000000000003', 'general', ChannelType.GuildText, { position: 2 }),
        ],
    });
    return { id, guild_id: guildId, created_at: new Date('2026-11-01T04:00:00Z'), summary: '2 roles, 1 categories, 2 channels', data: backup.captureStructure(before) };
}

/** The same server after the nuke: Mod, Info and rules deleted; a "raided" channel added. */
function nukedGuild(guildId, options = {}) {
    return liveGuild(guildId, {
        roles: [role('600000000000000001', 'Member', 1, '1024')],
        channels: [channel('700000000000000003', 'general', ChannelType.GuildText, { position: 2 }), channel('700000000000000009', 'raided', ChannelType.GuildText)],
        ...options,
    });
}

// ── 1. Which servers are snapshotted, and pacing ──────────────────────────

test('snapshot selection: main + support + every server with the staff guard on (one query), only servers I am in', async () => {
    const guilds = [MAIN, SUPPORT, OTHER, OTHER_2, IDLE].map((id) => [id, { id }]);
    const client = { guilds: { cache: new Map(guilds) } };
    const seen = [];
    const query = async (sql) => { seen.push(sql); return { rows: [{ id: OTHER }, { id: MAIN }, { id: '100000000000000999' }, { id: OTHER_2 }] }; };
    const ids = await backup.snapshotGuildIds(client, { query });
    assert.deepEqual(ids, [MAIN, SUPPORT, OTHER, OTHER_2], 'no duplicates, no server I left, the idle one skipped');
    assert.equal(seen.length, 1);
    assert.equal(seen[0], GUILD_SQL.staffGuard);
    assert.match(GUILD_SQL.staffGuard, /automod:settings:%/);
    assert.match(GUILD_SQL.staffGuard, /'enabled' = 'true'/);
    assert.match(GUILD_SQL.staffGuard, /'staffGuard' = 'true'/);
});

test('daily snapshots: paced between servers, one failing server does not stop the rest, a DB error skips the run', async () => {
    const guilds = [MAIN, OTHER, OTHER_2].map((id) => [id, { id }]);
    const client = { guilds: { cache: new Map(guilds) } };
    const query = async () => ({ rows: [{ id: OTHER }, { id: OTHER_2 }] });
    const times = [];
    const snapshot = async (guild) => {
        times.push([guild.id, Date.now()]);
        if (guild.id === OTHER) throw new Error('boom');
        return { id: times.length, summary: 'x' };
    };
    const result = await backup.snapshotMainServer(client, { pauseMs: 40, query, snapshot });
    assert.deepEqual(result, { taken: 2, failed: 1 });
    assert.deepEqual(times.map(([id]) => id), [MAIN, OTHER, OTHER_2]);
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i][1] - times[i - 1][1] >= 35, 'a pause between servers');

    const failing = await backup.snapshotMainServer(client, { pauseMs: 0, query: async () => { throw new Error('db down'); }, snapshot });
    assert.deepEqual(failing, { taken: 0, failed: 0 });
    assert.equal(backup.KEEP_SNAPSHOTS, 7);
});

test('snapshot at a nuke alert: only when the newest is over an hour old; captured at once; never throws', async () => {
    const guild = nukedGuild(OTHER);
    await withPool((sql) => (/MAX\(created_at\)/.test(sql) ? [{ newest: new Date(Date.now() - 10 * 60 * 1000) }] : []), async (queries) => {
        assert.equal(await backup.snapshotIfStale(guild), null, 'fresh enough');
        assert.equal(queries.filter((q) => /INSERT/.test(q.sql)).length, 0);
    });
    await withPool((sql) => {
        if (/MAX\(created_at\)/.test(sql)) return [{ newest: new Date(Date.now() - 2 * 60 * 60 * 1000) }];
        if (/INSERT/.test(sql)) return [{ id: 5, created_at: new Date(), summary: 's' }];
        return [];
    }, async (queries) => {
        const pending = backup.snapshotIfStale(guild);
        guild.channels.cache.clear(); // the nuke goes on after the alert: the snapshot is from before
        const row = await pending;
        assert.equal(row.id, 5);
        const insert = queries.find((q) => /INSERT/.test(q.sql));
        assert.equal(insert.params[0], OTHER);
        assert.equal(insert.params[2].channels.length, 2, 'captured when called');
        assert.equal(insert.params[2].kind, 'nuke', 'tagged as on-demand');
        assert.match(insert.params[1], /at a nuke alert/);
        const prune = queries.find((q) => /DELETE FROM server_snapshots/.test(q.sql));
        assert.deepEqual(prune.params, [OTHER, 3, true], 'only the on-demand pool is pruned, to 3');
    });
    await withPool(() => { throw new Error('db down'); }, async () => {
        assert.equal(await backup.snapshotIfStale(guild), null);
    });
});

// ── 2. The alert's buttons ────────────────────────────────────────────────

test('nuke alert row: diff, revert and lock down with the guild and the offender; diff time a minute before the alert', () => {
    const at = 1_700_000_060_000;
    const ids = nukeAlertRow(at, OTHER, OFFENDER).components.map((b) => b.data.custom_id);
    assert.deepEqual(ids, [
        `nukediff:1700000000:${OTHER}:${OFFENDER}`,
        `nukerevert:ask:1700000000:${OTHER}:${OFFENDER}`,
        `nukepanic:${OTHER}:${OFFENDER}`,
    ]);
    for (const id of ids) assert.ok(id.length <= 100);
    assert.match(nukeAlertRow(at, OTHER, null).components[0].data.custom_id, /:0$/);
});

// ── 3. The revert plan and the revert ─────────────────────────────────────

test('revert plan from a diff: what is recreated, fixed and left alone (nothing deleted)', () => {
    const snap = snapshotRow(OTHER);
    const diff = backup.diffAgainstLive(nukedGuild(OTHER), snap);
    const plan = backup.revertPlan(diff);
    assert.deepEqual(plan.recreateRoles, ['Mod']);
    assert.deepEqual(plan.recreateCategories, ['Info']);
    assert.deepEqual(plan.recreateChannels, ['rules']);
    assert.equal(plan.leftAlone, 1, 'the raided channel');
    assert.equal(plan.empty, false);
    const text = backup.formatRevertPlan(plan);
    assert.match(text, /Recreate \*\*1\*\* role/);
    assert.match(text, /nothing is deleted/);
    const none = backup.revertPlan(backup.diffAgainstLive(liveGuild(OTHER, {}), { ...snap, data: backup.captureStructure(liveGuild(OTHER, {})) }));
    assert.equal(none.empty, true);
    assert.match(backup.formatRevertPlan(none), /Nothing to revert/);
});

test('revert: any server from its own snapshot (support too); category, position and overwrites restored; never deletes; reports failures', async () => {
    for (const guildId of [OTHER, SUPPORT]) {
        const guild = nukedGuild(guildId);
        const counts = await backup.revertToSnapshot(guild, snapshotRow(guildId), async () => {}, { pauseMs: 0 });
        assert.equal(counts.rolesCreated, 1);
        assert.equal(counts.channelsCreated, 2);
        assert.deepEqual(guild.calls.deleted, [], 'nothing deleted');
        const [category, rules] = guild.calls.channelsCreated;
        assert.equal(category.name, 'Info');
        assert.equal(rules.parent, category.id, 'back in its recreated category');
        assert.deepEqual(rules.permissionOverwrites.map((o) => o.id), [guild.calls.rolesCreated[0].id], 'overwrite of the recreated Mod role');
        assert.ok(guild.calls.positions.some(([kind, list]) => kind === 'channels' && list.some((p) => p.position === 1)));
    }
    const failing = nukedGuild(OTHER, { failChannel: 'rules' });
    const counts = await backup.revertToSnapshot(failing, snapshotRow(OTHER), async () => {}, { pauseMs: 0 });
    assert.equal(counts.failed, 1);
    assert.match(backup.formatRevertSummary(counts), /Could not restore: channel rules/);
    await assert.rejects(backup.revertToSnapshot(nukedGuild(OTHER), snapshotRow(OTHER_2), async () => {}, { pauseMs: 0 }), /own snapshots/);
});

test('revert: one at a time per server, two servers at once', async () => {
    const slow = nukedGuild(OTHER);
    const first = backup.revertToSnapshot(slow, snapshotRow(OTHER), async () => {}, { pauseMs: 20 });
    await assert.rejects(backup.revertToSnapshot(nukedGuild(OTHER), snapshotRow(OTHER), async () => {}, { pauseMs: 0 }), /already running/);
    await backup.revertToSnapshot(nukedGuild(OTHER_2), snapshotRow(OTHER_2), async () => {}, { pauseMs: 0 });
    await first;
});

// ── 4. Who may press what ─────────────────────────────────────────────────

const perms = (admin) => ({ has: (flag) => admin && flag === PermissionFlagsBits.Administrator });

function click(guildId, userId, { admin = false } = {}) {
    const replies = [];
    const interaction = {
        id: `i${Math.random()}`, guildId, user: { id: userId, username: `u${userId.slice(-3)}`, send: async () => {} },
        member: { id: userId, guild: { ownerId: SERVER_OWNER }, permissions: perms(admin) },
        deferred: false, replied: false,
        reply: async (p) => { replies.push(p); interaction.replied = true; },
        deferReply: async () => { interaction.deferred = true; },
        deferUpdate: async () => { interaction.deferred = true; },
        update: async (p) => { replies.push(p); interaction.replied = true; },
        editReply: async (p) => { replies.push(p); },
        followUp: async (p) => { replies.push(p); },
    };
    return { interaction, replies };
}

function clientWith(...guilds) {
    return { user: { id: '900000000000000001' }, guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } };
}

test('access: owner and non-offender admins allowed; the offender (customId or remembered), members and other servers refused', () => {
    const client = clientWith(nukedGuild(OTHER), nukedGuild(OTHER_2), nukedGuild(SUPPORT), nukedGuild(MAIN));
    const access = (guildId, userId, target, offender, admin = false) => handlers.nukeAccess(click(guildId, userId, { admin }).interaction, client, target, offender);

    assert.deepEqual(access(OTHER, SERVER_OWNER, OTHER, OFFENDER), { ok: true, canRevert: true, owner: true, scope: 'owner' });
    assert.deepEqual(access(OTHER, ADMIN, OTHER, OFFENDER, true), { ok: true, canRevert: true, owner: false, scope: 'admin' });
    assert.match(access(OTHER, OFFENDER, OTHER, OFFENDER, true).message, /acted on you/);
    assert.match(access(OTHER, MEMBER, OTHER, OFFENDER).message, /Only administrators/);

    guard.noteOffender(OTHER, ADMIN);
    assert.match(access(OTHER, ADMIN, OTHER, null, true).message, /acted on you/, 'remembered offender, even without the customId');
    assert.ok(access(OTHER_2, ADMIN, OTHER_2, null, true).ok, 'only in the server it happened in');
    assert.equal(guard.isRecentOffender(OTHER, ADMIN, Date.now() + guard.OFFENDER_TTL_MS + 1), false, 'forgotten after a week');

    assert.match(access(OTHER, SERVER_OWNER, OTHER_2, OFFENDER).message, /another server/, 'a button naming another server');
    assert.match(access(OTHER, ADMIN, MAIN, OFFENDER, true).message, /another server/);
    assert.match(access(OTHER, ADMIN, 'junk', OFFENDER, true).message, /broken/);
    assert.ok(access(MAIN, ADMIN, SUPPORT, OFFENDER, true).ok, 'support alerts are posted (and pressed) in the main server');
    assert.match(access(SUPPORT, ADMIN, SUPPORT, OFFENDER, true).message, /another server/);
});

// ── 5. Confirm required ───────────────────────────────────────────────────

const snapshotAnswer = (row) => (sql, params) => (/FROM server_snapshots/.test(sql) && params[0] === row.guild_id ? [row] : []);
const ids = (replies) => JSON.stringify(replies.map((r) => r.components || []));

test('"Revert…" and "Show what changed" only show the plan with Confirm / Cancel; nothing runs until Confirm', async () => {
    const guild = nukedGuild(OTHER);
    const client = clientWith(guild);
    const row = snapshotRow(OTHER);
    await withPool(snapshotAnswer(row), async () => {
        const ask = click(OTHER, ADMIN, { admin: true });
        await handlers.handleNukeRevert(ask.interaction, client, ['ask', '1793520000', OTHER, OFFENDER]);
        assert.equal(ask.interaction.deferred, true);
        assert.match(ids(ask.replies), new RegExp(`nukerevert:confirm:${OTHER}:11:${OFFENDER}`));
        assert.match(ids(ask.replies), /nukerevert:cancel/);
        assert.match(JSON.stringify(ask.replies), /Recreate/);

        const diff = click(OTHER, ADMIN, { admin: true });
        await handlers.handleNukeDiff(diff.interaction, client, ['1793520000', OTHER, OFFENDER]);
        assert.match(ids(diff.replies), /nukerevert:confirm/);

        const member = click(OTHER, MEMBER);
        await handlers.handleNukeRevert(member.interaction, client, ['ask', '1793520000', OTHER, OFFENDER]);
        assert.equal(member.interaction.deferred, false);
        assert.match(JSON.stringify(member.replies), /Only administrators/);

        const offender = click(OTHER, OFFENDER, { admin: true });
        await handlers.handleNukeRevert(offender.interaction, client, ['confirm', OTHER, '11', OFFENDER]);
        assert.equal(offender.interaction.deferred, false);
    });
    assert.deepEqual(guild.calls.rolesCreated, [], 'nothing executed before Confirm');
    assert.deepEqual(guild.calls.channelsCreated, []);
});

test('Confirm: runs the revert from that server\'s snapshot; another server\'s snapshot id finds nothing', async () => {
    const guild = nukedGuild(OTHER);
    const client = clientWith(guild);
    const foreign = snapshotRow(OTHER_2, 99);
    await withPool(snapshotAnswer(foreign), async (queries) => {
        const { interaction, replies } = click(OTHER, SERVER_OWNER);
        await handlers.handleNukeRevert(interaction, client, ['confirm', OTHER, '99', OFFENDER]);
        assert.deepEqual(queries.find((q) => /FROM server_snapshots/.test(q.sql)).params, [OTHER, '99']);
        assert.match(JSON.stringify(replies), /Revert not started/);
    });
    assert.deepEqual(guild.calls.rolesCreated, []);

    const row = snapshotRow(OTHER);
    await withPool(snapshotAnswer(row), async () => {
        const { interaction, replies } = click(OTHER, SERVER_OWNER);
        await handlers.handleNukeRevert(interaction, client, ['confirm', OTHER, '11', OFFENDER]);
        assert.match(JSON.stringify(replies), /Revert running/);
        for (let i = 0; i < 100 && !JSON.stringify(replies).includes('Revert finished'); i += 1) await new Promise((r) => setTimeout(r, 20));
        assert.match(JSON.stringify(replies), /Revert finished/);
    });
    assert.equal(guild.calls.rolesCreated.length, 1);
    assert.deepEqual(guild.calls.deleted, []);

    const cancel = click(OTHER, ADMIN, { admin: true });
    await handlers.handleNukeRevert(cancel.interaction, client, ['cancel', OTHER, '11', OFFENDER]);
    assert.match(JSON.stringify(cancel.replies), /Nothing was changed/);
});

test('Lock down (panic): refused for the offender and members, before anything runs', async () => {
    const client = clientWith(nukedGuild(OTHER));
    for (const [userId, admin, re] of [[OFFENDER, true, /acted on you/], [MEMBER, false, /Only administrators/]]) {
        const { interaction, replies } = click(OTHER, userId, { admin });
        await handlers.handleNukePanic(interaction, client, [OTHER, OFFENDER]);
        assert.equal(interaction.deferred, false);
        assert.match(JSON.stringify(replies), re);
    }
    const { interaction, replies } = click(OTHER_2, SERVER_OWNER);
    await handlers.handleNukePanic(interaction, client, [OTHER, OFFENDER]);
    assert.match(JSON.stringify(replies), /another server/);
});

// ── 6. Owner-only permission restores (security review) ───────────────────

const ADMIN_BIT = String(PermissionFlagsBits.Administrator);
const MANAGE_CHANNELS = PermissionFlagsBits.ManageChannels;
const VIEW = PermissionFlagsBits.ViewChannel;

const dangerousChannels = (guildId) => [
    channel('700000000000000003', 'general', ChannelType.GuildText, { overwrites: [{ roleId: '600000000000000001', allow: '0', deny: '2048' }] }),
    channel('700000000000000005', 'staff', ChannelType.GuildText, {
        overwrites: [
            { roleId: guildId, allow: '0', deny: String(VIEW) },
            { roleId: '600000000000000004', allow: String(VIEW | MANAGE_CHANNELS), deny: '0' },
        ],
    }),
];
const dangerousRoles = (memberPerms) => [
    role('600000000000000001', 'Member', 1, memberPerms), role('600000000000000003', 'Admins', 3, ADMIN_BIT), role('600000000000000004', 'Helpers', 2, '2048'),
];

/** A snapshot where the nuke also deleted an Administrator role, changed @everyone and Member, and an overwrite. */
function dangerousSnapshot(guildId) {
    const before = liveGuild(guildId, { everyone: '1024', roles: dangerousRoles('1024'), channels: dangerousChannels(guildId) });
    return { id: 21, guild_id: guildId, created_at: new Date('2026-11-01T04:00:00Z'), summary: 's', data: backup.captureStructure(before) };
}

function dangerousNuked(guildId) {
    return liveGuild(guildId, {
        everyone: '8', // @everyone was given Administrator
        roles: [role('600000000000000001', 'Member', 1, '0')], // Member's permissions changed; Admins + Helpers deleted
        channels: [channel('700000000000000003', 'general', ChannelType.GuildText)], // its overwrite removed; staff deleted
    });
}

test('revert plan for an admin: permission restores and dangerous roles need the server owner; the owner gets everything', () => {
    const diff = backup.diffAgainstLive(dangerousNuked(OTHER), dangerousSnapshot(OTHER));
    const admin = backup.revertPlan(diff, { scope: 'admin' });
    assert.deepEqual(admin.recreateRoles, ['Helpers'], 'Admins (Administrator) is left to the owner');
    assert.deepEqual(admin.recreateChannels, ['staff']);
    assert.deepEqual(admin.fixRolePermissions, []);
    assert.equal(admin.fixOverwrites, 0);
    assert.equal(admin.strippedChannelPermissions, true);
    assert.equal(admin.needsOwner.length, 4);
    const text = backup.formatRevertPlan(admin);
    assert.match(text, /Needs the server owner/);
    assert.match(text, /@everyone/);
    assert.match(text, /`Admins`/);
    assert.match(text, /permissions of `Member`/);

    const owner = backup.revertPlan(diff, { scope: 'owner' });
    assert.deepEqual(owner.recreateRoles.sort(), ['Admins', 'Helpers']);
    assert.deepEqual(owner.fixRolePermissions, ['@everyone', 'Member']);
    assert.ok(owner.fixOverwrites > 0);
    assert.deepEqual(owner.needsOwner, []);
    assert.equal(backup.hasDangerousBits('8'), true);
    assert.equal(backup.hasDangerousBits(String(VIEW)), false);
});

test('admin revert: no @everyone or role permission restore, no dangerous role, no overwrite fix; channel denies kept, dangerous allows dropped', async () => {
    const guild = dangerousNuked(OTHER);
    const counts = await backup.revertToSnapshot(guild, dangerousSnapshot(OTHER), async () => {}, { pauseMs: 0, scope: 'admin' });
    assert.deepEqual(guild.calls.rolesCreated.map((r) => r.name), ['Helpers']);
    assert.ok(guild.calls.rolesCreated.every((r) => !backup.hasDangerousBits(r.permissions)));
    assert.deepEqual(guild.calls.rest, [], 'no permission set, no overwrite put');
    const [staff] = guild.calls.channelsCreated;
    const everyone = staff.permissionOverwrites.find((o) => o.id === OTHER);
    assert.equal(everyone.deny, VIEW, 'the private channel stays private');
    const helpers = staff.permissionOverwrites.find((o) => o.id === guild.calls.rolesCreated[0].id);
    assert.equal(helpers.allow, VIEW, 'Manage Channels dropped, View kept');
    assert.match(backup.formatRevertSummary(counts), /need the server owner/);
    assert.deepEqual(guild.calls.deleted, []);

    const ownerGuild = dangerousNuked(OTHER);
    await backup.revertToSnapshot(ownerGuild, dangerousSnapshot(OTHER), async () => {}, { pauseMs: 0 });
    assert.equal(ownerGuild.calls.rolesCreated.length, 2, 'the owner recreates Admins too');
    assert.ok(ownerGuild.calls.rest.some(([kind]) => kind === 'everyone'));
    assert.ok(ownerGuild.calls.rest.some(([kind]) => kind === 'rolePerms'));
    await assert.rejects(backup.revertToSnapshot(dangerousNuked(OTHER), dangerousSnapshot(OTHER), async () => {}, { pauseMs: 0, scope: 'root' }), /Unknown revert scope/);
});

const ALERT_SOON = String(1793505600 + 4 * 3600); // 4 h after the snapshot
const ALERT_LATE = String(1793505600 + 30 * 3600); // 30 h after

test('admin confirm: runs only the admin steps; only owner-only steps left means no Confirm and nothing runs', async () => {
    const guild = dangerousNuked(OTHER);
    const client = clientWith(guild);
    const row = dangerousSnapshot(OTHER);
    await withPool(snapshotAnswer(row), async () => {
        const ask = click(OTHER, ADMIN, { admin: true });
        await handlers.handleNukeRevert(ask.interaction, client, ['ask', ALERT_SOON, OTHER, OFFENDER]);
        assert.match(JSON.stringify(ask.replies), /Needs the server owner/);
        const confirmId = `nukerevert:confirm:${OTHER}:21:${OFFENDER}:${ALERT_SOON}`;
        assert.match(ids(ask.replies), new RegExp(confirmId));
        assert.ok(confirmId.length <= 100);

        const { interaction, replies } = click(OTHER, ADMIN, { admin: true });
        await handlers.handleNukeRevert(interaction, client, ['confirm', OTHER, '21', OFFENDER, ALERT_SOON]);
        for (let i = 0; i < 100 && !JSON.stringify(replies).includes('Revert finished'); i += 1) await new Promise((r) => setTimeout(r, 20));
        assert.match(JSON.stringify(replies), /Revert finished/);
    });
    assert.deepEqual(guild.calls.rolesCreated.map((r) => r.name), ['Helpers']);
    assert.deepEqual(guild.calls.rest, []);

    // Only owner-only steps left: @everyone and Member changed, nothing deleted.
    const onlyPerms = liveGuild(OTHER, { everyone: '8', roles: dangerousRoles('0'), channels: dangerousChannels(OTHER) });
    await withPool(snapshotAnswer(row), async () => {
        const ask = click(OTHER, ADMIN, { admin: true });
        await handlers.handleNukeRevert(ask.interaction, clientWith(onlyPerms), ['ask', ALERT_SOON, OTHER, OFFENDER]);
        assert.doesNotMatch(ids(ask.replies), /nukerevert:confirm/, 'nothing an admin may run');
        assert.match(JSON.stringify(ask.replies), /Needs the server owner/);
        const { interaction, replies } = click(OTHER, ADMIN, { admin: true });
        await handlers.handleNukeRevert(interaction, clientWith(onlyPerms), ['confirm', OTHER, '21', OFFENDER, ALERT_SOON]);
        assert.match(JSON.stringify(replies), /needs the server owner/);
    });
    assert.deepEqual(onlyPerms.calls.rest, []);
});

test('24 h limit: an admin cannot revert from a snapshot over a day older than the alert (or of unknown time); the owner can', async () => {
    const row = snapshotRow(OTHER);
    assert.equal(handlers.snapshotTooOldForAdmin(row, ALERT_SOON), false);
    assert.equal(handlers.snapshotTooOldForAdmin(row, ALERT_LATE), true);
    assert.equal(handlers.snapshotTooOldForAdmin(row, undefined), true, 'old confirm buttons without a time');
    const guild = nukedGuild(OTHER);
    const client = clientWith(guild);
    await withPool(snapshotAnswer(row), async () => {
        const ask = click(OTHER, ADMIN, { admin: true });
        await handlers.handleNukeRevert(ask.interaction, client, ['ask', ALERT_LATE, OTHER, OFFENDER]);
        assert.match(JSON.stringify(ask.replies), /more than 24 hours older/);
        assert.doesNotMatch(ids(ask.replies), /nukerevert:confirm/);

        const diff = click(OTHER, ADMIN, { admin: true });
        await handlers.handleNukeDiff(diff.interaction, client, [ALERT_LATE, OTHER, OFFENDER]);
        assert.doesNotMatch(ids(diff.replies), /revert/i, 'the diff only, no revert buttons');
        assert.match(JSON.stringify(diff.replies), /more than 24 hours older/);

        for (const sec of [ALERT_LATE, undefined]) {
            const { interaction, replies } = click(OTHER, ADMIN, { admin: true });
            await handlers.handleNukeRevert(interaction, client, ['confirm', OTHER, '11', OFFENDER, sec]);
            assert.match(JSON.stringify(replies), /Revert not started.*more than 24 hours older/);
        }
        assert.deepEqual(guild.calls.rolesCreated, []);

        const owner = click(OTHER, SERVER_OWNER);
        await handlers.handleNukeRevert(owner.interaction, client, ['ask', ALERT_LATE, OTHER, OFFENDER]);
        assert.match(ids(owner.replies), /nukerevert:confirm/, 'the owner may');
    });
});

// ── 7. On-demand snapshots never evict daily ones ─────────────────────────

test('snapshot kinds: daily and on-demand pruned separately (7 daily, 3 on-demand); unknown kinds refused', async () => {
    const guild = { id: OTHER };
    const data = { guildId: OTHER, roles: [], channels: [], everyonePermissions: '0' };
    await withPool((sql) => (/INSERT/.test(sql) ? [{ id: 1, created_at: new Date(), summary: 's' }] : []), async (queries) => {
        await backup.takeSnapshot(guild, data);
        await backup.takeSnapshot(guild, data, { kind: 'enable' });
        const prunes = queries.filter((q) => /DELETE/.test(q.sql));
        assert.deepEqual(prunes.map((q) => q.params), [[OTHER, 7, false], [OTHER, 3, true]]);
        assert.ok(prunes.every((q) => q.sql.includes("COALESCE(data->>'kind', 'daily') <> 'daily'")), 'old rows without a kind count as daily');
        assert.deepEqual(queries.filter((q) => /INSERT/.test(q.sql)).map((q) => q.params[2].kind), ['daily', 'enable']);
        await assert.rejects(backup.takeSnapshot(guild, data, { kind: 'weekly' }), /Unknown snapshot kind/);
    });
    assert.ok(backup.KEEP_SNAPSHOTS >= 5);
    assert.equal(backup.KEEP_ON_DEMAND_SNAPSHOTS, 3);
});

test('/automod staffguard: a snapshot only when the guard goes from off to on, and only with none from the last 24 h', async () => {
    const off = { enabled: true, staffGuard: false };
    const on = { enabled: true, staffGuard: true };
    assert.equal(backup.guardTurnedOn(off, on), true);
    assert.equal(backup.guardTurnedOn(on, on), false, 'already on');
    assert.equal(backup.guardTurnedOn({ enabled: false, staffGuard: false }, { enabled: false, staffGuard: true }), false, 'automod still off');
    assert.equal(backup.snapshotOnGuardEnabled(nukedGuild(OTHER), on, on), null);

    const guild = nukedGuild(OTHER);
    await withPool((sql) => (/MAX\(created_at\)/.test(sql) ? [{ newest: new Date(Date.now() - 20 * 3600 * 1000) }] : []), async (queries) => {
        assert.equal(await backup.snapshotOnGuardEnabled(guild, off, on), null, 'one from 20 h ago is recent enough');
        assert.equal(queries.filter((q) => /INSERT/.test(q.sql)).length, 0);
    });
    await withPool((sql) => {
        if (/MAX\(created_at\)/.test(sql)) return [{ newest: new Date(Date.now() - 30 * 3600 * 1000) }];
        if (/INSERT/.test(sql)) return [{ id: 8, created_at: new Date(), summary: 's' }];
        return [];
    }, async (queries) => {
        assert.equal((await backup.snapshotOnGuardEnabled(guild, off, on)).id, 8);
        assert.equal(queries.find((q) => /INSERT/.test(q.sql)).params[2].kind, 'enable');
    });
});
