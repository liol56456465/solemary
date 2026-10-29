// shell.js — what every front-site page shares: the security headers, the install link,
// the stylesheet, the logo, the page shell (head, top bar, footer) and the absolute URLs
// for canonical / Open Graph tags. site.js re-exports everything here (memberPortal.js and
// the tests import it from there); the page files under ./pages import it from here.
//
// The site has its own colour tokens (top of static/site.css, light and dark by device):
// near-white / near-black and one accent. tests/siteContrast.test.js checks the pairs.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PermissionFlagsBits } from 'discord.js';
import { html, raw } from '../dashboard/html.js';
import { CAT_PATH } from '../dashboard/icons.js';
import { logger } from '../../utils/logger.js';

export const DASHBOARD_PATH = '/dashboard';

export const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'none'; img-src 'self'; "
        + "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
};
export const NOINDEX = 'noindex, nofollow';

/**
 * What the bot needs in a new server (the "Add to Discord" link): no Administrator.
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

/**
 * The site's own origin from PUBLIC_URL ("https://meowist.example"), or null when it is not
 * set or not an http(s) URL. Used only for absolute URLs (canonical, Open Graph, sitemap):
 * nothing in the site hard-codes a host, so a new domain is one env change.
 */
export function siteOrigin(env = process.env) {
    const text = String(env.PUBLIC_URL || '').trim();
    if (!text) return null;
    try {
        const url = new URL(text);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        if (url.username || url.password) return null;
        return url.origin;
    } catch {
        return null;
    }
}

// The stylesheet: the site's own tokens and layout, one file, cached with a content hash.
function buildStylesheet() {
    try {
        return readFileSync(new URL('./static/site.css', import.meta.url), 'utf8');
    } catch (error) {
        logger.error(`Site stylesheet missing: ${error.message}`);
        return '';
    }
}
export const STYLESHEET = buildStylesheet();
export const CSS_PATH = `/site.css?v=${createHash('sha256').update(STYLESHEET).digest('hex').slice(0, 10)}`;

// The Meowist cat (fill = currentColor, follows the theme). Decorative: the name is next to it.
export const LOGO = raw(`<svg class="logo" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="${CAT_PATH}"/></svg>`);

// The browser-tab icon: the owner's logo, a white cat on black.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#000"/><path fill="#fff" fill-rule="evenodd" d="${CAT_PATH}"/></svg>`;

/** aria-current="page" when `key` is the active page. */
export const currentIf = (active) => (key) => (key === active ? raw(' aria-current="page"') : '');

/** The top-bar links. "My record" only when the member portal is on. */
function navLinks(ctx, active) {
    const current = currentIf(active);
    return html`<li><a href="/features"${current('features')}>Features</a></li>
<li><a href="/pricing"${current('pricing')}>Pricing</a></li>
<li><a href="/docs"${current('docs')}>Docs</a></li>
<li><a href="/commands"${current('commands')}>Commands</a></li>
<li><a href="/leaderboard"${current('leaderboard')}>Leaderboard</a></li>
${ctx.memberPortal ? html`<li><a href="/me"${current('me')}>My record</a></li>` : ''}`;
}

/** The footer columns: Product / Resources / Legal / Community (invites only when set). */
function footerColumns(ctx, active) {
    const current = currentIf(active);
    const column = (title, items) => html`<div class="footer-col"><h2 class="footer-title">${title}</h2><ul>${items}</ul></div>`;
    return html`${column('Product', html`<li><a href="/features"${current('features')}>Features</a></li>
<li><a href="/pricing"${current('pricing')}>Pricing</a></li>
<li><a href="/commands"${current('commands')}>Commands</a></li>
<li><a href="/leaderboard"${current('leaderboard')}>Leaderboard</a></li>
${ctx.dashboardEnabled ? html`<li><a href="${DASHBOARD_PATH}">Dashboard</a></li>` : ''}`)}
${column('Resources', html`<li><a href="/docs"${current('docs')}>Docs</a></li>
<li><a href="/faq"${current('faq')}>FAQ</a></li>
<li><a href="/status"${current('status')}>Status</a></li>
${ctx.transparency ? html`<li><a href="/transparency"${current('transparency')}>Transparency</a></li>` : ''}
<li><a href="/about"${current('about')}>About</a></li>`)}
${column('Legal', html`<li><a href="/privacy"${current('privacy')}>Privacy</a></li>
<li><a href="/terms"${current('terms')}>Terms</a></li>`)}
${ctx.mainInvite || ctx.supportInvite || ctx.memberPortal ? column('Community', html`${ctx.mainInvite ? html`<li><a href="${ctx.mainInvite}" rel="noopener">Our server</a></li>` : ''}
${ctx.supportInvite ? html`<li><a href="${ctx.supportInvite}" rel="noopener">Support server</a></li>` : ''}
${ctx.memberPortal ? html`<li><a href="/me"${current('me')}>My record</a></li>` : ''}`) : ''}`;
}

