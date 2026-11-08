// B5 (T3): guild/counting config cache, bounded maps, quieter logs, client cache limits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createConfigCache } from '../src/utils/configCache.js';
import {
    readGuildConfig, writeGuildConfig, updateGuildConfigAtomic, invalidateGuildConfigCache, guildConfigCacheInfo,
} from '../src/utils/database/guildConfigStorage.js';
import { getGuildConfig, setGuildConfig, patchGuildConfig } from '../src/services/config/guildConfig.js';
import {
    getCountingGameConfig, activateCountingGame, recordCorrectCount, resetCountingGame, countingCacheInfo,
} from '../src/services/countingGameService.js';
import { BoundedMap } from '../src/utils/boundedMap.js';
import { prefixCommandLogLine } from '../src/utils/prefixParser.js';
import { roleSyncLogLine } from '../src/services/leveling/levelRoleSyncService.js';
import { lookupDefinition, resetDefineCache, DEFINE_CACHE_SIZE, DEFINE_COOLDOWN_MS } from '../src/commands/Search/modules/search_define.js';
import { calculationContexts } from '../src/commands/Tools/modules/tools_calculate.js';
import { cacheLimitSettings, makeCache, sweepers, MESSAGE_CACHE_PER_CHANNEL, MEMBER_CACHE_PER_GUILD } from '../src/config/clientCache.js';
import { logEvent, isLogChannelBackedOff, resetLogChannelBackoff, isForbiddenError } from '../src/services/loggingService.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A key-value store like client.db that counts reads and can fail on demand. */
function countingStore(initial = {}) {
    const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
    const store = {
        data, gets: 0, failGet: null, getDelay: null,
        async get(key, fallback = null) {
            store.gets += 1;
            if (store.getDelay) await store.getDelay;
            if (store.failGet) throw store.failGet;
            return data.has(key) ? structuredClone(data.get(key)) : fallback;
        },
        async set(key, value) { data.set(key, structuredClone(value)); return true; },
        async delete(key) { return data.delete(key); },
        async update(key, mutator, defaultValue = null) {
            const current = data.has(key) ? structuredClone(data.get(key)) : structuredClone(defaultValue);
            const next = await mutator(current);
            data.set(key, structuredClone(next));
            return next;
        },
    };
    return store;
}

let guildSeq = 0;
const nextGuild = () => `91000000000000${String(++guildSeq).padStart(4, '0')}`;

// ── guild config cache ────────────────────────────────────────────────────────

test('guild config: the second read is a cache hit (one database read)', async () => {
    const client = { db: countingStore() };
    const guildId = nextGuild();
    await setGuildConfig(client, guildId, { prefix: '?' });
    client.db.gets = 0;
    const first = await getGuildConfig(client, guildId);
    const second = await getGuildConfig(client, guildId);
    assert.equal(first.prefix, '?');
    assert.equal(second.prefix, '?');
    assert.equal(client.db.gets, 1);
    assert.equal(guildConfigCacheInfo(client).size, 1);
});

test('guild config: every write path clears the entry, so the next read sees the new value', async () => {
    const client = { db: countingStore() };
    const guildId = nextGuild();
    assert.equal((await readGuildConfig(client, guildId)).prefix, '!');

    await writeGuildConfig(client, guildId, { ...(await readGuildConfig(client, guildId)), prefix: 'a' });
    assert.equal((await readGuildConfig(client, guildId)).prefix, 'a');

    await updateGuildConfigAtomic(client, guildId, (current) => ({ ...current, prefix: 'b' }));
    assert.equal((await readGuildConfig(client, guildId)).prefix, 'b');

    await patchGuildConfig(client, guildId, { prefix: 'c' });
    assert.equal((await getGuildConfig(client, guildId)).prefix, 'c');

    // A write that bypasses this module can clear it by hand.
    client.db.data.set(`guild:${guildId}:config`, { prefix: 'd' });
    assert.equal((await readGuildConfig(client, guildId)).prefix, 'c', 'cached until cleared');
    invalidateGuildConfigCache(client, guildId);
    assert.equal((await readGuildConfig(client, guildId)).prefix, 'd');
});

test('guild config: a failed write still clears the entry', async () => {
    const client = { db: countingStore() };
    const guildId = nextGuild();
    await readGuildConfig(client, guildId);
    client.db.update = async () => { throw new Error('connection reset'); };
    await assert.rejects(updateGuildConfigAtomic(client, guildId, (c) => c));
    client.db.gets = 0;
    await readGuildConfig(client, guildId);
    assert.equal(client.db.gets, 1);
});

