// i18n.js — website text catalog, languages and a small safe markup.
//
// Text lives in src/content/site/<lang>/<namespace>.json (nested objects; key "home.hero.title" is
// home.json → { "hero": { "title": "…" } }). English is complete; other languages fall back to
// English key by key. The owner's Website editor (dashboard Owner → Website, siteContent.js) can
// override any key per language through setContentOverrides(); overrides use the same markup, so
// they are just as safe.
//
// Three ways to read a key (all escape everything; nothing in a catalog can inject HTML):
//   t(key, params)   plain text (a string; html`` escapes it again, harmlessly)
//   ti(key, params)  inline markup → SafeHtml: **bold**, *italic*, `code`, [text](href)
//   tb(key, params)  block markup → SafeHtml: blank line = new paragraph, lines starting "- " = list,
//                    single newline = <br>
// Params: {name} in the text. A plain value is escaped; a SafeHtml value (html``) is inserted as is,
// so pages can pass links or <code> they built themselves. In a link target only plain params are
// allowed, and the final href must be a site path ("/…", not "//…"), https:, mailto: or "#…".

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeHtml, raw } from '../dashboard/html.js';
import { logger } from '../../utils/logger.js';

/** Website languages: code, URL prefix ('' = no prefix), the name shown in the picker. */
export const LANGUAGES = Object.freeze([
    { code: 'en', prefix: '', name: 'English' },
    { code: 'ru', prefix: 'ru', name: 'Русский' },
    { code: 'de', prefix: 'de', name: 'Deutsch' },
    { code: 'fr', prefix: 'fr', name: 'Français' },
    { code: 'it', prefix: 'it', name: 'Italiano' },
    { code: 'pl', prefix: 'pl', name: 'Polski' },
    { code: 'es', prefix: 'es', name: 'Español' },
    { code: 'pt-BR', prefix: 'pt-br', name: 'Português (Brasil)' },
]);
export const DEFAULT_LANG = 'en';
export const LANG_CODES = Object.freeze(LANGUAGES.map((l) => l.code));

const CONTENT_DIR = fileURLToPath(new URL('../../content/site/', import.meta.url));

let catalogs = null;
let overrides = null;

function flatten(prefix, value, out) {
    if (typeof value === 'string') {
        out.set(prefix, value);
        return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, v, out);
        return;
    }
    throw new Error(`i18n: ${prefix} must be a string or an object`);
}

/** Reads every catalog file once: Map(lang → Map(key → text)). */
export function loadCatalogs(dir = CONTENT_DIR) {
    const result = new Map();
    for (const { code } of LANGUAGES) {
        const map = new Map();
        const langDir = `${dir}${code}/`;
        if (existsSync(langDir)) {
            for (const file of readdirSync(langDir).filter((f) => f.endsWith('.json')).sort()) {
                const namespace = file.slice(0, -'.json'.length);
                flatten(namespace, JSON.parse(readFileSync(`${langDir}${file}`, 'utf8')), map);
            }
        }
        result.set(code, map);
    }
    return result;
}

function catalogsNow() {
    if (!catalogs) catalogs = loadCatalogs();
    return catalogs;
}

/** For tests: replace the catalogs (null = reload from disk next time). */
export function setCatalogsForTest(value) {
    catalogs = value;
}

/** The owner's edits: fn(lang, key) → string | null. null clears. */
export function setContentOverrides(fn) {
    overrides = typeof fn === 'function' ? fn : null;
}

export function isLanguage(code) {
    return LANG_CODES.includes(code);
}

/**
 * The raw text for a key, first found of: owner edit in this language → catalog in this language →
 * owner edit in English → English catalog. (An English edit does not replace an existing translation;
 * the editor marks that translation "needs update" instead.) Unknown key throws.
 */
export function lookup(lang, key) {
    return lookupSource(lang, key).text;
}

/** lookup() plus whether the text is an owner edit: { text, edited }. */
function lookupSource(lang, key) {
    const code = isLanguage(lang) ? lang : DEFAULT_LANG;
    const all = catalogsNow();
    const edited = (c) => {
        const value = overrides ? overrides(c, key) : null;
        return typeof value === 'string' ? value : undefined;
    };
    const candidates = [[edited(code), true], [all.get(code)?.get(key), false], [edited(DEFAULT_LANG), true], [all.get(DEFAULT_LANG)?.get(key), false]];
    const found = candidates.find(([text]) => text !== undefined);
    if (!found) throw new Error(`i18n: missing key "${key}"`);
    return { text: found[0], edited: found[1] };
}

