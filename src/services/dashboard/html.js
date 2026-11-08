// html.js — tiny server-side HTML templating and the page shell of the web dashboard.
//
// `html` is a tagged template: every interpolated value is HTML-escaped unless it is
// the result of another `html` call (or `raw`, for the few trusted constants). Arrays
// are joined. null / undefined / false render as nothing. There is no other way to
// put text into a page, so user-provided strings are always escaped.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ICON_SPRITE_MARKUP, hasIcon } from './icons.js';
import { allows, levelLabel } from './permissions.js';
import { isHomeOnlyPage } from './homeOnly.js';
import { html, raw } from './safeHtml.js';
import { LANGUAGES, currentLanguage, currentText, dashboardText } from './language.js';

export { escapeHtml, html, raw } from './safeHtml.js';

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
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A <time> showing formatDate (in the request's language: fmtDateTime); the static script turns it
 * into "5 min ago" (UTC stays in the tooltip).
 */
export function timeTag(value) {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return html`<time datetime="${date.toISOString()}" data-relative>${currentText().fmtDateTime(date)}</time>`;
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
 * A short hash of a static file, added to its URL (?v=…). That exact URL is cached for a year
 * (immutable, routes.js serveStatic); a deploy changes the hash, so pages never run old files.
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

// ── The server of the running request (multi-server B3) ──────────────────
// The guild router runs each request under /dashboard/<guildId>/… inside runInGuild, so every
// path() a page or handler builds keeps that prefix (links, form actions, 303 Locations).
// Global pages (picker, login, theme/lang/nav, Owner area) run outside: path() has no prefix.
const guildContext = new AsyncLocalStorage();

/** Runs `fn` with `guildId` as the request's server (path() then builds /dashboard/<guildId>/…). */
export function runInGuild(guildId, fn) {
    return guildContext.run({ guildId: String(guildId) }, fn);
}

/** The running request's server id, or null on global pages / outside a request. */
export function currentGuildId() {
    return guildContext.getStore()?.guildId || null;
}

/** A dashboard URL of the current server: path('/cases') → '/dashboard/<guildId>/cases' ('/dashboard/cases' outside one). */
export function path(suffix = '') {
    const guildId = currentGuildId();
    return guildId ? `${BASE}/${guildId}${suffix}` : `${BASE}${suffix}`;
}

/** A global dashboard URL (never under a server): rootPath('/theme') → '/dashboard/theme'; rootPath() → the server picker. */
export function rootPath(suffix = '') {
    return `${BASE}${suffix}`;
}

/** A URL of one server's dashboard: guildPath('123…', '/cases') → '/dashboard/123…/cases'. */
export function guildPath(guildId, suffix = '') {
    return `${BASE}/${guildId}${suffix}`;
}

/** A sidebar entry's link: Owner pages are global, everything else belongs to the current server. */
export function navHref(key) {
    const text = String(key || '');
    return text === 'owner' || text.startsWith('owner/') ? rootPath(`/${text}`) : path(`/${text}`);
}
const ACTION_ICON = { ban: 'nocontact', kick: 'kick', mute: 'mute', warn: 'warn' };

/** An enforcement action badge: neutral outline + icon + the word; red only for ban. */
export function typeBadge(type) {
    const name = String(type || '');
    const word = ACTION_ICON[name] ? currentText().t(`frame.action.${name}`) : name ? name[0].toUpperCase() + name.slice(1) : '';
    return html`<span class="type type-${name}">${ACTION_ICON[name] ? icon(ACTION_ICON[name]) : ''}${word}</span>`;
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
        { key: 'overview', main: true, label: 'Overview' },
        { key: 'inbox', main: true, label: 'Inbox' },
        { key: 'users', main: true, label: 'Members' },
        { key: 'bans', label: 'Banned' },
        { key: 'cases', main: true, label: 'Cases' },
        { key: 'appeals', main: true, label: 'Appeals' },
        { key: 'nocontact', label: 'Keep apart' },
        { key: 'staff', label: 'Staff' },
        { key: 'activity', label: 'Activity' },
        { key: 'incidents', label: 'Raid timeline' },
        { key: 'channels', label: 'Channel tools' },
    ] },
    { group: 'Community', items: [
        { key: 'tickets', main: true, label: 'Tickets & modmail', state: 'tickets', keywords: 'ticket panel, support, modmail, canned answers, saved replies, staff role, transcript, open tickets category, closed tickets category, ticket log channel', summary: 'Members ask staff for help in a private channel.' },
        { key: 'welcome', main: true, label: 'Welcome & goodbye', state: 'welcome', keywords: 'join message, leave message, goodbye, greeting, auto role, autorole, embed, image, banner, colour', summary: 'Greet new members, say goodbye, give a starting role.' },
        { key: 'leveling', main: true, label: 'Leveling', state: 'leveling', toggle: 'enabled', keywords: 'xp, levels, rank, level up message, role rewards, leaderboard, no xp channels', summary: 'Members earn levels for chatting and get roles for them.' },
        { key: 'reaction-roles', label: 'Reaction roles', keywords: 'self roles, role menu, buttons, select menu', summary: 'Menus where members pick their own roles.' },
        { key: 'messages', main: true, label: 'Messages', keywords: 'post as the bot, send message, embed, embed builder, announcement, poll, vote, countdown, timer', summary: 'Post announcements, polls and countdowns as Mewvo.' },
        { key: 'giveaways', label: 'Giveaways', keywords: 'prize, winners, reroll, end giveaway, random member, random user, pick a member', summary: 'Give away prizes to random members.' },
        { key: 'birthdays', label: 'Birthdays', state: 'birthdays', keywords: 'birthday channel, birthday role, timezone', summary: 'Wish members a happy birthday.' },
        { key: 'applications', label: 'Applications', state: 'applications', toggle: 'enabled', keywords: 'apply, staff application, questions, managers', summary: 'Members apply for a role by answering questions.' },
        { key: 'community', label: 'Community', keywords: 'suggestions, starboard, sticky message, tags, youtube feed', summary: 'Suggestions, starboard, sticky notes, saved replies, YouTube.' },
        { key: 'join-to-create', label: 'Join to create', state: 'joinToCreate', keywords: 'temporary voice, voice channels, jtc', summary: 'Voice channels that appear when needed and go away when empty.' },
    ] },
    { group: 'Server setup', items: [
        { key: 'automod', main: true, label: 'Automod', state: 'automod', toggle: 'enabled', keywords: 'spam, links, invites, bad words, raid, lockdown, panic, join gate, trusted, second chance, friendly notice, heads-up, warn privately, report only, watch only, monitor, probation, extra-watch, mood, native automod, slowmode', summary: 'Stops spam, bad words and raids by itself.' },
        { key: 'enforcement', main: true, label: 'Enforcement & appeals', keywords: 'mod log, evidence, muted role, warning roles, appeal window, cooldown, mass-action guard, safety limit, ladder, reasons, appeal panel, appeals category, reports category, modmail category, alerts channel', summary: 'How warns, mutes and bans work, and how members appeal.' },
        { key: 'logging', label: 'Logging', state: 'logging', toggle: 'enabled', keywords: 'audit log, message delete, edits, joins, leaves, ignore channels, events', summary: 'A record of what happens in the server, for staff.' },
        { key: 'verification', main: true, label: 'Verification', state: 'verification', keywords: 'verify, captcha, verified role, auto-verify, panel', summary: 'New members confirm they are real before they can chat.' },
        { key: 'counters', label: 'Counters', keywords: 'member count, stats channels, counting game', summary: 'Live member counts and a counting game.' },
        { key: 'support', label: 'Support server', keywords: 'banned role, support server, ban appeals category', summary: 'Where banned members can still appeal.' },
        { key: 'rules', main: true, label: 'Rules', keywords: 'server rules, rules page, rule numbers, reasons, rule link, punishment dm', summary: 'Your server rules, shown on a web page and in punishment messages.' },
    ] },
    { group: 'Bot', items: [
        { key: 'setup', main: true, label: 'Setup step by step' },
        { key: 'help', main: true, label: 'Words explained' },
        { key: 'modules', main: true, label: 'All modules' },
        { key: 'appearance', label: 'Bot in this server', keywords: 'nickname, avatar, bot name, profile, custom bot', summary: 'Give Mewvo its own name and picture here (Pro and Max).' },
        { key: 'bot-language', label: 'Bot language', keywords: 'language, translation, translate, locale, dm language, russian, german, french, italian, polish, spanish, portuguese', summary: 'The language Mewvo uses for posts and DMs here.' },
        { key: 'commands', main: true, label: 'Commands', keywords: 'disable command, enable command, categories, permissions, prefix, moderator role, mod role, shorten, short link', summary: 'Turn single commands or groups of commands on or off.' },
        { key: 'audit', label: 'Audit log' },
        { key: 'backup', label: 'Settings backup' },
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
    { key: 'owner/premium', label: 'Premium keys', icon: 'key' },
    { key: 'owner/health', label: 'Health', icon: 'monitor' },
    { key: 'owner/commands', label: 'Command sync', icon: 'commands' },
    { key: 'owner/announce', label: 'Announce', icon: 'messages' },
    { key: 'owner/erase', label: 'Erase a case', icon: 'nocontact' },
    { key: 'owner/errors', label: 'Recent errors', icon: 'warn' },
    { key: 'owner/website', label: 'Website', icon: 'home' },
    { key: 'owner/activity', label: 'Owner activity', icon: 'audit' },
] };

// The sidebar's English labels above stay the data (search keywords, audit, tests); pages show
// them translated: navLabel(item, tr) → frame.nav.items.<key> ("owner/home" → owner_home),
// groupLabel(group, tr) → frame.nav.groups.<key>.
const GROUP_KEY = { Moderate: 'moderate', Community: 'community', 'Server setup': 'serverSetup', Bot: 'bot', Owner: 'owner' };

/** A sidebar entry's label in the page's language (the English label when the catalog has none). */
export function navLabel(item, tr = currentText()) {
    return item?.key ? tr.t(`frame.nav.items.${String(item.key).replace(/\//g, '_')}`) : '';
}

/** A sidebar group's (section's) label in the page's language. */
export function groupLabel(group, tr = currentText()) {
    const name = typeof group === 'string' ? group : group?.group ?? group?.label;
    return GROUP_KEY[name] ? tr.t(`frame.nav.groups.${GROUP_KEY[name]}`) : name;
}

/**
 * The sidebar groups for this page's viewer: NAV, plus the Owner group for bot owners.
 * With an access decision, only the pages its level may use (permissions.js); groups left
 * empty are dropped. Without one (logged-out pages, tests) everything, as before.
 */
export function navGroups(session = null, access = null) {
    // Home-only pages (homeOnly.js) are hidden in other servers (the router 404s them there).
    const nav = session?.isHomeServer === false
        ? NAV.map((group) => ({ ...group, items: group.items.filter((item) => !isHomeOnlyPage(item.key)) }))
        : NAV;
    const groups = session?.isOwner ? [...nav, OWNER_NAV] : nav;
    if (!access?.allowed) return groups;
    return groups
        .map((group) => (group === OWNER_NAV ? group : { ...group, items: group.items.filter((item) => allows(access, `page:${item.key}`)) }))
        .filter((group) => group.items.length);
}


// The sidebar shows only the main pages (main: true) unless the viewer chose "all pages"
// (a cookie, like the theme). The page being viewed is always listed.
export const NAV_COOKIE = 'mewvo_nav';
export const navModeFrom = (value) => (value === 'all' ? 'all' : 'main');

/** navGroups trimmed to the main pages (plus `active`) in the 'main' view; Owner stays whole. */
export function visibleNavGroups(session = null, access = null, active = null) {
    const groups = navGroups(session, access);
    if (navModeFrom(session?.navMode) === 'all') return groups;
    return groups
        .map((group) => (group === OWNER_NAV ? group : { ...group, items: group.items.filter((item) => item.main || item.key === active) }))
        .filter((group) => group.items.length);
}

/** How many pages the 'main' view hides from this viewer (0 in the 'all' view). */
function hiddenCount(session, access, active) {
    const all = navGroups(session, access).reduce((n, g) => n + g.items.length, 0);
    const shown = visibleNavGroups(session, access, active).reduce((n, g) => n + g.items.length, 0);
    return all - shown;
}

/** "Show all pages (12 more)" / "Show only the main pages": GET /dashboard/nav, no script needed. */
function navSwitch(session, access, active, back, tr) {
    const all = navModeFrom(session?.navMode) === 'all';
    const hidden = hiddenCount(session, access, active);
    if (!all && !hidden) return '';
    return html`<a class="nav-switch" href="${rootPath(`/nav${queryString({ mode: all ? 'main' : 'all', next: back })}`)}">${all ? tr.t('frame.nav.showMain') : tr.tp('frame.nav.showAll', hidden)}</a>`;
}

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
        href: navHref(item.items[0].key), items: item.items,
    }));
}

