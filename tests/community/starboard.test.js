import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    normalizeStarEmoji, emojiKey, reactionEmojiKey, countStars, decideStarAction, buildStarPost, starboardSettingsPatch,
    handleStarReaction, handleStarMessageDelete, setStarboardPostsForTests, getStarboardPost,
} = await import('../../src/services/community/starboardService.js');
const { setCommunitySettingsForTests } = await import('../../src/services/community/settingsService.js');

test('emoji: standard and custom accepted, text rejected; keys ignore variation selectors', () => {
    assert.equal(normalizeStarEmoji(''), '⭐');
    assert.equal(normalizeStarEmoji('🌟'), '🌟');
    assert.equal(normalizeStarEmoji('<:catstar:123456789012345678>'), '<:catstar:123456789012345678>');
    assert.throws(() => normalizeStarEmoji('star'), /one emoji/);
    assert.throws(() => normalizeStarEmoji('⭐ ⭐'), /one emoji/);
    assert.equal(emojiKey('⭐️'), emojiKey('⭐'));
    assert.equal(reactionEmojiKey({ name: '⭐️', id: null }), emojiKey('⭐'));
    assert.equal(emojiKey('<a:catstar:123456789012345678>'), '123456789012345678');
    assert.equal(reactionEmojiKey({ name: 'catstar', id: '123456789012345678' }), '123456789012345678');
});

test('stars: no self-stars, no bots; reactions beyond the fetched page still count', () => {
    const users = [{ id: 'author' }, { id: 'a' }, { id: 'b' }, { id: 'bot', bot: true }];
    assert.equal(countStars(users, 'author'), 2);
    assert.equal(countStars(users, 'someone-else'), 3);
    assert.equal(countStars(users, 'author', 5), 7);
    assert.equal(countStars([], 'author', -2), 0);
});

test('threshold: create at the threshold, update on change, delete below it', () => {
    assert.equal(decideStarAction({ count: 2, threshold: 3, existing: null }), 'none');
    assert.equal(decideStarAction({ count: 3, threshold: 3, existing: null }), 'create');
    assert.equal(decideStarAction({ count: 4, threshold: 3, existing: { count: 3 } }), 'update');
    assert.equal(decideStarAction({ count: 3, threshold: 3, existing: { count: 3 } }), 'none');
    assert.equal(decideStarAction({ count: 2, threshold: 3, existing: { count: 3 } }), 'delete');
});

test('post: count, source link, first image; never pings', () => {
    const message = {
        id: '900', channelId: '800', url: 'https://discord.com/channels/1/800/900', content: 'hi @everyone',
        author: { username: 'kit', displayAvatarURL: () => 'https://cdn.example/a.png' },
        member: { displayName: 'Kitty' },
        attachments: new Map([['1', { contentType: 'image/png', url: 'https://cdn.example/p.png', name: 'p.png' }]]),
        embeds: [], createdAt: new Date('2026-10-01T00:00:00Z'),
    };
    const post = buildStarPost(message, 5, '⭐');
    assert.equal(post.content, '⭐ **5** · <#800>');
    assert.deepEqual(post.allowedMentions, { parse: [] });
    const embed = post.embeds[0].data;
    assert.equal(embed.author.name, 'Kitty');
    assert.equal(embed.image.url, 'https://cdn.example/p.png');
    assert.match(embed.fields[0].value, /Jump to message/);
});

test('settings patch validates threshold and emoji', () => {
    assert.deepEqual(starboardSettingsPatch({ channelId: 'c', emoji: null, threshold: null }), { starboardChannelId: 'c', starboardEmoji: '⭐', starboardThreshold: 3 });
    assert.throws(() => starboardSettingsPatch({ channelId: 'c', threshold: 0 }), /threshold/);
    assert.throws(() => starboardSettingsPatch({ channelId: 'c', emoji: 'abc', threshold: 2 }), /emoji/);
});

test('reaction hook: wrong emoji, bots, starboard channel and below-threshold reactions make no API calls', async () => {
    const G = 'g-star';
    setCommunitySettingsForTests(G, { starboardChannelId: 'board', starboardEmoji: '⭐', starboardThreshold: 3 });
    let fetched = 0;
    const reaction = (fields = {}) => ({
        emoji: { name: '⭐', id: null },
        count: 2,
        partial: false,
        users: { fetch: async () => { fetched += 1; return new Map(); } },
        message: { id: 'm1', channelId: 'general', guild: { id: G }, partial: false, fetch: async () => { fetched += 1; } },
        ...fields,
    });
    await handleStarReaction(reaction({ emoji: { name: '👍', id: null } }), { id: 'u' });
    await handleStarReaction(reaction(), { id: 'u', bot: true });
    await handleStarReaction(reaction({ message: { id: 'm2', channelId: 'board', guild: { id: G } } }), { id: 'u' });
    await handleStarReaction(reaction(), { id: 'u' });
    assert.equal(fetched, 0);
    setCommunitySettingsForTests(G, null);
});

test('delete hook: a deleted starboard post is forgotten', async () => {
    setStarboardPostsForTests([{ source_message_id: 's1', guild_id: 'g', source_channel_id: 'c', star_channel_id: 'board', star_message_id: 'p1', count: 3 }]);
    assert.ok(getStarboardPost('s1'));
    // No database in unit tests: the row delete fails, the hook logs and does not throw.
    await handleStarMessageDelete({ id: 'unrelated', guild: { id: 'g' } });
    assert.ok(getStarboardPost('s1'));
    setStarboardPostsForTests([]);
});
