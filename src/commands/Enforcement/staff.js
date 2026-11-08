import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { clearMassActionBlock, getMassActionBlock } from '../../services/enforcement/massActionGuard.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { automodConfig } from '../../config/automod.js';
import { hasOwnerPower, isMewvoServer } from '../../utils/ownerPower.js';
import { dateStamp, truncate } from '../../services/enforcement/format.js';
import {
    giveStaffWarning,
    listStaffWarnings,
    restoreStaffRoles,
    savedStaffRoles,
} from '../../services/automod/staffGuardService.js';
import {
    formatActivityLine, formatStatsLine, staffActivityForWeek, staffModerationStats, STATS_PERIODS, weekStart,
} from '../../services/staffActivityService.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import { buildCoverageReport, COVERAGE_PERIODS, loadCoverageCounts, slotLabel } from '../../services/staffCoverageService.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { fetchAllMembers } from '../../utils/memberFetchGate.js';

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** The server's owner, or OWNER_IDS in Mewvo's own servers only. */
export function isOwner(interaction) {
    return interaction.guild?.ownerId === interaction.user.id || hasOwnerPower(interaction.user.id, interaction.guildId);
}

/**
 * Who may run /staff restore (multi-server B4): the owner as before (the server owner, OWNER_IDS
 * in Mewvo's servers). In any other server also its Administrators: there nobody else could lift
 * a mass-action block or give back roles the staff guard removed. Mewvo's own servers stay
 * owner-only (their staff guard protects the bot's home against a rogue admin).
 */
export function canRestore(interaction) {
    if (isOwner(interaction)) return true;
    return !isMewvoServer(interaction.guildId) && isAdministrator(interaction.member);
}

/**
 * Why a non-owner Administrator may not restore `targetId` (null = allowed): not themselves
 * (a blocked admin must not lift their own block), and no saved role at or above their own
 * highest role (the bot would hand out roles they could not give by hand).
 */
export function restoreRefusal({ interaction, targetId, roles }) {
    if (isOwner(interaction)) return null;
    if (targetId === interaction.user.id) return 'You cannot restore yourself. Ask the server owner or another administrator.';
    const top = interaction.member?.roles?.highest?.position ?? 0;
    const tooHigh = (roles || []).filter((role) => role.position >= top);
    if (tooHigh.length) {
        return `Some saved roles are at or above your highest role (${truncate(tooHigh.map((role) => role.name).join(', '), 1000)}). Ask the server owner to restore them.`;
    }
    return null;
}

