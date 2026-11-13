// serverPicker.js — the server picker at GET /dashboard (multi-server B3, docs/multi-server-b3.md
// section 2) and the in-memory server list behind it.
//
// The login asks Discord for `identify guilds` and reads GET /users/@me/guilds once with the
// access token (the token is then dropped, as before; it is never stored). The list keeps only
// what the picker needs: id, name and icon of the servers shared with the bot or managed by the
// user (Manage Server / Administrator / owner; at most 50 without the bot), plus canManage and,
// on servers the user owns, owner + listedAt. Keyed by the Discord user id (a new login replaces
// it): in memory (at most 5,000 users) in front of the key-value store (dashboard:guildlist:<id>,
// temp_data), both gone 30 days after it was stored (the longest a session lives), so a restart
// keeps it (createGuildListStore). "Refresh server list" logs in again with prompt=none.
// A website login handed over to the dashboard (ssoHandoff.js) has no OAuth guilds token: its
// list is built from the servers Mewvo is in where the user is a member (buildBotGuildList),
// marked fromBot, and the picker offers "Refresh server list from Discord" for the full list.
//
// The list is a hint, never a permission: every shared server is re-checked live through the
// bot (access.js, ≤ 50 servers, 5 at a time) before it is shown, and every page under
// /dashboard/<guildId>/ checks access again on its own.

import { html, guildPath, layout, rootPath } from './html.js';
import { currentText, dashboardText } from './language.js';
import { installUrl } from '../site/shell.js';
import { SESSION_TTL_MS, isSnowflake } from './security.js';
import { createLruCache } from './guildDashboards.js';
import { logger } from '../../utils/logger.js';
import { deleteFromDb, getFromDb, setInDb } from '../../utils/database/wrapper.js';

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
 * The in-memory server lists of logged-in users (Discord user id → list): a new login replaces
 * the user's list. Each list is dropped 30 days after it was stored (absolute, not refreshed by
 * reading: the privacy text says "at most 30 days").
 */
export function createGuildListCache({ max = GUILD_LIST_MAX_SESSIONS, ttlMs = SESSION_TTL_MS, now } = {}) {
    return createLruCache({ max, ttlMs, now, absolute: true });
}

/** The production key-value store behind the server lists (temp_data, through the database wrapper). */
export const dbGuildListKv = Object.freeze({
    get: (key) => getFromDb(key, null),
    set: (key, value, ttlSeconds) => setInDb(key, value, ttlSeconds),
    delete: (key) => deleteFromDb(key),
});

/** The key-value key of a user's stored server list. */
export const guildListKey = (userId) => `dashboard:guildlist:${userId}`;

/**
 * A stored list read back (key-value store): only well-formed entries with the known fields,
 * at most MAX_LISTED_GUILDS; anything else → null (treated as "no list").
 */
export function sanitizeGuildList(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const entry of raw.slice(0, MAX_LISTED_GUILDS)) {
        const id = String(entry?.id ?? '');
        if (!isSnowflake(id)) continue;
        out.push({
            id,
            name: String(entry?.name ?? '').slice(0, 100) || id,
            icon: typeof entry?.icon === 'string' && ICON_HASH.test(entry.icon) ? entry.icon : null,
            canManage: entry?.canManage === true,
            ...(entry?.owner === true && Number.isFinite(Number(entry?.listedAt)) ? { owner: true, listedAt: Number(entry.listedAt) } : {}),
            ...(entry?.fromBot === true ? { fromBot: true } : {}),
        });
    }
    return out;
}

/**
 * The server lists, in memory (`memory`: createGuildListCache) in front of the key-value store
 * (`kv`: { get(key), set(key, value, ttlSeconds), delete(key) }, e.g. getFromDb / setInDb /
 * deleteFromDb). Without kv: memory only (tests, local previews). The list is a hint, never a
 * permission, so a store that does not answer is logged and the picker shows "Refresh server
 * list" (load → null); a failed save keeps the list in memory.
 */
