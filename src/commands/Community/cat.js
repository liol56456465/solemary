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
import { botText, textForInteraction } from '../../utils/botText.js';
import { describe } from '../../utils/commandLocalizations.js';

/**
 * The /cat view reply for a server (tests pass `deps` for getServerCat). Throws a user-facing error when the read fails.
 * lang: the embed's language (a public post: the server's); errorLang: the error reply's (the user's).
 */
export async function catViewReply(guildId, deps = {}, { lang = 'en', errorLang = lang } = {}) {
    let cat;
    try {
        cat = await getServerCat(guildId, deps);
    } catch (error) {
        logger.warn(`/cat view: could not read the cat of ${guildId}: ${error.message}`);
        throw createError(`Cat read failed: ${error.message}`, ErrorTypes.DATABASE, botText(errorLang).t('community.cat.dbDown'), { expected: true });
    }
    return { embeds: [catEmbed(cat, { lang })], files: [catAttachment(cat)], allowedMentions: { parse: [] } };
}

export default {
    slashOnly: true,
    category: 'Community',
    data: describe(new SlashCommandBuilder()
        .setName('cat'), 'community.cmd.cat.desc')
        .addSubcommand((sub) => describe(sub.setName('view'), 'community.cmd.cat.view'))
        .addSubcommand((sub) => describe(sub.setName('name'), 'community.cmd.cat.name')
            .addStringOption((option) => describe(option.setName('name'), 'community.cmd.cat.newName').setRequired(true).setMaxLength(CAT_NAME_MAX)))
        .setDMPermission(false),

    async execute(interaction, guildConfig, client, deps = {}) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'view') {
            const deferred = await InteractionHelper.safeDefer(interaction);
            if (!deferred) return;
            // A public reply: the embed in the server's language, an error in the user's.
            const lang = textForInteraction(interaction, { purpose: 'public' }).lang;
            return InteractionHelper.safeEditReply(interaction, await catViewReply(interaction.guildId, deps, { lang, errorLang: textForInteraction(interaction).lang }));
        }
        if (sub === 'name') {
            const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
            if (!deferred) return;
            const tr = textForInteraction(interaction);
            const name = sanitizeCatName(interaction.options.getString('name', true));
            if (!name) {
                throw createError('Empty cat name', ErrorTypes.USER_INPUT, tr.t('community.cat.nameInvalid'), { expected: true });
            }
            const save = deps.updateSettings || updateSettings;
            try {
                await save(interaction.guildId, { catName: name }, { userId: interaction.user.id, username: interaction.user.username, module: 'leveling' });
            } catch (error) {
                if (error.userMessage) throw createError(error.message, ErrorTypes.USER_INPUT, error.userMessage, { expected: true });
                throw createError(`Cat name not saved: ${error.message}`, ErrorTypes.DATABASE, tr.t('community.cat.notSaved'), { expected: true });
            }
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(tr.t('community.cat.renamedTitle'), tr.t('community.cat.renamed', { name }))],
                allowedMentions: { parse: [] },
            });
        }
    },
};
