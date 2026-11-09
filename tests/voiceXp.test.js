// Voice XP (docs/features-v14.md §1): eligibility, the two-tick rule, the daily cap with the UTC
// day change, reconnect and overlap handling, the time-before-XP order, addXp's voice source,
// settings validation, the voice leaderboard and the privacy hooks. No database, no Discord.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TitanBotError, ErrorTypes } from '../src/utils/errorHandler.js';
import {
    eligibleMembers, gatewayReady, runVoiceXpTick, awardVoiceMinute, resetVoiceXpForTests, previousVoiceKeysForTests, voiceKey,
} from '../src/services/leveling/voiceXp.js';
import { VOICE_DEFAULTS, voiceConfigOf, voiceConfigProblems } from '../src/services/leveling/voiceConfig.js';
import { voiceTimeText, voiceTimeValue } from '../src/services/leveling/voiceText.js';
import {
    deleteUserLevelData, getLeaderboard, getLevelingConfig, updateLevelingConfig, updateVoiceXpConfig,
} from '../src/services/leveling/leveling.js';
import { addXp } from '../src/services/leveling/xpSystem.js';
import { getUserLevelKey } from '../src/utils/database/keys.js';
import { buildLeaderboardReply } from '../src/commands/Leveling/leaderboard.js';
import { EXPORT_SECTIONS } from '../src/services/privacy/dataExport.js';
import { pgConfig } from '../src/config/database/postgres.js';
import { privacyPage } from '../src/services/site/pages/legal.js';
import { readDayMinutes, upsertMinutes, deleteVoiceActivity, topVoiceRows, readVoiceStats } from '../src/services/leveling/voiceStore.js';

const G = '400000000000000001';
const C1 = '400000000000000011';
const C2 = '400000000000000012';
const AFK = '400000000000000013';
const EXCLUDED = '400000000000000014';
const IGNORED = '400000000000000015';
const STAGE = '400000000000000016';
const ROLE_IGNORED = '400000000000000021';
const ROLE_BOOST = '400000000000000022';
const u = (n) => `4100000000000000${String(n).padStart(2, '0')}`;

class Coll extends Map {
    some(fn) { for (const v of this.values()) if (fn(v)) return true; return false; }
}

const member = (id, { bot = false, roles = [] } = {}) => ({
    id, user: { id, bot, tag: `user${id.slice(-2)}`, username: `user${id.slice(-2)}` }, roles: { cache: new Coll(roles.map((r) => [r, { id: r }])) },
});
const state = (id, channelId, extra = {}) => ({
    id, channelId, selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, suppress: false, ...extra,
});

function makeGuild({ states, members, channels = [C1, C2, AFK, EXCLUDED, IGNORED, STAGE], afk = AFK, available = true }) {
    return {
        id: G,
        available,
        afkChannelId: afk,
        voiceStates: { cache: new Map(states.map((s) => [s.id, s])) },
        members: { cache: new Map(members.map((m) => [m.id, m])) },
        channels: { cache: new Map(channels.map((id) => [id, { id }])) },
    };
}

const levelingCfg = (voice = {}, extra = {}) => ({
    enabled: true,
    ignoredChannels: [IGNORED],
    ignoredRoles: [ROLE_IGNORED],
    blacklistedUsers: [u(6)],
    voice: { ...VOICE_DEFAULTS, enabled: true, excludedChannels: [EXCLUDED], ...voice },
    ...extra,
});

/** An in-memory voice store with the same day/cap rules as the SQL UPSERT. */
function fakeStore({ failUpsert = false } = {}) {
    const rows = new Map();
    return {
        rows,
        upserts: 0,
        async readDayMinutes(guildId, userId, day) {
            const row = rows.get(`${guildId}:${userId}`);
            return row && row.day === day ? row.dayMinutes : 0;
        },
        async addVoiceXp(guildId, userId, xp) { rows.get(`${guildId}:${userId}`).xp += xp; },
        async upsertMinutes(guildId, userId, { day, seconds, xp }) {
            this.upserts += 1;
            if (failUpsert) throw new Error('db down');
            const key = `${guildId}:${userId}`;
            const row = rows.get(key) || { seconds: 0, xp: 0, day: null, dayMinutes: 0 };
            row.dayMinutes = row.day === day ? Math.min(row.dayMinutes + 1, 1440) : 1;
            row.day = day;
            row.seconds += seconds;
            row.xp += xp;
            rows.set(key, row);
            return row.dayMinutes;
        },
    };
}

