// languageRoles.js — the shared "pick a language" step of /language set (select) and the
// language panel (buttons): gives the chosen language role, removes the member's other
// language roles (services/languageRoleService.js) and answers privately.
// A language that has no role in this server (or a server without language roles) is saved as
// the member's personal language instead (services/personalLanguage.js, audit 4.6): Mewvo then
// DMs them in it in every server where no language role of theirs comes first. The member's
// language roles here are removed then, so the choice also counts in this server.
// The caller has already acknowledged the interaction (3 s): deferReply / deferUpdate.

import { createEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { botText, textForInteraction } from '../utils/botText.js';
import { scheduleDmRelang, schedulePersonalRelang } from '../services/botDm/dmRelang.js';
import { clearPersonalLanguage, setPersonalLanguage } from '../services/personalLanguage.js';
import {
    LanguageRoleError, NO_MENTIONS, PERSONAL_RESET, languageErrorText, languageRolesFor, nativeLanguageName,
    removeLanguageRoles, switchLanguageRole,
} from '../services/languageRoleService.js';
import { LANG_CODES } from '../services/site/i18n.js';

/** The member with a role cache: the interaction's own when it is a full GuildMember, else fetched. */
async function guildMember(interaction) {
    if (interaction.member?.roles?.cache) return interaction.member;
    return interaction.guild?.members?.fetch?.(interaction.user.id).catch(() => null) ?? null;
}

/**
 * A personal language (no role here) or "reset". Saved first: when the save fails nothing else
 * happens. Then the member's language roles here are removed (a role would keep winning); when
 * that is refused the language is still saved and the answer says the role still applies here.
 */
async function applyPersonalChoice(interaction, lang, map, tr, answer, deps) {
    const userId = interaction.user?.id;
    const reset = lang === PERSONAL_RESET;
    try {
        if (reset) await (deps.clearPersonal || clearPersonalLanguage)(userId);
        else await (deps.savePersonal || setPersonalLanguage)(userId, lang);
    } catch (error) {
        logger.warn(`Personal language of ${userId} not saved: ${error?.message || error}`);
        return answer(tr.t('language.error.saveFailed'), 'warning');
    }
    // Every server's DMs of the last 30 days follow (debounced; a role change below joins it).
    Promise.resolve((deps.schedulePersonal || schedulePersonalRelang)(interaction.client, userId, interaction.guildId)).catch(() => {});
    // Reset: the answer in the language that applies now (a role here, else their Discord language).
    const done = reset ? textForInteraction(interaction) : botText(lang);
    const lines = [reset ? done.t('language.resetDone') : done.t('language.saved', { language: nativeLanguageName(lang) })];
    if (!reset && interaction.guild) {
        const member = await guildMember(interaction);
        try {
            // Not fetchable: say a language role may still apply here, never a bare "Saved".
            if (!member) throw new LanguageRoleError('memberMissing');
            await removeLanguageRoles({ guild: interaction.guild, member, map });
        } catch (error) {
            if (!(error instanceof LanguageRoleError)) throw error;
            if (error.code === 'failed') logger.warn(`Language roles of ${userId} in ${interaction.guildId} not removed: ${error.cause?.message || error.message}`);
            lines.push(done.t('language.roleKept', { reason: languageErrorText(done, error) }));
        }
    }
    return answer(lines.join('\n'), 'success', done.t('language.pick.title'));
}

/**
 * Applies the choice and returns the private answer payload ({ embeds, components: [], allowedMentions }).
 * deps (tests): { resolve } replaces resolveSetting for the languageRoles read; { savePersonal,
 * clearPersonal, scheduleRelang, schedulePersonal }.
 */
export async function applyLanguageChoice(interaction, lang, deps = {}) {
    // Errors in the member's current reply language; success in the language just chosen.
    const tr = textForInteraction(interaction);
    const answer = (description, color, title = tr.t('language.pick.title')) => ({
        embeds: [createEmbed({ title, description, color })], components: [], allowedMentions: NO_MENTIONS,
    });
    try {
        if (!interaction.guild) throw new LanguageRoleError('memberMissing');
        if (lang !== PERSONAL_RESET && !LANG_CODES.includes(lang)) throw new LanguageRoleError('unknown');
        const map = languageRolesFor(interaction.guildId, deps);
        if (lang === PERSONAL_RESET || !map[lang]) return await applyPersonalChoice(interaction, lang, map, tr, answer, deps);
        const member = await guildMember(interaction);
        if (!member) throw new LanguageRoleError('memberMissing');
        const result = await switchLanguageRole({ guild: interaction.guild, member, lang, map });
        const language = nativeLanguageName(lang);
        if (!result.added && !result.removed.length) return answer(tr.t('language.already', { language }), 'info');
        // The bot's DMs of the last 30 days follow (services/botDm/dmRelang.js; debounced, so the
        // guildMemberUpdate this role change also causes runs together with it).
        (deps.scheduleRelang || scheduleDmRelang)(interaction.client, interaction.guildId, interaction.user?.id);
        const done = botText(lang);
        return answer(done.t('language.done', { language }), 'success', done.t('language.pick.title'));
    } catch (error) {
        if (!(error instanceof LanguageRoleError)) throw error;
        if (error.code === 'failed') logger.warn(`Language role change for ${interaction.user?.id} in ${interaction.guildId} failed: ${error.cause?.message || error.message}`);
        return answer(languageErrorText(tr, error), 'warning');
    }
}
