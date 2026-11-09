// ladderPolicy.js — whether a warn moves the 3-warn ladder in a server (beginner audit, owner
// decision D4). Two per-server settings (settingsRegistry.js, guild_settings):
//
//   warnLadderEnabled          default on. Off: warns are still recorded, but none of them ever
//                              leads to an automatic ladder ban in that server (manual bans as before).
//   automodWarnsCountOnLadder  Mewvo's home servers: on (as before). Any other server: off, so
//                              warns the bot gives on its own (automod, Discord AutoMod bridge) are
//                              recorded and shown but do not count toward a ladder ban.
//
// A warn that does not count is stored with counts_toward_level NULL (and is_imported FALSE): every
// ladder query filters on counts_toward_level = <level>, so it never counts and removing it never
// lowers the count. Reads come from the settings cache (resolveSetting) and throw
// SettingsUnavailableError when another server's settings could not be read: never a guessed default.

import { getConfiguredSetting, resolveSetting } from '../settings/guildSettings.js';
import { usesHomeValues } from '../settings/guildScoped.js';

/** Home servers (or no guild): the main server's value, as other home settings; else the server's own. */
function ladderSetting(guildId, key) {
    return usesHomeValues(guildId) ? getConfiguredSetting(key) : resolveSetting(guildId, key);
}

/** True when warns can lead to an automatic ladder ban in this server. */
export function isWarnLadderEnabled(guildId) {
    return ladderSetting(guildId, 'warnLadderEnabled') !== false;
}

/** True when the bot's own (automod) warns count toward the ladder in this server. */
export function automodWarnsCount(guildId) {
    return ladderSetting(guildId, 'automodWarnsCountOnLadder') !== false;
}

/**
 * Whether one new warn counts toward the ladder. `system`: the bot gives it on its own
 * (enforcementService.executeSystemAction: automod). Staff decisions (the panel, the dashboard,
 * the review card's Apply button) only depend on warnLadderEnabled.
 */
export function warnCountsOnLadder(guildId, { system = false } = {}) {
    if (!isWarnLadderEnabled(guildId)) return false;
    return system ? automodWarnsCount(guildId) : true;
}

/** True for a case given by automod (its reason key starts with "automod:"). */
export function isAutomodCase(row) {
    return typeof row?.reason_key === 'string' && row.reason_key.startsWith('automod:');
}

/**
 * True for a warn that was recorded without counting toward the ladder (D4): not imported,
 * counts_toward_level NULL. Old imported warns are history only and have their own label.
 * Only for rows that selected counts_toward_level (a row without the column is never "uncounted").
 */
export function isUncountedWarn(row) {
    return row?.type === 'warn' && !row.is_imported && !row.is_test
        && Object.hasOwn(row, 'counts_toward_level') && row.counts_toward_level === null;
}

/**
 * Which "doesn't count" label a case gets: 'automod' (an automod warn that did not count),
 * 'ladderOff' (a warn recorded while the warn ladder was off), or null (a normal case).
 */
export function uncountedKind(row) {
    if (!isUncountedWarn(row)) return null;
    return isAutomodCase(row) ? 'automod' : 'ladderOff';
}

/** The bot-text key of that label (src/content/bot/<lang>/enforcement.json), or null. */
export function uncountedLabelKey(row) {
    const kind = uncountedKind(row);
    return kind ? `enforcement.uncounted.${kind}` : null;
}
