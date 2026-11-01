// Trust card SQL against the local test database: the three queries run on the real tables and count right.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
let pgDb, svc;
const runId = String(Date.now()).slice(-9);
const guild = `5${runId}00000081`;
const banned = `5${runId}00000082`;
const warned = `5${runId}00000083`;
const clean = `5${runId}00000084`;
const safe = (s) => s.replace(/[01oil]/g, '9');
const codes = [safe(`t${runId.slice(-5)}a`), safe(`t${runId.slice(-5)}b`), safe(`t${runId.slice(-5)}c`)];

const insertCase = (code, target, type, status, extra = '') => pgDb.pool.query(
    `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, reason_key, status${extra ? ', is_test' : ''})
     VALUES ($1, $2, $3, 'm', '1', 'mod', $4, $2, 'Spam', 'prebuilt', 'spam', $5${extra ? ', TRUE' : ''})`,
    [guild, code, target, type, status],
);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    svc = await import('../../src/services/enforcement/trustCardService.js');
    await insertCase(codes[0], banned, 'ban', 'active');
    await insertCase(codes[1], warned, 'warn', 'active');
    await insertCase(codes[2], clean, 'ban', 'active', 'test'); // test case: never counted
    await pgDb.pool.query(`INSERT INTO mod_ladder (guild_id, user_id, warns_since_level) VALUES ($1, $2, 1)`, [guild, warned]);
    await pgDb.pool.query(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, created_at, claimed_at, decided_at, status)
        VALUES ('appeal', $1, $2, 'm', $3, NOW() - INTERVAL '10 hours', NOW() - INTERVAL '8 hours', NOW() - INTERVAL '6 hours', 'accepted')`, [codes[0], banned, guild]);
});
after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM mod_ladder WHERE guild_id = $1', [guild]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]);
    await pgDb.disconnect();
});

const since = () => new Date(Date.now() - 90 * 86400000);
const run = ({ text, params }) => pgDb.pool.query(text, params).then((r) => r.rows[0]);

test('trust card: appeals query counts and medians', { skip }, async () => {
    const row = await run(svc.trustAppealsQuery(guild, since()));
    assert.equal(row.received, 1);
    assert.equal(row.accepted, 1);
    assert.equal(row.denied, 0);
    assert.equal(row.answered, 1);
    assert.equal(row.decided, 1);
    assert.ok(Math.abs(Number(row.median_first_hours) - 2) < 0.01, `first ${row.median_first_hours}`);
    assert.ok(Math.abs(Number(row.median_decision_hours) - 4) < 0.01, `decision ${row.median_decision_hours}`);
});

test('trust card: cases query skips test cases', { skip }, async () => {
    assert.equal((await run(svc.trustCasesQuery(guild, since()))).cases, 2);
});

test('trust card: standing counts a ban and a warning once each, not the clean member', { skip }, async () => {
    assert.equal((await run(svc.standingQuery(guild, [banned, warned, clean]))).flagged, 2);
    assert.equal((await run(svc.standingQuery(guild, [clean]))).flagged, 0);
});
