import { PermissionsBitField, MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { setLogChannel } from '../../../services/loggingService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
export default {
    async execute(interaction, config, client) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Server** permissions to set the report channel.' });
        }

        const channel = interaction.options.getChannel('channel');
        const guildId = interaction.guildId;

        try {
            // setLogChannel reports failure via its return value rather than throwing.
            const saved = await setLogChannel(client, guildId, 'reports', channel.id);
            if (!saved) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not save the channel configuration.' });
            }

            return InteractionHelper.safeReply(interaction, {
                embeds: [successEmbed(
                    'Report Channel Set',
                    `All new reports will now be sent to ${channel}.\nYou can also manage this from \`/logging dashboard\`.`,
                )],
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            logger.error('report_setchannel error:', error);
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not save the channel configuration.' });
        }
    },
};
