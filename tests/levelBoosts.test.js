// Leveling boosts: XP multiplier math, reward mode role plans, the per-member role sync
// (rejoin, level-up, /level set) against a fake guild, and the boost service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TitanBotError, ErrorTypes } from '../src/utils/errorHandler.js';
import {
    applyXpMultiplier, computeXpMultiplier, isValidBoost, planRewardRoles, rewardModeOf,
} from '../src/services/leveling/levelBoosts.js';
import { roleSyncNote, syncLevelRolesForMember, reconcileLevelRoles } from '../src/services/leveling/levelRoleSyncService.js';
import {
    getLevelingConfig, saveUserLevelData, setLevelBoost, updateLevelingConfig, saveLevelingConfig,
} from '../src/services/leveling/leveling.js';
import guildMemberAdd from '../src/events/guildMemberAdd.js';

const GUILD = '400000000000000001';
const CH = '400000000000000002';
const CH2 = '400000000000000003';
const THREAD = '400000000000000004';
const ROLE_A = '400000000000000011';
const ROLE_B = '400000000000000012';
const ROLE_C = '400000000000000013';
const ROLE_HIGH = '400000000000000014';
const ROLE_STAFF = '400000000000000015';
const USER = '400000000000000021';

// ── multiplier math ───────────────────────────────────────────────────────

test('boost values: 1.1 to 5, at most one decimal', () => {
    for (const ok of [1.1, 1.5, 2, 4.9, 5]) assert.equal(isValidBoost(ok), true, String(ok));
    for (const bad of [1, 1.05, 5.1, 0, -2, 1.25, NaN, Infinity, '2', null]) assert.equal(isValidBoost(bad), false, String(bad));
});

test('multiplier: channel x highest role x global; roles do not stack; capped at x5', () => {
    const cfg = { channelMultipliers: { [CH]: 2 }, roleMultipliers: { [ROLE_A]: 1.5, [ROLE_B]: 2.5 }, xpMultiplier: 1 };
    assert.equal(computeXpMultiplier(cfg, { channelId: CH2, roleIds: [] }).multiplier, 1, 'nothing boosted');
    assert.equal(computeXpMultiplier(cfg, { channelId: CH, roleIds: [] }).multiplier, 2);
    const both = computeXpMultiplier(cfg, { channelId: CH2, roleIds: [ROLE_A, ROLE_B] });
    assert.equal(both.role, 2.5, 'highest role wins');
    assert.equal(both.multiplier, 2.5, 'not 1.5 x 2.5');
    const capped = computeXpMultiplier(cfg, { channelId: CH, roleIds: [ROLE_B] });
    assert.equal(capped.multiplier, 5);
    assert.equal(capped.capped, false, '2 x 2.5 is exactly 5');
    const over = computeXpMultiplier({ ...cfg, xpMultiplier: 2 }, { channelId: CH, roleIds: [ROLE_B] });
    assert.equal(over.multiplier, 5, '2 x 2.5 x 2 = 10 is capped');
    assert.equal(over.capped, true);
    assert.equal(computeXpMultiplier({ roleMultipliers: { [ROLE_A]: 1.1 }, channelMultipliers: { [CH]: 1.1 } }, { channelId: CH, roleIds: [ROLE_A] }).multiplier, 1.21);
});

test('multiplier: a thread uses its parent channel boost, not its own id', () => {
    const cfg = { channelMultipliers: { [CH]: 3, [THREAD]: 4 } };
    assert.equal(computeXpMultiplier(cfg, { channelId: THREAD, threadParentId: CH }).multiplier, 3);
    assert.equal(computeXpMultiplier(cfg, { channelId: THREAD, threadParentId: CH2 }).multiplier, 1);
});

test('multiplier: the old global multiplier only counts above 1; bad stored values are ignored', () => {
    assert.equal(computeXpMultiplier({ xpMultiplier: 0.5 }, {}).multiplier, 1);
    assert.equal(computeXpMultiplier({ xpMultiplier: 1.5 }, {}).multiplier, 1.5);
    assert.equal(computeXpMultiplier({ channelMultipliers: { [CH]: 99 }, roleMultipliers: { [ROLE_A]: 'x' } }, { channelId: CH, roleIds: [ROLE_A] }).multiplier, 1);
    assert.equal(computeXpMultiplier(null, {}).multiplier, 1);
});

test('applyXpMultiplier rounds down and never lowers XP', () => {
    assert.equal(applyXpMultiplier(15, 1), 15);
    assert.equal(applyXpMultiplier(15, 1.5), 22);
    assert.equal(applyXpMultiplier(10, 1.1), 11);
    assert.equal(applyXpMultiplier(25, 5), 125);
    assert.equal(applyXpMultiplier(20, 0.5), 20);
});

