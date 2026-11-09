// Front website (src/services/site/site.js): pages render, values are escaped, nothing is
// indexed and there is no add button while PUBLIC_SITE_ENABLED is off, the CSP has no
// unsafe-inline, and /health and /ready are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import {
    CSS_PATH, INSTALL_PERMISSIONS, JS_PATH, LEADERBOARD_PAGE_SIZE, NOINDEX, SCRIPT, SECURITY_HEADERS, STYLESHEET, botStatus,
    COMMANDS_CSP, createCatReader, createLeaderboardReader, createSite, installPermissionBits, installUrl, inviteOrNull,
    leaderboardPage, leaderboardPageNumber, publicSiteEnabled, uptimeWords,
} from '../src/services/site/site.js';

const CLIENT_ID = '123456789012345678';
const SUPPORT = 'https://discord.gg/7Ckv9Bt577';
const MAIN = 'https://discord.gg/mainServer1';

const SUB = (name, description) => ({ type: 1, name, description });
const fakeCommand = (json, category) => ({ category, data: { toJSON: () => json } });
function fakeCommands() {
    return new Map([
        ['ping', fakeCommand({ name: 'ping', description: 'Checks the bot’s latency <b>' }, 'Core')],
        ['todo', fakeCommand({ name: 'todo', description: 't', options: [SUB('add', 'Add a task'), { type: 2, name: 'share', options: [SUB('view', 'View a shared list')] }] }, 'Utility')],
        ['birthday', fakeCommand({ name: 'birthday', description: 'b', options: [SUB('set', 'Set your birthday'), SUB('setchannel', 'ADMIN ONLY')] }, 'Birthday')],
        ['purge', fakeCommand({ name: 'purge', description: 'ADMIN PURGE' }, 'Moderation')],
        ['claim', fakeCommand({ name: 'claim', description: 'Claims a ticket' }, 'Ticket')],
        ['Report message', fakeCommand({ name: 'Report message', type: 3 }, undefined)],
    ]);
}

