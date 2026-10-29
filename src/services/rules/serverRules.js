// serverRules.js — the main server's rules: read side for the public /rules page and the
// rule line in punishment DMs, and the pure list operations the dashboard Rules page uses.
//
// Storage: two registry settings in guild_settings (settingsRegistry.js), no own table:
//   serverRules      { rules: [{ id, title, text }], updatedAt }   (order = rule number)
//   reasonRuleLinks  { <prebuilt reason key>: <rule id> }
// Reads are synchronous from the settings cache (guildSettings.js), so a DM never waits on
// the database. Writes go through the settings service (row lock + dashboard_audit rows).

import { randomBytes } from 'node:crypto';
import { getConfiguredSetting, isSettingsLoaded } from '../settings/guildSettings.js';
import { RULES_LIMITS } from '../settings/settingsRegistry.js';
import { siteOrigin } from '../site/shell.js';
import { logger } from '../../utils/logger.js';

export { RULES_LIMITS };

/** { rules: [{ id, number, title, text }], updatedAt } from a stored value (or the empty default). */
export function numberedRules(value) {
    const rules = Array.isArray(value?.rules) ? value.rules : [];
    return {
        rules: rules.map((rule, i) => ({ id: rule.id, number: i + 1, title: rule.title, text: rule.text || '' })),
        updatedAt: value?.updatedAt || null,
    };
}

/** The rules as stored now (from the settings cache). */
export function readServerRules(env = process.env) {
    return numberedRules(getConfiguredSetting('serverRules', env));
}

/** The reason → rule id links as stored now. */
export function readReasonLinks(env = process.env) {
    const links = getConfiguredSetting('reasonRuleLinks', env);
    return links && typeof links === 'object' ? { ...links } : {};
}

/**
 * For the public page: throws while the settings were never read from the database (it was
 * down at boot), so the page answers 503 instead of pretending there are no rules.
 */
export function readPublicRules(env = process.env) {
    if (!isSettingsLoaded()) throw new Error('the server settings have not been loaded from the database');
    return readServerRules(env);
}

/** The rule a prebuilt reason is linked to ({ id, number, title }), or null. */
export function ruleForReason(reasonKey, env = process.env) {
    if (!reasonKey) return null;
    const ruleId = readReasonLinks(env)[reasonKey];
    if (!ruleId) return null;
    const rule = readServerRules(env).rules.find((r) => r.id === ruleId);
    return rule ? { id: rule.id, number: rule.number, title: rule.title } : null;
}

/** `${PUBLIC_URL origin}/rules#rule-N`, or null when PUBLIC_URL is not set (no page to link). */
export function rulesPageUrl(number, env = process.env) {
    const origin = siteOrigin(env);
    return origin ? `${origin}/rules#rule-${number}` : null;
}

let lookup = ruleForReason;

/** For tests: replace the rule lookup (null puts the real one back). */
export function setRuleLookupForTests(fn) {
    lookup = fn || ruleForReason;
}

/**
 * The DM line for a case whose prebuilt reason is linked to a rule: "Rule 3: No spam" plus
 * the link when the public page exists. Never throws: a failed lookup is logged and the DM
 * goes out without the line (the punishment is never blocked or delayed by it).
 */
export function ruleLineFor(record, env = process.env) {
    try {
        const reasonKey = record?.reason_key ?? record?.reasonKey;
        if (!reasonKey) return null;
        const rule = lookup(reasonKey, env);
        if (!rule) return null;
        const title = String(rule.title).replace(/\s+/g, ' ').trim();
        const url = rulesPageUrl(rule.number, env);
        // <link> keeps Discord from adding a preview card under the DM.
        return `Rule ${rule.number}: ${title}${url ? ` — <${url}>` : ''}`;
    } catch (error) {
        logger.warn(`Rule lookup for a punishment DM failed (sent without the rule line): ${error.message}`);
        return null;
    }
}

// ── List operations (pure: return a new value, never change the old one) ──────────

/** A fresh rule id that is not in `rules`. */
export function newRuleId(rules = []) {
    const taken = new Set(rules.map((r) => r.id));
    let id;
    do { id = randomBytes(4).toString('hex'); } while (taken.has(id));
    return id;
}

const stored = (value) => (Array.isArray(value?.rules) ? value.rules.map((r) => ({ id: r.id, title: r.title, text: r.text || '' })) : []);
const stamp = (rules, now) => ({ rules, updatedAt: new Date(now).toISOString() });

export function addRule(value, { title, text }, now = Date.now()) {
    const rules = stored(value);
    if (rules.length >= RULES_LIMITS.maxRules) return null;
    return stamp([...rules, { id: newRuleId(rules), title, text }], now);
}

export function editRule(value, id, { title, text }, now = Date.now()) {
    const rules = stored(value);
    const index = rules.findIndex((r) => r.id === id);
    if (index === -1) return null;
    rules[index] = { id, title, text };
    return stamp(rules, now);
}

export function deleteRule(value, id, now = Date.now()) {
    const rules = stored(value);
    if (!rules.some((r) => r.id === id)) return null;
    return stamp(rules.filter((r) => r.id !== id), now);
}

/** Moves a rule one place up (-1) or down (+1); null when it is not there or already at that end. */
export function moveRule(value, id, step, now = Date.now()) {
    const rules = stored(value);
    const index = rules.findIndex((r) => r.id === id);
    const target = index + step;
    if (index === -1 || target < 0 || target >= rules.length) return null;
    [rules[index], rules[target]] = [rules[target], rules[index]];
    return stamp(rules, now);
}

/** The links without those pointing at rules that no longer exist. */
export function pruneLinks(links, value) {
    const ids = new Set(stored(value).map((r) => r.id));
    return Object.fromEntries(Object.entries(links || {}).filter(([, id]) => ids.has(id)));
}
