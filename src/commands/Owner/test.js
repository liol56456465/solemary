import {
    ChannelType,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { ModerationService } from '../../services/moderation/moderationService.js';
import { isBotOwner } from '../../config/bot.js';
import { createEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError, TitanBotError } from '../../utils/errorHandler.js';

const ACTIONS = [
    { name: 'All safe checks', value: 'all' },
    { name: 'Ban readiness', value: 'ban' },
    { name: 'Kick readiness', value: 'kick' },
    { name: 'Timeout readiness', value: 'timeout' },
    { name: 'Warn readiness', value: 'warn' },
    { name: 'Unban readiness', value: 'unban' },
    { name: 'Purge readiness', value: 'purge' },
    { name: 'Lock readiness', value: 'lock' },
    { name: 'Unlock readiness', value: 'unlock' },
    { name: 'Verification setup', value: 'verification' },
    { name: 'Ticket setup', value: 'ticket' },
    { name: 'Feedback logging', value: 'feedback' },
    { name: 'Transcript delivery', value: 'transcript' },
];

const DURATION_CHOICES = [
    { name: '5 minutes', value: 5 },
    { name: '30 minutes', value: 30 },
    { name: '1 hour', value: 60 },
    { name: '1 day', value: 1440 },
];

function status(ok) {
    return ok ? '✅ Ready' : '❌ Needs attention';
}

function checkField(name, ok, detail) {
    return {
        name: `${status(ok)} · ${name}`,
        value: detail,
        inline: false,
    };
}

function isGuildOwnerOrBotOwner(interaction) {
    return interaction.guild?.ownerId === interaction.user.id || isBotOwner(interaction.user.id);
}

function getBotMember(guild) {
    return guild.members.me || guild.members.cache.get(guild.client.user.id);
}

function requireTarget(interaction) {
    const target = interaction.options.getUser('target');
    if (!target) {
        throw new TitanBotError(
            'Missing diagnostic target',
            ErrorTypes.USER_INPUT,
            'Choose a target user other than yourself for this diagnostic.',
        );
    }
    if (target.id === interaction.user.id) {
        throw new TitanBotError(
            'Diagnostic target is executor',
            ErrorTypes.VALIDATION,
            'The owner cannot test against themselves. Choose another member or test account.',
        );
    }
    return target;
}

async function runModerationCheck(interaction, action) {
    const target = requireTarget(interaction);
    const member = interaction.options.getMember('target');
    const botMember = getBotMember(interaction.guild);
    const requiredPermission = {
        ban: PermissionFlagsBits.BanMembers,
        kick: PermissionFlagsBits.KickMembers,
        timeout: PermissionFlagsBits.ModerateMembers,
        warn: PermissionFlagsBits.ModerateMembers,
        unban: PermissionFlagsBits.BanMembers,
    }[action];
    const permissionName = {
        ban: 'Ban Members',
        kick: 'Kick Members',
        timeout: 'Moderate Members',
        warn: 'Moderate Members',
        unban: 'Ban Members',
    }[action];

    const fields = [
        checkField(
            permissionName,
            Boolean(botMember?.permissions.has(requiredPermission)),
            `The bot must have **${permissionName}**.`,
        ),
        checkField(
            'Target availability',
            action === 'unban' || Boolean(member),
            action === 'unban'
                ? `The diagnostic will look up **${target.tag}** without changing their ban status.`
                : member
                    ? `**${target.tag}** is currently in this server.`
                    : `**${target.tag}** is not currently in this server.`,
        ),
    ];

    if (action === 'unban') {
        let isBanned = false;
        let lookupError = null;
        try {
            await interaction.guild.bans.fetch(target.id);
            isBanned = true;
        } catch (error) {
            if (error.code !== 10026) {
                lookupError = error;
            }
        }
        fields.push(checkField(
            'Ban status',
            Boolean(isBanned),
            lookupError
                ? `Could not confirm ban status (Discord error ${lookupError.code || 'unknown'}).`
                : isBanned
                ? `**${target.tag}** is banned. A real unban would be possible if permissions are correct.`
                : `**${target.tag}** is not currently banned.`,
        ));
        return fields;
    }

    if (!member) {
        if (action === 'ban') {
            fields.push(checkField(
                'Target availability',
                true,
                'Bans can target users who are not currently in the server. No action was performed.',
            ));
        } else {
            fields.push(checkField(
                'Target availability',
                false,
                `${action} requires the target to be a current server member.`,
            ));
        }
        return fields;
    }

    const hierarchy = ModerationService.validateBotHierarchy(member, action);
    fields.push(checkField(
        'Bot role hierarchy',
        hierarchy.valid,
        hierarchy.valid ? 'The bot role is above the target.' : hierarchy.error,
    ));

    if (action === 'kick') {
        fields.push(checkField(
            'Kick readiness',
            member.kickable,
            member.kickable ? 'Discord reports this member as kickable.' : 'Discord reports this member as not kickable.',
        ));
    } else if (action === 'timeout') {
        const duration = interaction.options.getInteger('duration') || 5;
        fields.push(checkField(
            'Timeout readiness',
            member.moderatable,
            member.moderatable ? `Discord reports this member as timeout-ready for ${duration} minutes.` : 'Discord reports this member as not timeout-ready.',
        ));
    } else if (action === 'warn') {
        fields.push(checkField(
            'Warning dry-run',
            true,
            'The warning would be recorded without writing anything in this safe test.',
        ));
    } else {
        fields.push(checkField(
            'Ban dry-run',
            true,
            'The ban would be attempted only after this diagnostic passes. No ban was issued.',
        ));
    }

    return fields;
}

function runChannelModerationCheck(interaction, action) {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const botMember = getBotMember(interaction.guild);
    const requiredPermission = {
        massban: PermissionFlagsBits.BanMembers,
        masskick: PermissionFlagsBits.KickMembers,
        purge: PermissionFlagsBits.ManageMessages,
        lock: PermissionFlagsBits.ManageChannels,
        unlock: PermissionFlagsBits.ManageChannels,
    }[action];
    const permissionName = {
        massban: 'Ban Members',
        masskick: 'Kick Members',
        purge: 'Manage Messages',
        lock: 'Manage Channels',
        unlock: 'Manage Channels',
    }[action];
    const channelPermissions = channel?.permissionsFor(botMember);
    const permissionAvailable = action === 'massban' || action === 'masskick'
        ? Boolean(botMember?.permissions.has(requiredPermission))
        : Boolean(channelPermissions?.has(requiredPermission));

    return [
        checkField(
            `${permissionName} permission`,
            permissionAvailable,
            action === 'massban' || action === 'masskick'
                ? `The bot needs **${permissionName}** in this server.`
                : `The bot needs **${permissionName}** in ${channel || 'the selected channel'}.`,
        ),
        checkField(
            'No action performed',
            true,
            `This is only a readiness check for **${action}**; no member or channel was changed.`,
        ),
    ];
}

async function runSystemCheck(interaction, action) {
    const config = await getGuildConfig(interaction.client, interaction.guildId);
    const botMember = getBotMember(interaction.guild);
    const selectedChannel = interaction.options.getChannel('channel');
    const fields = [];

    if (action === 'verification') {
        const role = config.verification?.roleId
            ? interaction.guild.roles.cache.get(config.verification.roleId)
            : null;
        const channel = config.verification?.channelId
            ? interaction.guild.channels.cache.get(config.verification.channelId)
            : null;
        fields.push(
            checkField('Verification enabled', Boolean(config.verification?.enabled), 'The server verification system must be enabled.'),
            checkField('Verification channel', Boolean(channel), channel ? `Verification panel channel: ${channel}.` : 'Run `/verification setup` to choose a channel.'),
            checkField('Verified role', Boolean(role), role ? `Verified role: ${role}.` : 'Run `/verification setup` to choose a role.'),
            checkField('Manage Roles permission', Boolean(botMember?.permissions.has(PermissionFlagsBits.ManageRoles)), 'The bot needs Manage Roles.'),
            checkField(
                'Verified role hierarchy',
                Boolean(role && botMember && botMember.roles.highest.position > role.position),
                role ? 'The bot role must be above the verified role.' : 'Configure a verified role first.',
            ),
        );
        return fields;
    }

    const logsChannel = selectedChannel || (config.ticketLogsChannelId
        ? interaction.guild.channels.cache.get(config.ticketLogsChannelId)
        : null);
    const transcriptChannel = selectedChannel || (config.ticketTranscriptChannelId
        ? interaction.guild.channels.cache.get(config.ticketTranscriptChannelId)
        : null);
    const channelPermissions = (channel, required) => {
        if (!channel || !botMember) return false;
        const permissions = channel.permissionsFor(botMember);
        return Boolean(permissions?.has(required));
    };

    if (action === 'ticket') {
        const panelChannel = config.ticketPanelChannelId
            ? interaction.guild.channels.cache.get(config.ticketPanelChannelId)
            : null;
        const dbStatus = interaction.client.db?.getStatus?.();
        fields.push(
            checkField('Ticket panel', Boolean(panelChannel), panelChannel ? `Ticket panel channel: ${panelChannel}.` : 'Run `/ticket setup` first or repair its configured channel.'),
            checkField('Manage Channels permission', Boolean(botMember?.permissions.has(PermissionFlagsBits.ManageChannels)), 'The bot needs Manage Channels to create and close tickets.'),
            checkField('Send Messages permission', Boolean(botMember?.permissions.has(PermissionFlagsBits.SendMessages)), 'The bot needs Send Messages in ticket channels.'),
            checkField('Database', Boolean(dbStatus && !dbStatus.isDegraded), dbStatus?.isDegraded ? 'Ticket data is not persistent while the database is degraded.' : 'Ticket data storage is available.'),
        );
    } else if (action === 'feedback') {
        const dbStatus = interaction.client.db?.getStatus?.();
        fields.push(
            checkField('Feedback log channel', Boolean(logsChannel), logsChannel ? `Feedback log channel: ${logsChannel}.` : 'Configure a ticket logs channel in `/ticket dashboard`.'),
            checkField(
                'Feedback channel permissions',
                channelPermissions(logsChannel, [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]),
                'The bot needs Send Messages and Embed Links in the feedback log channel.',
            ),
            checkField('Database', Boolean(dbStatus && !dbStatus.isDegraded), dbStatus?.isDegraded ? 'Feedback cannot be saved persistently while the database is degraded.' : 'Feedback storage is available.'),
        );
    } else {
        fields.push(
            checkField('Transcript channel', Boolean(transcriptChannel), transcriptChannel ? `Transcript channel: ${transcriptChannel}.` : 'Configure a transcript channel in `/ticket dashboard`.'),
            checkField(
                'Transcript channel permissions',
                channelPermissions(transcriptChannel, [
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks,
                    PermissionFlagsBits.AttachFiles,
                ]),
                'The bot needs Send Messages, Embed Links, and Attach Files in the transcript channel.',
            ),
            checkField(
                'DM transcript delivery',
                true,
                'The bot attempts to DM the transcript after closing; each user must allow DMs from server members.',
            ),
        );
    }

    return fields;
}

export default {
    data: new SlashCommandBuilder()
        .setName('test')
        .setDescription('Owner-only safe diagnostics; never performs moderation actions')
        .setDefaultMemberPermissions(null)
        .addStringOption(option =>
            option
                .setName('action')
                .setDescription('What should be checked')
                .setRequired(true)
                .addChoices(...ACTIONS),
        )
        .addUserOption(option =>
            option
                .setName('target')
                .setDescription('Different user to use for moderation readiness checks')
                .setRequired(false),
        )
        .addIntegerOption(option =>
            option
                .setName('duration')
                .setDescription('Timeout duration for the timeout readiness check')
                .setRequired(false)
                .addChoices(...DURATION_CHOICES),
        )
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('Optional channel to inspect for system diagnostics')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false),
        ),

    category: 'owner',

    async execute(interaction) {
        if (!interaction.guild) {
            return await replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'This diagnostic command can only be used in a server.',
            });
        }

        if (!isGuildOwnerOrBotOwner(interaction)) {
            return await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'Only the server owner or a configured bot owner can use this diagnostic command.',
            });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const action = interaction.options.getString('action');
        let fields = [];
        const memberActions = ['ban', 'kick', 'timeout', 'warn', 'unban'];
        const channelActions = ['purge', 'lock', 'unlock'];

        if ([...memberActions, ...channelActions, 'all'].includes(action)) {
            if (action === 'all') {
                for (const moderationAction of memberActions) {
                    fields.push(
                        { name: `── ${moderationAction.toUpperCase()} ──`, value: '\u200b', inline: false },
                        ...(await runModerationCheck(interaction, moderationAction)),
                    );
                }
                for (const moderationAction of channelActions) {
                    fields.push(
                        { name: `── ${moderationAction.toUpperCase()} ──`, value: '\u200b', inline: false },
                        ...runChannelModerationCheck(interaction, moderationAction),
                    );
                }
                fields.push(
                    { name: '── SYSTEMS ──', value: '\u200b', inline: false },
                    ...(await runSystemCheck(interaction, 'ticket')),
                    ...(await runSystemCheck(interaction, 'feedback')),
                    ...(await runSystemCheck(interaction, 'transcript')),
                    ...(await runSystemCheck(interaction, 'verification')),
                );
            } else if (memberActions.includes(action)) {
                fields = await runModerationCheck(interaction, action);
            } else {
                fields = runChannelModerationCheck(interaction, action);
            }
        } else {
            fields = await runSystemCheck(interaction, action);
        }

        const embedChunks = [];
        for (let i = 0; i < fields.length; i += 25) {
            embedChunks.push(fields.slice(i, i + 25));
        }
        const embeds = embedChunks.map((embedFields, index) =>
                createEmbed({
                    title: `🧪 Safe Test: ${action}${embedChunks.length > 1 ? ` (${index + 1}/${embedChunks.length})` : ''}`,
                    description: 'Diagnostics only. No moderation action, ticket action, or configuration change was performed.',
                    color: 0x5865f2,
                    fields: embedFields,
                    footer: { text: 'Choose a different target user to test moderation readiness.' },
                }),
            );
        await InteractionHelper.safeEditReply(interaction, { embeds });
    },
};