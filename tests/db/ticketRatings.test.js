// Ticket ratings (schema v14, services/ticketRatingService.js) against the local test database
// (npm run test:db): five rating clicks at once → exactly one succeeds; only the opener, only in the
// window, a comment once and only after the stars; a re-close after a reopen refreshes an unrated
// row and keeps a rated one; an old survey's ticket is copied in on a click; the O4 backfill copies
// old JSONB ratings once (a second run adds nothing; staff = claimedBy else closedBy); the stats;
// /wipedata blanks the opener and the comment but keeps the stars; the three retention rules.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const DAY = 86_400_000;
const runId = String(Date.now()).slice(-9);
const G = `4${runId}00000071`;
const G2 = `4${runId}00000072`;
const id = (n) => `3${runId}${String(n).padStart(8, '0')}`;
const OPENER = id(1);
const STAFF = id(2);
const CLOSER = id(3);
const OTHER = id(4);
let pgDb, svc, dbMod;
const q = (text, params) => pgDb.pool.query(text, params);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    svc = await import('../../src/services/ticketRatingService.js');
    dbMod = await import('../../src/services/enforcement/db.js');
    for (const g of [G, G2]) await q('INSERT INTO guilds (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [g]);
});

after(async () => {
    if (skip) return;
    for (const g of [G, G2]) {
        await q('DELETE FROM ticket_data WHERE guild_id = $1', [g]).catch(() => {});
        await q('DELETE FROM guilds WHERE id = $1', [g]).catch(() => {}); // cascades ticket_ratings
    }
    await pgDb.disconnect();
});

const pending = (refN, over = {}) => svc.createPendingRating({
    guildId: G, refId: id(refN), openerId: OPENER, staffId: STAFF, closerId: CLOSER, ticketNumber: '012', priority: 'high', windowDays: 7, ...over,
});

