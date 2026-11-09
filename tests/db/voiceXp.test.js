// Voice XP against the local test database (voice_activity, schema v14): the UPSERT makes the
// guilds/users rows, adds time and XP, restarts the day count on a new UTC day; reads and the
// leaderboard query; a failing UPSERT throws and no XP is given; /wipedata and the level reset
// delete the member's voice row only. Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, store, voiceXp, wipe, leveling, keys;
const runId = String(Date.now()).slice(-9);
const guildId = `7${runId}00000051`;
const user = (n) => `7${runId}000001${String(n).padStart(2, '0')}`;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    store = await import('../../src/services/leveling/voiceStore.js');
    voiceXp = await import('../../src/services/leveling/voiceXp.js');
    wipe = await import('../../src/services/wipedataService.js');
    leveling = await import('../../src/services/leveling/leveling.js');
    keys = await import('../../src/utils/database/keys.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM voice_activity WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.pool.query('DELETE FROM user_levels WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.disconnect();
});

test('voice store: UPSERT creates the row (users/guilds first), adds up, and restarts the day count on a new UTC day', { skip }, async () => {
    const me = user(1);
    assert.equal(await store.readDayMinutes(guildId, me, '2026-11-09'), 0, 'nothing stored');
    assert.equal(await store.readVoiceStats(guildId, me), null);
    assert.equal(await store.upsertMinutes(guildId, me, { day: '2026-11-09', seconds: 60, xp: 5 }), 1);
    assert.equal(await store.upsertMinutes(guildId, me, { day: '2026-11-09', seconds: 60, xp: 0 }), 2);
    assert.equal(await store.readDayMinutes(guildId, me, '2026-11-09'), 2);
    assert.equal(await store.readDayMinutes(guildId, me, '2026-11-10'), 0, 'another day: 0');
    assert.equal(await store.upsertMinutes(guildId, me, { day: '2026-11-10', seconds: 60, xp: 7 }), 1, 'new UTC day starts at 1');
    assert.deepEqual(await store.readVoiceStats(guildId, me), { seconds: 180, xp: 12 });
    await store.addVoiceXp(guildId, me, 4);
    assert.deepEqual(await store.readVoiceStats(guildId, me), { seconds: 180, xp: 16 }, 'XP given by addXp is added afterwards');
    await assert.rejects(store.addVoiceXp(guildId, user(9), 4), /row missing/, 'no row: an error, never a silent no-op');
    const { rows: [row] } = await pgDb.pool.query(
        "SELECT to_char(day, 'YYYY-MM-DD') AS day, day_minutes, updated_at FROM voice_activity WHERE guild_id = $1 AND user_id = $2", [guildId, me]);
    assert.equal(row.day, '2026-11-10');
    assert.equal(row.day_minutes, 1);
    assert.ok(Date.now() - new Date(row.updated_at).getTime() < 60_000, 'updated_at set by the write');

    await store.upsertMinutes(guildId, user(2), { day: '2026-11-10', seconds: 600, xp: 1 });
    await store.upsertMinutes(guildId, user(3), { day: '2026-11-10', seconds: 0, xp: 0 });
    const top = await store.topVoiceRows(guildId, 10, 0);
    assert.deepEqual(top.map((r) => [r.userId, r.voiceSeconds]), [[user(2), 600], [me, 180]], 'most time first; 0 seconds not listed');
});

test('a failing UPSERT throws and no XP is given for that minute', { skip }, async () => {
    const me = user(4);
    const gave = [];
    const failingStore = {
        readDayMinutes: store.readDayMinutes,
        // A day Postgres refuses: the real UPSERT fails inside its transaction.
        upsertMinutes: (g, id, options) => store.upsertMinutes(g, id, { ...options, day: '2026-13-45' }),
    };
    const entry = { userId: me, channelId: `7${runId}00000099`, member: { id: me, user: { id: me }, roles: { cache: new Map() } } };
    const cfg = { enabled: true, voice: { enabled: true, xpMin: 3, xpMax: 7, dailyCapMinutes: 120, minHumans: 2, requireUnmuted: false, excludedChannels: [] } };
    await assert.rejects(
        voiceXp.awardVoiceMinute({}, { id: guildId }, entry, cfg, { store: failingStore, giveXp: async (...args) => { gave.push(args); } }),
        (error) => /date|range/i.test(error.message),
    );
    assert.equal(gave.length, 0, 'no XP');
    assert.equal(await store.readVoiceStats(guildId, me), null, 'nothing written');
});

test('/wipedata and the level reset delete only this member\'s voice row', { skip }, async () => {
    const [a, b] = [user(5), user(6)];
    for (const id of [a, b]) {
        await store.upsertMinutes(guildId, id, { day: '2026-11-09', seconds: 60, xp: 3 });
        await db.set(keys.getUserLevelKey(guildId, id), { xp: 3, level: 0, totalXp: 3 });
    }
    const result = await wipe.wipeMemberData({ db }, guildId, a);
    assert.deepEqual(result.failed.map((f) => `${f.id}: ${f.error.message}`), []);
    assert.equal(await store.readVoiceStats(guildId, a), null, 'my voice time is gone');
    assert.deepEqual(await store.readVoiceStats(guildId, b), { seconds: 60, xp: 3 }, 'the other member keeps theirs');

    await leveling.deleteUserLevelData({ db }, guildId, b);
    assert.equal(await store.readVoiceStats(guildId, b), null, 'level reset clears voice time');
    assert.equal(await db.exists(keys.getUserLevelKey(guildId, b)), false);
});
