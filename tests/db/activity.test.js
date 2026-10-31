// Dashboard → Activity against the local test database: the three queries run on the real
// schema and the flushed message count comes back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
let pgDb, svc;
const guild = `2${String(Date.now()).slice(-9)}00000101`;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    svc = await import('../../src/services/stats/activityService.js');
});
after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM guild_daily_stats WHERE guild_id = $1', [guild]);
    await pgDb.disconnect();
});

test('activity: flush then read back', { skip }, async () => {
    for (let i = 0; i < 3; i += 1) svc.noteMessage({ guildId: guild, author: { bot: false } });
    await svc.flushActivity();
    svc.noteMessage({ guildId: guild, author: { bot: false } });
    await svc.flushActivity();
    const series = await svc.activitySeries(guild);
    assert.equal(series.length, 30);
    assert.equal(series[29].messages, 4);
    assert.ok(series.every((d) => d.joins === 0 && d.cases === 0));
});
