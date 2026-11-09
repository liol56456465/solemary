// Beginner audit 2.2 / 2.2b / D4: automod starts in Report only in other servers, refuses to turn on
// without a channel for review cards, and automod warns do not move the warn ladder there by default;
// a per-server warn ladder switch. No database: memory KV store + a fake enforcement database.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000003';
const UNREAD = '100000000000000009';
const BOT = '500000000000000001';
const TARGET = '600000000000000001';
const MOD = '600000000000000002';

Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT });

const { pgDb } = await import('../../src/utils/postgresDatabase.js');
const { db } = await import('../../src/utils/database/wrapper.js');
const { MemoryStorage } = await import('../../src/utils/memoryStorage.js');
const { resetSettingsCacheForTests, setSettingsCacheForTests } = await import('../../src/services/settings/guildSettings.js');
const { enforcementConfig } = await import('../../src/config/enforcement.js');
const settings = await import('../../src/services/automod/automodSettings.js');
const policy = await import('../../src/services/enforcement/ladderPolicy.js');
const enforcement = await import('../../src/services/enforcement/enforcementService.js');
const { warnDm } = await import('../../src/services/enforcement/dmTemplates.js');
const { warnEffectText, countedWarnsText, availableActions } = await import('../../src/services/enforcement/flowBuilder.js');
const { memberLadderLine } = await import('../../src/services/enforcement/precedentService.js');
const { nextWarningText, standingFields } = await import('../../src/services/enforcement/standingService.js');
const { buildRecordView, nextWarningWords } = await import('../../src/services/site/memberPortal.js');
const { buildRecordList } = await import('../../src/handlers/backgroundView.js');
const { botText } = await import('../../src/utils/botText.js');
const { getSettingEntry, neutralValue } = await import('../../src/services/settings/settingsRegistry.js');

const realIsAvailable = pgDb.isAvailable;
const realPool = pgDb.pool;
const savedMain = enforcementConfig.mainGuildId;

function memoryDb() {
    db.db = new MemoryStorage();
    db.useFallback = true;
    db.initialized = true;
    db.connectionType = 'memory';
}

function setup(rows = {}) {
    memoryDb();
    resetSettingsCacheForTests();
    settings.resetAutomodSettingsCache();
    for (const id of [OTHER, SUPPORT]) setSettingsCacheForTests(id, rows[id] || {});
}

afterEach(() => {
    pgDb.isAvailable = realIsAvailable;
    pgDb.pool = realPool;
    enforcementConfig.mainGuildId = savedMain;
});

// ── 2.2 Report only first ─────────────────────────────────────────────────

test('2.2 another server: the first "on" starts in Report only, and says so', async () => {
    setup();
    const first = await settings.setAutomodEnabled(OTHER, true);
    assert.equal(first.enabled, true);
    assert.equal(first.mode, 'monitor');
    assert.equal(first.startedInMonitor, true);
    assert.ok(first.firstEnabledAt > 0 && first.monitorSince > 0);
    // The flag is on the reply only, never in the cached or stored settings.
    assert.equal((await settings.getAutomodSettings(OTHER)).startedInMonitor, undefined);
    const stored = await db.get(`automod:settings:${OTHER}`);
    assert.equal(Object.hasOwn(stored, 'startedInMonitor'), false);
    assert.equal(stored.mode, 'monitor');
});

test('2.2 only the first "on": a server that chose On keeps it after off → on', async () => {
    setup();
    await settings.setAutomodEnabled(OTHER, true);
    await settings.setAutomodMode(OTHER, 'enforce');
    await settings.setAutomodEnabled(OTHER, false);
    const again = await settings.setAutomodEnabled(OTHER, true);
    assert.equal(again.mode, 'enforce');
    assert.equal(again.startedInMonitor, false);
    assert.equal(again.monitorSince, null);
});

test('2.2 existing servers that already run automod keep their mode (no silent change)', async () => {
    setup();
    // Stored before this change: on, enforcing, no firstEnabledAt marker.
    await db.set(`automod:settings:${OTHER}`, { enabled: true, mode: 'enforce', staffGuard: false });
    settings.resetAutomodSettingsCache();
    assert.equal((await settings.getAutomodSettings(OTHER)).mode, 'enforce');
    const off = await settings.setAutomodEnabled(OTHER, false);
    assert.ok(off.firstEnabledAt > 0, 'turning off stamps the marker');
    const on = await settings.setAutomodEnabled(OTHER, true);
    assert.equal(on.mode, 'enforce');
    assert.equal(on.startedInMonitor, false);
    // Already on and turned "on" again: nothing changes either.
    assert.equal((await settings.setAutomodEnabled(OTHER, true)).mode, 'enforce');
});

