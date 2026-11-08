import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { setupTicketSystem } from '../../services/ticketPanelService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';

import ticketConfig from './modules/ticket_dashboard.js';

export default {
    data: new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Manages the server's ticket system.")
        .setDescriptionLocalizations(localizations('ticket.cmd.ticket.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand((subcommand) =>
            subcommand
                .setName("setup")
                .setDescription(
                    "Sets up the ticket creation panel in a specified channel.",
                )
                .setDescriptionLocalizations(localizations('ticket.cmd.ticket.setup.description'))
                .addChannelOption((option) =>
                    option
.setName("panel_channel")
                        .setDescription(
                            "The channel where the ticket panel will be sent.",
                        )
                        .setDescriptionLocalizations(localizations('ticket.cmd.ticket.setup.panelChannel'))
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true),
                )

                .addStringOption((option) =>
                    option
                        .setName("panel_message")
                        .setDescription(
                            "The main message/description for the ticket panel.",
                        )
                        .setDescriptionLocalizations(localizations('ticket.cmd.ticket.setup.panelMessage'))
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName("button_label")
                        .setDescription(
                            "The label for the ticket creation button (default: Open ticket)",
                        )
                        .setDescriptionLocalizations(localizations('ticket.cmd.ticket.setup.buttonLabel'))
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName("category")
                        .setDescription(
                            "The category where new tickets will be created (optional).",
                        )
                        .setDescriptionLocalizations(localizations('ticket.cmd.ticket.setup.category'))
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName("closed_category")
                        .setDescription(
                            "The category where closed tickets will be moved (optional).",
                        )
                        .setDescriptionLocalizations(localizations('ticket.cmd.ticket.setup.closedCategory'))
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addRoleOption((option) =>
                    option
                        .setName("staff_role")
                        .setDescription(
                            "The role that can access tickets (optional).",
                        )
                        .setDescriptionLocalizations(localizations('ticket.cmd.ticket.setup.staffRole'))
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    option
                        .setName("max_tickets_per_user")
                        .setDescription("Maximum number of tickets a user can create (default: 3)")
                        .setDescriptionLocalizations(localizations('ticket.cmd.ticket.setup.maxTickets'))
                        .setMinValue(1)
                        .setMaxValue(10)
                        .setRequired(false),
                )
                .addBooleanOption((option) =>
                    option
                        .setName("dm_on_close")
                        .setDescription("Send closure notice by DM; transcript and feedback DMs are separate (default: true)")
                        .setDescriptionLocalizations(localizations('ticket.cmd.ticket.setup.dmOnClose'))
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("dashboard")
                .setDescription("Open the interactive ticket system dashboard")
                .setDescriptionLocalizations(localizations('ticket.cmd.ticket.dashboard.description')),
        ),
    category: "ticket",

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) {
            return;
        }
        const tr = textForInteraction(interaction);

        if (
            !interaction.member.permissions.has(
                PermissionFlagsBits.ManageChannels,
            )
        ) {
            logger.warn('Ticket command permission denied', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'ticket'
            });
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('ticket.command.manageChannels') });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === "dashboard") {
            return ticketConfig.execute(interaction, config, client);
        }

        if (subcommand === "setup") {
            const existingConfig = await getGuildConfig(client, interaction.guildId);
            if (existingConfig?.ticketPanelChannelId) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('ticket.setup.exists', { channelId: existingConfig.ticketPanelChannelId }) });
            }

            const panelChannel =
                interaction.options.getChannel("panel_channel");
            const categoryChannel = interaction.options.getChannel("category");
            const closedCategoryChannel = interaction.options.getChannel("closed_category");
            const staffRole = interaction.options.getRole("staff_role");
            // These defaults are saved with the settings (and shown on the panel): kept in English.
const panelMessage = interaction.options.getString("panel_message") || "Need help from staff? Press the button below to open a private ticket.";
            const buttonLabel =
                interaction.options.getString("button_label") ||
"Open ticket";
            const maxTicketsPerUser = interaction.options.getInteger("max_tickets_per_user") || 3;
const dmOnClose = interaction.options.getBoolean("dm_on_close") !== false;

            try {
                // Validation (before anything is posted), bot permissions, posting and
                // saving: services/ticketPanelService.js (shared with the web dashboard).
                await setupTicketSystem(client, interaction.guild, {
                    panelChannel,
                    panelMessage,
                    buttonLabel,
                    categoryId: categoryChannel ? categoryChannel.id : null,
                    closedCategoryId: closedCategoryChannel ? closedCategoryChannel.id : null,
                    staffRoleId: staffRole ? staffRole.id : null,
                    maxTicketsPerUser,
                    dmOnClose,
                    lang: tr.lang,
                });
                logger.info('Ticket configuration saved', {
                    guildId: interaction.guildId,
                    categoryId: categoryChannel?.id,
                    closedCategoryId: closedCategoryChannel?.id,
                    staffRoleId: staffRole?.id,
                    maxTickets: maxTicketsPerUser,
                    dmOnClose: dmOnClose,
                });

                // One sentence each, separated by a space (they used to run together).
                const sentences = [tr.t('ticket.setup.sent', { channel: String(panelChannel) })];
                sentences.push(categoryChannel
                    ? tr.t('ticket.setup.inCategory', { category: categoryChannel.name })
                    : tr.t('ticket.setup.newCategory'));
                if (closedCategoryChannel) {
                    sentences.push(tr.t('ticket.setup.closedCategory', { category: closedCategoryChannel.name }));
                }
                if (staffRole) {
                    sentences.push(tr.t('ticket.setup.staffRole', { role: staffRole.name }));
                }
                const successMessage = `${sentences.join(' ')}\n\n${tr.t('ticket.setup.summary', {
                    max: maxTicketsPerUser,
                    dm: dmOnClose ? tr.t('ticket.enabled') : tr.t('ticket.disabled'),
                })}`;

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(
                            tr.t('ticket.setup.title'),
                            successMessage,
                        ),
                    ],
                });

                logger.info('Ticket panel setup completed', {
                    userId: interaction.user.id,
                    userTag: interaction.user.tag,
                    guildId: interaction.guildId,
                    panelChannelId: panelChannel.id,
                    categoryId: categoryChannel?.id,
                    closedCategoryId: closedCategoryChannel?.id,
                    staffRoleId: staffRole?.id,
                    maxTickets: maxTicketsPerUser,
                    dmOnClose: dmOnClose,
                    commandName: 'ticket_setup'
                });

            } catch (error) {
                logger.error('Ticket setup error', {
                    error: error.message,
                    stack: error.stack,
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'ticket_setup'
                });
                if (interaction.deferred || interaction.replied) {
                    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: error.userMessage || tr.t('ticket.setup.failed') }).catch(err => {
                        logger.error('Failed to send error reply', {
                            error: err.message,
                            guildId: interaction.guildId
                        });
                    });
                } else {
                    await handleInteractionError(interaction, error, {
                        commandName: 'ticket_setup',
                        source: 'ticket_setup_command'
                    });
                }
            }
        }
    }
};
