import axios from 'axios';
import { createEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';

export default {
    async execute(interaction) {
        try {
            const deferred = await InteractionHelper.safeDefer(interaction);
            if (!deferred) {
                return;
            }

            const word = interaction.options.getString('word');

            if (word.length < 2) {
                logger.warn('Define command - word too short', {
                    userId: interaction.user.id,
                    word: word,
                    guildId: interaction.guildId
                });
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Please enter a word with at least 2 characters.' });
            }

            const response = await axios.get(
                `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
                { timeout: 5000 }
            );

            if (!response.data || response.data.length === 0) {
                return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: `No definitions found for "${word}".` });
            }

            const data = response.data[0];
            const embed = createEmbed({
                title: data.word,
                description: data.phonetic ? `*${data.phonetic}*` : '',
                color: 'success'
            });

            data.meanings.slice(0, 5).forEach(meaning => {
                const definitions = meaning.definitions
                    .slice(0, 3)
                    .map((def, idx) => {
                        let text = `${idx + 1}. ${def.definition}`;
                        if (def.example) {
                            text += `\n *Example: ${def.example}*`;
                        }
                        return text;
                    })
                    .join('\n\n')
                    .slice(0, 1024); // embed field values are capped at 1024 chars

                if (definitions) {
                    embed.addFields({
                        name: `**${meaning.partOfSpeech || 'Definition'}**`,
                        value: definitions,
                        inline: false
                    });
                }
            });

            const credit = wiktionaryCredit(data);
            embed.addFields({ name: 'Source', value: credit.line, inline: false });
            embed.setFooter({ text: `${credit.footer} · via Free Dictionary API` });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed], allowedMentions: { parse: [] } });

            logger.info('Dictionary definition retrieved', {
                userId: interaction.user.id,
                word: word,
                guildId: interaction.guildId,
                commandName: 'define'
            });

        } catch (error) {
            logger.error('Dictionary lookup error', {
                error: error.message,
                stack: error.stack,
                userId: interaction.user.id,
                word: interaction.options.getString('word'),
                guildId: interaction.guildId,
                commandName: 'define'
            });

            if (error.response?.status === 404) {
                await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: `No definitions found for "${interaction.options.getString('word')}".` });
            } else {
                await handleInteractionError(interaction, error, {
                    commandName: 'define',
                    source: 'dictionary_api'
                });
            }
        }
    },
};

const DEFAULT_LICENSE = { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0' };

/**
 * Wiktionary credit for a dictionaryapi.dev entry. The API passes on Wiktionary's licence
 * (`license: { name, url }`) and the page it used (`sourceUrls`); CC BY-SA needs both shown.
 */
export function wiktionaryCredit(entry) {
    const license = entry?.license?.name ? entry.license : DEFAULT_LICENSE;
    const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s<>()]+$/.test(u) ? u : null);
    const licenseUrl = safeUrl(license.url) || DEFAULT_LICENSE.url;
    const source = safeUrl(Array.isArray(entry?.sourceUrls) ? entry.sourceUrls[0] : null);
    const wiktionary = source ? `[Wiktionary](${source})` : 'Wiktionary';
    const name = String(license.name).replace(/[[\]()]/g, '').slice(0, 40);
    return {
        line: `Definitions from ${wiktionary} ([${name}](${licenseUrl}))`.slice(0, 1024),
        footer: 'Definitions from Wiktionary (CC BY-SA)',
    };
}
