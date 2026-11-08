// joinGateButtons.js — Kick / Dismiss on a join gate flag line (joingate:<kick|dismiss>:<userId>:<guildId>).
// Administrators of the server the flag line is in. The flag, the member and the removal belong to
// the joiner's own server (guildId). For a support joiner that is the support server while the line
// sits in the main server's review channel; reviewCards.actingGuild resolves it and checks the
// clicker is an Administrator there too. Old lines without a guild id act in the clicking server.

import { MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { clearGateFlag, closeGateLine, gateCheckLabels, getGateFlag, kickWithNotice } from '../services/automod/joinGate.js';
import { actingGuild } from '../services/automod/reviewCards.js';
import { noteIncidentEvent } from '../services/automod/raidService.js';
import { noteStaffReview } from '../services/staffActivityService.js';

const SNOWFLAKE = /^\d{17,20}$/;

export async function handleJoinGateButton(interaction, client, args) {
    const [decision, userId, cardGuildId] = args;
    if (!['kick', 'dismiss'].includes(decision) || !SNOWFLAKE.test(userId || '')) return;
    if (cardGuildId !== undefined && !SNOWFLAKE.test(cardGuildId)) return;
    if (!interaction.guildId || !isAdministrator(interaction.member)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only administrators of this server can act on join gate flags.' });
    }
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    let guild;
    try {
        ({ guild } = await actingGuild(interaction, cardGuildId || null));
    } catch (error) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: error.userMessage || 'You cannot act on this flag.' });
    }
    const guildId = guild.id;
    const admin = interaction.user;
    // Staff activity counts in the server where the click happened (where the staff work).
    await noteStaffReview(interaction.guildId, admin.id);
    const flag = await getGateFlag(guildId, userId).catch(() => null);

    if (decision === 'dismiss') {
        await clearGateFlag(guildId, userId).catch(() => {});
        await closeGateLine(interaction.message, `dismissed by ${admin.username}`);
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Flag dismissed', `<@${userId}> stays in the server.`)] });
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        await clearGateFlag(guildId, userId).catch(() => {});
        await closeGateLine(interaction.message, 'left the server');
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Already gone', 'They are no longer in the server.')] });
    }
    const hits = (flag?.hits?.length ? flag.hits : [{ check: 'avatar', reason: 'flagged by the join gate' }])
        .map((hit) => ({ ...hit, action: 'kick' }));
    const kicked = await kickWithNotice(member, hits, `Join gate: kicked by ${admin.username}`);
    if (!kicked) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'I could not kick them (their role may be above mine, or I lack Kick Members).' });
    }
    await clearGateFlag(guildId, userId).catch(() => {});
    // Raid timeline: only while a lockdown runs; never throws.
    await noteIncidentEvent(guildId, { kind: 'gate_kick', actorId: admin.id, targetId: userId, detail: `${gateCheckLabels(hits)} (kicked by staff)` });
    await closeGateLine(interaction.message, `kicked by ${admin.username}`);
    return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Kicked', `${member.user.username} was kicked from ${guild.name} and told why by DM.`)] });
}
