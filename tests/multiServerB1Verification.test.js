// Multi-server B1 (verification, OAuth, member restore): a member restore only uses the
// guilds.join tokens of members verified in the target's servers, the alt check only compares
// IP hashes within one server, and a server without verification set up says so clearly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    allowedRestoreGuildIds, backupSummary, banGuildFor, mayRestoreInto, restorableUserIds, restoreMembers, restoreRefusal,
} from '../src/services/memberBackupService.js';
import { bannedOnSameNetwork, guardScope, pruneVerificationIpHashes, recordIpHash } from '../src/services/verificationGuard.js';
import { recordAuthorization, markVerifiedIn, verifiedGuildsOf } from '../src/services/oauthVerification.js';
import { VERIFICATION_NOT_SET_UP, verificationSetupProblem } from '../src/services/verificationService.js';
import { handleVerificationReview } from '../src/handlers/verificationReview.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const A = '300000000000000001'; // another server
const B = '300000000000000002'; // a third server
const config = { mainGuildId: MAIN, supportGuildId: SUPPORT };
const env = {};

const LEGACY = '400000000000000001'; // token from before v12: no rows
const IN_MAIN = '400000000000000002';
const IN_A = '400000000000000003';
const IN_A_AND_MAIN = '400000000000000004';
const HELD_IN_A = '400000000000000005'; // authorized in A, never verified (held / denied)
const IN_SUPPORT = '400000000000000006';
const verified = new Map([
    [IN_MAIN, new Set([MAIN])],
    [IN_A, new Set([A])],
    [IN_A_AND_MAIN, new Set([A, MAIN])],
    [HELD_IN_A, new Set()],
    [IN_SUPPORT, new Set([SUPPORT])],
]);
const everyone = [LEGACY, IN_MAIN, IN_A, IN_A_AND_MAIN, HELD_IN_A, IN_SUPPORT];
const deps = { config, env, listUsers: async () => everyone, verifiedOf: async (ids) => new Map([...verified].filter(([id]) => ids.includes(id))) };

test('restore scope: verified in A is never pulled into B, the main server or the support server', async () => {
    assert.deepEqual(await restorableUserIds(B, deps), [], 'nobody verified in B');
    assert.deepEqual(await restorableUserIds(A, deps), [IN_A, IN_A_AND_MAIN], 'only A\'s own verifications');
    const home = [LEGACY, IN_MAIN, IN_A_AND_MAIN, IN_SUPPORT];
    assert.deepEqual(await restorableUserIds(MAIN, deps), home, 'main: home verifications and pre-v12 tokens, not A-only members');
    assert.deepEqual(await restorableUserIds(SUPPORT, deps), home, 'support: same set; a verification in A never adds anyone to Support');
});

test('restore scope: a replacement server in MEMBER_RESTORE_GUILD_IDS counts as home; held members count nowhere', async () => {
    const REPLACEMENT = '100000000000000009';
    const withReplacement = { ...deps, env: { MEMBER_RESTORE_GUILD_IDS: REPLACEMENT } };
    assert.deepEqual(await restorableUserIds(REPLACEMENT, withReplacement), [LEGACY, IN_MAIN, IN_A_AND_MAIN, IN_SUPPORT]);
    const homeIds = allowedRestoreGuildIds(config, env);
    assert.equal(mayRestoreInto(new Set(), A, homeIds), false, 'authorized in A but never verified');
    assert.equal(mayRestoreInto(new Set(), MAIN, homeIds), false, 'rows but none verified: not legacy');
    assert.equal(mayRestoreInto(undefined, A, homeIds), false, 'a pre-v12 token never goes to another server');
    assert.equal(mayRestoreInto(undefined, MAIN, homeIds), true);
});

test('restoreMembers adds only the scoped members and checks bans in the target\'s server', async () => {
    const added = [];
    const banChecks = [];
    const counts = await restoreMembers({}, { id: MAIN, name: 'Main' }, async () => {}, {
        ...deps,
        addMember: async (_client, guildId, userId) => { added.push(`${guildId}:${userId}`); return 'added'; },
        activeBan: async (guildId, userId) => { banChecks.push(guildId); return userId === IN_SUPPORT ? { case_code: 'abcde' } : null; },
        dbAvailable: () => true,
        pauseMs: 0,
    });
    assert.deepEqual(added, [LEGACY, IN_MAIN, IN_A_AND_MAIN].map((id) => `${MAIN}:${id}`));
    assert.equal(counts.total, 4);
    assert.equal(counts.skippedBanned, 1);
    assert.ok(banChecks.every((id) => id === MAIN));
    assert.equal(banGuildFor(SUPPORT, config, env), MAIN, 'home targets: the main server\'s bans, as before');
    assert.equal(banGuildFor(A, config, env), A, 'another server: its own bans');
});

