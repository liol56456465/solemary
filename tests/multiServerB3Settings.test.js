// Multi-server B3 (A3): settings per server. Any server's dashboard saves its own row (role
// 'other': only main-server keys without homeOnly, old value = neutralValue); the home servers
// keep the registry's main/support mapping; one server never sees another server's values.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS, getSettingEntry, isHomeOnlyKey, neutralValue, validatePatch } from '../src/services/settings/settingsRegistry.js';
import {
    isOtherGuild, resetSettingsCacheForTests, resolveSetting, setSettingsCacheForTests, setSettingsDbForTests, settingGuildId,
    updateSettings,
} from '../src/services/settings/guildSettings.js';
import { registryGuildId, registryValue, saveRegistry } from '../src/services/dashboard/modules/common.js';
import { settingsRowsFor } from '../src/services/dashboard/overview.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000009';
const OTHER_B = '100000000000000010';
const CHANNEL = '200000000000000003';
const CHANNEL_B = '200000000000000005';
const ROLE = '200000000000000004';
const ENV = {
    NODE_ENV: 'production', MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT,
    MOD_LOG_CHANNEL_ID: CHANNEL, MASS_ACTION_LIMIT: '7', BANNED_ROLE_ID: ROLE, SUPPORT_SERVER_INVITE: 'https://discord.gg/abc',
};
const HOME_ONLY = ['supportServerInvite', 'premiumRoleIds', 'transparencyReportEnabled', 'trustCardEnabled'];

afterEach(() => {
    resetSettingsCacheForTests();
    setSettingsDbForTests(null);
});

/** A fake database for updateSettings: rows by guild id, every query recorded. */
function fakeDb(rows = {}) {
    const calls = [];
    const client = {
        query: async (sql, params) => {
            calls.push({ sql, params });
            const id = params[0];
            if (/^INSERT INTO guild_settings/.test(sql.trim())) {
                rows[id] ||= {};
                return { rows: [] };
            }
            if (/^SELECT data FROM guild_settings/.test(sql.trim())) return { rows: [{ data: rows[id] }] };
            if (/^UPDATE guild_settings/.test(sql.trim())) {
                rows[id] = { ...rows[id], ...JSON.parse(params[1]) };
                return { rows: [{ guild_id: id, data: rows[id], seeded_from_env: false, updated_at: null }] };
            }
            if (/^INSERT INTO dashboard_audit/.test(sql.trim())) return { rows: [] };
            throw new Error(`unexpected query ${sql}`);
        },
    };
    return {
        calls, rows,
        isAvailable: () => true,
        settingsTable: 'guild_settings',
        auditTable: 'dashboard_audit',
        query: client.query,
        withTransaction: async (fn) => fn(client),
    };
}

test('isHomeOnlyKey: the support invite, premium roles, transparency report and trust card', () => {
    for (const key of HOME_ONLY) {
        assert.equal(isHomeOnlyKey(key), true, key);
        assert.equal(getSettingEntry(key).guild, 'main', `${key} stays a main-server key`);
    }
    assert.deepEqual(SETTINGS.filter((e) => e.homeOnly).map((e) => e.key).sort(), [...HOME_ONLY].sort());
    assert.equal(isHomeOnlyKey('modLogChannelId'), false);
    assert.equal(isHomeOnlyKey('nope'), false);
});