/** The group a page belongs to (by its sidebar key). */
function sectionOf(active, groups = NAV) {
    return sections(groups).find((sec) => sec.items.some((i) => i.key === active)) || null;
}

// The owner's logo (the website serves it at /favicon.png, same origin: CSP img-src 'self').
// Decorative: the name "Mewvo" is next to it.
const BRAND_LOGO = raw('<img class="brand-mark" src="/favicon.png" width="32" height="32" alt="">');

/** Desktop: the sidebar with every page by group; brand and server on top, account at the bottom. */
function sideNav(active, moduleStates, theme, back, session, access, tr) {
    return html`<nav class="side-nav" aria-label="${tr.t('frame.nav.label')}"><a class="side-brand" href="${path('/overview')}">${BRAND_LOGO}Mewvo</a>
${serverSwitch(session.server, tr)}
${visibleNavGroups(session, access, active).map((group) => html`<div class="side-group"><p class="side-group-label">${groupLabel(group, tr)}</p><ul class="side-list">${group.items.map((item) => {
        const state = stateOf(item, moduleStates);
        const on = item.key === active;
        const badge = item.key === 'inbox' && session.inboxCount > 0
            ? html`<span class="nav-badge">${session.inboxCount > 99 ? '99+' : tr.fmtNumber(session.inboxCount)}<span class="sr"> ${tr.t('frame.nav.waiting')}</span></span>` : '';
        return html`<li><a href="${navHref(item.key)}"${on ? raw(' aria-current="page"') : ''}><span class="side-text">${navLabel(item, tr)}</span>${badge}${state === null ? ''
            : html`<span class="dot ${state ? 'dot-on' : 'dot-off'}"><span class="sr">${state ? tr.t('frame.state.on') : tr.t('frame.state.off')}</span></span>`}</a></li>`;
    })}</ul></div>`)}
${navSwitch(session, access, active, back, tr)}
<div class="side-bottom"><a class="side-site" href="/"><span class="side-text">${tr.t('frame.nav.website')}</span></a>${userMenu(session, access, theme, back, tr)}</div></nav>`;
}

