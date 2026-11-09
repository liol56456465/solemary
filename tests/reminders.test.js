// /remind (services/reminders/reminderService.js, commands/Utility/remind.js): time parsing,
// limits, own reminders only, delivery by DM with a channel fallback, the cron never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReminderError, cleanReminderText, deliverReminder, reminderDelay, reminderMessage, runReminders } from '../src/services/reminders/reminderService.js';
import remind, { listText } from '../src/commands/Utility/remind.js';
import { EVERYONE_COMMANDS } from '../src/config/commands/commandAccess.js';

const ME = '200000000000000002';

test('reminder times: 1 minute to 1 year, readable errors', () => {
    assert.equal(reminderDelay('10m'), 600000);
    assert.equal(reminderDelay('1d12h'), 36 * 3600000);
    assert.throws(() => reminderDelay('soon'), ReminderError);
    assert.throws(() => reminderDelay('2y'), ReminderError);
    assert.throws(() => reminderDelay('600w'), /longest reminder is 1 year/);
    assert.throws(() => cleanReminderText('   '), /Write what/);
    assert.throws(() => cleanReminderText('x'.repeat(501)), /under 500/);
    assert.equal(cleanReminderText(' buy \n milk '), 'buy milk');
});

function fakeInteraction(sub, options = {}) {
    const replies = [];
    return {
        replies, id: `i${Math.random()}`, createdTimestamp: Date.now(), user: { id: ME }, guildId: '100000000000000001', channelId: '300000000000000003', replied: false, deferred: false,
        options: { getSubcommand: () => sub, getString: (n) => options[n] ?? null, getInteger: (n) => options[n] ?? null },
        reply: async (payload) => { replies.push(payload); return payload; },
        editReply: async (payload) => { replies.push(payload); return payload; },
        followUp: async (payload) => { replies.push(payload); return payload; },
    };
}

test('/remind: set, list, delete only your own; private replies; DB error says nothing was saved', async () => {
    assert.ok(EVERYONE_COMMANDS.has('remind me') && EVERYONE_COMMANDS.has('remind list') && EVERYONE_COMMANDS.has('remind delete'));
    const rows = [];
    const store = {
        create: async (r) => { const row = { id: rows.length + 1, ...r, due_at: new Date(Date.now() + r.delayMs), created_at: new Date() }; rows.push(row); return row; },
        listActive: async (userId) => rows.filter((r) => r.userId === userId),
        remove: async (userId, id) => { const i = rows.findIndex((r) => r.id === id && r.userId === userId); return i === -1 ? null : rows.splice(i, 1)[0]; },
    };
    const set = fakeInteraction('me', { in: '2h', text: 'stretch' });
    await remind.execute(set, {}, {}, { store });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].channelId, '300000000000000003');
    assert.match(set.replies[0].embeds[0].data.description, /Okay, I'll remind you <t:\d+:R>/);
    assert.ok(set.replies[0].flags);
    const bad = fakeInteraction('me', { in: 'tomorrowish', text: 'x' });
    await remind.execute(bad, {}, {}, { store });
    assert.match(bad.replies[0].embeds[0].data.description, /could not read that time/);
    assert.equal(rows.length, 1);
    const del = fakeInteraction('delete', { id: 99 });
    await remind.execute(del, {}, {}, { store });
    assert.match(del.replies[0].embeds[0].data.description, /no reminder with that number/);
    const broken = fakeInteraction('list');
    await remind.execute(broken, {}, {}, { store: { listActive: async () => { throw new Error('db down'); } } });
    assert.match(broken.replies[0].embeds[0].data.description, /nothing was saved/);
    assert.equal(listText([]), 'You have no reminders. Set one with `/remind me`.');
});

test('delivery: DM first, then the channel with only that user mentioned; failures are marked, the cron never throws', async () => {
    const row = { id: 7, user_id: ME, guild_id: 'G1', channel_id: '300000000000000003', text: 'stretch @everyone', created_at: new Date(0) };
    const sent = [];
    const dmOk = { users: { fetch: async () => ({ send: async (p) => sent.push(['dm', p]) }) }, channels: { fetch: async () => null } };
    assert.equal(await deliverReminder(dmOk, row), 'dm');
    assert.deepEqual(sent[0][1].allowedMentions, { parse: [] });
    let canWrite = true;
    let timedOut = false;
    const member = { isCommunicationDisabled: () => timedOut };
    const guild = { id: 'G1', members: { fetch: async (id) => (id === ME ? member : null) } };
    const channel = { isTextBased: () => true, guild, permissionsFor: () => ({ has: () => canWrite }), send: async (p) => sent.push(['channel', p]) };
    const dmClosed = { users: { fetch: async () => ({ send: async () => { throw new Error('Cannot send messages to this user'); } }) }, channels: { fetch: async () => channel } };
    assert.equal(await deliverReminder(dmClosed, row), 'channel');
    assert.deepEqual(sent[1][1].allowedMentions, { users: [ME] });
    assert.ok(sent[1][1].content.startsWith(`<@${ME}> ⏰ Reminder you set`));
    assert.match(reminderMessage(row), /^⏰ Reminder you set <t:0:R>: stretch @everyone$/);
    assert.match(reminderMessage(row, 'de'), /^⏰ Erinnerung, die du <t:0:R> gestellt hast: stretch @everyone$/);
    // Never posts where the member could not post it themselves now (muted, timed out, left, other server).
    canWrite = false;
    assert.equal(await deliverReminder(dmClosed, row), 'failed', 'muted: no Send Messages');
    canWrite = true; timedOut = true;
    assert.equal(await deliverReminder(dmClosed, row), 'failed', 'timed out');
    timedOut = false;
    assert.equal(await deliverReminder(dmClosed, { ...row, user_id: '999' }), 'failed', 'not a member any more');
    assert.equal(await deliverReminder(dmClosed, { ...row, guild_id: 'G2' }), 'failed', 'another server');
    assert.equal(sent.length, 2);

    const failed = [];
    const nowhere = { users: { fetch: async () => { throw new Error('x'); } }, channels: { fetch: async () => null } };
    assert.equal(await runReminders(nowhere, { claimDue: async () => [row], markFailed: async (id) => failed.push(id) }), 1);
    assert.deepEqual(failed, [7]);
    assert.equal(await runReminders(nowhere, { claimDue: async () => { throw new Error('db down'); } }), 0);
});
