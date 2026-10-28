// html.js — tiny server-side HTML templating and the page shell of the web dashboard.
//
// `html` is a tagged template: every interpolated value is HTML-escaped unless it is
// the result of another `html` call (or `raw`, for the few trusted constants). Arrays
// are joined. null / undefined / false render as nothing. There is no other way to
// put text into a page, so user-provided strings are always escaped.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
 * The sidebar. `state` names the on/off indicator from moduleStates, where the module
 * has an on/off setting; `toggle` is the module action behind its main switch (module
 * page header); `summary` (one line on the Modules page cards) marks a settings module.
 * Groups: Moderation, Community, Server (design system v2).
 */
export const NAV = [
    { key: 'overview', label: 'Overview' },
    { key: 'modules', label: 'Modules' },
    { group: 'Moderation', items: [
        { key: 'cases', label: 'Cases' },
        { key: 'appeals', label: 'Appeals' },
        { key: 'users', label: 'Members' },
        { key: 'enforcement', label: 'Enforcement & appeals', keywords: 'mod log, evidence, muted role, warning roles, appeal window, cooldown, mass-action guard, ladder, reasons, appeal panel', summary: 'Log channels, warning roles, appeal timings, appeal panels.' },
        { key: 'automod', label: 'Automod', state: 'automod', toggle: 'enabled', keywords: 'spam, links, invites, bad words, raid, lockdown, panic, join gate, trusted, second chance, mood, native automod, slowmode', summary: 'Rule modes, exceptions, join gate, raid panic.' },
        { key: 'nocontact', label: 'No-contact' },
        { key: 'staff', label: 'Staff' },
    ] },
    { group: 'Community', items: [
        { key: 'welcome', label: 'Welcome & goodbye', state: 'welcome', keywords: 'join message, leave message, goodbye, greeting, auto role, autorole, embed', summary: 'Join and leave messages, auto roles.' },
        { key: 'leveling', label: 'Leveling', state: 'leveling', toggle: 'enabled', keywords: 'xp, levels, rank, level up message, role rewards, leaderboard, no xp channels', summary: 'XP, level-up messages, role rewards.' },
        { key: 'reaction-roles', label: 'Reaction roles', keywords: 'self roles, role menu, buttons, select menu', summary: 'Self-assign role menus.' },
        { key: 'tickets', label: 'Tickets & modmail', state: 'tickets', keywords: 'ticket panel, support, modmail, canned answers, saved replies, staff role, transcript', summary: 'Ticket panel, modmail, saved answers.' },
        { key: 'giveaways', label: 'Giveaways', keywords: 'prize, winners, reroll, end giveaway', summary: 'Start, end and reroll giveaways.' },
        { key: 'birthdays', label: 'Birthdays', state: 'birthdays', keywords: 'birthday channel, birthday role, timezone', summary: 'Birthday announcements and role.' },
        { key: 'applications', label: 'Applications', state: 'applications', toggle: 'enabled', keywords: 'apply, staff application, questions, managers', summary: 'Role applications and their questions.' },
        { key: 'community', label: 'Community', keywords: 'suggestions, starboard, sticky message, tags, youtube feed', summary: 'Suggestions, starboard, stickies, tags, feeds.' },
        { key: 'join-to-create', label: 'Join to create', state: 'joinToCreate', keywords: 'temporary voice, voice channels, jtc', summary: 'Temporary voice channels.' },
    ] },
    { group: 'Server', items: [
        { key: 'logging', label: 'Logging', state: 'logging', toggle: 'enabled', keywords: 'audit log, message delete, edits, joins, leaves, ignore channels, events', summary: 'Which server events are logged, and where.' },
        { key: 'verification', label: 'Verification', state: 'verification', keywords: 'verify, captcha, verified role, auto-verify, panel', summary: 'Verify panel or auto-verify on join.' },
        { key: 'counters', label: 'Counters', keywords: 'member count, stats channels, counting game', summary: 'Member counters and the counting game.' },
        { key: 'commands', label: 'Commands', keywords: 'disable command, enable command, categories, permissions', summary: 'Turn commands and categories on or off.' },
        { key: 'support', label: 'Support server', keywords: 'banned role, support server', summary: 'The banned role in the support server.' },
        { key: 'audit', label: 'Audit log' },
    ] },
];

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

