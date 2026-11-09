import { PermissionsBitField, MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { setLogChannel } from '../../../services/loggingService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { replyText } from '../../../utils/commandLocalizations.js';

import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
export default {
    async execute(interaction, config, client) {
        // Every answer is private: the user's language.
        const tr = replyText(interaction);
        if (!hasAdminAccess(interaction)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('utility.report.setchannel.noAdmin') });
        }

        const channel = interaction.options.getChannel('channel');
        const guildId = interaction.guildId;

        try {
            // setLogChannel reports failure via its return value rather than throwing.
            const saved = await setLogChannel(client, guildId, 'reports', channel.id);
            if (!saved) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.report.setchannel.saveFailed') });
            }

            return InteractionHelper.safeReply(interaction, {
                embeds: [successEmbed(
                    tr.t('utility.report.setchannel.title'),
                    tr.t('utility.report.setchannel.done', { channel: String(channel) }),
                )],
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            logger.error('report_setchannel error:', error);
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.report.setchannel.saveFailed') });
        }
    },
};
