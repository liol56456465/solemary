import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    orderedPair, buildIndex, getActiveOrdersFor, findViolation, enforceNoContact, noContactLines, setNoContactCacheForTests,
} = await import('../src/services/enforcement/noContactService.js');
const { panelSummaryLines } = await import('../src/handlers/enforcementPanel.js');
const { formatModLogLine } = await import('../src/services/automod/channelRouting.js');

const G = '100000000000000001';
const A = '200000000000000002';
const B = '30000000000000003'; // shorter, numerically smaller than A
const C = '400000000000000004';
const future = new Date(Date.now() + 3600000);

const usersOf = (...ids) => ({ has: (id) => ids.includes(id) });

test('pairs are stored smaller ID first (numerically, not as text)', () => {
    assert.deepEqual(orderedPair(A, B), [B, A]);
    assert.deepEqual(orderedPair(B, A), [B, A]);
});

test('index: both members see the order; expired orders are ignored at once', () => {
    const index = buildIndex([{ id: '7', guild_id: G, user_a: B, user_b: A, until: future }]);
    assert.equal(index.get(`${G}:${A}`)[0].otherId, B);
    assert.equal(index.get(`${G}:${B}`)[0].otherId, A);

    setNoContactCacheForTests([
        { id: '7', guild_id: G, user_a: B, user_b: A, until: future },
        { id: '8', guild_id: G, user_a: A, user_b: C, until: new Date(Date.now() - 1000) },
    ]);
    assert.deepEqual(getActiveOrdersFor(G, A).map((order) => order.id), [7]);
    assert.deepEqual(getActiveOrdersFor(G, C), []);
    assert.deepEqual(getActiveOrdersFor('999', A), [], 'other guild');
});

test('violation: mention or reply to the other member only', () => {
    const orders = [{ id: 7, otherId: B, until: future.getTime() }];
    assert.equal(findViolation({ mentions: { users: usersOf(C) } }, orders), null);
    assert.equal(findViolation({ mentions: { users: usersOf(B) } }, orders).how, 'mentioned');
    assert.equal(findViolation({ mentions: { users: usersOf(), repliedUser: { id: B } } }, orders).how, 'replied to');
    const cached = { author: { id: B } };
    const viaCache = {
        mentions: { users: usersOf(), repliedUser: null },
        reference: { messageId: 'm1' },
        channel: { messages: { cache: { get: (id) => (id === 'm1' ? cached : undefined) } } },
    };
    assert.equal(findViolation(viaCache, orders).how, 'replied to');
    assert.equal(findViolation({ mentions: { users: usersOf(B) } }, []), null);
});

function fakeMessage({ authorId, mentions = [], repliedUser = null }) {
    const sent = [];
    const message = {
        id: 'msg1',
        guild: { id: G },
        author: { id: authorId, username: 'alice', bot: false },
        mentions: { users: usersOf(...mentions), repliedUser },
        channel: { id: 'chan1', send: async (payload) => { sent.push(payload); return { delete: async () => {} }; } },
        client: { users: { cache: new Map([[B, { username: 'bob' }]]) }, guilds: { cache: new Map() } },
        deleted: false,
        delete: async () => { message.deleted = true; },
        sent,
    };
    return message;
}

test('enforce: deletes, notifies only the author, leaves other messages alone', async () => {
    setNoContactCacheForTests([{ id: '7', guild_id: G, user_a: B, user_b: A, until: future }]);

    const fine = fakeMessage({ authorId: A, mentions: [C] });
    assert.equal(await enforceNoContact(fine), false);
    assert.equal(fine.deleted, false);
    assert.equal(fine.sent.length, 0);

    const bad = fakeMessage({ authorId: A, mentions: [B] });
    assert.equal(await enforceNoContact(bad), true);
    assert.equal(bad.deleted, true);
    assert.equal(bad.sent.length, 1);
    assert.deepEqual(bad.sent[0].allowedMentions, { users: [A], parse: [] });
    assert.match(bad.sent[0].content, new RegExp(`^<@${A}> you have a no-contact order with \\*\\*bob\\*\\*`));

    const noOrder = fakeMessage({ authorId: C, mentions: [A] });
    assert.equal(await enforceNoContact(noOrder), false, 'C has no order');
});

test('panel summary and mod log line show no-contact orders', () => {
    const orders = [{ id: 7, otherId: B, until: Date.UTC(2030, 0, 1) }];
    assert.deepEqual(noContactLines(orders), [`with <@${B}> until <t:1893456000:f> (order #7)`]);
    const state = { member: null, banned: false, ladder: { level: 0, warns_since_level: 0 }, activeBan: null, activeMute: null, muted: false };
    const text = panelSummaryLines({ id: A, username: 'alice', createdAt: new Date(0) }, state, new Map(), orders).join('\n');
    assert.match(text, /\*\*No-contact order:\*\* with <@30000000000000003>/);

    assert.equal(
        formatModLogLine('nocontact', [{ name: 'User', value: 'alice (1)' }, { name: 'Note', value: 'message removed' }, { name: 'Order', value: '#7' }]),
        '🚧 **No-contact** · alice (1) · message removed · Order: #7',
    );
});
