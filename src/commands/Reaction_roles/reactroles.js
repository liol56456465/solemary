import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle, MessageFlags, ComponentType, EmbedBuilder, LabelBuilder, CheckboxBuilder, TextDisplayBuilder } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { createError, TitanBotError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    createReactionRolePanel, hasDangerousPermissions, getAllReactionRoleMessages,
    getPanelRoleProblem, addPanelRole, removePanelRole, deletePanel,
} from '../../services/reactionRoleService.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import {
    getReactionRolePanelStatus,
    formatPanelStatusField,
} from '../../utils/panelStatus.js';
import { startDashboardSession } from '../../utils/dashboardSession.js';
import { getReactionRoleKey } from '../../utils/database/keys.js';
import { textForGuild, textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';
import { buildReactionRolePanelPayload, panelFieldsWithRoles } from '../../services/reactionRoleService.js';

const DASHBOARD_EPHEMERAL = MessageFlags.Ephemeral;
const SELECT_OPTION_LABEL_LIMIT = 100;
const SELECT_OPTION_DESCRIPTION_LIMIT = 100;

function truncateText(value, maxLength) {
    const text = String(value ?? '');
    return text.length > maxLength ? text.substring(0, maxLength) : text;
}

export default {
    data: new SlashCommandBuilder()
        .setName('reactroles')
        .setDescription('Manage reaction role assignments')
        .setDescriptionLocalizations(localizations('reactionroles.cmd.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set up a new reaction role panel')
                .setDescriptionLocalizations(localizations('reactionroles.cmd.setup.description'))
                .addChannelOption(option => 
                    option.setName('channel')
                        .setDescription('The channel to send the reaction role message to')
                        .setDescriptionLocalizations(localizations('reactionroles.cmd.setup.channel'))
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('title')
                        .setDescription('Title for the reaction role panel')
                        .setDescriptionLocalizations(localizations('reactionroles.cmd.setup.title'))
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('Description for the reaction role panel')
                        .setDescriptionLocalizations(localizations('reactionroles.cmd.setup.text'))
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('role1')
                        .setDescription('First role to add')
                        .setDescriptionLocalizations(localizations('reactionroles.cmd.setup.role1'))
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('role2')
                        .setDescription('Second role to add')
                        .setDescriptionLocalizations(localizations('reactionroles.cmd.setup.role2'))
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role3')
                        .setDescription('Third role to add')
                        .setDescriptionLocalizations(localizations('reactionroles.cmd.setup.role3'))
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role4')
                        .setDescription('Fourth role to add')
                        .setDescriptionLocalizations(localizations('reactionroles.cmd.setup.role4'))
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role5')
                        .setDescription('Fifth role to add')
                        .setDescriptionLocalizations(localizations('reactionroles.cmd.setup.role5'))
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('dashboard')
                .setDescription('Manage and configure your reaction role panels')
                .setDescriptionLocalizations(localizations('reactionroles.cmd.dashboard.description'))
                .addStringOption(option =>
                    option
                        .setName('panel')
                        .setDescription('Select a reaction role panel to manage')
                        .setDescriptionLocalizations(localizations('reactionroles.cmd.dashboard.panel'))
                        .setRequired(false)
                        .setAutocomplete(true)
                )
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'setup') {
            await handleSetup(interaction);
        } else if (subcommand === 'dashboard') {
            const selectedPanelId = interaction.options.getString('panel');
            await handleDashboard(interaction, selectedPanelId);
        }
    },

    async autocomplete(interaction) {
        if (interaction.commandName !== 'reactroles') return;
        if (interaction.options.getSubcommand() !== 'dashboard') return;

        // Autocomplete must respond within 3s. Build choices from stored panel data and
        // cached channels/messages only — no network fetches — to avoid DiscordAPIError 10062.
        try {
            const guildId = interaction.guild.id;
            const client = interaction.client;
            const guild = interaction.guild;

            let panels;
            try {
                panels = await getAllReactionRoleMessages(client, guildId);
            } catch {
                await interaction.respond([]).catch(() => {});
                return;
            }

            if (!panels?.length) {
                await interaction.respond([]).catch(() => {});
                return;
            }

            const tr = textForInteraction(interaction);
            const choices = [];
            for (const panel of panels) {
                if (!panel.messageId || !panel.channelId) continue;

                const channel = guild.channels.cache.get(panel.channelId);
                if (!channel) continue;

                const cachedTitle = channel.messages?.cache?.get(panel.messageId)?.embeds?.[0]?.title;
                const roleCount = Array.isArray(panel.roles) ? panel.roles.length : 0;
                const label = cachedTitle
                    ? `${cachedTitle} (#${channel.name})`
                    : tr.tp('reactionroles.autocomplete.roles', roleCount, { channel: channel.name });

                choices.push({ name: label.substring(0, 100), value: panel.messageId });
                if (choices.length >= 25) break;
            }

            await interaction.respond(choices).catch(() => {});
        } catch {
            await interaction.respond([]).catch(() => {});
        }
    }
};

async function handleSetup(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) return;
    const tr = textForInteraction(interaction);

    logger.info(`Reaction role setup initiated by ${interaction.user.tag} in guild ${interaction.guild.name}`);

    const channel = interaction.options.getChannel('channel');
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const roleIds = [1, 2, 3, 4, 5].map((i) => interaction.options.getRole(`role${i}`)?.id).filter(Boolean);

    // Every check (channel, bot permissions, panel limit, role safety), posting, saving
    // and logging: services/reactionRoleService.js (shared with the web dashboard).
    const { message, rejected } = await createReactionRolePanel(interaction.client, interaction.guild, {
        channel, title, description, roleIds, actorId: interaction.user.id, actorTag: interaction.user.tag, lang: tr.lang,
    });

    if (rejected.length > 0) {
        await interaction.followUp({
            embeds: [warningEmbed(tr.t('reactionroles.setup.warningTitle'), tr.t('reactionroles.errors.cannotAdd', { list: rejected.join('\n') }))],
            flags: MessageFlags.Ephemeral
        });
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(tr.t('reactionroles.setup.createdTitle'), tr.t('reactionroles.setup.createdText', { channel: String(channel), url: message.url }))]
    });
}

