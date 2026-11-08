import { getColor } from '../../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    UserSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed, infoEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { updateTicketSettings, clearTicketSettings } from '../../../services/ticketSettingsService.js';
import { refreshTicketPanel, repostTicketPanel as repostTicketPanelService } from '../../../services/ticketPanelService.js';
import { getGuildTicketStats } from '../../../utils/database/tickets.js';
import { getUserTicketCount } from '../../../services/ticket.js';
import {
    getTicketPanelStatus,
    messageHasButtonCustomId,
    formatPanelStatusField,
} from '../../../utils/panelStatus.js';
import { startDashboardSession } from '../../../utils/dashboardSession.js';
import { randomBytes } from 'node:crypto';
import { hasOwnerPower } from '../../../utils/ownerPower.js';
import { getAdminRequiredMessage, hasAdministrator } from '../../../utils/commandGate.js';
import { botText, textForInteraction } from '../../../utils/botText.js';

// Everything here is an ephemeral answer to the admin: their Discord language (docs/bot-i18n.md).

function buildButtonRow(guildConfig, guildId, disabled = false, panelStatus = null, tr = botText('en')) {
    const dmEnabled = guildConfig.dmOnClose !== false;
    const showRepost = panelStatus?.exists === false && panelStatus?.reason === 'panel_deleted';

    const buttons = [];

    if (showRepost) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`ticket_cfg_repost_${guildId}`)
                .setLabel(tr.t('ticket.dash.repost'))
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled),
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_dm_toggle_${guildId}`)
            .setLabel(tr.t('ticket.dash.dmToggle'))
            .setStyle(dmEnabled ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_staff_role_btn_${guildId}`)
            .setLabel(tr.t('ticket.dash.staffRoleButton'))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_delete_${guildId}`)
            .setLabel(tr.t('ticket.dash.deleteSystem'))
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
    );

    return new ActionRowBuilder().addComponents(buttons);
}

async function persistPanelMessageId(client, guildId, guildConfig, messageId) {
    if (!messageId || guildConfig.ticketPanelMessageId === messageId) return;
    guildConfig.ticketPanelMessageId = messageId;
    if (client.db) {
        await updateTicketSettings(client, guildId, { ticketPanelMessageId: messageId });
    }
}

// The panel message itself (build, repost, refresh) lives in
// services/ticketPanelService.js, shared with /ticket setup and the web dashboard.
async function repostTicketPanel(client, guild, guildConfig, { lang = 'en' } = {}) {
    return repostTicketPanelService(client, guild, guildConfig, { lang });
}

function formatCloseDuration(ms, tr = botText('en')) {
    if (ms == null) return `\`${tr.t('ticket.dash.na')}\``;
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function buildDashboardEmbed(config, guild, panelStatus = null, ticketStats = null, tr = botText('en')) {
    const notSet = `\`${tr.t('ticket.dash.notSet')}\``;
    const panelChannel = config.ticketPanelChannelId ? `<#${config.ticketPanelChannelId}>` : notSet;
    const staffRole = config.ticketStaffRoleId ? `<@&${config.ticketStaffRoleId}>` : notSet;
    const ticketLogsChannel = config.ticketLogsChannelId ? `<#${config.ticketLogsChannelId}>` : notSet;
    const transcriptChannel = config.ticketTranscriptChannelId ? `<#${config.ticketTranscriptChannelId}>` : notSet;

    const openCategoryChannel = config.ticketCategoryId ? guild.channels.cache.get(config.ticketCategoryId) : null;
    const openCategory = openCategoryChannel ? openCategoryChannel.toString() : notSet;
    
    const closedCategoryChannel = config.ticketClosedCategoryId ? guild.channels.cache.get(config.ticketClosedCategoryId) : null;
    const closedCategory = closedCategoryChannel ? closedCategoryChannel.toString() : notSet;

    const rawMsg = config.ticketPanelMessage || tr.t('ticket.panel.defaultMessage');
    const panelMsg = `\`${rawMsg.length > 60 ? rawMsg.substring(0, 60) + '…' : rawMsg}\``;
    const btnLabel = `\`${config.ticketButtonLabel || tr.t('ticket.panel.defaultButton')}\``;

    let panelStatusValue = formatPanelStatusField(panelStatus);

    const openTickets = ticketStats ? String(ticketStats.openCount) : '`-`';
    const avgCloseTime = ticketStats ? formatCloseDuration(ticketStats.avgCloseTimeMs, tr) : '`-`';
    const feedbackSummary = ticketStats?.feedbackCount
        ? tr.tp('ticket.dash.ratings', ticketStats.feedbackCount, { avg: ticketStats.avgRating })
        : `\`${tr.t('ticket.dash.noRatings')}\``;

    return new EmbedBuilder()
        .setTitle(tr.t('ticket.dash.title'))
        .setDescription(tr.t('ticket.dash.description', { server: guild.name }))
        .setColor(getColor('info'))
        .addFields(
            { name: tr.t('ticket.dash.fieldPanelStatus'), value: panelStatusValue, inline: false },
            { name: tr.t('ticket.dash.fieldPanelChannel'), value: panelChannel, inline: true },
            { name: tr.t('ticket.dash.fieldStaffRole'), value: staffRole, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: tr.t('ticket.dash.fieldOpenCategory'), value: openCategory, inline: true },
            { name: tr.t('ticket.dash.fieldClosedCategory'), value: closedCategory, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: tr.t('ticket.dash.fieldPanelMessage'), value: panelMsg, inline: false },
            { name: tr.t('ticket.dash.fieldButtonLabel'), value: btnLabel, inline: true },
            { name: tr.t('ticket.dash.fieldMaxPerUser'), value: String(config.maxTicketsPerUser || 3), inline: true },
            { name: tr.t('ticket.dash.fieldClosureDm'), value: config.dmOnClose !== false ? tr.t('ticket.enabled') : tr.t('ticket.disabled'), inline: true },
            { name: tr.t('ticket.dash.fieldLogsChannel'), value: ticketLogsChannel, inline: true },
            { name: tr.t('ticket.dash.fieldTranscriptChannel'), value: transcriptChannel, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: tr.t('ticket.dash.fieldOpenTickets'), value: openTickets, inline: true },
            { name: tr.t('ticket.dash.fieldAvgClose'), value: avgCloseTime, inline: true },
            { name: tr.t('ticket.dash.fieldRating'), value: feedbackSummary, inline: true },
        )
        .setFooter({ text: tr.t('ticket.dash.footer') })
        .setTimestamp();
}

