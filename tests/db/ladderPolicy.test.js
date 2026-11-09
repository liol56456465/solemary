// Warn ladder decision (beginner audit D4) against the local test database (npm run test:db):
// automod warns in another server are recorded with counts_toward_level NULL, the locked ladder row
// (SELECT … FOR UPDATE) does not move, they never count, and removing one does not lower the count.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const runId = String(Date.now()).slice(-9);
const GUILD = `7${runId}00000041`; // never a home server
const GUILD_COUNTS = `7${runId}00000042`;
const TARGET = `6${runId}00000041`;
const MOD = `6${runId}00000042`;
const BOT = `5${runId}00000041`;

let pgDb, db, enforcement, caseService, guildSettings;

function fakeGuild(guildId) {
    const bans = [];
    const botUser = { id: BOT, username: 'Mewvo', bot: true };
    const client = { user: botUser, guilds: { cache: new Map() }, users: { fetch: async () => null } };
    const guild = { id: guildId, name: 'Ladder test', ownerId: '999999999999999999', client, channels: { cache: new Map(), fetch: async () => null }, roles: { cache: new Map() } };
    client.guilds.cache.set(guildId, guild);
    const me = { id: BOT, user: botUser, guild, permissions: { has: () => true }, roles: { highest: { position: 100 }, cache: new Map() } };
    const target = {
        id: TARGET, guild, user: { id: TARGET, username: 'target' },
        roles: { highest: { position: 1 }, cache: new Map(), add: async () => {}, remove: async () => {} },
        permissions: { has: () => false },
    };
    const moderator = { id: MOD, guild, user: { id: MOD, username: 'mod' }, permissions: { has: () => true }, roles: { highest: { position: 50 }, cache: new Map() } };
    guild.members = {
        me, cache: new Map([[TARGET, target]]),
        fetch: async (id) => { if (id === TARGET) return target; throw new Error('Unknown member'); },
        fetchMe: async () => me,
        ban: async (id) => { bans.push(id); },
        unban: async () => {},
    };
    guild.bans = { fetch: async () => null };
    const targetUser = { id: TARGET, username: 'target', send: async () => ({ id: 'm1', channelId: 'c1' }) };
    return { guild, targetUser, moderator, bans };
}

const automodFlow = (n) => ({
    type: 'warn', reason: 'Automod: Spam', reasonSource: 'prebuilt', reasonKey: 'automod:spam',
    durationMs: null, unappealable: false, name: `target warn ${n}`, nameIsDefault: false,
});

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    enforcement = await import('../../src/services/enforcement/enforcementService.js');
    caseService = await import('../../src/services/enforcement/caseService.js');
    guildSettings = await import('../../src/services/settings/guildSettings.js');
    // The two servers' settings rows, as the cache holds them (no row written).
    guildSettings.setSettingsCacheForTests(GUILD, {});
    guildSettings.setSettingsCacheForTests(GUILD_COUNTS, { automodWarnsCountOnLadder: true });
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_cases WHERE guild_id = ANY($1)', [[GUILD, GUILD_COUNTS]]);
    await pgDb.pool.query('DELETE FROM mod_ladder WHERE guild_id = ANY($1)', [[GUILD, GUILD_COUNTS]]);
    await pgDb.pool.query('DELETE FROM bot_dm_log WHERE guild_id = ANY($1)', [[GUILD, GUILD_COUNTS]]).catch(() => {});
    guildSettings.resetSettingsCacheForTests();
    await pgDb.disconnect();
});

test('another server: automod warns are recorded uncounted; the ladder row stays; staff warns still count', { skip }, async () => {
    const { guild, targetUser, moderator, bans } = fakeGuild(GUILD);
    for (const n of [1, 2, 3]) {
        const result = await enforcement.executeSystemAction({ guild, targetUser, flow: automodFlow(n) });
        assert.equal(result.countsOnLadder, false);
    }
    assert.deepEqual(bans, [], 'three automod hits: no automatic ban');
    const ladder = await enforcement.getLadder(GUILD, TARGET);
    assert.equal(ladder.level, 0);
    assert.equal(ladder.warns_since_level, 0);
    const uncounted = await caseService.getUncountedWarns(GUILD, TARGET);
    assert.equal(uncounted.length, 3);
    assert.ok(uncounted.every((row) => row.counts_toward_level === null && row.ladder_level_after === 0));
    assert.equal((await caseService.getCountedWarns(GUILD, TARGET, 0)).length, 0);

    // A staff warn counts as before (1 of 3), and removing an uncounted warn does not lower it.
    const staff = await enforcement.executeAction({ guild, moderator, targetUser, flow: { ...automodFlow(4), reason: 'Spam', reasonKey: 'spam' } });
    assert.equal(staff.countsOnLadder, true);
    assert.equal((await enforcement.getLadder(GUILD, TARGET)).warns_since_level, 1);
    const removed = await enforcement.revokeWarn(GUILD, uncounted[0].case_code, MOD, 'mistake');
    assert.equal(removed.lowered, false);
    assert.equal((await enforcement.getLadder(GUILD, TARGET)).warns_since_level, 1);
    const state = await enforcement.getTargetState(guild, TARGET);
    assert.equal(state.uncountedWarns, 2);
});

test('another server with "automod warns count" on: the third automod warn is an automatic ban', { skip }, async () => {
    const { guild, targetUser, bans } = fakeGuild(GUILD_COUNTS);
    for (const n of [1, 2, 3]) await enforcement.executeSystemAction({ guild, targetUser, flow: automodFlow(n) });
    assert.deepEqual(bans, [TARGET]);
    const ladder = await enforcement.getLadder(GUILD_COUNTS, TARGET);
    assert.equal(ladder.level, 1);
    assert.equal(ladder.warns_since_level, 0);
    const { rows } = await pgDb.pool.query(
        `SELECT type, counts_toward_level, is_auto FROM mod_cases WHERE guild_id = $1 ORDER BY id`, [GUILD_COUNTS]);
    assert.deepEqual(rows.map((r) => [r.type, r.counts_toward_level, r.is_auto]), [['warn', 0, false], ['warn', 0, false], ['warn', 0, false], ['ban', null, true]]);
});

test('warn ladder off: staff warns never ban, the ladder row stays', { skip }, async () => {
    guildSettings.setSettingsCacheForTests(GUILD, { warnLadderEnabled: false });
    try {
        const { guild, targetUser, moderator, bans } = fakeGuild(GUILD);
        const before = await enforcement.getLadder(GUILD, TARGET);
        for (const n of [5, 6, 7]) {
            const result = await enforcement.executeAction({ guild, moderator, targetUser, flow: { ...automodFlow(n), reason: 'Spam', reasonKey: 'spam' } });
            assert.equal(result.countsOnLadder, false);
        }
        assert.deepEqual(bans, []);
        const after = await enforcement.getLadder(GUILD, TARGET);
        assert.equal(after.enabled, false);
        assert.equal(after.warns_since_level, before.warns_since_level);
        assert.equal(after.level, before.level);
    } finally {
        guildSettings.setSettingsCacheForTests(GUILD, {});
    }
});