async function fetchPanelDiscordMessage(guild, panelData) {
    try {
        const channel = guild.channels.cache.get(panelData.channelId);
        if (!channel) return null;
        return await channel.messages.fetch(panelData.messageId).catch(() => null);
    } catch {
        return null;
    }
}

async function showPanelDashboard(interaction, panelData, discordMsg, guildId, guild, client, panelStatus = null) {
    const tr = textForInteraction(interaction);
    if (!panelStatus && client) {
        panelStatus = await getReactionRolePanelStatus(client, guild, panelData);
        if (panelStatus.recoveredId) {
            await migrateReactionRoleMessageId(client, guildId, panelData, panelStatus.recoveredId);
            discordMsg = panelStatus.message || discordMsg;
        }
    }

    const payload = buildReactionRoleDashboardPayload(panelData, discordMsg, guildId, guild, panelStatus, tr);
    await InteractionHelper.safeEditReply(interaction, { ...payload, flags: DASHBOARD_EPHEMERAL });
}

function buildReactionRoleDashboardPayload(panelData, discordMsg, guildId, guild, panelStatus = null, tr = textForInteraction(null)) {
    const channel = guild.channels.cache.get(panelData.channelId);
    const title = discordMsg?.embeds?.[0]?.title ?? tr.t('reactionroles.dashboard.untitled');
    const roleList =
        panelData.roles.length > 0
            ? panelData.roles.map(id => `<@&${id}>`).join(',')
            : tr.t('reactionroles.dashboard.none');

    const showRepost = panelStatus?.exists === false && panelStatus?.reason === 'panel_deleted';

    const embed = new EmbedBuilder()
        .setTitle(tr.t('reactionroles.dashboard.title'))
        .setDescription(
            tr.t('reactionroles.dashboard.intro', { title }) + (discordMsg ? tr.t('reactionroles.dashboard.viewLink', { url: discordMsg.url }) : ''),
        )
        .setColor(getColor('info'))
        .addFields(
            { name: tr.t('reactionroles.dashboard.fieldStatus'), value: formatPanelStatusField(panelStatus), inline: false },
            { name: tr.t('reactionroles.dashboard.fieldChannel'), value: channel ? `<#${channel.id}>` : tr.t('reactionroles.dashboard.channelNotFound'), inline: true },
            { name: tr.t('reactionroles.dashboard.fieldRoles'), value: `\`${panelData.roles.length} / 25\``, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: tr.t('reactionroles.dashboard.fieldRoleList'), value: roleList, inline: false },
        )
        .setFooter({ text: tr.t('reactionroles.dashboard.footer') })
        .setTimestamp();

    const buttons = [];

    if (showRepost) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`rr_repost_${guildId}`)
                .setLabel(tr.t('reactionroles.dashboard.repostButton'))
                .setStyle(ButtonStyle.Primary),
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId(`rr_edit_text_${guildId}`)
            .setLabel(tr.t('reactionroles.dashboard.editTextButton'))
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`rr_delete_${guildId}`)
            .setLabel(tr.t('reactionroles.dashboard.deleteButton'))
            .setStyle(ButtonStyle.Danger),
    );

    const optionsSelect = new StringSelectMenuBuilder()
        .setCustomId(`rr_opts_${guildId}`)
        .setPlaceholder(tr.t('reactionroles.dashboard.actionPlaceholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('reactionroles.dashboard.addRoleLabel'))
                .setDescription(tr.t('reactionroles.dashboard.addRoleHint'))
                .setValue('add_role'),
            ...(panelData.roles.length > 0
                ? [
                      new StringSelectMenuOptionBuilder()
                          .setLabel(tr.t('reactionroles.dashboard.removeRoleLabel'))
                          .setDescription(tr.t('reactionroles.dashboard.removeRoleHint'))
                          .setValue('remove_role'),
                  ]
                : []),
        );

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(buttons),
            new ActionRowBuilder().addComponents(optionsSelect),
        ],
    };
}

