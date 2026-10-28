// joinGateButtons.js — Kick / Dismiss on a join gate flag line (joingate:<kick|dismiss>:<userId>).
// Administrators in the main server only.

import { MessageFlags } from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { clearGateFlag, closeGateLine, getGateFlag, kickWithNotice } from '../services/automod/joinGate.js';
import { noteStaffReview } from '../services/staffActivityService.js';

export async function handleJoinGateButton(interaction, client, args) {
    const [decision, userId] = args;
    if (!['kick', 'dismiss'].includes(decision) || !/^\d{17,20}$/.test(userId || '')) return;
    if (interaction.guildId !== enforcementConfig.mainGuildId || !isAdministrator(interaction.member)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only administrators in the main server can act on join gate flags.' });
    }
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const admin = interaction.user;
    await noteStaffReview(interaction.guildId, admin.id);
    const flag = await getGateFlag(interaction.guildId, userId).catch(() => null);

    if (decision === 'dismiss') {
        await clearGateFlag(interaction.guildId, userId).catch(() => {});
        await closeGateLine(interaction.message, `dismissed by ${admin.username}`);
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Flag dismissed', `<@${userId}> stays in the server.`)] });
    }

    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) {
        await clearGateFlag(interaction.guildId, userId).catch(() => {});
        await closeGateLine(interaction.message, 'left the server');
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Already gone', 'They are no longer in the server.')] });
    }
    const hits = (flag?.hits?.length ? flag.hits : [{ check: 'avatar', reason: 'flagged by the join gate' }])
        .map((hit) => ({ ...hit, action: 'kick' }));
    const kicked = await kickWithNotice(member, hits, `Join gate: kicked by ${admin.username}`);
    if (!kicked) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'I could not kick them (their role may be above mine, or I lack Kick Members).' });
    }
    await clearGateFlag(interaction.guildId, userId).catch(() => {});
    await closeGateLine(interaction.message, `kicked by ${admin.username}`);
    return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Kicked', `${member.user.username} was kicked and told why by DM.`)] });
}
