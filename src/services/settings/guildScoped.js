// guildScoped.js — reading a per-server setting from code that used to read the main
// server's value through a config object (enforcementConfig.X / automodConfig.X).
//
//   home server (main / support, or no guild given): the config object's value, exactly as
//     before (main-server value; the getters also honour test pins).
//   any other server: resolveSetting(guildId, key): only what it stored, else the neutral
//     default (null / [] for places); throws SettingsUnavailableError when its row could not
//     be read. Never another server's value.
//
// noteSettingsUnavailable() is for crons, events and automod: they skip that server for this
// run and log it at most once per server per interval (no log flood).

import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { isHomeGuild, resolveSetting } from './guildSettings.js';

/** True when the old main-server value applies: no guild, the main server, or the support server. */
export function usesHomeValues(guildId) {
    if (!guildId) return true;
    return guildId === enforcementConfig.mainGuildId || isHomeGuild(guildId);
}

/** `config[key]` for a home server, else resolveSetting(guildId, key). */
export function guildSetting(guildId, key, config) {
    return usesHomeValues(guildId) ? config[key] : resolveSetting(guildId, key);
}

export function isSettingsUnavailable(error) {
    return error?.name === 'SettingsUnavailableError';
}

const NOTE_INTERVAL_MS = 10 * 60 * 1000;
const MAX_NOTED = 1000;
const noted = new Map(); // guildId → last logged at

/** Logs "skipped <what> in <guild>" at most once per guild per 10 minutes. Returns true when logged. */
export function noteSettingsUnavailable(guildId, what, now = Date.now()) {
    const key = String(guildId || 'unknown');
    const last = noted.get(key);
    if (last !== undefined && now - last < NOTE_INTERVAL_MS) return false;
    noted.delete(key);
    if (noted.size >= MAX_NOTED) noted.delete(noted.keys().next().value);
    noted.set(key, now);
    logger.warn(`Settings of guild ${key} not loaded (database not responding): ${what} skipped for now`);
    return true;
}

export function resetSettingsUnavailableNotes() {
    noted.clear();
}
