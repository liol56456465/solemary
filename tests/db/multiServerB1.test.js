// Multi-server B1 against the local test database (npm run test:db): schema v12 migrates twice
// in a row without changing existing rows, IP checks stay within one server, a member restore
// only uses the tokens of members verified in the target's servers, and retention / wipedata
// clean up the new tables. Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const runId = String(Date.now()).slice(-9);
const g = (n) => `7${runId}${String(n).padStart(8, '0')}`;
const u = (n) => `6${runId}${String(n).padStart(8, '0')}`;
const MAIN = g(1);
const SUPPORT = g(2);
const A = g(3);
const B = g(4);
const config = { mainGuildId: MAIN, supportGuildId: SUPPORT };
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const caseCode = () => Array.from({ length: 7 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const codes = [];
let pgDb, db, schema, guard, oauth, backup, retention, wipe;
const q = (text, params) => pgDb.pool.query(text, params);
const hash = (n) => `${runId}ip${n}`.padEnd(64, '0');

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    schema = await import('../../src/utils/database/schema.js');
    guard = await import('../../src/services/verificationGuard.js');
    oauth = await import('../../src/services/oauthVerification.js');
    backup = await import('../../src/services/memberBackupService.js');
    retention = await import('../../src/services/privacy/retentionService.js');
    wipe = await import('../../src/services/wipedataService.js');
});

