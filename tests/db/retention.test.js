// Retention job (privacy/retentionService.js) against the local test database (npm run test:db):
// per rule, rows just inside the window stay and rows outside it go; open rows and other tables
// are untouched; the batch limit bounds a run; a database error in one rule does not stop the
// others. Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const DAY = 86_400_000;
const runId = String(Date.now()).slice(-9);
const guildId = `5${runId}00000031`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const caseCode = () => Array.from({ length: 7 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
let pgDb, r, mainGuildId;
const codes = [];
const q = (text, params) => pgDb.pool.query(text, params);
const ago = (days) => new Date(Date.now() - days * DAY);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    r = await import('../../src/services/privacy/retentionService.js');
    mainGuildId = (await import('../../src/config/enforcement.js')).enforcementConfig.mainGuildId;
});

after(async () => {
    if (skip) return;
    await q('DELETE FROM mod_watchlist WHERE guild_id = $1', [guildId]).catch(() => {});
    await q('DELETE FROM no_contact_orders WHERE guild_id = $1', [guildId]).catch(() => {});
    await q('DELETE FROM automod_raid_incidents WHERE guild_id = $1', [guildId]).catch(() => {});
    await q('DELETE FROM verification_audit WHERE guild_id = $1', [guildId]).catch(() => {});
    await q('DELETE FROM verification_ips WHERE user_id LIKE $1', [`6${runId}%`]).catch(() => {});
    await q('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]).catch(() => {});
    await pgDb.disconnect();
});

async function addWatch(n, { createdDays = 400, endedDays = null, untilDays = null } = {}) {
    const { rows: [row] } = await q(
        `INSERT INTO mod_watchlist (guild_id, user_id, reason, created_by, created_at, until, ended_at) VALUES ($1, $2, 'r', '1', $3, $4, $5) RETURNING id`,
        [guildId, user(n), ago(createdDays), untilDays === null ? null : ago(untilDays), endedDays === null ? null : ago(endedDays)]);
    return row.id;
}
async function addNoContact(n, { untilDays, endedDays = null }) {
    const { rows: [row] } = await q(
        `INSERT INTO no_contact_orders (guild_id, user_a, user_b, until, created_by, reason, created_at, ended_at) VALUES ($1, $2, $3, $4, '1', 'r', $5, $6) RETURNING id`,
        [guildId, user(n), user(n + 500), ago(untilDays), ago(800), endedDays === null ? null : ago(endedDays)]);
    return row.id;
}
async function addRaid(endedDays) {
    const { rows: [row] } = await q(
        `INSERT INTO automod_raid_incidents (guild_id, started_at, ended_at) VALUES ($1, $2, $3) RETURNING id`,
        [guildId, ago(endedDays + 1), ago(endedDays)]);
    return row.id;
}
async function addAudit(n, days) {
    const { rows: [row] } = await q(
        `INSERT INTO verification_audit (guild_id, user_id, action, created_at) VALUES ($1, $2, 'verified', NOW() - ($3::int * INTERVAL '1 day')) RETURNING id`,
        [guildId, user(n), days]);
    return row.id;
}
async function addIp(n, days) {
    await q(`INSERT INTO verification_ips (user_id, ip_hash, seen_at) VALUES ($1, $2, $3)`, [user(n), `h${runId}${n}`.padEnd(64, '0'), ago(days)]);
}
async function addCase(n, { type = 'warn', guild = guildId, expiresDays = null } = {}) {
    const code = caseCode();
    codes.push(code);
    await q(`INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, created_at, expires_at)
        VALUES ($1, $2, $3, 'm', '1', 'mod', $4, $5, 'Spam', 'custom', $6, $7)`,
    [guild, code, user(n), type, `m ${type} ${code}`, ago(900), expiresDays === null ? null : new Date(Date.now() + expiresDays * DAY)]);
    return code;
}
const ids = async (table, column, values) => (await q(`SELECT ${column} AS id FROM ${table} WHERE ${column} = ANY($1)`, [values])).rows.map((row) => String(row.id)).sort();
const str = (list) => list.map(String).sort();

test('retention periods: 1 year for watchlist, no-contact, raid reports, verification audit; 60 days for IP hashes', { skip }, () => {
    assert.deepEqual({ ...r.RETENTION_DAYS }, { watchlist: 365, no_contact: 365, raid_reports: 365, verification_audit: 365, verification_ips: 60 });
});

test('watchlist: ended or run out more than a year ago → deleted; inside the window and open entries stay', { skip }, async () => {
    const oldEnded = await addWatch(1, { endedDays: 366 });
    const recentEnded = await addWatch(2, { endedDays: 364 });
    const oldUntil = await addWatch(3, { untilDays: 370 }); // ran out, never marked ended
    const openForever = await addWatch(4, { createdDays: 900 }); // no end date: active
    const openFuture = await addWatch(5, { createdDays: 900, untilDays: -10 });
    const n = await r.pruneWatchlist();
    assert.ok(n >= 2);
    assert.deepEqual(await ids('mod_watchlist', 'id', [oldEnded, recentEnded, oldUntil, openForever, openFuture]), str([recentEnded, openForever, openFuture]));
});

test('no-contact: ended or past until more than a year ago → deleted; others stay', { skip }, async () => {
    const oldEnded = await addNoContact(10, { untilDays: -30, endedDays: 400 }); // ended early long ago
    const oldExpired = await addNoContact(11, { untilDays: 366 });
    const recent = await addNoContact(12, { untilDays: 364, endedDays: 364 });
    const active = await addNoContact(13, { untilDays: -5 });
    assert.ok((await r.pruneNoContactOrders()) >= 2);
    assert.deepEqual(await ids('no_contact_orders', 'id', [oldEnded, oldExpired, recent, active]), str([recent, active]));
});

test('raid reports: ended more than a year ago → deleted', { skip }, async () => {
    const old = await addRaid(366);
    const recent = await addRaid(364);
    assert.ok((await r.pruneRaidIncidents()) >= 1);
    assert.deepEqual(await ids('automod_raid_incidents', 'id', [old, recent]), str([recent]));
});

test('verification audit: older than a year → deleted', { skip }, async () => {
    const old = await addAudit(20, 366);
    const recent = await addAudit(21, 364);
    assert.ok((await r.pruneVerificationAudit()) >= 1);
    assert.deepEqual(await ids('verification_audit', 'id', [old, recent]), str([recent]));
});

test('verification IPs: not seen for 60 days → deleted, unless the member has an active main-server ban', { skip }, async () => {
    await addIp(30, 61);
    await addIp(31, 59);
    await addIp(32, 90); // active ban in the main server: kept
    await addIp(33, 90); // ban ended: deleted
    await addCase(32, { type: 'ban', guild: mainGuildId });
    await addCase(33, { type: 'ban', guild: mainGuildId, expiresDays: -1 });
    assert.ok((await r.pruneVerificationIps()) >= 2);
    assert.deepEqual(await ids('verification_ips', 'user_id', [user(30), user(31), user(32), user(33)]), [user(31), user(32)].sort());
});

test('a run is bounded by the batch limit', { skip }, async () => {
    const a = await addWatch(40, { endedDays: 500 });
    const b = await addWatch(41, { endedDays: 500 });
    // The watchlist test above already deleted every other old row (tests run one at a time).
    assert.equal(await r.pruneWatchlist({ limit: 1 }), 1);
    assert.equal((await ids('mod_watchlist', 'id', [a, b])).length, 1);
    assert.equal(await r.pruneWatchlist({ limit: 1 }), 1);
    assert.equal((await ids('mod_watchlist', 'id', [a, b])).length, 0);
});

test('runRetention: a database error in one rule does not stop the others; other tables untouched', { skip }, async () => {
    const watch = await addWatch(50, { endedDays: 400 });
    const nc = await addNoContact(51, { untilDays: 400 });
    const raid = await addRaid(400);
    const audit = await addAudit(52, 400);
    await addIp(53, 100);
    const kept = await addCase(54); // an old case: never touched by retention
    const { query } = await import('../../src/services/enforcement/db.js');
    const failing = (text, params) => (/mod_watchlist/.test(text) ? Promise.reject(new Error('relation is locked')) : query(text, params));
    const result = await r.runRetention(null, { query: failing });
    assert.deepEqual(result.failed, ['watchlist']);
    assert.deepEqual(Object.keys(result.counts).sort(), ['no_contact', 'raid_reports', 'verification_audit', 'verification_ips']);
    assert.deepEqual(await ids('mod_watchlist', 'id', [watch]), [String(watch)], 'the failed rule deleted nothing');
    assert.deepEqual(await ids('no_contact_orders', 'id', [nc]), []);
    assert.deepEqual(await ids('automod_raid_incidents', 'id', [raid]), []);
    assert.deepEqual(await ids('verification_audit', 'id', [audit]), []);
    assert.deepEqual(await ids('verification_ips', 'user_id', [user(53)]), []);
    assert.deepEqual(await ids('mod_cases', 'case_code', [kept]), [kept]);

    // The next run without the error deletes it.
    const again = await r.runRetention(null);
    assert.deepEqual(again.failed, []);
    assert.deepEqual(await ids('mod_watchlist', 'id', [watch]), []);
});
