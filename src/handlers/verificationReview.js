// verificationReview.js — Approve / Deny on a held verification (verifyreview:<approve|deny>:<guildId>:<userId>).
// Administrators of that server only.

import { MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { isAdministrator, sendDm } from '../services/enforcement/enforcementService.js';
import { verifyUser } from '../services/verificationService.js';
import { markVerifiedIn } from '../services/oauthVerification.js';
import { closeCard } from '../services/automod/reviewCards.js';
import { noteStaffReview } from '../services/staffActivityService.js';
import { logger } from '../utils/logger.js';
import { staffGuildId } from '../services/automod/channelRouting.js';

export async function handleVerificationReview(interaction, client, args) {
    const [decision, guildId, userId] = args;
    if (!['approve', 'deny'].includes(decision) || !/^\d{17,20}$/.test(guildId || '') || !/^\d{17,20}$/.test(userId || '')) return;
    // The card lives in that server's staff server (a home server's cards: the main server; any other
    // server: itself); an Administrator of another server never decides it.
    if (interaction.guildId !== staffGuildId(guildId)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'This verification belongs to another server. Approve it there.' });
    }
    if (!isAdministrator(interaction.member)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only administrators can approve verifications.' });
    }

    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const user = await client.users.fetch(userId).catch(() => null);
    const guild = client.guilds.cache.get(guildId);
    const admin = interaction.user;
    await noteStaffReview(interaction.guildId, admin.id);

    if (decision === 'approve') {
        const result = await verifyUser(client, guildId, userId, { source: 'staff_approval', moderatorId: admin.id });
        // Held verifications come from "Verify with Discord": now they count for a member restore into this server.
        await markVerifiedIn(userId, guildId).catch((error) => logger.warn(`Could not record the approved verification of ${userId} in ${guildId}: ${error.message}`));
        const dm = user ? await sendDm(user, `**Your verification in ${guild?.name || 'the server'} was approved.** You now have access.`) : false;
        await closeCard(interaction.message, `Approved by ${admin.username}${result.status === 'already_verified' ? ' (they were already verified)' : ''}. DM: ${dm ? 'delivered' : 'not delivered'}.`,
            { status: 'approved', by: admin.username });
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Verification approved', `${user?.username || userId} now has the **${result.roleName}** role.`)] });
    }

    const dm = user ? await sendDm(user, `**Your verification in ${guild?.name || 'the server'} was not approved.** If you think this is a mistake, contact a staff member.`) : false;
    await closeCard(interaction.message, `Denied by ${admin.username}. DM: ${dm ? 'delivered' : 'not delivered'}.`,
        { status: 'denied', by: admin.username });
    return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Verification denied', `${user?.username || userId} stays unverified.`)] });
}