test('2.2 Mewvo\'s home servers keep On (main server and support server)', async () => {
    setup();
    await settings.setAutomodEnabled(MAIN, false);
    const main = await settings.setAutomodEnabled(MAIN, true);
    assert.equal(main.mode, 'enforce');
    assert.equal(main.startedInMonitor, false);
    const support = await settings.setAutomodEnabled(SUPPORT, true);
    assert.equal(support.mode, 'enforce');
    assert.equal(support.startedInMonitor, false);
    assert.equal(settings.startsInMonitor(MAIN), false);
    assert.equal(settings.startsInMonitor(SUPPORT), false);
    assert.equal(settings.startsInMonitor(OTHER), true);
});

test('2.2 the "Switch to On" nudge: after 24 h of Report only, never while enforcing or off', async () => {
    setup();
    const on = await settings.setAutomodEnabled(OTHER, true);
    const t0 = on.monitorSince;
    assert.equal(settings.shouldNudgeToEnforce(on, t0 + settings.MONITOR_NUDGE_MS - 1), false);
    assert.equal(settings.shouldNudgeToEnforce(on, t0 + settings.MONITOR_NUDGE_MS), true);
    assert.equal(settings.shouldNudgeToEnforce({ ...on, enabled: false }, t0 + 2 * settings.MONITOR_NUDGE_MS), false);
    // Another save keeps the start (the clock does not restart).
    const later = await settings.setMoodAlerts(OTHER, false);
    assert.equal(later.monitorSince, t0);
    const enforcing = await settings.setAutomodMode(OTHER, 'enforce');
    assert.equal(enforcing.monitorSince, null);
    assert.equal(settings.shouldNudgeToEnforce(enforcing, t0 + 10 * settings.MONITOR_NUDGE_MS), false);
    const back = await settings.setAutomodMode(OTHER, 'monitor');
    assert.ok(back.monitorSince >= t0, 'switching back starts a new count');
});

// ── D4 settings ───────────────────────────────────────────────────────────

test('D4 defaults: home servers count automod warns (as before); other servers do not; ladder on everywhere', () => {
    setup();
    assert.equal(neutralValue(getSettingEntry('automodWarnsCountOnLadder')), false);
    assert.equal(neutralValue(getSettingEntry('warnLadderEnabled')), true);
    assert.equal(policy.warnCountsOnLadder(MAIN, { system: true }), true);
    assert.equal(policy.warnCountsOnLadder(SUPPORT, { system: true }), true);
    assert.equal(policy.warnCountsOnLadder(OTHER, { system: true }), false);
    assert.equal(policy.warnCountsOnLadder(OTHER), true, 'staff warns count');
    setSettingsCacheForTests(OTHER, { automodWarnsCountOnLadder: true });
    assert.equal(policy.warnCountsOnLadder(OTHER, { system: true }), true);
    setSettingsCacheForTests(OTHER, { warnLadderEnabled: false, automodWarnsCountOnLadder: true });
    assert.equal(policy.warnCountsOnLadder(OTHER, { system: true }), false);
    assert.equal(policy.warnCountsOnLadder(OTHER), false);
});

test('D4 settings that could not be read throw (never a guessed default)', () => {
    setup();
    assert.throws(() => policy.warnCountsOnLadder(UNREAD, { system: true }), { name: 'SettingsUnavailableError' });
    assert.throws(() => policy.isWarnLadderEnabled(UNREAD), { name: 'SettingsUnavailableError' });
});

test('D4 previewWarn: a ladder that is off never escalates; an enabled one is unchanged', () => {
    const off = enforcement.previewWarn({ level: 0, warns_since_level: 2, enabled: false });
    assert.equal(off.escalates, false);
    assert.equal(off.ladderOff, true);
    assert.equal(off.warnNumber, null);
    assert.equal(off.banDurationMs, null);
    const on = enforcement.previewWarn({ level: 0, warns_since_level: 2, enabled: true });
    assert.equal(on.escalates, true);
    assert.equal(on.warnNumber, 3);
    assert.deepEqual(enforcement.previewWarn({ level: 0, warns_since_level: 2 }), on, 'rows without the flag: as before');
});

// ── Doing the warns (fake enforcement database) ───────────────────────────

