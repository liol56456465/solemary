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
import { enforcementConfig } from '../src/config/enforcement.js';

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
        assert.ok(page.includes('<details class="lang-menu">') && page.includes('<nav class="footer-langs" aria-label="Sprache">'), 'picker label in the page language');
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
        assert.ok(fallback.body.includes('lang="fr">Mewvo est aussi disponible en Français.</a>'), 'the offer is written in the offered language');
        assert.ok(!(await site.get('/features', { 'accept-language': 'en-US,en' })).body.includes('lang-suggest'));
        assert.ok(!(await site.get('/features')).body.includes('lang-suggest'));
        assert.ok(!(await site.get('/features', { cookie: `${LANG_COOKIE}=en`, 'accept-language': 'de' })).body.includes('lang-suggest'), 'chose English: nothing offered');
        const cookie = await site.get('/pricing', { cookie: `${LANG_COOKIE}=pl` });
        assert.equal(cookie.status, 200);
        assert.ok(cookie.body.includes('href="/pl/pricing?setlang=1" hreflang="pl"'));
        assert.ok(!(await site.get('/de/features', { 'accept-language': 'fr' })).body.includes('lang-suggest'), 'prefixed pages: no note');
        const evil = await site.get('/features', { 'accept-language': '"><script>alert(1)</script>', cookie: `${LANG_COOKIE}="><b>` });
        assert.ok(!evil.body.includes('<script>') && !evil.body.includes('lang-suggest'));
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

// ── The last English fragments: bonus, days, the cat, errors, transparency words, plurals ──

const accountPages = await import('../src/services/site/accountPages.js');
const { PRO_BONUS_LABEL, AccountError, validateUsername, validatePassword, checkAge } = await import('../src/services/accounts/accountCore.js');
const billingSite = await import('../src/services/site/billing.js');
const premium = await import('../src/services/billing/premiumService.js');
const { catCard } = await import('../src/services/site/site.js');
const { CAT_STAGES, moodSentence, stageProgress } = await import('../src/services/community/catModel.js');
const { trustPage, ladderSentence } = await import('../src/services/site/pages/trust.js');
const { maskedText, medianWords } = await import('../src/services/site/pages/transparency.js');
const transparency = await import('../src/services/enforcement/transparencyService.js');
const portal = await import('../src/services/site/memberPortal.js');
const { caseStatusLabel } = await import('../src/services/enforcement/caseService.js');
const { nextWarningText } = await import('../src/services/enforcement/standingService.js');
const { planCard } = await import('../src/services/site/pages/pricing.js');
const { PLANS } = await import('../src/config/site/plans.js');
const { homePage } = await import('../src/services/site/pages/home.js');
const { featuresPage } = await import('../src/services/site/pages/features.js');
const { hasKey } = await import('../src/services/site/i18n.js');

const en = translator('en');
const de = translator('de');
const ru = translator('ru');
const DAY_MS = 86_400_000;

test('the early-account bonus length is a plural key: "6 months" in English, translated elsewhere', () => {
    assert.equal(accountPages.bonusLength(en), PRO_BONUS_LABEL);
    assert.equal(accountPages.bonusLength(de), '6 Monate');
    assert.equal(accountPages.bonusLength(ru), '6 месяцев');
    const page = (text) => String(accountPages.linkDiscordPage(text, { session: { csrf: 'c' }, account: { username: 'ana' } }));
    assert.match(page(en), /get Mewvo Pro for 6 months\./);
    assert.match(page(de), /bekommen Mewvo Pro für 6 Monate\./);
    assert.match(page(ru), /получают Mewvo Pro на 6 месяцев\./);
    assert.equal(accountPages.bonusStatusText({ link_number: 300 }, ru), 'Привязка №300: без бонуса Pro (его получили первые 100 привязок).');
    assert.equal(accountPages.bonusStatusText({ link_number: 300 }, en), 'Link #300: no Pro bonus (it went to the first 100 links).');
});