/** The catalog text without owner edits (own language, else English). */
function catalogFallback(lang, key) {
    const code = isLanguage(lang) ? lang : DEFAULT_LANG;
    const all = catalogsNow();
    const text = all.get(code)?.get(key) ?? all.get(DEFAULT_LANG)?.get(key);
    if (text === undefined) throw new Error(`i18n: missing key "${key}"`);
    return text;
}

const brokenEdits = new Set();
/**
 * Renders a key; when an owner edit cannot be rendered with the params the page passes (e.g. an
 * edit made before a code change removed a {param}), the catalog text is used instead, so a page
 * never breaks because of an edit. Logged once per language + key.
 */
function renderSafely(lang, key, render) {
    const { text, edited } = lookupSource(lang, key);
    if (!edited) return render(text);
    try {
        return render(text);
    } catch (error) {
        const id = `${lang}|${key}`;
        if (!brokenEdits.has(id)) {
            brokenEdits.add(id);
            logger.warn(`i18n: the owner's text for ${id} cannot be shown (${error.message}); using the catalog text`);
        }
        return render(catalogFallback(lang, key));
    }
}

const TOKEN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

function paramText(params, name) {
    if (!params || !(name in params)) throw new Error(`i18n: missing param {${name}}`);
    return params[name];
}

export const PLURAL_CATEGORIES = Object.freeze(['zero', 'one', 'two', 'few', 'many', 'other']);

/** True when the key exists for this language (catalog, owner edit or English fallback). */
export function hasKey(lang, key) {
    try { lookup(lang, key); return true; } catch { return false; }
}

/**
 * The plural form of a key for a number: "x.day" → "x.day.few" in Russian for 3, "x.day.one" in English
 * for 1; falls back to "<key>.other". The count is also available as {count}.
 */
export function pluralKey(lang, key, count) {
    const code = isLanguage(lang) ? lang : DEFAULT_LANG;
    // An exact ".zero" form wins for 0 when a language has one (pt-BR says "0 dias", CLDR's "one" would give "0 dia").
    if (Number(count) === 0 && hasKey(code, `${key}.zero`)) return `${key}.zero`;
    const category = new Intl.PluralRules(code).select(Number(count));
    return hasKey(code, `${key}.${category}`) ? `${key}.${category}` : `${key}.other`;
}

/** Plain text with {params} filled in (SafeHtml params are inserted as their text). */
export function translate(lang, key, params) {
    return renderSafely(lang, key, (text) => text.replace(TOKEN, (_, name) => String(paramText(params, name))));
}

/** True for hrefs a catalog may link to. */
export function isSafeHref(href) {
    return /^\/(?!\/)/.test(href) || /^#[\w-]*$/.test(href) || /^https:\/\/[^\s"'<>]+$/.test(href) || /^mailto:[^\s"'<>]+$/.test(href);
}

const PLACEHOLDER = (i) => `\u0000${i}\u0000`;

