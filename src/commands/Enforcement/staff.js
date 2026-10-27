import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { automodConfig } from '../../config/automod.js';
import { isBotOwner } from '../../config/bot.js';
import { dateStamp, truncate } from '../../services/enforcement/format.js';
import {
    giveStaffWarning,
    listStaffWarnings,
    restoreStaffRoles,
} from '../../services/automod/staffGuardService.js';
import { formatActivityLine, staffActivityForWeek, weekStart } from '../../services/staffActivityService.js';

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

function isOwner(interaction) {
    return interaction.guild?.ownerId === interaction.user.id || isBotOwner(interaction.user.id);
}

export default {
    // Registered as a guild command in MAIN_GUILD_ID only.
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('staff')
        .setDescription('Owner only: staff warnings, activity, and restoring removed staff roles')
        .addSubcommand((sub) => sub.setName('warn').setDescription('Give a staff member a warning (3 active remove their staff roles)')
            .addUserOption((option) => option.setName('user').setDescription('Staff member').setRequired(true))
            .addStringOption((option) => option.setName('reason').setDescription('Which admin rule they broke').setRequired(true).setMaxLength(500)))
        .addSubcommand((sub) => sub.setName('warnings').setDescription("Show a staff member's warnings")
            .addUserOption((option) => option.setName('user').setDescription('Staff member').setRequired(true)))
        .addSubcommand((sub) => sub.setName('activity').setDescription('What each staff member did this week or last week')
            .addStringOption((option) => option.setName('week').setDescription('Which week')
                .addChoices({ name: 'this week', value: 'this' }, { name: 'last week', value: 'last' })))
        .addSubcommand((sub) => sub.setName('restore').setDescription('Give back staff roles removed by the staff guard or by warnings')
            .addUserOption((option) => option.setName('user').setDescription('Staff member').setRequired(true))),

    async execute(interaction) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild for /staff', ErrorTypes.PERMISSION, 'This command only works in the main server.', { expected: true });
        }
        if (!isOwner(interaction)) {
            throw new TitanBotError('Not the owner', ErrorTypes.PERMISSION, 'Only the server owner can use /staff.', { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const sub = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');

        if (sub === 'activity') {
            const date = new Date();
            if (interaction.options.getString('week') === 'last') date.setUTCDate(date.getUTCDate() - 7);
            const start = weekStart(date);
            await interaction.guild.members.fetch().catch(() => null);
            const rows = await staffActivityForWeek(interaction.guild, start);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: `Staff activity, week of ${start}`,
                    description: truncate(rows.length ? `${rows.map(formatActivityLine).join('\n')}\n\n-# ⚠️ = no moderation work and under 20 messages. Actions are cases they created; reviews are automod and verification cards.` : 'No staff found.', 4096),
                    color: 'primary',
                })],
            });
        }

        if (sub === 'warn') {
            if (user.id === interaction.guild.ownerId || user.bot) throw userError('You cannot warn the owner or a bot.');
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!member) throw userError(`${user.username} is not in the server.`);
            const reason = interaction.options.getString('reason').trim();
            const { active, demoted } = await giveStaffWarning(interaction.guild, member, interaction.user, reason);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed('Staff warning given', [
                    `${user.username} now has **${active} of ${automodConfig.staffWarnLimit}** active staff warnings.`,
                    demoted ? 'That reached the limit: their staff roles were removed. Use `/staff restore` to give them back.' : null,
                ].filter(Boolean).join('\n'))],
            });
        }

        if (sub === 'warnings') {
            const rows = await listStaffWarnings(interaction.guildId, user.id);
            const now = Date.now();
            const lines = rows.map((row) => `${new Date(row.expires_at).getTime() > now ? '**active**' : 'expired'} · ${dateStamp(row.created_at)} by ${row.given_by_username}: ${truncate(row.reason, 200)}`);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: `Staff warnings: ${user.username}`,
                    description: truncate(lines.join('\n') || 'None.', 4096),
                    color: 'primary',
                })],
            });
        }

        if (sub === 'restore') {
            const roles = await restoreStaffRoles(interaction.guild, user.id, interaction.user);
            if (!roles) throw userError(`No removed staff roles are saved for ${user.username} (or they are not in the server).`);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed('Staff roles restored', roles.length ? roles.map((role) => role.name).join(', ') : 'None of the saved roles could be given back (deleted or above my role).')],
            });
        }
    },
};
