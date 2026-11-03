// Raid timeline (schema v10: incident_timelines, incident_events) against the local test
// database (npm run test:db): open/close, the 2,000-event bound under concurrent writers
// (checked with a small bound), cascade purge after 90 days, guild scope, the merged
// sources (member_events, mod_cases, dashboard_audit) and a database error that throws.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, tl, query;
const runId = String(Date.now()).slice(-9);
const guildId = `7${runId}00000010`;
const otherGuild = `7${runId}00000011`;
const user = (n) => `5${runId}${String(n).padStart(8, '0')}`;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
let codeSeq = 0;
const code = () => {
    let n = Number(runId) * 100 + 40 + (codeSeq += 1);
    let out = '';
    for (let i = 0; i < 7; i += 1) { out += ALPHA[n % ALPHA.length]; n = Math.floor(n / ALPHA.length); }
    return out;
};
const codes = [];
const DAY = 86_400_000;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    tl = await import('../../src/services/automod/incidentTimeline.js');
    ({ query } = await import('../../src/services/enforcement/db.js'));
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM incident_timelines WHERE guild_id = ANY($1)', [[guildId, otherGuild]]);
    await pgDb.pool.query('DELETE FROM member_events WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM dashboard_audit WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]);
    await pgDb.disconnect();
});

test('open, record, close; another guild cannot read it; events come back in time order', { skip }, async () => {
    const store = tl.createTimelineStore();
    const startedAt = new Date(Date.now() - 10 * 60 * 1000);
    const id = await store.open({ guildId, startedAt });
    assert.match(id, /^\d+$/);
    assert.equal(await store.addEvent(id, { kind: 'panic', at: new Date(startedAt.getTime() + 2000), detail: 'Paused until 16:00 UTC' }), 'stored');
    assert.equal(await store.addEvent(id, { kind: 'lockdown_start', at: startedAt, detail: '10 accounts joined within 60 seconds' }), 'stored');
    assert.equal(await store.addEvent(id, { kind: 'gate_kick', targetId: user(1), detail: 'x'.repeat(400) }), 'stored');
    assert.equal(await store.addEvent(id, { kind: 'join', targetId: user(1) }), 'invalid');
    const events = await store.events(id);
    assert.deepEqual(events.map((e) => e.kind), ['lockdown_start', 'panic', 'gate_kick']);
    assert.equal(events[2].detail.length, 200);
    assert.equal(events[2].target_id, user(1));
    assert.equal(await store.close(id, { endedBy: user(90) }), true);
    assert.equal(await store.close(id, { endedBy: user(91) }), false, 'the end is set once');
    const row = await store.get(guildId, id);
    assert.equal(row.ended_by, user(90));
    assert.equal(row.event_count, 3);
    assert.equal(await store.get(otherGuild, id), null);
    assert.equal((await store.list(guildId))[0].id, id);
});

test('bound: concurrent writers never pass it; the rest are counted as dropped', { skip }, async () => {
    const store = tl.createTimelineStore({ maxEvents: 5 });
    const id = await store.open({ guildId });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.addEvent(id, { kind: 'automod', targetId: user(i), detail: `hit ${i}` })));
    assert.equal(results.filter((r) => r === 'stored').length, 5);
    assert.equal(results.filter((r) => r === 'dropped').length, 7);
    const { rows: [counts] } = await pgDb.pool.query('SELECT event_count, dropped_events FROM incident_timelines WHERE id = $1', [id]);
    assert.deepEqual(counts, { event_count: 5, dropped_events: 7 });
    const { rows: [{ n }] } = await pgDb.pool.query('SELECT COUNT(*)::int AS n FROM incident_events WHERE incident_id = $1', [id]);
    assert.equal(n, 5);
});

