// site.js — the front website at the site root: Home, Commands, About, /robots.txt and
// the stylesheet. Server-rendered with the dashboard's `html` template (every value escaped),
// no scripts at all and no inline styles (CSP: style-src 'self', script-src 'none').
//
//   GET /            Home: what Meowist does
//   GET /commands    the commands every member may use (EVERYONE_COMMANDS + the loaded descriptions)
//   GET /about       who runs it
//   GET /robots.txt  Disallow: / while the site is not public
//   GET /favicon.svg the cat on a black tile (the site and the dashboard link it)
//   GET /site.css    the dashboard's theme tokens + site layout, cached, ?v=<content hash>
//
// NOT PUBLIC YET: PUBLIC_SITE_ENABLED=true (default off) shows the "Add to your server" button
// and lets search engines index the pages. While off, every response carries
// X-Robots-Tag: noindex, nofollow and every page the matching <meta name="robots">.
// The health endpoints (/health, /ready) stay in app.js, registered before this router.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { html, raw } from '../dashboard/html.js';
import { CAT_PATH } from '../dashboard/icons.js';
import { EVERYONE_COMMANDS } from '../../config/commands/commandAccess.js';
import { commandEntries } from '../../config/commands/retirement.js';
import { logger } from '../../utils/logger.js';

const DASHBOARD_PATH = '/dashboard';

export const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'none'; img-src 'self'; "
        + "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
};
export const NOINDEX = 'noindex, nofollow';

/**
 * What the bot needs in a new server (the "Add to your server" link): no Administrator.
 * Moderation (ban, kick, timeout, nicknames), the managed Muted role and its channel overwrites
 * (Manage Roles + Manage Channels), automod and native AutoMod rules (Manage Messages,
 * Manage Server), logging (View Audit Log), one-time rejoin invites (Create Invite),
 * join-to-create voice and mute disconnects (Move Members), appeal/ticket threads,
 * and posting embeds, files and reactions.
 */
export const INSTALL_PERMISSIONS = [
    'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory',
    'AddReactions', 'UseExternalEmojis', 'ManageMessages', 'ManageThreads', 'CreatePrivateThreads',
    'ManageChannels', 'ManageRoles', 'ManageGuild', 'ViewAuditLog', 'CreateInstantInvite',
    'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageNicknames', 'MoveMembers', 'Connect',
];

export function installPermissionBits() {
    return INSTALL_PERMISSIONS.reduce((bits, name) => bits | PermissionFlagsBits[name], 0n);
}

const SNOWFLAKE = /^\d{17,20}$/;
const INVITE = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/;

