// Every literal t('ns.key', { … }) / t('ns.key') / tp('ns.key', n, { … }) call in src/ passes
// every {placeholder} of that key's English text: t() throws "missing param" at runtime otherwise
// (services/site/i18n.js), which a test of the happy path may never reach.
//
// Scope: calls whose key is a string literal and whose params are absent or an inline object
// literal without spreads or computed keys. Skipped (counted, not failed): params passed as a
// variable or with a spread (`{ ...p }`), and keys that exist in more than one catalog (bot,
// dashboard, site) with different placeholders, where the call site can't tell which one it is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_CATALOG } from '../src/utils/botText.js';
import { DASHBOARD_CATALOG, catalogText as siteText, hasKey as siteHas, placeholdersOf } from '../src/services/site/i18n.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function jsFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) jsFiles(path, out);
        else if (name.endsWith('.js')) out.push(path);
    }
    return out;
}

const CATALOGS = [
    { name: 'bot', has: (k) => BOT_CATALOG.hasKey('en', k), text: (k) => BOT_CATALOG.catalogText('en', k) },
    { name: 'dashboard', has: (k) => DASHBOARD_CATALOG.hasKey('en', k), text: (k) => DASHBOARD_CATALOG.catalogText('en', k) },
    { name: 'site', has: (k) => siteHas('en', k), text: (k) => siteText('en', k) },
];

/** Placeholder lists of `key` in each catalog that has it (plural: key.other, without {count}). */
function placeholderSets(key, plural) {
    const sets = new Map();
    const k = plural ? `${key}.other` : key;
    for (const c of CATALOGS) {
        try {
            if (!c.has(k)) continue;
            const names = placeholdersOf(c.text(k)).filter((n) => !(plural && n === 'count'));
            sets.set(c.name, [...new Set(names)].sort());
        } catch {
            // not a leaf in this catalog
        }
    }
    return sets;
}

const QUOTES = new Set(['\'', '"', '`']);
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
// After one of these, a `/` starts a regex literal (after a value it divides).
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** When text[i] opens a string, template or regex literal: the index of its last character; else -1. */
function literalEnd(text, i) {
    const ch = text[i];
    if (QUOTES.has(ch)) {
        for (let j = i + 1; j < text.length; j += 1) {
            if (text[j] === '\\') j += 1;
            else if (ch === '`' && text[j] === '$' && text[j + 1] === '{') j = matchBracket(text, j + 1) - 1;
            else if (text[j] === ch) return j;
        }
        return text.length - 1;
    }
    if (ch === '/' && text[i + 1] !== '/' && text[i + 1] !== '*') {
        let k = i - 1;
        while (k >= 0 && /\s/.test(text[k])) k -= 1;
        if (k >= 0 && !BEFORE_REGEX.has(text[k])) return -1;
        let inClass = false;
        for (let j = i + 1; j < text.length; j += 1) {
            const c = text[j];
            if (c === '\\') j += 1;
            else if (c === '[') inClass = true;
            else if (c === ']') inClass = false;
            else if (c === '/' && !inClass) return j;
            else if (c === '\n') return -1;
        }
    }
    return -1;
}

/** From the index of an opening bracket, the index just past its match (literals skipped). */
function matchBracket(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
        const lit = literalEnd(text, i);
        if (lit >= 0) { i = lit; continue; }
        if (OPENERS.has(text[i])) depth += 1;
        else if (CLOSERS.has(text[i])) {
            depth -= 1;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

/** The pieces of `text` split at top-level commas. */
function topLevelParts(text) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
        const lit = literalEnd(text, i);
        if (lit >= 0) { i = lit; continue; }
        if (OPENERS.has(text[i])) depth += 1;
        else if (CLOSERS.has(text[i])) depth -= 1;
        else if (text[i] === ',' && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim()).filter(Boolean);
}

/** Top-level property names of an object literal's source, or null when it has a spread / computed key. */
function objectKeys(body) {
    const keys = [];
    for (const raw of topLevelParts(body.slice(1, -1))) {
        if (raw.startsWith('...') || raw.startsWith('[')) return null;
        const m = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(?::|\(|$)/.exec(raw);
        if (!m) return null;
        keys.push(m[1] || m[2] || m[3]);
    }
    return keys;
}

/** The arguments after the key of the call whose `(` is at `open`, as source text (null when unparsable). */
function argumentsAfterKey(text, open) {
    const end = matchBracket(text, open);
    if (end < 0) return null;
    return topLevelParts(text.slice(open + 1, end - 1)).slice(1);
}

// `.t('key'` / ` t('key'` / `.tp('key'`: the function and the key literal.
const CALL = /(?:^|[^\w$])(t|tp)(\()\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'\s*[,)]/g;

test('literal t()/tp() calls pass every placeholder of their key', (t) => {
    const problems = [];
    const stats = { checked: 0, variableParams: 0, ambiguous: 0, unknownKey: 0 };
    for (const file of jsFiles(SRC)) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(CALL)) {
            const [whole, fn, , key] = m;
            const plural = fn === 'tp';
            const sets = placeholderSets(key, plural);
            if (!sets.size) { stats.unknownKey += 1; continue; }
            if (new Set([...sets.values()].map((s) => s.join(','))).size > 1) { stats.ambiguous += 1; continue; }
            const want = [...sets.values()][0];

            const args = argumentsAfterKey(text, m.index + whole.indexOf(`${fn}(`) + fn.length);
            if (!args) { stats.variableParams += 1; continue; }
            const paramSource = plural ? args[1] : args[0]; // tp(key, count, params?)
            let given = [];
            if (paramSource !== undefined) {
                given = paramSource.startsWith('{') ? objectKeys(paramSource) : null;
                if (!given) { stats.variableParams += 1; continue; }
            }
            stats.checked += 1;
            const missing = want.filter((name) => !given.includes(name));
            if (missing.length) {
                const line = text.slice(0, m.index).split('\n').length;
                problems.push(`${file.slice(SRC.length)}:${line} ${fn}('${key}') misses {${missing.join('}, {')}}`);
            }
        }
    }
    t.diagnostic(`checked ${stats.checked}; skipped ${JSON.stringify(stats)}`);
    assert.ok(stats.checked > 500, `checked ${stats.checked} calls (skipped: ${JSON.stringify(stats)})`);
    assert.deepEqual(problems, []);
});
