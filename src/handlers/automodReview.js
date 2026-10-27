// automodReview.js — buttons and selects on automod review cards (amreview:…).
// Administrators in the main server only; the card itself is edited to show who
// reviewed it, and the moderator gets a private confirmation.

import { MessageFlags } from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { handleReviewAction } from '../services/automod/reviewCards.js';

export async function handleAutomodReview(interaction, client, args) {
    if (interaction.guildId !== enforcementConfig.mainGuildId || !isAdministrator(interaction.member)) {
        return replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: 'Only administrators in the main server can review automod decisions.',
        });
    }
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const outcome = await handleReviewAction(interaction, args);
    return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Review saved', outcome)] });
}
