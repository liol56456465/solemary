// customRules.js — word and phrase filters a server's staff add next to the built-in
// automod rules (a paid perk: the server OWNER's plan sets how many run, plans.js
// limits.customRules; Free 0).
//
// Stored as the setting automodCustomRules (main server, settingsRegistry.js): a list of
//   { id, name, words: [..], action: 'delete' | 'warn' | 'mute', muteDuration ('1h', mute only), enabled }
// Rules beyond the plan's limit are kept, they just don't run: the first N enabled rules run.
//
// Matching never uses staff-supplied regular expressions. Words and phrases go through the
// same obfuscation-resistant matcher as the built-in word lists (wordMatcher.js: look-alike
// letters, fancy fonts, zalgo, invisible characters, leetspeak, separators between letters,
// letters spelled out across spaces, stretched letters, common misspellings, hidden letters
// like "sc*m"). Whole words only ("ass" does not match "class"); a phrase matches when its
// words appear in a row. The built-in allow list keeps variants off ordinary words in other
// languages, but never the word as listed. Work per message is capped by the matcher.
//
// A hit goes through the normal automod pipeline (automodService.js) with rule key
// "custom-<id>": global monitor mode (card only), ignored channels, administrators and
// the cooldown all apply. warn and mute make a normal case with reason key
// "automod:custom:<id>" and the rule name as the label; delete only deletes the message
// and posts the review card.

import { randomInt } from 'node:crypto';
import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { PLANS } from '../../config/site/plans.js';
import { parseDuration } from '../enforcement/format.js';
import { planLimit } from '../billing/premiumEffects.js';
import { foldText, normalizeText } from './filters.js';
import { compileWords, matchWords } from './wordMatcher.js';

export const CUSTOM_RULE_ACTIONS = ['delete', 'warn', 'mute'];
export const CUSTOM_RULES_MAX = 100;        // the highest plan limit; the setting's schema allows this many
export const CUSTOM_RULE_NAME_MAX = 40;
export const CUSTOM_RULE_WORDS_MAX = 50;
export const CUSTOM_RULE_WORD_MAX = 60;
export const CUSTOM_RULE_MUTE_MAX_MS = 28 * 24 * 60 * 60 * 1000;
const WORD_TOKENS_MAX = 10;
const MIN_WORD_CHARS = 2;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_LENGTH = 8;

// Work caps per message.
const TEXT_MAX = 4000;

export const CUSTOM_RULE_PREFIX = 'custom-';
// Between Inappropriate language (60) and Disrespect (50): when a message breaks several
// rules the most severe decides (automodService.worstHit).
export const CUSTOM_RULE_SEVERITY = Object.freeze({ mute: 57, warn: 56, delete: 55 });

export class CustomRuleError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CustomRuleError';
        this.userMessage = message;
    }
}

const fail = (message) => { throw new CustomRuleError(message); };

export const customRuleKey = (id) => `${CUSTOM_RULE_PREFIX}${id}`;
export const isCustomRuleKey = (key) => typeof key === 'string' && key.startsWith(CUSTOM_RULE_PREFIX);
export const customRuleIdOf = (key) => (isCustomRuleKey(key) ? key.slice(CUSTOM_RULE_PREFIX.length) : null);

// ── Words ─────────────────────────────────────────────────────────────────

const splitTokens = (value) => value.split(/[^a-z0-9]+/).filter(Boolean);

/** The tokens a text is matched on: normalized like the built-in rules, split on anything but a-z and 0-9. */
export function tokensOf(text) {
    return splitTokens(normalizeText(text));
}

/** Splits the form text (one per line, or comma-separated) into words. */
export function splitWords(input) {
    if (Array.isArray(input)) return input.map((w) => String(w ?? ''));
    return String(input ?? '').split(/[\n,]/);
}

/** Checks and cleans the words of one rule; returns the stored list (trimmed, lower case, unique). */
export function cleanWords(input) {
    const out = [];
    const seen = new Set();
    for (const raw of splitWords(input)) {
        const word = String(raw).replace(/\s+/g, ' ').trim().toLowerCase();
        if (!word) continue;
        const sample = word.slice(0, 20);
        if (word.length > CUSTOM_RULE_WORD_MAX) fail(`"${sample}…" is longer than ${CUSTOM_RULE_WORD_MAX} characters.`);
        // Look-alike letters fold to A to Z; other alphabets would only half match.
        if (/[^\P{L}a-z]/u.test(foldText(word))) fail(`"${sample}" uses letters outside A to Z. Custom rules match English letters and numbers.`);
        const tokens = tokensOf(word);
        if (tokens.join('').length < MIN_WORD_CHARS) fail(`"${sample}" needs at least ${MIN_WORD_CHARS} letters (A to Z) or numbers.`);
        if (tokens.length > WORD_TOKENS_MAX) fail(`"${sample}…" has more than ${WORD_TOKENS_MAX} words. Use a shorter phrase.`);
        const key = tokens.join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(word);
    }
    if (!out.length) fail('Add at least one word or phrase.');
    if (out.length > CUSTOM_RULE_WORDS_MAX) fail(`A rule can have at most ${CUSTOM_RULE_WORDS_MAX} words or phrases (this one has ${out.length}).`);
    return out;
}

