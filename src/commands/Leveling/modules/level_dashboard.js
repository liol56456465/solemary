import { getColor } from '../../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    LabelBuilder,
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
import { getLevelingConfig, updateLevelingConfig, setLevelRoleReward } from '../../../services/leveling/leveling.js';
import { botHasPermission } from '../../../utils/permissionGuard.js';
import { getRoleAssignmentProblem } from '../../../utils/roleSafety.js';
import { startDashboardSession } from '../../../utils/dashboardSession.js';
import { botText, textForInteraction } from '../../../utils/botText.js';
import { DEFAULT_LEVEL_UP_MESSAGE, levelUpTemplate } from '../../../services/leveling/xpSystem.js';

// The whole dashboard is ephemeral: every text is in the user's own language (tr).

function buildDashboardEmbed(cfg, guild, tr = botText('en')) {
    const channel = cfg.levelUpChannel ? `<#${cfg.levelUpChannel}>` : tr.t('leveling.dash.notSet');
    const xpMin = cfg.xpRange?.min ?? cfg.xpPerMessage?.min ?? 15;
    const xpMax = cfg.xpRange?.max ?? cfg.xpPerMessage?.max ?? 25;
    const cooldown = cfg.xpCooldown ?? 60;
    const rawMsg = levelUpTemplate(cfg.levelUpMessage, tr.lang);
    const msgPreview = `\`${rawMsg.length > 60 ? rawMsg.substring(0, 60) + '…' : rawMsg}\``;

    const rewards = cfg.roleRewards ?? {};
    const rewardEntries = Object.entries(rewards).sort(([a], [b]) => Number(a) - Number(b));
    const rewardsValue = rewardEntries.length > 0
        ? rewardEntries.map(([lvl, roleId]) => tr.t('leveling.dash.rewardLine', { level: lvl, roleId })).join('\n')
        : tr.t('leveling.dash.noneConfigured');

    const ignoredChannels = cfg.ignoredChannels ?? [];
    const ignoredRoles = cfg.ignoredRoles ?? [];
    const ignoredChValue = ignoredChannels.length > 0 ? ignoredChannels.map(id => `<#${id}>`).join(',') : tr.t('leveling.dash.none');
    const ignoredRoValue = ignoredRoles.length > 0 ? ignoredRoles.map(id => `<@&${id}>`).join(',') : tr.t('leveling.dash.none');
    const onOff = (on) => (on ? tr.t('leveling.dash.on') : tr.t('leveling.dash.off'));

    return new EmbedBuilder()
        .setTitle(tr.t('leveling.dash.title'))
        .setDescription(tr.t('leveling.dash.description', { server: guild.name }))
        .setColor(getColor('info'))
        .addFields(
            { name: tr.t('leveling.dash.fieldChannel'), value: channel, inline: true },
            { name: tr.t('leveling.dash.fieldLeveling'), value: onOff(cfg.enabled), inline: true },
            { name: tr.t('leveling.dash.fieldAnnouncements'), value: onOff(cfg.announceLevelUp !== false), inline: true },
            { name: tr.t('leveling.dash.fieldXp'), value: `\`${xpMin} – ${xpMax}\``, inline: true },
            { name: tr.t('leveling.dash.fieldCooldown'), value: tr.t('leveling.dash.cooldownValue', { seconds: cooldown }), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: tr.t('leveling.dash.fieldMessage'), value: msgPreview, inline: false },
            { name: tr.t('leveling.dash.fieldRewards'), value: rewardsValue, inline: false },
            { name: tr.t('leveling.dash.fieldIgnoredChannels'), value: ignoredChValue, inline: true },
            { name: tr.t('leveling.dash.fieldIgnoredRoles'), value: ignoredRoValue, inline: true },
        )
        .setFooter({ text: tr.t('leveling.dash.footer') })
        .setTimestamp();
}

