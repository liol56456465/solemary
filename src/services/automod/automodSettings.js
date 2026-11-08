// automodSettings.js — per-guild automod settings and state kept in the key-value
// store, with a short in-memory cache because messageCreate reads them constantly.
//
// Multi-server (B1): automod runs in every server, but only where it is turned on.
// Defaults depend on the server (defaultsFor):
//   main server        as before: on, staff guard on, every rule follows the global mode.
//   any other server   (the support server included, where automod never ran) off until its
//                      admins turn it on; staff guard off; the Mewvo house rules "English only"
//                      and "Non-English characters" off unless set (DEFAULT_OFF_RULES).
// A stored value always wins, so a server keeps exactly what it saved.

import { db, getFromDb, setInDb } from '../../utils/database.js';
import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { guildSetting } from '../settings/guildScoped.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { clampPanicHours, DEFAULT_PANIC_HOURS, MAX_PANIC_HOURS } from './incidentActions.js';
import {
    CHANNEL_RULE_MODES, HEADS_UP_NEVER, RULE_MODES, headsUpSettingKey, normalizeHeadsUp, withChannelRule,
} from './policy.js';

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
    // First small offence: a notice instead of a warning (/automod friendlynotice).
    secondChance: true,
    // Heads-up first: rule key (or "custom" for all custom rules) → false to turn it off;
    // missing = on. Only the rules policy.js HEADS_UP_SETTING_KEYS lists; others are dropped.
    headsUp: {},
    // Calm-down note + slowmode when a channel heats up (/automod mood).
    moodAlerts: true,
    // Raid panic mode: when a lockdown starts, also pause invites and DMs with
    // Discord's incident actions for this many hours (1–24) (/automod panic).
    panic: { enabled: true, hours: 2 },
    // Join gate: check → 'off' | 'flag' | 'kick', plus ageDays (/automod joingate;
    // normalized by joinGate.js).
    joinGate: {},
    // Invites automod never counts as advertising, besides the server's own (/automod invites):
    // invite codes or server ids (automodService.inviteAllowed).
    inviteAllowlist: [],
    // Staff guard / anti-nuke (staffGuardService.js). Main server: on (as before); others: off.
    staffGuard: true,
});

// Mewvo's own house rules: off in other servers unless they set them (they would punish any
// non-English community the moment automod is turned on).
export const DEFAULT_OFF_RULES = Object.freeze(['english', 'characters']);
export const INVITE_ALLOWLIST_MAX = 50;

/** True for the server whose automod existed before multi-server: it keeps the old defaults. */
export function isLegacyAutomodGuild(guildId) {
    return !guildId || guildId === enforcementConfig.mainGuildId;
}

/** The defaults of one server (no guild: the main server's, as before). */
export function defaultsFor(guildId = null) {
    if (isLegacyAutomodGuild(guildId)) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, enabled: false, staffGuard: false };
}

const INVITE_CODE = /^[A-Za-z0-9-]{2,32}$/;
const SNOWFLAKE_ID = /^\d{17,20}$/;

