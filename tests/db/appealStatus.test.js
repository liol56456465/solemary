// Appeal status columns against the local test database: claim once, remind once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
let pgDb, svc;
const runId = String(Date.now()).slice(-9);
const guild = `5${runId}00000071`;
const member = `5${runId}00000072`;
const code = `q${runId.slice(-5)}`.replace(/[01oil]/g, '9').slice(0, 6);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    svc = await import('../../src/services/enforcement/appealStatusService.js');
    await pgDb.pool.query(`INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, reason_key)
        VALUES ($1, $2, $3, 'm', '1', 'mod', 'warn', 'm warn 1', 'Spam', 'prebuilt', 'spam')`, [guild, code, member]);
    await pgDb.pool.query(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, created_at) VALUES ('appeal', $1, $2, 'm', $3, NOW() - INTERVAL '3 days')`, [code, member, guild]);
});
after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = $1', [code]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = $1', [code]);
    await pgDb.disconnect();
});

test('appeal status: claim once, stale reminder once', { skip }, async () => {
    const dms = [];
    const client = { users: { fetch: async (id) => ({ send: async (p) => dms.push([id, p.content]) }) }, channels: { fetch: async () => null } };
    assert.equal((await svc.claimAppeal({ client, admin: { id: '2', username: 'Ann' }, caseCode: code })).status, 'claimed');
    assert.deepEqual(await svc.claimAppeal({ client, admin: { id: '3', username: 'Bob' }, caseCode: code }), { status: 'already', by: 'Ann' });
    assert.ok(await svc.remindStaleAppeals(client) >= 1);
    assert.equal(await svc.remindStaleAppeals(client), 0, 'only once');
    assert.ok(dms.some(([id, text]) => id === member && text.includes('still open')));
});
