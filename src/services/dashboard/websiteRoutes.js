// websiteRoutes.js — Owner area → Website: the owner edits the website's text per language and
// replaces its images, without code.
//
//   GET  /dashboard/owner/website                      overview: namespaces × languages (translated / needs
//                                                      update / missing), legal pages note
//   GET  /dashboard/owner/website/ns/:ns[?lang=&filter=&q=]   every key of one catalog file
//   GET  /dashboard/owner/website/key?k=<key>          one key: English, every language, edit forms, history
//   POST /dashboard/owner/website/text/save            save (do=save) or preview (do=preview) one language's text
//   POST /dashboard/owner/website/text/reset           delete the owner's text → catalog text again
//   POST /dashboard/owner/website/text/restore         a history entry's text back (or the default)
//   GET  /dashboard/owner/website/images               the replaceable images
//   POST /dashboard/owner/website/images/:slot/upload  multipart, 2 MB, re-encoded (siteImages.js)
//   POST /dashboard/owner/website/images/:slot/reset   back to the default file
//
// Access: the Owner area's checks (ownerRoutes.js ownerPost): live OWNER_IDS check (404 otherwise),
// 30 POSTs/min, same origin + CSRF, DASHBOARD_EDIT_ENABLED, a login from the last 12 hours.
// Every save / reset / restore / upload writes a dashboard_audit row (module 'website', key
// '<lang>.<key>' or 'image.<slot>', values cut to 500 characters). Changes go live at once: the
// in-memory copies the site reads are updated after the database write succeeded.

import { statSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import { InputError, queryText, text } from './forms.js';
import { path } from './html.js';
import { DEFAULT_LANG, LANG_CODES, catalogText, isLanguage, previewMarkup } from '../site/i18n.js';
import {
    TEXT_MAX, currentEnglish, dropOverride, editorKeys, englishSourceKey, isEditableKey, keyStatus, namespaceOf, namespaces,
    isSiteContentLoaded, loadSiteContent, overrideOf, putOverride, sha256, shownText, siteContentStore, statusCounts, validateSiteText,
} from '../site/siteContent.js';
import {
    IMAGE_MAX_BYTES, SITE_IMAGE_SLOTS, clearUploadedImage, isSiteImagesLoaded, loadSiteImages, prepareSiteImage, setUploadedImage, siteImageStore, slotDef, uploadedImage,
} from '../site/siteImages.js';
import { imagesPage, keyPage, namespacePage, websiteHomePage, NS_FILTERS } from './websitePages.js';

export const AUDIT_MODULE = 'website';
const AUDIT_VALUE_MAX = 500;
const UNAVAILABLE = 'The database is not responding. Nothing was changed; try again in a few minutes.';
const cut = (value) => (typeof value === 'string' && value.length > AUDIT_VALUE_MAX ? `${value.slice(0, AUDIT_VALUE_MAX - 1)}…` : value ?? null);

export const defaultWebsiteDeps = { content: siteContentStore, images: siteImageStore, prepareImage: prepareSiteImage };

/** The keys of a namespace page for a language, filtered (all / needs-update / missing / edited) and searched. */
export function namespaceRows(ns, lang, { filter = 'all', q = '' } = {}) {
    const needle = String(q || '').toLowerCase();
    return editorKeys(lang).filter((key) => namespaceOf(key) === ns).map((key) => {
        const status = keyStatus(lang, key);
        const english = currentEnglish(key) ?? '';
        const shown = shownText(lang, key);
        return { key, english, text: shown.text, from: shown.from, ...status };
    }).filter((row) => {
        if (filter === 'needs-update' && row.state !== 'needs-update') return false;
        if (filter === 'missing' && row.state !== 'missing') return false;
        if (filter === 'edited' && !row.edited) return false;
        if (!needle) return true;
        return row.key.toLowerCase().includes(needle) || row.english.toLowerCase().includes(needle) || row.text.toLowerCase().includes(needle);
    });
}

/** The overview table: [{ ns, keys, langs: { [lang]: counts } }]. */
export function overviewRows() {
    const perLang = new Map(LANG_CODES.map((lang) => [lang, editorKeys(lang)]));
    return namespaces().map((ns) => ({
        ns,
        keys: perLang.get(DEFAULT_LANG).filter((k) => namespaceOf(k) === ns).length,
        langs: Object.fromEntries(LANG_CODES.map((lang) => [lang, statusCounts(lang, perLang.get(lang).filter((k) => namespaceOf(k) === ns))])),
    }));
}

/** Every language of a key on its page: [{ lang, text, from, state, edited, row }]. */
export function keyLanguages(key) {
    return LANG_CODES.filter((lang) => isEditableKey(lang, key)).map((lang) => ({
        lang, ...shownText(lang, key), ...keyStatus(lang, key), row: overrideOf(lang, key),
    }));
}

export function createWebsiteHandlers(core) {
    const { sendHtml, fail, helpers } = core;
    const w = { ...defaultWebsiteDeps, ...(core.website || {}) };
    const { ownerPost, audit, flash, takeFlash, page, actorOf } = helpers;

    const keyHref = (key, lang = null) => path(`/owner/website/key?k=${encodeURIComponent(key)}${lang ? `#lang-${lang}` : ''}`);

    // ── Text ─────────────────────────────────────────────────────────────

    const home = (req, res) => sendHtml(res, 200, websiteHomePage({ ...page(req), flash: takeFlash(req), rows: overviewRows() }));

    function namespace(req, res) {
        const ns = String(req.params?.ns || '');
        if (!namespaces().includes(ns)) return fail(res, 404, 'Not found', 'There is no such text group.', req);
        const langRaw = queryText(req.query, 'lang', 10);
        const lang = isLanguage(langRaw) ? langRaw : LANG_CODES.find((c) => c !== DEFAULT_LANG);
        const filterRaw = queryText(req.query, 'filter', 20);
        const filter = Object.hasOwn(NS_FILTERS, filterRaw) ? filterRaw : 'all';
        const q = queryText(req.query, 'q', 100);
        return sendHtml(res, 200, namespacePage({ ...page(req), flash: takeFlash(req), ns, lang, filter, q, rows: namespaceRows(ns, lang, { filter, q }) }));
    }

    async function renderKey(req, res, status = 200, { key = null, error = null, errorLang = null, drafts = {}, preview = null, warnings = [] } = {}) {
        const k = key ?? queryText(req.query, 'k', 200);
        if (!k || !LANG_CODES.some((lang) => isEditableKey(lang, k))) return fail(res, 404, 'Not found', 'There is no such text on the website.', req);
        // History per language; a read error is shown on the page (never as "no history").
        const history = {};
        for (const { lang } of keyLanguages(k)) {
            try {
                history[lang] = await w.content.history(lang, k);
            } catch (err) {
                logger.warn(`Website editor: history of ${lang}.${k} not readable: ${err.message}`);
                history[lang] = null;
            }
        }
        return sendHtml(res, status, keyPage({
            ...page(req), flash: takeFlash(req), key: k, english: catalogText(DEFAULT_LANG, englishSourceKey(k)) ?? '',
            languages: keyLanguages(k), history, error, errorLang, drafts, preview, warnings,
        }));
    }

    const key = (req, res) => renderKey(req, res);

    /** The key + language of a text form (both must exist). */
    function target(req) {
        const k = text(req.body, 'key', 200);
        const lang = text(req.body, 'lang', 10);
        if (!isLanguage(lang)) throw new InputError('Unknown language.');
        if (!isEditableKey(lang, k)) throw new InputError('That text does not exist on the website (unknown key).');
        return { k, lang };
    }

    const rawText = (req) => (typeof req.body?.text === 'string' ? req.body.text : '');

    const rerenderKey = (req, res, status, message) => {
        let k = null;
        let lang = null;
        try { k = text(req.body, 'key', 200); lang = text(req.body, 'lang', 10); } catch { /* shown as not found */ }
        const draft = rawText(req).slice(0, TEXT_MAX * 2);
        return renderKey(req, res, status, { key: k, error: message, errorLang: lang, drafts: lang ? { [lang]: draft } : {} });
    };

    /** Saves a checked text: DB first (one transaction with history), then the live copy, audit, flash. */
    async function store(req, res, { k, lang, value, warnings = [], verb = 'Saved' }) {
        const sourceHash = lang === DEFAULT_LANG ? null : sha256(currentEnglish(k) ?? '');
        const existing = overrideOf(lang, k);
        if (existing && existing.text === value && (existing.source_hash ?? null) === sourceHash) throw new InputError('Nothing changed: this text is already saved.');
        if (!existing && value === catalogText(lang, k) && keyStatus(lang, k).state !== 'needs-update') throw new InputError('Nothing changed: this is the default text.');
        let saved;
        try {
            saved = await w.content.save({ lang, key: k, text: value, sourceHash, userId: actorOf(req).userId });
        } catch (error) {
            logger.error(`Website text save ${lang}.${k} failed: ${error.message}`);
            return fail(res, 503, 'Database unavailable', UNAVAILABLE, req);
        }
        putOverride(saved.row);
        await audit(req, [{ key: `${lang}.${k}`, old: cut(saved.oldText), new: cut(value) }], AUDIT_MODULE);
        await flash(req, [`${verb}: ${k} (${lang}). It is live on the website now.`, ...warnings].join(' '));
        return res.redirect(303, keyHref(k, lang));
    }

    const save = ownerPost(async (req, res) => {
        const { k, lang } = target(req);
        const input = rawText(req);
        if (text(req.body, 'do', 10) === 'preview') {
            // Not saved: the page again with the draft kept and the preview (or the reason it cannot be shown).
            try {
                const checked = validateSiteText(lang, k, input);
                return renderKey(req, res, 200, { key: k, drafts: { [lang]: input }, preview: { lang, html: previewMarkup(checked.text, k) }, warnings: checked.warnings });
            } catch (error) {
                if (!(error instanceof InputError)) throw error;
                return renderKey(req, res, 400, { key: k, error: error.userMessage, errorLang: lang, drafts: { [lang]: input } });
            }
        }
        const checked = validateSiteText(lang, k, input);
        return store(req, res, { k, lang, value: checked.text, warnings: checked.warnings });
    }, { rerender: rerenderKey });

    async function resetTo(req, res, { k, lang, verb = 'Reset to default' }) {
        if (!overrideOf(lang, k)) throw new InputError('This is already the default text.');
        let result;
        try {
            result = await w.content.reset({ lang, key: k, userId: actorOf(req).userId });
        } catch (error) {
            logger.error(`Website text reset ${lang}.${k} failed: ${error.message}`);
            return fail(res, 503, 'Database unavailable', UNAVAILABLE, req);
        }
        dropOverride(lang, k);
        if (result.removed) await audit(req, [{ key: `${lang}.${k}`, old: cut(result.oldText), new: null }], AUDIT_MODULE);
        await flash(req, `${verb}: ${k} (${lang}). The website shows the original text again.`);
        return res.redirect(303, keyHref(k, lang));
    }

    const reset = ownerPost(async (req, res) => resetTo(req, res, target(req)), { rerender: rerenderKey });

    const restore = ownerPost(async (req, res) => {
        const { k, lang } = target(req);
        const id = Number.parseInt(text(req.body, 'id', 20), 10);
        if (!Number.isSafeInteger(id) || id <= 0) throw new InputError('Unknown version.');
        let entry;
        try {
            entry = await w.content.historyEntry(id);
        } catch (error) {
            logger.error(`Website text history ${id} not readable: ${error.message}`);
            return fail(res, 503, 'Database unavailable', UNAVAILABLE, req);
        }
        if (!entry || entry.lang !== lang || entry.key !== k) throw new InputError('That version does not belong to this text.');
        if (entry.new_text === null) return resetTo(req, res, { k, lang, verb: 'Restored the default' });
        const checked = validateSiteText(lang, k, entry.new_text);
        return store(req, res, { k, lang, value: checked.text, warnings: checked.warnings, verb: 'Restored' });
    }, { rerender: rerenderKey });

    // ── Images ───────────────────────────────────────────────────────────

    const defaultBytes = (def) => {
        try { return statSync(def.filePath).size; } catch { return null; }
    };
    const slotRows = () => SITE_IMAGE_SLOTS.map((def) => ({ def, image: uploadedImage(def.slot), defaultBytes: defaultBytes(def) }));
    const renderImages = (req, res, status = 200, error = null) => sendHtml(res, status, imagesPage({ ...page(req), flash: takeFlash(req), error, slots: slotRows(), maxBytes: IMAGE_MAX_BYTES }));
    const images = (req, res) => renderImages(req, res);
    const rerenderImages = (req, res, status, message) => renderImages(req, res, status, message);

    function slotOf(req) {
        const def = slotDef(req.params?.slot);
        if (!def) throw new InputError('Unknown image.');
        return def;
    }

    const imageUpload = ownerPost(async (req, res) => {
        const def = slotOf(req);
        const prepared = await w.prepareImage(def, req.upload?.file?.data || null);
        let saved;
        try {
            saved = await w.images.save({ slot: def.slot, ...prepared, userId: actorOf(req).userId });
        } catch (error) {
            logger.error(`Website image save ${def.slot} failed: ${error.message}`);
            return fail(res, 503, 'Database unavailable', UNAVAILABLE, req);
        }
        setUploadedImage({ ...saved.row, bytes: prepared.bytes });
        await audit(req, [{
            key: `image.${def.slot}`, old: saved.oldSha256 ? `sha256 ${saved.oldSha256}` : 'default file',
            new: cut(`${prepared.mime} ${prepared.width}×${prepared.height}, ${prepared.bytes.length} bytes, sha256 ${prepared.sha256} (from ${prepared.source.type} ${prepared.source.width}×${prepared.source.height})`),
        }], AUDIT_MODULE);
        await flash(req, [`${def.label}: replaced. It is live at ${def.path} now (browsers may keep the old one for up to 5 minutes).`, ...prepared.warnings].join(' '));
        return res.redirect(303, path('/owner/website/images'));
    }, { rerender: rerenderImages });

    const imageReset = ownerPost(async (req, res) => {
        const def = slotOf(req);
        if (!uploadedImage(def.slot)) throw new InputError('This image is already the default.');
        let result;
        try {
            result = await w.images.remove(def.slot);
        } catch (error) {
            logger.error(`Website image reset ${def.slot} failed: ${error.message}`);
            return fail(res, 503, 'Database unavailable', UNAVAILABLE, req);
        }
        clearUploadedImage(def.slot);
        if (result.removed) await audit(req, [{ key: `image.${def.slot}`, old: `sha256 ${result.oldSha256}`, new: 'default file' }], AUDIT_MODULE);
        await flash(req, `${def.label}: back to the default image.`);
        return res.redirect(303, path('/owner/website/images'));
    }, { rerender: rerenderImages });

    /**
     * The editor never shows "default" for data it could not read: after a failed load at startup
     * the copy is loaded again first; if that fails too, the database-unavailable page (the public
     * site keeps showing the catalog text and default images meanwhile). Routes run requireOwner first.
     */
    const ready = (isLoaded, load, handler) => async (req, res, next) => {
        if (!isLoaded() && (await load()) === null) return fail(res, 503, 'Database unavailable', 'The saved website texts and images could not be read, so the editor is not shown. Try again in a few minutes.', req);
        return handler(req, res, next);
    };
    const text$ = (handler) => ready(isSiteContentLoaded, () => loadSiteContent(w.content), handler);
    const image$ = (handler) => ready(isSiteImagesLoaded, () => loadSiteImages(w.images), handler);

    return {
        home: text$(home), namespace: text$(namespace), key: text$(key), save: text$(save), reset: text$(reset), restore: text$(restore),
        images: image$(images), imageUpload: image$(imageUpload), imageReset: image$(imageReset),
    };
}
