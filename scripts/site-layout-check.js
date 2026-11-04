// site-layout-check.js — opens every public website page in every language at several widths in
// a headless browser and lists layout problems: the page scrolling sideways, boxes whose content
// overflows them, clipped text, a top bar that wraps onto extra rows or whose parts overlap, words
// glued to a link / <strong> / <code> without a space, overlapping neighbours, and picker menus
// that leave the screen. Localhost only.
//
//   node scripts/site-layout-check.js                       all pages × 8 languages × 360 390 768 1024 1280
//   node scripts/site-layout-check.js --pages home,pricing --langs de,fr --widths 390,1280
//   node scripts/site-layout-check.js --shots <dir>         also writes a PNG per page/lang/width (viewport,
//                                                           or --full for the whole page, capped at 6000 px)
//   node scripts/site-layout-check.js --json <file>         the raw findings as JSON
//   node scripts/site-layout-check.js --serve               only start the preview (http://127.0.0.1:5057/de/pricing,
//                                                           member pages at /__preview/<page>?lang=de); Ctrl+C stops it
//   node scripts/site-layout-check.js --chrome <path>       a different Chromium / headless shell binary
// Exit code 1 when anything was found.
//
// How: createSite() is mounted on a bare Express app on 127.0.0.1 with made-up data (leaderboard,
// rules, cat, transparency report, trust card, the real command list); the member pages (/me login,
// sign-up, record, account, checkout, billing, redeem) are rendered straight from their page
// functions with a fake session at /__preview/… Nothing logs in to Discord and no database is used
// (every DB URL / token / secret is removed from the environment before app code is imported).
// The browser is the headless Chromium shell that Playwright installed, driven over the DevTools
// protocol (Node's built-in WebSocket, no extra package); every non-local host is unresolvable
// for it (--host-resolver-rules) and the script only ever navigates to 127.0.0.1.
// Run on Node 22 (`nvm use`).

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const arg = (name, fallback = null) => {
    const at = process.argv.indexOf(name);
    return at > -1 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--') ? process.argv[at + 1] : fallback;
};
const PORT = Number(arg('--port', '5057'));
// Two set-ups of the top bar: "full" (public site: Add to Discord, Log in, Sign up, member pages,
// test checkout) on PORT and "basic" (not public, no member portal: the picker + Dashboard) on PORT + 1.
const PROFILES = { full: PORT, basic: PORT + 1 };
const ORIGIN = `http://${HOST}:${PORT}`;
const originOf = (profile) => `http://${HOST}:${PROFILES[profile]}`;

// ── a safe, fake environment (before any app module is imported) ───────────
for (const key of Object.keys(process.env)) {
    if (/(^|_)(DATABASE|POSTGRES|PG)(_|$)|_URL$|TOKEN|SECRET|^PG/.test(key)) delete process.env[key];
}
const GUILD = '100000000000000001';
Object.assign(process.env, {
    NODE_ENV: 'development', LOG_LEVEL: 'error',
    MAIN_GUILD_ID: GUILD, SUPPORT_GUILD_ID: '100000000000000002', OWNER_IDS: '',
});
function refuseRemoteDb() {
    for (const [key, value] of Object.entries(process.env)) {
        if (!/postgres(ql)?:\/\//i.test(String(value))) continue;
        const host = (() => { try { return new URL(value).hostname; } catch { return ''; } })();
        if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`Refusing to run: ${key} points at a non-local database.`);
    }
}
refuseRemoteDb();

const express = (await import('express')).default;
const { createSite, legalContact } = await import('../src/services/site/site.js');
const { installUrl } = await import('../src/services/site/shell.js');
const { GUIDES } = await import('../src/services/site/pages/docs.js');
const { LANGUAGES, localizePath, translator } = await import('../src/services/site/i18n.js');
const { loginPage, recordPage } = await import('../src/services/site/memberPortal.js');
const { signupPage, passwordLoginPage, forgotPage, accountSettingsPage } = await import('../src/services/site/accountPages.js');
const { checkoutPage, billingPage, redeemPage } = await import('../src/services/site/billing.js');
const { aggregateReport } = await import('../src/services/enforcement/transparencyService.js');
refuseRemoteDb();

