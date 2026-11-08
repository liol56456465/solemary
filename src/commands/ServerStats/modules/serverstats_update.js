import { PermissionFlagsBits } from 'discord.js';
import { createEmbed, successEmbed } from '../../../utils/embeds.js';
import { changeCounterType, getCounterEmoji, getCounterTypeLabel } from '../../../services/serverstatsService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
export async function handleUpdate(interaction, client) {
    const guild = interaction.guild;
    const counterId = interaction.options.getString("counter-id");
    const newType = interaction.options.getString("type");

    try {
        await InteractionHelper.safeDefer(interaction);
    } catch (error) {
        logger.error("Failed to defer reply:", error);
        return;
    }

    if (!hasAdminAccess(interaction)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Administrator** permission to update counters.' }).catch(logger.error);
        return;
    }

    if (!newType) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'You must provide a new counter type to update.' }).catch(logger.error);
        return;
    }

    try {
        // Atomic (row lock): validation, one counter per type, save and rename (services/serverstatsService.js).
        let result;
        try {
            result = await changeCounterType(client, guild, counterId, newType);
        } catch (error) {
            if (error.userMessage && error.type === ErrorTypes.USER_INPUT) {
                await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: error.userMessage }).catch(logger.error);
                return;
            }
            throw error;
        }
        const { counter: updatedCounter, oldType, renamed } = result;
        if (!renamed) {
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Counter updated, but I couldn\'t rename the channel yet. It will update on the next run.' }).catch(logger.error);
            return;
        }

        const finalChannel = guild.channels.cache.get(updatedCounter.channelId);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(`**Counter updated**\n\n**Counter ID:** \`${counterId}\`\n**Type:** ${getCounterTypeLabel(oldType)} → ${getCounterTypeLabel(newType)}\n**Channel:** ${finalChannel}\n**Channel Name:** ${finalChannel.name}\n\nIt updates every 15 minutes.`)]
        }).catch(logger.error);

    } catch (error) {
        logger.error("Error updating counter:", error);
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Something went wrong while updating the counter. Try again.' }).catch(logger.error);
    }
}