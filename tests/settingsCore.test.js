// Multi-server settings core (B0a): resolveSetting / settingsFor / refreshGuildSettings.
// Home servers keep exactly today's values; other servers never borrow env or production IDs;
// a database error throws instead of returning defaults; the env seed is additive only.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS, entriesForGuild, getSettingEntry, neutralValue, settingKeys } from '../src/services/settings/settingsRegistry.js';
import {
    SettingsUnavailableError, getConfiguredSetting, getSetting, isHomeGuild, missingSeedPatch, refreshGuildSettings,
    resetSettingsCacheForTests, resolveSetting, resolvedSource, setSettingsCacheForTests, setSettingsDbForTests,
    settingsFor,
} from '../src/services/settings/guildSettings.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/homeSettingsSnapshot.json', import.meta.url), 'utf8'));

const PROD_MAIN = '1527697154926182492';
const PROD_SUPPORT = '1564312871976829009';
const OTHER = '100000000000000009';
const CHANNEL = '200000000000000003';
const ROLE = '200000000000000004';

// A full production-like env: every registry env var set, so a leak to another server would show.
const LOADED_ENV = {
    NODE_ENV: 'production', MAIN_GUILD_ID: PROD_MAIN, SUPPORT_GUILD_ID: PROD_SUPPORT,
    ADMIN_REQUEST_CHANNEL_ID: CHANNEL, MUTED_ROLE_ID: ROLE, WARN_ROLE_IDS: `${ROLE},${CHANNEL}`,
    MASS_ACTION_LIMIT: '7', MOD_LOG_CHANNEL_ID: CHANNEL, EVIDENCE_CHANNEL_ID: CHANNEL, AUTOMOD_REVIEW_CHANNEL_ID: CHANNEL,
    BOT_ALERTS_CHANNEL_ID: CHANNEL, AUTOMOD_EXEMPT_CHANNEL_IDS: CHANNEL, AUTOMOD_EXTRA_WORDS: 'Foo',
    MAIN_APPEALS_CATEGORY_ID: CHANNEL, APPEALS_CATEGORY_ID: CHANNEL, BANNED_ROLE_ID: ROLE,
    VERIFY_SUCCESS_REDIRECT: 'https://example.com/ok', SUPPORT_SERVER_INVITE: 'https://discord.gg/abc',
};

function fakeDb({ available = true, rows = [], fail = null } = {}) {
    const calls = [];
    return {
        calls,
        isAvailable: () => available,
        settingsTable: 'guild_settings',
        auditTable: 'dashboard_audit',
        query: async (sql, params) => {
            calls.push({ sql, params });
            if (fail) throw fail;
            return { rows: rows.filter((row) => row.guild_id === params[0]) };
        },
        withTransaction: async () => { throw new Error('not used'); },
    };
}

afterEach(() => {
    resetSettingsCacheForTests();
    setSettingsDbForTests(null);
});

/** Mark the cache as loaded the way loadAllSettings does (rows read, possibly zero). */
async function markLoaded(rows = []) {
    const { loadAllSettings } = await import('../src/services/settings/guildSettings.js');
    setSettingsDbForTests({ ...fakeDb(), query: async () => ({ rows }) });
    await loadAllSettings();
    setSettingsDbForTests(null);
}

// ── Home servers: identical to before ─────────────────────────────────────

for (const nodeEnv of ['production', 'test']) {
    test(`home servers (${nodeEnv}): settingsFor matches the pre-B0a snapshot exactly`, () => {
        const env = { NODE_ENV: nodeEnv, MAIN_GUILD_ID: PROD_MAIN, SUPPORT_GUILD_ID: PROD_SUPPORT };
        assert.deepEqual(Object.keys(SNAPSHOT[nodeEnv].main).sort(), settingKeys().sort(), 'snapshot covers every key');
        assert.deepEqual(settingsFor(PROD_MAIN, env), SNAPSHOT[nodeEnv].main);
        assert.deepEqual(settingsFor(PROD_SUPPORT, env), SNAPSHOT[nodeEnv].support);
    });
}

test('home servers: resolveSetting === getSetting for every key, with env, stored rows and no cache', async () => {
    const check = (label) => {
        for (const key of settingKeys()) {
            for (const guild of [PROD_MAIN, PROD_SUPPORT]) {
                assert.deepEqual(resolveSetting(guild, key, LOADED_ENV), getSetting(guild, key, LOADED_ENV), `${label} ${guild} ${key}`);
            }
            const entry = getSettingEntry(key);
            const home = entry.guild === 'support' ? PROD_SUPPORT : PROD_MAIN;
            assert.deepEqual(resolveSetting(home, key, LOADED_ENV), getConfiguredSetting(key, LOADED_ENV), `${label} compat ${key}`);
        }
    };
    check('not loaded (database down at boot → env, owner decision 1)');
    await markLoaded([{ guild_id: PROD_MAIN, data: { modLogChannelId: ROLE, massActionLimit: 9 }, seeded_from_env: true }]);
    check('loaded');
    assert.equal(resolveSetting(PROD_MAIN, 'modLogChannelId', LOADED_ENV), ROLE, 'stored value wins');
    assert.equal(resolvedSource(PROD_MAIN, 'modLogChannelId', LOADED_ENV), 'database');
    assert.equal(resolvedSource(PROD_MAIN, 'mutedRoleId', LOADED_ENV), 'env');
});

