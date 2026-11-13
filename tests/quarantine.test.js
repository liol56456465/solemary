// Quarantine (enforcement/quarantineService.js): quarantine and release, the hierarchy refusals,
// rejoin, the View Channel deny on new channels, the alert's head-role pings (exactly those
// roles), the DM text, the raid trigger (automodService.actOn) and the staff guard trigger
// (staffGuardService), and /staff restore lifting a staff guard quarantine. Each with a control.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AuditLogEvent, ChannelType, Collection, PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
process.env.MAIN_GUILD_ID ??= MAIN;

const q = await import('../src/services/enforcement/quarantineService.js');
const { quarantineDm } = await import('../src/services/enforcement/dmTemplates.js');
const { postAlert } = await import('../src/services/automod/alertPost.js');
const { setSettingsCacheForTests, resetSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
const { actOn, resetAutomodState, setAutomodDepsForTest } = await import('../src/services/automod/automodService.js');
const { normalizeSettings } = await import('../src/services/automod/automodSettings.js');
const staffGuard = await import('../src/services/automod/staffGuardService.js');
const { db } = await import('../src/utils/database/wrapper.js');
const { MemoryStorage } = await import('../src/utils/memoryStorage.js');

const G = '300000000000000001';
const BOT = '300000000000000002';
const OWNER = '300000000000000003';
const TARGET = '300000000000000004';
const MOD = '300000000000000005';
const Q_ROLE = '600000000000000001';
const MEMBER_ROLE = '600000000000000002';
const HELPER_ROLE = '600000000000000003';
const BOOST_ROLE = '600000000000000004';
const HEAD_A = '600000000000000005';
const HEAD_B = '600000000000000006';
const HIGH_ROLE = '600000000000000007';
const ALERTS = '700000000000000001';

afterEach(() => {
    q.setQuarantineDepsForTest(null);
    setAutomodDepsForTest(null);
    staffGuard.setStaffGuardDepsForTest(null);
    resetSettingsCacheForTests();
});

const role = (id, name, position, { managed = false, perms = 0n } = {}) => ({ id, name, position, managed, permissions: { bitfield: perms, has: (bit) => (perms & bit) === bit } });

let messageSeq = 0;
function channel(id, type = ChannelType.GuildText) {
    const cache = new Map();
    return {
        id, type, name: `ch-${id.slice(-2)}`, sent: [],
        permissionOverwrites: {
            cache,
            edit: async (r, values) => {
                const prev = cache.get(r.id) || { allowBits: new Set(), denyBits: new Set() };
                const allowBits = new Set(prev.allowBits);
                const denyBits = new Set(prev.denyBits);
                for (const [name, on] of Object.entries(values)) {
                    const bit = PermissionFlagsBits[name];
                    allowBits.delete(bit); denyBits.delete(bit);
                    (on ? allowBits : denyBits).add(bit);
                }
                cache.set(r.id, { allowBits, denyBits, allow: { has: (bit) => allowBits.has(bit) }, deny: { has: (bit) => denyBits.has(bit) } });
            },
        },
        isTextBased: () => true,
        posted: new Map(),
        get messages() { return { fetch: async (mid) => this.posted.get(mid) || null }; },
        async send(payload) {
            messageSeq += 1;
            const message = {
                id: `8000000000000000${String(messageSeq).padStart(2, '0')}`, channelId: id, payload,
                delete: async () => { this.posted.delete(message.id); },
                edit: async (next) => { message.payload = next; message.edited = true; },
            };
            this.posted.set(message.id, message);
            return message;
        },
    };
}

function makeWorld({ guildId = G } = {}) {
    const roles = new Map([
        [guildId, role(guildId, '@everyone', 0)],
        [Q_ROLE, role(Q_ROLE, 'Quarantine', 5)],
        [MEMBER_ROLE, role(MEMBER_ROLE, 'Member', 1)],
        [HELPER_ROLE, role(HELPER_ROLE, 'Helper', 2, { perms: PermissionFlagsBits.Administrator })],
        [BOOST_ROLE, role(BOOST_ROLE, 'Booster', 3, { managed: true })],
        [HEAD_A, role(HEAD_A, 'Owner role', 8)], [HEAD_B, role(HEAD_B, 'Co-owner', 7)],
        [HIGH_ROLE, role(HIGH_ROLE, 'Above Mewvo', 20)],
    ]);
    const channels = new Map([['700000000000000002', channel('700000000000000002')], ['700000000000000003', channel('700000000000000003', ChannelType.PublicThread)]]);
    const guild = { id: guildId, name: 'Test <Server>', ownerId: OWNER, roles: { cache: roles, fetch: async () => null }, channels: { cache: channels, fetch: async () => null }, calls: [] };
    const me = { id: BOT, user: { id: BOT }, permissions: { has: () => true }, roles: { highest: { position: 10 } } };
    const members = new Map();
    guild.members = { me, cache: members, fetch: async (id) => members.get(typeof id === 'string' ? id : id?.user) || null };
    for (const r of roles.values()) Object.assign(r, { guild, editable: r.position < 10 && !r.managed });
    guild.client = { user: { id: BOT }, guilds: { cache: new Map([[guildId, guild]]) } };
    guild.fetchOwner = async () => null;
    return guild;
}

function addMember(guild, id, roleIds, { bot = false, highest = null, admin = false } = {}) {
    const ids = new Set([guild.id, ...roleIds]);
    const rolesOf = () => new Collection([...ids].map((rid) => [rid, guild.roles.cache.get(rid)]).filter(([, r]) => r));
    const member = {
        id, guild, user: { id, username: `user${id.slice(-2)}`, bot },
        permissions: { has: (bit) => admin && bit === PermissionFlagsBits.Administrator },
        voice: {},
        roles: {
            get cache() { return rolesOf(); },
            get highest() { return highest ?? { position: Math.max(...[...rolesOf().values()].map((r) => r.position)) }; },
            set: async (list, reason) => { guild.calls.push({ call: 'set', id, list: [...list], reason }); ids.clear(); ids.add(guild.id); for (const r of list) ids.add(r); },
            add: async (list, reason) => { const arr = [list].flat().map((r) => r.id || r); guild.calls.push({ call: 'add', id, list: arr, reason }); for (const r of arr) ids.add(r); },
            remove: async (list, reason) => { const arr = [list].flat().map((r) => r.id || r); guild.calls.push({ call: 'remove', id, list: arr, reason }); for (const r of arr) ids.delete(r); },
        },
    };
    guild.members.cache.set(id, member);
    return member;
}

function fakeDeps({ settings = {}, store = new Map(), failSet = false, dbUp = true } = {}) {
    const log = { dms: [], alerts: [], modLog: [] };
    q.setQuarantineDepsForTest({
        getFromDb: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
        setInDb: async (key, value) => { if (failSet) throw new Error('db down'); store.set(key, structuredClone(value)); return true; },
        deleteFromDb: async (key) => { store.delete(key); return true; },
        listKeys: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)),
        dbAvailable: () => dbUp,
        resolveSetting: (gid, key) => (Object.hasOwn(settings, key) ? settings[key] : null),
        appealInvite: () => 'https://discord.gg/ours',
        sendDm: async (user, o) => { log.dms.push({ user, ...o }); return true; },
        postAlert: async (client, kind, o) => { log.alerts.push({ kind, ...o }); return { id: '800000000000000009', channelId: ALERTS }; },
        postModLog: async (client, kind, fields, o) => { log.modLog.push({ kind, fields, ...o }); return true; },
        executeAction: async (o) => { log.actions = [...(log.actions || []), o]; return { record: { case_code: 'abc2345' } }; },
        hasOwnerPower: (userId) => userId === '300000000000000099',
    });
    return { store, log };
}

