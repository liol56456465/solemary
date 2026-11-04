// Website text in the catalog: the shell, home, features, mockups and changelog read every visible
// string from content/site/en/{shell,home,features,mockups,changelog}.json. Rendering every branch
// with a recording translator proves each key exists (a missing key throws) and that the catalog
// holds no key the pages no longer use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogs, translator, PLURAL_CATEGORIES, hasKey } from '../src/services/site/i18n.js';
import { addButton, installUrl, layout } from '../src/services/site/shell.js';
import { heroActions, homePage } from '../src/services/site/pages/home.js';
import { featuresPage } from '../src/services/site/pages/features.js';
import { changelogPage } from '../src/services/site/pages/changelog.js';
import { appealFormMock, banDmMock, ladderMock, warnDmMock } from '../src/services/site/pages/mockups.js';

const NAMESPACES = ['shell', 'home', 'features', 'mockups', 'changelog'];

/** A translator that records every key it is asked for (lookups of a missing key throw). */
function recording(lang = 'en') {
    const base = translator(lang);
    const used = new Set();
    const wrap = (fn) => (key, params) => { used.add(key); return fn(key, params); };
    return { used, ctx: { lang: base.lang, t: wrap(base.t), ti: wrap(base.ti), tb: wrap(base.tb), tp: (key, count, params) => { for (const c of PLURAL_CATEGORIES) if (hasKey('en', `${key}.${c}`)) used.add(`${key}.${c}`); return base.tp(key, count, params); } } };
}

const FLAGS = [
    {},
    {
        publicSite: true, installUrl: installUrl('123456789012345678'), dashboardEnabled: true, memberPortal: true, accounts: true, billing: true,
        supportInvite: 'https://discord.gg/support1', mainInvite: 'https://discord.gg/main1', origin: 'https://mewvo.example', transparency: true, trustCard: true,
    },
    { memberPortal: true, billing: true, dashboardEnabled: true, supportInvite: 'https://discord.gg/support1', viewer: { name: 'Ann', accountId: 'a1', csrf: 'x' } },
    { dashboardEnabled: true, supportInvite: 'https://discord.gg/support1' },
    { mainInvite: 'https://discord.gg/main1' },
    // The language picker, the "also available in" note and the English-only note (language.js / shell.js).
    { languageLink: (code, path) => `${path}?setlang=${code}`, suggestLang: 'de', englishOnlyFor: 'de' },
];
// Read in the OTHER language (the note is written in the language it offers), not through ctx.
const OTHER_LANGUAGE_KEYS = ['shell.suggestLanguage', 'shell.legalEnglishOnly'];

function renderAll(ctx) {
    return [
        homePage(ctx), featuresPage(ctx), changelogPage(ctx),
        layout(ctx, { title: 'X', active: 'features', path: '/x', body: '' }),
        heroActions(ctx), addButton(ctx), warnDmMock(ctx), banDmMock(ctx), appealFormMock(ctx), ladderMock(ctx),
    ].map(String).join('\n');
}

test('site text: every key the shell, home, features, mockups and changelog use is in the English catalog, and none is unused', () => {
    const { used, ctx } = recording('en');
    const pages = FLAGS.map((flags) => renderAll({ ...flags, ...ctx })).join('\n');
    assert.ok(pages.includes('class="lang-suggest"') && pages.includes('class="notice lang-note"'), 'the language notes render');
    for (const key of OTHER_LANGUAGE_KEYS) used.add(key);
    const en = loadCatalogs().get('en');
    for (const key of used) assert.ok(en.has(key), `missing English key ${key}`);
    const owned = [...en.keys()].filter((key) => NAMESPACES.includes(key.split('.')[0]));
    assert.ok(owned.length > 100, 'the catalogs are there');
    const unused = owned.filter((key) => !used.has(key));
    assert.deepEqual(unused, [], 'catalog keys no page reads');
});

test('site text: a bare context renders English; another language sets <html lang> and falls back key by key', () => {
    assert.match(homePage({}), /<html lang="en">/);
    assert.ok(homePage({}).includes('<h1>A Discord bot for moderation and appeals</h1>'));
    const de = { ...translator('de') };
    const page = featuresPage(de);
    assert.match(page, /<html lang="de">/);
    assert.ok(page.includes('<h1>'), 'renders with the English fallback where a key is not translated yet');
});
