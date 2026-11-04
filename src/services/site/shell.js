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
import { logger } from '../../utils/logger.js';
import { textOf } from './i18n.js';

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
 * The site's own origin from PUBLIC_URL ("https://mewvo.example"), or null when it is not
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

// The owner's logo (static/img/logo.png, 64×64: the white cat on a black tile). The ?v= hash
// changes with the file, so the week-long /img cache never shows an old logo.
// Decorative where it is used: the name "Mewvo" is always next to it.
export const LOGO_FILE = new URL('./static/img/logo.png', import.meta.url);
function logoVersion() {
    try {
        return createHash('sha256').update(readFileSync(LOGO_FILE)).digest('hex').slice(0, 10);
    } catch (error) {
        logger.error(`Site logo missing: ${error.message}`);
        return '0';
    }
}
export const LOGO_PATH = `/img/logo.png?v=${logoVersion()}`;
export const LOGO = raw(`<img class="logo" src="${LOGO_PATH}" width="28" height="28" alt="">`);
/** The browser-tab icon (the same PNG); the dashboard links it too. */
export const FAVICON_PATH = '/favicon.png';

/** aria-current="page" when `key` is the active page. */
export const currentIf = (active) => (key) => (key === active ? raw(' aria-current="page"') : '');

/** The top-bar links. "My record" only when the member portal is on. */
function navLinks(ctx, active) {
    const { t } = textOf(ctx);
    const current = currentIf(active);
    return html`<li><a href="/features"${current('features')}>${t('shell.links.features')}</a></li>
<li><a href="/pricing"${current('pricing')}>${t('shell.links.pricing')}</a></li>
<li><a href="/docs"${current('docs')}>${t('shell.links.docs')}</a></li>
<li><a href="/commands"${current('commands')}>${t('shell.links.commands')}</a></li>
<li><a href="/leaderboard"${current('leaderboard')}>${t('shell.links.leaderboard')}</a></li>
${ctx.memberPortal ? html`<li><a href="/me"${current('me')}>${t('shell.links.myRecord')}</a></li>` : ''}`;
}

/** The footer: link columns (Product, Help, Community, Legal); invites only when set. */
function footerColumns(ctx, active) {
    const { t } = textOf(ctx);
    const current = currentIf(active);
    const col = (title, links) => html`<div><p class="footer-title">${title}</p><ul class="footer-links">${links}</ul></div>`;
    return html`<div class="footer-cols">${col(t('shell.footer.columns.product'), html`<li><a href="/features"${current('features')}>${t('shell.links.features')}</a></li>
<li><a href="/pricing"${current('pricing')}>${t('shell.links.pricing')}</a></li>
<li><a href="/commands"${current('commands')}>${t('shell.links.commands')}</a></li>
<li><a href="/changelog"${current('changelog')}>${t('shell.links.changelog')}</a></li>
${ctx.dashboardEnabled ? html`<li><a href="${DASHBOARD_PATH}">${t('shell.links.dashboard')}</a></li>` : ''}`)}
${col(t('shell.footer.columns.help'), html`<li><a href="/docs"${current('docs')}>${t('shell.links.docs')}</a></li>
<li><a href="/faq"${current('faq')}>${t('shell.links.faq')}</a></li>
<li><a href="/status"${current('status')}>${t('shell.links.status')}</a></li>
${ctx.supportInvite ? html`<li><a href="${ctx.supportInvite}" rel="noopener">${t('shell.links.supportServer')}</a></li>` : ''}`)}
${col(t('shell.footer.columns.community'), html`<li><a href="/leaderboard"${current('leaderboard')}>${t('shell.links.leaderboard')}</a></li>
<li><a href="/rules"${current('rules')}>${t('shell.links.rules')}</a></li>
${ctx.transparency ? html`<li><a href="/transparency"${current('transparency')}>${t('shell.links.transparency')}</a></li>` : ''}
${ctx.trustCard ? html`<li><a href="/trust"${current('trust')}>${t('shell.links.trustCard')}</a></li>` : ''}
${ctx.memberPortal ? html`<li><a href="/me"${current('me')}>${t('shell.links.myRecord')}</a></li>` : ''}
${ctx.mainInvite ? html`<li><a href="${ctx.mainInvite}" rel="noopener">${t('shell.links.ourServer')}</a></li>` : ''}`)}
${col(t('shell.footer.columns.legal'), html`<li><a href="/about"${current('about')}>${t('shell.links.about')}</a></li>
<li><a href="/privacy"${current('privacy')}>${t('shell.links.privacy')}</a></li>
<li><a href="/terms"${current('terms')}>${t('shell.links.terms')}</a></li>
<li><a href="/legal"${current('legal')}>${t('shell.links.legalNotice')}</a></li>
<li><a href="/contact"${current('contact')}>${t('shell.links.contact')}</a></li>`)}</div>`;
}

/**
 * The way in for members (only when /me is on). Logged out: "Log in" (→ /me, which offers
 * Discord or a Mewvo account) and "Sign up" when Mewvo accounts are on. Logged in (only /me
 * pages know: the session cookie is scoped to /me): the name with a menu, no script needed.
 */
