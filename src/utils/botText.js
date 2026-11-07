// botText.js — the bot's own messages in 8 languages (en, ru, de, fr, it, pl, es, pt-BR).
//
// Text lives in src/content/bot/<lang>/<namespace>.json (same format, plurals and placeholder
// rules as the website and dashboard catalogs; read by the same core, services/site/i18n.js).
// See docs/bot-i18n.md for how to translate a command.
//
// Which language (owner's "mixed" rule), decided in ONE place: resolveBotLanguage().
//   purpose 'reply'          an ephemeral / private answer to the person who ran the command:
//                            their Discord language (interaction.locale)
//   purpose 'dm' | 'public'  a DM to a member (punishments, appeal results …) or a post in a
//                            channel: the server's language (setting botLanguage, Dashboard →
//                            Bot language; default English)
// Anything unknown (a Discord language we don't have, no server) is English.
// Later: a member's own choice (e.g. a language role) can slot in as the first step of
// resolveBotLanguage; callers already pass `member` / `userId` so they won't need to change.

import { fileURLToPath } from 'node:url';
import { DEFAULT_LANG, LANG_CODES, createCatalog, formatNumberIn } from '../services/site/i18n.js';
import { languageFromDiscordLocale } from '../services/dashboard/language.js';
import { resolveSetting } from '../services/settings/guildSettings.js';
import { logger } from './logger.js';

export { LANG_CODES };
export const BOT_LANGUAGE_KEY = 'botLanguage';
export const BOT_PURPOSES = Object.freeze(['reply', 'dm', 'public']);

/** The bot's own catalog (src/content/bot/<lang>/*.json); no owner edits. */
export const BOT_CATALOG = createCatalog({ dir: fileURLToPath(new URL('../content/bot/', import.meta.url)) });

/** A Discord locale ('de', 'pt-BR', 'es-419', 'en-GB' …) → one of the 8 codes; anything else → 'en'. */
export function languageFromLocale(locale) {
    return languageFromDiscordLocale(locale) || DEFAULT_LANG;
}

let languageReadFailed = false;
/** For tests: forget that a failed read was already logged. */
export function resetBotLanguageLogForTests() {
    languageReadFailed = false;
}

/**
 * The language a server chose for its public posts and member DMs, else English.
 *
 * The one place where a default on a database error is fine: the language is cosmetic, and a
 * punishment DM or an error reply must still go out when the settings cannot be read. So any
 * error here (database down at boot, an unknown server, a bad stored value) gives English and is
 * logged once per failing stretch (the next good read resets it), not on every message. Everywhere else the data-layer rule stands:
 * reads throw on a database error, never return defaults (CLAUDE.md "Data layer rules").
 */
export function serverLanguage(guildId, { resolve = resolveSetting } = {}) {
    if (!guildId) return DEFAULT_LANG;
    try {
        const value = resolve(String(guildId), BOT_LANGUAGE_KEY);
        languageReadFailed = false; // a later failure (e.g. a real outage) is logged again
        return LANG_CODES.includes(value) ? value : DEFAULT_LANG;
    } catch (error) {
        if (!languageReadFailed) {
            languageReadFailed = true;
            logger.warn(`Bot language of server ${guildId} could not be read (${error?.message || error}); using English. Logged once until a read works again.`);
        }
        return DEFAULT_LANG;
    }
}

/**
 * The language of one bot message. Every bot text goes through this, so a later step (a member's
 * own language, e.g. from a role) only has to be added here.
 * @param {object} p
 * @param {string|null} [p.guildId]   the server the message is about (DMs: the server that acted)
 * @param {object|null} [p.member]    the member it is for, when known (reserved for a member preference)
 * @param {string|null} [p.userId]    the user it is for, when there is no member object (same)
 * @param {object|null} [p.interaction]  the interaction being answered (reply: its locale)
 * @param {'reply'|'dm'|'public'} [p.purpose]
 * @param {object} [p.resolve]        tests: replaces resolveSetting
 */
export function resolveBotLanguage({ guildId = null, member = null, userId = null, interaction = null, purpose = 'reply', resolve } = {}) {
    void member; void userId; // a member-preference step goes here later (not built yet)
    if (purpose === 'reply') return languageFromLocale(interaction?.locale);
    return serverLanguage(guildId ?? interaction?.guildId ?? null, resolve ? { resolve } : {});
}

// {count} is written the language's way ("1,5" in German); English keeps the plain number.
const countText = (code, count) => (code === DEFAULT_LANG ? count : formatNumberIn(code, count, { maximumFractionDigits: 1 }));

/**
 * The text functions for one language:
 *   t(key, params)          plain text, {params} filled in (a missing param throws)
 *   tp(key, count, params)  plural form (key.one / key.few / key.other …), {count} filled in
 *   has(key)                true when the key exists (English counts)
 * Bot texts are plain Discord text: no HTML, Discord markup (**bold**, <t:…:F>) is kept as typed.
 */
export function botText(lang = DEFAULT_LANG) {
    const code = LANG_CODES.includes(lang) ? lang : DEFAULT_LANG;
    return {
        lang: code,
        t: (key, params) => BOT_CATALOG.translate(code, key, params),
        tp: (key, count, params = {}) => BOT_CATALOG.translate(code, BOT_CATALOG.pluralKey(code, key, count), { count: countText(code, count), ...params }),
        has: (key) => BOT_CATALOG.hasKey(code, key),
    };
}

/** Text for an answer to an interaction. purpose 'reply' (default): the user's Discord language. */
export function textForInteraction(interaction, { purpose = 'reply' } = {}) {
    return botText(resolveBotLanguage({ interaction, guildId: interaction?.guildId ?? null, member: interaction?.member ?? null, userId: interaction?.user?.id ?? null, purpose }));
}

/** Text for a DM to a member or a public post: the server's language. */
export function textForGuild(guildId, { member = null, userId = null, purpose = 'dm' } = {}) {
    return botText(resolveBotLanguage({ guildId, member, userId, purpose }));
}
