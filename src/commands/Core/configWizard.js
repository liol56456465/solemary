import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    LabelBuilder,
    ChannelType,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed, buildUserErrorEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildConfig, setConfigValue } from '../../services/config/guildConfig.js';
import ConfigService from '../../services/config/configService.js';
import { logger } from '../../utils/logger.js';
import { botConfig, getCommandPrefix } from '../../config/bot.js';
import { hasOwnerPower } from '../../utils/ownerPower.js';
import { hasAdministrator } from '../../utils/commandGate.js';
import { randomBytes } from 'node:crypto';

const DASHBOARD_CUSTOM_ID = 'config_select';
const WIZARD_BUTTON_ID = 'config_wizard';
const activeWizardSessions = new Set();

const DM_DISABLED_HELP = [
    '1. Right-click this server\'s name (mobile: tap the server name at the top).',
    '2. Open **Privacy Settings**.',
    '3. Turn on **Allow direct messages from server members**.',
    '4. Click **Start setup** again.',
].join('\n');

async function notifyWizardStarted(buttonInteraction) {
    await buttonInteraction.followUp({
        embeds: [infoEmbed(
            'Setup started',
            'Check your DMs, the first question is there. Press **Skip** under a question to keep its current value.',
        )],
        flags: MessageFlags.Ephemeral,
    }).catch(() => {});
}

async function notifyWizardDmBlocked(buttonInteraction) {
    await replyUserError(buttonInteraction, {
        type: ErrorTypes.USER_INPUT,
        message: `I couldn't send you a DM. Enable DMs from this server, then try again.\n\n${DM_DISABLED_HELP}`,
    }).catch(() => {});
}

function formatChannelMention(guild, channelId) {
    if (!channelId) {
        return '`Not set`';
    }
    const channel = guild.channels.cache.get(channelId);
    return channel ? `<#${channelId}>` : `#${channelId}`;
}

function formatRoleMention(guild, roleId) {
    if (!roleId) {
        return '`Not set`';
    }
    const role = guild.roles.cache.get(roleId);
    return role ? `<@&${roleId}>` : `@${roleId}`;
}

function getBotPresenceText() {
    const activity = botConfig.presence?.activities?.[0];
    if (!activity?.name) {
        return '`Not configured`';
    }

    const typeLabels = ['Playing', 'Streaming', 'Listening to', 'Watching', '', 'Competing in'];
    const typeLabel = typeLabels[activity.type];
    if (!typeLabel) {
        return activity.name;
    }

    return `${typeLabel} **${activity.name}**`;
}

function getThemeColorLines() {
    const colors = botConfig.embeds.colors;
    return [
        `Primary \`${colors.primary}\` · Success \`${colors.success}\``,
        `Warning \`${colors.warning}\` · Error \`${colors.error}\``,
    ].join('\n');
}

function buildDashboardEmbed(config, guild) {
    const setupDone = config.setupWizardCompleted;

    return createEmbed({
        title: 'Server settings',
        description: `Basic settings for **${guild.name}**. Pick one below to change it, or run the setup wizard.`,
        color: 'info',
        fields: [
            {
                name: 'Prefix',
                value: `\`${config.prefix || getCommandPrefix()}\``,
                inline: true,
            },
            {
                name: 'Moderator role',
                value: formatRoleMention(guild, config.modRole),
                inline: true,
            },
            {
                name: 'Log channel',
                value: formatChannelMention(guild, config.logging?.channels?.audit),
                inline: true,
            },
            {
                name: 'Bot status',
                value: getBotPresenceText(),
                inline: false,
            },
            {
                name: 'Embed colours',
                value: `${getThemeColorLines()}\n-# Set in the bot config, same for every server.`,
                inline: false,
            },
            {
                name: 'Command access',
                value: 'Use `/commands dashboard` to turn commands on or off.',
                inline: false,
            },
            {
                name: 'Setup',
                value: setupDone
                    ? 'Done. You can run the wizard again any time.'
                    : 'Not done yet. The wizard asks a few questions in DM.',
                inline: false,
            },
        ],
        footer: 'Closes after 10 minutes without use',
    });
}