// ── quarantine and release ────────────────────────────────────────────────

test('quarantine: saves the removable roles, sets only managed + the quarantine role, DMs, alerts with Release, mod log with the subject', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const member = addMember(guild, TARGET, [MEMBER_ROLE, HELPER_ROLE, BOOST_ROLE]);
    const { store, log } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE, quarantinePingRoleIds: [HEAD_A, HEAD_B] } });
    const result = await q.quarantineMember(member, 'Spamming\nlinks', { by: { id: MOD, username: 'mod' }, trigger: 'manual' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.removed.map((r) => r.id).sort(), [HELPER_ROLE, MEMBER_ROLE].sort());
    assert.deepEqual(result.kept.map((r) => r.id), [BOOST_ROLE], 'managed roles cannot be removed');
    const record = store.get(q.quarantineKey(G, TARGET));
    assert.deepEqual(record.roles.sort(), [HELPER_ROLE, MEMBER_ROLE].sort());
    assert.equal(record.reason, 'Spamming links');
    assert.equal(record.trigger, 'manual');
    assert.deepEqual(record.by, { id: MOD, username: 'mod' });
    assert.deepEqual(record.alert, { channelId: ALERTS, messageId: '800000000000000009' });
    assert.deepEqual(guild.calls.find((c) => c.call === 'set').list, [BOOST_ROLE, Q_ROLE]);
    assert.deepEqual([...member.roles.cache.keys()].sort(), [G, Q_ROLE, BOOST_ROLE].sort());
    // DM: logged template with the reason and the support invite.
    assert.equal(log.dms.length, 1);
    assert.equal(log.dms[0].key, 'enf.quarantine');
    assert.equal(log.dms[0].params.invite, 'https://discord.gg/ours');
    assert.equal(log.dms[0].params.reason, 'Spamming links');
    // Alert: Release button, head roles only.
    const alert = log.alerts[0];
    assert.equal(alert.kind, 'staff');
    assert.deepEqual(alert.mentionRoleIds, [HEAD_A, HEAD_B]);
    assert.match(alert.content, new RegExp(`^<@&${HEAD_A}> <@&${HEAD_B}> `));
    const buttons = alert.components.at(-1).toJSON().components.map((c) => c.custom_id);
    assert.deepEqual(buttons, ['release', 'kick', 'ban', 'keep'].map((d) => `qdecide:${d}:${G}:${TARGET}`));
    assert.ok(alert.fields.some((f) => /Helper/.test(f.value) && /Member/.test(f.value)), 'roles removed listed');
    // Mod log: subject for the Advanced forum.
    assert.equal(log.modLog[0].kind, 'quarantine');
    assert.deepEqual(log.modLog[0].subject, { id: TARGET, username: 'user04' });
    // Every channel denies View Channel to the role; threads are skipped.
    assert.ok(guild.channels.cache.get('700000000000000002').permissionOverwrites.cache.get(Q_ROLE).deny.has(PermissionFlagsBits.ViewChannel));
    assert.equal(guild.channels.cache.get('700000000000000003').permissionOverwrites.cache.size, 0);

    // A second quarantine changes nothing.
    const again = await q.quarantineMember(member, 'again');
    assert.deepEqual(again, { ok: false, code: 'already' });
    assert.equal(log.dms.length, 1);
});

test('quarantine: no role set, a role above Mewvo, the database down, or a refused role change → nothing changed (control: the same member works)', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const member = addMember(guild, TARGET, [MEMBER_ROLE]);
    fakeDeps({ settings: {} });
    assert.deepEqual(await q.quarantineMember(member, 'x'), { ok: false, code: 'noRole' });
    fakeDeps({ settings: { quarantineRoleId: HIGH_ROLE } });
    assert.deepEqual(await q.quarantineMember(member, 'x'), { ok: false, code: 'roleAboveBot' });
    fakeDeps({ settings: { quarantineRoleId: Q_ROLE }, dbUp: false });
    assert.deepEqual(await q.quarantineMember(member, 'x'), { ok: false, code: 'database' });
    assert.equal(guild.calls.length, 0);
    const { store } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    member.roles.set = async () => { throw new Error('Missing Permissions'); };
    const failed = await q.quarantineMember(member, 'x');
    assert.equal(failed.code, 'assignFailed');
    assert.equal(store.size, 0, 'the record is removed again');
    const ok = addMember(guild, MOD, [MEMBER_ROLE]);
    assert.equal((await q.quarantineMember(ok, 'x')).ok, true, 'control');
});

