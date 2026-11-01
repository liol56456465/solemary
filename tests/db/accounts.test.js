// Mewvo accounts against the local test database (schema v8, no email): sign-up uniqueness,
// email nullable (v8 ALTER), find by Discord id (password reset through Discord), the Discord
// link with its bonus inside one transaction (6 months = 183 days of Pro really land in
// premium_subscriptions), two links at the same moment for slot 100, the same Discord id on
// two accounts at once, the 1-letter claim, deletion keeping the bonus row, account sessions,
// and the prune of accounts that never linked Discord.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
let pgDb, store, sessionStoreMod;
const runId = String(Date.now()).slice(-8);
const ids = [1, 2, 3, 4, 5, 6].map((n) => `7${runId}0000000${n}`);
let savedCounter = null;
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    const mod = await import('../../src/services/accounts/accountStore.js');
    store = mod.createAccountStore();
    sessionStoreMod = await import('../../src/services/dashboard/sessionStore.js');
    const { rows } = await pgDb.pool.query(`SELECT value FROM member_account_counters WHERE name = 'discord_links'`);
    savedCounter = rows[0] ? Number(rows[0].value) : null;
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM member_account_bonuses WHERE discord_user_id = ANY($1)', [ids]);
    await pgDb.pool.query('DELETE FROM premium_subscriptions WHERE user_id = ANY($1)', [ids]);
    await pgDb.pool.query(`DELETE FROM member_accounts WHERE username LIKE $1`, [`%\\_${runId}`]);
    await pgDb.pool.query(`DELETE FROM member_sessions WHERE username LIKE $1`, [`%${runId}%`]);
    if (savedCounter === null) await pgDb.pool.query(`DELETE FROM member_account_counters WHERE name = 'discord_links'`);
    else await pgDb.pool.query(`UPDATE member_account_counters SET value = $1 WHERE name = 'discord_links'`, [savedCounter]);
    await pgDb.disconnect();
});

const make = async (n) => (await store.createAccount({ username: `acc${n}_${runId}`, passwordHash: 'scrypt$1$1$1$x$y' })).account;

