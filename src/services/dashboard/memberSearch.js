// memberSearch.js — "Find a member" for every dashboard form that needs a user: a search by name,
// nickname or ID instead of a typed user ID.
//
//   createMemberSearch()  the search itself: guild.members.search (Discord's name/nickname
//                         prefix search, REST) + the member cache (any part of the name) + the
//                         ban list where a banned user is a valid answer. Results are cached for
//                         a short time per query; each user gets a rate limit (routes.js).
//   memberField()         the form field: a text input that still takes a raw ID or @mention,
//                         a "Find a member by name" link (works without JS) and, with JS, a
//                         type-ahead list (dashboard.js, data-member-search → the JSON endpoint).
//   memberSearchPage()    the server-rendered results page behind that link: each result has a
//                         "Use" link back to the form with the ID filled in.
//   parseUserRef()        a raw ID or <@mention> → the ID (what the forms accept on submit).

import { createRateLimiter } from './security.js';
import { html, layout, path, queryString } from './html.js';
import { logger } from '../../utils/logger.js';

export const SEARCH_PATH = '/members/search';
export const SEARCH_JSON_PATH = '/members/search.json';
export const MAX_RESULTS = 10;
export const QUERY_MAX = 100;
export const SEARCH_RATE = { limit: 30, windowMs: 60 * 1000 };
const CACHE_TTL_MS = 30 * 1000;
const BAN_TTL_MS = 60 * 1000;
const CACHE_MAX = 200;
const FIELD_RE = /^[a-z][a-z0-9_]{0,23}$/;
const ANCHOR_RE = /^[a-z0-9-]{1,60}$/;

/** A raw user ID or a <@id> / <@!id> mention → the ID, else null. */
export function parseUserRef(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    const match = /^<@!?(\d{17,20})>$/.exec(text) || /^(\d{17,20})$/.exec(text);
    return match ? match[1] : null;
}

function memberResult(member) {
    const user = member?.user || {};
    const id = user.id || member?.id;
    if (!id) return null;
    return {
        id: String(id),
        name: String(member.nickname || user.globalName || user.username || id),
        username: String(user.username || id),
        bot: Boolean(user.bot),
        banned: false,
    };
}

function banResult(ban) {
    const user = ban?.user || {};
    if (!user.id) return null;
    return { id: String(user.id), name: String(user.globalName || user.username || user.id), username: String(user.username || user.id), bot: Boolean(user.bot), banned: true };
}

const fields = (r) => [r.name, r.username, r.id].map((v) => String(v).toLowerCase());

