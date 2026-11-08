import { getColor } from '../../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
    LabelBuilder,
    FileUploadBuilder,
    TextDisplayBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { getWelcomeConfig } from '../../../utils/database.js';
import { updateWelcomeSettings } from '../../../services/welcomeService.js';
import { botHasPermission } from '../../../utils/permissionGuard.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { resolveLogChannel } from '../../../services/loggingService.js';
import { storeWelcomeImage } from '../../../utils/welcomeImageStore.js';
import { botText, textForInteraction } from '../../../utils/botText.js';

// Ephemeral to the admin who opened it: every text in their Discord language ('reply').
// The message templates ({user}, {server} …) are the admin's own text and stay as typed.

async function deferComponent(interaction) {
    if (interaction.deferred || interaction.replied) {
        return true;
    }

    try {
        await interaction.deferUpdate();
        return true;
    } catch (error) {
        logger.debug('Component interaction expired or already acknowledged:', error.message);
        return false;
    }
}

async function sendEphemeralFollowUp(interaction, payload) {
    try {
        await interaction.followUp({
            ...payload,
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        logger.debug('Failed to send ephemeral follow-up:', error.message);
    }
}

function buildDashboardEmbed(cfg, guild, tr = botText()) {
    const notSet = tr.t('welcome.dashboard.notSet');
    const welcomeChannel = cfg.channelId ? `<#${cfg.channelId}>` : notSet;
    const goodbyeChannel = cfg.goodbyeChannelId ? `<#${cfg.goodbyeChannelId}>` : notSet;
    const onOff = (value) => (value ? tr.t('welcome.dashboard.on') : tr.t('welcome.dashboard.off'));

    const rawWelcome = cfg.welcomeMessage || 'Welcome to {server}, {user}.';
    const rawGoodbye = cfg.leaveMessage || '{user.tag} left the server.';
    const welcomePreview = `\`${rawWelcome.length > 55 ? rawWelcome.substring(0, 55) + '…' : rawWelcome}\``;
    const goodbyePreview = `\`${rawGoodbye.length > 55 ? rawGoodbye.substring(0, 55) + '…' : rawGoodbye}\``;

    return new EmbedBuilder()
        .setTitle(tr.t('welcome.dashboard.title'))
        .setDescription(tr.t('welcome.dashboard.description', { server: guild.name }))
        .setColor(getColor('info'))
        .addFields(
            { name: tr.t('welcome.dashboard.field.welcomeChannel'), value: welcomeChannel, inline: true },
            { name: tr.t('welcome.dashboard.field.welcome'), value: onOff(cfg.enabled), inline: true },
            { name: tr.t('welcome.dashboard.field.welcomePing'), value: onOff(cfg.welcomePing), inline: true },
            { name: tr.t('welcome.dashboard.field.goodbyeChannel'), value: goodbyeChannel, inline: true },
            { name: tr.t('welcome.dashboard.field.goodbye'), value: onOff(cfg.goodbyeEnabled), inline: true },
            { name: tr.t('welcome.dashboard.field.goodbyePing'), value: onOff(cfg.goodbyePing), inline: true },
            { name: tr.t('welcome.dashboard.field.welcomeMessage'), value: welcomePreview, inline: false },
            { name: tr.t('welcome.dashboard.field.goodbyeMessage'), value: goodbyePreview, inline: false },
        )
        .setFooter({ text: tr.t('welcome.dashboard.footer') })
        .setTimestamp();
}

function buildSelectMenu(guildId, tr = botText()) {
    return new StringSelectMenuBuilder()
        .setCustomId(`greet_cfg_${guildId}`)
        .setPlaceholder(tr.t('welcome.dashboard.menu.placeholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('welcome.dashboard.menu.welcomeChannel'))
                .setDescription(tr.t('welcome.dashboard.menu.welcomeChannelHint'))
                .setValue('welcome_channel'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('welcome.dashboard.menu.welcomeMessage'))
                .setDescription(tr.t('welcome.dashboard.menu.welcomeMessageHint'))
                .setValue('welcome_message'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('welcome.dashboard.menu.welcomeImage'))
                .setDescription(tr.t('welcome.dashboard.menu.welcomeImageHint'))
                .setValue('welcome_image'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('welcome.dashboard.menu.goodbyeChannel'))
                .setDescription(tr.t('welcome.dashboard.menu.goodbyeChannelHint'))
                .setValue('goodbye_channel'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('welcome.dashboard.menu.goodbyeMessage'))
                .setDescription(tr.t('welcome.dashboard.menu.goodbyeMessageHint'))
                .setValue('goodbye_message'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('welcome.dashboard.menu.goodbyeImage'))
                .setDescription(tr.t('welcome.dashboard.menu.goodbyeImageHint'))
                .setValue('goodbye_image'),
        );
}

function buildButtonRow(cfg, guildId, disabled = false, tr = botText()) {
    const welcomeOn = cfg.enabled === true;
    const goodbyeOn = cfg.goodbyeEnabled === true;
    const welcomePingOn = cfg.welcomePing === true;
    const goodbyePingOn = cfg.goodbyePing === true;
    
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`greet_cfg_toggle_welcome_${guildId}`)
                .setLabel(tr.t('welcome.dashboard.button.welcome'))
                .setStyle(welcomeOn ? ButtonStyle.Success : ButtonStyle.Danger)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`greet_cfg_toggle_goodbye_${guildId}`)
                .setLabel(tr.t('welcome.dashboard.button.goodbye'))
                .setStyle(goodbyeOn ? ButtonStyle.Success : ButtonStyle.Danger)
                .setDisabled(disabled),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`greet_cfg_ping_welcome_${guildId}`)
                .setLabel(tr.t('welcome.dashboard.button.pingWelcome'))
                .setStyle(welcomePingOn ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`greet_cfg_ping_goodbye_${guildId}`)
                .setLabel(tr.t('welcome.dashboard.button.pingGoodbye'))
                .setStyle(goodbyePingOn ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(disabled),
        ),
    ];
}

