import { SlashCommandBuilder } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { mergeSubcommands } from '../../utils/mergedCommand.js';
import baseconvert from './modules/tools_baseconvert.js';
import calculate from './modules/tools_calculate.js';
import generatepassword from './modules/tools_generatepassword.js';
import hexcolor from './modules/tools_hexcolor.js';
import randomuser from './modules/tools_randomuser.js';
import time from './modules/tools_time.js';
import unixtime from './modules/tools_unixtime.js';
import { localized, replyText } from '../Core/modules/commandText.js';

// /tools <name> replaces the separate small tool commands (same options). Who may
// use each one is set per subcommand in commandAccess.js (randomuser is admin-only).
const merged = mergeSubcommands(
    new SlashCommandBuilder().setName('tools').setDescription('Small utilities: calculator, converters, passwords and more').setDMPermission(false),
    {
        calculate: { module: calculate, description: 'Evaluate a math expression' },
        baseconvert: { module: baseconvert, description: 'Convert numbers between bases' },
        hexcolor: { module: hexcolor, description: 'Random hex color with preview' },
        generatepassword: { module: generatepassword, description: 'Generate a strong random password' },
        time: { module: time, description: 'Current time in different timezones' },
        unixtime: { module: unixtime, description: 'Current Unix timestamp' },
        randomuser: { module: randomuser, description: 'Pick a random member' },
    },
);
const { run } = merged;

// The merged subcommands get their description localizations here (mergeSubcommands builds them
// from the English text above); their options carry their own (set in each module).
const SUB_DESCRIPTION_KEYS = {
    calculate: 'tools.slash.tools.sub.calculate.description',
    baseconvert: 'tools.slash.tools.sub.baseconvert.description',
    hexcolor: 'tools.slash.tools.sub.hexcolor.description',
    generatepassword: 'tools.slash.tools.sub.generatepassword.description',
    time: 'tools.slash.tools.sub.time.description',
    unixtime: 'tools.slash.tools.sub.unixtime.description',
    randomuser: 'tools.slash.tools.sub.randomuser.description',
};
const data = {
    name: merged.data.name,
    toJSON() {
        const json = merged.data.toJSON();
        return {
            ...json,
            description_localizations: localized('tools.slash.tools.description'),
            options: (json.options ?? []).map((option) => (SUB_DESCRIPTION_KEYS[option.name]
                ? { ...option, description_localizations: localized(SUB_DESCRIPTION_KEYS[option.name]) }
                : option)),
        };
    },
};

export default {
    data,
    category: 'Tools',

    async execute(interaction, config, client) {
        if (!(await run(interaction, config, client))) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: replyText(interaction).t('tools.common.unknownSubcommand') });
        }
    },
};