/**
 * The top-level sections of the rail (desktop) and tab bar (phones): Overview, Modules, then
 * one per NAV group. A group's link opens its first page; its pages are tabs on the page.
 */
const SECTION_ICON = { overview: 'overview', modules: 'modules', Moderation: 'enforcement', Community: 'users', Server: 'server' };
export function sections() {
    return NAV.map((item) => (item.group
        ? { key: item.group.toLowerCase(), label: item.group, icon: SECTION_ICON[item.group] || 'overview', href: path(`/${item.items[0].key}`), items: item.items }
        : { key: item.key, label: item.label, icon: SECTION_ICON[item.key] || item.key, href: path(`/${item.key}`), items: null }));
}

/** The section a page belongs to (by its sidebar key). */
function sectionOf(active) {
    return sections().find((sec) => (sec.items ? sec.items.some((i) => i.key === active) : sec.key === active)) || null;
}

/** Desktop: the floating rail (icons with tooltips; theme switch and account at the bottom). */
function rail(active, theme, back, session, access) {
    const current = sectionOf(active);
    return html`<nav class="rail" aria-label="Sections"><a class="rail-logo" href="${path('/overview')}" aria-label="Meowist: Overview">${icon('cat')}</a>
<ul class="rail-list">${sections().map((sec) => html`<li><a class="rail-item${current?.key === sec.key ? ' on' : ''}" href="${sec.href}"${current?.key === sec.key ? raw(' aria-current="true"') : ''}>${icon(sec.icon)}<span class="rail-tip">${sec.label}</span></a></li>`)}</ul>
<div class="rail-bottom">${themeToggle(theme, back, 'rail-item')}${userMenu(session, access)}</div></nav>`;
}

/** A section's pages as pill tabs above the content (with the module on/off dot). */
function sectionTabs(active, moduleStates) {
    const sec = sectionOf(active);
    if (!sec?.items) return '';
    return html`<nav class="section-tabs" aria-label="${sec.label}">${sec.items.map((item) => {
        const state = stateOf(item, moduleStates);
        const on = item.key === active;
        return html`<a href="${path(`/${item.key}`)}"${on ? raw(' class="on" aria-current="page"') : ''}>${icon(item.key)}${item.label}${state === null ? ''
            : html`<span class="dot ${state ? 'dot-on' : 'dot-off'}"><span class="sr">${state ? 'on' : 'off'}</span></span>`}</a>`;
    })}</nav>`;
}

/** Phones: a floating tab bar; "More" is a sheet (details, no script) with the rest. */
function tabBar(active, theme, back, session, access) {
    const current = sectionOf(active);
    const main = sections().filter((sec) => ['overview', 'moderation', 'modules', 'community'].includes(sec.key));
    const rest = sections().filter((sec) => !main.some((m) => m.key === sec.key));
    const moreOn = rest.some((sec) => sec.key === current?.key);
    return html`<nav class="tabbar" aria-label="Sections">${main.map((sec) => html`<a href="${sec.href}"${current?.key === sec.key ? raw(' class="on" aria-current="true"') : ''}>${icon(sec.icon)}<span>${sec.key === 'overview' ? 'Home' : sec.label}</span></a>`)}
<details class="more menu-wrap"><summary${moreOn ? raw(' class="on"') : ''}>${icon('menu')}<span>More</span></summary><div class="more-sheet">
${rest.map((sec) => html`<p class="more-group">${sec.label}</p>${(sec.items || [{ key: sec.key, label: sec.label }]).map((item) => html`<a href="${path(`/${item.key}`)}"${item.key === active ? raw(' aria-current="page"') : ''}>${icon(item.key)}${item.label}</a>`)}`)}
<div class="more-foot">${themeToggle(theme, back, 'more-theme', true)}<form method="post" action="${path('/logout')}"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit" class="ghost">${icon('logout')}Log out</button></form></div></div></details></nav>`;
}

