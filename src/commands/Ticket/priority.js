import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getTicketPermissionContext } from '../../utils/ticket/ticketPermissions.js';
import { priorityLabel, updateTicketPriority } from '../../services/ticket.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';

export default {
    data: new SlashCommandBuilder()
        .setName("priority")
        .setDescription("Sets the priority level for the current support ticket.")
        .setDescriptionLocalizations(localizations('ticket.cmd.priority.description'))
        .addStringOption((option) =>
            option
                .setName("level")
                .setDescription("The priority level for the ticket.")
                .setDescriptionLocalizations(localizations('ticket.cmd.priority.level'))
                .setRequired(true)
                .addChoices(
                    { name: "Urgent", name_localizations: localizations('ticket.priority.urgent'), value: "urgent" },
                    { name: "High", name_localizations: localizations('ticket.priority.high'), value: "high" },
                    { name: "Medium", name_localizations: localizations('ticket.priority.medium'), value: "medium" },
                    { name: "Low", name_localizations: localizations('ticket.priority.low'), value: "low" },
                    { name: "None", name_localizations: localizations('ticket.priority.none'), value: "none" },
                ),
            )
        .setDMPermission(false),
    category: "Ticket",

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
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('ticket.command.priorityDenied') });
        }

        const priorityLevel = interaction.options.getString("level");
        await updateTicketPriority(interaction.channel, priorityLevel, interaction.user, { lang: tr.lang });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    tr.t('ticket.command.priorityTitle'),
                    // English: the level in capitals, as before ("HIGH").
                    tr.t('ticket.command.priorityBody', { level: priorityLabel(priorityLevel, tr).toUpperCase() }),
                ),
            ],
        });

        logger.info('Ticket priority updated successfully', {
            userId: interaction.user.id,
            userTag: interaction.user.tag,
            channelId: interaction.channel.id,
            channelName: interaction.channel.name,
            guildId: interaction.guildId,
            priority: priorityLevel,
            commandName: 'priority'
        });
    },
};