test('days left: one plural key (account.plan.daysLeft) with each language\'s forms', () => {
    const now = Date.UTC(2026, 10, 1);
    const left = (text, days) => accountPages.daysLeftText(now + (days + 0.5) * DAY_MS, now, text);
    assert.deepEqual([1, 3].map((d) => left(en, d)), ['1 day left', '3 days left']);
    assert.deepEqual([1, 3].map((d) => left(de, d)), ['Noch 1 Tag', 'Noch 3 Tage']);
    assert.deepEqual([1, 3, 5, 21].map((d) => left(ru, d)), ['Остался 1 день', 'Осталось 3 дня', 'Осталось 5 дней', 'Остался 21 день']);
    assert.equal(hasKey('en', 'account.plan.dayLeft'), false, 'the old pair is gone');
});

test('billing.common.days is gone: day counts use the plural billing.common.day', () => {
    assert.equal(hasKey('en', 'billing.common.days'), false);
    assert.equal(en.tp('billing.common.day', 30), '30 days');
    assert.equal(ru.tp('billing.common.day', 30), '30 дней');
    const keys = String(billingSite.billingPage(ru, { session: { username: 'a', csrf: 'c' }, account: { subscription: null, orders: [], gifts: [{ code: 'MEWVO-A', plan_id: 'pro', duration_days: 31, created_at: new Date(), expires_at: null }] } }));
    assert.match(keys, /<td>31 день<\/td>/);
});

test('the server cat on the website: stage, mood and sentence in the page\'s language; English unchanged', () => {
    const cat = (i, mood) => ({ name: 'Mochi', stage: CAT_STAGES[i], mood, sentence: moodSentence('Mochi', mood), total: CAT_STAGES[i].min, progress: stageProgress(CAT_STAGES[i].min, i), image: 'x.png' });
    const card = (text, c) => String(catCard(c, text));
    assert.match(card(en, cat(1, 'happy')), /alt="Mochi, a young cat, looking happy"/);
    assert.match(card(en, cat(1, 'happy')), /<p>Young cat\. Mochi is happy: the server was busier this week\.<\/p>/);
    assert.match(card(de, cat(1, 'happy')), /alt="Mochi \(junge Katze\) wirkt glücklich"/);
    assert.match(card(de, cat(1, 'happy')), /<p>Junge Katze\. Mochi ist glücklich: /);
    assert.match(card(de, cat(1, 'happy')), /Noch 13\.000 bis Katze\./);
    assert.match(card(ru, cat(0, 'sleepy')), /alt="Mochi, котёнок, выглядит сонным"/);
    assert.match(card(ru, cat(0, 'scared')), /<p>Котёнок\. Mochi напуган: /);
    // An unknown mood or stage (no key) keeps the English words; the bot's own sentence stays English.
    assert.match(card(de, { ...cat(1, 'happy'), mood: 'grumpy', sentence: 'Mochi is grumpy.' }), /Mochi is grumpy\./);
    assert.equal(moodSentence('Mochi', 'proud'), 'Mochi is proud: it grew a stage today.');
    const trust = String(trustPage(ru, TRUST_CARD, { cat: cat(2, 'proud') }));
    assert.match(trust, /alt="Mochi, кот сервера \(кот\), выглядит гордым"/);
    assert.match(trust, /<span>Кот<\/span>/);
});

test('premium period labels on pages come from billing.period.*', () => {
    const page = String(billingSite.checkoutPage(de, { session: { username: 'a', csrf: 'c' }, choice: { planId: 'pro', period: 'yearly', kind: 'personal' } }));
    assert.match(page, />Jährlich</);
    assert.match(page, />Monatlich</);
    assert.doesNotMatch(page, />Yearly<|>Monthly</);
});

