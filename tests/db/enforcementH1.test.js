// Enforcement batch H1 against the local test database (npm run test:db):
// /case search, My standing, precedent hint, no-contact orders, /staff coverage.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db;
const runId = String(Date.now()).slice(-9);
const guildId = `7${runId}00000003`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
let codeSeq = 0;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const code = () => {
    let n = Number(runId) * 100 + 70 + (codeSeq += 1);
    let out = '';
    for (let i = 0; i < 7; i += 1) { out += ALPHA[n % ALPHA.length]; n = Math.floor(n / ALPHA.length); }
    return out;
};
const codes = [];
const mod = { id: user(90), username: 'mod' };

async function insertCase(fields = {}) {
    const row = {
        guild_id: guildId, case_code: code(), target_user_id: user(1), target_username: 'target',
        moderator_id: mod.id, moderator_username: mod.username, type: 'warn', name: null, reason: 'r',
        prebuilt_or_custom: 'custom', ...fields,
    };
    row.name ??= `${row.case_code}-name`;
    codes.push(row.case_code);
    const keys = Object.keys(row);
    const { rows } = await pgDb.pool.query(
        `INSERT INTO mod_cases (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        keys.map((k) => row[k])
    );
    return rows[0];
}

async function insertAppeal(caseCode, userId, status, fields = {}) {
    await pgDb.pool.query(
        `INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, status, decided_at, created_at)
         VALUES ('appeal', $1, $2, 'target', $3, $4, $5, COALESCE($6, NOW()))`,
        [caseCode, userId, guildId, status, status === 'pending' ? null : new Date(), fields.createdAt || null]
    );
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = ANY($1)', [codes]).catch(() => {});
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM mod_ladder WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.pool.query('DELETE FROM no_contact_orders WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.disconnect();
});

test('case search: filters, status rules, text, dates and paging', { skip }, async () => {
    const { searchCaseRecords, listReasonKeys, normalizeSearchFilters } = await import('../../src/services/enforcement/caseSearchService.js');
    const day = (iso) => new Date(`${iso}T12:00:00Z`);
    const other = { id: user(91), username: 'other' };
    const a = await insertCase({ type: 'warn', reason_key: 'spam', reason: 'Spam in general', created_at: day('2026-01-05') });
    const b = await insertCase({ type: 'mute', reason_key: 'spam', duration_ms: 3600000, created_at: day('2026-01-10'), expires_at: day('2026-01-10') });
    const c = await insertCase({ type: 'ban', reason_key: 'raiding', target_user_id: user(2), moderator_id: other.id, moderator_username: other.username, created_at: day('2026-02-01') });
    const d = await insertCase({ type: 'warn', reason_key: 'spam', status: 'revoked', created_at: day('2026-02-02') });
    const e = await insertCase({ type: 'warn', reason_key: 'spam', status: 'revoked', voided_at: new Date(), name: 'Special Name', created_at: day('2026-02-03') });

    const find = async (raw, opts) => (await searchCaseRecords(guildId, normalizeSearchFilters(raw), opts));
    const codesOf = (result) => result.rows.map((row) => row.case_code);

    assert.deepEqual(codesOf(await find({})), [e, d, c, b, a].map((row) => row.case_code), 'newest first');
    assert.deepEqual(codesOf(await find({ memberId: user(2) })), [c.case_code]);
    assert.deepEqual(codesOf(await find({ moderatorId: other.id })), [c.case_code]);
    assert.deepEqual(codesOf(await find({ type: 'mute' })), [b.case_code]);
    assert.deepEqual(codesOf(await find({ reasonKey: 'raiding' })), [c.case_code]);
    assert.deepEqual(codesOf(await find({ status: 'active' })), [c.case_code, a.case_code]);
    assert.deepEqual(codesOf(await find({ status: 'ended' })), [b.case_code]);
    assert.deepEqual(codesOf(await find({ status: 'revoked' })), [d.case_code]);
    assert.deepEqual(codesOf(await find({ status: 'voided' })), [e.case_code]);
    assert.deepEqual(codesOf(await find({ text: 'special' })), [e.case_code], 'ILIKE on name');
    assert.deepEqual(codesOf(await find({ text: 'IN GENERAL' })), [a.case_code], 'ILIKE on reason');
    assert.deepEqual(codesOf(await find({ from: '2026-01-10', to: '2026-02-01' })), [c.case_code, b.case_code], 'inclusive dates');

    const page0 = await find({}, { page: 0, pageSize: 2 });
    const page2 = await find({}, { page: 2, pageSize: 2 });
    assert.equal(page0.total, 5);
    assert.deepEqual(codesOf(page2), [a.case_code]);
    const beyond = await find({}, { page: 9, pageSize: 2 });
    assert.equal(beyond.rows.length, 0);
    assert.equal(beyond.total, 5, 'total still known past the last page');

    const keys = await listReasonKeys(guildId, '');
    assert.deepEqual(keys.map((row) => row.reason_key), ['spam', 'raiding']);
    assert.equal(keys[0].count, 4);
});

test('my standing: only own counted warns at the current level, active punishments, own appeals', { skip }, async () => {
    const { getMemberStanding } = await import('../../src/services/enforcement/standingService.js');
    const me = user(10);
    const someoneElse = user(11);
    await pgDb.pool.query(
        `INSERT INTO mod_ladder (guild_id, user_id, level, warns_since_level) VALUES ($1, $2, 1, 0)`,
        [guildId, me]
    );
    await insertCase({ target_user_id: me, type: 'warn', counts_toward_level: 0 }); // before the ladder ban: no longer counts
    const counted = await insertCase({ target_user_id: me, type: 'warn', counts_toward_level: 1 });
    await insertCase({ target_user_id: me, type: 'warn', counts_toward_level: 1, status: 'revoked' });
    await insertCase({ target_user_id: me, type: 'warn', counts_toward_level: 1, is_test: true });
    await insertCase({ target_user_id: someoneElse, type: 'warn', counts_toward_level: 1 });
    const mute = await insertCase({ target_user_id: me, type: 'mute', duration_ms: 3600000, expires_at: new Date(Date.now() + 3600000) });
    await insertCase({ target_user_id: me, type: 'mute', duration_ms: 3600000, expires_at: new Date(Date.now() - 1000) });
    await insertAppeal(mute.case_code, me, 'pending');
    const othersCase = await insertCase({ target_user_id: someoneElse, type: 'kick' });
    await insertAppeal(othersCase.case_code, someoneElse, 'denied');

    const standing = await getMemberStanding(guildId, me);
    assert.deepEqual(standing.ladder, { level: 1, warns_since_level: 0 });
    assert.deepEqual(standing.warns.map((row) => row.case_code), [counted.case_code]);
    assert.equal(standing.activeMute.case_code, mute.case_code);
    assert.equal(standing.activeBan, null);
    assert.deepEqual(standing.appeals.map((row) => row.case_code), [mute.case_code]);

    const nobody = await getMemberStanding(guildId, user(12));
    assert.deepEqual(nobody.ladder, { level: 0, warns_since_level: 0 });
    assert.equal(nobody.warns.length, 0);
});

test('precedent: aggregate by type and duration, excludes test/voided/old/other reasons, counts accepted appeals; cached', { skip }, async () => {
    const { loadPrecedent, precedentHint, clearPrecedentCache } = await import('../../src/services/enforcement/precedentService.js');
    const key = `h1_${runId}`;
    const recent = new Date(Date.now() - 24 * 3600000);
    const m1 = await insertCase({ reason_key: key, type: 'mute', duration_ms: 3600000, created_at: recent });
    await insertCase({ reason_key: key, type: 'mute', duration_ms: 3600000, created_at: recent });
    await insertCase({ reason_key: key, type: 'warn', created_at: recent });
    await insertCase({ reason_key: key, type: 'warn', created_at: recent, is_test: true });
    await insertCase({ reason_key: key, type: 'warn', created_at: recent, voided_at: new Date(), status: 'revoked' });
    await insertCase({ reason_key: key, type: 'warn', created_at: new Date(Date.now() - 200 * 24 * 3600000) });
    await insertCase({ reason_key: `${key}x`, type: 'ban', created_at: recent });
    await insertAppeal(m1.case_code, user(1), 'accepted');
    await insertAppeal(m1.case_code, user(1), 'denied', { createdAt: new Date(Date.now() - 3600000) });

    const rows = (await loadPrecedent(guildId, key)).sort((a, b) => a.type.localeCompare(b.type));
    assert.deepEqual(rows, [
        { type: 'mute', duration_ms: 3600000, count: 2, overturned: 1 },
        { type: 'warn', duration_ms: null, count: 1, overturned: 0 },
    ]);

    clearPrecedentCache();
    const hint = await precedentHint(guildId, key, 'Test reason');
    assert.equal(hint, 'Similar cases (reason "Test reason", last 180 days): 3 — usually Mute 1 hour (2), Warn (1); 1 overturned on appeal.');
    await insertCase({ reason_key: key, type: 'warn', created_at: recent });
    assert.equal(await precedentHint(guildId, key, 'Test reason'), hint, 'served from the cache');
    clearPrecedentCache();
    assert.match(await precedentHint(guildId, key, 'Test reason'), /: 4 —/);
});

test('no-contact: add (DMs both), duplicate refused, cache, list, end early, expiry', { skip }, async () => {
    const nc = await import('../../src/services/enforcement/noContactService.js');
    const dms = [];
    const fakeUser = (id) => ({ id, username: `u${id.slice(-2)}`, send: async (payload) => { dms.push({ id, content: payload.content }); } });
    const client = { users: { fetch: async (id) => fakeUser(id) }, guilds: { cache: new Map() } };
    const admin = { id: user(90), username: 'mod' };
    const [a, b, c] = [user(21), user(3), user(23)];

    const { order, delivered } = await nc.addNoContactOrder(client, { guildId, userA: a, userB: b, days: 3, reason: 'Keep apart', createdBy: admin });
    assert.deepEqual([order.user_a, order.user_b], nc.orderedPair(a, b));
    assert.deepEqual(delivered, [true, true]);
    assert.equal(dms.length, 2);
    assert.match(dms[0].content, /No-contact order/);
    assert.ok(Math.abs(new Date(order.until).getTime() - (Date.now() + 3 * 86400000)) < 60000);
    assert.deepEqual(nc.getActiveOrdersFor(guildId, a).map((o) => o.otherId), [b], 'cache refreshed');
    assert.deepEqual(nc.getActiveOrdersFor(guildId, b).map((o) => o.otherId), [a]);

    await assert.rejects(nc.addNoContactOrder(client, { guildId, userA: b, userB: a, days: 1, reason: 'again', createdBy: admin }),
        new RegExp(`already have an active no-contact order \\(#${order.id}\\)`));
    await assert.rejects(nc.addNoContactOrder(client, { guildId, userA: a, userB: a, days: 1, reason: 'x', createdBy: admin }), /two different/);
    await assert.rejects(nc.addNoContactOrder(client, { guildId, userA: a, userB: c, days: 0, reason: 'x', createdBy: admin }), /between 1 and/);

    const second = (await nc.addNoContactOrder(client, { guildId, userA: a, userB: c, days: 1, reason: 'Other', createdBy: admin })).order;
    assert.deepEqual((await nc.listActiveNoContactOrders(guildId)).map((row) => Number(row.id)), [Number(second.id), Number(order.id)]);
    assert.equal(nc.getActiveOrdersFor(guildId, a).length, 2);

    dms.length = 0;
    const ended = await nc.endNoContactOrder(client, { guildId, id: Number(order.id), endedBy: admin });
    assert.equal(ended.order.ended_by, admin.id);
    assert.equal(dms.length, 2);
    assert.match(dms[0].content, /Staff ended it early/);
    assert.equal(await nc.endNoContactOrder(client, { guildId, id: Number(order.id), endedBy: admin }), null, 'already ended');
    assert.equal(await nc.endNoContactOrder(client, { guildId: '1', id: Number(second.id), endedBy: admin }), null, 'other guild');
    assert.deepEqual(nc.getActiveOrdersFor(guildId, b), []);

    // A pair whose order ended may get a new one.
    const again = (await nc.addNoContactOrder(client, { guildId, userA: a, userB: b, days: 2, reason: 'Again', createdBy: admin })).order;

    // Expiry: run out both remaining orders, then the job ends them and DMs everyone.
    await pgDb.pool.query(`UPDATE no_contact_orders SET until = NOW() - interval '1 minute' WHERE id = ANY($1::bigint[])`, [[second.id, again.id]]);
    await nc.refreshNoContactCache();
    assert.deepEqual(nc.getActiveOrdersFor(guildId, a), [], 'not enforced once past until');
    // An order past its end but not yet marked ended does not block a new one.
    const third = (await nc.addNoContactOrder(client, { guildId, userA: a, userB: b, days: 1, reason: 'Third', createdBy: admin })).order;
    assert.ok(third.id);
    dms.length = 0;
    const expired = await nc.expireNoContactOrders(client);
    assert.equal(expired, 1, 'only a↔c was left to expire (a↔b was closed by the new order)');
    assert.equal(dms.length, 2);
    assert.match(dms[0].content, /It expired/);
    assert.deepEqual(nc.getActiveOrdersFor(guildId, a).map((o) => o.otherId), [b]);
});

