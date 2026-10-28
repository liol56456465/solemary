// tagMatcher.js — keyword triggers for tags: validation, compilation and
// time-boxed matching. Pure apart from the shared vm context.
//
// Word triggers are a word or phrase matched case-insensitively on word
// boundaries; their regex is built from escaped text, so it is always safe.
// Regex triggers come from admins: they are length-capped, compiled with the
// `iu` flags, rejected when they use backreferences or nest quantifiers (the
// usual catastrophic-backtracking shapes), tested against adversarial input,
// and every match runs inside a vm with a timeout so one bad pattern can never
// stall the event loop.

import vm from 'node:vm';

export const WORD_TRIGGER_MAX = 100;
export const REGEX_TRIGGER_MAX = 200;
export const MATCH_INPUT_MAX = 2000;
export const MATCH_TIMEOUT_MS = 25;

const matchContext = vm.createContext(Object.create(null));
// Returns the index of the first pattern that matches `input`, or -1.
const matchScript = new vm.Script(
    '(() => { for (let i = 0; i < patterns.length; i += 1) { if (patterns[i].test(input)) return i; } return -1; })()'
);

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A trigger error message for the admin, or null; pure. */
function nestedQuantifierProblem(pattern) {
    // Walk the pattern tracking groups; a group that contains a quantifier and is
    // itself quantified ("(a+)+", "(.*)*", "(\w+\s?){2,}") is rejected.
    const stack = [{ quantified: false }];
    let inClass = false;
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === '\\') { i += 1; continue; }
        if (inClass) { if (ch === ']') inClass = false; continue; }
        if (ch === '[') { inClass = true; continue; }
        if (ch === '(') { stack.push({ quantified: false }); continue; }
        const isQuantifier = ch === '*' || ch === '+' || (ch === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(i)));
        if (ch === ')') {
            const group = stack.length > 1 ? stack.pop() : { quantified: false };
            const next = pattern[i + 1];
            const quantifiedGroup = next === '*' || next === '+' || (next === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(i + 1)));
            if (quantifiedGroup && group.quantified) return 'nested quantifiers like (a+)+ are not allowed';
            if (group.quantified || quantifiedGroup) stack[stack.length - 1].quantified = true;
            continue;
        }
        if (isQuantifier) stack[stack.length - 1].quantified = true;
    }
    return null;
}

/** Builds the RegExp for a trigger; throws Error(message for the admin) when invalid. */
export function compileTrigger(kind, trigger) {
    const text = String(trigger ?? '').trim();
    if (kind === 'word') {
        if (!text) throw new Error('A word trigger needs a word or phrase.');
        if (text.length > WORD_TRIGGER_MAX) throw new Error(`Word triggers are limited to ${WORD_TRIGGER_MAX} characters.`);
        const body = text.split(/\s+/).map(escapeRegex).join('\\s+');
        return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu');
    }
    if (kind === 'regex') {
        if (!text) throw new Error('A regex trigger needs a pattern.');
        if (text.length > REGEX_TRIGGER_MAX) throw new Error(`Regex triggers are limited to ${REGEX_TRIGGER_MAX} characters.`);
        if (/\\[1-9]|\\k</.test(text)) throw new Error('Backreferences are not allowed in regex triggers.');
        const nested = nestedQuantifierProblem(text);
        if (nested) throw new Error(`That regex is unsafe: ${nested}.`);
        let regex;
        try {
            regex = new RegExp(text, 'iu');
        } catch (error) {
            throw new Error(`That is not a valid regex: ${error.message.replace(/^Invalid regular expression: /, '')}`);
        }
        if (regex.test('')) throw new Error('That regex matches every message.');
        for (const probe of ['a'.repeat(MATCH_INPUT_MAX), `${'a '.repeat(MATCH_INPUT_MAX / 2 - 1)}!`, `${'1'.repeat(MATCH_INPUT_MAX - 1)}x`]) {
            // Twice in a row: one timeout can be a busy host rather than a slow pattern.
            if (matchFirst([regex], probe) === null && matchFirst([regex], probe) === null) throw new Error('That regex is too slow to run on every message.');
        }
        return regex;
    }
    throw new Error('Unknown trigger kind.');
}

/**
 * Index of the first pattern matching the text (capped to MATCH_INPUT_MAX), -1 for
 * none, or null when matching ran past the timeout.
 */
export function matchFirst(patterns, text, timeout = MATCH_TIMEOUT_MS) {
    if (!patterns.length) return -1;
    matchContext.patterns = patterns;
    matchContext.input = String(text ?? '').slice(0, MATCH_INPUT_MAX);
    try {
        return matchScript.runInContext(matchContext, { timeout });
    } catch (error) {
        if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
        throw error;
    } finally {
        matchContext.patterns = null;
        matchContext.input = null;
    }
}

/** True when the tag may fire in this channel (thread: its parent counts too); pure. */
export function channelAllowed(tag, channelId, parentId = null) {
    const ids = [channelId, parentId].filter(Boolean);
    if (tag.denyChannels?.some((id) => ids.includes(id))) return false;
    if (tag.allowChannels?.length) return tag.allowChannels.some((id) => ids.includes(id));
    return true;
}

/** True while the tag is cooling down in a channel; pure. */
export function onCooldown(lastAt, now, cooldownS) {
    return Boolean(lastAt) && now - lastAt < cooldownS * 1000;
}

/** Channel IDs from "<#1> 2 #3"-style text; "none"/"-"/"" gives []; pure. */
export function parseChannelList(text) {
    const raw = String(text ?? '').trim();
    if (!raw || raw === '-' || raw.toLowerCase() === 'none') return [];
    const ids = [...raw.matchAll(/(\d{17,20})/g)].map((match) => match[1]);
    return [...new Set(ids)].slice(0, 25);
}
