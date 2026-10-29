// Front website (src/services/site/site.js): pages render, values are escaped, nothing is
// indexed and there is no add button while PUBLIC_SITE_ENABLED is off, the CSP has no
// unsafe-inline, and /health and /ready are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import {
    CSS_PATH, INSTALL_PERMISSIONS, LEADERBOARD_PAGE_SIZE, NOINDEX, SECURITY_HEADERS, STYLESHEET, botStatus,
    createLeaderboardReader, createSite, everyoneCommandGroups, installPermissionBits, installUrl, inviteOrNull,
    leaderboardPageNumber, publicSiteEnabled, uptimeWords,
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
async function serve({
    env = {}, commands = fakeCommands(), dashboardEnabled = true, supportInvite = () => SUPPORT,
    leaderboard = async () => ({ enabled: true, rows: [] }), status = () => ({ state: 'online', uptimeMs: 3_600_000 }),
} = {}) {
    const app = express();
    app.get('/health', (req, res) => res.status(200).json({ status: 'healthy' }));
    app.get('/ready', (req, res) => res.status(503).json({ ready: false }));
    app.use(createSite({ client: { commands }, env: { CLIENT_ID, ...env }, dashboardEnabled, supportInvite, leaderboard, status }));
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
        for (const [path, heading] of [
            ['/', 'Moderation that explains itself.'], ['/commands', 'Commands'], ['/about', 'About Meowist'],
            ['/leaderboard', 'Leaderboard'], ['/status', 'Status'], ['/privacy', 'Privacy'], ['/terms', 'Terms'],
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
            assert.ok(!/<script/i.test(res.body), `${path}: no scripts`);
            assert.ok(!/\sstyle=/i.test(res.body) && !/<style/i.test(res.body), `${path}: no inline styles`);
            assert.ok(res.body.includes(`href="${SUPPORT}"`), `${path}: support link`);
            assert.ok(res.body.includes('<a class="button" href="/dashboard">Dashboard</a>'), `${path}: filled Dashboard button in the top bar`);
            assert.ok(res.body.includes('<li><a href="/dashboard">Dashboard</a></li>'), `${path}: footer link`);
            assert.ok(res.body.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">'), `${path}: favicon`);
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
        for (const path of ['/', '/commands', '/about', '/leaderboard', '/status', '/privacy', '/terms', '/robots.txt', CSS_PATH, '/nope']) {
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
        for (const path of ['/', '/commands', '/about', '/leaderboard', '/status', '/privacy', '/terms', '/nope']) {
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

test('the home page links to the dashboard from the hero', async () => {
    const site = await serve();
    try {
        const body = (await site.get('/')).body;
        assert.match(body, /<p class="hero-actions">.*<a class="button button-quiet" href="\/dashboard">Open the dashboard<\/a>/s);
    } finally { await site.close(); }
});

test('with the add button shown, Dashboard is the quiet button', async () => {
    const site = await serve({ env: { PUBLIC_SITE_ENABLED: 'true' } });
    try {
        const body = (await site.get('/')).body;
        assert.ok(body.includes('<a class="button button-quiet" href="/dashboard">Dashboard</a>'));
        assert.ok(body.includes('data-add-bot>Add to your server</a>'));
    } finally { await site.close(); }
});

test('the favicon is the cat on a black tile, cached, under the site CSP', async () => {
    const site = await serve();
    try {
        const res = await site.get('/favicon.svg');
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
        assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
        assert.equal(res.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy']);
        assert.ok(res.body.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && res.body.includes('fill="#000"'));
        assert.ok(!/<script|on\w+=/i.test(res.body), 'nothing active in the icon');
    } finally { await site.close(); }
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
        assert.ok(!res.body.includes('<img'), 'name escaped');
        assert.ok(res.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(res.body.includes('Ann &amp; &quot;Bob&quot;'));
        assert.ok(res.body.includes('<td class="num">1</td><td class="board-name">'));
        assert.ok(res.body.includes('<td class="num">12</td><td class="num">98,765</td>'), 'level and total XP');
        assert.ok(res.body.includes('<li><a href="/leaderboard" aria-current="page">Leaderboard</a></li>'));
        assert.ok(!res.body.includes('class="pager"'), 'one page: no pager');
        assert.ok(!/<script|\sstyle=|<style/i.test(res.body));
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
        assert.ok(second.body.includes('<title>Leaderboard, page 2 · Meowist</title>'));
        const last = await site.get('/leaderboard?page=3');
        assert.ok(last.body.includes('href="/leaderboard?page=2" rel="prev"'));
        assert.ok(!last.body.includes('rel="next"'), 'last page: no Next');
    } finally { await site.close(); }
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
        assert.ok(res.body.includes('Leveling is turned off on the Meowist server'));
        assert.ok(!res.body.includes('<table'));
    } finally { await site.close(); }
});

/** A client shaped like the real one, enough for getLevelingConfig and getLeaderboard. */
function fakeClient({ ready = true, enabled = true, levels = [], members = {}, failRows = false } = {}) {
    const memberCache = new Map(Object.entries(members).map(([id, displayName]) => [id, { displayName, user: { username: displayName } }]));
    const guild = { id: '111111111111111111', members: { cache: memberCache, fetch: async () => memberCache } };
    let reads = 0;
    return {
        reads: () => reads,
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
        { rank: 2, name: 'Former member', level: 2, totalXp: 300 },
    ]);
    await read({ offset: 0, limit: 51 });
    assert.equal(client.reads(), 1, 'second view within a minute is cached');
    clock += 61_000;
    await read({ offset: 0, limit: 51 });
    assert.equal(client.reads(), 2, 'read again after a minute');

    const disabled = createLeaderboardReader(fakeClient({ enabled: false, levels }), { guildId: () => '111111111111111111' });
    assert.deepEqual(await disabled({ offset: 0, limit: 51 }), { enabled: false, rows: [] });
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

test('status: Online / Starting / Degraded, 200 always, refreshes, shows no counts, IDs or versions', async () => {
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
            assert.ok(res.body.includes('<meta http-equiv="refresh" content="60">'));
            assert.ok(res.body.includes('<li><a href="/status" aria-current="page">Status</a></li>'));
            const main = res.body.slice(res.body.indexOf('<main'), res.body.indexOf('</main>'));
            assert.ok(!/\d{17,20}/.test(main), 'no IDs');
            assert.ok(!/schema|guild|memory|heap|version/i.test(main), 'no internals');
            // The only digits on the page body are the uptime ("2 days, 3 hours").
            const text = main.replace(/<[^>]+>/g, '').replace(/Up for [^.]*\./, '');
            assert.ok(!/\d/.test(text), `${label}: no numbers besides the uptime`);
            assert.ok(!/<script|\sstyle=|<style/i.test(res.body));
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
            assert.ok(res.body.includes('Last updated <time datetime="2026-10-29">29 October 2026</time>.'), path);
            assert.ok(res.body.includes(`<a href="${SUPPORT}" rel="noopener">the support server</a>`), path);
        }
        const privacy = (await site.get('/privacy')).body;
        for (const fact of ['<code>identify</code>', '<code>guilds.join</code>', 'AES-256-GCM', '60 days', '<code>/wipedata</code>', 'never sold', 'PostgreSQL', 'never asks for your email']) {
            assert.ok(privacy.includes(fact), fact);
        }
        assert.ok(privacy.includes('does not delete moderation records'));
        const terms = (await site.get('/terms')).body;
        assert.ok(terms.includes('No warranty') && terms.includes('href="/privacy"'));
        // Footer: status and legal links on every page; Leaderboard also in the top nav.
        const home = (await site.get('/')).body;
        const footer = home.slice(home.indexOf('<footer'));
        for (const link of ['<a href="/status">Status</a>', '<a href="/privacy">Privacy</a>', '<a href="/terms">Terms</a>', '<a href="/leaderboard">Leaderboard</a>']) {
            assert.ok(footer.includes(link), link);
        }
        const topnav = home.slice(home.indexOf('<nav class="topnav"'), home.indexOf('</nav>'));
        assert.ok(topnav.includes('<a href="/leaderboard">Leaderboard</a>'));
        assert.ok(!topnav.includes('/privacy') && !topnav.includes('/status'), 'legal and status links only in the footer');
    } finally { await site.close(); }
    const noInvite = await serve({ supportInvite: () => null });
    try { assert.ok((await noInvite.get('/privacy')).body.includes('the staff team on the Meowist server')); } finally { await noInvite.close(); }
});