test('purge: 90 days after the end (or the start when never closed); events go with the incident', { skip }, async () => {
    const store = tl.createTimelineStore();
    const now = Date.now();
    const oldEnded = await store.open({ guildId, startedAt: new Date(now - 100 * DAY) });
    await store.addEvent(oldEnded, { kind: 'lockdown_start', at: new Date(now - 100 * DAY) });
    await store.close(oldEnded, { endedAt: new Date(now - 95 * DAY) });
    const oldOpen = await store.open({ guildId, startedAt: new Date(now - 91 * DAY) });
    const longButRecent = await store.open({ guildId, startedAt: new Date(now - 120 * DAY) });
    await store.close(longButRecent, { endedAt: new Date(now - 10 * DAY) });
    const fresh = await store.open({ guildId, startedAt: new Date(now - 1 * DAY) });
    await store.purge(now);
    assert.equal(await store.get(guildId, oldEnded), null);
    assert.equal(await store.get(guildId, oldOpen), null);
    assert.ok(await store.get(guildId, longButRecent), 'ended 10 days ago: kept');
    assert.ok(await store.get(guildId, fresh));
    const { rows: [{ n }] } = await pgDb.pool.query('SELECT COUNT(*)::int AS n FROM incident_events WHERE incident_id = $1', [oldEnded]);
    assert.equal(n, 0, 'events deleted with the incident (cascade)');
});

test('sources: joins/leaves, cases (not test, not voided), dashboard changes inside the window', { skip }, async () => {
    const store = tl.createTimelineStore();
    const start = new Date(Date.now() - 30 * 60 * 1000);
    const end = new Date(Date.now() - 5 * 60 * 1000);
    const id = await store.open({ guildId, startedAt: start });
    await store.close(id, { endedAt: end });
    const inside = new Date(start.getTime() + 60 * 1000);
    await pgDb.pool.query(`INSERT INTO member_events (guild_id, user_id, kind, created_at) VALUES ($1, $2, 'join', $3), ($1, $4, 'leave', $3), ($1, $5, 'join', $6)`,
        [guildId, user(1), inside, user(2), user(3), new Date(start.getTime() - 30 * 1000)]);
    const insertCase = async (fields) => {
        const row = { guild_id: guildId, case_code: code(), target_user_id: user(1), target_username: 'target', moderator_id: user(90), moderator_username: 'mod', type: 'kick', reason: 'r', prebuilt_or_custom: 'prebuilt', created_at: inside, ...fields };
        row.name = `${row.case_code}-name`;
        codes.push(row.case_code);
        const keys = Object.keys(row);
        await pgDb.pool.query(`INSERT INTO mod_cases (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => row[k]));
    };
    await insertCase({});
    await insertCase({ is_test: true });
    await insertCase({ voided_at: new Date() });
    await insertCase({ created_at: new Date(end.getTime() + 60 * 1000) });
    await pgDb.pool.query(`INSERT INTO dashboard_audit (guild_id, user_id, username, module, key, created_at) VALUES ($1, $2, 'admin', 'automod', 'lockdown', $3), ($1, $2, 'owner', 'owner', 'x', $3)`,
        [guildId, user(90), inside]);
    const incident = await store.get(guildId, id);
    const sources = await store.sources(guildId, incident);
    assert.deepEqual(sources.members.map((m) => m.kind).sort(), ['join', 'join', 'leave'], 'the join just before the lockdown (raid window) counts');
    assert.equal(sources.cases.length, 1);
    assert.equal(sources.audit.length, 1, 'Owner area changes are left out');
    assert.deepEqual(sources.truncated, { members: false, cases: false, audit: false });
    const built = tl.buildTimeline({ incident, events: await store.events(id), sources });
    assert.equal(built.header.joins, 2);
    assert.equal(built.header.actions.kick, 1);
});

test('database errors throw from the store and are swallowed by the recorders', { skip }, async () => {
    const broken = tl.createTimelineStore({ tables: { ...(await import('../../src/config/database/postgres.js')).pgConfig.tables, incident_timelines: 'incident_timelines_missing' } });
    await assert.rejects(broken.open({ guildId }));
    await assert.rejects(broken.addEvent('1', { kind: 'panic' }));
    tl.setTimelineStoreForTest(broken);
    try {
        assert.equal(await tl.openTimeline({ guildId }), null);
        assert.equal(await tl.addTimelineEvent('1', { kind: 'panic' }), 'failed');
    } finally {
        tl.setTimelineStoreForTest();
    }
    assert.ok(query, 'the default store uses the enforcement pool');
});
