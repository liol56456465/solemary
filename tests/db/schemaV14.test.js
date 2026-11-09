// Schema v14 (docs/features-v14.md) against the local test database (npm run test:db): the new
// tables voice_activity, invite_joins, invite_inviters, ticket_ratings and the invite_tracking
// deleted_at column. The statements apply twice and only create (existing rows kept); each table's
// columns, keys and indexes exist; the CHECK / UNIQUE / FK rules refuse bad rows (the failure
// paths: a refused write throws, nothing is half-written); deleting the server cascades.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const runId = String(Date.now()).slice(-9);
const g = (n) => `7${runId}${String(n).padStart(8, '0')}`;
const u = (n) => `6${runId}${String(n).padStart(8, '0')}`;
let pgDb, schema;
const q = (text, params) => pgDb.pool.query(text, params);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    schema = await import('../../src/utils/database/schema.js');
    for (const n of [1, 2]) await q('INSERT INTO guilds (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [g(n)]);
    for (const n of [1, 2, 3]) await q('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [u(n)]);
});

after(async () => {
    if (skip) return;
    await q('DELETE FROM guilds WHERE id LIKE $1', [`7${runId}%`]).catch(() => {});
    await q('DELETE FROM users WHERE id LIKE $1', [`6${runId}%`]).catch(() => {});
    await pgDb.disconnect();
});

