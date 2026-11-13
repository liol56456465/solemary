// Advanced logs for tickets (owner, 2026-11-13: "when you search up the person in the ticket logs
// channel it will show their reviews, transcripts and only useful info, and don't save any
// unnecessary info like ticket opened"): one kind, 'tickets'. In Advanced mode each member's forum
// post holds, per closed ticket, one message with the close summary and the transcript file, the
// transcripts of their closed modmail, and their reviews. Routine events (opened, claimed, pinned…)
// are not posted anywhere. A forum failure sends the useful posts to the normal channels; Normal
// mode works exactly as before.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

const { db } = await import('../src/utils/database/wrapper.js');
const { MemoryStorage } = await import('../src/utils/memoryStorage.js');
// The in-memory store, set up directly: the test never tries to reach a database.
Object.assign(db, { db: new MemoryStorage(), useFallback: true, connectionType: 'memory', initialized: true, degradedModeWarningShown: true });
const { logger } = await import('../src/utils/logger.js');
const { LOG_FORUM_KINDS, logForumIds, logForumMessageRef, resetLogForumState } = await import('../src/services/logForum.js');
const { logTicketEvent } = await import('../src/utils/ticket/ticketLogging.js');
const { closeTicket } = await import('../src/services/ticket.js');
const { saveTicketData, getTicketData } = await import('../src/utils/database.js');
const { fileModmailTranscript } = await import('../src/services/modmailService.js');
const { editTranscriptLogRating } = await import('../src/services/ticketRatingEffects.js');

const OPENER = '200000000000000061';
const STAFF = '200000000000000062';
const FORUM = '930000000000000102';
const TEXT = '930000000000000101';
let guildSeq = 0;
const nextGuild = () => `9200000000000000${String((guildSeq += 1)).padStart(2, '0')}`;

afterEach(() => resetLogForumState());

async function quietly(fn) {
    const saved = {};
    for (const level of ['error', 'warn', 'info', 'debug']) { saved[level] = logger[level]; logger[level] = () => {}; }
    try { return await fn(); } finally { Object.assign(logger, saved); }
}

/** A config store like the real one (client.db). */
function store(initial = {}) {
    const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
    return {
        async get(key, fallback = null) { return data.has(key) ? structuredClone(data.get(key)) : fallback; },
        async set(key, value) { data.set(key, structuredClone(value)); return true; },
        async delete(key) { return data.delete(key); },
    };
}

function collection(items) {
    const map = new Map(items.map((m) => [m.id, m]));
    map.find = (fn) => [...map.values()].find(fn);
    map.last = () => [...map.values()].at(-1);
    return map;
}

/**
 * A guild with a forum (its posts are threads whose first message has the thread's id) and a
 * normal text channel; `config` is the guild config (ticket/transcript channels, logging.forums).
 */
function world(config = {}, { forumPerms = true } = {}) {
    const id = nextGuild();
    const channels = new Map();
    const dms = [];
    const users = new Map([
        [OPENER, { id: OPENER, tag: 'amy#1', username: 'amy', send: async (p) => { dms.push(p); return { id: `dm${dms.length}`, channelId: 'dmch' }; } }],
        [STAFF, { id: STAFF, tag: 'mod#1', username: 'mod', toString: () => `<@${STAFF}>`, displayAvatarURL: () => null }],
    ]);
    const guild = { id, name: 'G', iconURL: () => null, members: { me: {}, cache: new Map(), fetch: async () => null }, channels: { cache: channels, fetch: async (cid) => channels.get(cid) || null } };
    const client = {
        db: store({ [`guild:${id}:config`]: config }),
        guilds: { cache: new Map([[id, guild]]), fetch: async () => guild },
        users: { cache: users, fetch: async (uid) => users.get(uid) || null },
        channels: { fetch: async (cid) => channels.get(cid) || null },
    };
    guild.client = client;
    const text = {
        id: TEXT, type: ChannelType.GuildText, guildId: id, sent: [],
        permissionsFor: () => ({ has: () => true }), isSendable: () => true, isTextBased: () => true,
        send: async (m) => { text.sent.push(m); return { id: `tm${text.sent.length}`, channelId: TEXT }; },
    };
    let threadSeq = 0;
    const forum = {
        id: FORUM, type: ChannelType.GuildForum, guildId: id, created: [],
        flags: { has: () => false }, availableTags: [],
        permissionsFor: () => ({ has: () => forumPerms }),
        threads: {
            cache: new Map(),
            create: async ({ name, message }) => {
                if (forum.failCreate) throw forum.failCreate;
                threadSeq += 1;
                const thread = {
                    id: `94000000000000010${threadSeq}`, name, parentId: forum.id, guildId: id, locked: false, archived: false, sent: [message],
                    isThread: () => true,
                    setArchived: async (archived) => { thread.archived = archived; thread.unarchived = (thread.unarchived || 0) + 1; return thread; },
                };
                // The starter message has the thread's id (Discord forums).
                const starter = { id: thread.id, embeds: (message.embeds || []).map((e) => (e.toJSON ? e.toJSON() : e)), edits: [] };
                starter.edit = async (m) => {
                    if (thread.archived) throw Object.assign(new Error('Thread is archived'), { code: 50083 });
                    starter.edits.push(m);
                    return starter;
                };
                thread.messages = { fetch: async (mid) => (mid === thread.id ? starter : null) };
                thread.starter = starter;
                thread.send = async (m) => { thread.sent.push(m); return { id: `m${thread.sent.length}`, channelId: thread.id }; };
                forum.threads.cache.set(thread.id, thread);
                channels.set(thread.id, thread);
                forum.created.push({ name });
                return thread;
            },
        },
    };
    channels.set(text.id, text);
    channels.set(forum.id, forum);
    const posts = () => [...forum.threads.cache.values()];
    return { id, guild, client, text, forum, posts, dms };
}

