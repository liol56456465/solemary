// joinGateButtons.js — Kick / Dismiss on a join gate flag line (joingate:<kick|dismiss>:<userId>:<guildId>).
// Administrators of the server the flag line is in. The flag, the member and the removal belong to
// the joiner's own server (guildId). For a support joiner that is the support server while the line
// sits in the main server's review channel; reviewCards.actingGuild resolves it and checks the
// clicker is an Administrator there too. Old lines without a guild id act in the clicking server.
// Language (utils/botText.js): the ephemeral answer is in the clicker's Discord language; the
// closed flag line stays in the language of the server whose channel it is in.

import { MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { textForGuild, textForInteraction } from '../utils/botText.js';
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
    const tr = textForInteraction(interaction);
    if (!interaction.guildId || !isAdministrator(interaction.member)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('automod.joinGate.reply.adminOnly') });
    }
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    let guild;
    try {
        ({ guild } = await actingGuild(interaction, cardGuildId || null));
    } catch (error) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: error.userMessage || tr.t('automod.joinGate.reply.cannotAct') });
    }
    const guildId = guild.id;
    const admin = interaction.user;
    // The flag line is in this (the clicking) server's review channel: its language.
    const line = textForGuild(interaction.guildId, { purpose: 'public' });
    // Staff activity counts in the server where the click happened (where the staff work).
    await noteStaffReview(interaction.guildId, admin.id);
    const flag = await getGateFlag(guildId, userId).catch(() => null);

    if (decision === 'dismiss') {
        await clearGateFlag(guildId, userId).catch(() => {});
        await closeGateLine(interaction.message, line.t('automod.joinGate.outcome.dismissedBy', { name: admin.username }), { kicked: false, lang: line.lang });
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('automod.joinGate.reply.dismissedTitle'), tr.t('automod.joinGate.reply.dismissed', { userId }))],
            allowedMentions: { parse: [] },
        });
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        await clearGateFlag(guildId, userId).catch(() => {});
        await closeGateLine(interaction.message, line.t('automod.joinGate.outcome.left'), { kicked: false, lang: line.lang });
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(tr.t('automod.joinGate.reply.goneTitle'), tr.t('automod.joinGate.reply.gone'))] });
    }
    const hits = (flag?.hits?.length ? flag.hits : [{ check: 'avatar', reason: 'flagged by the join gate' }])
        .map((hit) => ({ ...hit, action: 'kick' }));
    const kicked = await kickWithNotice(member, hits, `Join gate: kicked by ${admin.username}`);
    if (!kicked) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('automod.joinGate.reply.kickFailed') });
    }
    await clearGateFlag(guildId, userId).catch(() => {});
    // Raid timeline: only while a lockdown runs; never throws.
    await noteIncidentEvent(guildId, { kind: 'gate_kick', actorId: admin.id, targetId: userId, detail: `${gateCheckLabels(hits)} (kicked by staff)` });
    await closeGateLine(interaction.message, line.t('automod.joinGate.outcome.kickedBy', { name: admin.username }), { kicked: true, lang: line.lang });
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(tr.t('automod.joinGate.reply.kickedTitle'), tr.t('automod.joinGate.reply.kicked', { name: member.user.username, server: guild.name }))],
        allowedMentions: { parse: [] },
    });
}
