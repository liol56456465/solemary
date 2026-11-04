// language.js — which language a website request is in, and the URL / cookie rules around it.
//
//   /de/features        German: the prefix is stripped before the page routes (req.siteLang = 'de')
//   /en/features        301 → /features (English has no prefix)
//   /xx/features        not a language: the normal 404
//   /de/dashboard, /de/img/…  not a page: the site's 404 (in German); never the dashboard
//   …?setlang=1         the visitor picked this language in the picker: the mewvo_lang cookie is
//                       set to the page's language and the same page is reloaded without ?setlang
//
// The cookie (1 year, SameSite=Lax, Path=/) is a preference set on the visitor's own click, so no
// consent banner is needed; it is listed in the Privacy Policy's cookie table. It never moves a
// visitor to another URL by itself: an unprefixed page only shows a small "also available in" note.
// /me pages have no prefix: their language is the cookie, else Accept-Language, else English.
//
// Every value from a header or cookie is matched against LANG_CODES before use; nothing raw is
// ever reflected into a page or a redirect.

import { parseCookies } from '../dashboard/security.js';
import {
    DEFAULT_LANG, LANGUAGES, LANG_CODES, isPagePath, languageByPrefix, localizePath, normalizePagePath,
} from './i18n.js';

export const LANG_COOKIE = 'mewvo_lang';
export const LANG_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const MAX_ACCEPT_LANGUAGE = 512;

/** The mewvo_lang cookie's language, or null when it is missing or not one of LANG_CODES. */
export function cookieLanguage(cookieHeader) {
    const value = parseCookies(cookieHeader)[LANG_COOKIE];
    return LANG_CODES.includes(value) ? value : null;
}

/**
 * The best supported language in an Accept-Language header, or null. "de-AT" matches de,
 * "pt" and "pt-PT" match pt-BR (the only Portuguese), "*" and unknown tags are skipped; q=0 never
 * matches. Ties keep the header's order.
 */
export function acceptLanguage(header) {
    const text = String(header || '').slice(0, MAX_ACCEPT_LANGUAGE);
    const entries = [];
    text.split(',').slice(0, 30).forEach((part, index) => {
        const [tag, ...params] = part.trim().split(';');
        let q = 1;
        for (const p of params) {
            const m = /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/i.exec(p);
            if (m) q = Number(m[1]);
        }
        if (!/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(tag || '') || !(q > 0)) return;
        entries.push({ tag: tag.toLowerCase(), q, index });
    });
    entries.sort((a, b) => b.q - a.q || a.index - b.index);
    for (const { tag } of entries) {
        const exact = LANG_CODES.find((code) => code.toLowerCase() === tag);
        if (exact) return exact;
        const primary = tag.split('-')[0];
        const loose = LANG_CODES.find((code) => code.toLowerCase().split('-')[0] === primary);
        if (loose) return loose;
    }
    return null;
}

/** The language for a page without a URL prefix (/me…): cookie → Accept-Language → English. */
export function requestLanguage(req) {
    return cookieLanguage(req?.headers?.cookie) || acceptLanguage(req?.headers?.['accept-language']) || DEFAULT_LANG;
}

/**
 * The other language to offer on an unprefixed (English) page, or null: the cookie's language when
 * it is set to something else than English; with no cookie, the best Accept-Language match.
 * A cookie set to English means "the visitor chose English": nothing is offered.
 */
export function suggestedLanguage(req) {
    const cookie = cookieLanguage(req?.headers?.cookie);
    const lang = cookie || acceptLanguage(req?.headers?.['accept-language']);
    return lang && lang !== DEFAULT_LANG ? lang : null;
}

/** The Set-Cookie value for a chosen language. */
export function languageCookie(lang, { secure = false } = {}) {
    if (!LANG_CODES.includes(lang)) throw new Error('languageCookie: unknown language');
    return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The query string of a request URL without `setlang` ("" or "?page=2"), re-encoded. */
function queryWithout(url, name) {
    const params = new URL(url, 'http://localhost').searchParams;
    params.delete(name);
    const text = params.toString();
    return text ? `?${text}` : '';
}

/** The picker link for a public page in a language: "/de/features?setlang=1" (path may carry a query). */
export function pickerHref(lang, path = '/') {
    const target = localizePath(lang, isPagePath(String(path).split(/[?#]/)[0]) ? path : '/');
    return `${target}${target.includes('?') ? '&' : '?'}setlang=1`;
}

/**
 * The site router's first step for GET/HEAD: strips a known language prefix from page URLs
 * (req.siteLang), 301s /en/… to the unprefixed page, and handles ?setlang=1 (cookie + 302 to the
 * same page). Anything else passes unchanged (unknown prefixes → the 404 page).
 */
export function languageRouting(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const match = /^\/([^/]+)(\/.*)?$/.exec(req.path);
    if (match) {
        const rest = match[2] || '/';
        if (match[1] === 'en') {
            // Only real pages: the target is always one of our own paths, never a user-supplied URL.
            if (!isPagePath(rest)) return next();
            return res.redirect(301, `${normalizePagePath(rest)}${queryWithout(req.url, '')}`);
        }
        const language = languageByPrefix(match[1]);
        if (language) {
            req.siteLang = language.code;
            if (isPagePath(rest)) {
                const q = req.url.indexOf('?');
                req.url = `${rest}${q === -1 ? '' : req.url.slice(q)}`;
                req.sitePrefixed = true;
            }
        }
    }
    const lang = req.siteLang || DEFAULT_LANG;
    // Unprefixed pages may carry the "also available in" note: it depends on these two headers.
    if (!req.siteLang && isPagePath(req.path)) res.vary('Accept-Language').vary('Cookie');
    if (req.query?.setlang !== undefined && (req.sitePrefixed || (!req.siteLang && isPagePath(req.path)))) {
        res.append('Set-Cookie', languageCookie(lang, { secure: Boolean(req.secure) }));
        res.set('Cache-Control', 'no-store');
        return res.redirect(302, `${localizePath(lang, normalizePagePath(req.path))}${queryWithout(req.url, 'setlang')}`);
    }
    return next();
}

/** The native names, for the picker. */
export const LANGUAGE_NAMES = Object.freeze(Object.fromEntries(LANGUAGES.map((l) => [l.code, l.name])));