function tickClient(guild, { status = 0 } = {}) {
    // client.ws.status stays Ready after the first ready (discord.js); the shards carry the real state.
    return { ws: { status: 0, shards: new Map([[0, { status }]]) }, guilds: { cache: new Map([[guild.id, guild]]) } };
}

function deps(config, store, extra = {}) {
    const gave = [];
    return {
        gave,
        readConfig: async () => config,
        store,
        random: () => 0,
        giveXp: async (client, guild, m, xp, options) => { gave.push({ userId: m.id, xp, options }); return { totalXp: xp }; },
        ...extra,
    };
}

beforeEach(() => resetVoiceXpForTests());

// ── eligibility ──────────────────────────────────────────────────────────

test('eligibility matrix: who counts and who does not', () => {
    const members = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((n) => member(u(n), { bot: n === 5, roles: n === 7 ? [ROLE_IGNORED] : [] }));
    const states = [
        state(u(1), C1),                               // counts
        state(u(2), C1, { selfMute: true }),           // self-muted listener counts (requireUnmuted off)
        state(u(3), C1, { selfDeaf: true }),           // deafened: no
        state(u(4), C1, { serverMute: true }),         // server-muted: no
        state(u(5), C1),                               // bot: no
        state(u(6), C1),                               // blacklisted: no
        state(u(7), C1),                               // ignored role: no
        state(u(8), C1, { serverDeaf: true }),         // server-deafened: no
        state(u(99), C1),                              // member not cached: no (no fetches)
        state(u(9), AFK), state(u(10), AFK),           // AFK channel: no
        state(u(11), EXCLUDED), state(u(12), EXCLUDED), // voice-excluded channel: no
        state(u(13), IGNORED), state(u(14), IGNORED),  // leveling ignored channel: no
        state(u(15), C2),                              // alone with nobody eligible: no
        state(u(16), STAGE, { suppress: true }), state(u(17), STAGE), // stage audience (suppressed) counts
    ];
    const guild = makeGuild({ states, members });
    const ids = eligibleMembers(guild, levelingCfg()).map((e) => e.userId).sort();
    assert.deepEqual(ids, [u(1), u(2), u(16), u(17)].sort());

    const strict = eligibleMembers(guild, levelingCfg({ requireUnmuted: true })).map((e) => e.userId).sort();
    assert.deepEqual(strict, [u(16), u(17)].sort(), 'requireUnmuted: the self-muted member drops out, and C1 is left with one person');

    assert.deepEqual(eligibleMembers(guild, levelingCfg({ minHumans: 3 })).map((e) => e.userId), [], 'minHumans 3: no channel has 3 eligible people');
    const noAfk = makeGuild({ states, members, afk: null });
    assert.ok(eligibleMembers(noAfk, levelingCfg()).some((e) => e.userId === u(9)), 'without an AFK channel set, that channel counts like any other');
});

test('a bot in the channel does not make a solo member eligible', () => {
    const guild = makeGuild({ states: [state(u(1), C1), state(u(5), C1)], members: [member(u(1)), member(u(5), { bot: true })] });
    assert.deepEqual(eligibleMembers(guild, levelingCfg()), []);
});

test('eligibleMembers marks entries counted only when the same guild:user:channel was seen before', () => {
    const guild = makeGuild({ states: [state(u(1), C1), state(u(2), C1)], members: [member(u(1)), member(u(2))] });
    const prev = new Set([voiceKey(G, u(1), C1), voiceKey(G, u(2), C2)]);
    const entries = eligibleMembers(guild, levelingCfg(), prev);
    assert.equal(entries.find((e) => e.userId === u(1)).counted, true);
    assert.equal(entries.find((e) => e.userId === u(2)).counted, false, 'moved channels: starts again');
});

