import { updateApplicationSettings } from '../../../services/applicationSettingsService.js';
import { getColor, getDefaultApplicationQuestions, botConfig } from '../../../config/bot.js';
import {
    normalizeApplicationQuestions,
    applicationQuestionText,
    parseApplicationQuestionInput,
    formatApplicationQuestionForEditing,
    MAX_QUESTION_LENGTH,
} from '../../../utils/applicationQuestions.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
    LabelBuilder,
    CheckboxBuilder,
    TextDisplayBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { botText, textForInteraction } from '../../../utils/botText.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { safeDeferInteraction } from '../../../utils/interactionValidator.js';
import {
    getApplicationSettings,
    getApplicationRoles,
    saveApplicationRoles,
    getApplicationRoleSettings,
    saveApplicationRoleSettings,
    deleteApplicationRoleSettings,
    getApplications,
    deleteApplication,
} from '../../../utils/database.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { createApplicationRole, deleteApplicationRole, updateApplicationRole } from '../../../services/applicationRoleService.js';
import { setLogChannel, resolveApplicationLogChannel, resolveLogChannel } from '../../../services/loggingService.js';

async function buildDashboardEmbed(settings, roles, guild, client, tr = botText('en')) {
    const guildConfig = await getGuildConfig(client, guild.id);
    const applicationsChannel = resolveLogChannel(guildConfig, 'applications') || settings.logChannelId;
    const logChannel = applicationsChannel ? `<#${applicationsChannel}>` : tr.t('community.appDashboard.notSet');
    const managerRoleList =
        settings.managerRoles?.length > 0
            ? settings.managerRoles.map(id => `<@&${id}>`).join(',')
            : tr.t('community.appDashboard.noneConfigured');
    const roleList =
        roles.length > 0
            ? roles.map(r => `<@&${r.roleId}> · ${r.name}`).join('\n')
            : tr.t('community.appDashboard.noRoles');
    const questionCount = settings.questions?.length ?? 0;
    const firstText = applicationQuestionText(settings.questions?.[0]);
    const firstQ =
        firstText
            ? `\`${firstText.length > 55 ? firstText.substring(0, 55) + '…' : firstText}\``
            : tr.t('community.appDashboard.notSet');

    return new EmbedBuilder()
        .setTitle(tr.t('community.appDashboard.title'))
        .setDescription(tr.t('community.appDashboard.description', { server: guild.name }))
        .setColor(getColor('info'))
        .addFields(
            { name: tr.t('community.appDashboard.field.status'), value: settings.enabled ? tr.t('community.appDashboard.enabled') : tr.t('community.appDashboard.disabled'), inline: true },
            { name: tr.t('community.appDashboard.field.logChannel'), value: logChannel, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: tr.t('community.appDashboard.field.managerRoles'), value: managerRoleList, inline: false },
            { name: tr.t('community.appDashboard.field.questions'), value: tr.t('community.appDashboard.questionsValue', { count: questionCount, first: firstQ }), inline: false },
            { name: tr.t('community.appDashboard.field.roles'), value: roleList, inline: false },
            {
                name: tr.t('community.appDashboard.field.retention'),
                value: tr.t('community.appDashboard.retentionValue', { pending: settings.pendingApplicationRetentionDays ?? 30, reviewed: settings.reviewedApplicationRetentionDays ?? 14 }),
                inline: false,
            },
        )
        .setFooter({ text: tr.t('community.appDashboard.footer15') })
        .setTimestamp();
}

