// /cat view | name — the Mewvo server cat (services/community/catService.js).
// view: everyone (commandAccess.js). name: Administrator-only (not listed there, so the
// dispatcher's gate refuses everyone else before execute runs).

import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { updateSettings } from '../../services/settings/guildSettings.js';
import { CAT_NAME_MAX, catAttachment, catEmbed, getServerCat, sanitizeCatName } from '../../services/community/catService.js';

const DB_DOWN = 'The database is not responding right now, so the cat could not be loaded. Please try again in a moment.';

/** The /cat view reply for a server (tests pass `deps` for getServerCat). Throws a user-facing error when the read fails. */
export async function catViewReply(guildId, deps = {}) {
    let cat;
    try {
        cat = await getServerCat(guildId, deps);
    } catch (error) {
        logger.warn(`/cat view: could not read the cat of ${guildId}: ${error.message}`);
        throw createError(`Cat read failed: ${error.message}`, ErrorTypes.DATABASE, DB_DOWN, { expected: true });
    }
    return { embeds: [catEmbed(cat)], files: [catAttachment(cat)], allowedMentions: { parse: [] } };
}

export default {
    slashOnly: true,
    category: 'Community',
    data: new SlashCommandBuilder()
        .setName('cat')
        .setDescription('The server cat, which grows as members chat')
        .addSubcommand((sub) => sub.setName('view').setDescription('See the server cat, its mood and how close it is to growing'))
        .addSubcommand((sub) => sub.setName('name').setDescription('Rename the server cat (administrators)')
            .addStringOption((option) => option.setName('name').setDescription('The new name').setRequired(true).setMaxLength(CAT_NAME_MAX)))
        .setDMPermission(false),

    async execute(interaction, guildConfig, client, deps = {}) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'view') {
            const deferred = await InteractionHelper.safeDefer(interaction);
            if (!deferred) return;
            return InteractionHelper.safeEditReply(interaction, await catViewReply(interaction.guildId, deps));
        }
        if (sub === 'name') {
            const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
            if (!deferred) return;
            const name = sanitizeCatName(interaction.options.getString('name', true));
            if (!name) {
                throw createError('Empty cat name', ErrorTypes.USER_INPUT, 'Use letters, numbers and spaces for the name.', { expected: true });
            }
            const save = deps.updateSettings || updateSettings;
            try {
                await save(interaction.guildId, { catName: name }, { userId: interaction.user.id, username: interaction.user.username, module: 'leveling' });
            } catch (error) {
                if (error.userMessage) throw createError(error.message, ErrorTypes.USER_INPUT, error.userMessage, { expected: true });
                throw createError(`Cat name not saved: ${error.message}`, ErrorTypes.DATABASE, 'The database is not responding right now, so nothing was changed.', { expected: true });
            }
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed('Cat renamed', `The server cat is now called ${name}.`)],
                allowedMentions: { parse: [] },
            });
        }
    },
};
