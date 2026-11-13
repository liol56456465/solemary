import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

import dashboard from './modules/logging_dashboard.js';
import channel from './modules/logging_channel.js';
import ignore from './modules/logging_ignore.js';

import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';

// English choice names of the per-kind log channels (the other languages: content/bot/<lang>/logging.json).
const CHOICE_NAMES = {
    moderation: 'Moderation (purge, lock, slowmode…)', members: 'Members (joins, leaves, names)', messages: 'Messages (edits, deletes)',
    server: 'Server (channels, roles)', community: 'Community (levels, giveaways, counters)', dashboard: 'Dashboard and website changes',
    automod: 'Automod', tickets: 'Tickets (opened, claimed, closed)', transcripts: 'Ticket transcripts',
};
export default {
    data: new SlashCommandBuilder()
        .setName('logging')
        .setDescription('Manage server logging: channels, filters and event categories.')
        .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('dashboard')
                .setDescription('Open the logging dashboard: channels, filters and categories.')
                .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.dashboard')),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('channel')
                .setDescription('Quick-set a log channel without opening the dashboard.')
                .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.channel'))
                .addStringOption((option) =>
                    option
                        .setName('destination')
                        .setDescription('Which log destination to configure.')
                        .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.destination'))
                        .setRequired(true)
                        .addChoices(
                            { name: 'Audit (moderation, messages, members…)', name_localizations: descriptionLocalizations('logging.cmd.choiceAudit'), value: 'audit' },
                            { name: 'Applications', name_localizations: descriptionLocalizations('logging.cmd.choiceApplications'), value: 'applications' },
                            { name: 'Reports', name_localizations: descriptionLocalizations('logging.cmd.choiceReports'), value: 'reports' },
                            { name: CHOICE_NAMES.moderation, name_localizations: descriptionLocalizations('logging.cmd.choiceModeration'), value: 'moderation' },
                            { name: CHOICE_NAMES.members, name_localizations: descriptionLocalizations('logging.cmd.choiceMembers'), value: 'members' },
                            { name: CHOICE_NAMES.messages, name_localizations: descriptionLocalizations('logging.cmd.choiceMessages'), value: 'messages' },
                            { name: CHOICE_NAMES.server, name_localizations: descriptionLocalizations('logging.cmd.choiceServer'), value: 'server' },
                            { name: CHOICE_NAMES.community, name_localizations: descriptionLocalizations('logging.cmd.choiceCommunity'), value: 'community' },
                            { name: CHOICE_NAMES.dashboard, name_localizations: descriptionLocalizations('logging.cmd.choiceDashboard'), value: 'dashboard' },
                            { name: CHOICE_NAMES.automod, name_localizations: descriptionLocalizations('logging.cmd.choiceAutomod'), value: 'automod' },
                            { name: CHOICE_NAMES.tickets, name_localizations: descriptionLocalizations('logging.cmd.choiceTickets'), value: 'tickets' },
                            { name: CHOICE_NAMES.transcripts, name_localizations: descriptionLocalizations('logging.cmd.choiceTranscripts'), value: 'transcripts' },
                        ),
                )
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The text or announcement channel for logs.')
                        .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.channelOption'))
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(false),
                )
                .addBooleanOption((option) =>
                    option
                        .setName('disable')
                        .setDescription('Set to True to clear this log channel.')
                        .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.disable'))
                        .setRequired(false),
                ),
        )
        .addSubcommandGroup((group) =>
            group
                .setName('ignore')
                .setDescription('Skip logs for a channel (with its threads / a category) or members with a role.')
                .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.ignore'))
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('channel')
                        .setDescription('Ignore a channel or category, or log it again (toggles).')
                        .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.ignoreChannel'))
                        .addChannelOption((option) =>
                            option
                                .setName('channel')
                                .setDescription('Channel or category')
                                .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.ignoreChannelOption'))
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildCategory)
                                .setRequired(true),
                        ),
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('role')
                        .setDescription('Ignore members with a role, or log them again (toggles).')
                        .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.ignoreRole'))
                        .addRoleOption((option) => option.setName('role').setDescription('Role')
                            .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.ignoreRoleOption')).setRequired(true)),
                )
                .addSubcommand((subcommand) =>
                    subcommand.setName('list').setDescription('Show the ignored channels, roles and users.')
                        .setDescriptionLocalizations(descriptionLocalizations('logging.cmd.ignoreList')),
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

            await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: textForInteraction(interaction).t('logging.unknownSubcommand') });
        } catch (error) {
            logger.error('logging command error:', error);
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: textForInteraction(interaction).t('logging.unexpected') }).catch(() => {});
        }
    },
};
