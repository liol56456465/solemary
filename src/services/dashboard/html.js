// html.js — tiny server-side HTML templating and the page shell of the web dashboard.
//
// `html` is a tagged template: every interpolated value is HTML-escaped unless it is
// the result of another `html` call (or `raw`, for the few trusted constants). Arrays
// are joined. null / undefined / false render as nothing. There is no other way to
// put text into a page, so user-provided strings are always escaped.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ICON_SPRITE_MARKUP, hasIcon } from './icons.js';
import { allows, levelLabel } from './permissions.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

class SafeHtml {
    constructor(text) { this.text = text; }
    toString() { return this.text; }
}

/** Trusted markup (constants only — never user input). */
export function raw(text) {
    return new SafeHtml(String(text));
}

function render(value) {
    if (value === null || value === undefined || value === false) return '';
    if (value instanceof SafeHtml) return value.text;
    if (Array.isArray(value)) return value.map(render).join('');
    return escapeHtml(value);
}

export function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i += 1) out += render(values[i]) + strings[i + 1];
    return new SafeHtml(out);
}

/** Builds a query string from an object, skipping empty values (values are URL-encoded). */
export function queryString(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
}

/** "2026-10-27 14:03 UTC" or "—". */
export function formatDate(value) {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A <time> showing formatDate; the static script turns it into "5 min ago" (UTC stays in the tooltip). */
export function timeTag(value) {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return html`<time datetime="${date.toISOString()}" data-relative>${formatDate(date)}</time>`;
}

/** "3 d", "5 h", "12 min" since `value`. */
export function formatAge(value, now = Date.now()) {
    const ms = Math.max(0, now - new Date(value).getTime());
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} d`;
}

export const BASE = '/dashboard';
/**
 * A short hash of a static file, added to its URL (?v=…). The files are cached for an hour,
 * so after a deploy the new pages would otherwise run with the old stylesheet or script.
 */
function assetVersion(name) {
    try {
        return createHash('sha256').update(readFileSync(new URL(`./static/${name}`, import.meta.url))).digest('hex').slice(0, 10);
    } catch {
        return '0';
    }
}

export const CSS_PATH = `${BASE}/static/dashboard.css?v=${assetVersion('dashboard.css')}`;
export const JS_PATH = `${BASE}/static/dashboard.js?v=${assetVersion('dashboard.js')}`;

/** A dashboard URL: path('/cases') → '/dashboard/cases'. */
export function path(suffix = '') {
    return `${BASE}${suffix}`;
}
const ACTION_ICON = { ban: 'nocontact', kick: 'kick', mute: 'mute', warn: 'warn' };

/** An enforcement action badge: neutral outline + icon + the word; red only for ban. */
export function typeBadge(type) {
    const name = String(type || '');
    return html`<span class="type type-${name}">${ACTION_ICON[name] ? icon(ACTION_ICON[name]) : ''}${name ? name[0].toUpperCase() + name.slice(1) : ''}</span>`;
}

/** A decorative line icon from the sprite (icons.js); labels are always next to it. */
export function icon(name, className = 'icon') {
    return html`<svg class="${className}" aria-hidden="true" focusable="false"><use href="#i-${hasIcon(name) ? name : 'overview'}"></use></svg>`;
}

/**
 * The sidebar (v5): four groups by job, every page listed. `state` names the on/off dot from
 * moduleStates, where the module has an on/off setting; `toggle` is the module action behind
 * its main switch (module page header); `summary` (one line on the Modules page cards) marks a
 * settings module.
 */
export const NAV = [
    { group: 'Moderate', items: [
        { key: 'overview', label: 'Overview' },
        { key: 'inbox', label: 'Inbox' },
        { key: 'users', label: 'Members' },
        { key: 'bans', label: 'Banned' },
        { key: 'cases', label: 'Cases' },
        { key: 'appeals', label: 'Appeals' },
        { key: 'nocontact', label: 'No-contact' },
        { key: 'staff', label: 'Staff' },
        { key: 'channels', label: 'Channel tools' },
    ] },
    { group: 'Community', items: [
        { key: 'tickets', label: 'Tickets & modmail', state: 'tickets', keywords: 'ticket panel, support, modmail, canned answers, saved replies, staff role, transcript, open tickets category, closed tickets category, ticket log channel', summary: 'Ticket panel, modmail, saved answers.' },
        { key: 'welcome', label: 'Welcome & goodbye', state: 'welcome', keywords: 'join message, leave message, goodbye, greeting, auto role, autorole, embed, image, banner, colour', summary: 'Join and leave messages, auto roles.' },
        { key: 'leveling', label: 'Leveling', state: 'leveling', toggle: 'enabled', keywords: 'xp, levels, rank, level up message, role rewards, leaderboard, no xp channels', summary: 'XP, level-up messages, role rewards.' },
        { key: 'reaction-roles', label: 'Reaction roles', keywords: 'self roles, role menu, buttons, select menu', summary: 'Self-assign role menus.' },
        { key: 'messages', label: 'Messages', keywords: 'post as the bot, send message, embed, embed builder, announcement, poll, vote, countdown, timer', summary: 'Post a message or embed, a poll or a countdown as the bot.' },
        { key: 'giveaways', label: 'Giveaways', keywords: 'prize, winners, reroll, end giveaway, random member, random user, pick a member', summary: 'Start, end and reroll giveaways.' },
        { key: 'birthdays', label: 'Birthdays', state: 'birthdays', keywords: 'birthday channel, birthday role, timezone', summary: 'Birthday announcements and role.' },
        { key: 'applications', label: 'Applications', state: 'applications', toggle: 'enabled', keywords: 'apply, staff application, questions, managers', summary: 'Role applications and their questions.' },
        { key: 'community', label: 'Community', keywords: 'suggestions, starboard, sticky message, tags, youtube feed', summary: 'Suggestions, starboard, stickies, tags, feeds.' },
        { key: 'join-to-create', label: 'Join to create', state: 'joinToCreate', keywords: 'temporary voice, voice channels, jtc', summary: 'Temporary voice channels.' },
    ] },
    { group: 'Server setup', items: [
        { key: 'automod', label: 'Automod', state: 'automod', toggle: 'enabled', keywords: 'spam, links, invites, bad words, raid, lockdown, panic, join gate, trusted, second chance, mood, native automod, slowmode', summary: 'Rule modes, exceptions, join gate, raid panic.' },
        { key: 'enforcement', label: 'Enforcement & appeals', keywords: 'mod log, evidence, muted role, warning roles, appeal window, cooldown, mass-action guard, ladder, reasons, appeal panel, appeals category, reports category, modmail category, alerts channel', summary: 'Log channels, warning roles, appeal timings, appeal panels.' },
        { key: 'logging', label: 'Logging', state: 'logging', toggle: 'enabled', keywords: 'audit log, message delete, edits, joins, leaves, ignore channels, events', summary: 'Which server events are logged, and where.' },
        { key: 'verification', label: 'Verification', state: 'verification', keywords: 'verify, captcha, verified role, auto-verify, panel', summary: 'Verify panel or auto-verify on join.' },
        { key: 'counters', label: 'Counters', keywords: 'member count, stats channels, counting game', summary: 'Member counters and the counting game.' },
        { key: 'support', label: 'Support server', keywords: 'banned role, support server, ban appeals category', summary: 'The support server: banned role, ban appeals.' },
    ] },
    { group: 'Bot', items: [
        { key: 'modules', label: 'All modules' },
        { key: 'commands', label: 'Commands', keywords: 'disable command, enable command, categories, permissions, prefix, moderator role, mod role, shorten, short link', summary: 'Turn commands and categories on or off.' },
        { key: 'audit', label: 'Audit log' },
    ] },
];

/**
 * The Owner area (bot owners, OWNER_IDS only): shown as an extra sidebar group when the
 * page shell's session says `isOwner` (checked live per request). Not part of NAV, so the
 * module lists (navItems, moduleItems) never include it. `icon` names a sprite icon.
 */
export const OWNER_NAV = { group: 'Owner', items: [
    { key: 'owner/home', label: 'Owner overview', icon: 'overview' },
    { key: 'owner/profile', label: 'Bot profile', icon: 'cat' },
    { key: 'owner/servers', label: 'Servers', icon: 'server' },
    { key: 'owner/users', label: 'Users', icon: 'users' },
    { key: 'owner/blacklist', label: 'Blacklist', icon: 'nocontact' },
    { key: 'owner/health', label: 'Health', icon: 'monitor' },
    { key: 'owner/commands', label: 'Command sync', icon: 'commands' },
    { key: 'owner/announce', label: 'Announce', icon: 'messages' },
    { key: 'owner/activity', label: 'Owner activity', icon: 'audit' },
] };

/**
 * The sidebar groups for this page's viewer: NAV, plus the Owner group for bot owners.
 * With an access decision, only the pages its level may use (permissions.js); groups left
 * empty are dropped. Without one (logged-out pages, tests) everything, as before.
 */
export function navGroups(session = null, access = null) {
    const groups = session?.isOwner ? [...NAV, OWNER_NAV] : NAV;
    if (!access?.allowed) return groups;
    return groups
        .map((group) => (group === OWNER_NAV ? group : { ...group, items: group.items.filter((item) => allows(access, `page:${item.key}`)) }))
        .filter((group) => group.items.length);
}

const itemIcon = (item) => icon(item.icon || item.key);

/** Every sidebar entry, flattened. */
export function navItems() {
    return NAV.flatMap((item) => (item.group ? item.items : [item]));
}

/** The settings modules (entries with a one-line summary), in sidebar order. */
export function moduleItems() {
    return navItems().filter((item) => item.summary);
}

function stateOf(item, moduleStates) {
    return item.state && Object.hasOwn(moduleStates, item.state) ? moduleStates[item.state] : null;
}

/** The sidebar groups as sections (phone tab bar): label, icon, first page, pages. */
const SECTION_ICON = { Moderate: 'enforcement', Community: 'users', 'Server setup': 'server', Bot: 'modules', Owner: 'cat' };
export function sections(groups = NAV) {
    return groups.map((item) => ({
        key: item.group.toLowerCase().replace(/\s+/g, '-'), label: item.group, icon: SECTION_ICON[item.group] || 'overview',
        href: path(`/${item.items[0].key}`), items: item.items,
    }));
}

/** The group a page belongs to (by its sidebar key). */
function sectionOf(active, groups = NAV) {
    return sections(groups).find((sec) => sec.items.some((i) => i.key === active)) || null;
}

/** Desktop: the sidebar with every page by group; brand and server on top, account at the bottom. */
function sideNav(active, moduleStates, theme, back, session, access) {
    return html`<nav class="side-nav" aria-label="Dashboard"><a class="side-brand" href="${path('/overview')}"><span class="brand-mark" aria-hidden="true">${icon('cat')}</span>Meowist</a>
${serverSwitch(session.server)}
${navGroups(session, access).map((group) => html`<div class="side-group"><p class="side-group-label">${group.group}</p><ul class="side-list">${group.items.map((item) => {
        const state = stateOf(item, moduleStates);
        const on = item.key === active;
        const badge = item.key === 'inbox' && session.inboxCount > 0
            ? html`<span class="nav-badge">${session.inboxCount > 99 ? '99+' : session.inboxCount}<span class="sr"> waiting</span></span>` : '';
        return html`<li><a href="${path(`/${item.key}`)}"${on ? raw(' aria-current="page"') : ''}>${itemIcon(item)}<span class="side-text">${item.label}</span>${badge}${state === null ? ''
            : html`<span class="dot ${state ? 'dot-on' : 'dot-off'}"><span class="sr">${state ? 'on' : 'off'}</span></span>`}</a></li>`;
    })}</ul></div>`)}
<div class="side-bottom"><a class="side-site" href="/">${icon('home')}<span class="side-text">Meowist website</span></a>${userMenu(session, access, theme, back)}</div></nav>`;
}

/** "Moderate / Members": where the page sits (the group, then the page). */
function crumbs(active, groups = NAV) {
    const sec = sectionOf(active, groups);
    const item = sec?.items.find((i) => i.key === active);
    if (!sec || !item) return '';
    return html`<p class="crumbs"><span>${sec.label}</span><span aria-hidden="true">/</span><b>${item.label}</b></p>`;
}

/** Phones: a floating tab bar (the four groups); "More" is a sheet (details, no script) with every page. */
function tabBar(active, theme, back, session, access) {
    const groups = navGroups(session, access);
    const current = sectionOf(active, groups);
    const main = sections(groups).slice(0, 3);
    return html`<nav class="tabbar" aria-label="Sections"><a href="${path('/overview')}"${active === 'overview' ? raw(' class="on" aria-current="true"') : ''}>${icon('overview')}<span>Home</span></a>${main.map((sec) => html`<a href="${sec.href}"${current?.key === sec.key && active !== 'overview' ? raw(' class="on" aria-current="true"') : ''}>${icon(sec.icon)}<span>${sec.label === 'Server setup' ? 'Setup' : sec.label}</span></a>`)}
<details class="more menu-wrap"><summary${current && !main.some((sec) => sec.key === current.key) ? raw(' class="on"') : ''}>${icon('menu')}<span>More</span></summary><div class="more-sheet">
${sections(groups).map((sec) => html`<p class="more-group">${sec.label}</p>${sec.items.map((item) => html`<a href="${path(`/${item.key}`)}"${item.key === active ? raw(' aria-current="page"') : ''}>${itemIcon(item)}${item.label}</a>`)}`)}
${themePicker(theme, back, 'sheet')}<div class="more-foot"><a href="/">${icon('home')}Website</a><form method="post" action="${path('/logout')}"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit" class="ghost">${icon('logout')}Log out</button></form></div></div></details></nav>`;
}

