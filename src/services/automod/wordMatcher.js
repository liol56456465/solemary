// wordMatcher.js — the deterministic, obfuscation-resistant word matcher behind the
// built-in word lists (filters.js: blocked words, insults, sexual words, swearing) and the
// servers' custom word rules (customRules.js). No AI, no network, no edit distance.
//
// How a message is read (analyze):
//   1. Folded to plain lower-case letters (textFold.js: fancy fonts, look-alike Cyrillic /
//      Greek / Armenian letters, accents, zalgo, invisible characters), keeping for every
//      folded character its place in the original text, so a match can be masked there.
//   2. Split into words (whitespace and apostrophes: "who're" stays two words) and each word
//      into pieces (punctuation, symbols and emoji between letters). A word is checked as a
//      whole with the separators dropped ("f.u.c.k", "f🔥u🔥c🔥k", "f-u-c-k") and piece by
//      piece ("hello,fuck"). Leetspeak is read as letters (0 o, 1 i or l, 3 e, 4 a, 5 s,
//      7 t, 8 b, 9 g, @ a, $ s, ! i, | i or l, + t, ( c); * # % _ stand for one hidden letter,
//      and are also read as plain separators when they sit between every letter ("f_u_c_k").
//   3. Repeated letters: a doubled consonant counts once (fukk, shitt), a vowel stretched to
//      three or more counts once or twice (fuuuuck, booooobs). A real double vowel stays:
//      "cook" is never read as "cok".
//   4. Words spelled out across spaces are joined: single letters ("f u c k", any run of
//      them) and short fragments ("fu ck", "ni gg er") as long as no fragment is a common
//      short word ("sh it" stays two words, so do "go ok" and "who re").
//
// How a list word becomes keys (compile), all generated, nothing hand-listed per word:
//   - Words of 4+ letters get variants: ck → k / c / q, c ↔ k, q → k, f ↔ ph, x → ks / cks,
//     i → y, u → v, s → z, y → i, and a single vowel doubled. Short words (3 letters or
//     fewer) only get look-alikes and repeats: their variants are ordinary words too often.
//   - All vowels dropped ("fck", "sht", "nggr") counts for 4+ letter words with at least 3
//     consonants, and only when the token has no vowel left at all: dropping SOME vowels or
//     swapping them ("fack", "fake") would hit ordinary words, so it does not count.
//   - A hidden letter (* # % _) matches one letter at its place ("f*ck", "s**t", "f*g"),
//     when the first letter and at least half the letters are real.
//   - Suffixes are per word (fucking, shitty, bitches; never "spicy" for "spic").
//   - A few distinctive words also match inside longer words ("motherfucker", "fuckwit"):
//     the `inside` flag, plain spelling only.
//   - Phrases ("fuck you", "kill yourself") match word by word, with "you" also as u / yu /
//     ya, and written together ("fuckyou").
// Matching is hash lookups per token, so it costs the same for 10 words or 5000.
//
// False positives: lists marked `allow: true` (the built-in lists) skip tokens on the
// ALLOW list and phrases on ALLOW_CONTEXT below, real words in English and other languages
// that the variants would otherwise hit. tests/automod/wordMatcher.test.js checks the
// built-in lists against a corpus of ordinary words and the repository's own text.

import { foldIndexed } from './textFold.js';

const MAX_TEXT = 4000;
const MAX_WINDOW_UNITS = 12;
const MAX_WINDOW_LETTERS = 20;
const MAX_WINDOW_CHECKS = 400;
const MAX_VARIANTS = 64;
const MAX_KEYS_PER_WORD = 160;
const SHORT_WORD = 3;
const MEMO_MAX = 20000; // remembered readings / lookups per table, then cleared
const MEMO_KEY_MAX = 64; // longer tokens (links, pasted junk) are rare repeats: not remembered