/** "Moderate / Members": where the page sits (the group, then the page). */
function crumbs(active, groups = NAV, tr = currentText()) {
    const sec = sectionOf(active, groups);
    const item = sec?.items.find((i) => i.key === active);
    if (!sec || !item) return '';
    return html`<p class="crumbs"><span>${groupLabel(sec.label, tr)}</span><span aria-hidden="true">/</span><b>${navLabel(item, tr)}</b></p>`;
}

/** Phones: a floating tab bar (the four groups); "More" is a sheet (details, no script) with every page. */
function tabBar(active, theme, back, session, access, tr) {
    const groups = navGroups(session, access);
    const current = sectionOf(active, groups);
    const main = sections(groups).slice(0, 3);
    return html`<nav class="tabbar" aria-label="${tr.t('frame.tabbar.label')}"><a href="${path('/overview')}"${active === 'overview' ? raw(' class="on" aria-current="true"') : ''}>${icon('overview')}<span>${tr.t('frame.tabbar.home')}</span></a>${main.map((sec) => html`<a href="${sec.href}"${current?.key === sec.key && active !== 'overview' ? raw(' class="on" aria-current="true"') : ''}>${icon(sec.icon)}<span>${sec.label === 'Server setup' ? tr.t('frame.tabbar.setup') : groupLabel(sec.label, tr)}</span></a>`)}
<details class="more menu-wrap"><summary${current && !main.some((sec) => sec.key === current.key) ? raw(' class="on"') : ''}>${icon('menu')}<span>${tr.t('frame.tabbar.more')}</span></summary><div class="more-sheet">
${sections(visibleNavGroups(session, access, active)).map((sec) => html`<p class="more-group">${groupLabel(sec.label, tr)}</p>${sec.items.map((item) => html`<a href="${navHref(item.key)}"${item.key === active ? raw(' aria-current="page"') : ''}>${navLabel(item, tr)}</a>`)}`)}
${navSwitch(session, access, active, back, tr)}
${themePicker(theme, back, 'sheet', tr)}<div class="more-foot"><a href="/">${icon('home')}${tr.t('frame.tabbar.website')}</a><form method="post" action="${rootPath('/logout')}"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit" class="ghost">${icon('logout')}${tr.t('frame.user.logout')}</button></form></div></div></details></nav>`;
}