// ── ticks ────────────────────────────────────────────────────────────────

test('a minute needs two consecutive eligible ticks; XP = xpMin..xpMax x boosts, through addXp with source voice', async () => {
    const guild = makeGuild({ states: [state(u(1), C1), state(u(2), C1, { selfMute: true })], members: [member(u(1), { roles: [ROLE_BOOST] }), member(u(2))] });
    const client = tickClient(guild);
    const store = fakeStore();
    const d = deps(levelingCfg({}, { roleMultipliers: { [ROLE_BOOST]: 2 } }), store);
    const first = await runVoiceXpTick(client, d);
    assert.equal(first.counted, 0, 'first tick only remembers');
    assert.equal(store.upserts, 0);
    const second = await runVoiceXpTick(client, d);
    assert.equal(second.counted, 2);
    assert.deepEqual(d.gave.map((g) => [g.userId, g.xp, g.options.source]).sort(), [[u(1), 6, 'voice'], [u(2), 3, 'voice']].sort(), 'xpMin 3, x2 role boost for user 1');
    assert.equal(store.rows.get(`${G}:${u(1)}`).seconds, 60);

    // Someone leaves: the other is alone and stops counting; nothing is awarded.
    guild.voiceStates.cache.delete(u(2));
    const third = await runVoiceXpTick(client, d);
    assert.equal(third.counted, 0);
    assert.equal(d.gave.length, 2);
});

test('daily cap: past the cap the time is still counted without XP; a new UTC day starts again', async () => {
    const guild = makeGuild({ states: [state(u(1), C1), state(u(2), C1)], members: [member(u(1)), member(u(2))] });
    const client = tickClient(guild);
    const store = fakeStore();
    let now = Date.parse('2026-11-09T23:57:30Z');
    const d = deps(levelingCfg({ dailyCapMinutes: 2 }), store);
    d.now = undefined;
    const run = () => runVoiceXpTick(client, { ...d, now });
    await run();                         // remember
    await run(); now += 60_000;          // minute 1 (XP)
    await run(); now += 60_000;          // minute 2 (XP)
    await run();                         // minute 3: over the cap, no XP
    const mine = () => d.gave.filter((g) => g.userId === u(1)).length;
    assert.equal(mine(), 2, 'only two minutes give XP');
    assert.equal(store.rows.get(`${G}:${u(1)}`).seconds, 180, 'all three minutes are counted as time');
    assert.equal(store.rows.get(`${G}:${u(1)}`).dayMinutes, 3);
    now = Date.parse('2026-11-10T00:00:30Z');
    await run();
    assert.equal(mine(), 3, 'the next UTC day gives XP again');
    assert.equal(store.rows.get(`${G}:${u(1)}`).dayMinutes, 1, 'the day count starts at 1');
    assert.equal(store.rows.get(`${G}:${u(1)}`).day, '2026-11-10');
});

test('cap 0: voice time is counted, no XP at all', async () => {
    const guild = makeGuild({ states: [state(u(1), C1), state(u(2), C1)], members: [member(u(1)), member(u(2))] });
    const store = fakeStore();
    const d = deps(levelingCfg({ dailyCapMinutes: 0 }), store);
    await runVoiceXpTick(tickClient(guild), d);
    await runVoiceXpTick(tickClient(guild), d);
    assert.equal(d.gave.length, 0);
    assert.equal(store.rows.get(`${G}:${u(1)}`).seconds, 60);
});