export function createGuildListStore({ memory = createGuildListCache(), kv = null, ttlMs = SESSION_TTL_MS } = {}) {
    /** { list, error }: memory, else the key-value store (then kept in memory again); error: the store did not answer. */
    async function read(userId) {
        const id = String(userId || '');
        const cached = memory.get(id);
        if (cached !== undefined) return { list: cached, error: false };
        if (!kv || !isSnowflake(id)) return { list: null, error: false };
        let stored;
        try {
            stored = sanitizeGuildList(await kv.get(guildListKey(id)));
        } catch (error) {
            logger.warn(`Dashboard: stored server list of ${id} not read: ${error.message}`);
            return { list: null, error: true };
        }
        if (stored) memory.set(id, stored);
        return { list: stored, error: false };
    }
    return {
        memory,
        read,
        /** The user's list, or null (none, or the store did not answer: the picker offers Refresh). */
        async load(userId) {
            return (await read(userId)).list;
        },
        /** Memory only (never over a stored list the store could not read just now). */
        keepInMemory(userId, list) {
            const clean = sanitizeGuildList(list) || [];
            memory.set(String(userId || ''), clean);
            return clean;
        },
        async remember(userId, list) {
            const id = String(userId || '');
            const clean = sanitizeGuildList(list) || [];
            memory.set(id, clean);
            if (!kv || !isSnowflake(id)) return clean;
            try {
                await kv.set(guildListKey(id), clean, Math.ceil(ttlMs / 1000));
            } catch (error) {
                logger.warn(`Dashboard: server list of ${id} not stored (kept in memory): ${error.message}`);
            }
            return clean;
        },
        async forget(userId) {
            const id = String(userId || '');
            memory.delete(id);
            if (!kv || !isSnowflake(id)) return;
            try {
                await kv.delete(guildListKey(id));
            } catch (error) {
                logger.warn(`Dashboard: stored server list of ${id} not deleted: ${error.message}`);
            }
        },
    };
}

/**
 * The server list of a website login handed over to the dashboard (no OAuth guilds token): the
 * servers Mewvo is in where this user is a member, seen through the bot. The bot's member cache
 * answers first (main server first); servers where the cache has no answer are asked live,
 * at most `maxChecks` of them, `concurrency` at a time (the picker's limits). Entries are
 * { id, name, icon: null, canManage: false, fromBot: true }; the picker then checks access on
 * each one live, as for every list.
 */
