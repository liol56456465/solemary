// Bot DM log (schema v13, bot_dm_log; services/botDm/dmLog.js) against the local test database
// (npm run test:db): the migration only creates (applies twice, existing rows untouched), the
// re-edit query sees only the member's DMs of that server from the last 30 days that are not in
// the new language yet, retention removes rows older than 30 days, /wipedata removes a member's
// rows, and a database error throws. Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const DAY = 86_400_000;
const runId = String(Date.now()).slice(-9);
const g = (n) => `7${runId}${String(n).padStart(8, '0')}`;
const u = (n) => `6${runId}${String(n).padStart(8, '0')}`;
const msg = (n) => `9${runId}${String(n).padStart(8, '0')}`;
const CHANNEL = `8${runId}00000001`;
let pgDb, schema, dmLog, retention, wipe;
const q = (text, params) => pgDb.pool.query(text, params);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    schema = await import('../../src/utils/database/schema.js');
    dmLog = await import('../../src/services/botDm/dmLog.js');
    retention = await import('../../src/services/privacy/retentionService.js');
    wipe = await import('../../src/services/wipedataService.js');
});

after(async () => {
    if (skip) return;
    await q('DELETE FROM bot_dm_log WHERE user_id LIKE $1', [`6${runId}%`]).catch(() => {});
    await pgDb.disconnect();
});

async function add(n, { guild = g(1), user = u(1), lang = 'en', daysAgo = 0, key = 'enf.warn', params = { rec: { case_code: 'abc23' } } } = {}) {
    await dmLog.insertDmLog({ guildId: guild, userId: user, channelId: CHANNEL, messageId: msg(n), key, params, lang });
    if (daysAgo) await q('UPDATE bot_dm_log SET created_at = NOW() - ($2::int * INTERVAL \'1 day\') WHERE message_id = $1', [msg(n), daysAgo]);
}

test('schema v13 applies twice in a row and only creates: columns, indexes, existing rows kept', { skip }, async () => {
    await add(1);
    for (let round = 0; round < 2; round += 1) {
        for (const statement of schema.tableStatements) await q(statement);
        for (const statement of schema.indexStatements) await q(statement);
    }
    const { rows: columns } = await q(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_name = 'bot_dm_log' ORDER BY ordinal_position`);
    assert.deepEqual(columns.map((c) => `${c.column_name}:${c.is_nullable}`), [
        'id:NO', 'guild_id:NO', 'user_id:NO', 'channel_id:NO', 'message_id:NO', 'template_key:NO', 'params:NO', 'lang:NO', 'created_at:NO',
    ]);
    assert.equal(columns.find((c) => c.column_name === 'params').data_type, 'jsonb');
    const { rows: indexes } = await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'bot_dm_log'`);
    for (const name of ['idx_bot_dm_log_user', 'idx_bot_dm_log_created', 'bot_dm_log_message_id_key']) {
        assert.ok(indexes.some((i) => i.indexname === name), name);
    }
    const { rows } = await q('SELECT template_key, params FROM bot_dm_log WHERE message_id = $1', [msg(1)]);
    assert.deepEqual(rows, [{ template_key: 'enf.warn', params: { rec: { case_code: 'abc23' } } }]);
});

test('one row per message: a second insert of the same message changes nothing', { skip }, async () => {
    await add(2, { lang: 'de' });
    await add(2, { lang: 'fr' });
    const { rows } = await q('SELECT lang FROM bot_dm_log WHERE message_id = $1', [msg(2)]);
    assert.deepEqual(rows.map((r) => r.lang), ['de']);
});

