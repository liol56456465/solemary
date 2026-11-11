// Deleted log messages: which channels count, which audit entry is the delete, who is trusted,
// and what is posted again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, EmbedBuilder } from 'discord.js';
import { logChannelIds, pickAuditEntry, isTrustedDeleter, buildRestorePayload, restoreBudget, handleDeletedMessages, markOwnDelete, AUDIT_FRESH_MS, RESTORE_LIMIT, RESTORE_WINDOW_MS } from '../src/services/logTamperService.js';

const BOT = '900000000000000001';
const CH = '800000000000000001';
const now = 1_800_000_000_000;

test('log channels: Logging page, old keys, ticket logs and staff channels', () => {
    const ids = logChannelIds({ logging: { channelId: 'a', channels: { moderation: 'b', messages: null } }, logChannelId: 'c', ticketLogsChannelId: 'd' }, 'g', { staffIds: ['e', null] });
    assert.deepEqual([...ids].sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('audit entry: each delete uses one unit of a merged entry; old merged = possibly', () => {
    const seen = new Map();
    const entry = (id, ageMs, count = 1, channelId = CH) => ({ id, targetId: BOT, createdTimestamp: now - ageMs, extra: { channel: { id: channelId }, count } });
    const opts = { type: AuditLogEvent.MessageDelete, botId: BOT, channelId: CH, now, seen };
    assert.deepEqual(pickAuditEntry([entry('1', 1000, 3)], opts), { entry: entry('1', 1000, 3), certain: true });
    assert.equal(pickAuditEntry([entry('1', 1000, 3)], opts)?.certain, true, 'second of three quick deletes');
    assert.equal(pickAuditEntry([entry('1', 1000, 3)], opts)?.certain, true, 'third');
    assert.equal(pickAuditEntry([entry('1', 1000, 3)], opts), null, 'all three used: a 4th delete without a count rise is ours');
    assert.equal(pickAuditEntry([entry('1', 1000, 4)], opts)?.certain, true, 'count rose');
    assert.equal(pickAuditEntry([entry('2', AUDIT_FRESH_MS + 1)], opts), null, 'old single entry');
    assert.equal(pickAuditEntry([entry('5', AUDIT_FRESH_MS + 1, 2)], opts)?.certain, false, 'old merged entry seen first time (restart)');
    assert.equal(pickAuditEntry([entry('3', 10, 1, 'other')], opts), null, 'other channel');
    assert.equal(pickAuditEntry([{ id: '4', targetId: CH, createdTimestamp: now, extra: { count: 3 } }], { ...opts, type: AuditLogEvent.MessageBulkDelete })?.certain, true);
});

test('restore budget: at most RESTORE_LIMIT per channel in the window', () => {
    const times = new Map();
    assert.equal(restoreBudget('c', 5, now, times), 5);
    assert.equal(restoreBudget('c', 8, now + 1000, times), RESTORE_LIMIT - 5);
    assert.equal(restoreBudget('c', 1, now + 2000, times), 0);
    assert.equal(restoreBudget('c', 1, now + RESTORE_WINDOW_MS + 2000, times), 1, 'window passed');
    assert.equal(restoreBudget('d', 1, now, times), 1, 'other channel');
});

test('server owner and OWNER_IDS are trusted; others are not', () => {
    const guild = { ownerId: 'o' };
    assert.equal(isTrustedDeleter(guild, 'o', []), true);
    assert.equal(isTrustedDeleter(guild, 'x', ['x']), true);
    assert.equal(isTrustedDeleter(guild, 'm', ['x']), false);
    assert.equal(isTrustedDeleter(guild, null, ['x']), false);
});

test('restore payload: who, original content and embeds, no pings', () => {
    const cached = { partial: false, author: { id: BOT }, attachments: new Map([['a', { name: 'transcript.html' }]]), content: '@everyone line1\nline2', embeds: [new EmbedBuilder().setTitle('Ban').toJSON()], createdTimestamp: now - 60_000 };
    const p = buildRestorePayload(cached, { executorId: '700000000000000001', deletedAt: now });
    assert.match(p.content, /deleted by <@700000000000000001>/);
    assert.match(p.content, /> @everyone line1\n> line2/);
    assert.equal(p.embeds.length, 1);
    assert.match(p.content, /Files \(removed by Discord with the message\): transcript\.html/);
    assert.deepEqual(p.allowedMentions, { parse: [] });
    const partial = buildRestorePayload({ partial: true, embeds: [] }, { deletedAt: now });
    assert.match(partial.content, /deleted by unknown/);
    assert.match(partial.content, /content is not available/);
    assert.equal(partial.embeds.length, 0);
    assert.ok(buildRestorePayload({ ...cached, content: 'x'.repeat(5000) }).content.length <= 2000);
});

test('Mewvo\'s own delete (markOwnDelete) is never restored', async () => {
    const sent = [];
    const channel = { id: CH, send: async (p) => { sent.push(p); } };
    const client = { user: { id: BOT }, db: null };
    const guild = { id: 'g', ownerId: 'o', client, members: { me: { permissions: { has: () => false } } } };
    const msg = { id: 'm1', partial: false, author: { id: BOT }, content: 'x', embeds: [], createdTimestamp: now };
    markOwnDelete('m1');
    await handleDeletedMessages(client, guild, channel, [msg]);
    assert.equal(sent.length, 0);
});

test('end to end: a moderator\'s delete is restored; the owner\'s and an unreadable audit log are not', async () => {
    const run = async ({ executorId, canReadAudit, ch, gid }) => {
        const sent = [];
        const channel = { id: ch, send: async (p) => { sent.push(p); } };
        const client = { user: { id: BOT }, db: { get: async () => ({ logging: { channels: { audit: ch } } }) }, guilds: { cache: new Map() } };
        const guild = {
            id: gid, ownerId: 'owner1', client,
            members: { me: { permissions: { has: () => canReadAudit } } },
            fetchAuditLogs: async () => ({ entries: new Map([['e', { id: `e-${ch}`, targetId: BOT, executorId, createdTimestamp: Date.now(), extra: { channel: { id: ch }, count: 1 } }]]) }),
        };
        const msg = { id: `m-${ch}`, partial: false, author: { id: BOT }, content: 'Ban log', embeds: [], createdTimestamp: Date.now() - 5000 };
        await handleDeletedMessages(client, guild, channel, [msg]);
        return sent;
    };
    const mod = await run({ executorId: 'mod1', canReadAudit: true, ch: '800000000000000011', gid: '310000000000000001' });
    assert.equal(mod.length, 1);
    assert.match(mod[0].content, /deleted by <@mod1>/);
    assert.match(mod[0].content, /> Ban log/);
    assert.equal((await run({ executorId: 'owner1', canReadAudit: true, ch: '800000000000000012', gid: '310000000000000002' })).length, 0);
    assert.equal((await run({ executorId: 'mod1', canReadAudit: false, ch: '800000000000000013', gid: '310000000000000003' })).length, 0);
});

test('an uncached delete does not take a Mewvo unit while members\' messages are being deleted too', () => {
    const seen = new Map();
    const ours = { id: 'b1', targetId: BOT, createdTimestamp: now - 500, extra: { channel: { id: CH }, count: 2 } };
    const member = { id: 'u1', targetId: '700000000000000099', createdTimestamp: now - 300, extra: { channel: { id: CH }, count: 1 } };
    const opts = { type: AuditLogEvent.MessageDelete, botId: BOT, channelId: CH, now, seen };
    assert.equal(pickAuditEntry([member, ours], { ...opts, unknownAuthor: true }), null);
    assert.equal(pickAuditEntry([member, ours], opts)?.certain, true, 'a cached Mewvo log still gets its unit');
    assert.equal(pickAuditEntry([member, ours], opts)?.certain, true, 'and the second one too');
});
