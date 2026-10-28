import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSecondChanceRule, secondChanceEligible, secondChanceNotice } from '../../src/services/automod/policy.js';
import { buildCardPayload, cardTier } from '../../src/services/automod/reviewFormat.js';
import { entryFrom } from '../../src/services/automod/reviewCards.js';
import { normalizeSettings } from '../../src/services/automod/automodSettings.js';

test('second chance rules: severity <= 20, and language only without a slur', () => {
    for (const rule of ['caps', 'characters', 'english']) assert.equal(isSecondChanceRule({ rule }), true, rule);
    assert.equal(isSecondChanceRule({ rule: 'language' }), true);
    assert.equal(isSecondChanceRule({ rule: 'language', slur: true }), false);
    for (const rule of ['spam', 'mentions', 'disrespect', 'scam', 'harassment']) assert.equal(isSecondChanceRule({ rule }), false, rule);
});

test('second chance eligibility: first offence only, once per window, not on probation', () => {
    const hit = { rule: 'caps' };
    const ok = { hit, enabled: true, offences: 0, alreadyUsed: false };
    assert.equal(secondChanceEligible(ok), true);
    assert.equal(secondChanceEligible({ ...ok, enabled: false }), false);
    assert.equal(secondChanceEligible({ ...ok, offences: 1 }), false);
    assert.equal(secondChanceEligible({ ...ok, alreadyUsed: true }), false);
    assert.equal(secondChanceEligible({ ...ok, probation: true }), false);
    assert.equal(secondChanceEligible({ ...ok, hit: { rule: 'caps', forceLastStep: true } }), false);
    assert.equal(secondChanceEligible({ ...ok, hit: { rule: 'spam' } }), false);
    assert.equal(secondChanceEligible({ ...ok, hit: { rule: 'language', slur: true } }), false);
    assert.equal(normalizeSettings({}).secondChance, true);
    assert.equal(normalizeSettings({ secondChance: false }).secondChance, false);
});

test('second chance notice mentions the member and says what to fix', () => {
    assert.equal(secondChanceNotice('caps', '42', true), '<@42> Please repost without all the caps — no warning this time.');
    assert.equal(secondChanceNotice('english', '42', false), '<@42> Please edit your message in English — no warning this time.');
    assert.match(secondChanceNotice('characters', '1', true), /fancy fonts/);
});

test('second chance shows as a compact line without buttons', () => {
    const entry = entryFrom({
        guild: { id: 'g' }, rule: 'caps', evidence: 'wrote mostly in capital letters', targetUser: { id: '42', username: 'amy' },
        channelId: '7', content: 'HELLO', note: { emoji: '💬', title: 'Second chance' }, deleted: true,
    });
    assert.equal(entry.kind, 'note');
    assert.equal(cardTier(entry), 'compact');
    const payload = buildCardPayload(entry);
    assert.equal(payload.content, '💬 Second chance · <@42> · Excessive caps · <#7>');
    assert.deepEqual(payload.components, []);
    assert.deepEqual(payload.embeds, []);
});
