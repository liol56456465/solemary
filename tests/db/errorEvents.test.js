// Schema v11 against the local test database (npm run test:db): error_events insert + prune to
// the newest 500, grouping and search, a DB error on read throws, the recorder end to end;
// community feeds accept kind 'twitch' (the widened CHECK) and still refuse unknown kinds.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, store, events, edb;
const runId = String(Date.now()).slice(-9);
const source = `zztest${runId}`;
const guild = `17${runId.padStart(16, '0')}`;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    store = await import('../../src/services/owner/errorEventStore.js');
    events = await import('../../src/utils/errorEvents.js');
    edb = await import('../../src/services/enforcement/db.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM error_events WHERE source LIKE $1', [`${source}%`]).catch(() => {});
    await pgDb.pool.query('DELETE FROM feeds WHERE guild_id = $1', [guild]).catch(() => {});
    await pgDb.disconnect();
});

const row = (i, over = {}) => events.errorEventRow({
    errorCode: i % 2 ? 'COMMAND_ERROR' : 'TASK_ERROR', errorType: 'unknown', source: `${source}${i % 2 ? 'a' : 'b'}`,
    guildId: guild, traceId: `int_${String(i).padStart(4, '0')}`, message: `boom ${i}`, ...over,
});

test('error_events: groups by code + source, newest sample, search by trace / code', { skip }, async () => {
    for (let i = 1; i <= 5; i += 1) await store.insertErrorEvent(row(i));
    const { groups, total } = await store.listErrorGroups({});
    assert.ok(total >= 5);
    const mine = groups.filter((g) => g.source.startsWith(source));
    assert.deepEqual(mine.map((g) => [g.error_code, g.source, g.count]), [['COMMAND_ERROR', `${source}a`, 3], ['TASK_ERROR', `${source}b`, 2]]);
    assert.equal(mine[0].sample_trace, 'int_0005');
    assert.equal(mine[0].message, 'boom 5');
    assert.equal(mine[0].guild_id, guild);
    assert.equal(mine[0].servers, 1);
    assert.ok(mine[0].last_seen instanceof Date);

    const byTrace = await store.listErrorGroups(store.parseErrorSearch('COMMAND_ERROR · int_0003'));
    assert.deepEqual(byTrace.groups.filter((g) => g.source.startsWith(source)).map((g) => g.count), [1]);
    const byCode = await store.listErrorGroups({ code: 'TASK_ERROR' });
    assert.ok(byCode.groups.every((g) => g.error_code === 'TASK_ERROR'));
});

test('error_events: the insert keeps only the newest 500 rows', { skip }, async () => {
    for (let i = 0; i < 510; i += 1) await store.insertErrorEvent(row(1000 + i, { source: `${source}p` }));
    const count = await pgDb.pool.query('SELECT COUNT(*)::int AS n FROM error_events');
    assert.equal(count.rows[0].n, 500);
    const newest = await pgDb.pool.query('SELECT message FROM error_events ORDER BY id DESC LIMIT 1');
    assert.equal(newest.rows[0].message, 'boom 1509');
    const oldestKept = await pgDb.pool.query('SELECT message FROM error_events ORDER BY id ASC LIMIT 1');
    assert.equal(oldestKept.rows[0].message, 'boom 1010');
});

test('error_events: a database error on read throws (never an empty list)', { skip }, async () => {
    const broken = (sql, params) => edb.query(sql.replaceAll('error_events', 'error_events_missing'), params);
    await assert.rejects(store.listErrorGroups({}, { query: broken }), /error_events_missing/);
    await assert.rejects(store.insertErrorEvent(row(1), { query: broken }), /error_events_missing/);
});

test('recorder end to end: handleTaskError writes one row with no user ID', { skip }, async () => {
    const { handleTaskError } = await import('../../src/utils/errorHandler.js');
    handleTaskError(`${source}task`, new Error('Missing Access for 1531096173786566697'), { guildId: guild });
    let found = null;
    for (let i = 0; i < 50 && !found; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        found = (await pgDb.pool.query('SELECT * FROM error_events WHERE source = $1', [`${source}task`])).rows[0] || null;
    }
    assert.ok(found, 'row written');
    assert.equal(found.guild_id, guild);
    assert.equal(found.message, 'Missing Access for <id>');
});

test('feeds: kind twitch is accepted (schema v11 CHECK), unknown kinds are refused', { skip }, async () => {
    await pgDb.pool.query('INSERT INTO feeds (guild_id, kind, source_id, channel_id) VALUES ($1, $2, $3, $4)', [guild, 'twitch', 'somestreamer', guild]);
    await pgDb.pool.query('INSERT INTO feeds (guild_id, kind, source_id, channel_id) VALUES ($1, $2, $3, $4)', [guild, 'youtube', 'UCabc', guild]);
    await assert.rejects(
        pgDb.pool.query('INSERT INTO feeds (guild_id, kind, source_id, channel_id) VALUES ($1, $2, $3, $4)', [guild, 'tiktok', 'x', guild]),
        /feeds_kind_check/,
    );
    const check = await pgDb.pool.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'feeds_kind_check'");
    assert.equal(check.rows.length, 1, 'exactly one kind check');
    assert.match(check.rows[0].def, /twitch/);
});