// ── made-up data ───────────────────────────────────────────────────────────
const NOW = Date.now();
const DAY = 86_400_000;
const ENV = {
    PUBLIC_SITE_ENABLED: 'true', CLIENT_ID: '400000000000000001', PUBLIC_URL: ORIGIN,
    MAIN_SERVER_INVITE: 'https://discord.gg/cozycorner',
    LEGAL_OPERATOR: 'Example Operator', LEGAL_EMAIL: 'hello@example.com', LEGAL_ADDRESS: 'Example street 1, 00000 Example City',
};
const SUPPORT_INVITE = 'https://discord.gg/7Ckv9Bt577';
const NAMES = ['Ari', 'Mika', 'Noor', 'Tomas', 'Lena', 'Kai', 'Juno', 'Sasha', 'Robin', 'Elias', 'Ivy', 'Dana', 'AVeryLongDiscordDisplayName32ch'];
const board = async ({ offset, limit }) => ({
    enabled: true,
    rows: Array.from({ length: Math.min(limit, 60 - offset) }, (_, i) => ({ rank: offset + i + 1, name: NAMES[(offset + i) % NAMES.length], level: 40 - i, totalXp: 987654 - i * 9137 })),
});
const RULES = {
    rules: [
        { number: 1, title: 'Be kind to each other', text: 'No harassment, hate speech or personal attacks.', consequence: 'Warning, then a mute.' },
        { number: 2, title: 'No spam or self-promotion', text: 'Links to your own server or channel only in #promo.' },
        { number: 3, title: 'Keep it safe for work', text: '' },
    ],
    updatedAt: new Date(NOW - 3 * DAY),
};
const CAT = {
    name: 'Mochi', image: 'young-happy.png', stage: { key: 'young', name: 'Young cat' }, mood: 'happy',
    sentence: 'Mochi is happy: the server was busier this week.', total: 4321,
    progress: { fraction: 0.178, toNext: 10679, next: { name: 'Cat' } },
};
const month = (back) => { const d = new Date(NOW); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back); return d.toISOString().slice(0, 7); };
const REPORT = aggregateReport({
    caseRows: [
        { month: month(5), warns: 12, mutes: 4, kicks: 2, bans: 5, ladder_bans: 2, automod: 6, voided: 1 },
        { month: month(2), warns: 31, mutes: 7, kicks: 1, bans: 3, ladder_bans: 3, automod: 14, voided: 0 },
        { month: month(0), warns: 7, mutes: 0, kicks: 0, bans: 3, ladder_bans: 3, automod: 1, voided: 0 },
    ],
    appealRows: [
        { month: month(5), is_total: false, received: 6, accepted: 2, denied: 3, open: 1, decided: 5, median_hours: 30.4 },
        { month: month(0), is_total: false, received: 2, accepted: 1, denied: 0, open: 1, decided: 1, median_hours: 0.5 },
        { month: null, is_total: true, received: 8, accepted: 3, denied: 3, open: 2, decided: 6, median_hours: '20.25' },
    ],
}, new Date(NOW));
const CARD = {
    days: 90, since: new Date(NOW - 90 * DAY), generatedAt: new Date(NOW), serverName: 'Cozy Corner', memberCount: 1240,
    appeals: { received: 9, accepted: 4, denied: 2, answered: 7, decided: 6, medianFirstHours: 5.2, medianDecisionHours: 30.4 },
    cases: 14, flagged: 6, headsUp: { fixed: 8, acted: 2 },
};

// The real command list (as the bot loads it: one entry per file, category = folder).
async function loadCommands() {
    const root = path.join(ROOT, 'src/commands');
    const commands = new Map();
    for (const dir of await fs.readdir(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const file of await fs.readdir(path.join(root, dir.name))) {
            if (!file.endsWith('.js')) continue;
            try {
                const mod = await import(pathToFileURL(path.join(root, dir.name, file)).href);
                const json = mod.default?.data?.toJSON?.();
                if (json?.name) commands.set(json.name, { ...mod.default, category: mod.default.category || dir.name });
            } catch { /* a command that needs more setup is simply left out of the preview */ }
        }
    }
    return commands;
}

