// site.js — the front website at the site root: Home, Commands, About, /robots.txt and
// the stylesheet. Server-rendered with the dashboard's `html` template (every value escaped),
// no scripts at all and no inline styles (CSP: style-src 'self', script-src 'none').
//
//   GET /            Home: what Meowist does
//   GET /commands    the commands every member may use (EVERYONE_COMMANDS + the loaded descriptions)
//   GET /about       who runs it
//   GET /leaderboard the main server's leveling leaderboard, 50 a page (?page=)
//   GET /status      Online / Starting / Degraded and the uptime, nothing else
//   GET /privacy     what the bot stores and why (written from the code, nothing invented)
//   GET /terms       the short rules for using the bot
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
import { enforcementConfig } from '../../config/enforcement.js';
import { getLeaderboard, getLevelingConfig } from '../leveling/leveling.js';
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
<li><a href="/leaderboard"${current('leaderboard')}>Leaderboard</a></li>
<li><a href="/about"${current('about')}>About</a></li>
${ctx.memberPortal ? html`<li><a href="/me"${current('me')}>My record</a></li>` : ''}`;
}

/** The footer-only links: status and the legal pages. */
function footerLinks(ctx, active) {
    const current = (key) => (key === active ? raw(' aria-current="page"') : '');
    return html`<li><a href="/status"${current('status')}>Status</a></li>
<li><a href="/privacy"${current('privacy')}>Privacy</a></li>
<li><a href="/terms"${current('terms')}>Terms</a></li>`;
}

function addButton(ctx, className = 'button') {
    return ctx.publicSite && ctx.installUrl
        ? html`<a class="${className}" href="${ctx.installUrl}" rel="noopener" data-add-bot>Add to your server</a>`
        : '';
}

// `refresh` (seconds) adds a <meta http-equiv="refresh">: the status page reloads itself without a script.
export function layout(ctx, { title, active = null, description = '', refresh = 0, body }) {
    // The way into the dashboard, like other bots' sites: a filled button unless "Add to your server" is shown.
    const login = ctx.dashboardEnabled ? html`<a class="button${ctx.publicSite && ctx.installUrl ? ' button-quiet' : ''}" href="${DASHBOARD_PATH}">Dashboard</a>` : '';
    return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">${ctx.publicSite ? '' : html`<meta name="robots" content="${NOINDEX}">`}
<title>${title === 'Meowist' ? 'Meowist' : `${title} · Meowist`}</title>${refresh > 0 ? html`<meta http-equiv="refresh" content="${Math.floor(refresh)}">` : ''}${description ? html`<meta name="description" content="${description}">` : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${CSS_PATH}"></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="topbar"><div class="wrap topbar-inner"><a class="brand" href="/"${active === 'home' ? raw(' aria-current="page"') : ''}>${LOGO}<span>Meowist</span></a>
<nav class="topnav" aria-label="Main"><ul>${navLinks(ctx, active)}</ul></nav>
<div class="topbar-actions">${addButton(ctx)}${login}</div></div></header>
<main id="main" tabindex="-1">${body}</main>
<footer class="footer"><div class="wrap footer-inner"><p class="footer-brand">${LOGO}<span>Meowist</span></p>
<nav aria-label="Footer"><ul>${navLinks(ctx, active)}${footerLinks(ctx, active)}${ctx.dashboardEnabled ? html`<li><a href="${DASHBOARD_PATH}">Dashboard</a></li>` : ''}</ul></nav></div></footer>
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

// ── Leaderboard ───────────────────────────────────────────────────────────

export const LEADERBOARD_PAGE_SIZE = 50;
const MAX_LEADERBOARD_PAGE = 1000;
const LEADERBOARD_CACHE_MS = 60 * 1000;
const LEADERBOARD_CACHE_MAX = 20;

/** ?page= as a whole number from 1 to MAX_LEADERBOARD_PAGE; anything else is page 1. */
export function leaderboardPageNumber(value) {
    const text = String((Array.isArray(value) ? value[0] : value) ?? '').trim();
    if (!/^\d{1,4}$/.test(text)) return 1;
    return Math.min(Math.max(Number(text), 1), MAX_LEADERBOARD_PAGE);
}

/**
 * The real leaderboard reader: ({ offset, limit }) → { enabled, rows: [{ rank, name, level, totalXp }] }.
 * Reads the main server (MAIN_GUILD_ID) through the same services as /leaderboard. Throws when
 * the bot is not connected yet, the server is not set or a read fails: the page then says the
 * leaderboard could not be loaded (503) instead of showing an empty one.
 * Members who ran /wipedata have no user_levels row any more (wipedataButtons.js deletes
 * getUserLevelKey → postgresDatabase.js deleteStructuredData 'user_level'), so they are not listed.
 * Names: the member's server display name; anyone who left shows as "Former member" (never an ID).
 * Each page is cached for a minute (one promise per page, so concurrent views share a read):
 * getLeaderboard fetches uncached members from the gateway, which an open page must not hammer.
 */
export function createLeaderboardReader(client, { guildId = () => enforcementConfig.mainGuildId, now = () => Date.now() } = {}) {
    const cache = new Map();
    const read = async ({ offset, limit }) => {
        const id = guildId();
        if (!id) throw new Error('MAIN_GUILD_ID is not set');
        if (!client?.isReady?.()) throw new Error('the bot is not connected yet');
        const guild = client.guilds?.cache?.get(id);
        if (!guild) throw new Error('the main server is not in the cache');
        const config = await getLevelingConfig(client, id);
        if (!config?.enabled) return { enabled: false, rows: [] };
        // Cache only: a public page view never makes the bot fetch members from Discord.
        const entries = await getLeaderboard(client, id, limit, offset, { fetchMissing: false });
        return {
            enabled: true,
            rows: entries.map((entry) => ({
                rank: entry.rank,
                name: guild.members.cache.get(entry.userId)?.displayName || 'Former member',
                level: entry.level,
                totalXp: entry.totalXp,
            })),
        };
    };
    return ({ offset, limit }) => {
        const key = `${offset}:${limit}`;
        const hit = cache.get(key);
        if (hit && hit.until > now()) return hit.promise;
        const promise = read({ offset, limit });
        cache.delete(key);
        cache.set(key, { promise, until: now() + LEADERBOARD_CACHE_MS });
        while (cache.size > LEADERBOARD_CACHE_MAX) cache.delete(cache.keys().next().value);
        // A failed read is not cached: the next view tries again.
        promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
        return promise;
    };
}

const formatNumber = (value) => (Number(value) || 0).toLocaleString('en-US');

/** `board` is the reader's result (with one row too many when there is a next page), or null when the read failed. */
export function leaderboardPage(ctx, { page, board }) {
    const head = html`<h1>Leaderboard</h1>