test('account errors on website forms: stable codes, English text unchanged, translated by code', () => {
    const results = [validateUsername('a'), validateUsername('a b'), validateUsername('___'), validateUsername('admin'), validatePassword('short'),
        validatePassword('x'.repeat(201)), checkAge(''), checkAge('2020-02-31'), checkAge('2020-01-01', new Date('2026-11-01'))];
    for (const r of results) {
        assert.equal(r.ok, false);
        assert.match(r.code, /^[a-zA-Z]+$/);
        assert.equal(accountPages.accountErrorText(r, en), r.error, r.code);
        assert.notEqual(accountPages.accountErrorText(r, de), r.error, `${r.code} is translated`);
    }
    assert.equal(accountPages.accountErrorText(validatePassword('short'), de), 'Das Passwort muss mindestens 10 Zeichen lang sein.');
    assert.equal(accountPages.accountErrorText(checkAge('2020-01-01', new Date('2026-11-01')), ru), 'Чтобы создать аккаунт, вам должно быть не меньше 14 лет.');
    const taken = new AccountError('That username is already taken. Choose another one.', 409, 'username_taken');
    assert.equal(accountPages.accountErrorText(taken, en), taken.userMessage);
    assert.equal(accountPages.accountErrorText(taken, de), 'Dieser Benutzername ist schon vergeben. Wähle einen anderen.');
    assert.equal(accountPages.accountErrorText(new AccountError('Odd.', 400, 'nothing_known'), de), 'Odd.', 'unknown code → English text');
});

test('PremiumError on checkout pages: English text unchanged, translated by code', () => {
    const caught = (fn) => { try { fn(); } catch (error) { return error; } throw new Error('no error'); };
    const errors = [
        caught(() => premium.quote({ planId: 'none', period: 'monthly', kind: 'personal' })),
        caught(() => premium.quote({ planId: 'pro', period: 'weekly', kind: 'personal' })),
        caught(() => premium.quote({ planId: 'pro', period: 'monthly', kind: 'x' })),
        caught(() => premium.conversion({ plan_id: 'max', expires_at: new Date(Date.now() + DAY_MS) }, 'pro')),
        caught(() => premium.giftDetails({ to: 'x'.repeat(500) })),
        caught(() => premium.giftDetails({ message: 'x'.repeat(5000) })),
        caught(() => premium.checkoutConsent({}, 'personal')),
        caught(() => premium.checkoutConsent({ consent_terms: 'yes' }, 'gift')),
        caught(() => premium.applyTime(null, 'pro', 0)),
        caught(() => premium.withdrawalQuote({ period: 'weekly' })),
    ];
    for (const error of errors) {
        assert.ok(error instanceof premium.PremiumError);
        assert.match(error.code, /^[a-zA-Z]+$/);
        assert.equal(billingSite.premiumErrorText(error, en), error.userMessage, error.code);
        assert.notEqual(billingSite.premiumErrorText(error, de), error.userMessage, `${error.code} is translated`);
    }
    assert.equal(billingSite.premiumErrorText(errors[0], de), 'Wähle einen bezahlten Plan (Normal, Pro oder Max).');
    assert.equal(billingSite.premiumErrorText(errors[7], ru),
        'Отметьте флажки, чтобы подтвердить: вы хотите получить ключ сейчас, вам 18 лет или больше или у вас есть разрешение. Ничего не заказано.');
    const ended = new premium.PremiumError('The 14-day withdrawal period for this order ended on 2026-11-01.', 409, 'withdrawalEnded', { count: 14, date: '2026-11-01' });
    assert.equal(billingSite.premiumErrorText(ended, en), ended.userMessage);
    assert.equal(billingSite.premiumErrorText(ended, ru), 'Срок отказа от этого заказа (14 дней) истёк 2026-11-01.');
    assert.equal(billingSite.premiumErrorText(new premium.PremiumError('Owner only.'), de), 'Owner only.', 'no code → English text');
    const blocked = billingSite.checkoutEffect({ plan_id: 'max', expires_at: new Date(Date.now() + DAY_MS) }, { planId: 'pro' }, Date.now(), de);
    assert.equal(blocked.kind, 'blocked');
    assert.match(blocked.text, /^Du hast schon Max bis /);
});

