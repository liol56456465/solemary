// /database Previous / Next. customId dblookup:<ownerId>:<nonce>:<prev|next>:<page>.
// Re-checked on every click: the clicker must be the owner who ran the lookup, still in
// OWNER_IDS, inside OWNER_TOOLS_GUILD_ID. The pages come from memory (already redacted);
// once they expire the owner runs /database again. Nothing is queried here.

import { MessageFlags } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { canUseOwnerTools, OWNER_TOOLS_REFUSAL } from '../../../utils/commandGate.js';
import { lookupPages } from '../../../services/owner/databaseLookup.js';
import { LOOKUP_BUTTON_ID, LOOKUP_EXPIRED, lookupMessage, parseLookupArgs } from '../../../handlers/databaseLookupView.js';

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

export async function handleLookupButton(interaction, args, { store = lookupPages, canUse = canUseOwnerTools, log = logger } = {}) {
    const parsed = parseLookupArgs(args);
    const userId = interaction.user?.id;
    if (!parsed || parsed.ownerId !== userId || !canUse({ guildId: interaction.guildId, userId })) {
        log.warn('Refused /database page button', { event: 'owner.database.refused', userId, guildId: interaction.guildId });
        await interaction.reply(ephemeral(OWNER_TOOLS_REFUSAL)).catch(() => {});
        return;
    }
    const entry = store.get(parsed.nonce);
    if (!entry || entry.ownerId !== userId) {
        await interaction.reply(ephemeral(LOOKUP_EXPIRED)).catch(() => {});
        return;
    }
    await interaction.deferUpdate();
    log.info(`Owner /database page ${parsed.page + 1} by ${userId}`, { event: 'owner.database.page', userId, page: parsed.page + 1 });
    await interaction.editReply(lookupMessage(entry, parsed.page, { ownerId: userId, nonce: parsed.nonce }));
}

export default {
    name: LOOKUP_BUTTON_ID,
    async execute(interaction, _client, args) {
        return handleLookupButton(interaction, args);
    },
};
