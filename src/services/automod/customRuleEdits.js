// customRuleEdits.js: the list changes behind /automod custom (and the dashboard's word
// editing). Each function takes the stored list and returns the new list, cleaned, or throws
// CustomRuleError with a message staff can read. Saving is the caller's job.

import { CustomRuleError, cleanCustomRules } from './customRules.js';

const fail = (message) => { throw new CustomRuleError(message); };
const planText = (planName) => planName || 'current';

/** The rule with this name (any case) or id, or null. */
export function findRule(list, nameOrId) {
    const key = String(nameOrId ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key) return null;
    return (list || []).find((rule) => rule.id === key || rule.name.toLowerCase() === key) || null;
}

function mustFind(list, nameOrId) {
    const rule = findRule(list, nameOrId);
    if (!rule) fail(`There is no custom rule called "${String(nameOrId ?? '').slice(0, 40)}". See them with /automod custom list.`);
    return rule;
}

/** Adds a rule at the end. `limit` is the plan's custom rule limit. */
export function addRule(list, { name, words, action, muteDuration }, { limit, planName } = {}) {
    const rules = Array.isArray(list) ? list : [];
    if (rules.length >= limit) {
        fail(limit
            ? `This server already has ${rules.length} custom rules, the most the ${planText(planName)} plan allows. Remove one first.`
            : 'Custom rules are part of the Normal, Pro and Max plans, on the server owner\'s plan.');
    }
    return cleanCustomRules([...rules, { name, words, action, muteDuration, enabled: true }]);
}

/** Removes a rule. Returns { list, rule }. */
export function removeRule(list, nameOrId) {
    const rule = mustFind(list, nameOrId);
    return { list: cleanCustomRules(list.filter((r) => r.id !== rule.id)), rule };
}

/** Replaces a rule's words (and optionally its action). Returns { list, rule } with the new rule. */
export function editRule(list, nameOrId, { words, action, muteDuration } = {}) {
    const rule = mustFind(list, nameOrId);
    const next = list.map((r) => {
        if (r.id !== rule.id) return r;
        const out = { ...r };
        if (words !== undefined && words !== null) out.words = words;
        if (action) {
            out.action = action;
            out.muteDuration = action === 'mute' ? (muteDuration || r.muteDuration) : null;
        } else if (muteDuration && r.action === 'mute') {
            out.muteDuration = muteDuration;
        }
        return out;
    });
    const clean = cleanCustomRules(next);
    return { list: clean, rule: clean.find((r) => r.id === rule.id) };
}

/** Turns a rule on or off. Returns { list, rule, changed }. */
export function toggleRule(list, nameOrId, enabled) {
    const rule = mustFind(list, nameOrId);
    if ((rule.enabled !== false) === enabled) return { list, rule, changed: false };
    const clean = cleanCustomRules(list.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
    return { list: clean, rule: clean.find((r) => r.id === rule.id), changed: true };
}
