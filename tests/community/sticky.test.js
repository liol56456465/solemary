import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    nextRepostDelay, noteStickyActivity, listStickies, getSticky, setStickiesForTests, buildStickyPayload,
    STICKY_MIN_INTERVAL_MS, STICKY_SETTLE_MS,
} = await import('../../src/services/community/stickyService.js');

const G = '100000000000000001';

test('repost delay: at least the settle time, and never sooner than the interval after the last post', () => {
    const now = 1_000_000;
    assert.equal(nextRepostDelay(now, 0), STICKY_SETTLE_MS);
    assert.equal(nextRepostDelay(now, now - 60_000), STICKY_SETTLE_MS);
    assert.equal(nextRepostDelay(now, now - 5_000), STICKY_MIN_INTERVAL_MS - 5_000);
    assert.equal(nextRepostDelay(now, now), STICKY_MIN_INTERVAL_MS);
    assert.ok(STICKY_MIN_INTERVAL_MS >= 15_000);
});

test('activity: only channels with a sticky schedule one repost; bursts coalesce; bots are ignored', () => {
    setStickiesForTests([
        { channel_id: 'c1', guild_id: G, content: 'Read the rules', last_message_id: 'm1' },
        { channel_id: 'c2', guild_id: 'other', content: 'x', last_message_id: null },
    ]);
    const message = (channelId, bot = false) => ({ channel: { id: channelId, send: async () => null }, author: { bot } });
    assert.equal(noteStickyActivity(message('nope')), false);
    assert.equal(noteStickyActivity(message('c1', true)), false);
    assert.equal(noteStickyActivity(message('c1')), true);
    assert.equal(noteStickyActivity(message('c1')), false); // already scheduled
    assert.ok(getSticky('c1').timer);
    assert.deepEqual(listStickies(G), [{ channelId: 'c1', content: 'Read the rules', lastMessageId: 'm1' }]);
    setStickiesForTests([]); // clears the pending timer
    assert.equal(getSticky('c1'), null);
});

test('payload: never pings', () => {
    const payload = buildStickyPayload('@everyone hi');
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(payload.embeds[0].data.description, '@everyone hi');
});
