import axios from 'axios';
import { createEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { BoundedMap } from '../../../utils/boundedMap.js';
import { botText } from '../../../utils/botText.js';
import { publicText, replyText } from '../../Core/modules/commandText.js';

// B5: dictionaryapi.dev is a free service. Answers are kept in an LRU of 500 words (a day; a
// word with no entry for an hour), and each user may cause one API call per DEFINE_COOLDOWN_MS
// (answers from the cache are not limited).
export const DEFINE_CACHE_SIZE = 500;
export const DEFINE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFINE_NOT_FOUND_TTL_MS = 60 * 60 * 1000;
export const DEFINE_COOLDOWN_MS = 5000;
const definitionCache = new BoundedMap(DEFINE_CACHE_SIZE); // word → { entry | null, expiresAt }
const lastApiCallByUser = new BoundedMap(5000); // userId → ms

const httpGet = (url) => axios.get(url, { timeout: 5000 });

/**
 * The dictionary entry for a word: { entry } (entry null when the word has none) or
 * { cooldownMs } when this user must wait before the next API call. Other errors throw.
 */
export async function lookupDefinition(word, userId, { get = httpGet, now = Date.now() } = {}) {
    const key = String(word).trim().toLowerCase();
    const cached = definitionCache.get(key);
    if (cached && cached.expiresAt > now) {
        definitionCache.set(key, cached); // LRU: a used word stays
        return { entry: cached.entry, cached: true };
    }
    if (cached) definitionCache.delete(key);

    const last = lastApiCallByUser.get(String(userId));
    if (last !== undefined && now - last < DEFINE_COOLDOWN_MS) {
        return { cooldownMs: DEFINE_COOLDOWN_MS - (now - last) };
    }
    lastApiCallByUser.set(String(userId), now);

    let entry = null;
    try {
        const response = await get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`);
        entry = Array.isArray(response?.data) && response.data.length ? response.data[0] : null;
    } catch (error) {
        if (error?.response?.status !== 404) throw error; // outages are not cached
    }
    definitionCache.set(key, { entry, expiresAt: now + (entry ? DEFINE_CACHE_TTL_MS : DEFINE_NOT_FOUND_TTL_MS) });
    return { entry, cached: false };
}

/** Tests only. */
export function resetDefineCache() {
    definitionCache.clear();
    lastApiCallByUser.clear();
}

export default {
    async execute(interaction) {
        try {
            const deferred = await InteractionHelper.safeDefer(interaction);
            if (!deferred) {
                return;
            }

            const word = interaction.options.getString('word');
            // Errors are private answers (the user's language); the definition is a public reply (the
            // server's). The definitions themselves come from an English dictionary and stay English.
            const err = replyText(interaction);

            if (word.length < 2) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: err.t('search.define.tooShort') });
            }

            const result = await lookupDefinition(word, interaction.user.id);
            if (result.cooldownMs) {
                return await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: err.t('search.define.cooldown', { seconds: Math.ceil(result.cooldownMs / 1000) }) });
            }
            if (!result.entry) {
                return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: err.t('search.define.notFound', { word }) });
            }

            const tr = publicText(interaction);
            const data = result.entry;
            const embed = createEmbed({
                title: data.word,
                description: data.phonetic ? `*${data.phonetic}*` : '',
                color: 'success'
            });

            (data.meanings || []).slice(0, 5).forEach(meaning => {
                const definitions = meaning.definitions
                    .slice(0, 3)
                    .map((def, idx) => {
                        let text = `${idx + 1}. ${def.definition}`;
                        if (def.example) {
                            text += tr.t('search.define.example', { example: def.example });
                        }
                        return text;
                    })
                    .join('\n\n')
                    .slice(0, 1024); // embed field values are capped at 1024 chars

                if (definitions) {
                    embed.addFields({
                        name: `**${meaning.partOfSpeech || tr.t('search.define.definition')}**`,
                        value: definitions,
                        inline: false
                    });
                }
            });

            const credit = wiktionaryCredit(data, { lang: tr.lang });
            embed.addFields({ name: tr.t('search.define.source'), value: credit.line, inline: false });
            embed.setFooter({ text: tr.t('search.define.footer', { credit: credit.footer }) });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed], allowedMentions: { parse: [] } });

            logger.debug('Dictionary definition sent', { guildId: interaction.guildId, cached: result.cached, commandName: 'define' });

        } catch (error) {
            logger.error('Dictionary lookup error', {
                error: error.message,
                stack: error.stack,
                guildId: interaction.guildId,
                commandName: 'define'
            });

            await handleInteractionError(interaction, error, {
                commandName: 'define',
                source: 'dictionary_api'
            });
        }
    },
};

const DEFAULT_LICENSE = { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0' };

/**
 * Wiktionary credit for a dictionaryapi.dev entry. The API passes on Wiktionary's licence
 * (`license: { name, url }`) and the page it used (`sourceUrls`); CC BY-SA needs both shown.
 */
export function wiktionaryCredit(entry, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const license = entry?.license?.name ? entry.license : DEFAULT_LICENSE;
    const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s<>()]+$/.test(u) ? u : null);
    const licenseUrl = safeUrl(license.url) || DEFAULT_LICENSE.url;
    const source = safeUrl(Array.isArray(entry?.sourceUrls) ? entry.sourceUrls[0] : null);
    const wiktionary = source ? `[Wiktionary](${source})` : 'Wiktionary';
    const name = String(license.name).replace(/[[\]()]/g, '').slice(0, 40);
    return {
        line: tr.t('search.define.creditLine', { wiktionary, license: `[${name}](${licenseUrl})` }).slice(0, 1024),
        footer: tr.t('search.define.creditFooter'),
    };
}
