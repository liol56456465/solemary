// botText.js — the bot's own messages in 8 languages (en, ru, de, fr, it, pl, es, pt-BR).
//
// Text lives in src/content/bot/<lang>/<namespace>.json (same format, plurals and placeholder
// rules as the website and dashboard catalogs; read by the same core, services/site/i18n.js).
// See docs/bot-i18n.md for how to translate a command.
//
// Which language (owner's "mixed" rule), decided in ONE place: resolveBotLanguage().
//   step 1 (purposes 'reply', 'dm', 'member'): the member's language role (setting
//                            languageRoles, /language), when a member object is passed
//   step 2 (purposes 'reply', 'dm'): the member's personal language (services/personalLanguage.js:
//                            /language without a role for it, or the website), by user id
//   purpose 'reply'          an ephemeral / private answer to the person who ran the command:
//                            their Discord language (interaction.locale). A prefix command's
//                            answer is a channel post: the server's language.
//   purpose 'member'         a public post addressed to ONE member (counting notice, level-up,
//                            welcome, a single birthday wish ...): the server's language
//   purpose 'dm' | 'public'  a DM to a member (punishments, appeal results ...) or a channel-wide
//                            post (panels, giveaways, mod log): the server's language (setting
//                            botLanguage, Dashboard -> Bot language). Not chosen yet: in a
//                            server other than Mewvo's own, the server's Discord language
//                            (guild.preferredLocale) when it is one of the 8; else English.
//                            'public' never looks at a language role.
// Anything unknown (a Discord language we don't have, no server) is English.

import { fileURLToPath } from 'node:url';
import { DEFAULT_LANG, LANG_CODES, createCatalog, formatNumberIn } from '../services/site/i18n.js';
import { languageFromDiscordLocale } from '../services/dashboard/language.js';
import { isHomeGuild, resolveSetting, resolvedSource } from '../services/settings/guildSettings.js';
import { logger } from './logger.js';
import { personalLanguageOf } from '../services/personalLanguage.js';

export { LANG_CODES };
export const BOT_LANGUAGE_KEY = 'botLanguage';
export const BOT_PURPOSES = Object.freeze(['reply', 'dm', 'member', 'public']);
export const LANGUAGE_ROLES_KEY = 'languageRoles';
/** Purposes where a member's language role wins (a channel-wide 'public' post never). */
const MEMBER_PURPOSES = new Set(['reply', 'dm', 'member']);
/**
 * Purposes where the member's personal language (no role) counts: what only they read (DMs,
 * private answers). A post in a channel for one member ('member') keeps the server's language.
 */
const PERSONAL_PURPOSES = new Set(['reply', 'dm']);

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
    languageRolesReadFailed = false;
}

// guildId → the server's Discord language (guild.preferredLocale), from the client's guild cache.
// app.js sets it at startup (setGuildLocaleResolver); without it (tests, scripts) there is none.
let guildLocaleOf = () => null;
/** app.js: how to find a server's Discord language (preferredLocale) by id. */
export function setGuildLocaleResolver(fn) {
    guildLocaleOf = typeof fn === 'function' ? fn : () => null;
}

/**
 * The language Mewvo detects for a server that never chose one: its Discord language
 * (guild.preferredLocale: a Community server's primary language, else 'en-US') when it is one
 * of the 8, else null. `locale` replaces the guild cache lookup.
 */
export function detectedServerLanguage(guildId, { locale } = {}) {
    let value = locale;
    if (value === undefined) {
        try {
            value = guildLocaleOf(String(guildId));
        } catch {
            value = null;
        }
    }
    return languageFromDiscordLocale(value) || null;
}

/**
 * The language of a server's public posts and member DMs. Order:
 *   1. the saved setting (Dashboard -> Bot language)
 *   2. nothing saved, in a server other than Mewvo's own: the server's Discord language
 *      (detectedServerLanguage). Nothing is written: it is read every time until an admin saves
 *      a language, so servers that added Mewvo before this existed get it too.
 *   3. English
 * Mewvo's own servers keep stored -> English, as before.
 *
 * `resolve` (tests) replaces resolveSetting; `source` replaces resolvedSource (with `resolve`
 * and no `source`, step 2 is skipped); `locale` replaces the guild cache lookup.
 *
 * The one place where a default on a database error is fine: the language is cosmetic, and a
 * punishment DM or an error reply must still go out when the settings cannot be read. So any
 * error here (database down at boot, an unknown server, a bad stored value) gives English and is
 * logged once per failing stretch (the next good read resets it), not on every message. Everywhere else the data-layer rule stands:
 * reads throw on a database error, never return defaults (CLAUDE.md "Data layer rules").
 */