test('hierarchy: the owner, Mewvo, bots and members at or above Mewvo are refused, nothing written (control: a member below works)', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const { store } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    const cases = [
        [addMember(guild, OWNER, [MEMBER_ROLE]), 'owner'],
        [addMember(guild, BOT, [MEMBER_ROLE]), 'self'],
        [addMember(guild, '300000000000000009', [MEMBER_ROLE], { bot: true }), 'bot'],
        [addMember(guild, '300000000000000010', [HIGH_ROLE]), 'aboveBot'],
        [addMember(guild, '300000000000000011', [MEMBER_ROLE], { highest: { position: 10 } }), 'aboveBot'],
    ];
    for (const [member, code] of cases) assert.deepEqual(await q.quarantineMember(member, 'x'), { ok: false, code }, code);
    assert.equal(store.size, 0);
    assert.equal(guild.calls.length, 0);
    assert.equal((await q.quarantineMember(addMember(guild, TARGET, [MEMBER_ROLE]), 'x')).ok, true);
});

test('release: gives back the saved roles that still exist below Mewvo, removes the quarantine role, deletes the record, logs it', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const member = addMember(guild, TARGET, [Q_ROLE]);
    const { store, log } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    store.set(q.quarantineKey(G, TARGET), { roleId: Q_ROLE, roles: [MEMBER_ROLE, HIGH_ROLE, '600000000000000099'], reason: 'raid', trigger: 'raid', at: new Date().toISOString() });
    const result = await q.releaseQuarantine(guild, TARGET, { by: { id: MOD, username: 'mod' } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.restored.map((r) => r.id), [MEMBER_ROLE]);
    assert.deepEqual(result.skipped, [HIGH_ROLE, '600000000000000099'], 'above Mewvo and deleted roles are skipped');
    assert.deepEqual([...member.roles.cache.keys()].sort(), [G, MEMBER_ROLE].sort());
    assert.equal(store.size, 0);
    assert.equal(log.modLog.at(-1).kind, 'unquarantine');
    assert.deepEqual(log.modLog.at(-1).subject, { id: TARGET, username: 'user04' });
    // Control: nothing to release.
    assert.deepEqual(await q.releaseQuarantine(guild, TARGET, { by: { id: MOD, username: 'mod' } }), { ok: false, code: 'none' });
});

test('release rules: not yourself, no saved role at/above you; the owner passes (control)', () => {
    const guild = makeWorld();
    const record = { roles: [MEMBER_ROLE], trigger: 'raid' };
    const admin = { roles: { highest: { position: 5 } } };
    assert.equal(q.releaseRefusal({ guild, record: null, targetId: TARGET, actorId: MOD }), 'none');
    assert.equal(q.releaseRefusal({ guild, record, targetId: TARGET, actorId: TARGET, actorMember: admin, home: false }), 'notYourself');
    // A staff guard quarantine in Mewvo's own servers stays owner-only (like /staff restore); elsewhere a decider may.
    assert.equal(q.releaseRefusal({ guild, record: { ...record, trigger: 'staffGuard' }, targetId: TARGET, actorId: MOD, actorMember: admin, home: true }), 'ownerOnly');
    assert.equal(q.releaseRefusal({ guild, record: { ...record, trigger: 'staffGuard' }, targetId: TARGET, actorId: MOD, actorMember: admin, home: false }), null);
    assert.equal(q.releaseRefusal({ guild, record: { roles: [HEAD_A] }, targetId: TARGET, actorId: MOD, actorMember: admin, home: false }), 'tooHigh');
    assert.equal(q.releaseRefusal({ guild, record, targetId: TARGET, actorId: MOD, actorMember: admin, home: false }), null);
    assert.equal(q.releaseRefusal({ guild, record: { roles: [HEAD_A], trigger: 'staffGuard' }, targetId: TARGET, actorId: OWNER, isOwner: true, home: true }), null);
});

// ── rejoin and new channels ───────────────────────────────────────────────

test('rejoin: a member with a record gets the quarantine role back at once (control: no record → nothing)', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const { store } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    const plain = addMember(guild, MOD, []);
    assert.equal(await q.reapplyQuarantineOnJoin(plain), false);
    assert.equal(guild.calls.length, 0);
    const back = addMember(guild, TARGET, []);
    store.set(q.quarantineKey(G, TARGET), { roleId: Q_ROLE, roles: [MEMBER_ROLE], reason: 'x', trigger: 'manual' });
    assert.equal(await q.reapplyQuarantineOnJoin(back), true);
    assert.deepEqual(guild.calls.at(-1).list, [Q_ROLE]);
    // The join pipeline gives no other role back while quarantined.
    const src = readFileSync(new URL('../src/events/guildMemberAdd.js', import.meta.url), 'utf8');
    for (const call of ['syncWarnRolesQuietly(guild', 'reapplyTempRolesOnJoin(member)', 'syncPremiumRole(', 'applyRoleRulesToMember(member)', 'mirrorRolesOnJoin(member)']) {
        assert.match(src, new RegExp(`!quarantined\\)? ?(?:await |void )?${call.replace(/[()]/g, '\\$&')}`), call);
    }
});

