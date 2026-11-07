// Multi-server B0b batch 2: staff channels, postModLog / postAlert, automod lists and the rejoin
// invite per server. The home servers (main + support) keep the main server's values; any other
// server only ever uses its own, a missing channel is a quiet skip (never a post to the main
// server), and a server whose settings could not be read is skipped without a crash or log flood.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';
const MAIN = process.env.MAIN_GUILD_ID;
const SUPPORT = process.env.SUPPORT_GUILD_ID;
const OTHER = '100000000000000777';
const UNREAD = '100000000000000888';

const { enforcementConfig } = await import('../../src/config/enforcement.js');
const { automodConfig } = await import('../../src/config/automod.js');
const { logger } = await import('../../src/utils/logger.js');
const settings = await import('../../src/services/settings/guildSettings.js');
const { resetSettingsUnavailableNotes, noteSettingsUnavailable, usesHomeValues } = await import('../../src/services/settings/guildScoped.js');
const routing = await import('../../src/services/automod/channelRouting.js');
const failures = await import('../../src/services/automod/postFailures.js');
const { postModLog, createRejoinInvite } = await import('../../src/services/enforcement/enforcementService.js');
const { postAlert } = await import('../../src/services/automod/alertPost.js');
const filters = await import('../../src/services/automod/filters.js');
const { storedCustomRules, findCustomRuleHit, resetCustomRulesCache } = await import('../../src/services/automod/customRules.js');
const { exemptChannelIdsOf } = await import('../../src/services/automod/automodSettings.js');

const MAIN_CH = { modlog: '300000000000000001', alerts: '300000000000000002', review: '300000000000000003' };
const OTHER_CH = { modlog: '400000000000000001', review: '400000000000000003' };

const pinned = {
    modLogChannelId: [enforcementConfig, MAIN_CH.modlog],
    alertsChannelId: [automodConfig, MAIN_CH.alerts],
    reviewChannelId: [automodConfig, MAIN_CH.review],
    exemptChannelIds: [automodConfig, ['500000000000000001']],
    extraBlockedWords: [automodConfig, ['mainonlyzebra']],
    automodCustomRules: [automodConfig, [{ id: 'mainrul1', name: 'Main rule', words: ['mainonlyword'], action: 'delete', muteDuration: null, enabled: true }]],
};
const before = { mainGuildId: enforcementConfig.mainGuildId };
enforcementConfig.mainGuildId = MAIN;
for (const [key, [config, value]] of Object.entries(pinned)) config[key] = value;

afterEach(() => {
    settings.resetSettingsCacheForTests();
    failures.resetPostFailures();
    resetSettingsUnavailableNotes();
    filters.resetBlockedCache();
    resetCustomRulesCache();
});

test.after(() => {
    for (const [key, [config]] of Object.entries(pinned)) config[key] = undefined;
    enforcementConfig.mainGuildId = before.mainGuildId;
});

/** A guild whose channels each record what was sent to them. */
function fakeGuild(id, channelIds) {
    const sent = [];
    const guild = { id, members: { me: {} } };
    const channels = channelIds.map((cid) => ({
        id: cid, name: `ch-${cid.slice(-2)}`, guild, isTextBased: () => true,
        send: async (payload) => { sent.push({ channelId: cid, payload }); return { id: 'm' }; },
    }));
    guild.channels = { cache: new Map(channels.map((c) => [c.id, c])), fetch: async () => null };
    return { guild, sent };
}

function fakeClient() {
    const main = fakeGuild(MAIN, Object.values(MAIN_CH));
    const other = fakeGuild(OTHER, Object.values(OTHER_CH));
    const unread = fakeGuild(UNREAD, ['600000000000000001']);
    const client = { guilds: { cache: new Map([[MAIN, main.guild], [OTHER, other.guild], [UNREAD, unread.guild]]) } };
    return { client, main, other, unread };
}

/** Collects logger.warn calls while `fn` runs. */
async function withWarnings(fn) {
    const warnings = [];
    const original = logger.warn;
    logger.warn = (message) => { warnings.push(String(message)); };
    try {
        await fn();
    } finally {
        logger.warn = original;
    }
    return warnings;
}