export function serverLanguage(guildId, { resolve, source, locale, isHome = isHomeGuild } = {}) {
    if (!guildId) return DEFAULT_LANG;
    const id = String(guildId);
    const read = resolve || resolveSetting;
    const sourceOf = source || (resolve ? null : resolvedSource);
    try {
        const value = read(id, BOT_LANGUAGE_KEY);
        const saved = !sourceOf || isHome(id) || sourceOf(id, BOT_LANGUAGE_KEY) === 'database';
        languageReadFailed = false; // a later failure (e.g. a real outage) is logged again
        if (!saved) {
            const detected = detectedServerLanguage(id, { locale });
            if (detected) return detected;
        }
        return LANG_CODES.includes(value) ? value : DEFAULT_LANG;
    } catch (error) {
        if (!languageReadFailed) {
            languageReadFailed = true;
            logger.warn(`Bot language of server ${guildId} could not be read (${error?.message || error}); using English. Logged once until a read works again.`);
        }
        return DEFAULT_LANG;
    }
}

let languageRolesReadFailed = false;

/** The personal language step: never throws (a broken lookup means the next step decides). */
function personalOf(personal, userId) {
    try {
        const code = personal(String(userId));
        return LANG_CODES.includes(code) ? code : null;
    } catch (error) {
        logger.debug(`Personal language of ${userId} not read: ${error?.message || error}`);
        return null;
    }
}

/** The member's role ids (a GuildMember: roles.cache; an API member: roles is an array of ids). */
function memberRoleIds(member) {
    const roles = member?.roles;
    if (!roles) return null;
    if (Array.isArray(roles)) return new Set(roles.map(String));
    if (roles.cache && typeof roles.cache.has === 'function') return { has: (id) => roles.cache.has(id) };
    return null;
}

/**
 * The language a member chose through a language role in this server, or null (no member, no
 * role, no setting). Several language roles: Discord does not tell when a role was added, so a
 * fixed order decides (the order of LANG_CODES: en, ru, de, fr, it, pl, es, pt-BR); /language
 * itself always leaves exactly one. Like serverLanguage, a failed settings read is cosmetic:
 * it gives null (the next step decides) and is logged once per failing stretch.
 */
export function memberLanguage(guildId, member, { resolve = resolveSetting } = {}) {
    if (!guildId || !member) return null;
    const ids = memberRoleIds(member);
    if (!ids) return null;
    let map;
    try {
        map = resolve(String(guildId), LANGUAGE_ROLES_KEY);
        languageRolesReadFailed = false;
    } catch (error) {
        if (!languageRolesReadFailed) {
            languageRolesReadFailed = true;
            logger.warn(`Language roles of server ${guildId} could not be read (${error?.message || error}); using the next language step. Logged once until a read works again.`);
        }
        return null;
    }
    if (!map || typeof map !== 'object') return null;
    for (const code of LANG_CODES) {
        const roleId = map[code];
        if (roleId && ids.has(String(roleId))) return code;
    }
    return null;
}

/**
 * The language of one bot message. Every bot text goes through this.
 * @param {object} p
 * @param {string|null} [p.guildId]   the server the message is about (DMs: the server that acted)
 * @param {object|null} [p.member]    the member it is for, when known: their language role wins
 *                                    (purposes 'reply', 'dm', 'member')
 * @param {string|null} [p.userId]    the user it is for, when there is no member object (no
 *                                    role lookup without a member: the next step decides)
 * @param {object|null} [p.interaction]  the interaction being answered (reply: its locale)
 * @param {'reply'|'dm'|'member'|'public'} [p.purpose]
 * @param {object} [p.resolve]        tests: replaces resolveSetting
 * @param {Function} [p.personal]     tests: replaces personalLanguageOf (userId → code | null)
 */
export function resolveBotLanguage({ guildId = null, member = null, userId = null, interaction = null, purpose = 'reply', resolve, personal = personalLanguageOf } = {}) {
    const opts = resolve ? { resolve } : {};
    const guild = guildId ?? interaction?.guildId ?? null;
    const who = member ?? (purpose === 'reply' ? interaction?.member ?? null : null);
    if (MEMBER_PURPOSES.has(purpose)) {
        const chosen = memberLanguage(guild, who, opts);
        if (chosen) return chosen;
    }
    // A prefix command's answer is a channel post, not a private one: no personal language.
    if (PERSONAL_PURPOSES.has(purpose) && !(purpose === 'reply' && interaction?._isPrefixCommand)) {
        const id = userId ?? who?.id ?? who?.user?.id ?? (purpose === 'reply' ? interaction?.user?.id : null) ?? null;
        const own = id ? personalOf(personal, id) : null;
        if (own) return own;
    }
    // A prefix command's "reply" is a message in the channel (no locale): the server's language.
    if (purpose === 'reply' && !interaction?._isPrefixCommand) return languageFromLocale(interaction?.locale);
    return serverLanguage(guild, opts);
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

/** Text for a DM to a member ('dm'), a post for one member ('member', pass `member`) or a channel post ('public'). */
export function textForGuild(guildId, { member = null, userId = null, purpose = 'dm' } = {}) {
    return botText(resolveBotLanguage({ guildId, member, userId, purpose }));
}