test('guild config: a database error throws and is never cached; no defaults on error', async () => {
    const client = { db: countingStore() };
    const guildId = nextGuild();
    client.db.failGet = new Error('database not responding');
    await assert.rejects(readGuildConfig(client, guildId), /database not responding/);
    await assert.rejects(getGuildConfig(client, guildId));
    assert.equal(guildConfigCacheInfo(client).size, 0);
    client.db.failGet = null;
    const gets = client.db.gets;
    await readGuildConfig(client, guildId);
    assert.equal(client.db.gets, gets + 1, 'the read after the error goes to the database');
});

test('guild config: callers get a copy; changing it does not change the cache', async () => {
    const client = { db: countingStore() };
    const guildId = nextGuild();
    const config = await getGuildConfig(client, guildId);
    config.prefix = 'mutated';
    assert.equal((await getGuildConfig(client, guildId)).prefix, '!');
});

test('guild config: a read that started before a write does not cache the old value', async () => {
    const client = { db: countingStore() };
    const guildId = nextGuild();
    let release;
    client.db.getDelay = new Promise((resolve) => { release = resolve; });
    const slowRead = readGuildConfig(client, guildId); // reads the old (empty) config
    await tick();
    client.db.getDelay = null;
    await updateGuildConfigAtomic(client, guildId, (current) => ({ ...current, prefix: 'new' }));
    release();
    await slowRead;
    assert.equal((await readGuildConfig(client, guildId)).prefix, 'new');
});

test('config cache: entries expire after the TTL and the size stays bounded', async () => {
    let now = 0;
    const cache = createConfigCache({ maxSize: 3, ttlMs: 1000, now: () => now });
    const db = {};
    let loads = 0;
    const loader = async () => ({ n: ++loads });
    await cache.read(db, 'a', loader);
    await cache.read(db, 'a', loader);
    assert.equal(loads, 1);
    now = 1001;
    await cache.read(db, 'a', loader);
    assert.equal(loads, 2, 'expired entry is read again');
    for (const id of ['b', 'c', 'd', 'e']) await cache.read(db, id, loader);
    assert.equal(cache.size(db), 3);
    // Another database object has its own entries.
    assert.equal(cache.size({}), 0);
});

// ── counting game cache ───────────────────────────────────────────────────────

test('counting config: cached between messages, cleared by every write', async () => {
    const client = { db: countingStore() };
    const guildId = nextGuild();
    await activateCountingGame(client, guildId, 'chan', 'decimal');
    client.db.gets = 0;
    await getCountingGameConfig(client, guildId);
    await getCountingGameConfig(client, guildId);
    assert.equal(client.db.gets, 1);

    await recordCorrectCount(client, guildId, 'u1', 1);
    assert.equal((await getCountingGameConfig(client, guildId)).nextNumber, 2);
    await resetCountingGame(client, guildId, 1);
    assert.equal((await getCountingGameConfig(client, guildId)).nextNumber, 1);
    assert.ok(countingCacheInfo(client).size <= 1);
});

test('counting config: a database error throws and is not cached', async () => {
    const client = { db: countingStore() };
    const guildId = nextGuild();
    client.db.failGet = new Error('down');
    await assert.rejects(getCountingGameConfig(client, guildId), /down/);
    assert.equal(countingCacheInfo(client).size, 0);
    client.db.failGet = null;
    assert.equal((await getCountingGameConfig(client, guildId)).enabled, false);
});

// ── bounded maps ──────────────────────────────────────────────────────────────

