import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHeat, messageHeat, shouldCalmChannel } from '../../src/services/automod/policy.js';
import { CALM_NOTE, noteMoodSignals, resetMoodState } from '../../src/services/automod/moodService.js';

const MIN = 60 * 1000;

test('mood: a message counts its heaviest signal; unrelated rules count nothing', () => {
    assert.equal(messageHeat([{ rule: 'caps' }]), 1);
    assert.equal(messageHeat([{ rule: 'caps' }, { rule: 'disrespect' }]), 2);
    assert.equal(messageHeat([{ rule: 'harassment' }]), 3);
    assert.equal(messageHeat([{ rule: 'english' }, { rule: 'spam' }]), 0);
    assert.equal(messageHeat([]), 0);
});

test('mood: heat over a 3-minute window with distinct members', () => {
    const now = 10 * MIN;
    const events = [
        { at: now - 4 * MIN, userId: 'a', weight: 3 },  // outside the window
        { at: now - 2 * MIN, userId: 'a', weight: 2 },
        { at: now - 1 * MIN, userId: 'b', weight: 2 },
        { at: now, userId: 'b', weight: 1 },
    ];
    assert.deepEqual(computeHeat(events, now), { score: 5, members: 2 });
});

test('mood: calm down at threshold with >= 3 members, once per 30 minutes', () => {
    const now = 100 * MIN;
    assert.equal(shouldCalmChannel({ score: 6, members: 3 }, { now }), true);
    assert.equal(shouldCalmChannel({ score: 5, members: 3 }, { now }), false);
    assert.equal(shouldCalmChannel({ score: 20, members: 2 }, { now }), false);
    assert.equal(shouldCalmChannel({ score: 6, members: 3 }, { now, lastCalmAt: now - 29 * MIN }), false);
    assert.equal(shouldCalmChannel({ score: 6, members: 3 }, { now, lastCalmAt: now - 30 * MIN }), true);
});

test('mood: three members trading insults get one calm-down note, then the cooldown', async () => {
    resetMoodState();
    const sent = [];
    const channel = {
        id: 'c1',
        client: { guilds: { cache: new Map() } },
        isThread: () => false,
        // No setRateLimitPerUser: slowmode can't be set, so the note says only "keep it friendly".
        send: async (payload) => { sent.push(payload); return {}; },
    };
    const msg = (userId) => ({ channelId: 'c1', channel, author: { id: userId } });
    const settings = { moodAlerts: true };
    const now = 1000 * MIN;
    assert.equal(await noteMoodSignals(msg('a'), [{ rule: 'disrespect' }], settings, now), false);
    assert.equal(await noteMoodSignals(msg('b'), [{ rule: 'disrespect' }], settings, now + 1000), false);
    assert.equal(await noteMoodSignals(msg('a'), [{ rule: 'caps' }], settings, now + 2000), false);
    assert.equal(await noteMoodSignals(msg('c'), [{ rule: 'caps' }], settings, now + 3000), true);
    assert.equal(sent.length, 1);
    assert.notEqual(sent[0].content, CALM_NOTE);
    assert.match(sent[0].content, /keep it friendly/);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    for (let i = 0; i < 6; i += 1) await noteMoodSignals(msg(`u${i}`), [{ rule: 'harassment' }], settings, now + 10000 + i);
    assert.equal(sent.length, 1);
    // Off: nothing is tracked.
    resetMoodState();
    for (let i = 0; i < 6; i += 1) assert.equal(await noteMoodSignals(msg(`u${i}`), [{ rule: 'harassment' }], { moodAlerts: false }, now + i), false);
});
