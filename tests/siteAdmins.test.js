// The new-admin path on the website: the install link (optionally sending the admin back to
// /added), the /added landing page (no storage, guild_id only for a link, the OAuth code dropped
// from the URL), the "For server admins" page in all 8 languages, and the admin FAQ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { PermissionsBitField } from 'discord.js';
import { createSite } from '../src/services/site/site.js';
import {
    INSTALL_PERMISSIONS, installPermissionBits, installRedirectUri, installUrl, siteInstallUrl,
} from '../src/services/site/shell.js';
import { LIMIT_ROWS, addedPage, addedState, adminsPage } from '../src/services/site/pages/admins.js';
import { faqPage } from '../src/services/site/pages/faq.js';
import { LANGUAGES, catalogKeys, translatedIn, translator } from '../src/services/site/i18n.js';
import { PLANS } from '../src/config/site/plans.js';

const CLIENT_ID = '400000000000000004';
const GUILD = '123456789012345678';
const ORIGIN = 'https://mewvo.example';

async function serve(env = {}, { memberPortalEnabled = false } = {}) {
    const app = express();
    app.use(createSite({
        client: { commands: null }, env: { CLIENT_ID, ...env }, dashboardEnabled: true, memberPortalEnabled, supportInvite: () => null,
        leaderboard: async () => ({ enabled: true, rows: [] }), status: () => ({ state: 'online', uptimeMs: 1 }),
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        get: async (path) => { const res = await fetch(base + path, { redirect: 'manual' }); return { status: res.status, headers: res.headers, body: await res.text() }; },
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

const paramsOf = (url) => new URL(url).searchParams;

test('install link: client id, the permissions integer and both scopes; the redirect only when enabled', () => {
    const plain = paramsOf(installUrl(CLIENT_ID));
    assert.equal(plain.get('client_id'), CLIENT_ID);
    assert.equal(plain.get('permissions'), '1460709747959');
    assert.equal(plain.get('scope'), 'bot applications.commands');
    assert.equal(plain.has('response_type'), false);
    assert.equal(plain.has('redirect_uri'), false);

    const back = paramsOf(installUrl(CLIENT_ID, { redirectUri: `${ORIGIN}/added` }));
    assert.equal(back.get('response_type'), 'code');
    assert.equal(back.get('redirect_uri'), `${ORIGIN}/added`);
    assert.equal(back.get('permissions'), '1460709747959');
    for (const bad of ['javascript:alert(1)', '/added', 'https://x.example/"><script>', '']) {
        assert.equal(paramsOf(installUrl(CLIENT_ID, { redirectUri: bad })).has('redirect_uri'), false, bad);
    }

    assert.equal(installRedirectUri({ PUBLIC_URL: ORIGIN }), null, 'off by default');
    assert.equal(installRedirectUri({ INSTALL_REDIRECT_ENABLED: 'true' }), null, 'needs PUBLIC_URL');
    assert.equal(installRedirectUri({ INSTALL_REDIRECT_ENABLED: 'true', PUBLIC_URL: `${ORIGIN}/x` }), `${ORIGIN}/added`);
    assert.equal(paramsOf(siteInstallUrl({ CLIENT_ID, PUBLIC_URL: ORIGIN })).has('redirect_uri'), false);
    assert.equal(paramsOf(siteInstallUrl({ CLIENT_ID, PUBLIC_URL: ORIGIN, INSTALL_REDIRECT_ENABLED: 'true' })).get('redirect_uri'), `${ORIGIN}/added`);
    assert.equal(siteInstallUrl({ CLIENT_ID: 'nope', INSTALL_REDIRECT_ENABLED: 'true', PUBLIC_URL: ORIGIN }), null);
});

test('permissions integer 1460709747959 decodes to exactly INSTALL_PERMISSIONS (no Administrator)', () => {
    assert.equal(installPermissionBits(), 1460709747959n);
    const decoded = new PermissionsBitField(1460709747959n).toArray();
    assert.deepEqual([...decoded].sort(), [...INSTALL_PERMISSIONS].sort());
    assert.ok(!decoded.includes('Administrator'));
});

test('the Add to Discord button carries the /added redirect only with INSTALL_REDIRECT_ENABLED', async () => {
    const on = await serve({ PUBLIC_SITE_ENABLED: 'true', PUBLIC_URL: ORIGIN, INSTALL_REDIRECT_ENABLED: 'true' });
    const off = await serve({ PUBLIC_SITE_ENABLED: 'true', PUBLIC_URL: ORIGIN });
    try {
        const redirect = `redirect_uri=${encodeURIComponent(`${ORIGIN}/added`)}`;
        const withIt = (await on.get('/')).body;
        assert.ok(withIt.includes('data-add-bot'));
        assert.ok(withIt.includes(redirect) && withIt.includes('response_type=code'));
        assert.ok(!(await off.get('/')).body.includes('redirect_uri'));
    } finally { await on.close(); await off.close(); }
});

test('addedState: guild_id only as a snowflake; an error means cancelled; nothing else is read', () => {
    assert.deepEqual(addedState({ guild_id: GUILD, code: 'x', permissions: '8' }), { state: 'added', guildId: GUILD });
    assert.deepEqual(addedState({ guild_id: [GUILD, '1'] }), { state: 'added', guildId: GUILD });
    for (const bad of ['"><script>alert(1)</script>', '12', `${GUILD}x`, '', undefined, { a: 1 }]) {
        assert.deepEqual(addedState({ guild_id: bad }), { state: 'unknown', guildId: null }, String(bad));
    }
    assert.deepEqual(addedState({ error: 'access_denied', guild_id: GUILD }), { state: 'cancelled', guildId: null });
});

test('/added: links to /dashboard/<id>, the setup guide and /admins; noindex, no-referrer, no-store, no cookie', async () => {
    const site = await serve({ PUBLIC_SITE_ENABLED: 'true' });
    try {
        const page = await site.get(`/added?guild_id=${GUILD}`);
        assert.equal(page.status, 200);
        assert.ok(page.body.includes(`href="/dashboard/${GUILD}"`));
        assert.ok(page.body.includes('href="/docs/setup"'));
        assert.ok(page.body.includes('href="/admins"'));
        assert.ok(page.body.includes('Mewvo is in your server'));
        assert.match(page.headers.get('x-robots-tag'), /noindex/);
        assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(page.headers.get('cache-control'), 'no-store');
        assert.equal(page.headers.get('set-cookie'), null);
        assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));

        // Discord's redirect: the code (and everything but the id) is dropped with a 303.
        const back = await site.get(`/added?code=SECRETCODE&guild_id=${GUILD}&permissions=1460709747959&state=s&iss=https%3A%2F%2Fdiscord.com`);
        assert.equal(back.status, 303);
        assert.equal(back.headers.get('location'), `/added?guild_id=${GUILD}`);
        assert.ok(!back.body.includes('SECRETCODE'));
        const de = await site.get(`/de/added?code=SECRETCODE&guild_id=${GUILD}`);
        assert.equal(de.headers.get('location'), `/de/added?guild_id=${GUILD}`);

        // A bad id: redirected to the plain page, never echoed.
        const evil = await site.get('/added?guild_id=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E');
        assert.equal(evil.status, 303);
        assert.equal(evil.headers.get('location'), '/added');
        const plain = await site.get('/added');
        assert.equal(plain.status, 200);
        assert.ok(plain.body.includes('href="/dashboard"'), 'without an id: the server picker');
        assert.ok(!plain.body.includes('<script>alert'));

        // Cancelled on Discord: no dashboard link, the Add button again.
        const cancelled = await site.get('/added?error=access_denied&error_description=The+resource+owner+denied');
        assert.equal(cancelled.status, 303);
        assert.equal(cancelled.headers.get('location'), '/added?error=access_denied');
        const no = await site.get('/added?error=access_denied');
        assert.equal(no.status, 200);
        assert.ok(no.body.includes('Mewvo was not added'));
        assert.ok(no.body.includes('data-add-bot'));
        assert.ok(!no.body.includes('href="/dashboard/'));
    } finally { await site.close(); }
});

test('/added escapes and never trusts what it is given; pages/admins.js touches no storage', () => {
    const ctx = { lang: 'en', dashboardEnabled: true };
    const page = addedPage(ctx, { state: 'added', guildId: '"><script>alert(1)</script>' });
    assert.ok(!page.includes('<script>alert'));
    assert.ok(!page.includes('/dashboard/"'));
    assert.ok(page.includes('Just added Mewvo?'), 'an id that is not a snowflake is the "unknown" page');
    const noDashboard = addedPage({ lang: 'en', dashboardEnabled: false }, { state: 'added', guildId: GUILD });
    assert.ok(!noDashboard.includes('href="/dashboard'));
    assert.ok(noDashboard.includes('/setup'));
    const source = readFileSync(new URL('../src/services/site/pages/admins.js', import.meta.url), 'utf8');
    assert.ok(!/database|setInDb|getFromDb|pg\b|cookie|session/i.test(source.replace(/^\/\/.*$/gm, '')), 'no storage in admins.js');
});

test('/admins: 200 in all 8 languages, own translation, every permission and the plan limits', async () => {
    const site = await serve({}, { memberPortalEnabled: false });
    try {
        for (const { code, prefix } of LANGUAGES) {
            const path = prefix ? `/${prefix}/admins` : '/admins';
            const res = await site.get(path);
            assert.equal(res.status, 200, path);
            assert.match(res.body, new RegExp(`<html lang="${code}">`));
            const { t } = translator(code);
            assert.ok(res.body.includes(`<h1>${t('admins.head.title')}</h1>`), path);
            for (const name of INSTALL_PERMISSIONS) assert.ok(res.body.includes(t(`admins.permissions.items.${name}.name`).replace(/'/g, '&#39;')), `${code} ${name}`);
            assert.equal((res.body.match(/<div class="cmd"><dt>/g) || []).length, INSTALL_PERMISSIONS.length);
            assert.ok(res.body.includes('1460709747959'));
            for (const plan of PLANS) assert.ok(res.body.includes(`<th scope="col">${plan.name}</th>`), `${code} ${plan.id}`);
            // The footer link to the page, in that language.
            assert.ok(res.body.includes(`href="${path}" aria-current="page"`), `${code} footer link`);
        }
        const en = (await site.get('/admins')).body;
        for (const plan of PLANS) for (const [key] of LIMIT_ROWS) assert.ok(en.includes(`<td>${translator('en').fmtNumber(plan.limits[key])}</td>`), `${plan.id} ${key}`);
        assert.ok(en.includes('href="/added"'), 'the plain "Start here" link (works without the Developer Portal redirect)');
        assert.ok(!en.includes('href="/me/appeals"'), 'web appeals only with the member portal');
    } finally { await site.close(); }
});

test('admins + FAQ catalogs: every key in all 8 languages, translated (not the English fallback), every admins key used', () => {
    const adminKeys = catalogKeys('en').filter((key) => key.startsWith('admins.'));
    const faqKeys = catalogKeys('en').filter((key) => key.startsWith('faq.admins.'));
    assert.equal(faqKeys.length, 11, 'title + 5 questions');
    for (const key of ['whoDecides', 'otherServers', 'removeBot', 'dashboardTeam', 'readMessages']) {
        assert.ok(faqKeys.includes(`faq.admins.${key}.q`) && faqKeys.includes(`faq.admins.${key}.a`), key);
    }
    for (const { code } of LANGUAGES) {
        for (const key of [...adminKeys, ...faqKeys, 'shell.links.admins']) assert.ok(translatedIn(code, key), `${code}: ${key}`);
    }
    // Every admins key is read by some state of the two pages.
    const used = new Set();
    const en = translator('en');
    const wrap = (fn) => (key, params) => { used.add(key); return fn(key, params); };
    const ctx = (extra) => ({ ...en, t: wrap(en.t), ti: wrap(en.ti), tb: wrap(en.tb), ...extra });
    for (const memberPortal of [false, true]) adminsPage(ctx({ memberPortal }));
    for (const dashboardEnabled of [false, true]) {
        for (const state of [{ state: 'added', guildId: GUILD }, { state: 'unknown' }, { state: 'cancelled' }]) addedPage(ctx({ dashboardEnabled, publicSite: true, installUrl: installUrl(CLIENT_ID) }), state);
    }
    const unused = adminKeys.filter((key) => !used.has(key));
    assert.deepEqual(unused, []);
});

test('/faq: the five admin questions in every language', () => {
    for (const { code } of LANGUAGES) {
        const page = faqPage({ ...translator(code) });
        const { t } = translator(code);
        assert.ok(page.includes(t('faq.admins.title').replace(/'/g, '&#39;')), code);
        for (const key of ['whoDecides', 'otherServers', 'removeBot', 'dashboardTeam', 'readMessages']) {
            assert.ok(page.includes(`<summary>${t(`faq.admins.${key}.q`).replace(/'/g, '&#39;')}</summary>`), `${code} ${key}`);
        }
    }
});
