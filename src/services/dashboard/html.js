// html.js — tiny server-side HTML templating and the page shell of the web dashboard.
//
// `html` is a tagged template: every interpolated value is HTML-escaped unless it is
// the result of another `html` call (or `raw`, for the few trusted constants). Arrays
// are joined. null / undefined / false render as nothing. There is no other way to
// put text into a page, so user-provided strings are always escaped.

import { ICON_SPRITE_MARKUP, hasIcon } from './icons.js';

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
export const CSS_PATH = `${BASE}/static/dashboard.css`;
export const JS_PATH = `${BASE}/static/dashboard.js`;

/** A dashboard URL: path('/cases') → '/dashboard/cases'. */
export function path(suffix = '') {
    return `${BASE}${suffix}`;
}
/** A decorative line icon from the sprite (icons.js); labels are always next to it. */
export function icon(name, className = 'icon') {
    return html`<svg class="${className}" aria-hidden="true" focusable="false"><use href="#i-${hasIcon(name) ? name : 'overview'}"></use></svg>`;
}

/**
 * The sidebar. `state` names the on/off indicator from moduleStates, where the module
 * has an on/off setting; `toggle` is the module action behind its main switch (Modules
 * page and the module page header); `summary` is the one-liner on the module cards.
 */
export const NAV = [
    { key: 'overview', label: 'Overview' },
    { key: 'modules', label: 'Modules' },
    { group: 'Records', items: [
        { key: 'users', label: 'Members' },
        { key: 'cases', label: 'Cases' },
        { key: 'appeals', label: 'Appeals' },
        { key: 'nocontact', label: 'No-contact' },
        { key: 'staff', label: 'Staff' },
    ] },
    { group: 'Settings', items: [
        { key: 'enforcement', label: 'Enforcement & appeals', summary: 'Log channels, warning roles, appeal timings, appeal panels.' },
        { key: 'automod', label: 'Automod', state: 'automod', toggle: 'enabled', summary: 'Rule modes, exceptions, join gate, raid panic.' },
        { key: 'logging', label: 'Logging', state: 'logging', toggle: 'enabled', summary: 'Which server events are logged, and where.' },
        { key: 'welcome', label: 'Welcome & goodbye', state: 'welcome', summary: 'Join and leave messages, auto roles.' },
        { key: 'tickets', label: 'Tickets', state: 'tickets', summary: 'Ticket panel, modmail, saved answers.' },
        { key: 'leveling', label: 'Leveling', state: 'leveling', toggle: 'enabled', summary: 'XP, level-up messages, role rewards.' },
        { key: 'verification', label: 'Verification', state: 'verification', summary: 'Verify panel or auto-verify on join.' },
        { key: 'reaction-roles', label: 'Reaction roles', summary: 'Self-assign role menus.' },
        { key: 'giveaways', label: 'Giveaways', summary: 'Start, end and reroll giveaways.' },
        { key: 'birthdays', label: 'Birthdays', state: 'birthdays', summary: 'Birthday announcements and role.' },
        { key: 'counters', label: 'Counters', summary: 'Member counters and the counting game.' },
        { key: 'join-to-create', label: 'Join to create', state: 'joinToCreate', summary: 'Temporary voice channels.' },
        { key: 'applications', label: 'Applications', state: 'applications', toggle: 'enabled', summary: 'Role applications and their questions.' },
        { key: 'community', label: 'Community', summary: 'Suggestions, starboard, stickies, tags, feeds.' },
        { key: 'commands', label: 'Commands', summary: 'Turn commands and categories on or off.' },
        { key: 'support', label: 'Support server', summary: 'The banned role in the support server.' },
    ] },
    { key: 'audit', label: 'Audit log' },
];

/** Every sidebar entry, flattened. */
export function navItems() {
    return NAV.flatMap((item) => (item.group ? item.items : [item]));
}

function stateOf(item, moduleStates) {
    return item.state && Object.hasOwn(moduleStates, item.state) ? moduleStates[item.state] : null;
}

function navLink(item, active, moduleStates) {
    const state = stateOf(item, moduleStates);
    const on = item.key === active;
    return html`<li><a href="${path(`/${item.key}`)}"${on ? raw(' class="on" aria-current="page"') : ''}>${icon(item.key)}<span class="nav-label">${item.label}</span>${state === null ? ''
        : html`<span class="dot ${state ? 'dot-on' : 'dot-off'}"><span class="sr">${state ? 'on' : 'off'}</span></span>`}</a></li>`;
}

function sidebar(active, moduleStates, server) {
    return html`<nav class="sidebar" id="sidebar" aria-label="Dashboard">${serverCard(server)}<ul>${NAV.map((item) => (item.group
        ? html`<li class="group"><span class="group-label">${item.group}</span><ul>${item.items.map((sub) => navLink(sub, active, moduleStates))}</ul></li>`
        : navLink(item, active, moduleStates)))}</ul></nav>`;
}

export const THEMES = ['system', 'light', 'dark'];
export const THEME_COOKIE = 'meowist_theme';
const THEME_LABEL = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

