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

function buildDashboardEmbed(cfg, guild) {
    const channel = cfg.levelUpChannel ? `<#${cfg.levelUpChannel}>` : '`Not set`';
    const xpMin = cfg.xpRange?.min ?? cfg.xpPerMessage?.min ?? 15;
    const xpMax = cfg.xpRange?.max ?? cfg.xpPerMessage?.max ?? 25;
    const cooldown = cfg.xpCooldown ?? 60;
    const rawMsg = cfg.levelUpMessage || '{user} is now level {level}.';
    const msgPreview = `\`${rawMsg.length > 60 ? rawMsg.substring(0, 60) + '…' : rawMsg}\``;

    const rewards = cfg.roleRewards ?? {};
    const rewardEntries = Object.entries(rewards).sort(([a], [b]) => Number(a) - Number(b));
    const rewardsValue = rewardEntries.length > 0
        ? rewardEntries.map(([lvl, roleId]) => `Level **${lvl}** → <@&${roleId}>`).join('\n')
        : '`None configured`';

    const ignoredChannels = cfg.ignoredChannels ?? [];
    const ignoredRoles = cfg.ignoredRoles ?? [];
    const ignoredChValue = ignoredChannels.length > 0 ? ignoredChannels.map(id => `<#${id}>`).join(',') : '`None`';
    const ignoredRoValue = ignoredRoles.length > 0 ? ignoredRoles.map(id => `<@&${id}>`).join(',') : '`None`';

    return new EmbedBuilder()
        .setTitle('Leveling')
        .setDescription(`Leveling settings for **${guild.name}**.\nPick a setting below to change it.`)
        .setColor(getColor('info'))
        .addFields(
            { name: 'Level-up channel', value: channel, inline: true },
            { name: 'Leveling', value: cfg.enabled ? '**On**' : '**Off**', inline: true },
            { name: 'Announcements', value: cfg.announceLevelUp !== false ? '**On**' : '**Off**', inline: true },
            { name: 'XP per message', value: `\`${xpMin} – ${xpMax}\``, inline: true },
            { name: 'XP cooldown', value: `\`${cooldown}s\``, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Level-up message', value: msgPreview, inline: false },
            { name: 'Role rewards', value: rewardsValue, inline: false },
            { name: 'Ignored channels', value: ignoredChValue, inline: true },
            { name: 'Ignored roles', value: ignoredRoValue, inline: true },
        )
        .setFooter({ text: 'Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();
}

function buildSelectMenu(guildId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`level_cfg_${guildId}`)
        .setPlaceholder('Pick a setting to change')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Level-up channel')
                .setDescription('Where level-up messages go')
                .setValue('channel'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Level-up message')
                .setDescription('What the bot says when someone levels up')
                .setValue('message'),
            new StringSelectMenuOptionBuilder()
                .setLabel('XP range')
                .setDescription('Least and most XP per message')
                .setValue('xp_range'),
            new StringSelectMenuOptionBuilder()
                .setLabel('XP cooldown')
                .setDescription('Seconds between XP grants for the same user')
                .setValue('xp_cooldown'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Add role reward')
                .setDescription('Give a role when someone reaches a level')
                .setValue('role_reward_add'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Remove role reward')
                .setDescription('Remove the role reward from a level')
                .setValue('role_reward_remove'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Ignored channels')
                .setDescription('Channels where nobody gets XP')
                .setValue('ignore_channels'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Ignored roles')
                .setDescription('Roles that don\'t get XP')
                .setValue('ignore_roles'),
        );
}

function buildButtonRow(cfg, guildId, disabled = false) {
    const announceOn = cfg.announceLevelUp !== false;
    const systemOn = cfg.enabled !== false;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`level_cfg_toggle_announce_${guildId}`)
            .setLabel('Announcements')
            .setStyle(announceOn ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`level_cfg_toggle_system_${guildId}`)
            .setLabel('Leveling')
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
    const selectMenu = buildSelectMenu(guildId);
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [buildDashboardEmbed(cfg, rootInteraction.guild)],
        components: [
            buildButtonRow(cfg, guildId),
            new ActionRowBuilder().addComponents(selectMenu),
        ],
    }).catch(() => {});
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        try {
            const guildId = interaction.guild.id;
            const cfg = await getLevelingConfig(client, guildId);

            if (!cfg.configured) {
                throw new TitanBotError(
                    'Leveling isn\'t set up',
                    ErrorTypes.CONFIGURATION,
                    'Run `/level setup` first.',
                );
            }

            await startDashboardSession({
                interaction,
                embeds: [buildDashboardEmbed(cfg, interaction.guild)],
                components: [
                    buildButtonRow(cfg, guildId),
                    new ActionRowBuilder().addComponents(buildSelectMenu(guildId)),
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
                                    'Announcements updated',
                                    `Level-up announcements are now **${cfg.announceLevelUp ? 'on' : 'off'}**.`,
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
                                    'Leveling updated',
                                    `Leveling is now **${cfg.enabled ? 'on' : 'off'}**.${!cfg.enabled ? '\nNobody earns XP until you turn it back on.' : ''}`,
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
                'Couldn\'t open the leveling settings.',
            );
        }
    },
};

async function handleRoleRewardAdd(selectInteraction, rootInteraction, cfg, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_role_reward_add_${guildId}`)
        .setTitle('Add role reward');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('reward_role')
        .setPlaceholder('Pick a role')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Role')
        .setDescription('Given when someone reaches the level')
        .setRoleSelectMenuComponent(roleSelect);

    const levelInput = new TextInputBuilder()
        .setCustomId('reward_level')
        .setLabel('Level required (1–500)')
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
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'Level must be a whole number between **1** and **500**.' });
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
        embeds: [successEmbed('Role reward added', `Members get <@&${roleId}> at level **${level}**.`)],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleRoleRewardRemove(selectInteraction, rootInteraction, cfg, guildId, client) {
    const rewards = cfg.roleRewards ?? {};
    const entries = Object.entries(rewards).sort(([a], [b]) => Number(a) - Number(b));

    if (entries.length === 0) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.USER_INPUT,
            message: 'There are no role rewards to remove.',
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_role_reward_remove_${guildId}`)
        .setTitle('Remove role reward');

    const infoInput = new TextInputBuilder()
        .setCustomId('current_rewards')
        .setLabel('Current rewards (read-only)')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(entries.map(([lvl, roleId]) => `Level ${lvl}: <@&${roleId}>`).join('\n'))
        .setRequired(false);

    const levelInput = new TextInputBuilder()
        .setCustomId('remove_level')
        .setLabel('Level')
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
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: `There's no role reward for level **${rawLevel}**.` });
        return;
    }

    delete cfg.roleRewards[level];
    const { after: afterRemove } = await setLevelRoleReward(client, guildId, level, null);
    Object.assign(cfg, afterRemove);

    await submitted.reply({
        embeds: [successEmbed('Role reward removed', `Removed the role reward for level **${level}**.`)],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleChannel(selectInteraction, rootInteraction, cfg, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_channel_modal_${guildId}`)
        .setTitle('Level-up channel');

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('levelup_channel')
        .setPlaceholder('Pick a text channel')
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true);

    const channelLabel = new LabelBuilder()
        .setLabel('Level-up channel')
        .setDescription('Where level-up messages go')
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
        await replyUserError(submitted, { type: ErrorTypes.PERMISSION, message: `I need **SendMessages** and **EmbedLinks** in ${channel} to post level-ups there.` });
        return;
    }

    cfg.levelUpChannel = channelId;
    await saveLevelingPatch(client, guildId, cfg, { levelUpChannel: channelId });

    await submitted.reply({
        embeds: [successEmbed('Channel updated', `Level-up messages now go to ${channel ??`<#${channelId}>`}.`)],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleIgnoreChannels(selectInteraction, rootInteraction, cfg, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_ignore_channels_${guildId}`)
        .setTitle('Ignored channels');

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ignore_channel')
        .setPlaceholder('Pick channels')
        .setMinValues(1)
        .setMaxValues(10)
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true);

    const channelLabel = new LabelBuilder()
        .setLabel('Ignored channels')
        .setDescription('Picked channels switch between ignored and not ignored')
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
        : '`None`';

    await submitted.reply({
        embeds: [successEmbed('Ignored channels updated', `No XP in: ${list}`)],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleIgnoreRoles(selectInteraction, rootInteraction, cfg, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId(`level_cfg_ignore_roles_${guildId}`)
        .setTitle('Ignored roles');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('ignore_role')
        .setPlaceholder('Pick roles')
        .setMinValues(1)
        .setMaxValues(10)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Ignored roles')
        .setDescription('Picked roles switch between ignored and not ignored')
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
        : '`None`';

    await submitted.reply({
        embeds: [successEmbed('Ignored roles updated', `No XP for: ${list}`)],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleMessage(selectInteraction, rootInteraction, cfg, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId('level_cfg_message')
        .setTitle('Level-up message')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('message_input')
                    .setLabel('Message ({user} and {level} are available)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(cfg.levelUpMessage || '{user} is now level {level}.')
                    .setMaxLength(500)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('{user} is now level {level}.'),
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

    const newMessage = submitted.fields.getTextInputValue('message_input').trim();

    if (!newMessage.includes('{user}') && !newMessage.includes('{level}')) {
        logger.warn(
            `Level-up message set without {user} or {level} placeholders in guild ${guildId}`,
        );
    }

    cfg.levelUpMessage = newMessage;
    await saveLevelingPatch(client, guildId, cfg, { levelUpMessage: newMessage });

    const preview = newMessage.replace('{user}', '@User').replace('{level}', '5');

    await submitted.reply({
        embeds: [
            successEmbed(
                'Message saved',
                `Level-up message saved.\n**Preview:** ${preview}`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleXpRange(selectInteraction, rootInteraction, cfg, guildId, client) {
    const currentMin = cfg.xpRange?.min ?? cfg.xpPerMessage?.min ?? 15;
    const currentMax = cfg.xpRange?.max ?? cfg.xpPerMessage?.max ?? 25;

    const modal = new ModalBuilder()
        .setCustomId('level_cfg_xp_range')
        .setTitle('XP per message')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('xp_min_input')
                    .setLabel('Minimum XP (1–500)')
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
                    .setLabel('Maximum XP (1–500)')
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
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'Both XP values must be whole numbers between **1** and **500**.' });
        return;
    }

    if (newMin > newMax) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'The minimum can\'t be higher than the maximum.' });
        return;
    }

    cfg.xpRange = { min: newMin, max: newMax };
    await saveLevelingPatch(client, guildId, cfg, { xpRange: cfg.xpRange });

    await submitted.reply({
        embeds: [
            successEmbed(
                'XP range updated',
                `Members now get between **${newMin}** and **${newMax}** XP per message.`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}

async function handleXpCooldown(selectInteraction, rootInteraction, cfg, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId('level_cfg_cooldown')
        .setTitle('XP cooldown')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('cooldown_input')
                    .setLabel('Cooldown in seconds (0–3600)')
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
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'Cooldown must be a whole number between **0** and **3600** seconds.' });
        return;
    }

    cfg.xpCooldown = newCooldown;
    await saveLevelingPatch(client, guildId, cfg, { xpCooldown: newCooldown });

    await submitted.reply({
        embeds: [
            successEmbed(
                'Cooldown updated',
                `XP cooldown set to **${newCooldown} second${newCooldown !== 1 ? 's' : ''}**.${newCooldown === 0 ? '\n> A cooldown of 0 means every message gives XP.' : ''}`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, guildId);
}