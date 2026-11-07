import test from 'node:test';
import assert from 'node:assert/strict';
import { banDm, englishOnError } from '../src/services/enforcement/dmTemplates.js';

test('a failing non-English DM template falls back to English instead of throwing', () => {
    const calls = [];
    const render = (rec, { lang } = {}) => {
        calls.push(lang);
        if (lang !== 'en') throw new Error('missing {placeholder}');
        return `ok ${rec.id}`;
    };
    const safe = englishOnError('fakeDm', render);
    assert.equal(safe({ id: 7 }, { lang: 'de' }), 'ok 7');
    assert.deepEqual(calls, ['de', 'en']);
});

test('an English failure still throws (a code bug, not a catalog problem)', () => {
    const safe = englishOnError('fakeDm', () => { throw new Error('boom'); });
    assert.throws(() => safe({}, { lang: 'en' }), /boom/);
    assert.throws(() => safe({}), /boom/);
});

test('the exported templates are wrapped and still render', () => {
    const rec = { case_code: 'abc23', reason: 'Spam', duration_ms: null, expires_at: null, created_at: new Date() };
    assert.equal(typeof banDm(rec, { lang: 'de' }), 'string');
});
