// commandText.js — shared text helpers for the translated commands (docs/bot-i18n.md).
//
// Lives in Core/modules (the command loader skips modules/ folders), used by Core, Utility, Tools,
// Search and Fun.
//
//   replyText(interaction)    an ephemeral / private answer: the user's Discord language. A prefix
//                             command has no locale and its answer is posted in the channel, so it
//                             gets the server's language (the owner's "mixed" rule).
//   publicText(interaction)   a post everyone in the channel sees (non-ephemeral reply, channel
//                             message): the server's language.
//   localized(key)            Discord description localizations for a catalog key: every Discord
//                             locale of our 8 languages → that language's text (for
//                             setDescriptionLocalizations; names are never localized).

import { BOT_CATALOG, LANG_CODES, textForInteraction } from '../../../utils/botText.js';

/** Our 8 languages → the Discord locales that show them. */
export const DISCORD_LOCALES = Object.freeze({
    en: ['en-US', 'en-GB'],
    ru: ['ru'],
    de: ['de'],
    fr: ['fr'],
    it: ['it'],
    pl: ['pl'],
    es: ['es-ES', 'es-419'],
    'pt-BR': ['pt-BR'],
});

/** { 'en-US': …, 'en-GB': …, ru: …, de: …, … } for a catalog key (an unknown key throws). */
export function localized(key) {
    const out = {};
    for (const lang of LANG_CODES) {
        const text = BOT_CATALOG.translate(lang, key);
        for (const locale of DISCORD_LOCALES[lang] || []) out[locale] = text;
    }
    return out;
}

/** Text for an ephemeral answer (prefix commands: the server's language, since it is posted publicly). */
export function replyText(interaction) {
    return textForInteraction(interaction, { purpose: interaction?._isPrefixCommand ? 'public' : 'reply' });
}

/** Text for a public post in the channel: the server's language. */
export function publicText(interaction) {
    return textForInteraction(interaction, { purpose: 'public' });
}
