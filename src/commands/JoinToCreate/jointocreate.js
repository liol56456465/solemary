import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, LabelBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { hasAdminAccess } from '../../utils/commandGate.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';
import {
    setupJoinToCreate,
    getChannelConfiguration,
    updateChannelConfig,
    removeTriggerChannel,
    logConfigurationChange,
    getConfiguration,
    validateBitrate,
    validateUserLimit,
    joinToCreateErrorText
} from '../../services/joinToCreateService.js';

/** "Unlimited" or "5 users" in `tr`'s language. */
function limitText(tr, limit) {
    return limit === 0 ? tr.t('jointocreate.limit.unlimited') : tr.tp('jointocreate.limit.users', limit);
}

export default {
    data: new SlashCommandBuilder()
        .setName("jointocreate")
        .setDescription("Manage join to create voice channels")
        .setDescriptionLocalizations(localizations('jointocreate.cmd.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName("setup")
                .setDescription("Set up a join to create voice channel")
                .setDescriptionLocalizations(localizations('jointocreate.cmd.setup.description'))
                .addChannelOption((option) =>
                    option
                        .setName("category")
                        .setDescription("Category to create the channel in.")
                        .setDescriptionLocalizations(localizations('jointocreate.cmd.setup.category'))
                        .addChannelTypes(ChannelType.GuildCategory)
                )
                .addStringOption((option) =>
                    option
                        .setName("channel_name")
                        .setDescription("Select a template for naming temporary voice channels.")
                        .setDescriptionLocalizations(localizations('jointocreate.cmd.setup.channelName'))
                        .addChoices(
                            { name: "{username}'s Room (Default)", value: "{username}'s Room" },
                            { name: "{username}'s Channel", value: "{username}'s Channel" },
                            { name: "{username}'s Lounge", value: "{username}'s Lounge" },
                            { name: "{username}'s Space", value: "{username}'s Space" },
                            { name: "{displayName}'s Room", value: "{displayName}'s Room" },
                            { name: "{username}'s VC", value: "{username}'s VC" },
                            { name: "{username}'s Gaming Room", value: "{username}'s Gaming Room" },
                            { name: "{username}'s Chat Room", value: "{username}'s Chat Room" },
                            { name: "{username}'s Private Room", value: "{username}'s Private Room" }
                        )
                )
                .addIntegerOption((option) =>
                    option
                        .setName("user_limit")
                        .setDescription("Maximum number of users in temporary channels. (0 = unlimited)")
                        .setDescriptionLocalizations(localizations('jointocreate.cmd.setup.userLimit'))
                )
                .addIntegerOption((option) =>
                    option
                        .setName("bitrate")
                        .setDescription("Bitrate for temporary channels in kbps (8-96).")
                        .setDescriptionLocalizations(localizations('jointocreate.cmd.setup.bitrate'))
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("dashboard")
                .setDescription("Change join to create settings")
                .setDescriptionLocalizations(localizations('jointocreate.cmd.dashboard.description'))
                .addChannelOption((option) =>
                    option
                        .setName("trigger_channel")
                        .setDescription("The Join to Create trigger channel to configure.")
                        .setDescriptionLocalizations(localizations('jointocreate.cmd.dashboard.triggerChannel'))
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildVoice)
                )
        ),
    category: "utility",

    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        try {

            if (!hasAdminAccess(interaction)) {
                throw new TitanBotError(
                    'User lacks Administrator',
                    ErrorTypes.PERMISSION,
                    tr.t('jointocreate.error.adminCommand')
                );
            }

            const subcommand = interaction.options.getSubcommand();
            await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

            let responseEmbed;

            if (subcommand === "setup") {
                await handleSetupSubcommand(interaction, client, tr);
                return;
            } else if (subcommand === "dashboard") {
                await handleConfigSubcommand(interaction, client, tr);
                return;
            }

        } catch (error) {
            try {
                let errorMessage;

                if (error instanceof TitanBotError) {
                    errorMessage = joinToCreateErrorText(error, tr) || tr.t('jointocreate.error.tryAgain');
                    logger.debug(`TitanBotError [${error.type}]: ${error.message}`, error.context || {});
                } else {
                    logger.error('Unexpected error in jointocreate command:', error);
                    errorMessage = tr.t('jointocreate.error.unexpected');
                }

                return replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: errorMessage });
            } catch (replyError) {
                logger.error('Failed to send error message:', replyError);
            }
        }
    }
};

