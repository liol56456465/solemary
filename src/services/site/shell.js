// shell.js — what every front-site page shares: the security headers, the install link,
// the stylesheet, the logo, the page shell (head, top bar, footer) and the absolute URLs
// for canonical / Open Graph tags. site.js re-exports everything here (memberPortal.js and
// the tests import it from there); the page files under ./pages import it from here.
//
// The site has its own colour tokens (top of static/site.css): dark gray and white only, the same
// look whatever the device's colour scheme. tests/siteContrast.test.js checks the pairs.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PermissionFlagsBits } from 'discord.js';
import { html, raw } from '../dashboard/html.js';
import { logger } from '../../utils/logger.js';
import {
    DEFAULT_LANG, LANGUAGES, isEnglishOnlyPath, isPagePath, localizePath, textOf, translatedIn, translator,
} from './i18n.js';

export const DASHBOARD_PATH = '/dashboard';

export const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; "
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

/** Where Discord sends the admin back after adding the bot (site.js GET /added). */
export const ADDED_PATH = '/added';

/**
 * The OAuth2 install link for CLIENT_ID, or null when the id is missing or malformed.
 * With `redirectUri` (an absolute http(s) URL, see installRedirectUri) it also asks Discord to
 * send the admin back: response_type=code + redirect_uri. Discord then adds the bot and
 * redirects to `redirectUri?code=…&guild_id=…&permissions=…` (Advanced Bot Authorization,
 * discord-api-docs topics/oauth2), or `?error=access_denied` when the admin cancels. The code is
 * never exchanged and guild_id is only a hint, so /added uses it for a link and nothing else.
 * The redirect URI must be registered under OAuth2 → Redirects in the Developer Portal, or
 * Discord refuses the whole link; that is why it is opt-in (INSTALL_REDIRECT_ENABLED).
 */
