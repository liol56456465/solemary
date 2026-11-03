// Level data is kept when a member leaves (owner, 2026-11-03): the leave handler no longer
// deletes it, and the leaderboard skips members who are known to have left.

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    LEADERBOARD_MAX_OFFSET, getLeaderboard, getUserLevelData, resetLeaderboardLeftCacheForTests, saveUserLevelData,
} from '../src/services/leveling/leveling.js';
import { getUserLevelKey } from '../src/utils/database/keys.js';
import guildMemberRemove from '../src/events/guildMemberRemove.js';

const GUILD = '500000000000000001';

beforeEach(() => resetLeaderboardLeftCacheForTests());
const id = (n) => `5100000000000000${String(n).padStart(2, '0')}`;

function memoryDb() {
    const store = new Map();
    return {
        store,
        async get(key, defaultValue = null) { return store.has(key) ? structuredClone(store.get(key)) : defaultValue; },
        async set(key, value) { store.set(key, structuredClone(value)); return true; },
        async update(key, mutator, defaultValue = null) {
            const next = await mutator(store.has(key) ? structuredClone(store.get(key)) : structuredClone(defaultValue));
            store.set(key, structuredClone(next));
            return next;
        },
        async list(prefix) { return [...store.keys()].filter((k) => k.startsWith(prefix)); },
        async delete(key) { store.delete(key); return true; },
    };
}

/** A guild whose cache holds `cached`; a fetch finds `fetchable` (or throws when fetchFails). */
function fakeGuild({ cached = [], fetchable = [], fetchFails = false } = {}) {
    const member = (userId) => ({ id: userId, user: { id: userId, username: `user${userId.slice(-2)}` } });
    const cache = new Map(cached.map((userId) => [userId, member(userId)]));
    const fetchCalls = [];
    const guild = {
        id: GUILD,
        members: {
            cache,
            async fetch({ user }) {
                fetchCalls.push(user);
                if (fetchFails) throw new Error('gateway down');
                const found = new Map(user.filter((u) => fetchable.includes(u)).map((u) => [u, member(u)]));
                for (const [k, v] of found) cache.set(k, v);
                return found;
            },
        },
    };
    return { guild, fetchCalls };
}

function clientWith(guild, { postgresRows = null } = {}) {
    const db = memoryDb();
    const reads = [];
    if (postgresRows) {
        db.rows = () => ({
            topUserLevels: async (guildId, limit, offset) => {
                reads.push([limit, offset]);
                return postgresRows.slice(offset, offset + limit);
            },
        });
    }
    return { db, reads, guilds: { cache: new Map([[GUILD, guild]]) }, users: { cache: new Map() } };
}

// 12 ranked rows: user 1 has the most XP.
const ROWS = Array.from({ length: 12 }, (_, i) => ({ userId: id(i + 1), xp: 0, level: 30 - i, totalXp: 10000 - i * 100 }));

test('leaderboard: members who left are skipped and ranks count only the members shown', async () => {
    const present = ROWS.map((r) => r.userId).filter((u) => u !== id(2) && u !== id(5));
    const { guild, fetchCalls } = fakeGuild({ cached: present.slice(0, 4), fetchable: present.slice(4) });
    const client = clientWith(guild, { postgresRows: ROWS });
    const page1 = await getLeaderboard(client, GUILD, 5, 0);
    assert.deepEqual(page1.map((e) => e.userId), [id(1), id(3), id(4), id(6), id(7)]);
    assert.deepEqual(page1.map((e) => e.rank), [1, 2, 3, 4, 5]);
    assert.ok(page1.every((e) => !e.username.startsWith('Unknown user')), 'no unknown users shown');
    assert.equal(fetchCalls.length, 1, 'one fetch for the uncached ids of the batch');

    const page2 = await getLeaderboard(client, GUILD, 5, 5);
    assert.deepEqual(page2.map((e) => e.userId), [id(8), id(9), id(10), id(11), id(12)]);
    assert.deepEqual(page2.map((e) => e.rank), [6, 7, 8, 9, 10]);
    assert.deepEqual(await getLeaderboard(client, GUILD, 5, 10), [], 'past the end');
});