test('channelCreate: a new channel denies View Channel to the quarantine role (control: no role set → no overwrite)', async () => {
    const guild = makeWorld();
    const fresh = channel('700000000000000004');
    fresh.guild = guild;
    fakeDeps({ settings: {} });
    await q.applyQuarantineOverwriteToChannel(fresh);
    assert.equal(fresh.permissionOverwrites.cache.size, 0);
    fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    await q.applyQuarantineOverwriteToChannel(fresh);
    assert.ok(fresh.permissionOverwrites.cache.get(Q_ROLE).deny.has(PermissionFlagsBits.ViewChannel));
    const src = readFileSync(new URL('../src/events/channelCreate.js', import.meta.url), 'utf8');
    assert.ok(src.includes('await applyQuarantineOverwriteToChannel(channel)'));
});

// ── alert pings and the DM ────────────────────────────────────────────────

test('alert: allowedMentions are exactly the head roles, never everyone/users (control: no ping roles → parse [] only)', async () => {
    setSettingsCacheForTests(G, { alertsChannelId: ALERTS });
    const guild = makeWorld();
    const alerts = channel(ALERTS);
    const sent = [];
    alerts.send = async (payload) => { sent.push(payload); return { id: '1', channelId: ALERTS }; };
    guild.channels.cache.set(ALERTS, alerts);
    await postAlert(guild.client, 'staff', { guildId: G, title: 't', content: `<@&${HEAD_A}> @everyone **x**`, mentionRoleIds: [HEAD_A, 'nope'] });
    assert.deepEqual(sent[0].allowedMentions, { parse: [], roles: [HEAD_A] });
    await postAlert(guild.client, 'staff', { guildId: G, title: 't' });
    assert.deepEqual(sent[1].allowedMentions, { parse: [] });
    assert.equal(sent[1].content, undefined);
    // Ping roles that no longer exist in the staff server are dropped before the post.
    const member = addMember(guild, TARGET, [MEMBER_ROLE]);
    const { log } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE, quarantinePingRoleIds: [HEAD_A, '600000000000000098'] } });
    await q.quarantineMember(member, 'x');
    assert.deepEqual(log.alerts[0].mentionRoleIds, [HEAD_A]);
});

test('DM: server, reason and the invite line; no invite → no invite line; a reason cannot ping', () => {
    const withInvite = quarantineDm({ guildId: G, serverName: 'Cats', reason: 'spam @everyone', invite: 'https://discord.gg/ours' }, { lang: 'en' });
    assert.equal(withInvite, 'You have been quarantined in **Cats** for **spam @​everyone**.\nTo talk this out, join https://discord.gg/ours.');
    const without = quarantineDm({ guildId: G, serverName: 'Cats', reason: 'spam' }, { lang: 'en' });
    assert.equal(without, 'You have been quarantined in **Cats** for **spam**.');
    assert.match(quarantineDm({ guildId: G, serverName: 'Cats', reason: 'spam', invite: 'https://discord.gg/x' }, { lang: 'de' }), /Quarantäne/);
});

// ── triggers ──────────────────────────────────────────────────────────────

function raidMessage() {
    return {
        id: `m${Math.random()}`, content: 'buy now', guildId: G, channelId: 'c1', url: 'https://discord.com/channels/1/2/3',
        guild: { id: G, client: {} }, author: { id: TARGET, username: 'raider' },
        mentions: { users: new Map(), roles: new Map() }, attachments: new Map(), client: { user: { id: 'bot' } },
    };
}

test('raid trigger: a raid joiner breaking a rule is quarantined instead of kicked (control: no quarantine role → the kick)', async () => {
    const calls = [];
    const rec = (name, value) => async (...args) => { calls.push({ name, args }); return typeof value === 'function' ? value(...args) : value; };
    let ready = true;
    let quarantineResult = { ok: true, removed: [], kept: [] };
    setAutomodDepsForTest({
        countOffences: rec('countOffences', 0), applyStep: rec('applyStep', { record: { case_code: 'abc2345' } }), postReviewCard: rec('postReviewCard', null),
        noteRepeatHit: rec('noteRepeatHit', null), deleteQuietly: rec('deleteQuietly', null), isRaidJoiner: rec('isRaidJoiner', true),
        giveSecondChance: rec('giveSecondChance', false), giveHeadsUp: rec('giveHeadsUp', false), noteIncidentEvent: rec('noteIncidentEvent', 'stored'),
        quarantineReady: () => ready, quarantineMember: rec('quarantineMember', () => quarantineResult),
    });
    const member = { id: TARGET, joinedTimestamp: Date.now(), permissions: { has: () => false } };
    resetAutomodState();
    assert.equal(await actOn(raidMessage(), member, { rule: 'spam', mode: 'on' }, normalizeSettings({})), true);
    const qc = calls.find((c) => c.name === 'quarantineMember');
    assert.equal(qc.args[0], member);
    assert.equal(qc.args[2].trigger, 'raid');
    assert.equal(qc.args[2].automated, true);
    assert.equal(calls.filter((c) => c.name === 'applyStep').length, 0, 'no kick');
    assert.equal(calls.find((c) => c.name === 'postReviewCard').args[0].step.type, 'quarantine');

    // Refused (e.g. the joiner is above Mewvo): the kick, as before.
    calls.length = 0;
    quarantineResult = { ok: false, code: 'aboveBot' };
    resetAutomodState();
    await actOn(raidMessage(), member, { rule: 'spam', mode: 'on' }, normalizeSettings({}));
    assert.equal(calls.find((c) => c.name === 'applyStep').args[0].step.type, 'kick');

    // Control: no quarantine role → kick, quarantine never tried.
    calls.length = 0;
    ready = false;
    resetAutomodState();
    await actOn(raidMessage(), member, { rule: 'spam', mode: 'on' }, normalizeSettings({}));
    assert.equal(calls.filter((c) => c.name === 'quarantineMember').length, 0);
    assert.equal(calls.find((c) => c.name === 'applyStep').args[0].step.type, 'kick');
});

function memoryDb() {
    db.db = new MemoryStorage();
    db.useFallback = true;
    db.initialized = true;
    db.connectionType = 'memory';
}

function nukeEntry(roleId) {
    return { action: AuditLogEvent.RoleUpdate, executorId: TARGET, targetId: roleId, changes: [{ key: 'permissions', old: '0', new: String(PermissionFlagsBits.Administrator) }] };
}

