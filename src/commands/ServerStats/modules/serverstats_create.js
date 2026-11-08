import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
// Validation, channel creation, the atomic save and the first rename live in the
// service (shared with the web dashboard).
import { createServerCounter, getCounterTypeLabel } from '../../../services/serverstatsService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
import { textForInteraction } from '../../../utils/botText.js';
export async function handleCreate(interaction, client) {
    const guild = interaction.guild;
    const type = interaction.options.getString("type");
    const channelType = interaction.options.getString("channel_type");
    const category = interaction.options.getChannel("category");
    const tr = textForInteraction(interaction); // ephemeral: the admin's Discord language

    try {
        await InteractionHelper.safeDefer(interaction);
    } catch (error) {
        logger.error("Failed to defer reply:", error);
        return;
    }

    if (!hasAdminAccess(interaction)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('serverstats.noAdmin.create') }).catch(logger.error);
        return;
    }

    try {
        let result;
        try {
            result = await createServerCounter(client, guild, { type, channelType, category, actorTag: interaction.user.tag, lang: tr.lang });
        } catch (error) {
            if (error.userMessage && error.type === ErrorTypes.USER_INPUT) {
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: error.userMessage }).catch(logger.error);
                return;
            }
            throw error;
        }
        const { counter: newCounter, channel: targetChannel, renamed } = result;
        if (!renamed) {
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('serverstats.create.notRenamed') }).catch(logger.error);
            return;
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('serverstats.success'), tr.t('serverstats.create.done', {
                type: getCounterTypeLabel(type, { lang: tr.lang }),
                channelType: targetChannel.type === ChannelType.GuildVoice ? tr.t('serverstats.create.voice') : tr.t('serverstats.create.text'),
                category: String(category),
                channel: String(targetChannel),
                channelName: targetChannel.name,
                id: newCounter.id,
            }))]
        }).catch(logger.error);

    } catch (error) {
        logger.error("Error creating counter:", error);
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('serverstats.error.createFailed') }).catch(logger.error);
    }
}