async function migrateReactionRoleMessageId(client, guildId, panelData, newMessageId) {
    if (!newMessageId || panelData.messageId === newMessageId) return;
    const oldKey = getReactionRoleKey(guildId, panelData.messageId);
    panelData.messageId = newMessageId;
    await client.db.set(getReactionRoleKey(guildId, newMessageId), panelData);
    await client.db.delete(oldKey).catch(() => {});
}

async function repostReactionRolePanel(guild, panelData, client, guildId, fallbackEmbed = null, tr = textForInteraction(null)) {
    const channel = await guild.channels.fetch(panelData.channelId).catch(() => null);
    if (!channel) {
        throw createError(
            'Panel channel missing',
            ErrorTypes.CONFIGURATION,
            tr.t('reactionroles.dashboard.channelMissing'),
        );
    }

    const roleObjects = panelData.roles.map(id => guild.roles.cache.get(id)).filter(Boolean);
    if (roleObjects.length === 0) {
        throw createError(
            'No valid roles',
            ErrorTypes.VALIDATION,
            tr.t('reactionroles.dashboard.noValidRoles'),
        );
    }

    // A post in the channel: the server's language. The title and description are the admin's
    // own text (kept from the old message); only the bot's fallbacks are translated.
    const panelTr = textForGuild(guildId, { purpose: 'public' });
    const title = fallbackEmbed?.title || panelTr.t('reactionroles.panel.defaultTitle');
    const description = fallbackEmbed?.description || panelTr.t('reactionroles.panel.defaultDescription');

    // Same layout as before (no footer on a repost): embed + role list + select menu.
    const { embeds, components } = buildReactionRolePanelPayload(title, description, roleObjects, { lang: panelTr.lang });
    const panelEmbed = EmbedBuilder.from(embeds[0]).setFooter(null);

    const sent = await channel.send({ embeds: [panelEmbed], components });
    await migrateReactionRoleMessageId(client, guildId, panelData, sent.id);
    return sent;
}