<p class="lead">The most active members of the Meowist server by level and total XP. You earn XP by chatting; members who delete their data with <code>/wipedata</code> are not listed.</p>`;
    let content;
    if (!board) {
        content = html`<p class="notice notice-bad" role="alert">The leaderboard could not be loaded right now. Nothing was changed; please try again in a minute.</p>`;
    } else if (!board.enabled) {
        content = html`<p class="notice">Leveling is turned off on the Meowist server, so there is no leaderboard right now.</p>`;
    } else {
        const rows = board.rows.slice(0, LEADERBOARD_PAGE_SIZE);
        const hasNext = board.rows.length > LEADERBOARD_PAGE_SIZE;
        const link = (n, label, rel) => html`<a class="button button-quiet" href="/leaderboard${n > 1 ? `?page=${n}` : ''}" rel="${rel}">${label}</a>`;
        const pager = page > 1 || hasNext
            ? html`<nav class="pager" aria-label="Leaderboard pages">${page > 1 ? link(page - 1, 'Previous', 'prev') : ''}<span class="pager-current">Page ${page}</span>${hasNext ? link(page + 1, 'Next', 'next') : ''}</nav>`
            : '';
        content = rows.length
            ? html`<div class="table-wrap"><table class="board"><caption class="visually-hidden">Leaderboard, page ${page}</caption>
