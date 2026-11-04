// siteContent.js — the owner's website text (dashboard Owner → Website): the store (tables
// site_content + site_content_history, schema v10), the in-memory copy the site reads through
// i18n.setContentOverrides, and the editor's rules (which keys exist, validation, status).
//
// Owner text uses the same safe markup as the catalog files (i18n.js escapes everything), so an
// override can never inject HTML. Keys must exist in the English catalog; other languages may
// also have the plural forms their language needs ("x.day.few" in Russian when English has
// "x.day.other"). Status of a translation:
//   translated    its own text, made for the current English text
//   needs update  an override saved for an older English text (source_hash differs), or a
//                 catalog-file translation while the English text is an owner edit
//   missing       no text in this language: the site shows English
// Data layer (CLAUDE.md): reads throw on a DB error; a save or reset writes the row and its history
// row in one transaction, or throws and nothing changes (the in-memory copy is updated only after).

import { createHash } from 'node:crypto';
import { query as dbQuery, withTransaction as dbTransaction } from '../enforcement/db.js';
import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';
import { InputError } from '../dashboard/forms.js';
import {
    DEFAULT_LANG, LANG_CODES, PLURAL_CATEGORIES, catalogKeys, catalogText, isLanguage, placeholdersOf, previewMarkup, setContentOverrides,
} from './i18n.js';

export const TEXT_MAX = 5000;
export const HISTORY_LIMIT = 30;
export const STATES = Object.freeze({
    translated: 'Translated', 'needs-update': 'Needs update', missing: 'Missing (English shown)', edited: 'Edited', default: 'Default',
});

export const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

// ── Keys ────────────────────────────────────────────────────────────────

const PLURAL_SET = new Set(PLURAL_CATEGORIES);

/** { base, category } when the key is a plural form of an English plural key (base.other exists), else null. */
export function pluralParts(key) {
    const cut = String(key).lastIndexOf('.');
    if (cut <= 0) return null;
    const base = key.slice(0, cut);
    const category = key.slice(cut + 1);
    if (!PLURAL_SET.has(category) || catalogText(DEFAULT_LANG, `${base}.other`) === undefined) return null;
    return { base, category };
}

function pluralCategoriesOf(lang) {
    try {
        return new Set(new Intl.PluralRules(lang).resolvedOptions().pluralCategories);
    } catch {
        return new Set(['one', 'other']);
    }
}

/**
 * Every key the editor offers in a language, in catalog order: the English keys, and for a plural
 * key every form the language uses (plus an exact ".zero" form when English or that language has one).
 */
export function editorKeys(lang) {
    const english = catalogKeys(DEFAULT_LANG);
    if (lang === DEFAULT_LANG) return english;
    const categories = pluralCategoriesOf(lang);
    const out = [];
    const doneBases = new Set();
    for (const key of english) {
        const plural = pluralParts(key);
        if (!plural) {
            out.push(key);
            continue;
        }
        if (doneBases.has(plural.base)) continue;
        doneBases.add(plural.base);
        for (const category of PLURAL_CATEGORIES) {
            const formKey = `${plural.base}.${category}`;
            const exists = catalogText(DEFAULT_LANG, formKey) !== undefined || catalogText(lang, formKey) !== undefined;
            if (categories.has(category) || exists) out.push(formKey);
        }
    }
    return out;
}

export function isEditableKey(lang, key) {
    if (!isLanguage(lang) || typeof key !== 'string' || !key) return false;
    if (catalogText(DEFAULT_LANG, key) !== undefined) return true;
    return lang !== DEFAULT_LANG && editorKeys(lang).includes(key);
}

/** The English key a text is checked against: the key itself, or "<base>.other" for a form English lacks. */
export function englishSourceKey(key) {
    if (catalogText(DEFAULT_LANG, key) !== undefined) return key;
    const plural = pluralParts(key);
    return plural ? `${plural.base}.other` : null;
}

/** The namespace (catalog file) of a key: "home.hero.title" → "home". */
export const namespaceOf = (key) => String(key).split('.')[0];

/** The namespaces in catalog order. */
export function namespaces() {
    return [...new Set(catalogKeys(DEFAULT_LANG).map(namespaceOf))];
}

// ── The in-memory copy (what the site shows) ─────────────────────────────

let cache = new Map();
let loaded = false;
const cacheId = (lang, key) => `${lang}\n${key}`;

/** The override row of a language + key ({ lang, key, text, source_hash, updated_by, updated_at }) or null. */
export function overrideOf(lang, key) {
    return cache.get(cacheId(lang, key)) || null;
}