function buildSettingsSelect(guildId) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASHBOARD_CUSTOM_ID}:${guildId}`)
            .setPlaceholder('Pick a setting to change')
            .addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel('Prefix')
                    .setDescription('The prefix for text commands')
                    .setValue('prefix'),
                new StringSelectMenuOptionBuilder()
                    .setLabel('Moderator role')
                    .setDescription('Role used for moderation commands')
                    .setValue('modRole'),
                new StringSelectMenuOptionBuilder()
                    .setLabel('Log channel')
                    .setDescription('Where the bot posts its logs')
                    .setValue('logChannelId'),
            ),
    );
}

function buildButtonRow(config, guildId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${WIZARD_BUTTON_ID}:${guildId}`)
            .setLabel(config.setupWizardCompleted ? 'Run setup again' : 'Start setup')
            .setStyle(config.setupWizardCompleted ? ButtonStyle.Secondary : ButtonStyle.Success),
    );
}

function extractId(value) {
    if (!value || typeof value !== 'string') return null;

    const channelMention = value.match(/<#!?(\d{17,19})>/);
    if (channelMention) return channelMention[1];

    const roleMention = value.match(/<@&(\d{17,19})>/);
    if (roleMention) return roleMention[1];

    const digits = value.match(/^(\d{17,19})$/);
    if (digits) return digits[1];

    return null;
}

// The DM questions: a typed answer, or the Skip / Stop setup buttons under the question
// (`config_wizard_step:<skip|cancel>:<nonce>`; collector-managed, see utils/collectorComponents.js).
export const STEP_BUTTON_PREFIX = 'config_wizard_step';
export const QUESTION_TIMEOUT_MS = 180_000;
const NO_PINGS = { parse: [] };

/** The Skip / Stop setup buttons of one question. */
export function stepButtons(nonce, { disabled = false } = {}) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${STEP_BUTTON_PREFIX}:skip:${nonce}`).setLabel('Skip (keep current)').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`${STEP_BUTTON_PREFIX}:cancel:${nonce}`).setLabel('Stop setup').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    );
}

/**
 * Waits for the first of: a DM from the user ({ text }), a press on this question's buttons
 * ({ button: 'skip' | 'cancel' }, acknowledged at once), or the timeout (null).
 */
export function waitForAnswer({ dmChannel, message, userId, nonce, timeMs = QUESTION_TIMEOUT_MS }) {
    return new Promise((resolve) => {
        let done = false;
        const collectors = [];
        const finish = (value) => {
            if (done) return;
            done = true;
            for (const collector of collectors) collector.stop('answered');
            resolve(value);
        };
        const texts = dmChannel.createMessageCollector({
            filter: (m) => m.author?.id === userId && !m.author?.bot, max: 1, time: timeMs,
        });
        collectors.push(texts);
        texts.on('collect', (m) => finish({ text: String(m.content || '').trim() }));
        texts.on('end', (collected, reason) => { if (reason === 'time') finish(null); });
        if (typeof message?.createMessageComponentCollector === 'function') {
            const buttons = message.createMessageComponentCollector({
                filter: (i) => i.user?.id === userId && typeof i.customId === 'string' && i.customId.startsWith(`${STEP_BUTTON_PREFIX}:`) && i.customId.endsWith(`:${nonce}`),
                max: 1, time: timeMs,
            });
            collectors.push(buttons);
            buttons.on('collect', async (i) => {
                const choice = i.customId.split(':')[1];
                finish({ button: choice === 'cancel' ? 'cancel' : 'skip' });
                await i.deferUpdate().catch(() => {});
            });
            buttons.on('end', (collected, reason) => { if (reason === 'time') finish(null); });
        }
    });
}

export async function askQuestion(dmChannel, userId, prompt, stepNumber, totalSteps, { nonce = randomBytes(4).toString('hex'), timeMs = QUESTION_TIMEOUT_MS } = {}) {
    const message = await dmChannel.send({
        embeds: [createEmbed({
            title: `Setup question ${stepNumber}/${totalSteps}`,
            description: prompt,
            color: 'primary',
        })],
        components: [stepButtons(nonce)],
        allowedMentions: NO_PINGS,
    });

    const result = await waitForAnswer({ dmChannel, message, userId, nonce, timeMs });
    // The buttons only work for this question: grey them out once it is answered or expired.
    await message?.edit?.({ components: [stepButtons(nonce, { disabled: true })] }).catch(() => {});

    if (!result) {
        await dmChannel.send({
            embeds: [buildUserErrorEmbed(ErrorTypes.RATE_LIMIT, 'You did not answer in time. Run the setup wizard again when ready.')],
            allowedMentions: NO_PINGS,
        });
        return null;
    }

    // Typing skip / cancel still works (older habit); the buttons are what the question offers.
    const typed = result.text?.toLowerCase();
    if (result.button === 'cancel' || typed === 'cancel') {
        await dmChannel.send({
            embeds: [infoEmbed('Setup cancelled', 'Stopped. Anything you already answered is saved.')],
            allowedMentions: NO_PINGS,
        });
        return { cancelled: true };
    }
    if (result.button === 'skip' || typed === 'skip') return { skipped: true };

    return { answer: result.text };
}

/** Still allowed to change this server's settings? Administrator (or the server owner), or OWNER_IDS in Mewvo's own servers. */
export async function stillAllowed(guild, userId) {
    if (hasOwnerPower(userId, guild?.id)) return true;
    const member = guild?.members?.cache?.get?.(userId) || await guild?.members?.fetch?.(userId).catch(() => null);
    return Boolean(member) && hasAdministrator({ guild, userId, permissions: member.permissions });
}

function formatSavedAck(key, value, guild) {
    if (key === 'prefix') {
        return `Server prefix saved as \`${value}\`.`;
    }

    if (key === 'logChannelId') {
        if (value === null) {
            return 'Log channel cleared.';
        }
        const channel = guild.channels.cache.get(value);
        return `Log channel saved as ${channel ?? `<#${value}>`}.`;
    }

    if (key === 'modRole') {
        if (value === null) {
            return 'Moderator role cleared.';
        }
        const role = guild.roles.cache.get(value);
        return `Moderator role saved as ${role ?? `<@&${value}>`}.`;
    }

    return 'Setting saved.';
}

