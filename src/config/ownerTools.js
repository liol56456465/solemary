// ownerTools.js — the owner's private server for owner-only tools (/database).
//
// OWNER_TOOLS_GUILD_ID (not a secret; default below) is the one server where /database is
// registered, as a guild command. It is never the main or the support server: if it is set
// to one of them, owner tools are off (null) and nothing is registered anywhere.

import { enforcementConfig } from './enforcement.js';
import { PRODUCTION_GUILD_IDS } from './testMode.js';

export const DEFAULT_OWNER_TOOLS_GUILD_ID = '1564332751170044186';
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * The owner-tools server id, or null when owner tools are off (invalid value, or the same as
 * the main / support server). `env` and the guild ids are injectable for tests.
 */
export function ownerToolsGuildId({
    env = process.env,
    mainGuildId = enforcementConfig.mainGuildId,
    supportGuildId = enforcementConfig.supportGuildId,
} = {}) {
    const raw = String(env.OWNER_TOOLS_GUILD_ID ?? '').trim();
    const id = raw || DEFAULT_OWNER_TOOLS_GUILD_ID;
    if (!SNOWFLAKE.test(id)) return null;
    // The real main / support servers are refused even when MAIN_GUILD_ID / SUPPORT_GUILD_ID are unset.
    if (id === mainGuildId || id === supportGuildId || PRODUCTION_GUILD_IDS.has(id)) return null;
    return id;
}

/** Why owner tools are off, or null when they are on. For the startup log. */
export function ownerToolsProblem(options = {}) {
    if (ownerToolsGuildId(options)) return null;
    const env = options.env || process.env;
    const raw = String(env.OWNER_TOOLS_GUILD_ID ?? '').trim();
    if (raw && !SNOWFLAKE.test(raw)) return 'OWNER_TOOLS_GUILD_ID is not a server ID; /database is not registered';
    return 'OWNER_TOOLS_GUILD_ID is the main or the support server; /database is not registered (it must never be there)';
}