// ── Channel routing ───────────────────────────────────────────────────────

test('home servers keep the main server\'s staff channels; the support server posts in the main server', () => {
    assert.equal(usesHomeValues(MAIN), true);
    assert.equal(usesHomeValues(SUPPORT), true);
    assert.equal(usesHomeValues(null), true, 'no guild: the old main-server behaviour');
    assert.equal(usesHomeValues(OTHER), false);
    for (const guildId of [MAIN, SUPPORT, null]) {
        assert.equal(routing.resolveChannelId(guildId, 'modlog'), MAIN_CH.modlog);
        assert.equal(routing.resolveChannelId(guildId, 'alerts'), MAIN_CH.alerts);
        assert.equal(routing.resolveChannelId(guildId, 'review'), MAIN_CH.review);
        assert.equal(routing.staffGuildId(guildId), MAIN);
    }
});

test('another server: only its own channels, with the mod log fallback; nothing set → null, never the main server\'s', () => {
    settings.setSettingsCacheForTests(OTHER, { modLogChannelId: OTHER_CH.modlog, reviewChannelId: OTHER_CH.review });
    assert.equal(routing.resolveChannelId(OTHER, 'modlog'), OTHER_CH.modlog);
    assert.equal(routing.resolveChannelId(OTHER, 'review'), OTHER_CH.review);
    assert.equal(routing.resolveChannelId(OTHER, 'alerts'), OTHER_CH.modlog, 'alerts fall back to its own mod log');
    assert.equal(routing.staffGuildId(OTHER), OTHER);

    settings.setSettingsCacheForTests(OTHER, { enabledModules: {} });
    for (const purpose of ['modlog', 'alerts', 'review']) assert.equal(routing.resolveChannelId(OTHER, purpose), null, purpose);
});

test('another server whose settings could not be read: resolveChannelId throws, fetchStaffChannel skips quietly (one log line)', async () => {
    const { client } = fakeClient();
    assert.throws(() => routing.resolveChannelId(UNREAD, 'modlog'), (error) => error instanceof settings.SettingsUnavailableError);
    const warnings = await withWarnings(async () => {
        for (let i = 0; i < 5; i += 1) assert.equal(await routing.fetchStaffChannel(client, UNREAD, 'review'), null);
    });
    assert.equal(warnings.length, 1, 'logged once, not per call');
    assert.match(warnings[0], /100000000000000888/);
});

test('fetchStaffChannel: home → the main server\'s channel; another server → its own, or null (never the main server\'s)', async () => {
    const { client } = fakeClient();
    assert.equal((await routing.fetchStaffChannel(client, SUPPORT, 'review')).id, MAIN_CH.review);
    settings.setSettingsCacheForTests(OTHER, { reviewChannelId: OTHER_CH.review });
    assert.equal((await routing.fetchStaffChannel(client, OTHER, 'review')).id, OTHER_CH.review);
    settings.setSettingsCacheForTests(OTHER, {});
    assert.equal(await routing.fetchStaffChannel(client, OTHER, 'review'), null);
});

// ── postModLog / postAlert ────────────────────────────────────────────────

test('postModLog: home servers post in the main mod log, as before (also without a guildId)', async () => {
    const { client, main } = fakeClient();
    await postModLog(client, 'ban', [{ name: 'User', value: 'x' }]);
    await postModLog(client, 'ban', [{ name: 'User', value: 'y' }], { guildId: SUPPORT });
    await postModLog(client, 'raid', [{ name: 'What', value: 'z' }], { guildId: MAIN });
    assert.deepEqual(main.sent.map((s) => s.channelId), [MAIN_CH.modlog, MAIN_CH.modlog, MAIN_CH.alerts]);
});

