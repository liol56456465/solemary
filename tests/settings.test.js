// Settings registry, env seeding and the cached getSetting / config getters (no database).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    SETTINGS, SETTING_KINDS, defaultValue, envValue, getSettingEntry, seedValue, validatePatch, validateSetting,
} from '../src/services/settings/settingsRegistry.js';
import {
    bindSettingGetters, getConfiguredSetting, getModuleSettings, getSetting, guildIdFor, guildRole,
    resetSettingsCacheForTests, setSettingsCacheForTests, settingSource,
} from '../src/services/settings/guildSettings.js';
import { enforcementConfig } from '../src/config/enforcement.js';
import { automodConfig } from '../src/config/automod.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const CHANNEL = '200000000000000003';

afterEach(() => resetSettingsCacheForTests());

test('registry: every entry is complete and the audit MOVE list is covered', () => {
    const keys = SETTINGS.map((e) => e.key);
    assert.equal(new Set(keys).size, keys.length, 'unique keys');
    for (const entry of SETTINGS) {
        assert.ok(SETTING_KINDS.includes(entry.kind), `${entry.key} kind`);
        assert.ok(['main', 'support'].includes(entry.guild), `${entry.key} guild`);
        assert.equal(typeof entry.module, 'string');
        assert.equal(typeof entry.label, 'string');
        assert.equal(typeof entry.sensitive, 'boolean');
        assert.ok(entry.schema?.safeParse, `${entry.key} schema`);
        // The default itself must be a valid value.
        assert.equal(validateSetting(entry.key, defaultValue(entry, { NODE_ENV: 'production' })).ok, true, `${entry.key} default valid`);
        assert.equal(validateSetting(entry.key, defaultValue(entry, { NODE_ENV: 'test' })).ok, true, `${entry.key} test default valid`);
    }
    for (const key of [
        'adminRequestChannelId', 'supportServerInvite', 'appealsCategoryId', 'mutedRoleId', 'bannedRoleId', 'warnRoleIds',
        'modLogChannelId', 'evidenceChannelId', 'massActionLimit', 'massActionWindowMs', 'massActionBlockMs',
        'staleReportMs', 'staleAppealReminderMs', 'appealWindowMs', 'appealCooldownMs', 'rejoinInviteMaxAgeSeconds',
        'reviewChannelId', 'alertsChannelId', 'exemptChannelIds', 'extraBlockedWords', 'verifySuccessRedirect',
    ]) assert.ok(getSettingEntry(key), key);
    assert.equal(getSettingEntry('bannedRoleId').guild, 'support');
    assert.equal(getSettingEntry('ENFORCEMENT_REASONS'), null, 'reasons stay in code');
});

test('registry: schemas reject bad values and accept good ones', () => {
    assert.equal(validateSetting('modLogChannelId', CHANNEL).ok, true);
    assert.equal(validateSetting('modLogChannelId', null).ok, true, 'channels can be cleared');
    assert.equal(validateSetting('modLogChannelId', '123').ok, false);
    assert.equal(validateSetting('modLogChannelId', `${CHANNEL} OR 1=1`).ok, false);
    assert.equal(validateSetting('massActionLimit', 0).ok, false);
    assert.equal(validateSetting('massActionLimit', 2.5).ok, false);
    assert.equal(validateSetting('massActionLimit', '5').ok, false, 'no string coercion');
    assert.equal(validateSetting('massActionLimit', 5).ok, true);
    assert.equal(validateSetting('supportServerInvite', 'https://discord.gg/abc-1').ok, true);
    assert.equal(validateSetting('supportServerInvite', 'https://evil.example/x').ok, false);
    assert.equal(validateSetting('verifySuccessRedirect', 'javascript:alert(1)').ok, false);
    assert.equal(validateSetting('verifySuccessRedirect', 'http://example.com').ok, false, 'https only');
    assert.equal(validateSetting('verifySuccessRedirect', 'https://example.com/ok').ok, true);
    assert.equal(validateSetting('warnRoleIds', [CHANNEL, 'x']).ok, false);
    assert.deepEqual(validateSetting('extraBlockedWords', [' Foo ']).value, ['foo']);
    assert.equal(validateSetting('nope', 1).ok, false);
});