async function refreshDashboard(rootInteraction, cfg, guildId) {
    try {
        const tr = textForInteraction(rootInteraction);
        const selectMenu = buildSelectMenu(guildId, tr);
        await InteractionHelper.safeEditReply(rootInteraction, {
            embeds: [buildDashboardEmbed(cfg, rootInteraction.guild, tr)],
            components: [
                ...buildButtonRow(cfg, guildId, false, tr),
                new ActionRowBuilder().addComponents(selectMenu),
            ],
        });
    } catch (error) {
        logger.debug('Could not refresh greet dashboard (interaction may have expired):', error.message);
    }
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        try {
            const guildId = interaction.guild.id;
            const cfg = await getWelcomeConfig(client, guildId);

            if (!cfg.channelId && !cfg.goodbyeChannelId) {
                throw new TitanBotError(
                    'Greet system not configured',
                    ErrorTypes.CONFIGURATION,
                    tr.t('welcome.dashboard.notConfigured'),
                );
            }

            await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
            if (!interaction.deferred) {
                return;
            }

            const selectMenu = buildSelectMenu(guildId, tr);

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [buildDashboardEmbed(cfg, interaction.guild, tr)],
                components: [
                    ...buildButtonRow(cfg, guildId, false, tr),
                    new ActionRowBuilder().addComponents(selectMenu),
                ],
            });

            const collector = interaction.channel.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                filter: i =>
                    i.user.id === interaction.user.id && i.customId === `greet_cfg_${guildId}`,
                time: 600_000,
            });

            collector.on('collect', async selectInteraction => {
                const selectedOption = selectInteraction.values[0];
                try {
                    switch (selectedOption) {
                        case 'welcome_channel':
                            await handleWelcomeChannel(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'welcome_message':
                            await handleWelcomeMessage(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'welcome_image':
                            await handleWelcomeImage(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'goodbye_channel':
                            await handleGoodbyeChannel(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'goodbye_message':
                            await handleGoodbyeMessage(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'goodbye_image':
                            await handleGoodbyeImage(selectInteraction, interaction, cfg, guildId, client);
                            break;
                    }
                } catch (error) {
                    if (error instanceof TitanBotError) {
                        logger.debug(`Greet config validation error: ${error.message}`);
                    } else {
                        logger.error('Unexpected greet dashboard error:', error);
                    }

                    const errorMessage =
                        error instanceof TitanBotError
                            ? error.userMessage || tr.t('welcome.dashboard.choiceFailed')
                            : tr.t('welcome.dashboard.saveFailed');

                    if (!selectInteraction.replied && !selectInteraction.deferred) {
                        await selectInteraction.deferUpdate().catch(() => {});
                    }

                    await replyUserError(selectInteraction, {
                        type: ErrorTypes.CONFIGURATION,
                        message: errorMessage,
                    }).catch(() => {});
                }
            });

            const btnCollector = interaction.channel.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: i =>
                    i.user.id === interaction.user.id &&
                    (i.customId === `greet_cfg_toggle_welcome_${guildId}` ||
                        i.customId === `greet_cfg_toggle_goodbye_${guildId}` ||
                        i.customId === `greet_cfg_ping_welcome_${guildId}` ||
                        i.customId === `greet_cfg_ping_goodbye_${guildId}`),
                time: 600_000,
            });

            btnCollector.on('collect', async btnInteraction => {
                try {
                    if (!await deferComponent(btnInteraction)) {
                        return;
                    }

                    const customId = btnInteraction.customId;

                    if (customId === `greet_cfg_toggle_welcome_${guildId}`) {
                        cfg.enabled = !cfg.enabled;
                        await updateWelcomeSettings(client, guildId, { enabled: cfg.enabled });
                        await sendEphemeralFollowUp(btnInteraction, {
                            embeds: [
                                successEmbed(
                                    tr.t('welcome.dashboard.welcomeUpdated'),
                                    cfg.enabled ? tr.t('welcome.dashboard.welcomeNowOn') : tr.t('welcome.dashboard.welcomeNowOff'),
                                ),
                            ],
                        });
                    } else if (customId === `greet_cfg_toggle_goodbye_${guildId}`) {
                        cfg.goodbyeEnabled = !cfg.goodbyeEnabled;
                        await updateWelcomeSettings(client, guildId, { goodbyeEnabled: cfg.goodbyeEnabled });
                        await sendEphemeralFollowUp(btnInteraction, {
                            embeds: [
                                successEmbed(
                                    tr.t('welcome.dashboard.goodbyeUpdated'),
                                    cfg.goodbyeEnabled ? tr.t('welcome.dashboard.goodbyeNowOn') : tr.t('welcome.dashboard.goodbyeNowOff'),
                                ),
                            ],
                        });
                    } else if (customId === `greet_cfg_ping_welcome_${guildId}`) {
                        cfg.welcomePing = !cfg.welcomePing;
                        await updateWelcomeSettings(client, guildId, { welcomePing: cfg.welcomePing });
                        await sendEphemeralFollowUp(btnInteraction, {
                            embeds: [
                                successEmbed(
                                    tr.t('welcome.dashboard.welcomePingUpdated'),
                                    cfg.welcomePing ? tr.t('welcome.dashboard.welcomePingOn') : tr.t('welcome.dashboard.welcomePingOff'),
                                ),
                            ],
                        });
                    } else if (customId === `greet_cfg_ping_goodbye_${guildId}`) {
                        cfg.goodbyePing = !cfg.goodbyePing;
                        await updateWelcomeSettings(client, guildId, { goodbyePing: cfg.goodbyePing });
                        await sendEphemeralFollowUp(btnInteraction, {
                            embeds: [
                                successEmbed(
                                    tr.t('welcome.dashboard.goodbyePingUpdated'),
                                    cfg.goodbyePing ? tr.t('welcome.dashboard.goodbyePingOn') : tr.t('welcome.dashboard.goodbyePingOff'),
                                ),
                            ],
                        });
                    }

                    await refreshDashboard(interaction, cfg, guildId);
                } catch (error) {
                    logger.error('Error handling greet dashboard button:', error);
                }
            });

            collector.on('end', async (collected, reason) => {
                if (reason === 'time') {
                    btnCollector.stop();
                    try {
                        await InteractionHelper.safeEditReply(interaction, {
                            embeds: [
                                new EmbedBuilder()
                                    .setTitle(tr.t('welcome.dashboard.closedTitle'))
                                    .setDescription(tr.t('welcome.dashboard.closedBody'))
                                    .setColor(getColor('error'))
                            ],
                            components: [],
                        });
                    } catch (error) {
                        logger.debug('Could not update dashboard on timeout:', error.message);
                    }
                }
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in greet_dashboard:', error);
            throw new TitanBotError(
                `Greet dashboard failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                tr.t('welcome.dashboard.openFailed'),
            );
        }
    },
};

async function handleWelcomeChannel(selectInteraction, rootInteraction, cfg, guildId, client) {
    if (!await deferComponent(selectInteraction)) {
        return;
    }
    const tr = textForInteraction(selectInteraction);

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('greet_cfg_welcome_channel')
        .setPlaceholder(tr.t('welcome.dashboard.channelPlaceholder'))
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMaxValues(1);

    await sendEphemeralFollowUp(selectInteraction, {
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('welcome.dashboard.welcomeChannelTitle'))
                .setDescription(
                    tr.t('welcome.dashboard.welcomeChannelPrompt', { current: cfg.channelId ? `<#${cfg.channelId}>` : tr.t('welcome.dashboard.notSet') }),
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
    });

    const chanCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'greet_cfg_welcome_channel',
        time: 60_000,
        max: 1,
    });

    chanCollector.on('collect', async chanInteraction => {
        if (!await deferComponent(chanInteraction)) {
            return;
        }
        const channel = chanInteraction.channels.first();

        if (!botHasPermission(channel, ['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
            await replyUserError(chanInteraction, {
                type: ErrorTypes.PERMISSION,
                message: tr.t('welcome.dashboard.needPermissions', { channel: String(channel) }),
            });
            return;
        }

        cfg.channelId = channel.id;
        await updateWelcomeSettings(client, guildId, { channelId: cfg.channelId });

        await sendEphemeralFollowUp(chanInteraction, {
            embeds: [successEmbed(tr.t('welcome.dashboard.channelUpdated'), tr.t('welcome.dashboard.welcomeChannelNow', { channel: String(channel) }))],
        });

        await refreshDashboard(rootInteraction, cfg, guildId);
    });

    chanCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('welcome.dashboard.noChannel'),
            }).catch(() => {});
        }
    });
}

