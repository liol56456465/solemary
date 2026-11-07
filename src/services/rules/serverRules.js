// serverRules.js — the main server's rules: read side for the public /rules page and the
// rule line in punishment DMs, and the pure list operations the dashboard Rules page uses.
//
// Storage: two registry settings in guild_settings (settingsRegistry.js), no own table:
//   serverRules      { rules: [{ id, title, text, consequence?, preset? }], updatedAt }   (order = rule number)
//   rulesPost        how the rules are posted in Discord (services/rules/rulesPost.js)
//   reasonRuleLinks  { <prebuilt reason key>: <rule id> }
// Reads are synchronous from the settings cache (guildSettings.js), so a DM never waits on
// the database. Writes go through the settings service (row lock + dashboard_audit rows).

import { randomBytes } from 'node:crypto';
import { getConfiguredSetting, isHomeGuild, isSettingsLoaded, resolveSetting } from '../settings/guildSettings.js';
import { RULES_LIMITS } from '../settings/settingsRegistry.js';
import { siteOrigin } from '../site/shell.js';
import { logger } from '../../utils/logger.js';

export { RULES_LIMITS };

/** { rules: [{ id, number, title, text, consequence, preset }], updatedAt } from a stored value (or the empty default). */
export function numberedRules(value) {
    const rules = Array.isArray(value?.rules) ? value.rules : [];
    return {
        rules: rules.map((rule, i) => ({
            id: rule.id, number: i + 1, title: rule.title, text: rule.text || '', consequence: rule.consequence || '', preset: rule.preset || null,
        })),
        updatedAt: value?.updatedAt || null,
    };
}

/**
 * A rules setting of a server. No server named, or one of Mewvo's own: the main server's value,
 * exactly as before (the public /rules page, the home DMs). Any other server: only what it stored
 * (resolveSetting; empty rules / no links by default), and SettingsUnavailableError when its
 * settings could not be read.
 */
function rulesSetting(key, guildId, env) {
    if (!guildId || isHomeGuild(guildId, env)) return getConfiguredSetting(key, env);
    return resolveSetting(guildId, key, env);
}

/** The rules as stored now (from the settings cache), of `guildId` (default: the main server). */
export function readServerRules(env = process.env, guildId = null) {
    return numberedRules(rulesSetting('serverRules', guildId, env));
}

/** The reason → rule id links as stored now, of `guildId` (default: the main server). */
export function readReasonLinks(env = process.env, guildId = null) {
    const links = rulesSetting('reasonRuleLinks', guildId, env);
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

/** The rule a prebuilt reason is linked to in `guildId` (default: the main server) ({ id, number, title }), or null. */
export function ruleForReason(reasonKey, env = process.env, guildId = null) {
    if (!reasonKey) return null;
    const ruleId = readReasonLinks(env, guildId)[reasonKey];
    if (!ruleId) return null;
    const rule = readServerRules(env, guildId).rules.find((r) => r.id === ruleId);
    return rule ? { id: rule.id, number: rule.number, title: rule.title, consequence: rule.consequence } : null;
}

/**
 * The confirm-step hint for a prebuilt reason linked to a rule: "Rule 2: No swearing.
 * Listed consequence: 1-hour mute." (or without the second part). Null when the reason is
 * not linked. Never throws: a hint must not block a punishment.
 */
export function ruleHintFor(reasonKey, env = process.env, guildId = null) {
    try {
        const rule = lookup(reasonKey, env, guildId);
        if (!rule) return null;
        const title = String(rule.title).replace(/\s+/g, ' ').trim();
        return `Rule ${rule.number}: ${title}.${rule.consequence ? ` Listed consequence: ${rule.consequence}.` : ''}`;
    } catch (error) {
        logger.warn(`Rule lookup for the confirm hint failed: ${error.message}`);
        return null;
    }
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
 * `word`: "Rule" in the DM's language (dmTemplates passes the bot catalog's word).
 * The rule comes from the case's server (`record.guild_id`; none: the main server). The /rules page
 * shows the main server's rules, so only a home server's line links to it.
 */
export function ruleLineFor(record, env = process.env, { word = 'Rule' } = {}) {
    try {
        const reasonKey = record?.reason_key ?? record?.reasonKey;
        if (!reasonKey) return null;
        const guildId = record?.guild_id ?? record?.guildId ?? null;
        const rule = lookup(reasonKey, env, guildId);
        if (!rule) return null;
        const title = String(rule.title).replace(/\s+/g, ' ').trim();
        const url = !guildId || isHomeGuild(guildId, env) ? rulesPageUrl(rule.number, env) : null;
        // <link> keeps Discord from adding a preview card under the DM.
        return `${word} ${rule.number}: ${title}${url ? `, <${url}>` : ''}`;
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

/** A rule as stored: empty consequence and no preset are left out (the schema has them optional). */
function storedRule({ id, title, text, consequence, preset }) {
    return { id, title, text: text || '', ...(consequence ? { consequence } : {}), ...(preset ? { preset } : {}) };
}
const stored = (value) => (Array.isArray(value?.rules) ? value.rules.map(storedRule) : []);
const stamp = (rules, now) => ({ rules, updatedAt: new Date(now).toISOString() });

export function addRule(value, { title, text, consequence = '', preset = null }, now = Date.now()) {
    const rules = stored(value);
    if (rules.length >= RULES_LIMITS.maxRules) return null;
    return stamp([...rules, storedRule({ id: newRuleId(rules), title, text, consequence, preset })], now);
}

/** Changes title, text and consequence; a library rule keeps its preset key. */
export function editRule(value, id, { title, text, consequence = '' }, now = Date.now()) {
    const rules = stored(value);
    const index = rules.findIndex((r) => r.id === id);
    if (index === -1) return null;
    rules[index] = storedRule({ id, title, text, consequence, preset: rules[index].preset });
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
