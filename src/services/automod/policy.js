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

// ── Ladder and probation ──────────────────────────────────────────────────────

/**
 * Which step of a rule's ladder applies. `offences` = earlier automod cases in the
 * group within the repeat window. Probation moves one step up (capped at the last
 * step); forceLastStep (ad bots) always takes the last step.
 */
export function ladderIndex({ offences, stepCount, forceLastStep = false, probation = false }) {
    const last = Math.max(0, stepCount - 1);
    if (forceLastStep) return last;
    return Math.min(Math.max(0, offences) + (probation ? 1 : 0), last);
}

/** Whether a stored probation record is still running. */
export function isProbationActive(record, now = Date.now()) {
    return Boolean(record && Number(record.until) > now);
}

/**
 * Probation on rejoin: a ban that ended within `recentMs` (endedAt = when it expired
 * or was lifted/voided), no ban still active, and no probation already running.
 * `endedBan`: { endedAt } or null.
 */
export function shouldStartProbation({ endedBan, hasActiveBan, existing, now = Date.now(), recentMs = automodConfig.probationRecentBanMs }) {
    if (!endedBan || hasActiveBan || isProbationActive(existing, now)) return false;
    const endedAt = new Date(endedBan.endedAt).getTime();
    return Number.isFinite(endedAt) && endedAt <= now && now - endedAt <= recentMs;
}

// ── Second chance ─────────────────────────────────────────────────────────────

/** Whether a rule can give a second chance at all (severity, or the allowlist without a slur). */
export function isSecondChanceRule(hit, cfg = automodConfig) {
    const rule = AUTOMOD_RULES[hit?.rule];
    if (!rule) return false;
    if (rule.severity <= cfg.secondChanceMaxSeverity) return true;
    return cfg.secondChanceRules.includes(hit.rule) && !hit.slur;
}

/**
 * A notice instead of a warning: second chance is on, the rule qualifies, it is the
 * member's first offence in the rule group within the repeat window (`offences` = 0),
 * they have not had a second chance for this rule in the window, they are not on
 * probation, and the hit does not jump straight to the last step (ad bots).
 */
export function secondChanceEligible({ hit, enabled, offences, alreadyUsed, probation = false }, cfg = automodConfig) {
    if (!enabled || probation || alreadyUsed || offences > 0 || hit?.forceLastStep) return false;
    return isSecondChanceRule(hit, cfg);
}

const SECOND_CHANCE_TEXT = {
    caps: 'without all the caps',
    characters: 'without the special characters or fancy fonts',
    english: 'in English',
    language: 'without the bad language',
};

/** "<@1> Please repost without all the caps — no warning this time." */
export function secondChanceNotice(ruleKey, userId, deleted) {
    const what = SECOND_CHANCE_TEXT[ruleKey] || `without breaking the rule (${AUTOMOD_RULES[ruleKey]?.label || ruleKey})`;
    const verb = deleted ? 'repost' : 'edit your message';
    return `<@${userId}> Please ${verb} ${what}. No warning this time.`;
}

// ── Mood (channel heat) ───────────────────────────────────────────────────────

/** One message's heat: the weight of its heaviest mood signal (0 for none). */
export function messageHeat(hits, cfg = automodConfig) {
    return (hits || []).reduce((max, hit) => Math.max(max, cfg.moodWeights[hit.rule] || 0), 0);
}

/** Channel heat over the window: { score, members } from [{ at, userId, weight }]. */
export function computeHeat(events, now = Date.now(), cfg = automodConfig) {
    const recent = (events || []).filter((event) => now - event.at <= cfg.moodWindowMs);
    return {
        score: recent.reduce((sum, event) => sum + event.weight, 0),
        members: new Set(recent.map((event) => event.userId)).size,
    };
}

/** Calm-down time: hot enough, enough different people, and not within the cooldown. */
export function shouldCalmChannel({ score, members }, { lastCalmAt = 0, now = Date.now() } = {}, cfg = automodConfig) {
    if (score < cfg.moodThreshold || members < cfg.moodMinMembers) return false;
    return now - lastCalmAt >= cfg.moodCooldownMs;
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
    return `${AUTOMOD_RULES[s.rule]?.label || s.rule}: ${s.corrected} of ${s.actions} ${what} in ${days} days, switch to monitor?`;
}

/** settings.channelRules with one exception set ('off' | 'monitor') or removed ('default'). */
export function withChannelRule(channelRules, channelId, ruleKey, mode) {
    const next = { ...(channelRules || {}) };
    const forChannel = { ...(next[channelId] || {}) };
    if (CHANNEL_RULE_MODES.includes(mode)) forChannel[ruleKey] = mode; else delete forChannel[ruleKey];
    if (Object.keys(forChannel).length) next[channelId] = forChannel; else delete next[channelId];
    return next;
}

// ── Heads-up first ────────────────────────────────────────────────────────────
// For the rules below, the first hit within headsUpSeenMs (30 days) is not acted on:
// the member gets a DM (or a short channel notice) and headsUpGraceMs (2 minutes) to
// edit or delete the message (services/automod/headsUp.js).
// Settings: settings.headsUp[<key>] = boolean; a missing key means on.
// Rule keys (config/automod.js AUTOMOD_RULES):
//   allowed, default on: disrespect, harassment (insults), sexual, language (only when the
//                        hit is not a blocked word / slur), privacy (personal info: deleted
//                        at once, no warning, no case), custom-<id> (every custom rule
//                        shares one setting, key "custom")
//   never:               scam, nsfw, advertising (incl. ad bots), mentions, spam,
//                        impersonation (raids), and language hits with slur: true
//   not offered:         caps, characters, english (they already get a second chance)

