// Dashboard audit fixes (D1–D17): atomic saves under the row lock, no defaults after a
// database error, the ban list paging, cleared fields, form length checks. Fake stores only
// (no database, no Discord).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    resetSettingsCacheForTests, setSettingsDbForTests, updateSettings, updateSettingsBatch, getStoredSetting,
} from '../src/services/settings/guildSettings.js';
import { derivedTemplateId, newTemplateId, TEMPLATE_ID, withTemplateIds, cleanTemplates } from '../src/services/enforcement/templateService.js';
import { getAction } from '../src/services/dashboard/modules/index.js';
import enforcementModule from '../src/services/dashboard/modules/enforcement.js';
import { InputError, list, multiline, text } from '../src/services/dashboard/forms.js';
import { createBanCache, fetchBanList } from '../src/services/dashboard/bansData.js';
import { setLogChannels, updateEventLogging, applyEventToggle } from '../src/services/loggingService.js';
import { updateLevelIgnoreList } from '../src/services/leveling/leveling.js';
import { getAllReactionRoleMessages } from '../src/services/reactionRoleService.js';
import { ensureCommunityCaches, setCommunityCachesLoadedForTests } from '../src/services/community/index.js';
import { getApplications } from '../src/utils/database.js';
import { pruneExpiredApplications, runRetention } from '../src/services/privacy/retentionService.js';
import { getGuildConfigKey, getReactionRolesPrefix } from '../src/utils/database/keys.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const ENV = { NODE_ENV: 'test', MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT };
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

afterEach(() => {
    resetSettingsCacheForTests();
    setSettingsDbForTests(null);
});

/**
 * guild_settings / dashboard_audit as a fake: withTransaction serializes like the row lock
 * (SELECT … FOR UPDATE), pauses between read and write, and rolls back on a throw.
 */
function settingsDb({ failUpdateFor = null } = {}) {
    const rows = {};
    const audit = [];
    let chain = Promise.resolve();
    const client = (tx) => ({
        query: async (sql, params) => {
            const q = sql.trim();
            const id = params[0];
            if (/^INSERT INTO guild_settings/.test(q)) { tx.rows[id] ||= {}; return { rows: [] }; }
            if (/^SELECT data FROM guild_settings/.test(q)) { await tick(); return { rows: [{ data: structuredClone(tx.rows[id]) }] }; }
            if (/^UPDATE guild_settings/.test(q)) {
                if (failUpdateFor === id) throw new Error('connection lost');
                tx.rows[id] = { ...tx.rows[id], ...JSON.parse(params[1]) };
                return { rows: [{ guild_id: id, data: tx.rows[id], seeded_from_env: false, updated_at: null }] };
            }
            if (/^INSERT INTO dashboard_audit/.test(q)) { tx.audit.push({ guildId: id, key: params[4], old: JSON.parse(params[5]), new: JSON.parse(params[6]) }); return { rows: [] }; }
            throw new Error(`unexpected query ${q}`);
        },
    });
    const db = {
        rows, audit, transactions: 0,
        isAvailable: () => true, settingsTable: 'guild_settings', auditTable: 'dashboard_audit',
        query: async () => ({ rows: [] }),
        withTransaction: (fn) => {
            const run = async () => {
                db.transactions += 1;
                const tx = { rows: structuredClone(rows), audit: [] };
                const result = await fn(client(tx));
                for (const key of Object.keys(rows)) delete rows[key];
                Object.assign(rows, tx.rows);
                audit.push(...tx.audit);
                return result;
            };
            const result = chain.then(run, run);
            chain = result.catch(() => {});
            return result;
        },
    };
    return db;
}

// ── D1: templates by stable id, add/remove under the lock ─────────────────

test('D1 templates: legacy ids are derived from the name (same on every read, nothing written)', () => {
    const legacy = [{ name: 'Spam', action: 'warn', reasonKey: 'spam', duration: null }];
    const a = withTemplateIds(legacy);
    const b = withTemplateIds(structuredClone(legacy));
    assert.equal(a[0].id, b[0].id);
    assert.equal(a[0].id, derivedTemplateId('spam'), 'case-insensitive like the unique names');
    assert.ok(TEMPLATE_ID.test(a[0].id) && TEMPLATE_ID.test(newTemplateId()));
    assert.equal(legacy[0].id, undefined, 'the stored list is not changed by a read');
    assert.equal(cleanTemplates(a)[0].id, a[0].id, 'cleanTemplates keeps the id');
    assert.throws(() => cleanTemplates([{ ...a[0] }, { ...a[0], name: 'Other' }]), /same id/);
});

