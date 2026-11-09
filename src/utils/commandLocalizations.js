// commandLocalizations.js — the shared text helpers of slash commands (docs/bot-i18n.md), from the
// bot catalog (src/content/bot/<lang>/*.json). Names are never localized (members type them).
//
// Descriptions (Discord shows the one for the member's client language):
//   describe(option.setName('user'), 'leveling.cmd.rank.user')
//     → .setDescription(English text) + .setDescriptionLocalizations({ ru, de, fr, it, pl, es-ES, es-419, pt-BR })
//   descriptionLocalizations(key, params)   the 7 non-English languages' Discord locales → text
//   localized(key)                          the same plus en-US / en-GB (English twice)
//
// Answers:
//   replyText(interaction)    an ephemeral / private answer: the user's Discord language. A prefix
//                             command has no locale and its answer is posted in the channel, so it
//                             gets the server's language (the owner's "mixed" rule).
//   publicText(interaction)   a post everyone in the channel sees (non-ephemeral reply, channel
//                             message): the server's language.
//
// Discord allows at most 100 characters per description; every description in every language is
// checked by tests/botI18nCommands.test.js, tests/botI18nUsage.test.js and the other
// tests/botI18n*.test.js files of each command group. As a last guard a longer text is cut here
// (never throws at boot). An unknown catalog key throws.

import { botText, textForInteraction } from './botText.js';

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

/** Our 7 non-English languages → the Discord locales that show them (English is the default description). */
export const DISCORD_LOCALES_BY_LANG = Object.freeze(Object.fromEntries(
    Object.entries(DISCORD_LOCALES).filter(([lang]) => lang !== 'en'),
));
export const DESCRIPTION_LIMIT = 100;

const fit = (text) => (text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text);

/** { ru: '…', de: '…', 'es-ES': '…', 'es-419': '…', … } for one catalog key; with includeEnglish also en-US / en-GB. */
export function descriptionLocalizations(key, params, { includeEnglish = false } = {}) {
    const out = {};
    for (const [lang, locales] of Object.entries(includeEnglish ? DISCORD_LOCALES : DISCORD_LOCALES_BY_LANG)) {
        const text = fit(botText(lang).t(key, params));
        for (const locale of locales) out[locale] = text;
    }
    return out;
}

/** { 'en-US': …, 'en-GB': …, ru: …, de: …, … }: every Discord locale of our 8 languages. */
export function localized(key, params) {
    return descriptionLocalizations(key, params, { includeEnglish: true });
}

/** The English description of a catalog key. */
export function englishDescription(key, params) {
    return fit(botText('en').t(key, params));
}

/** Sets the English description and its localizations on a command, subcommand or option builder. */
export function describe(builder, key, params) {
    return builder.setDescription(englishDescription(key, params)).setDescriptionLocalizations(descriptionLocalizations(key, params));
}

/** Text for an ephemeral answer (prefix commands: the server's language, since it is posted publicly). */
export function replyText(interaction) {
    return textForInteraction(interaction, { purpose: interaction?._isPrefixCommand ? 'public' : 'reply' });
}

/** Text for a public post in the channel: the server's language. */
export function publicText(interaction) {
    return textForInteraction(interaction, { purpose: 'public' });
}