after(async () => {
    if (skip) return;
    const like = [`6${runId}%`];
    await q('DELETE FROM verification_ips WHERE user_id LIKE $1', like).catch(() => {});
    await q('DELETE FROM verification_guild_ips WHERE user_id LIKE $1', like).catch(() => {});
    await q('DELETE FROM oauth_verified_guilds WHERE user_id LIKE $1', like).catch(() => {});
    await q("DELETE FROM temp_data WHERE key LIKE 'oauth:tokens:' || $1", like).catch(() => {});
    await q('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]).catch(() => {});
    await pgDb.disconnect();
});

async function ban(guildId, n) {
    const code = caseCode();
    codes.push(code);
    await q(`INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom)
        VALUES ($1, $2, $3, 'banned', '1', 'mod', 'ban', $4, 'Spam', 'custom')`, [guildId, code, u(n), `b ${code}`]);
    return code;
}

test('schema v12 applies twice in a row; the pre-v12 IP rows are unchanged', { skip }, async () => {
    await q('INSERT INTO verification_ips (user_id, ip_hash, seen_at) VALUES ($1, $2, NOW())', [u(1), hash(1)]);
    for (let round = 0; round < 2; round += 1) {
        for (const statement of schema.tableStatements) await q(statement);
        for (const statement of schema.indexStatements) await q(statement);
    }
    const { rows: columns } = await q(
        `SELECT table_name, column_name, is_nullable FROM information_schema.columns
         WHERE table_name IN ('verification_guild_ips', 'oauth_verified_guilds') ORDER BY table_name, ordinal_position`);
    assert.deepEqual(columns.map((c) => `${c.table_name}.${c.column_name}:${c.is_nullable}`), [
        'oauth_verified_guilds.user_id:NO', 'oauth_verified_guilds.guild_id:NO', 'oauth_verified_guilds.authorized_at:NO', 'oauth_verified_guilds.verified_at:YES',
        'verification_guild_ips.guild_id:NO', 'verification_guild_ips.user_id:NO', 'verification_guild_ips.ip_hash:NO', 'verification_guild_ips.seen_at:NO',
    ]);
    const { rows: indexes } = await q(`SELECT indexname FROM pg_indexes WHERE tablename IN ('verification_guild_ips', 'oauth_verified_guilds') ORDER BY indexname`);
    for (const name of ['idx_oauth_verified_guilds_guild', 'idx_verification_guild_ips_seen', 'idx_verification_guild_ips_user']) {
        assert.ok(indexes.some((i) => i.indexname === name), name);
    }
    const { rows } = await q('SELECT ip_hash FROM verification_ips WHERE user_id = $1', [u(1)]);
    assert.deepEqual(rows.map((r) => r.ip_hash), [hash(1)], 'the old table keeps its row and its key');
});

test('IP checks per server: a ban in A does not hold a verification in B; home servers still see pre-v12 rows', { skip }, async () => {
    // u(10) is banned in A and verified there from network 10; u(11) verifies from the same network.
    await guard.recordIpHash(A, u(10), hash(10));
    await ban(A, 10);
    await guard.recordIpHash(B, u(11), hash(10));
    assert.deepEqual(await guard.bannedOnSameNetwork(B, u(11), hash(10), { config }), [], 'B does not learn about A\'s member');
    await guard.recordIpHash(A, u(11), hash(10));
    const inA = await guard.bannedOnSameNetwork(A, u(11), hash(10), { config });
    assert.deepEqual(inA.map((m) => m.user_id), [u(10)], 'A sees its own banned member');

    // A ban in B of someone who only verified in A: B has no row of that member on this network.
    await ban(B, 10);
    assert.deepEqual(await guard.bannedOnSameNetwork(B, u(11), hash(10), { config }), [], 'B\'s ban needs B\'s own IP row');

    // Pre-v12 row (verification_ips, no guild) of a main-server ban: main and support see it, A does not.
    await q('INSERT INTO verification_ips (user_id, ip_hash, seen_at) VALUES ($1, $2, NOW())', [u(12), hash(12)]);
    await ban(MAIN, 12);
    assert.deepEqual((await guard.bannedOnSameNetwork(MAIN, u(13), hash(12), { config })).map((m) => m.user_id), [u(12)]);
    assert.deepEqual((await guard.bannedOnSameNetwork(SUPPORT, u(13), hash(12), { config })).map((m) => m.user_id), [u(12)]);
    assert.deepEqual(await guard.bannedOnSameNetwork(A, u(13), hash(12), { config }), []);

    // The same member and network in two servers are two rows (the old key allowed only one).
    const { rows } = await q('SELECT guild_id FROM verification_guild_ips WHERE user_id = $1 ORDER BY guild_id', [u(11)]);
    assert.deepEqual(rows.map((r) => r.guild_id), [A, B].sort());
});

test('IP prune: 60 days in both tables; a ban keeps rows only in its own server', { skip }, async () => {
    const old = new Date(Date.now() - 61 * 86_400_000);
    const add = (guildId, n) => q('INSERT INTO verification_guild_ips (guild_id, user_id, ip_hash, seen_at) VALUES ($1, $2, $3, $4)', [guildId, u(n), hash(n), old]);
    await add(A, 20); // banned in A: kept
    await add(B, 20); // same member in B, no ban there: deleted
    await add(A, 21); // no ban: deleted
    await ban(A, 20);
    await q('INSERT INTO verification_ips (user_id, ip_hash, seen_at) VALUES ($1, $2, $3)', [u(22), hash(22), old]); // pre-v12, no ban: deleted
    assert.ok((await guard.pruneVerificationIpHashes({ config })) >= 3);
    const { rows } = await q('SELECT guild_id, user_id FROM verification_guild_ips WHERE user_id = ANY($1)', [[u(20), u(21)]]);
    assert.deepEqual(rows.map((r) => `${r.guild_id}:${r.user_id}`), [`${A}:${u(20)}`]);
    assert.equal((await q('SELECT 1 FROM verification_ips WHERE user_id = $1', [u(22)])).rowCount, 0);
});

test('restore scope: verified in A cannot be pulled into B or into Mewvo\'s own servers', { skip }, async () => {
    const token = { scope: 'identify guilds.join', tokens: 'encrypted', expiresAt: 0 };
    const legacy = u(30); // token from before v12, no rows
    const onlyA = u(31);
    const mainAndA = u(32);
    const heldA = u(33);
    for (const id of [legacy, onlyA, mainAndA, heldA]) await db.set(`oauth:tokens:${id}`, token);
    await oauth.recordAuthorization(onlyA, A, { hadToken: false, homeGuildId: MAIN });
    await oauth.markVerifiedIn(onlyA, A);
    // mainAndA had a pre-v12 token (verified at home) and now verifies in A too.
    await oauth.recordAuthorization(mainAndA, A, { hadToken: true, homeGuildId: MAIN });
    await oauth.markVerifiedIn(mainAndA, A);
    await oauth.recordAuthorization(heldA, A, { hadToken: false, homeGuildId: MAIN }); // held, never approved

    const mine = [legacy, onlyA, mainAndA, heldA];
    const scoped = (target) => backup.restorableUserIds(target, { config, env: {}, listUsers: async () => mine });
    assert.deepEqual(await scoped(B), []);
    assert.deepEqual(await scoped(A), [onlyA, mainAndA]);
    assert.deepEqual(await scoped(MAIN), [legacy, mainAndA]);
    assert.deepEqual(await scoped(SUPPORT), [legacy, mainAndA], 'a verification in A never adds anyone to Support');

    // A fresh authorization (no token stored any more) drops rows left from an older token.
    await oauth.recordAuthorization(mainAndA, B, { hadToken: false, homeGuildId: MAIN });
    const { rows } = await q('SELECT guild_id, verified_at FROM oauth_verified_guilds WHERE user_id = $1', [mainAndA]);
    assert.deepEqual(rows.map((r) => [r.guild_id, r.verified_at]), [[B, null]]);

    assert.equal(await oauth.hasVerifiedIn(legacy, [MAIN], { homeIds: [MAIN, SUPPORT] }), true);
    assert.equal(await oauth.hasVerifiedIn(onlyA, [MAIN, SUPPORT], { homeIds: [MAIN, SUPPORT] }), false, 'the main join gate does not trust A');
    assert.equal(await oauth.hasVerifiedIn(onlyA, [A], { homeIds: [MAIN, SUPPORT] }), true);
    assert.equal(await oauth.hasVerifiedIn(u(39), [MAIN], { homeIds: [MAIN, SUPPORT] }), false, 'no token: never');
});

test('retention: verified-server rows go a day after their token is gone; wipedata removes them with the token', { skip }, async () => {
    const withToken = u(40);
    const orphan = u(41);
    const recentOrphan = u(42);
    await db.set(`oauth:tokens:${withToken}`, { scope: 'identify guilds.join', tokens: 'encrypted' });
    const add = (id, days) => q(`INSERT INTO oauth_verified_guilds (user_id, guild_id, authorized_at, verified_at) VALUES ($1, $2, NOW() - ($3::int * INTERVAL '1 day'), NOW())`, [id, A, days]);
    await add(withToken, 5);
    await add(orphan, 5);
    await add(recentOrphan, 0);
    assert.ok((await retention.pruneOAuthVerifiedGuilds()) >= 1);
    const { rows } = await q('SELECT user_id FROM oauth_verified_guilds WHERE user_id = ANY($1) ORDER BY user_id', [[withToken, orphan, recentOrphan]]);
    assert.deepEqual(rows.map((r) => r.user_id), [withToken, recentOrphan]);

    const result = await wipe.wipeMemberData({ db }, A, withToken);
    assert.ok(result.deleted.includes('oauth'));
    assert.equal(await db.exists(`oauth:tokens:${withToken}`), false);
    assert.equal((await q('SELECT 1 FROM oauth_verified_guilds WHERE user_id = $1', [withToken])).rowCount, 0);
});