/** A bare app with the real health routes' shape first, then the site (as in app.js). */
async function serve({
    env = {}, commands = fakeCommands(), dashboardEnabled = true, supportInvite = () => SUPPORT,
    leaderboard = async () => ({ enabled: true, rows: [] }), status = () => ({ state: 'online', uptimeMs: 3_600_000 }), cat,
} = {}) {
    const app = express();
    app.get('/health', (req, res) => res.status(200).json({ status: 'healthy' }));
    app.get('/ready', (req, res) => res.status(503).json({ ready: false }));
    app.use(createSite({ client: { commands }, env: { CLIENT_ID, ...env }, dashboardEnabled, supportInvite, leaderboard, status, cat }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
        const res = await fetch(base + path, { redirect: 'manual' });
        return { status: res.status, headers: res.headers, body: await res.text() };
    };
    return { get, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('PUBLIC_SITE_ENABLED is off unless true', () => {
    assert.equal(publicSiteEnabled({}), false);
    assert.equal(publicSiteEnabled({ PUBLIC_SITE_ENABLED: 'false' }), false);
    assert.equal(publicSiteEnabled({ PUBLIC_SITE_ENABLED: 'true' }), true);
});

test('every front page renders with the shell, the hashed stylesheet and script, no inline style or script', async () => {
    const site = await serve();
    try {
        for (const [path, heading] of [
            ['/', 'A Discord bot for moderation and appeals'], ['/commands', 'Commands'], ['/about', 'About Mewvo'], ['/changelog', 'Changelog'],
            ['/leaderboard', 'Leaderboard'], ['/status', 'Status'], ['/privacy', 'Privacy Policy'], ['/terms', 'Terms and Conditions'],
            ['/features', 'Features'], ['/pricing', 'Plans and prices'], ['/faq', 'Questions and answers'],
            ['/docs', 'Guides'], ['/docs/getting-started', 'Getting started for staff'], ['/docs/warnings', 'How warnings and bans escalate'],
            ['/docs/appeals', 'Appeals: how they work'], ['/docs/using-the-dashboard', 'Using the dashboard'],
        ]) {
            const res = await site.get(path);
            assert.equal(res.status, 200, path);
            assert.match(res.headers.get('content-type'), /text\/html/);
            assert.ok(res.body.startsWith('<!doctype html>'), path);
            assert.ok(res.body.includes(`<h1>${heading}</h1>`), path);
            assert.ok(res.body.includes(`<link rel="stylesheet" href="${CSS_PATH}">`), path);
            assert.match(CSS_PATH, /^\/site\.css\?v=[0-9a-f]{10}$/);
            for (const landmark of ['<header', '<nav class="topnav" aria-label="Main">', '<main id="main"', '<footer', 'class="skip" href="#main"']) {
                assert.ok(res.body.includes(landmark), `${path}: ${landmark}`);
            }
            assert.deepEqual(res.body.match(/<script[^>]*>[\s\S]*?<\/script>/gi), [`<script src="${JS_PATH}" defer></script>`], `${path}: only the static script`);
            assert.ok(!/\son[a-z]+=/i.test(res.body), `${path}: no inline handlers`);
            assert.ok(!/\sstyle=/i.test(res.body) && !/<style/i.test(res.body), `${path}: no inline styles`);
            assert.ok(res.body.includes(`href="${SUPPORT}"`), `${path}: support link`);
            assert.ok(res.body.includes('<a class="button" href="/dashboard">Dashboard</a>'), `${path}: filled Dashboard button in the top bar`);
            assert.ok(res.body.includes('<li><a href="/dashboard">Dashboard</a></li>'), `${path}: footer link`);
            assert.ok(res.body.includes('<link rel="icon" href="/favicon.png" type="image/png" sizes="64x64">'), `${path}: favicon`);
            assert.match(res.body, /<img class="logo" src="\/img\/logo\.png\?v=[0-9a-f]{10}" width="28" height="28" alt="">/, `${path}: the owner's logo`);
        }
        const notFound = await site.get('/nope');
        assert.equal(notFound.status, 404);
        assert.ok(notFound.body.includes('Page not found'));
    } finally { await site.close(); }
});

test('the stylesheet is the site\'s own: its tokens, light and dark, no dashboard layout, nothing remote', async () => {
    const site = await serve();
    try {
        const res = await site.get(CSS_PATH);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/css/);
        assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'the hashed URL never changes');
        assert.equal((await site.get('/site.css?v=0000000000')).headers.get('cache-control'), 'public, max-age=3600', 'an old hash: an hour');
        assert.equal((await site.get('/site.css')).headers.get('cache-control'), 'public, max-age=3600', 'no hash: an hour');
        assert.equal(res.body, STYLESHEET);
        const file = readFileSync(new URL('../src/services/site/static/site.css', import.meta.url), 'utf8');
        assert.equal(STYLESHEET, file);
        for (const selector of [':root {', '@media (prefers-color-scheme: dark)', '.topbar', '.plans', '.mock']) assert.ok(STYLESHEET.includes(selector), selector);
        assert.ok(!STYLESHEET.includes('.side-nav'), 'not the dashboard layout');
        assert.ok(!/@import|url\(|@font-face/i.test(STYLESHEET), 'no imports, remote files or web fonts');
        assert.ok(!/gradient\(|backdrop-filter|filter:\s*blur/i.test(STYLESHEET), 'no gradients, glass or blur');
    } finally { await site.close(); }
});

test('the script is the site\'s own static file: versioned, JavaScript, cached, small, no network or storage', async () => {
    const site = await serve();
    try {
        assert.match(JS_PATH, /^\/site\.js\?v=[0-9a-f]{10}$/);
        const res = await site.get(JS_PATH);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /^text\/javascript/);
        assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        assert.equal((await site.get('/site.js?v=0000000000')).headers.get('cache-control'), 'public, max-age=3600');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy']);
        assert.equal(res.body, SCRIPT);
        assert.equal(SCRIPT, readFileSync(new URL('../src/services/site/static/site.js', import.meta.url), 'utf8'));
        // 4 KB since the command explorer's live filter (2026-11-09); 2 KB with the menus alone.
        assert.ok(Buffer.byteLength(SCRIPT) < 4096, 'under 4 KB');
        assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|localStorage|sessionStorage|indexedDB|document\.cookie|import\(|eval\(|new Function|innerHTML/.test(SCRIPT), 'no network, storage, eval or HTML injection');
        for (const selector of ['details.lang-menu', 'details.account-menu', '.topnav a[aria-current="page"]', '.table-wrap', '[data-cmd-explorer]']) assert.ok(SCRIPT.includes(selector), selector);
        assert.ok(STYLESHEET.includes('.table-wrap.can-scroll'), 'the scroll hint class has a style');
        const prefixed = await site.get('/de/site.js');
        assert.equal(prefixed.status, 404, 'only pages exist under a language prefix');
    } finally { await site.close(); }
});

test('the site CSP is pinned: only script-src changed from none to self', () => {
    assert.equal(SECURITY_HEADERS['Content-Security-Policy'],
        "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
});

test('CSP and security headers: no unsafe-inline, scripts only from self, no framing', async () => {
    const site = await serve();
    try {
        for (const path of ['/', '/features', '/pricing', '/faq', '/docs', '/docs/appeals', '/commands', '/about', '/leaderboard', '/status', '/privacy', '/terms', '/robots.txt', '/img/og.png', CSS_PATH, JS_PATH, '/nope']) {
            const res = await site.get(path);
            const csp = res.headers.get('content-security-policy');
            // The command explorer's filter form: form-action 'self' there only (pages/commands.js).
            assert.equal(csp, path === '/commands' ? COMMANDS_CSP : SECURITY_HEADERS['Content-Security-Policy'], path);
            assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), path);
            assert.match(csp, /default-src 'none'/);
            assert.match(csp, /script-src 'self';/);
            assert.match(csp, /style-src 'self'/);
            assert.match(csp, /frame-ancestors 'none'/);
            assert.equal(res.headers.get('x-frame-options'), 'DENY');
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        }
    } finally { await site.close(); }
});

test('while not public: noindex everywhere, robots.txt disallows all, no add button', async () => {
    const site = await serve();
    try {
        for (const path of ['/', '/features', '/pricing', '/faq', '/docs', '/docs/warnings', '/commands', '/about', '/leaderboard', '/status', '/privacy', '/terms', '/nope']) {
            const res = await site.get(path);
            assert.equal(res.headers.get('x-robots-tag'), NOINDEX, path);
            assert.ok(res.body.includes(`<meta name="robots" content="${NOINDEX}">`), path);
            assert.ok(!res.body.includes('data-add-bot'), `${path}: no add button`);
            assert.ok(!res.body.includes('oauth2/authorize'), `${path}: no install URL`);
            assert.ok(!res.body.includes('Add to Discord'), path);
        }
        const robots = await site.get('/robots.txt');
        assert.equal(robots.status, 200);
        assert.match(robots.headers.get('content-type'), /text\/plain/);
        assert.equal(robots.body, 'User-agent: *\nDisallow: /\n');
        assert.equal(robots.headers.get('x-robots-tag'), NOINDEX);
    } finally { await site.close(); }
});

test('when public: the add button links to the install URL for CLIENT_ID; pages are indexable', async () => {
    const site = await serve({ env: { PUBLIC_SITE_ENABLED: 'true' } });
    try {
        const home = await site.get('/');
        assert.equal(home.headers.get('x-robots-tag'), null);
        assert.ok(!home.body.includes('name="robots"'));
        const href = home.body.match(/<a class="button" href="([^"]+)" rel="noopener" data-add-bot>Add to Discord<\/a>/);
        assert.ok(href, 'add button present');
        const url = new URL(href[1].replace(/&amp;/g, '&'));
        assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
        assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
        assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
        assert.equal(url.searchParams.get('permissions'), installPermissionBits().toString());
        const robots = await site.get('/robots.txt');
        assert.ok(!robots.body.includes('Disallow: /\n'));
        assert.ok(robots.body.includes('Disallow: /dashboard'));
    } finally { await site.close(); }
    // Public but without a valid CLIENT_ID: no broken button.
    const bad = await serve({ env: { PUBLIC_SITE_ENABLED: 'true', CLIENT_ID: 'nope' } });
    try { assert.ok(!(await bad.get('/')).body.includes('data-add-bot')); } finally { await bad.close(); }
});

test('install permissions: what the bot uses, never Administrator', () => {
    const bits = installPermissionBits();
    assert.equal(bits & PermissionFlagsBits.Administrator, 0n);
    for (const name of INSTALL_PERMISSIONS) assert.ok(PermissionFlagsBits[name], name);
    for (const name of ['BanMembers', 'KickMembers', 'ManageRoles', 'ManageChannels', 'ModerateMembers', 'CreateInstantInvite']) {
        assert.notEqual(bits & PermissionFlagsBits[name], 0n, name);
    }
    assert.equal(installUrl(''), null);
    assert.equal(installUrl('12"><script>'), null);
});

test('invite links: only Discord invites, the main-server link only when MAIN_SERVER_INVITE is set', async () => {
    assert.equal(inviteOrNull(SUPPORT), SUPPORT);
    assert.equal(inviteOrNull('javascript:alert(1)'), null);
    assert.equal(inviteOrNull('https://evil.example/x'), null);
    const without = await serve({ supportInvite: () => '' });
    try {
        const body = (await without.get('/')).body;
        assert.ok(!body.includes('Our server'));
        assert.ok(!body.includes('Support server</a>'));
    } finally { await without.close(); }
    const withMain = await serve({ env: { MAIN_SERVER_INVITE: MAIN } });
    try {
        const body = (await withMain.get('/about')).body;
        assert.ok(body.includes(`<a href="${MAIN}" rel="noopener">Our server</a>`));
    } finally { await withMain.close(); }
    const brokenGetter = await serve({ supportInvite: () => { throw new Error('settings not loaded'); } });
    try { assert.equal((await brokenGetter.get('/')).status, 200); } finally { await brokenGetter.close(); }
});

test('the home page links to the dashboard from the hero', async () => {
    const site = await serve();
    try {
        const body = (await site.get('/')).body;
        // At most two buttons in the hero; the dashboard is a plain text link under them.
        assert.match(body, /<p class="hero-actions">(?:(?!<\/p>).)*<\/p><p class="hero-more">[^<]*<a href="\/dashboard">Open the dashboard<\/a><\/p>/s);
        const actions = /<p class="hero-actions">((?:(?!<\/p>).)*)<\/p>/s.exec(body)[1];
        assert.ok((actions.match(/class="button/g) || []).length <= 2, 'at most two hero buttons');
    } finally { await site.close(); }
});

test('with the add button shown, Dashboard is the quiet button', async () => {
    const site = await serve({ env: { PUBLIC_SITE_ENABLED: 'true' } });
    try {
        const body = (await site.get('/')).body;
        assert.ok(body.includes('<a class="button button-quiet topbar-more" href="/dashboard">Dashboard</a>'));
        assert.ok(body.includes('data-add-bot>Add to Discord</a>'));
    } finally { await site.close(); }
});

test('the favicon and the logo are the owner\'s PNG (also at /favicon.ico), cached, under the site CSP', async () => {
    const site = await serve();
    try {
        const logo = readFileSync(new URL('../src/services/site/static/img/logo.png', import.meta.url));
        for (const path of ['/favicon.png', '/favicon.ico', '/img/logo.png']) {
            const res = await fetch(site.base + path);
            assert.equal(res.status, 200, path);
            assert.match(res.headers.get('content-type'), /^image\/png/, path);
            assert.equal(res.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy'], path);
            assert.ok(Buffer.from(await res.arrayBuffer()).equals(logo), `${path}: the same file`);
        }
        assert.equal((await site.get('/favicon.png')).headers.get('cache-control'), 'public, max-age=86400');
    } finally { await site.close(); }
});

test('Log in is hidden when the dashboard is not enabled', async () => {
    const site = await serve({ dashboardEnabled: false });
    try { assert.ok(!(await site.get('/')).body.includes('/dashboard')); } finally { await site.close(); }
});

test('commands page: every command grouped (admin ones too, with their tag), descriptions escaped', async () => {
    const site = await serve();
    try {
        const body = (await site.get('/commands')).body;
        assert.ok(body.includes('<code>/ping</code>'));
        assert.ok(body.includes('Checks the bot’s latency &lt;b&gt;'), 'description escaped');
        assert.ok(!body.includes('latency <b>'));
        assert.ok(body.includes('<code>/todo share view</code>'));
        assert.ok(body.includes('<code>/birthday set</code>'));
        assert.ok(body.includes('<code>/birthday setchannel</code>') && body.includes('id="birthday-setchannel"'), 'admin subcommand listed');
        assert.ok(body.includes('<code>/purge</code>') && body.includes('ADMIN PURGE'), 'admin command listed');
        assert.ok(body.includes('<code>Report message</code>'), 'context menu without a slash');
        assert.ok(body.includes('Ticket staff'), 'narrowed access noted');
        assert.ok(body.indexOf('id="h-core">General') < body.indexOf('id="h-utility">Utility'), 'groups in order');
        assert.ok(body.indexOf('id="h-ticket">') < body.indexOf('id="h-moderation">'), 'staff groups after the member groups');
    } finally { await site.close(); }
});

test('commands page before the commands load: a loading note, no form, no cards', async () => {
    const site = await serve({ commands: new Map() });
    try {
        const body = (await site.get('/commands')).body;
        assert.ok(body.includes('The command list is loading.'));
        assert.ok(!body.includes('<form') && !body.includes('cmd-card'));
        const redirect = await site.get('/commands/case');
        assert.equal(redirect.status, 302);
        assert.equal(redirect.headers.get('location'), '/commands');
    } finally { await site.close(); }
});

test('pages escape values from settings (support invite is validated, never raw)', async () => {
    const site = await serve({ supportInvite: () => 'https://discord.gg/x"><script>alert(1)</script>' });
    try {
        const body = (await site.get('/')).body;
        assert.ok(!body.includes('<script>'));
        assert.ok(!body.includes('Support server</a>'));
    } finally { await site.close(); }
});

test('health and ready stay JSON and are not shadowed by the site', async () => {
    const site = await serve();
    try {
        const health = await site.get('/health');
        assert.equal(health.status, 200);
        assert.deepEqual(JSON.parse(health.body), { status: 'healthy' });
        const ready = await site.get('/ready');
        assert.equal(ready.status, 503);
        assert.deepEqual(JSON.parse(ready.body), { ready: false });
    } finally { await site.close(); }
    // app.js: the real /health and /ready handlers are registered before the site, unchanged.
    const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
    const health = app.indexOf("app.get('/health'");
    const ready = app.indexOf("app.get('/ready'");
    const site2 = app.indexOf('registerSite(app');
    assert.ok(health > 0 && ready > health && site2 > ready, 'order: /health, /ready, then the site');
    assert.ok(app.includes("status: 'healthy',") && app.includes('createReadyHandler(this'));
    assert.ok(!app.includes('Mewvo System Online'), 'the old JSON root is gone');
});

// ── Leaderboard, status, privacy, terms ──────────────────────────────────

const row = (rank, name, level = 5, totalXp = 1234) => ({ rank, name, level, totalXp });
const fullPage = (from, count) => Array.from({ length: count }, (_, i) => row(from + i, `Member ${from + i}`));

test('leaderboard: rank, escaped display name, level and total XP; nav marks it current', async () => {
    const calls = [];
    const site = await serve({
        leaderboard: async (args) => { calls.push(args); return { enabled: true, rows: [row(1, '<img src=x onerror=alert(1)>', 12, 98765), row(2, 'Ann & "Bob"', 3, 40)] }; },
    });
    try {
        const res = await site.get('/leaderboard');
        assert.equal(res.status, 200);
        assert.deepEqual(calls, [{ offset: 0, limit: LEADERBOARD_PAGE_SIZE + 1 }]);
        assert.ok(!res.body.includes('<img src=x') && res.body.includes('&lt;img src=x onerror=alert(1)&gt;'), 'name escaped');
        assert.ok(res.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(res.body.includes('Ann &amp; &quot;Bob&quot;'));
        assert.ok(res.body.includes('<td class="num">1</td><td class="board-name">'));
        assert.ok(res.body.includes('<td class="num">12</td><td class="num">98,765</td>'), 'level and total XP');
        assert.ok(res.body.includes('<li><a href="/leaderboard" aria-current="page">Leaderboard</a></li>'));
        assert.ok(!res.body.includes('class="pager"'), 'one page: no pager');
        assert.ok(!/<script|\sstyle=|<style/i.test(res.body.replace(`<script src="${JS_PATH}" defer></script>`, '')));
    } finally { await site.close(); }
});

test('leaderboard: 50 a page, ?page= reads the right offset, Previous/Next links', async () => {
    const site = await serve({
        // A full page plus one row means there is a next page.
        leaderboard: async ({ offset, limit }) => ({ enabled: true, rows: offset < 100 ? fullPage(offset + 1, limit) : fullPage(offset + 1, 3) }),
    });
    try {
        const first = await site.get('/leaderboard');
        assert.equal((first.body.match(/<tr><td class="num">/g) || []).length, LEADERBOARD_PAGE_SIZE, 'only 50 rows shown');
        assert.ok(first.body.includes('<a class="button button-quiet" href="/leaderboard?page=2" rel="next">Next</a>'));
        assert.ok(!first.body.includes('rel="prev"'));
        const second = await site.get('/leaderboard?page=2');
        assert.ok(second.body.includes('<td class="num">51</td>'));
        assert.ok(second.body.includes('href="/leaderboard" rel="prev">Previous</a>'), 'page 1 link has no ?page=');
        assert.ok(second.body.includes('href="/leaderboard?page=3" rel="next"'));
        assert.ok(second.body.includes('<title>Leaderboard, page 2 · Mewvo</title>'));
        const last = await site.get('/leaderboard?page=3');
        assert.ok(last.body.includes('href="/leaderboard?page=2" rel="prev"'));
        assert.ok(!last.body.includes('rel="next"'), 'last page: no Next');
    } finally { await site.close(); }
    // getLeaderboard serves offsets up to 490: page 10 (offset 450) is the last one with rows.
    const deep = await serve({ leaderboard: async ({ offset, limit }) => ({ enabled: true, rows: fullPage(offset + 1, limit) }) });
    try {
        assert.ok((await deep.get('/leaderboard?page=9')).body.includes('href="/leaderboard?page=10" rel="next"'));
        assert.ok(!(await deep.get('/leaderboard?page=10')).body.includes('rel="next"'), 'no Next to an always-empty page 11');
    } finally { await deep.close(); }
    assert.equal(leaderboardPageNumber(undefined), 1);
    assert.equal(leaderboardPageNumber('0'), 1);
    assert.equal(leaderboardPageNumber('-2'), 1);
    assert.equal(leaderboardPageNumber('2abc'), 1);
    assert.equal(leaderboardPageNumber(['4', '5']), 4);
    assert.equal(leaderboardPageNumber('99999'), 1);
    assert.equal(leaderboardPageNumber('9999'), 1000);
});

test('leaderboard: an empty page past the end says so and links back', async () => {
    const site = await serve({ leaderboard: async () => ({ enabled: true, rows: [] }) });
    try {
        const first = await site.get('/leaderboard');
        assert.equal(first.status, 200);
        assert.ok(first.body.includes('Nobody has earned XP yet.'));
        const later = await site.get('/leaderboard?page=7');
        assert.ok(later.body.includes('There is nobody on this page.'));
        assert.ok(later.body.includes('href="/leaderboard">Back to the first page</a>'));
    } finally { await site.close(); }
});

test('leaderboard: a failed read is a 503 "could not be loaded", never an empty board', async () => {
    const site = await serve({ leaderboard: async () => { throw new Error('database not responding'); } });
    try {
        const res = await site.get('/leaderboard');
        assert.equal(res.status, 503);
        assert.ok(res.body.includes('could not be loaded'));
        assert.ok(!res.body.includes('Nobody has earned XP yet.'));
        assert.ok(!res.body.includes('database not responding'), 'no internal error text in the page');
        assert.equal(res.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy']);
    } finally { await site.close(); }
});

test('leaderboard: leveling turned off says so', async () => {
    const site = await serve({ leaderboard: async () => ({ enabled: false, rows: [] }) });
    try {
        const res = await site.get('/leaderboard');
        assert.equal(res.status, 200);
        assert.ok(res.body.includes('Leveling is turned off on Mewvo’s community server'));
        assert.ok(!res.body.includes('<table'));
    } finally { await site.close(); }
});

/** A client shaped like the real one, enough for getLevelingConfig and getLeaderboard. */
function fakeClient({ ready = true, enabled = true, levels = [], members = {}, failRows = false, memberCount } = {}) {
    const memberCache = new Map(Object.entries(members).map(([id, displayName]) => [id, { displayName, user: { username: displayName } }]));
    let fetches = 0;
    const guild = { id: '111111111111111111', memberCount, members: { cache: memberCache, fetch: async () => { fetches += 1; return memberCache; } } };
    let reads = 0;
    return {
        reads: () => reads,
        fetches: () => fetches,
        isReady: () => ready,
        guilds: { cache: new Map([[guild.id, guild]]) },
        users: { cache: new Map() },
        db: {
            get: async () => ({ leveling: { enabled } }),
            rows: () => ({
                topUserLevels: async (guildId, limit, offset) => {
                    reads += 1;
                    if (failRows) throw new Error('pg down');
                    return levels.slice(offset, offset + limit);
                },
            }),
        },
    };
}

test('the real reader: main server only, display names, former members without IDs, cached a minute', async () => {
    const levels = [
        { userId: '222222222222222222', xp: 10, level: 4, totalXp: 900 },
        { userId: '333333333333333333', xp: 5, level: 2, totalXp: 300 },
    ];
    const client = fakeClient({ levels, members: { '222222222222222222': 'Kitty <3' } });
    let clock = 0;
    const read = createLeaderboardReader(client, { guildId: () => '111111111111111111', now: () => clock });
    const board = await read({ offset: 0, limit: 51 });
    assert.equal(board.enabled, true);
    assert.deepEqual(board.rows, [
        { rank: 1, name: 'Kitty <3', level: 4, totalXp: 900 },
        { rank: 2, name: null, level: 2, totalXp: 300 },
    ]);
    // The page puts "Former member" (catalog text) where the reader has no name.
    const page = String(leaderboardPage({}, { page: 1, board }));
    assert.ok(page.includes('<td class="board-name">Kitty &lt;3</td>') && page.includes('<td class="board-name">Former member</td>'));
    assert.ok(!page.includes('333333333333333333'), 'never the ID');
    assert.equal(client.fetches(), 0, 'a page view never asks Discord for members (former member stays uncached)');
    await read({ offset: 0, limit: 51 });
    assert.equal(client.reads(), 1, 'second view within a minute is cached');
    clock += 61_000;
    await read({ offset: 0, limit: 51 });
    assert.equal(client.reads(), 2, 'read again after a minute');

    const disabled = createLeaderboardReader(fakeClient({ enabled: false, levels }), { guildId: () => '111111111111111111' });
    assert.deepEqual(await disabled({ offset: 0, limit: 51 }), { enabled: false, rows: [] });
});

test('the real reader: with a complete member cache, former members are not listed', async () => {
    const levels = [
        { userId: '222222222222222222', xp: 10, level: 4, totalXp: 900 },
        { userId: '333333333333333333', xp: 5, level: 2, totalXp: 300 },
        { userId: '444444444444444444', xp: 1, level: 1, totalXp: 100 },
    ];
    const members = { '222222222222222222': 'Kitty', '444444444444444444': 'Mochi' };
    const client = fakeClient({ levels, members, memberCount: 2 });
    const board = await createLeaderboardReader(client, { guildId: () => '111111111111111111' })({ offset: 0, limit: 51 });
    assert.deepEqual(board.rows, [
        { rank: 1, name: 'Kitty', level: 4, totalXp: 900 },
        { rank: 2, name: 'Mochi', level: 1, totalXp: 100 },
    ]);
    assert.equal(client.fetches(), 0);
});

test('the real reader throws (never an empty board) when it cannot read', async () => {
    const id = () => '111111111111111111';
    await assert.rejects(createLeaderboardReader(fakeClient(), { guildId: () => null })({ offset: 0, limit: 51 }), /MAIN_GUILD_ID/);
    await assert.rejects(createLeaderboardReader(fakeClient({ ready: false }), { guildId: id })({ offset: 0, limit: 51 }), /not connected/);
    await assert.rejects(createLeaderboardReader(fakeClient(), { guildId: () => '999999999999999999' })({ offset: 0, limit: 51 }), /not in the cache/);
    const failing = fakeClient({ failRows: true });
    const read = createLeaderboardReader(failing, { guildId: id });
    await assert.rejects(read({ offset: 0, limit: 51 }));
    await assert.rejects(read({ offset: 0, limit: 51 }));
    assert.equal(failing.reads(), 2, 'a failed read is not cached');
});

test('status: Online / Starting / Degraded, 200 always, a Refresh link, shows no counts, IDs or versions', async () => {
    for (const [status, label] of [
        [{ state: 'online', uptimeMs: (2 * 24 + 3) * 3_600_000 }, 'Online'],
        [{ state: 'starting', uptimeMs: null }, 'Starting'],
        [{ state: 'degraded', uptimeMs: 90_000 }, 'Degraded'],
        [() => { throw new Error('boom'); }, 'Degraded'],
    ]) {
        const site = await serve({ status: typeof status === 'function' ? status : () => status });
        try {
            const res = await site.get('/status');
            assert.equal(res.status, 200, label);
            assert.ok(res.body.includes(`<span class="status-dot" aria-hidden="true"></span>${label}</p>`), label);
            assert.ok(!res.body.includes('http-equiv="refresh"'), 'no automatic reload');
            assert.ok(res.body.includes('<a href="/status">Refresh</a>'), 'a Refresh link');
            assert.ok(res.body.includes('<li><a href="/status" aria-current="page">Status</a></li>'));
            const main = res.body.slice(res.body.indexOf('<main'), res.body.indexOf('</main>'));
            assert.ok(!/\d{17,20}/.test(main), 'no IDs');
            assert.ok(!/schema|guild|memory|heap|version/i.test(main), 'no internals');
            // The only digits on the page body are the uptime ("2 days, 3 hours").
            const text = main.replace(/<[^>]+>/g, '').replace(/Up for [^.]*\./, '');
            assert.ok(!/\d/.test(text), `${label}: no numbers besides the uptime`);
            assert.ok(!/<script|\sstyle=|<style/i.test(res.body.replace(`<script src="${JS_PATH}" defer></script>`, '')));
        } finally { await site.close(); }
    }
    const online = await serve({ status: () => ({ state: 'online', uptimeMs: (2 * 24 + 3) * 3_600_000 }) });
    try { assert.ok((await online.get('/status')).body.includes('Up for 2 days, 3 hours.')); } finally { await online.close(); }
});

test('botStatus decides like /ready and returns only the state and uptime', () => {
    assert.deepEqual(botStatus(null), { state: 'starting', uptimeMs: null });
    assert.deepEqual(botStatus({ isReady: () => false, uptime: null }), { state: 'starting', uptimeMs: null });
    const ready = (db) => ({ isReady: () => true, uptime: 5000, db, guilds: { cache: new Map([['x', {}]]) } });
    assert.deepEqual(botStatus(ready({ getStatus: () => ({ isDegraded: false, connectionType: 'postgresql' }) })), { state: 'online', uptimeMs: 5000 });
    assert.deepEqual(botStatus(ready({ getStatus: () => ({ isDegraded: true, connectionType: 'none' }) })), { state: 'degraded', uptimeMs: 5000 });
    assert.equal(botStatus(ready(undefined)).state, 'degraded', 'no database status is not "online"');
    assert.deepEqual(Object.keys(botStatus(ready({ getStatus: () => ({ isDegraded: false }) }))).sort(), ['state', 'uptimeMs']);
    assert.equal(uptimeWords(0), 'less than a minute');
    assert.equal(uptimeWords(59_000), 'less than a minute');
    assert.equal(uptimeWords(60_000), '1 minute');
    assert.equal(uptimeWords(3_600_000 + 120_000), '1 hour, 2 minutes');
    assert.equal(uptimeWords(24 * 3_600_000 + 5 * 60_000), '1 day');
    assert.equal(uptimeWords(3 * 24 * 3_600_000 + 4 * 3_600_000 + 7 * 60_000), '3 days, 4 hours');
});

test('privacy and terms: dated, linked from the footer, contact via the support server', async () => {
    const site = await serve();
    try {
        for (const path of ['/privacy', '/terms']) {
            const res = await site.get(path);
            assert.equal(res.status, 200);
            assert.ok(res.body.includes('Last updated <time datetime="2026-11-09">9 November 2026</time>.'), path);
            assert.ok(res.body.includes(`<a href="${SUPPORT}" rel="noopener">the support server</a>`), path);
        }
        const privacy = (await site.get('/privacy')).body;
        for (const fact of ['AES-256-GCM', '60 days', '90 days', '<code>/wipedata</code>', 'never sold', 'PostgreSQL', 'never asks for your email', 'scrypt', 'No email address', 'not saved', 'Art. 6(1)(f)', 'data protection authority', 'Automatic decisions', 'Cookies', 'at least 13', 'at least 14']) {
            assert.ok(privacy.includes(fact), fact);
        }
        assert.ok(privacy.includes('does not delete moderation records'));
        // Levels are kept after leaving (no "server resets levels" feature exists); how to delete them.
        assert.ok(!privacy.includes('resets levels'));
        assert.ok(privacy.includes('if you have left and want them deleted'));
        assert.ok(privacy.includes('or rejoin and run /wipedata'));
        // Accounts have no email (schema v8): no email provider, no email links.
        assert.ok(!privacy.includes('Resend') && !privacy.includes('Email links'));
        const terms = (await site.get('/terms')).body;
        assert.ok(terms.includes('No payments are taken yet') && terms.includes('Liability') && terms.includes('href="/privacy"'));
        // Footer: status and legal links on every page; Leaderboard also in the top nav.
        const home = (await site.get('/')).body;
        const footer = home.slice(home.indexOf('<footer'));
        for (const link of ['<a href="/status">Status</a>', '<a href="/privacy">Privacy Policy</a>', '<a href="/terms">Terms and Conditions</a>', '<a href="/leaderboard">Leaderboard</a>']) {
            assert.ok(footer.includes(link), link);
        }
        const topnav = home.slice(home.indexOf('<nav class="topnav"'), home.indexOf('</nav>'));
        assert.ok(topnav.includes('<a href="/leaderboard">Leaderboard</a>'));
        assert.ok(!topnav.includes('/privacy') && !topnav.includes('/status'), 'legal and status links only in the footer');
    } finally { await site.close(); }
    const noInvite = await serve({ supportInvite: () => null });
    try { assert.ok((await noInvite.get('/privacy')).body.includes('the staff team on the Mewvo server')); } finally { await noInvite.close(); }
});

// ── Redesign: new pages, pricing, share tags, sitemap, images ────────────

test('top bar: Features, Pricing, Docs, Commands, Leaderboard; footer: brand line and link columns', async () => {
    const site = await serve();
    try {
        const body = (await site.get('/features')).body;
        const topnav = body.slice(body.indexOf('<nav class="topnav"'), body.indexOf('</nav>'));
        const order = ['/features', '/pricing', '/docs', '/commands', '/leaderboard'].map((p) => topnav.indexOf(`<a href="${p}"`));
        assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `nav order ${order}`);
        assert.ok(topnav.includes('<a href="/features" aria-current="page">Features</a>'));
        const footer = body.slice(body.indexOf('<footer'));
        assert.ok(footer.includes('<ul class="footer-links">'));
        for (const title of ['Product', 'Help', 'Community', 'Legal']) assert.ok(footer.includes(`<p class="footer-title">${title}</p>`), title);
        assert.ok(footer.includes('<a href="/faq">FAQ</a>') && footer.includes('<a href="/about">About</a>'));
    } finally { await site.close(); }
});

test('pricing: plan cards side by side with both prices, "Coming soon" never a link, no switch or tick marks', async () => {
    const site = await serve();
    try {
        const body = (await site.get('/pricing')).body;
        const main = body.slice(body.indexOf('<main'), body.indexOf('</main>'));
        // English pays in US dollars (since 2026-11-05; the numbers are the same as in euros).
        for (const price of ['$0', '$1.99', '$4.99', '$9.99', '$19.90', '$49.90', '$99.90']) assert.ok(main.includes(price), price);
        assert.ok(!main.includes('€') && !main.includes('≈'), 'no euros and no approximations in English');
        assert.ok(main.includes('Prices in US dollars.'));
        assert.ok(main.includes('2 months free'));
        assert.ok(main.includes('<ul class="plan-cards">'));
        assert.equal((main.match(/<li class="plan-card[ "]/g) || []).length, 4, 'one card per plan in plans.js');
        assert.equal((main.match(/<li class="plan-card is-featured">/g) || []).length, 1, 'the featured plan stands out');
        assert.ok(!main.includes('billing-input') && !main.includes('plans-table'), 'no monthly/yearly switch, no plans table');
        assert.ok(!/[✓✔]/.test(main), 'no tick marks');
        assert.equal((main.match(/<span class="button button-disabled" aria-disabled="true">Coming soon<\/span>/g) || []).length, 3, 'one per paid plan');
        assert.ok(!/<a[^>]*>Coming soon/.test(main), 'Coming soon is not a link');
        assert.ok(!/<form|<button|checkout|stripe|paypal/i.test(main), 'nothing to buy');
        assert.ok(main.includes('Paid plans start when Mewvo opens to other servers'));
        assert.ok(main.includes(`<a href="${SUPPORT}" rel="noopener">Join the support server</a> to hear first.`));
        assert.ok(main.includes('<span class="planned">(planned)</span>'));
        assert.ok(main.includes('<table class="compare">'));
    } finally { await site.close(); }
});

test('pricing: per-currency price table and formatPrice (EUR stays the default currency)', async () => {
    const plans = await import('../src/config/site/plans.js');
    for (const plan of plans.PLANS) {
        assert.deepEqual(Object.keys(plan.prices).sort(), ['EUR', 'USD'], plan.id);
        assert.equal(plan.prices.EUR, plan.monthlyCents, `${plan.id}: monthlyCents must equal the EUR price`);
        assert.equal(plans.monthlyCentsIn(plan, 'USD'), plan.prices.USD);
    }
    assert.equal(plans.CURRENCY, 'EUR');
    assert.equal(plans.formatPrice(199), '€1.99');
    assert.equal(plans.formatPrice(199, 'USD'), '$1.99');
    assert.equal(plans.formatPrice(1990, 'EUR'), plans.euros(1990));
    assert.equal(plans.formatPrice(0, 'USD'), '$0.00');
    assert.throws(() => plans.formatPrice(199, 'GBP'), /Unknown currency/);
});

test('pricing: names and prices come from config/site/plans.js, the words from the plans catalog', async () => {
    const plans = await import('../src/config/site/plans.js');
    const { t } = (await import('../src/services/site/i18n.js')).translator('en');
    assert.deepEqual(plans.PLANS.map((p) => [p.name, p.monthlyCents]), [['Free', 0], ['Normal', 199], ['Pro', 499], ['Max', 999]]);
    assert.deepEqual(plans.PLANS.slice(1).map((p) => plans.euros(plans.yearlyCents(p))), ['€19.90', '€49.90', '€99.90']);
    assert.deepEqual(plans.PLANS.slice(1).map((p) => plans.euros(plans.yearlyPerMonthCents(p))), ['€1.66', '€4.16', '€8.33']);
    const source = readFileSync(new URL('../src/config/site/plans.js', import.meta.url), 'utf8');
    assert.match(source.slice(0, 400), /DRAFT FOR THE OWNER TO EDIT/);
    const pro = plans.PLANS.find((p) => p.id === 'pro');
    const saved = { name: pro.name, monthlyCents: pro.monthlyCents, prices: pro.prices };
    pro.name = 'Pro <Test>';
    pro.monthlyCents = 777;
    pro.prices = { EUR: 777, USD: 777 };
    const site = await serve();
    try {
        const body = (await site.get('/pricing')).body;
        assert.ok(body.includes('Pro &lt;Test&gt;'), 'name from plans.js, escaped');
        assert.ok(body.includes('$7.77') && body.includes('$77.70'), 'prices from plans.js (English: USD)');
        for (const plan of plans.PLANS) assert.ok(body.includes(t(`plans.${plan.id}.summary`)), plan.id);
        for (const group of plans.COMPARISON) for (const row of group.rows) assert.ok(body.includes(t(`plans.comparison.${group.key}.rows.${row.key}`)), row.key);
        for (const key of plans.PRICING_FAQ) assert.ok(body.includes(t(`plans.faq.${key}.q`).replace(/'/g, '&#39;')), key);
    } finally {
        Object.assign(pro, saved);
        await site.close();
    }
});

test('home: a real DM preview, dashboard, ladder, what it does as cards, the plans as compact cards', async () => {
    const site = await serve();
    try {
        const body = (await site.get('/')).body;
        let last = 0;
        for (const id of ['dashboard', 'ladder', 'enforcement', 'appeals', 'automod', 'tickets', 'logging', 'community']) {
            const at = body.indexOf(`id="${id}"`);
            assert.ok(at > last, `item ${id} in order`);
            last = at;
        }
        assert.ok(body.includes('Warning 2 of 3 in Mewvo') && body.includes('At 3 warnings you will be banned.'), 'warnDm wording');
        assert.ok(body.includes(`<span class="dc-link">${SUPPORT}</span>`), 'the real support invite in the DM preview');
        assert.ok(body.includes('$1.99') && body.includes('href="/pricing"'));
        assert.ok(body.includes('<ul class="plan-cards plan-cards-compact">') && !body.includes('plan-card-perks'), 'compact plan cards, perks on /pricing only');
        for (const href of ['/docs/warnings', '/docs/appeals', '/docs/using-the-dashboard', '/features#f-automod']) assert.ok(body.includes(`href="${href}"`), href);
        // No template furniture: numbered eyebrows, tick lists, a CTA band, made-up handles.
        for (const sign of ['section-num', 'section-index', 'class="ticks"', 'class="cta"', 'kicker', 'eyebrow', 'mira', 'pixelfox', '—']) {
            assert.ok(!body.includes(sign), sign);
        }
        for (const word of ['Supercharge', 'Unleash', 'Elevate', 'Seamless', 'Next-level', 'Revolutioni', 'Empower', 'trusted by']) {
            assert.ok(!body.toLowerCase().includes(word.toLowerCase()), word);
        }
    } finally { await site.close(); }
});

test('every image has alt text and a size; the image files are small and served under the CSP', async () => {
    const site = await serve();
    try {
        for (const path of ['/', '/docs/using-the-dashboard']) {
            const body = (await site.get(path)).body;
            const imgs = body.match(/<img [^>]+>/g) || [];
            assert.ok(imgs.length >= 1, path);
            for (const img of imgs) {
                // The logo is decorative (the name "Mewvo" is next to it): empty alt on purpose.
                assert.match(img, /class="logo"[^>]* alt=""|alt="[^"]{30,}"/, img);
                assert.match(img, /width="\d+" height="\d+"/, img);
            }
        }
        const og = await site.get('/img/og.png');
        assert.equal(og.status, 200);
        assert.match(og.headers.get('content-type'), /^image\/png/);
        assert.equal(og.headers.get('cache-control'), 'public, max-age=300', 'replaceable (Owner → Website → Images): 5 minutes');
        assert.equal(og.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy']);
        assert.equal((await site.get('/img/screen-overview-light.webp')).headers.get('content-type'), 'image/webp');
        assert.equal((await site.get('/img/nope.png')).status, 404);
        assert.equal((await site.get('/img/../shell.js')).status, 404);
        const climbed = await site.get('/img/../site.js');
        assert.equal(climbed.body, SCRIPT, 'only the static script, never the router source');
    } finally { await site.close(); }
    const { readdirSync, statSync } = await import('node:fs');
    const dir = new URL('../src/services/site/static/img/', import.meta.url);
    const total = readdirSync(dir).reduce((sum, name) => sum + statSync(new URL(name, dir)).size, 0);
    assert.ok(total < 600 * 1024, `images ${total} bytes`);
});

test('docs: the hub lists four guides; an unknown guide is the 404 page; FAQ answers open without a script', async () => {
    const site = await serve();
    try {
        const hub = (await site.get('/docs')).body;
        for (const slug of ['getting-started', 'warnings', 'appeals', 'using-the-dashboard']) assert.ok(hub.includes(`href="/docs/${slug}"`), slug);
        const warnings = (await site.get('/docs/warnings')).body;
        for (const fact of ['7-day ban', '30-day ban', 'permanent ban', '6 months', 'Lowers the level by one']) assert.ok(warnings.includes(fact), fact);
        assert.equal((await site.get('/docs/nope')).status, 404);
        const faq = (await site.get('/faq')).body;
        assert.ok((faq.match(/<details class="faq"><summary>/g) || []).length >= 8);
        assert.ok(faq.includes('href="/privacy"'));
    } finally { await site.close(); }
});

test('canonical and share tags only with a valid PUBLIC_URL; no hard-coded host anywhere', async () => {
    const without = await serve();
    try {
        for (const path of ['/', '/pricing']) {
            const body = (await without.get(path)).body;
            assert.ok(!body.includes('rel="canonical"') && !body.includes('og:') && !body.includes('twitter:'), path);
        }
    } finally { await without.close(); }
    const bad = await serve({ env: { PUBLIC_URL: 'javascript:alert(1)' } });
    try { assert.ok(!(await bad.get('/')).body.includes('rel="canonical"')); } finally { await bad.close(); }
    const site = await serve({ env: { PUBLIC_URL: 'https://mewvo.example/' } });
    try {
        const body = (await site.get('/pricing')).body;
        assert.ok(body.includes('<link rel="canonical" href="https://mewvo.example/pricing">'));
        assert.ok(body.includes('<meta property="og:image" content="https://mewvo.example/img/og.png">'));
        assert.ok(body.includes('<meta property="og:title" content="Pricing · Mewvo">'));
        assert.ok(body.includes('<meta name="twitter:card" content="summary_large_image">'));
        assert.ok((await site.get('/')).body.includes('<link rel="canonical" href="https://mewvo.example/">'));
        assert.ok((await site.get('/leaderboard?page=2')).body.includes('href="https://mewvo.example/leaderboard?page=2"'));
    } finally { await site.close(); }
    const { readdirSync } = await import('node:fs');
    for (const dir of ['../src/services/site/', '../src/services/site/pages/', '../src/config/site/', '../src/services/site/static/']) {
        for (const name of readdirSync(new URL(dir, import.meta.url)).filter((n) => n.endsWith('.js') || n.endsWith('.css'))) {
            assert.ok(!readFileSync(new URL(dir + name, import.meta.url), 'utf8').includes('replit'), `${dir}${name}: no replit host`);
        }
    }
});

test('sitemap: only when public and PUBLIC_URL is set, and robots.txt points to it', async () => {
    const hidden = await serve({ env: { PUBLIC_URL: 'https://mewvo.example' } });
    try {
        assert.equal((await hidden.get('/sitemap.xml')).status, 404);
        assert.equal((await hidden.get('/robots.txt')).body, 'User-agent: *\nDisallow: /\n');
    } finally { await hidden.close(); }
    const noOrigin = await serve({ env: { PUBLIC_SITE_ENABLED: 'true' } });
    try {
        assert.equal((await noOrigin.get('/sitemap.xml')).status, 404);
        assert.ok(!(await noOrigin.get('/robots.txt')).body.includes('Sitemap:'));
    } finally { await noOrigin.close(); }
    const site = await serve({ env: { PUBLIC_SITE_ENABLED: 'true', PUBLIC_URL: 'https://mewvo.example' } });
    try {
        const map = await site.get('/sitemap.xml');
        assert.equal(map.status, 200);
        assert.match(map.headers.get('content-type'), /application\/xml/);
        for (const path of ['/', '/features', '/pricing', '/docs', '/docs/appeals', '/faq', '/commands', '/leaderboard', '/privacy', '/terms']) {
            assert.ok(map.body.includes(`<loc>https://mewvo.example${path}</loc>`), path);
        }
        assert.ok(!map.body.includes('/dashboard') && !map.body.includes('/me<'));
        const robots = (await site.get('/robots.txt')).body;
        assert.ok(robots.includes('Sitemap: https://mewvo.example/sitemap.xml\n'));
        assert.ok(robots.includes('Disallow: /dashboard'));
    } finally { await site.close(); }
});

test('privacy policy: points to Download my data only when My record is on', async () => {
    const { privacyPage } = await import('../src/services/site/pages/legal.js');
    assert.ok(privacyPage({ memberPortal: true }).includes('<strong>Download my data</strong>'));
    assert.ok(!privacyPage({ memberPortal: false }).includes('Download my data'));
});

// ── Legal pages: privacy matches the code, fairer terms, legal notice, DSA contact ──

const ODR = /ec\.europa\.eu\/consumers\/odr|online dispute resolution platform/i;

test('privacy policy: authority, processors, transfers, lookups, retention, every cookie', async () => {
    const { privacyPage } = await import('../src/services/site/pages/legal.js');
    const page = privacyPage({ legal: {} });
    for (const fact of [
        'Valstybinė duomenų apsaugos inspekcija', 'href="https://vdai.lrv.lt"', 'Art. 77', 'Art. 22(3)',
        'The text of your messages is never stored', 'message IDs and message lengths, never message text', '7 days, error logs 14 days', 'log store',
        'Replit', 'Neon', 'independent controller', 'Data Privacy Framework', 'Standard Contractual Clauses',
        'is.gd', 'OpenStreetMap Nominatim', 'MET Norway', 'api.met.no', 'dictionaryapi.dev', 'dummyimage.com',
        'Staff watchlist', 'Deleted 1 year after the entry ends', 'No-contact orders', 'Deleted 1 year after the order ends',
        'Raid records: 1 year', 'Raid timelines: 90 days', 'Verification history', '1 year.', 'only for Mewvo’s own servers',
        'a person on the staff team decides', 'erase it or remove your name and ID', 'your stored Discord login token', 'at least 14',
    ]) assert.ok(page.includes(fact), fact);
    for (const cookie of ['mewvo_dash', 'mewvo_dash_state', 'mewvo_me', 'mewvo_me_state', 'mewvo_me_next', 'mewvo_me_link', 'mewvo_me_forgot', 'mewvo_me_form', 'mewvo_me_2fa', 'mewvo_me_reset', 'mewvo_theme', 'mewvo_nav']) {
        assert.ok(page.includes(`<code>${cookie}</code>`), cookie);
    }
    assert.ok(page.includes('depending on the region chosen'), 'no DB_REGION_LABEL: the general line');
    assert.ok(!page.includes('If you can’t reach the support server'), 'no email: no email line for banned people');
    const withEnv = privacyPage({ legal: { dbRegion: 'EU (Frankfurt)', email: 'privacy@mewvo.example' } });
    assert.ok(withEnv.includes('The database runs in this region: EU (Frankfurt).'));
    assert.ok(withEnv.includes('because you are banned, email <a href="mailto:privacy@mewvo.example">'));
    assert.ok(!ODR.test(page));
});

test('terms: consumer rights, withdrawal, Lithuanian law, VVTAT, no ODR link, explicit acceptance of changes', async () => {
    const { termsPage } = await import('../src/services/site/pages/legal.js');
    const page = termsPage({ legal: {} });
    for (const fact of [
        'Valstybinė vartotojų teisių apsaugos tarnyba', 'href="https://vvtat.lrv.lt"', 'governed by Lithuanian law', 'courts where you live',
        'href="/withdrawal"', 'within 14 days', 'minus the days you already used',
        'This does not limit your legal rights as a consumer, including if a paid plan does not work as described',
        'except for refunds the law requires', 'at least 18 years old, or with the permission of a parent or guardian', 'at least 14 years old',
        'just continuing to use Mewvo does not count as accepting', 'refund for the time left',
        'Content moderation', 'Server staff decide, not Mewvo', 'bot blocklist', 'Automated tools', 'Human review', 'href="/contact"',
    ]) assert.ok(page.includes(fact), fact);
    assert.ok(!page.includes('If you keep using Mewvo after that'));
    assert.ok(!/lost data or lost profits/.test(page), 'lost data is excluded for the free features only');
    assert.ok(!ODR.test(page));
});

test('legal notice: placeholder without env, every detail with env, VAT line rules, values escaped', async () => {
    const site = await serve();
    try {
        const res = await site.get('/legal');
        assert.equal(res.status, 200);
        assert.ok(res.body.includes('<h1>Legal notice</h1>'));
        assert.ok(res.body.includes('Operator details are being added'));
        assert.ok(!res.body.includes('Not VAT registered'), 'VAT status unknown without an operator');
    } finally { await site.close(); }
    const full = await serve({ env: { LEGAL_OPERATOR: 'Vardenis Pavardenis', LEGAL_EMAIL: 'hello@mewvo.example', LEGAL_ADDRESS: 'Gatvė 1, <b>Vilnius</b>', LEGAL_REG_NO: '123456', LEGAL_VAT_NO: 'LT100000000000' } });
    try {
        const body = (await full.get('/legal')).body;
        for (const fact of ['Vardenis Pavardenis, a private individual', 'Gatvė 1, &lt;b&gt;Vilnius&lt;/b&gt;', '123456', 'LT100000000000', 'href="mailto:hello@mewvo.example"', 'Lithuania']) {
            assert.ok(body.includes(fact), fact);
        }
        assert.ok(!body.includes('Operator details are being added') && !body.includes('<b>Vilnius'));
    } finally { await full.close(); }
    const noVat = await serve({ env: { LEGAL_OPERATOR: 'Vardenis Pavardenis' } });
    try {
        const body = (await noVat.get('/legal')).body;
        assert.ok(body.includes('Not VAT registered'));
        assert.ok(body.includes('Being added'), 'missing address still says so');
    } finally { await noVat.close(); }
});

test('contact page: DSA points of contact, notice contents, life-or-safety line; footer and sitemap list the new pages', async () => {
    const site = await serve({ env: { LEGAL_EMAIL: 'dsa@mewvo.example', PUBLIC_SITE_ENABLED: 'true', PUBLIC_URL: 'https://mewvo.example' } });
    try {
        const res = await site.get('/contact');
        assert.equal(res.status, 200);
        for (const fact of ['Art. 11', 'Art. 12', 'Art. 16', 'Art. 18', 'English or Lithuanian', 'href="mailto:dsa@mewvo.example"',
            'Where it is', 'Why it is illegal', 'Your name and email address', 'child sexual abuse material', 'in good faith', '112', 'read and answered by a person']) {
            assert.ok(res.body.includes(fact), fact);
        }
        const footer = res.body.slice(res.body.indexOf('<footer'));
        for (const link of ['<a href="/privacy">Privacy Policy</a>', '<a href="/terms">Terms and Conditions</a>', '<a href="/legal">Legal notice</a>', '<a href="/contact" aria-current="page">Contact and reports</a>']) {
            assert.ok(footer.includes(link), link);
        }
        const map = (await site.get('/sitemap.xml')).body;
        assert.ok(map.includes('<loc>https://mewvo.example/legal</loc>') && map.includes('<loc>https://mewvo.example/contact</loc>'));
    } finally { await site.close(); }
    const noEmail = await serve();
    try {
        const body = (await noEmail.get('/contact')).body;
        assert.ok(body.includes('An email address for this is being added'));
        assert.ok(body.includes(`<a href="${SUPPORT}" rel="noopener">the support server</a>`));
    } finally { await noEmail.close(); }
});

test('pricing FAQ: plans do not renew, withdrawal is explained, no "cancel any time"', async () => {
    const { PRICING_FAQ } = await import('../src/config/site/plans.js');
    const { t } = (await import('../src/services/site/i18n.js')).translator('en');
    const text = PRICING_FAQ.map((key) => `${t(`plans.faq.${key}.q`)} ${t(`plans.faq.${key}.a`)}`).join(' ');
    assert.ok(!/any time/i.test(text));
    assert.ok(text.includes('don’t renew') && text.includes('within 14 days') && text.includes('Withdrawal page'));
});

test('changelog: newest first, plain text, dated sections; the footer links it', async () => {
    const { CHANGELOG, changelogKey } = await import('../src/config/site/changelog.js');
    const { t } = (await import('../src/services/site/i18n.js')).translator('en');
    const dates = CHANGELOG.map((e) => e.date);
    assert.deepEqual([...dates].sort().reverse(), dates, 'newest first');
    for (const entry of CHANGELOG) {
        assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(entry.items.length);
        for (const key of entry.items) {
            // The text is in the catalog (content/site/en/changelog.json); the config keeps the order.
            const item = t(changelogKey(entry.date, key));
            assert.ok(!/[\u2014\u2013]/.test(item), `no em or en dash: ${item}`);
            assert.ok(!/\p{Extended_Pictographic}/u.test(item), `no emoji: ${item}`);
        }
    }
    const site = await serve();
    try {
        const res = await site.get('/changelog');
        assert.equal(res.status, 200);
        assert.ok(res.body.includes(`<time datetime="${dates[0]}">`));
        assert.ok(res.body.indexOf(dates[0]) < res.body.indexOf(dates[dates.length - 1]));
        assert.ok((await site.get('/')).body.includes('<a href="/changelog">Changelog</a>'));
    } finally {
        await site.close();
    }
});

const CAT = {
    name: 'Mochi <b>', image: 'young-happy.png', stage: { key: 'young', name: 'Young cat' }, mood: 'happy',
    sentence: 'Mochi <b> is happy: the server was busier this week.', total: 4321,
    progress: { fraction: 0.178, toNext: 10679, next: { name: 'Cat' } },
};

test('leaderboard: the server cat above the table (picture, name, stage, mood, progress), escaped, no inline styles', async () => {
    const site = await serve({ cat: async () => CAT, leaderboard: async () => ({ enabled: true, rows: [row(1, 'Ann')] }) });
    try {
        const res = await site.get('/leaderboard');
        assert.equal(res.status, 200);
        assert.ok(res.body.includes('<section class="cat-card" aria-label="The server cat"><img src="/img/cat/young-happy.png" width="128" height="128"'));
        assert.ok(res.body.includes('<h2>Mochi &lt;b&gt;</h2>'), 'name escaped');
        assert.ok(res.body.includes('<p>Young cat. Mochi &lt;b&gt; is happy: the server was busier this week.</p>'), 'stage and mood sentence');
        assert.ok(res.body.includes('<progress class="cat-bar" max="100" value="18"'));
        assert.ok(res.body.includes('4,321 messages counted. 10,679 more to Cat.'));
        assert.ok(res.body.indexOf('cat-card') < res.body.indexOf('<table class="board"'), 'above the table');
        assert.ok(!/<script|\sstyle=|<style/i.test(res.body.replace(`<script src="${JS_PATH}" defer></script>`, '')));
        assert.ok(STYLESHEET.includes('.cat-card'));
    } finally { await site.close(); }
});

test('leaderboard: a failing cat read hides the cat; the leaderboard still shows (200)', async () => {
    const site = await serve({ cat: async () => { throw new Error('db down'); }, leaderboard: async () => ({ enabled: true, rows: [row(1, 'Ann')] }) });
    try {
        const res = await site.get('/leaderboard');
        assert.equal(res.status, 200);
        assert.ok(!res.body.includes('cat-card'));
        assert.ok(res.body.includes('<td class="board-name">Ann</td>'));
    } finally { await site.close(); }
    const sync = await serve({ cat: () => { throw new Error('boom'); } });
    try {
        assert.equal((await sync.get('/leaderboard')).status, 200, 'a reader that throws at once is also hidden');
    } finally { await sync.close(); }
});

test('cat pictures are served from /img/cat/ like the other site images', async () => {
    const site = await serve();
    try {
        const res = await fetch(`${site.base}/img/cat/legend-proud.png`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/png');
    } finally { await site.close(); }
});

test('cat reader: none while the bot is not connected; cached a minute; a failed read is not cached', async () => {
    let t = 0;
    let reads = 0;
    let fail = false;
    const client = { isReady: () => true };
    const reader = createCatReader(client, { guildId: () => '1', now: () => t, read: async () => { reads += 1; if (fail) throw new Error('x'); return CAT; } });
    assert.equal(await createCatReader({ isReady: () => false }, { guildId: () => '1', read: async () => CAT })(), null);
    assert.equal(await reader(), CAT);
    await reader();
    assert.equal(reads, 1, 'cached');
    t = 61_000;
    fail = true;
    await assert.rejects(() => reader());
    fail = false;
    assert.equal(await reader(), CAT);
    assert.equal(reads, 3, 'the failure was not cached');
});
