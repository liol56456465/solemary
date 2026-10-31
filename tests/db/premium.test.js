// Premium (test checkout) against the local test database: purchase for me / as a gift in
// one transaction, redeem once (also when two redeems race), same plan adds time, another
// active plan is refused and leaves the key unused, owner keys, revoke, end, lists.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, service, store;
const runId = String(Date.now()).slice(-9);
const alice = `7${runId}00000031`;
const bob = `7${runId}00000032`;
const carol = `7${runId}00000033`;
const owner = { userId: `7${runId}00000034`, username: 'owner' };
const users = [alice, bob, carol, owner.userId];
const DAY = 24 * 3600 * 1000;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    service = await import('../../src/services/billing/premiumService.js');
    store = service.premiumStore;
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM premium_keys WHERE created_by = ANY($1) OR redeemed_by = ANY($1)', [users]);
    await pgDb.pool.query('DELETE FROM premium_orders WHERE user_id = ANY($1)', [users]);
    await pgDb.pool.query('DELETE FROM premium_subscriptions WHERE user_id = ANY($1)', [users]);
    await pgDb.disconnect();
});

test('premium: buy for me starts and then extends; another plan is refused and writes nothing', { skip }, async () => {
    const first = await store.purchase({ userId: alice, username: 'alice', planId: 'pro', period: 'monthly', kind: 'personal' });
    assert.equal(first.order.amount_cents, 499);
    assert.equal(first.order.test, true);
    assert.equal(first.subscription.plan_id, 'pro');
    const end1 = new Date(first.subscription.expires_at).getTime();
    assert.ok(Math.abs(end1 - (Date.now() + 30 * DAY)) < 60000);

    const second = await store.purchase({ userId: alice, username: 'alice', planId: 'pro', period: 'yearly', kind: 'personal' });
    assert.equal(second.order.amount_cents, 4990);
    assert.equal(new Date(second.subscription.expires_at).getTime(), end1 + 365 * DAY, 'added to the end date');

    await assert.rejects(store.purchase({ userId: alice, username: 'alice', planId: 'max', period: 'monthly', kind: 'personal' }), /already have Pro/);
    const { rows } = await pgDb.pool.query('SELECT COUNT(*)::int AS n FROM premium_orders WHERE user_id = $1', [alice]);
    assert.equal(rows[0].n, 2, 'the refused purchase left no order');

    const account = await store.accountOf(alice);
    assert.equal(account.subscription.plan_id, 'pro');
    assert.equal(account.orders.length, 2);
});

test('premium: a gift creates a key (not a plan); another account redeems it once; races redeem once', { skip }, async () => {
    const { order, key, subscription } = await store.purchase({ userId: bob, username: 'bob', planId: 'max', period: 'yearly', kind: 'gift' });
    assert.equal(subscription, null);
    assert.equal(order.key_code, key.code);
    assert.equal(key.duration_days, 365);
    assert.equal(service.normalizeKeyCode(key.code), key.code);
    assert.equal((await store.accountOf(bob)).subscription, null, 'the buyer has no plan from a gift');
    assert.equal((await store.accountOf(bob)).gifts[0].code, key.code);

    // Two redeems at once (different accounts): exactly one wins.
    const results = await Promise.allSettled([
        store.redeem({ code: key.code.toLowerCase(), userId: carol, username: 'carol' }),
        store.redeem({ code: key.code, userId: owner.userId, username: 'owner' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /already been used/);
    const winner = results.find((r) => r.status === 'fulfilled').value;
    assert.equal(winner.subscription.plan_id, 'max');
    const { rows: [row] } = await pgDb.pool.query('SELECT redeemed_by FROM premium_keys WHERE code = $1', [key.code]);
    assert.equal(row.redeemed_by, winner.key.redeemed_by);
    // Cleanup the race winner's plan so later tests start clean.
    await store.endSubscription(winner.key.redeemed_by, owner);
});

test('premium: owner keys, other active plan keeps the key unused, revoke, lists and end', { skip }, async () => {
    const keys = await store.generateKeys({ planId: 'normal', days: 30, count: 3, note: 'test batch', actor: owner });
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys.map((k) => k.code)).size, 3);
    assert.ok(keys.every((k) => k.source === 'owner' && k.note === 'test batch'));
    await assert.rejects(store.generateKeys({ planId: 'free', days: 30, count: 1, actor: owner }), /paid plan/);
    await assert.rejects(store.generateKeys({ planId: 'pro', days: 31, count: 1, actor: owner }), /durations/);
    await assert.rejects(store.generateKeys({ planId: 'pro', days: 30, count: 51, actor: owner }), /between 1 and 50/);

    // Alice has Pro: a Normal key is refused and stays unused.
    await assert.rejects(store.redeem({ code: keys[0].code, userId: alice }), /already have Pro/);
    const { rows: [still] } = await pgDb.pool.query('SELECT redeemed_at FROM premium_keys WHERE code = $1', [keys[0].code]);
    assert.equal(still.redeemed_at, null);

    // Carol has nothing active: redeem works; same plan again adds 30 days.
    const one = await store.redeem({ code: keys[0].code, userId: carol, username: 'carol' });
    const two = await store.redeem({ code: keys[1].code, userId: carol, username: 'carol' });
    assert.equal(new Date(two.subscription.expires_at).getTime(), new Date(one.subscription.expires_at).getTime() + 30 * DAY);

    const revoked = await store.revokeKey(keys[2].code, owner);
    assert.ok(revoked.revoked_at);
    assert.equal(await store.revokeKey(keys[2].code, owner), null, 'once');
    assert.equal(await store.revokeKey(keys[0].code, owner), null, 'a redeemed key cannot be cancelled');
    await assert.rejects(store.redeem({ code: keys[2].code, userId: alice }), /cancelled/);
    await assert.rejects(store.redeem({ code: 'MEWVO-2222-2222-2222', userId: alice }), /does not exist/);

    const unused = await store.listKeys({ status: 'unused' });
    assert.ok(!unused.rows.some((k) => keys.some((x) => x.code === k.code)));
    const revokedList = await store.listKeys({ status: 'revoked' });
    assert.ok(revokedList.rows.some((k) => k.code === keys[2].code));
    assert.ok(revokedList.counts.total >= 3);

    const active = await store.listActiveSubscriptions();
    assert.ok(active.some((s) => s.user_id === carol && s.plan_id === 'normal'));
    const ended = await store.endSubscription(carol, owner);
    assert.equal(ended.plan_id, 'normal');
    assert.equal((await store.accountOf(carol)).subscription, null);
    assert.equal(await store.endSubscription(carol, owner), null, 'nothing active any more');
    assert.ok((await store.listOrders(10)).some((o) => o.user_id === alice));
});
