import { randomInt } from 'node:crypto';
import { getColor } from '../../../config/bot.js';
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { localized, replyText } from '../../Core/modules/commandText.js';
export default {
    data: new SlashCommandBuilder()
        .setName('generatepassword')
        .setDescription('Generate a strong, random password')
        .addIntegerOption(option =>
            option.setName('length')
                .setDescription('Password length (default: 16, max: 50)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.generatepassword.options.length'))
                .setMinValue(8)
                .setMaxValue(50)
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('uppercase')
                .setDescription('Include uppercase letters (A-Z)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.generatepassword.options.uppercase'))
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('numbers')
                .setDescription('Include numbers (0-9)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.generatepassword.options.numbers'))
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('symbols')
                .setDescription('Include symbols (!@#$%^&*)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.generatepassword.options.symbols'))
                .setRequired(false)),

    async execute(interaction) {
        const tr = replyText(interaction);
        const deferSuccess = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral
        });

        if (!deferSuccess) {
            logger.warn('GeneratePassword interaction defer failed', {
                userId: interaction.user?.id,
                guildId: interaction.guildId,
                commandName: 'generatepassword'
            });
            return;
        }

        const length = interaction.options.getInteger('length') || 16;
        const includeUppercase = interaction.options.getBoolean('uppercase') ?? true;
        const includeNumbers = interaction.options.getBoolean('numbers') ?? true;
        const includeSymbols = interaction.options.getBoolean('symbols') ?? true;

        if (length < 8 || length > 50) {
            await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('tools.password.badLength', { length }), context: { lang: tr.lang } });
            return;
        }

        const lowercase = 'abcdefghijklmnopqrstuvwxyz';
        const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const numbers = '0123456789';
        const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';

        let chars = lowercase;
        if (includeUppercase) chars += uppercase;
        if (includeNumbers) chars += numbers;
        if (includeSymbols) chars += symbols;

        // randomInt: cryptographic and without modulo bias.
        let password = '';
        for (let i = 0; i < length; i++) {
            password += chars[randomInt(chars.length)];
        }

        if (includeUppercase && !/[A-Z]/.test(password)) {
            const randomIndex = randomInt(length);
            const randomUpper = uppercase[randomInt(uppercase.length)];
            password = password.substring(0, randomIndex) + randomUpper + password.substring(randomIndex + 1);
        }

        if (includeNumbers && !/[0-9]/.test(password)) {
            const randomIndex = randomInt(length);
            const randomNumber = numbers[randomInt(numbers.length)];
            password = password.substring(0, randomIndex) + randomNumber + password.substring(randomIndex + 1);
        }

        if (includeSymbols && !/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password)) {
            const randomIndex = randomInt(length);
            const randomSymbol = symbols[randomInt(symbols.length)];
            password = password.substring(0, randomIndex) + randomSymbol + password.substring(randomIndex + 1);
        }

        let strength = tr.t('tools.password.strength.weak');
        let strengthColor = getColor('error');

        const hasLower = /[a-z]/.test(password);
        const hasUpper = /[A-Z]/.test(password);
        const hasNumber = /[0-9]/.test(password);
        const hasSymbol = /[^a-zA-Z0-9]/.test(password);

        const uniqueChars = new Set(password).size;
        const uniqueRatio = uniqueChars / password.length;

        let score = 0;
        score += password.length * 4;
        score += (password.length - (password.match(/[a-z]/g) || []).length) * 2;
        score += (password.length - (password.match(/[A-Z]/g) || []).length) * 2;
        score += (password.match(/[0-9]/g) || []).length * 4;
        score += (password.match(/[^a-zA-Z0-9]/g) || []).length * 6;

        if (uniqueRatio < 0.5) score *= 0.7;
        if (hasLower && hasUpper) score *= 1.2;
        if (hasNumber) score *= 1.2;
        if (hasSymbol) score *= 1.3;

        if (score > 80) {
            strength = tr.t('tools.password.strength.veryStrong');
            strengthColor = getColor('success');
        } else if (score > 60) {
            strength = tr.t('tools.password.strength.strong');
            strengthColor = getColor('success');
        } else if (score > 40) {
            strength = tr.t('tools.password.strength.good');
            strengthColor = getColor('warning');
        } else if (score > 20) {
            strength = tr.t('tools.password.strength.weak');
            strengthColor = getColor('warning');
        }

        const contains = `${hasLower ? tr.t('tools.password.lowercase') : ''}${hasUpper ? `, ${tr.t('tools.password.uppercase')}` : ''}`
            + `${hasNumber ? `, ${tr.t('tools.password.numbers')}` : ''}${hasSymbol ? `, ${tr.t('tools.password.symbols')}` : ''}`;
        const embed = successEmbed(
            tr.t('tools.password.title'),
            tr.t('tools.password.body', { password, length: tr.tp('tools.password.characters', password.length), strength, contains }),
        ).setColor(strengthColor);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed],
        });
    },
};