export const HEADS_UP_RULES = ['disrespect', 'harassment', 'sexual', 'language', 'privacy'];
export const HEADS_UP_CUSTOM_KEY = 'custom';
export const HEADS_UP_NEVER = ['scam', 'nsfw', 'advertising', 'mentions', 'spam', 'impersonation'];
/** Keys the heads-up setting accepts (the dashboard lists these). */
export const HEADS_UP_SETTING_KEYS = [...HEADS_UP_RULES, HEADS_UP_CUSTOM_KEY];

const isCustomRuleKey = (ruleKey) => typeof ruleKey === 'string' && ruleKey.startsWith('custom-');

/** The settings key for a rule: the rule key, or "custom" for every custom rule (and "custom" itself); null when not offered. */
export function headsUpSettingKey(ruleKey) {
    if (ruleKey === HEADS_UP_CUSTOM_KEY || isCustomRuleKey(ruleKey)) return HEADS_UP_CUSTOM_KEY;
    return HEADS_UP_RULES.includes(ruleKey) ? ruleKey : null;
}

/** settings.headsUp from storage → boolean values for allowed keys only (anything else is dropped). */
export function normalizeHeadsUp(stored) {
    const out = {};
    if (!stored || typeof stored !== 'object') return out;
    for (const key of HEADS_UP_SETTING_KEYS) {
        if (typeof stored[key] === 'boolean') out[key] = stored[key];
    }
    return out;
}

/** Whether heads-up is on for a rule (missing = on; never for rules that don't offer it). */
export function headsUpEnabled(settings, ruleKey) {
    const key = headsUpSettingKey(ruleKey);
    if (!key) return false;
    return settings?.headsUp?.[key] !== false;
}

/**
 * Whether this hit gets a heads-up instead of the action (the "had one in the last 30
 * days" check comes after, in headsUp.js): the rule offers it and it is on, the hit is
 * not a slur and does not jump to the last step, and the member is not on probation.
 */
export function headsUpApplies({ hit, settings, probation = false }) {
    if (!hit || hit.slur || hit.forceLastStep || probation) return false;
    return headsUpEnabled(settings, hit.rule);
}

/**
 * A heads-up for a message only when EVERY hit allows one: a rule that never gets a
 * heads-up (scam, mentions, slurs…) next to an insult must not wait behind it.
 */
export function headsUpAllowedFor(hits, settings, probation = false) {
    return Array.isArray(hits) && hits.length > 0 && hits.every((hit) => headsUpApplies({ hit, settings, probation }));
}

const INSULT_RULES = ['disrespect', 'harassment'];
const WORDING_RULES = ['sexual', 'language'];

/** Whether two rule keys are the same kind of hit for a waiting heads-up (an insult can become harassment). */
export function sameHeadsUpFamily(a, b) {
    if (a === b) return true;
    if (INSULT_RULES.includes(a) && INSULT_RULES.includes(b)) return true;
    return WORDING_RULES.includes(a) && WORDING_RULES.includes(b);
}

/** "looked like harassment"; a custom rule: 'matched the server rule "Ads"'. */
function headsUpWhat(ruleKey, ruleLabel = null) {
    if (isCustomRuleKey(ruleKey)) return `matched the server rule "${ruleLabel || 'Custom rule'}"`;
    const label = AUTOMOD_RULES[ruleKey]?.label || ruleKey;
    return `looked like ${label.charAt(0).toLowerCase()}${label.slice(1).toLowerCase()}`;
}

const where = (channelName, serverName) => `#${channelName || 'a channel'}${serverName ? ` (${serverName})` : ''}`;

/** The DM for a heads-up. Plain wording, no emoji. */
export function headsUpDm({ ruleKey, ruleLabel = null, channelName, serverName = null, messageUrl = null, graceMinutes = 2 }) {
    return [
        `Your message in ${where(channelName, serverName)} ${headsUpWhat(ruleKey, ruleLabel)}. Edit or delete it within ${graceMinutes} minutes and nothing happens.`,
        messageUrl ? `Message: ${messageUrl}` : null,
    ].filter(Boolean).join('\n');
}

/** The channel notice when the DM could not be sent (mentions only the member). */
export function headsUpNotice({ ruleKey, ruleLabel = null, userId, graceMinutes = 2 }) {
    return `<@${userId}> Your message ${headsUpWhat(ruleKey, ruleLabel)}. Edit or delete it within ${graceMinutes} minutes and nothing happens.`;
}

/** Personal info: the message is removed at once, no warning. */
export function privacyHeadsUpDm({ channelName, serverName = null }) {
    return `Your message in ${where(channelName, serverName)} was removed because it looked like personal information. No warning this time.`;
}

export function privacyHeadsUpNotice(userId) {
    return `<@${userId}> Your message was removed because it looked like personal information. No warning this time.`;
}