async function handleDashboard(interaction, selectedPanelId) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: DASHBOARD_EPHEMERAL });
    if (!deferSuccess) return;

    const client = interaction.client;
    const guildId = interaction.guild.id;
    const guild = interaction.guild;
    const tr = textForInteraction(interaction);

    const panels = await getAllReactionRoleMessages(client, guildId);
    if (!panels?.length) {
        throw createError(
            'No panels',
            ErrorTypes.CONFIGURATION,
            tr.t('reactionroles.dashboard.noPanels'),
        );
    }

    let panelData = selectedPanelId ? panels.find(p => p.messageId === selectedPanelId) : null;
    if (!panelData) {
        if (panels.length === 1) {
            panelData = panels[0];
        } else {
            throw createError(
                'Panel required',
                ErrorTypes.VALIDATION,
                tr.t('reactionroles.dashboard.panelRequired'),
            );
        }
    }

    let panelStatus = await getReactionRolePanelStatus(client, guild, panelData);
    if (panelStatus.recoveredId) {
        await migrateReactionRoleMessageId(client, guildId, panelData, panelStatus.recoveredId);
        panelStatus = await getReactionRolePanelStatus(client, guild, panelData);
    }

    const discordMsg = panelStatus.message || (await fetchPanelDiscordMessage(guild, panelData));
    const payload = buildReactionRoleDashboardPayload(panelData, discordMsg, guildId, guild, panelStatus, tr);

    await startDashboardSession({
        interaction,
        ...payload,
        flags: DASHBOARD_EPHEMERAL,
        selectMenuId: `rr_opts_${guildId}`,
        buttonMatcher: (customId) =>
            customId === `rr_edit_text_${guildId}` ||
            customId === `rr_delete_${guildId}` ||
            customId === `rr_repost_${guildId}`,
        onSelect: async (selectInteraction) => {
            const selectedOption = selectInteraction.values[0];
            if (selectedOption === 'add_role') {
                await handleAddRole(selectInteraction, interaction, panelData, guildId, guild, client);
            } else if (selectedOption === 'remove_role') {
                await handleRemoveRole(selectInteraction, interaction, panelData, panels, guildId, guild, client);
            }
        },
        onButton: async (btnInteraction) => {
            if (btnInteraction.customId === `rr_repost_${guildId}`) {
                await btnInteraction.deferUpdate();
                const fallbackEmbed = discordMsg?.embeds?.[0];
                const newMsg = await repostReactionRolePanel(
                    guild,
                    panelData,
                    client,
                    guildId,
                    fallbackEmbed,
                    tr,
                );
                await btnInteraction.followUp({
                    embeds: [successEmbed(tr.t('reactionroles.dashboard.repostedTitle'), tr.t('reactionroles.dashboard.repostedText', { channel: String(newMsg.channel) }))],
                    flags: MessageFlags.Ephemeral,
                });
                await showPanelDashboard(
                    interaction,
                    panelData,
                    newMsg,
                    guildId,
                    guild,
                    client,
                    { exists: true, message: newMsg },
                );
                return;
            }

            if (btnInteraction.customId === `rr_edit_text_${guildId}`) {
                await handleEditText(btnInteraction, interaction, panelData, guildId, guild, client);
                return;
            }

            if (btnInteraction.customId === `rr_delete_${guildId}`) {
                await handleDeletePanel(btnInteraction, interaction, panelData, panels, guildId, guild, client);
            }
        },
    });
}

