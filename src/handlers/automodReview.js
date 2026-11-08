// automodReview.js — buttons and selects on automod review cards (amreview:…).
// Administrators of the server the card is in (multi-server B1: every server's cards are in its
// own review channel; the cases a card names must belong to that server, reviewCards.recordsFor).
// The card itself is edited to show who reviewed it, and the moderator gets a private confirmation.

import { MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { handleReviewAction } from '../services/automod/reviewCards.js';
import { noteStaffReview } from '../services/staffActivityService.js';
import { textForInteraction } from '../utils/botText.js';

export async function handleAutomodReview(interaction, client, args) {
    const tr = textForInteraction(interaction); // ephemeral: the clicker's Discord language
    if (!interaction.guildId || !isAdministrator(interaction.member)) {
        return replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: tr.t('automod.review.reply.noAdmin'),
        });
    }
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const outcome = await handleReviewAction(interaction, args);
    await noteStaffReview(interaction.guildId, interaction.user.id);
    return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(tr.t('automod.review.reply.saved'), outcome)] });
}
