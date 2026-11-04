// Website languages: /<prefix>/ routes (language.js + site.js), links that keep the language,
// catalog links rewritten, hreflang / canonical / sitemap, the picker and its cookie, the
// "also available in" note without a redirect, English-only legal pages, and dates / numbers per language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSite, sitemapXml, leaderboardPage, SITEMAP_PATHS } from '../src/services/site/site.js';
import {
    LANGUAGES, formatDateIn, formatNumberIn, isPagePath, localizePath, setContentOverrides, translateInline, translator,
} from '../src/services/site/i18n.js';
import { LANG_COOKIE, acceptLanguage, cookieLanguage, pickerHref, requestLanguage, suggestedLanguage } from '../src/services/site/language.js';
import { rulesPage } from '../src/services/site/pages/rules.js';
import { changelogPage } from '../src/services/site/pages/changelog.js';

const ORIGIN = 'https://mewvo.example';

async function serve({ env = {} } = {}) {
    const app = express();
    // A stand-in for the dashboard, registered before the site as in app.js.
    app.get('/dashboard', (req, res) => res.status(200).send('dashboard'));
    app.use(createSite({
        client: { commands: null }, env: { CLIENT_ID: '123456789012345678', ...env }, dashboardEnabled: true, supportInvite: () => null,
        leaderboard: async () => ({ enabled: true, rows: Array.from({ length: 51 }, (_, i) => ({ rank: i + 1, name: `U${i}`, level: 3, totalXp: 12345 })) }),
        status: () => ({ state: 'online', uptimeMs: 60_000 }), rules: async () => ({ rules: [], updatedAt: null }), cat: async () => null,
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, headers = {}) => {
        const res = await fetch(base + path, { redirect: 'manual', headers });
        return { status: res.status, headers: res.headers, cookies: res.headers.getSetCookie(), body: await res.text() };
    };
    return { get, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

test('routes: /de/… and /pt-br/… serve the page in that language; /en/… 301s; unknown prefixes and non-pages 404', async () => {
    const site = await serve();
    try {
        const de = await site.get('/de/features');
        assert.equal(de.status, 200);
        assert.match(de.body, /<html lang="de">/);
        assert.match((await site.get('/pt-br/pricing')).body, /<html lang="pt-BR">/);
        for (const home of ['/ru/', '/ru']) {
            const ru = await site.get(home);
            assert.equal(ru.status, 200, home);
            assert.match(ru.body, /<html lang="ru">/);
        }
        assert.equal((await site.get('/de/docs/appeals')).status, 200);
        assert.equal((await site.get('/de/docs/nope')).status, 404);
        const en = await site.get('/en/features?x=1');
        assert.equal(en.status, 301);
        assert.equal(en.headers.get('location'), '/features?x=1');
        assert.equal((await site.get('/en/')).headers.get('location'), '/');
        assert.equal((await site.get('/en//evil.example')).status, 404, 'never a redirect to another host');
        assert.equal((await site.get('/xx/features')).status, 404);
        const dash = await site.get('/de/dashboard');
        assert.equal(dash.status, 404, '/de/dashboard is not the dashboard');
        assert.match(dash.body, /<html lang="de">/, 'the 404 page in German');
        assert.equal((await site.get('/dashboard')).body, 'dashboard');
        for (const path of ['/de/img/logo.png', '/de/site.css', '/de/robots.txt', '/de/favicon.png']) {
            assert.equal((await site.get(path)).status, 404, path);
        }
        assert.match((await site.get('/features')).body, /<html lang="en">/);
    } finally {
        await site.close();
    }
});

test('links keep the language: shell, pages and the leaderboard pager; /dashboard, /me, /img and invites never get a prefix', async () => {
    const site = await serve();
    try {
        const page = (await site.get('/de/features')).body;
        for (const href of ['/de/', '/de/pricing', '/de/docs', '/de/faq', '/de/privacy', '/de/changelog']) assert.ok(page.includes(`href="${href}"`), href);
        assert.ok(page.includes('href="/dashboard"'));
        assert.ok(!/href="\/de\/(dashboard|me|img)/.test(page));
        const board = (await site.get('/de/leaderboard')).body;
        assert.ok(board.includes('href="/de/leaderboard?page=2"'));
        const english = (await site.get('/features')).body;
        assert.ok(english.includes('href="/pricing"') && !english.includes('href="/de/pricing"'));
    } finally {
        await site.close();
    }
    assert.equal(localizePath('de', '/features#f-automod'), '/de/features#f-automod');
    assert.equal(localizePath('pt-BR', '/'), '/pt-br/');
    assert.equal(localizePath('de', '/me/billing'), '/me/billing');
    assert.equal(localizePath('de', '//evil.example/features'), '//evil.example/features');
    assert.equal(localizePath('de', 'https://discord.gg/x'), 'https://discord.gg/x');
    assert.equal(localizePath('en', '/features'), '/features');
    assert.ok(isPagePath('/docs/getting-started') && !isPagePath('/docs/<x>') && !isPagePath('/dashboard'));
});

test('catalog links ([text](/path)) are rewritten through the translator; external and non-page links are not', () => {
    const { ti } = translator('de');
    const html = String(ti('home.what.text'));
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of links.filter((h) => h.startsWith('/'))) {
        assert.ok(!isPagePath(href.split(/[?#]/)[0]) || href.startsWith('/de/'), href);
    }
    // Directly: a site path gets the prefix, the same text in English stays as it was.
    setContentOverrides((lang, key) => (key === 'shell.footer.tagline' ? 'See [the FAQ](/faq), [the panel](/dashboard) and [Discord](https://discord.com).' : null));
    try {
        assert.equal(String(translator('de').ti('shell.footer.tagline')), 'See <a href="/de/faq">the FAQ</a>, <a href="/dashboard">the panel</a> and <a href="https://discord.com" rel="noopener">Discord</a>.');
        assert.equal(String(translator('en').ti('shell.footer.tagline')), 'See <a href="/faq">the FAQ</a>, <a href="/dashboard">the panel</a> and <a href="https://discord.com" rel="noopener">Discord</a>.');
        assert.equal(String(translateInline('de', 'shell.footer.tagline')), 'See <a href="/faq">the FAQ</a>, <a href="/dashboard">the panel</a> and <a href="https://discord.com" rel="noopener">Discord</a>.', 'no hook: unchanged');
        assert.ok(String(translator('de').tb('shell.footer.tagline')).includes('href="/de/faq"'));
    } finally {
        setContentOverrides(null);
    }
});

test('SEO: hreflang for every language + x-default, canonical per language, legal pages English only, sitemap in every language', async () => {
    const site = await serve({ env: { PUBLIC_SITE_ENABLED: 'true', PUBLIC_URL: ORIGIN } });
    try {
        const de = (await site.get('/de/features')).body;
        assert.ok(de.includes(`<link rel="canonical" href="${ORIGIN}/de/features">`));
        for (const l of LANGUAGES) {
            assert.ok(de.includes(`<link rel="alternate" hreflang="${l.code}" href="${ORIGIN}${l.prefix ? `/${l.prefix}` : ''}/features">`), l.code);
        }
        assert.ok(de.includes(`hreflang="pt-BR" href="${ORIGIN}/pt-br/features"`));
        assert.ok(de.includes(`<link rel="alternate" hreflang="x-default" href="${ORIGIN}/features">`));
        assert.ok((await site.get('/features')).body.includes(`<link rel="canonical" href="${ORIGIN}/features">`));
        assert.ok((await site.get('/ru/')).body.includes(`<link rel="canonical" href="${ORIGIN}/ru/">`));
        const legal = (await site.get('/de/privacy')).body;
        assert.ok(legal.includes(`<link rel="canonical" href="${ORIGIN}/privacy">`), 'legal canonical stays English');
        assert.ok(!legal.includes('rel="alternate"'), 'no alternates for English-only pages');
        const map = (await site.get('/sitemap.xml')).body;
        assert.ok(map.includes(`<loc>${ORIGIN}/de/features</loc>`) && map.includes(`<loc>${ORIGIN}/pt-br/docs/appeals</loc>`) && map.includes(`<loc>${ORIGIN}/ru/</loc>`));
        assert.ok(map.includes(`<loc>${ORIGIN}/privacy</loc>`) && !map.includes('/de/privacy') && !map.includes('/fr/withdrawal'));
    } finally {
        await site.close();
    }
    const urls = sitemapXml(ORIGIN).match(/<loc>/g).length;
    const legal = 5;
    assert.equal(urls, SITEMAP_PATHS.length + (LANGUAGES.length - 1) * (SITEMAP_PATHS.length - legal));
});

test('picker: links to the same page in each language (current one marked); ?setlang=1 sets the cookie and 302s to the same page', async () => {
    const site = await serve();
    try {
        const page = (await site.get('/de/leaderboard?page=2')).body;
        assert.ok(page.includes('<details class="lang-menu">') && page.includes('<nav class="footer-langs" aria-label="Language">'));
        assert.ok(page.includes('href="/fr/leaderboard?page=2&amp;setlang=1" hreflang="fr" lang="fr">Français</a>'));
        assert.ok(page.includes('href="/leaderboard?page=2&amp;setlang=1" hreflang="en" lang="en">English</a>'));
        assert.ok(page.includes('href="/de/leaderboard?page=2&amp;setlang=1" hreflang="de" lang="de" aria-current="true">Deutsch</a>'));
        const set = await site.get('/de/leaderboard?page=2&setlang=1');
        assert.equal(set.status, 302);
        assert.equal(set.headers.get('location'), '/de/leaderboard?page=2');
        assert.equal(set.cookies.length, 1);
        assert.match(set.cookies[0], /^mewvo_lang=de; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax$/);
        const en = await site.get('/features?setlang=1');
        assert.equal(en.headers.get('location'), '/features');
        assert.match(en.cookies[0], /^mewvo_lang=en;/);
        // Not a page: no cookie, no redirect.
        assert.equal((await site.get('/de/dashboard?setlang=1')).status, 404);
        assert.equal((await site.get('/de/features?setlang=1&next=https://evil.example')).headers.get('location'), '/de/features?next=https%3A%2F%2Fevil.example', 'the target is the same path; other params stay a query');
    } finally {
        await site.close();
    }
    assert.equal(pickerHref('pt-BR', '/docs'), '/pt-br/docs?setlang=1');
    assert.equal(pickerHref('de', '/dashboard'), '/de/?setlang=1');
});

test('first visit: Accept-Language or the cookie only shows a note in that language, never a redirect', async () => {
    const site = await serve();
    setContentOverrides((lang, key) => (lang === 'de' && key === 'shell.suggestLanguage' ? 'Mewvo gibt es auch auf {language}.' : null));
    try {
        const first = await site.get('/features', { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' });
        assert.equal(first.status, 200, 'no redirect');
        assert.equal(first.headers.get('vary'), 'Accept-Language, Cookie');
        assert.ok(first.body.includes('<a href="/de/features?setlang=1" hreflang="de" lang="de">Mewvo gibt es auch auf Deutsch.</a>'));
        assert.ok(first.body.includes('<a class="lang-suggest-dismiss" href="/features?setlang=1">Stay in English</a>'));
        assert.match(first.body, /<html lang="en">/);
        const fallback = await site.get('/', { 'accept-language': 'fr' });
        assert.ok(fallback.body.includes('lang="en">Mewvo is also available in Français.</a>'), 'untranslated: the English text, tagged en');
        assert.ok(!(await site.get('/features', { 'accept-language': 'en-US,en' })).body.includes('lang-suggest'));
        assert.ok(!(await site.get('/features')).body.includes('lang-suggest'));
        assert.ok(!(await site.get('/features', { cookie: `${LANG_COOKIE}=en`, 'accept-language': 'de' })).body.includes('lang-suggest'), 'chose English: nothing offered');
        const cookie = await site.get('/pricing', { cookie: `${LANG_COOKIE}=pl` });
        assert.equal(cookie.status, 200);
        assert.ok(cookie.body.includes('href="/pl/pricing?setlang=1" hreflang="pl"'));
        assert.ok(!(await site.get('/de/features', { 'accept-language': 'fr' })).body.includes('lang-suggest'), 'prefixed pages: no note');
        const evil = await site.get('/features', { 'accept-language': '"><script>alert(1)</script>', cookie: `${LANG_COOKIE}="><b>` });
        assert.ok(!evil.body.includes('<script') && !evil.body.includes('lang-suggest'));
    } finally {
        setContentOverrides(null);
        await site.close();
    }
    assert.equal(acceptLanguage('pt-PT,pt;q=0.9'), 'pt-BR');
    assert.equal(acceptLanguage('pt-br'), 'pt-BR');
    assert.equal(acceptLanguage('xx, de;q=0.1, it;q=0.5'), 'it');
    assert.equal(acceptLanguage('de;q=0, *'), null);
    assert.equal(acceptLanguage(''), null);
    assert.equal(cookieLanguage('mewvo_lang=xx'), null);
    assert.equal(cookieLanguage('mewvo_lang=pt-BR'), 'pt-BR');
    assert.equal(requestLanguage({ headers: { cookie: 'mewvo_lang=it', 'accept-language': 'de' } }), 'it');
    assert.equal(requestLanguage({ headers: { 'accept-language': 'es-MX' } }), 'es');
    assert.equal(requestLanguage({ headers: {} }), 'en');
    assert.equal(suggestedLanguage({ headers: { cookie: 'mewvo_lang=en', 'accept-language': 'de' } }), null);
});

test('legal pages under a prefix: the English page with a note in the visitor\'s language', async () => {
    const site = await serve();
    setContentOverrides((lang, key) => (lang === 'de' && key === 'shell.legalEnglishOnly' ? 'Diese Seite gibt es nur auf Englisch.' : null));
    try {
        for (const path of ['/de/privacy', '/de/terms', '/de/legal', '/de/contact', '/de/withdrawal']) {
            const res = await site.get(path);
            assert.equal(res.status, 200, path);
            assert.match(res.body, /<html lang="en">/, path);
            assert.ok(res.body.includes('<p class="notice lang-note" lang="de">Diese Seite gibt es nur auf Englisch.</p>'), path);
            assert.ok(res.body.includes('href="/de/features"'), `${path}: the shell keeps the language`);
        }
        assert.ok((await site.get('/de/privacy')).body.includes('<h1>Privacy Policy</h1>'));
        assert.ok(!(await site.get('/privacy')).body.includes('lang-note'));
        assert.ok((await site.get('/privacy')).body.includes('<code>mewvo_lang</code>'), 'the cookie is in the cookie table');
    } finally {
        setContentOverrides(null);
        await site.close();
    }
});

test('dates and numbers: English exactly as before (en-GB dates, en-US numbers); other languages localized', () => {
    const day = new Date(Date.UTC(2026, 10, 1));
    assert.equal(formatDateIn('en', day), '1 November 2026');
    assert.equal(formatDateIn('de', day), '1. November 2026');
    assert.equal(formatDateIn('en', day, { month: 'long', year: 'numeric', timeZone: 'UTC' }), 'November 2026');
    assert.equal(formatDateIn('en', null), '');
    assert.equal(formatNumberIn('en', 1234567), '1,234,567');
    assert.equal(formatNumberIn('de', 1234567), '1.234.567');
    const rows = [{ rank: 1, name: 'A', level: 2, totalXp: 123456 }];
    assert.ok(leaderboardPage({}, { page: 1, board: { enabled: true, rows } }).includes('<td class="num">123,456</td>'));
    assert.ok(leaderboardPage(translator('de'), { page: 1, board: { enabled: true, rows } }).includes('<td class="num">123.456</td>'));
    const rules = { rules: [{ number: 1, title: 'Be kind', text: '' }], updatedAt: day };
    assert.ok(rulesPage({}, rules).includes('<time datetime="2026-11-01">1 November 2026</time>'));
    assert.ok(rulesPage(translator('de'), rules).includes('<time datetime="2026-11-01">1. November 2026</time>'));
    assert.ok(changelogPage(translator('fr'), [{ date: '2026-11-01', items: [] }]).includes('1 novembre 2026'));
});
