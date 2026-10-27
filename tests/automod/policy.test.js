import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globalRuleMode, hasRuleOverride, resolveRuleMode, ruleMode } from '../../src/services/automod/policy.js';
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