/** A closable channel (ticket / modmail / report) with one message, for the transcript. */
function conversation(w, channelId, name) {
    const messages = [{ id: '1', author: { tag: 'amy#1' }, content: 'help', createdTimestamp: 1, embeds: [], attachments: new Map() }];
    return {
        id: channelId, name, guild: w.guild, client: w.client, parentId: null, type: 0,
        permissionOverwrites: { cache: new Map(), create: async () => {}, edit: async () => {} },
        messages: { fetch: async (opts) => (opts && typeof opts === 'object' ? collection(opts.before ? [] : messages) : collection(messages)) },
        send: async () => ({ id: 'post' }),
        edit: async () => {}, setParent: async () => {},
    };
}

const forumsConfig = (forums) => ({ ticketLogsChannelId: TEXT, ticketTranscriptChannelId: TEXT, logging: { forums } });

// ── settings ──────────────────────────────────────────────────────────────

test('tickets is one Advanced kind (no separate transcripts kind); the tamper guard covers its forum automatically', () => {
    assert.ok(LOG_FORUM_KINDS.includes('tickets'));
    assert.ok(!LOG_FORUM_KINDS.includes('transcripts'));
    assert.deepEqual(logForumIds({ logging: { forums: { tickets: '930000000000000201' } } }), ['930000000000000201']);
    // A new post is the thread (its first message has the thread's id); a later log is a message.
    assert.deepEqual(logForumMessageRef({ id: '7', isThread: () => true }), { channelId: '7', messageId: '7' });
    assert.deepEqual(logForumMessageRef({ id: '8', channelId: '7' }), { channelId: '7', messageId: '8' });
    assert.equal(logForumMessageRef(null), null);
});

// ── Advanced ──────────────────────────────────────────────────────────────

const titles = (messages) => messages.map((m) => m.embeds?.[0]?.data?.title ?? m.embeds?.[0]?.title);
const field = (message, name) => message.embeds[0].data.fields.find((f) => f.name === name)?.value;

test('Advanced: opened, claimed, pinned, priority and deleted post nothing anywhere (not the forum, not the ticket log channel)', async () => {
    const w = world(forumsConfig({ tickets: FORUM }));
    for (const type of ['open', 'claim', 'unclaim', 'pin', 'unpin', 'priority', 'delete', 'close']) {
        assert.equal(await logTicketEvent({ client: w.client, guildId: w.id, event: { type, ticketId: '1', ticketNumber: 5, userId: OPENER, executorId: STAFF } }), null, type);
    }
    assert.equal(w.forum.created.length, 0);
    assert.equal(w.text.sent.length, 0);
});

