// /wipedata against the local test database: levels, AFK, birthday and to-do rows are really
// gone afterwards, and another member's rows in the same server stay.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, keys, database, wipe;
const runId = String(Date.now()).slice(-9);
const guildId = `8${runId}00000041`;
const me = `8${runId}00000042`;
const other = `8${runId}00000043`;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    keys = await import('../../src/utils/database/keys.js');
    database = await import('../../src/utils/database.js');
    wipe = await import('../../src/services/wipedataService.js');
});

after(async () => {
    if (skip) return;
    for (const table of ['user_levels', 'afk_status', 'birthdays', 'economy']) {
        await pgDb.pool.query(`DELETE FROM ${table} WHERE guild_id = $1`, [guildId]).catch(() => {});
    }
    await pgDb.disconnect();
});

test('wipedata: own levels, AFK, birthday and to-do are deleted; another member keeps theirs', { skip }, async () => {
    const client = { db };
    for (const user of [me, other]) {
        await db.set(keys.getUserLevelKey(guildId, user), { xp: 50, level: 2, totalXp: 250 });
        await db.set(keys.getAFKKey(guildId, user), { reason: 'lunch', timestamp: Date.now() });
        await database.setBirthday(client, guildId, user, 3, 14);
        await db.set(`todo_${user}`, { tasks: [{ id: 1, text: 'x' }] });
        await db.set(`oauth:tokens:${user}`, { scope: 'identify guilds.join', tokens: 'encrypted' });
    }
    assert.equal(await db.exists(keys.getUserLevelKey(guildId, me)), true, 'level row stored');
    assert.equal(await db.exists(keys.getAFKKey(guildId, me)), true, 'AFK row stored');

    const result = await wipe.wipeMemberData(client, guildId, me);
    assert.deepEqual(result.failed.map((f) => `${f.id}: ${f.error.message}`), []);

    assert.equal(await db.exists(keys.getUserLevelKey(guildId, me)), false);
    assert.equal(await db.exists(keys.getAFKKey(guildId, me)), false);
    assert.equal(await db.exists(`todo_${me}`), false);
    assert.equal(await db.exists(`oauth:tokens:${me}`), false, 'my OAuth token is gone');
    assert.equal(await db.exists(`oauth:tokens:${other}`), true, 'the other member keeps theirs');
    const birthdays = await database.getGuildBirthdays(client, guildId);
    assert.equal(birthdays[me], undefined, 'my birthday is gone');
    assert.deepEqual(birthdays[other], { month: 3, day: 14 }, 'the other member keeps theirs');
    assert.equal(await db.exists(keys.getUserLevelKey(guildId, other)), true);
    assert.equal(await db.exists(`todo_${other}`), true);

    // Running it again with nothing left is fine.
    const again = await wipe.wipeMemberData(client, guildId, me);
    assert.deepEqual(again.failed, []);
    await db.delete(`todo_${other}`);
    await db.delete(`oauth:tokens:${other}`);
});
