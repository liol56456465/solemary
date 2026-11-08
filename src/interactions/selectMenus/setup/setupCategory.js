// The /setup "All commands" category select: setup-cat:<userId>. Only the person who ran
// /setup may use it, and the Administrator / Manage Server check runs again on every pick
// (components are not gated centrally: utils/commandGate.js).

import { MessageFlags } from 'discord.js';
import { textForInteraction } from '../../../utils/botText.js';
import { hasManageServer } from '../../../utils/commandGate.js';
import { hasOwnerPower } from '../../../utils/ownerPower.js';
import { SETUP_SELECT_ID, categoryReply } from '../../../services/setup/setupGuide.js';

export async function handleSetupCategory(interaction, client, args = []) {
    const tr = textForInteraction(interaction);
    const [ownerId] = args;
    if (!ownerId || ownerId !== interaction.user.id) {
        await interaction.reply({ content: tr.t('setup.notYours'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return;
    }
    const allowed = hasManageServer({ guild: interaction.guild, userId: interaction.user.id, permissions: interaction.memberPermissions })
        || hasOwnerPower(interaction.user.id, interaction.guildId); // OWNER_IDS: Mewvo's own servers only
    if (!allowed) {
        await interaction.reply({ content: tr.t('errors.access.manageServer'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return;
    }
    await interaction.deferUpdate();
    const { embeds, components } = categoryReply({
        client, guildId: interaction.guildId, userId: interaction.user.id, category: interaction.values?.[0], tr,
    });
    await interaction.editReply({ embeds, components, allowedMentions: { parse: [] } });
}

export default { name: SETUP_SELECT_ID, execute: handleSetupCategory };