function enforcementCtx() {
    return { guildId: MAIN, env: ENV, actor: { userId: '300000000000000001', username: 'admin' }, services: { updateSettings } };
}
const runAction = (name, form) => getAction(enforcementModule, name).run(enforcementCtx(), form);

test('D1 templates: two adds at once both survive; remove by id removes that one even after the list changed', async () => {
    const db = settingsDb();
    db.rows[MAIN] = { enforcementTemplates: [{ name: 'Spam', action: 'warn', reasonKey: 'spam', duration: null }] };
    setSettingsDbForTests(db);
    const legacyId = derivedTemplateId('Spam');
    await Promise.all([
        runAction('template-add', { name: 'Raid ban', action: 'ban', reasonKey: 'spam', duration: '' }),
        runAction('template-add', { name: 'Short mute', action: 'mute', reasonKey: 'spam', duration: '1h' }),
    ]);
    let saved = db.rows[MAIN].enforcementTemplates;
    assert.deepEqual(saved.map((t) => t.name), ['Spam', 'Raid ban', 'Short mute'], 'no add overwrote the other');
    assert.equal(saved[0].id, legacyId, 'the legacy template got its derived id on the next save');
    assert.ok(saved.every((t) => TEMPLATE_ID.test(t.id)));
    // The page showed the list before "Raid ban" was removed elsewhere: removing "Short mute" by id still hits it.
    const shortId = saved[2].id;
    await runAction('template-remove', { id: saved[1].id });
    const result = await runAction('template-remove', { id: shortId });
    assert.match(result.message, /Short mute/);
    saved = db.rows[MAIN].enforcementTemplates;
    assert.deepEqual(saved.map((t) => t.name), ['Spam']);
    await assert.rejects(runAction('template-remove', { id: shortId }), (error) => error instanceof InputError && /gone/i.test(error.message));
    await assert.rejects(runAction('template-remove', { id: '0' }), InputError);
    assert.deepEqual(db.audit.filter((r) => r.key === 'enforcementTemplates').length, 4, 'one audit row per save');
});

test('D1 updateSettings(build): runs under the lock, null = nothing written, a throw writes nothing', async () => {
    const db = settingsDb();
    db.rows[MAIN] = { openChannelCap: 5 };
    setSettingsDbForTests(db);
    await Promise.all([1, 2, 3].map(() => updateSettings(MAIN, (valueOf) => ({ openChannelCap: valueOf('openChannelCap') + 1 }), { userId: '1' }, ENV)));
    assert.equal(db.rows[MAIN].openChannelCap, 8, 'three locked increments, none lost');
    const none = await updateSettings(MAIN, () => null, { userId: '1' }, ENV);
    assert.deepEqual(none.changes, []);
    await assert.rejects(updateSettings(MAIN, () => { throw new InputError('no'); }, { userId: '1' }, ENV), /no/);
    assert.equal(db.rows[MAIN].openChannelCap, 8);
    await assert.rejects(updateSettings(MAIN, () => ({ openChannelCap: 'x' }), { userId: '1' }, ENV), /openChannelCap|whole|number|Invalid/i, 'a built patch is validated too');
});

// ── D9: the settings backup in one transaction ───────────────────────────

