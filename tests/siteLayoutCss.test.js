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

test('phone menu (☰): hidden on wide screens; on phones the bar is one sticky row and the page links, picker move into it', () => {
    assert.ok(CSS.includes('.nav-menu { display: none; }'), 'no ☰ above 760px');
    const at = CSS.indexOf('/* ── Phone menu (2026-11-13)');
    assert.ok(at > -1);
    const phone = CSS.slice(at);
    assert.match(phone, /@media \(max-width: 760px\) \{\n {4}\.topbar \{ position: sticky; \}/);
    assert.ok(phone.includes('.topbar .topnav, .topbar-actions .lang-menu { display: none; }'));
    assert.ok(phone.includes('.nav-menu { display: block; }'));
    assert.match(phone, /@media \(max-width: 760px\) and \(max-height: 500px\) \{\n {4}\.topbar \{ position: relative; \}/, 'sideways phones: the bar scrolls away');
    assert.match(rule('.nav-toggle'), /width: 44px; height: 44px;/);
    assert.match(rule('.nav-pop'), /max-height: calc\(100dvh - 56px\); overflow-y: auto;/);
    assert.match(rule('.nav-pop-links a'), /min-height: 48px/);
    assert.match(rule('.nav-pop-langs a'), /min-height: 44px/);
    // The ☰ rules come after the older phone rules (two rows, static bar) so they win.
    assert.ok(at > CSS.indexOf('/* Very narrow phones (320px)'));
});

const menuOf = (markup) => {
    const at = markup.indexOf('<details class="nav-menu">');
    assert.ok(at > -1, 'phone menu present');
    return markup.slice(at, markup.indexOf('</details>', at));
};

test('phone menu markup: labelled toggle, page links, languages; only what the bar hides on phones', () => {
    // Public, logged out, with member accounts: the bar keeps Add to Discord; Log in, Sign up and Dashboard are in ☰.
    const out = menuOf(page('de', { memberPortal: true, accounts: true }));
    assert.match(out, /<summary class="nav-toggle"><span class="nav-toggle-bars" aria-hidden="true"><\/span><span class="visually-hidden">Menü<\/span><\/summary>/);
    assert.match(out, /<nav class="nav-pop" aria-label="Menü">/);
    assert.match(out, /<div class="nav-pop-account"><a class="button button-quiet" href="\/me">[^<]+<\/a><a class="button" href="\/me\/signup">/);
    assert.ok(out.includes('href="/dashboard"'));
    assert.ok(!out.includes('data-add-bot'), 'Add to Discord stays in the bar');
    for (const p of ['/de/features', '/de/pricing', '/de/docs', '/de/commands', '/de/leaderboard', '/me']) assert.ok(out.includes(`href="${p}"`), p);
    assert.match(out, /<a href="\/\?setlang=de" hreflang="de" lang="de" aria-current="true">Deutsch<\/a>/);
    for (const { code } of LANGUAGES) assert.ok(out.includes(`hreflang="${code}"`), code);
    // Logged in: the account chip stays in the bar, so Add to Discord moves into ☰ and there is no Log in.
    const inside = menuOf(page('en', { memberPortal: true, accounts: true, viewer: { name: 'Ana', csrf: 'x' } }));
    assert.ok(inside.includes('data-add-bot'));
    assert.ok(!inside.includes('nav-pop-account'));
    // Not public, no member portal: the dashboard stays in the bar, not repeated in ☰.
    const plain = menuOf(page('en', { publicSite: false }));
    assert.ok(!plain.includes('/dashboard'));
    assert.ok(plain.includes('href="/features"'));
    // The current page is marked in ☰ too.
    const ctx = { ...translator('en', { href: (p) => p }), languageLink: (c) => `/?setlang=${c}` };
    assert.match(menuOf(layout(ctx, { title: 'T', active: 'pricing', body: '' })), /<a href="\/pricing" aria-current="page">/);
    // Every language has its own label.
    for (const { code } of LANGUAGES) assert.doesNotMatch(menuOf(page(code)), /shell\.header\.menu/, code);
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
    for (const sel of ['.topnav a, .topbar-actions .button, .lang-chip, .account-chip', '.lang-pop a, .account-pop a, .account-pop button', '.footer-links a', '.footer-langs a', '.jump a', '.cmd-who a', '.index a']) {
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
