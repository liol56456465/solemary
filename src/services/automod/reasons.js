// reasons.js — plain-English "why" for automod hits, shown on review cards.
//
// Each reason is a verb phrase that follows the member's mention on the card:
// "<@user> shared what looks like a phone number in #general." The offending word
// itself is never repeated for language and sexual hits; the technical detail
// (matched word, detector output) goes to the logger only, via `detail`.

import { formatDuration } from '../enforcement/format.js';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** findScam output → phrase. */
export function scamReason(raw) {
    const lookAlike = /^look-alike link (.+)$/.exec(raw || '');
    if (lookAlike) return `posted a fake link (${lookAlike[1]}) made to look like Discord or Steam`;
    return 'posted a "free Nitro / gift" lure with a link';
}

export function nsfwReason(domain) {
    return `posted a link to an adult site (${domain})`;
}

/** Ad-bot pattern: a new account or new joiner posting invites or copy-paste across channels. */
export function adBotReason({ newAccount, invite = null, channelCount = 0 }) {
    const who = newAccount ? 'new account' : 'joined less than a day ago';
    const what = invite ? `posted an invite to another server (${invite})` : `same message in ${channelCount || 'several'} channels`;
    return `looks like an ad bot: ${who}, ${what}`;
}

export function inviteReason(invite) {
    return `posted an invite to another server (${invite})`;
}

/** findPersonalInfo output ("a phone number", "an e-mail address"…) → phrase. */
export function privacyReason(kind) {
    return `shared what looks like ${kind || 'personal information'}`;
}

export function blockedWordReason() {
    return 'used a blocked word (hidden)';
}

export function sexualReason(targetId = null) {
    return targetId ? `sent a sexual remark (hidden) at <@${targetId}>` : 'used a sexual word (hidden)';
}

export function harassmentReason(targetId, times, windowMs) {
    return `insulted <@${targetId}> ${plural(times, 'time')} in ${formatDuration(windowMs)}`;
}

export function disrespectReason(targetId) {
    return `insulted <@${targetId}>`;
}

export function mentionsReason({ everyone, total }) {
    return everyone ? 'tried to ping @everyone or @here' : `mentioned ${total} people or roles in one message`;
}

export function spamReason(kind, { messages, windowMs, duplicates, duplicateWindowMs }) {
    return kind === 'flood'
        ? `sent ${messages} or more messages in ${Math.round(windowMs / 1000)} seconds`
        : `sent the same message ${duplicates} or more times in ${Math.round(duplicateWindowMs / 1000)} seconds`;
}

export function capsReason() {
    return 'wrote mostly in capital letters';
}

/** findForbiddenCharacters output → phrase (the characters themselves stay in the log). */
export function charactersReason(raw) {
    const value = raw || '';
    if (value.startsWith('invisible')) return 'used invisible characters';
    if (value.startsWith('stacked')) return 'used stacked accent marks (zalgo text)';
    if (value.startsWith('letters outside')) return 'used letters outside the English alphabet';
    if (value.startsWith('fancy')) return 'used a fancy font or look-alike letters';
    if (value.startsWith('letters with accents')) return 'used letters with accents';
    return 'used characters that are not allowed';
}

/** "fr" → "French"; unknown codes are returned as they are. */
export function languageName(code) {
    if (!code) return null;
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
        return code;
    }
}

export function englishReason(languageCode) {
    const name = languageName(languageCode);
    return name ? `wrote in another language (looks like ${name})` : 'wrote in another language';
}

/** findImpersonation output → phrase. */
export function impersonationReason(raw) {
    const title = /^"(.+)" uses a staff title$/.exec(raw || '');
    if (title) return `has a name that uses a staff title ("${title[1]}")`;
    const imitates = /^"(.+)" imitates staff member "(.+)"$/.exec(raw || '');
    if (imitates) return `has a name ("${imitates[1]}") that imitates staff member ${imitates[2]}`;
    return 'has a name that imitates staff';
}

/** "Insulted …" — a phrase as the start of a sentence (queue, digest). */
export function capitalize(text) {
    const value = String(text || '');
    return value.charAt(0).toUpperCase() + value.slice(1);
}
