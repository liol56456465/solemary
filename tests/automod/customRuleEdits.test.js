import test from 'node:test';
import assert from 'node:assert/strict';
import { addRule, editRule, findRule, removeRule, toggleRule } from '../../src/services/automod/customRuleEdits.js';
import { customRuleChoices, customRulesText } from '../../src/commands/Enforcement/automod.js';

const rule = (id, name, extra = {}) => ({ id, name, words: ['abc'], action: 'warn', muteDuration: null, enabled: true, ...extra });
const LIST = [rule('aaaa1111', 'Ads'), rule('bbbb2222', 'Links', { action: 'delete', enabled: false })];

test('findRule matches by name (any case, spaces folded) or id', () => {
    assert.equal(findRule(LIST, '  ADS ').id, 'aaaa1111');
    assert.equal(findRule(LIST, 'bbbb2222').name, 'Links');
    assert.equal(findRule(LIST, 'nope'), null);
    assert.equal(findRule(LIST, ''), null);
});

test('addRule cleans the new rule and respects the plan limit', () => {
    const next = addRule(LIST, { name: 'Invites', words: 'discord gg, Join My Server', action: 'mute', muteDuration: '1h' }, { limit: 5, planName: 'Pro' });
    assert.equal(next.length, 3);
    assert.deepEqual(next[2].words, ['discord gg', 'join my server']);
    assert.equal(next[2].muteDuration, '1h');
    assert.throws(() => addRule(LIST, { name: 'X', words: 'abc', action: 'warn' }, { limit: 2, planName: 'Normal' }), /the most the Normal plan allows/);
    assert.throws(() => addRule([], { name: 'X', words: 'abc', action: 'warn' }, { limit: 0 }), /Normal, Pro and Max/);
    assert.throws(() => addRule(LIST, { name: 'ads', words: 'abc', action: 'warn' }, { limit: 5 }), /already a custom rule called/);
    assert.throws(() => addRule(LIST, { name: 'Mute', words: 'abc', action: 'mute' }, { limit: 5 }), /needs a duration/);
});

test('editRule replaces words, changes the action, keeps the id; unknown rule is a readable error', () => {
    const { list, rule: changed } = editRule(LIST, 'ads', { words: 'one, two' });
    assert.deepEqual(changed.words, ['one', 'two']);
    assert.equal(changed.id, 'aaaa1111');
    assert.equal(list.length, 2);
    const muted = editRule(LIST, 'Ads', { action: 'mute', muteDuration: '30m' }).rule;
    assert.deepEqual([muted.action, muted.muteDuration, muted.words], ['mute', '30m', ['abc']]);
    assert.equal(editRule([rule('cccc3333', 'M', { action: 'mute', muteDuration: '1h' })], 'M', { action: 'delete' }).rule.muteDuration, null);
    assert.throws(() => editRule(LIST, 'Ads', { action: 'mute' }), /needs a duration/);
    assert.throws(() => editRule(LIST, 'Ads', { words: '' }), /at least one word/);
    assert.throws(() => editRule(LIST, 'gone', { words: 'x y' }), /no custom rule called "gone"/);
});

test('toggleRule and removeRule', () => {
    const on = toggleRule(LIST, 'Links', true);
    assert.equal(on.changed, true);
    assert.equal(on.rule.enabled, true);
    assert.equal(toggleRule(LIST, 'Ads', true).changed, false);
    const removed = removeRule(LIST, 'ads');
    assert.deepEqual(removed.list.map((r) => r.id), ['bbbb2222']);
    assert.equal(removed.rule.name, 'Ads');
    assert.throws(() => removeRule(LIST, 'x'), /no custom rule/);
});

test('/automod custom list text and autocomplete', () => {
    const text = customRulesText(LIST, 1, 'Normal');
    assert.match(text, /2 rules, up to 1 run on the Normal plan\./);
    assert.match(text, /\*\*Ads\*\*: Warn, on/);
    assert.match(text, /\*\*Links\*\*: Delete, off/);
    assert.match(customRulesText([rule('a1b2c3d4', 'A'), rule('e5f6g7h8', 'B')], 1, 'Normal'), /\*\*B\*\*: Warn, over the plan limit, not running/);
    assert.match(customRulesText([], 0, 'Free'), /Normal, Pro and Max/);
    assert.match(customRulesText([], 5, 'Normal'), /No custom rules yet/);
    assert.ok(!/—/.test(text));
    assert.deepEqual(customRuleChoices(LIST, 'lin'), [{ name: 'Links (Delete, off)', value: 'bbbb2222' }]);
    assert.equal(customRuleChoices(LIST).length, 2);
});
