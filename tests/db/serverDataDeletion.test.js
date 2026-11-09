// "Delete this server's data" against the local test database (npm run test:db): two servers with
// the same kinds of data; the preview counts server A's rows; a request waits the 7-day grace and
// can be cancelled; the daily job deletes A in full (cases with their notes, evidence, edits and
// appeals, levels, tickets, automod, snapshots, OAuth links, audit rows, settings, logging setup,
// key-value keys holding A's id) while server B is left exactly as it was; a member's reminder set
// in A stays theirs (only the server link goes); a new owner makes the request lapse; Mewvo's own
// servers are refused. Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const runId = String(Date.now()).slice(-9);
const A = `7${runId}0000051`;
const B = `7${runId}0000052`;
const USER = `8${runId}0000051`;
const OWNER_A = `8${runId}0000061`;
const OWNER_B = `8${runId}0000062`;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newCode = () => Array.from({ length: 7 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();
let pgDb, sd, dbMod;
const codes = {};
const q = (text, params) => pgDb.pool.query(text, params);
const noBot = { guilds: { cache: { get: () => undefined, has: () => false } }, users: { fetch: async () => ({ send: async () => {} }) } };
const texts = () => ({ done: (server) => `deleted ${server}` });

async function seed(g) {
    const code = newCode();
    codes[g] = code;
    await q(`INSERT INTO guilds (id, config) VALUES ($1, '{"logging": {"enabled": true}, "prefix": "!"}')`, [g]);
    await q(`INSERT INTO user_levels (guild_id, user_id, xp, level) VALUES ($1, $2, 50, 2)`, [g, USER]);
    await q(`INSERT INTO birthdays (guild_id, user_id, month, day) VALUES ($1, $2, 5, 6)`, [g, USER]);
    await q(`INSERT INTO ticket_data (guild_id, channel_id, data) VALUES ($1, $2, '{}')`, [g, `9${g.slice(1)}`]);
    // v14: a ticket rating (with a comment) of that ticket.
    await q(`INSERT INTO ticket_ratings (guild_id, kind, ref_id, opener_id, staff_id, expires_at, rating, rated_at, comment)
             VALUES ($1, 'ticket', $2, $3, '1', NOW() + interval '7 days', 4, NOW(), 'thanks')`, [g, `9${g.slice(1)}`, USER]);
    await q(`INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, status)
             VALUES ($1, $2, $3, 'alice', '1', 'mod', 'warn', $4, 'r', 'custom', 'expired')`, [g, code, USER, `w ${code}`]);
    await q(`INSERT INTO mod_case_notes (case_code, author_id, author_username, text) VALUES ($1, '1', 'mod', 'note')`, [code]);
    await q(`INSERT INTO mod_case_evidence (case_code, kind, url, added_by, added_by_username) VALUES ($1, 'link', 'https://x', '1', 'mod')`, [code]);
    await q(`INSERT INTO mod_case_edits (case_code, edited_by, edited_by_username, field, old_value, new_value) VALUES ($1, '1', 'mod', 'reason', 'a', 'b')`, [code]);
    await q(`INSERT INTO mod_ladder (guild_id, user_id, level, warns_since_level) VALUES ($1, $2, 0, 1)`, [g, USER]);
    const { rows: [appeal] } = await q(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, body, status) VALUES ('appeal', $1, $2, 'alice', $3, '{}', 'denied') RETURNING id`, [code, USER, g]);
    await q(`INSERT INTO mod_appeals (kind, user_id, username, guild_id, body, status) VALUES ('report', $1, 'alice', $2, '{}', 'closed')`, [USER, g]);
    await q(`INSERT INTO mod_watchlist (guild_id, user_id, reason, created_by) VALUES ($1, $2, 'watch', '1')`, [g, USER]);
    const { rows: [incident] } = await q(`INSERT INTO incident_timelines (guild_id, trigger_kind) VALUES ($1, 'raid') RETURNING id`, [g]);
    await q(`INSERT INTO incident_events (incident_id, at, kind) VALUES ($1, NOW(), 'join')`, [incident.id]);
    const { rows: [suggestion] } = await q(`INSERT INTO suggestions (guild_id, user_id, content) VALUES ($1, $2, 'idea') RETURNING id`, [g, USER]);
    await q(`INSERT INTO suggestion_votes (suggestion_id, user_id, vote) VALUES ($1, $2, 1)`, [suggestion.id, USER]);
    await q(`INSERT INTO server_snapshots (guild_id, summary, data) VALUES ($1, 's', '{}')`, [g]);
    await q(`INSERT INTO oauth_verified_guilds (user_id, guild_id) VALUES ($1, $2)`, [USER, g]);
    await q(`INSERT INTO dashboard_audit (guild_id, user_id, module, key, new) VALUES ($1, '1', 'welcome', 'channel', '"x"')`, [g]);
    await q(`INSERT INTO guild_settings (guild_id, data) VALUES ($1, '{"botLanguage": "de"}')`, [g]);
    await q(`INSERT INTO error_events (error_code, error_type, source, guild_id) VALUES ('X', 'system', 'test', $1)`, [g]);
    await q(`INSERT INTO reminders (user_id, guild_id, channel_id, text, due_at) VALUES ($1, $2, '1', 'remember', NOW() + interval '1 day')`, [USER, g]);
    await q(`INSERT INTO member_events (guild_id, user_id, kind) VALUES ($1, $2, 'join')`, [g, USER]);
    // Key-value: settings of several features, legacy shapes, and per-case / per-appeal marks.
    for (const key of [`guild:${g}:jointocreate`, `automod:settings:${g}`, `ticket_config_${g}`, `moderation_user_notes_${g}_${USER}`, `automod:contest:${code}`, `appeals:stale-reminded:${appeal.id}`]) {
        await q(`INSERT INTO temp_data (key, value) VALUES ($1, '{"v": 1}')`, [key]);
    }
    await q(`INSERT INTO cache_data (key, value) VALUES ($1, '{"v": 1}')`, [`cache:stats:${g}`]);
}

const KV_KEYS = (g) => [`guild:${g}:jointocreate`, `automod:settings:${g}`, `ticket_config_${g}`, `moderation_user_notes_${g}_${USER}`, `automod:contest:${codes[g]}`];

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    sd = await import('../../src/services/privacy/serverDataDeletion.js');
    dbMod = await import('../../src/services/enforcement/db.js');
    await q(`INSERT INTO users (id, username) VALUES ($1, 'alice') ON CONFLICT DO NOTHING`, [USER]);
    await seed(A);
    await seed(B);
    // An unrelated key that merely contains A's digits inside a longer number stays.
    await q(`INSERT INTO temp_data (key, value) VALUES ($1, '{}')`, [`guild:${A}9:config`]);
});

after(async () => {
    if (skip) return;
    for (const g of [A, B]) {
        await q('DELETE FROM mod_appeals WHERE guild_id = $1 OR case_code = $2', [g, codes[g]]).catch(() => {});
        await q('DELETE FROM mod_cases WHERE guild_id = $1', [g]).catch(() => {});
        for (const t of ['mod_ladder', 'mod_watchlist', 'incident_timelines', 'suggestions', 'server_snapshots', 'oauth_verified_guilds', 'dashboard_audit', 'guild_settings', 'error_events', 'member_events']) {
            await q(`DELETE FROM ${t} WHERE guild_id = $1`, [g]).catch(() => {});
        }
        await q('DELETE FROM guilds WHERE id = $1', [g]).catch(() => {});
        await q(`DELETE FROM temp_data WHERE key LIKE '%' || $1 || '%'`, [g]).catch(() => {});
        await q(`DELETE FROM cache_data WHERE key LIKE '%' || $1 || '%'`, [g]).catch(() => {});
        await q(`DELETE FROM temp_data WHERE key = ANY($1)`, [[`automod:contest:${codes[g]}`]]).catch(() => {});
        await q(`DELETE FROM dashboard_audit WHERE key = $1`, [`privacy.serverdata.${g}`]).catch(() => {});
    }
    await q(`DELETE FROM temp_data WHERE key LIKE 'appeals:stale-reminded:%' AND value = '{"v": 1}'::jsonb`).catch(() => {});
    await q('DELETE FROM reminders WHERE user_id = $1', [USER]).catch(() => {});
    await q('DELETE FROM users WHERE id = $1', [USER]).catch(() => {});
    await pgDb.disconnect();
});

const count = (preview, table) => preview.tables.filter((r) => r.table === table).reduce((n, r) => n + r.count, 0);
const options = () => ({ query: dbMod.query, withTransaction: dbMod.withTransaction });
let beforeB;

test('preview: counts per table and per kind for server A only (logging setup included)', { skip }, async () => {
    const p = await sd.previewServerData(A, { query: dbMod.query });
    assert.equal(count(p, 'mod_cases'), 1);
    assert.equal(count(p, 'mod_case_notes'), 1);
    assert.equal(count(p, 'mod_appeals'), 2, 'the appeal and the staff report');
    assert.equal(count(p, 'incident_events'), 1);
    assert.equal(count(p, 'suggestion_votes'), 1);
    assert.equal(count(p, 'reminders'), 1);
    assert.equal(count(p, 'ticket_ratings'), 1, 'v14 ticket ratings are counted (and deleted with the server)');
    assert.equal(p.kinds.logs, 1);
    assert.equal(p.kinds.kv, 5, 'the four feature keys + the cache key; not guild:<A>9:…, not per-case marks (counted with cases)');
    assert.equal(p.kinds.cases, 6, 'case, note, evidence, edit, ladder, contest mark');
    assert.equal(p.kinds.appeals, 3, 'appeal, report, stale-reminder mark');
    assert.equal(p.kinds.oauthLinks, 1);
    assert.equal(p.kinds.settings, 2, 'guild_settings + guilds row');
    beforeB = await sd.previewServerData(B, { query: dbMod.query });
    assert.deepEqual(beforeB.kinds, p.kinds, 'B holds the same kinds of data');
});

test('Mewvo\'s own servers are refused (nothing queried)', { skip }, async () => {
    for (const id of sd.HOME_GUILD_IDS) {
        await assert.rejects(sd.requestServerDeletion({ guildId: id, userId: OWNER_A, query: dbMod.query }), /refused/);
        await assert.rejects(sd.deleteServerData(id, { withTransaction: dbMod.withTransaction }), /refused/);
    }
});

test('grace period: a request is due after 7 days, a second click keeps it, Cancel removes it', { skip }, async () => {
    const first = await sd.requestServerDeletion({ guildId: A, userId: OWNER_A, now: T0, query: dbMod.query });
    assert.equal(first.created, true);
    const again = await sd.requestServerDeletion({ guildId: A, userId: OWNER_A, removeBot: true, now: T0 + DAY, query: dbMod.query });
    assert.equal(again.created, false);
    assert.equal(again.record.dueAt, first.record.dueAt, 'the pending request is not replaced');
    assert.equal((await sd.getDeletionRequest(A, { query: dbMod.query })).status, 'scheduled');
    const cancelled = await sd.cancelServerDeletion({ guildId: A, userId: OWNER_A, query: dbMod.query });
    assert.equal(cancelled.cancelled, true);
    assert.equal(await sd.getDeletionRequest(A, { query: dbMod.query }), null);
    assert.equal((await sd.cancelServerDeletion({ guildId: A, userId: OWNER_A, query: dbMod.query })).cancelled, false);
    // Cancelled: the job does nothing, even long after.
    const none = await sd.runDueDeletions(noBot, { ...options(), now: T0 + 30 * DAY, texts });
    assert.ok(!none.some((r) => r.guildId === A));
    assert.equal(count(await sd.previewServerData(A, { query: dbMod.query }), 'mod_cases'), 1);

    await sd.requestServerDeletion({ guildId: A, userId: OWNER_A, now: T0, query: dbMod.query });
    const early = await sd.listDueDeletions({ now: T0 + 7 * DAY - 60_000, query: dbMod.query });
    assert.ok(!early.some((r) => r.guildId === A), 'not due before 7 days');
    const due = await sd.listDueDeletions({ now: T0 + 7 * DAY + 1, query: dbMod.query });
    assert.ok(due.some((r) => r.guildId === A));
});

test('the job deletes all of server A and leaves server B exactly as it was', { skip }, async () => {
    const results = await sd.runDueDeletions(noBot, { ...options(), now: T0 + 7 * DAY + 1, texts, batchSize: 1 });
    const mine = results.find((r) => r.guildId === A);
    assert.equal(mine.result, 'deleted');
    assert.ok(mine.total >= 30);
    assert.equal(mine.dmDelivered, true);
    assert.ok(!results.some((r) => r.guildId === B), 'B was never requested');

    const afterA = await sd.previewServerData(A, { query: dbMod.query });
    assert.equal(afterA.total, 0, JSON.stringify(afterA.tables.filter((r) => r.count)));
    assert.equal(afterA.kinds.logs, 0);
    for (const key of KV_KEYS(A)) assert.equal((await q('SELECT 1 FROM temp_data WHERE key = $1', [key])).rowCount, 0, key);
    assert.equal((await q('SELECT 1 FROM cache_data WHERE key = $1', [`cache:stats:${A}`])).rowCount, 0);
    assert.equal((await q('SELECT 1 FROM temp_data WHERE key = $1', [`guild:${A}9:config`])).rowCount, 1, 'a longer number is another id');
    // The member's own reminder stays; only the server link is gone.
    const { rows: reminders } = await q('SELECT guild_id, channel_id FROM reminders WHERE user_id = $1 AND text = $2 ORDER BY guild_id NULLS FIRST', [USER, 'remember']);
    assert.deepEqual(reminders.map((r) => r.guild_id), [null, B]);
    // The member's own account row (users) is not server data.
    assert.equal((await q('SELECT 1 FROM users WHERE id = $1', [USER])).rowCount, 1);
    // The request record says done (and is no longer due).
    const record = await sd.getDeletionRequest(A, { query: dbMod.query });
    assert.equal(record.status, 'done');
    assert.equal((await sd.listDueDeletions({ now: T0 + 60 * DAY, query: dbMod.query })).some((r) => r.guildId === A), false);

    const afterB = await sd.previewServerData(B, { query: dbMod.query });
    assert.deepEqual(afterB.tables, beforeB.tables, 'B untouched, table by table');
    assert.deepEqual(afterB.kinds, beforeB.kinds);
    for (const key of KV_KEYS(B)) assert.equal((await q('SELECT 1 FROM temp_data WHERE key = $1', [key])).rowCount, 1, key);
});

test('deleteServerData touches nothing but the given server (direct call on A again: 0 rows, B unchanged)', { skip }, async () => {
    const again = await sd.deleteServerData(A, { withTransaction: dbMod.withTransaction });
    assert.equal(again.total, 0);
    assert.deepEqual((await sd.previewServerData(B, { query: dbMod.query })).tables, beforeB.tables);
    await assert.rejects(sd.deleteServerData(`${A}' OR '1'='1`, { withTransaction: dbMod.withTransaction }), /refused/);
});

test('a new owner during the grace period: the request lapses and nothing is deleted', { skip }, async () => {
    await sd.requestServerDeletion({ guildId: B, userId: OWNER_B, now: T0, query: dbMod.query });
    const client = { guilds: { cache: { get: (id) => (id === B ? { id: B, fetch: async () => ({ ownerId: OWNER_A }) } : undefined), has: (id) => id === B } } };
    const results = await sd.runDueDeletions(client, { ...options(), now: T0 + 8 * DAY, texts });
    assert.equal(results.find((r) => r.guildId === B).result, 'lapsed');
    assert.equal(await sd.getDeletionRequest(B, { query: dbMod.query }), null);
    assert.deepEqual((await sd.previewServerData(B, { query: dbMod.query })).tables, beforeB.tables);
});
