// Dashboard Inbox against the local test database (npm run test:db): the open-ticket,
// open-modmail and open-staff-report reads, getTicketData for a conversation, and a web
// reply that goes through the REAL sendStaffTextToMember (modmail_links → the member's DM).
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const skip = isLocalDatabaseUrl(process.env.POSTGRES_URL || '') ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
const runId = String(Date.now()).slice(-9);
const guildId = `8${runId}00000008`;
const id = (prefix, n) => `${prefix}${runId}${String(n).padStart(8, '0')}`;
let pgDb, db, inboxData, links, saveTicketData;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    inboxData = await import('../../src/services/dashboard/inboxData.js');
    links = await import('../../src/services/modmailLinks.js');
    ({ saveTicketData } = await import('../../src/utils/database.js'));
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM modmail_links WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM ticket_data WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM guilds WHERE id = $1', [guildId]);
    await pgDb.disconnect();
});

test('inbox reads: open tickets only, modmail links of this guild, pending reports with a channel', { skip }, async () => {
    const member = id('6', 1);
    await saveTicketData(guildId, id('5', 1), { id: id('5', 1), userId: member, guildId, createdAt: new Date(Date.now() - 3600000).toISOString(), status: 'open', claimedBy: null, priority: 'none', reason: 'help' });
    await saveTicketData(guildId, id('5', 2), { id: id('5', 2), userId: member, guildId, createdAt: new Date().toISOString(), status: 'closed' });
    const tickets = await inboxData.listOpenTickets(guildId);
    assert.deepEqual(tickets.map((t) => t.channelId), [id('5', 1)]);
    assert.equal(tickets[0].userId, member);
    assert.equal(tickets[0].reason, 'help');

    links.resetModmailLinksForTests();
    await links.linkModmailChannel(guildId, id('4', 1), member);
    await links.linkModmailChannel('8000000000000000001', id('4', 2), member).catch(() => {}); // another guild
    const modmail = await inboxData.listOpenModmail(guildId);
    assert.deepEqual(modmail.map((m) => [m.channelId, m.userId]), [[id('4', 1), member]]);
    await pgDb.pool.query('DELETE FROM modmail_links WHERE channel_id = $1', [id('4', 2)]);

    await pgDb.pool.query(
        `INSERT INTO mod_appeals (kind, user_id, username, guild_id, channel_id, body, status) VALUES
         ('report', $1, 'rep', $2, $3, '{"staffMember":"mod x"}', 'pending'),
         ('report', $1, 'rep', $2, NULL, '{}', 'pending'),
         ('report', $1, 'rep', $2, $4, '{}', 'closed')`,
        [member, guildId, id('3', 1), id('3', 2)],
    );
    const reports = await inboxData.listOpenReports(guildId);
    assert.deepEqual(reports.map((r) => r.channelId), [id('3', 1)]);
    assert.equal(reports[0].staffMember, 'mod x');
});

test('web reply to modmail: the real sendStaffTextToMember DMs the linked member "Name (staff): …"; a // note does not', { skip }, async () => {
    links.resetModmailLinksForTests();
    const member = id('6', 2);
    const channelId = id('4', 3);
    await links.linkModmailChannel(guildId, channelId, member);
    const dms = [];
    const posted = [];
    const client = { users: { fetch: async (u) => ({ id: u, send: async (m) => { dms.push({ to: u, ...m }); } }) } };
    const channel = { id: channelId, client, send: async (m) => { posted.push(m); return { react: async () => {} }; } };
    const conversation = { kind: 'modmail', channel, userId: member };

    const sent = await inboxData.sendReply({ conversation, staffName: 'Admin', text: 'Hello @everyone' });
    assert.deepEqual(sent, { note: false, delivered: true });
    assert.equal(dms.length, 1);
    assert.equal(dms[0].to, member);
    assert.equal(dms[0].content, '**Admin (staff):**\nHello @everyone');
    assert.deepEqual(dms[0].allowedMentions, { parse: [] });
    assert.equal(posted.length, 1);

    const note = await inboxData.sendReply({ conversation, staffName: 'Admin', text: '// internal' });
    assert.equal(note.note, true);
    assert.equal(dms.length, 1, 'the note was not DMed');
    assert.equal(posted.length, 2);
});
