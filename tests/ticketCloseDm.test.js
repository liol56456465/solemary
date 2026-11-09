// Audit 4.5: closing a ticket DMs the opener once (server named, transcript attached), not a
// closure DM and a separate transcript DM. Runs on the in-memory store (no POSTGRES_URL in unit
// tests); the rating survey needs Postgres (its row), so it is checked by the renderer tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/utils/database/wrapper.js');
const { MemoryStorage } = await import('../src/utils/memoryStorage.js');
// The in-memory store, set up directly: the test never tries to reach a database.
Object.assign(db, { db: new MemoryStorage(), useFallback: true, connectionType: 'memory', initialized: true, degradedModeWarningShown: true });
const { closeTicket } = await import('../src/services/ticket.js');
const { saveTicketData } = await import('../src/utils/database.js');

const GUILD = '100000000000000555';
const CHANNEL = '100000000000000556';
const OPENER = '200000000000000001';

function collection(items) {
    const map = new Map(items.map((m) => [m.id, m]));
    map.find = (fn) => [...map.values()].find(fn);
    map.last = () => [...map.values()].at(-1);
    return map;
}

function world() {
    const dms = [];
    const channelPosts = [];
    const opener = { id: OPENER, tag: 'opener#1', username: 'opener', send: async (p) => { dms.push(p); return { id: `dm${dms.length}`, channelId: 'dmch' }; } };
    const messages = [{ id: '1', author: { tag: 'opener#1' }, content: 'help', createdTimestamp: 1, embeds: [], attachments: new Map() }];
    const guild = {
        id: GUILD, name: 'Cat **Café**',
        members: { cache: new Map(), fetch: async () => null, me: null },
        channels: { cache: new Map(), fetch: async () => null },
    };
    const client = {
        users: { fetch: async (id) => (id === OPENER ? opener : null) },
        channels: { fetch: async () => null },
        guilds: { cache: new Map([[GUILD, guild]]) },
        db,
    };
    const channel = {
        id: CHANNEL, name: 'ticket-0042', guild, client, parentId: null, type: 0,
        permissionOverwrites: { cache: new Map(), create: async () => {}, edit: async () => {} },
        messages: { fetch: async (opts) => (opts && typeof opts === 'object' ? collection(opts.before ? [] : messages) : collection(messages)) },
        send: async (p) => { channelPosts.push(p); return { id: 'post' }; },
    };
    guild.client = client;
    return { dms, channelPosts, channel, client };
}

test('closing a ticket: one DM to the opener that names the server and carries the transcript', async () => {
    const w = world();
    await saveTicketData(GUILD, CHANNEL, { id: 42, userId: OPENER, status: 'open', createdAt: new Date().toISOString() });
    await closeTicket(w.channel, { id: '200000000000000002', tag: 'mod#1', toString: () => '<@200000000000000002>' }, 'Solved');
    const ticketDms = w.dms.filter((p) => p.embeds?.length);
    assert.equal(ticketDms.length, 1, `one DM, not two: ${JSON.stringify(w.dms.map((p) => p.embeds?.[0]?.data?.title))}`);
    const [dm] = ticketDms;
    const { title, description } = dm.embeds[0].data;
    assert.equal(title, 'Your ticket was closed');
    assert.ok(description.startsWith('Your ticket **ticket-0042** in **Cat \\*\\*Café\\*\\*** has been closed.'), description);
    assert.ok(description.endsWith('The transcript of this ticket is attached.'), description);
    assert.equal(dm.files?.length, 1, 'the transcript file rides on the closure DM');
    assert.deepEqual(dm.allowedMentions, { parse: [] });
});

test('a closure DM that fails with the transcript attached is sent again without it (the notice is never lost)', async () => {
    const w = world();
    const opener = await w.client.users.fetch(OPENER);
    const send = opener.send;
    opener.send = async (p) => { if (p.files?.length) throw new Error('Request entity too large'); return send(p); };
    await saveTicketData(GUILD, CHANNEL, { id: 43, userId: OPENER, status: 'open', createdAt: new Date().toISOString() });
    await closeTicket(w.channel, { id: '200000000000000002', tag: 'mod#1', toString: () => '<@200000000000000002>' }, 'Solved');
    const closed = w.dms.filter((p) => p.embeds?.[0]?.data?.title === 'Your ticket was closed');
    assert.equal(closed.length, 1, 'the notice went out once, without the file');
    assert.ok(!closed[0].files && !closed[0].embeds[0].data.description.includes('attached'));
});
