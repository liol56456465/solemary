import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { getColor } from '../../config/bot.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
export default {
    data: new SlashCommandBuilder()
        .setName("unlock")
        .setDescription(
            "Unlocks the current channel (allows @everyone to send messages again).",
        )
        .setDescriptionLocalizations(descriptionLocalizations('moderation.unlock.cmd.description'))
.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    category: "moderation",

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Unlock interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'unlock'
            });
            return;
        }

        // Errors: the moderator's language; the unlock notice is posted in the channel: the server's language.
        const tr = textForInteraction(interaction);
        const pub = textForInteraction(interaction, { purpose: 'public' });
        const channel = interaction.channel;
        const everyoneRole = interaction.guild.roles.everyone;

        try {
            const currentPermissions = channel.permissionsFor(everyoneRole);
            if (
                currentPermissions.has(PermissionFlagsBits.SendMessages) ===
                    true ||
                currentPermissions.has(PermissionFlagsBits.SendMessages) ===
                    null
            ) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('moderation.unlock.notLocked', { channel: String(channel) }) });
            }

            // Clear the deny instead of allowing: the channel goes back to inheriting from
            // its category, as it was before /lock.
            await channel.permissionOverwrites.edit(
                everyoneRole,
                { SendMessages: null },
                {
                    type: 0,
                    reason: `Channel unlocked by ${interaction.user.tag}`,
},
            );

            await logEvent({
                client,
                guild: interaction.guild,
                event: {
                    action: "Channel Unlocked",
                    target: channel.toString(),
                    executor: `${interaction.user.tag} (${interaction.user.id})`,
                    metadata: {
                        channelId: channel.id,
                        category: channel.parent?.name || 'None'
                    }
                }
            });

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    successEmbed(
                        pub.t('moderation.unlock.title'),
                        pub.t('moderation.unlock.done', { channel: String(channel) }),
                    ),
                ],
            });
        } catch (error) {
            logger.error('Unlock command error:', error);
            await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('moderation.unlock.failed') });
        }
    }
};