async function handleWelcomeMessage(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('greet_cfg_welcome_message')
        .setTitle(tr.t('welcome.dashboard.welcomeMessageTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('message_input')
                    .setLabel(tr.t('welcome.dashboard.messageLabel', { user: '{user}', server: '{server}' }))
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(cfg.welcomeMessage || 'Welcome to {server}, {user}.')
                    .setMaxLength(2000)
                    .setMinLength(1)
                    .setRequired(true),
            ),
        );

    try {
        await selectInteraction.showModal(modal);
    } catch {
        return;
    }

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'greet_cfg_welcome_message' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    cfg.welcomeMessage = submitted.fields.getTextInputValue('message_input').trim();
    await updateWelcomeSettings(client, guildId, { welcomeMessage: cfg.welcomeMessage });

    await submitted.reply({
        embeds: [successEmbed(tr.t('welcome.dashboard.saved'), tr.t('welcome.dashboard.welcomeSaved'))],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

// Uploaded files get a signed CDN URL that expires in about a day, so they are
// re-posted to a storage channel (audit log channel, else the dashboard's channel)
// and that message is saved; see utils/welcomeImageStore.js. Returns the stored
// reference (or null) and a note for the admin.
async function storeUploadedGreetImage(submitted, rootInteraction, client, guildId, attachment, label, tr = botText()) {
    const guildConfig = await getGuildConfig(client, guildId);
    const ref = await storeWelcomeImage(
        submitted.guild,
        attachment,
        [resolveLogChannel(guildConfig, 'audit'), rootInteraction.channelId],
        label,
    );
    const kept = label === 'goodbye'
        ? (channelId) => tr.t('welcome.dashboard.goodbyeCopyKept', { channelId })
        : (channelId) => tr.t('welcome.dashboard.welcomeCopyKept', { channelId });
    const note = ref ? kept(ref.channelId) : tr.t('welcome.dashboard.copyFailed');
    return { ref, note };
}

async function sendImageResult(submitted, title, description) {
    const embeds = [successEmbed(title, description)];
    if (submitted.deferred) {
        await submitted.editReply({ embeds });
    } else {
        await submitted.reply({ embeds, flags: MessageFlags.Ephemeral });
    }
}

async function handleWelcomeImage(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('greet_cfg_welcome_image')
        .setTitle(tr.t('welcome.dashboard.welcomeImageTitle'));

    const imageHint = new TextDisplayBuilder()
        .setContent(tr.t('welcome.dashboard.imageHint'));

    const urlLabel = new LabelBuilder()
        .setLabel(tr.t('welcome.dashboard.imageUrlLabel'))
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('image_input')
                .setPlaceholder('https://example.com/welcome.png')
                .setStyle(TextInputStyle.Short)
                .setValue(cfg.welcomeImage || '')
                .setRequired(false),
        );

    const uploadLabel = new LabelBuilder()
        .setLabel(tr.t('welcome.dashboard.imageUploadLabel'))
        .setFileUploadComponent(
            new FileUploadBuilder()
                .setCustomId('image_upload')
                .setRequired(false),
        );

    modal
        .addTextDisplayComponents(imageHint)
        .addLabelComponents(urlLabel, uploadLabel);

    try {
        await selectInteraction.showModal(modal);
    } catch {
        return;
    }

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'greet_cfg_welcome_image' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const uploadedFiles = submitted.fields.getUploadedFiles('image_upload');
    const uploaded = uploadedFiles?.at(0) ?? null;
    let imageUrl = uploaded?.url ?? submitted.fields.getTextInputValue('image_input').trim();

    if (imageUrl) {
        try {
            new URL(imageUrl);
            if (!['http:', 'https:'].includes(new URL(imageUrl).protocol)) {
                await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('welcome.dashboard.imageBadProtocol') });
                return;
            }
        } catch {
            await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('welcome.dashboard.imageBadUrl') });
            return;
        }
    }

    let storeNote = '';
    // Re-submitting the pre-filled URL keeps the stored copy.
    let imageRef = cfg.welcomeImageRef?.url && cfg.welcomeImageRef.url === imageUrl ? cfg.welcomeImageRef : null;
    if (uploaded) {
        // Re-uploading can take longer than the 3s reply window.
        await submitted.deferReply({ flags: MessageFlags.Ephemeral });
        ({ ref: imageRef, note: storeNote } = await storeUploadedGreetImage(submitted, rootInteraction, client, guildId, uploaded, 'welcome', tr));
        if (imageRef) imageUrl = imageRef.url;
    }

    cfg.welcomeImage = imageUrl || null;
    cfg.welcomeImageRef = imageRef;
    await updateWelcomeSettings(client, guildId, { welcomeImage: cfg.welcomeImage, welcomeImageRef: cfg.welcomeImageRef });

    await sendImageResult(submitted, tr.t('welcome.dashboard.welcomeImageTitle'), `${imageUrl ? tr.t('welcome.dashboard.imageSaved') : tr.t('welcome.dashboard.imageRemoved')}${storeNote}`);

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleWelcomePing(selectInteraction, rootInteraction, cfg, guildId, client) {
    if (!await deferComponent(selectInteraction)) {
        return;
    }
    const tr = textForInteraction(selectInteraction);

    cfg.welcomePing = !cfg.welcomePing;
    await updateWelcomeSettings(client, guildId, { welcomePing: cfg.welcomePing });

    await sendEphemeralFollowUp(selectInteraction, {
        embeds: [
            successEmbed(
                tr.t('welcome.dashboard.welcomePingUpdated'),
                cfg.welcomePing ? tr.t('welcome.dashboard.welcomePingOn') : tr.t('welcome.dashboard.welcomePingOff'),
            ),
        ],
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleGoodbyeChannel(selectInteraction, rootInteraction, cfg, guildId, client) {
    if (!await deferComponent(selectInteraction)) {
        return;
    }
    const tr = textForInteraction(selectInteraction);

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('greet_cfg_goodbye_channel')
        .setPlaceholder(tr.t('welcome.dashboard.channelPlaceholder'))
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMaxValues(1);

    await sendEphemeralFollowUp(selectInteraction, {
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('welcome.dashboard.goodbyeChannelTitle'))
                .setDescription(
                    tr.t('welcome.dashboard.goodbyeChannelPrompt', { current: cfg.goodbyeChannelId ? `<#${cfg.goodbyeChannelId}>` : tr.t('welcome.dashboard.notSet') }),
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
    });

    const chanCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'greet_cfg_goodbye_channel',
        time: 60_000,
        max: 1,
    });

    chanCollector.on('collect', async chanInteraction => {
        if (!await deferComponent(chanInteraction)) {
            return;
        }
        const channel = chanInteraction.channels.first();

        if (!botHasPermission(channel, ['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
            await replyUserError(chanInteraction, {
                type: ErrorTypes.PERMISSION,
                message: tr.t('welcome.dashboard.needPermissions', { channel: String(channel) }),
            });
            return;
        }

        cfg.goodbyeChannelId = channel.id;
        await updateWelcomeSettings(client, guildId, { goodbyeChannelId: cfg.goodbyeChannelId });

        await sendEphemeralFollowUp(chanInteraction, {
            embeds: [successEmbed(tr.t('welcome.dashboard.channelUpdated'), tr.t('welcome.dashboard.goodbyeChannelNow', { channel: String(channel) }))],
        });

        await refreshDashboard(rootInteraction, cfg, guildId);
    });

    chanCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('welcome.dashboard.noChannel'),
            }).catch(() => {});
        }
    });
}

