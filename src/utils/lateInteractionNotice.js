// lateInteractionNotice.js
//
// Discord gives the bot 3 seconds to acknowledge an interaction. After that the
// token is dead, Discord shows "The application did not respond", and the bot
// cannot answer in place. These helpers tell admins what happened instead: by DM,
// or by a short self-deleting channel message when DMs are closed. Members get no
// notice: an unexplained "sorry" DM from a bot is noise to them.

import { MessageFlags } from 'discord.js';
import { logger } from './logger.js';
import { canSeeAdminCommands } from './commandGate.js';

const ACK_DEADLINE_MS = 3000;
const CHANNEL_NOTICE_TTL_MS = 15 * 1000;
const USER_NOTICE_COOLDOWN_MS = 60 * 1000;
const EXPIRED_INTERACTION_CODE = 10062;

const lastNoticeByUser = new Map();

function interactionAgeMs(interaction) {
    return interaction?.createdTimestamp ? Date.now() - interaction.createdTimestamp : 0;
}

function describeInteraction(interaction) {
    if (interaction.isChatInputCommand?.()) return `\`/${interaction.commandName}\``;
    if (interaction.isButton?.()) return 'that button';
    if (interaction.isAnySelectMenu?.()) return 'that menu';
    if (interaction.isModalSubmit?.()) return 'that form';
    return 'that';
}

function buildNoticeText(interaction, { actionTaken }) {
    const what = describeInteraction(interaction);
    const where = interaction.guild ? ` in **${interaction.guild.name}**` : '';
    return actionTaken
        ? `Sorry, I didn't respond to ${what}${where} in time. It may still have gone through, so check before trying again.`
        : `Sorry, I didn't respond to ${what}${where} in time, so I didn't do anything. Please try again.`;
}

/**
 * Tell an admin their interaction timed out (members are only logged). DM first; if DMs are closed, post a
 * mention in the channel and delete it after a few seconds. At most one notice per
 * interaction and one per user per minute.
 */
export async function sendLateInteractionNotice(interaction, { actionTaken = false } = {}) {
    if (!interaction?.user || interaction._lateNoticeSent) return false;
    if (!canSeeAdminCommands(interaction)) {
        interaction._lateNoticeSent = true;
        logger.warn('Interaction missed the acknowledgement deadline (member, not notified)', {
            event: 'interaction.late_notice_skipped',
            interactionId: interaction.id,
            guildId: interaction.guildId,
            userId: interaction.user.id,
            command: interaction.commandName || interaction.customId,
            ageMs: interactionAgeMs(interaction),
        });
        return false;
    }
    interaction._lateNoticeSent = true;

    const userId = interaction.user.id;
    const now = Date.now();
    if (now - (lastNoticeByUser.get(userId) || 0) < USER_NOTICE_COOLDOWN_MS) return false;
    lastNoticeByUser.set(userId, now);

    const content = buildNoticeText(interaction, { actionTaken });
    logger.warn('Interaction missed the acknowledgement deadline; notifying user', {
        event: 'interaction.late_notice',
        interactionId: interaction.id,
        guildId: interaction.guildId,
        userId,
        command: interaction.commandName || interaction.customId,
        ageMs: interactionAgeMs(interaction),
        actionTaken,
    });

    try {
        await interaction.user.send({ content });
        return true;
    } catch {
        // DMs closed; fall back to the channel.
    }

    if (!interaction.guild || typeof interaction.channel?.send !== 'function') return false;

    try {
        const message = await interaction.channel.send({
            content: `<@${userId}> ${content}`,
            allowedMentions: { users: [userId] },
        });
        setTimeout(() => message.delete().catch(() => {}), CHANNEL_NOTICE_TTL_MS).unref?.();
        return true;
    } catch (error) {
        logger.debug('Could not deliver late interaction notice:', error?.message);
        return false;
    }
}

/**
 * Call right before running a handler. When the interaction is already past the
 * deadline by the local clock, acknowledge it as a probe: if Discord says it has
 * expired, the handler is skipped (nothing is done) and the user is told. If the
 * probe succeeds (borderline timing or clock skew), the interaction is now deferred
 * and the handler runs as usual. Returns true when the handler should be skipped.
 */
export async function skipIfArrivedTooLate(interaction) {
    if (!interaction || interaction.deferred || interaction.replied) return false;
    if (interactionAgeMs(interaction) < ACK_DEADLINE_MS) return false;

    try {
        const isComponentUpdate = interaction.isMessageComponent?.()
            || (interaction.isModalSubmit?.() && interaction.isFromMessage?.());
        if (isComponentUpdate) {
            await interaction.deferUpdate();
        } else {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }
        logger.warn('Interaction arrived past the deadline but was still acknowledged', {
            event: 'interaction.late_but_alive',
            interactionId: interaction.id,
            ageMs: interactionAgeMs(interaction),
        });
        return false;
    } catch (error) {
        if (error?.code === EXPIRED_INTERACTION_CODE) {
            await sendLateInteractionNotice(interaction, { actionTaken: false });
            return true;
        }
        return false;
    }
}

/**
 * Call after a handler finished. If it never acknowledged the interaction and the
 * deadline has passed, the user saw "did not respond"; tell them it may have run.
 */
export async function noticeIfHandlerMissedDeadline(interaction) {
    if (!interaction || interaction.deferred || interaction.replied) return;
    if (interactionAgeMs(interaction) < ACK_DEADLINE_MS) return;
    await sendLateInteractionNotice(interaction, { actionTaken: true });
}