// Themes (same tokens and layout, ten palettes): "system" follows the device (Paper or Graphite).
export const THEMES = ['system', 'nebula', 'ember', 'ocean', 'forest', 'gold', 'graphite', 'sakura', 'sunset', 'arctic', 'paper'];
export const THEME_COOKIE = 'meowist_theme';
const THEME_LABEL = {
    system: 'Follow device', nebula: 'Nebula', ember: 'Ember', ocean: 'Ocean', forest: 'Forest', gold: 'Midnight gold',
    graphite: 'Graphite', sakura: 'Sakura', sunset: 'Sunset', arctic: 'Arctic', paper: 'Paper',
};
// Themes from before v5, still in some cookies: the closest new palette.
const OLD_THEMES = { light: 'paper', white: 'paper', gray: 'graphite', dark: 'graphite', black: 'graphite', sage: 'forest', sand: 'sunset' };

/** The theme saved in the cookie (old names map to the closest palette); anything else follows the device. */
export function themeFrom(value) {
    if (Object.hasOwn(OLD_THEMES, value)) return OLD_THEMES[value];
    return THEMES.includes(value) ? value : 'system';
}

/**
 * The theme picker: a radio group of links (GET /dashboard/theme sets the cookie and comes
 * back, so it works without JS; the static script switches in place). Each option shows a
 * swatch of its own theme. `id` keeps the label ids unique (account menu and phone sheet).
 */