/** The theme saved in the cookie: 'light', 'dark' or 'system' (anything else). */
export function themeFrom(value) {
    return THEMES.includes(value) ? value : 'system';
}

/**
 * The theme switch: a plain link that works without JS (GET /dashboard/theme sets the
 * cookie and comes back); the static script switches in place instead.
 */
function themeToggle(theme, back) {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    return html`<a class="icon-button" href="${path(`/theme${queryString({ mode: next, next: back })}`)}" data-theme-toggle data-theme="${theme}" title="${THEME_LABEL[theme]} (switch to ${THEME_LABEL[next].toLowerCase()})">${icon(THEME_ICON[theme])}<span class="sr">${THEME_LABEL[theme]}; switch to ${THEME_LABEL[next].toLowerCase()}</span></a>`;
}

function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase() || '?';
}

/** The server this dashboard manages, at the top of the sidebar. */
function serverCard(server) {
    if (!server) return '';
    const avatar = server.iconUrl
        ? html`<img class="server-icon" src="${server.iconUrl}" alt="" width="36" height="36" referrerpolicy="no-referrer">`
        : html`<span class="server-icon server-initials" aria-hidden="true">${initials(server.name)}</span>`;
    return html`<div class="server-card">${avatar}<span class="server-text"><span class="server-name">${server.name}</span><span class="server-sub">Main server</span></span></div>`;
}

function userMenu(session, access) {
    return html`<details class="user-menu"><summary><span class="avatar-initials" aria-hidden="true">${initials(session.username)}</span><span class="user-name">${session.username}</span></summary>
<div class="menu"><p class="menu-meta"><strong>${session.username}</strong><br><span class="muted">${access && !access.canAct ? 'View and settings (bot owner)' : 'Administrator'}</span></p>
<form method="post" action="${path('/logout')}"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit" class="menu-item">${icon('logout')}Log out</button></form></div></details>`;
}

/** Breadcrumbs from the sidebar: Overview › group › page › (detail title). */
function breadcrumbs(active, title) {
    if (!active || active === 'overview') return '';
    const group = NAV.find((item) => item.group && item.items.some((sub) => sub.key === active));
    const item = navItems().find((i) => i.key === active);
    if (!item) return '';
    const crumbs = [html`<a href="${path('/overview')}">Overview</a>`];
    if (group) crumbs.push(html`<span>${group.group}</span>`);
    crumbs.push(item.label === title ? html`<span aria-current="page">${item.label}</span>` : html`<a href="${path(`/${item.key}`)}">${item.label}</a>`);
    if (item.label !== title) crumbs.push(html`<span aria-current="page">${title}</span>`);
    return html`<nav class="crumbs" aria-label="Breadcrumb"><ol>${crumbs.map((c) => html`<li>${c}</li>`)}</ol></nav>`;
}

/**
 * The page shell: top bar (server, theme switch, user menu), left sidebar (a drawer on
 * phones, opened by a checkbox: no script needed), breadcrumbs, then `body` (SafeHtml).
 * The theme comes from the cookie, set on <html> server-side so there is no flash.
 * `session` may carry display extras added by the routes: theme, server, path.
 * No inline styles or scripts (CSP); the one script is the static enhancement file.
 */
export function layout({ title, active = null, session = null, access = null, moduleStates = {}, body, theme: pageTheme = 'system' }) {
    const theme = themeFrom(session?.theme ?? pageTheme);
    const back = typeof session?.path === 'string' ? session.path : path(active ? `/${active}` : '/overview');
    const top = html`<header class="topbar">
${session ? html`<label for="nav-toggle" class="icon-button nav-button" tabindex="0" role="button" aria-label="Menu">${icon('menu')}</label>` : ''}
<a class="brand" href="${path('/overview')}"><span class="brand-mark" aria-hidden="true">M</span><span class="brand-name">Meowist</span></a>
<span class="spacer"></span>
${themeToggle(theme, back)}${session ? userMenu(session, access) : ''}</header>`;
    return html`<!doctype html><html lang="en"${theme === 'system' ? '' : html` data-theme="${theme}"`}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><meta name="color-scheme" content="light dark"><title>${title} · Meowist dashboard</title><link rel="stylesheet" href="${CSS_PATH}"><script src="${JS_PATH}" defer></script></head>
<body>${raw(ICON_SPRITE_MARKUP)}<a class="skip" href="#main">Skip to content</a>${session ? raw('<input type="checkbox" id="nav-toggle" class="nav-toggle" aria-controls="sidebar">') : ''}${top}
<div class="${session ? 'shell' : 'shell bare'}">${session ? html`${sidebar(active, moduleStates, session.server)}<label for="nav-toggle" class="scrim" aria-hidden="true"></label>` : ''}
<main id="main" tabindex="-1">${breadcrumbs(active, title)}${body}</main></div></body></html>`.text;
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
    return layout({ title, session, ...extra, body: html`<div class="message card"><h1>${title}</h1><p>${message}</p></div>` });
}