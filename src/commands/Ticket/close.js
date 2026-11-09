import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getTicketPermissionContext } from '../../utils/ticket/ticketPermissions.js';
import { closeTicket, closedReplyText } from '../../services/ticket.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';
export default {
    data: new SlashCommandBuilder()
        .setName("close")
        .setDescription("Closes the current ticket.")
        .setDescriptionLocalizations(localizations('ticket.cmd.close.description'))
        .setDMPermission(false)
        .addStringOption((option) =>
            option
                .setName("reason")
                .setDescription("The reason for closing the ticket.")
                .setDescriptionLocalizations(localizations('ticket.cmd.close.reason'))
                .setRequired(false),
        ),

    async execute(interaction, guildConfig, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) {
            return;
        }

        const tr = textForInteraction(interaction);
        const permissionContext = await getTicketPermissionContext({ client, interaction });
        if (!permissionContext.ticketData) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('ticket.command.notTicketChannel') });
        }

        if (!permissionContext.canCloseTicket) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('ticket.command.closeDenied') });
        }

        // The default reason is stored on the ticket record and goes into the logs: kept in English.
        const reason =
            interaction.options?.getString("reason") ||
            "Closed via command without a specific reason.";

        const closed = await closeTicket(interaction.channel, interaction.user, reason, { lang: tr.lang });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    tr.t('ticket.reply.closedTitle'),
                    closedReplyText(tr, closed),
                ),
            ],
        });

        logger.info('Ticket closed successfully', {
            userId: interaction.user.id,
            userTag: interaction.user.tag,
            channelId: interaction.channel.id,
            channelName: interaction.channel.name,
            guildId: interaction.guildId,
            // Free text; the log gets its length only.
            reasonLength: reason ? String(reason).length : 0,
            commandName: 'close'
        });
    },
};
