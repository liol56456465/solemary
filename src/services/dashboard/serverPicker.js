// serverPicker.js — the server picker at GET /dashboard (multi-server B3, docs/multi-server-b3.md
// section 2) and the in-memory server list behind it.
//
// The login asks Discord for `identify guilds` and reads GET /users/@me/guilds once with the
// access token (the token is then dropped, as before; nothing is stored in the database). The
// list keeps only what the picker needs: id, name and icon of the servers shared with the bot
// or managed by the user (Manage Server / Administrator / owner; at most 50 without the bot), keyed by
// the Discord user id (a new login replaces it), at most 5,000 users, gone 12 h after it was stored (absolute) or after a restart ("Refresh server
// list" then logs in again with prompt=none).
//
// The list is a hint, never a permission: every shared server is re-checked live through the
// bot (access.js, ≤ 50 servers, 5 at a time) before it is shown, and every page under
// /dashboard/<guildId>/ checks access again on its own.

import { html, guildPath, layout, rootPath } from './html.js';
import { currentText, dashboardText } from './language.js';
import { installUrl } from '../site/shell.js';
import { SESSION_TTL_MS, isSnowflake } from './security.js';
import { createLruCache } from './guildDashboards.js';

export const GUILD_LIST_MAX_SESSIONS = 5000;
export const PICKER_MAX_CHECKS = 50;
export const PICKER_CONCURRENCY = 5;
const MAX_LISTED_GUILDS = 200; // /users/@me/guilds returns at most 200 per page
const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;
const ICON_HASH = /^(a_)?[0-9a-f]{32}$/;

/** At most this many "Add Mewvo" servers are stored per user (servers without the bot). */
export const MAX_ADDABLE_GUILDS = 50;

/**
 * The server lists of logged-in users (Discord user id → list): a new login replaces the
 * user's list. Each list is dropped 12 h after it was stored (absolute, not refreshed by
 * reading: the privacy text says "at most 12 hours").
 */
export function createGuildListCache({ max = GUILD_LIST_MAX_SESSIONS, ttlMs = SESSION_TTL_MS, now } = {}) {
    return createLruCache({ max, ttlMs, now, absolute: true });
}

/** True when the OAuth guild entry says the user owns the server or has Manage Server / Administrator there. */
export function canManageFromOAuth(entry) {
    if (entry?.owner === true) return true;
    try {
        const bits = BigInt(String(entry?.permissions ?? '0'));
        return (bits & ADMINISTRATOR) === ADMINISTRATOR || (bits & MANAGE_GUILD) === MANAGE_GUILD;
    } catch {
        return false;
    }
}

/**
 * The stored list from Discord's answer: only servers the bot is in (`botHas(id)`) or the user
 * manages; only { id, name, icon, canManage }. Anything malformed is skipped; not an array → [].
 */
export function guildListFrom(raw, { botHas = () => false } = {}) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    let addable = 0;
    for (const entry of raw.slice(0, MAX_LISTED_GUILDS)) {
        const id = String(entry?.id ?? '');
        if (!isSnowflake(id)) continue;
        const canManage = canManageFromOAuth(entry);
        const shared = botHas(id);
        if (!shared && !canManage) continue;
        // Servers without the bot are only kept for "Add Mewvo": a bounded number of them.
        if (!shared && (addable += 1) > MAX_ADDABLE_GUILDS) continue;
        out.push({
            id,
            name: String(entry?.name ?? '').slice(0, 100) || id,
            icon: typeof entry?.icon === 'string' && ICON_HASH.test(entry.icon) ? entry.icon : null,
            canManage,
        });
    }
    return out;
}

function guildIconUrl(client, id, hash = null) {
    const guild = client?.guilds?.cache?.get(id);
    let url = null;
    try {
        url = guild && typeof guild.iconURL === 'function' ? guild.iconURL({ size: 64, extension: 'png' }) : null;
    } catch {
        url = null;
    }
    if (!url && hash) url = `https://cdn.discordapp.com/icons/${id}/${hash}.png?size=64`;
    return url && /^https:\/\/cdn\.discordapp\.com\//.test(url) ? url : null;
}

/** The "Add Mewvo" link for one server: the install link with that server pre-selected. */
export function addBotHref(clientId, guildId) {
    const base = installUrl(clientId);
    if (!base || !isSnowflake(String(guildId))) return null;
    return `${base}&${new URLSearchParams({ guild_id: String(guildId), disable_guild_select: 'true' })}`;
}

