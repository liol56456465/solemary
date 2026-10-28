import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ComponentType, LabelBuilder, RoleSelectMenuBuilder } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { getColor, getApplicationStatusColor } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import { withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import ApplicationService from '../../services/applicationService.js';
import { parseApplicationQuestionInput } from '../../utils/applicationQuestions.js';
import { 
    getApplicationSettings, 
    saveApplicationSettings, 
    getApplication, 
    getApplications, 
    updateApplication,
    getApplicationRoles,
    saveApplicationRoles,
    getApplicationRoleSettings,
    saveApplicationRoleSettings
} from '../../utils/database.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import appDashboard from './modules/app_dashboard.js';
import { createApplicationRole } from '../../services/applicationRoleService.js';
import { getApplicationStatusPresentation, reviewApplicationAndNotify } from '../../services/applicationReviewService.js';

export default {
    data: new SlashCommandBuilder()
    .setName("app-admin")
    .setDescription("Manage staff applications")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
        subcommand
            .setName("setup")
            .setDescription("Set up a new application")
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("review")
            .setDescription("Approve or deny an application")
            .addStringOption((option) =>
                option
                    .setName("id")
                    .setDescription("The application ID")
                    .setRequired(true),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("list")
            .setDescription("List all applications")
            .addStringOption((option) =>
                option
                    .setName("status")
                    .setDescription("Filter by status")
                    .addChoices(
                        { name: "Pending", value: "pending" },
                        { name: "Approved", value: "approved" },
                        { name: "Denied", value: "denied" },
                    ),
            )
            .addStringOption((option) =>
                option.setName("role").setDescription("Filter by role ID"),
            )
            .addUserOption((option) =>
                option.setName("user").setDescription("Filter by user"),
            )
            .addNumberOption((option) =>
                option
                    .setName("limit")
                    .setDescription(
                        "Maximum number of applications to show (default: 10)",
                    )
                    .setMinValue(1)
                    .setMaxValue(25),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("dashboard")
            .setDescription("Open the applications configuration dashboard")
            .addStringOption((option) =>
                option
                    .setName("application")
                    .setDescription("Select an application to configure")
                    .setRequired(false)
                    .setAutocomplete(true),
            ),
    ),

    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        }

        const { options, guild, member } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand !== 'dashboard' && subcommand !== 'setup') {
            await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });
        }

        logger.info(`App-admin command executed: ${subcommand}`, {
            userId: interaction.user.id,
            guildId: guild.id,
            subcommand
        });

        await ApplicationService.checkManagerPermission(interaction.client, guild.id, member);

        if (subcommand === "setup") {
            await handleSetup(interaction);
        } else if (subcommand === "review") {
            await handleReview(interaction);
        } else if (subcommand === "list") {
            await handleList(interaction);
        } else if (subcommand === "dashboard") {
            const selectedAppName = interaction.options.getString("application");
            await appDashboard.execute(interaction, null, interaction.client, selectedAppName);
        }
    }, { type: 'command', commandName: 'app-admin' })
};