function themePicker(theme, back, id) {
    return html`<div class="theme-picker"><p class="theme-picker-title" id="theme-${id}">Theme</p><div class="theme-grid" role="radiogroup" aria-labelledby="theme-${id}">${THEMES.map((key) => {
        const on = key === theme;
        return html`<a class="theme-opt sw-${key}${key === 'system' ? ' wide' : ''}" href="${path(`/theme${queryString({ mode: key, next: back })}`)}" role="radio" aria-checked="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}" data-theme-pick="${key}"><span class="sw" aria-hidden="true"><i class="sw-1"></i><i class="sw-2"></i><i class="sw-3"></i><i class="sw-a"></i></span><span class="theme-name">${THEME_LABEL[key]}<span class="theme-check" aria-hidden="true">✓</span></span></a>`;
    })}</div></div>`;
}

function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase() || '?';
}

/**
 * The server switcher in the top bar. The dashboard manages one server for now (the login
 * asks Discord for `identify` only, so it cannot list other servers); the menu says so.
 */
function serverSwitch(server) {
    if (!server) return '';
    const avatar = (size) => (server.iconUrl
        ? html`<img class="server-icon" src="${server.iconUrl}" alt="" width="${size}" height="${size}" referrerpolicy="no-referrer">`
        : html`<span class="server-icon server-initials" aria-hidden="true">${initials(server.name)}</span>`);
    return html`<details class="server-switch menu-wrap"><summary aria-label="Server: ${server.name}">${avatar(24)}<span class="server-name">${server.name}</span>${icon('chevron', 'icon icon-down')}</summary>
<div class="menu"><p class="menu-item is-current">${avatar(24)}<span class="server-text"><span class="server-name">${server.name}</span><span class="server-sub">Main server · managing now</span></span></p>
<p class="menu-note">Only this server can be managed for now.</p></div></details>`;
}