test('bounded maps: the in-memory maps named in B5 are BoundedMaps with a limit', () => {
    assert.ok(calculationContexts instanceof BoundedMap);
    for (let i = 0; i < calculationContexts.maxSize + 10; i += 1) calculationContexts.set(`k${i}`, {});
    assert.equal(calculationContexts.size, calculationContexts.maxSize);
    calculationContexts.clear();

    const files = {
        'src/services/applicationService.js': /applicationCooldowns = new BoundedMap\(/,
        'src/commands/Tools/modules/tools_calculate.js': /calculationHistory = new BoundedMap\(/,
        'src/utils/welcomeImageStore.js': /refreshCache = new BoundedMap\([\s\S]*warnedLegacyUrls = new BoundedSet\(/,
        'src/services/config/configService.js': /configChangeHistory = new BoundedMap\(/,
        'src/services/community/starboardService.js': /posts = new BoundedMap\([\s\S]*byStarMessage = new BoundedMap\([\s\S]*noPost = new BoundedSet\(/,
    };
    for (const [file, pattern] of Object.entries(files)) assert.match(read(file), pattern, file);
    assert.doesNotMatch(read('src/services/community/starboardService.js'), /SELECT \* FROM/);
});

test('define: an LRU of 500 words and a per-user cooldown on API calls', async () => {
    resetDefineCache();
    let calls = 0;
    const get = async (url) => {
        calls += 1;
        if (url.endsWith('/zzqx')) throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
        return { data: [{ word: decodeURIComponent(url.split('/').pop()), meanings: [] }] };
    };
    let now = 1_000_000;
    const first = await lookupDefinition('Cat', 'u1', { get, now });
    assert.equal(first.entry.word, 'cat');
    assert.equal((await lookupDefinition('cat ', 'u2', { get, now })).cached, true, 'cache hit, case and spaces ignored');
    assert.equal(calls, 1);

    const wait = await lookupDefinition('dog', 'u1', { get, now: now + 1000 });
    assert.ok(wait.cooldownMs > 0 && wait.cooldownMs <= DEFINE_COOLDOWN_MS);
    assert.equal(calls, 1, 'no API call during the cooldown');

    now += DEFINE_COOLDOWN_MS;
    assert.equal((await lookupDefinition('zzqx', 'u1', { get, now })).entry, null, '404 means no entry');
    assert.equal((await lookupDefinition('zzqx', 'u3', { get, now })).cached, true, 'a word with no entry is cached too');

    const outage = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
    await assert.rejects(lookupDefinition('bird', 'u4', { get: outage, now }), /timeout/);
    assert.equal((await lookupDefinition('bird', 'u5', { get, now })).cached, false, 'an outage is not cached');

    for (let i = 0; i < DEFINE_CACHE_SIZE + 5; i += 1) await lookupDefinition(`w${i}`, `user${i}`, { get, now });
    calls = 0;
    await lookupDefinition('cat', 'new-user', { get, now });
    assert.equal(calls, 1, 'the oldest word was dropped (bounded at 500)');
    resetDefineCache();
});

// ── logs ──────────────────────────────────────────────────────────────────────

test('prefix command log line: names and counts only, never the arguments', () => {
    const line = prefixCommandLogLine({ commandName: 'report', argCount: 2, userId: '1', guildId: '2' });
    assert.equal(line, 'Prefix command: report (2 args) user=1 guild=2');
    const source = read('src/events/messageCreate.js');
    assert.doesNotMatch(source, /args\.join/);
    assert.doesNotMatch(source, /logger\.info\(`(Prefix command|Resolved command|Executing prefix)/);
    assert.match(source, /logger\.debug\(prefixCommandLogLine\(/);
    assert.doesNotMatch(read('src/utils/prefixParser.js'), /JSON\.stringify\(args\)/);
});

test('logs: command received and level-ups are debug, level-ups logged once', () => {
    assert.match(read('src/events/interactionCreate.js'), /logger\.debug\(`Command received: \//);
    assert.doesNotMatch(read('src/events/messageCreate.js'), /leveled up/);
    const xp = read('src/services/leveling/xpSystem.js');
    assert.equal((xp.match(/Level up: user/g) || []).length, 1);
    assert.doesNotMatch(xp, /logger\.info\(`.*leveled up/);
});

test('level role sync: one summary line, warn only when something was skipped or failed', () => {
    const base = { memberId: 'm', guildId: 'g', level: 5 };
    assert.equal(roleSyncLogLine({ added: [], removed: [], skipped: [], errors: 0 }, base), null);
    const ok = roleSyncLogLine({ added: ['r1', 'r2'], removed: ['r0'], skipped: [], errors: 0 }, base);
    assert.equal(ok.level, 'info');
    assert.equal(ok.text, 'Level reward roles for m in guild g (level 5): 2 given, 1 taken off, 0 skipped, 0 failed');
    const bad = roleSyncLogLine({ added: [], removed: [], skipped: [{ roleId: 'r3', problem: 'above me' }], errors: 1 },
        { ...base, errorNotes: ['give r4: Missing Permissions'] });
    assert.equal(bad.level, 'warn');
    assert.match(bad.text, /r3: above me; give r4: Missing Permissions/);
    assert.doesNotMatch(read('src/services/leveling/levelRoleSyncService.js'), /logger\.info\(`(Gave|Took) level reward role/);
});

// ── log channel 403 backoff ───────────────────────────────────────────────────

test('logEvent: a refused log channel is paused, not retried on every event', async () => {
    resetLogChannelBackoff();
    const guildId = nextGuild();
    const channelId = '92000000000000001';
    let sends = 0;
    const channel = {
        id: channelId, type: 0,
        permissionsFor: () => ({ has: () => true }),
        send: async () => { sends += 1; throw Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }); },
    };
    const guild = { id: guildId, name: 'G', iconURL: () => null, channels: { cache: new Map([[channelId, channel]]) }, members: { me: {} } };
    const client = { db: countingStore({ [`guild:${guildId}:config`]: { logging: { enabled: true, channels: { audit: channelId } } } }), guilds: { cache: new Map([[guildId, guild]]) } };
    assert.equal(await logEvent({ client, guildId, eventType: 'moderation.ban', data: { title: 'x' } }), null);
    assert.equal(isLogChannelBackedOff(guildId, channelId), true);
    await logEvent({ client, guildId, eventType: 'moderation.ban', data: { title: 'y' } });
    assert.equal(sends, 1, 'no second request while paused');
    assert.equal(isLogChannelBackedOff(guildId, channelId, Date.now() + 11 * 60 * 1000), false, 'the pause ends');
    assert.equal(isLogChannelBackedOff(nextGuild(), channelId), false, 'the pause is per server');
    assert.equal(isForbiddenError({ code: 50013 }), true);
    assert.equal(isForbiddenError({ status: 500 }), false);
    resetLogChannelBackoff();
});

test('logEvent: a server pointing its log at another server\'s channel never pauses that server\'s logs', async () => {
    resetLogChannelBackoff();
    const victim = nextGuild();
    const attacker = nextGuild();
    const channelId = '92000000000000002';
    let sends = 0;
    const channel = {
        id: channelId, type: 0, guildId: victim,
        permissionsFor: () => ({ has: () => true }),
        send: async () => { sends += 1; return { id: 'm' }; },
    };
    const victimGuild = { id: victim, name: 'V', iconURL: () => null, channels: { cache: new Map([[channelId, channel]]) }, members: { me: {} } };
    // The attacker's guild resolves the foreign id (as a REST fetch would) but it belongs to the victim.
    const attackerGuild = { id: attacker, name: 'A', iconURL: () => null, channels: { cache: new Map([[channelId, channel]]) }, members: { me: {} } };
    const client = {
        db: countingStore({
            [`guild:${victim}:config`]: { logging: { enabled: true, channels: { audit: channelId } } },
            [`guild:${attacker}:config`]: { logging: { enabled: true, channels: { audit: channelId } } },
        }),
        guilds: { cache: new Map([[victim, victimGuild], [attacker, attackerGuild]]) },
    };
    assert.equal(await logEvent({ client, guildId: attacker, eventType: 'moderation.ban', data: { title: 'x' } }), null, 'a foreign channel is refused');
    assert.equal(sends, 0, 'nothing posted into another server');
    assert.equal(isLogChannelBackedOff(victim, channelId), false);
    assert.ok(await logEvent({ client, guildId: victim, eventType: 'moderation.ban', data: { title: 'y' } }), 'the owner server still logs');
    assert.equal(sends, 1);
    resetLogChannelBackoff();
});

test('logEvent: a temporary error loading the log channel does not pause logging', async () => {
    resetLogChannelBackoff();
    const guildId = nextGuild();
    const channelId = '92000000000000003';
    let fail = true;
    const channel = { id: channelId, type: 0, guildId, permissionsFor: () => ({ has: () => true }), send: async () => ({ id: 'm' }) };
    const guild = {
        id: guildId, name: 'G', iconURL: () => null, members: { me: {} },
        channels: { cache: new Map(), fetch: async () => { if (fail) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); return channel; } },
    };
    const client = { db: countingStore({ [`guild:${guildId}:config`]: { logging: { enabled: true, channels: { audit: channelId } } } }), guilds: { cache: new Map([[guildId, guild]]) } };
    assert.equal(await logEvent({ client, guildId, eventType: 'moderation.ban', data: { title: 'x' } }), null);
    assert.equal(isLogChannelBackedOff(guildId, channelId), false, 'not paused after a network error');
    fail = false;
    assert.ok(await logEvent({ client, guildId, eventType: 'moderation.ban', data: { title: 'y' } }), 'the next event is logged');
    // A confirmed Unknown Channel does pause.
    guild.channels.fetch = async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 }); };
    const other = '92000000000000004';
    client.db = countingStore({ [`guild:${guildId}:config`]: { logging: { enabled: true, channels: { audit: other } } } });
    assert.equal(await logEvent({ client, guildId, eventType: 'moderation.ban', data: { title: 'z' } }), null);
    assert.equal(isLogChannelBackedOff(guildId, other), true);
    resetLogChannelBackoff();
});

test('setLogChannel: refuses another server\'s channel id and lifts the pause for the new channel', async () => {
    resetLogChannelBackoff();
    const { setLogChannel } = await import('../src/services/loggingService.js');
    const guildId = nextGuild();
    const own = '92000000000000010';
    const foreign = '92000000000000011';
    const guild = { id: guildId, channels: { cache: new Map([[own, { id: own }]]) } };
    const client = { db: countingStore({}), guilds: { cache: new Map([[guildId, guild]]) } };
    assert.equal(await setLogChannel(client, guildId, 'audit', foreign), false, 'foreign id not saved');
    assert.equal(await setLogChannel(client, guildId, 'audit', own), true);
    assert.equal(await setLogChannel(client, guildId, 'audit', null), true, 'clearing always works');
    resetLogChannelBackoff();
});

test('every src/events file parses and loads (a syntax error must fail the suite)', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = new URL('../src/events/', import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
        const mod = await import(new URL(file, dir).href);
        assert.ok(mod, file);
    }
});

// ── client cache limits ───────────────────────────────────────────────────────

test('client cache: limits and sweepers as in the B5 plan; invites and automod rules kept', () => {
    const settings = cacheLimitSettings();
    assert.equal(settings.MessageManager, MESSAGE_CACHE_PER_CHANNEL);
    assert.equal(settings.MessageManager, 50);
    assert.equal(settings.GuildMemberManager.maxSize, MEMBER_CACHE_PER_GUILD);
    assert.equal(settings.GuildMemberManager.keepOverLimit({ id: 'bot', client: { user: { id: 'bot' } } }), true);
    assert.equal(settings.GuildMemberManager.keepOverLimit({ id: 'x', client: { user: { id: 'bot' } } }), false);
    for (const name of ['ReactionUserManager', 'PresenceManager', 'GuildStickerManager', 'GuildScheduledEventManager', 'StageInstanceManager', 'ThreadMemberManager']) {
        assert.equal(settings[name], 0, name);
    }
    for (const name of ['ReactionManager', 'VoiceStateManager', 'GuildInviteManager', 'AutoModerationRuleManager']) {
        assert.equal(name in settings, false, `${name} keeps the default`);
    }
    assert.equal(typeof makeCache(), 'function');
    assert.deepEqual(sweepers().messages, { interval: 900, lifetime: 3600 });
    assert.ok(sweepers().threads, 'thread sweeper default kept');
    const app = read('src/app.js');
    assert.match(app, /makeCache: makeCache\(\),\s*sweepers: sweepers\(\),/);
});

// ── calculator modal: only the submitter's own context ────────────────────────

test('calculator modal: a context key of another user is refused', async () => {
    const { resolveCalculatorContext } = await import('../src/handlers/calculateModals.js');
    const contexts = new Map([['111_add', { userId: '111', expression: '1+1' }]]);
    assert.deepEqual(resolveCalculatorContext(contexts, '111_add', '111'), { context: { userId: '111', expression: '1+1' } });
    assert.deepEqual(resolveCalculatorContext(contexts, '111_add', '222'), { notYours: true }, 'someone else\'s key');
    assert.deepEqual(resolveCalculatorContext(contexts, '1111_add', '111'), { notYours: true }, 'a longer id that starts with mine is not mine');
    assert.deepEqual(resolveCalculatorContext(contexts, '111_divide', '111'), { context: null }, 'own key, expired');
    contexts.set('222_add', { userId: '111' });
    assert.deepEqual(resolveCalculatorContext(contexts, '222_add', '222'), { notYours: true }, 'stored owner must match too');
    assert.deepEqual(resolveCalculatorContext(contexts, '', '111'), { notYours: true });
    assert.deepEqual(resolveCalculatorContext(contexts, '111_add', '222').context, undefined);
    const tool = read('src/commands/Tools/modules/tools_calculate.js');
    assert.match(tool, /i\.user\.id === interaction\.user\.id/, 'calculator buttons are filtered to the invoker');
});
