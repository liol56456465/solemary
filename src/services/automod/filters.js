// filters.js — the deterministic automod checks. Pure functions over message text
// (plus a little per-user history kept by the caller), so they are easy to test.

import { detectAll } from 'tinyld';
import { automodConfig } from '../../config/automod.js';
import { HOMOGLYPHS, INVISIBLE_PATTERN, foldText } from './textFold.js';
import { compileWords, matchWords } from './wordMatcher.js';

// Also matches invites broken up with spaces or brackets: "discord . gg / x", "discord(.)gg/x", "discord dot gg/x".
const INVITE_PATTERN = /(?:discord(?:app)?\s*(?:\.|\(\.\)|\[\.\]|\bdot\b)\s*com\s*\/\s*invite|discord\s*(?:\.|\(\.\)|\[\.\]|\bdot\b)\s*gg|dsc\s*\.\s*gg)\s*\/\s*([\w-]{2,32})/gi;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi;

// Domains Discord itself uses; anything that only looks like them is treated as phishing.
const DISCORD_DOMAINS = new Set([
    'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.new',
    'discordstatus.com', 'dis.gd', 'cdn.discordapp.com', 'media.discordapp.net',
]);
const STEAM_DOMAINS = new Set(['steampowered.com', 'steamcommunity.com', 'store.steampowered.com', 'help.steampowered.com']);

const NSFW_DOMAINS = [
    'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'spankbang.com',
    'onlyfans.com', 'fansly.com', 'chaturbate.com', 'brazzers.com', 'rule34.xxx', 'nhentai.net', 'e621.net',
    'hentaihaven.xxx', 'erome.com', 'motherless.com', 'stripchat.com', 'cam4.com',
];

// The built-in word lists. Matched by wordMatcher.js, which reads through look-alike
// letters, fancy fonts, leetspeak, separators between letters, letters spelled out across
// spaces, stretched letters, common misspellings and hidden letters ("f*g"), while
// ordinary words stay out ("class", "Scunthorpe", "Niger", "snigger"). Per word:
//   suffixes: endings that still count ("niggers", "bitches"); only these, so "spicy" is not "spic".
//   inside:   also matched inside a longer word ("youniggers") and split anywhere across words
//             ("nigg er", "kill your self"): distinctive words only.
//   notSplit: splits of an inside word that are ordinary words ("wet back").
//   name:     what the finder returns (defaults to the word itself).

// Slurs and severe insults.
const BLOCKED_WORDS = [
    { word: 'nigger', suffixes: ['s'], inside: true },
    { word: 'nigga', suffixes: ['s', 'z', 'h', 'hs'], inside: true },
    { word: 'faggot', suffixes: ['s', 'ry'], inside: true },
    { word: 'fag', suffixes: ['s'] },
    { word: 'retard', suffixes: ['s', 'ed'] },
    { word: 'tranny', suffixes: ['ies'], inside: true, notSplit: ['tran i'] }, // Tran: a common surname
    { word: 'chink', suffixes: ['s'] },
    { word: 'spic', suffixes: ['s'] },
    { word: 'kike', suffixes: ['s'] },
    { word: 'wetback', suffixes: ['s'], inside: true, notSplit: ['wet back', 'wet backs'] },
    { word: 'coon', suffixes: ['s'] },
    { word: 'gook', suffixes: ['s'] },
    { word: 'dyke', suffixes: ['s'] },
    { word: 'kys' },
    { word: 'kill yourself', name: 'killyourself', inside: true },
    { word: 'cunt', suffixes: ['s'] },
    { word: 'whore', suffixes: ['s'] },
    { word: 'slut', suffixes: ['s', 'ty'] },
];