function buildSelectMenu(guildId, tr = botText('en')) {
    return new StringSelectMenuBuilder()
        .setCustomId(`level_cfg_${guildId}`)
        .setPlaceholder(tr.t('leveling.dash.placeholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('leveling.dash.optChannel'))
                .setDescription(tr.t('leveling.dash.optChannelHelp'))
                .setValue('channel'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('leveling.dash.optMessage'))
                .setDescription(tr.t('leveling.dash.optMessageHelp'))
                .setValue('message'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('leveling.dash.optXpRange'))
                .setDescription(tr.t('leveling.dash.optXpRangeHelp'))
                .setValue('xp_range'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('leveling.dash.optCooldown'))
                .setDescription(tr.t('leveling.dash.optCooldownHelp'))
                .setValue('xp_cooldown'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('leveling.dash.optRewardAdd'))
                .setDescription(tr.t('leveling.dash.optRewardAddHelp'))
                .setValue('role_reward_add'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('leveling.dash.optRewardRemove'))
                .setDescription(tr.t('leveling.dash.optRewardRemoveHelp'))
                .setValue('role_reward_remove'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('leveling.dash.optIgnoredChannels'))
                .setDescription(tr.t('leveling.dash.optIgnoredChannelsHelp'))
                .setValue('ignore_channels'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('leveling.dash.optIgnoredRoles'))
                .setDescription(tr.t('leveling.dash.optIgnoredRolesHelp'))
                .setValue('ignore_roles'),
        );
}

function buildButtonRow(cfg, guildId, disabled = false, tr = botText('en')) {
    const announceOn = cfg.announceLevelUp !== false;
    const systemOn = cfg.enabled !== false;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`level_cfg_toggle_announce_${guildId}`)
            .setLabel(tr.t('leveling.dash.buttonAnnouncements'))
            .setStyle(announceOn ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`level_cfg_toggle_system_${guildId}`)
            .setLabel(tr.t('leveling.dash.buttonLeveling'))
            .setStyle(systemOn ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

// Saves only the changed fields (atomic), then syncs the local copy with what is
// stored so the dashboard also shows changes made elsewhere meanwhile.
async function saveLevelingPatch(client, guildId, cfg, patch) {
    const { after } = await updateLevelingConfig(client, guildId, patch);
    Object.assign(cfg, after);
}

async function refreshDashboard(rootInteraction, cfg, guildId) {
    const tr = textForInteraction(rootInteraction);
    const selectMenu = buildSelectMenu(guildId, tr);
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [buildDashboardEmbed(cfg, rootInteraction.guild, tr)],
        components: [
            buildButtonRow(cfg, guildId, false, tr),
            new ActionRowBuilder().addComponents(selectMenu),
        ],
    }).catch(() => {});
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        try {
            const guildId = interaction.guild.id;
            const cfg = await getLevelingConfig(client, guildId);

            if (!cfg.configured) {
                throw new TitanBotError(
                    'Leveling isn\'t set up',
                    ErrorTypes.CONFIGURATION,
                    tr.t('leveling.dash.notSetUp'),
                );
            }

            await startDashboardSession({
                interaction,
                embeds: [buildDashboardEmbed(cfg, interaction.guild, tr)],
                components: [
                    buildButtonRow(cfg, guildId, false, tr),
                    new ActionRowBuilder().addComponents(buildSelectMenu(guildId, tr)),
                ],
                selectMenuId: `level_cfg_${guildId}`,
                buttonMatcher: (customId) =>
                    customId === `level_cfg_toggle_announce_${guildId}` ||
                    customId === `level_cfg_toggle_system_${guildId}`,
                onSelect: async (selectInteraction) => {
                    const selectedOption = selectInteraction.values[0];
                    switch (selectedOption) {
                        case 'channel':
                            await handleChannel(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'message':
                            await handleMessage(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'xp_range':
                            await handleXpRange(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'xp_cooldown':
                            await handleXpCooldown(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'role_reward_add':
                            await handleRoleRewardAdd(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'role_reward_remove':
                            await handleRoleRewardRemove(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'ignore_channels':
                            await handleIgnoreChannels(selectInteraction, interaction, cfg, guildId, client);
                            break;
                        case 'ignore_roles':
                            await handleIgnoreRoles(selectInteraction, interaction, cfg, guildId, client);
                            break;
                    }
                },
                onButton: async (btnInteraction) => {
                    await btnInteraction.deferUpdate().catch(() => null);
                    const isAnnounce = btnInteraction.customId === `level_cfg_toggle_announce_${guildId}`;

                    if (isAnnounce) {
                        cfg.announceLevelUp = cfg.announceLevelUp === false;
                        await saveLevelingPatch(client, guildId, cfg, { announceLevelUp: cfg.announceLevelUp });
                        await btnInteraction.followUp({
                            embeds: [
                                successEmbed(
                                    tr.t('leveling.dash.announceTitle'),
                                    cfg.announceLevelUp ? tr.t('leveling.dash.announceOn') : tr.t('leveling.dash.announceOff'),
                                ),
                            ],
                            flags: MessageFlags.Ephemeral,
                        });
                    } else {
                        const wasEnabled = cfg.enabled !== false;
                        cfg.enabled = !wasEnabled;
                        await saveLevelingPatch(client, guildId, cfg, { enabled: cfg.enabled });
                        await btnInteraction.followUp({
                            embeds: [
                                successEmbed(
                                    tr.t('leveling.dash.levelingTitle'),
                                    cfg.enabled ? tr.t('leveling.dash.levelingOn') : tr.t('leveling.dash.levelingOff'),
                                ),
                            ],
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    await refreshDashboard(interaction, cfg, guildId);
                },
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in level_dashboard:', error);
            throw new TitanBotError(
                `Level dashboard failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                tr.t('leveling.dash.openFailed'),
            );
        }
    },
};

async function handleRoleRewardAdd(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_role_reward_add_${guildId}`)
        .setTitle(tr.t('leveling.dash.rewardAddTitle'));

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('reward_role')
        .setPlaceholder(tr.t('leveling.dash.pickRole'))
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel(tr.t('leveling.dash.roleLabel'))
        .setDescription(tr.t('leveling.dash.roleHelp'))
        .setRoleSelectMenuComponent(roleSelect);

    const levelInput = new TextInputBuilder()
        .setCustomId('reward_level')
        .setLabel(tr.t('leveling.dash.levelRequired'))
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('10')
        .setMaxLength(3)
        .setMinLength(1)
        .setRequired(true);

    modal.addLabelComponents(roleLabel);
    modal.addComponents(new ActionRowBuilder().addComponents(levelInput));

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === `level_cfg_role_reward_add_${guildId}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const rawLevel = submitted.fields.getTextInputValue('reward_level').trim();
    const level = parseInt(rawLevel, 10);

    if (isNaN(level) || level < 1 || level > 500) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('leveling.dash.levelRange') });
        return;
    }

    const roleId = submitted.fields.getField('reward_role').values[0];

    // Anyone who chats enough gets this role, so it must be harmless and assignable.
    const guild = rootInteraction.guild;
    const roleProblem = getRoleAssignmentProblem(guild.roles.cache.get(roleId), guild.members.me);
    if (roleProblem) {
        await replyUserError(submitted, { type: ErrorTypes.PERMISSION, message: roleProblem });
        return;
    }

    cfg.roleRewards = cfg.roleRewards ?? {};
    cfg.roleRewards[level] = roleId;
    const { after: afterAdd } = await setLevelRoleReward(client, guildId, level, roleId);
    Object.assign(cfg, afterAdd);

    await submitted.reply({
        embeds: [successEmbed(tr.t('leveling.dash.rewardAdded'), tr.t('leveling.dash.rewardAddedText', { roleId, level }))],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleRoleRewardRemove(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const rewards = cfg.roleRewards ?? {};
    const entries = Object.entries(rewards).sort(([a], [b]) => Number(a) - Number(b));

    if (entries.length === 0) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.USER_INPUT,
            message: tr.t('leveling.dash.noRewards'),
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_role_reward_remove_${guildId}`)
        .setTitle(tr.t('leveling.dash.rewardRemoveTitle'));

    const infoInput = new TextInputBuilder()
        .setCustomId('current_rewards')
        .setLabel(tr.t('leveling.dash.currentRewards'))
        .setStyle(TextInputStyle.Paragraph)
        .setValue(entries.map(([lvl, roleId]) => tr.t('leveling.dash.currentRewardLine', { level: lvl, roleId })).join('\n'))
        .setRequired(false);

    const levelInput = new TextInputBuilder()
        .setCustomId('remove_level')
        .setLabel(tr.t('leveling.dash.levelLabel'))
        .setStyle(TextInputStyle.Short)
        .setValue(entries[0][0])
        .setMaxLength(3)
        .setMinLength(1)
        .setRequired(true);

    modal.addComponents(
        new ActionRowBuilder().addComponents(infoInput),
        new ActionRowBuilder().addComponents(levelInput),
    );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === `level_cfg_role_reward_remove_${guildId}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const rawLevel = submitted.fields.getTextInputValue('remove_level').trim();
    const level = parseInt(rawLevel, 10);

    if (isNaN(level) || !cfg.roleRewards?.[level]) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: tr.t('leveling.dash.noRewardFor', { level: rawLevel }) });
        return;
    }

    delete cfg.roleRewards[level];
    const { after: afterRemove } = await setLevelRoleReward(client, guildId, level, null);
    Object.assign(cfg, afterRemove);

    await submitted.reply({
        embeds: [successEmbed(tr.t('leveling.dash.rewardRemoved'), tr.t('leveling.dash.rewardRemovedText', { level }))],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleChannel(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_channel_modal_${guildId}`)
        .setTitle(tr.t('leveling.dash.channelTitle'));

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('levelup_channel')
        .setPlaceholder(tr.t('leveling.dash.pickTextChannel'))
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true);

    const channelLabel = new LabelBuilder()
        .setLabel(tr.t('leveling.dash.optChannel'))
        .setDescription(tr.t('leveling.dash.optChannelHelp'))
        .setChannelSelectMenuComponent(channelSelect);

    modal.addLabelComponents(channelLabel);

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === `level_cfg_channel_modal_${guildId}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const channelId = submitted.fields.getField('levelup_channel').values[0];
    const channel = selectInteraction.guild.channels.cache.get(channelId);

    if (channel && !botHasPermission(channel, ['SendMessages', 'EmbedLinks'])) {
        await replyUserError(submitted, { type: ErrorTypes.PERMISSION, message: tr.t('leveling.dash.channelBotPermissions', { channel: String(channel) }) });
        return;
    }

    cfg.levelUpChannel = channelId;
    await saveLevelingPatch(client, guildId, cfg, { levelUpChannel: channelId });

    await submitted.reply({
        embeds: [successEmbed(tr.t('leveling.dash.channelUpdated'), tr.t('leveling.dash.channelUpdatedText', { channel: String(channel ?? `<#${channelId}>`) }))],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleIgnoreChannels(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_ignore_channels_${guildId}`)
        .setTitle(tr.t('leveling.dash.ignoredChannelsTitle'));

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ignore_channel')
        .setPlaceholder(tr.t('leveling.dash.pickChannels'))
        .setMinValues(1)
        .setMaxValues(10)
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true);

    const channelLabel = new LabelBuilder()
        .setLabel(tr.t('leveling.dash.ignoredChannelsTitle'))
        .setDescription(tr.t('leveling.dash.ignoredChannelsHelp'))
        .setChannelSelectMenuComponent(channelSelect);

    modal.addLabelComponents(channelLabel);

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === `level_cfg_ignore_channels_${guildId}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const selectedIds = submitted.fields.getField('ignore_channel').values;
    const ignoreSet = new Set(cfg.ignoredChannels ?? []);

    for (const id of selectedIds) {
        if (ignoreSet.has(id)) {
            ignoreSet.delete(id);
        } else {
            ignoreSet.add(id);
        }
    }

    cfg.ignoredChannels = Array.from(ignoreSet);
    await saveLevelingPatch(client, guildId, cfg, { ignoredChannels: cfg.ignoredChannels });

    const list = cfg.ignoredChannels.length > 0
        ? cfg.ignoredChannels.map(id => `<#${id}>`).join(',')
        : tr.t('leveling.dash.none');

    await submitted.reply({
        embeds: [successEmbed(tr.t('leveling.dash.ignoredChannelsUpdated'), tr.t('leveling.dash.ignoredChannelsText', { list }))],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleIgnoreRoles(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_ignore_roles_${guildId}`)
        .setTitle(tr.t('leveling.dash.ignoredRolesTitle'));

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('ignore_role')
        .setPlaceholder(tr.t('leveling.dash.pickRoles'))
        .setMinValues(1)
        .setMaxValues(10)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel(tr.t('leveling.dash.ignoredRolesTitle'))
        .setDescription(tr.t('leveling.dash.ignoredRolesHelp'))
        .setRoleSelectMenuComponent(roleSelect);

    modal.addLabelComponents(roleLabel);

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === `level_cfg_ignore_roles_${guildId}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const selectedIds = submitted.fields.getField('ignore_role').values;
    const ignoreSet = new Set(cfg.ignoredRoles ?? []);

    for (const id of selectedIds) {
        if (ignoreSet.has(id)) {
            ignoreSet.delete(id);
        } else {
            ignoreSet.add(id);
        }
    }

    cfg.ignoredRoles = Array.from(ignoreSet);
    await saveLevelingPatch(client, guildId, cfg, { ignoredRoles: cfg.ignoredRoles });

    const list = cfg.ignoredRoles.length > 0
        ? cfg.ignoredRoles.map(id => `<@&${id}>`).join(',')
        : tr.t('leveling.dash.none');

    await submitted.reply({
        embeds: [successEmbed(tr.t('leveling.dash.ignoredRolesUpdated'), tr.t('leveling.dash.ignoredRolesText', { list }))],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleMessage(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    // The bot's default shows in the admin's language; saving it unchanged keeps the default
    // (stored in English, posted in the server's language).
    const defaultText = levelUpTemplate(null, tr.lang);
    const modal = new ModalBuilder()
        .setCustomId('level_cfg_message')
        .setTitle(tr.t('leveling.dash.messageTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('message_input')
                    .setLabel(tr.t('leveling.dash.messageLabel', { user: '{user}', level: '{level}' }))
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(levelUpTemplate(cfg.levelUpMessage, tr.lang))
                    .setMaxLength(500)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder(defaultText),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'level_cfg_message' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const typed = submitted.fields.getTextInputValue('message_input').trim();
    const newMessage = typed === defaultText ? DEFAULT_LEVEL_UP_MESSAGE : typed;

    if (!newMessage.includes('{user}') && !newMessage.includes('{level}')) {
        logger.warn(
            `Level-up message set without {user} or {level} placeholders in guild ${guildId}`,
        );
    }

    cfg.levelUpMessage = newMessage;
    await saveLevelingPatch(client, guildId, cfg, { levelUpMessage: newMessage });

    const preview = levelUpTemplate(newMessage, tr.lang).replace('{user}', tr.t('leveling.dash.previewUser')).replace('{level}', '5');

    await submitted.reply({
        embeds: [
            successEmbed(
                tr.t('leveling.dash.messageSaved'),
                tr.t('leveling.dash.messageSavedText', { preview }),
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleXpRange(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const currentMin = cfg.xpRange?.min ?? cfg.xpPerMessage?.min ?? 15;
    const currentMax = cfg.xpRange?.max ?? cfg.xpPerMessage?.max ?? 25;

    const modal = new ModalBuilder()
        .setCustomId('level_cfg_xp_range')
        .setTitle(tr.t('leveling.dash.xpTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('xp_min_input')
                    .setLabel(tr.t('leveling.dash.xpMin'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(currentMin))
                    .setMaxLength(3)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('15'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('xp_max_input')
                    .setLabel(tr.t('leveling.dash.xpMax'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(currentMax))
                    .setMaxLength(3)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('25'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'level_cfg_xp_range' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const rawMin = submitted.fields.getTextInputValue('xp_min_input').trim();
    const rawMax = submitted.fields.getTextInputValue('xp_max_input').trim();
    const newMin = parseInt(rawMin, 10);
    const newMax = parseInt(rawMax, 10);

    if (isNaN(newMin) || isNaN(newMax) || newMin < 1 || newMax < 1 || newMin > 500 || newMax > 500) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('leveling.dash.xpRange') });
        return;
    }

    if (newMin > newMax) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('leveling.dash.xpMinAboveMax') });
        return;
    }

    cfg.xpRange = { min: newMin, max: newMax };
    await saveLevelingPatch(client, guildId, cfg, { xpRange: cfg.xpRange });

    await submitted.reply({
        embeds: [
            successEmbed(
                tr.t('leveling.dash.xpUpdated'),
                tr.t('leveling.dash.xpUpdatedText', { min: newMin, max: newMax }),
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleXpCooldown(selectInteraction, rootInteraction, cfg, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('level_cfg_cooldown')
        .setTitle(tr.t('leveling.dash.cooldownTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('cooldown_input')
                    .setLabel(tr.t('leveling.dash.cooldownLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(cfg.xpCooldown ?? 60))
                    .setMaxLength(4)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('60'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'level_cfg_cooldown' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const raw = submitted.fields.getTextInputValue('cooldown_input').trim();
    const newCooldown = parseInt(raw, 10);

    if (isNaN(newCooldown) || newCooldown < 0 || newCooldown > 3600) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('leveling.dash.cooldownRange') });
        return;
    }

    cfg.xpCooldown = newCooldown;
    await saveLevelingPatch(client, guildId, cfg, { xpCooldown: newCooldown });

    await submitted.reply({
        embeds: [
            successEmbed(
                tr.t('leveling.dash.cooldownUpdated'),
                `${tr.tp('leveling.dash.cooldownSet', newCooldown)}${newCooldown === 0 ? tr.t('leveling.dash.cooldownZero') : ''}`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}