// ── reward mode plans ─────────────────────────────────────────────────────

const REWARDS = { 5: ROLE_A, 10: ROLE_B, 20: ROLE_C };

test('reward mode: keep all adds every earned role and removes nothing', () => {
    assert.equal(rewardModeOf({}), 'keep');
    assert.equal(rewardModeOf({ rewardMode: 'highest' }), 'highest');
    const plan = planRewardRoles({ roleRewards: REWARDS, level: 12, mode: 'keep', heldRoleIds: [ROLE_A, ROLE_C] });
    assert.deepEqual(plan.add, [ROLE_B]);
    assert.deepEqual(plan.remove, [], 'an unearned role someone was given by hand stays');
});

test('reward mode: highest only adds the top earned role and removes lower ones', () => {
    const plan = planRewardRoles({ roleRewards: REWARDS, level: 12, mode: 'highest', heldRoleIds: [ROLE_A] });
    assert.deepEqual(plan.add, [ROLE_B]);
    assert.deepEqual(plan.remove, [ROLE_A]);
    const none = planRewardRoles({ roleRewards: REWARDS, level: 3, mode: 'highest', heldRoleIds: [ROLE_A] });
    assert.deepEqual(none, { add: [], remove: [], want: [] }, 'below every reward: nothing changes');
    const already = planRewardRoles({ roleRewards: REWARDS, level: 25, mode: 'highest', heldRoleIds: [ROLE_C] });
    assert.deepEqual([already.add, already.remove], [[], []]);
});

test('reward mode: removeUnearned takes off roles above the level; a role shared by levels is kept', () => {
    const plan = planRewardRoles({ roleRewards: REWARDS, level: 6, mode: 'keep', heldRoleIds: [ROLE_A, ROLE_B, ROLE_C], removeUnearned: true });
    assert.deepEqual(plan.add, []);
    assert.deepEqual(plan.remove.sort(), [ROLE_B, ROLE_C].sort());
    const shared = planRewardRoles({ roleRewards: { 5: ROLE_A, 30: ROLE_A, 10: ROLE_B }, level: 12, mode: 'highest', heldRoleIds: [ROLE_A, ROLE_B], removeUnearned: true });
    assert.deepEqual(shared.remove, [ROLE_A], 'ROLE_A is a lower earned reward in highest mode');
    const keepShared = planRewardRoles({ roleRewards: { 5: ROLE_A, 30: ROLE_A }, level: 12, mode: 'keep', heldRoleIds: [ROLE_A], removeUnearned: true });
    assert.deepEqual(keepShared.remove, [], 'level 5 still earns ROLE_A');
});

// ── fake client, guild and member ─────────────────────────────────────────

function fakeClient() {
    const store = new Map();
    const chains = new Map();
    const db = {
        store,
        async get(key, defaultValue = null) { return store.has(key) ? structuredClone(store.get(key)) : defaultValue; },
        async set(key, value) { store.set(key, structuredClone(value)); return true; },
        // Serialized per key, like the row lock in Postgres.
        update(key, mutator, defaultValue = null) {
            const run = async () => {
                const current = store.has(key) ? structuredClone(store.get(key)) : structuredClone(defaultValue);
                const next = await mutator(current);
                store.set(key, structuredClone(next));
                return next;
            };
            const result = (chains.get(key) || Promise.resolve()).then(run, run);
            chains.set(key, result.catch(() => {}));
            return result;
        },
        async list(prefix) { return [...store.keys()].filter((k) => k.startsWith(prefix)); },
        async delete(key) { store.delete(key); return true; },
    };
    return { db, guilds: { cache: new Map() } };
}

function fakeGuild({ manageRoles = true } = {}) {
    const guild = { id: GUILD, name: 'Test' };
    const role = (id, name, position, perms = []) => ({ id, name, position, managed: false, guild, permissions: { has: (p) => perms.includes(p) } });
    guild.roles = {
        cache: new Map([[GUILD, role(GUILD, '@everyone', 0)], [ROLE_A, role(ROLE_A, 'Level 5', 1)], [ROLE_B, role(ROLE_B, 'Level 10', 2)],
            [ROLE_C, role(ROLE_C, 'Level 20', 3)], [ROLE_HIGH, role(ROLE_HIGH, 'Above the bot', 50)], [ROLE_STAFF, role(ROLE_STAFF, 'Staff', 4, ['BanMembers'])]]),
        fetch: async (id) => guild.roles.cache.get(id) || null,
    };
    guild.memberMap = new Map();
    guild.fetchCalls = [];
    guild.members = {
        me: { permissions: { has: () => manageRoles }, roles: { highest: { position: 10 } } },
        cache: guild.memberMap,
        // No argument: the full member list (fills the cache). With an id: one member.
        fetch: async (id) => {
            const all = id === undefined || typeof id === 'object';
            guild.fetchCalls.push(all ? 'all' : id);
            return all ? guild.memberMap : guild.memberMap.get(id) || null;
        },
    };
    guild.channels = { cache: new Map() };
    return guild;
}

