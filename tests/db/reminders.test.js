// /remind against the local test database: create, list, the 25 limit, delete own only, a due
// reminder is claimed exactly once even with two claims at the same time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
let pgDb, svc, store;
const runId = String(Date.now()).slice(-9);
const me = `6${runId}00000061`;
const other = `6${runId}00000062`;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    svc = await import('../../src/services/reminders/reminderService.js');
    store = svc.createReminderStore();
});
after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM reminders WHERE user_id = ANY($1)', [[me, other]]);
    await pgDb.disconnect();
});

test('reminders: create, list, limit, delete own only, claim once', { skip }, async () => {
    const a = await store.create({ userId: me, channelId: '1', text: 'one', delayMs: 3600000 });
    await store.create({ userId: other, text: 'theirs', delayMs: 3600000 });
    assert.equal((await store.listActive(me)).length, 1);
    assert.equal(await store.remove(other, a.id), null, 'not someone else\'s');
    assert.equal((await store.remove(me, a.id)).text, 'one');
    for (let i = 0; i < svc.MAX_ACTIVE_REMINDERS; i += 1) await store.create({ userId: me, text: `r${i}`, delayMs: 3600000 });
    await assert.rejects(store.create({ userId: me, text: 'too many', delayMs: 3600000 }), /already have 25/);
    await pgDb.pool.query('DELETE FROM reminders WHERE user_id = $1', [me]);

    await store.create({ userId: me, text: 'due', delayMs: 60000 });
    const later = svc.createReminderStore({ now: () => Date.now() + 120000 });
    const [x, y] = await Promise.all([later.claimDue(), later.claimDue()]);
    const mine = [...x, ...y].filter((r) => r.user_id === me);
    assert.equal(mine.length, 1, 'claimed exactly once');
    assert.ok(mine[0].sent_at);
    assert.deepEqual((await later.claimDue()).filter((r) => r.user_id === me), []);
});
