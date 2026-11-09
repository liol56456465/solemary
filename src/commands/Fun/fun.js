import { SlashCommandBuilder } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { mergeSubcommands } from '../../utils/mergedCommand.js';
import fight from './modules/fun_fight.js';
import flip from './modules/fun_flip.js';
import roll from './modules/fun_roll.js';
import { localized, replyText } from '../../utils/commandLocalizations.js';

// /fun fight|flip|roll replaces /fight, /flip and /roll (same options).
const merged = mergeSubcommands(
    new SlashCommandBuilder().setName('fun').setDescription('Quick games: fights, coin flips and dice')
        .setDescriptionLocalizations(localized('fun.slash.fun.description')).setDMPermission(false),
    {
        fight: { module: fight, description: 'Start a simulated 1v1 text battle' },
        flip: { module: flip, description: 'Flip a coin' },
        roll: { module: roll, description: 'Roll dice (e.g. 2d20, 1d6 + 5)' },
    },
);
const { run } = merged;

// mergeSubcommands builds each subcommand from its name and English description only; the
// translated descriptions are added here (the options carry their own from the modules).
const SUB_DESCRIPTIONS = {
    fight: 'fun.slash.fun.sub.fight.description',
    flip: 'fun.slash.fun.sub.flip.description',
    roll: 'fun.slash.fun.sub.roll.description',
};
const data = {
    name: merged.data.name,
    toJSON() {
        const json = merged.data.toJSON();
        return {
            ...json,
            options: (json.options ?? []).map((option) => (SUB_DESCRIPTIONS[option.name]
                ? { ...option, description_localizations: localized(SUB_DESCRIPTIONS[option.name]) }
                : option)),
        };
    },
};

export default {
    data,
    category: 'Fun',

    async execute(interaction, config, client) {
        if (!(await run(interaction, config, client))) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: replyText(interaction).t('fun.unknownSubcommand') });
        }
    },
};
