// obfuscations.js — the automod bypass suite: for a word, the disguised ways members
// write it to get past a filter. Deterministic (no randomness), so the catch rate is the
// same on every run. Used by tests/automod/wordMatcher.test.js and the before/after
// measurement in the report.

const LEET = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };
const LEET_SYMBOLS = { a: '@', s: '$', i: '!' };
const CYRILLIC = { a: 'а', e: 'е', o: 'о', c: 'с', p: 'р', x: 'х', y: 'у', i: 'і', k: 'к' };
const GREEK = { o: 'ο', a: 'α', i: 'ι', k: 'κ', u: 'υ', t: 'τ', v: 'ν', e: 'ε', n: 'η' };
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

const mapChars = (word, table) => [...word].map((c) => table[c] || c).join('');
const changed = (form, word) => (form !== word ? form : null);
const fullWidth = (word) => [...word].map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(c.codePointAt(0) - 97 + 0xFF41) : c)).join('');
const mathBold = (word) => [...word].map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(c.codePointAt(0) - 97 + 0x1D41A) : c)).join('');
const between = (word, sep) => [...word].join(sep);

function consonantCount(word) {
    return [...word].filter((c) => /[a-z]/.test(c) && !VOWELS.has(c)).length;
}

/** The forms of one word: { kind, text }. Kinds that don't apply to the word are left out. */
export function obfuscationsOf(word) {
    const w = word.toLowerCase();
    const forms = [];
    const add = (kind, text) => { if (text) forms.push({ kind, text }); };
    const firstVowel = [...w].findIndex((c, i) => i > 0 && VOWELS.has(c));

    add('mixed case', [...w].map((c, i) => (i % 2 ? c : c.toUpperCase())).join(''));
    add('all caps', w.toUpperCase());
    add('leet digits', changed(mapChars(w, LEET), w));
    add('leet symbols', changed(mapChars(w, LEET_SYMBOLS), w));
    add('cyrillic look-alikes', changed(mapChars(w, CYRILLIC), w));
    add('greek look-alikes', changed(mapChars(w, GREEK), w));
    add('full width', fullWidth(w));
    add('math bold', mathBold(w));
    add('dots', between(w, '.'));
    add('hyphens', between(w, '-'));
    add('underscores', between(w, '_'));
    add('spaced letters', between(w, ' '));
    add('zero-width spaces', between(w, '​'));
    add('emoji between letters', between(w, '🔥'));
    add('repeated letters', firstVowel > 0 ? `${w.slice(0, firstVowel)}${w[firstVowel].repeat(5)}${w.slice(firstVowel + 1)}` : `${w}${w[w.length - 1].repeat(4)}`);
    add('vowel as *', firstVowel > 0 ? `${w.slice(0, firstVowel)}*${w.slice(firstVowel + 1)}` : null);
    if (w.length >= 4 && consonantCount(w) >= 3) {
        add('vowels dropped', changed(w[0] + [...w.slice(1)].filter((c) => !VOWELS.has(c)).join(''), w));
    }
    let cluster = null;
    if (w.includes('ck')) cluster = w.replace('ck', 'k');
    else if (w.length >= 4 && /c(?![hk])/.test(w)) cluster = w.replace(/c(?![hk])/, 'k');
    else if (w.includes('x')) cluster = w.replace('x', 'ks');
    add('c/k swapped', cluster);
    if (w.includes('ck')) add('ck as q', w.replace('ck', 'q'));
    add('accents', [...w].map((c) => (VOWELS.has(c) ? `${c}́` : c)).join(''));
    add('in a sentence', `lol you ${w} haha`);
    add('split in two', w.length >= 4 ? `${w.slice(0, Math.ceil(w.length / 2))} ${w.slice(Math.ceil(w.length / 2))}` : null);
    add('leet with dots', between(mapChars(w, LEET), '.'));
    add('cyrillic and emoji', between(mapChars(w, CYRILLIC), '✨'));
    add('trailing punctuation', `${w.toUpperCase()}!!!`);
    return forms;
}

/** The forms of a phrase ("fuck you"): fewer, the words keep their space. */
export function phraseObfuscationsOf(phrase) {
    const p = phrase.toLowerCase();
    const forms = [];
    const add = (kind, text) => forms.push({ kind, text });
    add('mixed case', p.toUpperCase());
    add('leet digits', mapChars(p, LEET));
    add('cyrillic look-alikes', mapChars(p, CYRILLIC));
    add('full width', fullWidth(p));
    add('no space', p.replace(/\s+/g, ''));
    add('extra spaces', p.replace(/\s+/g, '   '));
    add('dots for spaces', p.replace(/\s+/g, '.'));
    add('zero-width spaces', [...p].join('​'));
    add('repeated letters', p.replace(/([aeiou])/, '$1$1$1$1'));
    add('in a sentence', `omg ${p} lol`);
    return forms;
}

// The built-in word lists in the suite (canonical words as the matcher returns them).
export const SUITE = {
    blocked: ['nigger', 'nigga', 'faggot', 'fag', 'retard', 'tranny', 'chink', 'spic', 'kike', 'wetback', 'coon', 'gook', 'dyke', 'kys', 'cunt', 'whore', 'slut'],
    insult: ['idiot', 'stupid', 'dumb', 'dumbass', 'loser', 'ugly', 'trash', 'pathetic', 'moron', 'clown', 'braindead', 'bitch', 'bastard', 'asshole', 'dickhead', 'worthless', 'cringe'],
    sexual: ['sex', 'sexy', 'nude', 'nudes', 'horny', 'dick', 'cock', 'pussy', 'boobs', 'tits', 'porn', 'onlyfans', 'blowjob', 'cum', 'naked', 'rape'],
    swearing: ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'damn', 'crap', 'piss', 'wanker', 'twat', 'bollocks', 'motherfucker', 'bullshit', 'ass', 'arse'],
};
export const SUITE_PHRASES = {
    blocked: ['kill yourself'],
    insult: ['fuck you', 'fuck off', 'shut up'],
};
// Words a server might put in a custom rule.
export const CUSTOM_SUITE = ['fuck', 'scam', 'nitro', 'shit'];
export const CUSTOM_PHRASE_SUITE = ['free nitro', 'buy followers'];