// Themes (same tokens and layout, ten palettes): "system" follows the device (Paper or Graphite).
export const THEMES = ['system', 'light', 'dark', 'dim', 'contrast'];
export const THEME_COOKIE = 'mewvo_theme';
// Older theme names still in some cookies: the closest of the current ones (others: same as device).
const OLD_THEMES = { paper: 'light', white: 'light', graphite: 'dark', gray: 'dark', black: 'dark', nebula: 'dark', gold: 'dark', ocean: 'dark', forest: 'dark', ember: 'dark', arctic: 'light', sakura: 'light', sunset: 'light', sand: 'light', sage: 'dark' };

/** The theme in a cookie value: a current one, an old name mapped to the closest, or 'system'. */
export function themeFrom(value) {
    if (Object.hasOwn(OLD_THEMES, value)) return OLD_THEMES[value];
    return THEMES.includes(value) ? value : 'system';
}

/**
 * The theme picker: a radio group of links (GET /dashboard/theme sets the cookie and comes
 * back, so it works without JS; the static script switches in place). Each option shows a
 * swatch of its own theme. `id` keeps the label ids unique (account menu and phone sheet).
 */
function themePicker(theme, back, id, tr) {
    // "(in use)" after the current theme is CSS (::after); other languages give it their word.
    const inUse = tr.lang === 'en' ? '' : html` data-in-use="${tr.t('frame.theme.inUse')}"`;
    return html`<div class="theme-picker"><p class="theme-picker-title" id="theme-${id}">${tr.t('frame.theme.title')}</p><div class="theme-list" role="radiogroup" aria-labelledby="theme-${id}">${THEMES.map((key) => {
        const on = key === theme;
        return html`<a class="theme-opt" href="${rootPath(`/theme${queryString({ mode: key, next: back })}`)}" role="radio" aria-checked="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}" data-theme-pick="${key}"${inUse}>${tr.t(`frame.theme.${key}`)}</a>`;
    })}</div></div>`;
}