// ── Rules ─────────────────────────────────────────────────────────────────

export function newRuleId(taken = new Set()) {
    for (;;) {
        let id = '';
        for (let i = 0; i < ID_LENGTH; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
        if (!taken.has(id)) return id;
    }
}

/** A mute duration ('1h', '30m', '1d') in ms, or a CustomRuleError. */
export function muteDurationMs(value) {
    const raw = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!raw) fail('A mute rule needs a duration, like 1h.');
    const ms = parseDuration(raw);
    if (ms == null) fail(`"${raw.slice(0, 20)}" is not a duration. Use 30m, 1h or 1d.`);
    if (ms > CUSTOM_RULE_MUTE_MAX_MS) fail('A mute can be at most 28 days.');
    return ms;
}

/**
 * Checks one rule; returns it cleaned. `id` is kept when it is valid, else a new one is
 * made (avoiding `takenIds`). Throws CustomRuleError with a readable message.
 */
export function cleanCustomRule(input = {}, { takenIds = new Set() } = {}) {
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) fail('Give the rule a name.');
    if (name.length > CUSTOM_RULE_NAME_MAX) fail(`Keep the name to ${CUSTOM_RULE_NAME_MAX} characters or fewer.`);
    const action = String(input.action ?? '');
    if (!CUSTOM_RULE_ACTIONS.includes(action)) fail('Choose delete, warn or mute.');
    const words = cleanWords(input.words);
    let muteDuration = null;
    if (action === 'mute') {
        muteDurationMs(input.muteDuration);
        muteDuration = String(input.muteDuration).trim().toLowerCase().replace(/\s+/g, '');
    }
    const id = typeof input.id === 'string' && /^[a-z0-9]{4,16}$/.test(input.id) ? input.id : newRuleId(takenIds);
    return { id, name, words, action, muteDuration, enabled: input.enabled !== false };
}

/** The whole list: every rule cleaned, unique ids and names, at most CUSTOM_RULES_MAX. */
export function cleanCustomRules(list) {
    if (!Array.isArray(list)) fail('Custom rules must be a list.');
    if (list.length > CUSTOM_RULES_MAX) fail(`A server can store at most ${CUSTOM_RULES_MAX} custom rules.`);
    const ids = new Set();
    const names = new Set();
    const out = [];
    for (const input of list) {
        const rule = cleanCustomRule(input, { takenIds: ids });
        if (ids.has(rule.id)) rule.id = newRuleId(ids);
        const key = rule.name.toLowerCase();
        if (names.has(key)) fail(`There is already a custom rule called "${rule.name}".`);
        ids.add(rule.id);
        names.add(key);
        out.push(rule);
    }
    return out;
}

// ── Plan limit ────────────────────────────────────────────────────────────

/** The custom rule limit of a plan id ('free' | 'normal' | 'pro' | 'max'). */
export function limitForPlan(planId) {
    const plan = PLANS.find((p) => p.id === planId) || PLANS.find((p) => p.id === 'free');
    return plan?.limits?.customRules ?? 0;
}

/** How many custom rules run in this server: the server owner's plan. */
export function customRuleLimit(guildId) {
    return planLimit(guildId, 'customRules') ?? 0;
}

/** The rules that run: enabled ones, in list order, the first `limit`. */
export function runningRules(rules, limit) {
    const max = Math.max(0, Number(limit) || 0);
    return (Array.isArray(rules) ? rules : []).filter((rule) => rule?.enabled !== false).slice(0, max);
}

/** Ids of enabled rules that don't run because the plan's limit is lower. */
export function overLimitIds(rules, limit) {
    const running = new Set(runningRules(rules, limit).map((rule) => rule.id));
    return (Array.isArray(rules) ? rules : []).filter((rule) => rule?.enabled !== false && !running.has(rule.id)).map((rule) => rule.id);
}

// ── Rule definitions (the shape of AUTOMOD_RULES entries) ─────────────────

/** A custom rule as automod treats it: label, group, severity, deleteMessage, steps. */
export function customRuleDefinition(rule) {
    const action = CUSTOM_RULE_ACTIONS.includes(rule?.action) ? rule.action : 'delete';
    let steps = [];
    if (action === 'warn') steps = [{ type: 'warn' }];
    if (action === 'mute') {
        let durationMs = null;
        try { durationMs = muteDurationMs(rule.muteDuration); } catch { durationMs = 60 * 60 * 1000; }
        steps = [{ type: 'mute', durationMs }];
    }
    return {
        label: rule?.name || 'Custom rule',
        group: `custom:${rule?.id || 'unknown'}`,
        severity: CUSTOM_RULE_SEVERITY[action],
        deleteMessage: true,
        steps,
        custom: true,
        action,
    };
}