test('postModLog: another server posts in its own channel; with none set it is recorded and skipped, never the main server', async () => {
    const { client, main, other } = fakeClient();
    settings.setSettingsCacheForTests(OTHER, { modLogChannelId: OTHER_CH.modlog });
    await postModLog(client, 'ban', [{ name: 'User', value: 'x' }], { guildId: OTHER });
    await postModLog(client, 'raid', [{ name: 'What', value: 'y' }], { guildId: OTHER });
    assert.deepEqual(other.sent.map((s) => s.channelId), [OTHER_CH.modlog, OTHER_CH.modlog]);
    assert.equal(main.sent.length, 0);

    settings.setSettingsCacheForTests(OTHER, {});
    await postModLog(client, 'ban', [{ name: 'User', value: 'x' }], { guildId: OTHER });
    assert.equal(main.sent.length, 0, 'not set: nothing goes to the main server');
    assert.equal(other.sent.length, 2);
    assert.equal(failures.listPostFailures(OTHER)[0].reason, 'notSet', 'recorded for that server');
    assert.deepEqual(failures.listPostFailures(MAIN), []);

    settings.setSettingsCacheForTests(OTHER, { modLogChannelId: MAIN_CH.modlog });
    await postModLog(client, 'ban', [{ name: 'User', value: 'x' }], { guildId: OTHER });
    assert.equal(main.sent.length, 0, 'a channel id of another server is looked up in this server only');
    assert.equal(failures.listPostFailures(OTHER).find((f) => f.reason === 'missing')?.channelId, MAIN_CH.modlog);
});

test('postModLog / postAlert: a server whose settings could not be read is skipped, no throw, no log flood', async () => {
    const { client, main, unread } = fakeClient();
    const warnings = await withWarnings(async () => {
        for (let i = 0; i < 4; i += 1) {
            await postModLog(client, 'ban', [{ name: 'User', value: 'x' }], { guildId: UNREAD });
            assert.equal(await postAlert(client, 'raid', { guildId: UNREAD, title: 'Raid' }), null);
        }
    });
    assert.equal(main.sent.length + unread.sent.length, 0);
    assert.equal(warnings.length, 1);
    assert.deepEqual(failures.listPostFailures(UNREAD), [], 'not a channel problem: nothing recorded');
});

test('postAlert: another server without a channel is skipped and recorded for it; home posts in the main alerts channel', async () => {
    const { client, main, other } = fakeClient();
    settings.setSettingsCacheForTests(OTHER, {});
    assert.equal(await postAlert(client, 'raid', { guildId: OTHER, title: 'Raid' }), null);
    assert.equal(main.sent.length + other.sent.length, 0);
    assert.equal(failures.listPostFailures(OTHER)[0].reason, 'notSet');

    settings.setSettingsCacheForTests(OTHER, { modLogChannelId: OTHER_CH.modlog });
    assert.ok(await postAlert(client, 'raid', { guildId: OTHER, title: 'Raid' }));
    assert.deepEqual(other.sent.map((s) => s.channelId), [OTHER_CH.modlog]);
    assert.ok(await postAlert(client, 'raid', { guildId: SUPPORT, title: 'Raid' }));
    assert.deepEqual(main.sent.map((s) => s.channelId), [MAIN_CH.alerts]);
});

test('noteSettingsUnavailable: once per server per 10 minutes', async () => {
    const warnings = await withWarnings(() => {
        assert.equal(noteSettingsUnavailable('g1', 'x', 0), true);
        assert.equal(noteSettingsUnavailable('g1', 'x', 1000), false);
        assert.equal(noteSettingsUnavailable('g2', 'x', 1000), true);
        assert.equal(noteSettingsUnavailable('g1', 'x', 10 * 60 * 1000 + 1), true);
    });
    assert.equal(warnings.length, 3);
});

// ── Automod lists ─────────────────────────────────────────────────────────

