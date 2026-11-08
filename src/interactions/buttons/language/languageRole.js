// langrole:set:<code> — a button of the persistent language panel (/language panel).
// Anyone in the server may click: it changes only the clicker's own language roles.
// Acknowledged first (ephemeral defer, 3 s); the answer is private. An unknown code is
// refused by the switch ("has no role in this server").

import { MessageFlags } from 'discord.js';
import { LANGUAGE_ROLE_PREFIX } from '../../../services/languageRoleService.js';
import { applyLanguageChoice } from '../../../handlers/languageRoles.js';

export default {
    name: LANGUAGE_ROLE_PREFIX,
    // (interaction, client, args) from the dispatcher; the 4th argument is for tests.
    async execute(interaction, client, args = [], deps = {}) {
        const [action, lang] = args;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await applyLanguageChoice(interaction, action === 'set' ? lang : null, deps));
    },
};