async function handleSetup(interaction) {
    
    if (interaction.deferred || interaction.replied) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This interaction has already been processed. Please try the command again.' });
    }

    const modal = new ModalBuilder()
        .setCustomId('app_setup_modal')
        .setTitle('Set Up New Application');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('role_id')
        .setPlaceholder('Select the role users will apply for')
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Application Role')
        .setDescription('The role that users will be applying for')
        .setRoleSelectMenuComponent(roleSelect);

    const appNameInput = new TextInputBuilder()
        .setCustomId('app_name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., Moderator, Helper, Developer')
        .setMaxLength(50)
        .setMinLength(1)
        .setRequired(true);

    const appNameLabel = new LabelBuilder()
        .setLabel('Application Name')
        .setTextInputComponent(appNameInput);

    const q1Input = new TextInputBuilder()
        .setCustomId('app_question_1')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Why do you want this role?')
        .setMaxLength(112)
        .setMinLength(1)
        .setRequired(true);

    const q1Label = new LabelBuilder()
        .setLabel('Question 1 (required)')
        .setTextInputComponent(q1Input);

    const q2Input = new TextInputBuilder()
        .setCustomId('app_question_2')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('What experience do you have?')
        .setMaxLength(112)
        .setRequired(false);

    const q2Label = new LabelBuilder()
        .setLabel('Question 2 (optional)')
        .setTextInputComponent(q2Input);

    const q3Input = new TextInputBuilder()
        .setCustomId('app_question_3')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(112)
        .setRequired(false);

    const q3Label = new LabelBuilder()
        .setLabel('Question 3 (optional)')
        .setTextInputComponent(q3Input);

    modal.addLabelComponents(roleLabel, appNameLabel, q1Label, q2Label, q3Label);

    await interaction.showModal(modal);

    const submitted = await interaction.awaitModalSubmit({
        time: 15 * 60 * 1000, 
        filter: (i) =>
            i.customId === 'app_setup_modal' &&
            i.user.id === interaction.user.id,
    }).catch(() => null);

    if (!submitted) {
        logger.info('App setup modal dismissed or timed out', { guildId: interaction.guild.id, userId: interaction.user.id });
        return;
    }

    const appName = submitted.fields.getTextInputValue('app_name').trim();
    const selectedRoles = submitted.fields.getSelectedRoles('role_id');
    const roleId = selectedRoles.first()?.id;

    if (!roleId) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: 'You must select a role for the application.' });
        return;
    }

    // A trailing "[min:N]" sets that question's minimum answer length.
    const questions = [
        submitted.fields.getTextInputValue('app_question_1'),
        submitted.fields.getTextInputValue('app_question_2'),
        submitted.fields.getTextInputValue('app_question_3'),
    ].map(parseApplicationQuestionInput).filter(Boolean);

    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'The selected role could not be found.' });
        return;
    }

    // Duplicate check, atomic save, the role's questions and turning the system on:
    // services/applicationRoleService.js (shared with the web dashboard).
    try {
        await createApplicationRole(interaction.client, interaction.guild.id, {
            roleId, name: appName, questions, enabled: true, enableSystem: true,
        });
    } catch (error) {
        if (!error.userMessage || error.type !== ErrorTypes.VALIDATION) throw error;
        await replyUserError(submitted, { type: ErrorTypes.CONFIGURATION, message: error.userMessage.replace('This role', `The role ${role}`) });
        return;
    }

    await submitted.reply({
        embeds: [successEmbed(
            '✅ Application Created',
            `**${appName}** application has been created for ${role}.\n\nYou can customize the log channel, manager roles, questions, and retention period in the dashboard.`,
        )],
        flags: ['Ephemeral'],
    });

    setTimeout(() => {
        appDashboard.execute(submitted, null, interaction.client, appName);
    }, 500);
}