test('voice_xp counts only XP that addXp really gave', async () => {
    const guild = makeGuild({ states: [state(u(1), C1), state(u(2), C1)], members: [member(u(1)), member(u(2))] });
    const store = fakeStore();
    const d = deps(levelingCfg(), store, { giveXp: async () => null }); // leveling turned off meanwhile
    await runVoiceXpTick(tickClient(guild), d);
    await runVoiceXpTick(tickClient(guild), d);
    assert.equal(store.rows.get(`${G}:${u(1)}`).seconds, 60, 'time counted');
    assert.equal(store.rows.get(`${G}:${u(1)}`).xp, 0, 'no XP recorded');
});

test('reconnect: while the gateway is not ready the tick is skipped and the memory cleared', async () => {
    const guild = makeGuild({ states: [state(u(1), C1), state(u(2), C1)], members: [member(u(1)), member(u(2))] });
    const client = tickClient(guild);
    const d = deps(levelingCfg(), fakeStore());
    await runVoiceXpTick(client, d);
    assert.equal(previousVoiceKeysForTests().size, 2);
    client.ws.shards.get(0).status = 5; // reconnecting; client.ws.status itself stays 0 (Ready)
    const skipped = await runVoiceXpTick(client, d);
    assert.equal(skipped.skipped, 'not-ready');
    assert.equal(previousVoiceKeysForTests().size, 0);
    assert.equal(gatewayReady({ ws: { status: 0, shards: new Map() } }), false, 'no shards: not ready');
    client.ws.shards.get(0).status = 0;
    const back = await runVoiceXpTick(client, d);
    assert.equal(back.counted, 0, 'after a reconnect two ticks are needed again');
    assert.equal(d.gave.length, 0);
});

test('an unavailable guild, a guild with fewer than 2 voice states, leveling off or Voice XP off: no config read or no award', async () => {
    const two = [state(u(1), C1), state(u(2), C1)];
    const members = [member(u(1)), member(u(2))];
    let reads = 0;
    const counting = (cfg) => ({ ...deps(cfg, fakeStore()), readConfig: async () => { reads += 1; return cfg; } });
    const solo = makeGuild({ states: [state(u(1), C1)], members });
    await runVoiceXpTick(tickClient(solo), counting(levelingCfg()));
    assert.equal(reads, 0, 'one person in voice: config not read');
    const down = makeGuild({ states: two, members, available: false });
    await runVoiceXpTick(tickClient(down), counting(levelingCfg()));
    assert.equal(reads, 0, 'unavailable guild skipped');
    for (const cfg of [levelingCfg({ enabled: false }), levelingCfg({}, { enabled: false }), { enabled: true }]) {
        resetVoiceXpForTests();
        const d = counting(cfg);
        const guild = makeGuild({ states: two, members });
        await runVoiceXpTick(tickClient(guild), d);
        const r = await runVoiceXpTick(tickClient(guild), d);
        assert.equal(r.counted, 0);
        assert.equal(d.gave.length, 0);
    }
});

test('no double award when ticks overlap: the second call is refused while the first runs', async () => {
    const guild = makeGuild({ states: [state(u(1), C1), state(u(2), C1)], members: [member(u(1)), member(u(2))] });
    const client = tickClient(guild);
    const d = deps(levelingCfg(), fakeStore());
    await runVoiceXpTick(client, d);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = { ...d, giveXp: async (...args) => { await gate; return d.giveXp(...args); } };
    const first = runVoiceXpTick(client, slow);
    const second = await runVoiceXpTick(client, slow);
    assert.equal(second.skipped, 'overlap');
    release();
    const done = await first;
    assert.equal(done.counted, 2);
    assert.equal(d.gave.length, 2, 'one award per member');
});

test('a failing time write: no XP for that minute, the tick does not throw, others still count', async () => {
    const guild = makeGuild({ states: [state(u(1), C1), state(u(2), C1)], members: [member(u(1)), member(u(2))] });
    const store = fakeStore({ failUpsert: true });
    const d = deps(levelingCfg(), store);
    await runVoiceXpTick(tickClient(guild), d);
    const r = await runVoiceXpTick(tickClient(guild), d);
    assert.equal(r.counted, 2);
    assert.equal(r.awarded, 0);
    assert.equal(d.gave.length, 0, 'no XP without the stored minute');
    await assert.rejects(awardVoiceMinute({}, guild, { userId: u(1), channelId: C1, member: member(u(1)) }, levelingCfg(), { store, giveXp: d.giveXp }), /db down/);
});