function buildSelectMenu(guildId, tr = botText('en')) {
    return new StringSelectMenuBuilder()
        .setCustomId(`app_cfg_${guildId}`)
        .setPlaceholder(tr.t('community.appDashboard.menu.placeholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.logChannel'))
                .setDescription(tr.t('community.appDashboard.menu.logChannelHelp'))
                .setValue('log_channel'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.managerRoles'))
                .setDescription(tr.t('community.appDashboard.menu.managerRolesHelp'))
                .setValue('manager_role'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.questions'))
                .setDescription(tr.t('community.appDashboard.menu.questionsHelp'))
                .setValue('questions'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.roleAdd'))
                .setDescription(tr.t('community.appDashboard.menu.roleAddHelp'))
                .setValue('role_add'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.roleRemove'))
                .setDescription(tr.t('community.appDashboard.menu.roleRemoveHelp'))
                .setValue('role_remove'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.retention'))
                .setDescription(tr.t('community.appDashboard.menu.retentionHelp'))
                .setValue('retention'),
        );
}

function buildButtonRow(settings, guildId, disabled = false, tr = botText('en')) {
    const systemOn = settings.enabled === true;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_cfg_toggle_${guildId}`)
            .setLabel(tr.t('community.appDashboard.toggleButton'))
            .setStyle(systemOn ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

async function refreshDashboard(rootInteraction, settings, roles, guildId, client, selectedRoleId = null) {
    // Role dashboards must re-render the role view: its collectors only listen for
    // app_cfg_<roleId>, so swapping in the global menu leaves dead components.
    const selectedRole = selectedRoleId ? roles.find(r => r.roleId === selectedRoleId) : null;
    if (selectedRole) {
        await showApplicationDashboard(rootInteraction, selectedRole, settings, roles, guildId, client, false).catch(() => {});
        return;
    }

    const tr = textForInteraction(rootInteraction);
    const selectMenu = buildSelectMenu(guildId, tr);
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [await buildDashboardEmbed(settings, roles, rootInteraction.guild, client, tr)],
        components: [
            buildButtonRow(settings, guildId, false, tr),
            new ActionRowBuilder().addComponents(selectMenu),
        ],
    }).catch(() => {});
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client, selectedAppName = null) {
        const tr = textForInteraction(interaction);
        try {
            const guildId = interaction.guild.id;

            await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });

            const [settings, roles] = await Promise.all([
                getApplicationSettings(client, guildId),
                getApplicationRoles(client, guildId),
            ]);

            const guildConfig = await getGuildConfig(client, guildId);
            const applicationsChannel = resolveLogChannel(guildConfig, 'applications') || settings.logChannelId;

            const isCompletelyUnconfigured = 
                !applicationsChannel && 
                !settings.enabled && 
                (settings.managerRoles?.length ?? 0) === 0 && 
                roles.length === 0;

            if (isCompletelyUnconfigured) {
                throw new TitanBotError(
                    'Applications system not set up',
                    ErrorTypes.CONFIGURATION,
                    tr.t('community.appDashboard.notSetUp'),
                );
            }

            if (roles.length === 0) {
                await showGlobalDashboard(interaction, settings, roles, guildId, client);
                return;
            }

            if (selectedAppName) {
                const selectedRole = roles.find(r => r.name.toLowerCase() === selectedAppName.toLowerCase());
                if (selectedRole) {
                    await showApplicationDashboard(interaction, selectedRole, settings, roles, guildId, client);
                    return;
                }
                
            }

            const defaultRole = roles[0];
            await showApplicationDashboard(interaction, defaultRole, settings, roles, guildId, client);

        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in app_dashboard:', error);
            throw new TitanBotError(
                `Applications dashboard failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                tr.t('community.appDashboard.openFailed'),
            );
        }
    },
};

async function showApplicationSelector(interaction, roles, settings, guildId, client) {
    const tr = textForInteraction(interaction);
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`app_select_${guildId}`)
        .setPlaceholder(tr.t('community.appDashboard.selector.placeholder'))
        .addOptions(
            roles.map(role =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(role.name)
                    .setDescription(tr.t('community.appDashboard.selector.option', { name: role.name }).slice(0, 100))
                    .setValue(role.roleId),
            ),
        );

    const embed = new EmbedBuilder()
        .setTitle(tr.t('community.appDashboard.selector.title'))
        .setDescription(tr.t('community.appDashboard.selector.description'))
        .setColor(getColor('info'));

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(selectMenu)],
    });

    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === interaction.user.id && i.customId === `app_select_${guildId}`,
        time: 600_000,
        max: 1,
    });

    collector.on('collect', async selectInteraction => {
        const deferred = await safeDeferInteraction(selectInteraction);
        if (!deferred) return;
        
        const selectedRoleId = selectInteraction.values[0];
        const selectedRole = roles.find(r => r.roleId === selectedRoleId);

        if (selectedRole) {
            await showApplicationDashboard(interaction, selectedRole, settings, roles, guildId, client);
        }
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(interaction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('community.appDashboard.selector.noSelection'),
            }).catch(() => {});
        }
    });
}

async function showGlobalDashboard(interaction, settings, roles, guildId, client, attachCollectors = true) {
    const tr = textForInteraction(interaction);
    const selectMenu = buildSelectMenu(guildId, tr);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [await buildDashboardEmbed(settings, roles, interaction.guild, client, tr)],
        components: [
            buildButtonRow(settings, guildId, false, tr),
            new ActionRowBuilder().addComponents(selectMenu),
        ],
    });

    if (attachCollectors) {
        setupCollectors(interaction, settings, roles, guildId, client, null);
    }
}