test('D9 updateSettingsBatch: both servers in one transaction; a failure on the second saves neither', async () => {
    const db = settingsDb({ failUpdateFor: SUPPORT });
    db.rows[MAIN] = { openChannelCap: 5 };
    setSettingsDbForTests(db);
    const supportKey = (await import('../src/services/settings/settingsRegistry.js')).SETTINGS.find((e) => e.guild === 'support' && e.kind === 'number');
    const writes = [{ guildId: MAIN, patch: { openChannelCap: 9 } }];
    if (supportKey) writes.push({ guildId: SUPPORT, patch: { [supportKey.key]: supportKey.fallback } });
    else writes.push({ guildId: SUPPORT, patch: {} });
    await assert.rejects(updateSettingsBatch(writes, { userId: '1' }, ENV), /connection lost/);
    assert.equal(db.rows[MAIN].openChannelCap, 5, 'rolled back: the main server is unchanged');
    assert.equal(db.audit.length, 0);
    assert.equal(getStoredSetting(MAIN, 'openChannelCap'), undefined, 'the cache is not touched by a failed batch');
    const ok = settingsDb();
    setSettingsDbForTests(ok);
    const result = await updateSettingsBatch([{ guildId: MAIN, patch: { openChannelCap: 9 } }], { userId: '1', module: 'backup' }, ENV);
    assert.equal(ok.transactions, 1);
    assert.deepEqual(result.changes.map((c) => [c.guildId, c.key]), [[MAIN, 'openChannelCap']]);
});

// ── D10 / D13: form lengths ───────────────────────────────────────────────

test('D10 text(): a browser\'s \\r\\n counts as one character; D13 multiline()/list() refuse instead of cutting', () => {
    assert.equal(text({ a: 'ab\r\ncd' }, 'a', 5), 'ab\ncd', '5 characters after \\r\\n → \\n');
    assert.throws(() => text({ a: 'ab\r\ncde' }, 'a', 5), (e) => e instanceof InputError && /at most 5/.test(e.message) && e.field === 'a');
    assert.equal(multiline({ m: 'x\r\ny' }, 'm', 3), 'x\ny');
    assert.throws(() => multiline({ m: 'x'.repeat(11) }, 'm', 10), (e) => e instanceof InputError && /at most 10/.test(e.message));
    assert.deepEqual(list({ l: ['a', 'b', 'a'] }, 'l', { max: 2 }), ['a', 'b']);
    assert.throws(() => list({ l: ['a', 'b', 'c'] }, 'l', { max: 2 }), (e) => e instanceof InputError && /at most 2/.test(e.message));
    assert.throws(() => list({ l: ['x'.repeat(30)] }, 'l', { maxLength: 25 }), (e) => e instanceof InputError && /at most 25/.test(e.message));
});

// ── D4: the ban list paged and cached ─────────────────────────────────────

function bannedGuild(count, { failAfter = Infinity } = {}) {
    const ids = Array.from({ length: count }, (_, i) => String(100000000000000000n + BigInt(i)));
    const calls = [];
    return {
        id: MAIN, calls,
        bans: {
            fetch: async ({ limit, after } = {}) => {
                calls.push({ limit, after });
                if (calls.length > failAfter) throw new Error('discord down');
                const start = after ? ids.findIndex((id) => BigInt(id) > BigInt(after)) : 0;
                const page = start < 0 ? [] : ids.slice(start, start + limit);
                return new Map(page.map((id) => [id, { user: { id, username: `u${id.slice(-4)}` }, reason: null }]));
            },
        },
    };
}

test('D4 fetchBanList: pages with `after`; cut at the cap says so; an exact fit is not "cut"', async () => {
    const g = bannedGuild(2500);
    const all = await fetchBanList(g, { cap: 10_000, pageSize: 1000 });
    assert.equal(all.bans.length, 2500);
    assert.equal(all.truncated, false);
    assert.deepEqual(g.calls.map((c) => c.after ? 'after' : 'first'), ['first', 'after', 'after']);
    const capped = await fetchBanList(bannedGuild(2500), { cap: 2000, pageSize: 1000 });
    assert.equal(capped.bans.length, 2000);
    assert.equal(capped.truncated, true);
    const exact = await fetchBanList(bannedGuild(2000), { cap: 2000, pageSize: 1000 });
    assert.equal(exact.truncated, false);
});

test('D4 createBanCache: one fetch per TTL, shared by concurrent readers, invalidate, failures not cached', async () => {
    let now = 0;
    const g = bannedGuild(3);
    const cache = createBanCache({ ttlMs: 1000, now: () => now });
    const [a, b] = await Promise.all([cache.get(g), cache.get(g)]);
    assert.equal(a, b);
    assert.equal(g.calls.length, 1);
    now = 500;
    await cache.get(g);
    assert.equal(g.calls.length, 1, 'cached');
    cache.invalidate(MAIN);
    await cache.get(g);
    assert.equal(g.calls.length, 2, 'invalidated after a ban/unban');
    const down = bannedGuild(3, { failAfter: 0 });
    const c2 = createBanCache();
    await assert.rejects(c2.get(down), /discord down/);
    await assert.rejects(c2.get(down), /discord down/, 'the failure was not cached as an empty list');
    assert.equal(down.calls.length, 2);
});