test('Advanced: a close posts one message (summary + transcript file) in the opener\'s post; the review follows there; the rating is added to the summary', async () => {
    const w = world(forumsConfig({ tickets: FORUM }));
    const channelId = '100000000000000701';
    const createdAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    await saveTicketData(w.id, channelId, { id: 42, userId: OPENER, status: 'open', createdAt, claimedBy: '200000000000000063' });
    // Opened and claimed: nothing.
    await logTicketEvent({ client: w.client, guildId: w.id, event: { type: 'open', ticketId: channelId, ticketNumber: 42, userId: OPENER, executorId: OPENER } });
    assert.equal(w.forum.created.length, 0);
    await quietly(() => closeTicket(conversation(w, channelId, 'ticket-0042'), w.client.users.cache.get(STAFF), 'Solved'));
    assert.deepEqual(w.forum.created.map((c) => c.name), [`amy logs ${OPENER}`]);
    const [post] = w.posts();
    assert.equal(post.sent.length, 1, 'one message per ticket (no separate "closed" log)');
    const [summary] = post.sent;
    assert.equal(summary.embeds[0].data.title, 'Ticket closed');
    assert.equal(field(summary, 'Ticket'), '#42');
    assert.equal(field(summary, 'Opened by'), `<@${OPENER}>`);
    assert.equal(field(summary, 'Closed by'), `<@${STAFF}>`);
    assert.equal(field(summary, 'Handled by'), '<@200000000000000063>');
    assert.match(field(summary, 'Open for'), /^3 hours/);
    assert.equal(field(summary, 'Reason'), 'Solved');
    assert.equal(summary.files.length, 1, 'the transcript file is posted');
    assert.match(summary.files[0].name, /\.html$/);
    assert.deepEqual(summary.allowedMentions, { parse: [] });
    assert.equal(w.text.sent.length, 0, 'nothing in the ticket log or transcript channel');
    const saved = await getTicketData(w.id, channelId);
    assert.deepEqual(saved.transcriptLog, { channelId: post.id, messageId: post.id }, 'the starter message can be found again');

    // The review: in the same post, with the low-rating and flagged-comment information.
    await logTicketEvent({ client: w.client, guildId: w.id, event: { type: 'feedback', ticketId: channelId, ticketNumber: 42, userId: OPENER, metadata: { rating: 1, comment: 'rude', flagged: true, staffId: STAFF } } });
    assert.equal(w.forum.created.length, 1, 'the same post');
    const review = post.sent[1];
    assert.equal(review.embeds[0].data.title, 'Ticket feedback');
    assert.match(field(review, 'Rating'), /1/);
    assert.ok(field(review, 'Low rating'), 'a low rating is marked');
    assert.ok(review.embeds[0].data.fields.some((f) => f.name === 'Comment (flagged)'));
    assert.equal(w.text.sent.length, 0);

    // The post archived after an hour; the rating still lands on the summary message.
    post.archived = true;
    assert.equal(await editTranscriptLogRating(w.client, { kind: 'ticket', guild_id: w.id, ref_id: channelId, rating: 1 }), true);
    assert.equal(post.unarchived, 1, 'reopened first');
    assert.ok(post.starter.edits[0].embeds[0].fields.some((f) => f.name === 'Rating' && f.value.includes('1/5')));
});

test('Advanced: a closed modmail\'s transcript goes in the member\'s post of the tickets forum, with its file', async () => {
    const w = world(forumsConfig({ tickets: FORUM }));
    const user = w.client.users.cache.get(OPENER);
    const where = await quietly(() => fileModmailTranscript(conversation(w, '100000000000000801', 'modmail-amy'), { userId: OPENER, user, closer: w.client.users.cache.get(STAFF), reason: 'sorted' }));
    assert.equal(where, 'forum');
    assert.deepEqual(w.forum.created.map((c) => c.name), [`amy logs ${OPENER}`]);
    const [post] = w.posts();
    assert.equal(post.sent[0].files[0].name, `modmail-${OPENER}.html`);
    assert.match(post.sent[0].content, /sorted/);
    assert.deepEqual(post.sent[0].allowedMentions, { parse: [] });
    assert.equal(w.text.sent.length, 0);
});

// ── fallback ──────────────────────────────────────────────────────────────

