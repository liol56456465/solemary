import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_TEMPLATES, fillTemplate, templateLanguages } from '../src/config/messageTemplates.js';

const LANGS = ['de', 'fr', 'es', 'it', 'pl', 'pt-BR', 'ru'];
const placeholders = (s) => (s.match(/\{[a-z]+\}/g) || []).sort();
const code = (s) => (s.match(/`[^`]+`/g) || []).sort();
const emoji = (s) => (s.match(/\p{Extended_Pictographic}/gu) || []).length;
const bangs = (s) => (s.replace(/¡/g, '').match(/!/g) || []).length;
const lines = (s) => s.split('\n').length;

test('message templates: all 88 in 7 languages; placeholders, commands and line layout kept; plain voice', () => {
    for (const t of MESSAGE_TEMPLATES) {
        assert.deepEqual(templateLanguages(t), ['en', ...LANGS], `${t.id}: every language`);
        for (const lang of LANGS) {
            const tr = t.translations[lang];
            const where = `${t.id}/${lang}`;
            assert.ok(tr.title.trim() && tr.title.length <= 256, `${where} title`);
            assert.deepEqual(placeholders(tr.title + tr.text), placeholders(t.title + t.text), `${where} placeholders`);
            assert.deepEqual(code(tr.text), code(t.text), `${where} commands in backticks unchanged`);
            assert.equal(lines(tr.text), lines(t.text), `${where} same line breaks`);
            assert.ok(!/—/.test(tr.title + tr.text), `${where} no em dash`);
            assert.ok(emoji(tr.title + tr.text) <= emoji(t.title + t.text), `${where} no new emoji`);
            assert.ok(bangs(tr.title + tr.text) <= Math.max(bangs(t.title + t.text), t.celebrate ? 1 : 0), `${where} no extra "!"`);
            assert.notEqual(tr.text, t.text, `${where} translated`);
        }
    }
});

test('message templates: filled in the server language, English when asked or unknown', () => {
    const t = MESSAGE_TEMPLATES.find((x) => x.id === 'ticket-howto');
    assert.equal(fillTemplate(t, { server: 'S', lang: 'de' }).lang, 'de');
    assert.equal(fillTemplate(t, { server: 'S', lang: 'xx' }).lang, 'en');
    assert.equal(fillTemplate(t, { server: 'S' }).text, t.text.replaceAll('{server}', 'S'));
});