function fakeMember(guild, client, heldRoleIds = [], { failAdd = false } = {}) {
    const cache = new Map(heldRoleIds.map((id) => [id, guild.roles.cache.get(id)]));
    const member = {
        id: USER, guild, client,
        user: { id: USER, bot: false, username: 'member', tag: 'member', createdTimestamp: Date.now() - 86_400_000, displayAvatarURL: () => '' },
        roles: {
            cache,
            added: [], removed: [],
            async add(role, reason) {
                if (failAdd) throw new Error('Missing Permissions');
                member.roles.added.push({ id: role.id, reason }); cache.set(role.id, role);
            },
            async remove(role, reason) { member.roles.removed.push({ id: role.id, reason }); cache.delete(role.id); },
        },
    };
    guild.memberMap.set(USER, member);
    return member;
}

async function seed(client, { rewards = REWARDS, rewardMode, level = 12 } = {}) {
    await updateLevelingConfig(client, GUILD, { roleRewards: rewards, ...(rewardMode ? { rewardMode } : {}) });
    await saveUserLevelData(client, GUILD, USER, { xp: 0, level, totalXp: 100 });
}

// ── the per-member sync ───────────────────────────────────────────────────

test('sync: keep all gives every earned role (config and level read from storage)', async () => {
    const client = fakeClient();
    await seed(client);
    const guild = fakeGuild();
    const member = fakeMember(guild, client);
    const result = await syncLevelRolesForMember(client, member, { reason: 'test' });
    assert.deepEqual(result.added.sort(), [ROLE_A, ROLE_B].sort());
    assert.deepEqual(result.removed, []);
    assert.equal(member.roles.added[0].reason, 'test');
    assert.equal(roleSyncNote(result), 'Mewvo gave 2 reward roles.');
});

test('sync: highest only gives the top earned role and takes off lower ones', async () => {
    const client = fakeClient();
    await seed(client, { rewardMode: 'highest' });
    const member = fakeMember(fakeGuild(), client, [ROLE_A]);
    const result = await syncLevelRolesForMember(client, member);
    assert.deepEqual(result.added, [ROLE_B]);
    assert.deepEqual(result.removed, [ROLE_A]);
    assert.deepEqual([...member.roles.cache.keys()], [ROLE_B]);
});

test('sync: highest only never strips the lower earned roles when the top role cannot be given', async () => {
    // Top reward above the bot (hierarchy): the member keeps ROLE_A instead of ending with none.
    const client = fakeClient();
    await seed(client, { rewardMode: 'highest', rewards: { 5: ROLE_A, 10: ROLE_HIGH, 20: ROLE_C }, level: 12 });
    const member = fakeMember(fakeGuild(), client, [ROLE_A, ROLE_C]);
    const result = await syncLevelRolesForMember(client, member, { removeUnearned: true });
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, [ROLE_C], 'a role above the level still comes off');
    assert.ok(member.roles.cache.has(ROLE_A), 'the lower earned role is kept');
    assert.ok(result.skipped.some((s) => s.roleId === ROLE_A));

    // A Discord error on the add: same.
    const client2 = fakeClient();
    await seed(client2, { rewardMode: 'highest' });
    const failing = fakeMember(fakeGuild(), client2, [ROLE_A], { failAdd: true });
    const failed = await syncLevelRolesForMember(client2, failing);
    assert.deepEqual(failed.removed, []);
    assert.ok(failing.roles.cache.has(ROLE_A));
});

test('sync: roles above the bot, staff roles and missing Manage Roles are skipped and logged, never thrown', async () => {
    const client = fakeClient();
    await seed(client, { rewards: { 1: ROLE_HIGH, 2: ROLE_STAFF, 3: ROLE_A, 4: '400000000000000099' }, level: 5 });
    const member = fakeMember(fakeGuild(), client);
    const result = await syncLevelRolesForMember(client, member);
    assert.deepEqual(result.added, [ROLE_A]);
    assert.equal(result.skipped.length, 3);
    assert.match(roleSyncNote(result), /could not be changed/);

    const noPerm = fakeMember(fakeGuild({ manageRoles: false }), client);
    const blocked = await syncLevelRolesForMember(client, noPerm);
    assert.deepEqual(blocked.added, []);
    assert.ok(blocked.skipped.every((s) => s.problem), 'every skip has a reason');

    const failing = fakeMember(fakeGuild(), client, [], { failAdd: true });
    const failed = await syncLevelRolesForMember(client, failing);
    assert.equal(failed.errors, 1, 'a Discord error is counted, not thrown');
});

