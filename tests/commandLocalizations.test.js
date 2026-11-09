// utils/commandLocalizations.js is the one command-text helper (the old Core/modules/commandText.js
// was merged into it): localized() = descriptionLocalizations() plus English, one locale table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { LANG_CODES, botText } from '../src/utils/botText.js';
import {
    DESCRIPTION_LIMIT, DISCORD_LOCALES, DISCORD_LOCALES_BY_LANG, descriptionLocalizations, englishDescription, localized, publicText, replyText,
} from '../src/utils/commandLocalizations.js';

test('one locale table: all 8 languages, the non-English view leaves English out', () => {
    assert.deepEqual(Object.keys(DISCORD_LOCALES).sort(), [...LANG_CODES].sort());
    assert.deepEqual(Object.keys(DISCORD_LOCALES_BY_LANG).sort(), LANG_CODES.filter((lang) => lang !== 'en').sort());
    for (const [lang, locales] of Object.entries(DISCORD_LOCALES_BY_LANG)) assert.deepEqual(locales, DISCORD_LOCALES[lang]);
});

test('localized() is descriptionLocalizations() plus en-US / en-GB = the English description', () => {
    const key = 'core.slash.ping.description';
    const out = localized(key);
    assert.deepEqual({ ...out, 'en-US': undefined, 'en-GB': undefined }, { ...descriptionLocalizations(key), 'en-US': undefined, 'en-GB': undefined });
    assert.equal(out['en-US'], englishDescription(key));
    assert.equal(out['en-GB'], englishDescription(key));
    assert.equal(out.ru, botText('ru').t(key));
    for (const text of Object.values(out)) assert.ok(text.length <= DESCRIPTION_LIMIT);
    assert.throws(() => localized('core.slash.no.such.key'));
});

test('replyText: the user\'s locale; prefix commands and publicText: the server\'s language', () => {
    assert.equal(replyText({ locale: 'de', guildId: null }).lang, 'de');
    assert.equal(replyText({ locale: 'de', guildId: null, _isPrefixCommand: true }).lang, 'en');
    assert.equal(publicText({ locale: 'de', guildId: null }).lang, 'en');
});

test('the old helper is gone', () => {
    assert.equal(existsSync(new URL('../src/commands/Core/modules/commandText.js', import.meta.url)), false);
});