function buildSelectMenu(guildId, tr = botText('en')) {
    return new StringSelectMenuBuilder()
        .setCustomId(`ticket_config_${guildId}`)
        .setPlaceholder(tr.t('ticket.dash.selectPlaceholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('ticket.dash.optPanelMessage'))
                .setDescription(tr.t('ticket.dash.optPanelMessageDesc'))
                .setValue('panel_message'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('ticket.dash.optButtonLabel'))
                .setDescription(tr.t('ticket.dash.optButtonLabelDesc'))
                .setValue('button_label'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('ticket.dash.optOpenCategory'))
                .setDescription(tr.t('ticket.dash.optOpenCategoryDesc'))
                .setValue('open_category'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('ticket.dash.optClosedCategory'))
                .setDescription(tr.t('ticket.dash.optClosedCategoryDesc'))
                .setValue('closed_category'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('ticket.dash.optMaxTickets'))
                .setDescription(tr.t('ticket.dash.optMaxTicketsDesc'))
                .setValue('max_tickets'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('ticket.dash.optLogsChannel'))
                .setDescription(tr.t('ticket.dash.optLogsChannelDesc'))
                .setValue('logs_channel'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('ticket.dash.optTranscriptChannel'))
                .setDescription(tr.t('ticket.dash.optTranscriptChannelDesc'))
                .setValue('transcript_channel'),
        );
}

async function refreshDashboard(rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(rootInteraction);
    const panelStatus = client
        ? await getTicketPanelStatus(client, rootInteraction.guild, guildConfig)
        : null;
    const ticketStats = client ? await getGuildTicketStats(guildId) : null;

    if (panelStatus?.recoveredId) {
        await persistPanelMessageId(client, guildId, guildConfig, panelStatus.recoveredId);
    }

    const buttonRow = buildButtonRow(guildConfig, guildId, false, panelStatus, tr);
    const selectRow = new ActionRowBuilder().addComponents(buildSelectMenu(guildId, tr));
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [buildDashboardEmbed(guildConfig, rootInteraction.guild, panelStatus, ticketStats, tr)],
        components: [buttonRow, selectRow],
    }).catch(() => {});
}

