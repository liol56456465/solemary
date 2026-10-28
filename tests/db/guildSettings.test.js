// guildSettings against the local test database: load, one-time env seed, get,
// row-locked updates with audit rows, and concurrent updates of the same row.
// Uses its own guild ids (passed as env), never the configured test servers' rows.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, gs;
const runId = String(Date.now()).slice(-9);
const MAIN = `7${runId}00000001`;
const SUPPORT = `7${runId}00000002`;
const CH = (n) => `5${runId}000000${String(n).padStart(2, '0')}`;
const ADMIN = `6${runId}00000003`;

const ENV = {
    NODE_ENV: 'test', MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT,
    MOD_LOG_CHANNEL_ID: CH(1), MASS_ACTION_LIMIT: '7', BANNED_ROLE_ID: CH(2), STALE_REPORT_DAYS: 'oops',
};

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    gs = await import('../../src/services/settings/guildSettings.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM guild_settings WHERE guild_id = ANY($1)', [[MAIN, SUPPORT]]);
    await pgDb.pool.query('DELETE FROM dashboard_audit WHERE guild_id = ANY($1)', [[MAIN, SUPPORT]]);
    gs.resetSettingsCacheForTests();
    await pgDb.disconnect();
});

test('seedFromEnvOnce stores env/default values once; later env changes are ignored', { skip }, async () => {
    const seeded = await gs.seedFromEnvOnce(ENV);
    assert.ok(seeded[MAIN].includes('modLogChannelId'));
    assert.ok(seeded[MAIN].includes('appealWindowMs'));
    assert.deepEqual(seeded[SUPPORT], ['bannedRoleId']);
    const { rows: [row] } = await pgDb.pool.query('SELECT data, seeded_from_env FROM guild_settings WHERE guild_id = $1', [MAIN]);
    assert.equal(row.seeded_from_env, true);
    assert.equal(row.data.modLogChannelId, CH(1));
    assert.equal(row.data.massActionLimit, 7);
    assert.equal(row.data.staleReportMs, 7 * 86400000, 'invalid env → default');
    assert.equal(row.data.adminRequestChannelId, null, 'no production ID seeded in test mode');
    assert.equal(row.data.bannedRoleId, undefined, 'support-server keys live on the support row');

    const again = await gs.seedFromEnvOnce({ ...ENV, MOD_LOG_CHANNEL_ID: CH(9) });
    assert.deepEqual(again[MAIN], [], 'nothing left to seed');
    assert.equal(gs.getSetting(MAIN, 'modLogChannelId', { ...ENV, MOD_LOG_CHANNEL_ID: CH(9) }), CH(1), 'the stored value wins over a changed env');
});

test('loadAllSettings reads rows into memory; invalid stored values fall back to env', { skip }, async () => {
    await pgDb.pool.query(`UPDATE guild_settings SET data = data || '{"evidenceChannelId": "bad"}'::jsonb WHERE guild_id = $1`, [MAIN]);
    gs.resetSettingsCacheForTests();
    assert.equal(gs.isSettingsLoaded(), false);
    assert.equal(gs.getSetting(MAIN, 'modLogChannelId', { ...ENV, MOD_LOG_CHANNEL_ID: CH(8) }), CH(8), 'not loaded → env');
    const count = await gs.loadAllSettings();
    assert.ok(count >= 2);
    assert.equal(gs.isSettingsLoaded(), true);
    assert.equal(gs.getSetting(MAIN, 'modLogChannelId', ENV), CH(1));
    assert.equal(gs.getSetting(SUPPORT, 'bannedRoleId', ENV), CH(2));
    assert.equal(gs.getSetting(MAIN, 'evidenceChannelId', { ...ENV, EVIDENCE_CHANNEL_ID: CH(7) }), CH(7), 'invalid stored value ignored');
    assert.equal(gs.settingSource(MAIN, 'massActionLimit', ENV), 'database');
});

test('updateSettings validates, writes, refreshes the cache and audits old → new', { skip }, async () => {
    await assert.rejects(gs.updateSettings(MAIN, { modLogChannelId: 'nope' }, { userId: ADMIN }, ENV), /must be a Discord ID/);
    await assert.rejects(gs.updateSettings(MAIN, { bannedRoleId: CH(3) }, { userId: ADMIN }, ENV), /support server/);
    await assert.rejects(gs.updateSettings('123456789012345678', { modLogChannelId: CH(3) }, { userId: ADMIN }, ENV), /main or support/);

    const result = await gs.updateSettings(MAIN, { modLogChannelId: CH(3), massActionLimit: 7 }, { userId: ADMIN, username: 'admin' }, ENV);
    assert.deepEqual(result.changes.map((c) => c.key), ['modLogChannelId'], 'unchanged values are not audited');
    assert.deepEqual(result.changes[0], { key: 'modLogChannelId', module: 'logging', old: CH(1), new: CH(3) });
    assert.equal(gs.getSetting(MAIN, 'modLogChannelId', ENV), CH(3), 'cache refreshed');
    const { rows: [row] } = await pgDb.pool.query('SELECT data, updated_by FROM guild_settings WHERE guild_id = $1', [MAIN]);
    assert.equal(row.data.modLogChannelId, CH(3));
    assert.equal(row.updated_by, ADMIN);
    const audit = await gs.listSettingsAudit(MAIN, 10);
    assert.equal(audit[0].key, 'modLogChannelId');
    assert.equal(audit[0].old, CH(1));
    assert.equal(audit[0].new, CH(3));
    assert.equal(audit[0].user_id, ADMIN);
    assert.equal(audit[0].module, 'logging');

    await gs.updateSettings(SUPPORT, { bannedRoleId: null }, { userId: ADMIN }, ENV);
    assert.equal(gs.getSetting(SUPPORT, 'bannedRoleId', ENV), null, 'cleared');
});

test('concurrent updates of the same row lose nothing (row lock)', { skip }, async () => {
    const patches = [
        { evidenceChannelId: CH(10) }, { reviewChannelId: CH(11) }, { alertsChannelId: CH(12) },
        { massActionLimit: 9 }, { exemptChannelIds: [CH(13), CH(14)] }, { extraBlockedWords: ['zzword'] },
    ];
    await Promise.all(patches.map((patch, i) => gs.updateSettings(MAIN, patch, { userId: ADMIN, username: `a${i}` }, ENV)));
    const { rows: [row] } = await pgDb.pool.query('SELECT data FROM guild_settings WHERE guild_id = $1', [MAIN]);
    for (const patch of patches) {
        for (const [key, value] of Object.entries(patch)) assert.deepEqual(row.data[key], value, key);
    }
    // The cache matches the database after the last writer.
    await gs.loadAllSettings();
    assert.deepEqual(gs.getSetting(MAIN, 'exemptChannelIds', ENV), [CH(13), CH(14)]);

    // Same key from many writers: every change is audited in order, the last one wins.
    const values = [CH(20), CH(21), CH(22), CH(23)];
    await Promise.all(values.map((value) => gs.updateSettings(MAIN, { evidenceChannelId: value }, { userId: ADMIN }, ENV)));
    const audit = (await gs.listSettingsAudit(MAIN, 50)).filter((r) => r.key === 'evidenceChannelId').slice(0, 4).reverse();
    for (let i = 1; i < audit.length; i += 1) assert.equal(audit[i].old, audit[i - 1].new, 'each change starts from the previous value');
    const { rows: [after] } = await pgDb.pool.query('SELECT data FROM guild_settings WHERE guild_id = $1', [MAIN]);
    assert.equal(after.data.evidenceChannelId, audit[audit.length - 1].new);
});
