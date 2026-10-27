import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { mergeSubcommands } from '../../utils/mergedCommand.js';
import createGiveaway from './modules/giveaway_create.js';
import endGiveaway from './modules/giveaway_end.js';
import rerollGiveaway from './modules/giveaway_reroll.js';
import deleteGiveaway from './modules/giveaway_delete.js';

// /giveaway create|end|reroll|delete replaces /gcreate, /gend, /greroll and /gdelete
// with the same options and behaviour.
const { data, run } = mergeSubcommands(
    new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Create and manage giveaways')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false),
    {
        create: { module: createGiveaway, description: 'Start a new giveaway in a channel' },
        end: { module: endGiveaway, description: 'End a running giveaway now and pick the winners' },
        reroll: { module: rerollGiveaway, description: 'Pick new winners for an ended giveaway' },
        delete: { module: deleteGiveaway, description: 'Delete a giveaway and its message' },
    },
);

export default {
    data,
    category: 'Giveaway',

    async execute(interaction, config, client) {
        if (!(await run(interaction, config, client))) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Unknown subcommand.' });
        }
    },
};