/** "Add to Discord": only when the site is public and CLIENT_ID is valid. */
export function addButton(ctx, className = 'button') {
    return ctx.publicSite && ctx.installUrl
        ? html`<a class="${className}" href="${ctx.installUrl}" rel="noopener" data-add-bot>Add to Discord</a>`
        : '';
}

const DEFAULT_DESCRIPTION = 'Meowist is a Discord bot for moderation with case codes, a warning ladder, appeals, automod, tickets and community tools.';

/** canonical + Open Graph / Twitter tags: only with a known origin (PUBLIC_URL), never a guessed host. */
function shareTags(ctx, { title, description, path }) {
    if (!ctx.origin || typeof path !== 'string') return '';
    const url = `${ctx.origin}${path}`;
    const fullTitle = title === 'Meowist' ? 'Meowist' : `${title} · Meowist`;
    const text = description || DEFAULT_DESCRIPTION;
    const image = `${ctx.origin}/img/og.png`;
    return html`
<link rel="canonical" href="${url}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Meowist"><meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${text}"><meta property="og:url" content="${url}"><meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Meowist: Discord moderation with case codes, a warning ladder and appeals.">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${fullTitle}"><meta name="twitter:description" content="${text}"><meta name="twitter:image" content="${image}">`;
}

/**
 * The page shell. `path` (the page's own path, e.g. "/features") turns on the canonical and
 * share tags when PUBLIC_URL is set. `refresh` (seconds) adds a <meta http-equiv="refresh">:
 * the status page reloads itself without a script.
 */
export function layout(ctx, { title, active = null, description = '', refresh = 0, path = null, body }) {
    // The way into the dashboard: a filled button unless "Add to Discord" is shown.
    const login = ctx.dashboardEnabled ? html`<a class="button${ctx.publicSite && ctx.installUrl ? ' button-quiet' : ''}" href="${DASHBOARD_PATH}">Dashboard</a>` : '';
    return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">${ctx.publicSite ? '' : html`<meta name="robots" content="${NOINDEX}">`}
<title>${title === 'Meowist' ? 'Meowist' : `${title} · Meowist`}</title>${refresh > 0 ? html`<meta http-equiv="refresh" content="${Math.floor(refresh)}">` : ''}${description ? html`<meta name="description" content="${description}">` : ''}${shareTags(ctx, { title, description, path })}
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${CSS_PATH}"></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="topbar"><div class="wrap topbar-inner"><a class="brand" href="/"${active === 'home' ? raw(' aria-current="page"') : ''}>${LOGO}<span>Meowist</span></a>
<nav class="topnav" aria-label="Main"><ul>${navLinks(ctx, active)}</ul></nav>
<div class="topbar-actions">${addButton(ctx)}${login}</div></div></header>
<main id="main" tabindex="-1">${body}</main>
<footer class="footer"><div class="wrap"><div class="footer-grid"><div class="footer-about"><p class="footer-brand">${LOGO}<span>Meowist</span></p>
<p class="footer-text">A Discord bot for moderation, appeals and community tools. Built and run by its owner for the Meowist server.</p></div>
<nav class="footer-nav" aria-label="Footer">${footerColumns(ctx, active)}</nav></div>
<p class="footer-legal">Meowist is not affiliated with Discord. Prices on this site are in euros.</p></div></footer>
</body></html>`.text;
}
