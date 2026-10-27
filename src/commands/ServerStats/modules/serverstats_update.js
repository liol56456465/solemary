import { PermissionFlagsBits } from 'discord.js';
import { createEmbed, successEmbed } from '../../../utils/embeds.js';
import { changeCounterType, getCounterEmoji, getCounterTypeLabel } from '../../../services/serverstatsService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
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

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Channels** permission to update counters.' }).catch(logger.error);
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
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Counter updated but failed to update channel name. The counter will update on the next scheduled run.' }).catch(logger.error);
            return;
        }

        const finalChannel = guild.channels.cache.get(updatedCounter.channelId);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(`**Counter Updated Successfully!**\n\n**Counter ID:** \`${counterId}\`\n**Type Changed:** ${getCounterEmoji(oldType)} ${getCounterTypeLabel(oldType)} → ${getCounterEmoji(newType)} ${getCounterTypeLabel(newType)}\n\n**Current Settings:**\n**Type:** ${getCounterEmoji(updatedCounter.type)} ${getCounterTypeLabel(updatedCounter.type)}\n**Channel:** ${finalChannel}\n**Channel Name:** ${finalChannel.name}\n\nThe counter will automatically update every 15 minutes.`)]
        }).catch(logger.error);

    } catch (error) {
        logger.error("Error updating counter:", error);
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while updating the counter. Please try again.' }).catch(logger.error);
    }
}