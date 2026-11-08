import { botConfig, getColor } from '../../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed } from '../../../utils/embeds.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { updateVerificationSettings } from '../../../services/verificationSettingsService.js';
import { withErrorHandling, createError, ErrorTypes } from '../../../utils/errorHandler.js';
import { validateAutoVerifyCriteria } from '../../../services/verificationService.js';
import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { getRoleAssignmentProblem } from '../../../utils/roleSafety.js';
import { getWelcomeConfig } from '../../../utils/database.js';
import autoVerifyDashboard from './autoVerifyDashboard.js';
import { textForInteraction } from '../../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../../utils/commandLocalizations.js';

const autoVerifyDefaults = botConfig.verification?.autoVerify || {};
const minAccountAgeDays = autoVerifyDefaults.minAccountAge ?? 1;
const maxAccountAgeDays = autoVerifyDefaults.maxAccountAge ?? 365;
const defaultAccountAgeDays = autoVerifyDefaults.defaultAccountAgeDays ?? 7;

export default {
    data: new SlashCommandBuilder()
        .setName("autoverify")
        .setDescription("Configure automatic verification settings")
        .setDescriptionLocalizations(localizations('verification.cmd.autoverify.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName("setup")
                .setDescription("Set up automatic verification")
                .setDescriptionLocalizations(localizations('verification.cmd.autoverify.setup.description'))
                .addRoleOption(option =>
                    option
                        .setName("role")
                        .setDescription("Role to assign to users who meet auto-verify criteria")
                        .setDescriptionLocalizations(localizations('verification.cmd.autoverify.setup.role'))
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("criteria")
                        .setDescription("Criteria for automatic verification")
                        .setDescriptionLocalizations(localizations('verification.cmd.autoverify.setup.criteria'))
                        .addChoices(
                            { name: "Account Age", value: "account_age", name_localizations: localizations('verification.cmd.autoverify.setup.choiceAccountAge') },
                            { name: "No Criteria", value: "none", name_localizations: localizations('verification.cmd.autoverify.setup.choiceNone') }
                        )
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option
                        .setName("account_age_days")
                        .setDescription("Minimum account age in days (required for account age criteria)")
                        .setDescriptionLocalizations(localizations('verification.cmd.autoverify.setup.accountAgeDays'))
                        .setMinValue(minAccountAgeDays)
                        .setMaxValue(maxAccountAgeDays)
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("dashboard")
                .setDescription("Open the auto-verification dashboard for customization")
                .setDescriptionLocalizations(localizations('verification.cmd.autoverify.dashboard.description'))
        ),

    async execute(interaction, config, client) {
        const wrappedExecute = withErrorHandling(async () => {
            const subcommand = interaction.options.getSubcommand();
            const guild = interaction.guild;

            switch (subcommand) {
                case "setup":
                    return await handleSetup(interaction, guild, client);
                case "dashboard":
                    return await autoVerifyDashboard.execute(interaction, config, client);
                default:
                    throw createError(
                        `Unknown subcommand: ${subcommand}`,
                        ErrorTypes.VALIDATION,
                        textForInteraction(interaction).t('verification.auto.badSubcommand'),
                        { subcommand }
                    );
            }
        }, { command: 'autoverify', subcommand: interaction.options.getSubcommand() });

        return await wrappedExecute(interaction, config, client);
    }
};

async function handleSetup(interaction, guild, client) {
    const criteria = interaction.options.getString("criteria");
    const accountAgeDays = interaction.options.getInteger("account_age_days") || defaultAccountAgeDays;
    const targetRole = interaction.options.getRole("role");
    // Refusals are private (the admin's Discord language); the summary is posted in the channel
    // (the server's language).
    const tr = textForInteraction(interaction);
    const publicTr = textForInteraction(interaction, { purpose: 'public' });

    await InteractionHelper.safeDefer(interaction);

    try {
        const guildConfig = await getGuildConfig(client, guild.id);
        const welcomeConfig = await getWelcomeConfig(client, guild.id);
        const verificationEnabled = Boolean(guildConfig.verification?.enabled);
        const hasAutoRoleConfigured = Boolean(guildConfig.autoRole) || (Array.isArray(welcomeConfig.roleIds) && welcomeConfig.roleIds.length > 0);

        if (verificationEnabled || hasAutoRoleConfigured) {
            throw createError(
                'Auto-verify enable blocked by conflicting onboarding system',
                ErrorTypes.CONFIGURATION,
                tr.t('verification.auto.conflict'),
                {
                    guildId: guild.id,
                    verificationEnabled,
                    hasAutoRoleConfigured,
                    expected: true,
                    suppressErrorLog: true
                }
            );
        }

        const botMember = guild.members.me;
        if (!botMember) {
            throw createError(
                'Bot member not found in guild cache',
                ErrorTypes.CONFIGURATION,
                tr.t('verification.errors.permsUnknown'),
                { guildId: guild.id }
            );
        }

        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
            throw createError(
                'Missing ManageRoles permission',
                ErrorTypes.PERMISSION,
                tr.t('verification.auto.needManageRoles'),
                { guildId: guild.id }
            );
        }

        // Members who meet the criteria get this role automatically, so it must be harmless and assignable.
        const roleProblem = getRoleAssignmentProblem(targetRole, botMember);
        if (roleProblem) {
            throw createError(
                'Unsafe auto-verify role selected',
                ErrorTypes.PERMISSION,
                roleProblem,
                { guildId: guild.id, roleId: targetRole.id }
            );
        }

        validateAutoVerifyCriteria(criteria, criteria === 'account_age' ? accountAgeDays : 1, { lang: tr.lang });
        
        await updateVerificationSettings(client, guild.id, {
            autoVerify: {
                enabled: true,
                criteria: criteria,
                accountAgeDays: criteria === "account_age" ? accountAgeDays : null,
                roleId: targetRole.id,
                configuredVia: 'setup'
            }
        });

        let criteriaDescription = "";
        switch (criteria) {
            case "account_age":
                criteriaDescription = publicTr.t('verification.auto.criteriaAge', { days: accountAgeDays });
                break;
            case "none":
                criteriaDescription = publicTr.t('verification.auto.criteriaNone');
                break;
        }

        logger.info('Auto-verify enabled', {
            guildId: guild.id,
            criteria,
            accountAgeDays: criteria === 'account_age' ? accountAgeDays : null,
            roleId: targetRole.id
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                publicTr.t('verification.auto.setupTitle'),
                publicTr.t('verification.auto.setupText', { role: String(targetRole), criteria: criteriaDescription })
            )]
        });

    } catch (error) {
        
        throw error;
    }
}