/** The stored rules (all of them, also those over the limit or turned off). */
export function storedCustomRules() {
    const value = automodConfig.automodCustomRules;
    return Array.isArray(value) ? value : [];
}

/**
 * Any automod rule key → its definition: a built-in rule, a custom rule (looked up in the
 * stored rules; a removed rule keeps a generic label), or null.
 */
export function ruleDefinition(key, rules = null) {
    if (Object.hasOwn(AUTOMOD_RULES, key)) return AUTOMOD_RULES[key];
    const id = customRuleIdOf(key);
    if (!id) return null;
    const rule = (rules || storedCustomRules()).find((r) => r.id === id);
    return customRuleDefinition(rule || { id, name: 'Custom rule', action: 'delete' });
}

/** "custom:<id>" (the case group) → the rule's name, or null. */
export function customGroupLabel(group, rules = null) {
    const match = /^custom:(.+)$/.exec(String(group || ''));
    if (!match) return null;
    const rule = (rules || storedCustomRules()).find((r) => r.id === match[1]);
    return rule ? rule.name : 'Custom rule (removed)';
}

// ── Matching ──────────────────────────────────────────────────────────────

/**
 * Compiles running rules into one word list for the matcher (wordMatcher.js): every word
 * and phrase of every rule, tagged with its rule's index. Compiled once per guild and cached
 * (compiledForGuild), so a message costs hash lookups, not a pass per word.
 */
export function compileRules(rules) {
    const entries = [];
    const seen = new Set();
    rules.forEach((rule, index) => {
        for (const word of rule.words || []) {
            const tokens = tokensOf(word).slice(0, WORD_TOKENS_MAX);
            if (!tokens.length) continue;
            const key = `${index}:${tokens.join(' ')}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // The matcher reads the word itself (look-alikes, leetspeak); `word` stays as stored.
            entries.push({ word, index });
        }
    });
    // allow: ordinary words the generated variants would hit ("çok" for "cock", Dutch "kunt")
    // stay out; the word exactly as the server listed it is always caught.
    return { rules, words: compileWords(entries, { allow: true }) };
}

/** Of two matched rules, the one that decides: the harsher action, else the earlier rule. */
function better(compiled, a, b) {
    if (!a) return b;
    const sa = CUSTOM_RULE_SEVERITY[compiled.rules[a.index].action] || 0;
    const sb = CUSTOM_RULE_SEVERITY[compiled.rules[b.index].action] || 0;
    if (sb !== sa) return sb > sa ? b : a;
    return b.index < a.index ? b : a;
}

/** The rule a text breaks: { rule, word } or null. Pure. */
export function matchCompiled(text, compiled) {
    if (!compiled?.rules?.length || !compiled.words) return null;
    const value = String(text || '').slice(0, TEXT_MAX);
    if (!value.trim()) return null;
    let best = null;
    for (const hit of matchWords(value, compiled.words)) best = better(compiled, best, hit.entry);
    return best ? { rule: compiled.rules[best.index], word: best.word } : null;
}

/** Convenience for tests and one-off checks: compile and match. */
export function matchCustomRules(text, rules) {
    return matchCompiled(text, compileRules(rules));
}

// Compiled rules per guild, re-read at most every CACHE_MS (a dashboard change applies
// within that time; so does a plan change).
const CACHE_MS = 15 * 1000;
const compiledCache = new Map(); // guildId → { at, compiled }

export function resetCustomRulesCache() {
    compiledCache.clear();
}

/** The compiled running rules of a guild (stored rules, cut to the owner's plan). */
export function compiledForGuild(guildId, now = Date.now()) {
    const cached = compiledCache.get(guildId);
    if (cached && now - cached.at < CACHE_MS) return cached.compiled;
    let running = [];
    try {
        running = runningRules(storedCustomRules(), customRuleLimit(guildId));
    } catch {
        running = [];
    }
    // Compiling a big list takes a moment: only redo it when the running rules changed.
    const key = JSON.stringify(running);
    let compiled = cached && cached.key === key ? cached.compiled : null;
    if (!compiled) {
        try {
            compiled = compileRules(running);
        } catch {
            // Not cached under the rules' key: the next refresh tries again.
            compiledCache.set(guildId, { at: now, key: null, compiled: compileRules([]) });
            return compiledCache.get(guildId).compiled;
        }
    }
    compiledCache.set(guildId, { at: now, key, compiled });
    return compiled;
}

/** The custom rule a message text breaks in this guild: { rule, word } or null. */
export function findCustomRuleHit(text, guildId, now = Date.now()) {
    return matchCompiled(text, compiledForGuild(guildId, now));
}

/** "Delete", "Warn", "Mute 1h". */
export function actionLabel(rule) {
    if (rule.action === 'mute') return `Mute ${rule.muteDuration}`;
    return rule.action === 'warn' ? 'Warn' : 'Delete';
}