async function columnsOf(table) {
    const { rows } = await q(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = $1 ORDER BY ordinal_position`, [table]);
    return rows.map((c) => `${c.column_name}:${c.is_nullable}`);
}

async function indexesOf(table) {
    const { rows } = await q('SELECT indexname FROM pg_indexes WHERE tablename = $1', [table]);
    return rows.map((r) => r.indexname);
}

/** A refused statement throws with the given SQLSTATE (23514 check, 23505 unique, 23503 FK, 23502 not null). */
async function refused(sql, params, code) {
    await assert.rejects(q(sql, params), (err) => {
        assert.equal(err.code, code, `${sql}: ${err.message}`);
        return true;
    });
}

test('schema v14 applies twice in a row and only creates: existing rows kept', { skip }, async () => {
    await q('INSERT INTO voice_activity (guild_id, user_id, voice_seconds) VALUES ($1, $2, 120)', [g(1), u(1)]);
    await q(`INSERT INTO invite_tracking (guild_id, inviter_id, invite_code, uses) VALUES ($1, $2, $3, 4)`, [g(1), u(1), `c${runId}`.slice(0, 20)]);
    await q(`INSERT INTO invite_joins (guild_id, user_id, source) VALUES ($1, $2, 'unknown')`, [g(1), u(2)]);
    await q('INSERT INTO invite_inviters (guild_id, user_id, bonus) VALUES ($1, $2, 3)', [g(1), u(1)]);
    await q(`INSERT INTO ticket_ratings (guild_id, kind, ref_id, expires_at) VALUES ($1, 'ticket', $2, NOW() + INTERVAL '7 days')`, [g(1), u(3)]);
    for (let round = 0; round < 2; round += 1) {
        for (const statement of schema.tableStatements) await q(statement);
        for (const statement of schema.indexStatements) await q(statement);
    }
    assert.equal((await q('SELECT voice_seconds FROM voice_activity WHERE guild_id = $1', [g(1)])).rows[0].voice_seconds, '120');
    assert.equal((await q('SELECT uses, deleted_at FROM invite_tracking WHERE guild_id = $1', [g(1)])).rows[0].uses, 4);
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM invite_joins WHERE guild_id = $1', [g(1)])).rows[0].n, 1);
    assert.equal((await q('SELECT bonus FROM invite_inviters WHERE guild_id = $1', [g(1)])).rows[0].bonus, 3);
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM ticket_ratings WHERE guild_id = $1', [g(1)])).rows[0].n, 1);
});

test('voice_activity: columns, key, index; defaults; bad values and unknown member refused', { skip }, async () => {
    assert.deepEqual(await columnsOf('voice_activity'), [
        'guild_id:NO', 'user_id:NO', 'voice_seconds:NO', 'voice_xp:NO', 'day:YES', 'day_minutes:NO', 'updated_at:NO',
    ]);
    const indexes = await indexesOf('voice_activity');
    for (const name of ['voice_activity_pkey', 'idx_voice_activity_seconds']) assert.ok(indexes.includes(name), name);

    await q('INSERT INTO voice_activity (guild_id, user_id) VALUES ($1, $2)', [g(2), u(1)]);
    const { rows } = await q('SELECT voice_seconds, voice_xp, day, day_minutes, updated_at FROM voice_activity WHERE guild_id = $1 AND user_id = $2', [g(2), u(1)]);
    assert.deepEqual({ ...rows[0], updated_at: rows[0].updated_at instanceof Date }, { voice_seconds: '0', voice_xp: '0', day: null, day_minutes: 0, updated_at: true });

    await refused('INSERT INTO voice_activity (guild_id, user_id) VALUES ($1, $2)', [g(2), u(1)], '23505');
    await refused('INSERT INTO voice_activity (guild_id, user_id, day_minutes) VALUES ($1, $2, 1441)', [g(2), u(2)], '23514');
    await refused('INSERT INTO voice_activity (guild_id, user_id, voice_xp) VALUES ($1, $2, -1)', [g(2), u(2)], '23514');
    await refused('INSERT INTO voice_activity (guild_id, user_id) VALUES ($1, $2)', [g(2), u(99)], '23503'); // no users row
    await refused('INSERT INTO voice_activity (guild_id, user_id) VALUES ($1, $2)', [g(99), u(2)], '23503'); // no guilds row
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM voice_activity WHERE user_id = $1', [u(2)])).rows[0].n, 0);
});

test('invite_tracking gets deleted_at (nullable); invite_joins: columns, indexes, source CHECK', { skip }, async () => {
    const tracking = await columnsOf('invite_tracking');
    assert.ok(tracking.includes('deleted_at:YES'), tracking.join(','));

    assert.deepEqual(await columnsOf('invite_joins'), [
        'id:NO', 'guild_id:NO', 'user_id:NO', 'inviter_id:YES', 'invite_code:YES', 'source:NO',
        'account_created_at:YES', 'joined_at:NO', 'left_at:YES', 'counted:NO',
    ]);
    const indexes = await indexesOf('invite_joins');
    for (const name of ['invite_joins_pkey', 'idx_invite_joins_inviter', 'idx_invite_joins_user', 'idx_invite_joins_joined']) {
        assert.ok(indexes.includes(name), name);
    }
    for (const source of ['invite', 'vanity', 'widget', 'discovery', 'bot', 'ambiguous', 'unknown', 'not_ready', 'no_permission']) {
        await q('INSERT INTO invite_joins (guild_id, user_id, source) VALUES ($1, $2, $3)', [g(2), u(3), source]);
    }
    // A 32-character (vanity) code fits; the member and inviter need no users row.
    await q(`INSERT INTO invite_joins (guild_id, user_id, inviter_id, invite_code, source) VALUES ($1, $2, $3, $4, 'vanity')`,
        [g(2), u(98), u(97), 'v'.repeat(32)]);
    const { rows } = await q('SELECT counted, joined_at FROM invite_joins WHERE guild_id = $1 AND user_id = $2', [g(2), u(98)]);
    assert.equal(rows[0].counted, true);
    assert.ok(rows[0].joined_at instanceof Date);

    await refused(`INSERT INTO invite_joins (guild_id, user_id, source) VALUES ($1, $2, 'raid')`, [g(2), u(3)], '23514');
    await refused('INSERT INTO invite_joins (guild_id, user_id, source) VALUES ($1, $2, NULL)', [g(2), u(3)], '23502');
    await refused(`INSERT INTO invite_joins (guild_id, user_id, source, invite_code) VALUES ($1, $2, 'invite', $3)`, [g(2), u(3), 'x'.repeat(33)], '22001');
    await refused(`INSERT INTO invite_joins (guild_id, user_id, source) VALUES ($1, $2, 'invite')`, [g(99), u(3)], '23503');
});

test('invite_inviters: columns, key, bonus range; one row per inviter per server', { skip }, async () => {
    assert.deepEqual(await columnsOf('invite_inviters'), [
        'guild_id:NO', 'user_id:NO', 'bonus:NO', 'reset_at:YES', 'updated_by:YES', 'updated_at:NO',
    ]);
    assert.ok((await indexesOf('invite_inviters')).includes('invite_inviters_pkey'));
    await q('INSERT INTO invite_inviters (guild_id, user_id, bonus) VALUES ($1, $2, 100000)', [g(2), u(1)]);
    await q('INSERT INTO invite_inviters (guild_id, user_id, bonus) VALUES ($1, $2, -100000)', [g(2), u(2)]);
    await refused('INSERT INTO invite_inviters (guild_id, user_id) VALUES ($1, $2)', [g(2), u(1)], '23505');
    await refused('INSERT INTO invite_inviters (guild_id, user_id, bonus) VALUES ($1, $2, 100001)', [g(2), u(3)], '23514');
    await refused('UPDATE invite_inviters SET bonus = bonus - 1 WHERE guild_id = $1 AND user_id = $2', [g(2), u(2)], '23514');
    assert.equal((await q('SELECT bonus FROM invite_inviters WHERE guild_id = $1 AND user_id = $2', [g(2), u(2)])).rows[0].bonus, -100000);
});

test('ticket_ratings: columns, indexes, CHECKs, one prompt per ticket / modmail', { skip }, async () => {
    assert.deepEqual(await columnsOf('ticket_ratings'), [
        'id:NO', 'guild_id:NO', 'kind:NO', 'ref_id:NO', 'ticket_number:YES', 'opener_id:YES', 'staff_id:YES', 'closer_id:YES',
        'priority:YES', 'prompted_at:NO', 'expires_at:NO', 'delivery:YES', 'rating:YES', 'rated_at:YES', 'comment:YES',
        'comment_at:YES', 'comment_flagged:NO',
    ]);
    const indexes = await indexesOf('ticket_ratings');
    for (const name of ['ticket_ratings_pkey', 'ticket_ratings_guild_id_kind_ref_id_key', 'idx_ticket_ratings_rated', 'idx_ticket_ratings_staff', 'idx_ticket_ratings_open']) {
        assert.ok(indexes.includes(name), name);
    }
    const insert = `INSERT INTO ticket_ratings (guild_id, kind, ref_id, expires_at, delivery, rating) VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', $4, $5)`;
    await q(insert, [g(2), 'ticket', u(1), 'dm', null]);
    await q(insert, [g(2), 'modmail', u(1), 'channel', 5]); // same ref, other kind: allowed
    const { rows } = await q('SELECT comment_flagged, prompted_at FROM ticket_ratings WHERE guild_id = $1 AND kind = $2', [g(2), 'ticket']);
    assert.equal(rows[0].comment_flagged, false);
    assert.ok(rows[0].prompted_at instanceof Date);

    await refused(insert, [g(2), 'ticket', u(1), 'dm', null], '23505');
    await refused(insert, [g(2), 'ticket', u(2), 'dm', 0], '23514');
    await refused(insert, [g(2), 'ticket', u(2), 'dm', 6], '23514');
    await refused(insert, [g(2), 'ticket', u(2), 'email', null], '23514');
    await refused(insert, [g(2), 'appeal', u(2), 'dm', null], '23514');
    await refused(`INSERT INTO ticket_ratings (guild_id, kind, ref_id) VALUES ($1, 'ticket', $2)`, [g(2), u(2)], '23502'); // expires_at required
    await refused(insert, [g(99), 'ticket', u(2), 'dm', null], '23503');
});

test('deleting the server cascades into every v14 table', { skip }, async () => {
    await q('DELETE FROM guilds WHERE id = $1', [g(2)]);
    for (const table of ['voice_activity', 'invite_joins', 'invite_inviters', 'ticket_ratings']) {
        const { rows } = await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE guild_id = $1`, [g(2)]);
        assert.equal(rows[0].n, 0, table);
    }
});
