// settingsService.js — per-guild settings of the community features
// (suggestions channel, starboard channel/emoji/threshold).
//
// Held in memory (loaded at startup, updated on every change), so reaction and
// message events never read the database.

import { CT, query, isCommunityDbAvailable } from './db.js';

export const DEFAULT_SETTINGS = Object.freeze({
    suggestionsChannelId: null,
    starboardChannelId: null,
    starboardEmoji: '⭐',
    starboardThreshold: 3,
});

const COLUMNS = {
    suggestionsChannelId: 'suggestions_channel_id',
    starboardChannelId: 'starboard_channel_id',
    starboardEmoji: 'starboard_emoji',
    starboardThreshold: 'starboard_threshold',
};

let byGuild = new Map();

function toSettings(row) {
    return {
        suggestionsChannelId: row.suggestions_channel_id || null,
        starboardChannelId: row.starboard_channel_id || null,
        starboardEmoji: row.starboard_emoji || DEFAULT_SETTINGS.starboardEmoji,
        starboardThreshold: Number(row.starboard_threshold || DEFAULT_SETTINGS.starboardThreshold),
    };
}

export async function loadCommunitySettings() {
    if (!isCommunityDbAvailable()) return null;
    const { rows } = await query(`SELECT * FROM ${CT.settings}`);
    byGuild = new Map(rows.map((row) => [row.guild_id, toSettings(row)]));
    return rows.length;
}

/** Settings of a guild from memory (defaults when none are saved). */
export function getCommunitySettings(guildId) {
    return byGuild.get(guildId) || { ...DEFAULT_SETTINGS };
}

/** Saves the given settings (camelCase keys) and updates the cache; returns the new settings. */
export async function updateCommunitySettings(guildId, patch, updatedBy) {
    const keys = Object.keys(patch).filter((key) => COLUMNS[key]);
    if (!keys.length) return getCommunitySettings(guildId);
    const columns = keys.map((key) => COLUMNS[key]);
    const values = keys.map((key) => patch[key]);
    const { rows: [row] } = await query(
        `INSERT INTO ${CT.settings} (guild_id, updated_by, ${columns.join(', ')})
         VALUES ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(', ')})
         ON CONFLICT (guild_id) DO UPDATE SET updated_by = EXCLUDED.updated_by, updated_at = NOW(),
         ${columns.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}
         RETURNING *`,
        [guildId, updatedBy, ...values]
    );
    const settings = toSettings(row);
    byGuild.set(guildId, settings);
    return settings;
}

/** For tests: replace the cached settings of a guild. */
export function setCommunitySettingsForTests(guildId, settings) {
    if (settings) byGuild.set(guildId, { ...DEFAULT_SETTINGS, ...settings });
    else byGuild.delete(guildId);
}
