// Custom automod rules against the local test database: the automodCustomRules setting is
// saved through the settings service (validated, audited), read back from the cache and the
// row, and an invalid stored list falls back to [] (no rules run) instead of breaking automod.
// Uses its own guild ids (passed as env). Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, gs, cleanCustomRules, matchCustomRules;
const runId = String(Date.now()).slice(-9);
const MAIN = `7${runId}00000011`;
const SUPPORT = `7${runId}00000012`;
const ADMIN = `6${runId}00000013`;
const ENV = { NODE_ENV: 'test', MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT };

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    gs = await import('../../src/services/settings/guildSettings.js');
    ({ cleanCustomRules, matchCustomRules } = await import('../../src/services/automod/customRules.js'));
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM guild_settings WHERE guild_id = ANY($1)', [[MAIN, SUPPORT]]);
    await pgDb.pool.query('DELETE FROM dashboard_audit WHERE guild_id = ANY($1)', [[MAIN, SUPPORT]]);
    gs.resetSettingsCacheForTests();
    await pgDb.disconnect();
});

test('automodCustomRules: saved, audited, read back; raw unchecked input is refused', { skip }, async () => {
    const rules = cleanCustomRules([{ name: 'Ads', action: 'mute', muteDuration: '1h', words: 'free nitro\njoin my server' }]);
    const result = await gs.updateSettings(MAIN, { automodCustomRules: rules }, { userId: ADMIN, username: 'admin', module: 'automod' }, ENV);
    assert.deepEqual(result.changes.map((c) => c.key), ['automodCustomRules']);
    assert.deepEqual(gs.getSetting(MAIN, 'automodCustomRules', ENV), rules);
    const { rows: [row] } = await pgDb.pool.query('SELECT data FROM guild_settings WHERE guild_id = $1', [MAIN]);
    assert.deepEqual(row.data.automodCustomRules, rules);
    const audit = await gs.listSettingsAudit(MAIN, 5);
    assert.equal(audit[0].key, 'automodCustomRules');
    assert.ok(matchCustomRules('get FREE N1TRO', gs.getSetting(MAIN, 'automodCustomRules', ENV)));

    await assert.rejects(gs.updateSettings(MAIN, { automodCustomRules: [{ ...rules[0], regex: '.*' }] }, { userId: ADMIN }, ENV));
    await assert.rejects(gs.updateSettings(MAIN, { automodCustomRules: [{ ...rules[0], muteDuration: null }] }, { userId: ADMIN }, ENV));
    assert.deepEqual(gs.getSetting(MAIN, 'automodCustomRules', ENV), rules, 'a refused write changes nothing');
});

test('automodCustomRules: an invalid stored list is ignored on load (no rules run)', { skip }, async () => {
    await pgDb.pool.query(`UPDATE guild_settings SET data = data || '{"automodCustomRules": [{"id": "x"}]}'::jsonb WHERE guild_id = $1`, [MAIN]);
    gs.resetSettingsCacheForTests();
    await gs.loadAllSettings();
    assert.deepEqual(gs.getSetting(MAIN, 'automodCustomRules', ENV), []);
});
