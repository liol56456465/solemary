import { botConfig, getColor } from '../../../config/bot.js';
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
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { updateVerificationSettings } from '../../../services/verificationSettingsService.js';
import { getWelcomeConfig } from '../../../utils/database.js';
import { botHasPermission } from '../../../utils/permissionGuard.js';
import { getRoleAssignmentProblem } from '../../../utils/roleSafety.js';
import {
    getVerificationPanelStatus,
} from '../../../utils/panelStatus.js';
import { startDashboardSession } from '../../../utils/dashboardSession.js';
import { buildVerificationPanelPayload, panelLanguage, refreshVerificationPanel } from '../../../services/verificationPanelService.js';
import { botText, textForInteraction } from '../../../utils/botText.js';

// Everything in this dashboard is ephemeral (the admin's Discord language); the panel it posts is
// the server's (panelLanguage).

/** utils/panelStatus.js formatPanelStatusField, in `tr`'s language (English is identical). */
function panelStatusText(tr, panelStatus, repostHint) {
    if (!panelStatus) return tr.t('verification.dash.panelStatus.unknown');
    if (panelStatus.exists) {
        return panelStatus.message?.url
            ? tr.t('verification.dash.panelStatus.activeLink', { url: panelStatus.message.url })
            : tr.t('verification.dash.panelStatus.active');
    }
    if (panelStatus.reason === 'channel_missing') return tr.t('verification.dash.panelStatus.channelMissing');
    if (panelStatus.reason === 'panel_deleted') return tr.t('verification.dash.panelStatus.panelDeleted', { hint: repostHint });
    if (panelStatus.reason === 'no_channel') return tr.t('verification.dash.panelStatus.noChannel');
    return tr.t('verification.dash.panelStatus.unknown');
}

function conflictLines(tr, { autoVerifyEnabled, autoRoleConfigured }) {
    return [
        autoVerifyEnabled ? tr.t('verification.vdash.autoVerifyOn') : null,
        autoRoleConfigured ? tr.t('verification.dash.autoRoleConfigured') : null,
    ].filter(Boolean);
}

// The panel message is built in services/verificationPanelService.js (shared with
// /verification setup and the web dashboard).
async function updateLivePanel(guild, cfg) {
    await refreshVerificationPanel(guild, cfg);
}

function buildDashboardEmbed(cfg, guild, verifiedUserCount = 0, conflictSummary = '', panelStatus = null, tr = botText()) {
    const channel = cfg.channelId ? `<#${cfg.channelId}>` : tr.t('verification.dash.notSet');
    const role = cfg.roleId ? `<@&${cfg.roleId}>` : tr.t('verification.dash.notSet');
    const rawMsg = cfg.message || botConfig.verification.defaultMessage;
    const msgPreview = `\`${rawMsg.length > 60 ? rawMsg.substring(0, 60) + '…' : rawMsg}\``;
    const buttonText = cfg.buttonText || botConfig.verification.defaultButtonText;
    const panelStatusValue = cfg.channelId ? panelStatusText(tr, panelStatus, tr.t('verification.vdash.repostButton')) : tr.t('verification.dash.notConfigured');

    const embed = new EmbedBuilder()
        .setTitle(tr.t('verification.vdash.title'))
        .setDescription(tr.t('verification.vdash.intro', { server: guild.name }))
        .setColor(getColor('info'))
        .addFields(
            { name: tr.t('verification.vdash.fieldPanel'), value: panelStatusValue, inline: false },
            { name: tr.t('verification.vdash.fieldChannel'), value: channel, inline: true },
            { name: tr.t('verification.vdash.fieldRole'), value: role, inline: true },
            { name: tr.t('verification.dash.systemStatus'), value: cfg.enabled !== false ? tr.t('verification.dash.enabled') : tr.t('verification.dash.disabled'), inline: true },
            { name: tr.t('verification.vdash.fieldButton'), value: `\`${buttonText}\``, inline: true },
            { name: tr.t('verification.vdash.fieldUsers'), value: tr.tp('verification.vdash.users', verifiedUserCount), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: tr.t('verification.vdash.fieldMessage'), value: msgPreview, inline: false },
        );

    if (conflictSummary) {
        embed.addFields({ name: tr.t('verification.dash.conflicts'), value: conflictSummary, inline: false });
    }

    return embed
        .setFooter({ text: tr.t('verification.dash.footer') })
        .setTimestamp();
}

