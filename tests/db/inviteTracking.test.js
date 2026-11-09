// Invite tracking (schema v14) against the local test database (npm run test:db): the join row and
// the "rejoins count once" rule, the counting queries (fake / left / bonus / reset_at / the server
// reset), the leaderboard, the code cache (long codes never in invite_tracking), /wipedata, the
// data export sections, retention, and the cascade when the server row goes.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const runId = String(Date.now()).slice(-9);
const g = (n) => `8${runId}${String(n).padStart(8, '0')}`;
const u = (n) => `5${runId}${String(n).padStart(8, '0')}`;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const SETTINGS = { enabled: true, fakeAccountDays: 7, fakeLeaveHours: 24, milestones: [], stackRoles: true, resetAt: null };

let pgDb, store, stats, exporter, retention, enforcementDb;
const q = (text, params) => pgDb.pool.query(text, params);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    store = await import('../../src/services/invites/inviteStore.js');
    stats = await import('../../src/services/invites/inviteStats.js');
    exporter = await import('../../src/services/privacy/dataExport.js');
    retention = await import('../../src/services/privacy/retentionService.js');
    enforcementDb = await import('../../src/services/enforcement/db.js');
});

after(async () => {
    if (skip) return;
    await q('DELETE FROM guilds WHERE id LIKE $1', [`8${runId}%`]).catch(() => {});
    await pgDb.disconnect();
});

const at = (ms) => new Date(Date.UTC(2026, 9, 1) + ms);

async function join(guildId, userId, inviterId, { joined = 0, accountAgeDays = 100, code = 'abc', source = inviterId ? 'invite' : 'unknown', serverResetAt = null } = {}) {
    return store.insertJoin({
        guildId, userId, inviterId, code, source, accountCreatedAt: at(joined - accountAgeDays * DAY), joinedAt: at(joined), serverResetAt,
    });
}

test('insertJoin: creates the server row; a rejoin through the same inviter is not counted again; another inviter counts', { skip }, async () => {
    const G = g(1);
    const first = await join(G, u(1), u(9));
    assert.equal(first.counted, true);
    assert.ok((await q('SELECT 1 FROM guilds WHERE id = $1', [G])).rowCount, 'guild row made');
    await store.stampLeft(G, u(1), at(2 * DAY));
    const again = await join(G, u(1), u(9), { joined: 3 * DAY });
    assert.equal(again.counted, false, 'rejoin through the same inviter');
    const other = await join(G, u(1), u(8), { joined: 4 * DAY });
    assert.equal(other.counted, true, 'a different inviter');
    // The open row of a member who left while Mewvo was offline is closed by the next join.
    const rows = (await q('SELECT left_at FROM invite_joins WHERE guild_id = $1 AND user_id = $2 ORDER BY joined_at', [G, u(1)])).rows;
    assert.equal(rows.length, 3);
    assert.ok(rows[1].left_at, 'the second row was closed at the third join');
    assert.equal(rows[2].left_at, null);
    // No inviter: always counted (it never counts for anyone).
    assert.equal((await join(G, u(2), null)).counted, true);
    // A code longer than the column is stored as NULL, never cut.
    await store.insertJoin({ guildId: G, userId: u(3), source: 'vanity', code: 'x'.repeat(40) });
    assert.equal((await q('SELECT invite_code FROM invite_joins WHERE guild_id = $1 AND user_id = $2', [G, u(3)])).rows[0].invite_code, null);
});

test('counts: total = joined − left − fake + bonus; fake by account age or a quick leave; rule changes recount', { skip }, async () => {
    const G = g(2);
    const A = u(10);
    await join(G, u(11), A); // stays: counts
    await join(G, u(12), A, { accountAgeDays: 2 }); // new account: fake
    await join(G, u(13), A);
    await store.stampLeft(G, u(13), at(2 * HOUR)); // left within 24 h: fake
    await join(G, u(14), A);
    await store.stampLeft(G, u(14), at(5 * DAY)); // left later: left
    await store.changeBonus(G, A, 3, { actorId: u(99) });
    const c = await stats.inviteCounts(G, A, SETTINGS);
    assert.deepEqual({ invited: c.invited, left: c.left, fake: c.fake, bonus: c.bonus, total: c.total }, { invited: 4, left: 1, fake: 2, bonus: 3, total: 4 });
    // Rule off: nothing is fake, the quick leaver counts as left.
    const loose = await stats.inviteCounts(G, A, { ...SETTINGS, fakeAccountDays: 0, fakeLeaveHours: 0 });
    assert.deepEqual([loose.left, loose.fake, loose.total], [2, 0, 5]);
    // Somebody with no rows: zeros, not an error.
    assert.equal((await stats.inviteCounts(G, u(77), SETTINGS)).total, 0);
    // Bonus limits: past ±100,000 refused, nothing changed.
    await assert.rejects(store.changeBonus(G, A, 100000), (e) => e.code === 'bonusRange');
    assert.equal((await stats.inviteCounts(G, A, SETTINGS)).bonus, 3);
    assert.equal(await store.changeBonus(G, A, -5), -2);
});

