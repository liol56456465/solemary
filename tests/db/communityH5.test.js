// Community batch H5 against the local test database (npm run test:db):
// sticky messages, tags, suggestions, starboard, feeds.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db;
const runId = String(Date.now()).slice(-9);
const guildId = `7${runId}00000005`;
const id = (n) => `6${runId}${String(n).padStart(8, '0')}`;

function fakeChannel(channelId) {
    const sent = [];
    const deleted = [];
    let seq = 0;
    return {
        id: channelId,
        sent,
        deleted,
        toString: () => `<#${channelId}>`,
        send: async (payload) => {
            seq += 1;
            const message = { id: `${channelId.slice(0, 10)}${String(seq).padStart(9, '0')}`, payload };
            sent.push(message);
            return message;
        },
        messages: { delete: async (messageId) => { deleted.push(messageId); } },
    };
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM sticky_messages WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.pool.query('DELETE FROM tags WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.pool.query('DELETE FROM suggestions WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.pool.query('DELETE FROM community_settings WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.pool.query('DELETE FROM starboard_posts WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.pool.query('DELETE FROM feeds WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.disconnect();
});

test('sticky: set posts and saves the id, replace reposts, reload restores, remove deletes', { skip }, async () => {
    const sticky = await import('../../src/services/community/stickyService.js');
    const channel = fakeChannel(id(1));
    const { posted } = await sticky.setSticky({ guildId, channel, content: 'Read the rules', updatedBy: id(90) });
    assert.equal(posted, true);
    assert.equal(channel.sent.length, 1);
    const { rows: [row] } = await pgDb.pool.query('SELECT * FROM sticky_messages WHERE channel_id = $1', [channel.id]);
    assert.equal(row.content, 'Read the rules');
    assert.equal(row.last_message_id, channel.sent[0].id);

    await sticky.setSticky({ guildId, channel, content: 'New rules', updatedBy: id(90) });
    assert.equal(channel.sent.length, 2);
    assert.deepEqual(channel.deleted, [channel.sent[0].id]);

    sticky.setStickiesForTests([]);
    await sticky.loadStickies();
    assert.deepEqual(sticky.listStickies(guildId), [{ channelId: channel.id, content: 'New rules', lastMessageId: channel.sent[1].id }]);

    await assert.rejects(sticky.setSticky({ guildId, channel, content: '   ', updatedBy: id(90) }), /empty/);

    assert.equal(await sticky.removeSticky({ channelId: channel.id, channel }), true);
    assert.ok(channel.deleted.includes(channel.sent[1].id));
    assert.equal(await sticky.removeSticky({ channelId: channel.id, channel }), false);
    const { rowCount } = await pgDb.pool.query('SELECT 1 FROM sticky_messages WHERE channel_id = $1', [channel.id]);
    assert.equal(rowCount, 0);
});

test('tags: create, unique names, edit fields, triggers from the cache, uses, delete', { skip }, async () => {
    const tags = await import('../../src/services/community/tagService.js');
    await tags.loadTags();
    const created = await tags.createTag({ guildId, name: 'IP', content: 'play.example.com', triggerKind: 'word', trigger: 'server ip', createdBy: id(90) });
    assert.equal(created.name, 'ip');
    assert.equal(created.cooldownS, 60);
    await assert.rejects(tags.createTag({ guildId, name: 'ip', content: 'x', createdBy: id(90) }), /already a tag/);
    await assert.rejects(tags.createTag({ guildId, name: 'bad name', content: 'x', createdBy: id(90) }), /lowercase/);
    await assert.rejects(tags.createTag({ guildId, name: 'evil', content: 'x', triggerKind: 'regex', trigger: '(a+)+', createdBy: id(90) }), /unsafe/);
    await assert.rejects(tags.createTag({ guildId, name: 'fast', content: 'x', triggerKind: 'word', trigger: 'hi', cooldownS: 1, createdBy: id(90) }), /cooldown/);

    const edited = await tags.editTag({ guildId, name: 'ip', content: 'new.example.com', denyChannels: [id(2)], cooldownS: 30 });
    assert.equal(edited.content, 'new.example.com');
    assert.deepEqual(edited.denyChannels, [id(2)]);
    assert.equal(edited.triggerKind, 'word'); // untouched
    assert.equal(await tags.editTag({ guildId, name: 'missing', content: 'x' }), null);

    const msg = (content, channelId) => ({ guild: { id: guildId }, channel: { id: channelId, isThread: () => false }, content });
    assert.equal(tags.findTriggeredTag(msg('the server ip?', id(1)))?.name, 'ip');
    assert.equal(tags.findTriggeredTag(msg('the server ip?', id(2))), null);

    const noTrigger = await tags.editTag({ guildId, name: 'ip', triggerKind: 'none' });
    assert.equal(noTrigger.trigger, null);
    assert.equal(tags.findTriggeredTag(msg('the server ip?', id(3))), null);

    tags.useTag(guildId, 'ip');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { rows: [row] } = await pgDb.pool.query('SELECT uses FROM tags WHERE guild_id = $1 AND name = $2', [guildId, 'ip']);
    assert.equal(row.uses, 1);

    assert.equal(await tags.deleteTag(guildId, 'ip'), true);
    assert.equal(await tags.deleteTag(guildId, 'ip'), false);
    assert.equal(tags.getTag(guildId, 'ip'), null);
});

test('settings: upsert keeps other columns and updates the cache', { skip }, async () => {
    const settings = await import('../../src/services/community/settingsService.js');
    const first = await settings.updateCommunitySettings(guildId, { suggestionsChannelId: id(10) }, id(90));
    assert.equal(first.suggestionsChannelId, id(10));
    assert.equal(first.starboardEmoji, '⭐');
    assert.equal(first.starboardThreshold, 3);
    const second = await settings.updateCommunitySettings(guildId, { starboardChannelId: id(11), starboardThreshold: 5 }, id(90));
    assert.equal(second.suggestionsChannelId, id(10));
    assert.equal(second.starboardThreshold, 5);
    settings.setCommunitySettingsForTests(guildId, null);
    await settings.loadCommunitySettings();
    assert.equal(settings.getCommunitySettings(guildId).starboardChannelId, id(11));
});

test('suggestions: post, votes (one per member, changeable, withdraw), status closes voting', { skip }, async () => {
    const suggestions = await import('../../src/services/community/suggestionService.js');
    const { updateCommunitySettings } = await import('../../src/services/community/settingsService.js');
    suggestions.resetSuggestionCooldownsForTests();
    const channel = fakeChannel(id(12));
    channel.messages.fetch = async () => ({ edit: async (payload) => { channel.edited = payload; } });
    const guild = { id: guildId, channels: { cache: new Map([[channel.id, channel]]) } };
    const author = { id: id(20), username: 'author' };

    await updateCommunitySettings(guildId, { suggestionsChannelId: null }, id(90));
    await assert.rejects(suggestions.createSuggestion({ guild, user: author, content: 'x' }), /not set up/);
    await updateCommunitySettings(guildId, { suggestionsChannelId: channel.id }, id(90));

    const { row } = await suggestions.createSuggestion({ guild, user: author, content: 'Add a cat channel' });
    assert.equal(row.message_id, channel.sent[0].id);
    await assert.rejects(suggestions.createSuggestion({ guild, user: author, content: 'again' }), /another suggestion/);

    const vote = (userId, clicked) => suggestions.castVote({ suggestionId: Number(row.id), guildId, userId, clicked });
    let result = await vote(id(21), 1);
    assert.deepEqual([result.vote, result.row.upvotes, result.row.downvotes], [1, 1, 0]);
    result = await vote(id(22), 1);
    result = await vote(id(23), -1);
    assert.deepEqual([result.row.upvotes, result.row.downvotes], [2, 1]);
    result = await vote(id(21), -1); // change
    assert.deepEqual([result.vote, result.row.upvotes, result.row.downvotes], [-1, 1, 2]);
    result = await vote(id(21), -1); // withdraw
    assert.deepEqual([result.vote, result.row.upvotes, result.row.downvotes], [0, 1, 1]);
    // Concurrent clicks by different members all count.
    await Promise.all([30, 31, 32, 33].map((n) => vote(id(n), 1)));
    result = await vote(id(34), -1);
    assert.deepEqual([result.row.upvotes, result.row.downvotes], [5, 2]);
    assert.equal(await suggestions.castVote({ suggestionId: Number(row.id), guildId: 'other', userId: id(21), clicked: 1 }), null);

    const decided = await suggestions.setSuggestionStatus({ guildId, suggestionId: Number(row.id), status: 'approved', reason: 'Great idea', decidedBy: id(90) });
    assert.equal(decided.status, 'approved');
    assert.equal(decided.status_reason, 'Great idea');
    await assert.rejects(vote(id(40), 1), /closed/);
    const client = {
        channels: { cache: new Map([[channel.id, channel]]) },
        users: { fetch: async () => author },
    };
    assert.equal(await suggestions.refreshSuggestionMessage(client, decided), true);
    assert.ok(channel.edited.components[0].components.every((button) => button.data.disabled));
    assert.equal(await suggestions.setSuggestionStatus({ guildId: 'other', suggestionId: Number(row.id), status: 'denied', decidedBy: id(90) }), null);
    await assert.rejects(suggestions.setSuggestionStatus({ guildId, suggestionId: Number(row.id), status: 'bogus', decidedBy: id(90) }), /Status/);
});

test('starboard: threshold, self-stars, count updates, edits, deletes', { skip }, async () => {
    const starboard = await import('../../src/services/community/starboardService.js');
    const { updateCommunitySettings } = await import('../../src/services/community/settingsService.js');
    const board = fakeChannel(id(50));
    const posted = new Map();
    board.isTextBased = () => true;
    const origSend = board.send;
    board.send = async (payload) => {
        const message = await origSend(payload);
        message.edit = async (next) => { message.payload = next; };
        message.delete = async () => { posted.delete(message.id); board.deleted.push(message.id); };
        posted.set(message.id, message);
        return message;
    };
    board.messages.fetch = async (messageId) => {
        if (!posted.has(messageId)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return posted.get(messageId);
    };
    const guild = { id: guildId, channels: { cache: new Map([[board.id, board]]) } };
    await updateCommunitySettings(guildId, starboard.starboardSettingsPatch({ channelId: board.id, emoji: '⭐', threshold: 2 }), id(90));

    const author = { id: id(60), username: 'author' };
    const source = {
        id: id(61), channelId: id(62), guild, author, partial: false, content: 'cute cat',
        url: 'https://discord.com/channels/x', attachments: new Map(), embeds: [], channel: { nsfw: false }, createdAt: new Date(),
    };
    const reactors = [];
    const reaction = () => ({
        emoji: { name: '⭐', id: null }, partial: false, count: reactors.length, message: source,
        users: { fetch: async () => new Map(reactors.map((u) => [u.id, u])) },
    });
    const react = async (user) => { reactors.push(user); await starboard.handleStarReaction(reaction(), user); };
    const unreact = async (user) => { reactors.splice(reactors.findIndex((u) => u.id === user.id), 1); await starboard.handleStarReaction(reaction(), user); };

    await react(author); // self-star
    await react({ id: id(63) });
    assert.equal(board.sent.length, 0, 'self-star does not count');
    await react({ id: id(64) });
    assert.equal(board.sent.length, 1);
    let post = starboard.getStarboardPost(source.id);
    assert.equal(post.count, 2);
    assert.match(board.sent[0].payload.content, /\*\*2\*\*/);

    await react({ id: id(65), bot: true }); // bot reaction event ignored entirely
    await react({ id: id(66) });
    assert.equal(starboard.getStarboardPost(source.id).count, 3);
    assert.match(posted.get(post.starMessageId).payload.content, /\*\*3\*\*/);
    const { rows: [row] } = await pgDb.pool.query('SELECT * FROM starboard_posts WHERE source_message_id = $1', [source.id]);
    assert.equal(row.count, 3);

    source.content = 'cute cat (edited)';
    await starboard.handleStarSourceEdit(source);
    assert.match(posted.get(post.starMessageId).payload.embeds[0].data.description, /edited/);

    // Reload from the database keeps the post.
    starboard.setStarboardPostsForTests([]);
    await starboard.loadStarboardPosts();
    assert.equal(starboard.getStarboardPost(source.id).count, 3);

    await unreact({ id: id(66) });
    await unreact({ id: id(64) });
    assert.equal(starboard.getStarboardPost(source.id), null, 'below the threshold the post is removed');
    assert.equal(posted.size, 0);

    await react({ id: id(67) });
    post = starboard.getStarboardPost(source.id);
    assert.ok(post);
    await starboard.handleStarMessageDelete(source);
    assert.equal(starboard.getStarboardPost(source.id), null);
    assert.equal(posted.size, 0);
    const { rowCount } = await pgDb.pool.query('SELECT 1 FROM starboard_posts WHERE source_message_id = $1', [source.id]);
    assert.equal(rowCount, 0);

    // Bot messages are never starred.
    const botMessage = { ...source, id: id(70), author: { id: id(71), bot: true } };
    const botReaction = { ...reaction(), count: 5, message: botMessage };
    await starboard.handleStarReaction(botReaction, { id: id(72) });
    assert.equal(starboard.getStarboardPost(botMessage.id), null);
});

test('feeds: add records the newest video, polls post only new videos once per source, remove', { skip }, async () => {
    const feedsSvc = await import('../../src/services/community/feedService.js');
    const ytChannel = `UC${runId}abcdefghijklm`;
    assert.equal(ytChannel.length, 24);
    let videos = ['vid_0000002', 'vid_0000001'];
    let fetches = 0;
    const xml = () => `<feed><author><name>Cats</name></author>${videos.map((v) => `<entry><yt:videoId>${v}</yt:videoId><title>T ${v}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${v}"/></entry>`).join('')}</feed>`;
    const fakeFetch = async (url) => {
        fetches += 1;
        if (!url.includes(ytChannel)) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, text: async () => xml() };
    };
    const a = fakeChannel(id(80));
    const b = fakeChannel(id(81));
    a.isTextBased = () => true;
    b.isTextBased = () => true;
    const client = { channels: { cache: new Map([[a.id, a], [b.id, b]]) } };

    await feedsSvc.loadFeeds();
    await assert.rejects(feedsSvc.addFeed({ guildId, sourceInput: `UC${'x'.repeat(22)}`, channelId: a.id, createdBy: id(90) }, fakeFetch), /no channel/);
    const { feed, latest } = await feedsSvc.addFeed({ guildId, sourceInput: ytChannel, channelId: a.id, createdBy: id(90) }, fakeFetch);
    assert.equal(feed.lastItemId, 'vid_0000002');
    assert.equal(latest.author, 'Cats');
    await feedsSvc.addFeed({ guildId, sourceInput: ytChannel, channelId: b.id, template: '<@&123456789012345678> {title}', createdBy: id(90) }, fakeFetch);
    await assert.rejects(feedsSvc.addFeed({ guildId, sourceInput: ytChannel, channelId: b.id, createdBy: id(90) }, fakeFetch), /already/);

    // Only this test's feeds take part in the poll.
    feedsSvc.setFeedsForTests((await pgDb.pool.query('SELECT * FROM feeds WHERE guild_id = $1', [guildId])).rows);
    fetches = 0;
    let result = await feedsSvc.pollFeeds(client, fakeFetch);
    assert.deepEqual(result, { sources: 1, posted: 0 });
    assert.equal(fetches, 1, 'one fetch per YouTube channel');

    videos = ['vid_0000004', 'vid_0000003', ...videos];
    result = await feedsSvc.pollFeeds(client, fakeFetch);
    assert.equal(result.posted, 4);
    assert.deepEqual(a.sent.map((m) => m.payload.content.match(/vid_\d+/)[0]), ['vid_0000003', 'vid_0000004']);
    assert.deepEqual(b.sent[0].payload.allowedMentions, { parse: [], roles: ['123456789012345678'] });
    const { rows } = await pgDb.pool.query('SELECT last_item_id FROM feeds WHERE guild_id = $1', [guildId]);
    assert.ok(rows.every((row) => row.last_item_id === 'vid_0000004'));

    result = await feedsSvc.pollFeeds(client, fakeFetch);
    assert.equal(result.posted, 0, 'no reposts');
    assert.equal(feedsSvc.listFeeds(guildId).length, 2);

    assert.equal(await feedsSvc.removeFeed(guildId, feed.id), true);
    assert.equal(await feedsSvc.removeFeed(guildId, feed.id), false);
    assert.equal(feedsSvc.listFeeds(guildId).length, 1);
});