function buildSelectMenu(guildId, tr = botText()) {
    return new StringSelectMenuBuilder()
        .setCustomId(`verif_cfg_${guildId}`)
        .setPlaceholder(tr.t('verification.dash.selectPlaceholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('verification.vdash.optChannel'))
                .setDescription(tr.t('verification.vdash.optChannelDesc'))
                .setValue('channel'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('verification.vdash.optRole'))
                .setDescription(tr.t('verification.vdash.optRoleDesc'))
                .setValue('role'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('verification.vdash.optMessage'))
                .setDescription(tr.t('verification.vdash.optMessageDesc'))
                .setValue('message'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('verification.vdash.optButton'))
                .setDescription(tr.t('verification.vdash.optButtonDesc'))
                .setValue('button_text'),
        );
}

function buildButtonRow(cfg, guildId, disabled = false, panelStatus = null, tr = botText()) {
    const systemOn = cfg.enabled !== false;
    const showRepost =
        systemOn && panelStatus?.exists === false && panelStatus?.reason === 'panel_deleted';

    const buttons = [];

    if (showRepost) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`verif_cfg_repost_${guildId}`)
                .setLabel(tr.t('verification.vdash.repostButton'))
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled),
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId(`verif_cfg_toggle_${guildId}`)
            .setLabel(tr.t('verification.vdash.toggleButton'))
            .setStyle(systemOn ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(disabled),
    );

    return new ActionRowBuilder().addComponents(buttons);
}

async function repostVerificationPanel(guild, cfg, tr = botText()) {
    const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
    if (!channel) {
        throw new TitanBotError(
            'Panel channel missing',
            ErrorTypes.CONFIGURATION,
            tr.t('verification.vdash.channelGone'),
        );
    }
    return channel.send(buildVerificationPanelPayload(cfg, { lang: panelLanguage(guild) }));
}

