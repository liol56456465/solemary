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
import { textForInteraction } from '../../utils/botText.js';
import { describe, descriptionLocalizations } from '../../utils/commandLocalizations.js';
import appDashboard from './modules/app_dashboard.js';
import { createApplicationRole } from '../../services/applicationRoleService.js';
import { getApplicationStatusPresentation, reviewApplicationAndNotify } from '../../services/applicationReviewService.js';

export default {
    data: describe(new SlashCommandBuilder()
    .setName("app-admin"), 'community.cmd.appAdmin.description')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
        describe(subcommand
            .setName("setup"), 'community.cmd.appAdmin.setup.description')
    )
    .addSubcommand((subcommand) =>
        describe(subcommand
            .setName("review"), 'community.cmd.appAdmin.review.description')
            .addStringOption((option) =>
                describe(option
                    .setName("id"), 'community.cmd.appAdmin.review.id')
                    .setRequired(true),
            ),
    )
    .addSubcommand((subcommand) =>
        describe(subcommand
            .setName("list"), 'community.cmd.appAdmin.list.description')
            .addStringOption((option) =>
                describe(option
                    .setName("status"), 'community.cmd.appAdmin.list.status')
                    .addChoices(
                        { name: "Pending", name_localizations: descriptionLocalizations('community.cmd.appAdmin.list.choice.pending'), value: "pending" },
                        { name: "Approved", name_localizations: descriptionLocalizations('community.cmd.appAdmin.list.choice.approved'), value: "approved" },
                        { name: "Denied", name_localizations: descriptionLocalizations('community.cmd.appAdmin.list.choice.denied'), value: "denied" },
                    ),
            )
            .addStringOption((option) =>
                describe(option.setName("role"), 'community.cmd.appAdmin.list.role'),
            )
            .addUserOption((option) =>
                describe(option.setName("user"), 'community.cmd.appAdmin.list.user'),
            )
            .addNumberOption((option) =>
                describe(option
                    .setName("limit"), 'community.cmd.appAdmin.list.limit')
                    .setMinValue(1)
                    .setMaxValue(25),
            ),
    )
    .addSubcommand((subcommand) =>
        describe(subcommand
            .setName("dashboard"), 'community.cmd.appAdmin.dashboard.description')
            .addStringOption((option) =>
                describe(option
                    .setName("application"), 'community.cmd.appAdmin.dashboard.application')
                    .setRequired(false)
                    .setAutocomplete(true),
            ),
    ),

    category: "Community",

    // /app-admin setup answers with a form: exempt from the 3-second safety net.
    opensModal: (interaction) => interaction.options?.getSubcommand?.(false) === 'setup',
    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: textForInteraction(interaction).t('community.apply.serverOnly') });
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
    const tr = textForInteraction(interaction);

    if (interaction.deferred || interaction.replied) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('community.appAdmin.alreadyProcessed') });
    }

    const modal = new ModalBuilder()
        .setCustomId('app_setup_modal')
        .setTitle(tr.t('community.appAdmin.setup.modalTitle'));

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('role_id')
        .setPlaceholder(tr.t('community.appAdmin.setup.rolePlaceholder'))
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel(tr.t('community.appAdmin.setup.roleLabel'))
        .setDescription(tr.t('community.appAdmin.setup.roleDescription'))
        .setRoleSelectMenuComponent(roleSelect);

    const appNameInput = new TextInputBuilder()
        .setCustomId('app_name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(tr.t('community.appAdmin.setup.namePlaceholder'))
        .setMaxLength(50)
        .setMinLength(1)
        .setRequired(true);

    const appNameLabel = new LabelBuilder()
        .setLabel(tr.t('community.appAdmin.setup.nameLabel'))
        .setTextInputComponent(appNameInput);

    const q1Input = new TextInputBuilder()
        .setCustomId('app_question_1')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(tr.t('community.appAdmin.setup.q1Placeholder'))
        .setMaxLength(112)
        .setMinLength(1)
        .setRequired(true);

    const q1Label = new LabelBuilder()
        .setLabel(tr.t('community.appAdmin.questionRequired', { number: 1 }))
        .setTextInputComponent(q1Input);

    const q2Input = new TextInputBuilder()
        .setCustomId('app_question_2')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(tr.t('community.appAdmin.setup.q2Placeholder'))
        .setMaxLength(112)
        .setRequired(false);

    const q2Label = new LabelBuilder()
        .setLabel(tr.t('community.appAdmin.questionOptional', { number: 2 }))
        .setTextInputComponent(q2Input);

    const q3Input = new TextInputBuilder()
        .setCustomId('app_question_3')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(112)
        .setRequired(false);

    const q3Label = new LabelBuilder()
        .setLabel(tr.t('community.appAdmin.questionOptional', { number: 3 }))
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
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: tr.t('community.appAdmin.setup.noRole') });
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
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: tr.t('community.appAdmin.setup.roleNotFound') });
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
            tr.t('community.appAdmin.setup.createdTitle'),
            tr.t('community.appAdmin.setup.createdBody', { name: appName, role: String(role) }),
        )],
        flags: ['Ephemeral'],
    });

    // Opens the settings panel right after; a failure there must not become an unhandled rejection.
    setTimeout(() => {
        Promise.resolve()
            .then(() => appDashboard.execute(submitted, null, interaction.client, appName))
            .catch((error) => logger.error(`Application dashboard after create failed: ${error.message}`));
    }, 500);
}

