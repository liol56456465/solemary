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

// ── Self-tuning ───────────────────────────────────────────────────────────────

/**
 * The rule an automod case belongs to. Cases carry reason_key "automod:<group>" and
 * reason "Automod: <rule label>…" (a changed decision appends " (changed by …)").
 * A group with one rule needs no label; otherwise the longest matching label wins.
 * Null for member reports, native AutoMod and anything unrecognised.
 */
export function ruleForCase(reasonKey, reason) {
    const group = String(reasonKey || '').startsWith('automod:') ? reasonKey.slice('automod:'.length) : null;
    if (!group) return null;
    const candidates = Object.entries(AUTOMOD_RULES).filter(([, rule]) => rule.group === group);
    if (candidates.length === 1) return candidates[0][0];
    const text = String(reason || '');
    const matches = candidates.filter(([, rule]) => text.startsWith(`Automod: ${rule.label}`));
    if (!matches.length) return null;
    return matches.sort(([, a], [, b]) => b.label.length - a.label.length)[0][0];
}

/** Case-log rows [{ reasonKey, reason, actions, undone, changed }] → rule → totals. */
export function aggregateRuleStats(rows) {
    const byRule = {};
    for (const row of rows || []) {
        const rule = ruleForCase(row.reasonKey, row.reason);
        if (!rule) continue;
        const totals = byRule[rule] || (byRule[rule] = { actions: 0, undone: 0, changed: 0 });
        totals.actions += Number(row.actions) || 0;
        totals.undone += Number(row.undone) || 0;
        totals.changed += Number(row.changed) || 0;
    }
    return byRule;
}

/**
 * Rules worth a "switch to monitor?" suggestion: enforced (mode on), at least
 * tuningMinActions actions, undone or changed at least tuningUndoRate of the time, and
 * not suggested within tuningCooldownMs. Worst rate first.
 */
export function tuningSuggestions(byRule, { settings, lastSuggested = {}, now = Date.now(), cfg = automodConfig } = {}) {
    const out = [];
    for (const [rule, totals] of Object.entries(byRule || {})) {
        if (!AUTOMOD_RULES[rule] || ruleMode(settings, rule) !== 'on') continue;
        const corrected = totals.undone + totals.changed;
        if (totals.actions < cfg.tuningMinActions || corrected / totals.actions < cfg.tuningUndoRate) continue;
        const last = Number(lastSuggested?.[rule]) || 0;
        if (now - last < cfg.tuningCooldownMs) continue;
        out.push({ rule, ...totals, corrected, rate: corrected / totals.actions });
    }
    return out.sort((a, b) => b.rate - a.rate);
}

/** "Excessive caps: 9 of 20 undone in 14 days — switch to monitor?" */
export function formatTuningSuggestion(s, days = automodConfig.tuningWindowDays) {
    const what = s.changed ? (s.undone ? 'undone or changed' : 'changed') : 'undone';
    return `${AUTOMOD_RULES[s.rule]?.label || s.rule}: ${s.corrected} of ${s.actions} ${what} in ${days} days — switch to monitor?`;
}

/** settings.channelRules with one exception set ('off' | 'monitor') or removed ('default'). */
export function withChannelRule(channelRules, channelId, ruleKey, mode) {
    const next = { ...(channelRules || {}) };
    const forChannel = { ...(next[channelId] || {}) };
    if (CHANNEL_RULE_MODES.includes(mode)) forChannel[ruleKey] = mode; else delete forChannel[ruleKey];
    if (Object.keys(forChannel).length) next[channelId] = forChannel; else delete next[channelId];
    return next;
}