// ── D2: logging forms in one locked write ─────────────────────────────────

function kvStore(initial = {}, { failUpdate = false } = {}) {
    const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
    let chain = Promise.resolve();
    const store = {
        data, updates: 0,
        async get(key, fallback = null) { return data.has(key) ? structuredClone(data.get(key)) : fallback; },
        async set(key, value) { data.set(key, structuredClone(value)); return true; },
        async list(prefix) { return [...data.keys()].filter((k) => k.startsWith(prefix)); },
        async update(key, mutator, defaultValue = null) {
            const run = async () => {
                store.updates += 1;
                const current = data.has(key) ? structuredClone(data.get(key)) : structuredClone(defaultValue);
                await tick();
                const next = await mutator(current);
                if (failUpdate) throw new Error('write failed');
                data.set(key, structuredClone(next));
                return next;
            };
            const result = chain.then(run, run);
            chain = result.catch(() => {});
            return result;
        },
    };
    return store;
}
let guildN = 0;
const nextGuild = () => String(710000000000000000n + BigInt(++guildN));

test('D2 setLogChannels: all channels in one write, changes against the locked values; a failed write throws', async () => {
    const guildId = nextGuild();
    const db = kvStore();
    const client = { db };
    const a = '720000000000000001';
    const b = '720000000000000002';
    const changes = await setLogChannels(client, guildId, { audit: a, reports: b, applications: null });
    assert.equal(db.updates, 1, 'one locked write for the whole form');
    assert.deepEqual(changes.map((c) => [c.destination, c.new]), [['audit', a], ['reports', b]]);
    const config = db.data.get(getGuildConfigKey(guildId));
    assert.equal(config.logging.channels.audit, a);
    assert.equal(config.logging.enabled, true);
    assert.deepEqual(await setLogChannels(client, guildId, { audit: a }), [], 'unchanged → no changes');
    await assert.rejects(setLogChannels(client, guildId, { nowhere: a }), /Invalid log destination/);
    const failing = { db: kvStore({}, { failUpdate: true }) };
    await assert.rejects(setLogChannels(failing, nextGuild(), { audit: a }), /write failed/);
});

test('D2 updateEventLogging: the plan sees the locked toggles and every step is saved in one write', async () => {
    const guildId = nextGuild();
    const db = kvStore();
    const steps = await updateEventLogging({ db }, guildId, (events) => {
        assert.deepEqual(events, {});
        return [{ types: ['message.*'], enabled: false }, { types: ['moderation.ban'], enabled: false }];
    });
    assert.equal(steps.length, 2);
    assert.equal(db.updates, 1);
    const events = db.data.get(getGuildConfigKey(guildId)).logging.enabledEvents;
    assert.equal(events['message.*'], false);
    assert.equal(events['moderation.ban'], false);
    assert.deepEqual(applyEventToggle({ x: true }, ['y'], false), { x: true, y: false });
});

// ── D8: leveling no-XP list ───────────────────────────────────────────────

test('D8 updateLevelIgnoreList: concurrent adds and a remove all land; already listed = unchanged', async () => {
    const guildId = nextGuild();
    const db = kvStore();
    const client = { db };
    const [c1, c2, c3] = ['730000000000000001', '730000000000000002', '730000000000000003'];
    await Promise.all([c1, c2, c3].map((id) => updateLevelIgnoreList(client, guildId, 'ignoredChannels', 'add', id)));
    let leveling = db.data.get(getGuildConfigKey(guildId)).leveling;
    assert.deepEqual([...leveling.ignoredChannels].sort(), [c1, c2, c3]);
    const again = await updateLevelIgnoreList(client, guildId, 'ignoredChannels', 'add', c1);
    assert.equal(again.changed, false);
    const removed = await updateLevelIgnoreList(client, guildId, 'ignoredChannels', 'remove', c2);
    assert.equal(removed.changed, true);
    leveling = db.data.get(getGuildConfigKey(guildId)).leveling;
    assert.deepEqual([...leveling.ignoredChannels].sort(), [c1, c3]);
    await assert.rejects(updateLevelIgnoreList(client, guildId, 'somethingElse', 'add', c1), /no-XP|Invalid/);
});

