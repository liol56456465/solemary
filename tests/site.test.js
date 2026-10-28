// Front website (src/services/site/site.js): pages render, values are escaped, nothing is
// indexed and there is no add button while PUBLIC_SITE_ENABLED is off, the CSP has no
// unsafe-inline, and /health and /ready are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import {
    CSS_PATH, INSTALL_PERMISSIONS, NOINDEX, SECURITY_HEADERS, STYLESHEET, createSite, everyoneCommandGroups,
    installPermissionBits, installUrl, inviteOrNull, publicSiteEnabled,
} from '../src/services/site/site.js';
import { EVERYONE_COMMANDS } from '../src/config/commands/commandAccess.js';

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
async function serve({ env = {}, commands = fakeCommands(), dashboardEnabled = true, supportInvite = () => SUPPORT } = {}) {
    const app = express();
    app.get('/health', (req, res) => res.status(200).json({ status: 'healthy' }));
    app.get('/ready', (req, res) => res.status(503).json({ ready: false }));
    app.use(createSite({ client: { commands }, env: { CLIENT_ID, ...env }, dashboardEnabled, supportInvite }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
        const res = await fetch(base + path, { redirect: 'manual' });
        return { status: res.status, headers: res.headers, body: await res.text() };
    };
    return { get, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('PUBLIC_SITE_ENABLED is off unless true', () => {
    assert.equal(publicSiteEnabled({}), false);
    assert.equal(publicSiteEnabled({ PUBLIC_SITE_ENABLED: 'false' }), false);
    assert.equal(publicSiteEnabled({ PUBLIC_SITE_ENABLED: 'true' }), true);
});

test('every front page renders with the shell, the hashed stylesheet and no inline style or script', async () => {
    const site = await serve();
    try {
        for (const [path, heading] of [['/', 'Moderation that explains itself.'], ['/commands', 'Commands'], ['/about', 'About Meowist']]) {
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
            assert.ok(!/<script/i.test(res.body), `${path}: no scripts`);
            assert.ok(!/\sstyle=/i.test(res.body) && !/<style/i.test(res.body), `${path}: no inline styles`);
            assert.ok(res.body.includes(`href="${SUPPORT}"`), `${path}: support link`);
            assert.ok(res.body.includes('href="/dashboard">Log in'), `${path}: log in`);
        }
        const notFound = await site.get('/nope');
        assert.equal(notFound.status, 404);
        assert.ok(notFound.body.includes('Page not found'));
    } finally { await site.close(); }
});

test('the stylesheet is served with the dashboard theme tokens', async () => {
    const site = await serve();
    try {
        const res = await site.get(CSS_PATH);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/css/);
        assert.equal(res.body, STYLESHEET);
        const dashboard = readFileSync(new URL('../src/services/dashboard/static/dashboard.css', import.meta.url), 'utf8');
        for (const selector of [':root {', ':root:not([data-theme]) {', ':root[data-theme="paper"] {', '@media (prefers-color-scheme: dark)']) {
            assert.ok(dashboard.includes(selector) && STYLESHEET.includes(selector), selector);
        }
        assert.ok(!STYLESHEET.includes('.side-nav'), 'only the tokens, not the dashboard layout');
        assert.ok(STYLESHEET.includes('.topbar'));
    } finally { await site.close(); }
});

test('CSP and security headers: no unsafe-inline, no scripts, no framing', async () => {
    const site = await serve();
    try {
        for (const path of ['/', '/commands', '/about', '/robots.txt', CSS_PATH, '/nope']) {
            const res = await site.get(path);
            const csp = res.headers.get('content-security-policy');
            assert.equal(csp, SECURITY_HEADERS['Content-Security-Policy'], path);
            assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), path);
            assert.match(csp, /default-src 'none'/);
            assert.match(csp, /script-src 'none'/);
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
        for (const path of ['/', '/commands', '/about', '/nope']) {
            const res = await site.get(path);
            assert.equal(res.headers.get('x-robots-tag'), NOINDEX, path);
            assert.ok(res.body.includes(`<meta name="robots" content="${NOINDEX}">`), path);
            assert.ok(!res.body.includes('data-add-bot'), `${path}: no add button`);
            assert.ok(!res.body.includes('oauth2/authorize'), `${path}: no install URL`);
            assert.ok(!res.body.includes('Add to your server'), path);
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
        const href = home.body.match(/<a class="button" href="([^"]+)" rel="noopener" data-add-bot>Add to your server<\/a>/);
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

test('Log in is hidden when the dashboard is not enabled', async () => {
    const site = await serve({ dashboardEnabled: false });
    try { assert.ok(!(await site.get('/')).body.includes('/dashboard')); } finally { await site.close(); }
});

test('commands page: only everyone-commands, grouped, descriptions escaped', async () => {
    const site = await serve();
    try {
        const body = (await site.get('/commands')).body;
        assert.ok(body.includes('<code>/ping</code>'));
        assert.ok(body.includes('Checks the bot’s latency &lt;b&gt;'), 'description escaped');
        assert.ok(!body.includes('latency <b>'));
        assert.ok(body.includes('<code>/todo share view</code>'));
        assert.ok(body.includes('<code>/birthday set</code>'));
        assert.ok(!body.includes('setchannel') && !body.includes('ADMIN ONLY'), 'admin subcommand hidden');
        assert.ok(!body.includes('/purge') && !body.includes('ADMIN PURGE'), 'admin command hidden');
        assert.ok(body.includes('<code>Report message</code>'), 'context menu without a slash');
        assert.ok(body.includes('Ticket staff'), 'narrowed access noted');
        assert.ok(body.indexOf('id="h-core">General') < body.indexOf('id="h-utility">Utility'), 'groups in order');
    } finally { await site.close(); }
});

test('commands page before the commands load: the everyone keys, nothing else', () => {
    const groups = everyoneCommandGroups(new Map());
    const keys = groups.flatMap((g) => g.items.map((i) => i.key)).sort();
    assert.deepEqual(keys, [...EVERYONE_COMMANDS].sort());
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
    assert.ok(app.includes("status: 'healthy',") && app.includes("message: 'Bot is ready',"));
    assert.ok(!app.includes('Meowist System Online'), 'the old JSON root is gone');
});

test('commands page from the real command files: every listed command is an everyone-command with a description', async () => {
    const { loadCommands } = await import('../src/handlers/loaders/commandLoader.js');
    const client = {};
    await loadCommands(client);
    const items = everyoneCommandGroups(client.commands).flatMap((g) => g.items);
    assert.ok(items.length >= 40, `listed ${items.length}`);
    for (const item of items) {
        assert.ok(EVERYONE_COMMANDS.has(item.key), item.key);
        assert.ok(item.description.trim(), `${item.key} has a description`);
    }
    assert.ok(!items.some((i) => i.key.startsWith('enforcements') || i.key === 'purge'));
});
