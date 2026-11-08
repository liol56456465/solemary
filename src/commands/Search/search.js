import { SlashCommandBuilder } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { localized, replyText } from '../Core/modules/commandText.js';

import searchDefine from './modules/search_define.js';
import searchGoogle from './modules/search_google.js';

export default {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search the web and dictionaries')
        .setDescriptionLocalizations(localized('search.slash.search.description'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('define')
                .setDescription('Look up a word definition')
                .setDescriptionLocalizations(localized('search.slash.search.sub.define.description'))
                .addStringOption(option =>
                    option.setName('word')
                        .setDescription('The word to look up')
                        .setDescriptionLocalizations(localized('search.slash.search.sub.define.options.word'))
                        .setRequired(true))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('google')
                .setDescription('Search Google')
                .setDescriptionLocalizations(localized('search.slash.search.sub.google.description'))
                .addStringOption(option =>
                    option.setName('query')
                        .setDescription('What would you like to search for?')
                        .setDescriptionLocalizations(localized('search.slash.search.sub.google.options.query'))
                        .setRequired(true))
        ),

    async execute(interaction, config, client) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'define':
                return await searchDefine.execute(interaction, config, client);
            case 'google':
                return await searchGoogle.execute(interaction, config, client);
            default:
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('search.unknownSubcommand') });
        }
    }
};
