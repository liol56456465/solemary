// Scheduled messages (scheduled_messages) against the local test database (npm run test:db):
// create / list / edit / pause / resume / delete through the service, the 50-per-server limit
// under the per-guild lock, the claim compare-and-set, and the runner posting, rescheduling
// and pausing after 3 failures. Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, svc;
const runId = String(Date.now()).slice(-9);
const guildId = `7${runId}00000009`;
const fullGuildId = `7${runId}00000010`;
const channelId = `6${runId}00000001`;
const HOUR = 3_600_000;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    svc = await import('../../src/services/scheduledMessageService.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM scheduled_messages WHERE guild_id = ANY($1)', [[guildId, fullGuildId]]).catch(() => {});
    await pgDb.disconnect();
});

const input = (overrides = {}) => ({
    guildId, channelId, payload: { content: 'Hello', embed: { title: 'T', description: '', imageUrl: '', footer: '', colour: 0x9b59b6 } },
    schedule: { kind: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, timezone: 'Europe/Vilnius', createdBy: '200000000000000002', ...overrides,
});

test('scheduled_messages: create, list, edit, pause, resume, delete round-trip the row', { skip }, async () => {
    const now = Date.parse('2026-10-30T05:00:00Z');
    const row = await svc.createScheduledMessage(input(), { now });
    assert.equal(new Date(row.nextRunAt).toISOString(), '2026-10-30T07:00:00.000Z');
    assert.deepEqual(row.payload, { content: 'Hello', embed: { title: 'T', description: '', imageUrl: '', footer: '', colour: 0x9b59b6 } });
    const { rows: [raw] } = await pgDb.pool.query('SELECT * FROM scheduled_messages WHERE id = $1', [row.id]);
    assert.equal(raw.guild_id, guildId);
    assert.equal(raw.timezone, 'Europe/Vilnius');
    assert.equal(raw.paused, false);
    assert.equal(raw.failure_count, 0);
    assert.deepEqual(raw.schedule, { kind: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] });

    const list = await svc.listScheduledMessages(guildId);
    assert.deepEqual(list.map((m) => m.id), [row.id]);

    const { before: b, after: a } = await svc.updateScheduledMessage(guildId, row.id, { channelId, payload: { content: 'Edited' }, schedule: { kind: 'interval', date: '2026-10-30', time: '12:00', hours: 3 }, timezone: 'UTC' }, { now });
    assert.equal(b.payload.content, 'Hello');
    assert.equal(a.payload.content, 'Edited');
    assert.equal(new Date(a.nextRunAt).toISOString(), '2026-10-30T12:00:00.000Z');

    const paused = await svc.setScheduledMessagePaused(guildId, row.id, true, { now });
    assert.equal(paused.after.paused, true);
    const resumed = await svc.setScheduledMessagePaused(guildId, row.id, false, { now: Date.parse('2026-10-30T13:00:00Z') });
    assert.equal(new Date(resumed.after.nextRunAt).toISOString(), '2026-10-30T15:00:00.000Z');

    assert.equal((await svc.deleteScheduledMessage(guildId, row.id)).id, row.id);
    assert.equal(await svc.deleteScheduledMessage(guildId, row.id), null);
    await assert.rejects(svc.setScheduledMessagePaused(guildId, row.id, true), /no scheduled message/);
});

test('scheduled_messages: at most 50 per server, also when created at the same time', { skip }, async () => {
    const now = Date.now();
    const many = Array.from({ length: 53 }, () => svc.createScheduledMessage(input({ guildId: fullGuildId }), { now }).then(() => 'ok', (e) => e.userMessage || e.message));
    const results = await Promise.all(many);
    assert.equal(results.filter((r) => r === 'ok').length, 50);
    assert.ok(results.filter((r) => r !== 'ok').every((r) => /at most 50/.test(r)));
    const { rows: [{ count }] } = await pgDb.pool.query('SELECT COUNT(*)::int AS count FROM scheduled_messages WHERE guild_id = $1', [fullGuildId]);
    assert.equal(count, 50);
    await assert.rejects(pgDb.pool.query('UPDATE scheduled_messages SET failure_count = -1 WHERE guild_id = $1', [fullGuildId]), /check/i, 'failure_count is constrained');
});

test('scheduled_messages: the runner posts due rows once, reschedules, and pauses after 3 failures', { skip }, async () => {
    const created = await svc.createScheduledMessage(input({ schedule: { kind: 'interval', date: '2026-10-30', time: '09:00', hours: 1 }, timezone: 'UTC' }), { now: Date.parse('2026-10-30T08:00:00Z') });
    const store = svc.createScheduledMessageStore();
    // Only this test's row: the shared due() would also see other runs' rows.
    const scoped = { ...store, due: async (now) => (await store.due(now, 1000)).filter((r) => r.guildId === guildId) };
    const channel = { id: channelId, name: 'general' };
    const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
    const client = { isReady: () => true, guilds: { cache: new Map([[guildId, guild]]) } };
    const posts = [];
    let fail = false;
    const post = async (g, args) => {
        posts.push(args);
        if (fail) throw Object.assign(new Error('nope'), { userMessage: 'I am missing Send Messages in #general. Nothing was posted.' });
        return { message: { id: '900000000000000001' } };
    };
    const alerts = [];
    const postModLog = async (...args) => alerts.push(args);

    let now = Date.parse('2026-10-30T09:00:20Z');
    assert.equal((await svc.runDueScheduledMessages(client, { store: scoped, now, post, postModLog })).posted, 1);
    assert.equal((await svc.runDueScheduledMessages(client, { store: scoped, now: now + 1000, post, postModLog })).posted, 0, 'not twice');
    let { rows: [row] } = await pgDb.pool.query('SELECT * FROM scheduled_messages WHERE id = $1', [created.id]);
    assert.equal(row.next_run_at.toISOString(), '2026-10-30T10:00:00.000Z');
    assert.equal(row.last_message_id, '900000000000000001');
    assert.equal(posts[0].content, 'Hello');

    assert.equal(await store.claim(created.id, Date.parse('2026-10-30T09:00:00Z'), null), false, 'stale claim refused');

    fail = true;
    for (let i = 1; i <= 3; i += 1) {
        now += 3_600_000;
        await svc.runDueScheduledMessages(client, { store: scoped, now, post, postModLog });
        ({ rows: [row] } = await pgDb.pool.query('SELECT * FROM scheduled_messages WHERE id = $1', [created.id]));
        assert.equal(row.failure_count, i);
        assert.equal(row.paused, i === 3);
        assert.match(row.last_error, /missing Send Messages/);
    }
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0][1], 'system');
    now += HOUR;
    await svc.runDueScheduledMessages(client, { store: scoped, now, post, postModLog });
    assert.equal(posts.length, 4, 'paused: not tried again');
    const resumed = await svc.setScheduledMessagePaused(guildId, created.id, false, { now });
    assert.equal(resumed.after.failureCount, 0);
});
