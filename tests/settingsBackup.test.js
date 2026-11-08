// Settings backup (services/settings/settingsBackup.js): export both servers, check a file
// before anything is written (format, unknown keys, wrong server, each value's schema),
// list only real changes, apply through updateSettings per server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT, applyBackup, exportSettings, planBackup } from '../src/services/settings/settingsBackup.js';
import { SETTINGS } from '../src/services/settings/settingsRegistry.js';

const env = { MAIN_GUILD_ID: '100000000000000001', SUPPORT_GUILD_ID: '100000000000000002' };
const stored = new Map();
const read = (guildId, key) => (stored.has(`${guildId}:${key}`) ? stored.get(`${guildId}:${key}`) : SETTINGS.find((s) => s.key === key).fallback ?? null);

test('export: both servers, every non-sensitive setting, nothing secret', () => {
    const file = exportSettings({ env, read, now: new Date('2026-10-31T00:00:00Z') });
    assert.equal(file.format, BACKUP_FORMAT);
    assert.equal(file.guilds.main.guildId, env.MAIN_GUILD_ID);
    assert.ok('modLogChannelId' in file.guilds.main.settings);
    assert.ok(Object.keys(file.guilds.support?.settings || {}).every((k) => SETTINGS.find((s) => s.key === k).guild === 'support'));
    for (const entry of SETTINGS.filter((s) => s.sensitive)) {
        assert.ok(!(entry.key in (file.guilds[entry.guild]?.settings || {})), entry.key);
    }
    assert.equal(exportSettings({ env: {}, read }).guilds.main, undefined, 'no server configured: nothing');
});

test('check: refuses non-backups; lists only changes; skips unknown, wrong-server and invalid values', () => {
    assert.deepEqual(planBackup('', { env, read }), { ok: false, error: 'The file is empty.' });
    assert.equal(planBackup('{nope', { env, read }).error, 'That is not a JSON file.');
    assert.equal(planBackup('{"format":"other"}', { env, read }).error, 'That is not a Mewvo settings backup.');
    assert.match(planBackup('x'.repeat(300 * 1024), { env, read }).error, /too big/);
    const file = exportSettings({ env, read });
    file.guilds.main.settings.openChannelCap = 33;
    file.guilds.main.settings.notARealSetting = 1;
    file.guilds.main.settings.massActionLimit = 'lots';
    const supportKey = SETTINGS.find((s) => s.guild === 'support')?.key;
    if (supportKey) file.guilds.main.settings[supportKey] = null;
    const plan = planBackup(JSON.stringify(file), { env, read });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.changes.map((c) => c.key), ['openChannelCap']);
    assert.deepEqual(plan.patches.main, { openChannelCap: 33 });
    assert.ok(plan.problems.some((p) => /Unknown setting "notARealSetting"/.test(p)));
    assert.ok(plan.problems.some((p) => /skipped/.test(p) && /mass|limit|Bans/i.test(p)));
    if (supportKey) assert.ok(plan.problems.some((p) => /belongs to the support server/.test(p)));
    const same = planBackup(JSON.stringify(exportSettings({ env, read })), { env, read });
    assert.deepEqual(same.changes, [], 'an unchanged file changes nothing');
});

test('apply: both servers in one batch (one transaction), audited as module backup', async () => {
    const calls = [];
    const updateBatch = async (writes, actor) => { calls.push({ writes, actor }); return { changes: writes.flatMap((w) => Object.keys(w.patch).map((key) => ({ key }))) }; };
    const n = await applyBackup({ patches: { main: { openChannelCap: 33 }, support: {} } }, { userId: '1', username: 'a' }, { env, updateBatch });
    assert.equal(n, 1);
    assert.deepEqual(calls, [{ writes: [{ guildId: env.MAIN_GUILD_ID, patch: { openChannelCap: 33 } }], actor: { userId: '1', username: 'a', module: 'backup' } }]);
    assert.equal(await applyBackup({ patches: { main: {}, support: {} } }, { userId: '1' }, { env, updateBatch }), 0, 'nothing to write: no transaction');
    assert.equal(calls.length, 1);
});

test('apply: a failed batch throws, so nothing is reported as applied', async () => {
    const updateBatch = async () => { throw new Error('db down'); };
    await assert.rejects(applyBackup({ patches: { main: { openChannelCap: 33 }, support: {} } }, { userId: '1' }, { env, updateBatch }), /db down/);
});