// The switch cycles system (follow the device) → dark → light.
export const THEMES = ['system', 'dark', 'light'];
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
function themeToggle(theme, back, className = 'icon-button', withText = false) {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    return html`<a class="${className}" href="${path(`/theme${queryString({ mode: next, next: back })}`)}" data-theme-toggle data-theme="${theme}" title="${THEME_LABEL[theme]} (switch to ${THEME_LABEL[next].toLowerCase()})">${icon(THEME_ICON[theme])}<span class="${withText ? 'theme-text' : 'sr'}">${THEME_LABEL[theme]}; switch to ${THEME_LABEL[next].toLowerCase()}</span></a>`;
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

function userMenu(session, access) {
    return html`<details class="user-menu menu-wrap"><summary aria-label="Account: ${session.username}"><span class="avatar-initials" aria-hidden="true">${initials(session.username)}</span><span class="user-name">${session.username}</span></summary>
<div class="menu"><p class="menu-meta"><strong>${session.username}</strong><br><span class="muted">${access && !access.canAct ? 'View and settings (bot owner)' : 'Administrator'}</span></p>
<form method="post" action="${path('/logout')}"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit" class="menu-item">${icon('logout')}Log out</button></form></div></details>`;
}

/**
 * The page shell (design v3 "Bento"): a floating icon rail with the sections (desktop), a top
 * strip with the server switcher and search, the section's pages as pill tabs, then `body`
 * (SafeHtml); on phones a floating tab bar with a "More" sheet (details: no script needed).
 * The theme comes from the cookie, set on <html> server-side so there is no flash.
 * `session` may carry display extras added by the routes: theme, server, path.
 * No inline styles or scripts (CSP); the one script is the static enhancement file.
 */
export function layout({ title, active = null, session = null, access = null, moduleStates = {}, body, theme: pageTheme = 'system' }) {
    const theme = themeFrom(session?.theme ?? pageTheme);
    const back = typeof session?.path === 'string' ? session.path : path(active ? `/${active}` : '/overview');
    const top = session ? html`<header class="page-top">${serverSwitch(session.server)}<span class="spacer"></span>
<a class="icon-button find-link" href="${path('/modules')}" aria-label="Find a setting">${icon('search')}</a><form class="quick-find" role="search" method="get" action="${path('/modules')}"><label class="sr" for="quick-find">Find a setting</label>${icon('search')}<input id="quick-find" type="search" name="q" placeholder="Find a setting…" maxlength="60" autocomplete="off" data-quick-find><kbd aria-hidden="true">/</kbd></form></header>`
        : html`<header class="page-top bare-top"><a class="brand" href="${path('/overview')}" aria-label="Meowist"><span class="brand-mark" aria-hidden="true">${icon('cat')}</span><span class="brand-name">Meowist</span></a><span class="spacer"></span>${themeToggle(theme, back)}</header>`;
    return html`<!doctype html><html lang="en"${theme === 'system' ? '' : html` data-theme="${theme}"`}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><meta name="color-scheme" content="light dark"><title>${title} · Meowist dashboard</title><link rel="stylesheet" href="${CSS_PATH}"><script src="${JS_PATH}" defer></script></head>
<body>${raw(ICON_SPRITE_MARKUP)}<a class="skip" href="#main">Skip to content</a>
<div class="${session ? 'app' : 'app bare'}">${session ? rail(active, theme, back, session, access) : ''}
<div class="page">${top}${session ? sectionTabs(active, moduleStates) : ''}<main id="main" tabindex="-1">${body}</main></div></div>
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
    return layout({ title, session, ...extra, body: html`<div class="message card"><h1>${title}</h1><p>${message}</p>${session ? html`<p class="message-actions"><a class="button-link" href="${path('/overview')}">Back to Overview</a></p>` : ''}</div>` });
}