async function handleEditText(buttonInteraction, rootInteraction, panelData, guildId, guild, client) {
    const tr = textForInteraction(buttonInteraction);
    const channel = guild.channels.cache.get(panelData.channelId);
    const discordMsg = channel
        ? await channel.messages.fetch(panelData.messageId).catch(() => null)
        : null;

    const currentTitle = discordMsg?.embeds?.[0]?.title ?? '';
    const currentDesc = discordMsg?.embeds?.[0]?.description ?? '';

    const modal = new ModalBuilder()
        .setCustomId('rr_edit_text')
        .setTitle(tr.t('reactionroles.dashboard.editModalTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('panel_title')
                    .setLabel(tr.t('reactionroles.dashboard.editTitleLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentTitle)
                    .setMaxLength(256)
                    .setMinLength(1)
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('panel_description')
                    .setLabel(tr.t('reactionroles.dashboard.editDescriptionLabel'))
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(currentDesc)
                    .setMaxLength(2048)
                    .setMinLength(1)
                    .setRequired(true),
            ),
        );

    try {
        await buttonInteraction.showModal(modal);
    } catch (error) {
        logger.error('Error showing edit text modal:', error);
        await replyUserError(buttonInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: tr.t('reactionroles.dashboard.editModalFailed'),
        }).catch(() => {});
        return;
    }

    const submitted = await buttonInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'rr_edit_text' && i.user.id === buttonInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newTitle = submitted.fields.getTextInputValue('panel_title').trim();
    const newDescription = submitted.fields.getTextInputValue('panel_description').trim();

    if (discordMsg) {
        const roleObjects = panelData.roles
            .map(id => guild.roles.cache.get(id))
            .filter(Boolean);
        const updatedEmbed = EmbedBuilder.from(discordMsg.embeds[0])
            .setTitle(newTitle)
            .setDescription(newDescription);
        if (roleObjects.length > 0) {
            // The panel itself is public: its role list follows the server's language.
            updatedEmbed.setFields(panelFieldsWithRoles(discordMsg.embeds[0].fields, roleObjects, textForGuild(guildId, { purpose: 'public' })));
        }
        await discordMsg.edit({ embeds: [updatedEmbed] }).catch(() => {});
    }

    await submitted.reply({
        embeds: [successEmbed(tr.t('reactionroles.dashboard.updatedTitle'), tr.t('reactionroles.dashboard.updatedText'))],
        flags: MessageFlags.Ephemeral,
    });

    const refreshedMsg = channel
        ? await channel.messages.fetch(panelData.messageId).catch(() => null)
        : null;
    await showPanelDashboard(rootInteraction, panelData, refreshedMsg, guildId, guild, client);
}

async function handleAddRole(selectInteraction, rootInteraction, panelData, guildId, guild, client) {
    await selectInteraction.deferUpdate();
    const tr = textForInteraction(selectInteraction);

    const limitProblem = getPanelRoleProblem(guild, null, panelData, { lang: tr.lang });
    if (limitProblem) {
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: limitProblem,
        });
        return;
    }

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('rr_add_role_pick')
        .setPlaceholder(tr.t('reactionroles.dashboard.addPlaceholder'))
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('reactionroles.dashboard.addTitle'))
                .setDescription(
                    tr.t('reactionroles.dashboard.addText', { current: panelData.roles.length }),
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(roleSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const roleCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.RoleSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'rr_add_role_pick',
        time: 60_000,
        max: 1,
    });

    roleCollector.on('collect', async roleInteraction => {
        await roleInteraction.deferUpdate();
        const role = roleInteraction.roles.first();

        try {
            const { panel } = await addPanelRole(client, guildId, panelData.messageId, role.id, { lang: tr.lang });
            Object.assign(panelData, panel);
        } catch (error) {
            if (!(error instanceof TitanBotError) || !error.userMessage) throw error;
            await replyUserError(roleInteraction, { type: error.type, message: error.userMessage });
            return;
        }

        await roleInteraction.followUp({
            embeds: [successEmbed(tr.t('reactionroles.dashboard.addedTitle'), tr.t('reactionroles.dashboard.addedText', { role: String(role) }))],
            flags: MessageFlags.Ephemeral,
        });

        const channel = guild.channels.cache.get(panelData.channelId);
        const discordMsg = channel
            ? await channel.messages.fetch(panelData.messageId).catch(() => null)
            : null;
        await showPanelDashboard(rootInteraction, panelData, discordMsg, guildId, guild, client);
    });

    roleCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('reactionroles.dashboard.noRoleSelected'),
            }).catch(() => {});
        }
    });
}

