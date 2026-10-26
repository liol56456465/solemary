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
        try {
            await interaction.guild.bans.fetch(target.id);
            isBanned = true;
        } catch {
            // A missing ban is a useful diagnostic result, not a command failure.
        }
        fields.push(checkField(
            'Ban status',
            !isBanned,
            isBanned
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
        );
        return fields;
    }

    const logsChannel = selectedChannel || (config.ticketLogsChannelId
        ? interaction.guild.channels.cache.get(config.ticketLogsChannelId)
        : null);
    const transcriptChannel = selectedChannel || (config.ticketTranscriptChannelId
        ? interaction.guild.channels.cache.get(config.ticketTranscriptChannelId)
        : null);

    if (action === 'ticket') {
        fields.push(
            checkField('Ticket panel', Boolean(config.ticketPanelChannelId), config.ticketPanelChannelId ? 'Ticket panel is configured.' : 'Run `/ticket setup` first.'),
            checkField('Manage Channels permission', Boolean(botMember?.permissions.has(PermissionFlagsBits.ManageChannels)), 'The bot needs Manage Channels to create and close tickets.'),
            checkField('Send Messages permission', Boolean(botMember?.permissions.has(PermissionFlagsBits.SendMessages)), 'The bot needs Send Messages in ticket channels.'),
        );
    } else if (action === 'feedback') {
        fields.push(
            checkField('Feedback log channel', Boolean(logsChannel), logsChannel ? `Feedback log channel: ${logsChannel}.` : 'Configure a ticket logs channel in `/ticket dashboard`.'),
            checkField('Feedback channel sendability', Boolean(logsChannel?.isSendable?.()), 'The bot must be able to send feedback logs there.'),
        );
    } else {
        fields.push(
            checkField('Transcript channel', Boolean(transcriptChannel), transcriptChannel ? `Transcript channel: ${transcriptChannel}.` : 'Configure a transcript channel in `/ticket dashboard`.'),
            checkField('Transcript channel sendability', Boolean(transcriptChannel?.isSendable?.()), 'The bot must be able to send transcript files there.'),
            checkField('DM transcript delivery', config.dmOnClose !== false, 'DM transcript delivery is enabled by the ticket configuration.'),
        );
    }

    return fields;
}

export default {
    data: new SlashCommandBuilder()
        .setName('test')
        .setDescription('Owner-only safe diagnostics; never performs moderation actions')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

        if (['all', 'ban', 'kick', 'timeout', 'warn', 'unban'].includes(action)) {
            if (action === 'all') {
                for (const moderationAction of ['ban', 'kick', 'timeout', 'warn', 'unban']) {
                    fields.push(
                        { name: `── ${moderationAction.toUpperCase()} ──`, value: '\u200b', inline: false },
                        ...(await runModerationCheck(interaction, moderationAction)),
                    );
                }
                fields.push(
                    { name: '── SYSTEMS ──', value: '\u200b', inline: false },
                    ...(await runSystemCheck(interaction, 'ticket')),
                    ...(await runSystemCheck(interaction, 'feedback')),
                    ...(await runSystemCheck(interaction, 'transcript')),
                    ...(await runSystemCheck(interaction, 'verification')),
                );
            } else {
                fields = await runModerationCheck(interaction, action);
            }
        } else {
            fields = await runSystemCheck(interaction, action);
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                createEmbed({
                    title: `🧪 Safe Test: ${action}`,
                    description: 'Diagnostics only. No ban, kick, timeout, warning, ticket, or configuration change was performed.',
                    color: 0x5865f2,
                    fields: fields.slice(0, 25),
                    footer: { text: 'Choose a different target user to test moderation readiness.' },
                }),
            ],
        });
    },
};