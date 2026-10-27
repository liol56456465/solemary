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

// /tools <name> replaces the separate small tool commands (same options). Who may
// use each one is set per subcommand in commandAccess.js (randomuser is admin-only).
const { data, run } = mergeSubcommands(
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

export default {
    data,
    category: 'Tools',

    async execute(interaction, config, client) {
        if (!(await run(interaction, config, client))) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Unknown subcommand.' });
        }
    },
};