function memberActions(ctx) {
    if (!ctx.memberPortal) return '';
    const { t } = textOf(ctx);
    const v = ctx.viewer;
    if (!v) {
        return html`<a class="button button-quiet" href="/me">${t('shell.account.logIn')}</a>${ctx.accounts ? html`<a class="button" href="/me/signup">${t('shell.account.signUp')}</a>` : ''}`;
    }
    return html`<details class="account-menu"><summary class="account-chip">${LOGO}<span class="account-name">${v.name}</span></summary>
<div class="account-pop"><a href="/me">${t('shell.links.myRecord')}</a>${v.accountId ? html`<a href="/me/account">${t('shell.account.settings')}</a>` : ''}${ctx.billing ? html`<a href="/me/billing">${t('shell.account.subscription')}</a>` : ''}
<form method="post" action="/me/logout"><input type="hidden" name="csrf" value="${v.csrf}"><button type="submit">${t('shell.account.logOut')}</button></form></div></details>`;
}

/** "Add to Discord": only when the site is public and CLIENT_ID is valid. */
export function addButton(ctx, className = 'button') {
    return ctx.publicSite && ctx.installUrl
        ? html`<a class="${className}" href="${ctx.installUrl}" rel="noopener" data-add-bot>${textOf(ctx).t('shell.install.addToDiscord')}</a>`
        : '';
}

// The default share image; its alt text is shell.meta.shareImageAlt, the default description
// shell.meta.defaultDescription.
const DEFAULT_IMAGE = Object.freeze({ path: '/img/og.png', width: 1200, height: 630, large: true });

/** "Features · Mewvo"; the front page's title is the name alone. */
function fullTitle(ctx, title) {
    const { t } = textOf(ctx);
    return title === t('common.brand') ? title : t('shell.meta.pageTitle', { title });
}

/**
 * canonical + Open Graph / Twitter tags: only with a known origin (PUBLIC_URL), never a guessed host.
 * `image` ({ path, width, height, alt, large }) replaces the default share image (og.png);
 * `large: false` asks for the small square Twitter card.
 */
function shareTags(ctx, { title, description, path, image = null }) {
    if (!ctx.origin || typeof path !== 'string') return '';
    const { t } = textOf(ctx);
    const url = `${ctx.origin}${path}`;
    const full = fullTitle(ctx, title);
    const text = description || t('shell.meta.defaultDescription');
    const img = image && typeof image.path === 'string' && image.path.startsWith('/') ? image : { ...DEFAULT_IMAGE, alt: t('shell.meta.shareImageAlt') };
    const imageUrl = `${ctx.origin}${img.path}`;
    return html`
<link rel="canonical" href="${url}">
<meta property="og:type" content="website"><meta property="og:site_name" content="${t('common.brand')}"><meta property="og:title" content="${full}">
<meta property="og:description" content="${text}"><meta property="og:url" content="${url}"><meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="${String(img.width)}"><meta property="og:image:height" content="${String(img.height)}"><meta property="og:image:alt" content="${img.alt}">
<meta name="twitter:card" content="${img.large === false ? 'summary' : 'summary_large_image'}"><meta name="twitter:title" content="${full}"><meta name="twitter:description" content="${text}"><meta name="twitter:image" content="${imageUrl}">`;
}

/**
 * The page shell. `path` (the page's own path, e.g. "/features") turns on the canonical and
 * share tags when PUBLIC_URL is set. `refresh` (seconds) adds a <meta http-equiv="refresh">:
 * the status page reloads itself without a script. `image` overrides the share image (shareTags).
 */
export function layout(ctx, { title, active = null, description = '', refresh = 0, path = null, image = null, body }) {
    // The way into the dashboard: a filled button unless "Add to Discord" is shown.
    // The dashboard: a filled button unless "Add to Discord" or the member buttons are shown.
    const { t, lang } = textOf(ctx);
    const brand = t('common.brand');
    const quiet = (ctx.publicSite && ctx.installUrl) || ctx.memberPortal;
    const login = ctx.dashboardEnabled ? html`<a class="button${quiet ? ' button-quiet' : ''}" href="${DASHBOARD_PATH}">${t('shell.links.dashboard')}</a>` : '';
    return html`<!doctype html><html lang="${lang || 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#1e1f22">${ctx.publicSite ? '' : html`<meta name="robots" content="${NOINDEX}">`}
<title>${fullTitle(ctx, title)}</title>${refresh > 0 ? html`<meta http-equiv="refresh" content="${Math.floor(refresh)}">` : ''}${description ? html`<meta name="description" content="${description}">` : ''}${shareTags(ctx, { title, description, path, image })}
<link rel="icon" href="${FAVICON_PATH}" type="image/png" sizes="64x64"><link rel="stylesheet" href="${CSS_PATH}"></head>
<body><a class="skip" href="#main">${t('shell.header.skip')}</a>
<header class="topbar"><div class="wrap topbar-inner"><a class="brand" href="/"${active === 'home' ? raw(' aria-current="page"') : ''}>${LOGO}<span>${brand}</span></a>
<nav class="topnav" aria-label="${t('shell.header.navLabel')}"><ul>${navLinks(ctx, active)}</ul></nav>
<div class="topbar-actions">${addButton(ctx)}${login}${memberActions(ctx)}</div></div></header>
<main id="main" tabindex="-1">${body}</main>
<footer class="footer"><div class="wrap"><div class="footer-top"><div><p class="footer-brand">${LOGO}<span>${brand}</span></p>
<p class="footer-text">${t('shell.footer.tagline')}</p></div>
<nav class="footer-nav" aria-label="${t('shell.footer.navLabel')}">${footerColumns(ctx, active)}</nav></div>
<p class="footer-legal">${t('shell.footer.legalLine')}</p></div></footer>
</body></html>`.text;
}