export function installUrl(clientId, { redirectUri = null } = {}) {
    const id = String(clientId || '').trim();
    if (!SNOWFLAKE.test(id)) return null;
    const params = new URLSearchParams({ client_id: id, permissions: installPermissionBits().toString(), scope: 'bot applications.commands' });
    if (typeof redirectUri === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(redirectUri)) {
        params.set('response_type', 'code');
        params.set('redirect_uri', redirectUri);
    }
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/**
 * `${PUBLIC_URL}/added` when INSTALL_REDIRECT_ENABLED is "true" and PUBLIC_URL is set, else null
 * (the install link then has no redirect and Discord shows its own "added" screen).
 */
export function installRedirectUri(env = process.env) {
    if (!/^(1|true|yes|on)$/i.test(String(env.INSTALL_REDIRECT_ENABLED || '').trim())) return null;
    const origin = siteOrigin(env);
    return origin ? `${origin}${ADDED_PATH}` : null;
}

/** The site's "Add to Discord" link for this environment (with the /added redirect when enabled). */
export function siteInstallUrl(env = process.env) {
    return installUrl(env.CLIENT_ID, { redirectUri: installRedirectUri(env) });
}

/** True for a Discord snowflake ("123456789012345678"); /added only links with one. */
export function isSnowflakeText(value) {
    return typeof value === 'string' && SNOWFLAKE.test(value);
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

/**
 * The dashboard link for one server (/setup, the join welcome, retired commands), or null without
 * PUBLIC_URL. The one place that builds it: `${PUBLIC_URL}/dashboard/<guildId>` for every server
 * (multi-server B3; the Support server's id redirects to the main server there), and
 * `${PUBLIC_URL}/dashboard` (the server picker) when no valid server id is given.
 */
export function dashboardUrlFor(guildId, env = process.env) {
    const origin = siteOrigin(env);
    if (!origin) return null;
    const id = String(guildId ?? '').trim();
    return SNOWFLAKE.test(id) ? `${origin}${DASHBOARD_PATH}/${id}` : `${origin}${DASHBOARD_PATH}`;
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
export const CSS_VERSION = createHash('sha256').update(STYLESHEET).digest('hex').slice(0, 10);
export const CSS_PATH = `/site.css?v=${CSS_VERSION}`;

// The one script (static/site.js): closes the header menus on an outside tap or Escape, keeps one
// open at a time, closes a menu when one of its links is tapped. Optional: pages work without it.
function buildScript() {
    try {
        return readFileSync(new URL('./static/site.js', import.meta.url), 'utf8');
    } catch (error) {
        logger.error(`Site script missing: ${error.message}`);
        return '';
    }
}
export const SCRIPT = buildScript();
export const JS_VERSION = createHash('sha256').update(SCRIPT).digest('hex').slice(0, 10);
export const JS_PATH = `/site.js?v=${JS_VERSION}`;

/**
 * Cache-Control for a hashed asset: the URL with the current ?v= never changes content, so it is
 * cached for a year (immutable); any other ?v= (or none) for an hour.
 */
export function assetCacheControl(requested, current) {
    return typeof requested === 'string' && requested === current ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}

// The owner's logo (static/img/logo.png, 64×64). The ?v= hash follows the bundled file; the logo is
// a replaceable image (Owner → Website → Images, siteImages.js), served at the same path and cached
// 5 minutes, so a replaced logo shows within minutes without a new hash.
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

// Portal dates (My record, appeals, account): day, month, year and time in the page's language, UTC.
export const PORTAL_DATE_TIME = Object.freeze({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });

/** A <time> in the page's language (ctx.fmtDate), or "-" for a missing or invalid date. */
export function portalTime(ctx, value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '-';
    return html`<time datetime="${date.toISOString()}">${textOf(ctx).fmtDate(date, PORTAL_DATE_TIME)}</time>`;
}

/** aria-current="page" when `key` is the active page. */
export const currentIf = (active) => (key) => (key === active ? raw(' aria-current="page"') : '');

/** The top-bar links. "My record" only when the member portal is on. */
function navLinks(ctx, active) {
    const { t, href } = textOf(ctx);
    const current = currentIf(active);
    return html`<li><a href="${href('/features')}"${current('features')}>${t('shell.links.features')}</a></li>
<li><a href="${href('/pricing')}"${current('pricing')}>${t('shell.links.pricing')}</a></li>
<li><a href="${href('/docs')}"${current('docs')}>${t('shell.links.docs')}</a></li>
<li><a href="${href('/commands')}"${current('commands')}>${t('shell.links.commands')}</a></li>
<li><a href="${href('/leaderboard')}"${current('leaderboard')}>${t('shell.links.leaderboard')}</a></li>
${ctx.memberPortal ? html`<li><a href="/me"${current('me')}>${t('shell.links.myRecord')}</a></li>` : ''}`;
}

/** The footer: link columns (Product, Help, Community, Legal); invites only when set. */
function footerColumns(ctx, active) {
    const { t, href } = textOf(ctx);
    const current = currentIf(active);
    const col = (title, links) => html`<div><p class="footer-title">${title}</p><ul class="footer-links">${links}</ul></div>`;
    return html`<div class="footer-cols">${col(t('shell.footer.columns.product'), html`<li><a href="${href('/features')}"${current('features')}>${t('shell.links.features')}</a></li>
<li><a href="${href('/pricing')}"${current('pricing')}>${t('shell.links.pricing')}</a></li>
<li><a href="${href('/commands')}"${current('commands')}>${t('shell.links.commands')}</a></li>
<li><a href="${href('/changelog')}"${current('changelog')}>${t('shell.links.changelog')}</a></li>
${ctx.dashboardEnabled ? html`<li><a href="${DASHBOARD_PATH}">${t('shell.links.dashboard')}</a></li>` : ''}`)}
${col(t('shell.footer.columns.help'), html`<li><a href="${href('/docs')}"${current('docs')}>${t('shell.links.docs')}</a></li>
<li><a href="${href('/faq')}"${current('faq')}>${t('shell.links.faq')}</a></li>
<li><a href="${href('/admins')}"${current('admins')}>${t('shell.links.admins')}</a></li>
<li><a href="${href('/status')}"${current('status')}>${t('shell.links.status')}</a></li>
${ctx.supportInvite ? html`<li><a href="${ctx.supportInvite}" rel="noopener">${t('shell.links.supportServer')}</a></li>` : ''}`)}
${col(t('shell.footer.columns.community'), html`<li><a href="${href('/leaderboard')}"${current('leaderboard')}>${t('shell.links.leaderboard')}</a></li>
<li><a href="${href('/rules')}"${current('rules')}>${t('shell.links.rules')}</a></li>
${ctx.transparency ? html`<li><a href="${href('/transparency')}"${current('transparency')}>${t('shell.links.transparency')}</a></li>` : ''}
${ctx.trustCard ? html`<li><a href="${href('/trust')}"${current('trust')}>${t('shell.links.trustCard')}</a></li>` : ''}
${ctx.memberPortal ? html`<li><a href="/me"${current('me')}>${t('shell.links.myRecord')}</a></li>` : ''}
${ctx.mainInvite ? html`<li><a href="${ctx.mainInvite}" rel="noopener">${t('shell.links.ourServer')}</a></li>` : ''}`)}
${col(t('shell.footer.columns.legal'), html`<li><a href="${href('/about')}"${current('about')}>${t('shell.links.about')}</a></li>
<li><a href="${href('/privacy')}"${current('privacy')}>${t('shell.links.privacy')}</a></li>
<li><a href="${href('/terms')}"${current('terms')}>${t('shell.links.terms')}</a></li>
<li><a href="${href('/legal')}"${current('legal')}>${t('shell.links.legalNotice')}</a></li>
<li><a href="${href('/contact')}"${current('contact')}>${t('shell.links.contact')}</a></li>`)}</div>`;
}

/**
 * The way in for members (only when /me is on). Logged out: "Log in" (→ /me, which offers
 * Discord or a Mewvo account) and "Sign up" when Mewvo accounts are on. Logged in (only /me
 * pages know: the session cookie is scoped to /me): the name with a menu, no script needed.
 */
function memberActions(ctx, { addShown = false } = {}) {
    if (!ctx.memberPortal) return '';
    const { t } = textOf(ctx);
    const v = ctx.viewer;
    if (!v) {
        // Phones: with "Add to Discord" shown, that one stays and "Log in" moves out of the bar
        // (My record in the menu leads to the same log-in page); else "Log in" stays (short label).
        // "Sign up" is one tap further, on the log-in page.
        return html`${topButton(`button button-quiet${addShown ? ' topbar-more' : ''}`, '/me', t('shell.account.logIn'), t('shell.short.logIn'))}${ctx.accounts ? html`<a class="button topbar-more" href="/me/signup">${t('shell.account.signUp')}</a>` : ''}`;
    }
    return html`<details class="account-menu"><summary class="account-chip">${LOGO}<span class="account-name">${v.name}</span></summary>
<div class="account-pop"><a href="/me">${t('shell.links.myRecord')}</a>${v.accountId ? html`<a href="/me/account">${t('shell.account.settings')}</a>` : ''}${ctx.billing ? html`<a href="/me/billing">${t('shell.account.subscription')}</a>` : ''}
<form method="post" action="/me/logout"><input type="hidden" name="csrf" value="${v.csrf}"><button type="submit">${t('shell.account.logOut')}</button></form></div></details>`;
}

/**
 * A top-bar button. With a different short label (shell.short.*) both are in the link: phones show
 * the short one (aria-hidden) and keep the full one for screen readers (site.css, .label-long).
 */
function topButton(className, href, label, short, extra = '') {
    if (!short || short === label) return html`<a class="${className}" href="${href}"${raw(extra)}>${label}</a>`;
    return html`<a class="${className}" href="${href}"${raw(extra)}><span class="label-long">${label}</span><span class="label-short" aria-hidden="true">${short}</span></a>`;
}

/**
 * The phone menu (≤ 760px; hidden above, site.css): a ☰ button that opens a panel under the bar
 * (details, no script needed). Phones keep the brand, one button and this menu in one row; the
 * panel holds everything the bar hides there: the account buttons (Log in / Sign up), Dashboard,
 * Add to Discord when the account chip took its place, the page links and the languages.
 * What stays in the bar (topbarParts / memberActions) is not repeated here.
 */
function phoneMenu(ctx, here, active, { add, member }) {
    const { t } = textOf(ctx);
    const viewer = member ? ctx.viewer : null;
    const loggedOut = member && !viewer;
    // Phones show the first of: account chip, Add to Discord, Log in, Dashboard (the others are .topbar-more / .topbar-wide).
    const showAdd = add && Boolean(viewer);
    const showLogIn = loggedOut && add;
    const showSignUp = loggedOut && Boolean(ctx.accounts);
    const showDashboard = Boolean(ctx.dashboardEnabled) && (member || add);
    const account = showLogIn || showSignUp
        ? html`<div class="nav-pop-account">${showLogIn ? html`<a class="button button-quiet" href="/me">${t('shell.account.logIn')}</a>` : ''}${showSignUp ? html`<a class="button" href="/me/signup">${t('shell.account.signUp')}</a>` : ''}</div>`
        : '';
    const extras = [
        showAdd ? html`<li><a href="${ctx.installUrl}" rel="noopener" data-add-bot>${t('shell.install.addToDiscord')}</a></li>` : '',
        showDashboard ? html`<li><a href="${DASHBOARD_PATH}">${t('shell.links.dashboard')}</a></li>` : '',
    ].filter(Boolean);
    const langs = typeof ctx.languageLink === 'function'
        ? (() => {
            const code = ctx.urlLang || textOf(ctx).lang || DEFAULT_LANG;
            const items = LANGUAGES.map((l) => html`<li><a href="${ctx.languageLink(l.code, here)}" hreflang="${l.code}" lang="${l.code}"${l.code === code ? raw(' aria-current="true"') : ''}>${l.name}</a></li>`);
            return html`<p class="nav-pop-title">${t('shell.language.label')}</p><ul class="nav-pop-langs">${items}</ul>`;
        })()
        : '';
    return html`<details class="nav-menu"><summary class="nav-toggle"><span class="nav-toggle-bars" aria-hidden="true"></span><span class="visually-hidden">${t('shell.header.menu')}</span></summary>
<nav class="nav-pop" aria-label="${t('shell.header.menu')}">${account}${extras.length ? html`<ul class="nav-pop-links">${extras}</ul>` : ''}<ul class="nav-pop-links">${navLinks(ctx, active)}</ul>${langs}</nav></details>`;
}

// Rough widths (px) of the top-bar parts from the label lengths, in a wide system font (the layout
// checker's Linux font is one of the widest; Segoe UI, SF and Roboto are narrower). Only used to pick
// when the menu moves to its own row; scripts/site-layout-check.js checks the result in a browser.
const BAR = {
    brand: 106, gap: 32, actionGap: 8, navChar: 9.8, navPad: 24, buttonChar: 9.4, buttonPad: 30,
    chip: 140, pickerShort: 64, pickerChar: 7.4, pickerPad: 44,
};
const shortCode = (code) => code.slice(0, 2).toUpperCase();

/**
 * The top bar's actions (picker, Add to Discord, Dashboard, member buttons) and the class that says
 * up to which width the menu sits on its own row below the brand: topbar-stack-1000 (one row above
 * 1000px), topbar-stack-1180 (one row above 1180px, where the picker shows its full name) or
 * topbar-stack-all (always two rows: long labels or many buttons). Phones (≤ 760px) use one row
 * and keep one button: the account chip when logged in, else Add to Discord, else Log in, else
 * the dashboard (.topbar-more is hidden there); the rest, the page links and the languages are in
 * the ☰ menu (phoneMenu). Next to the member buttons the dashboard only fits on wide screens
 * (.topbar-wide); on narrower ones it is in the ☰ menu and the footer.
 */
function topbarParts(ctx, here, active, navLabels) {
    const { t } = textOf(ctx);
    const member = Boolean(ctx.memberPortal);
    const add = Boolean(ctx.publicSite && ctx.installUrl);
    // The dashboard: a filled button unless "Add to Discord" or the member buttons are shown.
    const quiet = add || member;
    const dashClass = `button${quiet ? ' button-quiet' : ''}${member ? ' topbar-wide' : add ? ' topbar-more' : ''}`;
    const dashboard = ctx.dashboardEnabled ? topButton(dashClass, DASHBOARD_PATH, t('shell.links.dashboard'), t('shell.short.dashboard')) : '';
    const addLink = add
        ? topButton(`button${member && ctx.viewer ? ' topbar-more' : ''}`, ctx.installUrl, t('shell.install.addToDiscord'), t('shell.short.addToDiscord'), ' rel="noopener" data-add-bot')
        : '';
    const actions = html`${languagePicker(ctx, here, 'header')}${addLink}${dashboard}${memberActions(ctx, { addShown: add })}${phoneMenu(ctx, here, active, { add, member })}`;

    // The one-row estimate (without and with the wide-screen extras).
    const code = ctx.urlLang || textOf(ctx).lang || DEFAULT_LANG;
    const current = LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
    const chars = (label) => [...String(label)].length;
    const button = (label) => chars(label) * BAR.buttonChar + BAR.buttonPad;
    const nav = navLabels.reduce((sum, label) => sum + chars(label) * BAR.navChar + BAR.navPad, 0);
    const actionsWidth = (wide) => {
        const list = [];
        if (typeof ctx.languageLink === 'function') list.push(wide ? chars(current.name) * BAR.pickerChar + BAR.pickerPad : BAR.pickerShort);
        if (add) list.push(button(t('shell.install.addToDiscord')));
        if (ctx.dashboardEnabled && (wide || !member)) list.push(button(t('shell.links.dashboard')));
        if (member && ctx.viewer) list.push(BAR.chip);
        if (member && !ctx.viewer) list.push(button(t('shell.account.logIn')), ...(ctx.accounts ? [button(t('shell.account.signUp'))] : []));
        return list.reduce((a, b) => a + b, 0) + Math.max(0, list.length - 1) * BAR.actionGap;
    };
    const row = (wide) => BAR.brand + BAR.gap + nav + BAR.gap + actionsWidth(wide);
    // The page content is 48px narrower than the window (the .wrap padding).
    const stack = row(false) <= 1000 - 48 ? 'topbar-stack-1000' : row(true) <= 1180 - 48 ? 'topbar-stack-1180' : 'topbar-stack-all';
    return { actions, stack };
}

/** "Add to Discord": only when the site is public and CLIENT_ID is valid. */
export function addButton(ctx, className = 'button') {
    return ctx.publicSite && ctx.installUrl
        ? html`<a class="${className}" href="${ctx.installUrl}" rel="noopener" data-add-bot>${textOf(ctx).t('shell.install.addToDiscord')}</a>`
        : '';
}

/**
 * The plain line right after every in-page "Add to Discord" button (beginner audit 2.11): no
 * Administrator, and a link to the permission list on /admins#permissions. '' whenever addButton
 * is ''. The top bar's button has no room for it (the /admins link is in the footer).
 */
export function installNote(ctx) {
    if (!(ctx.publicSite && ctx.installUrl)) return '';
    const { ti, href } = textOf(ctx);
    return html`<p class="install-note">${ti('shell.install.note', { url: `${href('/admins')}#permissions` })}</p>`;
}

// The default share image; its alt text is shell.meta.shareImageAlt, the default description
// shell.meta.defaultDescription.
const DEFAULT_IMAGE = Object.freeze({ path: '/img/og.png', width: 1200, height: 630, large: true });

/** "Features · Mewvo"; a title that is the name alone, or one marked `complete` (the home page's), is used as it is. */
function fullTitle(ctx, title, complete = false) {
    const { t } = textOf(ctx);
    return complete || title === t('common.brand') ? title : t('shell.meta.pageTitle', { title });
}

/**
 * canonical + Open Graph / Twitter tags: only with a known origin (PUBLIC_URL), never a guessed host.
 * `image` ({ path, width, height, alt, large }) replaces the default share image (og.png);
 * `large: false` asks for the small square Twitter card.
 */
function shareTags(ctx, { title, description, path, image = null, titleComplete = false }) {
    if (!ctx.origin || typeof path !== 'string') return '';
    const { t, href } = textOf(ctx);
    // English-only pages (legal) keep their English URL as canonical under any prefix and have no alternates.
    const pathOnly = path.split(/[?#]/)[0];
    const translatable = isPagePath(pathOnly) && !isEnglishOnlyPath(pathOnly);
    const url = `${ctx.origin}${translatable ? href(path) : path}`;
    const alternates = translatable
        ? html`${LANGUAGES.map((l) => html`
<link rel="alternate" hreflang="${l.code}" href="${ctx.origin}${localizePath(l.code, path)}">`)}
<link rel="alternate" hreflang="x-default" href="${ctx.origin}${path}">`
        : '';
    const full = fullTitle(ctx, title, titleComplete);
    const text = description || t('shell.meta.defaultDescription');
    const img = image && typeof image.path === 'string' && image.path.startsWith('/') ? image : { ...DEFAULT_IMAGE, alt: t('shell.meta.shareImageAlt') };
    const imageUrl = `${ctx.origin}${img.path}`;
    return html`
<link rel="canonical" href="${url}">${alternates}
<meta property="og:type" content="website"><meta property="og:site_name" content="${t('common.brand')}"><meta property="og:title" content="${full}">
<meta property="og:description" content="${text}"><meta property="og:url" content="${url}"><meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="${String(img.width)}"><meta property="og:image:height" content="${String(img.height)}"><meta property="og:image:alt" content="${img.alt}">
<meta name="twitter:card" content="${img.large === false ? 'summary' : 'summary_large_image'}"><meta name="twitter:title" content="${full}"><meta name="twitter:description" content="${text}"><meta name="twitter:image" content="${imageUrl}">`;
}

/**
 * The language picker (header: a menu without script; footer: a plain list). Plain links to the same
 * page in each language; the link sets the mewvo_lang cookie (language.js, ?setlang). Only when the
 * context knows how to build those links (ctx.languageLink; bare test contexts do not).
 */
function languagePicker(ctx, path, place) {
    if (typeof ctx.languageLink !== 'function') return '';
    const { t } = textOf(ctx);
    const currentCode = ctx.urlLang || textOf(ctx).lang || DEFAULT_LANG;
    const current = LANGUAGES.find((l) => l.code === currentCode) || LANGUAGES[0];
    const items = LANGUAGES.map((l) => html`<li><a href="${ctx.languageLink(l.code, path)}" hreflang="${l.code}" lang="${l.code}"${l.code === current.code ? raw(' aria-current="true"') : ''}>${l.name}</a></li>`);
    if (place === 'header') {
        // Below 1181px the chip shows the short code ("DE"); the full name stays for screen readers.
        return html`<details class="lang-menu"><summary class="lang-chip"><span class="visually-hidden">${t('shell.language.label')}: </span><span class="lang-chip-full" lang="${current.code}">${current.name}</span><span class="lang-chip-short" aria-hidden="true">${shortCode(current.code)}</span></summary>
<ul class="lang-pop">${items}</ul></details>`;
    }
    return html`<nav class="footer-langs" aria-label="${t('shell.language.label')}"><ul>${items}</ul></nav>`;
}

/**
 * "Mewvo is also available in Deutsch": on an unprefixed page when the cookie or Accept-Language
 * prefers another language (ctx.suggestLang, already one of LANG_CODES). Written in that language
 * (its own catalog; English only while it has no translation), with a link that switches and one
 * that keeps English (both set the cookie, so the note does not come back). Never a redirect.
 */
function languageSuggestion(ctx, path) {
    const code = ctx.suggestLang;
    const target = LANGUAGES.find((l) => l.code === code && l.code !== DEFAULT_LANG);
    if (!target || typeof ctx.languageLink !== 'function') return '';
    const other = translator(target.code);
    const textLang = translatedIn(target.code, 'shell.suggestLanguage') ? target.code : DEFAULT_LANG;
    return html`<aside class="lang-suggest" aria-label="${textOf(ctx).t('shell.language.label')}"><div class="wrap"><p><a href="${ctx.languageLink(target.code, path)}" hreflang="${target.code}" lang="${textLang}">${other.t('shell.suggestLanguage', { language: target.name })}</a>
<a class="lang-suggest-dismiss" href="${ctx.languageLink(DEFAULT_LANG, path)}">${textOf(ctx).t('shell.suggestLanguageDismiss')}</a></p></div></aside>`;
}

/** On an English-only page reached under a prefix: "This page is only available in English." in the visitor's language. */
function englishOnlyNote(ctx) {
    const code = ctx.englishOnlyFor;
    if (!code || code === DEFAULT_LANG) return '';
    const textLang = translatedIn(code, 'shell.legalEnglishOnly') ? code : DEFAULT_LANG;
    return html`<div class="wrap"><p class="notice lang-note" lang="${textLang}">${translator(code).t('shell.legalEnglishOnly')}</p></div>`;
}

/**
 * The page shell. `path` (the page's own path, e.g. "/features") turns on the canonical and
 * share tags when PUBLIC_URL is set. `refresh` (seconds) adds a <meta http-equiv="refresh">:
 * nothing uses it today (the status page has a Refresh link). `image` overrides the share image (shareTags).
 * `titleComplete`: the title is the whole <title> (no " · Mewvo" added; the home page).
 * `langNote: false`: no "only in English" note on an English-only page (Privacy and Terms show a
 * translated summary with their own note instead; pages/legal.js).
 */
export function layout(ctx, { title, active = null, description = '', refresh = 0, path = null, image = null, titleComplete = false, langNote = true, body }) {
    const { t, lang, href } = textOf(ctx);
    const brand = t('common.brand');
    const here = typeof path === 'string' ? path : '/';
    const navLabels = ['features', 'pricing', 'docs', 'commands', 'leaderboard', ...(ctx.memberPortal ? ['myRecord'] : [])].map((key) => t(`shell.links.${key}`));
    const bar = topbarParts(ctx, here, active, navLabels);
    return html`<!doctype html><html lang="${lang || 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#1e1f22">${ctx.publicSite ? '' : html`<meta name="robots" content="${NOINDEX}">`}
<title>${fullTitle(ctx, title, titleComplete)}</title>${refresh > 0 ? html`<meta http-equiv="refresh" content="${Math.floor(refresh)}">` : ''}${description ? html`<meta name="description" content="${description}">` : ''}${shareTags(ctx, { title, description, path, image, titleComplete })}
<link rel="icon" href="${FAVICON_PATH}" type="image/png" sizes="64x64"><link rel="stylesheet" href="${CSS_PATH}"><script src="${JS_PATH}" defer></script></head>
<body><a class="skip" href="#main">${t('shell.header.skip')}</a>
<header class="topbar ${bar.stack}"><div class="wrap topbar-inner"><a class="brand" href="${href('/')}"${active === 'home' ? raw(' aria-current="page"') : ''}>${LOGO}<span>${brand}</span></a>
<nav class="topnav" aria-label="${t('shell.header.navLabel')}"><ul>${navLinks(ctx, active)}</ul></nav>
<div class="topbar-actions">${bar.actions}</div></div></header>${languageSuggestion(ctx, here)}
<main id="main" tabindex="-1">${langNote ? englishOnlyNote(ctx) : ''}${body}</main>
<footer class="footer"><div class="wrap"><div class="footer-top"><div><p class="footer-brand">${LOGO}<span>${brand}</span></p>
<p class="footer-text">${t('shell.footer.tagline')}</p></div>
<nav class="footer-nav" aria-label="${t('shell.footer.navLabel')}">${footerColumns(ctx, active)}</nav></div>
${languagePicker(ctx, here, 'footer')}<p class="footer-legal">${t(ctx.publicSite ? 'shell.footer.legalLinePublic' : 'shell.footer.legalLine')}</p></div></footer>
</body></html>`.text;
}