/** Exact name first, then names that start with the query, then the rest; A–Z inside each. */
function rank(results, needle) {
    const score = (r) => (fields(r).some((v) => v === needle) ? 0 : fields(r).some((v) => v.startsWith(needle)) ? 1 : 2);
    return results.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/**
 * The search with its cache and rate limiter. search(guild, query, { includeBans }) →
 * { results: [{ id, name, username, bot, banned }], error: string | null } (never throws for a
 * Discord failure: the cached members are still returned, with `error` saying so).
 */
export function createMemberSearch({ ttlMs = CACHE_TTL_MS, banTtlMs = BAN_TTL_MS, maxEntries = CACHE_MAX, rate = SEARCH_RATE, now = () => Date.now() } = {}) {
    const cache = new Map();
    const bans = new Map();
    const limiter = createRateLimiter(rate);

    async function banList(guild) {
        const hit = bans.get(guild.id);
        if (hit && now() - hit.at < banTtlMs) return hit.list;
        const fetched = await guild.bans.fetch({ limit: 1000 });
        const list = [...(fetched?.values?.() || [])].map(banResult).filter(Boolean);
        bans.set(guild.id, { at: now(), list });
        return list;
    }

    async function lookup(guild, query, includeBans, limit) {
        const out = new Map();
        const add = (row) => { if (row && !out.has(row.id) && out.size < limit) out.set(row.id, row); };
        let error = null;
        const id = parseUserRef(query);
        if (id) {
            const member = guild.members?.cache?.get?.(id) || await guild.members?.fetch?.(id).catch(() => null);
            if (member) add(memberResult(member));
            else if (includeBans && guild.bans) {
                const ban = guild.bans.cache?.get?.(id) || await guild.bans.fetch?.(id).catch(() => null);
                add(banResult(ban));
            }
            return { results: [...out.values()], error };
        }
        if (query.length < 2) return { results: [], error: 'Type at least 2 letters of the name.' };
        const needle = query.toLowerCase();
        for (const member of guild.members?.cache?.values?.() || []) {
            const row = memberResult(member);
            if (row && fields(row).some((v) => v.includes(needle))) add(row);
            if (out.size >= limit) break;
        }
        if (out.size < limit && typeof guild.members?.search === 'function') {
            try {
                const found = await guild.members.search({ query, limit, cache: true });
                for (const member of found?.values?.() || []) add(memberResult(member));
            } catch (err) {
                logger.warn(`Dashboard member search failed: ${err.message}`);
                error = 'Discord did not answer the search, so only members Mewvo already knows are listed.';
            }
        }
        if (includeBans && guild.bans && out.size < limit) {
            try {
                for (const row of await banList(guild)) if (fields(row).some((v) => v.includes(needle))) add(row);
            } catch (err) {
                logger.warn(`Dashboard ban list for member search failed: ${err.message}`);
                error = error || 'The ban list could not be loaded, so banned users are not listed.';
            }
        }
        return { results: rank([...out.values()], needle), error };
    }

    async function search(guild, rawQuery, { includeBans = false, limit = MAX_RESULTS } = {}) {
        const query = String(rawQuery ?? '').trim().slice(0, QUERY_MAX);
        if (!guild || !query) return { results: [], error: null };
        const key = `${guild.id}|${includeBans ? 1 : 0}|${limit}|${query.toLowerCase()}`;
        const hit = cache.get(key);
        if (hit && now() - hit.at < ttlMs) return hit.value;
        const value = await lookup(guild, query, includeBans, limit);
        if (!value.error) {
            cache.set(key, { at: now(), value });
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        return value;
    }

    return { search, allow: (key) => limiter.allow(key) };
}

// ── The form field and the results page ───────────────────────────────────

/** A dashboard path with `key=value` set in its query (other values kept, an old `key` replaced). */
function withQuery(back, key, value) {
    const [pathname, query = ''] = String(back).split('?');
    const params = new URLSearchParams(query);
    params.set(key, value);
    return `${pathname}?${params.toString()}`;
}

/** The "Find a member by name" link of a field (the no-JS way to search). */
export function findMemberHref({ pick, back, anchor = '', bans = false, q = '' }) {
    return path(`${SEARCH_PATH}${queryString({ for: pick, back, at: anchor, bans: bans ? '1' : '', q })}`);
}

/**
 * A member field. `name`: the form field (posted value: an ID, or what was typed); `pick`: the
 * query key the results page fills in on `back` (the page reads it back as the value);
 * `bans`: banned users are valid answers too. `guild` (optional) shows who a filled-in ID is.
 */
export function memberField({ name, label, value = '', help = '', required = false, pick = name, back, anchor = '', bans = false, guild = null, inline = false, list = '' }) {
    const id = parseUserRef(String(value || ''));
    const member = id ? guild?.members?.cache?.get?.(id) : null;
    const who = member ? memberResult(member) : null;
    const json = path(`${SEARCH_JSON_PATH}${bans ? '?bans=1' : ''}`);
    const find = html`<a href="${findMemberHref({ pick, back, anchor, bans })}">Find a member by name</a>`;
    return html`<label class="member-field${inline ? ' inline-member' : ''}">${label}<input name="${name}" value="${value || ''}" maxlength="40" autocomplete="off" spellcheck="false" placeholder="Name, @mention or user ID" data-member-search="${json}"${list ? html` list="${list}"` : ''}${required ? html` required` : ''}>
<span class="hint">${who ? html`Picked: <b>${who.name}</b> (@${who.username}). ` : ''}${help ? html`${help} ` : ''}${find}</span></label>`;
}

/**
 * The form value of a member field: an ID or mention → the ID; empty → null when optional.
 * Anything else is refused with `message` (thrown by the caller's error type via `fail`).
 */
export function memberFieldValue(raw, { optional = false, fail }) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
        if (optional) return null;
        throw fail();
    }
    const id = parseUserRef(text);
    if (!id) throw fail();
    return id;
}

