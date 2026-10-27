// verificationReview.js — Approve / Deny on a held verification (verifyreview:<approve|deny>:<guildId>:<userId>).
// Administrators of that server only.

import { MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { isAdministrator, sendDm } from '../services/enforcement/enforcementService.js';
import { verifyUser } from '../services/verificationService.js';
import { closeCard } from '../services/automod/reviewCards.js';

export async function handleVerificationReview(interaction, client, args) {
    const [decision, guildId, userId] = args;
    if (!['approve', 'deny'].includes(decision) || !/^\d{17,20}$/.test(guildId || '') || !/^\d{17,20}$/.test(userId || '')) return;
    if (!isAdministrator(interaction.member)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only administrators can approve verifications.' });
    }

    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const user = await client.users.fetch(userId).catch(() => null);
    const guild = client.guilds.cache.get(guildId);
    const admin = interaction.user;

    if (decision === 'approve') {
        const result = await verifyUser(client, guildId, userId, { source: 'staff_approval', moderatorId: admin.id });
        const dm = user ? await sendDm(user, `**Your verification in ${guild?.name || 'the server'} was approved.** You now have access.`) : false;
        await closeCard(interaction.message, `Approved by ${admin.username}${result.status === 'already_verified' ? ' (they were already verified)' : ''}. DM: ${dm ? 'delivered' : 'not delivered'}.`);
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Verification approved', `${user?.username || userId} now has the **${result.roleName}** role.`)] });
    }

    const dm = user ? await sendDm(user, `**Your verification in ${guild?.name || 'the server'} was not approved.** If you think this is a mistake, contact a staff member.`) : false;
    await closeCard(interaction.message, `Denied by ${admin.username}. DM: ${dm ? 'delivered' : 'not delivered'}.`);
    return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Verification denied', `${user?.username || userId} stays unverified.`)] });
}
