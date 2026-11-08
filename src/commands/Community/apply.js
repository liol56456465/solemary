import { getColor, getDefaultApplicationQuestions } from '../../config/bot.js';
import { normalizeApplicationQuestions, MAX_ANSWER_LENGTH } from '../../utils/applicationQuestions.js';
import { SlashCommandBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import ApplicationService from '../../services/applicationService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { textForInteraction } from '../../utils/botText.js';
import { describe } from '../../utils/commandLocalizations.js';
import { getApplicationStatusPresentation } from '../../services/applicationReviewService.js';
import { logEvent, EVENT_TYPES, resolveApplicationLogChannel } from '../../services/loggingService.js';
import { formatLogLine, resolveUserAuthor } from '../../utils/logging/logEmbeds.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { 
    getApplicationSettings, 
    getUserApplications, 
    createApplication, 
    getApplication,
    getApplicationRoles,
    updateApplication,
    getApplicationRoleSettings
} from '../../utils/database.js';

export default {
    slashOnly: true,
    data: describe(new SlashCommandBuilder()
        .setName("apply"), 'community.cmd.apply.description')
        .addSubcommand((subcommand) =>
            describe(subcommand
                .setName("submit"), 'community.cmd.apply.submit.description')
                .addStringOption((option) =>
                    describe(option
                        .setName("application"), 'community.cmd.apply.submit.application')
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
        )
        .addSubcommand((subcommand) =>
            describe(subcommand
                .setName("status"), 'community.cmd.apply.status.description')
                .addStringOption((option) =>
                    describe(option
                        .setName("id"), 'community.cmd.apply.status.id')
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            describe(subcommand
                .setName("list"), 'community.cmd.apply.list.description'),
        ),

    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        const tr = textForInteraction(interaction);
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('community.apply.serverOnly') });
        }

        const { options, guild, member } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand !== "submit") {
            const isListCommand = subcommand === "list";
            await InteractionHelper.safeDefer(interaction, { flags: isListCommand ? [] : ["Ephemeral"] });
        }

        logger.info(`Apply command executed: ${subcommand}`, {
            userId: interaction.user.id,
            guildId: guild.id,
            subcommand
        });

        const settings = await getApplicationSettings(
            interaction.client,
            guild.id,
        );
        
        if (!settings.enabled) {
            throw createError(
                'Applications are disabled',
                ErrorTypes.CONFIGURATION,
                tr.t('community.apply.disabled'),
                { guildId: guild.id }
            );
        }

        if (subcommand === "submit") {
            await handleSubmit(interaction, settings);
        } else if (subcommand === "status") {
            await handleStatus(interaction);
        } else if (subcommand === "list") {
            await handleList(interaction);
        }
    }, { type: 'command', commandName: 'apply' })
};

/**
 * The answers of a submitted application form, one per question (fields q0, q1, …), or null
 * when the form no longer matches the questions (they were edited while it was open: a field is
 * missing, or there is one more than there are questions).
 */
export function collectApplicationAnswers(fields, questions) {
    const read = (id) => {
        try {
            return fields.getTextInputValue(id);
        } catch {
            return undefined;
        }
    };
    const answers = [];
    for (let i = 0; i < questions.length; i++) {
        const answer = read(`q${i}`);
        if (answer === undefined || answer === null) return null;
        answers.push({ question: questions[i].question, answer, minLength: questions[i].minLength });
    }
    if (read(`q${questions.length}`) !== undefined) return null;
    return answers;
}

