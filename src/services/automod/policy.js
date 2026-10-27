// policy.js — pure decisions about how automod treats a hit: the rule's mode
// (per rule, per channel), trusted members, second chances, probation, mood heat,
// self-tuning suggestions and native AutoMod dedupe. No Discord, no database:
// callers pass in the settings and state, so every decision can be unit-tested.

import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';

// ── Rule modes ────────────────────────────────────────────────────────────────
//   on       act (delete / punish) and post a review card
//   monitor  only post the card, with an Apply select
//   off      ignore the rule entirely
// A rule without an override follows the global /automod mode (enforce → on).

export const RULE_MODES = ['on', 'monitor', 'off'];
// Per-channel exceptions (/automod channel): a rule can be turned off or monitored in one channel.
export const CHANNEL_RULE_MODES = ['off', 'monitor'];

/** The mode a rule has when nothing overrides it: the global /automod mode. */
export function globalRuleMode(settings) {
    return settings?.mode === 'monitor' ? 'monitor' : 'on';
}

/** The rule's own mode: its /automod rule override, else the global mode. */
export function ruleMode(settings, ruleKey) {
    const override = settings?.ruleModes?.[ruleKey];
    return RULE_MODES.includes(override) ? override : globalRuleMode(settings);
}

/** Whether the rule's mode comes from an override rather than the global mode. */
export function hasRuleOverride(settings, ruleKey) {
    return RULE_MODES.includes(settings?.ruleModes?.[ruleKey]);
}

/**
 * Ids to look up channel exceptions for, most specific first: the channel itself,
 * its parent (a thread's channel, or a channel's category) and, for a thread, the
 * parent's category.
 */
export function channelCandidates(channel) {
    if (!channel) return [];
    const ids = [channel.id, channel.parentId, channel.parent?.parentId];
    return [...new Set(ids.filter(Boolean))];
}

/** A per-channel exception for this rule: { mode, channelId } or null. */
export function channelRuleOverride(settings, ruleKey, channel) {
    for (const id of channelCandidates(channel)) {
        const mode = settings?.channelRules?.[id]?.[ruleKey];
        if (CHANNEL_RULE_MODES.includes(mode)) return { mode, channelId: id };
    }
    return null;
}

/**
 * The effective mode of a rule in a channel. Most specific wins: a channel exception,
 * then the rule's override, then the global mode.
 */
export function resolveRuleMode(settings, ruleKey, channel = null) {
    return channelRuleOverride(settings, ruleKey, channel)?.mode || ruleMode(settings, ruleKey);
}

// ── Trusted members ───────────────────────────────────────────────────────────

/** Rules trusted members are not held to: severity at or below trustedRelaxMaxSeverity. */
export function isRelaxableRule(ruleKey, cfg = automodConfig) {
    const rule = AUTOMOD_RULES[ruleKey];
    return Boolean(rule) && rule.severity <= cfg.trustedRelaxMaxSeverity;
}

/** Whether the trusted role alone decides (no level needed). */
export function hasTrustedRole(roleIds, trusted) {
    return Boolean(trusted?.roleId && roleIds?.has?.(trusted.roleId));
}

/**
 * Trusted: has the trusted role, or a leveling level of at least trusted.minLevel
 * (when set). `level` is null when it was not read or could not be read.
 */
export function isTrustedMember({ roleIds, level = null }, trusted) {
    if (!trusted) return false;
    if (hasTrustedRole(roleIds, trusted)) return true;
    const minLevel = Number(trusted.minLevel) || 0;
    return minLevel > 0 && Number.isFinite(level) && level >= minLevel;
}

/** Whether checking trust is worth anything: a relaxable hit and some trust criterion set. */
export function trustMatters(hits, trusted, cfg = automodConfig) {
    if (!trusted?.roleId && !(Number(trusted?.minLevel) > 0)) return false;
    return hits.some((hit) => isRelaxableRule(hit.rule, cfg));
}

/** Hits left once a trusted member's relaxable hits are dropped. */
export function relaxForTrusted(hits, trusted, cfg = automodConfig) {
    return trusted ? hits.filter((hit) => !isRelaxableRule(hit.rule, cfg)) : hits;
}

/** settings.channelRules with one exception set ('off' | 'monitor') or removed ('default'). */
export function withChannelRule(channelRules, channelId, ruleKey, mode) {
    const next = { ...(channelRules || {}) };
    const forChannel = { ...(next[channelId] || {}) };
    if (CHANNEL_RULE_MODES.includes(mode)) forChannel[ruleKey] = mode; else delete forChannel[ruleKey];
    if (Object.keys(forChannel).length) next[channelId] = forChannel; else delete next[channelId];
    return next;
}