test('staff guard trigger: the anti-nuke offender is quarantined (nuke buttons + Release); control: no quarantine role → staff roles stripped', async () => {
    memoryDb();
    staffGuard.resetStaffGuardState();
    const guild = makeWorld({ guildId: MAIN });
    const granted = guild.roles.cache.get(MEMBER_ROLE);
    granted.setPermissions = async () => {};
    granted.permissions.bitfield = PermissionFlagsBits.Administrator;
    addMember(guild, TARGET, [HELPER_ROLE, MEMBER_ROLE]);
    const calls = [];
    let ready = true;
    staffGuard.setStaffGuardDepsForTest({
        quarantineReady: () => ready,
        quarantineMember: async (member, reason, options) => { calls.push({ member, reason, options }); return { ok: true, removed: [guild.roles.cache.get(HELPER_ROLE)], kept: [] }; },
        getQuarantine: async () => null, listQuarantines: async () => [],
    });
    await staffGuard.handleAuditLogEntry(nukeEntry(MEMBER_ROLE), guild);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].member.id, TARGET);
    assert.equal(calls[0].options.trigger, 'staffGuard');
    assert.equal(calls[0].options.automated, true);
    assert.equal(calls[0].options.extraComponents.length, 1, 'the nuke buttons ride along');
    assert.match(calls[0].reason, /^Staff guard: /);
    assert.equal(guild.calls.filter((c) => c.call === 'remove').length, 0, 'no separate strip');

    // Control: no quarantine role → the staff roles are stripped and saved for /staff restore.
    ready = false;
    staffGuard.resetStaffGuardState();
    await staffGuard.handleAuditLogEntry(nukeEntry(MEMBER_ROLE), guild);
    assert.equal(calls.length, 1);
    const removed = guild.calls.find((c) => c.call === 'remove');
    assert.ok(removed.list.includes(HELPER_ROLE));
    assert.ok((await staffGuard.savedStaffRoles(guild, TARGET)).some((r) => r.id === HELPER_ROLE));
});

test('/staff restore lifts a staff guard quarantine (savedStaffRoles and listRemovedStaffRoles show it); a raid quarantine is left alone (control)', async () => {
    memoryDb();
    const guild = makeWorld({ guildId: MAIN });
    addMember(guild, TARGET, [Q_ROLE]);
    const records = new Map([[TARGET, { roleId: Q_ROLE, roles: [HELPER_ROLE], reason: 'Staff guard: x', trigger: 'staffGuard', at: '2026-11-13T00:00:00.000Z' }]]);
    const released = [];
    staffGuard.setStaffGuardDepsForTest({
        getQuarantine: async (gid, uid) => records.get(uid) || null,
        listQuarantines: async () => [...records].map(([userId, r]) => ({ userId, ...r })),
        releaseQuarantine: async (g, uid, o) => { released.push({ uid, o }); records.delete(uid); return { ok: true, restored: [guild.roles.cache.get(HELPER_ROLE)] }; },
    });
    assert.deepEqual((await staffGuard.savedStaffRoles(guild, TARGET)).map((r) => r.id), [HELPER_ROLE]);
    assert.deepEqual((await staffGuard.listRemovedStaffRoles(MAIN)).map((r) => r.userId), [TARGET]);
    const roles = await staffGuard.restoreStaffRoles(guild, TARGET, { id: OWNER, username: 'owner' });
    assert.deepEqual(roles.map((r) => r.id), [HELPER_ROLE]);
    assert.equal(released.length, 1);
    // Control: a raid quarantine is not a staff guard one: /staff restore has nothing.
    records.set(MOD, { roleId: Q_ROLE, roles: [MEMBER_ROLE], trigger: 'raid' });
    addMember(guild, MOD, [Q_ROLE]);
    assert.equal(await staffGuard.restoreStaffRoles(guild, MOD, { id: OWNER, username: 'owner' }), null);
    assert.equal(released.length, 1);
});

test('dashboard: the quarantine role warning when it has permissions (control: a role without any)', async () => {
    const { quarantineRoleHasPermissions } = await import('../src/services/dashboard/modules/enforcement.js');
    const guild = makeWorld();
    assert.equal(quarantineRoleHasPermissions(guild, HELPER_ROLE), true);
    assert.equal(quarantineRoleHasPermissions(guild, Q_ROLE), false);
    assert.equal(quarantineRoleHasPermissions(guild, null), false);
});

// ── the info channel ──────────────────────────────────────────────────────

const INFO = '700000000000000005';

test('info channel: read-only allow there, View Channel denied everywhere else; a moved setting is fixed on the next run', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const info = channel(INFO);
    guild.channels.cache.set(INFO, info);
    const settings = { quarantineRoleId: Q_ROLE, quarantineInfoChannelId: INFO };
    fakeDeps({ settings });
    const qRole = guild.roles.cache.get(Q_ROLE);
    await q.ensureQuarantineOverwrites(guild, qRole);
    const there = info.permissionOverwrites.cache.get(Q_ROLE);
    for (const name of q.INFO_ALLOW_NAMES) assert.ok(there.allow.has(PermissionFlagsBits[name]), `allow ${name}`);
    for (const name of q.INFO_DENY_NAMES) assert.ok(there.deny.has(PermissionFlagsBits[name]), `deny ${name}`);
    assert.ok(!there.deny.has(PermissionFlagsBits.ViewChannel), 'never hidden there');
    const other = guild.channels.cache.get('700000000000000002').permissionOverwrites.cache.get(Q_ROLE);
    assert.ok(other.deny.has(PermissionFlagsBits.ViewChannel));
    // A new channel never gets the deny when it is the info channel.
    const fresh = channel(INFO);
    fresh.guild = guild;
    await q.applyQuarantineOverwriteToChannel(fresh);
    assert.ok(fresh.permissionOverwrites.cache.get(Q_ROLE).allow.has(PermissionFlagsBits.ViewChannel));
    // The setting moves to another channel: the old info channel is hidden again, the new one opened.
    settings.quarantineInfoChannelId = '700000000000000002';
    await q.ensureQuarantineOverwrites(guild, qRole);
    assert.ok(info.permissionOverwrites.cache.get(Q_ROLE).deny.has(PermissionFlagsBits.ViewChannel), 'old info channel hidden');
    assert.ok(guild.channels.cache.get('700000000000000002').permissionOverwrites.cache.get(Q_ROLE).allow.has(PermissionFlagsBits.ViewChannel), 'new info channel readable');
});

