import { getColor } from '../../../config/bot.js';
import { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { getServerCounters, removeServerCounter, getCounterEmoji, getCounterTypeLabel } from '../../../services/serverstatsService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes, createError, wrapServiceBoundary } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
import { botText, textForInteraction } from '../../../utils/botText.js';
export async function handleDelete(interaction, client) {
    const guild = interaction.guild;
    const counterId = interaction.options.getString("counter-id");
    const tr = textForInteraction(interaction); // ephemeral: the admin's Discord language

    try {
        await InteractionHelper.safeDefer(interaction);
    } catch (error) {
        logger.error("Failed to defer reply:", error);
        return;
    }

    if (!hasAdminAccess(interaction)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('serverstats.noAdmin.delete') }).catch(logger.error);
        return;
    }

    try {
        const counters = await getServerCounters(client, guild.id);

        if (counters.length === 0) {
            await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('serverstats.error.noneToDelete') }).catch(logger.error);
            return;
        }

        const counterToDelete = counters.find(c => c.id === counterId);
        if (!counterToDelete) {
            await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('serverstats.error.notFoundList', { id: counterId }) }).catch(logger.error);
            return;
        }

        const channel = guild.channels.cache.get(counterToDelete.channelId);

        const embed = createEmbed({
            title: tr.t('serverstats.delete.title'),
            description: tr.t('serverstats.delete.confirm', {
                id: counterToDelete.id,
                type: getCounterTypeDisplay(counterToDelete.type, tr.lang),
                channel: channel ? String(channel) : tr.t('serverstats.delete.alreadyDeleted'),
            }),
            color: getColor('error')
        });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`counter-delete:confirm:${counterToDelete.id}:${interaction.user.id}`)
                .setLabel(tr.t('serverstats.delete.button'))
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`counter-delete:cancel:${counterToDelete.id}:${interaction.user.id}`)
                .setLabel(tr.t('serverstats.delete.cancel'))
                .setStyle(ButtonStyle.Secondary)
        );

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [row] }).catch(logger.error);

    } catch (error) {
        logger.error("Error in handleDelete:", error);
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('serverstats.error.loadFailed') }).catch(logger.error);
    }
}

/** Deletes a counter and its channel; returns { message } in `lang` (the clicker's language; default English). */
export const performDeletionByCounterId = wrapServiceBoundary(async function performDeletionByCounterId(client, guild, counterId, { lang = 'en' } = {}) {
    // Atomic (row lock) removal + channel delete: services/serverstatsService.js.
    const { counter, channel, channelDeleted } = await removeServerCounter(client, guild, counterId, { lang });
    const tr = botText(lang);

    let message = tr.t('serverstats.delete.done', { id: counter.id, type: getCounterTypeDisplay(counter.type, lang) });

    if (channelDeleted) {
        message += tr.t('serverstats.delete.channelDeleted', { name: channel.name });
    } else if (channel) {
        message += tr.t('serverstats.delete.channelFailed', { name: channel.name });
    } else {
        message += tr.t('serverstats.delete.channelGone');
    }

    return { message };
}, (client, guild, counterId, { lang = 'en' } = {}) => ({
    service: 'serverstats',
    operation: 'performDeletionByCounterId',
    userMessage: botText(lang).t('serverstats.error.deleteFailed'),
}));

function getCounterTypeDisplay(type, lang = 'en') {
    return getCounterTypeLabel(type, { lang });
}
