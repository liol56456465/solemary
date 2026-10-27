// html.js — tiny server-side HTML templating and the page shell of the web dashboard.
//
// `html` is a tagged template: every interpolated value is HTML-escaped unless it is
// the result of another `html` call (or `raw`, for the few trusted constants). Arrays
// are joined. null / undefined / false render as nothing. There is no other way to
// put text into a page, so user-provided strings are always escaped.

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

/** A dashboard URL: path('/cases') → '/dashboard/cases'. */
export function path(suffix = '') {
    return `${BASE}${suffix}`;
}

/**
 * The sidebar. `state` names the on/off indicator from moduleStates, where the module
 * has an on/off setting. Every entry is a working page (Phase 2: settings pages).
 */
export const NAV = [
    { key: 'overview', label: 'Overview' },
    { group: 'Records', items: [
        { key: 'users', label: 'Members' },
        { key: 'cases', label: 'Cases' },
        { key: 'appeals', label: 'Appeals' },
        { key: 'nocontact', label: 'No-contact' },
        { key: 'staff', label: 'Staff' },
    ] },
    { group: 'Settings', items: [
        { key: 'enforcement', label: 'Enforcement & appeals' },
        { key: 'automod', label: 'Automod', state: 'automod' },
        { key: 'logging', label: 'Logging', state: 'logging' },
        { key: 'welcome', label: 'Welcome & goodbye', state: 'welcome' },
        { key: 'tickets', label: 'Tickets', state: 'tickets' },
        { key: 'leveling', label: 'Leveling', state: 'leveling' },
        { key: 'verification', label: 'Verification', state: 'verification' },
        { key: 'reaction-roles', label: 'Reaction roles' },
        { key: 'giveaways', label: 'Giveaways' },
        { key: 'birthdays', label: 'Birthdays', state: 'birthdays' },
        { key: 'counters', label: 'Counters' },
        { key: 'join-to-create', label: 'Join to create', state: 'joinToCreate' },
        { key: 'applications', label: 'Applications', state: 'applications' },
        { key: 'community', label: 'Community' },
        { key: 'commands', label: 'Commands' },
        { key: 'support', label: 'Support server' },
    ] },
    { key: 'audit', label: 'Audit log' },
];

/** Every sidebar entry, flattened. */
export function navItems() {
    return NAV.flatMap((item) => (item.group ? item.items : [item]));
}

function navLink(item, active, moduleStates) {
    const state = item.state && Object.hasOwn(moduleStates, item.state) ? moduleStates[item.state] : null;
    const classes = item.key === active ? 'on' : '';
    return html`<li><a href="${path(`/${item.key}`)}"${classes ? raw(` class="${classes}"`) : ''}${item.key === active ? raw(' aria-current="page"') : ''}>
<span>${item.label}</span>${state === null ? '' : html`<span class="state ${state ? 'state-on' : 'state-off'}">${state ? 'on' : 'off'}</span>`}</a></li>`;
}

function sidebar(active, moduleStates) {
    return html`<input type="checkbox" id="nav-toggle" class="nav-toggle"><label for="nav-toggle" class="nav-button">Menu</label>
<nav class="sidebar" aria-label="Modules"><ul>${NAV.map((item) => (item.group
        ? html`<li class="group"><span class="group-label">${item.group}</span><ul>${item.items.map((sub) => navLink(sub, active, moduleStates))}</ul></li>`
        : navLink(item, active, moduleStates)))}</ul></nav>`;
}

/**
 * The page shell. `session` adds the sidebar, the user and the logout form; `body`
 * must be SafeHtml. No inline styles or scripts (CSP: style-src 'self', no scripts).
 */
export function layout({ title, active = null, session = null, access = null, moduleStates = {}, body }) {
    const user = session ? html`<div class="user"><span>${session.username}</span>${access && !access.canAct ? html` <span class="tag">view and settings</span>` : ''}
<form method="post" action="${path('/logout')}" class="inline"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit">Log out</button></form></div>` : '';
    return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><title>${title} · Meowist dashboard</title><link rel="stylesheet" href="${CSS_PATH}"></head>
<body><header class="top"><a class="brand" href="${path('/overview')}">Meowist dashboard</a>${user}</header>
<div class="${session ? 'shell' : 'shell bare'}">${session ? sidebar(active, moduleStates) : ''}<main>${body}</main></div></body></html>`.text;
}

/** A plain message page (errors, 403, …). */
export function messagePage(title, message, session = null, extra = {}) {
    return layout({ title, session, ...extra, body: html`<h1>${title}</h1><p>${message}</p>` });
}