async function updateLivePanel(client, guild, config) {
    return refreshTicketPanel(client, guild, config);
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        try {
            const guildId = interaction.guild.id;
            const guildConfig = await getGuildConfig(client, guildId);

            if (!guildConfig.ticketPanelChannelId) {
                throw new TitanBotError(
                    'Ticket system not configured',
                    ErrorTypes.CONFIGURATION,
                    tr.t('ticket.dash.notConfigured'),
                );
            }

            const panelStatus = await getTicketPanelStatus(client, interaction.guild, guildConfig);
            if (panelStatus.recoveredId) {
                await persistPanelMessageId(client, guildId, guildConfig, panelStatus.recoveredId);
            }

            const ticketStats = await getGuildTicketStats(guildId);

            const selectRow = new ActionRowBuilder().addComponents(buildSelectMenu(guildId, tr));
            const buttonRow = buildButtonRow(guildConfig, guildId, false, panelStatus, tr);

            await startDashboardSession({
                interaction,
                embeds: [buildDashboardEmbed(guildConfig, interaction.guild, panelStatus, ticketStats, tr)],
                components: [buttonRow, selectRow],
                selectMenuId: `ticket_config_${guildId}`,
                buttonMatcher: (customId) =>
                    customId === `ticket_cfg_repost_${guildId}` ||
                    customId === `ticket_cfg_dm_toggle_${guildId}` ||
                    customId === `ticket_cfg_staff_role_btn_${guildId}` ||
                    customId === `ticket_cfg_delete_${guildId}`,
                onSelect: async (selectInteraction) => {
                    const selectedOption = selectInteraction.values[0];
                    switch (selectedOption) {
                        case 'panel_message':
                            await handlePanelMessage(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'button_label':
                            await handleButtonLabel(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'staff_role':
                            await handleStaffRole(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'open_category':
                            await handleOpenCategory(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'closed_category':
                            await handleClosedCategory(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'max_tickets':
                            await handleMaxTickets(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'logs_channel':
                            await handleLogsChannel(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'transcript_channel':
                            await handleTranscriptChannel(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                    }
                },
                onButton: async (btnInteraction) => {
                    if (btnInteraction.customId === `ticket_cfg_repost_${guildId}`) {
                        await handleRepostPanel(btnInteraction, interaction, guildConfig, guildId, client);
                    } else if (btnInteraction.customId === `ticket_cfg_dm_toggle_${guildId}`) {
                        await handleDmOnClose(btnInteraction, interaction, guildConfig, guildId, client);
                    } else if (btnInteraction.customId === `ticket_cfg_staff_role_btn_${guildId}`) {
                        await handleStaffRole(btnInteraction, interaction, guildConfig, guildId, client);
                    } else if (btnInteraction.customId === `ticket_cfg_delete_${guildId}`) {
                        await handleDeleteSystem(btnInteraction, interaction, guildConfig, guildId, client);
                    }
                },
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in ticket_config:', error);
            throw new TitanBotError(
                `Ticket config failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                tr.t('ticket.dash.openFailed'),
            );
        }
    },
};

async function handlePanelMessage(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('ticket_cfg_panel_msg')
        .setTitle(tr.t('ticket.dash.optPanelMessage'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('panel_msg_input')
                    .setLabel(tr.t('ticket.dash.panelMessageLabel'))
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(
                        guildConfig.ticketPanelMessage ||
                            tr.t('ticket.panel.defaultMessage'),
                    )
                    .setMaxLength(2000)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder(tr.t('ticket.panel.defaultMessage')),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'ticket_cfg_panel_msg' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newMessage = submitted.fields.getTextInputValue('panel_msg_input').trim();
    guildConfig.ticketPanelMessage = newMessage;
    await updateTicketSettings(client, guildId, { ticketPanelMessage: guildConfig.ticketPanelMessage });

    const panelUpdated = await updateLivePanel(client, rootInteraction.guild, guildConfig, guildId);

    await submitted.reply({
        embeds: [
            successEmbed(
                tr.t('ticket.dash.panelMessageUpdatedTitle'),
                tr.t('ticket.dash.panelMessageUpdated') + (
                    panelUpdated
                        ? tr.t('ticket.dash.panelRefreshed')
                        : tr.t('ticket.dash.panelNotFound')
                ),
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

async function handleButtonLabel(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('ticket_cfg_btn_label')
        .setTitle(tr.t('ticket.dash.optButtonLabel'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('btn_label_input')
                    .setLabel(tr.t('ticket.dash.buttonLabelLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(guildConfig.ticketButtonLabel || tr.t('ticket.panel.defaultButton'))
                    .setMaxLength(80)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder(tr.t('ticket.panel.defaultButton')),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'ticket_cfg_btn_label' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newLabel = submitted.fields.getTextInputValue('btn_label_input').trim();
    guildConfig.ticketButtonLabel = newLabel;
    await updateTicketSettings(client, guildId, { ticketButtonLabel: guildConfig.ticketButtonLabel });

    const panelUpdated = await updateLivePanel(client, rootInteraction.guild, guildConfig, guildId);

    await submitted.reply({
        embeds: [
            successEmbed(
                tr.t('ticket.dash.buttonLabelUpdatedTitle'),
                tr.t('ticket.dash.buttonLabelUpdated', { label: newLabel }) + (
                    panelUpdated
                        ? tr.t('ticket.dash.buttonRefreshed')
                        : tr.t('ticket.dash.panelNotFound')
                ),
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

async function handleStaffRole(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    await selectInteraction.deferUpdate();

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('ticket_cfg_staff_role')
        .setPlaceholder(tr.t('ticket.dash.staffRolePlaceholder'))
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(roleSelect);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('ticket.dash.staffRoleTitle'))
                .setDescription(
                    tr.t('ticket.dash.staffRoleBody', { current: guildConfig.ticketStaffRoleId ? `<@&${guildConfig.ticketStaffRoleId}>` : `\`${tr.t('ticket.dash.notSet')}\`` }),
                )
                .setColor(getColor('info')),
        ],
        components: [row],
        flags: MessageFlags.Ephemeral,
    });

    const roleCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.RoleSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_staff_role',
        time: 60_000,
        max: 1,
    });

    roleCollector.on('collect', async roleInteraction => {
        await roleInteraction.deferUpdate();
        const role = roleInteraction.roles.first();

        guildConfig.ticketStaffRoleId = role.id;
        await updateTicketSettings(client, guildId, { ticketStaffRoleId: guildConfig.ticketStaffRoleId });

        await roleInteraction.followUp({
            embeds: [successEmbed(tr.t('ticket.dash.staffRoleUpdatedTitle'), tr.t('ticket.dash.staffRoleUpdated', { role: String(role) }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
    });

    roleCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('ticket.dash.staffRoleTimeout'),
            }).catch(() => {});
        }
    });
}

async function handleOpenCategory(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_open_cat')
        .setPlaceholder(tr.t('ticket.dash.categoryPlaceholder'))
        .addChannelTypes(ChannelType.GuildCategory)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('ticket.dash.optOpenCategory'))
                .setDescription(
                    tr.t('ticket.dash.openCategoryBody', { current: guildConfig.ticketCategoryId ? `<#${guildConfig.ticketCategoryId}>` : `\`${tr.t('ticket.dash.notSet')}\`` }),
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const catCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_open_cat',
        time: 60_000,
        max: 1,
    });

    catCollector.on('collect', async catInteraction => {
        await catInteraction.deferUpdate();
        const category = catInteraction.channels.first();

        guildConfig.ticketCategoryId = category.id;
        await updateTicketSettings(client, guildId, { ticketCategoryId: guildConfig.ticketCategoryId });

        await catInteraction.followUp({
            embeds: [
                successEmbed(
                    tr.t('ticket.dash.openCategoryUpdatedTitle'),
                    tr.t('ticket.dash.openCategoryUpdated', { category: category.name }),
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
    });

    catCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('ticket.dash.categoryTimeout'),
            }).catch(() => {});
        }
    });
}

async function handleClosedCategory(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_closed_cat')
        .setPlaceholder(tr.t('ticket.dash.categoryPlaceholder'))
        .addChannelTypes(ChannelType.GuildCategory)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('ticket.dash.optClosedCategory'))
                .setDescription(
                    tr.t('ticket.dash.closedCategoryBody', { current: guildConfig.ticketClosedCategoryId ? `<#${guildConfig.ticketClosedCategoryId}>` : `\`${tr.t('ticket.dash.notSet')}\`` }),
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const catCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_closed_cat',
        time: 60_000,
        max: 1,
    });

    catCollector.on('collect', async catInteraction => {
        await catInteraction.deferUpdate();
        const category = catInteraction.channels.first();

        guildConfig.ticketClosedCategoryId = category.id;
        await updateTicketSettings(client, guildId, { ticketClosedCategoryId: guildConfig.ticketClosedCategoryId });

        await catInteraction.followUp({
            embeds: [
                successEmbed(
                    tr.t('ticket.dash.closedCategoryUpdatedTitle'),
                    tr.t('ticket.dash.closedCategoryUpdated', { category: category.name }),
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
    });

    catCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('ticket.dash.categoryTimeout'),
            }).catch(() => {});
        }
    });
}