function userMenu(session, access, theme = 'system', back = path('/overview')) {
    return html`<details class="user-menu menu-wrap"><summary aria-label="Account: ${session.username}"><span class="avatar-initials" aria-hidden="true">${initials(session.username)}</span><span class="user-name">${session.username}</span></summary>
<div class="menu"><p class="menu-meta"><strong>${session.username}</strong><br><span class="muted">${levelLabel(access)}</span></p>
${themePicker(theme, back, 'menu')}<a class="menu-item menu-link" href="/">${icon('home')}Meowist website</a><form method="post" action="${path('/logout')}"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit" class="menu-item">${icon('logout')}Log out</button></form></div></details>`;
}

/**
 * The page shell (v5): the grouped sidebar (desktop), a header with where-you-are and search,
 * then `body` (SafeHtml); on phones a floating tab bar with a "More" sheet (details: no script).
 * The theme comes from the cookie, set on <html> server-side so there is no flash.
 * `session` may carry display extras added by the routes: theme, server, path.
 * No inline styles or scripts (CSP); the one script is the static enhancement file.
 */
export function layout({ title, active = null, session = null, access = null, moduleStates = {}, body, theme: pageTheme = 'system', refreshSeconds = 0 }) {
    const theme = themeFrom(session?.theme ?? pageTheme);
    const back = typeof session?.path === 'string' ? session.path : path(active ? `/${active}` : '/overview');
    // "Find a setting" searches the Modules page: not shown to levels that cannot open it.
    const find = !access?.allowed || allows(access, 'page:modules')
        ? html`<a class="icon-button find-link" href="${path('/modules')}" aria-label="Find a setting">${icon('search')}</a><form class="quick-find" role="search" method="get" action="${path('/modules')}"><label class="sr" for="quick-find">Find a setting</label>${icon('search')}<input id="quick-find" type="search" name="q" placeholder="Find a setting…" maxlength="60" autocomplete="off" data-quick-find><kbd aria-hidden="true">/</kbd></form>` : '';
    const top = session ? html`<header class="page-top">${crumbs(active, navGroups(session, access))}<span class="spacer"></span>
${find}</header>`
        : html`<header class="page-top bare-top"><a class="brand" href="/" aria-label="Meowist website"><span class="brand-mark" aria-hidden="true">${icon('cat')}</span><span class="brand-name">Meowist</span></a><span class="spacer"></span></header>`;
    return html`<!doctype html><html lang="en"${theme === 'system' ? '' : html` data-theme="${theme}"`}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><meta name="color-scheme" content="light dark">${refreshSeconds > 0 ? html`<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}<title>${title} · Meowist dashboard</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${CSS_PATH}"><script src="${JS_PATH}" defer></script></head>
