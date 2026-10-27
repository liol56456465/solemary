// automodSettings.js — per-guild automod settings and state kept in the key-value
// store, with a short in-memory cache because messageCreate reads them constantly.

import { db, getFromDb, setInDb } from '../../utils/database.js';
import { automodConfig } from '../../config/automod.js';

const CACHE_TTL_MS = 30 * 1000;
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    // 'enforce': act and post a review card. 'monitor': only post the card, with an Apply button.
    // Rules without an entry in ruleModes follow it (services/automod/policy.js).
    mode: 'enforce',
    exemptChannelIds: [],
    // rule key → 'on' | 'monitor' | 'off' (/automod rule).
    ruleModes: {},
    // channel or category id → { rule key → 'off' | 'monitor' } (/automod channel).
    channelRules: {},
    // Trusted members skip the low-severity rules (/automod trusted): a role and/or a
    // minimum leveling level (0 = no level criterion).
    trusted: { roleId: null, minLevel: 0 },
    // First small offence: a notice instead of a warning (/automod secondchance).
    secondChance: true,
    // Calm-down note + slowmode when a channel heats up (/automod mood).
    moodAlerts: true,
});

/** Stored settings (any shape, or null) → a complete settings object. */
export function normalizeSettings(stored) {
    const value = { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
    value.exemptChannelIds = Array.isArray(value.exemptChannelIds) ? [...value.exemptChannelIds] : [];
    value.ruleModes = value.ruleModes && typeof value.ruleModes === 'object' ? { ...value.ruleModes } : {};
    value.channelRules = value.channelRules && typeof value.channelRules === 'object'
        ? Object.fromEntries(Object.entries(value.channelRules).map(([id, rules]) => [id, { ...rules }]))
        : {};
    const trusted = value.trusted && typeof value.trusted === 'object' ? value.trusted : {};
    value.trusted = { roleId: trusted.roleId || null, minLevel: Math.max(0, Number(trusted.minLevel) || 0) };
    value.secondChance = value.secondChance !== false;
    value.moodAlerts = value.moodAlerts !== false;
    return value;
}

const cache = new Map();

const settingsKey = (guildId) => `automod:settings:${guildId}`;
const lockdownKey = (guildId) => `automod:lockdown:${guildId}`;

export async function getAutomodSettings(guildId) {
    const cached = cache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const stored = await getFromDb(settingsKey(guildId), null);
    const value = normalizeSettings(stored);
    cache.set(guildId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
}

/**
 * Changes the settings under a row lock. `patch` is an object merged over the
 * current settings, or a function (current settings → new settings) for nested
 * changes such as one rule's mode. Resolves the saved settings or throws.
 */
export async function updateAutomodSettings(guildId, patch) {
    const saved = await db.update(settingsKey(guildId), (current) => {
        const base = normalizeSettings(current);
        return typeof patch === 'function' ? patch(base) : { ...base, ...patch };
    }, null);
    const value = normalizeSettings(saved);
    cache.set(guildId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
}

export async function isChannelExempt(guildId, channel) {
    const settings = await getAutomodSettings(guildId);
    const ids = new Set([...automodConfig.exemptChannelIds, ...settings.exemptChannelIds]);
    // A thread follows its parent channel.
    return ids.has(channel.id) || Boolean(channel.parentId && ids.has(channel.parentId) && channel.isThread?.());
}

/** { active, startedAt, previousVerificationLevel, joinerIds[] } or null. */
export async function getLockdown(guildId) {
    return getFromDb(lockdownKey(guildId), null);
}

export async function setLockdown(guildId, state) {
    await setInDb(lockdownKey(guildId), state);
}
