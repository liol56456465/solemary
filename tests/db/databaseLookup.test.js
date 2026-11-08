// /database lookups against the local test database: every query runs on the real schema (a
// wrong column or table name fails here), the rows come back, and secrets stay hidden.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, lookupLib, enforcementDb, lookup;
const runId = String(Date.now()).slice(-9);
const guildId = `9${runId}00000061`;
const me = `9${runId}00000062`;
const code = `q${runId.slice(-5)}`.replace(/[01lio]/g, 'z');
const accountName = `dbl${runId}`;
const PASSWORD_HASH = `scrypt$dbl-secret-${runId}`;
const TOKEN_VALUE = `oauth-secret-${runId}`;
const SETTING_SECRET = `setting-secret-${runId}`;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    lookupLib = await import('../../src/services/owner/databaseLookup.js');
    enforcementDb = await import('../../src/services/enforcement/db.js');
    lookup = lookupLib.createDatabaseLookup({ query: enforcementDb.query });
    const q = (text, params) => pgDb.pool.query(text, params);
    await q(`INSERT INTO guilds (id, config) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET config = $2`, [guildId, { modmailBlocked: [me], disabledCategories: { fun: true } }]);
    await q(`INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom)
        VALUES ($1, $2, $3, 'dbl_target_100%', '9000000000000000001', 'mod', 'warn', 'Spam', 'spam 50% off', 'custom')`, [guildId, code, me]);
    await q(`INSERT INTO mod_case_notes (case_code, author_id, author_username, text) VALUES ($1, '9000000000000000001', 'mod', 'a note')`, [code]);
    await q(`INSERT INTO mod_ladder (guild_id, user_id, level, warns_since_level) VALUES ($1, $2, 1, 2)`, [guildId, me]);
    await q(`INSERT INTO guild_settings (guild_id, data) VALUES ($1, $2)`, [guildId, { modLogChannelId: '123', webhookToken: SETTING_SECRET }]);
    await q(`INSERT INTO member_accounts (username, password_hash, age_confirmed_at, terms_accepted_at, discord_user_id)
        VALUES ($1, $2, NOW(), NOW(), $3)`, [accountName, PASSWORD_HASH, me]);
    await db.set(`oauth:tokens:${me}`, { tokens: { access_token: TOKEN_VALUE }, scope: 'identify guilds.join' });
});

after(async () => {
    if (skip) return;
    const q = (text, params) => pgDb.pool.query(text, params).catch(() => {});
    await q('DELETE FROM mod_case_notes WHERE case_code = $1', [code]);
    await q('DELETE FROM mod_cases WHERE case_code = $1', [code]);
    await q('DELETE FROM mod_ladder WHERE guild_id = $1', [guildId]);
    await q('DELETE FROM guild_settings WHERE guild_id = $1', [guildId]);
    await q('DELETE FROM member_accounts WHERE username = $1', [accountName]);
    await q('DELETE FROM guilds WHERE id = $1', [guildId]);
    await db.delete(`oauth:tokens:${me}`);
    await pgDb.disconnect();
});

const allText = (result) => lookupLib.paginate(result).pages.join('\n') + JSON.stringify(result);

test('/database user on the real schema: every section runs; rows found; secrets hidden', { skip }, async () => {
    const result = await lookup.user(me);
    const byName = Object.fromEntries(result.sections.map((s) => [s.name, s]));
    assert.equal(byName['Cases against them'].count, 1);
    assert.equal(byName['Cases against them'].rows[0].case_code, code);
    assert.equal(byName['Warn ladder'].rows[0].level, 1);
    assert.equal(byName['Modmail blocked in'].rows[0].guild_id, guildId);
    assert.equal(byName['OAuth verification link'].count, 1);
    assert.equal(byName['OAuth verification link'].rows[0].status, 'stored');
    assert.equal(byName['Mewvo website account'].rows[0].account_name, accountName);
    const text = allText(result);
    assert.ok(!text.includes(PASSWORD_HASH));
    assert.ok(!text.includes(TOKEN_VALUE));
});

test('/database server, case, stats and search on the real schema', { skip }, async () => {
    const server = await lookup.server(guildId);
    const settings = server.sections.find((s) => s.name.startsWith('Settings'));
    assert.deepEqual(settings.rows.find((r) => r.setting === 'webhookToken').value, lookupLib.HIDDEN);
    assert.ok(!allText(server).includes(SETTING_SECRET));
    assert.ok(server.sections.find((s) => s.name.startsWith('Rows per table')).rows.some((r) => r.table === 'mod_cases' && r.rows === 1));

    const one = await lookup.caseByCode(code.toUpperCase());
    assert.equal(one.sections[0].rows[0].case_code, code);
    assert.equal(one.sections.find((s) => s.name === 'Staff notes').count, 1);

    const stats = await lookup.stats();
    assert.ok(stats.sections.find((s) => s.name === 'Rows per table').rows.some((r) => r.table === 'mod_cases' && r.rows >= 1));
    assert.ok(stats.sections.find((s) => s.name === 'Database size').rows[0].size);

    const hits = await lookup.search('50% off');
    assert.ok(hits.sections[0].rows.some((r) => r.case_code === code), 'literal % matched');
    const wildcard = await lookup.search(`${runId}_%`);
    assert.equal(wildcard.sections[0].rows.filter((r) => r.case_code === code).length, 0, '_ and % are not wildcards');
    const byName = await lookup.search('dbl_target_100%');
    assert.ok(byName.sections[0].rows.some((r) => r.case_code === code));
});

test('/database profile on the real schema: every section runs; cases, warns per server and ladder found; no secrets', { skip }, async () => {
    const result = await lookup.profile(me);
    const section = (name) => result.sections.find((s) => s.name === name);
    assert.equal(section('Cases against them').rows[0].case_code, code);
    assert.equal(section('Warns per server').rows[0].guild_id, guildId);
    assert.equal(Number(section('Warns per server').rows[0].warns), 1);
    assert.equal(section('Warn ladder').rows[0].level, 1);
    assert.equal(section('Mewvo website account').rows[0].account_name, accountName);
    assert.equal(section('OAuth verification link'), undefined, 'no OAuth record section in the profile');
    const text = allText(result);
    assert.ok(!text.includes(PASSWORD_HASH));
    assert.ok(!text.includes(TOKEN_VALUE));
});
