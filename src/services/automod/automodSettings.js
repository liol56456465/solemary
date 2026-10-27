// automodSettings.js — per-guild automod settings and state kept in the key-value
// store, with a short in-memory cache because messageCreate reads them constantly.

import { db, getFromDb, setInDb } from '../../utils/database.js';
import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { clampPanicHours, DEFAULT_PANIC_HOURS, MAX_PANIC_HOURS } from './incidentActions.js';
import { CHANNEL_RULE_MODES, RULE_MODES, withChannelRule } from './policy.js';

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
    // Raid panic mode: when a lockdown starts, also pause invites and DMs with
    // Discord's incident actions for this many hours (1–24) (/automod panic).
    panic: { enabled: true, hours: 2 },
    // Join gate: check → 'off' | 'flag' | 'kick', plus ageDays (/automod joingate;
    // normalized by joinGate.js).
    joinGate: {},
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
    const panic = value.panic && typeof value.panic === 'object' ? value.panic : {};
    value.panic = { enabled: panic.enabled !== false, hours: clampPanicHours(panic.hours ?? DEFAULT_PANIC_HOURS) };
    value.joinGate = value.joinGate && typeof value.joinGate === 'object' ? { ...value.joinGate } : {};
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

/** { active, startedAt, previousVerificationLevel, raisedVerification, incidentActions, gateKicks, joinerIds[] } or null. */
export async function getLockdown(guildId) {
    return getFromDb(lockdownKey(guildId), null);
}

export async function setLockdown(guildId, state) {
    await setInDb(lockdownKey(guildId), state);
}

// ── Setting helpers ───────────────────────────────────────────────────────────
// Used by /automod and the web dashboard, so both validate and write the same way.
// Every write is a locked read-modify-write (updateAutomodSettings). Each resolves
// the saved (normalized) settings; invalid input throws a TitanBotError whose
// userMessage can be shown as is.

export const TRUSTED_MIN_LEVEL_MAX = 1000;
export const JOIN_GATE_DAYS_MIN = 1;
export const JOIN_GATE_DAYS_MAX = 365;
const SNOWFLAKE = /^\d{17,20}$/;
const AUTOMOD_MODES = ['enforce', 'monitor'];

