// Invite tracking (docs/features-v14.md section 2): the attribution rule, the per-server batch and
// its serialization, the cache events, the fake / total maths, milestone roles, the startup warm-up
// pacing, welcome placeholders, log lines, /invites and its reset button, access keys, the 8
// catalogs. No database (tests/db/inviteTracking.test.js has the SQL), no Discord.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const G = '100000000000000881';
const A = '200000000000000881'; // inviter
const B = '200000000000000882'; // other inviter
const U = '300000000000000881'; // joiner
const U2 = '300000000000000882';
Object.assign(process.env, { MAIN_GUILD_ID: process.env.MAIN_GUILD_ID || MAIN, SUPPORT_GUILD_ID: process.env.SUPPORT_GUILD_ID || SUPPORT });

const tracker = await import('../src/services/invites/inviteTracker.js');
const cache = await import('../src/services/invites/inviteCache.js');
const stats = await import('../src/services/invites/inviteStats.js');
const roles = await import('../src/services/invites/inviteRoles.js');
const expected = await import('../src/services/invites/expectedAdds.js');
const { inviteTokens, formatWelcomeMessage } = await import('../src/utils/welcome.js');
const { EVERYONE_COMMANDS } = await import('../src/config/commands/commandAccess.js');
const { dashboardPageFor } = await import('../src/config/commands/retirement.js');
const { buildIntents } = await import('../src/config/intents.js');
const { GatewayIntentBits } = await import('discord.js');
const invitesCommand = (await import('../src/commands/Community/invites.js')).default;
const commandModule = await import('../src/commands/Community/invites.js');
const { handleInviteResetButton } = await import('../src/interactions/buttons/invites/inviteReset.js');
const { validateSetting, getSettingEntry, neutralValue } = await import('../src/services/settings/settingsRegistry.js');
const { botText } = await import('../src/utils/botText.js');

const entry = (uses, { inviterId = A, maxUses = 0, expiresAt = null, deletedAt } = {}) => ({ uses, inviterId, maxUses, expiresAt, ...(deletedAt ? { deletedAt } : {}) });
const codes = (obj) => new Map(Object.entries(obj));
const SETTINGS = { enabled: true, fakeAccountDays: 7, fakeLeaveHours: 24, milestones: [], stackRoles: true, resetAt: null };

beforeEach(() => {
    cache.resetInviteCacheForTests();
    tracker.resetInviteTrackerForTests();
    expected.resetExpectedAddsForTests();
    stats.resetInviteStatsCacheForTests();
});

// ── the attribution rule (pure) ───────────────────────────────────────────

test('diff: one code went up → that code and its creator', () => {
    const r = tracker.diffInvites(codes({ abc: entry(3), xyz: entry(1, { inviterId: B }) }), codes({ abc: entry(4), xyz: entry(1, { inviterId: B }) }));
    assert.deepEqual(r, { source: 'invite', code: 'abc', inviterId: A });
});

test('diff: a code missing from the cache (no inviteCreate seen) that has uses counts as went up', () => {
    const r = tracker.diffInvites(codes({}), codes({ fresh: entry(1, { inviterId: B }) }));
    assert.deepEqual(r, { source: 'invite', code: 'fresh', inviterId: B });
});

test('diff: two codes went up (or a code and the vanity URL) → ambiguous, nothing guessed', () => {
    const r = tracker.diffInvites(codes({ a: entry(1), b: entry(1, { inviterId: B }) }), codes({ a: entry(2), b: entry(2, { inviterId: B }) }));
    assert.deepEqual(r, { source: 'ambiguous', code: null, inviterId: null });
    const v = tracker.diffInvites(codes({ a: entry(1) }), codes({ a: entry(2) }), { before: { code: 'cats', uses: 5 }, after: { code: 'cats', uses: 6 } });
    assert.equal(v.source, 'ambiguous');
});

test('diff: vanity URL went up → vanity with its code; a changed vanity code is a new baseline', () => {
    const r = tracker.diffInvites(codes({ a: entry(1) }), codes({ a: entry(1) }), { before: { code: 'cats', uses: 5 }, after: { code: 'cats', uses: 6 } });
    assert.deepEqual(r, { source: 'vanity', code: 'cats', inviterId: null });
    const changed = tracker.diffInvites(codes({}), codes({}), { before: { code: 'old', uses: 5 }, after: { code: 'new', uses: 9 } });
    assert.equal(changed.source, 'unknown');
});