export async function buildBotGuildList(client, userId, { mainGuildId = null, maxChecks = PICKER_MAX_CHECKS, concurrency = PICKER_CONCURRENCY } = {}) {
    if (!isSnowflake(String(userId || ''))) return [];
    const guilds = [...(client?.guilds?.cache?.values?.() || [])].filter((g) => isSnowflake(String(g?.id || '')));
    guilds.sort((a, b) => (a.id === mainGuildId ? -1 : b.id === mainGuildId ? 1 : 0));
    const found = [];
    const unknown = [];
    for (const guild of guilds) {
        if (guild.members?.cache?.has?.(userId)) found.push(guild);
        else unknown.push(guild);
    }
    const asked = unknown.slice(0, maxChecks);
    const members = await mapLimited(asked, concurrency, async (guild) => guild.members.fetch({ user: userId, force: false }));
    asked.forEach((guild, i) => { if (members[i]) found.push(guild); });
    const order = new Map(guilds.map((g, i) => [g.id, i]));
    return found
        .sort((a, b) => order.get(a.id) - order.get(b.id))
        .slice(0, MAX_LISTED_GUILDS)
        .map((guild) => ({ id: guild.id, name: String(guild.name || '').slice(0, 100) || guild.id, icon: null, canManage: false, fromBot: true }));
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
 * manages; only { id, name, icon, canManage }, plus `owner: true` and `listedAt` (ms) on servers the
 * user owns (proof for "Delete this server's data" after Mewvo was removed, serverDataRoutes.js).
 * Anything malformed is skipped; not an array → [].
 */
export function guildListFrom(raw, { botHas = () => false, now = Date.now() } = {}) {
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
            ...(entry?.owner === true ? { owner: true, listedAt: now } : {}),
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
        .map((g) => ({
            id: g.id, name: g.name, iconUrl: guildIconUrl(client, g.id, g.icon), href: addBotHref(clientId, g.id),
            // The owner of a server Mewvo left may ask for its stored data to be deleted.
            dataHref: g.owner === true ? rootPath(`/removed/${g.id}/data`) : null,
        }))
        .filter((g) => g.href);
    return { servers, addable, listKnown: Array.isArray(list), limited: ordered.length > checked.length, fromBot: entries.some((g) => g.fromBot === true) };
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
    const { servers = [], addable = [], listKnown = true, limited = false, fromBot = false } = picker || {};
    const list = servers.length
        ? html`<ul class="server-list">${servers.map((s) => html`<li class="card server-card">${serverIcon(s.iconUrl)}<span class="server-text"><a class="server-name" href="${s.href}">${s.name}</a>
<span class="muted">${ROLE_KEY[s.role] ? t(`role.${ROLE_KEY[s.role]}`) : ''}${s.home ? html` · ${t('home')}` : ''}</span></span>
<a class="button-link" href="${s.href}" aria-label="${t('openLabel', { name: s.name })}">${t('open')}</a></li>`)}</ul>`
        : html`<p class="empty">${t('empty')}</p>`;
    const refresh = fromBot ? html`<section class="card"><h2>${t('fromBotTitle')}</h2><p>${t('fromBotText')}</p><p><a class="button-link" href="${rootPath('?refresh=1')}">${t('refreshFromDiscord')}</a></p></section>`
        : listKnown ? html`<p class="muted">${t('refreshHint')} <a href="${rootPath('?refresh=1')}">${t('refresh')}</a></p>`
        : html`<section class="card"><h2>${t('refreshTitle')}</h2><p>${t('refreshText')}</p><p><a class="button-link" href="${rootPath('?refresh=1')}">${t('refresh')}</a></p></section>`;
    const add = addable.length
        ? html`<section class="card"><h2>${t('addTitle')}</h2><p class="muted">${t('addIntro')}</p><ul class="server-list">${addable.map((g) => html`<li class="server-card">${serverIcon(g.iconUrl)}<span class="server-text"><span class="server-name">${g.name}</span></span>
<a class="button-link" href="${g.href}" rel="noopener noreferrer" aria-label="${t('addLabel', { name: g.name })}">${t('add')}</a>${g.dataHref ? html` <a href="${g.dataHref}" aria-label="${tr.t('serverData.picker.label', { name: g.name })}">${tr.t('serverData.picker.link')}</a>` : ''}</li>`)}</ul></section>`
        : '';
    const owner = session?.isOwner ? html`<p><a href="${rootPath('/owner')}">${t('ownerArea')}</a></p>` : '';
    const body = html`<div class="picker">${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}<h1>${t('title')}</h1>
<p class="muted">${t('intro', { name: session?.username || '' })}</p>
${list}${limited ? html`<p class="muted">${tr.t('servers.limited', { count: PICKER_MAX_CHECKS })}</p>` : ''}
${refresh}${add}${owner}
<form method="post" action="${rootPath('/logout')}"><input type="hidden" name="csrf" value="${session?.csrf || ''}"><button type="submit" class="ghost">${tr.t('frame.user.logout')}</button></form>
<form method="post" action="${rootPath('/logout-all')}"><input type="hidden" name="csrf" value="${session?.csrf || ''}"><button type="submit" class="ghost">${tr.t('frame.user.logoutAll')}</button></form>
<p class="muted">${t('logoutAllHint')}</p></div>`;
    return layout({ title: t('title'), session: null, body, theme, lang: tr.lang });
}
