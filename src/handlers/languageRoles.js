// languageRoles.js — the shared "pick a language" step of /language set (select) and the
// language panel (buttons): gives the chosen language role, removes the member's other
// language roles (services/languageRoleService.js) and answers privately.
// The caller has already acknowledged the interaction (3 s): deferReply / deferUpdate.

import { createEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { botText, textForInteraction } from '../utils/botText.js';
import {
    LanguageRoleError, NO_MENTIONS, languageErrorText, languageRolesFor, nativeLanguageName, switchLanguageRole,
} from '../services/languageRoleService.js';

/** The member with a role cache: the interaction's own when it is a full GuildMember, else fetched. */
async function guildMember(interaction) {
    if (interaction.member?.roles?.cache) return interaction.member;
    return interaction.guild?.members?.fetch?.(interaction.user.id).catch(() => null) ?? null;
}

/**
 * Applies the choice and returns the private answer payload ({ embeds, components: [], allowedMentions }).
 * deps (tests): { resolve } replaces resolveSetting for the languageRoles read.
 */
export async function applyLanguageChoice(interaction, lang, deps = {}) {
    // Errors in the member's current reply language; success in the language just chosen.
    const tr = textForInteraction(interaction);
    const answer = (description, color, title = tr.t('language.pick.title')) => ({
        embeds: [createEmbed({ title, description, color })], components: [], allowedMentions: NO_MENTIONS,
    });
    try {
        if (!interaction.guild) throw new LanguageRoleError('memberMissing');
        const map = languageRolesFor(interaction.guildId, deps);
        const member = await guildMember(interaction);
        if (!member) throw new LanguageRoleError('memberMissing');
        const result = await switchLanguageRole({ guild: interaction.guild, member, lang, map });
        const language = nativeLanguageName(lang);
        if (!result.added && !result.removed.length) return answer(tr.t('language.already', { language }), 'info');
        const done = botText(lang);
        return answer(done.t('language.done', { language }), 'success', done.t('language.pick.title'));
    } catch (error) {
        if (!(error instanceof LanguageRoleError)) throw error;
        if (error.code === 'failed') logger.warn(`Language role change for ${interaction.user?.id} in ${interaction.guildId} failed: ${error.cause?.message || error.message}`);
        return answer(languageErrorText(tr, error), 'warning');
    }
}