async function showApplicationDashboard(rootInteraction, selectedRole, settings, roles, guildId, client, attachCollectors = true) {
    const tr = textForInteraction(rootInteraction);
    const roleObj = rootInteraction.guild.roles.cache.get(selectedRole.roleId);

    const guildConfig = await getGuildConfig(client, guildId);
    const appSettings = await getApplicationRoleSettings(client, guildId, selectedRole.roleId);
    const questions = appSettings.questions || settings.questions || [];
    const appLogChannelId = resolveApplicationLogChannel(guildConfig, appSettings, settings);
    const isEnabled = selectedRole.enabled !== false; 

    const logChannelDisplay = appLogChannelId 
        ? `<#${appLogChannelId}>` 
        : tr.t('community.appDashboard.role.inheritsLog');
    
    const questionsDisplay = questions.length > 0
        ? normalizeApplicationQuestions(questions).map(({ question: q, minLength }, i) =>
            `${i + 1}. \`${q.length > 60 ? q.substring(0, 60) + '…' : q}\`${minLength > 1 ? tr.t('community.appDashboard.role.minChars', { min: minLength }) : ''}`).join('\n')
        : tr.t('community.appDashboard.role.inheritsQuestions');
    
    const managerRolesDisplay = settings.managerRoles && settings.managerRoles.length > 0
        ? settings.managerRoles.map(id => `<@&${id}>`).join(',')
        : tr.t('community.appDashboard.noneConfigured');

    const embed = new EmbedBuilder()
        .setTitle(tr.t('community.appDashboard.role.title'))
        .setDescription(tr.t('community.appDashboard.role.description', { name: selectedRole.name }))
        .setColor(isEnabled ? getColor('success') : getColor('error'))
        .addFields(
            { 
                name: tr.t('community.appDashboard.field.role'),
                value: roleObj ? roleObj.toString() : `<@&${selectedRole.roleId}>`, 
                inline: true 
            },
            { 
                name: tr.t('community.appDashboard.field.status'),
                value: isEnabled ? `**${tr.t('community.appDashboard.enabled')}**` : `**${tr.t('community.appDashboard.disabled')}**`, 
                inline: true 
            },
            { name: '\u200B', value: '\u200B', inline: true },
            { 
                name: tr.t('community.appDashboard.field.questions'),
                value: questionsDisplay,
                inline: false 
            },
            { 
                name: tr.t('community.appDashboard.field.logChannel'),
                value: logChannelDisplay,
                inline: true 
            },
            { 
                name: tr.t('community.appDashboard.field.managerRoles'),
                value: managerRolesDisplay,
                inline: true 
            },
            { 
                name: tr.t('community.appDashboard.menu.retention'),
                value: tr.t('community.appDashboard.retentionValue', { pending: settings.pendingApplicationRetentionDays ?? 30, reviewed: settings.reviewedApplicationRetentionDays ?? 14 }),
                inline: false 
            },
        )
        .setFooter({ text: tr.t('community.appDashboard.footer10') })
        .setTimestamp();

    const configMenu = buildApplicationSelectMenu(guildId, selectedRole.roleId, tr);

    const controlButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_toggle_${selectedRole.roleId}`)
            .setLabel(isEnabled ? tr.t('community.appDashboard.role.disableButton') : tr.t('community.appDashboard.role.enableButton'))
            .setStyle(isEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`app_delete_${selectedRole.roleId}`)
            .setLabel(tr.t('community.appDashboard.role.deleteButton'))
            .setStyle(ButtonStyle.Danger),
    );

    const menuRow = new ActionRowBuilder().addComponents(configMenu);

    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [embed],
        components: [menuRow, controlButtons],
    });

    if (attachCollectors) {
        setupCollectors(rootInteraction, settings, roles, guildId, client, selectedRole.roleId);
    }
}

function setupCollectors(interaction, settings, roles, guildId, client, selectedRoleId) {
    const tr = textForInteraction(interaction);
    const customIdPrefix = selectedRoleId ? `app_cfg_${selectedRoleId}` : `app_cfg_${guildId}`;
    
    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === interaction.user.id && 
            (selectedRoleId 
                ? i.customId === customIdPrefix
                : (i.customId === `app_cfg_${guildId}` || i.customId === `app_select_${guildId}`)),
        time: 600_000,
    });

    collector.on('collect', async selectInteraction => {
        const selectedOption = selectInteraction.values[0];
        try {
            
            if (!selectInteraction.isStringSelectMenu()) {
                return;
            }
            switch (selectedOption) {
                case 'log_channel':
                    await handleLogChannel(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
                case 'manager_role':
                    await handleManagerRole(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
                case 'questions':
                    await handleQuestions(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
                case 'role_add':
                    await handleRoleAdd(selectInteraction, interaction, settings, roles, guildId, client);
                    break;
                case 'role_remove':
                    await handleRoleRemove(selectInteraction, interaction, settings, roles, guildId, client);
                    break;
                case 'retention':
                    await handleRetention(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
            }
        } catch (error) {
            if (error instanceof TitanBotError) {
                logger.debug(`Applications config validation error: ${error.message}`);
            } else {
                logger.error('Unexpected applications dashboard error:', error);
            }

            const errorMessage =
                error instanceof TitanBotError
                    ? error.userMessage || tr.t('community.appDashboard.selectionFailed')
                    : tr.t('community.appDashboard.unexpected');

            if (!selectInteraction.replied && !selectInteraction.deferred) {
                await safeDeferInteraction(selectInteraction);
            }

            await replyUserError(selectInteraction, {
                type: ErrorTypes.CONFIGURATION,
                message: errorMessage,
            }).catch(() => {});
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            const timeoutEmbed = new EmbedBuilder()
                .setTitle(tr.t('community.appDashboard.timedOutTitle'))
                .setDescription(tr.t('community.appDashboard.timedOutBody'))
                .setColor(getColor('error'));
                
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [timeoutEmbed],
                components: [],
            }).catch(() => {});
        }
    });

    if (!selectedRoleId) {
        const globalToggleCollector = interaction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === interaction.user.id &&
                i.customId === `app_cfg_toggle_${guildId}`,
            time: 600_000,
        });

        globalToggleCollector.on('collect', async toggleInteraction => {
            const deferred = await safeDeferInteraction(toggleInteraction);
            if (!deferred) return;
            
            try {
                const wasEnabled = settings.enabled === true;
                settings.enabled = !wasEnabled;

                await updateApplicationSettings(interaction.client, guildId, { enabled: settings.enabled });

                const updatedSettings = await getApplicationSettings(interaction.client, guildId);
                const updatedRoles = await getApplicationRoles(interaction.client, guildId);
                await showGlobalDashboard(interaction, updatedSettings, updatedRoles, guildId, interaction.client, false);

                await toggleInteraction.followUp({
                    embeds: [wasEnabled
                        ? successEmbed(tr.t('community.appDashboard.system.offTitle'), tr.t('community.appDashboard.system.offBody'))
                        : successEmbed(tr.t('community.appDashboard.system.onTitle'), tr.t('community.appDashboard.system.onBody'))],
                    flags: MessageFlags.Ephemeral,
                });

            } catch (error) {
                logger.error('Error toggling global application status:', error);
                await replyUserError(toggleInteraction, {
                    type: ErrorTypes.UNKNOWN,
                    message: tr.t('community.appDashboard.toggleFailed'),
                });
            }
        });

        globalToggleCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle(tr.t('community.appDashboard.configTimeoutTitle'))
                    .setDescription(tr.t('community.appDashboard.configTimeoutBody'))
                    .setColor(getColor('warning'));
                    
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [timeoutEmbed],
                    components: [],
                }).catch(() => {});
            }
        });
    }

    if (selectedRoleId) {
        const btnCollector = interaction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === interaction.user.id &&
                i.customId === `app_delete_${selectedRoleId}`,
            time: 600_000,
        });

        btnCollector.on('collect', async btnInteraction => {
            
            const appRoleForDelete = roles.find(r => r.roleId === selectedRoleId);
            const appNameForDelete = appRoleForDelete?.name ?? tr.t('community.appDashboard.delete.thisApplication');

            const confirmModal = new ModalBuilder()
                .setCustomId('app_delete_confirm')
                .setTitle(tr.t('community.appDashboard.delete.modalTitle'));

            const deleteWarningText = new TextDisplayBuilder()
                .setContent(tr.t('community.appDashboard.delete.warning', { name: appNameForDelete }));

            const deleteCheckbox = new CheckboxBuilder()
                .setCustomId('confirm_delete')
                .setDefault(false);

            const deleteCheckboxLabel = new LabelBuilder()
                .setLabel(tr.t('community.appDashboard.delete.checkbox'))
                .setCheckboxComponent(deleteCheckbox);

            confirmModal
                .addTextDisplayComponents(deleteWarningText)
                .addLabelComponents(deleteCheckboxLabel);

            try {
                await btnInteraction.showModal(confirmModal);
            } catch (error) {
                logger.error('Error showing delete confirmation modal:', error);
                await replyUserError(btnInteraction, {
                    type: ErrorTypes.UNKNOWN,
                    message: tr.t('community.appDashboard.delete.modalFailed'),
                }).catch(() => {});
                return;
            }

            try {
                const confirmSubmit = await btnInteraction.awaitModalSubmit({
                    time: 60_000,
                    filter: i =>
                        i.customId === 'app_delete_confirm' && i.user.id === btnInteraction.user.id,
                }).catch(() => null);

                if (!confirmSubmit) {
                    await replyUserError(btnInteraction, {
                        type: ErrorTypes.VALIDATION,
                        message: tr.t('community.appDashboard.delete.cancelled'),
                    });
                    return;
                }

                const confirmed = confirmSubmit.fields.getCheckbox('confirm_delete');
                if (!confirmed) {
                    await replyUserError(confirmSubmit, { type: ErrorTypes.VALIDATION, message: tr.t('community.appDashboard.delete.mustTick') });
                    return;
                }

                await handleDeleteApplication(confirmSubmit, selectedRoleId, guildId, roles, client);
                collector.stop();
                btnCollector.stop();

            } catch (error) {
                logger.error('Error confirming application deletion:', error);
                await replyUserError(btnInteraction, {
                    type: ErrorTypes.UNKNOWN,
                    message: tr.t('community.appDashboard.delete.failed'),
                });
            }
        });

        btnCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle(tr.t('community.appDashboard.configTimeoutTitle'))
                    .setDescription(tr.t('community.appDashboard.configTimeoutBody'))
                    .setColor(getColor('warning'));
                    
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [timeoutEmbed],
                    components: [],
                }).catch(() => {});
            }
        });

        const toggleCollector = interaction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === interaction.user.id &&
                i.customId === `app_toggle_${selectedRoleId}`,
            time: 900_000,
        });

        toggleCollector.on('collect', async toggleInteraction => {
            const deferred = await safeDeferInteraction(toggleInteraction);
            if (!deferred) return;
            
            try {
                
                const roleIndex = roles.findIndex(r => r.roleId === selectedRoleId);
                if (roleIndex === -1) {
                    await replyUserError(toggleInteraction, {
                        type: ErrorTypes.USER_INPUT,
                        message: tr.t('community.appDashboard.roleNotFound'),
                    });
                    return;
                }

                const wasEnabled = roles[roleIndex].enabled !== false;
                roles[roleIndex].enabled = !wasEnabled;

                await updateApplicationRole(interaction.client, guildId, selectedRoleId, { enabled: !wasEnabled });

                const updatedRole = roles[roleIndex];
                const updatedSettings = await getApplicationSettings(interaction.client, guildId);
                await showApplicationDashboard(interaction, updatedRole, updatedSettings, roles, guildId, interaction.client, false);

                await toggleInteraction.followUp({
                    embeds: [wasEnabled
                        ? successEmbed(tr.t('community.appDashboard.roleToggle.offTitle'), tr.t('community.appDashboard.roleToggle.offBody', { name: updatedRole.name }))
                        : successEmbed(tr.t('community.appDashboard.roleToggle.onTitle'), tr.t('community.appDashboard.roleToggle.onBody', { name: updatedRole.name }))],
                    flags: MessageFlags.Ephemeral,
                });

            } catch (error) {
                logger.error('Error toggling application status:', error);
                await replyUserError(toggleInteraction, {
                    type: ErrorTypes.UNKNOWN,
                    message: tr.t('community.appDashboard.toggleFailed'),
                });
            }
        });

        toggleCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle(tr.t('community.appDashboard.configTimeoutTitle'))
                    .setDescription(tr.t('community.appDashboard.configTimeoutBody'))
                    .setColor(getColor('warning'));
                    
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [timeoutEmbed],
                    components: [],
                }).catch(() => {});
            }
        });
    }
}

function buildApplicationSelectMenu(guildId, roleId, tr = botText('en')) {
    return new StringSelectMenuBuilder()
        .setCustomId(`app_cfg_${roleId}`)
        .setPlaceholder(tr.t('community.appDashboard.menu.placeholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.logChannel'))
                .setDescription(tr.t('community.appDashboard.menu.roleLogChannelHelp'))
                .setValue('log_channel'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.managerRoles'))
                .setDescription(tr.t('community.appDashboard.menu.managerRolesHelp'))
                .setValue('manager_role'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.questions'))
                .setDescription(tr.t('community.appDashboard.menu.questionsHelp'))
                .setValue('questions'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('community.appDashboard.menu.retention'))
                .setDescription(tr.t('community.appDashboard.menu.retentionHelp'))
                .setValue('retention'),
        );
}

async function handleLogChannel(selectInteraction, rootInteraction, settings, roles, guildId, client, selectedRoleId) {
    const tr = textForInteraction(selectInteraction);
    let currentChannel = settings.logChannelId;
    if (selectedRoleId) {
        const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
        currentChannel = roleSettings.logChannelId || settings.logChannelId;
    }

    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_log_channel_modal_${guildId}_${selectedRoleId || 'global'}`)
        .setTitle(tr.t('community.appDashboard.logChannel.modalTitle'));

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('log_channel')
        .setPlaceholder(tr.t('community.appDashboard.logChannel.placeholder'))
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true);

    const channelLabel = new LabelBuilder()
        .setLabel(tr.t('community.appDashboard.field.logChannel'))
        .setDescription(tr.t('community.appDashboard.logChannel.labelHelp'))
        .setChannelSelectMenuComponent(channelSelect);

    modal.addLabelComponents(channelLabel);

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_log_channel_modal_${guildId}_${selectedRoleId || 'global'}`,
        });

        const channelId = modalSubmission.fields.getField('log_channel').values[0];
        const channel = selectInteraction.guild.channels.cache.get(channelId);

        if (selectedRoleId) {
            const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
            roleSettings.logChannelId = channelId;
            await saveApplicationRoleSettings(client, guildId, selectedRoleId, roleSettings);
        } else {
            if (!(await setLogChannel(client, guildId, 'applications', channelId))) {
                throw new Error('Could not save the application log channel. Nothing was changed for logging.');
            }
            settings.logChannelId = channelId;
            await updateApplicationSettings(client, guildId, { logChannelId: channelId });
        }

        await modalSubmission.reply({
            embeds: [successEmbed(tr.t('community.appDashboard.logChannel.updatedTitle'), tr.t('community.appDashboard.logChannel.updatedBody', { channel: String(channel ?? `<#${channelId}>`) }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId, client, selectedRoleId);
    } catch (error) {
        if (error.code === 'InteractionCollectorError' || error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in log channel modal:', error);
        await replyUserError(selectInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: tr.t('community.appDashboard.logChannel.failed'),
        });
    }
}