/** A fake mod_cases / mod_ladder: enough for doWarn (records SQL). */
function fakeEnforcementDb() {
    const ladders = new Map();
    const cases = [];
    const sql = [];
    let id = 0;
    const answer = (text, params) => {
        const q = String(text).replace(/\s+/g, ' ').trim();
        sql.push(q);
        if (/^INSERT INTO \S*mod_ladder/.test(q)) {
            const key = `${params[0]}:${params[1]}`;
            if (!ladders.has(key)) ladders.set(key, { level: 0, warns_since_level: 0 });
            return [];
        }
        if (/^SELECT level, warns_since_level FROM \S*mod_ladder/.test(q)) {
            const row = ladders.get(`${params[0]}:${params[1]}`);
            return row ? [{ ...row }] : [];
        }
        if (/^UPDATE \S*mod_ladder SET level/.test(q)) {
            ladders.set(`${params[0]}:${params[1]}`, { level: params[2], warns_since_level: params[3] });
            return [];
        }
        if (/^INSERT INTO \S*mod_cases/.test(q)) {
            const [guildId, caseCode, targetUserId, targetUsername, moderatorId, moderatorUsername, type, name, reason, source, reasonKey, durationMs,
                , expiresAt, unappealable, appealDeadline, ladderLevelAfter, countsTowardLevel, isAuto] = params;
            const row = {
                id: (id += 1), guild_id: guildId, case_code: caseCode, target_user_id: targetUserId, target_username: targetUsername,
                moderator_id: moderatorId, moderator_username: moderatorUsername, type, name, reason, prebuilt_or_custom: source,
                reason_key: reasonKey, duration_ms: durationMs, created_at: new Date(), expires_at: expiresAt, unappealable,
                appeal_deadline: appealDeadline, ladder_level_after: ladderLevelAfter, counts_toward_level: countsTowardLevel,
                is_auto: isAuto, is_imported: false, is_test: false, status: 'active', dm_delivered: false,
            };
            cases.push(row);
            return [row];
        }
        if (/COUNT\(\*\)/.test(q)) return [{ count: 0 }];
        return [];
    };
    const run = async (text, params = []) => {
        const rows = answer(text, params) || [];
        return { rows, rowCount: rows.length };
    };
    pgDb.pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    pgDb.isAvailable = () => true;
    return { ladders, cases, sql };
}

function fakeGuild(guildId) {
    const bans = [];
    const dms = [];
    const botUser = { id: BOT, username: 'Mewvo', bot: true };
    const client = { user: botUser, guilds: { cache: new Map() }, users: { fetch: async () => null } };
    const guild = { id: guildId, name: 'Test server', ownerId: '999999999999999999', client, channels: { cache: new Map(), fetch: async () => null }, roles: { cache: new Map() } };
    client.guilds.cache.set(guildId, guild);
    const me = { id: BOT, user: botUser, guild, permissions: { has: () => true }, roles: { highest: { position: 100 }, cache: new Map() } };
    const target = {
        id: TARGET, guild, user: { id: TARGET, username: 'target' },
        roles: { highest: { position: 1 }, cache: new Map(), add: async () => {}, remove: async () => {} },
        permissions: { has: () => false },
    };
    const moderator = { id: MOD, guild, user: { id: MOD, username: 'mod' }, permissions: { has: () => true }, roles: { highest: { position: 50 }, cache: new Map() } };
    guild.members = {
        me,
        cache: new Map([[TARGET, target]]),
        fetch: async (id) => { if (id === TARGET) return target; throw new Error('Unknown member'); },
        fetchMe: async () => me,
        ban: async (id) => { bans.push(id); },
    };
    guild.bans = { fetch: async () => null };
    const targetUser = { id: TARGET, username: 'target', send: async (payload) => { dms.push(payload.content); return { id: 'm1', channelId: 'c1' }; } };
    return { guild, targetUser, moderator, bans, dms };
}

const automodFlow = () => ({
    type: 'warn', reason: 'Automod: Spam', reasonSource: 'prebuilt', reasonKey: 'automod:spam',
    durationMs: null, unappealable: false, name: 'target warn 1', nameIsDefault: false,
});

