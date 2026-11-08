// langrole:pick:<userId> — the select of /language set (ephemeral). Only the member who ran
// the command can use it (the message is theirs alone; checked anyway). Acknowledged first
// (deferUpdate, 3 s); the answer replaces the menu.

import { MessageFlags } from 'discord.js';
import { textForInteraction } from '../../../utils/botText.js';
import { LANGUAGE_ROLE_PREFIX, NO_MENTIONS } from '../../../services/languageRoleService.js';
import { applyLanguageChoice } from '../../../handlers/languageRoles.js';

export default {
    name: LANGUAGE_ROLE_PREFIX,
    // (interaction, client, args) from the dispatcher; the 4th argument is for tests.
    async execute(interaction, client, args = [], deps = {}) {
        const [action, userId] = args;
        if (action !== 'pick' || interaction.user.id !== userId) {
            return interaction.reply({ content: textForInteraction(interaction).t('language.notYours'), flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
        }
        await interaction.deferUpdate();
        return interaction.editReply(await applyLanguageChoice(interaction, interaction.values?.[0] ?? null, deps));
    },
};