async function handleMaxTickets(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('ticket_cfg_max_tickets')
        .setTitle(tr.t('ticket.dash.optMaxTickets'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('max_tickets_input')
                    .setLabel(tr.t('ticket.dash.maxTicketsLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(guildConfig.maxTicketsPerUser || 3))
                    .setMaxLength(2)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('3'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'ticket_cfg_max_tickets' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const raw = submitted.fields.getTextInputValue('max_tickets_input').trim();
    const newMax = parseInt(raw, 10);

    if (Number.isNaN(newMax) || newMax < 1 || newMax > 10) {
        await replyUserError(submitted, {
            type: ErrorTypes.VALIDATION,
            message: tr.t('ticket.dash.maxTicketsInvalid'),
        });
        return;
    }

    guildConfig.maxTicketsPerUser = newMax;
    await updateTicketSettings(client, guildId, { maxTicketsPerUser: guildConfig.maxTicketsPerUser });

    await submitted.reply({
        embeds: [
            successEmbed(
                tr.t('ticket.dash.maxTicketsUpdatedTitle'),
                tr.tp('ticket.dash.maxTicketsUpdated', newMax),
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

async function handleDmOnClose(btnInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(btnInteraction);
    await btnInteraction.deferUpdate();

    const newState = guildConfig.dmOnClose === false;
    guildConfig.dmOnClose = newState;
    await updateTicketSettings(client, guildId, { dmOnClose: guildConfig.dmOnClose });

    await btnInteraction.followUp({
        embeds: [
            successEmbed(
                tr.t('ticket.dash.dmUpdatedTitle'),
                newState ? tr.t('ticket.dash.dmOn') : tr.t('ticket.dash.dmOff'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

async function handleLogsChannel(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_logs_channel')
        .setPlaceholder(tr.t('ticket.dash.channelPlaceholder'))
        .addChannelTypes(ChannelType.GuildText)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('ticket.dash.logsTitle'))
                .setDescription(tr.t('ticket.dash.logsBody'))
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i => i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_logs_channel',
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async channelInteraction => {
        await channelInteraction.deferUpdate();
        const channel = channelInteraction.channels.first();

        guildConfig.ticketLogsChannelId = channel.id;
        await updateTicketSettings(client, guildId, { ticketLogsChannelId: guildConfig.ticketLogsChannelId });

        await channelInteraction.followUp({
            embeds: [successEmbed(tr.t('ticket.dash.logsUpdatedTitle'), tr.t('ticket.dash.logsUpdated', { channel: String(channel) }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('ticket.dash.channelTimeout'),
            }).catch(() => {});
        }
    });
}

async function handleTranscriptChannel(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_transcript_channel')
        .setPlaceholder(tr.t('ticket.dash.channelPlaceholder'))
        .addChannelTypes(ChannelType.GuildText)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('ticket.dash.transcriptTitle'))
                .setDescription(tr.t('ticket.dash.transcriptBody'))
                .setColor(getColor('info'))
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i => i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_transcript_channel',
        time: 60_000,
        max: 1
    });

    collector.on('collect', async channelInteraction => {
        await channelInteraction.deferUpdate();
        const channel = channelInteraction.channels.first();

        guildConfig.ticketTranscriptChannelId = channel.id;
        await updateTicketSettings(client, guildId, { ticketTranscriptChannelId: guildConfig.ticketTranscriptChannelId });

        await channelInteraction.followUp({
            embeds: [successEmbed(tr.t('ticket.dash.transcriptUpdatedTitle'), tr.t('ticket.dash.transcriptUpdated', { channel: String(channel) }))],
            flags: MessageFlags.Ephemeral
        });

        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('ticket.dash.channelTimeout'),
            }).catch(() => {});
        }
    });
}

async function handleCheckUser(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await selectInteraction.deferUpdate();

    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('ticket_cfg_check_user')
        .setPlaceholder('Select a user to check...')
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(userSelect);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Check user tickets')
                .setDescription('Select a user to view their current open ticket count.')
                .setColor(getColor('info')),
        ],
        components: [row],
        flags: MessageFlags.Ephemeral,
    });

    const userCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.UserSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_check_user',
        time: 60_000,
        max: 1,
    });

    userCollector.on('collect', async userInteraction => {
        await userInteraction.deferUpdate();
        const targetUser = userInteraction.users.first();
        const maxTickets = guildConfig.maxTicketsPerUser || 3;
        const openCount = await getUserTicketCount(guildId, targetUser.id);
        const atLimit = openCount >= maxTickets;

        await userInteraction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle(`Ticket Check: ${targetUser.username}`)
                    .setDescription(
                        `**Open Tickets:** ${openCount} / ${maxTickets}\n` +
                            `**Remaining:** ${Math.max(0, maxTickets - openCount)}\n\n` +
                            (atLimit
                                ? 'This user has reached their ticket limit.'
                                : 'This user can still open more tickets.'),
                    )
                    .setColor(atLimit ? getColor('error') : getColor('success'))
                    .setThumbnail(targetUser.displayAvatarURL({ size: 64 }))
                    .setTimestamp(),
            ],
            flags: MessageFlags.Ephemeral,
        });
    });

    userCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No user was selected.',
            }).catch(() => {});
        }
    });
}