// ── D6: reaction role panels ──────────────────────────────────────────────

test('D6 getAllReactionRoleMessages: a failed read throws (no silently missing panel); malformed panels still count', async () => {
    const guildId = nextGuild();
    const prefix = getReactionRolesPrefix(guildId);
    const db = kvStore({
        [`${prefix}1`]: { messageId: '1', channelId: '2', roles: [] },
        [`${prefix}2`]: { broken: true },
    });
    const panels = await getAllReactionRoleMessages({ db }, guildId);
    assert.equal(panels.length, 1);
    assert.equal(panels.storedCount, 2, 'the 5-panel cap counts the malformed one too');
    const get = db.get;
    db.get = async (key, fallback) => { if (key.endsWith('2')) throw new Error('db down'); return get(key, fallback); };
    await assert.rejects(getAllReactionRoleMessages({ db }, guildId), (error) => error.type === 'database' || /reaction role/i.test(error.message));
});

// ── D7: community caches ──────────────────────────────────────────────────

test('D7 ensureCommunityCaches: a cache that never loaded refuses with a database error, then loads lazily', async () => {
    setCommunityCachesLoadedForTests([]);
    // No community database in unit tests: the loaders return null (not loaded).
    await assert.rejects(ensureCommunityCaches(null), (error) => error.type === 'database' && /not responding/.test(error.userMessage));
    setCommunityCachesLoadedForTests();
    await ensureCommunityCaches(null);
});

// ── D5: applications read without deleting, paged ─────────────────────────

test('D5 getApplications: newest first, reads only the batches it needs, leaves expired ones out without deleting', async () => {
    const guildId = nextGuild();
    const prefix = `guild:${guildId}:applications:`;
    const now = Date.now();
    const initial = {};
    for (let i = 0; i < 120; i += 1) {
        const createdAt = now - i * 1000;
        initial[`${prefix}${createdAt}-a${i}`] = { id: `${createdAt}-a${i}`, userId: '1', status: 'pending', createdAt };
    }
    const old = now - 400 * 86_400_000;
    initial[`${prefix}${old}-old`] = { id: `${old}-old`, userId: '1', status: 'pending', createdAt: old };
    const db = kvStore(initial);
    const reads = [];
    const get = db.get;
    db.get = async (key, fallback) => { if (/^\d/.test(key.slice(prefix.length))) reads.push(key); return get(key, fallback); };
    db.delete = async () => { throw new Error('a read must not delete'); };
    const page = await getApplications({ db }, guildId, { limit: 10 });
    assert.equal(page.length, 10);
    assert.equal(page[0].id, `${now}-a0`, 'newest first');
    assert.ok(reads.length <= 50, `one batch read (${reads.length})`);
    const everything = await getApplications({ db }, guildId, { limit: Infinity });
    assert.equal(everything.length, 120, 'the 400-day-old pending one is past retention: left out, not deleted');
    assert.ok(db.data.has(`${prefix}${old}-old`));
});

test('D5 the daily retention job deletes expired applications per server (client rules)', async () => {
    const cleaned = [];
    const client = { db: {}, guilds: { cache: new Map([['1', {}], ['2', {}]]) } };
    const n = await pruneExpiredApplications({ client, cleanup: async (c, guildId) => { cleaned.push(guildId); if (guildId === '2') throw new Error('x'); return { removed: 3 }; } });
    assert.equal(n, 3);
    assert.deepEqual(cleaned, ['1', '2'], 'one failing server does not stop the others');
    const seen = [];
    const result = await runRetention(client, { rules: [], clientRules: [['applications', async ({ client: c }) => { seen.push(c); return 1; }]] });
    assert.equal(result.counts.applications, 1);
    assert.equal(seen[0], client);
    const noClient = await runRetention(null, { rules: [], clientRules: [['applications', async () => 1]] });
    assert.deepEqual(noClient.counts, {}, 'without the bot client the client rules do not run');
});
