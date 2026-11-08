import { PermissionFlagsBits } from 'discord.js';
import { createEmbed, successEmbed } from '../../../utils/embeds.js';
import { changeCounterType, getCounterEmoji, getCounterTypeLabel } from '../../../services/serverstatsService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
import { textForInteraction } from '../../../utils/botText.js';
export async function handleUpdate(interaction, client) {
    const guild = interaction.guild;
    const counterId = interaction.options.getString("counter-id");
    const newType = interaction.options.getString("type");
    const tr = textForInteraction(interaction); // ephemeral: the admin's Discord language

    try {
        await InteractionHelper.safeDefer(interaction);
    } catch (error) {
        logger.error("Failed to defer reply:", error);
        return;
    }

    if (!hasAdminAccess(interaction)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('serverstats.noAdmin.update') }).catch(logger.error);
        return;
    }

    if (!newType) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('serverstats.error.noType') }).catch(logger.error);
        return;
    }

    try {
        // Atomic (row lock): validation, one counter per type, save and rename (services/serverstatsService.js).
        let result;
        try {
            result = await changeCounterType(client, guild, counterId, newType, { lang: tr.lang });
        } catch (error) {
            if (error.userMessage && error.type === ErrorTypes.USER_INPUT) {
                await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: error.userMessage }).catch(logger.error);
                return;
            }
            throw error;
        }
        const { counter: updatedCounter, oldType, renamed } = result;
        if (!renamed) {
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('serverstats.update.notRenamed') }).catch(logger.error);
            return;
        }

        const finalChannel = guild.channels.cache.get(updatedCounter.channelId);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('serverstats.success'), tr.t('serverstats.update.done', {
                id: counterId,
                oldType: getCounterTypeLabel(oldType, { lang: tr.lang }),
                newType: getCounterTypeLabel(newType, { lang: tr.lang }),
                channel: String(finalChannel),
                channelName: finalChannel.name,
            }))]
        }).catch(logger.error);

    } catch (error) {
        logger.error("Error updating counter:", error);
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('serverstats.error.updateFailed') }).catch(logger.error);
    }
}
