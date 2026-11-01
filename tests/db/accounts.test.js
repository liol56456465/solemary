// Mewvo accounts against the local test database (schema v7): sign-up uniqueness, single-use
// tokens, the Discord link with its bonus inside one transaction (the Pro month really lands in
// premium_subscriptions), two links at the same moment for slot 100, the same Discord id on
// two accounts at once, the 1-letter claim, deletion keeping the bonus row, account sessions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
let pgDb, store, core, sessionStoreMod;
const runId = String(Date.now()).slice(-8);
const ids = [1, 2, 3, 4, 5].map((n) => `7${runId}0000000${n}`);
let savedCounter = null;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    const mod = await import('../../src/services/accounts/accountStore.js');
    store = mod.createAccountStore();
    core = await import('../../src/services/accounts/accountCore.js');
    sessionStoreMod = await import('../../src/services/dashboard/sessionStore.js');
    const { rows } = await pgDb.pool.query(`SELECT value FROM member_account_counters WHERE name = 'discord_links'`);
    savedCounter = rows[0] ? Number(rows[0].value) : null;
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM member_account_bonuses WHERE discord_user_id = ANY($1)', [ids]);
    await pgDb.pool.query('DELETE FROM premium_subscriptions WHERE user_id = ANY($1)', [ids]);
    await pgDb.pool.query(`DELETE FROM member_accounts WHERE email LIKE $1`, [`%@t${runId}.example`]);
    await pgDb.pool.query(`DELETE FROM member_sessions WHERE username LIKE $1`, [`%${runId}%`]);
    if (savedCounter === null) await pgDb.pool.query(`DELETE FROM member_account_counters WHERE name = 'discord_links'`);
    else await pgDb.pool.query(`UPDATE member_account_counters SET value = $1 WHERE name = 'discord_links'`, [savedCounter]);
    await pgDb.disconnect();
});

const make = async (n) => (await store.createAccount({ username: `acc${n}_${runId}`, email: `a${n}@t${runId}.example`, passwordHash: 'scrypt$1$1$1$x$y' })).account;

test('accounts: unique names and emails, single-use confirmation tokens', { skip }, async () => {
    const a = await make(1);
    assert.equal(a.email_confirmed_at, null);
    assert.deepEqual(await store.createAccount({ username: `other_${runId}`, email: `a1@t${runId}.example`, passwordHash: 'h' }), { emailTaken: true });
    await assert.rejects(store.createAccount({ username: `acc1_${runId}`, email: `zz@t${runId}.example`, passwordHash: 'h' }), /already taken/);
    const { token, hash } = core.createToken();
    await store.saveToken({ accountId: a.id, purpose: 'confirm', hash, email: a.email, ttlMs: 60000 });
    assert.ok(await store.peekToken(token, 'confirm'));
    assert.equal(await store.peekToken(token, 'reset'), null);
    const [x, y] = await Promise.all([store.confirmEmail(token), store.confirmEmail(token)]);
    assert.equal([x, y].filter((r) => r.account).length, 1, 'used exactly once');
    assert.ok((await store.findById(a.id)).email_confirmed_at);
    const { rows } = await pgDb.pool.query('SELECT token_hash FROM member_account_tokens WHERE account_id = $1', [a.id]);
    assert.ok(rows.every((r) => r.token_hash !== token), 'only the hash is stored');
});

test('bonuses: two links at the same moment for slot 100 get 100 and 101; Pro lands in premium_subscriptions', { skip }, async () => {
    const { rows: clash } = await pgDb.pool.query('SELECT 1 FROM member_account_bonuses WHERE link_number IN (100, 101)');
    assert.equal(clash.length, 0, 'local test DB has no real bonus rows at 100/101');
    await pgDb.pool.query(`INSERT INTO member_account_counters (name, value) VALUES ('discord_links', 99)
        ON CONFLICT (name) DO UPDATE SET value = 99`);
    const [a, b] = [await make(2), await make(3)];
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
    const { rows: subs } = await pgDb.pool.query('SELECT user_id, plan_id, source FROM premium_subscriptions WHERE user_id = ANY($1) AND plan_id IS NOT NULL', [[ids[1], ids[2]]]);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].plan_id, 'pro');
    assert.equal(subs[0].source, 'bonus');

    // Unlink and link again: no second bonus.
    await store.unlinkDiscord(a.id);
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

test('1-letter claim (link number 1-30 only), deletion keeps the bonus row, account sessions', { skip }, async () => {
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
});

test('prune: unconfirmed accounts older than 7 days', { skip }, async () => {
    const old = await make(7);
    await pgDb.pool.query(`UPDATE member_accounts SET created_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [old.id]);
    const result = await store.prune();
    assert.ok(result.accounts >= 1);
    assert.equal(await store.findById(old.id), null);
});

test('security review: reset confirms the email and uses up every open link; setPassword too; a pending email blocks nobody', { skip }, async () => {
    const a = await make(9);
    const confirm = core.createToken();
    await store.saveToken({ accountId: a.id, purpose: 'confirm', hash: confirm.hash, email: a.email, ttlMs: 60000 });
    const reset = core.createToken();
    await store.saveToken({ accountId: a.id, purpose: 'reset', hash: reset.hash, ttlMs: 60000 });
    const done = await store.resetPassword(reset.token, 'scrypt$1$1$1$new$hash');
    assert.ok(done.account.email_confirmed_at, 'the reset link confirmed the email');
    assert.equal(done.account.password_hash, 'scrypt$1$1$1$new$hash');
    assert.deepEqual(await store.confirmEmail(confirm.token), { error: 'used' }, 'the old confirm link is used up');

    assert.deepEqual(await store.setPendingEmail(a.id, `pending9@t${runId}.example`), { ok: true });
    const change = core.createToken();
    await store.saveToken({ accountId: a.id, purpose: 'email_change', hash: change.hash, email: `pending9@t${runId}.example`, ttlMs: 60000 });
    const other = await store.createAccount({ username: `acc10_${runId}`, email: `pending9@t${runId}.example`, passwordHash: 'h' });
    assert.ok(other.account, 'a pending email change does not block a sign-up');
    await store.setPassword(a.id, 'scrypt$1$1$1$newer$hash');
    assert.equal((await store.findById(a.id)).pending_email, null);
    assert.equal(await store.peekToken(change.token, null), null, 'the email change link is used up');
});
