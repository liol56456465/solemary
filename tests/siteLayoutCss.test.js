// Website layout in every language: guards the CSS rules and top-bar markup that keep long
// translated labels inside their boxes. The full check runs in a browser
// (node scripts/site-layout-check.js: every page × 8 languages × 360–1280px); this only makes
// sure the key rules are not dropped by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layout } from '../src/services/site/shell.js';
import { translator, localizePath, LANGUAGES } from '../src/services/site/i18n.js';

const CSS = readFileSync(new URL('../src/services/site/static/site.css', import.meta.url), 'utf8');
const rule = (selector) => {
    const at = CSS.indexOf(`${selector} {`);
    assert.ok(at > -1, `rule ${selector}`);
    return CSS.slice(at, CSS.indexOf('}', at));
};

test('buttons wrap long labels (centred, sensible line height); top-bar buttons stay on one line', () => {
    const button = rule('.button');
    assert.ok(!/white-space:\s*nowrap/.test(button), '.button must not force one line');
    assert.match(button, /text-align:\s*center/);
    assert.match(button, /line-height:\s*1\.25/);
    assert.match(CSS, /\.topbar-actions \.button, \.lang-chip, \.account-chip \{ white-space: nowrap; \}/);
});

test('long words: hyphenation in translated pages, overflow-wrap where boxes are narrow, min-width 0 on form boxes', () => {
    assert.match(CSS, /html:not\(\[lang="en"\]\) :is\([^)]*h1[^)]*\) \{ hyphens: auto;/);
    assert.match(CSS, /\.footer-links a, \.tag,[^{]*\{ overflow-wrap: anywhere; \}/);
    assert.match(CSS, /\.consent, \.form-stack, \.form-field \{ min-width: 0; \}/);
    assert.match(rule('.table-wrap'), /overflow-x:\s*auto/, 'tables scroll inside their box');
});

test('top bar: stack classes, phone rules (one kept button, short labels, short picker code)', () => {
    for (const cls of ['.topbar-stack-all .topnav', '.topbar-stack-1180 .topnav', '.topbar-stack-1000 .topnav']) assert.ok(CSS.includes(`${cls} {`), cls);
    assert.match(CSS, /\.topbar-actions \.topbar-more \{ display: none; \}/);
    assert.match(CSS, /\.topbar-actions \.label-short \{ display: inline; \}/);
    assert.match(CSS, /\.lang-chip-short \{ display: inline;/);
});

function page(lang, extra = {}) {
    const ctx = {
        publicSite: true, installUrl: 'https://discord.com/oauth2/authorize?client_id=1', dashboardEnabled: true,
        ...translator(lang, { href: (p) => localizePath(lang, p) }), urlLang: lang, languageLink: (code) => `/?setlang=${code}`, ...extra,
    };
    return layout(ctx, { title: 'T', body: '' });
}

test('top bar markup: picker short code with the full name kept, short labels aria-hidden, a stack class in every language', () => {
    const de = page('de');
    assert.match(de, /<span class="lang-chip-full" lang="de">Deutsch<\/span><span class="lang-chip-short" aria-hidden="true">DE<\/span>/);
    assert.match(de, /data-add-bot><span class="label-long">Zu Discord hinzufügen<\/span><span class="label-short" aria-hidden="true">Hinzufügen<\/span><\/a>/);
    for (const { code } of LANGUAGES) assert.match(page(code), /<header class="topbar topbar-stack-(1000|1180|all)">/, code);
    // Many buttons: the menu always gets its own row; next to the member buttons the dashboard is wide-screen only.
    const member = page('ru', { memberPortal: true, accounts: true });
    assert.match(member, /topbar-stack-all/);
    assert.match(member, /class="button button-quiet topbar-wide" href="\/dashboard"/);
    // English, not public: one row above 1000px, labels unchanged.
    const en = page('en', { publicSite: false });
    assert.match(en, /topbar-stack-1000/);
    assert.ok(en.includes('<a class="button" href="/dashboard">Dashboard</a>'));
});

// Phones (2026-11-07): the browser check (scripts/site-layout-check.js, touch emulation) measures tap
// targets, field text and fixed bars; these guard the rules that make it pass.
const block = (media) => {
    const at = CSS.indexOf(`@media ${media} {`);
    assert.ok(at > -1, `@media ${media}`);
    return CSS.slice(at, CSS.indexOf('\n}', at));
};

test('phones: form fields at 16px (iOS zoom), 44px tap targets, no sticky bar on short screens', () => {
    const fields = '.form-field input, .redeem-row input, .gift-fields input, .gift-fields textarea, .withdraw-name { font-size: 16px; }';
    assert.ok(CSS.includes(fields), 'fields at 16px');
    assert.ok(CSS.indexOf(fields) > CSS.indexOf('.form-field input { width: 100%'), 'the 16px rule comes after the base field rules');
    const touch = block('(max-width: 760px), (pointer: coarse)');
    for (const sel of ['.topnav a, .topbar-actions .button, .lang-chip, .account-chip', '.lang-pop a, .account-pop a, .account-pop button', '.footer-links a', '.footer-langs a', '.jump a', '.index a']) {
        const at = touch.indexOf(`${sel} {`);
        assert.ok(at > -1, sel);
        assert.match(touch.slice(at, touch.indexOf('}', at)), /min-height: 44px/, sel);
    }
    assert.match(block('(max-height: 500px)'), /\.topbar \{ position: static; \}/);
    assert.match(block('(max-width: 374px)'), /\.account-chip \.account-name \{ position: absolute;/);
    assert.ok(CSS.includes('body { min-height: 100dvh; }'));
});

test('phones: the viewport tag lets people zoom; checkout and withdrawal fields have the right hints', () => {
    const de = page('de');
    assert.ok(de.includes('<meta name="viewport" content="width=device-width,initial-scale=1">'));
    assert.doesNotMatch(de, /user-scalable|maximum-scale/);
    const billing = readFileSync(new URL('../src/services/site/billing.js', import.meta.url), 'utf8');
    assert.match(billing, /<input class="withdraw-name" id="w-name" name="name" required [^>]*autocomplete="name"/);
    assert.match(billing, /id="gift-to" name="gift_to" [^>]*autocapitalize="none" spellcheck="false"/);
});
