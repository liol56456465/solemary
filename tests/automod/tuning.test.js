import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    aggregateRuleStats, formatTuningSuggestion, ruleForCase, tuningSuggestions,
} from '../../src/services/automod/policy.js';
import { tuningComponents } from '../../src/services/automod/automodTuning.js';

const DAY = 24 * 60 * 60 * 1000;

test('cases map to rules: single-rule groups by key, shared groups by label', () => {
    assert.equal(ruleForCase('automod:english', 'Automod: English only'), 'english');
    assert.equal(ruleForCase('automod:english', 'anything'), 'english');
    assert.equal(ruleForCase('automod:spam', 'Automod: Excessive caps'), 'caps');
    assert.equal(ruleForCase('automod:spam', 'Automod: Excessive caps (changed by bob)'), 'caps');
    assert.equal(ruleForCase('automod:spam', 'Automod: Spam'), 'spam');
    assert.equal(ruleForCase('automod:spam', 'Automod: Mass mentions during a join raid'), 'mentions');
    assert.equal(ruleForCase('automod:spam', 'Reported message'), null);
    assert.equal(ruleForCase('automod:report', 'Reported message'), null);
    assert.equal(ruleForCase('automod:native:123', 'x'), null);
    assert.equal(ruleForCase('spam', 'Automod: Spam'), null);
    assert.equal(ruleForCase(null, null), null);
});

test('rule stats aggregate across reasons', () => {
    const byRule = aggregateRuleStats([
        { reasonKey: 'automod:spam', reason: 'Automod: Excessive caps', actions: 15, undone: 6, changed: 0 },
        { reasonKey: 'automod:spam', reason: 'Automod: Excessive caps (changed by a)', actions: 5, undone: 1, changed: 2 },
        { reasonKey: 'automod:spam', reason: 'Automod: Spam', actions: 3, undone: 0, changed: 0 },
        { reasonKey: 'automod:report', reason: 'Reported message', actions: 9, undone: 9, changed: 0 },
    ]);
    assert.deepEqual(byRule, {
        caps: { actions: 20, undone: 7, changed: 2 },
        spam: { actions: 3, undone: 0, changed: 0 },
    });
});

test('tuning suggestion: >= 30% corrected over >= 10 actions, enforced rules, once a week', () => {
    const now = 100 * DAY;
    const settings = { mode: 'enforce', ruleModes: {} };
    const byRule = {
        caps: { actions: 20, undone: 9, changed: 0 },      // 45% → yes
        english: { actions: 10, undone: 2, changed: 1 },   // 30% → yes (boundary)
        spam: { actions: 9, undone: 9, changed: 0 },       // too few actions
        characters: { actions: 20, undone: 5, changed: 0 }, // 25% → no
    };
    let out = tuningSuggestions(byRule, { settings, now });
    assert.deepEqual(out.map((s) => s.rule), ['caps', 'english']);
    assert.equal(out[0].corrected, 9);

    // Suggested 3 days ago → not again; 7 days ago → again.
    out = tuningSuggestions(byRule, { settings, now, lastSuggested: { caps: now - 3 * DAY, english: now - 7 * DAY } });
    assert.deepEqual(out.map((s) => s.rule), ['english']);

    // Already monitored or off (by rule or globally) → nothing to suggest.
    assert.deepEqual(tuningSuggestions(byRule, { settings: { mode: 'enforce', ruleModes: { caps: 'monitor', english: 'off' } }, now }), []);
    assert.deepEqual(tuningSuggestions(byRule, { settings: { mode: 'monitor', ruleModes: {} }, now }), []);
});

test('tuning suggestion text and button', () => {
    assert.equal(formatTuningSuggestion({ rule: 'caps', actions: 20, corrected: 9, undone: 9, changed: 0 }),
        'Excessive caps: 9 of 20 undone in 14 days — switch to monitor?');
    assert.match(formatTuningSuggestion({ rule: 'caps', actions: 20, corrected: 9, undone: 7, changed: 2 }), /undone or changed/);
    const [row] = tuningComponents('caps');
    const json = row.toJSON();
    assert.equal(json.components[0].custom_id, 'amreview:tune:caps');
    assert.equal(json.components[1].custom_id, 'amreview:dismiss');
});
