// guildSettings.js — the one cached settings service for per-server settings
// (guild_settings table, keyed by guild_id; the keys are in settingsRegistry.js).
//
//   loadAllSettings()        reads every row into memory; called at startup before the
//                            bot handles any event (like community/settingsService.js)
//   seedFromEnvOnce()        copies the env / hardcoded values of keys a row does not
//                            have yet into the row (one-time seed; later env changes
//                            are ignored once a key is stored)
//   getSetting(guild, key)   synchronous, from memory. A key that is not stored (or a
//                            cache that never loaded because the database was down at
//                            boot) falls back to env → default — owner decision 1.
//   updateSettings(...)      validates through the registry, writes under a row lock
//                            (SELECT … FOR UPDATE), refreshes the cache and writes one
//                            dashboard_audit row per changed key (old → new).
//
// The config objects (config/enforcement.js, config/automod.js) expose these keys as
// getters (bindSettingGetters), so existing callers keep reading them synchronously.
//
// Multi-server (B0a): resolveSetting(guildId, key) / settingsFor(guildId) /
// refreshGuildSettings(guildId) are the per-guild reads. Env and hardcoded fallbacks apply
// ONLY to the home servers (MAIN_GUILD_ID / SUPPORT_GUILD_ID); any other server gets what it
// stored, else neutralValue(), and an error (never defaults) when its row could not be read.
// Compatibility layer, unchanged: getConfiguredSetting(key) and the config getters still
// return the main (or support) server's values; getSetting(guildId, key) keeps its old
// any-server fallback until B0b moves its callers (docs/multi-server-b0.md).
//
// The database helpers are imported lazily so this module (imported by the config
// files) never pulls the database layer into their import graph.

import { logger } from '../../utils/logger.js';
import {
    entriesForGuild, getSettingEntry, neutralValue, seedValue, settingKeys, validatePatch, validateSetting,
} from './settingsRegistry.js';

const SNOWFLAKE = /^\d{17,20}$/;

const cache = new Map(); // guildId → { data: {key: value}, seeded: boolean, updatedAt }
let loaded = false;
let allRowsLoaded = false; // only loadAllSettings sets this (the seed reads just the home rows)

let dbModule = null;
async function dbHelpers() {
    if (!dbModule) {
        const [db, pg] = await Promise.all([
            import('../enforcement/db.js'),
            import('../../config/database/postgres.js'),
        ]);
        dbModule = {
            query: db.query,
            withTransaction: db.withTransaction,
            isAvailable: db.isEnforcementDbAvailable,
            settingsTable: pg.pgConfig.tables.guild_settings,
            auditTable: pg.pgConfig.tables.dashboard_audit,
        };
    }
    return dbModule;
}

const clone = (value) => (value !== null && typeof value === 'object' ? structuredClone(value) : value);
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** MAIN_GUILD_ID / SUPPORT_GUILD_ID for a registry entry's `guild`. */
export function guildIdFor(guild, env = process.env) {
    const name = guild === 'support' ? 'SUPPORT_GUILD_ID' : 'MAIN_GUILD_ID';
    return String(env[name] || '').trim() || null;
}

/**
 * The server whose settings apply to something of `guildId` that home servers share (appeals):
 * the main server for either home server, the server itself otherwise.
 */
export function homeSettingsGuild(guildId, env = process.env) {
    return isHomeGuild(guildId, env) ? guildIdFor('main', env) || guildId : guildId;
}

/** 'main' | 'support' | null for a guild id. */
export function guildRole(guildId, env = process.env) {
    if (!guildId) return null;
    if (guildId === guildIdFor('main', env)) return 'main';
    if (guildId === guildIdFor('support', env)) return 'support';
    return null;
}

/** Drops stored values that no longer pass their schema (logged), so they fall back to env. */
function cleanData(guildId, data) {
    const out = {};
    for (const [key, value] of Object.entries(data && typeof data === 'object' ? data : {})) {
        if (!getSettingEntry(key)) continue; // a key from a newer/older version: ignored, kept in the row
        const result = validateSetting(key, value);
        if (result.ok) out[key] = result.value;
        else logger.warn(`Setting ${key} of guild ${guildId} is invalid in the database (${result.error}); using the env/default value`);
    }
    return out;
}