<body>${raw(ICON_SPRITE_MARKUP)}<a class="skip" href="#main">Skip to content</a>
<div class="${session ? 'app' : 'app bare'}">${session ? sideNav(active, moduleStates, theme, back, session, access) : ''}
<div class="page">${top}<main id="main" tabindex="-1">${body}</main></div></div>
${session ? tabBar(active, theme, back, session, access) : ''}</body></html>`.text;
}

/** "Channel exceptions" → "channel-exceptions" (a stable key for remembering open sections). */
export function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section';
}

/**
 * A titled block on a module page: a collapsible card (<details>, keyboard accessible
 * without JS; the static script remembers which ones were open). options:
 * { open (default true), collapsible (default true), key }.
 */
export function section(title, body, help = '', { open = true, collapsible = true, key = slug(title) } = {}) {
    const inner = html`${help ? html`<p class="muted section-help">${help}</p>` : ''}${body}`;
    if (!collapsible) return html`<section class="card"><h2>${title}</h2>${inner}</section>`;
    return html`<details class="card section" id="s-${key}" data-key="${key}"${open ? raw(' open') : ''}><summary><h2>${title}</h2></summary><div class="section-body">${inner}</div></details>`;
}

/** A plain message page (errors, 403, …). */
export function messagePage(title, message, session = null, extra = {}) {
    return layout({ title, session, ...extra, body: html`<div class="message card"><h1>${title}</h1><p>${message}</p><p class="message-actions">${session ? html`<a class="button-link" href="${path('/overview')}">Back to Overview</a>` : html`<a class="button-link" href="/">Back to the home page</a>`}</p></div>` });
}