test("validatePatch role 'other': main-server keys only, never homeOnly or support-server keys", () => {
    assert.deepEqual(validatePatch({ modLogChannelId: CHANNEL, massActionLimit: 3 }, 'other'), { modLogChannelId: CHANNEL, massActionLimit: 3 });
    assert.throws(() => validatePatch({ bannedRoleId: ROLE }, 'other'), /belongs to the support server/);
    for (const key of HOME_ONLY) {
        const value = getSettingEntry(key).fallback;
        assert.throws(() => validatePatch({ [key]: value }, 'other'), /only available in Mewvo's own servers/, key);
        assert.doesNotThrow(() => validatePatch({ [key]: value }, 'main'), `${key} still saves in the main server`);
    }
    assert.throws(() => validatePatch({ modLogChannelId: 'x' }, 'other'), /Discord ID/);
});

test('settingGuildId / isOtherGuild: home servers keep the registry mapping, others their own id or null', () => {
    assert.equal(isOtherGuild(MAIN, ENV), false);
    assert.equal(isOtherGuild(SUPPORT, ENV), false);
    assert.equal(isOtherGuild(null, ENV), false, 'missing = the main server');
    assert.equal(isOtherGuild(OTHER, ENV), true);
    assert.equal(isOtherGuild(OTHER, { ...ENV, MAIN_GUILD_ID: '' }), false, 'no home servers configured: old mapping');
    for (const home of [MAIN, SUPPORT, null]) {
        assert.equal(settingGuildId(home, 'modLogChannelId', ENV), MAIN);
        assert.equal(settingGuildId(home, 'bannedRoleId', ENV), SUPPORT);
        assert.equal(settingGuildId(home, 'supportServerInvite', ENV), MAIN);
    }
    assert.equal(settingGuildId(OTHER, 'modLogChannelId', ENV), OTHER);
    assert.equal(settingGuildId(OTHER, 'bannedRoleId', ENV), null);
    for (const key of HOME_ONLY) assert.equal(settingGuildId(OTHER, key, ENV), null, key);
});

test("updateSettings for a non-home server: role 'other', old = neutralValue, only its own row, read back per server", async () => {
    const db = fakeDb();
    setSettingsDbForTests(db);
    const { changes, settings } = await updateSettings(OTHER, { modLogChannelId: CHANNEL_B, massActionLimit: 7 }, { userId: '300000000000000001', username: 'a' }, ENV);
    assert.deepEqual(changes, [
        { key: 'modLogChannelId', module: 'logging', old: null, new: CHANNEL_B },
        // 7 is the env MASS_ACTION_LIMIT of the home servers; another server starts from the generic 5.
        { key: 'massActionLimit', module: 'enforcement', old: 5, new: 7 },
    ]);
    assert.deepEqual(settings, { modLogChannelId: CHANNEL_B, massActionLimit: 7 });
    assert.ok(db.calls.every((c) => c.params[0] === OTHER), 'every query targets the server itself');
    assert.equal(db.calls.filter((c) => /dashboard_audit/.test(c.sql)).length, 2, 'one audit row per change');
    assert.deepEqual(Object.keys(db.rows), [OTHER]);
    assert.equal(resolveSetting(OTHER, 'modLogChannelId', ENV), CHANNEL_B);
    assert.equal(resolveSetting(MAIN, 'modLogChannelId', ENV), CHANNEL, 'the main server still reads its own (env) value');
});

test('updateSettings refuses homeOnly / support keys and bad guild ids before touching the database', async () => {
    const db = fakeDb();
    setSettingsDbForTests(db);
    await assert.rejects(updateSettings(OTHER, { supportServerInvite: 'https://discord.gg/xyz' }, {}, ENV), (e) => /only available/.test(e.userMessage));
    await assert.rejects(updateSettings(OTHER, { trustCardEnabled: true }, {}, ENV), /only available/);
    await assert.rejects(updateSettings(OTHER, { bannedRoleId: ROLE }, {}, ENV), /support server/);
    await assert.rejects(updateSettings('not-a-guild', { massActionLimit: 3 }, {}, ENV), /Invalid guild id/);
    await assert.rejects(updateSettings('', { massActionLimit: 3 }, {}, ENV), /Invalid guild id/);
    assert.equal(db.calls.length, 0);
    // The home servers keep their roles: the main server may still save a homeOnly key.
    const { changes } = await updateSettings(MAIN, { trustCardEnabled: true }, {}, ENV);
    assert.deepEqual(changes.map((c) => [c.key, c.old, c.new]), [['trustCardEnabled', false, true]]);
    assert.deepEqual(Object.keys(db.rows), [MAIN]);
});

// ── Dashboard helpers (modules/common.js, overview.js) ───────────────────

function ctxFor(guildId, store = {}) {
    const saved = [];
    return {
        saved,
        ctx: {
            guildId, env: ENV, lang: 'en', actor: { userId: '300000000000000001', username: 'a' },
            services: {
                getSetting: (id, key) => (Object.hasOwn(store, `${id}:${key}`) ? store[`${id}:${key}`] : `seed:${id}:${key}`),
                resolveSetting: (id, key) => (Object.hasOwn(store, `${id}:${key}`) ? store[`${id}:${key}`] : neutralValue(getSettingEntry(key))),
                updateSettings: async (id, patch) => {
                    saved.push([id, patch]);
                    return { changes: Object.entries(patch).map(([key, value]) => ({ key, old: null, new: value })) };
                },
            },
        },
    };
}

test('registryGuildId(ctx, key): home dashboards as before, other servers their own id; the old (key, env) form still works', () => {
    assert.equal(registryGuildId(ctxFor(MAIN).ctx, 'bannedRoleId'), SUPPORT);
    assert.equal(registryGuildId(ctxFor(undefined).ctx, 'modLogChannelId'), MAIN, 'no ctx.guildId = the main server');
    assert.equal(registryGuildId(ctxFor(OTHER).ctx, 'modLogChannelId'), OTHER);
    assert.equal(registryGuildId(ctxFor(OTHER).ctx, 'bannedRoleId'), null);
    assert.equal(registryGuildId(ctxFor(OTHER).ctx, 'supportServerInvite'), null);
    assert.equal(registryGuildId('bannedRoleId', ENV), SUPPORT);
});

test('registryValue: home → getSetting of the registry server; other → its own value, neutral for keys it lacks', () => {
    const store = { [`${OTHER}:modLogChannelId`]: CHANNEL_B };
    assert.equal(registryValue(ctxFor(MAIN, store).ctx, 'bannedRoleId'), `seed:${SUPPORT}:bannedRoleId`);
    assert.equal(registryValue(ctxFor(OTHER, store).ctx, 'modLogChannelId'), CHANNEL_B);
    assert.equal(registryValue(ctxFor(OTHER_B, store).ctx, 'modLogChannelId'), null, 'another server never sees it');
    assert.equal(registryValue(ctxFor(OTHER, store).ctx, 'supportServerInvite'), null, 'homeOnly: neutral, not the home invite');
    assert.equal(registryValue(ctxFor(OTHER, store).ctx, 'bannedRoleId'), null);
    assert.equal(registryValue(ctxFor(OTHER, store).ctx, 'trustCardEnabled'), false);
});

test('saveRegistry: an other server writes only its own row and refuses keys it does not have', async () => {
    const other = ctxFor(OTHER);
    const result = await saveRegistry(other.ctx, { modLogChannelId: CHANNEL, massActionLimit: 3 }, 'enforcement');
    assert.equal(result.audited, true);
    assert.deepEqual(other.saved, [[OTHER, { modLogChannelId: CHANNEL, massActionLimit: 3 }]]);
    await assert.rejects(saveRegistry(other.ctx, { supportServerInvite: 'https://discord.gg/abc' }, 'support'), /only available in Mewvo's own servers/);
    await assert.rejects(saveRegistry(other.ctx, { bannedRoleId: ROLE }, 'support'), /only available/);
    assert.equal(other.saved.length, 1, 'nothing saved on refusal');

    const home = ctxFor(MAIN);
    await saveRegistry(home.ctx, { modLogChannelId: CHANNEL, bannedRoleId: ROLE }, 'enforcement');
    assert.deepEqual(home.saved, [[MAIN, { modLogChannelId: CHANNEL }], [SUPPORT, { bannedRoleId: ROLE }]], 'home: old split by server');
});

test('settingsRowsFor(client, module, guildId): per-server values and sources', () => {
    const saved = { ...process.env };
    Object.assign(process.env, ENV);
    try {
        setSettingsCacheForTests(MAIN, { modLogChannelId: CHANNEL });
        setSettingsCacheForTests(OTHER, { modLogChannelId: CHANNEL_B });
        setSettingsCacheForTests(OTHER_B, {});
        const client = { guilds: { cache: new Map() } };
        const row = (guildId) => settingsRowsFor(client, 'logging', guildId).find((r) => r.key === 'modLogChannelId');
        assert.equal(row(MAIN).source, 'database');
        assert.equal(row(OTHER).source, 'database');
        assert.match(String(row(OTHER).display), new RegExp(CHANNEL_B));
        assert.equal(row(OTHER_B).source, 'default', 'nothing stored: neutral default, never the env');
        assert.doesNotMatch(String(row(OTHER_B).display), new RegExp(`${CHANNEL}|${CHANNEL_B}`));
        const invite = settingsRowsFor(client, 'support', OTHER).find((r) => r.key === 'supportServerInvite');
        assert.equal(invite.source, 'default');
        assert.doesNotMatch(String(invite.display), /discord\.gg/);
    } finally {
        for (const key of Object.keys(ENV)) {
            if (Object.hasOwn(saved, key)) process.env[key] = saved[key];
            else delete process.env[key];
        }
    }
});
