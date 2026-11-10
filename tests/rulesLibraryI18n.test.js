import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES_LIBRARY, RULES_LIBRARY_TRANSLATIONS, libraryIn, libraryRuleIn } from '../src/config/rulesLibrary.js';
import { RULES_LIMITS } from '../src/services/settings/settingsRegistry.js';

test('rule library: every rule in all 7 languages, within the rule limits, translated, plain punctuation', () => {
    const keys = RULES_LIBRARY.map((r) => r.key).sort();
    for (const [lang, entries] of Object.entries(RULES_LIBRARY_TRANSLATIONS)) {
        assert.deepEqual(Object.keys(entries).sort(), keys, `${lang}: same rules`);
        for (const [key, [title, text, consequence]] of Object.entries(entries)) {
            const en = RULES_LIBRARY.find((r) => r.key === key);
            assert.ok(title.length <= RULES_LIMITS.titleMax && !/[\r\n]/.test(title), `${lang}/${key} title`);
            assert.ok(text.length <= RULES_LIMITS.textMax, `${lang}/${key} text`);
            assert.ok(consequence.length <= RULES_LIMITS.consequenceMax && !/[\r\n]/.test(consequence), `${lang}/${key} consequence ${consequence.length}`);
            assert.notEqual(text, en.text, `${lang}/${key} translated`);
            assert.ok(!/—/.test(title + text + consequence), `${lang}/${key} no em dash`);
            assert.ok(!/\.$/.test(consequence), `${lang}/${key} consequence without a full stop (the hint adds one)`);
        }
    }
});

test('rule library: the server language picks the text; the link to the prebuilt reason stays', () => {
    assert.equal(libraryRuleIn('raiding', 'de').title, 'Keine Raids');
    assert.equal(libraryRuleIn('raiding', 'de').reason, 'raiding');
    assert.equal(libraryRuleIn('raiding', 'en').title, 'No raiding');
    assert.equal(libraryRuleIn('raiding', 'xx').title, 'No raiding');
    assert.equal(libraryIn('ru').length, RULES_LIBRARY.length);
});
