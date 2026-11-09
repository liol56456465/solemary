// The website's command explorer (/commands, pages/commands.js + commandCatalog.js), from the real
// command files: every access key exactly once in all 8 languages, /database and other owner tools
// never, translated descriptions, the filters, the anchors and redirects, the CSP (form-action
// 'self' on /commands only, no inline script or style) and every text key in every language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { loadCommands } from '../src/handlers/loaders/commandLoader.js';
import { DASHBOARD_PAGES, OWNER_KIT, commandEntries } from '../src/config/commands/retirement.js';
import { EVERYONE_COMMANDS, MANAGE_SERVER_COMMANDS } from '../src/config/commands/commandAccess.js';
import { LANGUAGES, loadCatalogs } from '../src/services/site/i18n.js';
import { COMMANDS_CSP, createSite, SECURITY_HEADERS } from '../src/services/site/site.js';
import {
    ACCESS_TIERS, buildCommandCatalog, commandCatalog, commandSlug, invalidateCommandCatalog,
} from '../src/services/site/commandCatalog.js';
import {
    DEFAULT_WHO, HAND_EXAMPLES, OPTION_TYPES, commandAnchorHref, commandFilters, commandsPage, matchesFilters, whoParam,
} from '../src/services/site/pages/commands.js';

const client = {};
await loadCommands(client);
const COMMANDS = client.commands;
const KEYS = commandEntries(COMMANDS).map((e) => e.key);
const CATALOGS = loadCatalogs();