const LEET = {
    0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', 6: 'g',
    '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '(': 'c', '<': 'c', '€': 'e', '¢': 'c', '©': 'c', '®': 'r',
};
const LEET_L = { 1: 'l', '|': 'l' };
const WILD = new Set(['*', '#', '%', '_']);
const HARD = new Set(["'", '’', '‘', '`', '´', 'ʼ']);
const isVowel = (c) => c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u';
const isLetter = (c) => c >= 'a' && c <= 'z';
const isDigit = (c) => c >= '0' && c <= '9';
const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || /\s/.test(c);

// Common short words: a fragment that is one of these is never joined with its neighbour
// ("sh it", "go ok", "who re", "co on"). Single letters are always joinable. "gg" is not on
// the list: "ni gg er" must join, and "gg" next to other fragments ("gg ez") makes no listed word.
const STOP = new Set(`a i o u am an as at be by do go he hi if in is it me my no of oh ok on or so to up us we ya ye yo
all and any are bad big but can cat day did dog eat end far few for fun get got had has her hey him his how its
let lol lot man may new nor not now off old one our out own put ran red run sad saw say see she sit six sky
ten the too top try two use via was way who why yes yet you omg idk wtf btw brb ily irl ez xd re ah eh hm um
mm uh oi ha he ho no nah yep yup wow cya bye pls plz thx ty np lmao`.split(/\s+/));

// Real words (English and other languages) that a variant of a built-in word would hit.
// Compared with the token as written (look-alikes folded, leetspeak read); a stretched token
// ("kysssss") is never allowed.
// A trailing * means "starts with".
export const ALLOW = [
    'niger', 'nigers', // the country (and "niger" in Latin): nigger with one g
    'snigger*', 'niggard*', // snigger, sniggering, niggardly: they contain the slur's letters
    'dike', 'dikes', // embankment: dyke with i
    'kunt', // Dutch "kunt" (you can): cunt with k
    'dik', 'dic', // Dutch/Afrikaans "dik" (thick), "dic." (Spanish/Portuguese December)
    'kok', 'cok', 'coq', 'koks', // Dutch/Indonesian kok, Turkish çok, French coq: cock variants
    'cocker', 'cockers', 'cocked', 'cocking', 'cocky', 'dicker', 'dickers', // real words with a suffix
    'spick', // "spick and span"
    'pis', 'pss', 'psss', // Polish PiS, French pis, "pss" (psst): piss variants
    'cnt', 'tts', 'bbs', // count (code), text-to-speech, bulletin boards: vowel-less variants
    'krap', // Dutch "krap" (tight)
    'kyss', // Scandinavian "kyss" (kiss): kys + s
    'trani', // Trani, Italian city: tranny with i
    'fagot', 'fagots', // archaic bundle of sticks; also Polish/Czech "fagot" (bassoon)
    'looser', // loose + er: loser with a doubled vowel
];
// Phrases where a listed word is ordinary: the hit is dropped when it lies inside one.
export const ALLOW_CONTEXT = [
    /maine[\s-]*coons?\b/g, // the cat breed
    /\b(?:magna|summa)?\s*cum\s+laude\b/g,
    /\bspic?k?[\s-]+(?:and|n|&)[\s-]+span\b/g,
];

const allowExact = new Set(ALLOW.filter((w) => !w.endsWith('*')));
const allowPrefix = ALLOW.filter((w) => w.endsWith('*')).map((w) => w.slice(0, -1));

function isAllowedToken(plain) {
    if (allowExact.has(plain)) return true;
    return allowPrefix.some((prefix) => plain.startsWith(prefix));
}

// ── Forms ─────────────────────────────────────────────────────────────────

/** Runs capped at two: "fuuuuck" → "fuuck". */
export function cap2(value) {
    let out = '';
    let run = 0;
    for (let i = 0; i < value.length; i += 1) {
        run = i && value[i] === value[i - 1] ? run + 1 : 1;
        if (run <= 2) out += value[i];
    }
    return out;
}

/**
 * The matching forms of a decoded token: [b, a, c].
 *   b: consonant runs → one letter, vowel runs of 3+ → two (the key form of list words)
 *   a: the same, but vowel runs of 3+ → one ("fuuuuck" → "fuck")
 *   c: every run capped at two (the key form of short list words)
 */
function formsOf(value) {
    let b = '';
    let a = '';
    let c = '';
    let i = 0;
    while (i < value.length) {
        const ch = value[i];
        let n = 1;
        while (i + n < value.length && value[i + n] === ch) n += 1;
        c += n >= 2 ? ch + ch : ch;
        if (isVowel(ch)) {
            b += n >= 3 ? ch + ch : ch.repeat(n);
            a += n >= 3 ? ch : ch.repeat(n);
        } else if (ch === '*') {
            b += ch.repeat(n);
            a += ch.repeat(n);
        } else {
            b += ch;
            a += ch;
        }
        i += n;
    }
    return a === b ? (c === b ? [b] : [b, c]) : (c === b || c === a ? [b, a] : [b, a, c]);
}

const keyForm = (value) => formsOf(value)[0];

/** Vowels removed, the first letter kept: "fuck" → "fck". */
function skeletonOf(value) {
    return value[0] + value.slice(1).replace(/[aeiou]/g, '');
}

const hasVowelAfterFirst = (value) => /[aeiou]/.test(value.slice(1));

// ── Words → keys ──────────────────────────────────────────────────────────

/** Spelling variants of a 4+ letter word (see the header). The word itself comes first. */
function spellingVariants(word) {
    const options = [];
    for (let i = 0; i < word.length;) {
        const two = word.slice(i, i + 2);
        if (two === 'ck') { options.push(['ck', 'k', 'c', 'q']); i += 2; continue; }
        if (two === 'ph') { options.push(['ph', 'f']); i += 2; continue; }
        if (two === 'ch' || two === 'sh' || two === 'th') { options.push([two]); i += 2; continue; }
        const ch = word[i];
        let choice = [ch];
        if (ch === 'c') choice = ['c', 'k'];
        else if (ch === 'k') choice = ['k', 'c'];
        else if (ch === 'q') choice = ['q', 'k'];
        else if (ch === 'f') choice = ['f', 'ph'];
        else if (ch === 'x') choice = ['x', 'ks', 'cks'];
        else if (ch === 'u') choice = ['u', 'v'];
        else if (ch === 'i' && i > 0) choice = ['i', 'y'];
        else if (ch === 's' && i > 0) choice = ['s', 'z'];
        else if (ch === 'y' && i > 0) choice = ['y', 'i'];
        options.push(choice);
        i += 1;
    }
    let out = [''];
    for (const choice of options) {
        const next = [];
        for (const prefix of out) {
            for (const part of choice) {
                if (next.length < MAX_VARIANTS) next.push(prefix + part);
            }
        }
        out = next;
    }
    return out;
}

/** Variants of a short word: only x → ks / cks ("seks", "secks"). */
function shortVariants(word) {
    return word.includes('x') ? [word, word.replace(/x/g, 'ks'), word.replace(/x/g, 'cks')] : [word];
}

/** A variant with one single vowel doubled, for each vowel ("fuuck"). */
function vowelDoubled(variant) {
    const out = [];
    for (let i = 1; i < variant.length; i += 1) {
        if (isVowel(variant[i]) && variant[i - 1] !== variant[i] && variant[i + 1] !== variant[i]) {
            out.push(variant.slice(0, i + 1) + variant.slice(i));
        }
    }
    return out;
}

const consonantCount = (word) => [...word].filter((c) => isLetter(c) && !isVowel(c)).length;

// An entry's keys are all added in one go (one addWord call, or consecutive calls for one
// phrase word), so comparing with the last value is enough to skip duplicates; a full
// includes() scan would make a big list with shared keys quadratic to compile.
function pushTo(map, key, value) {
    const list = map.get(key);
    if (list) {
        if (list.at(-1) !== value) list.push(value);
    } else {
        map.set(key, [value]);
    }
}

function emptyCompiled(allow) {
    return {
        keys: new Map(), skeletons: new Map(), wildSkeletons: new Map(), patterns: new Map(),
        inside: [], suffixes: [], allow, phrases: new Map(), parts: null, size: 0,
    };
}

/** Adds one single word (decoded, a-z0-9) with its entry to a compiled table. */
function addWord(compiled, word, entry, { exact = false } = {}) {
    if (!word) return;
    const short = word.length <= SHORT_WORD;
    const variants = exact ? [word] : short ? shortVariants(word) : spellingVariants(word);
    const keyed = new Set();
    for (const variant of variants) {
        keyed.add(short ? cap2(variant) : keyForm(variant));
        // Doubled vowels only on the word itself: "cok" (a cock variant) doubled is "cook".
        if (!short && !exact && variant === word) for (const doubled of vowelDoubled(variant)) keyed.add(keyForm(doubled));
        if (keyed.size >= MAX_KEYS_PER_WORD) break;
    }
    for (const key of keyed) pushTo(compiled.keys, key, entry);
    if (exact) return;
    const dropVowels = !short && consonantCount(word) >= 3;
    const patternsSeen = new Set(); // per entry: a bucket scan per pattern would be quadratic in big lists
    for (const variant of variants) {
        const form = keyForm(variant);
        // Re-keyed: dropping vowels can bring equal consonants together ("braindead" -> "brndd" -> "brnd").
        const skeleton = keyForm(skeletonOf(form));
        if (skeleton.length >= 2 && skeleton !== form) {
            if (dropVowels) pushTo(compiled.skeletons, skeleton, entry);
            pushTo(compiled.wildSkeletons, skeleton, entry);
        }
        for (const suffix of ['', ...entry.suffixes]) {
            const pattern = cap2(variant + suffix);
            if (patternsSeen.has(pattern)) continue;
            patternsSeen.add(pattern);
            if (!compiled.patterns.has(pattern.length)) compiled.patterns.set(pattern.length, []);
            compiled.patterns.get(pattern.length).push({ text: pattern, entry });
        }
    }
    if (entry.inside) {
        for (const variant of [word, word.replace(/u/g, 'v')]) {
            const a = formsOf(variant)[1] || formsOf(variant)[0];
            compiled.inside.push({ c: cap2(variant), a: a === cap2(variant) ? a : null, entry });
        }
    }
}

// Spellings of short phrase words ("fuck u", "kill urself").
const PART_ALIASES = {
    you: ['you', 'u', 'yu', 'ya', 'yuo', 'yoo'],
    your: ['your', 'ur', 'yur', 'yor', 'youre'],
    yourself: ['yourself', 'urself', 'yourslf', 'yoself', 'yourselves'],
    my: ['my', 'mah'],
};

/** The words of a list entry as the matcher reads them (decoded, wildcards as separators). */
export function wordParts(text) {
    const parts = [];
    for (const word of analyze(String(text || '').replace(/[*#%_]/g, ' ')).words) {
        for (const index of word.pieces) parts.push(decodeFull(analyzedPieceRaw(word, index)));
    }
    return parts.filter(Boolean);
}

/**
 * Compiles a word list. `words`: [{ word, suffixes?: [], inside?: bool, exact?: bool, ...payload }].
 * Each entry comes back on a hit as `entry` (with every field passed in).
 * options.allow: skip the ALLOW tokens and ALLOW_CONTEXT phrases (the built-in lists).
 */
export function compileWords(words, { allow = false } = {}) {
    const compiled = emptyCompiled(allow);
    const parts = emptyCompiled(false);
    const suffixes = new Set();
    // One entry per phrase word and spelling: many phrases share words ("free nitro", "free robux").
    const partsAdded = new Set();
    for (const input of words) {
        const parsed = wordParts(input.word);
        if (!parsed.length) continue;
        // uid: two rules may list the same word; each is its own hit.
        // plain: the word as listed (decoded), so a token that IS the listed word is never
        // dropped by the allow list (a server that lists "kunt" wants "kunt" caught).
        const entry = { ...input, uid: compiled.size, plain: parsed.join(''), suffixes: new Set(input.suffixes || []) };
        for (const suffix of entry.suffixes) suffixes.add(suffix);
        compiled.size += 1;
        if (parsed.length === 1) {
            addWord(compiled, parsed[0], entry, { exact: input.exact });
            continue;
        }
        // A phrase: word by word, and written together.
        const joined = parsed.join('');
        if (joined.length > SHORT_WORD) addWord(compiled, joined, entry, { exact: input.exact });
        for (const part of parsed) {
            const tag = `${input.exact ? 'x' : 'v'}:${part}`;
            if (partsAdded.has(tag)) continue;
            partsAdded.add(tag);
            const partEntry = { word: part, suffixes: new Set() };
            for (const spelling of input.exact ? [part] : (PART_ALIASES[part] || [part])) {
                addWord(parts, spelling, partEntry, { exact: input.exact });
            }
        }
        pushTo(compiled.phrases, parsed[0], { parts: parsed, entry });
    }
    compiled.suffixes = [...suffixes].sort((x, y) => y.length - x.length);
    compiled.parts = parts;
    return compiled;
}

// ── Messages → tokens ─────────────────────────────────────────────────────

/** Decoded letters of raw piece text: leetspeak read, wildcards as "*". `l`: 1 and | as l. */
function decode(raw, l = false) {
    let out = '';
    for (const ch of raw) {
        if (isLetter(ch)) out += ch;
        else if (WILD.has(ch)) out += '*';
        else if (l && LEET_L[ch]) out += LEET_L[ch];
        else if (LEET[ch]) out += LEET[ch];
        else out += ch;
    }
    return out;
}
const decodeFull = (raw) => decode(raw);

/** The decoded readings of a token: leet as i, leet as l, and with leet/digits at the edges dropped. */
const WILD_BETWEEN_EACH = /^[^*#%_](?:[*#%_][^*#%_]){2,}$/;

const readingsMemo = new Map();

function readingsOf(raw) {
    if (raw.length > MEMO_KEY_MAX) return computeReadings(raw);
    let readings = readingsMemo.get(raw);
    if (!readings) {
        readings = computeReadings(raw);
        if (readingsMemo.size >= MEMO_MAX) readingsMemo.clear();
        readingsMemo.set(raw, readings);
    }
    return readings;
}

function computeReadings(raw) {
    const out = new Set([decode(raw)]);
    if (/[1|]/.test(raw)) out.add(decode(raw, true));
    // "_" is also a plain separator ("f_u_c_k"), and so is any wildcard put between every
    // letter ("s*h*i*t"): read once more without them.
    if (raw.includes('_')) out.add(decode(raw.replace(/_/g, '')));
    if (WILD_BETWEEN_EACH.test(raw)) out.add(decode(raw.replace(/[*#%_]/g, '')));
    let first = 0;
    let last = raw.length - 1;
    while (first <= last && !isLetter(raw[first])) first += 1;
    while (last >= first && !isLetter(raw[last])) last -= 1;
    if (first <= last && (first > 0 || last < raw.length - 1)) {
        const inner = raw.slice(first, last + 1);
        out.add(decode(inner));
        if (/[1|]/.test(inner)) out.add(decode(inner, true));
    }
    return [...out].filter((value) => value && /[a-z]/.test(value));
}

const charKind = (ch) => {
    if (isLetter(ch) || isDigit(ch)) return 'alnum';
    if (LEET[ch] || WILD.has(ch)) return 'leet';
    if (HARD.has(ch)) return 'hard';
    if (isSpace(ch)) return 'space';
    return 'soft';
};

function analyzedPieceRaw(word, index) {
    return word.pieceRaw[word.pieces.indexOf(index)];
}

// Discord markup: mentions, channels, timestamps, slash-command mentions ("<#123>" would read
// as "c*i"), blanked with spaces of the same length so positions stay. A custom emoji keeps
// its name (":fuck:" is a word like any other).
const MARKUP = /<(?:@[!&]?|#)\d+>|<t:-?\d+(?::\w)?>|<\/[\w -]+:\d+>|<a?:(\w+):\d+>/g;

function blankMarkup(value) {
    if (!value.includes('<')) return value;
    return value.replace(MARKUP, (whole, name) => {
        if (!name) return ' '.repeat(whole.length);
        const at = whole.indexOf(':') + 1; // the name stays in its place: "<a:" / "<:" become spaces
        return `${' '.repeat(at)}${name}${' '.repeat(whole.length - at - name.length)}`;
    });
}

const analysisCache = new Map();
const ANALYSIS_CACHE_MAX = 8;

/**
 * Splits a text into words and pieces (folded positions):
 * { folded, start, end, words: [{ from, to, raw, pieces: [i], pieceRaw: [..] }], pieces: [{ from, to, raw, word }] }.
 */
export function analyze(text) {
    const value = String(text || '').slice(0, MAX_TEXT);
    const cached = analysisCache.get(value);
    if (cached) return cached;
    const { folded, start, end } = foldIndexed(blankMarkup(value));
    const words = [];
    const pieces = [];
    let word = null;
    let piece = null;
    const closePiece = () => {
        if (!piece) return;
        piece.word = words.length;
        pieces.push(piece);
        word.pieces.push(pieces.length - 1);
        word.pieceRaw.push(piece.raw);
        word.raw += piece.raw;
        word.to = piece.to;
        piece = null;
    };
    const closeWord = () => {
        closePiece();
        if (word?.pieces.length) words.push(word);
        word = null;
    };
    for (let i = 0; i < folded.length; i += 1) {
        const ch = folded[i];
        const kind = charKind(ch);
        if (kind === 'space' || kind === 'hard') { closeWord(); continue; }
        if (kind === 'soft') { closePiece(); continue; }
        if (!word) word = { from: i, to: i + 1, raw: '', pieces: [], pieceRaw: [] };
        if (!piece) piece = { from: i, to: i + 1, raw: '' };
        if (!word.pieces.length && !piece.raw) word.from = i;
        piece.raw += ch;
        piece.to = i + 1;
    }
    closeWord();
    // Piece indexes in words were taken before the word itself was pushed: fix the word links.
    words.forEach((w, index) => { for (const p of w.pieces) pieces[p].word = index; });
    const analysis = { value, folded, start, end, words, pieces, allowedRanges: null };
    if (analysisCache.size >= ANALYSIS_CACHE_MAX) analysisCache.delete(analysisCache.keys().next().value);
    analysisCache.set(value, analysis);
    return analysis;
}

function allowedRangesOf(analysis) {
    if (analysis.allowedRanges) return analysis.allowedRanges;
    const ranges = [];
    for (const pattern of ALLOW_CONTEXT) {
        pattern.lastIndex = 0;
        for (const match of analysis.folded.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
    }
    analysis.allowedRanges = ranges;
    return ranges;
}

// ── Lookups ───────────────────────────────────────────────────────────────

/** Entries a decoded token matches. mode 'strict' (fragments joined across spaces) skips the loose paths. */
/**
 * lookup, remembered per compiled list: chat repeats its words, and the window pass checks
 * the same joined fragments again. Pure, so a hit list is shared (callers only read it).
 */
function lookupMemo(compiled, reading, mode, digits) {
    if (reading.length > MEMO_KEY_MAX) return lookup(compiled, reading, mode, { digits });
    const memo = compiled.memo || (compiled.memo = new Map());
    const key = `${mode === 'strict' ? 's' : 'f'}${digits ? 1 : 0}${reading}`;
    let hits = memo.get(key);
    if (hits) return hits;
    hits = lookup(compiled, reading, mode, { digits });
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(key, hits);
    return hits;
}

function lookup(compiled, reading, mode = 'full', { digits = false } = {}) {
    const hits = [];
    const add = (entries, suffix) => {
        for (const entry of entries || []) {
            if ((!suffix || entry.suffixes.has(suffix)) && !hits.includes(entry)) hits.push(entry);
        }
    };
    if (reading.includes('*')) {
        if (mode === 'strict') return hits;
        return wildLookup(compiled, reading);
    }
    const forms = formsOf(reading);
    for (const form of forms) {
        add(compiled.keys.get(form));
        for (const suffix of compiled.suffixes) {
            if (form.length >= suffix.length + 2 && form.endsWith(suffix)) {
                add(compiled.keys.get(form.slice(0, -suffix.length)), suffix);
                if (suffix === 'ies') add(compiled.keys.get(`${form.slice(0, -3)}y`), suffix);
            }
        }
    }
    if (mode === 'strict') return hits;
    // Every vowel dropped: the token core has no vowel after its first letter. Not for tokens
    // with digits: a digit read as a consonant makes too many skeletons ("M8" -> "mb").
    const form = forms[0];
    for (const suffix of digits ? [] : ['', ...compiled.suffixes]) {
        if (suffix && !(form.length >= suffix.length + 2 && form.endsWith(suffix))) continue;
        const core = suffix ? form.slice(0, -suffix.length) : form;
        if (core.length >= 2 && !hasVowelAfterFirst(core) && reading.length - suffix.length >= 3) add(compiled.skeletons.get(core), suffix);
    }
    for (const { c, a, entry } of compiled.inside) {
        if (hits.includes(entry)) continue;
        if (forms.some((f) => f.includes(c) || (a && f.includes(a)))) hits.push(entry);
    }
    return hits;
}

/** A token with hidden letters ("f*ck", "s**t", "f*g"). */
function wildLookup(compiled, reading) {
    const hits = [];
    if (reading[0] === '*') return hits;
    const real = reading.replace(/\*/g, '');
    if (real.length < 2 || real.length * 2 < reading.length) return hits;
    const core = keyForm(real);
    if (!hasVowelAfterFirst(core)) {
        for (const entry of compiled.wildSkeletons.get(core) || []) if (!hits.includes(entry)) hits.push(entry);
    }
    const capped = cap2(reading);
    for (const { text, entry } of compiled.patterns.get(capped.length) || []) {
        if (hits.includes(entry)) continue;
        let ok = true;
        for (let i = 0; ok && i < capped.length; i += 1) ok = capped[i] === '*' || capped[i] === text[i];
        if (ok) hits.push(entry);
    }
    return hits;
}

/** Whether a token is on the ALLOW list in any of its readings (as written, not stretched). */
function allowedToken(readings) {
    // A stretched spelling ("kysssss", "niiiger") is not the ordinary word it shortens to.
    return readings.some((reading) => cap2(reading) === reading && isAllowedToken(reading));
}

// ── Matching ──────────────────────────────────────────────────────────────

/**
 * Every hit of a compiled list in a text: [{ entry, word, start, end, match }], in text
 * order. start/end index the ORIGINAL text; match is the original substring.
 * options.first: stop after the first hit.
 */
export function matchWords(text, compiled, { first = false } = {}) {
    if (!compiled || !compiled.size) return [];
    const analysis = analyze(text);
    if (!analysis.words.length) return [];
    const found = [];
    const seen = new Set();
    const ranges = compiled.allow ? allowedRangesOf(analysis) : [];
    const record = (entries, from, to, readings) => {
        if (!entries.length) return false;
        if (compiled.allow && readings && allowedToken(readings)) {
            entries = entries.filter((entry) => readings.some((reading) => cap2(reading) === entry.plain));
            if (!entries.length) return false;
        }
        if (ranges.some(([a, b]) => from >= a && to <= b)) return false;
        let added = false;
        for (const entry of entries) {
            const key = `${from}:${to}:${entry.uid ?? entry.word}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const start = analysis.start(from);
            const end = analysis.end(to - 1);
            found.push({ entry, word: entry.word, start, end, match: analysis.value.slice(start, end) });
            added = true;
        }
        return added;
    };
    const check = (raw, from, to, mode = 'full') => {
        const readings = readingsOf(raw);
        const digits = /[0-9]/.test(raw);
        const hits = [];
        for (const reading of readings) {
            for (const entry of lookupMemo(compiled, reading, mode, digits)) if (!hits.includes(entry)) hits.push(entry);
        }
        return record(hits, from, to, readings);
    };

    // Whole words and their pieces.
    for (const word of analysis.words) {
        if (check(word.raw, word.from, word.to) && first) return found;
        if (word.pieces.length > 1) {
            for (const index of word.pieces) {
                const piece = analysis.pieces[index];
                if (check(piece.raw, piece.from, piece.to) && first) return found;
            }
        }
    }

    // Fragments joined across spaces: single letters, or short fragments that are not common words.
    const units = analysis.words.map((word) => {
        const reading = decode(word.raw);
        const letters = reading.replace(/[^a-z]/g, '');
        const joinable = letters.length >= 1 && letters.length <= 3 && !reading.includes('*')
            && (letters.length === 1 || !STOP.has(letters));
        return { word, joinable, single: letters.length === 1 };
    });
    let checks = 0;
    for (let i = 0; i < units.length && checks < MAX_WINDOW_CHECKS; i += 1) {
        if (!units[i].joinable) continue;
        let raw = units[i].word.raw;
        let singles = units[i].single;
        for (let j = i + 1; j < units.length && j - i < MAX_WINDOW_UNITS && checks < MAX_WINDOW_CHECKS; j += 1) {
            if (!units[j].joinable) break;
            raw += units[j].word.raw;
            singles = singles && units[j].single;
            if (raw.length > MAX_WINDOW_LETTERS) break;
            checks += 1;
            const mode = singles && j - i >= 2 ? 'full' : 'strict';
            if (check(raw, units[i].word.from, units[j].word.to, mode) && first) return found;
        }
    }

    // Phrases, piece by piece ("join-my-server"), then word by word with each word's
    // separators dropped ("f.u.c.k off").
    if (compiled.phrases.size) {
        const passes = [analysis.pieces];
        if (analysis.words.some((word) => word.pieces.length > 1)) passes.push(analysis.words);
        for (const units of passes) {
            const partsOf = units.map((unit) => {
                const out = new Set();
                for (const reading of readingsOf(unit.raw)) for (const entry of lookupMemo(compiled.parts, reading, 'full', false)) out.add(entry.word);
                return out;
            });
            for (let i = 0; i < partsOf.length; i += 1) {
                for (const part of partsOf[i]) {
                    for (const { parts, entry } of compiled.phrases.get(part) || []) {
                        if (i + parts.length > partsOf.length) continue;
                        let ok = true;
                        for (let k = 1; ok && k < parts.length; k += 1) ok = partsOf[i + k].has(parts[k]);
                        if (ok && record([entry], units[i].from, units[i + parts.length - 1].to, null) && first) return found;
                    }
                }
            }
        }
    }
    return found.sort((x, y) => x.start - y.start || y.end - x.end);
}

/** The first hit (by position) or null. */
export function firstMatch(text, compiled) {
    const hits = matchWords(text, compiled);
    return hits[0] || null;
}