export default {
    data: new SlashCommandBuilder()
        .setName('staff')
        .setDescription('Staff warnings, activity, stats, coverage and restoring roles (owner only; some subcommands: admins)')
        .addSubcommand((sub) => sub.setName('warn').setDescription('Give a staff member a warning (3 active remove their staff roles)')
            .addUserOption((option) => option.setName('user').setDescription('Staff member').setRequired(true))
            .addStringOption((option) => option.setName('reason').setDescription('Which admin rule they broke').setRequired(true).setMaxLength(500)))
        .addSubcommand((sub) => sub.setName('warnings').setDescription("Show a staff member's warnings")
            .addUserOption((option) => option.setName('user').setDescription('Staff member').setRequired(true)))
        .addSubcommand((sub) => sub.setName('activity').setDescription('What each staff member did this week or last week')
            .addStringOption((option) => option.setName('week').setDescription('Which week')
                .addChoices({ name: 'this week', value: 'this' }, { name: 'last week', value: 'last' })))
        .addSubcommand((sub) => sub.setName('stats').setDescription('Admins: moderation stats per moderator (actions, appeals, removed cases)')
            .addUserOption((option) => option.setName('moderator').setDescription('Only this moderator'))
            .addStringOption((option) => option.setName('period').setDescription('Time period (default: 30 days)')
                .addChoices(...Object.entries(STATS_PERIODS).map(([value, { label }]) => ({ name: label, value })))))
        .addSubcommand((sub) => sub.setName('coverage').setDescription('Admins: when incidents happen vs when staff are active (weekday × hour)')
            .addStringOption((option) => option.setName('period').setDescription('Time period (default: 7 days)')
                .addChoices({ name: 'last 7 days', value: '7d' }, { name: 'last 30 days', value: '30d' })))
        .addSubcommand((sub) => sub.setName('restore').setDescription('Give back removed staff roles and lift a safety limit block (too many bans/kicks)')
            .addUserOption((option) => option.setName('user').setDescription('Staff member').setRequired(true))),

    async execute(interaction) {
        // Any server (multi-server B1): every subcommand reads and writes this server's rows only.
        if (!interaction.guildId) {
            throw new TitanBotError('/staff outside a server', ErrorTypes.PERMISSION, 'This command only works in a server.', { expected: true });
        }
        const sub = interaction.options.getSubcommand();
        // /staff stats and coverage are open to administrators; everything else is the owner's.
        const adminSub = sub === 'stats' || sub === 'coverage';
        if (sub === 'restore') {
            if (!canRestore(interaction)) {
                throw new TitanBotError('Not allowed to restore', ErrorTypes.PERMISSION,
                    isMewvoServer(interaction.guildId) ? 'Only the server owner can use /staff restore here.' : 'You need the Administrator permission to use /staff restore.',
                    { expected: true });
            }
        } else if (adminSub ? !(isOwner(interaction) || isAdministrator(interaction.member)) : !isOwner(interaction)) {
            throw new TitanBotError('Not the owner', ErrorTypes.PERMISSION,
                adminSub ? `You need the Administrator permission to see staff ${sub}.` : 'Only the server owner can use /staff.', { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (sub === 'stats') {
            const period = interaction.options.getString('period') || '30d';
            const moderator = interaction.options.getUser('moderator');
            const rows = await staffModerationStats(interaction.guildId, interaction.client.user.id, { period, moderatorId: moderator?.id || null });
            const label = STATS_PERIODS[period]?.label || period;
            const empty = moderator ? `${moderator.username} has no moderation cases in this period.` : 'No moderation cases in this period.';
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: truncate(`Moderation stats${moderator ? `, ${moderator.username}` : ''}, ${label}`, 256),
                    description: truncate(rows.length
                        ? `${rows.map(formatStatsLine).join('\n')}\n\n-# Cases they created (test and automatic cases left out; removed cases are not in the totals). Appeals: decided in this period on their cases.`
                        : empty, 4096),
                    color: 'primary',
                })],
            });
        }
        if (sub === 'coverage') {
            const period = COVERAGE_PERIODS[interaction.options.getString('period')] ? interaction.options.getString('period') : '7d';
            const days = COVERAGE_PERIODS[period];
            const guildConfig = await getGuildConfig(interaction.client, interaction.guildId).catch(() => null);
            const counts = await loadCoverageCounts(interaction.guildId, interaction.client.user.id, days);
            const report = buildCoverageReport(counts, guildConfig?.birthdayTimezone || 'UTC');
            const gaps = report.gaps.length
                ? report.gaps.map((slot, i) => `${i + 1}. **${slotLabel(slot)}**: ${slot.incidents} incident${slot.incidents === 1 ? '' : 's'}, ${slot.staff} staff action${slot.staff === 1 ? '' : 's'}`).join('\n')
                : 'No incidents in this period.';
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: `Staff coverage, last ${days} days (${report.timeZone})`,
                    description: truncate([
                        `**Incidents** (cases created, automatic included): ${report.totalIncidents}`,
                        '```',
                        report.incidentText,
                        '```',
                        `**Staff activity** (proxy, see below): ${report.totalStaff}`,
                        '```',
                        report.staffText,
                        '```',
                        `Legend: \`·\` none · \`░▒▓█\` quarter steps up to the busiest hour (incidents max ${report.maxIncidents}, staff max ${report.maxStaff}). Columns are hours 0–23.`,
                    ].join('\n'), 4096),
                    fields: [{ name: 'Most under-covered slots', value: truncate(gaps, 1024) }],
                    footer: { text: 'Staff activity = cases created by human moderators + appeals decided (staff_activity only has weekly totals, so no hours). Time zone: /birthday setchannel timezone.' },
                    color: 'primary',
                })],
            });
        }
        const user = interaction.options.getUser('user');

        if (sub === 'activity') {
            const date = new Date();
            if (interaction.options.getString('week') === 'last') date.setUTCDate(date.getUTCDate() - 7);
            const start = weekStart(date);
            const { partial } = await fetchAllMembers(interaction.guild, { maxAgeMs: 60 * 60_000, timeoutMs: 10_000, waitMs: 5_000 });
            const rows = await staffActivityForWeek(interaction.guild, start);
            const cachedNote = partial ? '\n-# Based on cached members: the full member list could not be loaded right now, so some staff may be missing.' : '';
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: `Staff activity, week of ${start}`,
                    description: truncate(rows.length ? `${rows.map(formatActivityLine).join('\n')}\n\n-# (inactive) = no moderation work and under 20 messages. Actions are cases they created; reviews are automod and verification cards.${cachedNote}` : `No staff found.${cachedNote}`, 4096),
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
            // Per server: the block and the saved roles are keyed by this guild's id.
            const refusal = restoreRefusal({ interaction, targetId: user.id, roles: await savedStaffRoles(interaction.guild, user.id) });
            if (refusal) throw userError(refusal);
            // Also lifts a mass-action guard block on the panel.
            const block = await getMassActionBlock(interaction.guild.id, user.id);
            if (block) await clearMassActionBlock(interaction.guild.id, user.id);
            const roles = await restoreStaffRoles(interaction.guild, user.id, interaction.user);
            if (!roles && !block) throw userError(`No removed staff roles are saved for ${user.username} (or they are not in the server), and they are not blocked from the panel.`);
            const lines = [
                roles ? (roles.length ? `Roles: ${roles.map((role) => role.name).join(', ')}` : 'None of the saved roles could be given back (deleted or above my role).') : null,
                block ? 'Their enforcement panel block was lifted.' : null,
            ].filter(Boolean);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed('Staff access restored', lines.join('\n'))],
            });
        }
    },
};
