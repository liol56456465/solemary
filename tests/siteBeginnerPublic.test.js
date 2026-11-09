// Beginner audit 2.8, 2.11, 4.10 and the warn DM preview on the website: public-site variants of the
// "Mewvo is not public yet" texts (PUBLIC_SITE_ENABLED on/off), the "No Administrator needed" line
// after every in-page "Add to Discord" button, the translated "In short" on Privacy and Terms, the
// test-checkout banner, and the warn DM preview matching the bot's own DM text, in all 8 languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { createSite } from '../src/services/site/site.js';
import { LANGUAGES, loadCatalogs, translator, localizePath } from '../src/services/site/i18n.js';
import { PRIVACY_SHORT, TERMS_SHORT } from '../src/services/site/pages/legal.js';
import { pricingPage } from '../src/services/site/pages/pricing.js';
import { durationIn } from '../src/services/enforcement/dmTemplates.js';
import { escapeHtml } from '../src/services/dashboard/safeHtml.js';

const CLIENT_ID = '400000000000000004';
const CATALOGS = loadCatalogs();
const CODES = LANGUAGES.map((l) => l.code);
const OTHER = CODES.filter((c) => c !== 'en');

async function serveSite({ env = {}, support = null } = {}) {
    const app = express();
    app.use(createSite({
        client: { commands: null }, env: { CLIENT_ID, ...env }, dashboardEnabled: true, supportInvite: () => support,
        leaderboard: async () => ({ enabled: true, rows: [] }), status: () => ({ state: 'online', uptimeMs: 1 }),
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        get: async (path) => { const res = await fetch(base + path, { redirect: 'manual' }); return { status: res.status, body: await res.text() }; },
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

/** A catalog text as plain HTML text (escaped, markup stripped), for "is this on the page". */
const plain = (code, key) => String(translator(code).ti(key, { url: 'https://discord.gg/x', support: 'x' })).replace(/<[^>]+>/g, '');
const pageText = (body) => body.replace(/<[^>]+>/g, '');
const main = (body) => body.slice(body.indexOf('<main'), body.indexOf('</main>'));

test('2.8 public site: pricing, plans FAQ, FAQ and footer say Mewvo can be added; the private texts stay when it is off', async () => {
    const pub = await serveSite({ env: { PUBLIC_SITE_ENABLED: 'true' } });
    const priv = await serveSite();
    try {
        for (const code of CODES) {
            const at = (path) => localizePath(code, path);
            const t = translator(code).t;
            const pricingPub = pageText((await pub.get(at('/pricing'))).body);
            const pricingPriv = pageText((await priv.get(at('/pricing'))).body);
            assert.ok(pricingPub.includes(escapeHtml(t('pricing.head.leadPublic'))), `${code}: public lead`);
            assert.ok(!pricingPub.includes(escapeHtml(t('pricing.head.lead'))), `${code}: no private lead`);
            assert.ok(pricingPub.includes(escapeHtml(t('plans.faq.buyNow.aPublic'))) && !pricingPub.includes(escapeHtml(t('plans.faq.buyNow.a'))), `${code}: buy-now answer`);
            assert.ok(pricingPriv.includes(escapeHtml(t('pricing.head.lead'))) && pricingPriv.includes(escapeHtml(t('plans.faq.buyNow.a'))), `${code}: private texts kept`);

            const faqPub = pageText((await pub.get(at('/faq'))).body);
            const faqPriv = pageText((await priv.get(at('/faq'))).body);
            assert.ok(faqPub.includes(escapeHtml(t('faq.about.notYet.qPublic'))) && !faqPub.includes(escapeHtml(t('faq.about.notYet.q'))), `${code}: FAQ question`);
            assert.ok(faqPub.includes(plain(code, 'faq.about.notYet.aPublic')) && faqPub.includes(plain(code, 'faq.about.free.aPublic')), `${code}: FAQ answers`);
            assert.ok(!faqPub.includes(plain(code, 'faq.about.free.a')), `${code}: no "plans start when Mewvo opens"`);
            assert.ok(faqPriv.includes(escapeHtml(t('faq.about.notYet.q'))) && faqPriv.includes(plain(code, 'faq.about.free.a')), `${code}: private FAQ kept`);

            const homePub = (await pub.get(at('/'))).body;
            assert.ok(homePub.includes(escapeHtml(t('shell.footer.legalLinePublic'))) && !homePub.includes(escapeHtml(t('shell.footer.legalLine'))), `${code}: footer`);
            assert.ok(!homePub.includes(escapeHtml(t('home.hero.notPublic'))), `${code}: no "can't be added yet" on the home page`);
            assert.ok((await priv.get(at('/'))).body.includes(escapeHtml(t('shell.footer.legalLine'))), `${code}: private footer kept`);
        }
        // English, word for word (what the owner reads).
        const en = pageText((await pub.get('/pricing')).body);
        assert.ok(en.includes('Paid plans are not on sale yet') && !en.includes('opens to other servers') && !en.includes('runs only on its own server'));
        const faq = pageText((await pub.get('/faq')).body);
        assert.ok(faq.includes('Can I add Mewvo to my server?') && !faq.includes('Why can’t I add it to my server yet?'));
    } finally { await pub.close(); await priv.close(); }
});

test('2.8 the support-server lead has a public variant too', async () => {
    const pub = await serveSite({ env: { PUBLIC_SITE_ENABLED: 'true' }, support: 'https://discord.gg/7Ckv9Bt577' });
    try {
        const body = (await pub.get('/pricing')).body;
        assert.ok(body.includes('Paid plans are not on sale yet') && body.includes('<a href="https://discord.gg/7Ckv9Bt577" rel="noopener">Join the support server</a> to hear first when they start.'));
        assert.ok(!body.includes('opens to other servers'));
    } finally { await pub.close(); }
});

test('2.8 test checkout: the "Test mode" banner sits above the Buy buttons; without test checkout neither is there', () => {
    const on = String(pricingPage({ billing: true, memberPortal: true, publicSite: true, legal: {} }));
    const banner = on.indexOf('<p class="test-banner" role="note">');
    assert.ok(banner > 0, 'the banner is shown with Buy buttons');
    assert.ok(on.includes('<strong>Test mode.</strong>'));
    assert.ok(banner < on.indexOf('/me/checkout?'), 'before the first Buy link');
    for (const ctx of [{}, { publicSite: true }]) {
        const off = String(pricingPage(ctx));
        assert.ok(!off.includes('test-banner') && !off.includes('/me/checkout'), 'no banner and nothing to buy');
    }
});

test('2.11 every in-page "Add to Discord" button is followed by the "No Administrator needed" line, in every language', async () => {
    const pub = await serveSite({ env: { PUBLIC_SITE_ENABLED: 'true' } });
    const priv = await serveSite();
    try {
        for (const code of CODES) {
            const at = (path) => localizePath(code, path);
            const permissions = `${at('/admins')}#permissions`;
            for (const path of ['/', '/pricing', '/added?error=access_denied']) {
                const body = main((await pub.get(at(path))).body);
                const buttons = body.match(/data-add-bot>/g) || [];
                const notes = body.match(/<p class="install-note">/g) || [];
                assert.ok(buttons.length > 0, `${code} ${path}: an Add button`);
                assert.equal(notes.length, buttons.length, `${code} ${path}: one line per button`);
                assert.ok(body.includes(`href="${permissions}"`), `${code} ${path}: links to the permission list`);
                const note = body.slice(body.indexOf('<p class="install-note">'));
                assert.ok(note.startsWith(`<p class="install-note">${escapeHtml(translator(code).t('shell.install.note', { url: 'X' })).split('[')[0]}`), `${code} ${path}: the translated line`);
                assert.equal((await priv.get(at(path))).body.includes('install-note'), false, `${code} ${path}: no line without the button`);
            }
            assert.ok((await pub.get(at('/admins'))).body.includes('<h2 id="permissions">'), `${code}: the anchor exists`);
        }
        const home = main((await pub.get('/')).body);
        assert.ok(home.includes('<p class="install-note">No Administrator needed — <a href="/admins#permissions">see why Mewvo asks for each permission →</a></p>'));
    } finally { await pub.close(); await priv.close(); }
});

test('4.10 Privacy and Terms: "In short" translated in all 7 other languages with the binding-English note; English unchanged', async () => {
    const site = await serveSite();
    try {
        for (const code of OTHER) {
            for (const [page, keys] of [['privacy', PRIVACY_SHORT], ['terms', TERMS_SHORT]]) {
                for (const key of ['legal.inShort', 'legal.binding', ...keys.map((k) => `legal.${page}.short.${k}`)]) {
                    assert.ok(CATALOGS.get(code).has(key), `${code}: ${key} translated`);
                    assert.notEqual(CATALOGS.get(code).get(key), CATALOGS.get('en').get(key), `${code}: ${key} is not the English text`);
                }
                const body = (await site.get(localizePath(code, `/${page}`))).body;
                const t = translator(code).t;
                const start = body.indexOf(`<section class="notice legal-summary" lang="${code}" aria-labelledby="short-local">`);
                assert.ok(start > 0, `${code} /${page}: the summary`);
                const section = body.slice(start, body.indexOf('</section>', start));
                assert.ok(section.includes(`<h2 id="short-local">${escapeHtml(t('legal.inShort'))}</h2>`), `${code} /${page}: heading`);
                for (const k of keys) assert.ok(section.includes(`<li>${escapeHtml(t(`legal.${page}.short.${k}`))}</li>`), `${code} /${page}: ${k}`);
                assert.ok(section.includes(`<p class="legal-binding">${escapeHtml(t('legal.binding'))}</p>`), `${code} /${page}: the binding note`);
                assert.ok(body.includes('<html lang="en">') && body.includes(`<h2>In short</h2>`), `${code} /${page}: the English text follows`);
            }
        }
        const privacy = (await site.get('/privacy')).body;
        assert.ok(!privacy.includes('legal-summary') && !privacy.includes('The full text below is in English'));
        // The English bullets are the binding text: exactly what the page said before.
        assert.ok(privacy.includes('<h2>In short</h2>\n<ul><li>Mewvo works with Discord IDs (the numbers that identify accounts, servers and channels). Where a record needs a readable name, such as a moderation case, the username at that moment is saved with it.</li><li>The text of your messages is never stored. Technical logs keep only message IDs and lengths.</li><li>Everything is kept in a PostgreSQL database used only by the bot.</li>'));
        assert.ok(privacy.includes('<li>This website has no analytics, no ads, no tracking and no third-party scripts or cookies.</li></ul>'));
        const terms = (await site.get('/terms')).body;
        assert.ok(terms.includes('<h2>In short</h2>') && terms.includes('<li>When you buy a paid plan, you can withdraw within 14 days without giving a reason.</li>'));
        assert.ok(!terms.includes('legal-summary'));
        const source = readFileSync(new URL('../src/services/site/pages/legal.js', import.meta.url), 'utf8');
        assert.ok((source.match(/<!-- OWNER REVIEW/g) || []).length >= 4, 'the owner-review markers are kept');
    } finally { await site.close(); }
});

test('the warn DM preview (warning 2 of 3) says what the bot\'s DM says: "1 more warning means an automatic ban for 7 days" in every language', () => {
    for (const code of CODES) {
        const bot = JSON.parse(readFileSync(new URL(`../src/content/bot/${code}/enforcement.json`, import.meta.url), 'utf8'));
        const template = (bot.enforcement?.dm?.warn ?? bot.dm?.warn)?.next?.one;
        assert.equal(typeof template, 'string', `${code}: the bot's text`);
        const expected = template.replace('{count}', '1').replace('{length}', durationIn(7 * 86400000, code));
        assert.equal(CATALOGS.get(code).get('mockups.warnDm.limit'), expected, code);
    }
});
