import { MessageFlags } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { logEvent, EVENT_TYPES, resolveLogChannel } from '../../../services/loggingService.js';
import { formatLogLine, resolveUserAuthor } from '../../../utils/logging/logEmbeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { logger } from '../../../utils/logger.js';
import { textForGuild } from '../../../utils/botText.js';
import { replyText } from '../../Core/modules/commandText.js';
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
        // The answers are private (the reporter's language); the post in the report channel is the server's.
        const tr = replyText(interaction);
        const staff = textForGuild(guildId, { purpose: 'public' });
        if (!(await checkRateLimit(`report:${guildId}:${interaction.user.id}`, REPORT_LIMIT, REPORT_WINDOW_MS))) {
            return await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: tr.t('utility.report.rateLimited') });
        }

        const targetUser = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');

        const guildConfig = await getGuildConfig(client, guildId);
        const reportChannelId = resolveLogChannel(guildConfig, 'reports');

        if (!reportChannelId) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.report.noChannel') });
        }

        const ownerMention = interaction.guild.ownerId
            ? staff.t('utility.report.ownerPing', { ownerId: interaction.guild.ownerId })
            : staff.t('utility.report.newReport');

        const sent = await logEvent({
            client,
            guildId,
            eventType: EVENT_TYPES.REPORT_FILE,
            content: ownerMention,
            data: {
                title: staff.t('utility.report.logTitle'),
                lines: [
                    formatLogLine(staff.t('utility.report.reportedUser'), `${targetUser.tag} (\`${targetUser.id}\`)`),
                    formatLogLine(staff.t('utility.report.reportedBy'), `${interaction.user.tag} (\`${interaction.user.id}\`)`),
                    formatLogLine(staff.t('utility.report.channel'), interaction.channel.toString()),
                ],
                blockFields: [{ name: staff.t('utility.report.reason'), value: reason }],
                author: await resolveUserAuthor(client, targetUser.id),
                thumbnail: targetUser.displayAvatarURL(),
            },
        });

        // logEvent returns null (without throwing) when logging is disabled, the channel
        // is gone, or the bot lacks permissions there — don't claim the report was filed.
        if (!sent) {
            return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: tr.t('utility.report.notDelivered') });
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: tr.t('utility.report.submittedTitle'),
                description: tr.t('utility.report.submitted', { tag: targetUser.tag }),
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