/** Runs `fn` over `items`, `limit` at a time; results in order. */
async function mapLimited(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next;
            next += 1;
            results[i] = await fn(items[i]).catch(() => null);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * What the picker shows:
 *   servers  shared servers the user may open now (live check), the home server first
 *   addable  servers the user manages where the bot is absent ("Add Mewvo")
 *   listKnown false after a restart (no stored list: "Refresh server list")
 *   limited  true when more than PICKER_MAX_CHECKS shared servers were left unchecked
 * deps: { client, list (stored list or null), mainGuildId, isOwner, checkAccess(guildId) → decision,
 *   isBlockedGuild(guildId), clientId }.
 */
export async function collectPicker({
    client, list = null, mainGuildId = null, isOwner = false, checkAccess, isBlockedGuild = () => false, clientId = '',
    maxChecks = PICKER_MAX_CHECKS, concurrency = PICKER_CONCURRENCY,
}) {
    const botHas = (id) => Boolean(client?.guilds?.cache?.has?.(id));
    const entries = Array.isArray(list) ? list : [];
    const known = new Map(entries.map((g) => [g.id, g]));
    // Candidates: shared servers from the list, plus the main server (bot owners always; anyone
    // when the list is unknown, so its staff still find it after a restart). Support folds into main.
    const ids = entries.filter((g) => botHas(g.id)).map((g) => g.id);
    if (mainGuildId && botHas(mainGuildId) && !ids.includes(mainGuildId) && (isOwner || !Array.isArray(list))) ids.unshift(mainGuildId);
    const ordered = [...ids].sort((a, b) => (a === mainGuildId ? -1 : b === mainGuildId ? 1 : 0)).filter((id) => !isBlockedGuild(id));
    const checked = ordered.slice(0, maxChecks);
    const decisions = await mapLimited(checked, concurrency, async (id) => checkAccess(id));
    const servers = [];
    checked.forEach((id, i) => {
        const decision = decisions[i];
        if (!decision?.allowed) return;
        const guild = client?.guilds?.cache?.get(id);
        servers.push({
            id, name: guild?.name || known.get(id)?.name || id, iconUrl: guildIconUrl(client, id, known.get(id)?.icon),
            role: decision.role || null, home: id === mainGuildId, href: guildPath(id, '/overview'),
        });
    });
    const addable = entries
        .filter((g) => g.canManage && !botHas(g.id) && !isBlockedGuild(g.id))
        .map((g) => ({ id: g.id, name: g.name, iconUrl: guildIconUrl(client, g.id, g.icon), href: addBotHref(clientId, g.id) }))
        .filter((g) => g.href);
    return { servers, addable, listKnown: Array.isArray(list), limited: ordered.length > checked.length };
}

const ROLE_KEY = { admin: 'admin', manager: 'manager', moderator: 'moderator', owner: 'owner' };

function serverIcon(url) {
    return url ? html`<img class="server-icon" src="${url}" alt="" width="40" height="40" referrerpolicy="no-referrer">` : '';
}

/**
 * The picker page (no sidebar: no server is chosen yet). `session` carries username, csrf,
 * isOwner; `picker` is collectPicker's result.
 */
export function pickerPage({ session, picker, lang = null, theme = 'system', flash = null }) {
    const tr = lang ? dashboardText(lang) : currentText();
    const t = (key, params) => tr.t(`servers.${key}`, params);
    const { servers = [], addable = [], listKnown = true, limited = false } = picker || {};
    const list = servers.length
        ? html`<ul class="server-list">${servers.map((s) => html`<li class="card server-card">${serverIcon(s.iconUrl)}<span class="server-text"><a class="server-name" href="${s.href}">${s.name}</a>
<span class="muted">${ROLE_KEY[s.role] ? t(`role.${ROLE_KEY[s.role]}`) : ''}${s.home ? html` · ${t('home')}` : ''}</span></span>
<a class="button-link" href="${s.href}" aria-label="${t('openLabel', { name: s.name })}">${t('open')}</a></li>`)}</ul>`
        : html`<p class="empty">${t('empty')}</p>`;
    const refresh = listKnown ? html`<p class="muted">${t('refreshHint')} <a href="${rootPath('?refresh=1')}">${t('refresh')}</a></p>`
        : html`<section class="card"><h2>${t('refreshTitle')}</h2><p>${t('refreshText')}</p><p><a class="button-link" href="${rootPath('?refresh=1')}">${t('refresh')}</a></p></section>`;
    const add = addable.length
        ? html`<section class="card"><h2>${t('addTitle')}</h2><p class="muted">${t('addIntro')}</p><ul class="server-list">${addable.map((g) => html`<li class="server-card">${serverIcon(g.iconUrl)}<span class="server-text"><span class="server-name">${g.name}</span></span>
<a class="button-link" href="${g.href}" rel="noopener noreferrer" aria-label="${t('addLabel', { name: g.name })}">${t('add')}</a></li>`)}</ul></section>`
        : '';
    const owner = session?.isOwner ? html`<p><a href="${rootPath('/owner')}">${t('ownerArea')}</a></p>` : '';
    const body = html`<div class="picker">${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}<h1>${t('title')}</h1>
<p class="muted">${t('intro', { name: session?.username || '' })}</p>
${list}${limited ? html`<p class="muted">${tr.t('servers.limited', { count: PICKER_MAX_CHECKS })}</p>` : ''}
${refresh}${add}${owner}
<form method="post" action="${rootPath('/logout')}"><input type="hidden" name="csrf" value="${session?.csrf || ''}"><button type="submit" class="ghost">${tr.t('frame.user.logout')}</button></form></div>`;
    return layout({ title: t('title'), session: null, body, theme, lang: tr.lang });
}