// ── the member pages, rendered from their page functions with a fake session ─
const SESSION = { username: 'ari_cozy', accountId: 'acc-1', csrf: 'preview-csrf', userId: '300000000000001001' };
function memberContext(lang) {
    return {
        publicSite: true, dashboardEnabled: true, memberPortal: true, accounts: true, billing: true,
        installUrl: installUrl(ENV.CLIENT_ID), mainInvite: ENV.MAIN_SERVER_INVITE, origin: null,
        legal: { ...legalContact(ENV), vatRegistered: false }, supportInvite: SUPPORT_INVITE,
        ...translator(lang, { href: (p) => localizePath(lang, p) }), urlLang: lang,
        viewer: { name: SESSION.username, accountId: SESSION.accountId, csrf: SESSION.csrf },
        languageLink: (code) => `?lang=${encodeURIComponent(code)}`,
    };
}
const ago = (ms) => new Date(NOW - ms);
const RECORD_VIEW = {
    warnings: { count: 2, threshold: 3 },
    ladder: { level: 1, next: 'The next warning brings a 30-day ban.' },
    activeBan: null, activeMute: { code: 'k7m2q', endsAt: new Date(NOW + 2 * DAY) },
    cases: [
        { code: 'k7m2q', type: 'Mute', reason: 'Spamming the same message in several channels', by: 'Juno', createdAt: ago(DAY), endsAt: new Date(NOW + 2 * DAY), status: 'Active', appeal: { appealable: true, until: new Date(NOW + 30 * DAY) } },
        { code: 'p4xw9', type: 'Warn', reason: 'Rule 1: personal attacks', by: 'Mira', createdAt: ago(20 * DAY), endsAt: null, status: 'Counted', appeal: { appealable: false, text: 'Appeal denied', from: ago(15 * DAY) } },
    ],
    truncated: false,
    appeals: [{ code: 'p4xw9', type: 'Warn', status: 'Denied', filedAt: ago(18 * DAY), decidedAt: ago(15 * DAY) }],
};
const ACCOUNT = { username: 'ari_cozy', discord_user_id: SESSION.userId, discord_username: 'ari', created_at: ago(40 * DAY), totp_enabled_at: ago(30 * DAY) };
const BILLING = {
    subscription: { plan_id: 'pro', expires_at: new Date(NOW + 60 * DAY), source: 'purchase' },
    orders: [{ id: 41, created_at: ago(3 * DAY), plan_id: 'pro', period: 'monthly', kind: 'personal', amount_cents: 499, test: true, legal: null }],
    gifts: [{ code: 'MEWVO-AB12-CD34-EF56', gift_to: 'Mika', plan_id: 'plus', duration_days: 30, created_at: ago(2 * DAY), redeemed_at: null }],
};
const MEMBER_PAGES = {
    login: (ctx) => loginPage({ ...ctx, viewer: null }),
    signup: (ctx) => signupPage({ ...ctx, viewer: null }, { csrf: 'x' }),
    'password-login': (ctx) => passwordLoginPage({ ...ctx, viewer: null }, { csrf: 'x' }),
    forgot: (ctx) => forgotPage({ ...ctx, viewer: null }, { csrf: 'x' }),
    record: (ctx) => recordPage(ctx, { session: SESSION, view: RECORD_VIEW }),
    account: (ctx) => accountSettingsPage(ctx, { session: SESSION, account: ACCOUNT, recoveryLeft: 8, canClaim: true, plan: { plan_id: 'pro', expires_at: new Date(NOW + 60 * DAY), source: 'purchase' }, now: NOW }),
    checkout: (ctx) => checkoutPage(ctx, { session: SESSION, choice: { planId: 'pro', period: 'monthly', kind: 'personal' } }),
    'checkout-gift': (ctx) => checkoutPage(ctx, { session: SESSION, choice: { planId: 'plus', period: 'yearly', kind: 'gift' } }),
    billing: (ctx) => billingPage(ctx, { session: SESSION, account: BILLING }),
    redeem: (ctx) => redeemPage(ctx, { session: SESSION }),
};