test('sync: leveling off, no rewards, or a bot member changes nothing', async () => {
    const client = fakeClient();
    await seed(client);
    await updateLevelingConfig(client, GUILD, { enabled: false });
    const member = fakeMember(fakeGuild(), client);
    assert.deepEqual((await syncLevelRolesForMember(client, member)).added, []);
    await updateLevelingConfig(client, GUILD, { enabled: true });
    member.user.bot = true;
    assert.deepEqual((await syncLevelRolesForMember(client, member)).added, []);
});

test('sync: removeUnearned (an admin lowered the level) takes off reward roles above the level', async () => {
    const client = fakeClient();
    await seed(client, { level: 6 });
    const member = fakeMember(fakeGuild(), client, [ROLE_A, ROLE_B, ROLE_C]);
    const result = await syncLevelRolesForMember(client, member, { removeUnearned: true });
    assert.deepEqual(result.removed.sort(), [ROLE_B, ROLE_C].sort());
    assert.equal(roleSyncNote(result), 'Mewvo took off 2 reward roles.');
});

test('rejoin: guildMemberAdd gives back the earned reward roles (by reward mode)', async () => {
    const client = fakeClient();
    await seed(client, { rewardMode: 'highest', level: 25 });
    const guild = fakeGuild();
    const member = fakeMember(guild, client);
    await guildMemberAdd.execute(member);
    assert.deepEqual(member.roles.added.map((a) => a.id), [ROLE_C], 'only the highest earned reward');
    assert.match(member.roles.added[0].reason, /rejoined/);

    const keepClient = fakeClient();
    await seed(keepClient, { level: 12 });
    const keepGuild = fakeGuild();
    const keepMember = fakeMember(keepGuild, keepClient);
    await guildMemberAdd.execute(keepMember);
    assert.deepEqual(keepMember.roles.added.map((a) => a.id).sort(), [ROLE_A, ROLE_B].sort());
});

test('rejoin: a role the bot cannot give does not stop the join pipeline', async () => {
    const client = fakeClient();
    await seed(client, { rewards: { 1: ROLE_HIGH }, level: 3 });
    const member = fakeMember(fakeGuild(), client);
    await assert.doesNotReject(guildMemberAdd.execute(member));
    assert.deepEqual(member.roles.added, []);
});

test('startup reconcile uses the same rule (highest only removes lower rewards)', async () => {
    const client = fakeClient();
    await seed(client, { rewardMode: 'highest', level: 12 });
    const guild = fakeGuild();
    fakeMember(guild, client, [ROLE_A]);
    client.guilds.cache.set(GUILD, guild);
    const summary = await reconcileLevelRoles(client);
    assert.equal(summary.rolesReAwarded, 1);
    assert.equal(summary.rolesRemoved, 1);
    assert.equal(summary.errors, 0);
});

test('startup reconcile: a Discord error on the role check keeps the reward; only Unknown Role (null) prunes it', async () => {
    const GONE = '400000000000000099';
    const FLAKY = '400000000000000098';
    const client = fakeClient();
    await seed(client, { rewards: { 5: ROLE_A, 30: GONE, 40: FLAKY }, level: 12 });
    const guild = fakeGuild();
    guild.roles.fetch = async (id) => {
        if (id === FLAKY) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
        return guild.roles.cache.get(id) || null;
    };
    fakeMember(guild, client);
    client.guilds.cache.set(GUILD, guild);
    const summary = await reconcileLevelRoles(client);
    assert.equal(summary.prunedRewardEntries, 1, 'only the unknown role');
    const rewards = (await getLevelingConfig(client, GUILD)).roleRewards;
    assert.equal(rewards[30], undefined, 'Unknown Role pruned');
    assert.equal(rewards[40], FLAKY, 'kept after a Discord error');
    assert.equal(rewards[5], ROLE_A);
});