<thead><tr><th scope="col">Rank</th><th scope="col">Member</th><th scope="col">Level</th><th scope="col">Total XP</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td class="num">${r.rank}</td><td class="board-name">${r.name}</td><td class="num">${r.level}</td><td class="num">${formatNumber(r.totalXp)}</td></tr>`)}</tbody></table></div>${pager}`
            : html`<p class="notice">${page > 1 ? 'There is nobody on this page.' : 'Nobody has earned XP yet.'}</p>${page > 1 ? html`<p><a class="button button-quiet" href="/leaderboard">Back to the first page</a></p>` : ''}`;
    }
    return layout(ctx, {
        title: page > 1 ? `Leaderboard, page ${page}` : 'Leaderboard', active: 'leaderboard',
        description: 'The Meowist server leveling leaderboard.',
        body: html`<div class="wrap page">${head}${content}</div>`,
    });
}

// ── Status ────────────────────────────────────────────────────────────────

/**
 * online / starting / degraded, decided like /ready in app.js: the Discord client is ready and
 * the database is not degraded. Only the state and the uptime leave this function: no counts,
 * IDs, schema version or memory (those stay on /health and /ready).
 */
export function botStatus(client) {
    if (!client?.isReady?.()) return { state: 'starting', uptimeMs: null };
    const db = client.db?.getStatus?.() || { isDegraded: true };
    const uptime = Number(client.uptime);
    return { state: db.isDegraded ? 'degraded' : 'online', uptimeMs: Number.isFinite(uptime) && uptime >= 0 ? uptime : null };
}

/** "3 days, 4 hours", "12 minutes", "less than a minute": the two largest units. */
export function uptimeWords(ms) {
    const total = Math.floor(Number(ms) / 60000);
    if (!Number.isFinite(total) || total < 1) return 'less than a minute';
    const units = [['day', Math.floor(total / 1440)], ['hour', Math.floor((total % 1440) / 60)], ['minute', total % 60]];
    const first = units.findIndex(([, n]) => n > 0);
    return units.slice(first, first + 2).filter(([, n]) => n > 0).map(([unit, n]) => `${n} ${unit}${n === 1 ? '' : 's'}`).join(', ');
}

const STATUS_TEXT = {
    online: { label: 'Online', text: 'Meowist is running normally.' },
    starting: { label: 'Starting', text: 'Meowist is starting or reconnecting to Discord. Commands answer again in a moment.' },
    degraded: { label: 'Degraded', text: 'Meowist is connected to Discord but its database is not responding. Commands that read or save data may fail until it recovers.' },
};

export function statusPage(ctx, status) {
    const state = STATUS_TEXT[status?.state] ? status.state : 'degraded';
    const { label, text } = STATUS_TEXT[state];
    const uptime = state !== 'starting' && Number.isFinite(status?.uptimeMs) ? status.uptimeMs : null;
    return layout(ctx, {
        title: 'Status', active: 'status', refresh: 60,
        description: 'Whether the Meowist bot is online.',
        body: html`<div class="wrap page"><h1>Status</h1>
<p class="status status-${state}"><span class="status-dot" aria-hidden="true"></span>${label}</p>
<p class="lead">${text}</p>
${uptime !== null ? html`<p>Up for ${uptimeWords(uptime)}.</p>` : ''}
<p class="note">This page refreshes every minute.${ctx.supportInvite ? html` Something not working? <a href="${ctx.supportInvite}" rel="noopener">Tell us in the support server</a>.` : ''}</p></div>`,
    });
}

// ── Privacy and terms ─────────────────────────────────────────────────────

export const LEGAL_UPDATED = '2026-10-29';
const updatedLine = () => html`<p class="note">Last updated <time datetime="${LEGAL_UPDATED}">29 October 2026</time>.</p>`;
const contactLine = (ctx) => (ctx.supportInvite
    ? html`<a href="${ctx.supportInvite}" rel="noopener">the support server</a>`
    : 'the staff team on the Meowist server');