async function startServer(profile, commands) {
    const full = profile === 'full';
    const app = express();
    app.get('/dashboard', (req, res) => res.type('html').send('<!doctype html><title>dashboard</title>'));
    if (full) app.get('/__preview/:page', (req, res, next) => {
        const render = MEMBER_PAGES[req.params.page];
        if (!render) return next();
        const lang = LANGUAGES.some((l) => l.code === req.query.lang) ? req.query.lang : 'en';
        try {
            res.type('html').send(render(memberContext(lang)));
        } catch (error) {
            res.status(500).type('text').send(`preview failed: ${error.stack}`);
        }
    });
    app.use(createSite({
        client: { commands, isReady: () => true }, env: full ? ENV : { ...ENV, PUBLIC_SITE_ENABLED: 'false' }, dashboardEnabled: true,
        memberPortalEnabled: full, memberAccountsEnabled: full, billingEnabled: full, supportInvite: () => SUPPORT_INVITE,
        leaderboard: board, status: () => ({ state: 'online', uptimeMs: 3 * DAY + 3_600_000 }), rules: async () => RULES, cat: async () => CAT,
        transparency: { enabled: () => true, read: async () => REPORT },
        trust: { enabled: () => true, read: async () => CARD },
    }));
    return new Promise((resolve) => { const s = app.listen(PROFILES[profile], HOST, () => resolve(s)); });
}

// ── what gets checked ──────────────────────────────────────────────────────
const SITE_PAGES = [
    ['home', '/'], ['features', '/features'], ['pricing', '/pricing'], ['docs', '/docs'],
    ...GUIDES.map((g) => [`docs-${g.slug}`, `/docs/${g.slug}`]),
    ['faq', '/faq'], ['commands', '/commands'], ['leaderboard', '/leaderboard'], ['status', '/status'], ['about', '/about'],
    ['changelog', '/changelog'], ['rules', '/rules'], ['transparency', '/transparency'], ['trust', '/trust'],
    ['privacy', '/privacy'], ['terms', '/terms'], ['legal', '/legal'], ['contact', '/contact'], ['withdrawal', '/withdrawal'],
    ['not-found', '/no-such-page'],
];
const ALL_PAGES = [
    ...SITE_PAGES.map(([name, p]) => ({ name, profile: 'full', url: (lang) => localizePath(lang, p) })),
    ...SITE_PAGES.map(([name, p]) => ({ name: `${name}~basic`, profile: 'basic', url: (lang) => localizePath(lang, p) })),
    // The "also available in …" bar: an unprefixed page with Accept-Language set to the language.
    { name: 'home-suggest', profile: 'full', url: () => '/', acceptLanguage: true },
    { name: 'home-suggest~basic', profile: 'basic', url: () => '/', acceptLanguage: true },
    ...Object.keys(MEMBER_PAGES).map((name) => ({ name: `me-${name}`, profile: 'full', url: (lang) => `/__preview/${name}?lang=${encodeURIComponent(lang)}` })),
];
const list = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : null);
const wantPages = list(arg('--pages'));
const wantLangs = list(arg('--langs'));
const PAGES = wantPages ? ALL_PAGES.filter((p) => wantPages.includes(p.name) || wantPages.includes(p.name.replace('~basic', '')) || wantPages.includes(p.name.replace('~basic', '*'))) : ALL_PAGES;
const LANGS = LANGUAGES.map((l) => l.code).filter((c) => !wantLangs || wantLangs.includes(c) || wantLangs.includes(c.toLowerCase()));
const WIDTHS = (list(arg('--widths')) || ['360', '390', '768', '1024', '1280']).map(Number);
const MOBILE_MAX = 760; // the CSS breakpoint where the top bar becomes two rows