test('My record: case status and the next warning in the page\'s language; English as caseStatusLabel / nextWarningText', () => {
    const rows = [
        { status: 'revoked', revoke_reason: 'Appeal accepted' }, { status: 'revoked', revoke_reason: 'Automod decision' }, { status: 'revoked' },
        { status: 'appeal_pending' }, { status: 'active', expires_at: new Date(Date.now() - 1000) }, { status: 'expired' },
    ].map((r, i) => ({ case_code: `c${i}`, type: 'ban', created_at: new Date(), reason: 'r', ...r }));
    const view = (text, ladder = { level: 0, warns_since_level: 0 }) => portal.buildRecordView({ standing: { ladder, warns: [] }, cases: rows, appeals: [], text, config: enforcementConfig });
    assert.deepEqual(view(en).cases.map((c) => c.status), rows.map((r) => caseStatusLabel(r)));
    assert.deepEqual(view(ru).cases.map((c) => c.status), ['снято по апелляции', 'отменено модератором', 'снято досрочно', 'апелляция на рассмотрении', 'истекло', 'истекло']);
    assert.equal(portal.buildRecordView({ standing: { warns: [] }, cases: [rows[0]], appeals: [{ case_code: 'c0', status: 'denied', type: 'ban', created_at: new Date() }], text: de, config: enforcementConfig }).cases[0].status, 'per Einspruch aufgehoben');
    for (const ladder of [{ level: 0, warns_since_level: 0 }, { level: 0, warns_since_level: 1 }, { level: 0, warns_since_level: 2 }, { level: 1, warns_since_level: 0 }, { level: 2, warns_since_level: 0 }, { level: 3, warns_since_level: 0 }]) {
        assert.equal(portal.nextWarningWords(ladder, en), nextWarningText(ladder));
    }
    assert.equal(portal.nextWarningWords({ level: 0, warns_since_level: 0 }, de), 'Es wäre Verwarnung 1 von 3. Noch 2 weitere danach würden einen automatischen Bann bedeuten (7 Tage).');
    assert.equal(portal.nextWarningWords({ level: 1, warns_since_level: 0 }, ru), 'Это будет предел предупреждений: автоматический бан (1 месяц, ступень предупреждений 2 из 3).');
    assert.equal(portal.nextWarningWords({ level: 2, warns_since_level: 0 }, ru), 'Это будет предел предупреждений: автоматический бан (навсегда, ступень предупреждений 3 из 3).');
    assert.equal(portal.banLengthText(DAY_MS + 3_600_000, ru), '1 день 1 час');
});

test('transparency words: masked counts and medians in the page\'s language; English as the service', () => {
    for (const values of [[0], [1], [2], [3, 0], [1234], [5, 2, 0], [1, 1, 0]]) {
        const mask = transparency.maskTotal(values);
        assert.equal(maskedText(mask, en), mask.text, String(values));
    }
    assert.equal(maskedText(transparency.maskCount(2), de), 'weniger als 3');
    assert.equal(maskedText(transparency.maskTotal([5, 2, 0]), ru), 'не меньше 6');
    assert.equal(maskedText(transparency.maskCount(1234), de), '1.234');
    for (const hours of [0.2, 1, 1.4, 5, 47.4, 48, 80, 240]) {
        assert.equal(medianWords(transparency.medianParts(hours, 3), en), transparency.medianText(hours, 3), String(hours));
    }
    assert.equal(medianWords(transparency.medianParts(0.5, 3), de), 'unter einer Stunde');
    assert.equal(medianWords(transparency.medianParts(5, 3), ru), '5 часов');
    assert.equal(medianWords(transparency.medianParts(50, 3), ru), '2,1 дня');
    assert.equal(medianWords(transparency.medianParts(5, 2), ru), null);
});

const TRUST_CARD = {
    days: 90, since: new Date('2026-08-03T12:00:00Z'), generatedAt: new Date('2026-11-01T12:00:00Z'), serverName: 'Mewvo', memberCount: 200,
    appeals: { received: 2, accepted: 4, denied: 2, answered: 7, decided: 6, medianFirstHours: 5.2, medianDecisionHours: 50 }, cases: 1000, flagged: 6, headsUp: { fixed: 8, acted: 2 },
};