test('info channel unset: every channel stays hidden, and there is nothing to post (control for the test above)', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const info = channel(INFO);
    guild.channels.cache.set(INFO, info);
    fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    await q.ensureQuarantineOverwrites(guild, guild.roles.cache.get(Q_ROLE));
    const there = info.permissionOverwrites.cache.get(Q_ROLE);
    assert.ok(there.deny.has(PermissionFlagsBits.ViewChannel));
    assert.ok(!there.allow.has(PermissionFlagsBits.ViewChannel));
    await assert.rejects(q.postQuarantineInfo(guild), (error) => error.code === 'noChannel');
    assert.equal(info.posted.size, 0);
});

test('info message: posted as an embed with no mentions; posting again replaces it; Refresh edits it in place', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const info = channel(INFO);
    const sent = [];
    const send = info.send.bind(info);
    info.send = async (payload) => { sent.push(payload); return send(payload); };
    guild.channels.cache.set(INFO, info);
    const { store } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE, quarantineInfoChannelId: INFO } });
    const first = await q.postQuarantineInfo(guild);
    assert.equal(first.replaced, false);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    const embed = sent[0].embeds[0].toJSON();
    assert.equal(embed.title, 'You are in quarantine');
    assert.match(embed.description, /Your access to \*\*Test <Server>\*\* is paused/);
    assert.match(embed.description, /join our support server https:\/\/discord\.gg\/ours/);
    assert.deepEqual(store.get(q.infoPostKey(G)).messageId, first.message.id);
    assert.ok(info.permissionOverwrites.cache.get(Q_ROLE).allow.has(PermissionFlagsBits.ViewChannel), 'posting also fixes the overwrites');
    const second = await q.postQuarantineInfo(guild);
    assert.equal(second.replaced, true);
    assert.equal(info.posted.size, 1, 'the old message is gone');
    assert.equal(store.get(q.infoPostKey(G)).messageId, second.message.id);
    assert.equal(await q.refreshQuarantineInfo(guild.client, guild), 1);
    assert.equal(info.posted.get(second.message.id).edited, true);
});

test('info message text: no support invite drops the support line; other languages translate it', () => {
    const without = q.quarantineInfoPayload({ serverName: 'Cats', invite: null }, { lang: 'en' }).embeds[0].toJSON().description;
    assert.ok(!/support server/.test(without));
    assert.match(without, /Please don't create new accounts/);
    const de = q.quarantineInfoPayload({ serverName: 'Cats', invite: 'https://discord.gg/x' }, { lang: 'de' }).embeds[0].toJSON();
    assert.equal(de.title, 'Du bist unter Quarantäne');
    assert.match(de.description, /https:\/\/discord\.gg\/x/);
});

// ── review fixes ──────────────────────────────────────────────────────────

test('release: a Discord hiccup on the member fetch keeps the record (only Unknown Member counts as "left")', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const { store } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    store.set(q.quarantineKey(G, TARGET), { roleId: Q_ROLE, roles: [MEMBER_ROLE], reason: 'x', trigger: 'raid' });
    guild.members.fetch = async () => { throw Object.assign(new Error('Service Unavailable'), { code: 0, status: 503 }); };
    await assert.rejects(q.releaseQuarantine(guild, TARGET, { by: { id: MOD, username: 'mod' } }), /Service Unavailable/);
    assert.ok(store.has(q.quarantineKey(G, TARGET)), 'the saved roles are not lost');
    guild.members.fetch = async () => { throw Object.assign(new Error('Unknown Member'), { code: 10007 }); };
    const left = await q.releaseQuarantine(guild, TARGET, { by: { id: MOD, username: 'mod' } });
    assert.equal(left.left, true);
    assert.equal(store.size, 0);
});

test('release: roles back but the record delete fails → a partial error (the caller says "press Release again")', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    addMember(guild, TARGET, [Q_ROLE]);
    const { store } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    store.set(q.quarantineKey(G, TARGET), { roleId: Q_ROLE, roles: [MEMBER_ROLE], reason: 'x', trigger: 'raid' });
    q.setQuarantineDepsForTest({
        getFromDb: async (key) => store.get(key) || null,
        deleteFromDb: async () => { throw new Error('db down'); },
        resolveSetting: (gid, key) => (key === 'quarantineRoleId' ? Q_ROLE : null),
        postModLog: async () => true,
    });
    await assert.rejects(q.releaseQuarantine(guild, TARGET, { by: { id: MOD, username: 'mod' } }), (error) => error.partial === true);
});

test('a quarantine role with permissions of its own is never used (control: an empty role is ready)', () => {
    const guild = makeWorld();
    assert.equal(q.quarantineRoleProblem(guild, guild.roles.cache.get(HELPER_ROLE)), 'roleHasPermissions');
    assert.equal(q.quarantineRoleProblem(guild, guild.roles.cache.get(Q_ROLE)), null);
});

// ── deciders (owner, 2026-11-13: only the owner or co-owner decide) ──────

const { handleQuarantineDecision, handleQuarantineBanModal } = await import('../src/handlers/quarantineRelease.js');
const DECIDER_ROLE = HEAD_A;

