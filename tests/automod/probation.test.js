import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProbationActive, ladderIndex, shouldStartProbation } from '../../src/services/automod/policy.js';
import { buildCardPayload } from '../../src/services/automod/reviewFormat.js';
import { entryFrom } from '../../src/services/automod/reviewCards.js';
import { AUTOMOD_RULES } from '../../src/config/automod.js';

const DAY = 24 * 60 * 60 * 1000;

test('ladder: probation moves one step up, capped; ad bots take the last step', () => {
    assert.equal(ladderIndex({ offences: 0, stepCount: 3 }), 0);
    assert.equal(ladderIndex({ offences: 0, stepCount: 3, probation: true }), 1);
    assert.equal(ladderIndex({ offences: 1, stepCount: 3, probation: true }), 2);
    assert.equal(ladderIndex({ offences: 5, stepCount: 3, probation: true }), 2);
    assert.equal(ladderIndex({ offences: 5, stepCount: 3 }), 2);
    assert.equal(ladderIndex({ offences: 0, stepCount: 1, probation: true }), 0);
    assert.equal(ladderIndex({ offences: 0, stepCount: 3, forceLastStep: true }), 2);
    // Caps on probation: first offence is a 1-hour mute instead of a warn.
    const caps = AUTOMOD_RULES.caps.steps;
    assert.equal(caps[ladderIndex({ offences: 0, stepCount: caps.length, probation: true })].type, 'mute');
});

test('probation starts after a recently ended ban, once, never with an active ban', () => {
    const now = 100 * DAY;
    const endedBan = { endedAt: new Date(now - 2 * DAY).toISOString() };
    assert.equal(shouldStartProbation({ endedBan, hasActiveBan: false, existing: null, now }), true);
    assert.equal(shouldStartProbation({ endedBan: null, hasActiveBan: false, existing: null, now }), false);
    assert.equal(shouldStartProbation({ endedBan, hasActiveBan: true, existing: null, now }), false);
    assert.equal(shouldStartProbation({ endedBan, hasActiveBan: false, existing: { until: now + DAY }, now }), false);
    // An expired probation record does not block a new one.
    assert.equal(shouldStartProbation({ endedBan, hasActiveBan: false, existing: { until: now - 1 }, now }), true);
    // Ended too long ago (or in the future) → no probation.
    assert.equal(shouldStartProbation({ endedBan: { endedAt: now - 31 * DAY }, hasActiveBan: false, existing: null, now }), false);
    assert.equal(shouldStartProbation({ endedBan: { endedAt: now + DAY }, hasActiveBan: false, existing: null, now }), false);
    assert.equal(isProbationActive({ until: now + 1 }, now), true);
    assert.equal(isProbationActive({ until: now }, now), false);
    assert.equal(isProbationActive(null, now), false);
});

test('every card for a member on probation is marked', () => {
    const until = Date.UTC(2026, 10, 3);
    const base = {
        guild: { id: 'g' }, rule: 'caps', evidence: 'wrote mostly in capital letters', targetUser: { id: '42', username: 'amy' },
        channelId: '7', content: 'HELLO', probation: { until },
    };
    const stamp = `<t:${Math.floor(until / 1000)}:D>`;
    const compact = buildCardPayload(entryFrom({ ...base, step: { type: 'warn' }, result: { record: { case_code: 'abc1234' } } }));
    assert.match(compact.content, new RegExp(`⚠️ on probation \\(rejoined after ban, until ${stamp}\\)`));
    const full = buildCardPayload(entryFrom({ ...base, monitor: true, suggested: { type: 'mute', durationMs: 3600000 } }));
    assert.match(full.embeds[0].data.description, /on probation \(rejoined after ban/);
    const note = buildCardPayload(entryFrom({ ...base, note: { emoji: '💬', title: 'Second chance' } }));
    assert.match(note.content, /on probation/);
    const plain = buildCardPayload(entryFrom({ ...base, probation: null, step: { type: 'warn' }, result: { record: { case_code: 'abc1234' } } }));
    assert.doesNotMatch(plain.content, /probation/);
});