test('number + noun sentences are plural keys (pricing, trust, portal, account, billing)', () => {
    const pro = PLANS.find((p) => p.id === 'pro');
    assert.match(String(planCard(en, pro)), /a year \(2 months free\)/);
    assert.match(String(planCard(de, pro)), /im Jahr \(2 Monate gratis\)/);
    assert.match(String(planCard(ru, pro)), /в год \(2 месяца бесплатно\)/);
    assert.equal(ladderSentence({ warnsPerLevel: 3, ladderBans: { 1: 7 * DAY_MS, 2: 21 * DAY_MS, 3: null } }, ru),
        'Предупреждения накапливаются: третье предупреждение означает бан на 7 дней, а каждое предупреждение после этого бана — более долгий бан (бан на 21 день, затем бан навсегда).');
    const trustRu = String(trustPage(ru, TRUST_CARD));
    assert.match(trustRu, /Последние 90 дней, с /);
    assert.match(trustRu, /за последние 90 дней\./);
    assert.match(trustRu, /<dd>меньше 3<\/dd>/, 'masked count in Russian');
    assert.match(trustRu, /<dd>5 часов<\/dd>|5 часов/);
    assert.match(trustRu, /<dd>5\s000<\/dd>/, 'cases per 1,000 members written the Russian way');
    const trustDe = String(trustPage(de, TRUST_CARD));
    assert.match(trustDe, /Letzte 90 Tage, vom /);
    assert.match(String(trustPage(en, TRUST_CARD)), /<dd>5,000<\/dd>/);
    const old = { case_code: 'k', type: 'kick', status: 'active', created_at: new Date(Date.now() - 100 * DAY_MS), reason: 'r' };
    const view = (text) => portal.buildRecordView({ standing: { warns: [] }, cases: Array.from({ length: 201 }, (_, i) => ({ ...old, case_code: `k${i}` })), appeals: [], text, config: enforcementConfig });
    assert.equal(view(ru).cases[0].appeal.text, 'Срок подачи апелляции (30 дней) истёк');
    assert.equal(view(de).cases[0].appeal.text, 'Die Einspruchsfrist (30 Tage) ist abgelaufen');
    const session = { username: 'ana', csrf: 'c' };
    assert.match(String(portal.recordPage(de, { session, view: view(de) })), /Es werden deine neuesten 201 Fälle angezeigt\./);
    assert.match(String(portal.recordPage(ru, { session, view: view(ru) })), /Показаны ваши последние 201 дело\./);
    assert.match(String(portal.recordPage(en, { session, view: view(en) })), /Showing your newest 201 cases\./);
    const order = { id: 7, kind: 'gift', plan_id: 'pro', period: 'yearly', amount_cents: 4990, created_at: new Date(Date.now() - 40 * DAY_MS), legal: null };
    const key = { code: 'MEWVO-A', plan_id: 'pro', duration_days: 1, gift_to: null, created_at: new Date(), expires_at: null };
    const receiptRu = String(billingSite.receiptPage(ru, { session, order, key }));
    assert.match(receiptRu, /Подарочный ключ · Pro, 1 день/);
    assert.match(receiptRu, /Срок в 14 дней истёк\./);
    assert.match(String(billingSite.receiptPage(de, { session, order, key: { ...key, duration_days: 365 } })), /Geschenk-Key · Pro, 365 Tage/);
    assert.match(String(billingSite.receiptPage(en, { session, order, key })), /The 14-day period ended\./);
    assert.match(String(billingSite.withdrawListPage(ru, { session, orders: [] })), /в течение 14 дней после заказа/);
    const checkoutRu = String(billingSite.checkoutPage(ru, { session, choice: { planId: 'pro', period: 'yearly', kind: 'gift' } }));
    assert.match(checkoutRu, /2 месяца бесплатно/);
    assert.match(checkoutRu, /365 дней с момента активации ключа/);
    assert.match(String(billingSite.checkoutPage(de, { session, choice: { planId: 'pro', period: 'monthly', kind: 'personal' } })), /30 Tage ab der Bestellung/);
});

test('home DM caption: English unchanged; translations say the bot sends the DM in English', () => {
    assert.match(String(homePage(en)), /Same wording as the bot\./);
    assert.match(String(homePage(de)), /Mewvo schickt sie auf Englisch/);
    assert.match(String(homePage(ru)), /Mewvo отправляет его на английском/);
    for (const { code } of LANGUAGES) assert.match(String(featuresPage(translator(code))), /Change to…</, `${code}: no doubled full stop`);
});
