import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getTicketPermissionContext } from '../../utils/ticket/ticketPermissions.js';
import { claimTicket } from '../../services/ticket.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';
export default {
    data: new SlashCommandBuilder()
        .setName("claim")
        .setDescription("Claims an open ticket, assigning it to you.")
        .setDescriptionLocalizations(localizations('ticket.cmd.claim.description'))
        .setDMPermission(false),

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

        if (!permissionContext.canManageTicket) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('ticket.command.claimDenied') });
        }

        await claimTicket(interaction.channel, interaction.user, { lang: tr.lang });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    tr.t('ticket.reply.claimedTitle'),
                    tr.t('ticket.reply.claimedBody'),
                ),
            ],
        });

        logger.info('Ticket claimed successfully', {
            userId: interaction.user.id,
            userTag: interaction.user.tag,
            channelId: interaction.channel.id,
            channelName: interaction.channel.name,
            guildId: interaction.guildId,
            commandName: 'claim'
        });
    },
};
