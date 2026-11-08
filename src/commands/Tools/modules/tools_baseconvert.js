import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { getColor } from '../../../config/bot.js';
import { localized, publicText } from '../../Core/modules/commandText.js';

const BASE_ALPHABETS = {
    'BIN': { base: 2, prefix: '0b', name: 'Binary', alphabet: '01' },
    'OCT': { base: 8, prefix: '0o', name: 'Octal', alphabet: '0-7' },
    'DEC': { base: 10, prefix: '', name: 'Decimal', alphabet: '0-9' },
    'HEX': { base: 16, prefix: '0x', name: 'Hexadecimal', alphabet: '0-9A-F' },
    'B64': { base: 64, prefix: 'b64:', name: 'Base64', alphabet: 'A-Za-z0-9+/=' },
    'B36': { base: 36, prefix: '', name: 'Base36', alphabet: '0-9A-Z' },
    'B58': { base: 58, prefix: '', name: 'Base58', alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz' },
    'B62': { base: 62, prefix: '', name: 'Base62', alphabet: '0-9A-Za-z' },
};

// Catalog keys of the base names (the choice names above stay English: names are not localized).
const BASE_NAME_KEYS = {
    BIN: 'tools.baseconvert.base.BIN',
    OCT: 'tools.baseconvert.base.OCT',
    DEC: 'tools.baseconvert.base.DEC',
    HEX: 'tools.baseconvert.base.HEX',
    B64: 'tools.baseconvert.base.B64',
    B36: 'tools.baseconvert.base.B36',
    B58: 'tools.baseconvert.base.B58',
    B62: 'tools.baseconvert.base.B62',
};
const EXAMPLE_KEYS = {
    BIN: 'tools.baseconvert.example.BIN',
    OCT: 'tools.baseconvert.example.OCT',
    DEC: 'tools.baseconvert.example.DEC',
    HEX: 'tools.baseconvert.example.HEX',
};

const BASE_NAMES = Object.entries(BASE_ALPHABETS).map(([key, { name }]) => ({ name: `${key} (${name})`, value: key }));
const BASE_CHARSETS = {
    BIN: '01',
    OCT: '01234567',
    DEC: '0123456789',
    HEX: '0123456789ABCDEF',
    B36: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    B58: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
    B62: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
};

function parseBigIntFromBase(value, baseKey) {
    if (baseKey === 'B64') {
        const bytes = Buffer.from(value, 'base64');
        return bytes.reduce((acc, byte) => (acc * 256n) + BigInt(byte), 0n);
    }

    const charset = BASE_CHARSETS[baseKey];
    if (!charset) {
        throw new Error(`Unsupported base: ${baseKey}`);
    }

    const normalized = ['BIN', 'OCT', 'DEC', 'HEX', 'B36'].includes(baseKey)
        ? value.toUpperCase()
        : value;

    let result = 0n;
    const base = BigInt(charset.length);

    for (const char of normalized) {
        const digit = charset.indexOf(char);
        if (digit < 0) {
            throw new Error(`Invalid character '${char}' for base ${baseKey}`);
        }
        result = (result * base) + BigInt(digit);
    }

    return result;
}

function formatBigIntToBase(value, baseKey) {
    if (baseKey === 'B64') {
        if (value === 0n) {
            return Buffer.from([0]).toString('base64');
        }

        const bytes = [];
        let n = value;
        while (n > 0n) {
            bytes.unshift(Number(n & 0xffn));
            n >>= 8n;
        }

        return Buffer.from(bytes).toString('base64');
    }

    const charset = BASE_CHARSETS[baseKey];
    if (!charset) {
        throw new Error(`Unsupported base: ${baseKey}`);
    }

    if (value === 0n) {
        return '0';
    }

    const base = BigInt(charset.length);
    let n = value;
    let output = '';

    while (n > 0n) {
        const index = Number(n % base);
        output = charset[index] + output;
        n /= base;
    }

    return output;
}

export default {
    data: new SlashCommandBuilder()
        .setName('baseconvert')
        .setDescription('Convert numbers between different bases')
        .addStringOption(option =>
            option.setName('number')
                .setDescription('The number to convert')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.baseconvert.options.number'))
                .setRequired(true))
        .addStringOption(option =>
            option.setName('from')
                .setDescription('Source base/format')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.baseconvert.options.from'))
                .setRequired(true)
                .addChoices(...BASE_NAMES))
        .addStringOption(option =>
            option.setName('to')
                .setDescription('Target base/format (default: all)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.baseconvert.options.to'))
                .setRequired(false)
                .addChoices(...BASE_NAMES)),

    async execute(interaction) {
        // The answer is posted in the channel (not ephemeral): the server's language.
        const tr = publicText(interaction);
        const nameOf = (key) => tr.t(BASE_NAME_KEYS[key]);
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`BaseConvert interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'baseconvert'
            });
            return;
        }

        const numberStr = interaction.options.getString('number').trim();
        const fromBase = interaction.options.getString('from');
        const toBase = interaction.options.getString('to');

        const { prefix: fromPrefix } = BASE_ALPHABETS[fromBase];
        const fromName = nameOf(fromBase);

        const cleanNumber = fromPrefix && numberStr.startsWith(fromPrefix)
            ? numberStr.slice(fromPrefix.length)
            : numberStr;

        if (!cleanNumber) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: tr.t('tools.baseconvert.noNumber'),
                context: { lang: tr.lang },
            });
        }

        const alphabet = BASE_ALPHABETS[fromBase].alphabet;
        const regex = new RegExp(`^[${alphabet}]+$`, 'i');

        if (!regex.test(cleanNumber)) {
            const examples = EXAMPLE_KEYS[fromBase] ? tr.t(EXAMPLE_KEYS[fromBase]) : '';
            logger.warn(`Invalid base conversion input: ${cleanNumber} for base ${fromBase}`);
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: tr.t('tools.baseconvert.badInput', { input: cleanNumber, alphabet, examples }),
                context: { lang: tr.lang },
            });
        }

        let decimalValue;
        try {
            if (fromBase === 'B64') {
                decimalValue = parseBigIntFromBase(cleanNumber, fromBase);
            } else {
                decimalValue = parseBigIntFromBase(cleanNumber, fromBase);
            }
        } catch (error) {
            logger.error('Base conversion parse error:', error);
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: tr.t('tools.baseconvert.tooLarge'),
                context: { lang: tr.lang },
            });
        }

        if (toBase) {
            const { prefix: toPrefix } = BASE_ALPHABETS[toBase];
            const toName = nameOf(toBase);
            let result;

            try {
                result = formatBigIntToBase(decimalValue, toBase);

                const embed = successEmbed(
                    tr.t('tools.baseconvert.title'),
                    tr.t('tools.baseconvert.fromTo', {
                        fromName, fromBase, from: `${fromPrefix}${cleanNumber}`, toName, toBase, to: `${toPrefix}${result}`, decimal: decimalValue.toLocaleString(),
                    }),
                );
                embed.setColor(getColor('success'));

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

            } catch (error) {
                logger.error(`Base conversion error to ${BASE_ALPHABETS[toBase].name}:`, error);
                await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: tr.t('tools.baseconvert.resultTooLarge'),
                    context: { lang: tr.lang },
                });
            }

        } else {
            let description = tr.t('tools.baseconvert.input', { fromName, from: `${fromPrefix}${cleanNumber}` });
            description += tr.t('tools.baseconvert.decimal', { decimal: decimalValue.toLocaleString() });

            for (const [baseKey, { prefix }] of Object.entries(BASE_ALPHABETS)) {
                const name = nameOf(baseKey);
                if (baseKey === fromBase) continue;

                try {
                    let value = formatBigIntToBase(decimalValue, baseKey);

                    description += tr.t('tools.baseconvert.row', { name, base: baseKey, value: `${prefix}${value}` });
                } catch (error) {
                    description += tr.t('tools.baseconvert.rowTooLarge', { name, base: baseKey });
                }
            }

            const embed = successEmbed(
                tr.t('tools.baseconvert.title'),
                description
            );
            embed.setColor(getColor('primary'));

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        }
    },
};