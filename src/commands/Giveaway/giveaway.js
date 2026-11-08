import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { mergeSubcommands } from '../../utils/mergedCommand.js';
import { describe, descriptionLocalizations, englishDescription } from '../../utils/commandLocalizations.js';
import { textForInteraction } from '../../utils/botText.js';
import createGiveaway from './modules/giveaway_create.js';
import endGiveaway from './modules/giveaway_end.js';
import rerollGiveaway from './modules/giveaway_reroll.js';
import deleteGiveaway from './modules/giveaway_delete.js';

// The subcommand descriptions (catalog keys); mergeSubcommands takes the English text,
// the localizations are added to its JSON below.
const SUBCOMMAND_KEYS = {
    create: 'giveaway.cmd.create',
    end: 'giveaway.cmd.end',
    reroll: 'giveaway.cmd.reroll',
    delete: 'giveaway.cmd.delete',
};

// /giveaway create|end|reroll|delete replaces /gcreate, /gend, /greroll and /gdelete
// with the same options and behaviour.
const merged = mergeSubcommands(
    describe(new SlashCommandBuilder().setName('giveaway'), 'giveaway.cmd.giveaway')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false),
    {
        create: { module: createGiveaway, description: englishDescription(SUBCOMMAND_KEYS.create) },
        end: { module: endGiveaway, description: englishDescription(SUBCOMMAND_KEYS.end) },
        reroll: { module: rerollGiveaway, description: englishDescription(SUBCOMMAND_KEYS.reroll) },
        delete: { module: deleteGiveaway, description: englishDescription(SUBCOMMAND_KEYS.delete) },
    },
);
const { run } = merged;
const data = {
    name: merged.data.name,
    toJSON() {
        const json = merged.data.toJSON();
        return {
            ...json,
            options: (json.options ?? []).map((option) => (SUBCOMMAND_KEYS[option.name]
                ? { ...option, description_localizations: descriptionLocalizations(SUBCOMMAND_KEYS[option.name]) }
                : option)),
        };
    },
};

export default {
    data,
    category: 'Giveaway',

    async execute(interaction, config, client) {
        if (!(await run(interaction, config, client))) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: textForInteraction(interaction).t('giveaway.unknownSubcommand') });
        }
    },
};