// ── the in-page check (runs in the browser; must be self-contained) ────────
function inPageCheck({ mobileMax }) {
    const out = [];
    const vw = document.documentElement.clientWidth;
    const describe = (el) => {
        const name = (e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + [...e.classList].slice(0, 2).map((c) => `.${c}`).join('');
        const parent = el.parentElement && el.parentElement !== document.body ? `${name(el.parentElement)} > ` : '';
        return parent + name(el);
    };
    const snippet = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);
    const add = (kind, el, detail) => out.push({ kind, selector: el ? describe(el) : '', text: el ? snippet(el) : '', detail });
    // Hidden, or hidden for the eye only (the visually-hidden pattern: clipped to 1px, for screen readers).
    const hiddenEl = (el) => el.closest('.visually-hidden, .skip, details:not([open]) > :not(summary)') || el.getClientRects().length === 0
        || (getComputedStyle(el).clip !== 'auto' && el.getBoundingClientRect().width <= 1);
    const scrollerOf = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if (ox === 'auto' || ox === 'scroll') return p;
        }
        return null;
    };
    const SKIP = new Set(['SCRIPT', 'STYLE', 'BR', 'OPTION', 'svg', 'path', 'IMG', 'INPUT', 'TEXTAREA', 'SELECT', 'HTML', 'HEAD', 'META', 'LINK', 'TITLE']);

    // 1. The page scrolls sideways.
    const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (docW > vw + 1) {
        const wide = [...document.body.querySelectorAll('*')].filter((el) => !SKIP.has(el.tagName) && !hiddenEl(el) && !scrollerOf(el) && el.getBoundingClientRect().right > vw + 1);
        const leaves = wide.filter((el) => !wide.some((o) => o !== el && el.contains(o)));
        add('page-scroll', null, `document ${docW}px wide in a ${vw}px viewport`);
        for (const el of leaves.slice(0, 4)) add('page-scroll-culprit', el, `right edge at ${Math.round(el.getBoundingClientRect().right)}px`);
    }

    // 2. Boxes whose content does not fit (visible overflow) or is cut off (hidden overflow).
    const over = [];
    for (const el of document.body.querySelectorAll('*')) {
        if (SKIP.has(el.tagName) || hiddenEl(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'inline' || cs.display === 'contents' || el.clientWidth === 0) continue;
        const ox = cs.overflowX;
        if (ox === 'auto' || ox === 'scroll') continue; // a box made to scroll (tables, the phone menu)
        if (scrollerOf(el)) continue; // inside such a box: it scrolls, the page does not
        const dx = el.scrollWidth - el.clientWidth;
        const dy = (cs.overflowY === 'hidden' || cs.overflowY === 'clip') ? el.scrollHeight - el.clientHeight : 0;
        if (dx > 1 || dy > 1) {
            const clipped = ox === 'hidden' || ox === 'clip' || dy > 1;
            if (clipped && cs.textOverflow === 'ellipsis' && dy <= 1) continue; // deliberate "…" (names, mock labels)
            over.push({ el, kind: clipped ? 'clipped' : 'overflow', detail: dx > 1 ? `content ${el.scrollWidth}px in a ${el.clientWidth}px box` : `content ${el.scrollHeight}px tall in a ${el.clientHeight}px box` });
        }
    }
    for (const o of over) if (!over.some((x) => x !== o && o.el.contains(x.el))) add(o.kind, o.el, o.detail);

    // 3. The top bar: one row on wide screens; on phones brand + actions on one row, the menu below.
    const inner = document.querySelector('.topbar-inner');
    if (inner) {
        const brand = inner.querySelector('.brand');
        const nav = inner.querySelector('.topnav');
        const actions = [...(inner.querySelector('.topbar-actions')?.children || [])].filter((c) => !hiddenEl(c));
        const b = brand.getBoundingClientRect();
        for (const c of actions) {
            const r = c.getBoundingClientRect();
            if (r.top >= b.bottom - 2 || r.bottom <= b.top + 2) add('header-row', c, 'not on the same row as the brand');
            if (r.height > 46) add('header-wrap', c, `${Math.round(r.height)}px tall: its text wraps`);
            if (r.right > vw + 0.5 || r.left < -0.5) add('header-offscreen', c, `spans ${Math.round(r.left)}–${Math.round(r.right)}px of ${vw}px`);
        }
        // The menu: beside the brand or on its own row below it, but in one line (phones: one line that scrolls).
        if (nav) {
            const tops = new Set([...nav.querySelectorAll('a')].map((a) => Math.round(a.getBoundingClientRect().top / 8)));
            if (tops.size > 1) add('header-menu-lines', nav, `the menu breaks into ${tops.size} lines`);
            const n = nav.getBoundingClientRect();
            if (n.top < b.bottom - 2 && n.bottom > b.top + 2 && vw <= mobileMax) add('header-row', nav, 'the menu is beside the brand on a phone');
        }
        // Overlaps between the brand, the visible menu links and the actions.
        const navBox = nav?.getBoundingClientRect();
        const links = nav ? [...nav.querySelectorAll('a')].filter((a) => { const r = a.getBoundingClientRect(); return r.right > navBox.left + 1 && r.left < navBox.right - 1; }) : [];
        const parts = [brand, ...links, ...actions];
        for (let i = 0; i < parts.length; i += 1) {
            for (let j = i + 1; j < parts.length; j += 1) {
                const p = parts[i].getBoundingClientRect(); const q = parts[j].getBoundingClientRect();
                const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
                const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
                if (w > 1 && h > 1) add('header-overlap', parts[j], `overlaps ${describe(parts[i])} by ${Math.round(w)}×${Math.round(h)}px`);
            }
        }
    }

    // 4. Neighbours that overlap (negative margins, absolute bits, fixed heights with longer text).
    for (const parent of document.querySelectorAll('main *, footer *, header *')) {
        const kids = [...parent.children].filter((k) => !SKIP.has(k.tagName) && !hiddenEl(k) && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed');
        if (kids.length < 2 || kids.length > 60 || scrollerOf(parent)) continue;
        for (let i = 0; i < kids.length - 1; i += 1) {
            for (let j = i + 1; j < Math.min(kids.length, i + 4); j += 1) {
                for (const p of kids[i].getClientRects()) {
                    for (const q of kids[j].getClientRects()) {
                        const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
                        const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
                        if (w > 3 && h > 3) { add('overlap', kids[j], `overlaps its sibling ${describe(kids[i])} by ${Math.round(w)}×${Math.round(h)}px`); i = kids.length; break; }
                    }
                    if (i === kids.length) break;
                }
            }
        }
    }

    // 5. Words glued to an inline element: "word<a>link</a>" or "<strong>x</strong>word" with no space.
    const WORD = /[\p{L}\p{N}]/u;
    const INLINE = new Set(['A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'KBD', 'TIME', 'SMALL', 'SPAN', 'ABBR', 'MARK', 'Q']);
    const visibleText = (node) => (node.nodeType === 3 ? node.textContent : (node.nodeType === 1 && !hiddenEl(node) ? node.textContent : ''));
    for (const el of document.querySelectorAll('main *, footer *, header *, aside *')) {
        if (!INLINE.has(el.tagName) || hiddenEl(el) || getComputedStyle(el).display !== 'inline') continue;
        const own = el.textContent;
        if (!own.trim()) continue;
        const prev = el.previousSibling; const next = el.nextSibling;
        const before = prev ? visibleText(prev) : '';
        const after = next ? visibleText(next) : '';
        const prevInline = !prev || prev.nodeType === 3 || (prev.nodeType === 1 && getComputedStyle(prev).display === 'inline');
        const nextInline = !next || next.nodeType === 3 || (next.nodeType === 1 && getComputedStyle(next).display === 'inline');
        if (prevInline && before && WORD.test(before.slice(-1)) && WORD.test(own[0])) add('glued', el, `no space before: "…${before.slice(-12)}|${own.slice(0, 12)}…"`);
        if (nextInline && after && WORD.test(own.slice(-1)) && WORD.test(after[0])) add('glued', el, `no space after: "…${own.slice(-12)}|${after.slice(0, 12)}…"`);
    }

    // 6. The picker and account menus, opened: inside the screen, nothing cut off.
    for (const menu of document.querySelectorAll('.lang-menu, .account-menu')) {
        if (hiddenEl(menu)) continue;
        menu.open = true;
        const pop = menu.querySelector('.lang-pop, .account-pop');
        const r = pop.getBoundingClientRect();
        if (r.left < -0.5 || r.right > vw + 0.5) add('menu-offscreen', pop, `menu spans ${Math.round(r.left)}–${Math.round(r.right)}px of ${vw}px`);
        for (const item of pop.querySelectorAll('a, button')) if (item.scrollWidth > item.clientWidth + 1) add('overflow', item, `menu item ${item.scrollWidth}px in ${item.clientWidth}px`);
        menu.open = false;
    }
    return out;
}

// ── a tiny DevTools-protocol client over Node's WebSocket ──────────────────
function chromeBinary() {
    const given = arg('--chrome');
    if (given) return given;
    const base = path.join(homedir(), '.cache/ms-playwright');
    const dir = readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
    if (!dir) throw new Error('No Playwright headless shell found; pass --chrome <path>');
    return path.join(base, dir, 'chrome-headless-shell-linux64/chrome-headless-shell');
}

async function launchBrowser() {
    const profile = mkdtempSync(path.join(tmpdir(), 'mewvo-layout-'));
    const proc = spawn(chromeBinary(), [
        '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${HOST}`, '--no-first-run', '--disable-gpu', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('Chromium did not start')), 15_000);
        proc.stderr.on('data', (chunk) => {
            buffer += chunk;
            const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
            if (m) { clearTimeout(timer); resolve(m[1]); }
        });
        proc.on('exit', (code) => reject(new Error(`Chromium exited (${code})`)));
    });
    if (new URL(wsUrl).hostname !== HOST) throw new Error('DevTools is not on 127.0.0.1');
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
        } else for (const l of listeners) l(msg);
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        id += 1;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const waitFor = (method, sessionId, ms = 15_000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(l); reject(new Error(`timeout waiting for ${method}`)); }, ms);
        const l = (msg) => { if (msg.method === method && msg.sessionId === sessionId) { clearTimeout(timer); listeners.delete(l); resolve(msg.params); } };
        listeners.add(l);
    });
    const close = () => { try { ws.close(); } catch { /* gone */ } proc.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true }); };
    return { send, waitFor, close };
}

