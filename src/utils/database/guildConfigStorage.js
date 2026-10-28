import { GUILD_CONFIG_DEFAULTS } from '../../config/guild/guildConfigDefaults.js';
import { normalizeGuildConfig, validateGuildConfigOrThrow } from '../schemas.js';
import { createError, ErrorTypes } from '../errorHandler.js';
import { getGuildConfigKey } from './keys.js';

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

    const rawConfig = await client.db.get(getGuildConfigKey(guildId), null);
    if (rawConfig === null) {
        return normalizeGuildConfig({}, GUILD_CONFIG_DEFAULTS);
    }
    return normalizeGuildConfig(unwrapReplitData(rawConfig), GUILD_CONFIG_DEFAULTS);
}

/**
 * Locked read-modify-write of a guild config: change(current) returns the new
 * config, which is normalized, validated and saved while the row is locked.
 */
export async function updateGuildConfigAtomic(client, guildId, change, context = {}) {
    if (!client?.db || typeof client.db.update !== 'function') {
        throw databaseUnavailable(guildId, context);
    }
    return client.db.update(getGuildConfigKey(guildId), async (raw) => {
        const current = normalizeGuildConfig(unwrapReplitData(raw) || {}, GUILD_CONFIG_DEFAULTS);
        const next = normalizeGuildConfig(await change(current), GUILD_CONFIG_DEFAULTS);
        return validateGuildConfigOrThrow(next, { guildId, ...context });
    }, {});
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
    await client.db.set(getGuildConfigKey(guildId), validated);
    return validated;
}