test('home servers follow the configured MAIN_GUILD_ID / SUPPORT_GUILD_ID (test servers in test mode)', () => {
    const env = { NODE_ENV: 'test', MAIN_GUILD_ID: '100000000000000001', SUPPORT_GUILD_ID: '100000000000000002', MOD_LOG_CHANNEL_ID: CHANNEL };
    assert.equal(isHomeGuild('100000000000000001', env), true);
    assert.equal(isHomeGuild('100000000000000002', env), true);
    assert.equal(isHomeGuild(PROD_MAIN, env), false, 'the production id is not home when another main server is configured');
    assert.equal(resolveSetting('100000000000000001', 'modLogChannelId', env), CHANNEL);
});

// ── Other servers: no env, no production IDs ──────────────────────────────

test('other server, empty row: neutral defaults only, never an env value or production ID', async () => {
    await markLoaded([]);
    const values = settingsFor(OTHER, LOADED_ENV);
    const homeIds = new Set([CHANNEL, ROLE, ...JSON.stringify(SNAPSHOT.production).match(/\d{17,20}/g)]);
    for (const entry of SETTINGS) {
        const value = values[entry.key];
        assert.deepEqual(value, neutralValue(entry), entry.key);
        for (const id of JSON.stringify(value ?? null).match(/\d{17,20}/g) || []) {
            assert.ok(!homeIds.has(id), `${entry.key} leaks ${id}`);
        }
        assert.ok(!JSON.stringify(value ?? null).includes('discord.gg'), `${entry.key} leaks an invite`);
        assert.equal(resolvedSource(OTHER, entry.key, LOADED_ENV), 'default');
    }
    // Spot checks of the rules.
    assert.equal(values.modLogChannelId, null);
    assert.equal(values.adminRequestChannelId, null);
    assert.deepEqual(values.warnRoleIds, []);
    assert.deepEqual(values.extraBlockedWords, [], 'env words are not lent');
    assert.equal(values.bannedRoleId, null);
    assert.equal(values.supportServerInvite, null);
    assert.equal(values.verifySuccessRedirect, null);
    assert.equal(values.massActionLimit, 5, 'generic default kept, env 7 not lent');
    assert.equal(values.appealWindowMs, 30 * 86400000);
    assert.equal(values.catName, getSettingEntry('catName').fallback);
    assert.deepEqual(values.serverRules, { rules: [], updatedAt: null });
    // Copies: changing the result changes nothing.
    values.serverRules.rules.push({});
    assert.deepEqual(resolveSetting(OTHER, 'serverRules', LOADED_ENV), { rules: [], updatedAt: null });
});

test('other server: its own stored values are returned, missing keys neutral', async () => {
    await markLoaded([{ guild_id: OTHER, data: { modLogChannelId: CHANNEL, massActionLimit: 3, warnRoleIds: [ROLE] } }]);
    assert.equal(resolveSetting(OTHER, 'modLogChannelId', LOADED_ENV), CHANNEL);
    assert.equal(resolveSetting(OTHER, 'massActionLimit', LOADED_ENV), 3);
    assert.deepEqual(resolveSetting(OTHER, 'warnRoleIds', LOADED_ENV), [ROLE]);
    assert.equal(resolveSetting(OTHER, 'mutedRoleId', LOADED_ENV), null);
    assert.equal(resolvedSource(OTHER, 'modLogChannelId', LOADED_ENV), 'database');
    const copy = resolveSetting(OTHER, 'warnRoleIds', LOADED_ENV);
    copy.push('x');
    assert.deepEqual(resolveSetting(OTHER, 'warnRoleIds', LOADED_ENV), [ROLE]);
});

test('neutralValue: places are null/empty for every entry; generic defaults kept', () => {
    for (const entry of SETTINGS) {
        const value = neutralValue(entry);
        if (['channel', 'category', 'role', 'url'].includes(entry.kind)) assert.equal(value, null, entry.key);
        if (entry.kind === 'list') assert.deepEqual(value, [], entry.key);
        if (entry.prodOnly) assert.ok(value === null || (Array.isArray(value) && !value.length), entry.key);
        if (value !== null && typeof value === 'object') assert.equal(Object.isFrozen(value), false, `${entry.key} is a copy`);
    }
});

// ── Database errors throw, never defaults ─────────────────────────────────

