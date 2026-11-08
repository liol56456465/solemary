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
import { botText } from '../../utils/botText.js';
import { localized, replyText } from './modules/commandText.js';

const DASHBOARD_CUSTOM_ID = 'config_select';
const WIZARD_BUTTON_ID = 'config_wizard';
const activeWizardSessions = new Set();

// Language: the panel and its buttons are ephemeral (the user's Discord language); the DM wizard
// is the same person's private conversation started from that panel, so it uses their language too.

async function notifyWizardStarted(buttonInteraction, tr) {
    await buttonInteraction.followUp({
        embeds: [infoEmbed(
            tr.t('core.config.startedTitle'),
            tr.t('core.config.started'),
        )],
        flags: MessageFlags.Ephemeral,
    }).catch(() => {});
}

async function notifyWizardDmBlocked(buttonInteraction, tr) {
    await replyUserError(buttonInteraction, {
        type: ErrorTypes.USER_INPUT,
        message: tr.t('core.config.dmBlocked', { help: tr.t('core.config.dmHelp') }),
    }).catch(() => {});
}

function formatChannelMention(guild, channelId, tr) {
    if (!channelId) {
        return `\`${tr.t('core.config.notSet')}\``;
    }
    const channel = guild.channels.cache.get(channelId);
    return channel ? `<#${channelId}>` : `#${channelId}`;
}

function formatRoleMention(guild, roleId, tr) {
    if (!roleId) {
        return `\`${tr.t('core.config.notSet')}\``;
    }
    const role = guild.roles.cache.get(roleId);
    return role ? `<@&${roleId}>` : `@${roleId}`;
}

// Discord activity types 0-5 (4 = custom status: just the text).
const ACTIVITY_KEYS = [
    'core.config.activity.playing', 'core.config.activity.streaming', 'core.config.activity.listening',
    'core.config.activity.watching', null, 'core.config.activity.competing',
];

function getBotPresenceText(tr) {
    const activity = botConfig.presence?.activities?.[0];
    if (!activity?.name) {
        return `\`${tr.t('core.config.notConfigured')}\``;
    }

    const key = ACTIVITY_KEYS[activity.type];
    if (!key) {
        return activity.name;
    }

    return tr.t(key, { name: activity.name });
}

function getThemeColorLines(tr) {
    const colors = botConfig.embeds.colors;
    return [
        tr.t('core.config.colorsPrimary', { primary: colors.primary, success: colors.success }),
        tr.t('core.config.colorsWarning', { warning: colors.warning, error: colors.error }),
    ].join('\n');
}

function buildDashboardEmbed(config, guild, tr) {
    const setupDone = config.setupWizardCompleted;

    return createEmbed({
        title: tr.t('core.config.panel.title'),
        description: tr.t('core.config.panel.description', { server: guild.name }),
        color: 'info',
        fields: [
            {
                name: tr.t('core.config.panel.prefix'),
                value: `\`${config.prefix || getCommandPrefix()}\``,
                inline: true,
            },
            {
                name: tr.t('core.config.panel.modRole'),
                value: formatRoleMention(guild, config.modRole, tr),
                inline: true,
            },
            {
                name: tr.t('core.config.panel.logChannel'),
                value: formatChannelMention(guild, config.logging?.channels?.audit, tr),
                inline: true,
            },
            {
                name: tr.t('core.config.panel.botStatus'),
                value: getBotPresenceText(tr),
                inline: false,
            },
            {
                name: tr.t('core.config.panel.colors'),
                value: `${getThemeColorLines(tr)}\n${tr.t('core.config.panel.colorsNote')}`,
                inline: false,
            },
            {
                name: tr.t('core.config.panel.access'),
                value: tr.t('core.config.panel.accessText'),
                inline: false,
            },
            {
                name: tr.t('core.config.panel.setup'),
                value: setupDone
                    ? tr.t('core.config.panel.setupDone')
                    : tr.t('core.config.panel.setupNotDone'),
                inline: false,
            },
        ],
        footer: tr.t('core.config.panel.footer'),
    });
}