export async function handleApplicationModal(interaction) {
    if (!interaction.isModalSubmit()) return;
    
    const customId = interaction.customId;
    if (!customId.startsWith('app_modal_')) return;

    // Several DB reads + the submission run before the first reply; acknowledge
    // within Discord's 3 s window so the modal does not show "interaction failed".
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;
    const tr = textForInteraction(interaction);

    const roleId = customId.split('_')[2];
    
    const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    const applicationRole = applicationRoles.find(appRole => appRole.roleId === roleId);
    
    if (!applicationRole) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: tr.t('community.apply.configNotFound') });
    }

    // It may have been disabled while the form was open.
    if (applicationRole.enabled === false) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: tr.t('community.apply.closed', { name: applicationRole.name }) });
    }
    
    const role = interaction.guild.roles.cache.get(roleId);
    
    if (!role) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('community.apply.roleNotFound') });
    }
    
    const answers = [];
    const settings = await getApplicationSettings(interaction.client, interaction.guild.id);

    let questions = settings.questions?.length ? settings.questions : getDefaultApplicationQuestions();
    const roleSettings = await getApplicationRoleSettings(interaction.client, interaction.guild.id, roleId);
    if (roleSettings.questions && roleSettings.questions.length > 0) {
        questions = roleSettings.questions;
    }
    
    questions = normalizeApplicationQuestions(questions);
    // The questions may have been edited while the form was open: then the fields no longer
    // match them, and the answers would land under the wrong questions.
    const collected = collectApplicationAnswers(interaction.fields, questions);
    if (!collected) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('community.apply.questionsChanged') });
    }
    answers.push(...collected);
    try {
        const application = await ApplicationService.submitApplication(interaction.client, {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            roleId: roleId,
            roleName: applicationRole.name,
            username: interaction.user.tag,
            avatar: interaction.user.displayAvatarURL(),
            answers: answers
        });
        
        // The application is saved; posting it for staff can fail (no channel, missing
        // permissions). The reply says which of the two happened.
        let postedToStaff = false;
        try {
            const settings = await getApplicationSettings(interaction.client, interaction.guild.id);
            const roleSettings = await getApplicationRoleSettings(interaction.client, interaction.guild.id, roleId);
            const guildConfig = await getGuildConfig(interaction.client, interaction.guild.id);

            const logChannelId = resolveApplicationLogChannel(guildConfig, roleSettings, settings);

            if (logChannelId) {
                const logMessage = await logEvent({
                    client: interaction.client,
                    guildId: interaction.guild.id,
                    eventType: EVENT_TYPES.APPLICATION_SUBMIT,
                    channelId: logChannelId,
                    data: {
                        title: 'New application',
                        lines: [
                            formatLogLine('Applicant', `<@${interaction.user.id}> (${interaction.user.tag})`),
                            formatLogLine('Application', applicationRole.name),
                            formatLogLine('Role', role.name),
                            formatLogLine('Application ID', `\`${application.id}\``),
                        ],
                        inlineFields: [
                            { name: 'Status', value: 'In Progress', inline: true },
                        ],
                        author: await resolveUserAuthor(interaction.client, interaction.user.id),
                    },
                });

                if (logMessage) {
                    postedToStaff = true;
                    await updateApplication(interaction.client, interaction.guild.id, application.id, {
                        logMessageId: logMessage.id,
                        logChannelId,
                    }).catch((error) => logger.warn(`Application ${application.id}: log message id not saved: ${error.message}`));
                }
            }
        } catch (error) {
            logger.warn(`Application ${application.id} saved but not posted for staff: ${error.message}`);
        }

        const embed = successEmbed(
            postedToStaff ? tr.t('community.apply.sent.title') : tr.t('community.apply.saved.title'),
            (postedToStaff
                ? tr.t('community.apply.sent.body', { name: applicationRole.name })
                : tr.t('community.apply.saved.body', { name: applicationRole.name })) + '\n\n' +
            tr.t('community.apply.idLine', { id: application.id }) + '\n' +
            tr.t('community.apply.statusHint', { id: application.id })
        );

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
        
    } catch (error) {
        logger.error('Error creating application:', {
            error: error.message,
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            roleId,
            stack: error.stack
        });
        
        await handleInteractionError(interaction, error, {
            type: 'modal',
            handler: 'application_submission'
        });
    }
}

async function handleList(interaction) {
    const tr = textForInteraction(interaction);
    // /apply list is posted in the channel (not ephemeral): the server's language.
    const trPublic = textForInteraction(interaction, { purpose: 'public' });
    try {
        const applicationRoles = (await getApplicationRoles(interaction.client, interaction.guild.id))
            .filter((appRole) => appRole.enabled !== false);
        
        if (applicationRoles.length === 0) {
            return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('community.apply.list.none') });
        }

        const embed = createEmbed({
            title: trPublic.t('community.apply.list.title'),
            description: trPublic.t('community.apply.list.description')
        });

        applicationRoles.forEach((appRole, index) => {
            const role = interaction.guild.roles.cache.get(appRole.roleId);
            embed.addFields({
                name: `${index + 1}. ${appRole.name}`,
                value: trPublic.t('community.apply.list.entry', {
                    role: role ? `<@&${appRole.roleId}>` : trPublic.t('community.apply.list.roleMissing'),
                    name: appRole.name,
                }),
                inline: false
            });
        });

        embed.setFooter({
            text: trPublic.t('community.apply.list.footer')
        });

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    } catch (error) {
        logger.error('Error listing applications:', {
            error: error.message,
            guildId: interaction.guild.id,
            stack: error.stack
        });
        
        throw createError(
            'Failed to load applications',
            ErrorTypes.DATABASE,
            tr.t('community.apply.list.loadFailed'),
            { guildId: interaction.guild.id }
        );
    }
}