async function openTab(browser) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, sessionId);
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Network.enable', {}, sessionId);
    let width = 0;
    return {
        async visit(url, { viewport, acceptLanguage = null }) {
            if (new URL(url).hostname !== HOST) throw new Error(`Local pages only: ${url}`);
            if (viewport !== width) {
                await browser.send('Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, deviceScaleFactor: 1, mobile: viewport < 768 }, sessionId);
                width = viewport;
            }
            await browser.send('Network.setExtraHTTPHeaders', { headers: acceptLanguage ? { 'Accept-Language': acceptLanguage } : {} }, sessionId);
            await browser.send('Network.clearBrowserCookies', {}, sessionId);
            const loaded = browser.waitFor('Page.loadEventFired', sessionId);
            await browser.send('Page.navigate', { url }, sessionId);
            await loaded;
        },
        async evaluate(fn, input) {
            const { result, exceptionDetails } = await browser.send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(input)})`, returnByValue: true, awaitPromise: true }, sessionId);
            if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
            return result.value;
        },
        async screenshot(file, full) {
            let clip;
            if (full) {
                const { cssContentSize } = await browser.send('Page.getLayoutMetrics', {}, sessionId);
                clip = { x: 0, y: 0, width, height: Math.min(Math.ceil(cssContentSize.height), 6000), scale: 1 };
            }
            const { data } = await browser.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }, sessionId);
            writeFileSync(file, Buffer.from(data, 'base64'));
        },
    };
}

// ── run ────────────────────────────────────────────────────────────────────
async function main() {
    const commands = await loadCommands();
    const servers = await Promise.all(Object.keys(PROFILES).map((profile) => startServer(profile, commands)));
    if (process.argv.includes('--serve')) {
        console.log(`Preview (full top bar): ${ORIGIN}/, ${ORIGIN}/de/pricing, ${ORIGIN}/__preview/checkout?lang=de (member pages: ${Object.keys(MEMBER_PAGES).join(', ')})`);
        console.log(`Preview (basic top bar: not public, no member portal): ${originOf('basic')}/`);
        return;
    }
    const shots = arg('--shots');
    if (shots) mkdirSync(shots, { recursive: true });
    const browser = await launchBrowser();
    const jobs = [];
    for (const page of PAGES) {
        for (const lang of LANGS) {
            if (page.acceptLanguage && lang === 'en') continue;
            for (const width of WIDTHS) jobs.push({ page, lang, width });
        }
    }
    const findings = [];
    const failures = [];
    let next = 0;
    const worker = async () => {
        const tab = await openTab(browser);
        while (next < jobs.length) {
            const job = jobs[next]; next += 1;
            const url = originOf(job.page.profile) + job.page.url(job.lang);
            try {
                await tab.visit(url, { viewport: job.width, acceptLanguage: job.page.acceptLanguage ? job.lang : null });
                const issues = await tab.evaluate(inPageCheck.toString(), { mobileMax: MOBILE_MAX });
                for (const issue of issues) findings.push({ page: job.page.name, lang: job.lang, width: job.width, ...issue });
                if (shots) await tab.screenshot(path.join(shots, `${job.page.name}-${job.lang}-${job.width}.png`), process.argv.includes('--full'));
            } catch (error) {
                failures.push({ page: job.page.name, lang: job.lang, width: job.width, error: error.message });
            }
        }
    };
    const started = Date.now();
    try {
        await Promise.all(Array.from({ length: 4 }, worker));
    } finally {
        browser.close();
        for (const server of servers) { server.closeAllConnections?.(); server.close(); }
    }
    // Group: the same problem (kind + selector + detail without numbers) across pages / languages / widths.
    const groups = new Map();
    for (const f of findings) {
        const key = `${f.kind} | ${f.selector} | ${f.detail.replace(/\d+/g, '#')}`;
        if (!groups.has(key)) groups.set(key, { kind: f.kind, selector: f.selector, detail: f.detail, text: f.text, where: [] });
        const at = `${f.page}/${f.lang}/${f.width}`;
        if (!groups.get(key).where.includes(at)) groups.get(key).where.push(at);
    }
    const sorted = [...groups.values()].sort((a, b) => b.where.length - a.where.length);
    for (const g of sorted) {
        const shown = g.where.slice(0, 8).join(' ');
        console.log(`[${g.kind}] ${g.selector}  ${g.detail}${g.text ? `  «${g.text}»` : ''}\n    ${g.where.length}× ${shown}${g.where.length > 8 ? ' …' : ''}`);
    }
    for (const f of failures) console.log(`[load-failed] ${f.page}/${f.lang}/${f.width}: ${f.error}`);
    const counts = {};
    for (const f of findings) counts[f.kind] = (counts[f.kind] || 0) + 1;
    console.log(`\n${jobs.length} page views in ${Math.round((Date.now() - started) / 1000)} s: ${findings.length} findings in ${groups.size} groups${failures.length ? `, ${failures.length} failed loads` : ''}`
        + (findings.length ? ` (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''));
    const json = arg('--json');
    if (json) writeFileSync(json, JSON.stringify({ findings, failures }, null, 2));
    process.exitCode = findings.length || failures.length ? 1 : 0;
}

await main();
if (!process.argv.includes('--serve')) process.exit(process.exitCode ?? 0);
