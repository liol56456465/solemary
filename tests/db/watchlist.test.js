// Staff watchlist (mod_watchlist, schema v9) against the local test database (npm run test:db):
// add / duplicate / list / end / expiry / cache, and the failure path (DB error → throws, nothing
// shown as success, the in-memory cache unchanged). Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, wl;
const runId = String(Date.now()).slice(-9);
const guildId = `7${runId}00000009`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
const admin = { id: user(90), username: 'mod' };
const client = { guilds: { cache: new Map() }, users: { cache: new Map() } };

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    wl = await import('../../src/services/enforcement/watchlistService.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_watchlist WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.disconnect();
});

test('watchlist: add (no end / days), duplicate refused, cache, list, end, expiry', { skip }, async () => {
    const [a, b, c] = [user(1), user(2), user(3)];

    const first = await wl.addWatch(client, { guildId, userId: a, username: 'alice', reason: ' Alt of a banned member ', createdBy: admin });
    assert.equal(first.until, null, 'no end date by default');
    assert.equal(first.reason, 'Alt of a banned member');
    assert.equal(first.created_by, admin.id);
    assert.equal(wl.getActiveWatch(guildId, a).id, Number(first.id), 'cache refreshed');

    await assert.rejects(wl.addWatch(client, { guildId, userId: a, reason: 'again', createdBy: admin }),
        new RegExp(`already on the watchlist \\(#${first.id}\\)`));
    await assert.rejects(wl.addWatch(client, { guildId, userId: admin.id, reason: 'me', createdBy: admin }), /yourself/);
    await assert.rejects(wl.addWatch(client, { guildId, userId: b, isBot: true, reason: 'bot', createdBy: admin }), /Bots cannot/);
    await assert.rejects(wl.addWatch(client, { guildId, userId: b, days: 0, reason: 'x', createdBy: admin }), /between 1 and/);

    const second = await wl.addWatch(client, { guildId, userId: b, days: 3, reason: 'Raid suspect', createdBy: admin });
    assert.ok(Math.abs(new Date(second.until).getTime() - (Date.now() + 3 * 86400000)) < 60000);
    assert.deepEqual((await wl.listActiveWatches(guildId)).map((row) => Number(row.id)), [Number(second.id), Number(first.id)]);

    // End early: only in its own guild, only once.
    assert.equal(await wl.endWatch(client, { guildId: '1', id: Number(first.id), endedBy: admin }), null, 'other guild');
    const ended = await wl.endWatch(client, { guildId, id: Number(first.id), endedBy: admin });
    assert.equal(ended.ended_by, admin.id);
    assert.ok(ended.ended_at);
    assert.equal(await wl.endWatch(client, { guildId, id: Number(first.id), endedBy: admin }), null, 'already ended');
    assert.equal(wl.getActiveWatch(guildId, a), null);

    // A member whose entry ended may be added again.
    const again = await wl.addWatch(client, { guildId, userId: a, days: 1, reason: 'Back again', createdBy: admin });

    // Expiry: run out b and the new a entry; not alerting once past until, then the job ends them.
    await pgDb.pool.query(`UPDATE mod_watchlist SET until = NOW() - interval '1 minute' WHERE id = ANY($1::bigint[])`, [[second.id, again.id]]);
    await wl.refreshWatchlistCache();
    assert.equal(wl.getActiveWatch(guildId, b), null, 'not watched once past until');
    // An entry past its end but not yet marked ended does not block a new one.
    const third = await wl.addWatch(client, { guildId, userId: a, reason: 'Third', createdBy: admin });
    assert.ok(third.id);
    const c1 = await wl.addWatch(client, { guildId, userId: c, reason: 'No limit', createdBy: admin });
    const expired = await wl.expireWatchlist(client);
    assert.equal(expired, 1, 'only b was left to expire (the old a entry was closed by the new one)');
    const { rows } = await pgDb.pool.query('SELECT id, ended_at FROM mod_watchlist WHERE guild_id = $1 ORDER BY id', [guildId]);
    assert.ok(rows.find((r) => r.id === second.id).ended_at);
    assert.equal(rows.find((r) => r.id === c1.id).ended_at, null, 'no end date: never expires');
    assert.deepEqual((await wl.listActiveWatches(guildId)).map((row) => row.user_id).sort(), [a, c].sort());
    assert.equal(wl.getActiveWatch(guildId, a).id, Number(third.id));

    // The unique open entry lives in the database, not only in code.
    await assert.rejects(pgDb.pool.query(
        'INSERT INTO mod_watchlist (guild_id, user_id, reason, created_by) VALUES ($1, $2, $3, $4)', [guildId, c, 'dup', admin.id]
    ), (error) => error.code === '23505');
});

test('watchlist: a database error throws, the cache is kept and nothing is shown as success', { skip }, async () => {
    const target = user(11);
    const kept = await wl.addWatch(client, { guildId, userId: target, reason: 'Kept', createdBy: admin });
    const realQuery = pgDb.pool.query;
    pgDb.pool.query = async (text, params) => {
        if (/mod_watchlist/.test(String(text))) throw new Error('simulated failure');
        return realQuery.call(pgDb.pool, text, params);
    };
    try {
        await assert.rejects(wl.addWatch(client, { guildId, userId: user(12), reason: 'x', createdBy: admin }), /simulated failure/);
        await assert.rejects(wl.listActiveWatches(guildId), /simulated failure/);
        await assert.rejects(wl.endWatch(client, { guildId, id: Number(kept.id), endedBy: admin }), /simulated failure/);
        await assert.rejects(wl.refreshWatchlistCache(), /simulated failure/);
        await assert.rejects(wl.expireWatchlist(client), /simulated failure/);
        assert.equal(wl.getActiveWatch(guildId, target).id, Number(kept.id), 'the old cache stays in use');
        assert.equal(wl.getActiveWatch(guildId, user(12)), null);

        // /case watch add: the error reaches the dispatcher; no success reply is sent.
        const { default: command } = await import('../../src/commands/Enforcement/case.js');
        const { enforcementConfig } = await import('../../src/config/enforcement.js');
        const replies = [];
        const interaction = {
            id: 'i1', createdTimestamp: Date.now(), deferred: true, replied: false,
            guildId: enforcementConfig.mainGuildId,
            user: { id: admin.id, username: admin.username },
            member: { id: admin.id, permissions: { has: (bit) => bit === PermissionFlagsBits.Administrator } },
            options: {
                getSubcommandGroup: () => 'watch', getSubcommand: () => 'add',
                getUser: () => ({ id: user(12), username: 'eve', bot: false }),
                getInteger: () => null, getString: () => 'reason',
            },
            editReply: async (payload) => { replies.push(payload); },
            reply: async (payload) => { replies.push(payload); },
        };
        await assert.rejects(command.execute(interaction, {}, client), /simulated failure/);
        assert.equal(replies.length, 0, 'no success shown');
    } finally {
        pgDb.pool.query = realQuery;
    }
    const { rows } = await pgDb.pool.query('SELECT 1 FROM mod_watchlist WHERE guild_id = $1 AND user_id = $2', [guildId, user(12)]);
    assert.equal(rows.length, 0, 'nothing was stored');
    assert.equal((await wl.listActiveWatches(guildId)).some((row) => row.id === kept.id), true);
});