test('startup reconcile: one full member fetch, former members skipped without a fetch or level read', async () => {
    const client = fakeClient();
    await seed(client, { level: 12 });
    const departed = ['700000000000000001', '700000000000000002', '700000000000000003'];
    for (const id of departed) await saveUserLevelData(client, GUILD, id, { xp: 0, level: 30, totalXp: 9000 });
    const guild = fakeGuild();
    const member = fakeMember(guild, client);
    client.guilds.cache.set(GUILD, guild);
    const reads = [];
    const get = client.db.get.bind(client.db);
    client.db.get = async (key, d) => { reads.push(key); return get(key, d); };
    const summary = await reconcileLevelRoles(client);
    assert.deepEqual(guild.fetchCalls, ['all'], 'one full fetch, no per-id REST');
    assert.ok(!reads.some((key) => departed.some((id) => key.endsWith(id))), 'no level read for former members');
    assert.deepEqual(member.roles.added.map((a) => a.id).sort(), [ROLE_A, ROLE_B].sort());
    assert.equal(summary.skippedGuilds, 0);
    assert.equal(summary.errors, 0);
});

test('startup reconcile: a failed or timed-out member fetch skips the guild (no per-id fetches)', async () => {
    for (const mode of ['fail', 'hang']) {
        const client = fakeClient();
        await seed(client, { level: 12 });
        const guild = fakeGuild();
        const member = fakeMember(guild, client);
        guild.members.fetch = async (id) => {
            guild.fetchCalls.push(id === undefined || typeof id === 'object' ? 'all' : id);
            if (mode === 'fail') throw new Error('gateway down');
            return new Promise(() => {});
        };
        client.guilds.cache.set(GUILD, guild);
        const summary = await reconcileLevelRoles(client, null, { fetchTimeoutMs: 20 });
        assert.deepEqual(guild.fetchCalls, ['all'], mode);
        assert.equal(summary.skippedGuilds, 1, mode);
        assert.deepEqual(member.roles.added, [], mode);
    }
});

// ── the boost service ─────────────────────────────────────────────────────

async function assertValidation(promise, word) {
    await assert.rejects(promise, (error) => {
        assert.ok(error instanceof TitanBotError);
        assert.equal(error.type, ErrorTypes.VALIDATION);
        if (word) assert.match(error.userMessage, word);
        return true;
    });
}

test('setLevelBoost: sets and removes one boost, keeps the others; refuses bad values', async () => {
    const client = fakeClient();
    await Promise.all([
        setLevelBoost(client, GUILD, 'channel', CH, 2),
        setLevelBoost(client, GUILD, 'role', ROLE_A, 1.5),
        setLevelBoost(client, GUILD, 'role', ROLE_B, 3),
    ]);
    let cfg = await getLevelingConfig(client, GUILD);
    assert.deepEqual(cfg.channelMultipliers, { [CH]: 2 });
    assert.deepEqual(cfg.roleMultipliers, { [ROLE_A]: 1.5, [ROLE_B]: 3 });
    const { before, after, field } = await setLevelBoost(client, GUILD, 'role', ROLE_A, null);
    assert.equal(field, 'roleMultipliers');
    assert.equal(before.roleMultipliers[ROLE_A], 1.5);
    assert.deepEqual(after.roleMultipliers, { [ROLE_B]: 3 });

    await assertValidation(setLevelBoost(client, GUILD, 'channel', CH, 5.5), /between 1.1 and 5/);
    await assertValidation(setLevelBoost(client, GUILD, 'channel', CH, 1.25), /one decimal/);
    await assertValidation(setLevelBoost(client, GUILD, 'user', CH, 2), /channel or a role/);
    await assertValidation(setLevelBoost(client, GUILD, 'role', 'abc', 2), /not valid/);
    await assertValidation(updateLevelingConfig(client, GUILD, { rewardMode: 'all' }), /Reward mode/);
    await assertValidation(updateLevelingConfig(client, GUILD, { roleMultipliers: { [ROLE_A]: 9 } }), /Role boosts/);
    await assertValidation(saveLevelingConfig(client, GUILD, { channelMultipliers: { nope: 2 } }), /Channel boosts/);
    cfg = await getLevelingConfig(client, GUILD);
    assert.deepEqual(cfg.roleMultipliers, { [ROLE_B]: 3 }, 'nothing changed by refused writes');
});

test('setLevelBoost: at most 50 boosts per kind', async () => {
    const client = fakeClient();
    const map = {};
    for (let i = 0; i < 50; i++) map[`4100000000000000${String(i).padStart(2, '0')}`] = 2;
    await updateLevelingConfig(client, GUILD, { channelMultipliers: map });
    await assertValidation(setLevelBoost(client, GUILD, 'channel', CH, 2), /At most 50/);
    await setLevelBoost(client, GUILD, 'channel', '410000000000000000', 3);
    assert.equal((await getLevelingConfig(client, GUILD)).channelMultipliers['410000000000000000'], 3, 'changing an existing one is fine');
});