function buildSettingsSelect(guildId, tr) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASHBOARD_CUSTOM_ID}:${guildId}`)
            .setPlaceholder(tr.t('core.config.select.placeholder'))
            .addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(tr.t('core.config.panel.prefix'))
                    .setDescription(tr.t('core.config.select.prefixHelp'))
                    .setValue('prefix'),
                new StringSelectMenuOptionBuilder()
                    .setLabel(tr.t('core.config.panel.modRole'))
                    .setDescription(tr.t('core.config.select.modRoleHelp'))
                    .setValue('modRole'),
                new StringSelectMenuOptionBuilder()
                    .setLabel(tr.t('core.config.panel.logChannel'))
                    .setDescription(tr.t('core.config.select.logChannelHelp'))
                    .setValue('logChannelId'),
            ),
    );
}

function buildButtonRow(config, guildId, tr) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${WIZARD_BUTTON_ID}:${guildId}`)
            .setLabel(config.setupWizardCompleted ? tr.t('core.config.againButton') : tr.t('core.config.startButton'))
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

/** The Skip / Stop setup buttons of one question (labels in `lang`, default English). */
export function stepButtons(nonce, { disabled = false, lang = 'en' } = {}) {
    const tr = botText(lang);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${STEP_BUTTON_PREFIX}:skip:${nonce}`).setLabel(tr.t('core.config.skipButton')).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`${STEP_BUTTON_PREFIX}:cancel:${nonce}`).setLabel(tr.t('core.config.stopButton')).setStyle(ButtonStyle.Danger).setDisabled(disabled),
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

export async function askQuestion(dmChannel, userId, prompt, stepNumber, totalSteps, { nonce = randomBytes(4).toString('hex'), timeMs = QUESTION_TIMEOUT_MS, lang = 'en' } = {}) {
    const tr = botText(lang);
    const message = await dmChannel.send({
        embeds: [createEmbed({
            title: tr.t('core.config.questionTitle', { step: stepNumber, total: totalSteps }),
            description: prompt,
            color: 'primary',
        })],
        components: [stepButtons(nonce, { lang })],
        allowedMentions: NO_PINGS,
    });

    const result = await waitForAnswer({ dmChannel, message, userId, nonce, timeMs });
    // The buttons only work for this question: grey them out once it is answered or expired.
    await message?.edit?.({ components: [stepButtons(nonce, { disabled: true, lang })] }).catch(() => {});

    if (!result) {
        await dmChannel.send({
            embeds: [buildUserErrorEmbed(ErrorTypes.RATE_LIMIT, tr.t('core.config.timeout'), { lang })],
            allowedMentions: NO_PINGS,
        });
        return null;
    }

    // Typing skip / cancel still works (older habit); the buttons are what the question offers.
    const typed = result.text?.toLowerCase();
    if (result.button === 'cancel' || typed === 'cancel') {
        await dmChannel.send({
            embeds: [infoEmbed(tr.t('core.config.cancelledTitle'), tr.t('core.config.cancelled'))],
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

function formatSavedAck(key, value, guild, tr) {
    if (key === 'prefix') {
        return tr.t('core.config.saved.prefix', { value });
    }

    if (key === 'logChannelId') {
        if (value === null) {
            return tr.t('core.config.saved.logCleared');
        }
        const channel = guild.channels.cache.get(value);
        return tr.t('core.config.saved.log', { channel: String(channel ?? `<#${value}>`) });
    }

    if (key === 'modRole') {
        if (value === null) {
            return tr.t('core.config.saved.modCleared');
        }
        const role = guild.roles.cache.get(value);
        return tr.t('core.config.saved.mod', { role: String(role ?? `<@&${value}>`) });
    }

    return tr.t('core.config.saved.setting');
}

async function validateGuildChannelId(guild, channelId, tr) {
    const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        throw new Error(tr.t('core.config.channelNotFound'));
    }
    return channel.id;
}

async function validateGuildRoleId(guild, roleId, tr) {
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        throw new Error(tr.t('core.config.roleNotFound'));
    }
    return role.id;
}

// The panel is the root interaction's ephemeral reply: its user's language.
async function refreshDashboard(rootInteraction, config, guild) {
    const tr = replyText(rootInteraction);
    const embed = buildDashboardEmbed(config, guild, tr);
    const components = [buildButtonRow(config, guild.id, tr), buildSettingsSelect(guild.id, tr)];
    await InteractionHelper.safeEditReply(rootInteraction, { embeds: [embed], components }).catch(() => {});
}