test('five clicks at once: exactly one rating is saved, the others are told "already"', { skip }, async () => {
    await pending(100);
    const results = await Promise.all([1, 2, 3, 4, 5].map((stars) => svc.submitRating({ guildId: G, refId: id(100), userId: OPENER, rating: stars })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.reason), ['already', 'already', 'already', 'already']);
    const { rows } = await q('SELECT rating, rated_at FROM ticket_ratings WHERE guild_id = $1 AND ref_id = $2', [G, id(100)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rating, results.find((r) => r.ok).row.rating);
});

test('only the opener, only inside the window; the comment once and only after the stars', { skip }, async () => {
    await pending(101);
    assert.equal((await svc.submitRating({ guildId: G, refId: id(101), userId: OTHER, rating: 5 })).reason, 'notYours');
    assert.equal((await svc.submitComment({ guildId: G, refId: id(101), userId: OPENER, comment: 'early' })).reason, 'notRated');
    assert.equal((await svc.submitRating({ guildId: G, refId: id(101), userId: OPENER, rating: 2 })).ok, true);
    const first = await svc.submitComment({ guildId: G, refId: id(101), userId: OPENER, comment: 'slow answer', flagged: true });
    assert.equal(first.ok, true);
    assert.equal(first.row.comment_flagged, true);
    assert.equal((await svc.submitComment({ guildId: G, refId: id(101), userId: OPENER, comment: 'again' })).reason, 'already');
    assert.equal((await svc.findRating(G, id(101))).comment, 'slow answer');

    await pending(102, { windowDays: 1 });
    await q(`UPDATE ticket_ratings SET expires_at = NOW() - interval '1 minute' WHERE guild_id = $1 AND ref_id = $2`, [G, id(102)]);
    assert.equal((await svc.submitRating({ guildId: G, refId: id(102), userId: OPENER, rating: 5 })).reason, 'expired');
    assert.equal((await svc.findRating(G, id(102))).rating, null);
});

test('reopen + close again: an unrated row is refreshed (new staff), a rated one is kept and no new survey is due', { skip }, async () => {
    const first = await pending(103);
    const again = await pending(103, { staffId: OTHER });
    assert.equal(again.id, first.id);
    assert.equal(again.staff_id, OTHER);
    await svc.submitRating({ guildId: G, refId: id(103), userId: OPENER, rating: 4 });
    assert.equal(await pending(103, { staffId: CLOSER }), null, 'rated: nothing returned');
    const kept = await svc.findRating(G, id(103));
    assert.deepEqual([kept.rating, kept.staff_id], [4, OTHER]);
});

test('modmail: a server without a guilds row gets one (FK), kind modmail', { skip }, async () => {
    const g3 = `4${runId}00000073`;
    try {
        const r = await svc.createPendingRating({ guildId: g3, kind: 'modmail', refId: id(104), openerId: OPENER, staffId: CLOSER, closerId: CLOSER, windowDays: 7 });
        assert.equal(r.kind, 'modmail');
        await svc.setRatingDelivery(r.id, 'failed');
        assert.equal((await svc.findRating(g3, id(104))).delivery, 'failed');
    } finally {
        await q('DELETE FROM guilds WHERE id = $1', [g3]);
    }
});

test('an old survey: its ticket is copied in on a click (pending inside the window, rated as rated, nothing when too old)', { skip }, async () => {
    const now = Date.now();
    const recent = { userId: OPENER, claimedBy: STAFF, closedBy: CLOSER, closedAt: new Date(now - DAY).toISOString(), priority: 'low' };
    const row = await svc.materializeLegacyRating(G, id(105), recent, { windowDays: 7 });
    assert.deepEqual([row.rating, row.staff_id, row.closer_id, row.priority], [null, STAFF, CLOSER, 'low']);
    assert.equal((await svc.submitRating({ guildId: G, refId: id(105), userId: OPENER, rating: 5 })).ok, true);

    const rated = { userId: OPENER, closedBy: CLOSER, closedAt: new Date(now - 40 * DAY).toISOString(), feedback: { rating: 3, submittedAt: new Date(now - 39 * DAY).toISOString(), comment: 'ok' } };
    const copied = await svc.materializeLegacyRating(G, id(106), rated, { windowDays: 7 });
    assert.deepEqual([copied.rating, copied.staff_id, copied.comment], [3, CLOSER, 'ok']);
    assert.equal(await svc.materializeLegacyRating(G, id(107), { userId: OPENER, closedAt: new Date(now - 40 * DAY).toISOString() }, { windowDays: 7 }), null);
});

test('O4 backfill: old JSONB ratings copied once (idempotent, additive); staff = claimedBy else closedBy', { skip }, async () => {
    const closedAt = new Date(Date.now() - 3 * DAY).toISOString();
    const tickets = [
        [id(200), { userId: OPENER, claimedBy: STAFF, closedBy: CLOSER, closedAt, number: '007', priority: 'high', feedback: { rating: 5, submittedAt: closedAt, comment: 'great' } }],
        [id(201), { userId: OPENER, claimedBy: null, closedBy: CLOSER, closedAt, feedback: { rating: 2 } }],
        [id(202), { userId: OPENER, closedBy: CLOSER, closedAt, feedback: { comment: 'no stars' } }], // no rating: not copied
        [id(203), { userId: 'bad', closedBy: CLOSER, feedback: { rating: 4 } }], // bad opener: not copied
        [id(204), { userId: OPENER, closedBy: CLOSER, closedAt: 'not a date', feedback: { rating: 4, submittedAt: '2025-13-40T00:00:00Z' } }], // bad dates never fail the run
        // Retention holds: older than 2 years not copied; a comment older than 180 days copied without it.
        [id(205), { userId: OPENER, closedBy: CLOSER, closedAt: new Date(Date.now() - 800 * DAY).toISOString(), feedback: { rating: 1, comment: 'old' } }],
        [id(206), { userId: OPENER, closedBy: CLOSER, closedAt: new Date(Date.now() - 200 * DAY).toISOString(), feedback: { rating: 3, comment: 'stale' } }],
        // The opener closed their own unclaimed ticket: no staff member.
        [id(207), { userId: OPENER, closedBy: OPENER, closedAt, feedback: { rating: 5 } }],
    ];
    for (const [channelId, data] of tickets) {
        await q('INSERT INTO ticket_data (guild_id, channel_id, data) VALUES ($1, $2, $3)', [G2, channelId, data]);
    }
    // A ticket already rated the new way is never touched.
    await svc.createPendingRating({ guildId: G2, refId: id(201), openerId: OPENER, staffId: OTHER, windowDays: 7 });
    await svc.submitRating({ guildId: G2, refId: id(201), userId: OPENER, rating: 4 });

    await svc.backfillLegacyRatings();
    const again = await svc.backfillLegacyRatings();
    const { rows } = await q('SELECT ref_id, rating, staff_id, closer_id, ticket_number, priority, comment FROM ticket_ratings WHERE guild_id = $1 ORDER BY ref_id', [G2]);
    assert.deepEqual(rows.map((r) => r.ref_id), [id(200), id(201), id(204), id(206), id(207)]);
    const byRef = Object.fromEntries(rows.map((r) => [r.ref_id, r]));
    assert.deepEqual([byRef[id(206)].rating, byRef[id(206)].comment], [3, null]);
    assert.equal(byRef[id(207)].staff_id, null);
    assert.deepEqual([byRef[id(200)].rating, byRef[id(200)].staff_id, byRef[id(200)].ticket_number, byRef[id(200)].priority, byRef[id(200)].comment], [5, STAFF, '007', 'high', 'great']);
    assert.deepEqual([byRef[id(201)].rating, byRef[id(201)].staff_id], [4, OTHER], 'the new-way rating stays');
    assert.equal(byRef[id(204)].rating, 4);
    // Rows of other test runs may be copied by the same statement; ours: nothing on the second run.
    const { rows: [{ n }] } = await q('SELECT COUNT(*)::int AS n FROM ticket_ratings WHERE guild_id = $1', [G2]);
    assert.equal(n, 5);
    assert.equal(typeof again, 'number');
});

test('stats: per staff, per kind/priority, trend, response rate, low ratings, summary (this server only)', { skip }, async () => {
    const byStaff = await svc.ratingsByStaff(G);
    assert.ok(byStaff.every((r) => r.count > 0));
    const staffIds = byStaff.map((r) => r.staffId);
    assert.ok(staffIds.includes(STAFF) && staffIds.includes(OTHER));
    const byPriority = await svc.ratingsByPriority(G);
    assert.ok(byPriority.some((r) => r.kind === 'ticket' && r.priority === 'high'));
    const trend = await svc.weeklyRatingTrend(G);
    assert.equal(trend.length, 8);
    assert.ok(trend[7].count >= 4, 'this week: the ratings above');
    const response = await svc.ratingResponseRate(G);
    assert.ok(response.prompted >= response.rated && response.rated >= 4);
    const low = await svc.recentLowRatings(G);
    assert.ok(low.every((r) => r.rating <= 2));
    assert.ok(low.some((r) => r.comment === 'slow answer' && r.comment_flagged === true));
    const summary = await svc.guildRatingSummary(G);
    assert.ok(summary.count >= 4 && summary.avg >= 1 && summary.avg <= 5);
    const other = await svc.guildRatingSummary(`4${runId}00000079`);
    assert.deepEqual(other, { count: 0, avg: null });
});

test('/wipedata: the opener and the comment go, the stars stay (every server); another member untouched', { skip }, async () => {
    await svc.createPendingRating({ guildId: G, refId: id(110), openerId: OTHER, staffId: STAFF, windowDays: 7 });
    await svc.submitRating({ guildId: G, refId: id(110), userId: OTHER, rating: 5 });
    await svc.submitComment({ guildId: G, refId: id(110), userId: OTHER, comment: 'mine' });
    const n = await svc.clearRatingsGivenBy(OPENER);
    assert.ok(n >= 5);
    const { rows } = await q('SELECT opener_id, comment, rating FROM ticket_ratings WHERE guild_id IN ($1, $2) AND ref_id = ANY($3)', [G, G2, [id(101), id(200)]]);
    assert.ok(rows.length === 2 && rows.every((r) => r.opener_id === null && r.comment === null));
    assert.deepEqual(rows.map((r) => r.rating).sort(), [2, 5], 'stars kept');
    const kept = await svc.findRating(G, id(110));
    assert.deepEqual([kept.opener_id, kept.comment], [OTHER, 'mine']);
    assert.equal((await svc.submitRating({ guildId: G, refId: id(102), userId: OPENER, rating: 1 })).reason, 'notYours', 'a wiped opener can no longer rate');
});

test('retention: comments after 180 days cleared, rows after 2 years deleted, unrated 30 days after the window deleted', { skip }, async () => {
    const insert = (refN, { prompted, expires, rating = null, ratedAgo = null, commentAgo = null }) => q(
        `INSERT INTO ticket_ratings (guild_id, kind, ref_id, opener_id, prompted_at, expires_at, rating, rated_at, comment, comment_at)
         VALUES ($1, 'ticket', $2, $3, NOW() - make_interval(days => $4::int), NOW() - make_interval(days => $5::int), $6::smallint,
                 NOW() - make_interval(days => $7::int),
                 CASE WHEN $8::int IS NULL THEN NULL ELSE 'c' END,
                 NOW() - make_interval(days => $8::int))`,
        [G, id(refN), OTHER, prompted, expires, rating, ratedAgo, commentAgo]);
    await insert(300, { prompted: 200, expires: 193, rating: 3, ratedAgo: 199, commentAgo: 181 }); // comment goes, row stays
    await insert(301, { prompted: 170, expires: 163, rating: 3, ratedAgo: 170, commentAgo: 170 }); // comment stays
    await insert(302, { prompted: 735, expires: 728, rating: 4, ratedAgo: 731 }); // row goes (2 years)
    await insert(303, { prompted: 40, expires: 33 }); // never rated, window closed 33 days ago: goes
    await insert(304, { prompted: 30, expires: 23 }); // never rated, 23 days: stays
    const r = await import('../../src/services/privacy/retentionService.js');
    const rules = Object.fromEntries(r.RETENTION_RULES);
    assert.ok(await rules.ticket_rating_comments({ query: dbMod.query, tables: (await import('../../src/config/database/postgres.js')).pgConfig.tables, now: Date.now(), limit: 5000 }) >= 1);
    assert.ok(await svc.pruneOldRatings() >= 1);
    assert.ok(await svc.pruneUnratedRatings() >= 1);
    const { rows } = await q('SELECT ref_id, comment, rating FROM ticket_ratings WHERE guild_id = $1 AND ref_id = ANY($2) ORDER BY ref_id', [G, [300, 301, 302, 303, 304].map(id)]);
    assert.deepEqual(rows.map((x) => [x.ref_id, x.comment, x.rating]), [[id(300), null, 3], [id(301), 'c', 3], [id(304), null, null]]);
});
