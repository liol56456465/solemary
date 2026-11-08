import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';

import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { hasOwnerPower } from '../utils/ownerPower.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { noteOwnerOverride } from '../services/ownerOverride.js';
import { botText, textForGuild } from '../utils/botText.js';
import { replyText } from '../commands/Core/modules/commandText.js';

// The countdown message is a public post: the server's language. Answers to the person who
// clicked a button only they see: their own language.
const messageText = (countdownData) => textForGuild(countdownData?.message?.guildId ?? null, { purpose: 'public' });

function createControlButtons(countdownId, isPaused = false, { lang } = {}) {
    const tr = botText(lang);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`countdown_pause:${countdownId}`)
            .setLabel(isPaused ? tr.t('tools.countdown.resume') : tr.t('tools.countdown.pause'))
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`countdown_cancel:${countdownId}`)
            .setLabel(tr.t('tools.countdown.cancel'))
            .setStyle(ButtonStyle.Danger),
    );
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    return [
        h > 0 ? h.toString().padStart(2, "0") : null,
        m.toString().padStart(2, "0"),
        s.toString().padStart(2, "0"),
    ]
        .filter(Boolean)
        .join(":");
}

// The message is edited at most this often: frequent edits share the channel's rate
// limit with every other bot message there. The <t:…:R> timestamp counts down in the
// client between edits.
const UPDATE_INTERVAL_MS = 15_000;

function buildRunningEmbed(countdownData, remaining, tr = messageText(countdownData)) {
    return successEmbed(
        countdownData.title,
        tr.t('tools.countdown.remaining', { time: formatTime(Math.ceil(remaining / 1000)), ends: `<t:${Math.ceil(countdownData.endTime / 1000)}:R>` }),
    );
}

function startCountdown(countdownId, countdownData, activeCountdowns) {
    if (countdownData.interval) {
        clearTimeout(countdownData.interval);
        countdownData.interval = null;
    }

    logger.info(`Countdown started: ${countdownData.title} (${countdownData.remainingTime / 1000}s remaining)`);

    // One timer per countdown, rescheduled after each tick: it fires every
    // UPDATE_INTERVAL_MS, or exactly at the end when that comes sooner.
    const tick = async () => {
        try {
            if (countdownData.isPaused) return;

            const remaining = Math.max(0, countdownData.endTime - Date.now());
            countdownData.remainingTime = remaining;
            const tr = messageText(countdownData);

            if (remaining <= 0) {
                const finishedEmbed = successEmbed(
                    tr.t('tools.countdown.finishedTitle', { title: countdownData.title }),
                    tr.t('tools.countdown.finished'),
                );

                await countdownData.message.edit({
                    embeds: [finishedEmbed],
                    components: [],
                });

                cleanupCountdown(countdownId, activeCountdowns);
                return;
            }

            try {
                await countdownData.message.edit({
                    embeds: [buildRunningEmbed(countdownData, remaining, tr)],
                    components: [createControlButtons(countdownId, false, { lang: tr.lang })],
                });
            } catch (error) {
                logger.error("Error updating countdown message:", error);
            }

            // Paused or cancelled while the edit was in flight.
            if (countdownData.isPaused || !activeCountdowns.has(countdownId)) return;
            const left = Math.max(0, countdownData.endTime - Date.now());
            countdownData.interval = setTimeout(tick, Math.min(UPDATE_INTERVAL_MS, left));
        } catch (error) {
            logger.error("Countdown update error:", error);
            cleanupCountdown(countdownId, activeCountdowns);
        }
    };

    countdownData.interval = setTimeout(tick, Math.min(UPDATE_INTERVAL_MS, countdownData.remainingTime));
}

function cleanupCountdown(countdownId, activeCountdowns) {
    const countdownData = activeCountdowns.get(countdownId);
    if (countdownData) {
        clearTimeout(countdownData.interval);
        activeCountdowns.delete(countdownId);
    }
}

async function countdownButtonHandler(interaction, client, args) {
    const tr = replyText(interaction);
    try {
        const { activeCountdowns } = await import('../commands/Tools/countdown.js');
        // customId is `countdown_<action>:<countdownId>`; the router strips the
        // prefix before ':' and passes the remainder as args.
        const action = interaction.customId.split(':')[0].replace('countdown_', '');
        const countdownId = args.join(':');

        const countdownData = activeCountdowns.get(countdownId);
        if (!countdownData) {
            return await interaction.reply({
                content: tr.t('tools.countdown.expired'),
                flags: ["Ephemeral"],
            });
        }

        // Pausing or cancelling a public countdown affects everyone: Administrator only (access model).
        if (!hasOwnerPower(interaction.user.id, interaction.guildId) && !isAdministrator(interaction.member)) {
            return await interaction.reply({
                content: tr.t('tools.countdown.adminOnly'),
                flags: ["Ephemeral"],
            });
        }
        if (!isAdministrator(interaction.member)) {
            noteOwnerOverride({ client, guildId: interaction.guildId, userId: interaction.user.id, username: interaction.user.username, action: `countdown ${action}`, via: 'button' });
        }

        // Every answer is ephemeral: acknowledge before editing the public countdown message
        // (a REST call); the reply() calls below then edit this deferred reply.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const trMessage = messageText(countdownData);
        switch (action) {
            case "pause":
                if (countdownData.isPaused) {
                    countdownData.isPaused = false;
                    countdownData.endTime = Date.now() + countdownData.remainingTime;
                    startCountdown(countdownId, countdownData, activeCountdowns);

                    await countdownData.message.edit({
                        embeds: [buildRunningEmbed(countdownData, countdownData.remainingTime, trMessage)],
                        components: [createControlButtons(countdownId, false, { lang: trMessage.lang })],
                    });

                    await interaction.reply({
                        content: tr.t('tools.countdown.resumed'),
                        flags: ["Ephemeral"],
                    });
                } else {
                    clearTimeout(countdownData.interval);
                    countdownData.isPaused = true;
                    countdownData.remainingTime = Math.max(0, countdownData.endTime - Date.now());

                    // No end timestamp while paused: it would keep counting down in the client.
                    await countdownData.message.edit({
                        embeds: [successEmbed(
                            trMessage.t('tools.countdown.pausedTitle', { title: countdownData.title }),
                            trMessage.t('tools.countdown.remainingPaused', { time: formatTime(Math.ceil(countdownData.remainingTime / 1000)) }),
                        )],
                        components: [createControlButtons(countdownId, true, { lang: trMessage.lang })],
                    });

                    await interaction.reply({
                        content: tr.t('tools.countdown.paused'),
                        flags: ["Ephemeral"],
                    });
                }
                break;

            case "cancel":
                clearTimeout(countdownData.interval);

                const embed = successEmbed(
                    trMessage.t('tools.countdown.cancelledTitle', { title: countdownData.title }),
                    trMessage.t('tools.countdown.cancelledBody'),
                );

                await countdownData.message.edit({
                    embeds: [embed],
                    components: [],
                });

                cleanupCountdown(countdownId, activeCountdowns);

                await interaction.reply({
                    content: tr.t('tools.countdown.cancelled'),
                    flags: ["Ephemeral"],
                });
                break;
        }
    } catch (error) {
        logger.error('Countdown button handler error:', error);
        try {
            // Also after the deferReply above (sendErrorResponse edits the deferred reply).
            if (!interaction.replied) {
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('tools.countdown.failed'), context: { lang: tr.lang } });
            }
        } catch (err) {
            logger.error('Failed to send error message:', err);
        }
    }
}

export { createControlButtons, formatTime, startCountdown, cleanupCountdown, countdownButtonHandler };
export default countdownButtonHandler;