async function handleReview(interaction) {
    const appId = interaction.options.getString("id");
    const tr = textForInteraction(interaction);

    const application = await getApplication(
        interaction.client,
        interaction.guild.id,
        appId,
    );
    if (!application) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('community.appAdmin.review.notFound') });
    }

    if (application.status !== "pending") {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('community.appAdmin.review.processed') });
    }

    const appEmbed = createEmbed({
        title: tr.t('community.appAdmin.review.title'),
        description: tr.t('community.appAdmin.review.body', { userId: application.userId, name: application.roleName, id: appId }),
        color: 'info',
    });

    if (application.answers && application.answers.length > 0) {
        application.answers.forEach((item, index) => {
            appEmbed.addFields({
                name: tr.t('community.appAdmin.review.question', { number: index + 1, question: item.question }),
                value: item.answer || tr.t('community.appAdmin.review.noAnswer'),
                inline: false
            });
        });
    }

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_review_approve_${appId}`)
            .setLabel(tr.t('community.appAdmin.review.approve'))
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`app_review_deny_${appId}`)
            .setLabel(tr.t('community.appAdmin.review.deny'))
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
            .setTitle(isApprove ? tr.t('community.appAdmin.review.approveTitle') : tr.t('community.appAdmin.review.denyTitle'));

        reasonModal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('review_reason')
                    .setLabel(tr.t('community.appAdmin.review.reasonLabel'))
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder(tr.t('community.appAdmin.review.reasonPlaceholder'))
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
                    status === 'approved'
                        ? successEmbed(tr.t('community.appAdmin.review.approvedTitle'), tr.t('community.appAdmin.review.approvedBody'))
                        : successEmbed(tr.t('community.appAdmin.review.deniedTitle'), tr.t('community.appAdmin.review.deniedBody')),
                ],
                flags: ["Ephemeral"],
            });

        } catch (error) {
            logger.error('Error reviewing application:', error);
            await replyUserError(buttonInteraction, { type: ErrorTypes.UNKNOWN, message: tr.t('community.appAdmin.review.failed') });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            const timeoutEmbed = createEmbed({
                title: tr.t('community.appAdmin.review.timeoutTitle'),
                description: tr.t('community.appAdmin.review.timeoutBody'),
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
    const tr = textForInteraction(interaction);

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
                title: tr.t('community.appAdmin.list.noneTitle'),
                description: tr.t('community.appAdmin.list.noneDescription')
            });

            applicationRoles.forEach((appRole, index) => {
                const role = interaction.guild.roles.cache.get(appRole.roleId);
                embed.addFields({
                    name: `${index + 1}. ${appRole.name}`,
                    value: tr.t('community.appAdmin.list.roleEntry', { role: role ? `<@&${appRole.roleId}>` : tr.t('community.apply.list.roleMissing') }),
                    inline: false
                });
            });

            embed.setFooter({
                text: tr.t('community.appAdmin.list.footer')
            });

            return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
        } else {
            return await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: tr.t('community.appAdmin.list.noneConfigured')
            });
        }
    }

    applications = applications
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);

    const embed = createEmbed({ title: tr.t('community.appAdmin.list.title'), description: tr.tp('community.appAdmin.list.description', applications.length) });

    applications.forEach((app) => {
        const statusView = getApplicationStatusPresentation(app?.status, { lang: tr.lang });
        const roleName = app?.roleName || tr.t('community.apply.status.unknownRole');
        const username = app?.username || tr.t('community.appAdmin.list.unknownUser');
        const createdAt = app?.createdAt ? new Date(app.createdAt) : null;
        const createdAtDisplay = createdAt && !Number.isNaN(createdAt.getTime())
            ? createdAt.toLocaleString()
            : tr.t('community.apply.status.unknownDate');

        embed.addFields({
            name: `${roleName} - ${username}`,
            value: tr.t('community.appAdmin.list.entry', { id: app.id, status: statusView.statusLabel, date: createdAtDisplay }),
            inline: true,
        });
    });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [embed],
        flags: ["Ephemeral"],
    });
}