test('the re-edit list: this member and server, last 30 days, not in the new language yet, newest first, bounded', { skip }, async () => {
    const user = u(10);
    await add(10, { user, daysAgo: 3 });
    await add(11, { user, daysAgo: 1 });
    await add(12, { user, lang: 'fr' });                  // already in French
    await add(13, { user, daysAgo: 31 });                 // too old
    await add(14, { user, guild: g(2) });                 // another server
    await add(15, { user: u(11) });                       // another member
    const rows = await dmLog.listDmsToRelang({ guildId: g(1), userId: user, lang: 'fr' });
    assert.deepEqual(rows.map((r) => r.message_id), [msg(11), msg(10)]);
    assert.equal(rows[0].template_key, 'enf.warn');
    assert.deepEqual(rows[0].params, { rec: { case_code: 'abc23' } });
    assert.equal(rows[0].channel_id, CHANNEL);
    assert.equal((await dmLog.listDmsToRelang({ guildId: g(1), userId: user, lang: 'fr', limit: 1 })).length, 1);

    await dmLog.setDmLogLang(rows[0].id, 'fr');
    await dmLog.deleteDmLogRow(rows[1].id);
    assert.deepEqual(await dmLog.listDmsToRelang({ guildId: g(1), userId: user, lang: 'fr' }), []);
});

test('retention: rows older than 30 days go, newer ones stay (the daily job runs the rule)', { skip }, async () => {
    const user = u(20);
    await add(20, { user, daysAgo: 29 });
    await add(21, { user, daysAgo: 31 });
    await add(22, { user, daysAgo: 400 });
    assert.equal(retention.RETENTION_DAYS.bot_dm_log, 30);
    const rule = retention.RETENTION_RULES.find(([name]) => name === 'bot_dm_log')[1];
    const removed = await rule({});
    assert.ok(removed >= 2);
    const { rows } = await q('SELECT message_id FROM bot_dm_log WHERE user_id = $1', [user]);
    assert.deepEqual(rows.map((r) => r.message_id), [msg(20)]);
    const result = await retention.runRetention(null, { rules: retention.RETENTION_RULES.filter(([name]) => name === 'bot_dm_log') });
    assert.deepEqual(result.failed, []);
});

test('/wipedata deletes the member\'s logged DMs (every server), nobody else\'s', { skip }, async () => {
    const me = u(30);
    await add(30, { user: me });
    await add(31, { user: me, guild: g(2) });
    await add(32, { user: u(31) });
    const store = { exists: async () => false, delete: async () => true };
    const result = await wipe.wipeMemberData({ db: store }, g(1), me, {
        removeBirthday: async () => {}, removeReminders: async () => {}, removeVerifiedGuilds: async () => {},
    });
    assert.ok(result.deleted.includes('dmlog'), JSON.stringify(result.failed.map((f) => f.id)));
    const { rows } = await q('SELECT user_id FROM bot_dm_log WHERE user_id = ANY($1)', [[me, u(31)]]);
    assert.deepEqual(rows.map((r) => r.user_id), [u(31)]);
});

test('a database error throws (never an empty list that looks like "nothing to edit")', { skip }, async () => {
    const tables = { bot_dm_log: 'bot_dm_log_does_not_exist' };
    await assert.rejects(dmLog.listDmsToRelang({ guildId: g(1), userId: u(1), lang: 'fr' }, { tables }));
    await assert.rejects(dmLog.pruneDmLog({ tables }));
    await assert.rejects(dmLog.deleteDmLogForUser(u(1), { tables }));
    await assert.rejects(dmLog.insertDmLog({ guildId: g(1), userId: u(1), channelId: CHANNEL, messageId: msg(99), key: 'k', params: {}, lang: 'en' }, { tables }));
});

test('migrate:check passes against the local test database at the expected version (v13)', { skip }, async () => {
    const { spawnSync } = await import('node:child_process');
    const { EXPECTED_SCHEMA_VERSION } = await import('../../src/config/database/schemaVersion.js');
    // The same check as `npm run migrate:check`, with this run's (local, test) database settings.
    const out = spawnSync(process.execPath, ['scripts/migrate.js', 'check'], { env: process.env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
    assert.ok(`${out.stdout}${out.stderr}`.includes(`v${EXPECTED_SCHEMA_VERSION}`));
});
