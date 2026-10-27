import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

import dashboard from './modules/logging_dashboard.js';
import channel from './modules/logging_channel.js';
import ignore from './modules/logging_ignore.js';

import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
export default {
    data: new SlashCommandBuilder()
        .setName('logging')
        .setDescription('Manage server logging — channels, filters, and event categories.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('dashboard')
                .setDescription('Open the logging dashboard — set channels, filters, and toggle categories.'),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('channel')
                .setDescription('Quick-set a log channel without opening the dashboard.')
                .addStringOption((option) =>
                    option
                        .setName('destination')
                        .setDescription('Which log destination to configure.')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Audit (moderation, messages, members…)', value: 'audit' },
                            { name: 'Applications', value: 'applications' },
                            { name: 'Reports', value: 'reports' },
                        ),
                )
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The text channel for logs.')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false),
                )
                .addBooleanOption((option) =>
                    option
                        .setName('disable')
                        .setDescription('Set to True to clear this log channel.')
                        .setRequired(false),
                ),
        )
        .addSubcommandGroup((group) =>
            group
                .setName('ignore')
                .setDescription('Skip logs for a channel (with its threads / a category) or members with a role.')
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('channel')
                        .setDescription('Ignore a channel or category, or log it again (toggles).')
                        .addChannelOption((option) =>
                            option
                                .setName('channel')
                                .setDescription('Channel or category')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildCategory)
                                .setRequired(true),
                        ),
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('role')
                        .setDescription('Ignore members with a role, or log them again (toggles).')
                        .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true)),
                )
                .addSubcommand((subcommand) =>
                    subcommand.setName('list').setDescription('Show the ignored channels, roles and users.'),
                ),
        ),

    async execute(interaction, config, client) {
        try {
            const subcommand = interaction.options.getSubcommand();

            if (interaction.options.getSubcommandGroup(false) === 'ignore') {
                return await ignore.execute(interaction, config, client);
            }

            if (subcommand === 'dashboard') {
                return await dashboard.execute(interaction, config, client);
            }

            if (subcommand === 'channel') {
                return await channel.execute(interaction, config, client);
            }

            await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This subcommand is not recognised.' });
        } catch (error) {
            logger.error('logging command error:', error);
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An unexpected error occurred.' }).catch(() => {});
        }
    },
};