async function handleSubmit(interaction, settings) {
    const applicationName = interaction.options.getString("application");
    const member = interaction.member;
    const tr = textForInteraction(interaction);

    const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    
    const applicationRole = applicationRoles.find(appRole => 
        appRole.name.toLowerCase() === applicationName.toLowerCase()
    );

    if (!applicationRole) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('community.apply.submit.notFound') });
    }

    if (applicationRole.enabled === false) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: tr.t('community.apply.submit.closed', { name: applicationRole.name }) });
    }

    const userApps = await getUserApplications(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
    );
    const pendingApp = userApps.find((app) => app.status === "pending");

    if (pendingApp) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('community.apply.submit.pending') });
    }

    const role = interaction.guild.roles.cache.get(applicationRole.roleId);
    if (!role) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('community.apply.submit.roleGone') });
    }

    const modal = new ModalBuilder()
        .setCustomId(`app_modal_${applicationRole.roleId}`)
        .setTitle(tr.t('community.apply.submit.modalTitle', { name: applicationRole.name }).slice(0, 45));

    let questions = settings.questions?.length ? settings.questions : getDefaultApplicationQuestions();
    const roleSettings = await getApplicationRoleSettings(interaction.client, interaction.guild.id, applicationRole.roleId);
    if (roleSettings.questions && roleSettings.questions.length > 0) {
        questions = roleSettings.questions;
    }

    normalizeApplicationQuestions(questions).forEach(({ question, minLength }, index) => {
        const input = new TextInputBuilder()
            .setCustomId(`q${index}`)
            .setLabel(
                question.length > 45
                    ? `${question.substring(0, 42)}...`
                    : question,
            )
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMinLength(minLength)
            .setMaxLength(MAX_ANSWER_LENGTH);

        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
    });

    await interaction.showModal(modal);
}

async function handleStatus(interaction) {
    const appId = interaction.options.getString("id");
    const tr = textForInteraction(interaction);

    if (appId) {
        const application = await getApplication(
            interaction.client,
            interaction.guild.id,
            appId,
        );

        if (!application || application.userId !== interaction.user.id) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('community.apply.status.notFound') });
        }

        const submittedAt = application?.createdAt ? new Date(application.createdAt) : null;
        const submittedAtDisplay = submittedAt && !Number.isNaN(submittedAt.getTime())
            ? submittedAt.toLocaleString()
            : tr.t('community.apply.status.unknownDate');
        const statusView = getApplicationStatusPresentation(application.status, { lang: tr.lang });
        const embed = createEmbed({
            title: tr.t('community.apply.status.oneTitle', { id: application.id, role: application.roleName || tr.t('community.apply.status.unknownRole') }),
            description: tr.t('community.apply.status.oneBody', { id: application.id, status: statusView.statusLabel, date: submittedAtDisplay })
        });

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
    } else {
        const applications = await getUserApplications(
            interaction.client,
            interaction.guild.id,
            interaction.user.id,
        );

        if (applications.length === 0) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('community.apply.status.none') });
        }

        const recentApplications = applications
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .slice(0, 10);

        const embed = createEmbed({
            title: tr.t('community.apply.status.allTitle'),
            description: tr.tp('community.apply.status.allDescription', recentApplications.length)
        });

        recentApplications.forEach((application) => {
            const submittedAt = application?.createdAt ? new Date(application.createdAt) : null;
            const submittedAtDisplay = submittedAt && !Number.isNaN(submittedAt.getTime())
                ? submittedAt.toLocaleDateString()
                : tr.t('community.apply.status.unknownDate');
            const statusView = getApplicationStatusPresentation(application.status, { lang: tr.lang });

            embed.addFields({
                name: tr.t('community.apply.status.fieldName', { role: application.roleName || tr.t('community.apply.status.unknownRole'), status: statusView.statusLabel }),
                value: tr.t('community.apply.status.fieldValue', { id: application.id, status: statusView.statusLabel, date: submittedAtDisplay }),
                inline: true,
            });
        });

        if (applications.length > recentApplications.length) {
            embed.setFooter({ text: tr.tp('community.apply.status.footer', applications.length, { shown: recentApplications.length }) });
        }

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
    }
}