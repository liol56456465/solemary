// "Download my data" against the local test database: every query runs on the real schema
// (a wrong column name fails here), and the member's own rows come back.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, keys, exporter, enforcementDb;
const runId = String(Date.now()).slice(-9);
const guildId = `9${runId}00000051`;
const me = `9${runId}00000052`;
const other = `9${runId}00000053`;
const code = `x${runId.slice(-5)}`.replace(/[01lio]/g, 'z');

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    keys = await import('../../src/utils/database/keys.js');
    exporter = await import('../../src/services/privacy/dataExport.js');
    enforcementDb = await import('../../src/services/enforcement/db.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM user_levels WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM premium_orders WHERE user_id = $1', [me]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = $1', [code]);
    for (const table of ['mod_watchlist', 'no_contact_orders', 'automod_raid_incidents', 'incident_timelines', 'ticket_data', 'giveaways', 'invite_tracking']) {
        await pgDb.pool.query(`DELETE FROM ${table} WHERE guild_id = $1`, [guildId]).catch(() => {});
    }
    await pgDb.pool.query('DELETE FROM guilds WHERE id = $1', [guildId]).catch(() => {});
    await db.delete(`todo_${me}`);
    await db.delete(`oauth:tokens:${me}`);
    await pgDb.disconnect();
});

test('data export: all sections run on the real schema and return the member\'s rows', { skip }, async () => {
    await db.set(keys.getUserLevelKey(guildId, me), { xp: 70, level: 3, totalXp: 300 });
    await db.set(`todo_${me}`, { tasks: [{ id: 1, text: 'buy milk' }] });
    await pgDb.pool.query(`INSERT INTO premium_orders (user_id, username, plan_id, period, kind, amount_cents) VALUES ($1, 'me', 'pro', 'monthly', 'personal', 499)`, [me]);
    const file = await exporter.buildDataExport(me, { query: enforcementDb.query, readKey: async (key) => db.get(key) });
    assert.equal(file.levels.length, 1);
    assert.equal(file.levels[0].guild_id, guildId);
    assert.equal(Number(file.levels[0].xp), 70);
    assert.equal(file.planOrders.length, 1);
    assert.equal(file.planOrders[0].amount_cents, 499);
    assert.deepEqual(file.todoList.tasks, [{ id: 1, text: 'buy milk' }]);
    for (const [name] of exporter.EXPORT_SECTIONS) assert.ok(Array.isArray(file[name]), name);
    JSON.stringify(file); // serialisable (BigInt would throw)
});

test('data export: the entitled sections return the member\'s rows and leave others out', { skip }, async () => {
    const q = (text, params) => pgDb.pool.query(text, params);
    await q('INSERT INTO guilds (id) VALUES ($1) ON CONFLICT DO NOTHING', [guildId]);
    await q(`INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom)
        VALUES ($1, $2, $3, 'memyself', $4, 'casemod', 'warn', 'n', 'Spam', 'prebuilt')`, [guildId, code, me, other]);
    await q(`INSERT INTO mod_case_notes (case_code, author_id, author_username, text) VALUES ($1, $2, 'secretmod', 'Was rude in #general')`, [code, other]);
    await q(`INSERT INTO mod_case_evidence (case_code, kind, url, source_message_url, excerpt, added_by, added_by_username) VALUES
        ($1, 'link', 'https://discord.com/channels/1/2/3', 'https://discord.com/channels/1/2/3', 'memyself: my own words', $2, 'secretmod'),
        ($1, 'link', 'https://discord.com/channels/1/2/4', 'https://discord.com/channels/1/2/4', 'someoneelse: their words', $2, 'secretmod')`, [code, other]);
    await q(`INSERT INTO mod_watchlist (guild_id, user_id, reason, created_by) VALUES ($1, $2, 'alt suspicion', $3)`, [guildId, me, other]);
    await q(`INSERT INTO no_contact_orders (guild_id, user_a, user_b, until, created_by, reason) VALUES ($1, $2, $3, NOW() + INTERVAL '1 day', $3, 'keep apart')`, [guildId, me, other]);
    await q(`INSERT INTO automod_raid_incidents (guild_id, started_at, joiner_ids) VALUES ($1, NOW(), $2::jsonb)`, [guildId, JSON.stringify([other, me])]);
    const { rows: [timeline] } = await q(`INSERT INTO incident_timelines (guild_id, trigger_kind) VALUES ($1, 'raid') RETURNING id`, [guildId]);
    await q(`INSERT INTO incident_events (incident_id, at, kind, actor_id, target_id, detail) VALUES ($1, NOW(), 'gate_kick', $2, $3, 'new account')`, [timeline.id, other, me]);
    await q(`INSERT INTO ticket_data (guild_id, channel_id, data) VALUES ($1, $2, $3::jsonb)`, [guildId, `9${runId}00000054`, JSON.stringify({ userId: me, status: 'closed', reason: 'help', claimedBy: other, closedBy: other })]);
    await q(`INSERT INTO giveaways (guild_id, message_id, data) VALUES ($1, $2, $3::jsonb)`, [guildId, `9${runId}00000055`, JSON.stringify({ prize: 'Nitro', participants: [other, me], winnerIds: [me] })]);
    await q(`INSERT INTO invite_tracking (guild_id, inviter_id, invite_code, uses) VALUES ($1, $2, $3, 4)`, [guildId, me, `c${runId}`]);
    await db.set(`oauth:tokens:${me}`, { scope: 'identify guilds.join', tokens: 'CIPHERTEXT-NEVER-EXPORTED' });

    const file = await exporter.buildDataExport(me, { query: enforcementDb.query, readKey: async (key) => db.get(key) });
    const text = JSON.stringify(file);
    assert.deepEqual(file.caseNotes.map((n) => [n.case_code, n.text, n.who_wrote]), [[code, 'Was rude in #general', 'staff']]);
    assert.equal(file.caseEvidenceOwnMessages, undefined, 'evidence excerpts are not exported (username match is unsafe)');
    assert.ok(!text.includes('my own words'), 'no evidence text in the file');
    assert.equal(file.watchlist.length, 1);
    assert.equal(file.watchlist[0].reason, 'alt suspicion');
    assert.equal(file.noContactOrders.filter((o) => o.guild_id === guildId)[0].reason, 'keep apart');
    assert.equal(file.raidIncidentsJoined.filter((r) => r.guild_id === guildId).length, 1);
    assert.equal(file.raidTimelineEvents.filter((e) => String(e.incident_id) === String(timeline.id))[0].detail, 'new account');
    assert.equal(file.tickets.filter((t) => t.guild_id === guildId)[0].reason, 'help');
    assert.deepEqual(file.giveawayEntries.filter((g) => g.guild_id === guildId).map((g) => [g.prize, g.won]), [['Nitro', true]]);
    assert.equal(file.invitesCreated.filter((i) => i.guild_id === guildId)[0].uses, 4);
    assert.equal(file.oauthTokenStored, true);
    for (const leaked of [other, 'secretmod', 'someoneelse', 'their words', 'CIPHERTEXT-NEVER-EXPORTED']) {
        assert.ok(!text.includes(leaked), `${leaked} is not in the file`);
    }
});
