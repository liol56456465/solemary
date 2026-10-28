import { SlashCommandBuilder } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { mergeSubcommands } from '../../utils/mergedCommand.js';
import fight from './modules/fun_fight.js';
import flip from './modules/fun_flip.js';
import roll from './modules/fun_roll.js';

// /fun fight|flip|roll replaces /fight, /flip and /roll (same options).
const { data, run } = mergeSubcommands(
    new SlashCommandBuilder().setName('fun').setDescription('Quick games: fights, coin flips and dice').setDMPermission(false),
    {
        fight: { module: fight, description: 'Start a simulated 1v1 text battle' },
        flip: { module: flip, description: 'Flip a coin' },
        roll: { module: roll, description: 'Roll dice (e.g. 2d20, 1d6 + 5)' },
    },
);

export default {
    data,
    category: 'Fun',

    async execute(interaction, config, client) {
        if (!(await run(interaction, config, client))) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Unknown subcommand.' });
        }
    },
};
