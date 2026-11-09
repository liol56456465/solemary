// Merge of beginner waves A1 (one plain "Warnings" line) and B (warn ladder switch): with the ladder off,
// the panel line never promises an automatic ban, in every language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warnStatusText } from '../src/services/enforcement/flowBuilder.js';
import { LANG_CODES } from '../src/utils/botText.js';

test('ladder off: no "next one bans" / "at 3 they are banned" line', () => {
    for (const lang of LANG_CODES) {
        const off = warnStatusText({ level: 0, warns_since_level: 2, enabled: false }, { lang });
        const on = warnStatusText({ level: 0, warns_since_level: 2, enabled: true }, { lang });
        assert.ok(off.includes('2'), lang);
        assert.notEqual(off, on, `${lang}: the ladder-off line differs from the ladder line`);
    }
    assert.equal(warnStatusText({ level: 0, warns_since_level: 2, enabled: false }, { lang: 'en' }), '**Warnings:** 2 (warn ladder off)');
});