async function runSetupWizard(buttonInteraction, config, guild, client, rootInteraction) {
    const user = buttonInteraction.user;
    const tr = replyText(buttonInteraction);

    if (activeWizardSessions.has(user.id)) {
        await buttonInteraction.followUp({
            embeds: [warningEmbed(tr.t('core.config.runningTitle'), tr.t('core.config.running'))],
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
        await notifyWizardDmBlocked(buttonInteraction, tr);
        return;
    } finally {
        if (!dmChannel) {
            activeWizardSessions.delete(user.id);
        }
    }

    const prompts = [
        {
            key: 'prefix',
            skipMessage: tr.t('core.config.prompt.prefixSkip'),
            question: tr.t('core.config.prompt.prefixQuestion', { prefix: config.prefix || getCommandPrefix() }),
            parse: async (answer) => {
                const normalized = answer.trim();
                if (normalized.toLowerCase() === 'skip') return undefined;
                if (/\s/.test(normalized) || normalized.length < 1 || normalized.length > 10) {
                    throw new Error(tr.t('core.config.prompt.prefixRule'));
                }
                return normalized;
            },
        },
        {
            key: 'logChannelId',
            skipMessage: tr.t('core.config.prompt.logSkip'),
            question: tr.t('core.config.prompt.logQuestion'),
            parse: async (answer) => {
                const normalized = answer.trim();
                if (normalized.toLowerCase() === 'skip') return undefined;
                if (normalized.toLowerCase() === 'none') return null;
                const id = extractId(normalized);
                if (!id) throw new Error(tr.t('core.config.prompt.logInvalid'));
                return validateGuildChannelId(guild, id, tr);
            },
        },
        {
            key: 'modRole',
            skipMessage: tr.t('core.config.prompt.modSkip'),
            question: tr.t('core.config.prompt.modQuestion'),
            parse: async (answer) => {
                const normalized = answer.trim();
                if (normalized.toLowerCase() === 'skip') return undefined;
                if (normalized.toLowerCase() === 'none') return null;
                const id = extractId(normalized);
                if (!id) throw new Error(tr.t('core.config.prompt.modInvalid'));
                return validateGuildRoleId(guild, id, tr);
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
                    title: tr.t('core.config.introTitle'),
                    description: tr.t('core.config.intro'),
                    color: 'info',
                })],
            });
        } catch (error) {
            logger.warn('Failed to send setup wizard DM', { userId: user.id, error: error.message });
            await notifyWizardDmBlocked(buttonInteraction, tr);
            return;
        }

        await notifyWizardStarted(buttonInteraction, tr);

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
                    { lang: tr.lang },
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
                            embeds: [buildUserErrorEmbed(ErrorTypes.PERMISSION, tr.t('core.config.lostAdmin', { server: guild.name }), { lang: tr.lang })],
                            allowedMentions: NO_PINGS,
                        });
                        wizardCancelled = true;
                        answered = true;
                        break;
                    }

                    if (value === undefined) {
                        await dmChannel.send({
                            embeds: [infoEmbed(tr.t('core.config.skippedTitle'), prompt.skipMessage)],
                        });
                    } else {
                        await ConfigService.updateSetting(client, guild.id, prompt.key, value, user.id);
                        changes[prompt.key] = value;
                        await dmChannel.send({
                            embeds: [successEmbed(tr.t('core.config.savedTitle'), formatSavedAck(prompt.key, value, guild, tr))],
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
                        embeds: [buildUserErrorEmbed(ErrorTypes.VALIDATION, tr.t('core.config.retry', { error: error.message }), { lang: tr.lang })],
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

        const changed = Object.keys(changes).length;
        const summaryTitle = wizardCancelled
            ? (changed > 0 ? tr.t('core.config.summary.stoppedTitle') : tr.t('core.config.cancelledTitle'))
            : tr.t('core.config.summary.doneTitle');

        const summaryBody = wizardCancelled
            ? (changed > 0
                ? tr.tp('core.config.summary.stoppedSaved', changed)
                : tr.t('core.config.summary.stoppedNothing'))
            : (changed > 0
                ? `${tr.tp('core.config.summary.updated', changed)}${errors.length > 0 ? ` ${tr.t('core.config.summary.retried')}` : ''}`
                : tr.t('core.config.summary.nothing'));

        const summaryEmbed = createEmbed({
            title: summaryTitle,
            description: summaryBody,
            color: wizardCancelled ? 'warning' : (errors.length > 0 ? 'warning' : 'success'),
        });

        if (errors.length > 0) {
            const uniqueErrors = [...new Set(errors)];
            summaryEmbed.addFields({ name: tr.t('core.config.summary.issues'), value: uniqueErrors.join('\n').slice(0, 1024) });
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
    const tr = replyText(selectInteraction);

    if (setting === 'logChannelId') {
        const modal = new ModalBuilder()
            .setCustomId(modalCustomId)
            .setTitle(tr.t('core.config.panel.logChannel'));

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('log_channel')
            .setPlaceholder(tr.t('core.config.modal.channelPlaceholder'))
            .setMinValues(1)
            .setMaxValues(1)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true);

        const channelLabel = new LabelBuilder()
            .setLabel(tr.t('core.config.panel.logChannel'))
            .setDescription(tr.t('core.config.select.logChannelHelp'))
            .setChannelSelectMenuComponent(channelSelect);

        modal.addLabelComponents(channelLabel);
        await selectInteraction.showModal(modal);
        return;
    }

    if (setting === 'modRole') {
        const modal = new ModalBuilder()
            .setCustomId(modalCustomId)
            .setTitle(tr.t('core.config.panel.modRole'));

        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId('mod_role')
            .setPlaceholder(tr.t('core.config.modal.rolePlaceholder'))
            .setMinValues(1)
            .setMaxValues(1)
            .setRequired(true);

        const roleLabel = new LabelBuilder()
            .setLabel(tr.t('core.config.panel.modRole'))
            .setDescription(tr.t('core.config.select.modRoleHelp'))
            .setRoleSelectMenuComponent(roleSelect);

        modal.addLabelComponents(roleLabel);
        await selectInteraction.showModal(modal);
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(modalCustomId)
        .setTitle(tr.t('core.config.panel.prefix'));

    const textInput = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(tr.t('core.config.modal.prefixLabel'))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(10);

    modal.addComponents(new ActionRowBuilder().addComponents(textInput));
    await selectInteraction.showModal(modal);
}

function resolveSettingModalValue(setting, submitted, tr) {
    if (setting === 'logChannelId') {
        const channelId = submitted.fields.getField('log_channel')?.values?.[0];
        if (!channelId) {
            throw new Error(tr.t('core.config.pickLog'));
        }
        return channelId;
    }

    if (setting === 'modRole') {
        const roleId = submitted.fields.getField('mod_role')?.values?.[0];
        if (!roleId) {
            throw new Error(tr.t('core.config.pickMod'));
        }
        return roleId;
    }

    const prefix = submitted.fields.getTextInputValue('value')?.trim();
    if (!prefix || prefix.length < 1 || prefix.length > 10 || /\s/.test(prefix)) {
        throw new Error(tr.t('core.config.prompt.prefixRule'));
    }
    return prefix;
}

function buildSettingSuccessMessage(setting, value, guild, tr) {
    if (setting === 'logChannelId') {
        const channel = guild.channels.cache.get(value);
        return tr.t('core.config.set.log', { channel: String(channel ?? `<#${value}>`) });
    }

    if (setting === 'modRole') {
        const role = guild.roles.cache.get(value);
        return tr.t('core.config.set.mod', { role: String(role ?? `<@&${value}>`) });
    }

    return tr.t('core.config.set.prefix', { value });
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

    const tr = replyText(submitted);
    try {
        const value = resolveSettingModalValue(setting, submitted, tr);
        await ConfigService.updateSetting(client, guildId, setting, value, submitted.user.id);

        await submitted.reply({
            embeds: [successEmbed(tr.t('core.config.savedTitle'), buildSettingSuccessMessage(setting, value, submitted.guild, tr))],
            flags: MessageFlags.Ephemeral,
        });

        const updatedConfig = await getGuildConfig(client, guildId);
        await refreshDashboard(rootInteraction, updatedConfig, submitted.guild);
    } catch (error) {
        logger.error('Config wizard modal submit error:', error);
        await replyUserError(submitted, {
            type: ErrorTypes.CONFIGURATION,
            message: error.message || tr.t('core.config.tryAgain'),
        }).catch(() => {});
    }
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('configwizard')
        .setDescription('Open the server settings and setup wizard')
        .setDescriptionLocalizations(localized('core.slash.configwizard.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false),
    category: 'Core',

    async execute(interaction) {
        // The panel is ephemeral: the user's Discord language.
        const tr = replyText(interaction);
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
            if (!deferSuccess) {
                return;
            }

            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                return replyUserError(interaction, {
                    type: ErrorTypes.PERMISSION,
                    message: tr.t('core.config.needManageServer'),
                });
            }

            const guildConfig = await getGuildConfig(interaction.client, interaction.guildId);
            const embed = buildDashboardEmbed(guildConfig, interaction.guild, tr);
            const components = [buildButtonRow(guildConfig, interaction.guildId, tr), buildSettingsSelect(interaction.guildId, tr)];

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
                        message: replyText(componentInteraction).t('core.config.failed'),
                    }).catch(() => {});
                }
            });
        } catch (error) {
            logger.error('Config command error:', error);
            await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: tr.t('core.config.openFailed'),
            });
        }
    },
};