/** Replaces the copy with these rows (unknown languages or keys are skipped). Returns how many were kept. */
export function setOverrideRows(rows = []) {
    const next = new Map();
    for (const row of rows) {
        if (!isEditableKey(row?.lang, row?.key) || typeof row.text !== 'string') continue;
        // A text saved before a code change may no longer fit its key ({params} changed): not shown.
        try {
            validateSiteText(row.lang, row.key, row.text);
        } catch (error) {
            logger.warn(`Website text ${row.lang}.${row.key} not used (no longer fits the key): ${error.userMessage || error.message}`);
            continue;
        }
        next.set(cacheId(row.lang, row.key), { ...row });
    }
    cache = next;
    loaded = true;
    return next.size;
}

/** False after a failed load at startup: the editor then retries before showing anything. */
export const isSiteContentLoaded = () => loaded;

export function putOverride(row) {
    cache.set(cacheId(row.lang, row.key), { ...row });
}

export function dropOverride(lang, key) {
    cache.delete(cacheId(lang, key));
}

/** Points i18n at the copy (once at startup; tests call it too). */
export function installOverrides() {
    setContentOverrides((lang, key) => cache.get(cacheId(lang, key))?.text ?? null);
}

/**
 * Startup: every site_content row into memory, then wired into i18n. A database error is logged
 * and the site runs on the catalog files (it must keep working). Returns the count or null.
 */
export async function loadSiteContent(store = siteContentStore) {
    installOverrides();
    try {
        const rows = await store.listAll();
        const kept = setOverrideRows(rows);
        if (kept !== rows.length) logger.warn(`Website text: ${rows.length - kept} saved text(s) skipped (unknown language or key, or no longer fits)`);
        logger.info(`Website text: ${kept} owner edit(s) loaded`);
        return kept;
    } catch (error) {
        loaded = false;
        logger.error(`Website text not loaded (site uses the catalog files): ${error.message}`);
        return null;
    }
}

// ── Status ───────────────────────────────────────────────────────────────

/** The English text the site shows now for a key's English source (owner edit or catalog). */
export function currentEnglish(key, lookupOverride = overrideOf) {
    const source = englishSourceKey(key);
    if (!source) return undefined;
    return lookupOverride(DEFAULT_LANG, source)?.text ?? catalogText(DEFAULT_LANG, source);
}

/**
 * { state, edited } for one language + key. English: 'edited' | 'default'. Other languages:
 * 'translated' | 'needs-update' | 'missing' (see the header).
 */
export function keyStatus(lang, key, lookupOverride = overrideOf) {
    const row = lookupOverride(lang, key);
    const edited = Boolean(row);
    if (lang === DEFAULT_LANG) return { state: edited ? 'edited' : 'default', edited };
    const source = englishSourceKey(key);
    const englishEdit = source ? lookupOverride(DEFAULT_LANG, source) : null;
    if (row) return { state: row.source_hash === sha256(currentEnglish(key, lookupOverride) ?? '') ? 'translated' : 'needs-update', edited };
    if (catalogText(lang, key) !== undefined) return { state: englishEdit ? 'needs-update' : 'translated', edited };
    return { state: 'missing', edited };
}

/** Counts per state for a list of keys in a language: { total, translated, needsUpdate, missing, edited }. */
export function statusCounts(lang, keys, lookupOverride = overrideOf) {
    const counts = { total: keys.length, translated: 0, needsUpdate: 0, missing: 0, edited: 0 };
    for (const key of keys) {
        const { state, edited } = keyStatus(lang, key, lookupOverride);
        if (edited) counts.edited += 1;
        if (state === 'translated') counts.translated += 1;
        else if (state === 'needs-update') counts.needsUpdate += 1;
        else if (state === 'missing') counts.missing += 1;
    }
    return counts;
}

/** The text the site shows in this language now ({ text, from: 'edit' | 'catalog' | 'english' }). */
export function shownText(lang, key, lookupOverride = overrideOf) {
    const row = lookupOverride(lang, key);
    if (row) return { text: row.text, from: 'edit' };
    const own = catalogText(lang, key);
    if (own !== undefined) return { text: own, from: 'catalog' };
    return { text: currentEnglish(key, lookupOverride) ?? '', from: 'english' };
}

// ── Validation ───────────────────────────────────────────────────────────

const braces = (names) => names.map((n) => `{${n}}`).join(', ');

/**
 * Checks a text before it is saved: known language + key, not empty, at most 5,000 characters,
 * the same {placeholders} as the English text ({count} is free in plural forms), and it renders.
 * Returns { text (trimmed, \n line ends), warnings }. Throws InputError.
 */
