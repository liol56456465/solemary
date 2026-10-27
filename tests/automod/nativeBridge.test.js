import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoModerationActionType } from 'discord.js';
import {
    DEFAULT_NATIVE_POLICY, isBridgedAction, isDuplicate, nativeEvidence, policyFor, triggerLabel,
} from '../../src/services/automod/nativeBridge.js';
import { buildCardPayload } from '../../src/services/automod/reviewFormat.js';
import { entryFrom } from '../../src/services/automod/reviewCards.js';

test('native: only the BlockMessage action is bridged (one per trigger)', () => {
    assert.equal(isBridgedAction({ type: AutoModerationActionType.BlockMessage }), true);
    assert.equal(isBridgedAction({ type: AutoModerationActionType.SendAlertMessage }), false);
    assert.equal(isBridgedAction({ type: AutoModerationActionType.Timeout }), false);
    assert.equal(isBridgedAction(null), false);
});

test('native: rules without a row are logged with a 10-minute dedupe', () => {
    const rules = new Map([['1', { policy: 'warn', dedupeMinutes: 5 }]]);
    assert.deepEqual(policyFor(rules, '1'), { policy: 'warn', dedupeMinutes: 5 });
    assert.deepEqual(policyFor(rules, '2'), DEFAULT_NATIVE_POLICY);
    assert.deepEqual(policyFor(null, '2'), { policy: 'log', dedupeMinutes: 10 });
});

test('native: dedupe one action per member and rule within N minutes', () => {
    const now = 1_000_000_000;
    assert.equal(isDuplicate(undefined, 10, now), false);
    assert.equal(isDuplicate(now - 9 * 60 * 1000, 10, now), true);
    assert.equal(isDuplicate(now - 10 * 60 * 1000, 10, now), false);
    assert.equal(isDuplicate(now - 1000, 0, now), false);
});

test('native: evidence keeps the keyword behind a spoiler; cards and lines', () => {
    assert.equal(nativeEvidence('Bad words', 'darn'), 'triggered the Discord AutoMod rule "Bad words" (matched ||darn||)');
    assert.equal(nativeEvidence('Spam', null), 'triggered the Discord AutoMod rule "Spam"');
    assert.equal(triggerLabel(1), 'keyword');
    assert.equal(triggerLabel(99), 'trigger 99');

    const base = {
        guild: { id: 'g' }, rule: 'native:123', ruleLabel: 'Discord AutoMod: Bad words',
        evidence: nativeEvidence('Bad words', 'darn'), targetUser: { id: '42', username: 'amy' },
        channelId: '7', content: 'darn it', deleted: true,
    };
    const line = buildCardPayload(entryFrom({ ...base, note: { emoji: '🛡️', title: 'Discord AutoMod blocked a message' } }));
    assert.equal(line.content, '🛡️ Discord AutoMod blocked a message · <@42> · Discord AutoMod: Bad words · <#7>');
    const card = buildCardPayload(entryFrom({ ...base, step: { type: 'warn' }, result: { record: { case_code: 'abc1234' } }, tier: 'full' }));
    const embed = card.embeds[0].data;
    assert.equal(embed.title, '🟡 Warned — Discord AutoMod: Bad words');
    assert.match(embed.description, /\|\|darn\|\|/);
    assert.equal(embed.fields[0].value, '||darn it||');
    assert.equal(card.components[0].toJSON().components[0].custom_id, 'amreview:keep:abc1234');
});
