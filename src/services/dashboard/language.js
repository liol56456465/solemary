// language.js — the dashboard's language: which one a request is in, its translator, and the
// picker's cookie. Text lives in src/content/dashboard/<lang>/<namespace>.json (same format and
// markup as the website catalog, read by the same core: site/i18n.js). See docs/dashboard-i18n.md.
//
// Order (first that gives one of the 8 languages):
//   1. the mewvo_lang cookie (shared with the website: Path=/, set by either picker)
//   2. the Discord account's language (`locale` from the login's identify call; kept in memory per
//      user, not in the database, so after a restart it is back on the next login)
//   3. the browser's Accept-Language
//   4. English
//
// Every value from a cookie, header or Discord is matched against LANG_CODES before use; nothing
// raw is reflected into a page or a redirect.
//
// Pages get the translator explicitly (session.lang → layout; ctx.t … on module pages). The few
// shared helpers that have no context (form parsing errors, pickers, pills, timeTag) read the
// request's language from an AsyncLocalStorage set by languageContext(); outside a request (tests,
// scripts) that is English.

import { AsyncLocalStorage } from 'node:async_hooks';
import { DASHBOARD_CATALOG, DEFAULT_LANG, LANGUAGES, LANG_CODES, formatNumberIn, translator } from '../site/i18n.js';
import { acceptLanguage, cookieLanguage } from '../site/language.js';
import { SafeHtml, escapeHtml, raw } from './safeHtml.js';

export { LANGUAGES };

const MAX_REMEMBERED = 5000;
const discordLocales = new Map();

/** A Discord locale ("de", "pt-BR", "es-ES", "en-US") → one of LANG_CODES, or null. */
export function languageFromDiscordLocale(locale) {
    if (typeof locale !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(locale)) return null;
    return acceptLanguage(locale);
}

/** Remembers the language of a user's Discord account (login callback). Bounded: oldest dropped first. */
export function rememberDiscordLocale(userId, locale) {
    const lang = languageFromDiscordLocale(locale);
    if (!userId) return null;
    discordLocales.delete(userId);
    if (!lang) return null;
    discordLocales.set(userId, lang);
    while (discordLocales.size > MAX_REMEMBERED) discordLocales.delete(discordLocales.keys().next().value);
    return lang;
}

/** The remembered Discord language of a user, or null. */
export function discordLanguageOf(userId) {
    return (userId && discordLocales.get(userId)) || null;
}

/** For tests. */
export function forgetDiscordLocales() {
    discordLocales.clear();
}

/** The dashboard language for a request (+ the logged-in user id, when known). */
export function dashboardLanguage(req, userId = null) {
    return cookieLanguage(req?.headers?.cookie) || discordLanguageOf(userId)
        || acceptLanguage(req?.headers?.['accept-language']) || DEFAULT_LANG;
}

// ── Translator ───────────────────────────────────────────────────────────

/** "2026-10-27 14:03 UTC" (English, as the dashboard always showed it) or the language's own date + time, UTC. */
function dateTimeIn(code, value) {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    if (code === DEFAULT_LANG) return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    return `${new Intl.DateTimeFormat(code, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
}

// tx(): a key for a text node (between tags, never in an attribute), as SafeHtml. The catalog's
// own ' and " stay as typed (like the English pages always had them); only & < > are escaped
// there. {params} are escaped fully (escapeHtml), or inserted as is when they are SafeHtml.
const TOKEN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
const textEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function textNode(code, key, params) {
    const text = DASHBOARD_CATALOG.lookup(code, key);
    let out = '';
    let last = 0;
    for (const match of text.matchAll(TOKEN)) {
        out += textEscape(text.slice(last, match.index));
        if (!params || !(match[1] in params)) throw new Error(`i18n: missing param {${match[1]}}`);
        const value = params[match[1]];
        out += value instanceof SafeHtml ? value.text : escapeHtml(value);
        last = match.index + match[0].length;
    }
    return raw(out + textEscape(text.slice(last)));
}

const TRANSLATORS = new Map();
/**
 * The dashboard translator for a language: t / ti / tb / tp / tpi (dashboard catalog), href, and
 *   fmtNumber(n)     English keeps the plain number the dashboard always showed ("12345"); others group it ("12.345")
 *   fmtDate(v, opts) a date in the language (site/i18n.js formatDateIn)
 *   fmtDateTime(v)   "2026-10-27 14:03 UTC" in English; "27.10.2026, 14:03 UTC" in German
 *   weekday(date)    "Mon" in English; the language's short weekday name otherwise (UTC)
 *   has(key)         true when the dashboard catalog has the key (in English at least)
 *   tx(key, params)  a text node (SafeHtml) that keeps the catalog's ' and " as typed; never in an attribute
 */
export function dashboardText(lang = DEFAULT_LANG) {
    const code = LANG_CODES.includes(lang) ? lang : DEFAULT_LANG;
    if (!TRANSLATORS.has(code)) {
        const base = translator(code, { catalog: 'dashboard', href: (p) => p });
        TRANSLATORS.set(code, Object.freeze({
            ...base,
            fmtNumber: (n, opts) => (code === DEFAULT_LANG ? String(n ?? '') : formatNumberIn(code, n, opts)),
            fmtDateTime: (value) => dateTimeIn(code, value),
            has: (key) => DASHBOARD_CATALOG.hasKey(code, key),
            tx: (key, params) => textNode(code, key, params),
            weekday: (date) => new Intl.DateTimeFormat(code === DEFAULT_LANG ? 'en-GB' : code, { weekday: 'short', timeZone: 'UTC' }).format(date),
        }));
    }
    return TRANSLATORS.get(code);
}

// ── The request's language for helpers without a context ─────────────────

const requestLanguage = new AsyncLocalStorage();

/** Express middleware: runs the rest of the request with its language (refined after login by setRequestLanguage). */
export function languageContext(req, res, next) {
    return requestLanguage.run({ lang: dashboardLanguage(req) }, next);
}

/** Sets the language of the running request (requireUser, once the user is known). */
export function setRequestLanguage(lang) {
    const store = requestLanguage.getStore();
    if (store && LANG_CODES.includes(lang)) store.lang = lang;
}

/** The running request's language ('en' outside a request). */
export function currentLanguage() {
    return requestLanguage.getStore()?.lang || DEFAULT_LANG;
}

/** The translator of the running request (or `lang` when given). */
export function currentText(lang = null) {
    return dashboardText(lang || currentLanguage());
}

/** The translator for a module context (ctx.lang), else the running request's. */
export function textFor(ctx) {
    return dashboardText(ctx?.lang || currentLanguage());
}

/** "reaction-roles" → "reactionRoles": a module page's catalog namespace (src/content/dashboard/<lang>/<namespace>.json). */
export function namespaceOf(moduleKey) {
    return String(moduleKey).replace(/[-/](.)/g, (_, c) => c.toUpperCase());
}