export function validateSiteText(lang, key, input) {
    if (!isLanguage(lang)) throw new InputError('Unknown language.');
    if (!isEditableKey(lang, key)) throw new InputError('That text does not exist on the website (unknown key). New keys are added in code.');
    const text = String(input ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new InputError('The text is empty. Use "Reset to default" to go back to the original text.', 400, 'text');
    if (text.length > TEXT_MAX) throw new InputError(`Too long: at most ${TEXT_MAX} characters (${text.length} entered).`, 400, 'text');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) throw new InputError('The text contains invisible control characters. Retype it or paste it as plain text.', 400, 'text');
    const english = catalogText(DEFAULT_LANG, englishSourceKey(key)) ?? '';
    const want = new Set(placeholdersOf(english));
    const got = new Set(placeholdersOf(text));
    if (pluralParts(key)) {
        want.delete('count');
        got.delete('count');
    }
    const missing = [...want].filter((n) => !got.has(n));
    const extra = [...got].filter((n) => !want.has(n));
    if (missing.length || extra.length) {
        const parts = [missing.length ? `missing ${braces(missing)}` : '', extra.length ? `not allowed ${braces(extra)}` : ''].filter(Boolean).join('; ');
        throw new InputError(`Use the same {placeholders} as the English text (${parts}). They are filled in by the website.`, 400, 'text');
    }
    // A {param} inside a link target must be one English uses there too: pages may pass a
    // formatted value (e.g. a code tag) for other params, which a link target cannot take.
    const linkParams = (value) => new Set([...String(value).matchAll(/\]\(([^)\s]+)\)/g)].flatMap((m) => placeholdersOf(m[1])));
    const englishLinks = linkParams(english);
    const badLinks = [...linkParams(text)].filter((n) => !englishLinks.has(n));
    if (badLinks.length) throw new InputError(`${braces(badLinks)} cannot be used inside a link address here (the English text does not). Put it in the link text instead.`, 400, 'text');
    try {
        previewMarkup(text, key);
    } catch (error) {
        throw new InputError(`The text could not be shown: ${error.message}`, 400, 'text');
    }
    const warnings = [];
    if (/<\/?[a-z!][^>]*>/i.test(text)) warnings.push('HTML is not supported: tags show as typed text. Use **bold**, *italic*, `code`, [text](/path) and "- " lists.');
    return { text, warnings };
}

// ── Store ────────────────────────────────────────────────────────────────

const ROW = 'lang, key, text, source_hash, updated_by, updated_at';

/** query / withTransaction / tables injectable for tests. Every read throws on a DB error. */
export function createSiteContentStore({
    query = dbQuery, withTransaction = dbTransaction,
    table = pgConfig.tables.site_content, historyTable = pgConfig.tables.site_content_history,
} = {}) {
    async function listAll() {
        const { rows } = await query(`SELECT ${ROW} FROM ${table}`);
        return rows;
    }

    /** Saves a text and its history row in one transaction: { row, oldText } (oldText null = it was the catalog text). */
    async function save({ lang, key, text, sourceHash = null, userId }) {
        return withTransaction(async (client) => {
            const before = await client.query(`SELECT text FROM ${table} WHERE lang = $1 AND key = $2 FOR UPDATE`, [lang, key]);
            const { rows: [row] } = await client.query(
                `INSERT INTO ${table} (lang, key, text, source_hash, updated_by) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (lang, key) DO UPDATE SET text = EXCLUDED.text, source_hash = EXCLUDED.source_hash,
                     updated_by = EXCLUDED.updated_by, updated_at = NOW()
                 RETURNING ${ROW}`, [lang, key, text, sourceHash, String(userId)]);
            if (!row) throw new Error('site_content save returned no row');
            const oldText = before.rows[0]?.text ?? null;
            await client.query(`INSERT INTO ${historyTable} (lang, key, old_text, new_text, changed_by) VALUES ($1, $2, $3, $4, $5)`,
                [lang, key, oldText, text, String(userId)]);
            return { row, oldText };
        });
    }

    /** Deletes the override (back to the catalog text) and writes a history row: { removed, oldText }. */
    async function reset({ lang, key, userId }) {
        return withTransaction(async (client) => {
            const { rows } = await client.query(`DELETE FROM ${table} WHERE lang = $1 AND key = $2 RETURNING text`, [lang, key]);
            if (!rows.length) return { removed: false, oldText: null };
            await client.query(`INSERT INTO ${historyTable} (lang, key, old_text, new_text, changed_by) VALUES ($1, $2, $3, NULL, $4)`,
                [lang, key, rows[0].text, String(userId)]);
            return { removed: true, oldText: rows[0].text };
        });
    }

    async function history(lang, key, limit = HISTORY_LIMIT) {
        const { rows } = await query(
            `SELECT id, lang, key, old_text, new_text, changed_by, changed_at FROM ${historyTable}
             WHERE lang = $1 AND key = $2 ORDER BY changed_at DESC, id DESC LIMIT $3`, [lang, key, limit]);
        return rows;
    }

    async function historyEntry(id) {
        const { rows } = await query(`SELECT id, lang, key, old_text, new_text, changed_by, changed_at FROM ${historyTable} WHERE id = $1`, [id]);
        return rows[0] || null;
    }

    return { listAll, save, reset, history, historyEntry };
}

export const siteContentStore = createSiteContentStore();

/** For tests: languages in the picker order without English. */
export const TRANSLATION_LANGS = Object.freeze(LANG_CODES.filter((c) => c !== DEFAULT_LANG));