// ── addXp source ─────────────────────────────────────────────────────────

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
function fakeClient() {
    const store = new Map();
    const chains = new Map();
    const db = {
        store,
        async get(key, defaultValue = null) { await tick(); return store.has(key) ? structuredClone(store.get(key)) : defaultValue; },
        async set(key, value) { await tick(); store.set(key, structuredClone(value)); return true; },
        async delete(key) { return store.delete(key); },
        async exists(key) { return store.has(key); },
        update(key, mutator, defaultValue = null) {
            const run = async () => {
                const current = store.has(key) ? structuredClone(store.get(key)) : structuredClone(defaultValue);
                await tick();
                const next = await mutator(current);
                store.set(key, structuredClone(next));
                return next;
            };
            const result = (chains.get(key) || Promise.resolve()).then(run, run);
            chains.set(key, result.catch(() => {}));
            return result;
        },
    };
    return { db };
}

test('addXp: source voice leaves lastMessage (the chat cooldown) alone; the default source stamps it', async () => {
    const client = fakeClient();
    const guild = { id: G, channels: { cache: new Map() } };
    const m = member(u(1));
    const key = getUserLevelKey(G, u(1));
    client.db.store.set(key, { xp: 0, level: 0, totalXp: 0, lastMessage: 12345, rank: 0 });
    const result = await addXp(client, guild, m, 5, { source: 'voice' });
    assert.equal(result.totalXp, 5);
    assert.equal(client.db.store.get(key).lastMessage, 12345, 'voice XP does not block chat XP');
    const before = Date.now();
    await addXp(client, guild, m, 5);
    assert.ok(client.db.store.get(key).lastMessage >= before, 'a message still stamps the cooldown');
    assert.equal(client.db.store.get(key).totalXp, 10);
});

// ── settings ─────────────────────────────────────────────────────────────

async function assertValidation(promise, word) {
    await assert.rejects(promise, (error) => {
        assert.ok(error instanceof TitanBotError, `expected TitanBotError, got ${error}`);
        assert.equal(error.type, ErrorTypes.VALIDATION);
        if (word) assert.match(error.userMessage, word);
        return true;
    });
}

test('voice settings: off by default (also for a stored config without them); bounds checked; row-locked merges', async () => {
    assert.deepEqual(voiceConfigOf({ enabled: true, xpCooldown: 20 }), { ...VOICE_DEFAULTS, excludedChannels: [] }, 'existing servers: off');
    assert.equal(voiceConfigOf(null).enabled, false);
    assert.equal(VOICE_DEFAULTS.dailyCapMinutes, 120);
    assert.equal(VOICE_DEFAULTS.requireUnmuted, false);
    assert.deepEqual([VOICE_DEFAULTS.xpMin, VOICE_DEFAULTS.xpMax, VOICE_DEFAULTS.minHumans], [3, 7, 2]);

    const client = fakeClient();
    const cfg = await getLevelingConfig(client, G);
    assert.equal(voiceConfigOf(cfg).enabled, false, 'a new server: off');

    await assertValidation(updateVoiceXpConfig(client, G, { dailyCapMinutes: 1441 }), /0 to 1440/);
    await assertValidation(updateVoiceXpConfig(client, G, { dailyCapMinutes: -1 }), /0 to 1440/);
    await assertValidation(updateVoiceXpConfig(client, G, { minHumans: 1 }), /2 to 10/);
    await assertValidation(updateVoiceXpConfig(client, G, { xpMax: 51 }), /1 to 50/);
    await assertValidation(updateVoiceXpConfig(client, G, { xpMin: 8 }), /cannot be more than/, 'merged with the stored max 7');
    await assertValidation(updateVoiceXpConfig(client, G, { excludedChannels: Array.from({ length: 101 }, (_, i) => `5000000000000000${String(i).padStart(3, '0')}`) }), /at most 100/);
    await assertValidation(updateVoiceXpConfig(client, G, { excludedChannels: ['nope'] }), /not valid/);
    await assertValidation(updateVoiceXpConfig(client, G, { enabled: 'yes' }), /on or off/);
    await assertValidation(updateVoiceXpConfig(client, G, { surprise: 1 }), /unknown setting/);
    await assertValidation(updateLevelingConfig(client, G, { voice: { dailyCapMinutes: 5000 } }), /0 to 1440/);
    assert.deepEqual(voiceConfigProblems({ dailyCapMinutes: 0, minHumans: 10, xpMin: 1, xpMax: 50 }), []);

    await Promise.all([
        updateVoiceXpConfig(client, G, { enabled: true }),
        updateVoiceXpConfig(client, G, { dailyCapMinutes: 60 }),
        updateVoiceXpConfig(client, G, { excludedChannels: [C1] }),
    ]);
    const saved = voiceConfigOf(await getLevelingConfig(client, G));
    assert.equal(saved.enabled, true);
    assert.equal(saved.dailyCapMinutes, 60);
    assert.deepEqual(saved.excludedChannels, [C1], 'concurrent saves of different fields all survive');
});