async function handleRemoveRole(selectInteraction, rootInteraction, panelData, panels, guildId, guild, client) {
    await selectInteraction.deferUpdate();
    const tr = textForInteraction(selectInteraction);

    const roleOptions = panelData.roles
        .map(id => {
            const role = guild.roles.cache.get(id);
            return role ? { label: role.name.substring(0, 100), value: id } : null;
        })
        .filter(Boolean);

    if (roleOptions.length === 0) {
        await replyUserError(selectInteraction, {
            type: ErrorTypes.USER_INPUT,
            message: tr.t('reactionroles.dashboard.rolesGone'),
        });
        return;
    }

    const removeSelect = new StringSelectMenuBuilder()
        .setCustomId('rr_remove_role_pick')
        .setPlaceholder(tr.t('reactionroles.dashboard.removePlaceholder'))
        .setMaxValues(1)
        .addOptions(
            roleOptions.map(r =>
                new StringSelectMenuOptionBuilder().setLabel(r.label).setValue(r.value),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('reactionroles.dashboard.removeTitle'))
                .setDescription(tr.t('reactionroles.dashboard.removeText'))
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(removeSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const removeCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'rr_remove_role_pick',
        time: 60_000,
        max: 1,
    });

    removeCollector.on('collect', async removeInteraction => {
        await removeInteraction.deferUpdate();
        const roleId = removeInteraction.values[0];
        const role = guild.roles.cache.get(roleId);

        let deletedPanel;
        try {
            const result = await removePanelRole(client, guildId, panelData.messageId, roleId, { lang: tr.lang });
            Object.assign(panelData, result.panel);
            deletedPanel = result.deletedPanel;
        } catch (error) {
            if (!(error instanceof TitanBotError) || !error.userMessage) throw error;
            await replyUserError(removeInteraction, { type: error.type, message: error.userMessage });
            return;
        }

        if (deletedPanel) {
            await removeInteraction.followUp({
                embeds: [
                    successEmbed(
                        tr.t('reactionroles.dashboard.removedTitle'),
                        tr.t('reactionroles.dashboard.removedLast'),
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });

            const panelIndex = panels.findIndex(p => p.messageId === panelData.messageId);
            if (panelIndex > -1) {
                panels.splice(panelIndex, 1);
            }

            if (panels.length === 0) {
                await InteractionHelper.safeEditReply(rootInteraction, {
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(tr.t('reactionroles.dashboard.title'))
                            .setDescription(tr.t('reactionroles.dashboard.noPanelsLeft'))
                            .setColor(getColor('info')),
                    ],
                    components: [],
                    flags: DASHBOARD_EPHEMERAL,
                });
            } else {
                
                await InteractionHelper.safeEditReply(rootInteraction, {
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(tr.t('reactionroles.dashboard.title'))
                            .setDescription(tr.t('reactionroles.dashboard.deletedOther'))
                            .setColor(getColor('success')),
                    ],
                    components: [],
                    flags: DASHBOARD_EPHEMERAL,
                });
            }
        } else {
            await removeInteraction.followUp({
                embeds: [
                    successEmbed(
                        tr.t('reactionroles.dashboard.removedTitle'),
                        tr.t('reactionroles.dashboard.removedText', { role: role ? role.toString() : `<@&${roleId}>` }),
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });

            const channel = guild.channels.cache.get(panelData.channelId);
            const discordMsg = channel
                ? await channel.messages.fetch(panelData.messageId).catch(() => null)
                : null;
            await showPanelDashboard(rootInteraction, panelData, discordMsg, guildId, guild, client);
        }
    });

    removeCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('reactionroles.dashboard.noRoleSelected'),
            }).catch(() => {});
        }
    });
}