// Written from what the code stores (utils/database/schema.js, oauthVerification.js,
// verificationGuard.js, wipedataButtons.js, dashboard/security.js, utils/logger.js); nothing invented.
export function privacyPage(ctx) {
    return layout(ctx, {
        title: 'Privacy', active: 'privacy',
        description: 'What the Meowist bot stores about you and why.',
        body: html`<div class="wrap page prose"><h1>Privacy</h1>
${updatedLine()}
<p class="lead">What Meowist stores, why, and how to have it removed. Meowist is run by its owner for the Meowist Discord server. Your data is never sold or used for advertising.</p>
<h2>In short</h2>
<ul><li>Meowist works with Discord IDs (the numbers that identify accounts, servers and channels). Where a record needs a readable name, such as a moderation case, the username at that moment is saved with it.</li>
<li>Everything is kept in a PostgreSQL database used only by the bot. Nothing is shared, except with Discord, which the bot runs on, and the services that host the bot and its database.</li>
<li>Meowist never asks for your email address or your password.</li></ul>
<h2>Leveling</h2>
<p>For each server: your XP, your level and when your last message counted towards XP. The text of your messages is not saved for this. Levels are shown on the server’s leaderboard and on this website’s leaderboard (your server display name, level and total XP).</p>
<h2>Moderation records</h2>
<p>When staff warn, mute, kick or ban someone, Meowist saves a case: the case code, the type, the reason, who took the action, when, how long it lasts, whether it can be appealed and whether the DM about it was delivered. Changes to a case are kept as its history. Staff can attach evidence: links to messages with a short excerpt of the text (kept in case the message is deleted) and images, which are re-posted in a staff-only channel. Your step on the warning ladder is stored per server and is never reset automatically.</p>
<p>A case that turns out to be a mistake can be voided: it stays on record but no longer counts.</p>
<h2>Appeals, reports, tickets and modmail</h2>
<ul><li><strong>Appeals and staff reports:</strong> what you write in the form, the decision, who made it and the staff note. The conversation happens in a Discord channel; when an appeal is decided, a transcript of that channel is posted to a staff-only channel.</li>
<li><strong>Tickets:</strong> a record of the ticket channel, who opened it and its state. A transcript is posted to a staff-only channel when it closes.</li>
<li><strong>Modmail:</strong> when you message the bot and choose to send it to staff, your messages are passed on to a staff channel. The database only keeps which channel belongs to which member; when the conversation is closed, a transcript is posted to a staff-only channel.</li></ul>
<h2>Verification</h2>
<p>If a server uses “Verify with Discord”, you sign in with Discord and allow two things: <code>identify</code> (your account’s ID and name) and <code>guilds.join</code> (so the bot can add you to the support server, which keeps appeal messages reaching you even after a ban). The sign-in tokens Discord gives the bot are stored encrypted (AES-256-GCM).</p>
<p>To spot people coming back on a new account after a ban, Meowist stores a keyed one-way hash of the IP address you verified from, never the address itself. These hashes are deleted after 60 days, unless the account has an active ban on the Meowist server. Accounts younger than 7 days, and accounts that match a banned member’s hash, are held for a person on the staff team to approve; a match alone never refuses anyone. Verification actions (for example verified, or approved by staff) are recorded with their time.</p>
<h2>Server logs and member history</h2>
<p>If a server turns on logging, events such as joins, leaves, role changes and edited or deleted messages (including their text) are posted to that server’s staff log channels on Discord. Joins and leaves are also kept in the database for 90 days, for the staff’s member statistics.</p>
<h2>Things you choose to save</h2>
<p>Features you use store what you give them, for example your birthday if you set one, your AFK message, your suggestions and votes, and giveaway entries.</p>
<h2>The dashboard (staff only)</h2>
<p>Staff who sign in to the dashboard with Discord (<code>identify</code> only) get a session that ends after 12 hours. The database keeps a hash of the session ID with their ID, username and avatar. Every change made in the dashboard is written to an audit log: who changed which setting, from what, to what.</p>
<h2>The bot’s own logs</h2>
<p>Technical logs record what the bot did and the errors it ran into, so problems can be fixed. They are deleted automatically after 7 days (error logs after 14 days).</p>
<h2>Deleting your data</h2>
<p>Run <code>/wipedata</code> in a server to delete your levels and XP, your economy balance and your AFK status in that server. It does not delete moderation records, appeals, reports or verification records: those are the server’s safety records and stay so decisions can be checked later. For anything else, ask in ${contactLine(ctx)}.</p>
<h2>Blocked accounts</h2>
<p>Accounts or servers blocked from using the bot are recorded with the reason and who blocked them. Lifting a block keeps the entry as history.</p>
<h2>Changes and contact</h2>
<p>When what Meowist stores changes, this page is updated along with the date above. Questions about your data: ask in ${contactLine(ctx)}.</p></div>`,
    });
}