test('extra blocked words are per server: the main server\'s never apply elsewhere, each server\'s own do', () => {
    assert.equal(filters.findBlockedWord('a mainonlyzebra here', MAIN), 'mainonlyzebra');
    assert.equal(filters.findBlockedWord('a mainonlyzebra here', SUPPORT), 'mainonlyzebra', 'support: as before');
    assert.equal(filters.findBlockedWord('a mainonlyzebra here'), 'mainonlyzebra', 'no guild: as before');

    settings.setSettingsCacheForTests(OTHER, { extraBlockedWords: ['otheronlyquokka'] });
    assert.equal(filters.findBlockedWord('a mainonlyzebra here', OTHER), null);
    assert.equal(filters.findBlockedWord('an otheronlyquokka here', OTHER), 'otheronlyquokka');
    assert.equal(filters.findBlockedWord('an otheronlyquokka here', MAIN), null);
    assert.equal(filters.findBlockedWord('you n1gg3r', OTHER), 'nigger', 'the built-in list applies everywhere');
    assert.ok(filters.findListWords('an otheronlyquokka here', OTHER).some((hit) => hit.word === 'otheronlyquokka'));

    settings.setSettingsCacheForTests(OTHER, { extraBlockedWords: ['otheronlyquokka', 'secondwombat'] });
    assert.equal(filters.findBlockedWord('a secondwombat', OTHER), 'secondwombat', 'a changed list is recompiled');

    assert.throws(() => filters.findBlockedWord('text', UNREAD), (error) => error instanceof settings.SettingsUnavailableError);
});

test('the compiled blocked-word cache is bounded and shared by the home servers', () => {
    filters.findBlockedWord('x', MAIN);
    filters.findBlockedWord('x', SUPPORT);
    filters.findBlockedWord('x');
    assert.equal(filters.blockedCacheSize(), 1, 'one entry for all home servers');
    for (let i = 0; i < filters.BLOCKED_CACHE_MAX + 50; i += 1) {
        const id = `7000000000000${String(i).padStart(5, '0')}`;
        settings.setSettingsCacheForTests(id, { extraBlockedWords: i % 2 ? [`word${i}`] : [] });
        filters.findBlockedWord('hello', id);
    }
    assert.equal(filters.blockedCacheSize(), filters.BLOCKED_CACHE_MAX);
});

test('custom rules and exempt channels are per server', () => {
    assert.equal(storedCustomRules(MAIN)[0].name, 'Main rule');
    assert.equal(storedCustomRules()[0].name, 'Main rule', 'no guild: as before');
    settings.setSettingsCacheForTests(OTHER, {});
    assert.deepEqual(storedCustomRules(OTHER), []);
    assert.equal(findCustomRuleHit('mainonlyword', OTHER), null, 'the main server\'s rules never run elsewhere');
    const own = { id: 'othrrul1', name: 'Other rule', words: ['quokka'], action: 'delete', muteDuration: null, enabled: true };
    settings.setSettingsCacheForTests(OTHER, { automodCustomRules: [own] });
    assert.deepEqual(storedCustomRules(OTHER).map((r) => r.name), ['Other rule']);
    assert.throws(() => storedCustomRules(UNREAD), (error) => error instanceof settings.SettingsUnavailableError);
    // The matcher skips an unreadable server for this run instead of crashing (logged once).
    assert.equal(findCustomRuleHit('mainonlyword', UNREAD), null);

    assert.deepEqual(exemptChannelIdsOf(MAIN, { exemptChannelIds: ['x'] }), ['500000000000000001', 'x']);
    assert.deepEqual(exemptChannelIdsOf(OTHER, { exemptChannelIds: ['x'] }), ['x'], 'the main list is not merged in');
    settings.setSettingsCacheForTests(OTHER, { exemptChannelIds: ['y'] });
    assert.deepEqual(exemptChannelIdsOf(OTHER, { exemptChannelIds: ['x'] }), ['y', 'x']);
});

test('createRejoinInvite: the invite age of the server it is for', async () => {
    const made = [];
    const guildWith = (id) => {
        const channel = { type: 0, permissionsFor: () => ({ has: () => true }) };
        return {
            id, members: { me: {} }, rulesChannel: channel, systemChannel: null, channels: { cache: new Map() },
            invites: { create: async (_c, options) => { made.push(options.maxAge); return { url: 'https://discord.gg/x' }; } },
        };
    };
    settings.setSettingsCacheForTests(OTHER, { rejoinInviteMaxAgeSeconds: 3600 });
    await createRejoinInvite(guildWith(OTHER), 'r');
    await createRejoinInvite(guildWith(MAIN), 'r');
    assert.equal(made[0], 3600);
    assert.equal(made[1], enforcementConfig.rejoinInviteMaxAgeSeconds);
});