async function handleSetupSubcommand(interaction, client, tr) {
    try {
        const category = interaction.options.getChannel('category');
        const nameTemplate = interaction.options.getString('channel_name') || "{username}'s Room";
        const userLimit = interaction.options.getInteger('user_limit') || 0;
        const bitrate = interaction.options.getInteger('bitrate') || 64;

        logger.debug(`Setting up Join to Create in guild ${interaction.guild.id} with template: ${nameTemplate}`);

        // One trigger per server, validation before the channel is created, save and
        // log: services/joinToCreateService.js (shared with the web dashboard).
        const { channel: triggerChannel } = await setupJoinToCreate(client, interaction.guild, {
            categoryId: category?.id || null,
            nameTemplate,
            userLimit,
            bitrateKbps: bitrate,
            actorId: interaction.user.id,
        });

        const responseEmbed = successEmbed(
            tr.t('jointocreate.setup.title'),
            `${tr.t('jointocreate.setup.created', { channel: String(triggerChannel) })}\n\n` +
            `${tr.t('jointocreate.setup.settings')}\n` +
            `${tr.t('jointocreate.setup.template', { template: nameTemplate })}\n` +
            `${tr.t('jointocreate.setup.userLimit', { limit: limitText(tr, userLimit) })}\n` +
            `${tr.t('jointocreate.setup.bitrate', { kbps: bitrate })}\n` +
            `${category ? tr.t('jointocreate.setup.category', { category: category.name }) : tr.t('jointocreate.setup.categoryRoot')}`
        );

        return await InteractionHelper.safeEditReply(interaction, { embeds: [responseEmbed] });

    } catch (error) {
        logger.error('Error in handleSetupSubcommand:', error);
        if (error instanceof TitanBotError) {
            throw error;
        }
        throw new TitanBotError(
            `Setup failed: ${error.message}`,
            ErrorTypes.DISCORD_API,
            tr.t('jointocreate.error.setupFailed')
        );
    }
}