test('diff: a used-up invite (vanished at max-1 uses, even already marked deleted) → that code', () => {
    const now = 1_000_000;
    const before = codes({ once: entry(0, { maxUses: 1 }), other: entry(2, { inviterId: B }) });
    assert.deepEqual(tracker.diffInvites(before, codes({ other: entry(2, { inviterId: B }) }), {}, { now }), { source: 'invite', code: 'once', inviterId: A });
    // inviteDelete came first: still in the cache, marked deleted a moment ago.
    const deleted = codes({ once: entry(4, { maxUses: 5, deletedAt: now - 500 }) });
    assert.equal(tracker.diffInvites(deleted, codes({}), {}, { now }).code, 'once');
    // Deleted long ago (staff), expired, or not at max-1: not a used-up invite.
    assert.equal(tracker.diffInvites(codes({ once: entry(0, { maxUses: 1, deletedAt: now - 60_000 }) }), codes({}), {}, { now }).source, 'unknown');
    assert.equal(tracker.diffInvites(codes({ once: entry(0, { maxUses: 1, expiresAt: now - 1 }) }), codes({}), {}, { now }).source, 'unknown');
    assert.equal(tracker.diffInvites(codes({ big: entry(3, { maxUses: 10 }) }), codes({}), {}, { now }).source, 'unknown');
    // Two used-up candidates → ambiguous.
    assert.equal(tracker.diffInvites(codes({ a: entry(0, { maxUses: 1 }), b: entry(0, { maxUses: 1 }) }), codes({}), {}, { now }).source, 'ambiguous');
});

test('diff: nothing changed → discovery (DISCOVERABLE), else widget (widget on), else unknown', () => {
    const same = codes({ a: entry(1) });
    assert.equal(tracker.diffInvites(same, codes({ a: entry(1) }), {}, { discoverable: true }).source, 'discovery');
    assert.equal(tracker.diffInvites(same, codes({ a: entry(1) }), {}, { widgetEnabled: true }).source, 'widget');
    assert.equal(tracker.diffInvites(same, codes({ a: entry(1) }), {}, {}).source, 'unknown');
    // A creator-less invite that went up while the widget is on: the widget's invite.
    assert.deepEqual(tracker.diffInvites(codes({ w: entry(0, { inviterId: null }) }), codes({ w: entry(1, { inviterId: null }) }), {}, { widgetEnabled: true }),
        { source: 'widget', code: 'w', inviterId: null });
});

// ── batch, consume +1, serialization ──────────────────────────────────────

function fakeGuild(id = G, { manage = true } = {}) {
    return {
        id, features: [], widgetEnabled: false,
        members: { me: { permissions: { has: (bit) => manage && (bit === PermissionFlagsBits.ManageGuild || bit === PermissionFlagsBits.ManageRoles) } }, fetch: async () => null },
    };
}
const ready = (guildId, map, vanity = null) => cache.setInviteState(guildId, { status: 'ready', codes: map, vanity, loadedAt: 0 });

test('batch: the same code used twice in one window → both joins get it, one fetch', async () => {
    const guild = fakeGuild();
    ready(G, codes({ abc: entry(3) }));
    let fetches = 0;
    const fetch = async () => { fetches += 1; return { codes: codes({ abc: entry(5) }), vanity: null }; };
    const out = await tracker.attributeBatch(guild, [{ id: U }, { id: U2 }], { fetch, now: () => 1 });
    assert.equal(fetches, 1);
    assert.deepEqual(out.map((r) => r.code), ['abc', 'abc']);
    assert.equal(cache.getInviteState(G).codes.get('abc').uses, 5);
});

test('batch: one join, the code went up by 2 → +1 consumed, the other use waits (pending) for a later join', async () => {
    const guild = fakeGuild();
    ready(G, codes({ abc: entry(3) }));
    const fetch = async () => ({ codes: codes({ abc: entry(5) }), vanity: null });
    const [first] = await tracker.attributeBatch(guild, [{ id: U }], { fetch, now: () => 1000 });
    assert.equal(first.code, 'abc');
    assert.equal(cache.getInviteState(G).codes.get('abc').uses, 4, 'only one use consumed');
    const [second] = await tracker.attributeBatch(guild, [{ id: U2 }], { fetch, now: () => 2000 });
    assert.equal(second.code, 'abc', 'the late join still finds its use');
    // A pending use nobody claims is dropped after PENDING_MS.
    ready(G, codes({ abc: entry(3) }));
    await tracker.attributeBatch(guild, [{ id: U }], { fetch, now: () => 0 });
    const [late] = await tracker.attributeBatch(guild, [{ id: U2 }], { fetch, now: () => tracker.PENDING_MS + 1 });
    assert.equal(late.source, 'unknown');
});

test('batch: cache not loaded → not_ready; Manage Server gone (50013) → no_permission and the cache says so', async () => {
    const guild = fakeGuild();
    assert.deepEqual((await tracker.attributeBatch(guild, [{ id: U }], { fetch: async () => assert.fail('no fetch') })).map((r) => r.source), ['not_ready']);
    ready(G, codes({}));
    const out = await tracker.attributeBatch(guild, [{ id: U }], { fetch: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } });
    assert.equal(out[0].source, 'no_permission');
    assert.equal(cache.getInviteState(G).status, 'no_permission');
    ready(G, codes({}));
    const other = await tracker.attributeBatch(guild, [{ id: U }], { fetch: async () => { throw new Error('socket hang up'); } });
    assert.equal(other[0].source, 'unknown');
});

