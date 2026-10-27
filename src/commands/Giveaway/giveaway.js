import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import createGiveaway from './modules/giveaway_create.js';
import endGiveaway from './modules/giveaway_end.js';
import rerollGiveaway from './modules/giveaway_reroll.js';
import deleteGiveaway from './modules/giveaway_delete.js';

// /giveaway create|end|reroll|delete replaces /gcreate, /gend, /greroll and
// /gdelete. Each subcommand keeps the old command's options and behaviour: its
// options are taken from that module's own builder.
const SUBCOMMANDS = {
    create: { module: createGiveaway, description: 'Start a new giveaway in a channel' },
    end: { module: endGiveaway, description: 'End a running giveaway now and pick the winners' },
    reroll: { module: rerollGiveaway, description: 'Pick new winners for an ended giveaway' },
    delete: { module: deleteGiveaway, description: 'Delete a giveaway and its message' },
};

const builder = new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Create and manage giveaways')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

const SUBCOMMAND_TYPE = 1;

export default {
    data: {
        name: 'giveaway',
        toJSON: () => ({
            ...builder.toJSON(),
            options: Object.entries(SUBCOMMANDS).map(([name, { module, description }]) => ({
                type: SUBCOMMAND_TYPE,
                name,
                description,
                options: module.data.toJSON().options ?? [],
            })),
        }),
    },
    category: 'Giveaway',

    async execute(interaction, config, client) {
        const entry = SUBCOMMANDS[interaction.options.getSubcommand()];
        if (!entry) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Unknown subcommand.' });
        }
        return entry.module.execute(interaction, config, client);
    },
};