test('validatePatch: all problems at once, unknown keys and wrong server refused', () => {
    assert.deepEqual(validatePatch({ modLogChannelId: CHANNEL, massActionLimit: 3 }, 'main'), { modLogChannelId: CHANNEL, massActionLimit: 3 });
    assert.throws(() => validatePatch({ modLogChannelId: 'x', nope: 1 }, 'main'), (error) => error.problems.length === 2 && /unknown setting/.test(error.userMessage));
    assert.throws(() => validatePatch({ bannedRoleId: CHANNEL }, 'main'), /support server/);
    assert.deepEqual(validatePatch({ bannedRoleId: CHANNEL }, 'support'), { bannedRoleId: CHANNEL });
    assert.throws(() => validatePatch(null), /object/);
    assert.throws(() => validatePatch([1]), /object/);
});

test('env seeding: units, lists, empty values and production-only defaults', () => {
    const e = (key) => getSettingEntry(key);
    assert.equal(envValue(e('massActionWindowMs'), { MASS_ACTION_WINDOW_MINUTES: '15' }), 15 * 60 * 1000);
    assert.equal(envValue(e('staleReportMs'), { STALE_REPORT_DAYS: '2' }), 2 * 86400000);
    assert.equal(envValue(e('massActionLimit'), { MASS_ACTION_LIMIT: 'abc' }), undefined, 'invalid → default');
    assert.equal(seedValue(e('massActionLimit'), { MASS_ACTION_LIMIT: '-3' }), 5);
    assert.deepEqual(envValue(e('warnRoleIds'), { WARN_ROLE_IDS: ' 1, 2 ,,3 ' }), ['1', '2', '3']);
    assert.deepEqual(envValue(e('extraBlockedWords'), { AUTOMOD_EXTRA_WORDS: 'Foo, BAR' }), ['foo', 'bar']);
    assert.equal(envValue(e('modLogChannelId'), { MOD_LOG_CHANNEL_ID: '  ' }), undefined);
    assert.equal(seedValue(e('appealWindowMs'), {}), 30 * 86400000, 'hardcoded value (no env var)');
    // Production-only fallbacks (real Meowist IDs) never apply in test mode.
    assert.equal(seedValue(e('adminRequestChannelId'), { NODE_ENV: 'test' }), null, 'bug fix: no prod ID in test mode');
    assert.equal(seedValue(e('adminRequestChannelId'), { NODE_ENV: 'production' }), '1527697155643408442');
    assert.deepEqual(seedValue(e('warnRoleIds'), { NODE_ENV: 'test' }), []);
    assert.equal(seedValue(e('modLogChannelId'), { NODE_ENV: 'test' }), null);
    assert.equal(seedValue(e('modLogChannelId'), { NODE_ENV: 'test', MOD_LOG_CHANNEL_ID: CHANNEL }), CHANNEL);
    assert.equal(seedValue(e('supportServerInvite'), { NODE_ENV: 'test' }), 'https://discord.gg/7Ckv9Bt577', 'unchanged behaviour');
});

