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

// /verification auto setup|dashboard replaces the separate /autoverify command.
const verificationCommand = mergeSubcommands(
    new SlashCommandBuilder()
        .setName("verification")
        .setDescription("Manage the server verification system")
        .addSubcommand(subcommand =>
            subcommand
                .setName("setup")
                .setDescription("Set up the verification system")
                .addChannelOption(option =>
                    option
                        .setName("verification_channel")
                        .setDescription("Channel where verification messages will be sent")
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option
                        .setName("verified_role")
                        .setDescription("Role to give to verified users")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("message")
                        .setDescription("Custom verification message")
                        .setMaxLength(2000)
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName("button_text")
                        .setDescription("Text for the verification button")
                        .setMaxLength(80)
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("remove")
                .setDescription("Remove verification from a user")
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription("User to remove verification from")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("dashboard")
                .setDescription("Open the verification system configuration dashboard")
        ),
    {
        auto: { module: autoVerify, description: 'Automatic verification (verify members on join by rules)' },
    },
);

export default {
    data: verificationCommand.data,

    async execute(interaction, config, client) {
        if (await verificationCommand.run(interaction, config, client)) return;

        const wrappedExecute = withErrorHandling(async () => {
            const subcommand = interaction.options.getSubcommand();
            const guild = interaction.guild;

            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                throw createError(
                    'Missing ManageGuild permission for verification admin subcommand',
                    ErrorTypes.PERMISSION,
                    'You need the **Manage Server** permission to use this verification subcommand.',
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
                        "Please select a valid subcommand.",
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

    // Checks (permissions, role hierarchy, AutoVerify/AutoRole conflicts) run before
    // the defer, as before; posting and saving follow. All in
    // services/verificationPanelService.js, shared with the web dashboard.
    await checkVerificationSetup(client, guild, { channel: verificationChannel, role: verifiedRole });

    await InteractionHelper.safeDefer(interaction);

    await setupVerification(client, guild, { channel: verificationChannel, role: verifiedRole, message, buttonText });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            'Verification System Updated',
            [
                `Channel: ${verificationChannel}`,
                `Verified Role: ${verifiedRole}`,
                `Button Text: ${buttonText}`
            ].join('\n')
        )]
    });
}

async function handleRemove(interaction, guild, client) {
    const targetUser = interaction.options.getUser("user");

    const result = await removeVerification(client, guild.id, targetUser.id, {
        moderatorId: interaction.user.id,
        reason: 'admin_removal'
    });

    if (result.status === 'not_verified') {
        return await InteractionHelper.safeReply(interaction, {
            embeds: [infoEmbed('Not Verified', `${targetUser.tag} does not currently have the verified role.`)],
            flags: MessageFlags.Ephemeral
        });
    }

    logger.info('Verification removed via command', {
        guildId: guild.id,
        targetUserId: targetUser.id,
        moderatorId: interaction.user.id
    });

    return await InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Verification Removed', `Verification removed from ${targetUser.tag}.`)]
    });
}