/** One allowlist entry as stored: a server id, or an invite code (from a code or invite link). Null when unusable. */
export function normalizeInviteEntry(entry) {
    const text = String(entry ?? '').trim();
    if (SNOWFLAKE_ID.test(text)) return text;
    const code = text.replace(/^(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\//i, '').replace(/[/?#].*$/, '');
    return INVITE_CODE.test(code) ? code : null;
}

/**
 * Stored settings (any shape, or null) → a complete settings object. `guildId` picks the
 * defaults (defaultsFor); without it the main server's defaults apply, as before.
 * `defaultOffRules` is derived, never stored: rules that are off unless ruleModes sets them.
 */
export function normalizeSettings(stored, guildId = null) {
    const defaults = defaultsFor(guildId);
    const value = { ...defaults, ...(stored && typeof stored === 'object' ? stored : {}) };
    value.enabled = typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled;
    value.staffGuard = typeof value.staffGuard === 'boolean' ? value.staffGuard : defaults.staffGuard;
    value.inviteAllowlist = Array.isArray(value.inviteAllowlist)
        ? [...new Set(value.inviteAllowlist.map(normalizeInviteEntry).filter(Boolean))].slice(0, INVITE_ALLOWLIST_MAX)
        : [];
    value.defaultOffRules = isLegacyAutomodGuild(guildId) ? [] : [...DEFAULT_OFF_RULES];
    value.exemptChannelIds = Array.isArray(value.exemptChannelIds) ? [...value.exemptChannelIds] : [];
    value.ruleModes = value.ruleModes && typeof value.ruleModes === 'object' ? { ...value.ruleModes } : {};
    value.channelRules = value.channelRules && typeof value.channelRules === 'object'
        ? Object.fromEntries(Object.entries(value.channelRules).map(([id, rules]) => [id, { ...rules }]))
        : {};
    const trusted = value.trusted && typeof value.trusted === 'object' ? value.trusted : {};
    value.trusted = { roleId: trusted.roleId || null, minLevel: Math.max(0, Number(trusted.minLevel) || 0) };
    value.secondChance = value.secondChance !== false;
    value.headsUp = normalizeHeadsUp(value.headsUp);
    value.moodAlerts = value.moodAlerts !== false;
    const panic = value.panic && typeof value.panic === 'object' ? value.panic : {};
    value.panic = { enabled: panic.enabled !== false, hours: clampPanicHours(panic.hours ?? DEFAULT_PANIC_HOURS) };
    value.joinGate = value.joinGate && typeof value.joinGate === 'object' ? { ...value.joinGate } : {};
    return value;
}

// One entry per server that sent a message in the last CACHE_TTL_MS; bounded for thousands of servers.
const CACHE_MAX = 5000;
const cache = new BoundedMap(CACHE_MAX);

const settingsKey = (guildId) => `automod:settings:${guildId}`;
const lockdownKey = (guildId) => `automod:lockdown:${guildId}`;

export async function getAutomodSettings(guildId) {
    const cached = cache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const stored = await getFromDb(settingsKey(guildId), null);
    const value = normalizeSettings(stored, guildId);
    cache.set(guildId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
}

/** Test hook: forget the cached settings. */
export function resetAutomodSettingsCache() {
    cache.clear();
}

/** Test hook: how many servers' settings are cached. */
export function automodSettingsCacheSize() {
    return cache.size;
}

/** Settings as stored: without the derived fields. */
function storable(settings) {
    const { defaultOffRules, ...rest } = settings || {};
    void defaultOffRules;
    return rest;
}

/**
 * Changes the settings under a row lock. `patch` is an object merged over the
 * current settings, or a function (current settings → new settings) for nested
 * changes such as one rule's mode. Resolves the saved settings or throws.
 */
export async function updateAutomodSettings(guildId, patch) {
    const saved = await db.update(settingsKey(guildId), (current) => {
        const base = normalizeSettings(current, guildId);
        return storable(typeof patch === 'function' ? patch(base) : { ...base, ...patch });
    }, null);
    const value = normalizeSettings(saved, guildId);
    cache.set(guildId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
}

/**
 * Exempt channels of a server: /automod exempt plus the server's exemptChannelIds setting
 * (home servers: the main server's AUTOMOD_EXEMPT_CHANNEL_IDS, as before; others: only their
 * own). Throws SettingsUnavailableError for another server whose settings could not be read.
 */
export function exemptChannelIdsOf(guildId, settings) {
    const configured = guildSetting(guildId, 'exemptChannelIds', automodConfig);
    return [...new Set([...(Array.isArray(configured) ? configured : []), ...(settings?.exemptChannelIds || [])])];
}

export async function isChannelExempt(guildId, channel) {
    const settings = await getAutomodSettings(guildId);
    const ids = new Set(exemptChannelIdsOf(guildId, settings));
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
    requireBoolean(enabled, 'Friendly notice for a first small offence');
    return updateAutomodSettings(guildId, { secondChance: enabled });
}

/**
 * Heads-up first for one rule (a built-in key from policy.js HEADS_UP_RULES, "custom",
 * or a "custom-<id>" key, which sets "custom"). Rules that never get a heads-up (scam,
 * NSFW, ads, mentions, spam, raids) are refused.
 */
export async function setHeadsUp(guildId, ruleKey, enabled) {
    requireBoolean(enabled, 'Warn privately first');
    const key = headsUpSettingKey(ruleKey);
    if (!key) {
        if (typeof ruleKey === 'string' && (HEADS_UP_NEVER.includes(ruleKey) || Object.hasOwn(AUTOMOD_RULES, ruleKey))) {
            throw userError('Warn privately first (2 min to fix) is not available for this rule.');
        }
        throw userError('Unknown rule.');
    }
    return updateAutomodSettings(guildId, (current) => ({ ...current, headsUp: { ...current.headsUp, [key]: enabled } }));
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

/** Staff guard / anti-nuke on or off (staffGuardService.js; off by default outside the main server). */
export async function setStaffGuard(guildId, enabled) {
    requireBoolean(enabled, 'Staff guard');
    return updateAutomodSettings(guildId, { staffGuard: enabled });
}

/**
 * The invite allowlist (/automod invites): action 'add' | 'remove' an entry (a server id,
 * an invite code or an invite link), or 'clear'. Resolves the saved settings.
 */
export async function setInviteAllowlist(guildId, action, entry = null) {
    if (!['add', 'remove', 'clear'].includes(action)) throw userError('Unknown action.');
    const value = action === 'clear' ? null : normalizeInviteEntry(entry);
    if (action !== 'clear' && !value) throw userError('Give an invite link, an invite code or a server id.');
    return updateAutomodSettings(guildId, (current) => {
        const list = new Set(current.inviteAllowlist);
        if (action === 'clear') list.clear();
        else if (action === 'remove') list.delete(value);
        else {
            if (!list.has(value) && list.size >= INVITE_ALLOWLIST_MAX) {
                throw userError(`The allowlist holds at most ${INVITE_ALLOWLIST_MAX} entries.`);
            }
            list.add(value);
        }
        return { ...current, inviteAllowlist: [...list] };
    });
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
