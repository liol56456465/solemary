import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    channelCandidates, channelRuleOverride, globalRuleMode, hasRuleOverride, resolveRuleMode, ruleMode, withChannelRule,
} from '../../src/services/automod/policy.js';
import { applyRuleModes, worstHit } from '../../src/services/automod/automodService.js';
import { normalizeSettings } from '../../src/services/automod/automodSettings.js';

test('rule mode: the global mode is the default for rules without an override', () => {
    assert.equal(globalRuleMode({ mode: 'enforce' }), 'on');
    assert.equal(globalRuleMode({ mode: 'monitor' }), 'monitor');
    assert.equal(globalRuleMode({}), 'on');
    assert.equal(ruleMode({ mode: 'monitor', ruleModes: {} }, 'caps'), 'monitor');
    assert.equal(ruleMode({ mode: 'enforce', ruleModes: { caps: 'off' } }, 'caps'), 'off');
    assert.equal(ruleMode({ mode: 'monitor', ruleModes: { scam: 'on' } }, 'scam'), 'on');
    assert.equal(ruleMode({ mode: 'enforce', ruleModes: { caps: 'bogus' } }, 'caps'), 'on');
    assert.equal(hasRuleOverride({ ruleModes: { caps: 'monitor' } }, 'caps'), true);
    assert.equal(hasRuleOverride({ ruleModes: {} }, 'caps'), false);
    assert.equal(resolveRuleMode({ mode: 'enforce', ruleModes: { english: 'monitor' } }, 'english'), 'monitor');
});

test('rule modes on hits: off hits are dropped, the worst remaining hit decides', () => {
    const settings = normalizeSettings({ mode: 'enforce', ruleModes: { language: 'off', caps: 'monitor' } });
    const hits = applyRuleModes([{ rule: 'language' }, { rule: 'caps' }, { rule: 'english' }], settings);
    assert.deepEqual(hits.map((h) => [h.rule, h.mode]), [['caps', 'monitor'], ['english', 'on']]);
    assert.equal(worstHit(hits).rule, 'caps');
    assert.deepEqual(applyRuleModes([{ rule: 'language' }], settings), []);
});

test('settings normalize: defaults filled, nested objects copied', () => {
    const stored = { mode: 'monitor', ruleModes: { caps: 'off' } };
    const value = normalizeSettings(stored);
    assert.equal(value.enabled, true);
    assert.deepEqual(value.exemptChannelIds, []);
    value.ruleModes.caps = 'on';
    assert.equal(stored.ruleModes.caps, 'off');
    assert.deepEqual(normalizeSettings(null).ruleModes, {});
});

test('channel exceptions: most specific wins, threads and categories inherit', () => {
    const settings = {
        mode: 'enforce',
        ruleModes: { caps: 'monitor' },
        channelRules: { intl: { english: 'off' }, cat: { english: 'monitor', caps: 'off' } },
    };
    const intl = { id: 'intl', parentId: 'cat' };
    const thread = { id: 't1', parentId: 'intl', parent: { parentId: 'cat' } };
    const other = { id: 'gen', parentId: 'cat' };
    const outside = { id: 'x', parentId: null };
    assert.deepEqual(channelCandidates(thread), ['t1', 'intl', 'cat']);
    assert.equal(resolveRuleMode(settings, 'english', intl), 'off');
    assert.equal(resolveRuleMode(settings, 'english', thread), 'off');
    assert.equal(resolveRuleMode(settings, 'english', other), 'monitor');
    assert.equal(resolveRuleMode(settings, 'english', outside), 'on');
    assert.equal(resolveRuleMode(settings, 'caps', other), 'off');
    assert.equal(resolveRuleMode(settings, 'caps', outside), 'monitor');
    assert.deepEqual(channelRuleOverride(settings, 'english', thread), { mode: 'off', channelId: 'intl' });
    assert.equal(channelRuleOverride(settings, 'scam', thread), null);

    let rules = withChannelRule({}, 'intl', 'english', 'off');
    assert.deepEqual(rules, { intl: { english: 'off' } });
    rules = withChannelRule(rules, 'intl', 'caps', 'monitor');
    assert.deepEqual(rules, { intl: { english: 'off', caps: 'monitor' } });
    rules = withChannelRule(rules, 'intl', 'english', 'default');
    rules = withChannelRule(rules, 'intl', 'caps', 'default');
    assert.deepEqual(rules, {});
    // Applied before acting: the hit is dropped in that channel only.
    assert.deepEqual(applyRuleModes([{ rule: 'english' }], normalizeSettings(settings), intl), []);
    assert.equal(applyRuleModes([{ rule: 'english' }], normalizeSettings(settings), outside).length, 1);
});