test('getSetting: stored value wins; otherwise env, otherwise default; no cache = env (database down at boot)', () => {
    const env = { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, MOD_LOG_CHANNEL_ID: CHANNEL, NODE_ENV: 'test' };
    assert.equal(getSetting(MAIN, 'modLogChannelId', env), CHANNEL);
    assert.equal(settingSource(MAIN, 'modLogChannelId', env), 'env');
    assert.equal(settingSource(MAIN, 'evidenceChannelId', env), 'default');
    setSettingsCacheForTests(MAIN, { modLogChannelId: '300000000000000004', evidenceChannelId: null });
    assert.equal(getSetting(MAIN, 'modLogChannelId', env), '300000000000000004');
    assert.equal(settingSource(MAIN, 'modLogChannelId', env), 'database');
    assert.equal(getSetting(MAIN, 'evidenceChannelId', env), null, 'a stored null is a value');
    assert.equal(getSetting(MAIN, 'massActionLimit', env), 5, 'missing key → default');
    assert.equal(getSetting(null, 'modLogChannelId', env), CHANNEL);
    assert.throws(() => getSetting(MAIN, 'nope', env), /Unknown setting/);
    // Values are copies: callers can't change the cache.
    setSettingsCacheForTests(MAIN, { warnRoleIds: ['1'] });
    getSetting(MAIN, 'warnRoleIds', env).push('2');
    assert.deepEqual(getSetting(MAIN, 'warnRoleIds', env), ['1']);
});

test('guild roles and module settings', () => {
    const env = { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, NODE_ENV: 'test', BANNED_ROLE_ID: CHANNEL };
    assert.equal(guildIdFor('main', env), MAIN);
    assert.equal(guildIdFor('support', env), SUPPORT);
    assert.equal(guildRole(MAIN, env), 'main');
    assert.equal(guildRole(SUPPORT, env), 'support');
    assert.equal(guildRole('999', env), null);
    assert.equal(getConfiguredSetting('bannedRoleId', env), CHANNEL);
    setSettingsCacheForTests(SUPPORT, { bannedRoleId: '300000000000000005' });
    assert.equal(getConfiguredSetting('bannedRoleId', env), '300000000000000005', 'read from the support server row');
    assert.deepEqual(Object.keys(getModuleSettings(MAIN, 'logging', env)).sort(), ['evidenceChannelId', 'modLogChannelId']);
    assert.deepEqual(Object.keys(getModuleSettings(SUPPORT, 'support', env)), ['bannedRoleId']);
});

test('config getters keep their API: env values without a database row, stored values once loaded', () => {
    const main = process.env.MAIN_GUILD_ID;
    // No row: exactly what the environment says (the test process env).
    assert.equal(enforcementConfig.modLogChannelId, seedValue(getSettingEntry('modLogChannelId')));
    assert.equal(enforcementConfig.massActionLimit, seedValue(getSettingEntry('massActionLimit')));
    assert.deepEqual(automodConfig.exemptChannelIds, seedValue(getSettingEntry('exemptChannelIds')));
    assert.equal(automodConfig.reviewChannelId, seedValue(getSettingEntry('reviewChannelId')));
    assert.equal(enforcementConfig.appealWindowMs, 30 * 86400000);
    assert.ok(Object.keys(enforcementConfig).includes('modLogChannelId'), 'enumerable');
    // A stored value shows up through the same property.
    process.env.MAIN_GUILD_ID = MAIN;
    try {
        setSettingsCacheForTests(MAIN, { modLogChannelId: CHANNEL, reviewChannelId: CHANNEL });
        assert.equal(enforcementConfig.modLogChannelId, CHANNEL);
        assert.equal(automodConfig.reviewChannelId, CHANNEL);
    } finally {
        if (main === undefined) delete process.env.MAIN_GUILD_ID; else process.env.MAIN_GUILD_ID = main;
    }
    // Tests may still assign (pinned until undefined is assigned).
    enforcementConfig.evidenceChannelId = '400000000000000006';
    assert.equal(enforcementConfig.evidenceChannelId, '400000000000000006');
    enforcementConfig.evidenceChannelId = undefined;
    assert.equal(enforcementConfig.evidenceChannelId, seedValue(getSettingEntry('evidenceChannelId')));
});

test('bindSettingGetters refuses unknown keys', () => {
    assert.throws(() => bindSettingGetters({}, ['nope']), /Unknown setting/);
});