test('reset: one inviter (reset_at, bonus 0) and the server-wide resetAt (old bonuses ignored); nothing deleted', { skip }, async () => {
    const G = g(3);
    const A = u(20);
    const B = u(21);
    await join(G, u(22), A);
    await join(G, u(23), B);
    await store.changeBonus(G, A, 2);
    await store.changeBonus(G, B, 4);
    await store.resetInviter(G, A, { actorId: u(99), at: new Date() });
    assert.equal((await stats.inviteCounts(G, A, SETTINGS)).total, 0, 'old joins and the bonus no longer count');
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM invite_joins WHERE guild_id = $1', [G])).rows[0].n, 2, 'nothing deleted');
    const later = await store.insertJoin({ guildId: G, userId: u(24), inviterId: A, code: 'abc', source: 'invite', joinedAt: new Date(Date.now() + 1000) });
    assert.equal(later.counted, true);
    assert.equal((await stats.inviteCounts(G, A, SETTINGS)).total, 1, 'joins after the reset count');
    // Server-wide reset: B's old join and old bonus stop counting; a bonus given after it counts.
    const resetAt = new Date(Date.now() + 2000).toISOString();
    const serverReset = { ...SETTINGS, resetAt };
    assert.equal((await stats.inviteCounts(G, B, serverReset)).total, 0);
    await q('UPDATE invite_inviters SET updated_at = $3 WHERE guild_id = $1 AND user_id = $2', [G, B, new Date(Date.now() - 1000)]);
    const bonus = await store.changeBonus(G, B, 1, { serverResetAt: resetAt });
    assert.equal(bonus, 1, 'the bonus from before the server reset is dropped, the new one kept');
});

test('leaderboard: highest total first, bonus-only inviters included, blanked inviters never', { skip }, async () => {
    const G = g(4);
    const [A, B, C] = [u(30), u(31), u(32)];
    for (const n of [33, 34, 35]) await join(G, u(n), A);
    await join(G, u(36), B);
    await store.changeBonus(G, C, 2);
    await q(`INSERT INTO invite_joins (guild_id, user_id, inviter_id, source) VALUES ($1, $2, NULL, 'invite')`, [G, u(37)]);
    const rows = await stats.inviteLeaderboard(G, SETTINGS, { page: 1, pageSize: 10 });
    assert.deepEqual(rows.map((r) => [r.rank, r.userId, r.total]), [[1, A, 3], [2, C, 2], [3, B, 1]]);
    const page2 = await stats.inviteLeaderboard(G, SETTINGS, { page: 2, pageSize: 2 });
    assert.deepEqual(page2.map((r) => [r.rank, r.userId]), [[3, B]]);
    const list = await stats.joinsByInviter(G, A, SETTINGS, { limit: 2 });
    assert.equal(list.length, 2);
    assert.ok(list.every((r) => r.current && !r.fake));
    const recent = await stats.recentJoins(G, SETTINGS, { limit: 3 });
    assert.equal(recent.length, 3);
    assert.equal(recent[0].userId, u(37));
});

test('code cache: saveCodes upserts, marks vanished codes deleted, never writes a code over 20 characters', { skip }, async () => {
    const G = g(5);
    await store.saveCodes(G, [{ code: 'short1', inviterId: u(40), uses: 2, maxUses: 5, expiresAt: null }, { code: 'y'.repeat(25), inviterId: u(40), uses: 1 }]);
    let rows = (await q('SELECT invite_code, uses, deleted_at FROM invite_tracking WHERE guild_id = $1 ORDER BY invite_code', [G])).rows;
    assert.deepEqual(rows.map((r) => [r.invite_code, r.uses, r.deleted_at]), [['short1', 2, null]]);
    await store.saveCodes(G, [{ code: 'short2', inviterId: null, uses: 0 }]);
    rows = (await q('SELECT invite_code, deleted_at FROM invite_tracking WHERE guild_id = $1 ORDER BY invite_code', [G])).rows;
    assert.ok(rows.find((r) => r.invite_code === 'short1').deleted_at, 'vanished → deleted (kept)');
    assert.equal(rows.find((r) => r.invite_code === 'short2').deleted_at, null);
    assert.equal(await store.saveCode(G, { code: 'z'.repeat(21) }), false);
    assert.equal(await store.markCodeDeleted(G, 'short2'), 1);
    const listed = await store.listStoredCodes(G);
    assert.equal(listed.length, 2);
    assert.ok(listed.every((c) => c.deleted));
});