test('D4 another server: three automod warns are recorded, the ladder does not move, no ban, no "of 3" DM', async () => {
    setup();
    const store = fakeEnforcementDb();
    const { guild, targetUser, bans, dms } = fakeGuild(OTHER);
    for (let i = 0; i < 3; i += 1) {
        const result = await enforcement.executeSystemAction({ guild, targetUser, flow: { ...automodFlow(), name: `target warn ${i + 1}` } });
        assert.equal(result.countsOnLadder, false);
        assert.equal(result.banRecord ?? null, null);
    }
    assert.equal(store.cases.length, 3);
    assert.ok(store.cases.every((row) => row.type === 'warn' && row.counts_toward_level === null));
    assert.ok(store.cases.every((row) => policy.uncountedKind(row) === 'automod'));
    assert.equal(store.sql.filter((q) => /^UPDATE \S*mod_ladder/.test(q)).length, 0, 'the ladder row never changes');
    assert.deepEqual(store.ladders.get(`${OTHER}:${TARGET}`), { level: 0, warns_since_level: 0 });
    assert.deepEqual(bans, []);
    assert.equal(dms.length, 3);
    for (const dm of dms) {
        assert.doesNotMatch(dm, /of 3|will be banned/);
        assert.match(dm, /does not count toward an automatic ban/);
    }
});

test('D4 another server that turned "automod warns count" on: the third automod warn bans, as before', async () => {
    setup({ [OTHER]: { automodWarnsCountOnLadder: true } });
    const store = fakeEnforcementDb();
    const { guild, targetUser, bans } = fakeGuild(OTHER);
    for (let i = 0; i < 3; i += 1) {
        await enforcement.executeSystemAction({ guild, targetUser, flow: { ...automodFlow(), name: `target warn ${i + 1}` } });
    }
    assert.deepEqual(store.cases.filter((r) => r.type === 'warn').map((r) => r.counts_toward_level), [0, 0, 0]);
    assert.equal(store.cases.filter((r) => r.type === 'ban' && r.is_auto).length, 1);
    assert.deepEqual(bans, [TARGET]);
    assert.deepEqual(store.ladders.get(`${OTHER}:${TARGET}`), { level: 1, warns_since_level: 0 });
});

test('D4 home server: automod warns keep counting (today\'s behaviour)', async () => {
    setup();
    enforcementConfig.mainGuildId = MAIN;
    const store = fakeEnforcementDb();
    const { guild, targetUser, bans } = fakeGuild(MAIN);
    for (let i = 0; i < 3; i += 1) {
        await enforcement.executeSystemAction({ guild, targetUser, flow: { ...automodFlow(), name: `target warn ${i + 1}` } });
    }
    assert.equal(store.cases.filter((r) => r.type === 'ban' && r.is_auto).length, 1);
    assert.deepEqual(bans, [TARGET]);
});

test('D4 warn ladder off: staff warns never ban automatically and the DM has no ladder text; manual bans unaffected', async () => {
    setup({ [OTHER]: { warnLadderEnabled: false } });
    const store = fakeEnforcementDb();
    const { guild, targetUser, moderator, bans, dms } = fakeGuild(OTHER);
    for (let i = 0; i < 4; i += 1) {
        const flow = { ...automodFlow(), reason: 'Spam', reasonKey: 'spam', name: `target warn ${i + 1}` };
        const result = await enforcement.executeAction({ guild, moderator, targetUser, flow });
        assert.equal(result.countsOnLadder, false);
    }
    assert.deepEqual(bans, []);
    assert.ok(store.cases.every((row) => row.counts_toward_level === null && policy.uncountedKind(row) === 'ladderOff'));
    for (const dm of dms) assert.doesNotMatch(dm, /of 3|will be banned/);
    // The getLadder flag reaches every preview (panel, dashboard, standing).
    const ladder = await enforcement.getLadder(OTHER, TARGET);
    assert.equal(ladder.enabled, false);
    assert.equal(enforcement.previewWarn(ladder).escalates, false);
    // A manual ban still works.
    const ban = await enforcement.executeAction({ guild, moderator, targetUser, flow: { type: 'ban', reason: 'Raid', reasonSource: 'custom', durationMs: null, unappealable: false, name: 'target ban 1' } });
    assert.equal(ban.record.type, 'ban');
    assert.deepEqual(bans, [TARGET]);
});

test('D4 an uncounted warn cannot lift a ladder ban on appeal', async () => {
    assert.equal(await enforcement.liftLadderBanForWarn({ id: OTHER }, { counts_toward_level: null, target_user_id: TARGET }, { id: MOD }, 'r'), null);
});

// ── Texts ─────────────────────────────────────────────────────────────────

const rec = { case_code: 'abc2345', reason: 'Spam', created_at: new Date(), guild_id: OTHER, type: 'warn' };