/**
 * The server switcher in the top bar: the server being managed and a link to the server
 * picker (GET /dashboard: every server the viewer may manage, re-checked live).
 */
function serverSwitch(server, tr) {
    if (!server) return '';
    const avatar = (size) => (server.iconUrl
        ? html`<img class="server-icon" src="${server.iconUrl}" alt="" width="${size}" height="${size}" referrerpolicy="no-referrer">`
        : '');
    return html`<details class="server-switch menu-wrap"><summary aria-label="${tr.t('frame.server.label', { name: server.name })}">${avatar(24)}<span class="server-name">${server.name}</span>${icon('chevron', 'icon icon-down')}</summary>
<div class="menu"><p class="menu-item is-current">${avatar(24)}<span class="server-text"><span class="server-name">${server.name}</span><span class="server-sub">${tr.t('frame.server.sub')}</span></span></p>
<a class="menu-item menu-link" href="${rootPath()}">${icon('server')}${tr.t('frame.server.switch')}</a>
<p class="menu-note">${tr.t('frame.server.note')}</p></div></details>`;
}

const LEVEL_KEY = { Moderator: 'frame.user.level.moderator', 'View and settings (bot owner)': 'frame.user.level.ownerView', Administrator: 'frame.user.level.administrator', 'Manage Server': 'general.access.levelManager' };