async function handleReview(interaction) {
    const appId = interaction.options.getString("id");

    const application = await getApplication(
        interaction.client,
        interaction.guild.id,
        appId,
    );
    if (!application) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Application not found.' });
    }

    if (application.status !== "pending") {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This application has already been processed.' });
    }

    const appEmbed = createEmbed({
        title: `Review Application`,
        description: `**User:** <@${application.userId}>\n**Application:** ${application.roleName}\n**Application ID:** \`${appId}\``,
        color: 'info',
    });

    if (application.answers && application.answers.length > 0) {
        application.answers.forEach((item, index) => {
            appEmbed.addFields({
                name: `Q${index + 1}: ${item.question}`,
                value: item.answer || '*No answer provided*',
                inline: false
            });
        });
    }

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_review_approve_${appId}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`app_review_deny_${appId}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger),
    );

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [appEmbed],
        components: [buttonRow],
        flags: ["Ephemeral"],
    });

    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i =>
            i.user.id === interaction.user.id &&
            (i.customId.startsWith(`app_review_approve_${appId}`) ||
             i.customId.startsWith(`app_review_deny_${appId}`)),
        time: 300_000, 
        max: 1,
    });

    collector.on('collect', async buttonInteraction => {
        const isApprove = buttonInteraction.customId.includes('approve');

        const reasonModal = new ModalBuilder()
            .setCustomId(`app_review_reason_${appId}_${isApprove ? 'approve' : 'deny'}`)
            .setTitle(`${isApprove ? 'Approve' : 'Deny'} Application - Reason`);

        reasonModal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('review_reason')
                    .setLabel('Reason (optional)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Provide a reason for this decision...')
                    .setMaxLength(500)
                    .setRequired(false),
            ),
        );

        await buttonInteraction.showModal(reasonModal);

        try {
            const reasonSubmit = await buttonInteraction.awaitModalSubmit({
                time: 5 * 60 * 1000, 
                filter: i =>
                    i.customId === `app_review_reason_${appId}_${isApprove ? 'approve' : 'deny'}` &&
                    i.user.id === buttonInteraction.user.id,
            }).catch(() => null);

            if (!reasonSubmit) return;

            const reason = reasonSubmit.fields.getTextInputValue('review_reason').trim() || "No reason provided.";
            const action = isApprove ? 'approve' : 'deny';

            // Status, DM, log message and role: services/applicationReviewService.js
            // (shared with the web dashboard).
            const { status } = await reviewApplicationAndNotify(reasonSubmit.client, interaction.guild, appId, {
                action,
                reason,
                reviewerId: reasonSubmit.user.id,
            });

            await reasonSubmit.reply({
                embeds: [
                    successEmbed(
                        `Application ${status}`,
                        `The application has been **${status}**.`,
                    ),
                ],
                flags: ["Ephemeral"],
            });

        } catch (error) {
            logger.error('Error reviewing application:', error);
            await replyUserError(buttonInteraction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while reviewing the application.' });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            const timeoutEmbed = createEmbed({
                title: 'Review Timeout',
                description: 'The review buttons have timed out.',
                color: 'warning',
            });

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [timeoutEmbed],
                components: [],
            }).catch(() => {});
        }
    });
}

async function handleList(interaction) {
    const status = interaction.options.getString("status");
    const user = interaction.options.getUser("user");
    const limit = interaction.options.getNumber("limit") || 10;

    const filters = {};
    
    if (status) {
        filters.status = status;
    } else {
        filters.status = 'pending';
    }

    let applications = await getApplications(
        interaction.client,
        interaction.guild.id,
        filters,
    );

    if (!user) {
        // Hide applicants who left the server. Viewing the list never deletes anything, and
        // only a definite "Unknown Member" (10007) hides one; other fetch errors keep it listed.
        const visible = [];
        for (const app of applications) {
            if (interaction.guild.members.cache.has(app.userId)) {
                visible.push(app);
                continue;
            }
            try {
                await interaction.guild.members.fetch(app.userId);
                visible.push(app);
            } catch (error) {
                if (error?.code !== 10007) visible.push(app);
            }
        }
        applications = visible;
    }

    if (user) {
        applications = applications.filter((app) => app.userId === user.id);
    }

    if (applications.length === 0) {
        const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
        
        if (applicationRoles.length > 0) {
            const embed = createEmbed({ 
                title: "No Applications Found", 
                description: "No submitted applications found matching the specified criteria.\n\nHowever, the following application roles are configured:" 
            });

            applicationRoles.forEach((appRole, index) => {
                const role = interaction.guild.roles.cache.get(appRole.roleId);
                embed.addFields({
                    name: `${index + 1}. ${appRole.name}`,
                    value: `**Role:** ${role ?`<@&${appRole.roleId}>`: 'Role not found'}\n**Available for applications:** Yes`,
                    inline: false
                });
            });

            embed.setFooter({
                text: "Users can apply with /apply submit or see available roles with /apply list"
            });

            return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
        } else {
            return await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: 'No applications found and no application roles configured.\n' +
                    'Use `/app-admin roles add` to configure application roles first.'
            });
        }
    }

    applications = applications
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);

    const embed = createEmbed({ title: "Submitted Applications", description: `Showing ${applications.length} applications.`, });

    applications.forEach((app) => {
        const statusView = getApplicationStatusPresentation(app?.status);
        const roleName = app?.roleName || 'Unknown Role';
        const username = app?.username || 'Unknown User';
        const createdAt = app?.createdAt ? new Date(app.createdAt) : null;
        const createdAtDisplay = createdAt && !Number.isNaN(createdAt.getTime())
            ? createdAt.toLocaleString()
            : 'Unknown date';

        embed.addFields({
            name: `${statusView.statusEmoji} ${roleName} - ${username}`,
            value:
                `**ID:** \`${app.id}\`\n` +
                `**Status:** ${statusView.statusEmoji} ${statusView.statusLabel}\n` +
                `**Date:** ${createdAtDisplay}`,
            inline: true,
        });
    });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [embed],
        flags: ["Ephemeral"],
    });
}

