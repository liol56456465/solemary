import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LANGUAGES, loadCatalogs, placeholdersOf, setCatalogsForTest, setContentOverrides, translator, textOf, isSafeHref,
} from '../src/services/site/i18n.js';
import { html } from '../src/services/dashboard/html.js';

const fixture = () => new Map([
    ['en', new Map([
        ['a.plain', 'Hello {name} & <you>'],
        ['a.inline', 'Use **bold**, *it*, `code` and [docs](/docs) or [ext](https://x.example/?a=1&b=2)'],
        ['a.evil', '[x](javascript:alert(1)) [y](//evil.example) <script>alert(1)</script>'],
        ['a.block', 'First line\nsecond\n\n- one\n- **two**\n\nLast {link}'],
        ['a.href', '[invite]({url})'],
        ['a.only', 'English only'],
    ])],
    ['de', new Map([['a.plain', 'Hallo {name}']])],
]);

test('plain text: params filled, fallback to English per key, unknown language → English', () => {
    setCatalogsForTest(fixture());
    try {
        assert.equal(translator('en').t('a.plain', { name: 'Ana' }), 'Hello Ana & <you>');
        assert.equal(translator('de').t('a.plain', { name: 'Ana' }), 'Hallo Ana');
        assert.equal(translator('de').t('a.only'), 'English only');
        assert.equal(translator('xx').lang, 'en');
        assert.throws(() => translator('en').t('a.missing'), /missing key/);
        assert.throws(() => translator('en').t('a.plain'), /missing param/);
    } finally { setCatalogsForTest(null); }
});

test('inline markup is safe: escaped text, allowed links only, no script', () => {
    setCatalogsForTest(fixture());
    try {
        const { ti } = translator('en');
        assert.equal(String(ti('a.inline')),
            'Use <strong>bold</strong>, <em>it</em>, <code>code</code> and <a href="/docs">docs</a> or <a href="https://x.example/?a=1&amp;b=2" rel="noopener">ext</a>');
        const evil = String(ti('a.evil'));
        assert.ok(!/<a /.test(evil), 'javascript: and // links are dropped to text');
        assert.ok(!evil.includes('<script>'), 'tags escaped');
        assert.match(evil, /&lt;script&gt;/);
        assert.equal(String(ti('a.plain', { name: html`<b>ok</b>` })), 'Hello <b>ok</b> &amp; &lt;you&gt;', 'SafeHtml params inserted as is');
        assert.equal(String(ti('a.plain', { name: '<i>x</i>' })), 'Hello &lt;i&gt;x&lt;/i&gt; &amp; &lt;you&gt;', 'plain params escaped');
        assert.equal(String(ti('a.href', { url: 'https://discord.gg/abc' })), '<a href="https://discord.gg/abc" rel="noopener">invite</a>');
        assert.equal(String(ti('a.href', { url: 'javascript:alert(1)' })), 'invite', 'unsafe param href dropped');
        assert.throws(() => ti('a.href', { url: html`<x>` }), /must be plain text/);
    } finally { setCatalogsForTest(null); }
});

test('block markup: paragraphs, <br>, lists', () => {
    setCatalogsForTest(fixture());
    try {
        assert.equal(String(translator('en').tb('a.block', { link: html`<a href="/x">x</a>` })),
            '<p>First line<br>second</p>\n<ul><li>one</li><li><strong>two</strong></li></ul>\n<p>Last <a href="/x">x</a></p>');
    } finally { setCatalogsForTest(null); }
});

test('owner overrides: own language first, then catalog, then English edit, then English', () => {
    setCatalogsForTest(fixture());
    try {
        setContentOverrides((lang, key) => (lang === 'en' && key === 'a.only' ? 'Edited' : lang === 'de' && key === 'a.only' ? 'Bearbeitet' : null));
        assert.equal(translator('de').t('a.only'), 'Bearbeitet');
        setContentOverrides((lang, key) => (lang === 'en' && key !== 'a.only' ? 'Edited {name}' : null));
        assert.equal(translator('de').t('a.plain', { name: 'A' }), 'Hallo A', 'an English edit does not replace a translation');
        assert.equal(translator('en').t('a.plain', { name: 'A' }), 'Edited A');
        setContentOverrides((lang, key) => (lang === 'en' && key === 'a.only' ? '**x**' : null));
        assert.equal(String(translator('de').ti('a.only')), '<strong>x</strong>', 'English edit used where no translation exists');
    } finally { setContentOverrides(null); setCatalogsForTest(null); }
});

test('textOf: bare test contexts get an English translator', () => {
    assert.equal(textOf({}).lang, 'en');
    const own = translator('de');
    assert.equal(textOf(own), own);
    assert.equal(textOf({ lang: 'fr' }).lang, 'fr');
});

test('isSafeHref', () => {
    for (const ok of ['/docs', '/', '#top', 'https://a.b/c', 'mailto:a@b.c']) assert.equal(isSafeHref(ok), true, ok);
    for (const bad of ['//x.y', 'http://a.b', 'javascript:x', 'data:text/html,1', ' /x', 'https://a b']) assert.equal(isSafeHref(bad), false, bad);
});

test('real catalogs: every language only has keys English has, with the same {params}', () => {
    const all = loadCatalogs();
    const en = all.get('en');
    assert.ok(en.size > 0, 'English catalog exists');
    for (const { code } of LANGUAGES) {
        if (code === 'en') continue;
        for (const [key, text] of all.get(code)) {
            assert.ok(en.has(key), `${code}: ${key} is not an English key`);
            assert.deepEqual(placeholdersOf(text), placeholdersOf(en.get(key)), `${code}: ${key} placeholders`);
        }
    }
});
