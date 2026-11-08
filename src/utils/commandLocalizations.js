// commandLocalizations.js — Discord description localizations for slash commands, from the bot
// catalog (src/content/bot/<lang>/*.json). Names are never localized (members type them).
//
//   describe(option.setName('user'), 'leveling.cmd.rank.user')
//     → .setDescription(English text) + .setDescriptionLocalizations({ ru, de, fr, it, pl, es-ES, es-419, pt-BR })
//
// Discord allows at most 100 characters per description; tests/botCommandLocalizations.test.js checks
// every description in every language. As a last guard a longer text is cut here (never throws at boot).

import { botText } from './botText.js';

/** Our 7 non-English languages → the Discord locales that show them. */
export const DISCORD_LOCALES_BY_LANG = Object.freeze({
    ru: ['ru'], de: ['de'], fr: ['fr'], it: ['it'], pl: ['pl'], es: ['es-ES', 'es-419'], 'pt-BR': ['pt-BR'],
});
export const DESCRIPTION_LIMIT = 100;

const fit = (text) => (text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text);

/** { ru: '…', de: '…', 'es-ES': '…', 'es-419': '…', … } for one catalog key. */
export function descriptionLocalizations(key, params) {
    const out = {};
    for (const [lang, locales] of Object.entries(DISCORD_LOCALES_BY_LANG)) {
        const text = fit(botText(lang).t(key, params));
        for (const locale of locales) out[locale] = text;
    }
    return out;
}

/** The English description of a catalog key. */
export function englishDescription(key, params) {
    return fit(botText('en').t(key, params));
}

/** Sets the English description and its localizations on a command, subcommand or option builder. */
export function describe(builder, key, params) {
    return builder.setDescription(englishDescription(key, params)).setDescriptionLocalizations(descriptionLocalizations(key, params));
}
