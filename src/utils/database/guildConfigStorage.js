import { GUILD_CONFIG_DEFAULTS } from '../../config/guild/guildConfigDefaults.js';
import { normalizeGuildConfig, validateGuildConfigOrThrow } from '../schemas.js';
import { createError, ErrorTypes } from '../errorHandler.js';
import { getGuildConfigKey } from './keys.js';
import { createConfigCache } from '../configCache.js';

// Read cache (B5): getGuildConfig runs on every message and every log event. 2,000 servers,
// 60 s; every write below clears the server's entry (configCache.js has the rules).
export const GUILD_CONFIG_CACHE_SIZE = 2000;
export const GUILD_CONFIG_CACHE_TTL_MS = 60_000;
const configCache = createConfigCache({ maxSize: GUILD_CONFIG_CACHE_SIZE, ttlMs: GUILD_CONFIG_CACHE_TTL_MS });

/** Drops a server's cached config (for a write that does not go through this module). */
export function invalidateGuildConfigCache(client, guildId) {
    configCache.invalidate(client?.db, guildId);
}

/** Tests / health: { hits, misses } and the entries held for this client. */
export function guildConfigCacheInfo(client) {
    return { ...configCache.stats(), size: configCache.size(client?.db) };
}

export function unwrapReplitData(data) {
    if (
        typeof data === 'object' &&
        data !== null &&
        data.ok !== undefined &&
        data.value !== undefined
    ) {
        return unwrapReplitData(data.value);
    }
    return data;
}

function databaseUnavailable(guildId, context) {
    return createError(
        'Database client unavailable for guild config',
        ErrorTypes.DATABASE,
        'The database is not responding right now, so nothing was changed. Please try again in a moment.',
        { guildId, ...context },
    );
}

/**
 * Low-level guild config read. Returns the normalized config, with defaults only
 * when the guild has none saved. A failed read throws: defaults returned on an
 * outage would be saved over the real config by the next write.
 */
export async function readGuildConfig(client, guildId, context = {}) {
    if (!client?.db || typeof client.db.get !== 'function') {
        throw databaseUnavailable(guildId, context);
    }

    return configCache.read(client.db, guildId, async () => {
        const rawConfig = await client.db.get(getGuildConfigKey(guildId), null);
        if (rawConfig === null) {
            return normalizeGuildConfig({}, GUILD_CONFIG_DEFAULTS);
        }
        return normalizeGuildConfig(unwrapReplitData(rawConfig), GUILD_CONFIG_DEFAULTS);
    });
}

/**
 * Locked read-modify-write of a guild config: change(current) returns the new
 * config, which is normalized, validated and saved while the row is locked.
 */
export async function updateGuildConfigAtomic(client, guildId, change, context = {}) {
    if (!client?.db || typeof client.db.update !== 'function') {
        throw databaseUnavailable(guildId, context);
    }
    const saved = await configCache.write(client.db, guildId, () => client.db.update(getGuildConfigKey(guildId), async (raw) => {
        const current = normalizeGuildConfig(unwrapReplitData(raw) || {}, GUILD_CONFIG_DEFAULTS);
        const next = normalizeGuildConfig(await change(current), GUILD_CONFIG_DEFAULTS);
        return validateGuildConfigOrThrow(next, { guildId, ...context });
    }, {}));
    notifyConfigSaved(guildId, saved);
    return saved;
}

// Called after every successful config write with (guildId, savedConfig), so in-memory lists
// derived from configs (modmail servers) stay current. A listener's error never fails the write.
const savedListeners = new Set();

/** Registers fn(guildId, config) for every saved guild config; returns an unsubscribe function. */
export function onGuildConfigSaved(fn) {
    savedListeners.add(fn);
    return () => savedListeners.delete(fn);
}

function notifyConfigSaved(guildId, config) {
    for (const fn of savedListeners) {
        try {
            fn(String(guildId), config);
        } catch {
            // a derived list may be stale; it is refreshed on its own timer
        }
    }
}

/**
 * Low-level guild config write. Validates payload and throws on failure.
 */
export async function writeGuildConfig(client, guildId, config, context = {}) {
    if (!client?.db || typeof client.db.set !== 'function') {
        throw createError(
            'Database client unavailable for guild config write',
            ErrorTypes.DATABASE,
            'Failed to save server configuration. The database is unavailable.',
            { guildId, ...context },
        );
    }

    const validated = validateGuildConfigOrThrow(config, { guildId, ...context });
    await configCache.write(client.db, guildId, () => client.db.set(getGuildConfigKey(guildId), validated));
    notifyConfigSaved(guildId, validated);
    return validated;
}