// Insults that count as disrespect when aimed at someone (a mention or a reply).
const INSULT_WORDS = [
    { word: 'idiot', suffixes: ['s'] }, { word: 'stupid' }, { word: 'dumb' }, { word: 'dumbass' }, { word: 'loser', suffixes: ['s'] },
    { word: 'ugly' }, { word: 'shut up' }, { word: 'stfu' }, { word: 'trash' }, { word: 'pathetic' }, { word: 'moron', suffixes: ['s'] },
    { word: 'clown', suffixes: ['s'] }, { word: 'braindead' }, { word: 'bitch', suffixes: ['es'] }, { word: 'bastard', suffixes: ['s'] },
    { word: 'asshole', suffixes: ['s'] }, { word: 'dickhead', suffixes: ['s'] }, { word: 'dick head', name: 'dickhead' }, { word: 'fuck you' }, { word: 'fuck off' },
    { word: 'screw you' }, { word: 'nobody likes you' }, { word: 'go die' }, { word: 'hate you' }, { word: 'worthless' }, { word: 'cringe' },
];

// Sexual words; counted as sexual harassment only when aimed at someone.
const SEXUAL_WORDS = [
    { word: 'sex' }, { word: 'sexy' }, { word: 'nude' }, { word: 'nudes' }, { word: 'horny' }, { word: 'dick', suffixes: ['s'] },
    { word: 'cock', suffixes: ['s'] }, { word: 'pussy', suffixes: ['ies'] }, { word: 'boobs' }, { word: 'tits' }, { word: 'porn', suffixes: ['o'] },
    { word: 'onlyfans' }, { word: 'send pics' }, { word: 'blowjob', suffixes: ['s'] }, { word: 'blow job', name: 'blowjob' }, { word: 'cum' }, { word: 'naked' },
    { word: 'suck my' }, { word: 'rape', suffixes: ['d', 's'] },
];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '|': 'i' };

export { INVISIBLE_PATTERN, foldText };

export function normalizeText(text) {
    return foldText(text)
        .replace(/[013457@$!|]/g, (c) => LEET[c] || c)
        .replace(/(.)\1{2,}/g, '$1$1');
}

/**
 * Letters spelled out one by one to dodge filters ("n i g g e r", "n.i.g.g.e.r"):
 * every run of 3+ single letters split by spaces or punctuation, joined back up.
 * (The word lists use wordMatcher.js, which does this itself; kept for other callers.)
 */