test('D4 warn DM: counted keeps "Warning X of 3"; uncounted drops the ladder lines (every language)', () => {
    setup();
    const counted = warnDm(rec, 2, { guildId: OTHER, serverName: 'Test' });
    assert.match(counted, /Warning 2 of 3/);
    assert.match(counted, /Warnings don't expire\. 1 more warning means an automatic ban for 7 days\./);
    for (const lang of ['en', 'de', 'es', 'fr', 'it', 'pl', 'pt-BR', 'ru']) {
        const text = warnDm(rec, null, { guildId: OTHER, serverName: 'Test', lang });
        assert.doesNotMatch(text, /null|\{|2 of 3|3 warnings/, lang);
        assert.ok(text.includes(botText(lang).t('enforcement.dm.warn.notCounted')), lang);
    }
});

test('D4 panel, standing and portal lines when the ladder is off', () => {
    const off = { level: 0, warns_since_level: 0, enabled: false };
    assert.match(warnEffectText(off), /recorded only/);
    assert.match(warnEffectText(off, { lang: 'de' }), /nur vermerkt/);
    assert.match(countedWarnsText(off), /warn ladder off/);
    assert.match(memberLadderLine(off), /warn ladder is off/);
    assert.match(nextWarningText(off), /never lead to an automatic ban/);
    assert.match(standingFields({ ladder: off, warns: [], activeBan: null, activeMute: null, appeals: [] }).map((f) => f.value).join('\n'), /warn ladder is off/);
    assert.doesNotMatch(nextWarningWords(off), /undefined|null/);
    const offView = buildRecordView({ standing: { ladder: { ...off, warns_since_level: 2 }, warns: [], activeBan: null, activeMute: null }, cases: [], appeals: [], config: { warnsPerLevel: 3 } });
    assert.equal(offView.warnings.ladderOff, true, 'My record shows "2 (warn ladder off)", not "2 of 3"');
    // Remove warn is offered for uncounted warns too.
    assert.ok(availableActions({ member: {}, banned: false, muted: false, ladder: { warns_since_level: 0 }, uncountedWarns: 1 }).includes('removewarn'));
    assert.ok(!availableActions({ member: {}, banned: false, muted: false, ladder: { warns_since_level: 0 }, uncountedWarns: 0 }).includes('removewarn'));
});

test('D4 labels: uncounted automod warns are shown distinctly in /background and My record', async () => {
    setup();
    const automodWarn = { ...rec, id: 1, case_code: 'auto234', name: 'target warn 1', reason_key: 'automod:spam', counts_toward_level: null, is_imported: false, is_test: false, status: 'active', moderator_username: 'Mewvo' };
    const ladderOffWarn = { ...automodWarn, id: 2, case_code: 'lado234', reason_key: 'spam' };
    const countedWarn = { ...automodWarn, id: 3, case_code: 'coun234', counts_toward_level: 0 };
    const imported = { ...automodWarn, id: 4, case_code: 'impo234', is_imported: true };
    assert.equal(policy.uncountedKind(automodWarn), 'automod');
    assert.equal(policy.uncountedKind(ladderOffWarn), 'ladderOff');
    assert.equal(policy.uncountedKind(countedWarn), null);
    assert.equal(policy.uncountedKind(imported), null, 'imported warns keep their own label');
    assert.equal(policy.uncountedKind({ type: 'warn', is_imported: false }), null, 'a row without the column is never "uncounted"');

    // My record (member portal).
    const view = buildRecordView({
        standing: { ladder: { level: 0, warns_since_level: 1 }, warns: [countedWarn], activeBan: null, activeMute: null },
        cases: [automodWarn, ladderOffWarn, countedWarn], appeals: [], config: { warnsPerLevel: 3, appealWindowMs: 1, appealCooldownMs: 1 },
    });
    assert.deepEqual(view.cases.map((c) => c.status), ["automod warning — doesn't count toward bans", "on record, doesn't count toward bans", 'counts now']);

    // /background list.
    const fake = fakeEnforcementDb();
    void fake;
    pgDb.pool = { query: async (text) => ({ rows: /FROM \S*mod_cases/.test(text) ? [{ ...automodWarn, total_count: 2 }, { ...countedWarn, total_count: 2 }] : [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
    const list = await buildRecordList(OTHER, MOD, { id: TARGET, username: 'target' }, 0);
    const json = JSON.stringify(list);
    assert.match(json, /Automod warning — doesn't count toward bans/);
    assert.equal((json.match(/doesn't count toward bans/g) || []).length, 1, 'only the uncounted warn is labelled');
});