async function validateGuildChannelId(guild, channelId) {
    const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        throw new Error('That channel was not found in this server or is not a text channel.');
    }
    return channel.id;
}

async function validateGuildRoleId(guild, roleId) {
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        throw new Error('That role was not found in this server.');
    }
    return role.id;
}

async function refreshDashboard(rootInteraction, config, guild) {
    const embed = buildDashboardEmbed(config, guild);
    const components = [buildButtonRow(config, guild.id), buildSettingsSelect(guild.id)];
    await InteractionHelper.safeEditReply(rootInteraction, { embeds: [embed], components }).catch(() => {});
}

async function runSetupWizard(buttonInteraction, config, guild, client, rootInteraction) {
    const user = buttonInteraction.user;

    if (activeWizardSessions.has(user.id)) {
        await buttonInteraction.followUp({
            embeds: [warningEmbed('Setup already running', 'You already have the setup open in your DMs. Answer there, or press **Stop setup** under the question.')],
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
    }

    activeWizardSessions.add(user.id);

    let dmChannel;

    try {
        dmChannel = await user.createDM();
    } catch (error) {
        logger.warn('Failed to create DM channel for setup wizard', { userId: user.id, error: error.message });
        await notifyWizardDmBlocked(buttonInteraction);
        return;
    } finally {
        if (!dmChannel) {
            activeWizardSessions.delete(user.id);
        }
    }

    const prompts = [
        {
            key: 'prefix',
            skipMessage: 'Keeping the current server prefix.',
            question: 'What command prefix should this server use?\nCurrent: `' + (config.prefix || getCommandPrefix()) + '`\nType the new prefix, or press **Skip** to keep it.',
            parse: async (answer) => {
                const normalized = answer.trim();
                if (normalized.toLowerCase() === 'skip') return undefined;
                if (/\s/.test(normalized) || normalized.length < 1 || normalized.length > 10) {
                    throw new Error('Prefix must be 1-10 characters with no spaces.');
                }
                return normalized;
            },
        },
        {
            key: 'logChannelId',
            skipMessage: 'Keeping the current log channel.',
            question: 'Which channel should receive bot logs?\nSend a channel mention or channel ID, or `none` to clear it. Press **Skip** to keep the current one.',
            parse: async (answer) => {
                const normalized = answer.trim();
                if (normalized.toLowerCase() === 'skip') return undefined;
                if (normalized.toLowerCase() === 'none') return null;
                const id = extractId(normalized);
                if (!id) throw new Error('Provide a valid channel mention or ID from this server.');
                return validateGuildChannelId(guild, id);
            },
        },
        {
            key: 'modRole',
            skipMessage: 'Keeping the current moderator role.',
            question: 'What role should moderators have?\nSend a role mention or role ID, or `none` to clear it. Press **Skip** to keep the current one.',
            parse: async (answer) => {
                const normalized = answer.trim();
                if (normalized.toLowerCase() === 'skip') return undefined;
                if (normalized.toLowerCase() === 'none') return null;
                const id = extractId(normalized);
                if (!id) throw new Error('Provide a valid role mention or ID from this server.');
                return validateGuildRoleId(guild, id);
            },
        },
    ];

    const changes = {};
    const errors = [];
    let wizardCancelled = false;

    try {
        try {
            await dmChannel.send({
                embeds: [createEmbed({
                    title: 'Setup',
                    description: 'Answer each question here.\n\n• **Skip** keeps the current value\n• **Stop setup** stops the setup',
                    color: 'info',
                })],
            });
        } catch (error) {
            logger.warn('Failed to send setup wizard DM', { userId: user.id, error: error.message });
            await notifyWizardDmBlocked(buttonInteraction);
            return;
        }

        await notifyWizardStarted(buttonInteraction);

        for (let index = 0; index < prompts.length; index++) {
            const prompt = prompts[index];
            let answered = false;

            while (!answered) {
                const result = await askQuestion(
                    dmChannel,
                    user.id,
                    prompt.question,
                    index + 1,
                    prompts.length,
                );

                if (result === null) {
                    wizardCancelled = true;
                    answered = true;
                    break;
                }

                if (result.cancelled) {
                    wizardCancelled = true;
                    answered = true;
                    break;
                }

                try {
                    const value = result.skipped ? undefined : await prompt.parse(result.answer);

                    // The wizard can run for minutes: re-check before every save (Administrator or OWNER_IDS).
                    if (value !== undefined && !(await stillAllowed(guild, user.id))) {
                        await dmChannel.send({
                            embeds: [buildUserErrorEmbed(ErrorTypes.PERMISSION, `You no longer have the Administrator permission in ${guild.name}, so nothing more was saved. Setup stopped.`)],
                            allowedMentions: NO_PINGS,
                        });
                        wizardCancelled = true;
                        answered = true;
                        break;
                    }

                    if (value === undefined) {
                        await dmChannel.send({
                            embeds: [infoEmbed('Skipped', prompt.skipMessage)],
                        });
                    } else {
                        await ConfigService.updateSetting(client, guild.id, prompt.key, value, user.id);
                        changes[prompt.key] = value;
                        await dmChannel.send({
                            embeds: [successEmbed('Saved', formatSavedAck(prompt.key, value, guild))],
                        });

                        try {
                            const updatedConfig = await getGuildConfig(client, guild.id);
                            await refreshDashboard(rootInteraction, updatedConfig, guild);
                        } catch (refreshError) {
                            logger.debug('Failed to refresh dashboard during setup wizard', { error: refreshError.message });
                        }
                    }

                    answered = true;
                } catch (error) {
                    errors.push(`• ${prompt.key}: ${error.message}`);
                    await dmChannel.send({
                        embeds: [buildUserErrorEmbed(ErrorTypes.VALIDATION, `${error.message}\n\nAnswer again, or press **Skip** or **Stop setup** under the new question.`)],
                    });
                }
            }

            if (wizardCancelled) {
                break;
            }
        }

        if (!wizardCancelled) {
            try {
                await setConfigValue(client, guild.id, 'setupWizardCompleted', true);
            } catch (error) {
                logger.warn('Failed to persist setupWizardCompleted flag', { guildId: guild.id, error: error.message });
            }
        }

        const summaryTitle = wizardCancelled
            ? (Object.keys(changes).length > 0 ? 'Setup stopped' : 'Setup cancelled')
            : 'Setup done';

        const summaryBody = wizardCancelled
            ? (Object.keys(changes).length > 0
                ? `Setup stopped early. Saved **${Object.keys(changes).length}** setting(s) before stopping.`
                : 'Stopped before anything was saved.')
            : (Object.keys(changes).length > 0
                ? `Updated **${Object.keys(changes).length}** setting(s).${errors.length > 0 ? ' Some answers had to be retried.' : ''}`
                : 'Nothing was changed.');

        const summaryEmbed = createEmbed({
            title: summaryTitle,
            description: summaryBody,
            color: wizardCancelled ? 'warning' : (errors.length > 0 ? 'warning' : 'success'),
        });

        if (errors.length > 0) {
            const uniqueErrors = [...new Set(errors)];
            summaryEmbed.addFields({ name: 'Issues', value: uniqueErrors.join('\n').slice(0, 1024) });
        }

        await dmChannel.send({ embeds: [summaryEmbed] });

        try {
            const updatedConfig = await getGuildConfig(client, guild.id);
            await refreshDashboard(rootInteraction, updatedConfig, guild);
        } catch (error) {
            logger.debug('Failed to refresh dashboard after wizard completion', { error: error.message });
        }
    } finally {
        activeWizardSessions.delete(user.id);
    }
}

async function showSettingModal(selectInteraction, guildId, setting) {
    const modalCustomId = `config_wizard_modal:${setting}:${guildId}`;

    if (setting === 'logChannelId') {
        const modal = new ModalBuilder()
            .setCustomId(modalCustomId)
            .setTitle('Log channel');

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('log_channel')
            .setPlaceholder('Pick a text channel')
            .setMinValues(1)
            .setMaxValues(1)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true);

        const channelLabel = new LabelBuilder()
            .setLabel('Log channel')
            .setDescription('Where the bot posts its logs')
            .setChannelSelectMenuComponent(channelSelect);

        modal.addLabelComponents(channelLabel);
        await selectInteraction.showModal(modal);
        return;
    }

    if (setting === 'modRole') {
        const modal = new ModalBuilder()
            .setCustomId(modalCustomId)
            .setTitle('Moderator role');

        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId('mod_role')
            .setPlaceholder('Pick a role')
            .setMinValues(1)
            .setMaxValues(1)
            .setRequired(true);

        const roleLabel = new LabelBuilder()
            .setLabel('Moderator role')
            .setDescription('Role used for moderation commands')
            .setRoleSelectMenuComponent(roleSelect);

        modal.addLabelComponents(roleLabel);
        await selectInteraction.showModal(modal);
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(modalCustomId)
        .setTitle('Prefix');

    const textInput = new TextInputBuilder()
        .setCustomId('value')
        .setLabel('New prefix (1-10 characters, no spaces)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(10);

    modal.addComponents(new ActionRowBuilder().addComponents(textInput));
    await selectInteraction.showModal(modal);
}

function resolveSettingModalValue(setting, submitted) {
    if (setting === 'logChannelId') {
        const channelId = submitted.fields.getField('log_channel')?.values?.[0];
        if (!channelId) {
            throw new Error('Pick a log channel.');
        }
        return channelId;
    }

    if (setting === 'modRole') {
        const roleId = submitted.fields.getField('mod_role')?.values?.[0];
        if (!roleId) {
            throw new Error('Pick a moderator role.');
        }
        return roleId;
    }

    const prefix = submitted.fields.getTextInputValue('value')?.trim();
    if (!prefix || prefix.length < 1 || prefix.length > 10 || /\s/.test(prefix)) {
        throw new Error('Prefix must be 1-10 characters with no spaces.');
    }
    return prefix;
}

function buildSettingSuccessMessage(setting, value, guild) {
    if (setting === 'logChannelId') {
        const channel = guild.channels.cache.get(value);
        return `Log channel set to ${channel ?? `<#${value}>`}.`;
    }

    if (setting === 'modRole') {
        const role = guild.roles.cache.get(value);
        return `Moderator role set to ${role ?? `<@&${value}>`}.`;
    }

    return `Server prefix set to \`${value}\`.`;
}

async function handleSettingModalSubmit(selectInteraction, rootInteraction, setting, guildId, client) {
    const modalCustomId = `config_wizard_modal:${setting}:${guildId}`;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: (modalInteraction) =>
                modalInteraction.customId === modalCustomId &&
                modalInteraction.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) {
        return;
    }

    try {
        const value = resolveSettingModalValue(setting, submitted);
        await ConfigService.updateSetting(client, guildId, setting, value, submitted.user.id);

        await submitted.reply({
            embeds: [successEmbed('Saved', buildSettingSuccessMessage(setting, value, submitted.guild))],
            flags: MessageFlags.Ephemeral,
        });

        const updatedConfig = await getGuildConfig(client, guildId);
        await refreshDashboard(rootInteraction, updatedConfig, submitted.guild);
    } catch (error) {
        logger.error('Config wizard modal submit error:', error);
        await replyUserError(submitted, {
            type: ErrorTypes.CONFIGURATION,
            message: error.message || 'Try again.',
        }).catch(() => {});
    }
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('configwizard')
        .setDescription('Open the server settings and setup wizard')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false),
    category: 'Core',

    async execute(interaction) {
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
            if (!deferSuccess) {
                return;
            }

            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                return replyUserError(interaction, {
                    type: ErrorTypes.PERMISSION,
                    message: 'You need the **Manage Server** permission to use this command.',
                });
            }

            const guildConfig = await getGuildConfig(interaction.client, interaction.guildId);
            const embed = buildDashboardEmbed(guildConfig, interaction.guild);
            const components = [buildButtonRow(guildConfig, interaction.guildId), buildSettingsSelect(interaction.guildId)];

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components });

            const replyMessage = await interaction.fetchReply().catch(() => null);
            if (!replyMessage) {
                return;
            }

            const collectorFilter = (componentInteraction) =>
                componentInteraction.user.id === interaction.user.id &&
                componentInteraction.customId.includes(`:${interaction.guildId}`);

            const componentCollector = replyMessage.createMessageComponentCollector({
                filter: collectorFilter,
                time: 600_000,
            });

            componentCollector.on('collect', async (componentInteraction) => {
                try {
                    if (componentInteraction.isButton()) {
                        await componentInteraction.deferUpdate();

                        if (componentInteraction.customId.startsWith(`${WIZARD_BUTTON_ID}:`)) {
                            const latestConfig = await getGuildConfig(interaction.client, interaction.guildId);
                            await runSetupWizard(componentInteraction, latestConfig, interaction.guild, interaction.client, interaction);
                        }
                        return;
                    }

                    if (componentInteraction.isStringSelectMenu()) {
                        const selected = componentInteraction.values[0];
                        await showSettingModal(componentInteraction, interaction.guildId, selected);
                        await handleSettingModalSubmit(
                            componentInteraction,
                            interaction,
                            selected,
                            interaction.guildId,
                            interaction.client,
                        );
                    }
                } catch (error) {
                    logger.error('Config dashboard interaction error:', error);
                    await replyUserError(componentInteraction, {
                        type: ErrorTypes.UNKNOWN,
                        message: 'That didn\'t work. Try again.',
                    }).catch(() => {});
                }
            });
        } catch (error) {
            logger.error('Config command error:', error);
            await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: 'Couldn\'t open the settings. Try again.',
            });
        }
    },
};