test('/wipedata: own join rows and own invite_inviters row deleted; blanked as the inviter elsewhere; one transaction', { skip }, async () => {
    const G = g(6);
    const me = u(50);
    await join(G, me, u(51)); // how I joined
    await join(G, u(52), me); // someone I invited
    await store.changeBonus(G, me, 2);
    await store.saveCode(G, { code: 'mine', inviterId: me, uses: 1 });
    await join(g(7), me, u(51)); // another server: untouched
    await store.wipeInviteData(G, me);
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM invite_joins WHERE guild_id = $1 AND user_id = $2', [G, me])).rows[0].n, 0);
    assert.equal((await q('SELECT inviter_id FROM invite_joins WHERE guild_id = $1 AND user_id = $2', [G, u(52)])).rows[0].inviter_id, null);
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM invite_inviters WHERE guild_id = $1 AND user_id = $2', [G, me])).rows[0].n, 0);
    assert.equal((await q('SELECT inviter_id FROM invite_tracking WHERE guild_id = $1 AND invite_code = $2', [G, 'mine'])).rows[0].inviter_id, null);
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM invite_joins WHERE guild_id = $1 AND user_id = $2', [g(7), me])).rows[0].n, 1, 'other servers kept');
});

test('data export: invitedBy (own rows) and invitesSummary (counts only, never the invitees)', { skip }, async () => {
    const G = g(8);
    const me = u(60);
    const invitee = u(61);
    await join(G, me, u(62), { code: 'how' });
    await join(G, invitee, me);
    await store.stampLeft(G, invitee, at(3 * DAY));
    await join(G, u(63), me);
    await store.changeBonus(G, me, 1);
    const file = await exporter.buildDataExport(me, { query: enforcementDb.query, readKey: async () => null });
    const mine = file.invitedBy.filter((r) => r.guild_id === G);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].inviter_id, u(62));
    assert.equal(mine[0].invite_code, 'how');
    const summary = file.invitesSummary.find((r) => r.guild_id === G);
    assert.deepEqual({ joined: summary.members_joined_through_you, left: summary.of_them_left, bonus: summary.staff_bonus },
        { joined: 2, left: 1, bonus: 1 });
    assert.ok(!JSON.stringify(file).includes(invitee), 'the invitee id is never in the file');
    JSON.stringify(file);
});

test('retention: join rows of members who left more than 365 days ago go; current members and recent leavers stay', { skip }, async () => {
    const G = g(9);
    await join(G, u(70), u(79));
    await join(G, u(71), u(79));
    await join(G, u(72), u(79));
    await q('UPDATE invite_joins SET left_at = NOW() - INTERVAL \'400 days\' WHERE guild_id = $1 AND user_id = $2', [G, u(70)]);
    await q('UPDATE invite_joins SET left_at = NOW() - INTERVAL \'10 days\' WHERE guild_id = $1 AND user_id = $2', [G, u(71)]);
    const rule = retention.RETENTION_RULES.find(([name]) => name === 'invite_joins')[1];
    const removed = await rule({ query: enforcementDb.query });
    assert.ok(removed >= 1);
    const left = (await q('SELECT user_id FROM invite_joins WHERE guild_id = $1 ORDER BY user_id', [G])).rows.map((r) => r.user_id);
    assert.deepEqual(left, [u(71), u(72)]);
});

