// Multi-server B5 (T2): the "which servers use this feature" queries (scheduling/guildScan.js)
// against the local test database (npm run test:db): each finds the server that uses the
// feature and not the one that does not. Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const skip = isLocalDatabaseUrl(process.env.POSTGRES_URL || '') ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
const runId = String(Date.now()).slice(-9);
const USES = `8${runId}00000001`;
const IDLE = `8${runId}00000002`;
const snowflake = (n) => `7${runId}${String(n).padStart(8, '0')}`;
let pgDb, db, keys, scan, stats;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    keys = await import('../../src/utils/database/keys.js');
    scan = await import('../../src/services/scheduling/guildScan.js');
    stats = await import('../../src/services/serverstatsService.js');

    await db.set(keys.getGuildConfigKey(USES), {
        birthdayChannelId: snowflake(1),
        ticketCategoryId: snowflake(2),
        ticketPanelChannelId: snowflake(3),
        verification: { enabled: true, channelId: snowflake(4) },
    });
    await db.set(keys.getGuildConfigKey(IDLE), { verification: { enabled: false, channelId: snowflake(5) } });
    await db.set(keys.getServerCountersKey(USES), [{ id: '1', type: 'members', channelId: snowflake(6), guildId: USES, enabled: true }]);
    await db.set(keys.getLevelingKey(USES), { enabled: true, roleRewards: { 5: snowflake(7) } });
    await db.set(keys.getLevelingKey(IDLE), { enabled: true, roleRewards: {} });
    await db.set(keys.getReactionRoleKey(USES, snowflake(8)), { messageId: snowflake(8), channelId: snowflake(9), roles: [] });
    await db.set(`automod:settings:${USES}`, { enabled: true, staffGuard: true });
    await db.set(`automod:settings:${IDLE}`, { enabled: true, staffGuard: false });
    await pgDb.pool.query('INSERT INTO guild_daily_stats (guild_id, day, messages) VALUES ($1, CURRENT_DATE, 3)', [USES]);
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM guild_daily_stats WHERE guild_id = ANY($1)', [[USES, IDLE]]);
    await pgDb.pool.query('DELETE FROM temp_data WHERE key LIKE $1 OR key LIKE $2', [`guild:${USES}:%`, `guild:${IDLE}:%`]);
    await pgDb.pool.query('DELETE FROM temp_data WHERE key = ANY($1)', [[`automod:settings:${USES}`, `automod:settings:${IDLE}`]]);
    await pgDb.pool.query('DELETE FROM guilds WHERE id = ANY($1)', [[USES, IDLE]]);
    await pgDb.disconnect();
});

const ids = async (sql, params = []) => new Set((await pgDb.pool.query(sql, params)).rows.map((row) => String(row.id)));

test('each feature query finds the server that uses it and not the idle one', { skip }, async () => {
    const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    for (const [name, params] of [['counters'], ['birthdays'], ['ticketCategory'], ['ticketPanel'], ['verificationPanel'], ['reactionRoles'], ['levelRewards'], ['activeSince', [day]], ['staffGuard']]) {
        const found = await ids(scan.GUILD_SQL[name], params || []);
        assert.ok(found.has(USES), `${name}: the server that uses it`);
        assert.ok(!found.has(IDLE), `${name}: not the idle server`);
    }
});

test('listGuildCounters: one query with the counters themselves', { skip }, async () => {
    const byGuild = await stats.listGuildCounters({ db });
    assert.deepEqual(byGuild.get(USES).map((c) => c.channelId), [snowflake(6)]);
    assert.equal(byGuild.has(IDLE), false);
});