function userError(message) {
    return createError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

function requireBoolean(value, what) {
    if (typeof value !== 'boolean') throw userError(`${what} must be on or off.`);
    return value;
}

function requireSnowflake(id, what) {
    if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw userError(`Pick a valid ${what}.`);
    return id;
}

function requireIntegerInRange(value, min, max, message) {
    if (!Number.isInteger(value) || value < min || value > max) throw userError(message);
    return value;
}

function requireRule(ruleKey) {
    if (typeof ruleKey !== 'string' || !Object.hasOwn(AUTOMOD_RULES, ruleKey)) throw userError('Unknown rule.');
    return ruleKey;
}

export async function setAutomodEnabled(guildId, enabled) {
    requireBoolean(enabled, 'Automod');
    return updateAutomodSettings(guildId, { enabled });
}

/** mode: 'enforce' | 'monitor'. */
export async function setAutomodMode(guildId, mode) {
    if (!AUTOMOD_MODES.includes(mode)) throw userError('Unknown mode.');
    return updateAutomodSettings(guildId, { mode });
}

/** mode: 'default' (remove the override, follow the global mode) or one of RULE_MODES. */
export async function setRuleMode(guildId, ruleKey, mode) {
    requireRule(ruleKey);
    if (mode !== 'default' && !RULE_MODES.includes(mode)) throw userError('Unknown mode.');
    return updateAutomodSettings(guildId, (current) => {
        const ruleModes = { ...current.ruleModes };
        if (mode === 'default') delete ruleModes[ruleKey]; else ruleModes[ruleKey] = mode;
        return { ...current, ruleModes };
    });
}

/** mode: 'default' (remove the exception) or one of CHANNEL_RULE_MODES. */
export async function setChannelRuleMode(guildId, channelId, ruleKey, mode) {
    requireSnowflake(channelId, 'channel');
    requireRule(ruleKey);
    if (mode !== 'default' && !CHANNEL_RULE_MODES.includes(mode)) throw userError('Unknown mode.');
    return updateAutomodSettings(guildId, (current) => ({
        ...current,
        channelRules: withChannelRule(current.channelRules, channelId, ruleKey, mode),
    }));
}

/** Why a role can't be the trusted role (a user-facing sentence), or null when it can. */
export function getTrustedRoleProblem(guild, role) {
    if (!role) return 'Pick a role.';
    const guildId = guild?.id ?? role.guild?.id;
    if (role.id === guildId || role.managed) return 'Pick a normal role (not @everyone or a bot role).';
    return null;
}

/**
 * Trusted members. undefined keeps the current value; roleId null removes the role;
 * minLevel 0 removes the level criterion; clear: true removes both. Check the role
 * with getTrustedRoleProblem first (it needs the guild).
 */
export async function setTrusted(guildId, { roleId = undefined, minLevel = undefined, clear = false } = {}) {
    const keepLevel = minLevel === undefined || minLevel === null;
    if (!clear && roleId === undefined && keepLevel) {
        throw userError('Give a role, a minimum level, or clear: true.');
    }
    if (roleId !== undefined && roleId !== null) requireSnowflake(roleId, 'role');
    if (!keepLevel) {
        requireIntegerInRange(minLevel, 0, TRUSTED_MIN_LEVEL_MAX, `The minimum level must be a whole number from 0 to ${TRUSTED_MIN_LEVEL_MAX}.`);
    }
    return updateAutomodSettings(guildId, (current) => ({
        ...current,
        trusted: clear
            ? { roleId: null, minLevel: 0 }
            : {
                roleId: roleId === undefined ? current.trusted.roleId : roleId,
                minLevel: keepLevel ? current.trusted.minLevel : minLevel,
            },
    }));
}

export async function setSecondChance(guildId, enabled) {
    requireBoolean(enabled, 'Second chance');
    return updateAutomodSettings(guildId, { secondChance: enabled });
}

export async function setMoodAlerts(guildId, enabled) {
    requireBoolean(enabled, 'Mood alerts');
    return updateAutomodSettings(guildId, { moodAlerts: enabled });
}

/**
 * One join gate check: check ∈ JOIN_GATE_CHECKS, action ∈ JOIN_GATE_ACTIONS; days
 * (1–365) sets the new-account age, null keeps it.
 */
export async function setJoinGateCheck(guildId, check, action, days = null) {
    // Imported lazily: joinGate.js imports this module.
    const { JOIN_GATE_ACTIONS, JOIN_GATE_CHECKS, normalizeJoinGate } = await import('./joinGate.js');
    if (typeof check !== 'string' || !Object.hasOwn(JOIN_GATE_CHECKS, check)) throw userError('Unknown check.');
    if (!JOIN_GATE_ACTIONS.includes(action)) throw userError('Unknown action.');
    const keepDays = days === null || days === undefined;
    if (!keepDays) {
        requireIntegerInRange(days, JOIN_GATE_DAYS_MIN, JOIN_GATE_DAYS_MAX, `Days must be a whole number from ${JOIN_GATE_DAYS_MIN} to ${JOIN_GATE_DAYS_MAX}.`);
    }
    return updateAutomodSettings(guildId, (current) => {
        const gate = normalizeJoinGate(current.joinGate);
        return { ...current, joinGate: { ...gate, [check]: action, ...(keepDays ? {} : { ageDays: days }) } };
    });
}

/** Raid panic mode. hours (1–24) sets the pause length, null keeps it. */
export async function setPanic(guildId, { enabled, hours = null } = {}) {
    requireBoolean(enabled, 'Raid panic mode');
    const keepHours = hours === null || hours === undefined;
    if (!keepHours) {
        requireIntegerInRange(hours, 1, MAX_PANIC_HOURS, `Hours must be a whole number from 1 to ${MAX_PANIC_HOURS}.`);
    }
    return updateAutomodSettings(guildId, (current) => ({
        ...current,
        panic: { enabled, hours: keepHours ? current.panic.hours : hours },
    }));
}

/**
 * Adds (true), removes (false) or toggles ('toggle') a channel automod ignores,
 * decided under the lock. Resolves { settings, exempt } (exempt = the new state).
 */
export async function setExemptChannel(guildId, channelId, exempt) {
    requireSnowflake(channelId, 'channel');
    if (exempt !== true && exempt !== false && exempt !== 'toggle') throw userError('Unknown exempt value.');
    let nowExempt = false;
    const settings = await updateAutomodSettings(guildId, (current) => {
        const ids = new Set(current.exemptChannelIds);
        nowExempt = exempt === 'toggle' ? !ids.has(channelId) : exempt;
        if (nowExempt) ids.add(channelId); else ids.delete(channelId);
        return { ...current, exemptChannelIds: [...ids] };
    });
    return { settings, exempt: nowExempt };
}