function clickFrom(guild, member, { message = null } = {}) {
    const out = { deferred: false, edits: [], replies: [], modals: [] };
    const interaction = {
        id: 'i1', guildId: guild.id, guild, createdTimestamp: Date.now(), user: member.user, member, client: guild.client, message,
        get deferred() { return out.deferred; }, replied: false,
        deferReply: async () => { out.deferred = true; },
        editReply: async (o) => { out.edits.push(o); },
        reply: async (o) => { out.replies.push(o); },
        showModal: async (m) => { out.modals.push(m); },
        isRepliable: () => true,
        fields: { getTextInputValue: () => 'raid bot' },
    };
    return { interaction, out };
}

test('deciders: the server owner, OWNER_IDS here and decider-role holders; a plain Administrator is not (control)', () => {
    const guild = makeWorld();
    fakeDeps({ settings: { quarantineDeciderRoleIds: [DECIDER_ROLE] } });
    const admin = addMember(guild, MOD, [HELPER_ROLE]);
    const coOwner = addMember(guild, '300000000000000020', [DECIDER_ROLE]);
    assert.equal(q.isQuarantineDecider({ guild, userId: OWNER }), 'owner');
    assert.equal(q.isQuarantineDecider({ guild, userId: '300000000000000099' }), 'owner', 'OWNER_IDS with owner power');
    assert.equal(q.isQuarantineDecider({ guild, userId: coOwner.id, staffMember: coOwner }), 'role');
    assert.equal(q.isQuarantineDecider({ guild, userId: admin.id, staffMember: admin }), null, 'Administrator alone decides nothing');
});

test('alert buttons: a non-decider Administrator is refused (ephemeral, nothing changed); a decider releases', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const { store } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE, quarantineDeciderRoleIds: [DECIDER_ROLE] } });
    addMember(guild, TARGET, [Q_ROLE]);
    store.set(q.quarantineKey(G, TARGET), { roleId: Q_ROLE, roles: [MEMBER_ROLE], reason: 'x', trigger: 'raid' });
    const admin = addMember(guild, MOD, [HELPER_ROLE]);
    const { interaction, out } = clickFrom(guild, admin);
    await handleQuarantineDecision(interaction, guild.client, ['release', G, TARGET]);
    assert.equal(out.deferred, true, 'acknowledged at once');
    assert.match(out.edits.at(-1).content, /Only the server owner/);
    assert.ok(store.has(q.quarantineKey(G, TARGET)), 'still quarantined');
    // Ban opens no form for a non-decider either.
    const ban = clickFrom(guild, admin);
    await handleQuarantineDecision(ban.interaction, guild.client, ['ban', G, TARGET]);
    assert.equal(ban.out.modals.length, 0);
    // A decider role without Administrator: refused too.
    const noAdmin = clickFrom(guild, addMember(guild, '300000000000000021', [DECIDER_ROLE]));
    await handleQuarantineDecision(noAdmin.interaction, guild.client, ['release', G, TARGET]);
    assert.match(noAdmin.out.edits.at(-1).content, /needs Administrator/);
    assert.ok(store.has(q.quarantineKey(G, TARGET)));
    const decider = addMember(guild, '300000000000000020', [DECIDER_ROLE], { admin: true });
    const ok = clickFrom(guild, decider);
    await handleQuarantineDecision(ok.interaction, guild.client, ['release', G, TARGET]);
    assert.match(ok.out.edits.at(-1).content, /was released/);
    assert.equal(store.size, 0);
});

test('alert buttons: Kick asks to confirm first, then kicks through executeAction; Ban opens a reason form, its submit bans', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const { store, log } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE, quarantineDeciderRoleIds: [DECIDER_ROLE] } });
    addMember(guild, TARGET, [Q_ROLE]);
    const decider = addMember(guild, '300000000000000020', [DECIDER_ROLE], { admin: true });
    store.set(q.quarantineKey(G, TARGET), { roleId: Q_ROLE, roles: [MEMBER_ROLE], reason: 'raid spam', trigger: 'raid' });
    const ask = clickFrom(guild, decider);
    await handleQuarantineDecision(ask.interaction, guild.client, ['kick', G, TARGET]);
    assert.equal((log.actions || []).length, 0, 'nothing before the confirm');
    assert.equal(ask.out.edits.at(-1).components[0].toJSON().components[0].custom_id, `qdecide:kickok:${G}:${TARGET}`);
    const confirm = clickFrom(guild, decider);
    await handleQuarantineDecision(confirm.interaction, guild.client, ['kickok', G, TARGET]);
    assert.equal(log.actions.length, 1);
    assert.equal(log.actions[0].flow.type, 'kick');
    assert.equal(log.actions[0].flow.reason, 'raid spam', 'kick reason: the quarantine reason');
    assert.equal(log.actions[0].moderator.id, decider.id, 'as the decider');
    assert.equal(store.size, 0, 'record gone after the kick');

    store.set(q.quarantineKey(G, TARGET), { roleId: Q_ROLE, roles: [MEMBER_ROLE], reason: 'raid spam', trigger: 'raid' });
    const ban = clickFrom(guild, decider);
    await handleQuarantineDecision(ban.interaction, guild.client, ['ban', G, TARGET]);
    assert.equal(ban.out.modals.length, 1, 'the reason form');
    assert.equal(ban.out.modals[0].toJSON().custom_id, `qban:${G}:${TARGET}`);
    const submit = clickFrom(guild, decider);
    await handleQuarantineBanModal(submit.interaction, guild.client, [G, TARGET]);
    assert.equal(log.actions.at(-1).flow.type, 'ban');
    assert.equal(log.actions.at(-1).flow.reason, 'raid bot');
    assert.equal(log.actions.at(-1).flow.durationMs, null);
    assert.match(submit.out.edits.at(-1).content, /was banned \(case abc2345\)/);
    assert.equal(store.size, 0);
});

