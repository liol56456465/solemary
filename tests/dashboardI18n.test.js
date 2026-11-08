// The dashboard in 8 languages: language order, the picker, the catalog (src/content/dashboard/),
// the translated frame, and English staying as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
    DASHBOARD_CATALOG, LANGUAGES, PLURAL_CATEGORIES, placeholdersOf, setContentOverrides, translator,
} from '../src/services/site/i18n.js';
import {
    currentLanguage, dashboardLanguage, dashboardText, forgetDiscordLocales, languageContext, languageFromDiscordLocale,
    namespaceOf, rememberDiscordLocale,
} from '../src/services/dashboard/language.js';
import { layout, messagePage } from '../src/services/dashboard/html.js';
import { overviewPage, weekSeries, gettingStarted } from '../src/services/dashboard/overview.js';
import { moduleSettingsPage } from '../src/services/dashboard/pages.js';
import { InputError, intField, pill, postForm } from '../src/services/dashboard/forms.js';
import commandsModule from '../src/services/dashboard/modules/commands.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import { createDashboard, dashboardSettings } from '../src/services/dashboard/routes.js';
import { SESSION_COOKIE, STATE_COOKIE } from '../src/services/dashboard/security.js';

const CODES = LANGUAGES.map((l) => l.code);
const OTHERS = CODES.filter((c) => c !== 'en');
const ROOT = new URL('../src/content/dashboard/', import.meta.url);
const NAMESPACES = readdirSync(new URL('en/', ROOT)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

// ── Language order ─────────────────────────────────────────────────────────

test('language order: mewvo_lang cookie → Discord account language → Accept-Language → English', () => {
    forgetDiscordLocales();
    const req = (cookie, accept) => ({ headers: { ...(cookie ? { cookie } : {}), ...(accept ? { 'accept-language': accept } : {}) } });
    assert.equal(dashboardLanguage(req()), 'en');
    assert.equal(dashboardLanguage(req(null, 'pl-PL,pl;q=0.9')), 'pl');
    rememberDiscordLocale('200000000000000002', 'es-ES');
    assert.equal(dashboardLanguage(req(null, 'pl'), '200000000000000002'), 'es', 'Discord beats Accept-Language');
    assert.equal(dashboardLanguage(req('mewvo_lang=de', 'pl'), '200000000000000002'), 'de', 'the cookie beats both');
    assert.equal(dashboardLanguage(req('mewvo_lang=en', 'pl'), '200000000000000002'), 'en', 'a chosen English stays English');
    assert.equal(dashboardLanguage(req('mewvo_lang=xx', 'pl')), 'pl', 'an unknown cookie value is ignored');
    rememberDiscordLocale('200000000000000002', 'ja');
    assert.equal(dashboardLanguage(req(null, 'it'), '200000000000000002'), 'it', 'an unsupported Discord language is forgotten');
    forgetDiscordLocales();
});

test('Discord locales map onto the 8 languages; anything else is null', () => {
    const map = { de: 'de', ru: 'ru', fr: 'fr', it: 'it', pl: 'pl', 'es-ES': 'es', 'es-419': 'es', 'pt-BR': 'pt-BR', 'en-US': 'en', 'en-GB': 'en' };
    for (const [locale, lang] of Object.entries(map)) assert.equal(languageFromDiscordLocale(locale), lang, locale);
    for (const bad of ['ja', 'zh-CN', '', null, 42, '<script>', 'de;q=1', 'x'.repeat(40)]) assert.equal(languageFromDiscordLocale(bad), null, String(bad));
});

// ── The catalog ────────────────────────────────────────────────────────────

const pluralBase = (key) => key.replace(/\.(zero|one|two|few|many|other)$/, '');
test('every dashboard key exists in English and all 7 languages, with the same placeholders', () => {
    const en = DASHBOARD_CATALOG.catalogKeys('en');
    assert.ok(en.length > 300, `English catalog: ${en.length} keys`);
    const singles = en.filter((k) => !/\.(zero|one|two|few|many|other)$/.test(k));
    for (const lang of OTHERS) {
        const keys = new Set(DASHBOARD_CATALOG.catalogKeys(lang));
        for (const key of singles) {
            assert.ok(keys.has(key), `${lang}: missing ${key}`);
            assert.deepEqual(placeholdersOf(DASHBOARD_CATALOG.catalogText(lang, key)), placeholdersOf(DASHBOARD_CATALOG.catalogText('en', key)), `${lang}: placeholders of ${key}`);
        }
        // Plurals: every category the language uses (CLDR) is there, each with English's placeholders.
        const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
        for (const base of new Set(en.filter((k) => k !== pluralBase(k)).map(pluralBase))) {
            const want = placeholdersOf(DASHBOARD_CATALOG.catalogText('en', `${base}.other`));
            for (const category of categories) {
                const text = DASHBOARD_CATALOG.catalogText(lang, `${base}.${category}`);
                assert.ok(text !== undefined, `${lang}: missing ${base}.${category}`);
                assert.deepEqual(placeholdersOf(text), want, `${lang}: placeholders of ${base}.${category}`);
            }
        }
        // Nothing a language has that English does not (a typo would never be shown).
        // A plural form English does not use ("few", "many") is fine, but only for a plural English has.
        for (const key of keys) {
            const known = DASHBOARD_CATALOG.catalogText('en', key) !== undefined
                || (PLURAL_CATEGORIES.includes(key.split('.').pop()) && DASHBOARD_CATALOG.catalogText('en', `${pluralBase(key)}.other`) !== undefined);
            assert.ok(known, `${lang}: unknown key ${key}`);
        }
    }
});

test('the catalog files are the same namespaces in every language', () => {
    for (const lang of OTHERS) {
        const files = readdirSync(new URL(`${lang}/`, ROOT)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
        assert.deepEqual(files, NAMESPACES, lang);
    }
});

test('every catalog key the frame code names exists in English', () => {
    const files = ['html.js', 'forms.js', 'overview.js', 'pages.js', 'routes.js', 'modules/commands.js',
        'modules/common.js', 'enforcementPages.js', 'enforcementRoutes.js', 'inboxPages.js', 'inboxRoutes.js',
        'memberToolsPages.js', 'memberToolsRoutes.js', 'membersData.js', 'memberActions.js', 'bulkActions.js',
        'helpPages.js', 'incidentPages.js', 'backupPages.js', 'activityPage.js', 'modulesPage.js',
        'permissionFixRoutes.js', 'ownerPages.js', 'ownerErasePages.js', 'websitePages.js', 'modules/appearance.js',
        'modules/applications.js', 'modules/automod.js', 'modules/birthdays.js', 'modules/channels.js',
        'modules/community.js', 'modules/counters.js', 'modules/enforcement.js', 'modules/giveaways.js',
        'modules/joinToCreate.js', 'modules/leveling.js', 'modules/logging.js', 'modules/messages.js',
        'modules/reactionRoles.js', 'modules/rules.js', 'modules/support.js', 'modules/tickets.js',
        'modules/verification.js', 'modules/welcome.js', 'ownerErrors.js', 'modules/botLanguage.js'];
    const prefixes = NAMESPACES.join('|');
    const found = new Set();
    for (const file of files) {
        const code = readFileSync(new URL(`../src/services/dashboard/${file}`, import.meta.url), 'utf8');
        for (const m of code.matchAll(new RegExp(`['\`]((?:${prefixes})\\.[A-Za-z0-9_.-]+)['\`]`, 'g'))) found.add(m[1]);
    }
    assert.ok(found.size > 100, `${found.size} keys found in the code`);
    // Strings that look like catalog keys but are not (owner activity / audit keys).
    for (const notKey of ['commands.register']) found.delete(notKey);
    for (const key of found) {
        assert.ok(DASHBOARD_CATALOG.hasKey('en', key) || DASHBOARD_CATALOG.hasKey('en', `${key}.other`), `missing in English: ${key}`);
    }
});

test('the dashboard catalog is its own: website owner edits never reach it; the website API is unchanged', () => {
    setContentOverrides(() => 'EDITED');
    try {
        assert.equal(dashboardText('en').t('frame.skip'), 'Skip to content');
        assert.equal(translator('en').t('shell.header.skip'), 'EDITED', 'website keys still take owner edits');
    } finally { setContentOverrides(null); }
    assert.throws(() => translator('en').t('frame.skip'), /missing key/, 'dashboard keys are not website keys');
    assert.equal(translator('de', { catalog: 'dashboard' }).t('frame.skip'), DASHBOARD_CATALOG.catalogText('de', 'frame.skip'));
    assert.throws(() => translator('en', { catalog: 'nope' }), /unknown catalog/);
});

test('numbers and dates: English keeps the dashboard formats; other languages localize', () => {
    const en = dashboardText('en');
    const de = dashboardText('de');
    const at = new Date(Date.UTC(2026, 9, 27, 14, 3));
    assert.equal(en.fmtNumber(12345), '12345');
    assert.equal(de.fmtNumber(12345), '12.345');
    assert.equal(en.fmtDateTime(at), '2026-10-27 14:03 UTC');
    assert.match(de.fmtDateTime(at), /^27\.10\.2026, 14:03 UTC$/);
    assert.equal(en.tp('frame.nav.showAll', 3), 'Show all pages (3 more)');
    assert.equal(namespaceOf('reaction-roles'), 'reactionRoles');
    assert.equal(namespaceOf('owner/home'), 'ownerHome');
});

test('tx keeps the catalog quotes in a text node but escapes params', () => {
    const out = String(dashboardText('en').tx('overview.handover.empty'));
    assert.ok(out.includes('like "keep an eye on #general tonight"'));
    const withParam = String(dashboardText('en').tx('commands.every.support', { list: '<b>"x"</b>' }));
    assert.ok(withParam.includes('&lt;b&gt;&quot;x&quot;&lt;/b&gt;'));
});

// ── The frame in a language ────────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 5, 12, 0);
const SESSION = { username: 'a', csrf: 'tok', path: '/dashboard/cases?status=active', server: { name: 'S', iconUrl: null } };
const ADMIN = { allowed: true, role: 'admin', canView: true, canAct: true };
const OVERVIEW = {
    now: NOW, bot: { ready: true }, database: null, guild: { name: 'S', memberCount: 12345 }, openTickets: 2,
    week: weekSeries({}, NOW), joinedThisWeek: null, activeBans: 1, activeMutes: 0, pendingAppeals: 0, pendingList: [],
    lockdown: { active: false }, recent: [], checklist: gettingStarted({ config: {}, welcome: null, settings: {}, mutedRole: null }), moduleStates: {},
};

test('English pages: lang="en", no script words, the picker lists 8 languages with safe links', () => {
    const page = overviewPage({ session: SESSION, access: ADMIN, overview: OVERVIEW });
    assert.match(page, /^<!doctype html><html lang="en">/);
    assert.ok(!page.includes('data-ui-text'), 'English needs no word list for the script');
    assert.ok(!page.includes('data-unsaved') && !page.includes('data-in-use') && !page.includes('data-save'));
    const picker = page.match(/<details class="lang-switch menu-wrap">[\s\S]*?<\/details>/)[0];
    const links = [...picker.matchAll(/<a class="menu-item menu-link" href="([^"]+)" lang="([^"]+)"/g)];
    assert.deepEqual(links.map((m) => m[2]), CODES);
    for (const [, href] of links) assert.match(href, /^\/dashboard\/lang\?code=[A-Za-z-]+&amp;next=%2Fdashboard%2Fcases%3Fstatus%3Dactive$/);
    assert.ok(picker.includes('aria-label="Language: English"'));
    assert.ok(picker.includes('lang="en" hreflang="en" aria-current="true">English</a>'));
    for (const { name } of LANGUAGES) assert.ok(picker.includes(`>${name}</a>`), name);
    assert.ok(page.includes('<p class="stat-label">Members</p><span class="stat-value">12345</span>'));
});

test('a German session gets the whole frame and the Overview in German', () => {
    const de = dashboardText('de');
    const page = overviewPage({ session: { ...SESSION, lang: 'de' }, access: ADMIN, overview: OVERVIEW, recentChanges: [] });
    assert.match(page, /^<!doctype html><html lang="de">/);
    assert.ok(page.includes(`<title>${de.t('frame.title', { title: de.t('frame.nav.items.overview') })}</title>`));
    for (const key of ['frame.nav.items.cases', 'frame.nav.groups.moderate', 'frame.skip', 'overview.stats.members', 'overview.cards.needs', 'frame.user.logout']) {
        assert.ok(page.includes(de.t(key).replace(/&/g, '&amp;')), key);
    }
    assert.ok(page.includes('<span class="stat-value">12.345</span>'), 'German number grouping');
    assert.ok(!/>Members<|>Cases<|>Log out<|Needs your attention/.test(page), 'no English left in the frame');
    const ui = JSON.parse(page.match(/data-ui-text="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
    assert.equal(ui.cancel, de.t('frame.script.cancel'));
    assert.ok(ui.unsavedIn.includes('{place}'));
    assert.ok(page.includes(`data-in-use="${de.t('frame.theme.inUse')}"`));
});

test('message pages, the module frame and the Commands page follow the language', () => {
    const pl = dashboardText('pl');
    const message = messagePage(pl.t('errors.notFound'), pl.t('errors.noSuchPage'), null, { lang: 'pl' });
    assert.match(message, /^<!doctype html><html lang="pl">/);
    assert.ok(message.includes(pl.t('frame.message.backHome')));
    const ctx = { csrf: 't', canEdit: true, canAct: true, lang: 'pl', guild: { id: '1', channels: { cache: new Map() }, roles: { cache: new Map() } }, client: { commands: new Map() } };
    const body = commandsModule.render(ctx, { config: {}, snapshot: { categories: [] } });
    const page = moduleSettingsPage({ session: { ...SESSION, lang: 'pl' }, access: ADMIN, module: commandsModule, body, editEnabled: false });
    assert.ok(page.includes(`<h1>${pl.t('frame.nav.items.commands')}</h1>`));
    assert.ok(page.includes(pl.t('commands.page.help')));
    assert.ok(page.includes(pl.t('commands.bot.title')));
    assert.ok(page.includes(pl.t('forms.save')), 'the default Save button');
    assert.ok(page.includes(`data-unsaved="${pl.t('frame.unsaved')}"`));
    assert.ok(page.includes(' data-save>'), 'the script knows the translated Save button');
    assert.ok(page.includes(pl.t('forms.reset')), 'a translated Save still gets Reset');
});

test('helpers without a context use the request language (AsyncLocalStorage); English outside a request', async () => {
    assert.equal(currentLanguage(), 'en');
    assert.equal(String(pill(true)), '<span class="state state-on">on</span>');
    await new Promise((resolve, reject) => {
        languageContext({ headers: { cookie: 'mewvo_lang=fr' } }, {}, async () => {
            try {
                await Promise.resolve();
                assert.equal(currentLanguage(), 'fr');
                assert.throws(() => intField({ n: 'x' }, 'n', { min: 1, max: 5, label: 'N' }), (error) => error instanceof InputError
                    && error.userMessage === dashboardText('fr').t('forms.error.wholeNumber', { label: 'N' }));
                assert.ok(String(postForm({ csrf: 't', canEdit: true }, 'm', 'a', '')).includes(dashboardText('fr').t('forms.save')));
                resolve();
            } catch (error) { reject(error); }
        });
    });
    assert.equal(currentLanguage(), 'en');
});

// ── Routes: picker, login language, pages ────────────────────────────────

const ENV = {
    DASHBOARD_ENABLED: 'true', SESSION_SECRET: 'x'.repeat(64), CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: 'https://bot.example/', MAIN_GUILD_ID: '100000000000000001', NODE_ENV: 'test',
};
const ADMIN_ID = '200000000000000002';
function fakeRes() {
    return {
        statusCode: 200, headers: {}, cookies: [], body: null, redirectedTo: null,
        status(code) { this.statusCode = code; return this; }, type() { return this; }, send(body) { this.body = body; return this; },
        set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; },
        append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
}
function makeDashboard(me) {
    const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/token') ? { access_token: 'tok' } : me) });
    const access = createAccessChecker({}, { facts: async (client, userId) => ({ inGuild: true, isAdmin: userId === ADMIN_ID, isOwnerId: false }) });
    const overview = {
        getGuildConfig: async () => ({}), getWelcomeConfig: async () => null, countOpenTickets: async () => 0, listPendingAppeals: async () => [],
        searchCaseRecords: async () => ({ rows: [], total: 0 }), countActiveSanctions: async () => ({ ban: 0, mute: 0 }), casesPerDay: async () => ({}),
        getLockdownState: async () => ({ active: false }), findMutedRole: async () => null,
    };
    return createDashboard({
        client: { user: { id: '9' }, guilds: { cache: new Map() }, isReady: () => true, ws: { ping: 1 } },
        settings: dashboardSettings(ENV), access, fetchImpl, sessions: createMemorySessionStore(), data: { overview },
    });
}
async function login(d) {
    const start = fakeRes();
    await d.index({ headers: {}, ip: '1.1.1.1' }, start);
    const state = new URL(start.redirectedTo).searchParams.get('state');
    const nonce = decodeURIComponent(start.cookies.find((c) => c.startsWith(`${STATE_COOKIE}=`)).split(';')[0].slice(STATE_COOKIE.length + 1));
    const res = fakeRes();
    await d.callback({ headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(nonce)}` }, query: { code: 'c', state } }, res);
    const line = res.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    return { res, cookie: line ? line.split(';')[0] : '' };
}
async function page(d, handler, req) {
    const res = fakeRes();
    let passed = false;
    await d.requireUser(req, res, () => { passed = true; });
    if (passed) await handler(req, res);
    return res;
}

test('picker route: sets the shared mewvo_lang cookie and returns only to a dashboard path', () => {
    const d = makeDashboard({ id: ADMIN_ID, username: 'a' });
    const go = (query) => { const res = fakeRes(); d.setLanguage({ query, headers: {} }, res); return res; };
    const ok = go({ code: 'de', next: '/dashboard/cases?status=active' });
    assert.equal(ok.statusCode, 303);
    assert.equal(ok.redirectedTo, '/dashboard/cases?status=active');
    assert.deepEqual(ok.cookies, ['mewvo_lang=de; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure'], 'the website\'s own cookie (Path=/)');
    assert.equal(ok.headers['Cache-Control'], 'no-store');
    assert.equal(go({ code: 'pt-BR', next: '/dashboard/overview' }).cookies[0].split(';')[0], 'mewvo_lang=pt-BR');
    for (const next of ['//evil.example/x', 'https://evil.example/', '/dashboard//evil.example', '/features', '/dashboard/x"><script>', ['/dashboard/cases']]) {
        assert.equal(go({ code: 'de', next }).redirectedTo, '/dashboard/overview', String(next));
    }
    for (const code of ['xx', 'de; Path=/x', '<b>', ['de'], undefined]) {
        const res = go({ code, next: '/dashboard/cases' });
        assert.deepEqual(res.cookies, [], `no cookie for ${String(code)}`);
        assert.equal(res.redirectedTo, '/dashboard/cases');
    }
});

test('login remembers the Discord language; a cookie wins; error pages follow cookie / Accept-Language', async () => {
    forgetDiscordLocales();
    const d = makeDashboard({ id: ADMIN_ID, username: 'a', locale: 'de' });
    const { cookie } = await login(d);
    const german = await page(d, d.overview, { method: 'GET', path: '/overview', headers: { cookie, 'accept-language': 'fr' }, query: {} });
    assert.match(german.body, /^<!doctype html><html lang="de">/, 'Discord locale beats Accept-Language');
    const cookieWins = await page(d, d.overview, { method: 'GET', path: '/overview', headers: { cookie: `${cookie}; mewvo_lang=it` }, query: {} });
    assert.match(cookieWins.body, /^<!doctype html><html lang="it">/);
    // A module page: ctx carries the translator, the frame is Italian.
    const it = dashboardText('it');
    const missing = await page(d, d.notFound, { method: 'GET', path: '/nope', headers: { cookie: `${cookie}; mewvo_lang=it` }, query: {} });
    assert.equal(missing.statusCode, 404);
    assert.ok(missing.body.includes(`<h1>${it.t('errors.notFound')}</h1>`));
    // Logged out: no session, the language from the headers only; nothing from them is reflected.
    const stranger = makeDashboard({ id: '300000000000000003', username: 'x' });
    const start = fakeRes();
    await stranger.index({ headers: {} }, start);
    const res = fakeRes();
    await stranger.callback({ headers: { 'accept-language': 'ru', cookie: 'mewvo_lang=<script>' }, query: { error: 'access_denied' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /^<!doctype html><html lang="ru">/);
    assert.ok(res.body.includes(dashboardText('ru').t('errors.loginCancelled')));
    assert.ok(!res.body.includes('<script>alert') && !res.body.includes('mewvo_lang'));
    forgetDiscordLocales();
});

test('English output of the frame is unchanged: every frame word is the English catalog', () => {
    const page = layout({ title: 'X', session: SESSION, access: ADMIN, body: '' });
    for (const text of ['Skip to content', 'Find a setting…', 'Moderate', 'Server setup', 'Show all pages (', 'Mewvo website', 'Same as my device', 'Managing now', 'Switch server', 'Log out', 'Administrator']) {
        assert.ok(page.includes(text), text);
    }
    assert.ok(page.includes('<title>X · Mewvo dashboard</title>'));
});

// tx() keeps the catalog's ' and " unescaped (so English pages stay byte-for-byte), which is only
// safe in a text node. Rather than escaping quotes (that would change every English page that
// shows an apostrophe), this test makes sure no dashboard code ever puts tx() in a tag.
function txInAttribute(source) {
    const problems = [];
    source.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const match of line.matchAll(/\btx\(/g)) {
            const open = line.lastIndexOf('${', match.index);
            if (open === -1) {
                // Not inside ${…} on this line: only fine when the line has no template markup at all.
                if (/[<>]/.test(line)) problems.push(`${i + 1}: tx() outside \${…} on a line with markup`);
                continue;
            }
            const before = line.slice(0, open);
            const inTag = before.lastIndexOf('<') > before.lastIndexOf('>');
            if (inTag || /=\s*["']?$/.test(before)) problems.push(`${i + 1}: tx() inside a tag or attribute`);
        }
    });
    return problems;
}

test('tx() is never used inside an HTML tag or attribute value in src/services/dashboard', () => {
    // The checker itself catches the cases it is for.
    assert.equal(txInAttribute('html`<a title="${tr.tx(\'k\')}">x</a>`').length, 1, 'quoted attribute');
    assert.equal(txInAttribute('html`<a title=${tx(\'k\')}>x</a>`').length, 1, 'unquoted attribute');
    assert.equal(txInAttribute('html`<input ${tr.tx(\'k\')}>`').length, 1, 'inside a tag');
    assert.equal(txInAttribute('html`<p class="muted">${tr.tx(\'k\')}</p>`').length, 0, 'text node is fine');
    assert.equal(txInAttribute('// tx(): a key for a text node').length, 0, 'comments are skipped');

    const dir = new URL('../src/services/dashboard/', import.meta.url);
    const files = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.js'));
    let uses = 0;
    for (const file of files) {
        const source = readFileSync(new URL(String(file), dir), 'utf8');
        uses += (source.match(/\btx\(/g) || []).length;
        assert.deepEqual(txInAttribute(source), [], `src/services/dashboard/${file}`);
    }
    assert.ok(uses > 0, 'the scan found the tx() calls');
});