test('schema v8: member_accounts.email is nullable, still UNIQUE; accounts without email, unique usernames', { skip }, async () => {
    const { rows: [column] } = await pgDb.pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'member_accounts' AND column_name = 'email'`);
    assert.equal(column.is_nullable, 'YES');
    const a = await make(1);
    const b = await make(11);
    assert.equal(a.email, null);
    assert.equal(b.email, null, 'many accounts without email');
    await assert.rejects(store.createAccount({ username: `acc1_${runId}`, passwordHash: 'h' }), /already taken/);
    assert.equal((await store.findByLogin(`ACC1_${runId}`)).id, a.id);
    // An older row with an email keeps it; the address stays unique.
    await pgDb.pool.query('UPDATE member_accounts SET email = $2 WHERE id = $1', [a.id, `old${runId}@example.com`]);
    await assert.rejects(pgDb.pool.query('UPDATE member_accounts SET email = $2 WHERE id = $1', [b.id, `old${runId}@example.com`]), /unique|duplicate/i);
    const exported = await store.exportOf(b.id);
    assert.ok(!('email' in exported) && !('pending_email' in exported), 'no email fields for an account without one');
    assert.equal((await store.exportOf(a.id)).email, `old${runId}@example.com`);
});

test('bonuses: two links at the same moment for slot 100 get 100 and 101; 183 days of Pro land in premium_subscriptions', { skip }, async () => {
    const { rows: clash } = await pgDb.pool.query('SELECT 1 FROM member_account_bonuses WHERE link_number IN (100, 101)');
    assert.equal(clash.length, 0, 'local test DB has no real bonus rows at 100/101');
    await pgDb.pool.query(`INSERT INTO member_account_counters (name, value) VALUES ('discord_links', 99)
        ON CONFLICT (name) DO UPDATE SET value = 99`);
    const [a, b] = [await make(2), await make(3)];
    const started = Date.now();
    const both = await Promise.all([
        store.linkDiscord({ accountId: a.id, discordUserId: ids[1] }),
        store.linkDiscord({ accountId: b.id, discordUserId: ids[2] }),
    ]);
    assert.deepEqual(both.map((r) => r.bonus.linkNumber).sort(), [100, 101]);
    const winner = both.find((r) => r.bonus.linkNumber === 100);
    const loser = both.find((r) => r.bonus.linkNumber === 101);
    assert.equal(winner.bonus.pro, true);
    assert.equal(loser.bonus.pro, false);
    assert.equal(loser.premium, null);
    const { rows: subs } = await pgDb.pool.query('SELECT user_id, plan_id, source, started_at, expires_at FROM premium_subscriptions WHERE user_id = ANY($1) AND plan_id IS NOT NULL', [[ids[1], ids[2]]]);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].plan_id, 'pro');
    assert.equal(subs[0].source, 'bonus');
    const length = new Date(subs[0].expires_at).getTime() - started;
    assert.ok(length > 183 * DAY - 60000 && length < 183 * DAY + 60000, `183 days of Pro (got ${(length / DAY).toFixed(2)} days)`);

    // Found by the Discord id (the "Forgot password?" lookup).
    assert.equal((await store.findByDiscordId(ids[1])).id, (winner.account.id));
    assert.equal(await store.findByDiscordId('12345'), null);

    // Unlink and link again: no second bonus.
    await store.unlinkDiscord(a.id);
    assert.equal(await store.findByDiscordId(ids[1]), null);
    const relink = await store.linkDiscord({ accountId: a.id, discordUserId: ids[1] });
    assert.equal(relink.bonus.kind, 'repeat');
});

test('bonuses: the same Discord id on two accounts at the same moment links only one', { skip }, async () => {
    const [a, b] = [await make(4), await make(5)];
    const results = await Promise.allSettled([
        store.linkDiscord({ accountId: a.id, discordUserId: ids[3] }),
        store.linkDiscord({ accountId: b.id, discordUserId: ids[3] }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = results.find((r) => r.status === 'rejected');
    assert.match(failed.reason.userMessage, /already linked to another Mewvo account/);
    const { rows } = await pgDb.pool.query('SELECT COUNT(*)::int AS n FROM member_account_bonuses WHERE discord_user_id = $1', [ids[3]]);
    assert.equal(rows[0].n, 1);
});

test('1-letter claim (link number 1-30 only), deletion keeps the bonus row, account sessions, a new password', { skip }, async () => {
    await pgDb.pool.query(`UPDATE member_account_counters SET value = 0 WHERE name = 'discord_links'`);
    // Make link number 1 free for this run (only rows of this test file are ever at 1 in the local DB).
    const { rows: taken } = await pgDb.pool.query('SELECT discord_user_id FROM member_account_bonuses WHERE link_number = 1');
    assert.equal(taken.length, 0, 'local test DB has no real bonus row at 1');
    const a = await make(6);
    const linked = await store.linkDiscord({ accountId: a.id, discordUserId: ids[4] });
    assert.equal(linked.bonus.letter, true);
    const free = await store.freeLetters();
    const account = await store.findById(a.id);
    assert.equal(store.canClaimLetter(await store.bonusOf(ids[4]), account), true);
    const claimed = await store.claimLetter({ accountId: a.id, letter: free[0] });
    assert.equal(claimed.username, free[0]);
    await assert.rejects(store.claimLetter({ accountId: a.id, letter: free[1] }), /cannot claim/);

    await store.setPassword(a.id, 'scrypt$1$1$1$new$hash');
    const changed = await store.findById(a.id);
    assert.equal(changed.password_hash, 'scrypt$1$1$1$new$hash');
    assert.ok(changed.password_changed_at);

    const sessions = sessionStoreMod.createPgSessionStore({ query: (t, p) => pgDb.pool.query(t, p), table: 'member_sessions', ttlMs: 60000, accounts: true });
    const s1 = await sessions.create({ userId: null, username: `before link ${runId}`, accountId: a.id });
    const s2 = await sessions.create({ userId: ids[4], username: `linked ${runId}`, accountId: a.id });
    assert.equal((await sessions.get(s1.id)).userId, null);
    assert.equal((await sessions.get(s1.id)).accountId, String(a.id));
    assert.equal(await sessions.destroyForAccount(a.id, s2.id), 1);
    assert.equal(await sessions.get(s1.id), null);
    assert.ok(await sessions.get(s2.id));

    assert.equal(await store.deleteAccount(a.id), true);
    assert.equal(await store.findById(a.id), null);
    const bonus = await store.bonusOf(ids[4]);
    assert.equal(bonus.account_id, null);
    assert.equal(bonus.letter_claimed, free[0]);
    await pgDb.pool.query('DELETE FROM member_sessions WHERE account_id = $1', [a.id]);

    // A new account with that Discord id: no second bonus, and the bonus row points at it again.
    const b = await make(12);
    const again = await store.linkDiscord({ accountId: b.id, discordUserId: ids[4] });
    assert.equal(again.bonus.kind, 'repeat');
    assert.equal(String((await store.bonusOf(ids[4])).account_id), String(b.id));
});

test('prune: accounts that never linked Discord, older than 7 days; linked, unlinked-later and email-confirmed ones stay', { skip }, async () => {
    const old = await make(7);
    const linked = await make(8);
    const legacy = await make(9);
    const unlinked = await make(10);
    await store.linkDiscord({ accountId: linked.id, discordUserId: ids[5] });
    await pgDb.pool.query('UPDATE member_accounts SET email_confirmed_at = NOW() WHERE id = $1', [legacy.id]);
    await pgDb.pool.query('UPDATE member_account_bonuses SET account_id = $2 WHERE discord_user_id = $1', [ids[5], linked.id]);
    // "unlinked": had the bonus row of an earlier link, Discord removed since.
    await pgDb.pool.query(`INSERT INTO member_account_bonuses (discord_user_id, account_id, link_number) VALUES ($1, $2, (SELECT COALESCE(MAX(link_number), 0) + 1000 FROM member_account_bonuses))`, [ids[0], unlinked.id]);
    await pgDb.pool.query(`UPDATE member_accounts SET created_at = NOW() - INTERVAL '8 days' WHERE id = ANY($1)`, [[old.id, linked.id, legacy.id, unlinked.id]]);
    const result = await store.prune();
    assert.ok(result.accounts >= 1);
    assert.equal(await store.findById(old.id), null);
    for (const kept of [linked, legacy, unlinked]) assert.ok(await store.findById(kept.id), kept.username);
});
