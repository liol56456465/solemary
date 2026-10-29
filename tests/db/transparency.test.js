// Transparency report against the local test database (npm run test:db): the real SQL buckets
// cases and appeals by UTC month, leaves out test, imported and other-server cases, counts
// voided cases apart and computes the median decision time. Uses its own made-up guild id,
// so other data in the database does not matter. Skipped unless POSTGRES_URL is on localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const skip = isLocalDatabaseUrl(process.env.POSTGRES_URL || '') ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
const runId = String(Date.now()).slice(-9);
const GUILD = `9${runId}00000071`;
const OTHER = `9${runId}00000072`;
const NOW = new Date('2026-10-29T13:00:00Z');
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
let pgDb, transparency;
let seq = 0;

const code = () => Array.from({ length: 7 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

async function addCase({ guild = GUILD, type = 'warn', at, isAuto = false, isTest = false, isImported = false, voided = false, reasonKey = 'spam' }) {
    seq += 1;
    const caseCode = code();
    await pgDb.pool.query(
        `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason,
                                prebuilt_or_custom, reason_key, created_at, is_auto, is_imported, is_test, voided_at)
         VALUES ($1, $2, $3, 'member', '200000000000000002', 'mod', $4, $5, 'reason', 'prebuilt', $6, $7, $8, $9, $10, $11)`,
        [guild, caseCode, `6${runId}${String(seq).padStart(6, '0')}`, type, `tr-${runId}-${seq}`, reasonKey, at, isAuto, isImported, isTest, voided ? at : null],
    );
    return caseCode;
}

async function addAppeal(caseCode, { at, status = 'pending', decidedAfterHours = null }) {
    const decidedAt = decidedAfterHours === null ? null : new Date(new Date(at).getTime() + decidedAfterHours * 3600_000);
    await pgDb.pool.query(
        `INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, status, created_at, decided_at)
         VALUES ('appeal', $1, $2, 'member', $3, $4, $5, $6)`,
        [caseCode, `6${runId}000000`, GUILD, status, at, decidedAt],
    );
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    transparency = await import('../../src/services/enforcement/transparencyService.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query(`DELETE FROM mod_appeals WHERE case_code IN (SELECT case_code FROM mod_cases WHERE guild_id = ANY($1))`, [[GUILD, OTHER]]);
    await pgDb.pool.query(`DELETE FROM mod_cases WHERE guild_id = ANY($1)`, [[GUILD, OTHER]]);
    await pgDb.disconnect();
});

test('real SQL: UTC month buckets, exclusions, voided apart, ladder/automod sub-counts, median decision time', { skip }, async () => {
    // May: 3 warns, 1 voided warn, 1 test warn, 1 imported warn; a ban by the ladder; an automod mute.
    for (let i = 0; i < 3; i += 1) await addCase({ at: '2026-05-10T12:00:00Z' });
    await addCase({ at: '2026-05-11T12:00:00Z', voided: true });
    await addCase({ at: '2026-05-11T12:00:00Z', isTest: true });
    await addCase({ at: '2026-05-11T12:00:00Z', isImported: true });
    const ladderBan = await addCase({ type: 'ban', at: '2026-05-12T12:00:00Z', isAuto: true, reasonKey: 'warn_ladder' });
    await addCase({ type: 'mute', at: '2026-05-13T12:00:00Z', reasonKey: 'automod:spam' });
    // The last second of June in UTC is June; the first of July is July.
    await addCase({ type: 'kick', at: '2026-06-30T23:59:59Z' });
    await addCase({ type: 'kick', at: '2026-07-01T00:00:00Z' });
    // Before the window and on another server: not counted.
    await addCase({ at: '2026-03-31T23:59:59Z' });
    await addCase({ guild: OTHER, at: '2026-05-10T12:00:00Z' });
    // Appeals in May: decided after 2, 10 and 30 hours (median 10), one open, one closed.
    const warns = [];
    for (let i = 0; i < 5; i += 1) warns.push(await addCase({ at: '2026-05-20T12:00:00Z' }));
    await addAppeal(ladderBan, { at: '2026-05-14T00:00:00Z', status: 'accepted', decidedAfterHours: 2 });
    await addAppeal(warns[0], { at: '2026-05-21T00:00:00Z', status: 'denied', decidedAfterHours: 10 });
    await addAppeal(warns[1], { at: '2026-05-22T00:00:00Z', status: 'denied', decidedAfterHours: 30 });
    await addAppeal(warns[2], { at: '2026-05-23T00:00:00Z', status: 'pending' });
    await addAppeal(warns[3], { at: '2026-05-24T00:00:00Z', status: 'closed', decidedAfterHours: 1 });
    // An appeal on a test case is not counted.
    const testCase = await addCase({ at: '2026-05-20T12:00:00Z', isTest: true });
    await addAppeal(testCase, { at: '2026-05-25T00:00:00Z', status: 'accepted', decidedAfterHours: 1 });

    const report = await transparency.readTransparencyReport(GUILD, { now: NOW });
    const month = (key) => report.months.find((m) => m.key === key);
    assert.deepEqual(month('2026-05').cases, { warns: 8, mutes: 1, kicks: 0, bans: 1, ladderBans: 1, automod: 1, voided: 1 });
    assert.equal(month('2026-06').cases.kicks, 1);
    assert.equal(month('2026-07').cases.kicks, 1);
    assert.equal(month('2026-04').cases.warns, 0, 'March 31 is outside the window');
    const may = month('2026-05').appeals;
    assert.deepEqual({ ...may, medianHours: Math.round(may.medianHours * 100) / 100 }, { received: 5, accepted: 1, denied: 2, open: 1, decided: 3, medianHours: 10 });
    assert.equal(report.totals.appeals.received, 5);
    assert.equal(Math.round(report.totals.appeals.medianHours * 100) / 100, 10);
    assert.equal(report.totals.cases.warns, 8);
});
