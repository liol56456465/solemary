import { botConfig, getColor } from '../../../config/bot.js';
import { getRoleAssignmentProblem } from '../../../utils/roleSafety.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    RoleSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
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
import { validateAutoVerifyCriteria } from '../../../services/verificationService.js';
import { botHasPermission } from '../../../utils/permissionGuard.js';
import { botText, textForInteraction } from '../../../utils/botText.js';

// Everything in this dashboard is ephemeral: the admin's Discord language.

function conflictLines(tr, { verificationEnabled, autoRoleConfigured }) {
    return [
        verificationEnabled ? tr.t('verification.adash.verificationOn') : null,
        autoRoleConfigured ? tr.t('verification.dash.autoRoleConfigured') : null,
    ].filter(Boolean);
}

const autoVerifyDefaults = botConfig.verification?.autoVerify || {};
const minAccountAgeDays = autoVerifyDefaults.minAccountAge ?? 1;
const maxAccountAgeDays = autoVerifyDefaults.maxAccountAge ?? 365;
const defaultAccountAgeDays = autoVerifyDefaults.defaultAccountAgeDays ?? 7;

function buildDashboardEmbed(cfg, guild, conflictSummary = '', tr = botText()) {
    const autoVerify = cfg.verification?.autoVerify;
    const autoVerifyRole = autoVerify?.roleId ? guild.roles.cache.get(autoVerify.roleId) : null;

    let criteriaDescription = tr.t('verification.dash.notConfigured');
    if (autoVerify?.criteria) {
        switch (autoVerify.criteria) {
            case "account_age":
                criteriaDescription = tr.t('verification.adash.criteriaAge', { days: autoVerify.accountAgeDays });
                break;
            case "none":
                criteriaDescription = tr.t('verification.adash.criteriaNone');
                break;
        }
    }

    const embed = new EmbedBuilder()
        .setTitle(tr.t('verification.adash.title'))
        .setDescription(tr.t('verification.adash.intro', { server: guild.name }))
        .setColor(getColor('info'))
        .addFields(
            { name: tr.t('verification.dash.systemStatus'), value: autoVerify?.enabled ? tr.t('verification.dash.enabled') : tr.t('verification.dash.disabled'), inline: true },
            { name: tr.t('verification.adash.fieldRole'), value: autoVerifyRole ? autoVerifyRole.toString() : tr.t('verification.dash.notSet'), inline: true },
            { name: tr.t('verification.adash.fieldCriteria'), value: criteriaDescription, inline: true },
            { name: tr.t('verification.adash.fieldAge'), value: autoVerify?.accountAgeDays ? tr.t('verification.adash.ageDays', { days: autoVerify.accountAgeDays }) : tr.t('verification.adash.na'), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
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
        .setCustomId(`autoverify_cfg_${guildId}`)
        .setPlaceholder(tr.t('verification.dash.selectPlaceholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('verification.adash.optRole'))
                .setDescription(tr.t('verification.adash.optRoleDesc'))
                .setValue('role'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('verification.adash.optAge'))
                .setDescription(tr.t('verification.adash.optAgeDesc'))
                .setValue('account_age'),
        );
}

function buildButtonRow(cfg, guildId, disabled = false, tr = botText()) {
    const autoVerifyOn = cfg.verification?.autoVerify?.enabled === true;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`autoverify_cfg_criteria_${guildId}`)
            .setLabel(tr.t('verification.adash.criteriaButton'))
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`autoverify_cfg_toggle_${guildId}`)
            .setLabel(tr.t('verification.adash.toggleButton'))
            .setStyle(autoVerifyOn ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

async function refreshDashboard(rootInteraction, cfg, guildId, client) {
    try {
        const tr = textForInteraction(rootInteraction);
        const selectMenu = buildSelectMenu(guildId, tr);

        let conflictSummary = '';
        try {
            const welcomeConfig = await getWelcomeConfig(client, guildId);
            const verificationEnabled = Boolean(cfg.verification?.enabled);
            const autoRoleConfigured = Boolean(cfg.autoRole) || (Array.isArray(welcomeConfig.roleIds) && welcomeConfig.roleIds.length > 0);
            
            const conflicts = conflictLines(tr, { verificationEnabled, autoRoleConfigured });
            
            if (conflicts.length > 0) {
                conflictSummary = conflicts.join('\n');
            }
        } catch (error) {
            logger.warn('Could not fetch autoverify dashboard conflicts:', error.message);
        }
        
        await InteractionHelper.safeEditReply(rootInteraction, {
            embeds: [buildDashboardEmbed(cfg, rootInteraction.guild, conflictSummary, tr)],
            components: [
                buildButtonRow(cfg, guildId, false, tr),
                new ActionRowBuilder().addComponents(selectMenu),
            ],
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        logger.debug('Could not refresh autoverify dashboard (interaction may have expired):', error.message);
    }
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        try {
            const guildId = interaction.guild.id;
            const guildConfig = await getGuildConfig(client, guildId);

            if (!guildConfig.verification?.autoVerify?.enabled) {
                
                const welcomeConfig = await getWelcomeConfig(client, guildId);
                const verificationEnabled = Boolean(guildConfig.verification?.enabled);
                const autoRoleConfigured = Boolean(guildConfig.autoRole) || (Array.isArray(welcomeConfig.roleIds) && welcomeConfig.roleIds.length > 0);
                
                const blockingMessage = conflictLines(tr, { verificationEnabled, autoRoleConfigured });

                const blockingText = blockingMessage.length > 0
                    ? `\n\n${tr.t('verification.adash.turnOffFirst')}\n${blockingMessage.map(msg =>`• ${msg}`).join('\n')}`
                    : '';

                return await InteractionHelper.safeReply(interaction, {
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(tr.t('verification.adash.title'))
                            .setDescription(tr.t('verification.adash.notConfigured', { blocking: blockingText }))
                            .setColor(getColor('warning'))
                            .setFooter({ text: tr.t('verification.dash.footer') })
                            .setTimestamp()
                    ],
                    flags: MessageFlags.Ephemeral
                });
            }

            await InteractionHelper.safeDefer(interaction, { ephemeral: true });

            const selectMenu = buildSelectMenu(guildId, tr);

            let conflictSummary = '';
            try {
                const welcomeConfig = await getWelcomeConfig(client, guildId);
                const verificationEnabled = Boolean(guildConfig.verification?.enabled);
                const autoRoleConfigured = Boolean(guildConfig.autoRole) || (Array.isArray(welcomeConfig.roleIds) && welcomeConfig.roleIds.length > 0);
                
                const conflicts = conflictLines(tr, { verificationEnabled, autoRoleConfigured });
                
                if (conflicts.length > 0) {
                    conflictSummary = conflicts.join('\n');
                }
            } catch (error) {
                logger.warn('Could not fetch autoverify dashboard conflicts:', error.message);
            }

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [buildDashboardEmbed(guildConfig, interaction.guild, conflictSummary, tr)],
                components: [
                    buildButtonRow(guildConfig, guildId, false, tr),
                    new ActionRowBuilder().addComponents(selectMenu),
                ],
                flags: MessageFlags.Ephemeral,
            });

            const collector = interaction.channel.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                filter: i =>
                    i.user.id === interaction.user.id && i.customId === `autoverify_cfg_${guildId}`,
                time: 600_000,
            });

            collector.on('collect', async selectInteraction => {
                const selectedOption = selectInteraction.values[0];
                try {
                    switch (selectedOption) {
                        case 'role':
                            await handleRole(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'account_age':
                            await handleAccountAge(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                    }
                } catch (error) {
                    if (error instanceof TitanBotError) {
                        logger.debug(`Autoverify config validation error: ${error.message}`);
                    } else {
                        logger.error('Unexpected autoverify dashboard error:', error);
                    }

                    const errorMessage =
                        error instanceof TitanBotError
                            ? error.userMessage || tr.t('verification.adash.selectionError')
                            : tr.t('verification.adash.unexpectedError');

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
                    (i.customId === `autoverify_cfg_toggle_${guildId}` || i.customId === `autoverify_cfg_criteria_${guildId}`),
                time: 600_000,
            });

            btnCollector.on('collect', async btnInteraction => {
                try {
                    if (btnInteraction.customId === `autoverify_cfg_criteria_${guildId}`) {
                        await handleCriteria(btnInteraction, interaction, guildConfig, guildId, client);
                    } else if (btnInteraction.customId === `autoverify_cfg_toggle_${guildId}`) {
                        await btnInteraction.deferUpdate().catch(() => null);
                        guildConfig.verification.autoVerify.enabled = !guildConfig.verification.autoVerify.enabled;
                        await updateVerificationSettings(client, guildId, {
                            autoVerify: { enabled: guildConfig.verification.autoVerify.enabled },
                        });
                        
                        await btnInteraction.followUp({
                            embeds: [
                                successEmbed(
                                    tr.t('verification.adash.statusTitle'),
                                    guildConfig.verification.autoVerify.enabled ? tr.t('verification.adash.statusOn') : tr.t('verification.adash.statusOff'),
                                ),
                            ],
                            flags: MessageFlags.Ephemeral,
                        });

                        await refreshDashboard(interaction, guildConfig, guildId, client);
                    }
                } catch (err) {
                    logger.debug('Button interaction error:', err.message);
                }
            });

            collector.on('end', async (collected, reason) => {
                if (reason === 'time') {
                    btnCollector.stop();
                    try {
                        const timeoutEmbed = new EmbedBuilder()
                            .setTitle(tr.t('verification.dash.timedOutTitle'))
                            .setDescription(tr.t('verification.dash.timedOutText'))
                            .setColor(getColor('error'));
                        await InteractionHelper.safeEditReply(interaction, {
                            embeds: [timeoutEmbed],
                            components: [],
                            flags: MessageFlags.Ephemeral,
                        });
                    } catch (error) {
                        logger.debug('Could not update dashboard on timeout:', error.message);
                    }
                }
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in autoverify_dashboard:', error);
            throw new TitanBotError(
                `Auto-verification dashboard failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                tr.t('verification.adash.openFailed'),
            );
        }
    },
};

async function handleCriteria(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    
    if (!selectInteraction.deferred) {
        await selectInteraction.deferUpdate().catch(() => null);
    }
    
    const criteriaEmbed = new EmbedBuilder()
        .setTitle(tr.t('verification.adash.criteriaTitle'))
        .setDescription(tr.t('verification.adash.criteriaText'))
        .setColor(getColor('info'));

    const criteriaMenu = new StringSelectMenuBuilder()
        .setCustomId('autoverify_criteria_select')
        .setPlaceholder(tr.t('verification.adash.criteriaPlaceholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('verification.adash.criteriaOptAge', { days: defaultAccountAgeDays }))
                .setDescription(tr.t('verification.adash.criteriaOptAgeDesc'))
                .setValue('account_age'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('verification.adash.criteriaOptNone'))
                .setDescription(tr.t('verification.adash.criteriaOptNoneDesc'))
                .setValue('none'),
        );

    await selectInteraction.followUp({
        embeds: [criteriaEmbed],
        components: [new ActionRowBuilder().addComponents(criteriaMenu)],
        flags: MessageFlags.Ephemeral,
    });

    const criteriaCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'autoverify_criteria_select',
        time: 60_000,
        max: 1,
    });

    criteriaCollector.on('collect', async criteriaInteraction => {
        await criteriaInteraction.deferUpdate();
        const newCriteria = criteriaInteraction.values[0];

        guildConfig.verification.autoVerify.criteria = newCriteria;

        if (newCriteria !== 'account_age') {
            guildConfig.verification.autoVerify.accountAgeDays = null;
        } else if (!guildConfig.verification.autoVerify.accountAgeDays) {
            guildConfig.verification.autoVerify.accountAgeDays = defaultAccountAgeDays;
        }

        await updateVerificationSettings(client, guildId, {
            autoVerify: {
                criteria: newCriteria,
                accountAgeDays: guildConfig.verification.autoVerify.accountAgeDays ?? null,
            },
        });

        let criteriaDisplay = '';
        switch (newCriteria) {
            case 'account_age':
                criteriaDisplay = tr.t('verification.adash.criteriaShowAge', { days: guildConfig.verification.autoVerify.accountAgeDays });
                break;
            case 'none':
                criteriaDisplay = tr.t('verification.adash.criteriaShowNone');
                break;
        }

        await criteriaInteraction.followUp({
            embeds: [successEmbed(tr.t('verification.adash.criteriaUpdatedTitle'), tr.t('verification.adash.criteriaUpdatedText', { criteria: criteriaDisplay }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
    });

    criteriaCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: tr.t('verification.adash.noCriteria'),
            }).catch(() => {});
        }
    });
}

async function handleRole(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    await selectInteraction.deferUpdate();

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('autoverify_role_select')
        .setPlaceholder(tr.t('verification.dash.rolePlaceholder'))
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('verification.adash.roleTitle'))
                .setDescription(tr.t('verification.adash.roleText'))
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(roleSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const roleCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.RoleSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'autoverify_role_select',
        time: 60_000,
        max: 1,
    });

    roleCollector.on('collect', async roleInteraction => {
        await roleInteraction.deferUpdate();
        const role = roleInteraction.roles.first();

        const roleProblem = getRoleAssignmentProblem(role, rootInteraction.guild.members.me);
        if (roleProblem) {
            await replyUserError(roleInteraction, { type: ErrorTypes.VALIDATION, message: roleProblem });
            return;
        }

        guildConfig.verification.autoVerify.roleId = role.id;
        await updateVerificationSettings(client, guildId, { autoVerify: { roleId: role.id } });

        await roleInteraction.followUp({
            embeds: [successEmbed(tr.t('verification.dash.roleUpdated'), tr.t('verification.adash.roleUpdatedText', { role: String(role) }))],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
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

async function handleAccountAge(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const tr = textForInteraction(selectInteraction);
    const modal = new ModalBuilder()
        .setCustomId('autoverify_account_age_modal')
        .setTitle(tr.t('verification.adash.ageModal'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('age_input')
                    .setLabel(tr.t('verification.adash.ageLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder(tr.t('verification.adash.agePlaceholder', { min: minAccountAgeDays, max: maxAccountAgeDays }))
                    .setValue((guildConfig.verification.autoVerify.accountAgeDays || defaultAccountAgeDays).toString())
                    .setRequired(true),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'autoverify_account_age_modal' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const inputValue = submitted.fields.getTextInputValue('age_input').trim();
    const days = parseInt(inputValue, 10);

    if (isNaN(days) || days < minAccountAgeDays || days > maxAccountAgeDays) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('verification.adash.ageInvalid', { min: minAccountAgeDays, max: maxAccountAgeDays }) });
        return;
    }

    guildConfig.verification.autoVerify.accountAgeDays = days;
    await updateVerificationSettings(client, guildId, { autoVerify: { accountAgeDays: days } });

    await submitted.reply({
        embeds: [successEmbed(tr.t('verification.adash.ageUpdatedTitle'), tr.t('verification.adash.ageUpdatedText', { days }))],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}