async function handleConfigSubcommand(interaction, client, tr) {
    try {
        const triggerChannel = interaction.options.getChannel('trigger_channel');
        const guildId = interaction.guild.id;

        const currentConfig = await getChannelConfiguration(client, guildId, triggerChannel.id);
        const channelConfig = currentConfig.channelConfig || {};

        const configEmbed = new EmbedBuilder()
            .setTitle(tr.t('jointocreate.panel.title'))
            .setDescription(tr.t('jointocreate.panel.description', { channel: String(triggerChannel) }))
            .setColor(getColor('info'))
            .addFields(
                {
                    name: tr.t('jointocreate.panel.nameTemplate'),
                    value: `\`${channelConfig.nameTemplate || currentConfig.channelNameTemplate || "{username}'s Room"}\``,
                    inline: false
                },
                {
                    name: tr.t('jointocreate.panel.userLimit'),
                    value: limitText(tr, channelConfig.userLimit ?? currentConfig.userLimit ?? 0),
                    inline: true
                },
                {
                    name: tr.t('jointocreate.panel.bitrate'),
                    value: tr.t('jointocreate.panel.kbps', { kbps: (channelConfig.bitrate ?? currentConfig.bitrate ?? 64000) / 1000 }),
                    inline: true
                }
            )
            .setFooter({ text: tr.t('jointocreate.panel.footer') })
            .setTimestamp();

        const nameButton = new ButtonBuilder()
            .setCustomId(`jtc_config_name_${triggerChannel.id}`)
            .setLabel(tr.t('jointocreate.panel.buttonName'))
            .setStyle(ButtonStyle.Primary);

        const limitButton = new ButtonBuilder()
            .setCustomId(`jtc_config_limit_${triggerChannel.id}`)
            .setLabel(tr.t('jointocreate.panel.buttonLimit'))
            .setStyle(ButtonStyle.Primary);

        const bitrateButton = new ButtonBuilder()
            .setCustomId(`jtc_config_bitrate_${triggerChannel.id}`)
            .setLabel(tr.t('jointocreate.panel.buttonBitrate'))
            .setStyle(ButtonStyle.Primary);

        const deleteButton = new ButtonBuilder()
            .setCustomId(`jtc_config_delete_${triggerChannel.id}`)
            .setLabel(tr.t('jointocreate.panel.buttonRemove'))
            .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(nameButton, limitButton, bitrateButton, deleteButton);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [configEmbed],
            components: [row]
        });

        const message = await interaction.fetchReply();

        if (!message || typeof message.createMessageComponentCollector !== 'function') {
            throw new TitanBotError(
                'Failed to fetch interaction reply for collector setup',
                ErrorTypes.DISCORD_API,
                tr.t('jointocreate.error.controlsFailed')
            );
        }

        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 300000
        });

        collector.on('collect', async (buttonInteraction) => {
            const btr = textForInteraction(buttonInteraction);
            try {

                if (!hasAdminAccess(buttonInteraction)) {
                    await buttonInteraction.reply({
                        content: btr.t('jointocreate.error.adminControls'),
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const customId = buttonInteraction.customId;

                if (customId.includes('jtc_config_name_')) {
                    await handleNameTemplateModal(buttonInteraction, triggerChannel, currentConfig, client, btr);
                } else if (customId.includes('jtc_config_limit_')) {
                    await handleUserLimitModal(buttonInteraction, triggerChannel, currentConfig, client, btr);
                } else if (customId.includes('jtc_config_bitrate_')) {
                    await handleBitrateModal(buttonInteraction, triggerChannel, currentConfig, client, btr);
                } else if (customId.includes('jtc_config_delete_')) {
                    await handleChannelDeletion(buttonInteraction, triggerChannel, currentConfig, client, btr);
                }
            } catch (error) {
                const userMessage = error instanceof TitanBotError
                    ? joinToCreateErrorText(error, btr) || btr.t('jointocreate.error.occurred')
                    : btr.t('jointocreate.error.processing');

                if (error instanceof TitanBotError) {
                    logger.debug(`Button interaction validation error: ${error.message}`, error.context || {});
                } else {
                    logger.error('Unexpected error in config button interaction:', error);
                }

                await buttonInteraction.reply({
                    content: `${userMessage}`,
                    flags: MessageFlags.Ephemeral
                }).catch(() => {});
            }
        });

        collector.on('end', () => {
            const disabledRow = new ActionRowBuilder().addComponents(
                nameButton.setDisabled(true),
                limitButton.setDisabled(true),
                bitrateButton.setDisabled(true),
                deleteButton.setDisabled(true)
            );

            message.edit({
                components: [disabledRow],
                embeds: [configEmbed.setFooter({ text: tr.t('jointocreate.panel.expired') })]
            }).catch(() => {});
        });

    } catch (error) {
        if (error instanceof TitanBotError) {
            throw error;
        }
        throw new TitanBotError(
            `Config failed: ${error.message}`,
            ErrorTypes.DATABASE,
            tr.t('jointocreate.error.loadFailed')
        );
    }
}

async function handleNameTemplateModal(interaction, triggerChannel, currentConfig, client, tr) {
    let modalSubmission = null;
    try {
        const TEMPLATE_OPTIONS = [
            { label: "{username}'s Room (Default)", value: "{username}'s Room" },
            { label: "{username}'s Channel",        value: "{username}'s Channel" },
            { label: "{username}'s Lounge",         value: "{username}'s Lounge" },
            { label: "{username}'s Space",          value: "{username}'s Space" },
            { label: "{displayName}'s Room",        value: "{displayName}'s Room" },
            { label: "{username}'s VC",             value: "{username}'s VC" },
            { label: "{username}'s Gaming Room", value: "{username}'s Gaming Room" },
            { label: "{username}'s Chat Room",   value: "{username}'s Chat Room" },
            { label: "{username}'s Private Room",   value: "{username}'s Private Room" },
        ];

        const currentTemplate = currentConfig.channelConfig?.nameTemplate
            || currentConfig.channelNameTemplate
            || "{username}'s Room";

        const templateSelect = new StringSelectMenuBuilder()
            .setCustomId('template')
            .setPlaceholder(tr.t('jointocreate.modal.pickTemplate'))
            .setOptions(
                TEMPLATE_OPTIONS.map(o => ({
                    label: o.label,
                    value: o.value,
                    default: o.value === currentTemplate,
                })),
            );

        const templateLabel = new LabelBuilder()
            .setLabel(tr.t('jointocreate.panel.nameTemplate'))
            .setStringSelectMenuComponent(templateSelect);

        const modal = new ModalBuilder()
            .setCustomId(`jtc_name_modal_${triggerChannel.id}`)
            .setTitle(tr.t('jointocreate.panel.nameTemplate'))
            .addLabelComponents(templateLabel);

        await interaction.showModal(modal);

        modalSubmission = await interaction.awaitModalSubmit({
            filter: (i) => i.customId === `jtc_name_modal_${triggerChannel.id}` && i.user.id === interaction.user.id,
            time: 60000
        });

        if (!hasAdminAccess(modalSubmission)) {
            await modalSubmission.reply({
                content: tr.t('jointocreate.error.adminSettings'),
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const [newTemplate] = modalSubmission.fields.getStringSelectValues('template');

        await updateChannelConfig(client, interaction.guild.id, triggerChannel.id, {
            nameTemplate: newTemplate
        });

        await logConfigurationChange(client, interaction.guild.id, interaction.user.id, 'Updated channel name template', {
            channelId: triggerChannel.id,
            newTemplate
        });

        await modalSubmission.reply({
            embeds: [successEmbed(tr.t('jointocreate.modal.updated'), tr.t('jointocreate.modal.templateChanged', { template: newTemplate }))],
            flags: MessageFlags.Ephemeral
        });

    } catch (error) {
        if (error.code === 'INTERACTION_COLLECTOR_ERROR') {
            return;
        }
        // The button interaction was already used for showModal(), so the caller
        // cannot reply to it; answer the modal submission instead.
        if (modalSubmission && !modalSubmission.replied && !modalSubmission.deferred) {
            if (!(error instanceof TitanBotError)) {
                logger.error('Unexpected error in Join to Create modal:', error);
            }
            await modalSubmission.reply({
                content: (error instanceof TitanBotError && joinToCreateErrorText(error, tr)) || tr.t('jointocreate.error.updateSettings'),
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return;
        }
        if (error instanceof TitanBotError) {
            throw error;
        }
        logger.error('Unexpected error in name template modal:', error);
        throw new TitanBotError(
            `Modal error: ${error.message}`,
            ErrorTypes.UNKNOWN,
            tr.t('jointocreate.error.updateTemplate')
        );
    }
}

async function handleUserLimitModal(interaction, triggerChannel, currentConfig, client, tr) {
    let modalSubmission = null;
    try {
        const currentLimit = currentConfig.channelConfig?.userLimit ?? currentConfig.userLimit ?? 0;

        const modal = new ModalBuilder()
            .setCustomId(`jtc_limit_modal_${triggerChannel.id}`)
            .setTitle(tr.t('jointocreate.panel.userLimit'))
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('user_limit')
                        .setLabel(tr.t('jointocreate.modal.limitLabel'))
                        .setPlaceholder(tr.t('jointocreate.modal.limitPlaceholder'))
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setMinLength(1)
                        .setMaxLength(2)
                        .setValue(currentLimit.toString())
                )
            );

        await interaction.showModal(modal);

        modalSubmission = await interaction.awaitModalSubmit({
            filter: (i) => i.customId === `jtc_limit_modal_${triggerChannel.id}` && i.user.id === interaction.user.id,
            time: 60000
        });

        if (!hasAdminAccess(modalSubmission)) {
            await modalSubmission.reply({
                content: tr.t('jointocreate.error.adminSettings'),
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const userInput = modalSubmission.fields.getTextInputValue('user_limit').trim();

        await updateChannelConfig(client, interaction.guild.id, triggerChannel.id, {
            userLimit: parseInt(userInput)
        });

        await logConfigurationChange(client, interaction.guild.id, interaction.user.id, 'Updated user limit', {
            channelId: triggerChannel.id,
            userLimit: parseInt(userInput)
        });

        await modalSubmission.reply({
            embeds: [successEmbed(tr.t('jointocreate.modal.updated'), tr.t('jointocreate.modal.limitChanged', { limit: limitText(tr, parseInt(userInput)) }))],
            flags: MessageFlags.Ephemeral
        });

    } catch (error) {
        if (error.code === 'INTERACTION_COLLECTOR_ERROR') {
            return;
        }
        // The button interaction was already used for showModal(), so the caller
        // cannot reply to it; answer the modal submission instead.
        if (modalSubmission && !modalSubmission.replied && !modalSubmission.deferred) {
            if (!(error instanceof TitanBotError)) {
                logger.error('Unexpected error in Join to Create modal:', error);
            }
            await modalSubmission.reply({
                content: (error instanceof TitanBotError && joinToCreateErrorText(error, tr)) || tr.t('jointocreate.error.updateSettings'),
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return;
        }
        if (error instanceof TitanBotError) {
            throw error;
        }
        logger.error('Unexpected error in user limit modal:', error);
        throw new TitanBotError(
            `Modal error: ${error.message}`,
            ErrorTypes.UNKNOWN,
            tr.t('jointocreate.error.updateLimit')
        );
    }
}

async function handleBitrateModal(interaction, triggerChannel, currentConfig, client, tr) {
    let modalSubmission = null;
    try {
        const currentBitrate = ((currentConfig.channelConfig.bitrate ?? currentConfig.bitrate ?? 64000) / 1000);

        const modal = new ModalBuilder()
            .setCustomId(`jtc_bitrate_modal_${triggerChannel.id}`)
            .setTitle(tr.t('jointocreate.panel.bitrate'))
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bitrate')
                        .setLabel(tr.t('jointocreate.modal.bitrateLabel'))
                        .setPlaceholder(tr.t('jointocreate.modal.bitratePlaceholder'))
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setMinLength(1)
                        .setMaxLength(3)
                        .setValue(currentBitrate.toString())
                )
            );

        await interaction.showModal(modal);

        modalSubmission = await interaction.awaitModalSubmit({
            filter: (i) => i.customId === `jtc_bitrate_modal_${triggerChannel.id}` && i.user.id === interaction.user.id,
            time: 60000
        });

        if (!hasAdminAccess(modalSubmission)) {
            await modalSubmission.reply({
                content: tr.t('jointocreate.error.adminSettings'),
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const userInput = modalSubmission.fields.getTextInputValue('bitrate').trim();

        await updateChannelConfig(client, interaction.guild.id, triggerChannel.id, {
            bitrate: parseInt(userInput) * 1000
        });

        await logConfigurationChange(client, interaction.guild.id, interaction.user.id, 'Updated bitrate', {
            channelId: triggerChannel.id,
            bitrate: parseInt(userInput)
        });

        await modalSubmission.reply({
            embeds: [successEmbed(tr.t('jointocreate.modal.updated'), tr.t('jointocreate.modal.bitrateChanged', { kbps: parseInt(userInput) }))],
            flags: MessageFlags.Ephemeral
        });

    } catch (error) {
        if (error.code === 'INTERACTION_COLLECTOR_ERROR') {
            return;
        }
        // The button interaction was already used for showModal(), so the caller
        // cannot reply to it; answer the modal submission instead.
        if (modalSubmission && !modalSubmission.replied && !modalSubmission.deferred) {
            if (!(error instanceof TitanBotError)) {
                logger.error('Unexpected error in Join to Create modal:', error);
            }
            await modalSubmission.reply({
                content: (error instanceof TitanBotError && joinToCreateErrorText(error, tr)) || tr.t('jointocreate.error.updateSettings'),
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return;
        }
        if (error instanceof TitanBotError) {
            throw error;
        }
        logger.error('Unexpected error in bitrate modal:', error);
        throw new TitanBotError(
            `Modal error: ${error.message}`,
            ErrorTypes.UNKNOWN,
            tr.t('jointocreate.error.updateBitrate')
        );
    }
}

async function handleChannelDeletion(interaction, triggerChannel, currentConfig, client, tr) {
    try {
        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`jtc_delete_confirm_${triggerChannel.id}`)
                .setLabel(tr.t('jointocreate.remove.yes'))
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`jtc_delete_cancel_${triggerChannel.id}`)
                .setLabel(tr.t('jointocreate.remove.cancel'))
                .setStyle(ButtonStyle.Secondary)
        );

        await InteractionHelper.safeReply(interaction, {
            embeds: [warningEmbed(tr.t('jointocreate.remove.confirmTitle'), tr.t('jointocreate.remove.confirmBody', { channel: triggerChannel.name }))],
            components: [confirmRow],
            flags: MessageFlags.Ephemeral
        });

        const message = await interaction.fetchReply();
        const deleteCollector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === interaction.user.id && 
                          (i.customId === `jtc_delete_confirm_${triggerChannel.id}` || 
                           i.customId === `jtc_delete_cancel_${triggerChannel.id}`),
            time: 600_000,
            max: 1
        });

        deleteCollector.on('collect', async (buttonInteraction) => {
            try {
                
                if (!hasAdminAccess(buttonInteraction)) {
                    await buttonInteraction.reply({
                        content: tr.t('jointocreate.error.adminRemove'),
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                if (buttonInteraction.customId === `jtc_delete_confirm_${triggerChannel.id}`) {
                    
                    await removeTriggerChannel(client, interaction.guild.id, triggerChannel.id);

                    await logConfigurationChange(client, interaction.guild.id, interaction.user.id, 'Removed Join to Create trigger', {
                        channelId: triggerChannel.id,
                        channelName: triggerChannel.name
                    });

                    try {
                        if (triggerChannel.members.size === 0) {
                            await triggerChannel.delete('Join to Create trigger removed by administrator');
                        }
                    } catch (deleteError) {
                        logger.warn(`Could not delete channel ${triggerChannel.id}: ${deleteError.message}`);
                        
                    }

                    await buttonInteraction.update({
                        embeds: [successEmbed(tr.t('jointocreate.remove.doneTitle'), tr.t('jointocreate.remove.doneBody', { channel: triggerChannel.name }))],
                        components: []
                    });

                } else {
                    await buttonInteraction.update({
                        embeds: [successEmbed(tr.t('jointocreate.remove.cancelledTitle'), tr.t('jointocreate.remove.cancelledBody'))],
                        components: []
                    });
                }
            } catch (collectError) {
                logger.error('Error handling delete confirmation:', collectError);
                await buttonInteraction.reply({
                    content: tr.t('jointocreate.error.processing'),
                    flags: MessageFlags.Ephemeral
                }).catch(() => {});
            }
        });

        deleteCollector.on('end', (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                message.edit({ components: [] }).catch(() => {});
            }
        });

    } catch (error) {
        if (error instanceof TitanBotError) {
            throw error;
        }
        logger.error('Unexpected error in handleChannelDeletion:', error);
        throw new TitanBotError(
            `Deletion error: ${error.message}`,
            ErrorTypes.UNKNOWN,
            tr.t('jointocreate.error.removeFailed')
        );
    }
}