/** Escapes, then applies inline markup and fills params. Returns an HTML string. `rewrite` (optional) maps site paths ("/features" → "/de/features"). */
function renderInline(escaped, params, key, rewrite = null) {
    const stash = [];
    const keep = (htmlText) => {
        stash.push(htmlText);
        return PLACEHOLDER(stash.length - 1);
    };
    let s = escaped;
    // Links first, so their text can still hold bold/italic/code.
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, target) => {
        let href = target.replace(TOKEN, (__, name) => {
            const value = paramText(params, name);
            if (value && typeof value === 'object') throw new Error(`i18n: {${name}} in a link target of "${key}" must be plain text`);
            return escapeHtml(value);
        });
        // escapeHtml turned & into &amp; — compare against the unescaped form for the safety check.
        const plain = href.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        if (!isSafeHref(plain)) return text;
        if (rewrite && plain.startsWith('/')) {
            const localized = rewrite(plain);
            if (localized !== plain && isSafeHref(localized)) href = escapeHtml(localized);
        }
        const external = /^https:/.test(plain) ? ' rel="noopener"' : '';
        return `${keep(`<a href="${href}"${external}>`)}${text}${keep('</a>')}`;
    });
    // escapeHtml turned ` into &#96;.
    s = s.replace(/&#96;((?:(?!&#96;)[^\n])+)&#96;/g, (_, code) => keep(`<code>${code.replace(TOKEN, (__, name) => {
        const value = paramText(params, name);
        return value && typeof value === 'object' && 'text' in value ? escapeHtml(String(value.text)) : escapeHtml(value);
    })}</code>`));
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(TOKEN, (_, name) => {
        const value = paramText(params, name);
        return value && typeof value === 'object' && 'text' in value ? String(value) : escapeHtml(value);
    });
    // eslint-disable-next-line no-control-regex
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

/** Inline markup → SafeHtml. */
export function translateInline(lang, key, params, { rewrite = null } = {}) {
    return raw(renderSafely(lang, key, (text) => renderInline(escapeHtml(text), params, key, rewrite)));
}

function renderBlock(text, params, key, rewrite) {
    const blocks = escapeHtml(text).replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    const out = blocks.map((block) => {
        const lines = block.split('\n');
        if (lines.every((line) => /^- /.test(line))) {
            return `<ul>${lines.map((line) => `<li>${renderInline(line.slice(2), params, key, rewrite)}</li>`).join('')}</ul>`;
        }
        return `<p>${lines.map((line) => renderInline(line, params, key, rewrite)).join('<br>')}</p>`;
    });
    return out.join('\n');
}

/** Block markup (paragraphs, "- " lists, <br>) → SafeHtml. */
export function translateBlock(lang, key, params, { rewrite = null } = {}) {
    return raw(renderSafely(lang, key, (text) => renderBlock(text, params, key, rewrite)));
}

/**
 * The Website editor's preview: a text that is not saved yet, rendered with the block markup
 * (the widest of the three; inline-only keys look the same apart from paragraphs). Every
 * {param} shows as its own name. Same escaping as the live site. Throws like a page would
 * (e.g. a broken param).
 */
export function previewMarkup(text, key = 'preview') {
    const params = Object.fromEntries(placeholdersOf(text).map((name) => [name, `{${name}}`]));
    return raw(renderBlock(String(text), params, key, null));
}

/** The catalog file text of a key in one language (no owner edits), or undefined. */
export function catalogText(lang, key) {
    return catalogsNow().get(lang)?.get(key);
}

/** Every key of a language's catalog files (no owner edits), in file order. */
export function catalogKeys(lang) {
    return [...(catalogsNow().get(lang)?.keys() || [])];
}

// ── Language URLs ───────────────────────────────────────────────────────────
// Every public page also answers under /<prefix>/… (site.js strips the prefix). Only these paths
// get a prefix; /dashboard, /me, /oauth, /img, the stylesheet and external links never do.

/** The translatable public pages (plus /docs/<slug>). */
export const PAGE_PATHS = Object.freeze([
    '/', '/features', '/pricing', '/faq', '/docs', '/commands', '/about', '/changelog', '/leaderboard', '/rules', '/status',
    '/transparency', '/trust', '/privacy', '/terms', '/legal', '/contact', '/withdrawal',
]);
/** Pages that exist in English only (owner decision): /de/privacy shows the English page with a note. */
export const ENGLISH_ONLY_PATHS = Object.freeze(['/privacy', '/terms', '/legal', '/contact', '/withdrawal']);
const PAGE_SET = new Set(PAGE_PATHS);
const ENGLISH_ONLY_SET = new Set(ENGLISH_ONLY_PATHS);

/** "/features/" → "/features"; "/" stays "/". */
export function normalizePagePath(pathname) {
    const text = String(pathname || '');
    return text.length > 1 && text.endsWith('/') ? text.slice(0, -1) : text;
}

/** True for a public page path (no query): "/features", "/docs/appeals", "/" (a trailing slash is allowed). */
export function isPagePath(pathname) {
    const path = normalizePagePath(pathname);
    return PAGE_SET.has(path) || /^\/docs\/[a-z0-9-]{1,64}$/.test(path);
}

export function isEnglishOnlyPath(pathname) {
    return ENGLISH_ONLY_SET.has(normalizePagePath(pathname));
}

/** The language for a URL prefix ("pt-br" → the pt-BR entry), or null. English has no prefix. */
export function languageByPrefix(prefix) {
    return LANGUAGES.find((l) => l.prefix && l.prefix === prefix) || null;
}

export function prefixOf(lang) {
    return LANGUAGES.find((l) => l.code === lang)?.prefix || '';
}

/**
 * A site link in a language: "/features" → "/de/features", "/" → "/de/", "/leaderboard?page=2" →
 * "/de/leaderboard?page=2". English, non-page paths ("/dashboard", "/me", "/img/…"), "#…",
 * external and protocol-relative links come back unchanged.
 */
export function localizePath(lang, href) {
    if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return href;
    const prefix = prefixOf(lang);
    if (!prefix) return href;
    const cut = href.search(/[?#]/);
    const pathname = cut === -1 ? href : href.slice(0, cut);
    const rest = cut === -1 ? '' : href.slice(cut);
    if (!isPagePath(pathname)) return href;
    return pathname === '/' ? `/${prefix}/${rest}` : `/${prefix}${pathname}${rest}`;
}

// ── Dates and numbers ─────────────────────────────────────────────────────
// English keeps the formats the pages always had: en-GB dates ("1 November 2026"), en-US numbers ("12,345").
const FORMATS = new Map();
const DEFAULT_DATE = Object.freeze({ day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
function cachedFormat(kind, locale, opts) {
    const id = `${kind}|${locale}|${JSON.stringify(opts)}`;
    if (!FORMATS.has(id)) FORMATS.set(id, kind === 'date' ? new Intl.DateTimeFormat(locale, opts) : new Intl.NumberFormat(locale, opts));
    return FORMATS.get(id);
}

/** A date in the language ("1 November 2026" / "1. November 2026"); '' for a missing or invalid date. */
export function formatDateIn(lang, value, opts = DEFAULT_DATE) {
    const date = value instanceof Date ? value : new Date(value);
    if (value == null || Number.isNaN(date.getTime())) return '';
    return cachedFormat('date', isLanguage(lang) && lang !== DEFAULT_LANG ? lang : 'en-GB', opts).format(date);
}

/** A number with the language's grouping ("12,345" / "12.345"); not a number → 0. */
export function formatNumberIn(lang, n, opts = {}) {
    return cachedFormat('number', isLanguage(lang) && lang !== DEFAULT_LANG ? lang : 'en-US', opts).format(Number(n) || 0);
}

/**
 * The functions a page context carries for one language. `href` maps site paths for links
 * (default: the same language's prefix); catalog links ([text](/path)) go through it too, so a
 * translation never needs to write a prefix.
 */
export function translator(lang = DEFAULT_LANG, { href = null } = {}) {
    const code = isLanguage(lang) ? lang : DEFAULT_LANG;
    const link = typeof href === 'function' ? href : (path) => localizePath(code, path);
    const options = { rewrite: link };
    return {
        lang: code,
        t: (key, params) => translate(code, key, params),
        ti: (key, params) => translateInline(code, key, params, options),
        tb: (key, params) => translateBlock(code, key, params, options),
        /** Plural plain text: tp('billing.common.day', 3) → "3 days" ({count} is filled in). */
        // {count} is written the language's way ("1,5" in German); English keeps the plain number, as before.
        tp: (key, count, params = {}) => translate(code, pluralKey(code, key, count), {
            count: code === DEFAULT_LANG ? count : formatNumberIn(code, count, { maximumFractionDigits: 1 }), ...params,
        }),
        /** A site link that keeps the page's language: href('/features') → '/de/features'. */
        href: link,
        fmtDate: (value, opts) => formatDateIn(code, value, opts),
        fmtNumber: (n, opts) => formatNumberIn(code, n, opts),
    };
}

/** True when this language itself has the key (its catalog or an owner edit), not only the English fallback. */
export function translatedIn(lang, key) {
    if (!isLanguage(lang)) return false;
    const edited = overrides ? overrides(lang, key) : null;
    return typeof edited === 'string' || catalogsNow().get(lang)?.has(key) === true;
}

/** Every key in a catalog map, for tests (placeholders per key). */
export function placeholdersOf(text) {
    return [...String(text).matchAll(TOKEN)].map((m) => m[1]).sort();
}

/**
 * The translator for a page context: its own t/ti/tb/tp (+ href, fmtDate, fmtNumber), else one for
 * ctx.lang (tests pass bare contexts). A context with its own text functions but without the link
 * and format helpers gets those of ctx.lang added.
 */
export function textOf(ctx) {
    const own = ctx && typeof ctx.t === 'function' && typeof ctx.ti === 'function' && typeof ctx.tb === 'function' && typeof ctx.tp === 'function';
    if (own && typeof ctx.href === 'function' && typeof ctx.fmtDate === 'function' && typeof ctx.fmtNumber === 'function') return ctx;
    const base = translator(ctx?.lang);
    return own ? { ...base, ...ctx, href: ctx.href || base.href, fmtDate: ctx.fmtDate || base.fmtDate, fmtNumber: ctx.fmtNumber || base.fmtNumber } : base;
}