// ── shown in ─────────────────────────────────────────────────────────────

test('voice time text, the /rank and /profile value, and the voice leaderboard reply', () => {
    assert.equal(voiceTimeText(0), '0 min');
    assert.equal(voiceTimeText(59), '0 min');
    assert.equal(voiceTimeText(45 * 60), '45 min');
    assert.equal(voiceTimeText(3 * 3600 + 5 * 60 + 30), '3 h 5 min');
    assert.equal(voiceTimeText(3700, 'de'), '1 Std. 1 Min.');
    assert.equal(voiceTimeValue(null, false), null, 'off and nothing stored: no line');
    assert.equal(voiceTimeValue(null, true), '0 min', 'on: the line shows 0');
    assert.equal(voiceTimeValue({ seconds: 600 }, false), '10 min', 'turned off later: stored time still shown');

    const reply = buildLeaderboardReply([{ rank: 1, userId: u(1), voiceSeconds: 7260 }], { page: 1, offset: 0, type: 'voice' });
    const embed = reply.embeds[0].toJSON();
    assert.equal(embed.title, 'Voice Leaderboard');
    assert.match(embed.fields[0].value, new RegExp(`<@${u(1)}> - 2 h 1 min in voice`));
    assert.deepEqual(reply.allowedMentions, { parse: [] });
    const off = buildLeaderboardReply([], { page: 1, offset: 0, type: 'voice', voiceEnabled: false }).embeds[0].toJSON();
    assert.match(off.description, /Voice XP is off/);
    const empty = buildLeaderboardReply([], { page: 1, offset: 0, type: 'voice', voiceEnabled: true }).embeds[0].toJSON();
    assert.match(empty.description, /Nobody has voice time yet/);
    const xp = buildLeaderboardReply([{ rank: 1, userId: u(1), level: 2, xp: 5 }], { page: 1, offset: 0 }).embeds[0].toJSON();
    assert.equal(xp.title, 'Level Leaderboard', 'the XP board is unchanged');
});

test('getLeaderboard type voice: voice rows, members who left skipped like the XP board', async () => {
    const guild = {
        id: G, memberCount: 2,
        members: { cache: new Map([[u(1), member(u(1))], [u(3), member(u(3))]]) },
    };
    const client = { guilds: { cache: new Map([[G, guild]]) }, users: { cache: new Map() }, db: { rows: () => null } };
    const readVoiceRows = async (guildId, count, from) => [
        { userId: u(1), voiceSeconds: 900, voiceXp: 50 }, { userId: u(2), voiceSeconds: 600, voiceXp: 30 }, { userId: u(3), voiceSeconds: 60, voiceXp: 3 },
    ].slice(from, from + count);
    const page = await getLeaderboard(client, G, 10, 0, { type: 'voice', readVoiceRows });
    assert.deepEqual(page.map((r) => [r.userId, r.rank, r.voiceSeconds]), [[u(1), 1, 900], [u(3), 2, 60]], 'user 2 left (cache complete): skipped, ranks close up');
    await assert.rejects(getLeaderboard(client, G, 10, 0, { type: 'voice', readVoiceRows: async () => { throw new Error('db down'); } }), /leaderboard/i);
});