async function handleManagerRole(selectInteraction, rootInteraction, settings, roles, guildId, client, selectedRoleId = null) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_manager_role_modal_${guildId}`)
        .setTitle(tr.t('community.appDashboard.managers.modalTitle'));

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('manager_roles')
        .setPlaceholder(tr.t('community.appDashboard.managers.placeholder'))
        .setMinValues(1)
        .setMaxValues(5)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel(tr.t('community.appDashboard.field.managerRoles'))
        .setDescription(tr.t('community.appDashboard.managers.labelHelp'))
        .setRoleSelectMenuComponent(roleSelect);

    modal.addLabelComponents(roleLabel);

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_manager_role_modal_${guildId}`,
        });

        const selectedRoleIds = modalSubmission.fields.getField('manager_roles').values;
        const roleSet = new Set(settings.managerRoles ?? []);

        for (const roleId of selectedRoleIds) {
            if (roleSet.has(roleId)) {
                roleSet.delete(roleId);
            } else {
                roleSet.add(roleId);
            }
        }

        settings.managerRoles = Array.from(roleSet);
        await updateApplicationSettings(client, guildId, { managerRoles: settings.managerRoles });

        const finalList = settings.managerRoles.length > 0
            ? settings.managerRoles.map(id => `<@&${id}>`).join(',')
            : tr.t('community.appDashboard.managers.none');

        await modalSubmission.reply({
            embeds: [successEmbed(tr.t('community.appDashboard.managers.updatedTitle'), tr.t('community.appDashboard.managers.updatedBody', { roles: finalList }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId, client, selectedRoleId);
    } catch (error) {
        if (error.code === 'InteractionCollectorError' || error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in manager role modal:', error);
        await replyUserError(selectInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: tr.t('community.appDashboard.managers.failed'),
        });
    }
}

// Questions are up to 100 characters; the extra room is for an optional " [min:N]" tag.
const QUESTION_INPUT_MAX = MAX_QUESTION_LENGTH + 12;

async function handleQuestions(selectInteraction, rootInteraction, settings, roles, guildId, client, selectedRoleId) {
    const tr = textForInteraction(selectInteraction);
    const MIN_TAG_HINT = tr.t('community.appDashboard.questions.minTagHint');
    let currentQuestions = settings.questions ?? [];
    
    if (selectedRoleId) {
        const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
        currentQuestions = roleSettings.questions ?? currentQuestions;
    }

    const modal = new ModalBuilder()
        .setCustomId('app_cfg_questions')
        .setTitle(tr.t('community.appDashboard.questions.modalTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q1')
                    .setLabel(tr.t('community.appAdmin.questionRequired', { number: 1 }))
                    .setStyle(TextInputStyle.Short)
                    .setValue(formatApplicationQuestionForEditing(currentQuestions[0]))
                    .setPlaceholder(MIN_TAG_HINT)
                    .setMaxLength(QUESTION_INPUT_MAX)
                    .setMinLength(1)
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q2')
                    .setLabel(tr.t('community.appAdmin.questionOptional', { number: 2 }))
                    .setStyle(TextInputStyle.Short)
                    .setValue(formatApplicationQuestionForEditing(currentQuestions[1]))
                    .setPlaceholder(MIN_TAG_HINT)
                    .setMaxLength(QUESTION_INPUT_MAX)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q3')
                    .setLabel(tr.t('community.appAdmin.questionOptional', { number: 3 }))
                    .setStyle(TextInputStyle.Short)
                    .setValue(formatApplicationQuestionForEditing(currentQuestions[2]))
                    .setPlaceholder(MIN_TAG_HINT)
                    .setMaxLength(QUESTION_INPUT_MAX)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q4')
                    .setLabel(tr.t('community.appAdmin.questionOptional', { number: 4 }))
                    .setStyle(TextInputStyle.Short)
                    .setValue(formatApplicationQuestionForEditing(currentQuestions[3]))
                    .setPlaceholder(MIN_TAG_HINT)
                    .setMaxLength(QUESTION_INPUT_MAX)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q5')
                    .setLabel(tr.t('community.appAdmin.questionOptional', { number: 5 }))
                    .setStyle(TextInputStyle.Short)
                    .setValue(formatApplicationQuestionForEditing(currentQuestions[4]))
                    .setPlaceholder(MIN_TAG_HINT)
                    .setMaxLength(QUESTION_INPUT_MAX)
                    .setRequired(false),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'app_cfg_questions' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newQuestions = ['q1', 'q2', 'q3', 'q4', 'q5']
        .map(key => parseApplicationQuestionInput(submitted.fields.getTextInputValue(key)))
        .filter(Boolean);

    if (newQuestions.length === 0) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: tr.t('community.appDashboard.questions.needOne') });
        return;
    }

    if (selectedRoleId) {
        
        await updateApplicationRole(client, guildId, selectedRoleId, { questions: newQuestions });
    } else {
        
        settings.questions = newQuestions;
        await updateApplicationSettings(client, guildId, { questions: newQuestions });
    }

    await submitted.reply({
        embeds: [
            successEmbed(
                tr.t('community.appDashboard.questions.updatedTitle'),
                tr.tp('community.appDashboard.questions.saved', newQuestions.length),
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, settings, roles, guildId, client, selectedRoleId);
}

async function handleRoleAdd(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_role_add_modal_${guildId}`)
        .setTitle(tr.t('community.appDashboard.menu.roleAdd'));

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('application_role')
        .setPlaceholder(tr.t('community.appDashboard.roleAdd.placeholder'))
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel(tr.t('community.appAdmin.setup.roleLabel'))
        .setDescription(tr.t('community.appDashboard.roleAdd.labelHelp'))
        .setRoleSelectMenuComponent(roleSelect);

    const nameInput = new TextInputBuilder()
        .setCustomId('role_name')
        .setLabel(tr.t('community.appDashboard.roleAdd.nameLabel'))
        .setStyle(TextInputStyle.Short)
        .setMaxLength(50)
        .setRequired(false);

    modal.addLabelComponents(roleLabel);
    modal.addComponents(new ActionRowBuilder().addComponents(nameInput));

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_role_add_modal_${guildId}`,
        });

        const roleId = modalSubmission.fields.getField('application_role').values[0];
        const role = selectInteraction.guild.roles.cache.get(roleId);
        const customName = modalSubmission.fields.getTextInputValue('role_name').trim() || role?.name || roleId;

        if (roles.some(r => r.roleId === roleId)) {
            await replyUserError(modalSubmission, { type: ErrorTypes.UNKNOWN, message: tr.t('community.appDashboard.roleAdd.exists', { role: String(role ?? roleId) }) });
            return;
        }

        const { role: added } = await createApplicationRole(client, guildId, { roleId, name: customName.slice(0, 50) });
        roles.push(added);

        await modalSubmission.reply({
            embeds: [successEmbed(tr.t('community.appDashboard.roleAdd.addedTitle'), tr.t('community.appDashboard.roleAdd.addedBody', { role: String(role ?? roleId), name: customName }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId, client);
    } catch (error) {
        if (error.code === 'InteractionCollectorError' || error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in role add modal:', error);
        await replyUserError(selectInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: tr.t('community.appDashboard.roleAdd.failed'),
        });
    }
}

async function handleRoleRemove(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    if (roles.length === 0) {
        await replyUserError(selectInteraction, {
            type: ErrorTypes.USER_INPUT,
            message: tr.t('community.appDashboard.roleRemove.none'),
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_role_remove_modal_${guildId}`)
        .setTitle(tr.t('community.appDashboard.menu.roleRemove'));

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('remove_role')
        .setPlaceholder(tr.t('community.appDashboard.roleRemove.placeholder'))
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel(tr.t('community.appDashboard.menu.roleRemove'))
        .setDescription(tr.t('community.appDashboard.roleRemove.labelHelp'))
        .setRoleSelectMenuComponent(roleSelect);

    modal.addLabelComponents(roleLabel);

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_role_remove_modal_${guildId}`,
        });

        const roleId = modalSubmission.fields.getField('remove_role').values[0];
        const index = roles.findIndex(r => r.roleId === roleId);

        if (index === -1) {
            await replyUserError(modalSubmission, { type: ErrorTypes.USER_INPUT, message: tr.t('community.appDashboard.roleRemove.notInList', { roleId }) });
            return;
        }

        roles.splice(index, 1);
        // Removes the role from the list (its submitted applications are kept).
        await deleteApplicationRole(client, guildId, roleId, { deleteApplications: false });

        await modalSubmission.reply({
            embeds: [successEmbed(tr.t('community.appDashboard.roleRemove.removedTitle'), tr.t('community.appDashboard.roleRemove.removedBody', { roleId }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId, client);
    } catch (error) {
        if (error.code === 'InteractionCollectorError' || error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in role remove modal:', error);
        await replyUserError(selectInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: tr.t('community.appDashboard.roleRemove.failed'),
        });
    }
}

async function handleRetention(selectInteraction, rootInteraction, settings, roles, guildId, client, selectedRoleId = null) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('app_cfg_retention')
        .setTitle(tr.t('community.appDashboard.retention.modalTitle'));

    const retentionInfo = new TextDisplayBuilder()
        .setContent(tr.t('community.appDashboard.retention.info'));

    const pendingLabel = new LabelBuilder()
        .setLabel(tr.t('community.appDashboard.retention.pendingLabel'))
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('pending_days')
                .setStyle(TextInputStyle.Short)
                .setValue(String(settings.pendingApplicationRetentionDays ?? 30))
                .setMaxLength(4)
                .setMinLength(1)
                .setRequired(true),
        );

    const reviewedLabel = new LabelBuilder()
        .setLabel(tr.t('community.appDashboard.retention.reviewedLabel'))
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('reviewed_days')
                .setStyle(TextInputStyle.Short)
                .setValue(String(settings.reviewedApplicationRetentionDays ?? 14))
                .setMaxLength(4)
                .setMinLength(1)
                .setRequired(true),
        );

    modal
        .addTextDisplayComponents(retentionInfo)
        .addLabelComponents(pendingLabel, reviewedLabel);

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'app_cfg_retention' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const pendingDays = parseInt(submitted.fields.getTextInputValue('pending_days').trim(), 10);
    const reviewedDays = parseInt(submitted.fields.getTextInputValue('reviewed_days').trim(), 10);

    if (isNaN(pendingDays) || pendingDays < 1 || pendingDays > 3650) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('community.appDashboard.retention.pendingInvalid') });
        return;
    }

    if (isNaN(reviewedDays) || reviewedDays < 1 || reviewedDays > 3650) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('community.appDashboard.retention.reviewedInvalid') });
        return;
    }

    settings.pendingApplicationRetentionDays = pendingDays;
    settings.reviewedApplicationRetentionDays = reviewedDays;
    await updateApplicationSettings(client, guildId, {
        pendingApplicationRetentionDays: pendingDays,
        reviewedApplicationRetentionDays: reviewedDays,
    });

    await submitted.reply({
        embeds: [
            successEmbed(
                tr.t('community.appDashboard.retention.updatedTitle'),
                `${tr.tp('community.appDashboard.retention.pendingKept', pendingDays)}\n${tr.tp('community.appDashboard.retention.reviewedKept', reviewedDays)}`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, settings, roles, guildId, client, selectedRoleId);
}

async function handleDeleteApplication(confirmSubmit, selectedRoleId, guildId, roles, client) {
    const tr = textForInteraction(confirmSubmit);
    try {
        
        const roleIndex = roles.findIndex(r => r.roleId === selectedRoleId);
        if (roleIndex === -1) {
            await replyUserError(confirmSubmit, { type: ErrorTypes.USER_INPUT, message: tr.t('community.appDashboard.roleNotFound') });
            return;
        }

        const deletedRole = roles[roleIndex];

        roles.splice(roleIndex, 1);

        // Role, its settings and every application for it (shared with the web dashboard).
        const { deletedApplications } = await deleteApplicationRole(client, guildId, selectedRoleId);

        await confirmSubmit.reply({
            embeds: [
                successEmbed(
                    tr.t('community.appDashboard.delete.doneTitle'),
                    tr.t('community.appDashboard.delete.doneBody', { roleId: selectedRoleId, name: deletedRole.name }) + '\n\n' +
                    tr.tp('community.appDashboard.delete.doneCount', deletedApplications),
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

    } catch (error) {
        logger.error('Error in handleDeleteApplication:', error);
        await replyUserError(confirmSubmit, { type: ErrorTypes.UNKNOWN, message: tr.t('community.appDashboard.delete.failedRetry') });
    }
}