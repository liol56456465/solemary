// "Download my data" against the local test database: every query runs on the real schema
// (a wrong column name fails here), and the member's own rows come back.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, keys, exporter, enforcementDb;
const runId = String(Date.now()).slice(-9);
const guildId = `9${runId}00000051`;
const me = `9${runId}00000052`;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    keys = await import('../../src/utils/database/keys.js');
    exporter = await import('../../src/services/privacy/dataExport.js');
    enforcementDb = await import('../../src/services/enforcement/db.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM user_levels WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM premium_orders WHERE user_id = $1', [me]);
    await db.delete(`todo_${me}`);
    await pgDb.disconnect();
});

test('data export: all sections run on the real schema and return the member\'s rows', { skip }, async () => {
    await db.set(keys.getUserLevelKey(guildId, me), { xp: 70, level: 3, totalXp: 300 });
    await db.set(`todo_${me}`, { tasks: [{ id: 1, text: 'buy milk' }] });
    await pgDb.pool.query(`INSERT INTO premium_orders (user_id, username, plan_id, period, kind, amount_cents) VALUES ($1, 'me', 'pro', 'monthly', 'personal', 499)`, [me]);
    const file = await exporter.buildDataExport(me, { query: enforcementDb.query, readKey: async (key) => db.get(key) });
    assert.equal(file.levels.length, 1);
    assert.equal(file.levels[0].guild_id, guildId);
    assert.equal(Number(file.levels[0].xp), 70);
    assert.equal(file.planOrders.length, 1);
    assert.equal(file.planOrders[0].amount_cents, 499);
    assert.deepEqual(file.todoList.tasks, [{ id: 1, text: 'buy milk' }]);
    for (const [name] of exporter.EXPORT_SECTIONS) assert.ok(Array.isArray(file[name]), name);
    JSON.stringify(file); // serialisable (BigInt would throw)
});
