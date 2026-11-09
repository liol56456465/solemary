// personalLanguage.js — a member's own language for Mewvo, without a language role (audit 4.6).
//
// Set with /language set when the server has no role for the language picked (or no language
// roles at all), and on the website (My record → Account settings). One value per Discord
// account, for every server: key-value store key `user:<id>:lang` (temp_data, no expiry; no
// schema change). Cleared by picking "server language" again, or by /wipedata.
//
// resolveBotLanguage (utils/botText.js) reads it synchronously, so the values live in memory:
// loaded once at startup (loadPersonalLanguages) and written through on every change. The
// language is cosmetic, so a failed load never stops a DM: lookups give null (the server's
// language decides), one warning is logged, and the load is retried in the background (at most
// once a minute) until it works. Reads and writes for the member's own settings page and the
// data export go to the database and throw on an error (CLAUDE.md data layer rules).

// No static import of the database wrapper: botText.js imports this file, and the wrapper's own
// imports reach botText.js again (a cycle). The wrapper is loaded on first use instead.
import { LANG_CODES } from './site/i18n.js';
import { logger } from '../utils/logger.js';

const ID = /^\d{17,20}$/;
const KEY = /^user:(\d{17,20}):lang$/;
export const RETRY_MS = 60 * 1000;
const LOAD_BATCH = 25;

/** The key-value key of a member's personal language. */
export const personalLanguageKey = (userId) => `user:${userId}:lang`;

const languages = new Map(); // userId → code
let state = 'unloaded'; // 'unloaded' | 'loading' | 'loaded' | 'failed'
let lastAttempt = -Infinity;
let warned = false;
let store = null; // the key-value store (utils/database/wrapper.js db), set by the startup load
let loading = null;
// Ids changed (set, cleared, wiped) while a load runs: their in-memory value wins over the snapshot.
let touched = null;
const touch = (id) => { touched?.add(id); };

/** The key-value store: the one given at startup, else the bot's database wrapper. */
async function kv(database) {
    if (database) return database;
    if (!store) store = (await import('../utils/database/wrapper.js')).db;
    return store;
}

const validCode = (value) => (typeof value === 'string' && LANG_CODES.includes(value) ? value : null);
const checkId = (userId) => {
    if (!ID.test(String(userId ?? ''))) throw new Error('personal language: bad user id');
    return String(userId);
};

/**
 * Loads every stored personal language into memory. Never throws: returns the number loaded,
 * or null when the database could not be read (logged; retried later by personalLanguageOf).
 * `database` (tests): an object with list(prefix) and get(key).
 */
export async function loadPersonalLanguages(database = null, { now = Date.now() } = {}) {
    if (database) store = database;
    lastAttempt = now;
    state = 'loading';
    touched = new Set();
    const job = (async () => {
        try {
            await kv(null);
            const keys = (await store.list('user:')).filter((key) => KEY.test(key));
            const loaded = new Map();
            for (let i = 0; i < keys.length; i += LOAD_BATCH) {
                const batch = keys.slice(i, i + LOAD_BATCH);
                const values = await Promise.all(batch.map((key) => store.get(key, null)));
                batch.forEach((key, n) => {
                    const code = validCode(values[n]);
                    if (code) loaded.set(key.match(KEY)[1], code);
                });
            }
            // Changes made while loading were written through already: they win (also a clear).
            for (const [userId, code] of languages) if (!loaded.has(userId)) loaded.set(userId, code);
            for (const userId of touched) {
                if (languages.has(userId)) loaded.set(userId, languages.get(userId));
                else loaded.delete(userId);
            }
            languages.clear();
            for (const [userId, code] of loaded) languages.set(userId, code);
            state = 'loaded';
            warned = false;
            return languages.size;
        } catch (error) {
            state = 'failed';
            if (!warned) {
                warned = true;
                logger.warn(`Personal languages could not be loaded (${error?.message || error}); DMs use the server language until a retry works.`);
            }
            return null;
        } finally {
            loading = null;
            touched = null;
        }
    })();
    loading = job;
    return job;
}

/**
 * The member's personal language, or null (none chosen, or not known yet). Synchronous and
 * never throws (resolveBotLanguage). While the startup load has not worked, a background retry
 * is started at most once per RETRY_MS.
 */
export function personalLanguageOf(userId, { now = Date.now() } = {}) {
    if (!userId) return null;
    if (state === 'failed' && !loading && now - lastAttempt >= RETRY_MS) {
        loadPersonalLanguages(null, { now }).catch(() => {});
    }
    return languages.get(String(userId)) ?? null;
}

/** True once the stored languages are in memory (tests, the startup log). */
export const personalLanguagesLoaded = () => state === 'loaded';

/** The member's personal language from the database (settings page, export). Throws on a database error. */
export async function readPersonalLanguage(userId, { database = null } = {}) {
    const id = checkId(userId);
    const kvStore = await kv(database);
    const code = validCode(await kvStore.get(personalLanguageKey(id), null));
    if (code) languages.set(id, code);
    else languages.delete(id);
    return code;
}

/** Saves the member's personal language. Throws on a bad code or a database error (nothing changes then). */
export async function setPersonalLanguage(userId, lang, { database = null } = {}) {
    const id = checkId(userId);
    const code = validCode(lang);
    if (!code) throw new Error('personal language: unknown language');
    const result = await (await kv(database)).set(personalLanguageKey(id), code);
    if (result === false) throw new Error('personal language: the write was not saved');
    languages.set(id, code);
    touch(id);
    return code;
}

/** Removes the member's personal language (back to each server's). Throws on a database error. */
export async function clearPersonalLanguage(userId, { database = null } = {}) {
    const id = checkId(userId);
    const kvStore = await kv(database);
    const result = await kvStore.delete(personalLanguageKey(id));
    if (result === false && await kvStore.exists?.(personalLanguageKey(id))) throw new Error('personal language: the delete was not saved');
    languages.delete(id);
    touch(id);
    return true;
}

/** /wipedata: forget the in-memory copy after the key was deleted there. */
export function forgetPersonalLanguage(userId) {
    languages.delete(String(userId));
    touch(String(userId));
}

/** For tests: a clean state, optionally with values ({ userId: code }) and a load state. */
export function setPersonalLanguagesForTests(values = {}, { loaded = true, database = null } = {}) {
    languages.clear();
    for (const [userId, code] of Object.entries(values)) languages.set(userId, code);
    state = loaded ? 'loaded' : 'unloaded';
    warned = false;
    lastAttempt = -Infinity;
    loading = null;
    touched = null;
    store = database;
}
