// i18n.js — website text catalog, languages and a small safe markup.
//
// Text lives in src/content/site/<lang>/<namespace>.json (nested objects; key "home.hero.title" is
// home.json → { "hero": { "title": "…" } }). English is complete; other languages fall back to
// English key by key. The owner's Website editor (later) can override any key per language through
// setContentOverrides(); overrides use the same markup, so they are just as safe.
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
    const code = isLanguage(lang) ? lang : DEFAULT_LANG;
    const all = catalogsNow();
    const edited = (c) => {
        const value = overrides ? overrides(c, key) : null;
        return typeof value === 'string' ? value : undefined;
    };
    const text = edited(code) ?? all.get(code)?.get(key) ?? edited(DEFAULT_LANG) ?? all.get(DEFAULT_LANG)?.get(key);
    if (text === undefined) throw new Error(`i18n: missing key "${key}"`);
    return text;
}

const TOKEN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

function paramText(params, name) {
    if (!params || !(name in params)) throw new Error(`i18n: missing param {${name}}`);
    return params[name];
}

/** Plain text with {params} filled in (SafeHtml params are inserted as their text). */
export function translate(lang, key, params) {
    return lookup(lang, key).replace(TOKEN, (_, name) => String(paramText(params, name)));
}

/** True for hrefs a catalog may link to. */
export function isSafeHref(href) {
    return /^\/(?!\/)/.test(href) || /^#[\w-]*$/.test(href) || /^https:\/\/[^\s"'<>]+$/.test(href) || /^mailto:[^\s"'<>]+$/.test(href);
}

const PLACEHOLDER = (i) => `\u0000${i}\u0000`;

/** Escapes, then applies inline markup and fills params. Returns an HTML string. */
function renderInline(escaped, params, key) {
    const stash = [];
    const keep = (htmlText) => {
        stash.push(htmlText);
        return PLACEHOLDER(stash.length - 1);
    };
    let s = escaped;
    // Links first, so their text can still hold bold/italic/code.
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, target) => {
        const href = target.replace(TOKEN, (__, name) => {
            const value = paramText(params, name);
            if (value && typeof value === 'object') throw new Error(`i18n: {${name}} in a link target of "${key}" must be plain text`);
            return escapeHtml(value);
        });
        // escapeHtml turned & into &amp; — compare against the unescaped form for the safety check.
        const plain = href.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        if (!isSafeHref(plain)) return text;
        const external = /^https:/.test(plain) ? ' rel="noopener"' : '';
        return `${keep(`<a href="${href}"${external}>`)}${text}${keep('</a>')}`;
    });
    // escapeHtml turned ` into &#96;.
    s = s.replace(/&#96;((?:(?!&#96;)[^\n])+)&#96;/g, (_, code) => keep(`<code>${code}</code>`));
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
export function translateInline(lang, key, params) {
    return raw(renderInline(escapeHtml(lookup(lang, key)), params, key));
}

/** Block markup (paragraphs, "- " lists, <br>) → SafeHtml. */
export function translateBlock(lang, key, params) {
    const blocks = escapeHtml(lookup(lang, key)).replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    const out = blocks.map((block) => {
        const lines = block.split('\n');
        if (lines.every((line) => /^- /.test(line))) {
            return `<ul>${lines.map((line) => `<li>${renderInline(line.slice(2), params, key)}</li>`).join('')}</ul>`;
        }
        return `<p>${lines.map((line) => renderInline(line, params, key)).join('<br>')}</p>`;
    });
    return raw(out.join('\n'));
}

/** The functions a page context carries for one language. */
export function translator(lang = DEFAULT_LANG) {
    const code = isLanguage(lang) ? lang : DEFAULT_LANG;
    return {
        lang: code,
        t: (key, params) => translate(code, key, params),
        ti: (key, params) => translateInline(code, key, params),
        tb: (key, params) => translateBlock(code, key, params),
    };
}

/** Every key in a catalog map, for tests (placeholders per key). */
export function placeholdersOf(text) {
    return [...String(text).matchAll(TOKEN)].map((m) => m[1]).sort();
}

/** The translator for a page context: its own t/ti/tb, else one for ctx.lang (tests pass bare contexts). */
export function textOf(ctx) {
    return ctx && typeof ctx.t === 'function' && typeof ctx.ti === 'function' && typeof ctx.tb === 'function'
        ? ctx
        : translator(ctx?.lang);
}