test('other server while the table was never read (database down at boot): throws, no defaults', () => {
    assert.throws(() => resolveSetting(OTHER, 'modLogChannelId', LOADED_ENV), (error) => {
        assert.ok(error instanceof SettingsUnavailableError);
        assert.equal(error.type, 'database');
        assert.match(error.userMessage, /nothing was changed/);
        return true;
    });
    assert.throws(() => settingsFor(OTHER, LOADED_ENV), SettingsUnavailableError);
    assert.throws(() => resolvedSource(OTHER, 'modLogChannelId', LOADED_ENV), SettingsUnavailableError);
    // Home rows held in the cache (as the seed leaves them) do not make other servers readable.
    setSettingsCacheForTests(PROD_MAIN, { modLogChannelId: ROLE });
    assert.throws(() => resolveSetting(OTHER, 'modLogChannelId', LOADED_ENV), SettingsUnavailableError);
    // Home defaults are copies too.
    const rules = settingsFor(PROD_MAIN, { NODE_ENV: 'test', MAIN_GUILD_ID: PROD_MAIN }).rulesPost;
    rules.title = 'changed';
    assert.equal(getSetting(PROD_MAIN, 'rulesPost', { NODE_ENV: 'test' }).title, 'Server rules');
    setSettingsCacheForTests(PROD_MAIN, null);
    // The home servers keep running on env (owner decision 1).
    assert.equal(resolveSetting(PROD_MAIN, 'modLogChannelId', LOADED_ENV), CHANNEL);
});

test('refreshGuildSettings: query error or database down → throws, cache untouched', async () => {
    setSettingsCacheForTests(OTHER, { modLogChannelId: CHANNEL });
    setSettingsDbForTests(fakeDb({ fail: Object.assign(new Error('connection terminated'), { code: '08006' }) }));
    await assert.rejects(refreshGuildSettings(OTHER, LOADED_ENV), (error) => {
        assert.ok(error instanceof SettingsUnavailableError);
        assert.equal(error.cause.code, '08006');
        return true;
    });
    assert.equal(resolveSetting(OTHER, 'modLogChannelId', LOADED_ENV), CHANNEL, 'cached row kept');
    setSettingsDbForTests(fakeDb({ available: false }));
    await assert.rejects(refreshGuildSettings(OTHER, LOADED_ENV), SettingsUnavailableError);
});

test('refreshGuildSettings: reads the row of that guild only; no row → neutral defaults (not an error)', async () => {
    const db = fakeDb({ rows: [{ guild_id: OTHER, data: { modLogChannelId: CHANNEL, bogus: 1 } }] });
    setSettingsDbForTests(db);
    const values = await refreshGuildSettings(OTHER, LOADED_ENV);
    assert.equal(values.modLogChannelId, CHANNEL);
    assert.equal(values.mutedRoleId, null);
    assert.deepEqual(db.calls.at(-1).params, [OTHER]);
    assert.match(db.calls.at(-1).sql, /WHERE guild_id = \$1/);

    const EMPTY = '100000000000000010';
    const values2 = await refreshGuildSettings(EMPTY, LOADED_ENV);
    assert.equal(values2.modLogChannelId, null);
    assert.equal(resolveSetting(EMPTY, 'massActionLimit', LOADED_ENV), 5, 'readable after the refresh');
    await assert.rejects(refreshGuildSettings('', LOADED_ENV), TypeError);
});

test('resolveSetting refuses unknown keys and missing guild ids', () => {
    assert.throws(() => resolveSetting(PROD_MAIN, 'nope', LOADED_ENV), /Unknown setting/);
    assert.throws(() => resolveSetting(null, 'modLogChannelId', LOADED_ENV), TypeError);
    assert.throws(() => settingsFor('', LOADED_ENV), TypeError);
});

// ── Additive seed ─────────────────────────────────────────────────────────

test('missingSeedPatch: only keys the row lacks; stored values (null included) are never overwritten', () => {
    const entries = entriesForGuild('main');
    const stored = { modLogChannelId: ROLE, evidenceChannelId: null, massActionLimit: 2, serverRules: { rules: [], updatedAt: null } };
    const patch = missingSeedPatch(stored, entries, LOADED_ENV);
    for (const key of Object.keys(stored)) assert.ok(!Object.hasOwn(patch, key), `${key} must not be in the patch`);
    assert.equal(patch.mutedRoleId, ROLE, 'missing key seeded from env');
    assert.equal(patch.adminRequestChannelId, CHANNEL);
    assert.ok(!Object.hasOwn(patch, 'bannedRoleId'), 'support-server key not seeded into the main row');
    // Applying the patch the way seedFromEnvOnce does (data || patch) keeps every stored value.
    const after = { ...stored, ...patch };
    for (const [key, value] of Object.entries(stored)) assert.deepEqual(after[key], value, key);
    // Fully seeded row → empty patch (running the seed again changes nothing).
    assert.deepEqual(missingSeedPatch(after, entries, LOADED_ENV), {});
    // Garbage data is treated as empty, invalid env values are left out.
    assert.ok(Object.keys(missingSeedPatch(null, entries, LOADED_ENV)).length > 0);
    assert.ok(!Object.hasOwn(missingSeedPatch({}, entries, { ...LOADED_ENV, MOD_LOG_CHANNEL_ID: '12' }), 'modLogChannelId'));
});