async function handleDeletePanel(btnInteraction, rootInteraction, panelData, panels, guildId, guild, client) {
    const tr = textForInteraction(btnInteraction);
    const channel = guild.channels.cache.get(panelData.channelId);
    const discordMsg = channel
        ? await channel.messages.fetch(panelData.messageId).catch(() => null)
        : null;
    const title = discordMsg?.embeds?.[0]?.title ?? tr.t('reactionroles.dashboard.thisPanel');

    const deleteModal = new ModalBuilder()
        .setCustomId('rr_delete_confirm_modal')
        .setTitle(tr.t('reactionroles.dashboard.deleteModalTitle'));

    const deleteWarningText = new TextDisplayBuilder()
        .setContent(tr.t('reactionroles.dashboard.deleteWarning', { title }));

    const deleteCheckbox = new CheckboxBuilder()
        .setCustomId('delete_confirmation')
        .setDefault(false);

    const deleteCheckboxLabel = new LabelBuilder()
        .setLabel(tr.t('reactionroles.dashboard.deleteConfirm'))
        .setCheckboxComponent(deleteCheckbox);

    deleteModal
        .addTextDisplayComponents(deleteWarningText)
        .addLabelComponents(deleteCheckboxLabel);

    await btnInteraction.showModal(deleteModal);

    const submitted = await btnInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'rr_delete_confirm_modal' && i.user.id === btnInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) {
        await showPanelDashboard(rootInteraction, panelData, discordMsg, guildId, guild, client);
        return;
    }

    const confirmed = submitted.fields.getCheckbox('delete_confirmation');

    if (!confirmed) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('reactionroles.dashboard.deleteMustTick') });
        await showPanelDashboard(rootInteraction, panelData, discordMsg, guildId, guild, client);
        return;
    }

    await submitted.deferUpdate();

    const { deleted } = await deletePanel(client, guildId, panelData.messageId, {
        actorId: submitted.user.id,
        actorTag: submitted.user.tag,
    });
    // Data already gone (deleted elsewhere): still remove the message we found.
    if (!deleted && discordMsg) {
        await discordMsg.delete().catch(() => {});
    }

    await submitted.followUp({
        embeds: [successEmbed(tr.t('reactionroles.dashboard.deletedTitle'), tr.t('reactionroles.dashboard.deletedText', { title }))],
        flags: MessageFlags.Ephemeral,
    });

    const panelIndex = panels.findIndex(p => p.messageId === panelData.messageId);
    if (panelIndex > -1) {
        panels.splice(panelIndex, 1);
    }

    if (panels.length === 0) {
        await InteractionHelper.safeEditReply(rootInteraction, {
            embeds: [
                new EmbedBuilder()
                    .setTitle(tr.t('reactionroles.dashboard.title'))
                    .setDescription(tr.t('reactionroles.dashboard.noPanelsLeft'))
                    .setColor(getColor('info')),
            ],
            components: [],
            flags: DASHBOARD_EPHEMERAL,
        });
    } else {
        await InteractionHelper.safeEditReply(rootInteraction, {
            embeds: [
                new EmbedBuilder()
                    .setTitle(tr.t('reactionroles.dashboard.title'))
                    .setDescription(tr.t('reactionroles.dashboard.deletedOther'))
                    .setColor(getColor('success')),
            ],
            components: [],
            flags: DASHBOARD_EPHEMERAL,
        });
    }
}