export function termsPage(ctx) {
    return layout(ctx, {
        title: 'Terms', active: 'terms',
        description: 'The rules for using the Meowist bot.',
        body: html`<div class="wrap page prose"><h1>Terms</h1>
${updatedLine()}
<p class="lead">The short rules for using Meowist. By using the bot you accept them.</p>
<h2>Using the bot</h2>
<ul><li>Follow Discord’s Terms of Service and Community Guidelines, and the rules of the server you are in.</li>
<li>Don’t use Meowist to harass anyone, to spam, or to get around a punishment.</li>
<li>Don’t try to break, overload or misuse the bot, this website or the dashboard.</li></ul>
<h2>Moderation decisions</h2>
<p>Meowist carries out what a server’s staff decide. Warnings, mutes, kicks and bans are decisions of that server’s staff team; the automatic steps of the warning ladder follow the rules that server has set.</p>
<h2>Appeals</h2>
<p>If a punishment can be appealed, the DM about it says how. One appeal per case can be open at a time, and staff decide and tell you the result. Some punishments cannot be appealed; the DM says so.</p>
<h2>Being blocked</h2>
<p>The bot’s owner can block an account or a server from using Meowist, for example for abusing it.</p>
<h2>No warranty</h2>
<p>Meowist is provided as it is, for free, without any promise that it is always available, free of errors or fit for a particular purpose. It can change, pause or stop at any time.</p>
<h2>Your data</h2>
<p>See the <a href="/privacy">privacy page</a> for what Meowist stores and how to delete it.</p>
<h2>Changes</h2>
<p>These terms can change; the date above shows the latest version. Questions: ask in ${contactLine(ctx)}.</p></div>`,
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
 * `leaderboard({ offset, limit })` and `status()` default to the real readers on `client`;
 * tests pass fakes.
 */
export function createSite({
    client = null, env = process.env, dashboardEnabled = false, memberPortalEnabled = false, supportInvite = () => null,
    leaderboard = createLeaderboardReader(client), status = () => botStatus(client),
} = {}) {
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
    router.get('/privacy', page(privacyPage));
    router.get('/terms', page(termsPage));
    // Always 200: it is a page about the bot, not a health check (that is /ready).
    router.get('/status', page((ctx) => {
        let current;
        try { current = status(); } catch { current = { state: 'degraded', uptimeMs: null }; }
        return statusPage(ctx, current);
    }));
    // One row more than a page is read, only to know whether there is a next page.
    router.get('/leaderboard', async (req, res) => {
        const number = leaderboardPageNumber(req.query.page);
        let board = null;
        try {
            board = await leaderboard({ offset: (number - 1) * LEADERBOARD_PAGE_SIZE, limit: LEADERBOARD_PAGE_SIZE + 1 });
        } catch (error) {
            logger.warn(`Site leaderboard could not be loaded: ${error.message}`);
        }
        res.set('Cache-Control', 'no-cache');
        res.status(board ? 200 : 503).type('html').send(leaderboardPage(context(), { page: number, board }));
    });
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
export function registerSite(app, client, { env = process.env, dashboardEnabled = false, memberPortalEnabled = false, supportInvite, leaderboard, status } = {}) {
    app.use(createSite({ client, env, dashboardEnabled, memberPortalEnabled, supportInvite, leaderboard, status }));
    logger.info(`Front site at / (${publicSiteEnabled(env) ? 'public' : 'not public: noindex, no add button (PUBLIC_SITE_ENABLED)'})`);
}