async function handleGoodbyeMessage(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('greet_cfg_goodbye_message')
        .setTitle(tr.t('welcome.dashboard.goodbyeMessageTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('message_input')
                    .setLabel(tr.t('welcome.dashboard.messageLabel', { user: '{user}', server: '{server}' }))
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(cfg.leaveMessage || '{user.tag} left the server.')
                    .setMaxLength(2000)
                    .setMinLength(1)
                    .setRequired(true),
            ),
        );

    try {
        await selectInteraction.showModal(modal);
    } catch {
        return;
    }

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'greet_cfg_goodbye_message' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    cfg.leaveMessage = submitted.fields.getTextInputValue('message_input').trim();
    await updateWelcomeSettings(client, guildId, { leaveMessage: cfg.leaveMessage });

    await submitted.reply({
        embeds: [successEmbed(tr.t('welcome.dashboard.saved'), tr.t('welcome.dashboard.goodbyeSaved'))],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleGoodbyeImage(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('greet_cfg_goodbye_image')
        .setTitle(tr.t('welcome.dashboard.goodbyeImageTitle'));

    const imageHint = new TextDisplayBuilder()
        .setContent(tr.t('welcome.dashboard.imageHint'));

    const urlLabel = new LabelBuilder()
        .setLabel(tr.t('welcome.dashboard.imageUrlLabel'))
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('image_input')
                .setPlaceholder('https://example.com/goodbye.png')
                .setStyle(TextInputStyle.Short)
                .setValue(
                    typeof cfg.leaveEmbed?.image === 'string'
                        ? cfg.leaveEmbed.image
                        : cfg.leaveEmbed?.image?.url || ''
                )
                .setRequired(false),
        );

    const uploadLabel = new LabelBuilder()
        .setLabel(tr.t('welcome.dashboard.imageUploadLabel'))
        .setFileUploadComponent(
            new FileUploadBuilder()
                .setCustomId('image_upload')
                .setRequired(false),
        );

    modal
        .addTextDisplayComponents(imageHint)
        .addLabelComponents(urlLabel, uploadLabel);

    try {
        await selectInteraction.showModal(modal);
    } catch {
        return;
    }

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'greet_cfg_goodbye_image' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const uploadedFiles = submitted.fields.getUploadedFiles('image_upload');
    const uploaded = uploadedFiles?.at(0) ?? null;
    let imageUrl = uploaded?.url ?? submitted.fields.getTextInputValue('image_input').trim();

    if (imageUrl) {
        try {
            new URL(imageUrl);
            if (!['http:', 'https:'].includes(new URL(imageUrl).protocol)) {
                await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('welcome.dashboard.imageBadProtocol') });
                return;
            }
        } catch {
            await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('welcome.dashboard.imageBadUrl') });
            return;
        }
    }

    let storeNote = '';
    // Re-submitting the pre-filled URL keeps the stored copy.
    let imageRef = cfg.goodbyeImageRef?.url && cfg.goodbyeImageRef.url === imageUrl ? cfg.goodbyeImageRef : null;
    if (uploaded) {
        // Re-uploading can take longer than the 3s reply window.
        await submitted.deferReply({ flags: MessageFlags.Ephemeral });
        ({ ref: imageRef, note: storeNote } = await storeUploadedGreetImage(submitted, rootInteraction, client, guildId, uploaded, 'goodbye', tr));
        if (imageRef) imageUrl = imageRef.url;
    }

    const nextLeaveEmbed = { ...(cfg.leaveEmbed || {}) };
    if (imageUrl) {
        nextLeaveEmbed.image = imageUrl;
    } else {
        delete nextLeaveEmbed.image;
    }

    cfg.leaveEmbed = nextLeaveEmbed;
    cfg.goodbyeImageRef = imageRef;
    await updateWelcomeSettings(client, guildId, { leaveEmbed: cfg.leaveEmbed, goodbyeImageRef: cfg.goodbyeImageRef });

    await sendImageResult(submitted, tr.t('welcome.dashboard.goodbyeImageTitle'), `${imageUrl ? tr.t('welcome.dashboard.imageSaved') : tr.t('welcome.dashboard.imageRemoved')}${storeNote}`);

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleGoodbyePing(selectInteraction, rootInteraction, cfg, guildId, client) {
    if (!await deferComponent(selectInteraction)) {
        return;
    }
    const tr = textForInteraction(selectInteraction);

    cfg.goodbyePing = !cfg.goodbyePing;
    await updateWelcomeSettings(client, guildId, { goodbyePing: cfg.goodbyePing });

    await sendEphemeralFollowUp(selectInteraction, {
        embeds: [
            successEmbed(
                tr.t('welcome.dashboard.goodbyePingUpdated'),
                cfg.goodbyePing ? tr.t('welcome.dashboard.goodbyePingOn') : tr.t('welcome.dashboard.goodbyePingOff'),
            ),
        ],
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}