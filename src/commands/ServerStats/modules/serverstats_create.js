import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
// Validation, channel creation, the atomic save and the first rename live in the
// service (shared with the web dashboard).
import { createServerCounter, getCounterTypeLabel } from '../../../services/serverstatsService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
export async function handleCreate(interaction, client) {
    const guild = interaction.guild;
    const type = interaction.options.getString("type");
    const channelType = interaction.options.getString("channel_type");
    const category = interaction.options.getChannel("category");

    try {
        await InteractionHelper.safeDefer(interaction);
    } catch (error) {
        logger.error("Failed to defer reply:", error);
        return;
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Channels** permission to create counters.' }).catch(logger.error);
        return;
    }

    try {
        let result;
        try {
            result = await createServerCounter(client, guild, { type, channelType, category, actorTag: interaction.user.tag });
        } catch (error) {
            if (error.userMessage && error.type === ErrorTypes.USER_INPUT) {
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: error.userMessage }).catch(logger.error);
                return;
            }
            throw error;
        }
        const { counter: newCounter, channel: targetChannel, renamed } = result;
        if (!renamed) {
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Counter created but failed to update channel name. The counter will update on the next scheduled run.' }).catch(logger.error);
            return;
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(`**Counter Created Successfully!**\n\n**Type:** ${getCounterTypeLabel(type)}\n**Channel Type:** ${targetChannel.type === ChannelType.GuildVoice ? 'voice' : 'text'}\n**Category:** ${category}\n**Channel:** ${targetChannel}\n**Channel Name:** ${targetChannel.name}\n**Counter ID:** \`${newCounter.id}\`\n\nThe counter will automatically update every 15 minutes.\n\nUse \`/serverstats list\` to view all counters.`)]
        }).catch(logger.error);

    } catch (error) {
        logger.error("Error creating counter:", error);
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while creating the counter. Please try again.' }).catch(logger.error);
    }
}
