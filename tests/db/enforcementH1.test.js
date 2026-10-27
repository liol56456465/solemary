// Enforcement batch H1 against the local test database (npm run test:db):
// /case search, My standing, precedent hint, no-contact orders, /staff coverage.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
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
