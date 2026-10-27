import { MessageFlags } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { logEvent, EVENT_TYPES, resolveLogChannel } from '../../../services/loggingService.js';
import { formatLogLine, resolveUserAuthor } from '../../../utils/logging/logEmbeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { logger } from '../../../utils/logger.js';
import { checkRateLimit } from '../../../utils/rateLimiter.js';

// Each report pings the server owner, so members may file only a few at a time.
const REPORT_LIMIT = 2;
const REPORT_WINDOW_MS = 10 * 60 * 1000;

export default {
    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn('Report interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId });
            return;
        }

        const guildId = interaction.guildId;
        if (!(await checkRateLimit(`report:${guildId}:${interaction.user.id}`, REPORT_LIMIT, REPORT_WINDOW_MS))) {
            return await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: 'You have filed several reports recently. Please wait a few minutes before filing another.' });
        }

        const targetUser = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');

        const guildConfig = await getGuildConfig(client, guildId);
        const reportChannelId = resolveLogChannel(guildConfig, 'reports');

        if (!reportChannelId) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'The report channel has not been set up. Ask a moderator to use `/logging dashboard` or `/logging channel`.' });
        }

        const ownerMention = interaction.guild.ownerId
            ? `<@${interaction.guild.ownerId}> New report!`
            : 'New report!';

        const sent = await logEvent({
            client,
            guildId,
            eventType: EVENT_TYPES.REPORT_FILE,
            content: ownerMention,
            data: {
                title: 'User Report',
                lines: [
                    formatLogLine('Reported User', `${targetUser.tag} (\`${targetUser.id}\`)`),
                    formatLogLine('Reported By', `${interaction.user.tag} (\`${interaction.user.id}\`)`),
                    formatLogLine('Channel', interaction.channel.toString()),
                ],
                blockFields: [{ name: 'Reason', value: reason }],
                author: await resolveUserAuthor(client, targetUser.id),
                thumbnail: targetUser.displayAvatarURL(),
            },
        });

        // logEvent returns null (without throwing) when logging is disabled, the channel
        // is gone, or the bot lacks permissions there — don't claim the report was filed.
        if (!sent) {
            return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'Your report could not be delivered: the report channel is missing, logging is disabled, or I lack permission to post there. Please contact a moderator directly.' });
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: 'Report Submitted',
                description: `Your report against **${targetUser.tag}** has been successfully filed and sent to the moderation team. Thank you!`,
            })],
        });

        logger.info('Report submitted', {
            userId: interaction.user.id,
            reportedUserId: targetUser.id,
            guildId,
            reasonLength: reason.length,
        });
    },
};