// ── privacy ──────────────────────────────────────────────────────────────

test('privacy: data export has a voiceActivity section for the member only; the privacy page lists voice time; level reset deletes voice time', async () => {
    const section = EXPORT_SECTIONS.find(([name]) => name === 'voiceActivity');
    assert.ok(section, 'export section');
    const sql = section[1](pgConfig.tables);
    assert.match(sql, /FROM voice_activity WHERE user_id = \$1/);
    assert.doesNotMatch(sql, /channel/, 'no channel or other people in it');

    const page = String(privacyPage({ memberPortal: true }));
    assert.match(page, /Voice time \(only if the server turns on Voice XP\)/);
    assert.match(page, /Not who you talked with, and no audio/);

    const client = fakeClient();
    const key = getUserLevelKey(G, u(1));
    client.db.store.set(key, { xp: 1 });
    const removed = [];
    await deleteUserLevelData(client, G, u(1), { removeVoice: async (g, id) => { removed.push(`${g}:${id}`); } });
    assert.equal(client.db.store.has(key), false);
    assert.deepEqual(removed, [`${G}:${u(1)}`]);
    await assert.rejects(deleteUserLevelData(client, G, u(1), { removeVoice: async () => { throw new Error('db down'); } }), (e) => e.type === ErrorTypes.DATABASE);
});

test('voice store SQL: reads and writes are scoped to the guild and member, the UPSERT restarts the day count on a new day', async () => {
    const seen = [];
    const query = async (text, params) => { seen.push({ text, params }); return { rows: [{ day_minutes: 4, voice_seconds: '120', voice_xp: '9' }], rowCount: 1 }; };
    assert.equal(await readDayMinutes(G, u(1), '2026-11-09', { query }), 4);
    assert.match(seen[0].text, /guild_id = \$1 AND user_id = \$2 AND day = \$3::date/);
    assert.deepEqual(await readVoiceStats(G, u(1), { query }), { seconds: 120, xp: 9 });
    assert.equal(await deleteVoiceActivity(G, u(1), { query }), true);
    assert.match(seen.at(-1).text, /DELETE FROM voice_activity WHERE guild_id = \$1 AND user_id = \$2/);
    await topVoiceRows(G, 10, 20, { query });
    assert.deepEqual(seen.at(-1).params, [G, 10, 20]);

    const statements = [];
    const transaction = async (fn) => fn({ query: async (text, params) => { statements.push({ text, params }); return { rows: [{ day_minutes: 1 }] }; } });
    assert.equal(await upsertMinutes(G, u(1), { day: '2026-11-09', seconds: 60, xp: 5 }, { transaction }), 1);
    assert.match(statements[0].text, /INSERT INTO guilds .* ON CONFLICT \(id\) DO NOTHING/);
    assert.match(statements[1].text, /INSERT INTO users .* ON CONFLICT \(id\) DO NOTHING/);
    assert.match(statements[2].text, /CASE WHEN voice_activity\.day = EXCLUDED\.day THEN LEAST\(voice_activity\.day_minutes \+ 1, 1440\) ELSE 1 END/);
    assert.match(statements[2].text, /updated_at = NOW\(\)/);
    assert.deepEqual(statements[2].params, [G, u(1), 60, 5, '2026-11-09']);
    const failing = async (fn) => fn({ query: async () => { throw new Error('db down'); } });
    await assert.rejects(upsertMinutes(G, u(1), { day: '2026-11-09' }, { transaction: failing }), /db down/);
});
