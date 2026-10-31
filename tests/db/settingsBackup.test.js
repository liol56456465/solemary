// Settings backup against the local test database: a checked file applies through
// updateSettings (row-locked, audited as module "backup"), then the old value is restored.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) || !process.env.MAIN_GUILD_ID ? (isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)') : 'needs MAIN_GUILD_ID';
let pgDb, backup, gs;
let before0;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    backup = await import('../../src/services/settings/settingsBackup.js');
    gs = await import('../../src/services/settings/guildSettings.js');
    before0 = gs.getConfiguredSetting('openChannelCap');
});
after(async () => {
    if (skip) return;
    await gs.updateSettings(process.env.MAIN_GUILD_ID, { openChannelCap: before0 }, { userId: '1', username: 'test' });
    await pgDb.disconnect();
});

test('settings backup: check then apply changes exactly the listed setting', { skip }, async () => {
    const file = backup.exportSettings();
    const target = before0 === 33 ? 34 : 33;
    file.guilds.main.settings.openChannelCap = target;
    const plan = backup.planBackup(JSON.stringify(file));
    assert.deepEqual(plan.changes.map((c) => c.key), ['openChannelCap']);
    assert.equal(await backup.applyBackup(plan, { userId: '1', username: 'test' }), 1);
    assert.equal(gs.getConfiguredSetting('openChannelCap'), target);
    const { rows } = await pgDb.pool.query(`SELECT module FROM dashboard_audit WHERE key = 'openChannelCap' ORDER BY id DESC LIMIT 1`);
    assert.equal(rows[0].module, 'backup');
});