function userMenu(session, access, theme = 'system', back = path('/overview'), tr = currentText()) {
    const level = levelLabel(access);
    return html`<details class="user-menu menu-wrap"><summary aria-label="${tr.t('frame.user.label', { name: session.username })}"><span class="user-name">${session.username}</span></summary>
<div class="menu"><p class="menu-meta"><strong>${session.username}</strong><br><span class="muted">${LEVEL_KEY[level] ? tr.t(LEVEL_KEY[level]) : level}</span></p>
${themePicker(theme, back, 'menu', tr)}<a class="menu-item menu-link" href="/">${icon('home')}${tr.t('frame.nav.website')}</a><form method="post" action="${rootPath('/logout')}"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit" class="menu-item">${icon('logout')}${tr.t('frame.user.logout')}</button></form></div></details>`;
}

/**
 * The language picker in the top bar: the 8 languages by their own names, plain links to
 * GET /dashboard/lang?code=…&next=… (sets the mewvo_lang cookie, shared with the website, and comes
 * back to this page; no script needed).
 */
function languagePicker(back, tr) {
    const current = LANGUAGES.find((l) => l.code === tr.lang) || LANGUAGES[0];
    return html`<details class="lang-switch menu-wrap"><summary class="icon-button lang-button" aria-label="${tr.t('frame.language.label', { name: current.name })}"><span class="lang-code" aria-hidden="true">${current.code.slice(0, 2).toUpperCase()}</span></summary>
<div class="menu"><p class="menu-meta">${tr.t('frame.language.title')}</p>${LANGUAGES.map((l) => html`<a class="menu-item menu-link" href="${rootPath(`/lang${queryString({ code: l.code, next: back })}`)}" lang="${l.code}" hreflang="${l.code}"${l.code === current.code ? raw(' aria-current="true"') : ''}>${l.name}</a>`)}</div></details>`;
}

/**
 * The page shell (v5): the grouped sidebar (desktop), a header with where-you-are and search,
 * then `body` (SafeHtml); on phones a floating tab bar with a "More" sheet (details: no script).
 * The theme comes from the cookie, set on <html> server-side so there is no flash.
 * `session` may carry display extras added by the routes: theme, server, path.
 * No inline styles or scripts (CSP); the one script is the static enhancement file.
 */
