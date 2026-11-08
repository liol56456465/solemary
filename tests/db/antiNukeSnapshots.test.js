// Anti-nuke: on-demand structure snapshots (nuke alert, staff guard turned on) never evict daily
// ones, against the local test database (npm run test:db). Skipped unless POSTGRES_URL is local.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const skip = isLocalDatabaseUrl(process.env.POSTGRES_URL || '') ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
const GUILD = `9${String(Date.now()).slice(-9)}00000001`;
let pgDb, backup;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    backup = await import('../../src/services/structureBackupService.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM server_snapshots WHERE guild_id = $1', [GUILD]);
    await pgDb.disconnect();
});

const counts = async () => {
    const { rows } = await pgDb.pool.query(
        `SELECT COALESCE(data->>'kind', 'daily') AS kind, COUNT(*)::int AS n FROM server_snapshots WHERE guild_id = $1 GROUP BY 1`, [GUILD]);
    return Object.fromEntries(rows.map((row) => [row.kind, row.n]));
};

test('7 daily snapshots survive any number of on-demand ones; on-demand capped at 3; old rows without a kind count as daily', { skip }, async () => {
    const guild = { id: GUILD };
    const data = { guildId: GUILD, roles: [], channels: [], everyonePermissions: '0' };
    // An old row from before kinds existed: daily.
    await pgDb.pool.query(`INSERT INTO server_snapshots (guild_id, summary, data, created_at) VALUES ($1, 'old', $2, NOW() - INTERVAL '3 days')`, [GUILD, data]);
    for (let i = 0; i < 8; i += 1) await backup.takeSnapshot(guild, data);
    assert.deepEqual(await counts(), { daily: 7 });
    for (let i = 0; i < 6; i += 1) await backup.takeSnapshot(guild, data, { kind: i % 2 ? 'nuke' : 'enable' });
    assert.deepEqual(await counts(), { daily: 7, nuke: 2, enable: 1 }, 'the 3 newest on-demand ones, all daily kept');
    await backup.takeSnapshot(guild, data);
    const after = await counts();
    assert.equal(after.daily, 7);
    assert.equal((after.nuke || 0) + (after.enable || 0), 3, 'a daily snapshot does not prune on-demand ones either');
});