async function handleRepostPanel(btnInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(btnInteraction);
    await btnInteraction.deferUpdate();

    const panelStatus = await getTicketPanelStatus(client, rootInteraction.guild, guildConfig);
    if (panelStatus.exists) {
        await btnInteraction.followUp({
            embeds: [infoEmbed(tr.t('ticket.dash.panelActiveTitle'), tr.t('ticket.dash.panelActiveBody'))],
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
        return;
    }

    const sentPanel = await repostTicketPanel(client, rootInteraction.guild, guildConfig, { lang: tr.lang });

    await btnInteraction.followUp({
        embeds: [
            successEmbed(
                tr.t('ticket.dash.repostedTitle'),
                tr.t('ticket.dash.repostedBody', { channelId: guildConfig.ticketPanelChannelId })
                    + (sentPanel.url ? tr.t('ticket.dash.repostedLink', { url: sentPanel.url }) : ''),
            ),
        ],
        flags: MessageFlags.Ephemeral,
    }).catch(() => {});

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

/** How long the Confirm / Cancel buttons of "Delete system" stay usable. */
export const TICKET_DELETE_CONFIRM_MS = 60_000;

const NO_MENTIONS = { parse: [] };

/** Administrator in this server (the owner counts) or OWNER_IDS, checked on the click itself. */
export function canDeleteTicketSystem(interaction) {
    return hasOwnerPower(interaction.user.id, interaction.guildId)
        || hasAdministrator({ guild: interaction.guild, userId: interaction.user.id, permissions: interaction.memberPermissions });
}

/**
 * Asks "Delete the ticket system?" with [Delete ticket system] (danger) and [Cancel] in an
 * ephemeral reply to the Delete system button. Only the same user's click counts; it is
 * acknowledged at once (deferUpdate), then the permission is checked again. After timeoutMs
 * the buttons are removed and the message says it expired.
 * Resolves to { outcome: 'confirm' | 'cancel' | 'denied' | 'expired', interaction }; on
 * 'confirm' the caller deletes and edits `interaction`'s reply with the result.
 */
export async function askTicketDeleteConfirm(btnInteraction, { timeoutMs = TICKET_DELETE_CONFIRM_MS, canDelete = canDeleteTicketSystem } = {}) {
    const tr = textForInteraction(btnInteraction);
    const nonce = randomBytes(6).toString('hex');
    const yesId = `ticket_delete_yes_${nonce}`;
    const noId = `ticket_delete_no_${nonce}`;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(yesId).setLabel(tr.t('ticket.dash.deleteYes')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(noId).setLabel(tr.t('ticket.dash.deleteCancel')).setStyle(ButtonStyle.Secondary),
    );
    const seconds = Math.round(timeoutMs / 1000);
    await btnInteraction.reply({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('ticket.dash.deleteTitle'))
                .setDescription([
                    tr.t('ticket.dash.deleteWhat'),
                    tr.t('ticket.dash.deleteChannelsKept'),
                    tr.t('ticket.dash.deleteUndo'),
                    tr.tp('ticket.dash.deleteWindow', seconds),
                ].join('\n\n'))
                .setColor(getColor('error')),
        ],
        components: [row],
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
    });
    const prompt = await btnInteraction.fetchReply();
    const click = await prompt.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === btnInteraction.user.id && (i.customId === yesId || i.customId === noId),
        time: timeoutMs,
    }).catch(() => null);

    if (!click) {
        await btnInteraction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle(tr.t('ticket.dash.expiredTitle'))
                    .setDescription(tr.tp('ticket.dash.expiredBody', seconds))
                    .setColor(getColor('error')),
            ],
            components: [],
            allowedMentions: NO_MENTIONS,
        }).catch(() => {});
        return { outcome: 'expired', interaction: null };
    }

    // Ack first (3-second limit), then check again: roles can change while the buttons wait.
    await click.deferUpdate();
    const done = (title, description) => click.editReply({
        embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(getColor('error'))],
        components: [],
        allowedMentions: NO_MENTIONS,
    }).catch(() => {});

    if (click.customId === noId) {
        await done(tr.t('ticket.dash.cancelledTitle'), tr.t('ticket.dash.nothingDeleted'));
        return { outcome: 'cancel', interaction: click };
    }
    if (!canDelete(click)) {
        await done(tr.t('ticket.dash.notAllowedTitle'), `${getAdminRequiredMessage(click.guildId, { lang: tr.lang })}\n${tr.t('ticket.dash.nothingDeleted')}`);
        return { outcome: 'denied', interaction: click };
    }
    return { outcome: 'confirm', interaction: click };
}