test('restore into another server is still refused (Privacy Policy), before any token is read', async () => {
    assert.match(restoreRefusal(A, config, env), /only be restored into Mewvo's own servers/);
    let listed = false;
    await assert.rejects(
        restoreMembers({}, { id: A, name: 'A' }, async () => {}, { ...deps, listUsers: async () => { listed = true; return []; } }),
        /only be restored into Mewvo's own servers/
    );
    assert.equal(listed, false);
});

test('backupSummary counts only who may be restored into that server; a database error throws', async () => {
    const guild = { id: MAIN, members: { cache: new Map([[IN_MAIN, {}], [IN_A, {}]]) } };
    assert.deepEqual(await backupSummary(guild, MAIN, deps), { stored: 4, inGuild: 1 });
    await assert.rejects(backupSummary(guild, MAIN, { ...deps, listUsers: async () => { throw new Error('db down'); } }), /db down/);
});

test('recordAuthorization: a fresh token clears stale rows; a pre-v12 token keeps its home server; unknown leaves rows alone', async () => {
    const run = async (hadToken) => {
        const seen = [];
        await recordAuthorization(IN_A, A, { hadToken, homeGuildId: MAIN, q: async (text, params) => { seen.push({ text, params }); return { rowCount: 1 }; } });
        return seen;
    };
    const fresh = await run(false);
    assert.equal(fresh.length, 2);
    assert.match(fresh[0].text, /^DELETE FROM oauth_verified_guilds WHERE user_id = \$1/);
    assert.match(fresh[1].text, /INSERT INTO oauth_verified_guilds/);
    assert.deepEqual(fresh[1].params, [IN_A, A]);

    const legacy = await run(true);
    assert.equal(legacy.length, 2);
    assert.match(legacy[0].text, /WHERE NOT EXISTS/, 'the home row only when the user has no rows yet');
    assert.deepEqual(legacy[0].params, [IN_A, MAIN]);
    assert.deepEqual(legacy[1].params, [IN_A, A]);

    const unknown = await run(null);
    assert.equal(unknown.length, 1);
    assert.match(unknown[0].text, /INSERT INTO/);
});

test('verifiedGuildsOf / markVerifiedIn: only verified rows count; no rows means a pre-v12 token', async () => {
    const q = async () => ({ rows: [
        { user_id: IN_A, guild_id: A, verified_at: new Date() },
        { user_id: HELD_IN_A, guild_id: A, verified_at: null },
    ] });
    const map = await verifiedGuildsOf([IN_A, HELD_IN_A, LEGACY], { q });
    assert.deepEqual([...map.get(IN_A)], [A]);
    assert.deepEqual([...map.get(HELD_IN_A)], []);
    assert.equal(map.has(LEGACY), false);
    assert.equal((await verifiedGuildsOf([], { q: async () => { throw new Error('not called'); } })).size, 0);
    assert.equal(await markVerifiedIn(IN_A, A, { q: async (text, params) => { assert.deepEqual(params, [IN_A, A]); return { rowCount: 0 }; } }), false);
});

test('IP checks: another server only sees its own rows and bans; home servers share theirs and the pre-v12 table', async () => {
    assert.deepEqual(guardScope(A, config), { guildIds: [A], legacy: false });
    assert.deepEqual(guardScope(MAIN, config), { guildIds: [MAIN, SUPPORT], legacy: true });
    assert.deepEqual(guardScope(SUPPORT, config), { guildIds: [MAIN, SUPPORT], legacy: true });
    assert.deepEqual(guardScope(null, config), { guildIds: [], legacy: false });

    const seen = [];
    const q = async (text, params) => { seen.push({ text, params }); return { rows: [] }; };
    await bannedOnSameNetwork(A, IN_A, 'h'.repeat(64), { q, config });
    assert.deepEqual(seen[0].params[2], [A], 'IP rows and bans of A only');
    assert.equal(seen[0].params[4], false, 'the pre-v12 (home) table is not read for A');
    assert.match(seen[0].text, /guild_id = ANY\(\$3\)[\s\S]*c\.guild_id = ANY\(\$3\)/);
    await bannedOnSameNetwork(MAIN, IN_MAIN, 'h'.repeat(64), { q, config });
    assert.deepEqual(seen[1].params[2], [MAIN, SUPPORT]);
    assert.equal(seen[1].params[4], true);
    assert.deepEqual(await bannedOnSameNetwork('', IN_A, 'h', { q: async () => { throw new Error('not called'); }, config }), []);

    await recordIpHash(A, IN_A, 'h'.repeat(64), { q });
    assert.match(seen[2].text, /INSERT INTO verification_guild_ips \(guild_id, user_id, ip_hash, seen_at\)/);
    assert.deepEqual(seen[2].params, [A, IN_A, 'h'.repeat(64)]);
});

test('IP prune: both tables, bounded together; a ban keeps rows only in its own server (home: any home server)', async () => {
    const seen = [];
    const q = async (text, params) => { seen.push({ text, params }); return { rowCount: 2 }; };
    assert.equal(await pruneVerificationIpHashes({ q, limit: 5, config }), 4);
    assert.match(seen[0].text, /DELETE FROM verification_ips /);
    assert.match(seen[1].text, /DELETE FROM verification_guild_ips /);
    assert.match(seen[1].text, /c\.guild_id = v\.guild_id OR \(v\.guild_id = ANY\(\$2\) AND c\.guild_id = ANY\(\$2\)\)/);
    assert.deepEqual(seen[0].params[1], [MAIN, SUPPORT]);
    assert.equal(seen[0].params[4], 5);
    assert.equal(seen[1].params[4], 3, 'what is left of the limit');
});

test('verificationSetupProblem: a server without verification gets a clear message', async () => {
    const guild = (roles = ['r1']) => ({ roles: { cache: new Map(roles.map((id) => [id, {}])) } });
    const client = (g) => ({ guilds: { cache: new Map(g ? [[A, g]] : []) } });
    const read = (verification) => async () => ({ verification });
    assert.equal(await verificationSetupProblem(client(guild()), A, { readConfig: read(undefined) }), VERIFICATION_NOT_SET_UP);
    assert.equal(await verificationSetupProblem(client(guild()), A, { readConfig: read({ enabled: false, roleId: 'r1' }) }), VERIFICATION_NOT_SET_UP);
    assert.equal(await verificationSetupProblem(client(guild()), A, { readConfig: read({ enabled: true }) }), VERIFICATION_NOT_SET_UP);
    assert.match(await verificationSetupProblem(client(guild([])), A, { readConfig: read({ enabled: true, roleId: 'r1' }) }), /role of this server no longer exists/);
    assert.match(await verificationSetupProblem(client(null), A, { readConfig: read({ enabled: true, roleId: 'r1' }) }), /not in that server/);
    assert.equal(await verificationSetupProblem(client(guild()), A, { readConfig: read({ enabled: true, roleId: 'r1' }) }), null);
    assert.match(VERIFICATION_NOT_SET_UP, /\/verification setup/);
    await assert.rejects(verificationSetupProblem(client(guild()), A, { readConfig: async () => { throw new Error('db down'); } }), /db down/);
});

test('verifyreview: an Administrator of another server cannot decide a held verification', async () => {
    const replies = [];
    const interaction = {
        id: '900000000000000001', createdTimestamp: Date.now(), guildId: B, guild: { id: B }, member: { permissions: { has: () => true } }, user: { id: IN_MAIN, username: 'admin' },
        replied: false, deferred: false, isRepliable: () => true, isChatInputCommand: () => false,
        reply: async (payload) => { replies.push(payload); interaction.replied = true; },
        followUp: async (payload) => { replies.push(payload); },
        editReply: async (payload) => { replies.push(payload); },
    };
    let verifiedCalled = false;
    const client = { users: { fetch: async () => { verifiedCalled = true; } }, guilds: { cache: new Map() } };
    await handleVerificationReview(interaction, client, ['approve', A, IN_A]);
    assert.equal(verifiedCalled, false, 'nothing about the member is looked up');
    assert.equal(replies.length, 1);
    assert.match(JSON.stringify(replies[0]), /belongs to another server/);
});

test('verifyreview: a held support-server verification is decided in the main server (its staff server)', async () => {
    const { enforcementConfig } = await import('../src/config/enforcement.js');
    const saved = { main: enforcementConfig.mainGuildId, env: { MAIN_GUILD_ID: process.env.MAIN_GUILD_ID, SUPPORT_GUILD_ID: process.env.SUPPORT_GUILD_ID } };
    enforcementConfig.mainGuildId = MAIN;
    Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT });
    try {
        const replies = [];
        const interaction = {
            id: '900000000000000002', createdTimestamp: Date.now(), guildId: MAIN, guild: { id: MAIN },
            member: { permissions: { has: () => false } }, user: { id: IN_MAIN, username: 'mod' },
            replied: false, deferred: false, isRepliable: () => true, isChatInputCommand: () => false,
            reply: async (payload) => { replies.push(payload); interaction.replied = true; },
            followUp: async (payload) => { replies.push(payload); },
            editReply: async (payload) => { replies.push(payload); },
        };
        // No real guild here: it gets past the server check and then fails at verifyUser ("Guild … not found").
        const error = await handleVerificationReview(interaction, { users: { fetch: async () => null }, guilds: { cache: new Map() } }, ['approve', SUPPORT, IN_SUPPORT])
            .then(() => null, (e) => e);
        assert.doesNotMatch(JSON.stringify(replies), /belongs to another server/, 'the main server may decide support cards');
        assert.match(String(error?.message), /Guild 100000000000000002 not found/, 'it reached the verify step');
    } finally {
        enforcementConfig.mainGuildId = saved.main;
        for (const [k, v] of Object.entries(saved.env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
});