test('Keep in quarantine only records the review (record stays, buttons stay on)', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const { store, log } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    store.set(q.quarantineKey(G, TARGET), { roleId: Q_ROLE, roles: [MEMBER_ROLE], reason: 'x', trigger: 'automod' });
    const result = await q.decideQuarantine(guild, TARGET, { decision: 'keep', by: { id: OWNER, username: 'owner' } });
    assert.equal(result.ok, true);
    assert.equal(store.get(q.quarantineKey(G, TARGET)).reviews.length, 1);
    assert.equal((log.actions || []).length, 0);
    assert.equal(log.modLog.at(-1).title, 'Quarantine reviewed');
});

test('automod: a ban-level step quarantines when a quarantine role is set, bans when not (control); a warn-level step is unchanged', async () => {
    const calls = [];
    const rec = (name, value) => async (...args) => { calls.push({ name, args }); return typeof value === 'function' ? value(...args) : value; };
    let ready = true;
    setAutomodDepsForTest({
        countOffences: rec('countOffences', 0), applyStep: rec('applyStep', { record: { case_code: 'abc2345' } }), postReviewCard: rec('postReviewCard', null),
        noteRepeatHit: rec('noteRepeatHit', null), deleteQuietly: rec('deleteQuietly', null), isRaidJoiner: rec('isRaidJoiner', false),
        giveSecondChance: rec('giveSecondChance', false), giveHeadsUp: rec('giveHeadsUp', false), noteIncidentEvent: rec('noteIncidentEvent', 'stored'),
        quarantineReady: () => ready, quarantineMember: rec('quarantineMember', { ok: true, removed: [], kept: [] }),
    });
    const member = { id: TARGET, joinedTimestamp: Date.now() - 30 * 86_400_000, permissions: { has: () => false } };
    // scam: its only step is a ban.
    resetAutomodState();
    await actOn(raidMessage(), member, { rule: 'scam', mode: 'on' }, normalizeSettings({}));
    assert.equal(calls.find((c) => c.name === 'quarantineMember').args[2].trigger, 'automod');
    assert.equal(calls.filter((c) => c.name === 'applyStep').length, 0, 'no ban');
    // Control: no quarantine role → the ban.
    calls.length = 0;
    ready = false;
    resetAutomodState();
    await actOn(raidMessage(), member, { rule: 'scam', mode: 'on' }, normalizeSettings({}));
    assert.equal(calls.filter((c) => c.name === 'quarantineMember').length, 0);
    assert.equal(calls.find((c) => c.name === 'applyStep').args[0].step.type, 'ban');
    // A warn-level hit (spam, first offence) stays a warn, quarantine role or not.
    calls.length = 0;
    ready = true;
    resetAutomodState();
    await actOn(raidMessage(), member, { rule: 'spam', mode: 'on' }, normalizeSettings({}));
    assert.equal(calls.filter((c) => c.name === 'quarantineMember').length, 0);
    assert.equal(calls.find((c) => c.name === 'applyStep').args[0].step.type, 'warn');
});

// ── join check fails closed (security review) ────────────────────────────

test('join: the quarantine read fails or the database is down → "unknown" (no join roles; staff alerted where quarantine is in use); control: no record → "clear"', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    const member = addMember(guild, TARGET, []);
    const { log } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    assert.equal(await q.checkQuarantineOnJoin(member), 'clear', 'control: read fine, no record');
    assert.equal(log.alerts.length, 0);
    q.setQuarantineDepsForTest({
        dbAvailable: () => true, getFromDb: async () => { throw new Error('db down'); },
        resolveSetting: (gid, key) => (key === 'quarantineRoleId' ? Q_ROLE : null),
        postAlert: async (client, kind, o) => { log.alerts.push(o); return null; },
    });
    assert.equal(await q.checkQuarantineOnJoin(member), 'unknown');
    assert.equal(log.alerts.length, 1);
    assert.match(log.alerts[0].description, /no roles/);
    q.setQuarantineDepsForTest({ dbAvailable: () => false, resolveSetting: () => null, postAlert: async (c, k, o) => { log.alerts.push(o); } });
    assert.equal(await q.checkQuarantineOnJoin(member), 'unknown', 'database down');
    assert.equal(log.alerts.length, 1, 'no quarantine role here: no alert, but still no roles');
    assert.equal(guild.calls.length, 0, 'no role given by the check');
    // The join pipeline: every role-giving step waits on `quarantined`, which is true unless the check said "clear".
    const src = readFileSync(new URL('../src/events/guildMemberAdd.js', import.meta.url), 'utf8');
    assert.ok(src.includes("(await checkQuarantineOnJoin(member)) !== 'clear'"));
    for (const gate of ['if (!quarantined && welcomeConfig?.roleIds', 'if (!quarantined && (config?.verification', 'if (!user.bot && !quarantined)', 'if (!quarantined) void mirrorRolesOnJoin']) {
        assert.ok(src.includes(gate), gate);
    }
});

test('decisions run one at a time per member: a Keep racing a Ban never writes the record back (control: Keep alone keeps it)', async () => {
    setSettingsCacheForTests(G, {});
    const guild = makeWorld();
    addMember(guild, TARGET, [Q_ROLE]);
    const moderator = addMember(guild, '300000000000000020', [DECIDER_ROLE], { admin: true });
    const { store } = fakeDeps({ settings: { quarantineRoleId: Q_ROLE } });
    store.set(q.quarantineKey(G, TARGET), { roleId: Q_ROLE, roles: [MEMBER_ROLE], reason: 'x', trigger: 'raid' });
    const [ban, keep] = await Promise.all([
        q.decideQuarantine(guild, TARGET, { decision: 'ban', by: { id: moderator.id, username: 'co' }, moderator, reason: 'r' }),
        q.decideQuarantine(guild, TARGET, { decision: 'keep', by: { id: moderator.id, username: 'co' } }),
    ]);
    assert.equal(ban.ok, true);
    assert.deepEqual(keep, { ok: false, code: 'none' });
    assert.equal(store.size, 0, 'the ban removed the record and nothing brought it back');
});
