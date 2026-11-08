// The public, multi-server website copy and small site fixes: the home <title>, the Free plan's
// "Add to Discord", the button kept on phones for logged-out visitors, web appeals in the FAQ and
// docs, localized portal dates, the /me language picker keeping the query, and the hashed
// dashboard assets cached for a year.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSite } from '../src/services/site/site.js';
import { PORTAL_DATE_TIME, portalTime } from '../src/services/site/shell.js';
import { translator } from '../src/services/site/i18n.js';
import { registerDashboard } from '../src/services/dashboard/routes.js';
import { CSS_PATH as DASHBOARD_CSS } from '../src/services/dashboard/html.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { registerMemberPortal } from '../src/services/site/memberPortal.js';

const CLIENT_ID = '400000000000000004';
const SUPPORT = 'https://discord.gg/7Ckv9Bt577';

async function serveSite({ env = {}, memberPortalEnabled = false } = {}) {
    const app = express();
    app.use(createSite({
        client: { commands: null }, env: { CLIENT_ID, ...env }, dashboardEnabled: true, memberPortalEnabled, supportInvite: () => SUPPORT,
        leaderboard: async () => ({ enabled: true, rows: [] }), status: () => ({ state: 'online', uptimeMs: 1 }),
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        get: async (path) => { const res = await fetch(base + path, { redirect: 'manual' }); return { status: res.status, headers: res.headers, body: await res.text() }; },
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

test('home: a descriptive <title> in each language (no " · Mewvo" added twice)', async () => {
    const site = await serveSite({ env: { PUBLIC_URL: 'https://mewvo.example' } });
    try {
        const en = await site.get('/');
        assert.ok(en.body.includes('<title>Mewvo: moderation and community bot for Discord</title>'));
        assert.ok(en.body.includes('<meta property="og:title" content="Mewvo: moderation and community bot for Discord">'));
        const de = await site.get('/de/');
        assert.ok(de.body.includes('<title>Mewvo: Moderations- und Community-Bot für Discord</title>'));
        const features = await site.get('/features');
        assert.match(features.body, /<title>[^<]+ · Mewvo<\/title>/, 'other pages keep "Page · Mewvo"');
    } finally { await site.close(); }
});

test('pricing: the Free plan button is "Add to Discord" on the public site, the invite otherwise', async () => {
    const pub = await serveSite({ env: { PUBLIC_SITE_ENABLED: 'true', MAIN_SERVER_INVITE: 'https://discord.gg/abc' } });
    try {
        const body = (await pub.get('/pricing')).body;
        const free = body.slice(body.indexOf('<li class="plan-card'), body.indexOf('</li><li class="plan-card'));
        assert.ok(free.includes('href="https://discord.com/oauth2/authorize?client_id=400000000000000004'), 'the install link');
        assert.ok(free.includes('>Add to Discord</a>'));
        assert.ok(!free.includes('discord.gg/abc'));
    } finally { await pub.close(); }
    const privateSite = await serveSite({ env: { MAIN_SERVER_INVITE: 'https://discord.gg/abc' } });
    try {
        const body = (await privateSite.get('/pricing')).body;
        const free = body.slice(body.indexOf('<li class="plan-card'), body.indexOf('</li><li class="plan-card'));
        assert.ok(free.includes('href="https://discord.gg/abc"') && !free.includes('oauth2/authorize'));
    } finally { await privateSite.close(); }
});

test('phones: logged-out visitors keep "Add to Discord" in the top bar; "Log in" moves to the menu', async () => {
    const site = await serveSite({ env: { PUBLIC_SITE_ENABLED: 'true' }, memberPortalEnabled: true });
    try {
        const body = (await site.get('/features')).body;
        const actions = body.slice(body.indexOf('<div class="topbar-actions">'), body.indexOf('</header>'));
        const add = actions.match(/<a class="([^"]+)" href="https:\/\/discord\.com\/oauth2[^"]*"/);
        assert.ok(add, 'the add button is there');
        assert.ok(!add[1].includes('topbar-more'), 'not hidden on phones');
        assert.match(actions, /<a class="button button-quiet topbar-more" href="\/me">/, 'Log in is hidden on phones (My record in the menu leads there)');
        assert.ok(body.includes('<li><a href="/me">My record</a></li>'), 'the menu link');
    } finally { await site.close(); }
});

test('FAQ and docs: web appeals only when the member portal is on; the server that punished you decides', async () => {
    const on = await serveSite({ memberPortalEnabled: true });
    try {
        const faq = (await on.get('/faq')).body;
        assert.ok(faq.includes('Can I appeal on the website?'));
        assert.ok(faq.includes('href="/me/appeals"'));
        assert.ok(faq.includes('one-way scrypt hash of your password'), 'matches the privacy page');
        assert.ok(!faq.includes('No email, no password'), 'the old claim is gone');
        const docs = (await on.get('/docs/appeals')).body;
        assert.ok(docs.includes('<strong>On the website:</strong>'));
        assert.ok(docs.includes('the server that punished you'));
        const access = (await on.get('/docs/getting-started')).body;
        assert.ok(!access.includes('moves currency'));
    } finally { await on.close(); }
    const off = await serveSite();
    try {
        const faq = (await off.get('/faq')).body;
        assert.ok(!faq.includes('Can I appeal on the website?'));
        assert.ok(!faq.includes('href="/me/appeals"'), 'no link to a page that is not there');
        assert.ok(!(await off.get('/docs/appeals')).body.includes('On the website:'));
    } finally { await off.close(); }
});

test('changelog: hosted wording and the entries since 1 November', async () => {
    const site = await serveSite();
    try {
        const body = (await site.get('/changelog')).body;
        assert.ok(!body.includes('at its next update'));
        assert.ok(body.includes('there is nothing to install or update'));
        for (const part of ['id="d-2026-11-08"', 'Mewvo is public', 'Appeals on the website', 'own dashboard', '8 languages', 'Mewvo accounts', 'Website editor', '/trust']) {
            assert.ok(body.includes(part), part);
        }
        assert.ok(body.indexOf('id="d-2026-11-08"') < body.indexOf('id="d-2026-11-01"'), 'newest first');
    } finally { await site.close(); }
});

test('portal dates are in the page language (UTC), with a machine-readable datetime', () => {
    const at = new Date(Date.UTC(2026, 10, 8, 14, 5));
    const en = String(portalTime(translator('en'), at));
    const de = String(portalTime(translator('de'), at));
    assert.match(en, /^<time datetime="2026-11-08T14:05:00.000Z">8 Nov 2026, 14:05 UTC<\/time>$/);
    assert.ok(de.includes('8. Nov. 2026') && de.includes('14:05'), de);
    assert.equal(String(portalTime(translator('en'), null)), '-');
    assert.equal(PORTAL_DATE_TIME.timeZone, 'UTC');
});

test('/me: the language picker keeps the page\'s query (without setlang)', async () => {
    const env = {
        MEMBER_PORTAL_ENABLED: 'true', SESSION_SECRET: 'x'.repeat(64), CLIENT_ID, DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: 'https://bot.example',
        MAIN_GUILD_ID: '100000000000000001', NODE_ENV: 'test', MEMBER_ACCOUNTS_ENABLED: 'false',
    };
    const app = express();
    registerMemberPortal(app, { env, sessions: createMemorySessionStore({ ttlMs: 3600 * 1000 }), data: { listCasesAllServers: async () => [], listUserAppeals: async () => [], getMemberStanding: async () => ({}) } });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/me?next=%2Fme%2Fappeals&setlang=xx`, { redirect: 'manual' });
        // An unknown setlang only reloads the same page with the rest of the query.
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/me?next=%2Fme%2Fappeals');
        const page = await (await fetch(`http://127.0.0.1:${server.address().port}/me?next=%2Fme%2Fappeals`)).text();
        assert.ok(page.includes('href="/me?next=%2Fme%2Fappeals&amp;setlang=de"'), 'the picker link keeps the query');
    } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});

test('dashboard: the hashed stylesheet URL is cached for a year, any other an hour', async () => {
    const env = { DASHBOARD_ENABLED: 'true', SESSION_SECRET: 'x'.repeat(64), CLIENT_ID, DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: 'https://bot.example', MAIN_GUILD_ID: '100000000000000001', NODE_ENV: 'test' };
    const app = express();
    assert.equal(registerDashboard(app, {}, env, { sessions: createMemorySessionStore() }), true);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const hashed = await fetch(`${base}${DASHBOARD_CSS}`);
        assert.equal(hashed.status, 200);
        assert.equal(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        const old = await fetch(`${base}/dashboard/static/dashboard.css?v=0000000000`);
        assert.equal(old.headers.get('cache-control'), 'public, max-age=3600');
    } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});
