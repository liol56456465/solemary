// textFold.js — turns styled or disguised text back into plain lower-case Latin letters.
// Shared by the automod filters (filters.js) and the word matcher (wordMatcher.js).
// foldIndexed also keeps, for every folded character, where it came from in the
// original text, so a match can be masked in the original.

// Characters that render as nothing (or as a blank) and are used to break up words.
export const INVISIBLE_PATTERN = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{E0000}-\u{E007F}]/gu;
const INVISIBLE_ONE = new RegExp(`^${INVISIBLE_PATTERN.source}$`, 'u');

// Look-alike letters NFKD does not fold: Cyrillic, Greek, Armenian, small capitals, IPA and others.
export const HOMOGLYPHS = {
    а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
    ѕ: 's', і: 'i', ї: 'i', ј: 'j', ԁ: 'd', ԛ: 'q', ԝ: 'w', ɡ: 'g', ɩ: 'i', ʏ: 'y', ʀ: 'r', ɴ: 'n', ʟ: 'l',
    ʜ: 'h', ɢ: 'g', ɪ: 'i', ʙ: 'b', ᴀ: 'a', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ᴊ: 'j', ᴋ: 'k', ᴍ: 'm',
    ᴏ: 'o', ᴘ: 'p', ǫ: 'q', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ᴢ: 'z',
    α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
    ɑ: 'a', ɛ: 'e', ɔ: 'o', ɵ: 'o', ø: 'o', ł: 'l', đ: 'd', ħ: 'h', ı: 'i', ȷ: 'j', ß: 'ss', æ: 'ae', œ: 'oe',
    // Added 2026-11 (automod bypasses): more Cyrillic, Greek, Armenian and Latin-extended look-alikes.
    п: 'n', г: 'r', ш: 'w', ц: 'u', ь: 'b', ԍ: 'g', ѵ: 'v', һ: 'h', ӏ: 'l', ԃ: 'd', ү: 'y',
    μ: 'u', ϲ: 'c', ς: 'c', σ: 'o', γ: 'y', π: 'n', θ: 'o', ϝ: 'f', ϳ: 'j',
    ս: 'u', օ: 'o', ո: 'n', հ: 'h', ց: 'g', զ: 'q', ա: 'w', ռ: 'n',
    ƒ: 'f', ɓ: 'b', ɗ: 'd', ɦ: 'h', ɱ: 'm', ɲ: 'n', ŋ: 'n', ƙ: 'k', ɠ: 'g', ʈ: 't', ɽ: 'r', ɾ: 'r',
    ʋ: 'u', ɯ: 'w', ʂ: 's', ʐ: 'z', ƭ: 't', ȼ: 'c', ɇ: 'e', ɨ: 'i', ʉ: 'u', ƀ: 'b', ƶ: 'z',
};

// Upper-case Greek letters that look like a Latin capital but lower-case to something else
// (Η → η looks like n, Ν → ν looks like v, Μ → μ looks like u): folded before lower-casing.
const UPPER_HOMOGLYPHS = {
    Α: 'a', Β: 'b', Ε: 'e', Ζ: 'z', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Υ: 'y', Χ: 'x',
};
const UPPER_PATTERN = new RegExp(`[${Object.keys(UPPER_HOMOGLYPHS).join('')}]`, 'g');

/**
 * Turns styled or disguised text back into plain lower-case Latin letters: fancy fonts
 * (𝓱𝓮𝓵𝓵𝓸, ｈｅｌｌｏ, ⓗⓔⓛⓛⓞ, ʜᴇʟʟᴏ), look-alike Cyrillic/Greek letters, accents and
 * zalgo marks, regional-indicator letters, and invisible characters.
 */
export function foldText(text) {
    return String(text || '')
        .replace(INVISIBLE_PATTERN, '')
        .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, (c) => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 97))
        // Squared and negative circled/squared letters (🄷, 🅗, 🅷) have no compatibility mapping.
        .replace(/[\u{1F130}-\u{1F149}\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}]/gu, (c) => String.fromCharCode(((c.codePointAt(0) - 0x1F130) % 32) + 97))
        .replace(UPPER_PATTERN, (c) => UPPER_HOMOGLYPHS[c])
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/./gu, (c) => HOMOGLYPHS[c] || c);
}

const foldCache = new Map();
const FOLD_CACHE_MAX = 5000;

/** One code point folded like foldText (cached: messages reuse few non-ASCII characters). */
function foldOne(ch) {
    let out = foldCache.get(ch);
    if (out !== undefined) return out;
    const cp = ch.codePointAt(0);
    if (INVISIBLE_ONE.test(ch)) out = '';
    else if (cp >= 0x1F1E6 && cp <= 0x1F1FF) out = String.fromCharCode(cp - 0x1F1E6 + 97);
    else if ((cp >= 0x1F130 && cp <= 0x1F149) || (cp >= 0x1F150 && cp <= 0x1F169) || (cp >= 0x1F170 && cp <= 0x1F189)) {
        out = String.fromCharCode(((cp - 0x1F130) % 32) + 97);
    } else if (UPPER_HOMOGLYPHS[ch]) out = UPPER_HOMOGLYPHS[ch];
    else out = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/./gu, (c) => HOMOGLYPHS[c] || c);
    if (foldCache.size < FOLD_CACHE_MAX) foldCache.set(ch, out);
    return out;
}

const ASCII = /^[\x00-\x7F]*$/;

/**
 * foldText with positions: { folded, start(i), end(i) } where start/end give the range in
 * the original text of folded character i (code units). Plain ASCII text keeps its positions.
 */
export function foldIndexed(text) {
    const value = String(text || '');
    if (ASCII.test(value)) {
        return { folded: value.toLowerCase(), start: (i) => i, end: (i) => i + 1 };
    }
    let folded = '';
    const starts = [];
    const ends = [];
    let at = 0;
    for (const ch of value) {
        const out = foldOne(ch);
        for (let k = 0; k < out.length; k += 1) {
            starts.push(at);
            ends.push(at + ch.length);
        }
        folded += out;
        at += ch.length;
    }
    return { folded, start: (i) => starts[i] ?? value.length, end: (i) => ends[i] ?? value.length };
}