test('leaderboard: a failed member fetch never hides anyone (fallback name instead)', async () => {
    const { guild } = fakeGuild({ cached: [id(1)], fetchFails: true });
    const client = clientWith(guild, { postgresRows: ROWS.slice(0, 3) });
    const page = await getLeaderboard(client, GUILD, 10, 0);
    assert.deepEqual(page.map((e) => e.userId), [id(1), id(2), id(3)]);
    assert.equal(page[1].username, `Unknown user (${id(2)})`);
});

test('leaderboard: fetchMissing false (the website) never fetches and keeps uncached members listed', async () => {
    const { guild, fetchCalls } = fakeGuild({ cached: [id(1)] });
    const client = clientWith(guild, { postgresRows: ROWS.slice(0, 3) });
    const page = await getLeaderboard(client, GUILD, 10, 0, { fetchMissing: false });
    assert.equal(page.length, 3);
    assert.equal(fetchCalls.length, 0);
});

test('leaderboard: reads past the first batch when many top members left (Postgres, steps of 100)', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ userId: `52000000000000${String(i).padStart(4, '0')}`, xp: 0, level: 500 - i, totalXp: 100000 - i }));
    const stayed = many.slice(120).map((r) => r.userId);
    const { guild } = fakeGuild({ fetchable: stayed });
    const client = clientWith(guild, { postgresRows: many });
    const page = await getLeaderboard(client, GUILD, 10, 0);
    assert.deepEqual(page.map((e) => e.userId), stayed.slice(0, 10));
    assert.deepEqual(client.reads, [[100, 0], [100, 100]]);
});

test('leaderboard: the memory store fallback skips members who left too', async () => {
    const { guild } = fakeGuild({ cached: [id(1), id(3)] });
    const client = clientWith(guild);
    for (const row of ROWS.slice(0, 3)) await saveUserLevelData(client, GUILD, row.userId, row);
    const page = await getLeaderboard(client, GUILD, 10, 0);
    assert.deepEqual(page.map((e) => [e.rank, e.userId]), [[1, id(1)], [2, id(3)]]);
});

test('leaving the server keeps the member level data', async () => {
    const userId = id(1);
    const db = memoryDb();
    const client = { db, guilds: { cache: new Map() }, users: { cache: new Map() } };
    await saveUserLevelData(client, GUILD, userId, { xp: 5, level: 12, totalXp: 2000 });
    const guild = { id: GUILD, name: 'Test', memberCount: 10, channels: { cache: new Map() }, roles: { cache: new Map() }, members: { cache: new Map() } };
    const member = {
        id: userId, guild, client, roles: { cache: new Map() },
        user: { id: userId, bot: false, username: 'left', tag: 'left', displayAvatarURL: () => '' },
    };
    await guildMemberRemove.execute(member);
    assert.ok(db.store.has(getUserLevelKey(GUILD, userId)), 'level row still stored');
    assert.equal((await getUserLevelData(client, GUILD, userId)).level, 12);
});

test('leaderboard abuse bounds: at most 2 member fetches per call, leavers remembered, deep pages refused', async () => {
    // 400 rows, nobody cached or fetchable: without a bound this would be 4 fetches per call.
    const many = Array.from({ length: 400 }, (_, i) => ({ userId: `53000000000000${String(i).padStart(4, '0')}`, xp: 0, level: 900 - i, totalXp: 900000 - i }));
    const { guild, fetchCalls } = fakeGuild();
    const client = clientWith(guild, { postgresRows: many });
    const page = await getLeaderboard(client, GUILD, 10, 0);
    assert.equal(fetchCalls.length, 2, 'two fetch batches, then uncached members stay listed');
    assert.deepEqual(page.map((e) => e.userId), many.slice(200, 210).map((r) => r.userId));
    // Second call: the first 200 leavers come from memory (no fetch); the next two batches use the budget.
    await getLeaderboard(client, GUILD, 10, 0);
    assert.equal(fetchCalls.length, 4);
    assert.deepEqual(fetchCalls[2], many.slice(200, 300).map((r) => r.userId));
    // A remembered leaver who rejoined (back in the cache) is shown again.
    guild.members.cache.set(many[0].userId, { id: many[0].userId, user: { id: many[0].userId, username: 'back' } });
    assert.equal((await getLeaderboard(client, GUILD, 10, 0))[0].userId, many[0].userId);
    const before = client.reads.length;
    assert.deepEqual(await getLeaderboard(client, GUILD, 10, LEADERBOARD_MAX_OFFSET + 10), []);
    assert.equal(client.reads.length, before, 'a page past the limit reads nothing');
});