function cacheRow(row) {
    cache.set(row.guild_id, {
        data: cleanData(row.guild_id, row.data),
        seeded: Boolean(row.seeded_from_env),
        updatedAt: row.updated_at || null,
    });
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** True once loadAllSettings() read the table. */
export function isSettingsLoaded() {
    return loaded;
}

/**
 * A setting of a guild: stored value, else env, else default. Synchronous.
 * @deprecated for anything but the home servers: it lends env / production fallbacks to ANY
 * guild. New code uses resolveSetting(guildId, key); B0b moves the existing callers.
 */
export function getSetting(guildId, key, env = process.env) {
    const entry = getSettingEntry(key);
    if (!entry) throw new Error(`Unknown setting "${key}"`);
    const row = guildId ? cache.get(guildId) : null;
    if (row && Object.hasOwn(row.data, key)) return clone(row.data[key]);
    return seedValue(entry, env);
}

/**
 * Only what this guild stored itself (no env, no hardcoded default), or undefined. For values
 * that must not borrow another server's fallback, like the main server's admin request channel.
 */
export function getStoredSetting(guildId, key) {
    if (!getSettingEntry(key)) throw new Error(`Unknown setting "${key}"`);
    const row = guildId ? cache.get(guildId) : null;
    return row && Object.hasOwn(row.data, key) ? clone(row.data[key]) : undefined;
}

/** A setting of the server the registry assigns it to (main or support). */
export function getConfiguredSetting(key, env = process.env) {
    const entry = getSettingEntry(key);
    if (!entry) throw new Error(`Unknown setting "${key}"`);
    return getSetting(guildIdFor(entry.guild, env), key, env);
}

/** Where a value comes from: 'database' | 'env' | 'default'. */
export function settingSource(guildId, key, env = process.env) {
    const entry = getSettingEntry(key);
    if (!entry) return null;
    const row = guildId ? cache.get(guildId) : null;
    if (row && Object.hasOwn(row.data, key)) return 'database';
    return entry.env && String(env[entry.env] ?? '').trim() ? 'env' : 'default';
}

/** { key: value } for every setting of a module that lives on this guild. */
export function getModuleSettings(guildId, module, env = process.env) {
    const role = guildRole(guildId, env) || 'main';
    const out = {};
    for (const entry of entriesForGuild(role)) {
        if (entry.module === module) out[entry.key] = getSetting(guildId, entry.key, env);
    }
    return out;
}

// ── Per-guild core (multi-server, phase B0a) ──────────────────────────────
//
// getSetting() above lets EVERY server fall back to env vars and the hardcoded production
// IDs, so another server would silently use Mewvo's channels and roles. The functions below
// are the multi-server-safe reads; B0b moves the callers listed in docs/multi-server-b0.md
// onto them. For the home servers (MAIN_GUILD_ID / SUPPORT_GUILD_ID) they return exactly
// what getSetting returns today (same sources, same order: stored → env → default, and env
// while the database was down at boot — owner decision 1). Every other server gets only what
// it stored itself, else neutralValue() (null / [] for places, generic defaults otherwise),
// and an error instead of defaults when its settings could not be read.

/** Thrown when a non-home server's settings are asked for but could not be read from the database. */
export class SettingsUnavailableError extends Error {
    constructor(guildId, cause) {
        super(`Settings of guild ${guildId} are not loaded: database not responding`);
        this.name = 'SettingsUnavailableError';
        this.type = 'database'; // ErrorTypes.DATABASE (not imported: config files import this module)
        this.userMessage = 'The database is not responding right now, so nothing was changed. Please try again in a minute.';
        this.guildId = guildId;
        if (cause) this.cause = cause;
    }
}

const fetchedGuilds = new Set(); // non-home guilds read one by one by refreshGuildSettings()

/** True for Mewvo's own servers (configured MAIN_GUILD_ID / SUPPORT_GUILD_ID). */
export function isHomeGuild(guildId, env = process.env) {
    return guildRole(guildId, env) !== null;
}

function requireGuildId(guildId) {
    const id = typeof guildId === 'string' ? guildId.trim() : '';
    if (!id) throw new TypeError('A guild id is required');
    return id;
}

/**
 * One setting of one guild. Home server: identical to getSetting(guildId, key). Any other
 * server: its stored value, else neutralValue(entry); throws SettingsUnavailableError when the
 * table was never read (database down at boot) and the guild was not refreshed since.
 */
export function resolveSetting(guildId, key, env = process.env) {
    const entry = getSettingEntry(key);
    if (!entry) throw new Error(`Unknown setting "${key}"`);
    const id = requireGuildId(guildId);
    if (isHomeGuild(id, env)) return getSetting(id, key, env);
    const row = cache.get(id);
    if (!row && !allRowsLoaded && !fetchedGuilds.has(id)) throw new SettingsUnavailableError(id);
    if (row && Object.hasOwn(row.data, key)) return clone(row.data[key]);
    return neutralValue(entry);
}

/** Where resolveSetting's value comes from: 'database' | 'env' | 'default' (non-home: never 'env'). */
export function resolvedSource(guildId, key, env = process.env) {
    const id = requireGuildId(guildId);
    if (isHomeGuild(id, env)) return settingSource(id, key, env);
    if (!getSettingEntry(key)) return null;
    const row = cache.get(id);
    if (!row && !allRowsLoaded && !fetchedGuilds.has(id)) throw new SettingsUnavailableError(id);
    return row && Object.hasOwn(row.data, key) ? 'database' : 'default';
}

/**
 * Every registry setting of one guild, resolved like resolveSetting: { key: value } (copies).
 * Synchronous, from the cache. Throws like resolveSetting.
 */
export function settingsFor(guildId, env = process.env) {
    const id = requireGuildId(guildId);
    const out = {};
    for (const key of settingKeys()) out[key] = resolveSetting(id, key, env);
    return out;
}

/**
 * Reads one guild's row from the database into the cache (or drops a stale cached row when
 * there is none) and returns settingsFor(guildId). Throws SettingsUnavailableError when the
 * database is down or the query fails; the cache is left as it was then.
 */
export async function refreshGuildSettings(guildId, env = process.env) {
    const id = requireGuildId(guildId);
    const db = await dbHelpers();
    if (!db.isAvailable()) throw new SettingsUnavailableError(id);
    let rows;
    try {
        ({ rows } = await db.query(
            `SELECT guild_id, data, seeded_from_env, updated_at FROM ${db.settingsTable} WHERE guild_id = $1`, [id]));
    } catch (error) {
        throw new SettingsUnavailableError(id, error);
    }
    if (rows[0]) cacheRow(rows[0]);
    else cache.delete(id);
    if (!isHomeGuild(id, env)) fetchedGuilds.add(id);
    return settingsFor(id, env);
}

/**
 * The guild whose row holds `key` when the dashboard of `guildId` reads or saves it (missing
 * `guildId` = the main server). Mewvo's home servers keep the registry mapping (a support key
 * lives on the support server, everything else on the main server). Any other server: its own
 * id, or null for keys it does not have (support-server keys and `homeOnly` keys).
 */
export function settingGuildId(guildId, key, env = process.env) {
    const entry = getSettingEntry(key);
    if (!entry) throw new Error(`Unknown setting "${key}"`);
    if (!isOtherGuild(guildId, env)) return guildIdFor(entry.guild, env);
    return entry.guild === 'support' || entry.homeOnly ? null : guildId.trim();
}

/**
 * True when `guildId` is a server other than Mewvo's own (missing = the main server, so false).
 * Without a configured MAIN_GUILD_ID there are no home servers to tell apart (the dashboard is
 * off then) and everything keeps the old single-server mapping: false.
 */
export function isOtherGuild(guildId, env = process.env) {
    const id = typeof guildId === 'string' ? guildId.trim() : '';
    return Boolean(id && guildIdFor('main', env) && !isHomeGuild(id, env));
}

/**
 * Defines getter/setter properties on a config object for the given setting keys.
 * Reading goes through getConfiguredSetting; assigning (tests only) pins a value
 * until the next assignment of undefined.
 */
export function bindSettingGetters(target, keys) {
    for (const key of keys) {
        if (!getSettingEntry(key)) throw new Error(`Unknown setting "${key}"`);
        let pinned;
        let isPinned = false;
        Object.defineProperty(target, key, {
            enumerable: true,
            configurable: true,
            get: () => (isPinned ? pinned : getConfiguredSetting(key)),
            set: (value) => {
                isPinned = value !== undefined;
                pinned = value;
            },
        });
    }
    return target;
}

// ── Startup ───────────────────────────────────────────────────────────────

/** Reads every guild_settings row into memory. Returns the row count, or null when the database is down. */
export async function loadAllSettings() {
    const db = await dbHelpers();
    if (!db.isAvailable()) {
        logger.warn('Settings: database unavailable, running on env/default values');
        return null;
    }
    try {
        const { rows } = await db.query(`SELECT guild_id, data, seeded_from_env, updated_at FROM ${db.settingsTable}`);
        cache.clear();
        for (const row of rows) cacheRow(row);
        loaded = true;
        allRowsLoaded = true;
        return rows.length;
    } catch (error) {
        logger.error(`Settings could not be loaded (running on env/default values): ${error.message}`);
        return null;
    }
}

/**
 * The additive seed patch: { key: env/default value } for every entry the stored row `data`
 * does NOT have yet. A key that is already stored (whatever its value, null included) is never
 * in the patch, so applying it with `data || patch` can only add keys, never overwrite. Values
 * that fail their schema are left out (logged); the bot keeps reading them from the env.
 */
export function missingSeedPatch(data, entries, env = process.env) {
    const stored = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const missing = {};
    for (const entry of entries) {
        if (Object.hasOwn(stored, entry.key)) continue;
        const value = seedValue(entry, env);
        const check = validateSetting(entry.key, value);
        if (check.ok) missing[entry.key] = check.value;
        else logger.warn(`Settings seed: ${entry.env || entry.key} is not valid (${check.error}); not stored, the bot keeps using it from the environment`);
    }
    return missing;
}

/**
 * For the main and support server: stores the env/default value of every registry key
 * the row does not have yet, and marks the row seeded. Keys already stored are never
 * touched, so the env only seeds once per key. Returns { guildId: [seeded keys] } or
 * null when the database is down.
 */
export async function seedFromEnvOnce(env = process.env) {
    const db = await dbHelpers();
    if (!db.isAvailable()) return null;
    const seeded = {};
    for (const guild of ['main', 'support']) {
        const guildId = guildIdFor(guild, env);
        if (!guildId) continue;
        const entries = entriesForGuild(guild);
        const row = await db.withTransaction(async (client) => {
            await client.query(
                `INSERT INTO ${db.settingsTable} (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`, [guildId]);
            const { rows: [current] } = await client.query(
                `SELECT guild_id, data, seeded_from_env, updated_at FROM ${db.settingsTable} WHERE guild_id = $1 FOR UPDATE`, [guildId]);
            const missing = missingSeedPatch(current.data, entries, env);
            seeded[guildId] = Object.keys(missing);
            if (!seeded[guildId].length && current.seeded_from_env) return current;
            const { rows: [updated] } = await client.query(
                `UPDATE ${db.settingsTable} SET data = data || $2::jsonb, seeded_from_env = TRUE, updated_at = NOW()
                 WHERE guild_id = $1 RETURNING guild_id, data, seeded_from_env, updated_at`,
                [guildId, JSON.stringify(missing)]);
            return updated;
        });
        cacheRow(row);
    }
    loaded = true;
    return seeded;
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Changes settings of one guild. patch = { key: value } (validated by the registry,
 * every key must belong to this guild's role); actor = { userId, username, module? }.
 * Mewvo's home servers use role 'main' / 'support' (old value = stored, else env/default);
 * any other server uses role 'other' (only `guild: 'main'` keys without `homeOnly`; old
 * value = stored, else neutralValue) and only ever touches its own row.
 * Returns { changes: [{ key, module, old, new }], settings: { key: value } }.
 * Throws (with userMessage) on invalid input, an unknown guild or a database error;
 * nothing is changed then.
 */
export async function updateSettings(guildId, patch, actor = {}, env = process.env) {
    const id = typeof guildId === 'string' ? guildId.trim() : '';
    if (!SNOWFLAKE.test(id) && !isHomeGuild(id, env)) {
        throw Object.assign(new Error(`Invalid guild id ${JSON.stringify(guildId)}`), { userMessage: 'Settings can only be changed for a server.' });
    }
    guildId = id;
    const role = guildRole(guildId, env) || 'other';
    const fallbackOf = role === 'other' ? (entry) => neutralValue(entry) : (entry) => seedValue(entry, env);
    const clean = validatePatch(patch, role);
    const keys = Object.keys(clean);
    const db = await dbHelpers();
    const result = await db.withTransaction(async (client) => {
        await client.query(
            `INSERT INTO ${db.settingsTable} (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`, [guildId]);
        const { rows: [current] } = await client.query(
            `SELECT data FROM ${db.settingsTable} WHERE guild_id = $1 FOR UPDATE`, [guildId]);
        const stored = current.data && typeof current.data === 'object' ? current.data : {};
        const changes = [];
        for (const key of keys) {
            const old = Object.hasOwn(stored, key) ? stored[key] : fallbackOf(getSettingEntry(key));
            if (!sameValue(old, clean[key])) changes.push({ key, module: getSettingEntry(key).module, old, new: clean[key] });
        }
        const { rows: [row] } = await client.query(
            `UPDATE ${db.settingsTable} SET data = data || $2::jsonb, updated_by = $3, updated_at = NOW()
             WHERE guild_id = $1 RETURNING guild_id, data, seeded_from_env, updated_at`,
            [guildId, JSON.stringify(clean), actor.userId || null]);
        for (const change of changes) {
            const entry = getSettingEntry(change.key);
            await client.query(
                `INSERT INTO ${db.auditTable} (guild_id, user_id, username, module, key, old, new)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
                [guildId, actor.userId || null, String(actor.username || '').slice(0, 100) || null, actor.module || change.module, change.key,
                    JSON.stringify(entry.sensitive ? '[hidden]' : change.old ?? null), JSON.stringify(entry.sensitive ? '[hidden]' : change.new ?? null)]);
        }
        return { row, changes };
    });
    cacheRow(result.row);
    if (result.changes.length) {
        logger.info(`Settings changed in ${guildId} by ${actor.userId || 'unknown'}: ${result.changes.map((c) => c.key).join(', ')}`);
    }
    const settings = {};
    for (const key of keys) settings[key] = resolveSetting(guildId, key, env);
    return { changes: result.changes, settings };
}

/** Recent dashboard_audit rows of a guild, newest first. */
export async function listSettingsAudit(guildId, limit = 50) {
    const db = await dbHelpers();
    const { rows } = await db.query(
        `SELECT id, guild_id, user_id, username, module, key, old, new, created_at FROM ${db.auditTable}
         WHERE guild_id = $1 ORDER BY id DESC LIMIT $2`,
        [guildId, Math.min(500, Math.max(1, limit))]);
    return rows;
}

// ── Tests ─────────────────────────────────────────────────────────────────

/** For tests: replace (or with null, drop) the cached row of a guild. */
export function setSettingsCacheForTests(guildId, data) {
    if (data) cache.set(guildId, { data: { ...data }, seeded: true, updatedAt: null });
    else cache.delete(guildId);
}

/** For tests: forget everything that was loaded. */
export function resetSettingsCacheForTests() {
    cache.clear();
    fetchedGuilds.clear();
    loaded = false;
    allRowsLoaded = false;
}

/** For tests: replace the lazily imported database helpers ({ query, withTransaction, isAvailable, settingsTable, auditTable }); null restores them. */
export function setSettingsDbForTests(helpers) {
    dbModule = helpers || null;
}