async function serve({ commands = COMMANDS, env = {} } = {}) {
    const app = express();
    app.use(createSite({ client: { commands }, env: { CLIENT_ID: '123456789012345678', ...env }, leaderboard: async () => ({ enabled: true, rows: [] }), status: () => ({ state: 'online', uptimeMs: 1 }) }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
        const res = await fetch(base + path, { redirect: 'manual' });
        return { status: res.status, headers: res.headers, body: await res.text() };
    };
    return { get, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The card ids of a page and which of them are hidden. */
function cards(body) {
    const all = [...body.matchAll(/<article class="cmd-card" id="([a-z0-9-]+)"([^>]*)>/g)];
    return { ids: all.map((m) => m[1]), shown: all.filter((m) => !/ hidden$/.test(m[2])).map((m) => m[1]) };
}

test('catalog: every commandEntries key exactly once, a unique slug, in all 8 languages; no owner tools', () => {
    assert.ok(KEYS.length > 150, `keys: ${KEYS.length}`);
    for (const { code } of LANGUAGES) {
        const entries = buildCommandCatalog(COMMANDS, code);
        assert.deepEqual(entries.map((e) => e.key).sort(), [...KEYS].sort(), code);
        const slugs = entries.map((e) => e.slug);
        assert.equal(new Set(slugs).size, slugs.length, `${code}: unique slugs`);
        for (const e of entries) {
            assert.match(e.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, e.key);
            assert.ok(!e.slug.startsWith('c-') && !e.slug.startsWith('h-') && !['main', 'cmd-q', 'cmd-cat', 'cmd-who'].includes(e.slug), `${e.slug} clashes with a page id`);
            assert.ok(e.menu || e.description.trim(), `${code}: ${e.key} has a description`);
        }
        assert.ok(!entries.some((e) => e.key === 'database' || e.key.startsWith('database ')), `${code}: /database is never listed`);
    }
    const owner = [...COMMANDS.values()].filter((c) => c.scope === 'owner').map((c) => c.data.name);
    assert.ok(owner.includes('database'), 'the owner tool exists and is left out on purpose');
});

test('catalog: access tiers follow commandAccess and the owner kit; dashboard pages only for staff commands', () => {
    for (const e of buildCommandCatalog(COMMANDS, 'en')) {
        const expected = EVERYONE_COMMANDS.has(e.key) ? 'everyone' : MANAGE_SERVER_COMMANDS.has(e.key) ? 'manage' : OWNER_KIT.has(e.key) ? 'ownerkit' : 'admin';
        assert.equal(e.access, expected, e.key);
        if (e.access === 'everyone' || e.access === 'manage' || e.key === 'test') assert.equal(e.page, null, e.key);
        else assert.ok(DASHBOARD_PAGES.includes(e.page), `${e.key}: ${e.page}`);
    }
    const byKey = new Map(buildCommandCatalog(COMMANDS, 'en').map((e) => [e.key, e]));
    assert.equal(byKey.get('enforcements').access, 'ownerkit');
    assert.equal(byKey.get('setup').access, 'manage');
    assert.equal(byKey.get('backup status').group, 'recovery', 'the Owner folder shows as Recovery');
    assert.equal(byKey.get('Report message').menu, 'message');
    assert.equal(byKey.get('Moderate').menu, 'member');
});

test('catalog: non-English descriptions come from the commands\' own localizations', () => {
    const en = new Map(buildCommandCatalog(COMMANDS, 'en').map((e) => [e.key, e]));
    for (const { code } of LANGUAGES.filter((l) => l.code !== 'en')) {
        const entries = buildCommandCatalog(COMMANDS, code).filter((e) => !e.menu);
        const translated = entries.filter((e) => e.description !== en.get(e.key).description);
        assert.ok(translated.length / entries.length > 0.9, `${code}: ${translated.length} of ${entries.length} translated`);
        const search = entries.find((e) => e.key === 'case search');
        assert.notEqual(search.description, en.get('case search').description, code);
        assert.ok(search.search.includes(en.get('case search').description.toLowerCase()), `${code}: English words still match`);
        const option = search.options.find((o) => o.name === 'member');
        assert.notEqual(option.description, en.get('case search').options.find((o) => o.name === 'member').description, `${code}: option text`);
    }
});

test('catalog: each group appears once, in page order; a module\'s own lower-case category joins its folder\'s group', () => {
    const runs = buildCommandCatalog(COMMANDS, 'en').map((e) => e.group).filter((g, i, all) => g !== all[i - 1]);
    assert.equal(new Set(runs).size, runs.length, runs.join(' '));
    assert.equal(runs[0], 'core');
    assert.equal(runs.at(-1), 'recovery');
    const cmd = (name, category) => [name, { category, data: { toJSON: () => ({ name, description: 'd' }) } }];
    const mixed = buildCommandCatalog(new Map([cmd('a', 'Moderation'), cmd('b', 'Ticket'), cmd('c', 'moderation')]), 'en');
    assert.deepEqual(mixed.map((e) => [e.key, e.group]), [['b', 'ticket'], ['a', 'moderation'], ['c', 'moderation']]);
});

test('catalog: cached per language, rebuilt for a new command map and after invalidateCommandCatalog()', () => {
    const a = commandCatalog(COMMANDS, 'de');
    assert.equal(commandCatalog(COMMANDS, 'de'), a, 'cached');
    invalidateCommandCatalog();
    assert.notEqual(commandCatalog(COMMANDS, 'de'), a, 'rebuilt');
    assert.deepEqual(commandCatalog(new Map(), 'de'), [], 'nothing before the commands load');
    assert.equal(commandSlug('Warn for this message'), 'warn-for-this-message');
});

test('texts: every commands.* key in all 8 languages; every dashboard page, option type and hand-written example labelled', () => {
    const en = CATALOGS.get('en');
    const keys = [...en.keys()].filter((k) => k.startsWith('pages.commands.'));
    assert.ok(keys.length > 80, `keys: ${keys.length}`);
    for (const { code } of LANGUAGES) {
        const cat = CATALOGS.get(code);
        for (const key of keys) assert.ok(cat.get(key)?.trim(), `${code}: ${key}`);
        for (const page of DASHBOARD_PAGES) assert.ok(cat.has(`pages.commands.dashboardPages.${page}`), `${code}: page ${page}`);
        for (const name of Object.values(OPTION_TYPES)) {
            assert.ok(cat.has(`pages.commands.types.${name}`) && cat.has(`pages.commands.placeholders.${name}`), `${code}: type ${name}`);
        }
        for (const tier of ACCESS_TIERS) assert.ok(cat.has(`pages.commands.access.${tier}`) && cat.has(`pages.commands.who.${tier}`), `${code}: ${tier}`);
    }
    assert.equal(en.get('pages.commands.access.ownerkit'), 'Administrator; owner-only when admin commands are retired');
    assert.equal(en.get('pages.commands.groups.recovery'), 'Recovery');
});

test('hand-written examples: about 10, each for a real command, using only its own option names', () => {
    assert.ok(HAND_EXAMPLES.length >= 10);
    const bySlug = new Map(buildCommandCatalog(COMMANDS, 'en').map((e) => [e.slug, e]));
    for (const slug of HAND_EXAMPLES) {
        const entry = bySlug.get(slug);
        assert.ok(entry, slug);
        for (const { code } of LANGUAGES) {
            const text = CATALOGS.get(code).get(`pages.commands.examples.${slug}`);
            assert.ok(text.startsWith(`/${entry.key} `) || text === `/${entry.key}`, `${code}: ${slug} starts with the command`);
            const names = [...text.matchAll(/(?:^|\s)([a-z0-9_]+):/g)].map((m) => m[1]);
            assert.ok(names.length, `${code}: ${slug} has options`);
            for (const name of names) assert.ok(entry.options.some((o) => o.name === name), `${code}: ${slug} option ${name}`);
            for (const o of entry.options.filter((x) => x.required)) assert.ok(names.includes(o.name), `${code}: ${slug} has required ${o.name}`);
        }
    }
});

test('filters: q trimmed and cut, bad cat ignored; who defaults to everyone, who=all is every tier; who=admin includes the owner kit', () => {
    const groups = ['core', 'enforcement'];
    assert.deepEqual(commandFilters({ q: '  warn  ', cat: 'core', who: 'everyone' }, groups), { q: 'warn', cat: 'core', who: 'everyone' });
    // Beginner audit 4.11: visitors start on "everyone"; an unknown who falls back to that default.
    assert.equal(DEFAULT_WHO, 'everyone');
    assert.deepEqual(commandFilters({}, groups), { q: '', cat: '', who: 'everyone' });
    assert.deepEqual(commandFilters({ q: ['a', 'b'], cat: 'nope', who: 'root' }, groups), { q: 'a', cat: '', who: 'everyone' });
    assert.deepEqual(commandFilters({ who: 'all' }, groups), { q: '', cat: '', who: '' }, 'who=all: no tier filter');
    assert.deepEqual(commandFilters({ q: { x: 1 }, cat: ['core'], who: ['ownerkit'] }, groups), { q: '', cat: 'core', who: 'ownerkit' });
    assert.equal(whoParam('everyone'), '', 'the default has no ?who=');
    assert.equal(whoParam(''), 'all');
    assert.equal(whoParam('admin'), 'admin');
    assert.equal(commandFilters({ q: 'x'.repeat(500) }, groups).q.length, 100);
    const entry = { group: 'enforcement', access: 'ownerkit', search: '/enforcements open the panel' };
    assert.ok(matchesFilters(entry, { who: 'admin' }) && matchesFilters(entry, { who: 'ownerkit' }));
    assert.ok(!matchesFilters(entry, { who: 'everyone' }));
    assert.ok(matchesFilters(entry, { q: 'PANEL enforcements' }) && !matchesFilters(entry, { q: 'panel zzz' }));
});

test('page: all cards rendered, filtered ones hidden; who, cat and q work server-side; the default shows everyone commands', async () => {
    const site = await serve();
    try {
        const entries = buildCommandCatalog(COMMANDS, 'en');
        const tier = (who) => entries.filter((e) => matchesFilters(e, { who })).map((e) => e.slug).sort();
        // No ?who=: every card is sent, only the "everyone" ones show, with the "Show all" note.
        const plain = (await site.get('/commands')).body;
        const first = cards(plain);
        assert.equal(first.ids.length, KEYS.length);
        assert.deepEqual(first.shown.sort(), tier('everyone'), 'visitors see the everyone commands first');
        assert.ok(first.shown.length < KEYS.length && first.shown.includes('remind-me') && !first.shown.includes('enforcements'));
        assert.ok(plain.includes('<p class="notice cmd-default" data-cmd-default>Showing the commands everyone can use. <a href="/commands?who=all" data-cmd-all><strong>Show all commands (incl. admin)</strong></a></p>'), 'the show-all link');
        assert.match(plain, /<option value="everyone" selected>Everyone<\/option>/);
        assert.match(plain, /<option value="all">All<\/option>/);
        assert.ok(plain.includes('<li><a href="/commands?who=all">All</a></li>') && plain.includes('<li><a href="/commands" aria-current="true">Everyone</a></li>'));
        const all = cards((await site.get('/commands?who=all')).body);
        assert.equal(all.ids.length, KEYS.length);
        assert.equal(all.shown.length, KEYS.length, '?who=all shows every card');
        const allBody = (await site.get('/commands?who=all')).body;
        assert.match(allBody, /<p class="notice cmd-default" data-cmd-default hidden>/, 'no note when everything shows');
        assert.match(allBody, /<option value="all" selected>All<\/option>/);
        const kept = (await site.get('/commands?q=case&cat=enforcement')).body;
        assert.ok(kept.includes('href="/commands?q=case&amp;cat=enforcement&amp;who=all" data-cmd-all'), 'show-all keeps q and cat');
        assert.ok((await site.get('/de/commands')).body.includes('<a href="/de/commands?who=all" data-cmd-all>'), 'show-all keeps the language');
        for (const who of ACCESS_TIERS) {
            const page = cards((await site.get(`/commands?who=${who}`)).body);
            assert.equal(page.ids.length, KEYS.length, `${who}: every card is sent`);
            assert.deepEqual(page.shown.sort(), tier(who), who);
        }
        assert.ok(tier('admin').includes('enforcements') && !tier('everyone').includes('purge'));
        const bad = cards((await site.get('/commands?who=root&cat=%3Cscript%3E')).body);
        assert.deepEqual(bad.shown.sort(), tier('everyone'), 'bad who / cat: the default filter');
        const birthday = cards((await site.get('/commands?cat=birthday&who=all')).body);
        assert.ok(birthday.shown.length && birthday.shown.every((s) => s.startsWith('birthday-')));
        const search = await site.get('/commands?q=%20%20remind%20');
        assert.ok(cards(search.body).shown.includes('remind-me'));
        assert.ok(search.body.includes('value="remind"'), 'q trimmed into the field');
        const none = await site.get('/commands?q=zzzqqq');
        assert.equal(cards(none.body).shown.length, 0);
        assert.ok(/<p class="cmd-empty" data-cmd-empty>No command matches/.test(none.body), 'the empty note shows');
        const de = await site.get('/de/commands?q=f%C3%A4lle&who=admin');
        assert.ok(cards(de.body).shown.includes('case-search'), 'German words match on /de');
    } finally { await site.close(); }
});

test('page: anchors, access tags, examples, dashboard lines; no ids, /database or inline script/style', async () => {
    const site = await serve();
    try {
        const body = (await site.get('/commands')).body;
        assert.ok(body.includes('<a class="cmd-anchor" href="#case-search"'));
        assert.ok(body.includes('Administrator; owner-only when admin commands are retired'));
        assert.ok(body.includes('<code>/remind me in:2h text:Take the bread out of the oven</code>'), 'hand-written example');
        assert.ok(body.includes('<code>/case watch add member:@member reason:text</code>'), 'generated example');
        assert.ok(body.includes('Also on the dashboard: Cases'));
        assert.ok(!body.includes('Moved to the dashboard'), 'not retired: nothing moved');
        assert.ok(!/<code>\/database/.test(body) && !body.includes('id="database'));
        assert.ok(!/<script(?![^>]*\ssrc=)/.test(body), 'no inline script');
        assert.ok(!/\sstyle=/.test(body) && !/<style/.test(body), 'no inline style');
        assert.ok(!/\b\d{17,20}\b/.test(body.replace(/client_id=\d+/g, '')), 'no Discord ids on the page');
        assert.ok(body.includes('<form class="cmd-filter" method="get" action="/commands"'));
        const de = (await site.get('/de/commands')).body;
        assert.ok(de.includes('action="/de/commands"') && de.includes('Fälle nach Mitglied'));
    } finally { await site.close(); }
    const retired = await serve({ env: { RETIRE_ADMIN_COMMANDS: 'true' } });
    try {
        const body = (await retired.get('/commands')).body;
        assert.ok(body.includes('Moved to the dashboard: Cases'));
    } finally { await retired.close(); }
});

test('headers: form-action \'self\' and script-src \'self\' on /commands only; the rest of the site keeps form-action \'none\'', async () => {
    assert.equal(COMMANDS_CSP, SECURITY_HEADERS['Content-Security-Policy'].replace("form-action 'none'", "form-action 'self'"));
    const site = await serve();
    try {
        for (const path of ['/commands', '/commands?who=admin', '/de/commands']) {
            const csp = (await site.get(path)).headers.get('content-security-policy');
            assert.equal(csp, COMMANDS_CSP, path);
            assert.match(csp, /script-src 'self';/);
            assert.match(csp, /form-action 'self';/);
        }
        for (const path of ['/', '/docs', '/features', '/nope', '/commands/nope-nothing']) {
            assert.match((await site.get(path)).headers.get('content-security-policy'), /form-action 'none'/, path);
        }
    } finally { await site.close(); }
});

test('/commands/<slug>: 301 to the anchor (or the command\'s first card), ?who=all for cards the default hides, keeps the language; unknown → 404', async () => {
    const site = await serve();
    try {
        const exact = await site.get('/commands/case-search');
        assert.equal(exact.status, 301);
        assert.equal(exact.headers.get('location'), '/commands?who=all#case-search', 'an admin card: ?who=all, or the default filter would hide it');
        const parent = await site.get('/commands/case');
        assert.equal(parent.status, 301);
        assert.equal(parent.headers.get('location'), '/commands?who=all#case-edit');
        assert.equal((await site.get('/de/commands/purge')).headers.get('location'), '/de/commands?who=all#purge');
        assert.equal((await site.get('/commands/remind-me')).headers.get('location'), '/commands#remind-me', 'an everyone card: no ?who=');
        assert.equal(commandAnchorHref(COMMANDS, 'no-such-command'), null);
        assert.equal((await site.get('/commands/no-such-command')).status, 404);
        assert.equal((await site.get('/commands/database')).status, 404, 'owner tools have no card');
    } finally { await site.close(); }
});

test('page renders with fake commands too (escaping, a command without a folder)', () => {
    const page = String(commandsPage({ commands: new Map([['x', { data: { toJSON: () => ({ name: 'x', description: '<img src=x onerror=alert(1)>' }) } }]]) }));
    assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;') && !page.includes('<img src=x'));
    assert.ok(page.includes('id="h-other">Other</h2>'));
});
