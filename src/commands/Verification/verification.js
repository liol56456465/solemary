import { botConfig, getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createEmbed, infoEmbed, successEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { checkVerificationSetup, setupVerification } from '../../services/verificationPanelService.js';
import { withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { removeVerification, verifyUser } from '../../services/verificationService.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getWelcomeConfig } from '../../utils/database.js';
import verificationDashboard from './modules/verification_dashboard.js';
import autoVerify from './modules/autoVerify.js';
import { mergeSubcommands } from '../../utils/mergedCommand.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';

// /verification auto setup|dashboard replaces the separate /autoverify command.
const merged = mergeSubcommands(
    new SlashCommandBuilder()
        .setName("verification")
        .setDescription("Manage the server verification system")
        .setDescriptionLocalizations(localizations('verification.cmd.verification.description'))
        .addSubcommand(subcommand =>
            subcommand
                .setName("setup")
                .setDescription("Set up the verification system")
                .setDescriptionLocalizations(localizations('verification.cmd.verification.setup.description'))
                .addChannelOption(option =>
                    option
                        .setName("verification_channel")
                        .setDescription("Channel where verification messages will be sent")
                        .setDescriptionLocalizations(localizations('verification.cmd.verification.setup.channel'))
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option
                        .setName("verified_role")
                        .setDescription("Role to give to verified users")
                        .setDescriptionLocalizations(localizations('verification.cmd.verification.setup.role'))
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("message")
                        .setDescription("Custom verification message")
                        .setDescriptionLocalizations(localizations('verification.cmd.verification.setup.message'))
                        .setMaxLength(2000)
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName("button_text")
                        .setDescription("Text for the verification button")
                        .setDescriptionLocalizations(localizations('verification.cmd.verification.setup.buttonText'))
                        .setMaxLength(80)
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("remove")
                .setDescription("Remove verification from a user")
                .setDescriptionLocalizations(localizations('verification.cmd.verification.remove.description'))
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription("User to remove verification from")
                        .setDescriptionLocalizations(localizations('verification.cmd.verification.remove.user'))
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("dashboard")
                .setDescription("Open the verification system configuration dashboard")
                .setDescriptionLocalizations(localizations('verification.cmd.verification.dashboard.description'))
        ),
    {
        auto: { module: autoVerify, description: 'Automatic verification (verify members on join by rules)', descriptionLocalizations: localizations('verification.cmd.verification.auto.description') },
    },
);

export default {
    data: merged.data,

    async execute(interaction, config, client) {
        if (await merged.run(interaction, config, client)) return;

        const wrappedExecute = withErrorHandling(async () => {
            const subcommand = interaction.options.getSubcommand();
            const guild = interaction.guild;
            const tr = textForInteraction(interaction);

            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                throw createError(
                    'Missing ManageGuild permission for verification admin subcommand',
                    ErrorTypes.PERMISSION,
                    tr.t('verification.errors.needManageServer'),
                    { subcommand, requiredPermission: 'ManageGuild', userId: interaction.user.id }
                );
            }

            switch (subcommand) {
                case "setup":
                    return await handleSetup(interaction, guild, client);
                case "remove":
                    return await handleRemove(interaction, guild, client);
                case "dashboard":
                    return await verificationDashboard.execute(interaction, config, client);
                default:
                    throw createError(
                        `Unknown subcommand: ${subcommand}`,
                        ErrorTypes.VALIDATION,
                        tr.t('verification.errors.badSubcommand'),
                        { subcommand }
                    );
            }
        }, { command: 'verification', subcommand: interaction.options.getSubcommand() });

        return await wrappedExecute(interaction, config, client);
    }
};

async function handleSetup(interaction, guild, client) {
    const verificationChannel = interaction.options.getChannel("verification_channel");
    const verifiedRole = interaction.options.getRole("verified_role");
    const message = interaction.options.getString("message") || botConfig.verification.defaultMessage;
    const buttonText = interaction.options.getString("button_text") || botConfig.verification.defaultButtonText;
    // Refusals are private (the admin's Discord language); the panel and the summary below are
    // posted in the channel (the server's language).
    const { lang } = textForInteraction(interaction);
    const tr = textForInteraction(interaction, { purpose: 'public' });

    // Checks (permissions, role hierarchy, AutoVerify/AutoRole conflicts) run before
    // the defer, as before; posting and saving follow. All in
    // services/verificationPanelService.js, shared with the web dashboard.
    await checkVerificationSetup(client, guild, { channel: verificationChannel, role: verifiedRole, lang });

    await InteractionHelper.safeDefer(interaction);

    await setupVerification(client, guild, { channel: verificationChannel, role: verifiedRole, message, buttonText, lang });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            tr.t('verification.setup.title'),
            [
                tr.t('verification.setup.channel', { channel: String(verificationChannel) }),
                tr.t('verification.setup.role', { role: String(verifiedRole) }),
                tr.t('verification.setup.button', { text: buttonText })
            ].join('\n')
        )]
    });
}

async function handleRemove(interaction, guild, client) {
    const targetUser = interaction.options.getUser("user");
    const tr = textForInteraction(interaction);
    const publicTr = textForInteraction(interaction, { purpose: 'public' });

    const result = await removeVerification(client, guild.id, targetUser.id, {
        moderatorId: interaction.user.id,
        reason: 'admin_removal',
        lang: tr.lang,
    });

    if (result.status === 'not_verified') {
        return await InteractionHelper.safeReply(interaction, {
            embeds: [infoEmbed(tr.t('verification.remove.notTitle'), tr.t('verification.remove.notText', { user: targetUser.tag }))],
            flags: MessageFlags.Ephemeral
        });
    }

    logger.info('Verification removed via command', {
        guildId: guild.id,
        targetUserId: targetUser.id,
        moderatorId: interaction.user.id
    });

    return await InteractionHelper.safeReply(interaction, {
        // Not ephemeral: posted in the channel, so the server's language.
        embeds: [successEmbed(publicTr.t('verification.remove.doneTitle'), publicTr.t('verification.remove.doneText', { user: targetUser.tag }))]
    });
}