test('queueJoin: two joins at the same time share ONE fetch; batches of one server never overlap', async () => {
    const guild = fakeGuild();
    ready(G, codes({ a: entry(0), b: entry(0, { inviterId: B }) }));
    let fetches = 0;
    let running = 0;
    let overlap = false;
    const after = [codes({ a: entry(1), b: entry(0, { inviterId: B }) }), codes({ a: entry(1), b: entry(1, { inviterId: B }) })];
    const fetch = async () => {
        running += 1;
        if (running > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
        return { codes: after[Math.min(fetches++, 1)], vanity: null };
    };
    const deps = { fetch, windowMs: 5 };
    const [r1, r2] = await Promise.all([tracker.queueJoin({ id: U, guild }, deps), tracker.queueJoin({ id: U2, guild }, deps)]);
    assert.equal(fetches, 1, 'one fetch for the burst');
    // Both joins in one batch, only code a went up once: the first gets it, the second finds nothing.
    assert.equal(r1.code, 'a');
    assert.equal(r2.source, 'unknown');
    // Two more batches started at once run one after the other (Mutex per server).
    const [r3, r4] = await Promise.all([
        tracker.queueJoin({ id: U, guild }, { fetch, windowMs: 1 }),
        new Promise((resolve) => setTimeout(() => resolve(tracker.queueJoin({ id: U2, guild }, { fetch, windowMs: 1 })), 3)),
    ]);
    assert.equal(overlap, false, 'never two fetches of one server at once');
    assert.ok(r3 && r4);
});

test('attributeJoin: off → null; bot → null; OAuth re-add marker → bot (no fetch); no Manage Server → no_permission; not loaded → not_ready + warm', async () => {
    const guild = fakeGuild();
    const member = (id, extra = {}) => ({ id, guild, joinedTimestamp: Date.now(), user: { id, bot: false, createdTimestamp: Date.now() - 30 * 86_400_000, username: 'x' }, ...extra });
    const base = { dbAvailable: () => false, attribute: async () => assert.fail('no batch') };
    assert.equal(await tracker.attributeJoin(member(U), { ...base, settings: { ...SETTINGS, enabled: false } }), null);
    assert.equal(await tracker.attributeJoin({ ...member(U), user: { id: U, bot: true } }, { ...base, settings: SETTINGS }), null);
    expected.expectBotAdd(G, U);
    assert.equal((await tracker.attributeJoin(member(U), { ...base, settings: SETTINGS })).source, 'bot');
    const noPerm = await tracker.attributeJoin({ ...member(U2), guild: fakeGuild(G, { manage: false }) }, { ...base, settings: SETTINGS });
    assert.equal(noPerm.source, 'no_permission');
    cache.resetInviteCacheForTests();
    let warmed = 0;
    const notReady = await tracker.attributeJoin(member(U2), { ...base, settings: SETTINGS, warm: async () => { warmed += 1; return 'ready'; } });
    assert.equal(notReady.source, 'not_ready');
    await tracker.attributeJoin(member(U), { ...base, settings: SETTINGS, warm: async () => { warmed += 1; return 'ready'; } });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(warmed, 1, 'loaded once, not once per join');
});

test('attributeJoin: records the row, reads the inviter total for {inviter.invites}, account age and the fake mark', async () => {
    const guild = fakeGuild();
    ready(G, codes({}));
    const inserted = [];
    const out = await tracker.attributeJoin({
        id: U, guild, joinedTimestamp: 10 * 86_400_000, user: { id: U, bot: false, createdTimestamp: 8 * 86_400_000 },
    }, {
        settings: SETTINGS, dbAvailable: () => true, now: () => 10 * 86_400_000,
        attribute: async () => ({ source: 'invite', code: 'abc', inviterId: A }),
        insert: async (row) => { inserted.push(row); return { id: '1', counted: true }; },
        counts: async () => ({ total: 7 }),
        fetchMember: async () => ({ user: { username: 'alice' } }),
        saveCode: async () => {},
    });
    assert.equal(inserted[0].source, 'invite');
    assert.equal(inserted[0].inviterId, A);
    assert.equal(out.inviterInvites, 7);
    assert.equal(out.inviterName, 'alice');
    assert.equal(out.accountAgeDays, 2);
    assert.equal(out.fakeAccount, true, '2-day-old account < 7 days');
    // A failed insert: still an attribution for the welcome, recorded false, no count read.
    const failed = await tracker.attributeJoin({ id: U2, guild, user: { id: U2, bot: false } }, {
        settings: SETTINGS, dbAvailable: () => true, attribute: async () => ({ source: 'invite', code: 'abc', inviterId: A }),
        insert: async () => { throw new Error('db down'); }, counts: async () => assert.fail('no count after a failed insert'), fetchMember: async () => null,
    });
    assert.equal(failed.recorded, false);
    assert.equal(failed.inviterInvites, null);
});

test('awaitAttribution: unknown after the timeout; null stays null', async () => {
    assert.equal(await tracker.awaitAttribution(null), null);
    const slow = new Promise((r) => setTimeout(() => r({ source: 'invite' }), 200));
    const r = await tracker.awaitAttribution(slow, 10);
    assert.equal(r.source, 'unknown');
    assert.equal(r.timedOut, true);
    assert.equal((await tracker.awaitAttribution(Promise.resolve({ source: 'vanity' }), 50)).source, 'vanity');
});

test('noteMemberLeft: stamps (bots skipped), returns the row; a slow database never holds the leave log', async () => {
    const guild = { id: G };
    const row = { inviterId: A, code: 'abc', source: 'invite' };
    assert.deepEqual(await tracker.noteMemberLeft({ guild, user: { id: U } }, { stamp: async () => row, dbAvailable: () => true }), row);
    assert.equal(await tracker.noteMemberLeft({ guild, user: { id: U, bot: true } }, { stamp: async () => assert.fail('bot'), dbAvailable: () => true }), null);
    assert.equal(await tracker.noteMemberLeft({ guild, user: { id: U } }, { stamp: () => new Promise(() => {}), dbAvailable: () => true, timeoutMs: 10 }), null);
    assert.equal(await tracker.noteMemberLeft({ guild, user: { id: U } }, { stamp: async () => { throw new Error('down'); }, dbAvailable: () => true }), null);
});

// ── cache events and warm-up pacing ───────────────────────────────────────

test('inviteCreate adds the code at 0 uses; inviteDelete keeps it marked deleted (for a join that used it up)', async () => {
    ready(G, codes({}));
    const saved = [];
    await cache.noteInviteCreate({ guild: { id: G }, code: 'new1', uses: 0, maxUses: 1, inviterId: A }, { saveCode: async (g, c) => saved.push(c.code) });
    assert.equal(cache.getInviteState(G).codes.get('new1').uses, 0);
    assert.deepEqual(saved, ['new1']);
    await cache.noteInviteDelete({ guild: { id: G }, code: 'new1' }, { now: 5, resolve: () => ({ enabled: false }) });
    assert.equal(cache.getInviteState(G).codes.get('new1').deletedAt, 5);
    // Not loaded: nothing happens.
    cache.resetInviteCacheForTests();
    assert.equal(await cache.noteInviteCreate({ guild: { id: G }, code: 'x' }), false);
});

test('warmGuild: no Manage Server → no_permission (no fetch); Discord refuses → no_permission; ready otherwise', async () => {
    assert.equal(await cache.warmGuild(fakeGuild(G, { manage: false }), { fetch: async () => assert.fail('no fetch') }), 'no_permission');
    assert.equal(cache.getInviteState(G).status, 'no_permission');
    assert.equal(await cache.warmGuild(fakeGuild(), { fetch: async () => { throw Object.assign(new Error('x'), { code: 50013 }); } }), 'no_permission');
    const saved = [];
    assert.equal(await cache.warmGuild(fakeGuild(), { fetch: async () => ({ codes: codes({ a: entry(1) }), vanity: null }), saveCodes: async (g, list) => saved.push(list) }), 'ready');
    assert.equal(saved[0][0].code, 'a');
    // A failed save of the stored copy never breaks the cache.
    assert.equal(await cache.warmGuild(fakeGuild(), { fetch: async () => ({ codes: codes({}), vanity: null }), saveCodes: async () => { throw new Error('db down'); } }), 'ready');
});

test('warm-up: only servers with the feature on, 250 ms between starts, at most 3 at once', async () => {
    const guilds = new Map(Array.from({ length: 8 }, (_, i) => [`10000000000000090${i}`, { id: `10000000000000090${i}` }]));
    const on = new Set([...guilds.keys()].filter((_, i) => i !== 2));
    const pauses = [];
    let running = 0;
    let peak = 0;
    const warmed = [];
    const totals = await cache.warmAllInviteCaches({ guilds: { cache: guilds } }, {
        isOn: (id) => on.has(id),
        sleepFn: async (ms) => { pauses.push(ms); },
        warm: async (guild) => {
            running += 1;
            peak = Math.max(peak, running);
            warmed.push(guild.id);
            await new Promise((r) => setTimeout(r, 5));
            running -= 1;
            return guild.id.endsWith('5') ? 'no_permission' : 'ready';
        },
    });
    assert.equal(totals.servers, 7);
    assert.equal(totals.ready, 6);
    assert.equal(totals.noPermission, 1);
    assert.ok(!warmed.includes('100000000000000902'), 'feature off: never loaded');
    assert.deepEqual(pauses, Array(6).fill(cache.WARM_PAUSE_MS));
    assert.equal(cache.WARM_PAUSE_MS, 250);
    assert.ok(peak <= cache.WARM_CONCURRENCY && cache.WARM_CONCURRENCY === 3, `peak ${peak}`);
});

test('OAuth re-add marker: used once, expires after a minute', () => {
    expected.expectBotAdd(G, U, 0);
    assert.equal(expected.takeExpectedBotAdd(G, U, 1000), true);
    assert.equal(expected.takeExpectedBotAdd(G, U, 1000), false);
    expected.expectBotAdd(G, U, 0);
    assert.equal(expected.takeExpectedBotAdd(G, U, expected.EXPECT_MS + 1), false);
    const src = fs.readFileSync('src/services/oauthVerification.js', 'utf8');
    assert.ok(/expectBotAdd\(guildId, userId\);[\s\S]{0,400}client\.rest\.put\(Routes\.guildMember/.test(src), 'marked right before the guilds.join call');
});

// ── fake / total maths, settings ──────────────────────────────────────────

test('fake: account younger than N days at join, or left within N hours; 0 turns a rule off', () => {
    const day = 86_400_000;
    const joinedAt = 100 * day;
    assert.equal(stats.isFakeJoin({ accountCreatedAt: joinedAt - 3 * day, joinedAt }, SETTINGS), true);
    assert.equal(stats.isFakeJoin({ accountCreatedAt: joinedAt - 8 * day, joinedAt }, SETTINGS), false);
    assert.equal(stats.isFakeJoin({ accountCreatedAt: joinedAt - 30 * day, joinedAt, leftAt: joinedAt + 3_600_000 }, SETTINGS), true);
    assert.equal(stats.isFakeJoin({ accountCreatedAt: joinedAt - 30 * day, joinedAt, leftAt: joinedAt + 25 * 3_600_000 }, SETTINGS), false);
    assert.equal(stats.isFakeJoin({ accountCreatedAt: joinedAt - day, joinedAt, leftAt: joinedAt + 1 }, { fakeAccountDays: 0, fakeLeaveHours: 0 }), false);
    assert.equal(stats.isFakeJoin({ accountCreatedAt: null, joinedAt }, SETTINGS), false, 'unknown age is not fake');
    assert.equal(stats.inviteTotal({ invited: 10, left: 2, fake: 3, bonus: 4 }), 9);
    assert.equal(stats.inviteTotal({ invited: 1, left: 0, fake: 0, bonus: -5 }), -4);
});

test('setting inviteTracking: off by default everywhere, 7 days / 24 h, at most 10 unique milestones; older values normalized', () => {
    const e = getSettingEntry('inviteTracking');
    assert.equal(e.module, 'invites');
    assert.deepEqual(neutralValue(e), { enabled: false, fakeAccountDays: 7, fakeLeaveHours: 24, milestones: [], stackRoles: true, resetAt: null });
    const base = neutralValue(e);
    assert.equal(validateSetting('inviteTracking', { ...base, milestones: Array.from({ length: 11 }, (_, i) => ({ count: i + 1, roleId: `6000000000000000${10 + i}` })) }).ok, false);
    assert.equal(validateSetting('inviteTracking', { ...base, milestones: [{ count: 5, roleId: A }, { count: 5, roleId: B }] }).ok, false);
    assert.equal(validateSetting('inviteTracking', { ...base, milestones: [{ count: 5, roleId: A }, { count: 6, roleId: A }] }).ok, false);
    assert.equal(validateSetting('inviteTracking', { ...base, fakeAccountDays: 366 }).ok, false);
    assert.equal(validateSetting('inviteTracking', { ...base, enabled: true, milestones: [{ count: 5, roleId: A }] }).ok, true);
    assert.deepEqual(stats.normalizeInviteSettings({ enabled: true }), { ...base, enabled: true });
    assert.deepEqual(stats.normalizeInviteSettings({ milestones: [{ count: 9, roleId: B }, { count: 2, roleId: A }, { count: 'x', roleId: A }] }).milestones,
        [{ count: 2, roleId: A }, { count: 9, roleId: B }]);
    // The support server never tracks invites; a settings read failure throws (callers skip), inviteTrackingOn says false.
    assert.equal(stats.inviteSettings(process.env.SUPPORT_GUILD_ID, { resolve: () => ({ ...base, enabled: true }) }).enabled, false);
    assert.equal(stats.inviteSettings(G, { resolve: () => ({ ...base, enabled: true }) }).enabled, true);
    assert.throws(() => stats.inviteSettings(G, { resolve: () => { throw Object.assign(new Error('down'), { name: 'SettingsUnavailableError' }); } }));
    assert.equal(stats.inviteTrackingOn(G, { resolve: () => { throw new Error('down'); } }), false);
});

// ── milestone roles ───────────────────────────────────────────────────────

test('milestones: which roles a total reaches (stacked or highest only); refused roles skipped; never removed on a drop', async () => {
    const ms = [{ count: 5, roleId: 'r5' }, { count: 10, roleId: 'r10' }, { count: 25, roleId: 'r25' }];
    assert.deepEqual(roles.milestoneRolesFor(12, ms, true), ['r5', 'r10']);
    assert.deepEqual(roles.milestoneRolesFor(12, ms, false), ['r10']);
    assert.deepEqual(roles.milestoneRolesFor(4, ms, true), []);
    const roleOf = (id, extra = {}) => ({ id, name: id, position: 1, managed: false, guild: { id: G }, permissions: { has: () => false }, ...extra });
    const guild = {
        id: G,
        members: { me: { permissions: { has: (bit) => bit === PermissionFlagsBits.ManageRoles }, roles: { highest: { position: 10 } } } },
        roles: { cache: new Map([['r5', roleOf('r5')], ['r10', roleOf('r10', { permissions: { has: (p) => p === 'BanMembers' } })], ['r25', roleOf('r25')]]) },
    };
    const have = new Set();
    const member = { roles: { cache: { has: (id) => have.has(id) }, add: async (role) => { have.add(role.id); }, remove: async (role) => { have.delete(role.id); } } };
    const out = await roles.applyMilestoneRoles(guild, member, 12, { milestones: ms, stackRoles: true });
    assert.deepEqual(out.added, ['r5']);
    assert.deepEqual(out.refused, ['r10'], 'a staff-permission role is never handed out');
    const drop = await roles.applyMilestoneRoles(guild, member, 0, { milestones: ms, stackRoles: true });
    assert.deepEqual(drop.removed, []);
    assert.ok(have.has('r5'), 'kept when the count drops');
    // Not stacking: reaching 25 gives r25 and takes the lower one away.
    const top = await roles.applyMilestoneRoles(guild, member, 30, { milestones: ms, stackRoles: false });
    assert.deepEqual(top.added, ['r25']);
    assert.deepEqual(top.removed, ['r5']);
});

// ── texts: welcome, logs ──────────────────────────────────────────────────

test('welcome placeholders: {inviter} {inviter.name} {invite.code} {inviter.invites}, with the fallback words', () => {
    const t = inviteTokens({ inviterId: A, inviterName: 'al*ice_<@1>', code: 'abc-1', inviterInvites: 4 });
    assert.deepEqual(t, { '{inviter}': `<@${A}>`, '{inviter.name}': 'alice1', '{invite.code}': 'abc-1', '{inviter.invites}': '4' });
    assert.deepEqual(inviteTokens(null, { inviter: 'jemand', code: 'ein Link' }), { '{inviter}': 'jemand', '{inviter.name}': 'jemand', '{invite.code}': 'ein Link', '{inviter.invites}': '0' });
    const text = formatWelcomeMessage('Hi {user}, {inviter} ({inviter.name}) brought you with {invite.code}: {inviter.invites} now', {
        user: { toString: () => `<@${U}>` }, guild: { name: 'S' }, invite: { inviterId: A, inviterName: 'alice', code: 'abc', inviterInvites: 3 },
    });
    assert.equal(text, `Hi <@${U}>, <@${A}> (alice) brought you with abc: 3 now`);
    assert.equal(formatWelcomeMessage('{inviter}/{invite.code}', { user: {}, guild: {} }), 'someone/a link');
    for (const lang of ['ru', 'de', 'fr', 'it', 'pl', 'es', 'pt-BR']) {
        assert.notEqual(botText(lang).t('welcome.post.inviterUnknown'), 'someone', lang);
    }
});

test('join / leave log lines: "Invited by", the source otherwise, account age and the fake mark', () => {
    assert.deepEqual(tracker.joinLogLines({ source: 'invite', code: 'abc', inviterId: A, accountAgeDays: 2, fakeAccount: true, counted: true }),
        [`**Invited by:** <@${A}> (\`abc\`)`, '**Account:** 2 days old (new account: counts as fake)']);
    assert.deepEqual(tracker.joinLogLines({ source: 'vanity', code: 'cats', accountAgeDays: 1, fakeAccount: false }), ['**Joined via:** the vanity URL (`cats`)', '**Account:** 1 day old']);
    assert.match(tracker.joinLogLines({ source: 'invite', code: 'abc', inviterId: A, counted: false })[1], /not counted again/);
    assert.deepEqual(tracker.joinLogLines(null), [], 'feature off: nothing added');
    assert.deepEqual(tracker.leaveLogLines({ source: 'discovery' }), ['**Joined via:** Server Discovery']);
    assert.equal(tracker.safeCode('a`b<@1>'), 'ab1');
});

// ── /invites ──────────────────────────────────────────────────────────────

function fakeInteraction({ sub, group = null, options = {}, userId = A, admin = true } = {}) {
    const replies = [];
    return {
        replies,
        id: '900000000000000001', guildId: G, guild: fakeGuild(), user: { id: userId }, locale: 'en-US', member: null,
        memberPermissions: { has: (bit) => admin && bit === PermissionFlagsBits.Administrator },
        options: {
            getSubcommand: () => sub, getSubcommandGroup: () => group,
            getUser: (name) => options[name] || null, getInteger: (name) => options[name] ?? null,
        },
        deferred: false, replied: false,
        deferReply: async function () { this.deferred = true; },
        editReply: async function (payload) { replies.push(payload); return payload; },
        reply: async function (payload) { replies.push(payload); this.replied = true; return payload; },
        deferUpdate: async function () { this.deferred = true; },
        isRepliable: () => true,
    };
}
const descOf = (i) => i.replies.at(-1)?.embeds?.[0]?.data?.description || i.replies.at(-1)?.embeds?.[0]?.description || i.replies.at(-1)?.content || '';

test('/invites: one top-level command, every description fits Discord in 8 languages', () => {
    const json = invitesCommand.data.toJSON();
    assert.equal(json.name, 'invites');
    const subs = json.options.map((o) => o.name);
    assert.deepEqual(subs, ['view', 'leaderboard', 'who', 'list', 'bonus', 'reset', 'setup']);
    const walk = (o) => [o, ...(o.options || []).flatMap(walk)];
    for (const o of walk(json)) {
        assert.ok(o.description.length >= 1 && o.description.length <= 100, o.name);
        for (const text of Object.values(o.description_localizations || {})) assert.ok(text.length <= 100, `${o.name}: ${text}`);
        assert.equal(Object.keys(o.description_localizations || {}).length, 8, `${o.name} localized`);
    }
});

test('access: view and leaderboard for everyone; who, list, bonus, reset, setup stay Administrator; dashboard page invites', () => {
    assert.ok(EVERYONE_COMMANDS.has('invites view') && EVERYONE_COMMANDS.has('invites leaderboard'));
    for (const key of ['invites who', 'invites list', 'invites bonus add', 'invites bonus remove', 'invites reset', 'invites setup']) assert.ok(!EVERYONE_COMMANDS.has(key), key);
    assert.equal(dashboardPageFor('invites reset'), 'invites');
});

test('intents: GuildInvites is requested (not privileged)', () => {
    assert.ok(buildIntents({}).includes(GatewayIntentBits.GuildInvites));
    assert.ok(buildIntents({ ENABLE_GUILD_MEMBERS: 'false', ENABLE_MESSAGE_CONTENT: 'false' }).includes(GatewayIntentBits.GuildInvites));
});

test('/invites view: counts only, of another member too; off → the "turned off" notice; database down → nothing invented', async () => {
    const other = { id: B, bot: false };
    const view = fakeInteraction({ sub: 'view', options: { user: other }, admin: false });
    await invitesCommand.execute(view, {}, {}, { settings: () => SETTINGS, counts: async (g, id) => ({ userId: id, invited: 5, left: 1, fake: 1, bonus: 2, total: 5 }) });
    assert.match(descOf(view), new RegExp(`<@${B}> has \\*\\*5\\*\\* invites`));
    assert.deepEqual(view.replies.at(-1).allowedMentions, { parse: [] });
    const off = fakeInteraction({ sub: 'view' });
    await invitesCommand.execute(off, {}, {}, { settings: () => ({ ...SETTINGS, enabled: false }) });
    assert.match(descOf(off), /Invite tracking is off/);
    const down = fakeInteraction({ sub: 'leaderboard' });
    await invitesCommand.execute(down, {}, {}, { settings: () => SETTINGS, leaderboard: async () => { throw new Error('db'); } });
    assert.match(descOf(down), /database is not responding/);
    const unreadable = fakeInteraction({ sub: 'view' });
    await invitesCommand.execute(unreadable, {}, {}, { settings: () => { throw new Error('settings down'); } });
    assert.match(descOf(unreadable), /database is not responding/);
});

test('/invites leaderboard and bonus: lines with ranks; a bonus past the limit is refused', async () => {
    const board = fakeInteraction({ sub: 'leaderboard' });
    await invitesCommand.execute(board, {}, {}, { settings: () => SETTINGS, leaderboard: async () => [{ rank: 1, userId: A, total: 4, invited: 5, left: 1, fake: 0 }] });
    assert.match(descOf(board), /\*\*1\.\*\* <@200000000000000881>: \*\*4\*\*/);
    const bonus = fakeInteraction({ sub: 'add', group: 'bonus', options: { user: { id: B, bot: false }, amount: 3 } });
    const calls = [];
    await invitesCommand.execute(bonus, {}, {}, { settings: () => SETTINGS, bonus: async (...a) => { calls.push(a); return 3; }, counts: async () => ({ total: 3 }) });
    assert.equal(calls[0][2], 3);
    assert.match(descOf(bonus), /Bonus of <@200000000000000882> is now 3/);
    const tooMuch = fakeInteraction({ sub: 'remove', group: 'bonus', options: { user: { id: B, bot: false }, amount: 5 } });
    await invitesCommand.execute(tooMuch, {}, {}, { settings: () => SETTINGS, bonus: async () => { throw Object.assign(new RangeError('x'), { code: 'bonusRange' }); } });
    assert.match(descOf(tooMuch), /±100,000/);
});

test('/invites reset: asks first (buttons carry invoker and target); the button re-checks the clicker and Administrator', async () => {
    const ask = fakeInteraction({ sub: 'reset', options: { user: { id: B } } });
    await invitesCommand.execute(ask, {}, {}, { settings: () => SETTINGS });
    const ids = ask.replies.at(-1).components[0].toJSON().components.map((c) => c.custom_id);
    assert.deepEqual(ids, [`invreset:confirm:${A}:${B}`, `invreset:cancel:${A}:${B}`]);
    // Someone else clicks: refused, nothing changed.
    const stranger = fakeInteraction({ userId: B });
    await handleInviteResetButton(stranger, {}, ['confirm', A, B], { resetUser: async () => assert.fail('no reset') });
    assert.match(stranger.replies.at(-1).content, /belong to the admin/);
    // The invoker lost Administrator since: refused after the ack.
    const demoted = fakeInteraction({ userId: A, admin: false });
    await handleInviteResetButton(demoted, {}, ['confirm', A, B], { resetUser: async () => assert.fail('no reset'), isAdmin: () => false });
    assert.match(descOf(demoted), /Administrator permission/);
    const ok = fakeInteraction({ userId: A });
    const done = [];
    await handleInviteResetButton(ok, {}, ['confirm', A, B], { resetUser: async (g, id) => done.push(id), isAdmin: () => true });
    assert.deepEqual(done, [B]);
    assert.match(descOf(ok), /starts again from now/);
    const all = fakeInteraction({ userId: A });
    const allDone = [];
    await handleInviteResetButton(all, {}, ['confirm', A, 'all'], { resetAll: async (g) => allDone.push(g), isAdmin: () => true });
    assert.deepEqual(allDone, [G]);
    const broken = fakeInteraction({ userId: A });
    await handleInviteResetButton(broken, {}, ['confirm', A, 'all'], { resetAll: async () => { throw new Error('db'); }, isAdmin: () => true });
    assert.match(descOf(broken), /database is not responding/);
});

test('/invites setup: state, Manage Server warning, the dashboard page', () => {
    const tr = botText('en');
    const interaction = fakeInteraction({ sub: 'setup' });
    interaction.guild = fakeGuild(G, { manage: false });
    const text = commandModule.setupText(tr, interaction, { ...SETTINGS, milestones: [{ count: 1, roleId: A }] });
    assert.match(text, /\*\*on\*\*/);
    assert.match(text, /Manage Server/);
    assert.match(text, /Manage Roles/);
});

// ── catalogs ──────────────────────────────────────────────────────────────

function keysOf(obj, prefix = '') {
    return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
function valueAt(obj, key) {
    return key.split('.').reduce((o, k) => o?.[k], obj);
}

test('invites.json (bot and dashboard): the same keys and placeholders in all 8 languages, translated', () => {
    for (const area of ['bot', 'dashboard']) {
        const read = (lang) => JSON.parse(fs.readFileSync(`src/content/${area}/${lang}/invites.json`, 'utf8'));
        const en = read('en');
        const enKeys = keysOf(en).sort();
        for (const lang of ['ru', 'de', 'fr', 'it', 'pl', 'es', 'pt-BR']) {
            const other = read(lang);
            assert.deepEqual(keysOf(other).sort(), enKeys, `${area}/${lang} keys`);
            for (const key of enKeys) assert.equal(placeholders(valueAt(other, key)), placeholders(valueAt(en, key)), `${area}/${lang} ${key}`);
            assert.notEqual(other.title ?? other.settings.title, en.title ?? en.settings.title, `${area}/${lang} translated`);
        }
    }
});

// ── review fixes ──────────────────────────────────────────────────────────

test('a member who leaves while their join is still being recorded gets left_at on that row (stamp waits for it)', async () => {
    const guild = fakeGuild();
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const joinPromise = tracker.startInviteAttribution({ id: U, guild, user: { id: U, bot: false } }, {
        settings: SETTINGS, dbAvailable: () => true,
        attribute: async () => { await gate; return { source: 'unknown', code: null, inviterId: null }; },
        insert: async () => { order.push('insert'); return { id: '1', counted: true }; },
    });
    const left = tracker.noteMemberLeft({ guild, user: { id: U } }, { dbAvailable: () => true, stamp: async () => { order.push('stamp'); return null; } });
    release();
    await joinPromise;
    await left;
    assert.deepEqual(order, ['insert', 'stamp']);
});

test('/invites bonus: saved but the total unreadable → says it was saved, never "nothing was changed"', async () => {
    const i = fakeInteraction({ sub: 'add', group: 'bonus', options: { user: { id: B, bot: false }, amount: 2 } });
    await invitesCommand.execute(i, {}, {}, { settings: () => SETTINGS, bonus: async () => 2, counts: async () => { throw new Error('db'); } });
    assert.match(descOf(i), /^Saved: the bonus of <@200000000000000882> is now 2/);
});

test('warmInviteCache: skipped when already loaded (no reload between a join and its batch), else runs once', async () => {
    const { warmInviteCache } = await import('../src/services/invites/invitePage.js');
    let warms = 0;
    ready(G, codes({}));
    warmInviteCache(fakeGuild(), { warm: async () => { warms += 1; } });
    cache.resetInviteCacheForTests();
    warmInviteCache(fakeGuild(), { warm: async () => { warms += 1; } });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(warms, 1);
});
