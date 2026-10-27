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

/** The effective mode of a rule. */
export function resolveRuleMode(settings, ruleKey) {
    return ruleMode(settings, ruleKey);
}