async function handleDeleteSystem(btnInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(btnInteraction);
    const { outcome, interaction: confirmed } = await askTicketDeleteConfirm(btnInteraction);
    if (outcome !== 'confirm') {
        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
        return;
    }

    const keysToDelete = [
        'ticketPanelChannelId',
        'ticketPanelMessageId',
        'ticketStaffRoleId',
        'ticketCategoryId',
        'ticketClosedCategoryId',
        'ticketPanelMessage',
        'ticketButtonLabel',
        'maxTicketsPerUser',
        'dmOnClose',
    ];

    if (guildConfig.ticketPanelChannelId) {
        try {
            const panelChannel = await client.guilds.cache.get(guildId)?.channels.fetch(guildConfig.ticketPanelChannelId).catch(() => null);
            if (panelChannel) {
                if (guildConfig.ticketPanelMessageId) {
                    const panelMessage = await panelChannel.messages.fetch(guildConfig.ticketPanelMessageId).catch(() => null);
                    if (panelMessage) await panelMessage.delete().catch(() => {});
                } else {
                    
                    const messages = await panelChannel.messages.fetch({ limit: 50 }).catch(() => null);
                    if (messages) {
                        const found = messages.find(
                            m => m.author.id === client.user.id && messageHasButtonCustomId(m, 'create_ticket'),
                        );
                        if (found) await found.delete().catch(() => {});
                    }
                }
            }
        } catch (panelDeleteError) {
            logger.warn('Could not delete ticket panel message:', panelDeleteError.message);
        }
    }

    try {
        const { pgConfig } = await import('../../../config/database/postgres.js');
        if (client.db?.db?.pool && typeof client.db.db.isAvailable === 'function' && client.db.db.isAvailable()) {
            await client.db.db.pool.query(
                `DELETE FROM ${pgConfig.tables.tickets} WHERE guild_id = $1`,
                [guildId]
            );
        }
    } catch (ticketDeleteError) {
        logger.warn('Could not clear ticket records from database:', ticketDeleteError.message);
    }

    try {
        await clearTicketSettings(client, guildId, keysToDelete);
    } catch (error) {
        logger.error('Could not clear ticket settings:', error);
        await confirmed.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle(tr.t('ticket.dash.notFinishedTitle'))
                    .setDescription(tr.t('ticket.dash.notFinishedBody'))
                    .setColor(getColor('error')),
            ],
            components: [],
            allowedMentions: NO_MENTIONS,
        }).catch(() => {});
        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
        return;
    }
    for (const key of keysToDelete) {
        delete guildConfig[key];
    }

    await confirmed.editReply({
        embeds: [
            successEmbed(
                tr.t('ticket.dash.deletedTitle'),
                tr.t('ticket.dash.deletedBody'),
            ),
        ],
        components: [],
        allowedMentions: NO_MENTIONS,
    }).catch(() => {});

    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('ticket.dash.deletedTitle'))
                .setDescription(tr.t('ticket.dash.deletedRoot'))
                .setColor(getColor('error'))
                .setTimestamp(),
        ],
        components: [],
    }).catch(() => {});
}