export function joinSpelledOutLetters(text) {
    const runs = normalizeText(text).match(/(?:(?<![a-z])[a-z](?![a-z])[\s.\-_*,|/\\~+'"`:;]*){3,}/g) || [];
    return runs.map((run) => run.replace(/[^a-z]/g, ''));
}

const INSULT_LIST = compileWords(INSULT_WORDS, { allow: true });
const SEXUAL_LIST = compileWords(SEXUAL_WORDS, { allow: true });
// The blocked list includes the server's extra words (a setting that can change at any
// time): recompiled only when that setting's value changes.
let blockedList = null;
let blockedExtraKey = null;
let blockedExtraRef = null;
function blockedCompiled() {
    const extra = Array.isArray(automodConfig.extraBlockedWords) ? automodConfig.extraBlockedWords : [];
    if (blockedList && extra === blockedExtraRef) return blockedList;
    blockedExtraRef = extra;
    const key = JSON.stringify(extra);
    if (!blockedList || key !== blockedExtraKey) {
        const extraEntries = extra.map((word) => String(word ?? '').trim().toLowerCase()).filter(Boolean).map((word) => ({ word }));
        blockedList = compileWords([...BLOCKED_WORDS, ...extraEntries], { allow: true });
        blockedExtraKey = key;
    }
    return blockedList;
}

/** The name of the first word of a compiled list in the text, or null. */
function firstListWord(text, compiled) {
    const [hit] = matchWords(text, compiled, { first: true });
    return hit ? (hit.entry.name || hit.word) : null;
}

/**
 * Every hit of the built-in word lists: [{ list: 'blocked' | 'insult' | 'sexual', word, start, end, match }],
 * start/end index the original text (for masking).
 */
export function findListWords(text) {
    const lists = [['blocked', blockedCompiled()], ['insult', INSULT_LIST], ['sexual', SEXUAL_LIST]];
    return lists.flatMap(([list, compiled]) => matchWords(text, compiled)
        .map((hit) => ({ list, word: hit.entry.name || hit.word, start: hit.start, end: hit.end, match: hit.match })))
        .sort((a, b) => a.start - b.start || b.end - a.end);
}

export function extractUrls(text) {
    // Folded, so full-width dots and look-alike letters in links are seen for what they are.
    return foldText(text).match(URL_PATTERN) || [];
}

export function hostOf(url) {
    try {
        const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return null;
    }
}

function matchesDomain(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}

/** Invite codes in the text (the caller decides which point at our own servers). */
export function findInviteCodes(text) {
    return [...foldText(text).matchAll(INVITE_PATTERN)].map((match) => match[1]);
}

export function findBlockedWord(text) {
    return firstListWord(text, blockedCompiled());
}

export function findInsult(text) {
    return firstListWord(text, INSULT_LIST);
}

export function findSexualWord(text) {
    return firstListWord(text, SEXUAL_LIST);
}

/**
 * The language of a message when it is clearly not English, else null. Short
 * messages, links and emoji are not judged: the detector is unreliable on them.
 */
export function detectNonEnglish(text) {
    const cleaned = String(text || '')
        .replace(/<a?:\w+:\d+>|<[@#&!]+\d+>|https?:\/\/\S+|`[^`]*`/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const words = cleaned.split(' ').filter((word) => /\p{L}{2,}/u.test(word));
    const letters = cleaned.match(/\p{L}/gu) || [];
    if (words.length < automodConfig.englishMinWords || letters.length < automodConfig.englishMinLetters) return null;

    const [best] = detectAll(cleaned);
    if (!best || best.lang === 'en' || best.accuracy < automodConfig.englishMinConfidence) return null;
    return best.lang;
}

// Personal info: e-mail addresses, phone numbers, IPv4 addresses and card numbers.
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/;
const PHONE_PATTERN = /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,4}\d{2,4}/g;
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
const CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

function passesLuhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
        let digit = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 1) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
    }
    return sum % 10 === 0;
}

// Mentions, custom emoji and timestamps carry 10-20 digit ids that look like
// phone or card numbers.
const DISCORD_MARKUP_PATTERN = /<a?:\w+:\d+>|<[@#&!]+\d+>|<t:-?\d+(?::\w)?>|<\/[\w -]+:\d+>/g;

/** What kind of personal info the text contains, or null. */
export function findPersonalInfo(text) {
    const value = String(text || '').normalize('NFKC').replace(INVISIBLE_PATTERN, '')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(DISCORD_MARKUP_PATTERN, ' ');
    if (EMAIL_PATTERN.test(value)) return 'an e-mail address';
    for (const match of value.match(CARD_PATTERN) || []) {
        const digits = match.replace(/\D/g, '');
        // A bare 17+ digit run is a pasted Discord id, not a card.
        if (digits.length >= 17 && digits === match.trim()) continue;
        if (digits.length >= 13 && passesLuhn(digits)) return 'a card number';
    }
    for (const match of value.match(PHONE_PATTERN) || []) {
        const digits = match.replace(/\D/g, '');
        // Needs a + or separators: a bare digit run is a score, id or timestamp more often than a phone.
        const formatted = match.trim().startsWith('+') || /\d[\s()-]+\d/.test(match.trim());
        if (formatted && digits.length >= 9 && digits.length <= 15 && !/^(\d)\1+$/.test(digits)) return 'a phone number';
    }
    // Version numbers (1.21.4.2) look like IPs; real addresses nearly always have a 3-digit part.
    const ip = value.match(IPV4_PATTERN)?.[0];
    if (ip && ip.split('.').some((part) => part.length === 3)) return 'an IP address';
    return null;
}

/** Letters and digits only, with look-alike characters folded: "R@m4z1nas" → "ramazinas". */
export function nameKey(name) {
    return normalizeText(name).replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const current = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length];
}

const STAFF_TITLE_PATTERN = /\b(admin|administrator|moderator|mod|staff|owner|support team|discord staff)\b/i;

/**
 * Whether a non-staff member's name imitates staff: a staff title in the name, or a
 * name within one character of a staff member's (for names of 5+ characters).
 * staffNames: display names and usernames of staff. Returns the reason, or null.
 */
export function findImpersonation(names, staffNames) {
    for (const name of names.filter(Boolean)) {
        if (STAFF_TITLE_PATTERN.test(normalizeText(name))) return `"${name}" uses a staff title`;
        const key = nameKey(name);
        if (key.length < 5) continue;
        for (const staffName of staffNames) {
            const staffKey = nameKey(staffName);
            if (staffKey.length >= 5 && editDistance(key, staffKey) <= 1) return `"${name}" imitates staff member "${staffName}"`;
        }
    }
    return null;
}

export function isCapsFlood(text) {
    const letters = String(text || '').normalize('NFKD').replace(/<a?:\w+:\d+>|<[@#&!]+\d+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) || [];
    if (letters.length < automodConfig.capsMinLetters) return false;
    const upper = letters.filter((c) => c !== c.toLowerCase()).length;
    return upper / letters.length >= automodConfig.capsRatio;
}

export function findNsfwDomain(text) {
    for (const url of extractUrls(text)) {
        const host = hostOf(url);
        if (host && NSFW_DOMAINS.some((domain) => matchesDomain(host, domain))) return host;
    }
    return null;
}

/** A link that imitates Discord or Steam, or a "free nitro" lure with a link. */
export function findScam(text) {
    const urls = extractUrls(text);
    for (const url of urls) {
        const host = hostOf(url);
        if (!host) continue;
        const looksDiscord = /d[il1]s?c[o0]r?[dcl]|nitro|discrod|dlscord/.test(host);
        if (looksDiscord && ![...DISCORD_DOMAINS].some((d) => matchesDomain(host, d))) return `look-alike link ${host}`;
        const looksSteam = /st[e3]am|steam?c[o0]m+unity|steamcomunity/.test(host);
        if (looksSteam && ![...STEAM_DOMAINS].some((d) => matchesDomain(host, d))) return `look-alike link ${host}`;
    }
    if (urls.length && /free\s*(discord\s*)?nitro|nitro\s*(for\s*)?free|gift(ed)?\s*(you\s*)?nitro|steam\s*gift/i.test(text)) {
        return 'free Nitro or gift lure with a link';
    }
    return null;
}

/** Distinct user and role mentions, plus whether @everyone/@here was attempted. */
export function countMentions(message) {
    const users = message.mentions?.users?.size || 0;
    const roles = message.mentions?.roles?.size || 0;
    const everyone = /@(everyone|here)\b/.test(message.content || '');
    return { total: users + roles, everyone };
}

/**
 * Spam from a user's recent messages: [{ at, text, channelId }], newest last, already
 * including this one. Returns 'flood' | 'duplicate' | null.
 */
export function detectSpam(history, now = Date.now()) {
    const recent = history.filter((entry) => now - entry.at <= automodConfig.spamWindowMs);
    if (recent.length >= automodConfig.spamMessages) return 'flood';

    const last = history[history.length - 1];
    if (!last?.text) return null;
    const same = history.filter((entry) => now - entry.at <= automodConfig.duplicateWindowMs && entry.text === last.text);
    return same.length >= automodConfig.duplicateMessages ? 'duplicate' : null;
}

/** The same text posted in several channels within the ad-bot window. */
export function detectCrossChannelSpam(history, now = Date.now()) {
    const last = history[history.length - 1];
    if (!last?.text || last.text.length < 8) return false;
    const channels = new Set(history
        .filter((entry) => now - entry.at <= automodConfig.adBotWindowMs && entry.text === last.text)
        .map((entry) => entry.channelId));
    return channels.size >= automodConfig.adBotChannelSpread;
}

export function hasLinkOrAttachment(message) {
    return extractUrls(message.content).length > 0 || (message.attachments?.size || 0) > 0;
}

// Characters from emoticons that are fine even though they are not English letters: ¯\_(ツ)_/¯, ( ͡° ͜ʖ ͡°), ಠ_ಠ, ʕ•ᴥ•ʔ.
const EMOTICON_CHARACTERS = new Set(['ツ', 'ʖ', 'ಠ', 'ᴥ', 'ʕ', 'ʔ', 'ω', 'ʘ', 'ᴗ', 'ɷ']);
const EMOTICON_MARKS = new Set(['\u0361', '\u035C']);

const INVISIBLE_TEST = new RegExp(INVISIBLE_PATTERN.source, 'u');
// Emoji sequences legitimately contain joiners, variation selectors and keycap marks.
const EMOJI_SEQUENCE = /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u200D\uFE0F\u20E3])+/gu;

function strippedForCharacterCheck(text) {
    return String(text || '')
        .replace(EMOJI_SEQUENCE, ' ')
        .replace(/<a?:\w+:\d+>|<[@#&!]+\d+>|<t:\d+(?::\w)?>/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/```[\s\S]*?```|`[^`]*`/g, ' ');
}

/**
 * The server is English only: letters must be plain A–Z. Returns why a message breaks
 * that (fancy fonts, look-alike letters, zalgo, invisible characters, another
 * alphabet), with a short sample, or null. Emoji, digits and punctuation are fine.
 */
export function findForbiddenCharacters(text) {
    const value = strippedForCharacterCheck(text);
    if (INVISIBLE_TEST.test(value)) return 'invisible characters';

    const marks = [...value.normalize('NFD')].filter((c) => /\p{M}/u.test(c) && !EMOTICON_MARKS.has(c));
    const fancy = [];
    const foreign = [];
    for (const char of value) {
        if (char.charCodeAt(0) < 0x80 || EMOTICON_CHARACTERS.has(char)) continue;
        // Letters, plus symbols that stand for a letter (ⓗ, 🄷): both are writing.
        if (!/\p{L}/u.test(char) && !/^[a-z]$/.test(foldText(char))) continue;
        // Styled letters (𝓱, ｈ, ⓗ) fold to A–Z without being accented letters (é decomposes).
        const isStyled = /^[a-z]+$/.test(foldText(char)) && char.normalize('NFD') === char;
        if (isStyled || HOMOGLYPHS[char.toLowerCase()]) fancy.push(char);
        else foreign.push(char);
    }
    if (marks.length >= 3 && marks.length > foreign.length) return 'stacked accent marks (zalgo text)';
    // Real words in another alphabet also contain letters with no look-alike (Привет: П, и).
    if (foreign.length) return `letters outside the English alphabet (${foreign.slice(0, 6).join('')})`;
    if (fancy.length) return `fancy font or look-alike letters (${fancy.slice(0, 6).join('')})`;
    if (marks.length) return 'letters with accents';
    return null;
}

/**
 * A plain-English version of a display name for a nickname reset: styled letters
 * folded to A–Z, everything else that is not ASCII removed. Null when nothing usable is left.
 */
export function plainName(name) {
    const folded = foldText(name).replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
    if (!/[a-z0-9]/i.test(folded)) return null;
    // Keep the original's capitalisation where the letters are plain.
    const original = String(name || '');
    const restored = /^[\x20-\x7E]+$/.test(original) ? original : folded.replace(/\b\w/g, (c) => c.toUpperCase());
    return restored.slice(0, 32);
}