/** Validated query of the results page: { q, pick, back, anchor, bans } (bad values dropped). */
export function searchParams(query = {}, safeBack) {
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const pick = str(query.for, 24);
    const anchor = str(query.at, 60);
    return {
        q: str(query.q, QUERY_MAX),
        pick: FIELD_RE.test(pick) ? pick : '',
        back: safeBack(str(query.back, 300)),
        anchor: ANCHOR_RE.test(anchor) ? anchor : '',
        bans: str(query.bans, 1) === '1',
    };
}

/** The "Use" link of one result: back to the form, the ID filled in, scrolled to the form. */
export function useHref({ back, pick, anchor }, id) {
    return `${withQuery(back, pick, id)}${anchor ? `#s-${anchor}` : ''}`;
}

/** The results page (GET /dashboard/members/search). */
export function memberSearchPage({ session, access = null, moduleStates = {}, params, results = null, error = null, theme, lang }) {
    const { q, pick, back, anchor, bans } = params;
    const form = html`<form method="get" action="${path(SEARCH_PATH)}" class="inline-form" role="search">
<input type="hidden" name="for" value="${pick}"><input type="hidden" name="back" value="${back}">${anchor ? html`<input type="hidden" name="at" value="${anchor}">` : ''}${bans ? html`<input type="hidden" name="bans" value="1">` : ''}
<label>Name, nickname or user ID<input type="search" name="q" value="${q}" maxlength="${QUERY_MAX}" required autofocus></label><button type="submit">Search</button></form>`;
    const list = results === null ? '' : results.length
        ? html`<div class="scroll"><table><thead><tr><th>Member</th><th>Username</th><th>User ID</th><th></th></tr></thead><tbody>
${results.map((r) => html`<tr><td><b>${r.name}</b>${r.bot ? html` <span class="muted">bot</span>` : ''}${r.banned ? html` <span class="warn">banned</span>` : ''}</td><td>@${r.username}</td><td><code>${r.id}</code></td>
<td>${pick ? html`<a class="button-link" href="${useHref(params, r.id)}">Use</a>` : html`<a href="${path(`/users/${r.id}`)}">Open</a>`}</td></tr>`)}
</tbody></table></div>`
        : html`<p class="empty">No member matches "${q}".${bans ? ' Banned users were searched too.' : ''} Discord matches the start of a name or nickname.</p>`;
    const body = html`<header class="page-head"><h1>Find a member</h1></header>
<p class="muted help">Search by name, nickname or user ID${bans ? ', including banned users' : ''}. Pick one to fill it into the form.</p>
${error ? html`<p class="warn" role="alert">${error}</p>` : ''}
${form}
${list}
<p><a href="${back}${anchor ? `#s-${anchor}` : ''}">Back to the form</a></p>`;
    return layout({ title: 'Find a member', active: null, session, access, moduleStates, body, theme, lang });
}

/** The ID "Find a member" filled in on a page (?<key>=<id>), else ''. */
export function pickedFromQuery(query, key) {
    const value = query?.[key];
    return typeof value === 'string' ? parseUserRef(value) || '' : '';
}

/** The JSON of the type-ahead: `<`, `>` and `&` escaped so it is safe even if sniffed as HTML. */
export function searchJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
