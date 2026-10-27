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
// The database helpers are imported lazily so this module (imported by the config
// files) never pulls the database layer into their import graph.

import { logger } from '../../utils/logger.js';
import {
    entriesForGuild, getSettingEntry, seedValue, validatePatch, validateSetting,
} from './settingsRegistry.js';

const cache = new Map(); // guildId → { data: {key: value}, seeded: boolean, updatedAt }
let loaded = false;

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

/** A setting of a guild: stored value, else env, else default. Synchronous. */
export function getSetting(guildId, key, env = process.env) {
    const entry = getSettingEntry(key);
    if (!entry) throw new Error(`Unknown setting "${key}"`);
    const row = guildId ? cache.get(guildId) : null;
    if (row && Object.hasOwn(row.data, key)) return clone(row.data[key]);
    return seedValue(entry, env);
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
        return rows.length;
    } catch (error) {
        logger.error(`Settings could not be loaded (running on env/default values): ${error.message}`);
        return null;
    }
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
            const data = current.data && typeof current.data === 'object' ? current.data : {};
            const missing = {};
            for (const entry of entries) {
                if (Object.hasOwn(data, entry.key)) continue;
                const value = seedValue(entry, env);
                const check = validateSetting(entry.key, value);
                if (check.ok) missing[entry.key] = check.value;
                else logger.warn(`Settings seed: ${entry.env || entry.key} is not valid (${check.error}); not stored, the bot keeps using it from the environment`);
            }
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
 * Returns { changes: [{ key, module, old, new }], settings: { key: value } }.
 * Throws (with userMessage) on invalid input, an unknown guild or a database error;
 * nothing is changed then.
 */
export async function updateSettings(guildId, patch, actor = {}, env = process.env) {
    const role = guildRole(guildId, env);
    if (!role) {
        throw Object.assign(new Error(`Guild ${guildId} is not the main or support server`), { userMessage: 'Settings can only be changed for the main or support server.' });
    }
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
            const old = Object.hasOwn(stored, key) ? stored[key] : seedValue(getSettingEntry(key), env);
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
    for (const key of keys) settings[key] = getSetting(guildId, key, env);
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
    loaded = false;
}