/** The OAuth2 install link for CLIENT_ID, or null when the id is missing or malformed. */
export function installUrl(clientId) {
    const id = String(clientId || '').trim();
    if (!SNOWFLAKE.test(id)) return null;
    const params = new URLSearchParams({ client_id: id, permissions: installPermissionBits().toString(), scope: 'bot applications.commands' });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** A Discord invite link, or null (anything else is never put in a page). */
export function inviteOrNull(value) {
    const text = String(value || '').trim();
    return INVITE.test(text) ? text : null;
}

export function publicSiteEnabled(env = process.env) {
    return /^(1|true|yes|on)$/i.test(String(env.PUBLIC_SITE_ENABLED || '').trim());
}

// The theme tokens (every palette, light/dark by device) are the top of dashboard.css, up to
// its "Base" section: the site uses the same colours without duplicating them.
const BASE_MARKER = '/* ── Base';
function buildStylesheet() {
    try {
        const dashboard = readFileSync(new URL('../dashboard/static/dashboard.css', import.meta.url), 'utf8');
        const cut = dashboard.indexOf(BASE_MARKER);
        const tokens = cut > 0 ? dashboard.slice(0, cut) : '';
        const site = readFileSync(new URL('./static/site.css', import.meta.url), 'utf8');
        return `${tokens}\n${site}`;
    } catch (error) {
        logger.error(`Site stylesheet missing: ${error.message}`);
        return '';
    }
}
export const STYLESHEET = buildStylesheet();
export const CSS_PATH = `/site.css?v=${createHash('sha256').update(STYLESHEET).digest('hex').slice(0, 10)}`;

// ── Pages ─────────────────────────────────────────────────────────────────

// The Meowist cat (fill = currentColor, follows the theme). Decorative: the name is next to it.
const LOGO = raw(`<svg class="logo" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="${CAT_PATH}"/></svg>`);

// The browser-tab icon: the owner's logo, a white cat on black.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#000"/><path fill="#fff" fill-rule="evenodd" d="${CAT_PATH}"/></svg>`;

/** The links of the top bar and the footer; invites only when set. */
function navLinks(ctx, active) {
    const current = (key) => (key === active ? raw(' aria-current="page"') : '');
    return html`${ctx.mainInvite ? html`<li><a href="${ctx.mainInvite}" rel="noopener">Our server</a></li>` : ''}
${ctx.supportInvite ? html`<li><a href="${ctx.supportInvite}" rel="noopener">Support server</a></li>` : ''}
<li><a href="/commands"${current('commands')}>Commands</a></li>
<li><a href="/about"${current('about')}>About</a></li>
${ctx.memberPortal ? html`<li><a href="/me"${current('me')}>My record</a></li>` : ''}`;
}

function addButton(ctx, className = 'button') {
    return ctx.publicSite && ctx.installUrl
        ? html`<a class="${className}" href="${ctx.installUrl}" rel="noopener" data-add-bot>Add to your server</a>`
        : '';
}

export function layout(ctx, { title, active = null, description = '', body }) {
    // The way into the dashboard, like other bots' sites: a filled button unless "Add to your server" is shown.
    const login = ctx.dashboardEnabled ? html`<a class="button${ctx.publicSite && ctx.installUrl ? ' button-quiet' : ''}" href="${DASHBOARD_PATH}">Dashboard</a>` : '';
    return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">${ctx.publicSite ? '' : html`<meta name="robots" content="${NOINDEX}">`}
<title>${title === 'Meowist' ? 'Meowist' : `${title} · Meowist`}</title>${description ? html`<meta name="description" content="${description}">` : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${CSS_PATH}"></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="topbar"><div class="wrap topbar-inner"><a class="brand" href="/"${active === 'home' ? raw(' aria-current="page"') : ''}>${LOGO}<span>Meowist</span></a>
<nav class="topnav" aria-label="Main"><ul>${navLinks(ctx, active)}</ul></nav>
<div class="topbar-actions">${addButton(ctx)}${login}</div></div></header>
<main id="main" tabindex="-1">${body}</main>
<footer class="footer"><div class="wrap footer-inner"><p class="footer-brand">${LOGO}<span>Meowist</span></p>
<nav aria-label="Footer"><ul>${navLinks(ctx, active)}${ctx.dashboardEnabled ? html`<li><a href="${DASHBOARD_PATH}">Dashboard</a></li>` : ''}</ul></nav></div></footer>
</body></html>`.text;
}

// What the bot does, from the dashboard modules and CLAUDE.md (nothing invented).
const FEATURES = [
    { title: 'Enforcement with case codes', text: 'Ban, kick, mute and warn from one panel. Every action gets a short case code, the member gets a DM with the reason, the time and how to appeal, and staff can edit, void and attach evidence to cases.' },
    { title: 'A fair warning ladder', text: 'Two warnings are a heads-up; the third is a 7-day ban. After that the steps are a 30-day ban and then a permanent one. The ladder never quietly resets, and an accepted appeal steps it back down.' },
    { title: 'Appeals that reach a person', text: 'Members appeal from a panel, even after a ban: ban and kick appeals open a private channel in the support server. One pending appeal per case, and staff decide with a note.' },
    { title: 'Automod and raid protection', text: 'Rules for spam, links, invites and words, each with its own mode and exceptions, a join gate, raid panic with lockdown, automatic slowmode, and a bridge to Discord’s native AutoMod.' },
    { title: 'Tickets and modmail', text: 'A ticket panel with claim, priority and saved answers. Members can also DM the bot to reach the staff team privately.' },
    { title: 'Community tools', text: 'Leveling with role rewards, suggestions, a starboard, sticky messages, tags, YouTube feeds, reaction roles, giveaways, birthdays, role applications and join-to-create voice channels.' },
    { title: 'Logging and verification', text: 'Server events logged to the channels you choose, a verification panel, and welcome and goodbye messages.' },
    { title: 'A web dashboard', text: 'Staff run the server from the browser: members, cases, appeals and every module’s settings, with an audit log of each change. Administrator is checked on every request.' },
];

export function homePage(ctx) {
    const support = ctx.supportInvite ? html`<a class="button button-quiet" href="${ctx.supportInvite}" rel="noopener">Join the support server</a>` : '';
    return layout(ctx, {
        title: 'Meowist', active: 'home',
        description: 'Meowist is a Discord bot for moderation, appeals, automod, tickets and community tools.',
        body: html`<section class="hero"><div class="wrap"><p class="eyebrow">Discord bot</p>
<h1>Moderation that explains itself.</h1>
<p class="lead">Meowist keeps a Discord server calm: clear enforcement with case codes and DMs, a warning ladder members can understand, appeals that reach a person, automod, tickets and the community features around them.</p>
<p class="hero-actions">${addButton(ctx)}<a class="button${ctx.publicSite && ctx.installUrl ? ' button-quiet' : ''}" href="/commands">See the commands</a>${ctx.dashboardEnabled ? html`<a class="button button-quiet" href="${DASHBOARD_PATH}">Open the dashboard</a>` : ''}${support}</p>
${ctx.publicSite ? '' : html`<p class="note">Meowist runs on its own server for now; it can’t be added to other servers yet.</p>`}</div></section>
<section class="features" aria-labelledby="features-title"><div class="wrap"><h2 id="features-title">What it does</h2>
<ul class="feature-grid">${FEATURES.map((f) => html`<li class="feature"><h3>${f.title}</h3><p>${f.text}</p></li>`)}</ul></div></section>
<section class="strip" aria-labelledby="access-title"><div class="wrap"><h2 id="access-title">Who can do what</h2>
<p>Everyday commands (help, rank, leaderboard, fun, to-do lists, reports…) are open to every member. Anything that moderates, changes settings or affects other members needs the Administrator role, and is checked again each time it runs.</p></div></section>`,
    });
}

const CATEGORY_LABEL = {
    Core: 'General', Community: 'Community', Leveling: 'Leveling', Fun: 'Fun', Birthday: 'Birthdays',
    Utility: 'Utility', Tools: 'Tools', Search: 'Search', Verification: 'Verification', Ticket: 'Tickets',
};
const CATEGORY_ORDER = ['Core', 'Community', 'Leveling', 'Fun', 'Birthday', 'Utility', 'Tools', 'Search', 'Verification', 'Ticket'];
// Everyone-commands that narrow access inside the command (commandAccess.js header comment).
const NARROWED = {
    claim: 'Ticket staff', priority: 'Ticket staff', 'modmail close': 'Ticket staff',
    'canned send': 'Ticket staff', 'canned list': 'Ticket staff', close: 'Ticket staff or the ticket opener',
};

/**
 * The everyone-commands, grouped by command category: [{ label, items: [{ key, description, slash, note }] }].
 * Descriptions come from the loaded commands; before they are loaded the keys are listed alone.
 */
export function everyoneCommandGroups(commands) {
    const groups = new Map();
    const push = (category, item) => {
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(item);
    };
    const seen = new Set();
    for (const [name, command] of commands?.entries?.() || []) {
        const json = typeof command?.data?.toJSON === 'function' ? command.data.toJSON() : null;
        const menu = json?.type === 2 || json?.type === 3;
        for (const entry of commandEntries(new Map([[name, command]]))) {
            if (entry.access !== 'everyone' || seen.has(entry.key)) continue;
            seen.add(entry.key);
            const category = menu ? 'Menus' : (command.category || 'Other');
            push(category, { key: entry.key, description: menu ? `Right-click ${json.type === 3 ? 'a message' : 'a member'} → Apps → ${entry.key}` : entry.description, slash: !menu, note: NARROWED[entry.key] || '' });
        }
    }
    if (!seen.size) {
        for (const key of EVERYONE_COMMANDS) push('Other', { key, description: '', slash: true, note: NARROWED[key] || '' });
    }
    const rank = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i === -1 ? CATEGORY_ORDER.length + (c === 'Menus' ? 0 : 1) : i; };
    return [...groups.entries()]
        .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
        .map(([category, items]) => ({
            key: category.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            label: category === 'Menus' ? 'Right-click menus' : (CATEGORY_LABEL[category] || category.replace(/_/g, ' ')),
            items: items.sort((a, b) => a.key.localeCompare(b.key)),
        }));
}

export function commandsPage(ctx) {
    const groups = everyoneCommandGroups(ctx.commands);
    return layout(ctx, {
        title: 'Commands', active: 'commands',
        description: 'The Meowist commands every member can use.',
        body: html`<div class="wrap page"><h1>Commands</h1>
<p class="lead">The commands every member can use. Staff tools live on the dashboard and need the Administrator role.</p>
${groups.length > 1 ? html`<nav class="jump" aria-label="Command groups"><ul>${groups.map((g) => html`<li><a href="#c-${g.key}">${g.label}</a></li>`)}</ul></nav>` : ''}
${groups.map((g) => html`<section class="cmd-group" id="c-${g.key}" aria-labelledby="h-${g.key}"><h2 id="h-${g.key}">${g.label}</h2>
<dl class="cmd-list">${g.items.map((c) => html`<div class="cmd"><dt><code>${c.slash ? `/${c.key}` : c.key}</code>${c.note ? html` <span class="tag">${c.note}</span>` : ''}</dt><dd>${c.description || ' '}</dd></div>`)}</dl></section>`)}</div>`,
    });
}

export function aboutPage(ctx) {
    return layout(ctx, {
        title: 'About', active: 'about',
        description: 'About Meowist, the Discord bot of the Meowist server.',
        body: html`<div class="wrap page prose"><h1>About Meowist</h1>
<p class="lead">Meowist is the bot of the Meowist Discord server, built and run by its owner for that community.</p>
<h2>How it started</h2>
<p>Meowist began as a fork of TitanBot, an open-source (MIT) Discord bot, and has since been rebuilt around the server’s own needs: an enforcement system with case codes and appeals, a warning ladder, automod, tickets and modmail, and a web dashboard for the staff team.</p>
<h2>How it treats members</h2>
<ul><li>Every punishment comes with a DM that says what happened, why, until when, and whether and how it can be appealed.</li>
<li>Staff actions are recorded as cases, so decisions can be reviewed and corrected.</li>
<li>Verification asks Discord only for your identity and permission to add you to the support server, never your email.</li>
<li>Members can delete their own data from the bot in a server with <code>/wipedata</code>.</li></ul>
<h2>Availability</h2>
<p>${ctx.publicSite ? 'Meowist can be added to other servers with the button at the top of the page.' : 'For now Meowist runs only on its own server; it can’t be added to other servers yet.'}</p>
<h2>Get help</h2>
<p>${ctx.supportInvite ? html`Questions, appeals or problems: <a href="${ctx.supportInvite}" rel="noopener">join the support server</a>.` : 'Ask the staff team on the Meowist server.'}</p></div>`,
    });
}

export function notFoundPage(ctx) {
    return layout(ctx, {
        title: 'Not found',
        body: html`<div class="wrap page"><h1>Page not found</h1><p class="lead">There is no such page.</p><p><a class="button" href="/">Go to the home page</a></p></div>`,
    });
}

// ── Router ────────────────────────────────────────────────────────────────

/**
 * The front-site router. `client` gives the loaded commands (read per request: the web server
 * starts before the commands load); `support()` the current support invite (a settings getter).
 */
export function createSite({ client = null, env = process.env, dashboardEnabled = false, memberPortalEnabled = false, supportInvite = () => null } = {}) {
    const router = express.Router();
    const publicSite = publicSiteEnabled(env);
    const base = {
        publicSite,
        dashboardEnabled: Boolean(dashboardEnabled),
        memberPortal: Boolean(memberPortalEnabled),
        installUrl: installUrl(env.CLIENT_ID),
        mainInvite: inviteOrNull(env.MAIN_SERVER_INVITE),
    };
    const context = () => {
        let support = null;
        try { support = inviteOrNull(supportInvite()); } catch { support = null; }
        return { ...base, supportInvite: support, commands: client?.commands || null };
    };

    router.use((req, res, next) => {
        res.set(SECURITY_HEADERS);
        if (!publicSite) res.set('X-Robots-Tag', NOINDEX);
        next();
    });
    const page = (render) => (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.status(200).type('html').send(render(context()));
    };
    router.get('/', page(homePage));
    router.get('/commands', page(commandsPage));
    router.get('/about', page(aboutPage));
    router.get('/robots.txt', (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.type('text/plain').send(publicSite ? 'User-agent: *\nDisallow: /dashboard\nDisallow: /oauth\n' : 'User-agent: *\nDisallow: /\n');
    });
    router.get('/favicon.svg', (req, res) => {
        res.set('Cache-Control', 'public, max-age=86400');
        res.status(200).type('image/svg+xml').send(FAVICON_SVG);
    });
    router.get('/site.css', (req, res) => {
        res.set('Cache-Control', 'public, max-age=3600');
        res.status(200).type('text/css').send(STYLESHEET);
    });
    // Last: any other GET is a plain 404 page (the API and dashboard routes are registered before).
    router.get(/.*/, (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.status(404).type('html').send(notFoundPage(context()));
    });
    return router;
}

/** Mounts the front site at the root of `app` (after /health, /ready, OAuth and the dashboard). */
export function registerSite(app, client, { env = process.env, dashboardEnabled = false, memberPortalEnabled = false, supportInvite } = {}) {
    app.use(createSite({ client, env, dashboardEnabled, memberPortalEnabled, supportInvite }));
    logger.info(`Front site at / (${publicSiteEnabled(env) ? 'public' : 'not public: noindex, no add button (PUBLIC_SITE_ENABLED)'})`);
}
