import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRelaxableRule, isTrustedMember, relaxForTrusted, trustMatters } from '../../src/services/automod/policy.js';
import { normalizeSettings } from '../../src/services/automod/automodSettings.js';

test('trusted: only rules with severity <= 20 are relaxable', () => {
    assert.equal(isRelaxableRule('caps'), true);
    assert.equal(isRelaxableRule('characters'), true);
    assert.equal(isRelaxableRule('english'), true);
    assert.equal(isRelaxableRule('spam'), false);
    assert.equal(isRelaxableRule('language'), false);
    assert.equal(isRelaxableRule('nope'), false);
});

test('trusted: the role or a high enough level', () => {
    const roles = new Set(['r1']);
    assert.equal(isTrustedMember({ roleIds: roles }, { roleId: 'r1', minLevel: 0 }), true);
    assert.equal(isTrustedMember({ roleIds: roles }, { roleId: 'r2', minLevel: 0 }), false);
    assert.equal(isTrustedMember({ roleIds: new Set(), level: 10 }, { roleId: null, minLevel: 10 }), true);
    assert.equal(isTrustedMember({ roleIds: new Set(), level: 9 }, { roleId: null, minLevel: 10 }), false);
    assert.equal(isTrustedMember({ roleIds: new Set(), level: null }, { roleId: null, minLevel: 10 }), false);
    assert.equal(isTrustedMember({ roleIds: new Set(), level: 50 }, { roleId: null, minLevel: 0 }), false);
    assert.equal(isTrustedMember({ roleIds: roles }, null), false);
});

test('trusted: checked only when a relaxable rule was hit; relaxing drops only those hits', () => {
    const hits = [{ rule: 'caps' }, { rule: 'spam' }];
    assert.equal(trustMatters(hits, { roleId: null, minLevel: 0 }), false);
    assert.equal(trustMatters([{ rule: 'spam' }], { roleId: 'r1', minLevel: 0 }), false);
    assert.equal(trustMatters(hits, { roleId: null, minLevel: 5 }), true);
    assert.deepEqual(relaxForTrusted(hits, true).map((h) => h.rule), ['spam']);
    assert.deepEqual(relaxForTrusted(hits, false).map((h) => h.rule), ['caps', 'spam']);
});

test('trusted settings normalize', () => {
    assert.deepEqual(normalizeSettings({}).trusted, { roleId: null, minLevel: 0 });
    assert.deepEqual(normalizeSettings({ trusted: { roleId: 'r', minLevel: '7' } }).trusted, { roleId: 'r', minLevel: 7 });
    assert.deepEqual(normalizeSettings({ trusted: { minLevel: -3 } }).trusted, { roleId: null, minLevel: 0 });
});