test('staff coverage: hourly incidents vs human cases + appeal decisions, period-limited', { skip }, async () => {
    const { loadCoverageCounts, buildCoverageReport } = await import('../../src/services/staffCoverageService.js');
    const bot = user(99);
    const covGuild = `7${runId}00000004`;
    const hourAgo = (h) => new Date(Date.now() - h * 3600000);
    await insertCase({ guild_id: covGuild, created_at: hourAgo(2) });
    await insertCase({ guild_id: covGuild, created_at: hourAgo(2) });
    await insertCase({ guild_id: covGuild, created_at: hourAgo(5), moderator_id: bot, moderator_username: 'bot', is_auto: true });
    await insertCase({ guild_id: covGuild, created_at: hourAgo(5), is_test: true });
    await insertCase({ guild_id: covGuild, created_at: hourAgo(24 * 10) }); // outside 7 days
    const appealed = await insertCase({ guild_id: covGuild, created_at: hourAgo(24 * 20) });
    await pgDb.pool.query(
        `INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, status, decided_by, decided_at)
         VALUES ('appeal', $1, $2, 'target', $3, 'denied', $4, $5)`,
        [appealed.case_code, user(1), covGuild, mod.id, hourAgo(1)]
    );

    const counts = await loadCoverageCounts(covGuild, bot, 7);
    const sum = (rows) => rows.reduce((total, row) => total + row.count, 0);
    assert.equal(sum(counts.incidents), 3, 'two human + one automatic; test and old cases left out');
    assert.equal(sum(counts.staff), 3, 'two human cases + one appeal decision');
    assert.equal(sum((await loadCoverageCounts(covGuild, bot, 30)).incidents), 5);

    const report = buildCoverageReport(counts, 'UTC');
    assert.equal(report.totalIncidents, 3);
    assert.equal(report.totalStaff, 3);
    assert.equal(report.gaps[0].staff, 0, 'the automatic-only hour is the least covered');
});