export function layout({ title, active = null, session = null, access = null, moduleStates = {}, body, theme: pageTheme = 'system', refreshSeconds = 0, lang = null }) {
    const tr = dashboardText(lang || session?.lang || currentLanguage());
    const theme = themeFrom(session?.theme ?? pageTheme);
    const back = typeof session?.path === 'string' ? session.path : path(active ? `/${active}` : '/overview');
    // "Find a setting" searches the Modules page: not shown to levels that cannot open it.
    const find = !access?.allowed || allows(access, 'page:modules')
        ? html`<a class="icon-button find-link" href="${path('/modules')}" aria-label="${tr.t('frame.top.find')}">${icon('search')}</a><form class="quick-find" role="search" method="get" action="${path('/modules')}"><label class="sr" for="quick-find">${tr.t('frame.top.find')}</label>${icon('search')}<input id="quick-find" type="search" name="q" placeholder="${tr.t('frame.top.findPlaceholder')}" maxlength="60" autocomplete="off" data-quick-find></form>` : '';
    const top = session ? html`<header class="page-top">${crumbs(active, navGroups(session, access), tr)}<span class="spacer"></span>
${find}${languagePicker(back, tr)}</header>`
        : html`<header class="page-top bare-top"><a class="brand" href="/" aria-label="${tr.t('frame.nav.website')}">${BRAND_LOGO}<span class="brand-name">Mewvo</span></a><span class="spacer"></span></header>`;
    // The static script's own words (dialogs, "Saving…", relative times): English is built in.
    const uiText = tr.lang === 'en' ? '' : html` data-ui-text="${JSON.stringify(scriptText(tr))}"`;
    return html`<!doctype html><html lang="${tr.lang}"${theme === 'system' ? '' : html` data-theme="${theme}"`}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><meta name="color-scheme" content="light dark">${refreshSeconds > 0 ? html`<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}<title>${tr.t('frame.title', { title })}</title><link rel="icon" href="/favicon.png" type="image/png" sizes="64x64"><link rel="stylesheet" href="${CSS_PATH}"><script src="${JS_PATH}" defer></script></head>
<body${uiText}>${raw(ICON_SPRITE_MARKUP)}<a class="skip" href="#main">${tr.t('frame.skip')}</a>
<div class="${session ? 'app' : 'app bare'}">${session ? sideNav(active, moduleStates, theme, back, session, access, tr) : ''}
<div class="page">${top}<main id="main" tabindex="-1">${body}</main></div></div>
${session ? tabBar(active, theme, back, session, access, tr) : ''}</body></html>`.text;
}

/** The words the static script shows (frame.script.*), for <body data-ui-text>. */
const SCRIPT_KEYS = ['filter', 'filterLabel', 'cancel', 'continue', 'saving', 'copy', 'copyLabel', 'copied', 'copyFailed', 'justNow', 'underMinute',
    'dismiss', 'unsaved', 'unsavedIn', 'discard', 'save', 'searchModules', 'noModule'];
function scriptText(tr) {
    return Object.fromEntries(SCRIPT_KEYS.map((key) => [key, tr.t(`frame.script.${key}`, { place: '{place}', name: '{name}' })]));
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
    return html`<details class="card section" id="s-${key}" data-key="${key}"${open ? raw(' open') : ''}><summary><h2${unsavedAttr()}>${title}</h2></summary><div class="section-body">${inner}</div></details>`;
}

/**
 * The "Unsaved changes" mark is CSS (::after / ::before with content); in other languages the
 * element carries the word (data-unsaved) and the CSS shows that instead. '' in English.
 */
export function unsavedAttr(tr = currentText()) {
    return tr.lang === 'en' ? '' : html` data-unsaved="${tr.t('frame.unsaved')}"`;
}

/** A plain message page (errors, 403, …). `title` and `message` come translated (or English). */
export function messagePage(title, message, session = null, extra = {}) {
    const tr = dashboardText(extra.lang || session?.lang || currentLanguage());
    return layout({ title, session, ...extra, lang: tr.lang, body: html`<div class="message card"><h1>${title}</h1><p>${message}</p><p class="message-actions">${session && currentGuildId() ? html`<a class="button-link" href="${path('/overview')}">${tr.t('frame.message.backOverview')}</a>`
        : session ? html`<a class="button-link" href="${rootPath()}">${tr.t('frame.message.backServers')}</a>`
            : html`<a class="button-link" href="/">${tr.t('frame.message.backHome')}</a>`}</p></div>` });
}