async function refreshDashboard(rootInteraction, cfg, guildId, client) {
    try {
        const tr = textForInteraction(rootInteraction);
        const selectMenu = buildSelectMenu(guildId, tr);

        let verifiedUserCount = 0;
        let conflictSummary = '';
        let panelStatus = null;

        if (cfg.channelId && cfg.enabled !== false) {
            panelStatus = await getVerificationPanelStatus(client, rootInteraction.guild, cfg);
            if (panelStatus.recoveredId) {
                cfg.messageId = panelStatus.recoveredId;
                await updateVerificationSettings(client, guildId, { messageId: cfg.messageId });
            }
        }
        
        try {
            const verifiedRole = rootInteraction.guild.roles.cache.get(cfg.roleId);
            if (verifiedRole) {
                verifiedUserCount = verifiedRole.members.size;
            }
            
            const guildConfig = await getGuildConfig(client, guildId);
            const welcomeConfig = await getWelcomeConfig(client, guildId);
            const autoVerifyEnabled = Boolean(guildConfig.verification?.autoVerify?.enabled);
            const autoRoleConfigured = Boolean(guildConfig.autoRole) || (Array.isArray(welcomeConfig.roleIds) && welcomeConfig.roleIds.length > 0);
            
            const conflicts = conflictLines(tr, { autoVerifyEnabled, autoRoleConfigured });
            
            if (conflicts.length > 0) {
                conflictSummary = conflicts.join('\n');
            }
        } catch (error) {
            logger.warn('Could not fetch verification dashboard details:', error.message);
        }
        
        await InteractionHelper.safeEditReply(rootInteraction, {
            embeds: [buildDashboardEmbed(cfg, rootInteraction.guild, verifiedUserCount, conflictSummary, panelStatus, tr)],
            components: [
                buildButtonRow(cfg, guildId, false, panelStatus, tr),
                new ActionRowBuilder().addComponents(selectMenu),
            ],
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        logger.debug('Could not refresh verification dashboard (interaction may have expired):', error.message);
    }
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        try {
            const guildId = interaction.guild.id;
            const guildConfig = await getGuildConfig(client, guildId);
            const cfg = guildConfig.verification;

            if (!cfg?.channelId) {
                throw new TitanBotError(
                    'Verification not configured',
                    ErrorTypes.CONFIGURATION,
                    tr.t('verification.vdash.notConfigured'),
                );
            }

            await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

            let verifiedUserCount = 0;
            let conflictSummary = '';
            let panelStatus = null;

            if (cfg.channelId && cfg.enabled !== false) {
                panelStatus = await getVerificationPanelStatus(client, interaction.guild, cfg);
                if (panelStatus.recoveredId) {
                    cfg.messageId = panelStatus.recoveredId;
                    await updateVerificationSettings(client, guildId, { messageId: cfg.messageId });
                }
            }
            
            try {
                const verifiedRole = interaction.guild.roles.cache.get(cfg.roleId);
                if (verifiedRole) {
                    verifiedUserCount = verifiedRole.members.size;
                }
                
                const welcomeConfig = await getWelcomeConfig(client, guildId);
                const autoVerifyEnabled = Boolean(guildConfig.verification?.autoVerify?.enabled);
                const autoRoleConfigured = Boolean(guildConfig.autoRole) || (Array.isArray(welcomeConfig.roleIds) && welcomeConfig.roleIds.length > 0);
                
                const conflicts = conflictLines(tr, { autoVerifyEnabled, autoRoleConfigured });
                
                if (conflicts.length > 0) {
                    conflictSummary = conflicts.join('\n');
                }
            } catch (error) {
                logger.warn('Could not fetch verification dashboard details:', error.message);
            }

            await startDashboardSession({
                interaction,
                embeds: [buildDashboardEmbed(cfg, interaction.guild, verifiedUserCount, conflictSummary, panelStatus, tr)],
                components: [
                    buildButtonRow(cfg, guildId, false, panelStatus, tr),
                    new ActionRowBuilder().addComponents(buildSelectMenu(guildId, tr)),
                ],
                flags: MessageFlags.Ephemeral,
                selectMenuId: `verif_cfg_${guildId}`,
                buttonMatcher: (customId) =>
                    customId === `verif_cfg_toggle_${guildId}` || customId === `verif_cfg_repost_${guildId}`,
                onSelect: async (selectInteraction) => {
                    const selectedOption = selectInteraction.values[0];
                    switch (selectedOption) {
                        case 'channel':
                            await handleChannel(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'role':
                            await handleRole(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'message':
                            await handleMessage(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'button_text':
                            await handleButtonText(selectInteraction, interaction, cfg, guildId, client);
                            break;
                    }
                },
                onButton: async (btnInteraction) => {
                    if (btnInteraction.customId === `verif_cfg_repost_${guildId}`) {
                        await btnInteraction.deferUpdate();
                        const newMsg = await repostVerificationPanel(interaction.guild, cfg, tr);
                        cfg.messageId = newMsg.id;
                        await updateVerificationSettings(client, guildId, { messageId: cfg.messageId });
                        await btnInteraction.followUp({
                            embeds: [successEmbed(tr.t('verification.vdash.repostedTitle'), tr.t('verification.vdash.repostedText', { channel: String(newMsg.channel) }))],
                            flags: MessageFlags.Ephemeral,
                        });
                        await refreshDashboard(interaction, cfg, guildId, client);
                        return;
                    }

                    await btnInteraction.deferUpdate().catch(() => null);

                    const wasEnabled = cfg.enabled !== false;
                    const autoVerifyEnabled = Boolean(guildConfig.verification?.autoVerify?.enabled);

                    if (!wasEnabled && autoVerifyEnabled) {
                        await replyUserError(btnInteraction, {
                            type: ErrorTypes.CONFIGURATION,
                            message: tr.t('verification.vdash.autoVerifyBlocks'),
                        });
                        return;
                    }

                    cfg.enabled = !wasEnabled;

                    if (!cfg.enabled && cfg.channelId && cfg.messageId) {
                        const channel = interaction.guild.channels.cache.get(cfg.channelId);
                        if (channel) {
                            const msg = await channel.messages.fetch(cfg.messageId).catch(() => null);
                            if (msg) await msg.delete().catch(() => {});
                        }
                    }

                    if (cfg.enabled && cfg.channelId) {
                        try {
                            const newMsg = await repostVerificationPanel(interaction.guild, cfg, tr);
                            cfg.messageId = newMsg.id;
                        } catch (error) {
                            logger.warn('Could not re-post verification panel on re-enable:', error.message);
                        }
                    }

                    await updateVerificationSettings(client, guildId, { enabled: cfg.enabled, messageId: cfg.messageId });

                    await btnInteraction.followUp({
                        embeds: [
                            successEmbed(
                                tr.t('verification.vdash.systemUpdatedTitle'),
                                cfg.enabled ? tr.t('verification.vdash.systemOn') : tr.t('verification.vdash.systemOff'),
                            ),
                        ],
                        flags: MessageFlags.Ephemeral,
                    });

                    await refreshDashboard(interaction, cfg, guildId, client);
                },
                onTimeout: async (rootInteraction) => {
                    await InteractionHelper.safeEditReply(rootInteraction, {
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(tr.t('verification.dash.timedOutTitle'))
                                .setDescription(tr.t('verification.dash.timedOutText'))
                                .setColor(getColor('error')),
                        ],
                        components: [],
                        flags: MessageFlags.Ephemeral,
                    });
                },
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in verification_dashboard:', error);
            throw new TitanBotError(
                `Verification dashboard failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                tr.t('verification.vdash.openFailed'),
            );
        }
    },
};

async function handleChannel(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('verif_cfg_channel')
        .setPlaceholder(tr.t('verification.vdash.channelPlaceholder'))
        .addChannelTypes(ChannelType.GuildText)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('verification.vdash.channelTitle'))
                .setDescription(
                    tr.t('verification.vdash.channelText', { current: cfg.channelId ? `<#${cfg.channelId}>` : tr.t('verification.dash.notSet') }),
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const chanCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'verif_cfg_channel',
        time: 60_000,
        max: 1,
    });

    chanCollector.on('collect', async chanInteraction => {
        await chanInteraction.deferUpdate();
        const newChannel = chanInteraction.channels.first();

        if (!botHasPermission(newChannel, ['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
            await replyUserError(chanInteraction, {
                type: ErrorTypes.PERMISSION,
                message: tr.t('verification.vdash.channelPerms', { channel: String(newChannel) }),
            });
            return;
        }

        if (cfg.channelId && cfg.messageId) {
            const oldChannel = rootInteraction.guild.channels.cache.get(cfg.channelId);
            if (oldChannel) {
                try {
                    const oldMsg = await oldChannel.messages.fetch(cfg.messageId).catch(() => null);
                    if (oldMsg) await oldMsg.delete();
                } catch {
                    
                }
            }
        }

        if (cfg.enabled !== false) {
            try {
                const newMsg = await newChannel.send(buildVerificationPanelPayload(cfg, { lang: panelLanguage(rootInteraction.guild) }));
                cfg.messageId = newMsg.id;
            } catch (error) {
                logger.warn('Could not post verification panel in new channel:', error.message);
            }
        }

        cfg.channelId = newChannel.id;
        await updateVerificationSettings(client, guildId, { channelId: cfg.channelId, messageId: cfg.messageId });

        await chanInteraction.followUp({
            embeds: [successEmbed(tr.t('verification.vdash.channelUpdatedTitle'), tr.t('verification.vdash.channelUpdatedText', { channel: String(newChannel) }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, cfg, guildId, client);
    });

    chanCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('verification.vdash.noChannel'),
            }).catch(() => {});
        }
    });
}

async function handleRole(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    await selectInteraction.deferUpdate();

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('verif_cfg_role')
        .setPlaceholder(tr.t('verification.dash.rolePlaceholder'))
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('verification.vdash.roleTitle'))
                .setDescription(
                    tr.t('verification.vdash.roleText', { current: cfg.roleId ? `<@&${cfg.roleId}>` : tr.t('verification.dash.notSet') }),
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(roleSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const roleCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.RoleSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'verif_cfg_role',
        time: 60_000,
        max: 1,
    });

    roleCollector.on('collect', async roleInteraction => {
        await roleInteraction.deferUpdate();
        const role = roleInteraction.roles.first();
        const guild = rootInteraction.guild;
        const botMember = guild.members.me;

        // Everyone who verifies gets this role, so it must be harmless and assignable.
        const roleProblem = getRoleAssignmentProblem(role, botMember);
        if (roleProblem) {
            await replyUserError(roleInteraction, { type: ErrorTypes.PERMISSION, message: roleProblem });
            return;
        }

        cfg.roleId = role.id;
        await updateVerificationSettings(client, guildId, { roleId: cfg.roleId });

        await roleInteraction.followUp({
            embeds: [successEmbed(tr.t('verification.dash.roleUpdated'), tr.t('verification.vdash.roleUpdatedText', { role: String(role) }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, cfg, guildId, client);
    });

    roleCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('verification.dash.noRole'),
            }).catch(() => {});
        }
    });
}

async function handleMessage(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    try {
        const modal = new ModalBuilder()
            .setCustomId('verif_cfg_message')
            .setTitle(tr.t('verification.vdash.messageModal'))
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('message_input')
                        .setLabel(tr.t('verification.vdash.messageLabel'))
                        .setStyle(TextInputStyle.Paragraph)
                        .setValue(cfg.message || botConfig.verification.defaultMessage)
                        .setMaxLength(2000)
                        .setMinLength(1)
                        .setRequired(true),
                ),
            );

        await selectInteraction.showModal(modal);

        const submitted = await selectInteraction
            .awaitModalSubmit({
                filter: i =>
                    i.customId === 'verif_cfg_message' && i.user.id === selectInteraction.user.id,
                time: 120_000,
            })
            .catch(() => null);

        if (!submitted) return;

        cfg.message = submitted.fields.getTextInputValue('message_input').trim();

        await updateVerificationSettings(client, guildId, { message: cfg.message });

        await updateLivePanel(rootInteraction.guild, cfg);

        await submitted.reply({
            embeds: [successEmbed(tr.t('verification.vdash.messageUpdatedTitle'), tr.t('verification.vdash.messageUpdatedText'))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, cfg, guildId, client);
    } catch (error) {
        logger.error('Error in handleMessage:', error);
        
    }
}

async function handleButtonText(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    try {
        const modal = new ModalBuilder()
            .setCustomId('verif_cfg_button_text')
            .setTitle(tr.t('verification.vdash.buttonModal'))
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('button_text_input')
                        .setLabel(tr.t('verification.vdash.buttonLabel'))
                        .setStyle(TextInputStyle.Short)
                        .setValue(cfg.buttonText || botConfig.verification.defaultButtonText)
                        .setMaxLength(80)
                        .setMinLength(1)
                        .setRequired(true),
                ),
            );

        await selectInteraction.showModal(modal);

        const submitted = await selectInteraction
            .awaitModalSubmit({
                filter: i =>
                    i.customId === 'verif_cfg_button_text' && i.user.id === selectInteraction.user.id,
                time: 120_000,
            })
            .catch(() => null);

        if (!submitted) return;

        cfg.buttonText = submitted.fields.getTextInputValue('button_text_input').trim();

        await updateVerificationSettings(client, guildId, { buttonText: cfg.buttonText });

        await updateLivePanel(rootInteraction.guild, cfg);

        await submitted.reply({
            embeds: [successEmbed(tr.t('verification.vdash.buttonUpdatedTitle'), tr.t('verification.vdash.buttonUpdatedText', { text: cfg.buttonText }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, cfg, guildId, client);
    } catch (error) {
        logger.error('Error in handleButtonText:', error);
        
    }
}