test('cascade: deleting the server row removes its invite rows', { skip }, async () => {
    const G = g(10);
    await join(G, u(80), u(81));
    await store.changeBonus(G, u(81), 1);
    await store.saveCode(G, { code: 'gone', inviterId: u(81), uses: 1 });
    await q('DELETE FROM guilds WHERE id = $1', [G]);
    for (const table of ['invite_joins', 'invite_inviters', 'invite_tracking']) {
        assert.equal((await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE guild_id = $1`, [G])).rows[0].n, 0, table);
    }
});

test('leave reconcile: closes only the given open, old-enough rows of that server; counted as left (not fake); retention prunes after 365 days', { skip }, async () => {
    const reconcile = await import('../../src/services/invites/inviteReconcile.js');
    const G = g(11);
    const OTHER = g(12);
    const A = u(99);
    for (const n of [90, 91, 92, 93]) await join(G, u(n), A);
    await join(OTHER, u(90), A);
    // Joined 40 days ago (the clock is the database's NOW()); u(93) only 5 days ago.
    await q(`UPDATE invite_joins SET joined_at = NOW() - INTERVAL '40 days', account_created_at = NOW() - INTERVAL '400 days' WHERE guild_id = ANY($1)`, [[G, OTHER]]);
    await q(`UPDATE invite_joins SET joined_at = NOW() - INTERVAL '5 days' WHERE guild_id = $1 AND user_id = $2`, [G, u(93)]);
    // u(92) left normally 10 days ago: its left_at must stay.
    await q(`UPDATE invite_joins SET left_at = NOW() - INTERVAL '10 days' WHERE guild_id = $1 AND user_id = $2`, [G, u(92)]);
    const rowOf = async (guildId, userId) => (await q('SELECT id, left_at FROM invite_joins WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rows[0];
    const before92 = (await rowOf(G, u(92))).left_at;

    // listOpenJoins: open + old enough only.
    const open = await store.listOpenJoins(G, { minAgeHours: reconcile.MIN_AGE_HOURS });
    assert.deepEqual(open.map((r) => r.userId).sort(), [u(90), u(91)]);

    // The UPDATE: ids of every kind, only the open old row of this server changes.
    const ids = [(await rowOf(G, u(90))).id, (await rowOf(G, u(92))).id, (await rowOf(G, u(93))).id, (await rowOf(OTHER, u(90))).id];
    assert.equal(await store.closeOpenJoins(G, ids, { minAgeHours: reconcile.MIN_AGE_HOURS }), 1);
    assert.ok((await rowOf(G, u(90))).left_at, 'closed');
    assert.equal((await rowOf(G, u(91))).left_at, null, 'not in the list: untouched');
    assert.equal((await rowOf(G, u(92))).left_at.getTime(), before92.getTime(), 'already closed: left_at unchanged');
    assert.equal((await rowOf(G, u(93))).left_at, null, 'too young: untouched');
    assert.equal((await rowOf(OTHER, u(90))).left_at, null, 'another server: untouched');

    // Through reconcileGuild with the real store: an untrusted list closes nothing; a trusted
    // list where u(91) is present closes nothing more.
    const untrusted = await reconcile.reconcileGuild({ id: G, memberCount: 5 }, {
        fetchMembers: async () => ({ members: new Map(), partial: true, reason: 'too-large' }),
    });
    assert.equal(untrusted.closed, 0);
    const trusted = await reconcile.reconcileGuild({ id: G, memberCount: 1 }, {
        fetchMembers: async () => ({ members: new Map([[u(91), {}]]), partial: false, reason: 'fetched' }),
    });
    assert.deepEqual({ open: trusted.open, closed: trusted.closed }, { open: 1, closed: 0 });
    assert.equal((await rowOf(G, u(91))).left_at, null);

    // The reconciled leave counts as "left", never as "fake", even with the longest fake-leave window.
    const counts = await stats.inviteCounts(G, A, { ...SETTINGS, fakeAccountDays: 0, fakeLeaveHours: reconcile.MIN_AGE_HOURS });
    assert.equal(counts.fake, 0);
    assert.equal(counts.left, 2, 'u(90) reconciled + u(92) normal leave');

    // Retention: kept now, pruned once the reconcile time is more than 365 days ago.
    const id90 = (await rowOf(G, u(90))).id;
    await retention.pruneInviteJoins({ query: enforcementDb.query });
    assert.equal((await q('SELECT 1 FROM invite_joins WHERE id = $1', [id90])).rowCount, 1, 'kept within 365 days');
    await retention.pruneInviteJoins({ query: enforcementDb.query, now: Date.now() + 366 * DAY });
    assert.equal((await q('SELECT 1 FROM invite_joins WHERE id = $1', [id90])).rowCount, 0, 'pruned after 365 days');
    assert.ok(await rowOf(G, u(91)), 'open rows are never pruned');
});
