// verificationReview.js — Approve / Deny on a held verification (verifyreview:<approve|deny>:<guildId>:<userId>).
// Administrators of that server only.
// Languages (docs/bot-i18n.md): the private answer = the admin's Discord language; the DM = the
// language of the server the member verified in; the closed card (a staff post) = the language of
// the server the card is in.

import { MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { sendLoggedDm } from '../services/botDm/dmLog.js';
import { verifyUser } from '../services/verificationService.js';
import { markVerifiedIn } from '../services/oauthVerification.js';
import { closeCard } from '../services/automod/reviewCards.js';
import { noteStaffReview } from '../services/staffActivityService.js';
import { logger } from '../utils/logger.js';
import { staffGuildId } from '../services/automod/channelRouting.js';
import { textForGuild, textForInteraction } from '../utils/botText.js';

export async function handleVerificationReview(interaction, client, args) {
    const [decision, guildId, userId] = args;
    if (!['approve', 'deny'].includes(decision) || !/^\d{17,20}$/.test(guildId || '') || !/^\d{17,20}$/.test(userId || '')) return;
    const tr = textForInteraction(interaction);
    // The card lives in that server's staff server (a home server's cards: the main server; any other
    // server: itself); an Administrator of another server never decides it.
    if (interaction.guildId !== staffGuildId(guildId)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('verification.review.otherServer') });
    }
    if (!isAdministrator(interaction.member)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('verification.review.adminOnly') });
    }

    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const user = await client.users.fetch(userId).catch(() => null);
    const guild = client.guilds.cache.get(guildId);
    const admin = interaction.user;
    await noteStaffReview(interaction.guildId, admin.id);
    const cardText = textForGuild(interaction.guildId, { purpose: 'public' });
    // The DM: the member's language role, else the server's (botDm/dmRenderers.js; logged for a
    // language change). No server name known: "the server" in the DM's language.
    const sendResult = (key) => (user ? sendLoggedDm(user, {
        key, params: { serverName: guild?.name || null }, guildId,
        member: guild?.members?.cache?.get?.(userId) ?? null, label: key,
    }) : false);
    const delivered = (dm) => (dm ? cardText.t('verification.review.dmDelivered') : cardText.t('verification.review.dmNotDelivered'));

    if (decision === 'approve') {
        const result = await verifyUser(client, guildId, userId, { source: 'staff_approval', moderatorId: admin.id, lang: tr.lang });
        // Held verifications come from "Verify with Discord": now they count for a member restore into this server.
        await markVerifiedIn(userId, guildId).catch((error) => logger.warn(`Could not record the approved verification of ${userId} in ${guildId}: ${error.message}`));
        const dm = await sendResult('verification.approved');
        const outcome = result.status === 'already_verified'
            ? cardText.t('verification.review.cardApprovedAlready', { admin: admin.username, dm: delivered(dm) })
            : cardText.t('verification.review.cardApproved', { admin: admin.username, dm: delivered(dm) });
        await closeCard(interaction.message, outcome, { status: 'approved', by: admin.username });
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(tr.t('verification.review.approvedTitle'), tr.t('verification.review.approvedText', { user: user?.username || userId, role: result.roleName }))] });
    }

    const dm = await sendResult('verification.denied');
    await closeCard(interaction.message, cardText.t('verification.review.cardDenied', { admin: admin.username, dm: delivered(dm) }),
        { status: 'denied', by: admin.username });
    return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(tr.t('verification.review.deniedTitle'), tr.t('verification.review.deniedText', { user: user?.username || userId }))] });
}
