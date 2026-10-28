// The global bot blacklist (bot_blacklist) against the local test database: add, the one-active
// rule, list, undo (row kept as history), the gate cache in step, refusals that write nothing,
// and load() rebuilding the cache from the table.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, service, cache;
const runId = String(Date.now()).slice(-9);
const user = `7${runId}00000021`;
const guild = `7${runId}00000022`;
const owner = `7${runId}00000023`;
const actor = { userId: owner, username: 'owner' };
const opts = { isOwner: (id) => id === owner, protectedGuildIds: [`7${runId}00000099`] };

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    service = await import('../../src/services/owner/blacklistService.js');
    cache = await import('../../src/services/owner/blacklistCache.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM bot_blacklist WHERE target_id = ANY($1)', [[user, guild, owner, opts.protectedGuildIds[0]]]);
    cache.setBlacklistCache([]);
    await pgDb.disconnect();
});

test('bot_blacklist: add, one active entry per target, list, undo keeps history, cache follows', { skip }, async () => {
    const store = service.blacklistStore;
    const row = await store.add({ kind: 'user', targetId: user, reason: 'spam bot', actor }, opts);
    assert.equal(row.kind, 'user');
    assert.equal(row.target_id, user);
    assert.equal(row.added_by, owner);
    assert.ok(row.created_at instanceof Date);
    assert.deepEqual(cache.blacklistHit({ userId: user }), { kind: 'user' });

    await assert.rejects(store.add({ kind: 'user', targetId: user, reason: 'again', actor }, opts), /already blacklisted/);
    const g = await store.add({ kind: 'guild', targetId: guild, reason: 'raids', actor }, opts);
    assert.deepEqual(cache.blacklistHit({ userId: '1', guildId: guild }), { kind: 'guild' });

    const { active } = await store.list();
    assert.ok(active.some((r) => r.target_id === user) && active.some((r) => r.target_id === guild));

    const removed = await store.remove(String(row.id), actor);
    assert.equal(removed.removed_by, owner);
    assert.ok(removed.removed_at instanceof Date);
    assert.equal(cache.blacklistHit({ userId: user }), null);
    assert.equal(await store.remove(String(row.id), actor), null, 'undo works once');
    const after = await store.list();
    assert.ok(!after.active.some((r) => r.target_id === user));
    assert.ok(after.removed.some((r) => r.target_id === user), 'history kept');

    // Re-adding after an undo is allowed (only one ACTIVE entry per target).
    const again = await store.add({ kind: 'user', targetId: user, reason: 'back again', actor }, opts);
    assert.notEqual(again.id, row.id);

    // load() rebuilds the cache from the table.
    cache.setBlacklistCache([]);
    assert.equal(cache.blacklistHit({ userId: user }), null);
    const count = await service.loadBlacklist();
    assert.ok(count >= 2);
    assert.deepEqual(cache.blacklistHit({ userId: user }), { kind: 'user' });
    assert.deepEqual(cache.blacklistHit({ userId: '1', guildId: g.target_id }), { kind: 'guild' });
});

test('bot_blacklist: refused entries (owner, protected server, bad ID) write nothing', { skip }, async () => {
    const store = service.blacklistStore;
    await assert.rejects(store.add({ kind: 'user', targetId: owner, reason: 'x', actor }, opts), /never be blacklisted/);
    await assert.rejects(store.add({ kind: 'guild', targetId: opts.protectedGuildIds[0], reason: 'x', actor }, opts), /cannot be blacklisted/);
    await assert.rejects(store.add({ kind: 'user', targetId: 'abc', reason: 'x', actor }, opts), /Discord ID/);
    const { rows } = await pgDb.pool.query('SELECT 1 FROM bot_blacklist WHERE target_id = ANY($1)', [[owner, opts.protectedGuildIds[0]]]);
    assert.equal(rows.length, 0);
    await assert.rejects(pgDb.pool.query(`INSERT INTO bot_blacklist (kind, target_id, reason, added_by) VALUES ('role', $1, 'x', $2)`, [user, owner]), /check/i, 'kind is constrained');
});

test('bot state: maintenance and presence survive a restart (stored in the key-value store, applied on ready)', { skip }, async () => {
    const state = await import('../../src/services/owner/botStateService.js');
    const { botConfig } = await import('../../src/config/bot.js');
    const { deleteFromDb } = await import('../../src/utils/database.js');
    const before = botConfig.commands.maintenanceMode;
    const applied = [];
    const client = { user: { setPresence: (p) => applied.push(p) } };
    try {
        await state.setMaintenance(true);
        await state.savePresence(client, { status: 'idle', activityType: 'watching', activityText: 'the cats' });
        botConfig.commands.maintenanceMode = false; // "restart": the env default again
        applied.length = 0;
        const line = await state.applyStoredBotState(client);
        assert.equal(botConfig.commands.maintenanceMode, true);
        assert.deepEqual(applied, [{ status: 'idle', activities: [{ name: 'the cats', type: 3 }] }]);
        assert.match(line, /maintenance ON \(dashboard\)/);
        applied.length = 0;
        await state.applyStoredBotState(client, { testModeEnabled: true });
        assert.equal(applied.length, 0, 'test mode keeps its own presence');
    } finally {
        await deleteFromDb(state.MAINTENANCE_KEY).catch(() => {});
        await deleteFromDb(state.PRESENCE_KEY).catch(() => {});
        botConfig.commands.maintenanceMode = before;
    }
});