test('fallback: a broken forum sends the useful posts to the normal channels (summary + transcript, review, modmail transcript); noise stays dropped', async () => {
    const w = world(forumsConfig({ tickets: FORUM }), { forumPerms: false });
    const channelId = '100000000000000703';
    await saveTicketData(w.id, channelId, { id: 44, userId: OPENER, status: 'open', createdAt: new Date().toISOString() });
    await quietly(() => closeTicket(conversation(w, channelId, 'ticket-0044'), w.client.users.cache.get(STAFF), 'Solved'));
    assert.equal(w.forum.created.length, 0);
    const transcriptPost = w.text.sent.find((m) => m.files?.length);
    assert.ok(transcriptPost, 'the transcript reached the transcript channel');
    assert.equal(transcriptPost.embeds[0].data.title, 'Ticket closed', 'with the close summary (the "closed" log was skipped)');
    assert.deepEqual(transcriptPost.allowedMentions, { parse: [] });
    assert.deepEqual((await getTicketData(w.id, channelId)).transcriptLog.channelId, TEXT);
    const before = w.text.sent.length;
    await quietly(() => logTicketEvent({ client: w.client, guildId: w.id, event: { type: 'feedback', ticketId: channelId, ticketNumber: 44, userId: OPENER, metadata: { rating: 5 } } }));
    assert.equal(w.text.sent.length, before + 1, 'the review reached the ticket log channel');
    await quietly(() => logTicketEvent({ client: w.client, guildId: w.id, event: { type: 'claim', ticketId: channelId, userId: OPENER, executorId: STAFF } }));
    assert.equal(w.text.sent.length, before + 1, 'noise is not posted in the fallback either');
    const user = w.client.users.cache.get(OPENER);
    assert.equal(await quietly(() => fileModmailTranscript(conversation(w, '100000000000000803', 'modmail-amy'), { userId: OPENER, user, closer: user })), 'channel');
});

test('fallback: a tickets forum without Attach Files is not used for transcripts (the file would be lost), still for reviews', async () => {
    const { PermissionFlagsBits } = await import('discord.js');
    const noFiles = () => ({ has: (perms) => !(Array.isArray(perms) ? perms : [perms]).includes(PermissionFlagsBits.AttachFiles) });
    const w = world(forumsConfig({ tickets: FORUM }));
    w.forum.permissionsFor = noFiles;
    const user = w.client.users.cache.get(OPENER);
    assert.equal(await quietly(() => fileModmailTranscript(conversation(w, '100000000000000804', 'modmail-amy'), { userId: OPENER, user, closer: user })), 'channel');
    assert.equal(w.forum.created.length, 0);
    // Control: a review (no files) still uses that forum.
    await logTicketEvent({ client: w.client, guildId: w.id, event: { type: 'feedback', ticketId: '1', ticketNumber: 5, userId: OPENER, metadata: { rating: 4 } } });
    assert.equal(w.forum.created.length, 1);
});

// ── Normal mode ───────────────────────────────────────────────────────────

test('Normal: every ticket event goes to the ticket log channel as before; the transcript to the transcript channel with its usual embed', async () => {
    const w = world(forumsConfig({}));
    for (const type of ['open', 'claim', 'feedback']) {
        await logTicketEvent({ client: w.client, guildId: w.id, event: { type, ticketId: '1', ticketNumber: 5, userId: OPENER, executorId: STAFF, metadata: { rating: 1 } } });
    }
    assert.deepEqual(titles(w.text.sent), ['Ticket opened', 'Ticket claimed', 'Ticket feedback']);
    assert.equal(field(w.text.sent[2], 'Low rating'), undefined, 'the review embed is unchanged in Normal mode');
    assert.deepEqual(w.text.sent[0].allowedMentions, { parse: [] });

    const channelId = '100000000000000702';
    await saveTicketData(w.id, channelId, { id: 43, userId: OPENER, status: 'open', createdAt: new Date().toISOString() });
    await quietly(() => closeTicket(conversation(w, channelId, 'ticket-0043'), w.client.users.cache.get(STAFF), 'Solved'));
    const closedLog = w.text.sent.find((m) => m.embeds?.[0]?.data?.title === 'Ticket closed');
    assert.ok(closedLog && !closedLog.files, 'the "closed" log as before');
    const transcript = w.text.sent.find((m) => m.embeds?.[0]?.data?.title === 'Ticket transcript');
    assert.equal(transcript.files.length, 1);
    assert.equal(w.forum.created.length, 0);

    const user = w.client.users.cache.get(OPENER);
    assert.equal(await quietly(() => fileModmailTranscript(conversation(w, '100000000000000802', 'modmail-amy'), { userId: OPENER, user, closer: user })), 'channel');
    assert.equal(w.forum.created.length, 0);
});
