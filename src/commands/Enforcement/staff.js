import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { clearMassActionBlock, getMassActionBlock } from '../../services/enforcement/massActionGuard.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { automodConfig } from '../../config/automod.js';
import { botText, textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
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

// Every answer is ephemeral: the caller's Discord language (utils/botText.js 'reply').
// The stats and activity lines and the coverage grid come from shared services (still English).

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** The period labels of /staff stats in a language (STATS_PERIODS keys). */
function periodLabels(tr) {
    return {
        '7d': tr.t('staff.staff.period.days7'),
        '30d': tr.t('staff.staff.period.days30'),
        '90d': tr.t('staff.staff.period.days90'),
        all: tr.t('staff.staff.period.all'),
    };
}

/** Choice localizations of the stats periods (keys of STATS_PERIODS). */
const PERIOD_CHOICE_KEYS = {
    '7d': () => descriptionLocalizations('staff.staff.period.days7'),
    '30d': () => descriptionLocalizations('staff.staff.period.days30'),
    '90d': () => descriptionLocalizations('staff.staff.period.days90'),
    all: () => descriptionLocalizations('staff.staff.period.all'),
};

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
 * highest role (the bot would hand out roles they could not give by hand). `lang`: the
 * caller's language (default English).
 */
export function restoreRefusal({ interaction, targetId, roles, lang = 'en' }) {
    if (isOwner(interaction)) return null;
    const tr = botText(lang);
    if (targetId === interaction.user.id) return tr.t('staff.staff.restore.notYourself');
    const top = interaction.member?.roles?.highest?.position ?? 0;
    const tooHigh = (roles || []).filter((role) => role.position >= top);
    if (tooHigh.length) {
        return tr.t('staff.staff.restore.tooHigh', { roles: truncate(tooHigh.map((role) => role.name).join(', '), 1000) });
    }
    return null;
}

export default {
    data: new SlashCommandBuilder()
        .setName('staff')
        .setDescription('Staff warnings, activity, stats, coverage and restoring roles (owner only; some subcommands: admins)')
        .setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.description'))
        .addSubcommand((sub) => sub.setName('warn').setDescription('Give a staff member a warning (3 active remove their staff roles)')
            .setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.warn'))
            .addUserOption((option) => option.setName('user').setDescription('Staff member').setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.staffMember')).setRequired(true))
            .addStringOption((option) => option.setName('reason').setDescription('Which admin rule they broke').setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.reason')).setRequired(true).setMaxLength(500)))
        .addSubcommand((sub) => sub.setName('warnings').setDescription("Show a staff member's warnings")
            .setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.warnings'))
            .addUserOption((option) => option.setName('user').setDescription('Staff member').setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.staffMember')).setRequired(true)))
        .addSubcommand((sub) => sub.setName('activity').setDescription('What each staff member did this week or last week')
            .setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.activity'))
            .addStringOption((option) => option.setName('week').setDescription('Which week').setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.week'))
                .addChoices(
                    { name: 'this week', name_localizations: descriptionLocalizations('staff.staff.cmd.thisWeek'), value: 'this' },
                    { name: 'last week', name_localizations: descriptionLocalizations('staff.staff.cmd.lastWeek'), value: 'last' },
                )))
        .addSubcommand((sub) => sub.setName('stats').setDescription('Admins: moderation stats per moderator (actions, appeals, removed cases)')
            .setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.stats'))
            .addUserOption((option) => option.setName('moderator').setDescription('Only this moderator').setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.moderator')))
            .addStringOption((option) => option.setName('period').setDescription('Time period (default: 30 days)').setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.statsPeriod'))
                .addChoices(...Object.entries(STATS_PERIODS).map(([value, { label }]) => ({
                    name: label, ...(PERIOD_CHOICE_KEYS[value] ? { name_localizations: PERIOD_CHOICE_KEYS[value]() } : {}), value,
                })))))
        .addSubcommand((sub) => sub.setName('coverage').setDescription('Admins: when incidents happen vs when staff are active (weekday × hour)')
            .setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.coverage'))
            .addStringOption((option) => option.setName('period').setDescription('Time period (default: 7 days)').setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.coveragePeriod'))
                .addChoices(
                    { name: 'last 7 days', name_localizations: descriptionLocalizations('staff.staff.period.days7'), value: '7d' },
                    { name: 'last 30 days', name_localizations: descriptionLocalizations('staff.staff.period.days30'), value: '30d' },
                )))
        .addSubcommand((sub) => sub.setName('restore').setDescription('Give back removed staff roles and lift a safety limit block (too many bans/kicks)')
            .setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.restore'))
            .addUserOption((option) => option.setName('user').setDescription('Staff member').setDescriptionLocalizations(descriptionLocalizations('staff.staff.cmd.staffMember')).setRequired(true))),

    async execute(interaction) {
        const tr = textForInteraction(interaction);
        // Any server (multi-server B1): every subcommand reads and writes this server's rows only.
        if (!interaction.guildId) {
            throw new TitanBotError('/staff outside a server', ErrorTypes.PERMISSION, tr.t('staff.staff.serverOnly'), { expected: true });
        }
        const sub = interaction.options.getSubcommand();
        // /staff stats and coverage are open to administrators; everything else is the owner's.
        const adminSub = sub === 'stats' || sub === 'coverage';
        if (sub === 'restore') {
            if (!canRestore(interaction)) {
                throw new TitanBotError('Not allowed to restore', ErrorTypes.PERMISSION,
                    isMewvoServer(interaction.guildId) ? tr.t('staff.staff.restore.ownerOnly') : tr.t('staff.staff.restore.noAdmin'),
                    { expected: true });
            }
        } else if (adminSub ? !(isOwner(interaction) || isAdministrator(interaction.member)) : !isOwner(interaction)) {
            throw new TitanBotError('Not the owner', ErrorTypes.PERMISSION,
                adminSub
                    ? tr.t(sub === 'stats' ? 'staff.staff.noAdminStats' : 'staff.staff.noAdminCoverage')
                    : tr.t('staff.staff.ownerOnly'), { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (sub === 'stats') {
            const period = interaction.options.getString('period') || '30d';
            const moderator = interaction.options.getUser('moderator');
            const rows = await staffModerationStats(interaction.guildId, interaction.client.user.id, { period, moderatorId: moderator?.id || null });
            const label = periodLabels(tr)[period] || STATS_PERIODS[period]?.label || period;
            const empty = moderator ? tr.t('staff.staff.stats.emptyFor', { name: moderator.username }) : tr.t('staff.staff.stats.empty');
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: truncate(moderator
                        ? tr.t('staff.staff.stats.titleFor', { name: moderator.username, period: label })
                        : tr.t('staff.staff.stats.title', { period: label }), 256),
                    description: truncate(rows.length
                        ? `${rows.map(formatStatsLine).join('\n')}\n\n${tr.t('staff.staff.stats.footnote')}`
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
                ? report.gaps.map((slot, i) => tr.t('staff.staff.coverage.gap', {
                    n: i + 1,
                    slot: slotLabel(slot),
                    incidents: tr.tp('staff.staff.coverage.incidents', slot.incidents),
                    staff: tr.tp('staff.staff.coverage.staffActions', slot.staff),
                })).join('\n')
                : tr.t('staff.staff.coverage.noIncidents');
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: truncate(tr.t('staff.staff.coverage.title', { days, timeZone: report.timeZone }), 256),
                    description: truncate([
                        tr.t('staff.staff.coverage.incidentsHeading', { count: report.totalIncidents }),
                        '```',
                        report.incidentText,
                        '```',
                        tr.t('staff.staff.coverage.staffHeading', { count: report.totalStaff }),
                        '```',
                        report.staffText,
                        '```',
                        tr.t('staff.staff.coverage.legend', { maxIncidents: report.maxIncidents, maxStaff: report.maxStaff }),
                    ].join('\n'), 4096),
                    fields: [{ name: tr.t('staff.staff.coverage.gapsTitle'), value: truncate(gaps, 1024) }],
                    footer: { text: truncate(tr.t('staff.staff.coverage.footer'), 2048) },
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
            const cachedNote = partial ? `\n${tr.t('staff.staff.activity.cached')}` : '';
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: truncate(tr.t('staff.staff.activity.title', { start }), 256),
                    description: truncate(rows.length
                        ? `${rows.map(formatActivityLine).join('\n')}\n\n${tr.t('staff.staff.activity.footnote')}${cachedNote}`
                        : `${tr.t('staff.staff.activity.none')}${cachedNote}`, 4096),
                    color: 'primary',
                })],
            });
        }

        if (sub === 'warn') {
            if (user.id === interaction.guild.ownerId || user.bot) throw userError(tr.t('staff.staff.warn.ownerOrBot'));
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!member) throw userError(tr.t('staff.staff.warn.notInServer', { name: user.username }));
            const reason = interaction.options.getString('reason').trim();
            const { active, demoted } = await giveStaffWarning(interaction.guild, member, interaction.user, reason);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(tr.t('staff.staff.warn.title'), [
                    tr.t('staff.staff.warn.count', { name: user.username, active, limit: automodConfig.staffWarnLimit }),
                    demoted ? tr.t('staff.staff.warn.demoted') : null,
                ].filter(Boolean).join('\n'))],
            });
        }

        if (sub === 'warnings') {
            const rows = await listStaffWarnings(interaction.guildId, user.id);
            const now = Date.now();
            const lines = rows.map((row) => tr.t('staff.staff.warnings.line', {
                state: new Date(row.expires_at).getTime() > now ? tr.t('staff.staff.warnings.active') : tr.t('staff.staff.warnings.expired'),
                date: dateStamp(row.created_at),
                by: row.given_by_username,
                reason: truncate(row.reason, 200),
            }));
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: truncate(tr.t('staff.staff.warnings.title', { name: user.username }), 256),
                    description: truncate(lines.join('\n') || tr.t('staff.staff.warnings.none'), 4096),
                    color: 'primary',
                })],
            });
        }

        if (sub === 'restore') {
            // Per server: the block and the saved roles are keyed by this guild's id.
            const refusal = restoreRefusal({ interaction, targetId: user.id, roles: await savedStaffRoles(interaction.guild, user.id), lang: tr.lang });
            if (refusal) throw userError(refusal);
            // Also lifts a mass-action guard block on the panel.
            const block = await getMassActionBlock(interaction.guild.id, user.id);
            if (block) await clearMassActionBlock(interaction.guild.id, user.id);
            const roles = await restoreStaffRoles(interaction.guild, user.id, interaction.user);
            if (!roles && !block) throw userError(tr.t('staff.staff.restore.nothing', { name: user.username }));
            const lines = [
                roles ? (roles.length ? tr.t('staff.staff.restore.roles', { roles: truncate(roles.map((role) => role.name).join(', '), 3000) }) : tr.t('staff.staff.restore.noRoles')) : null,
                block ? tr.t('staff.staff.restore.blockLifted') : null,
            ].filter(Boolean);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(tr.t('staff.staff.restore.title'), lines.join('\n'))],
            });
        }
    },
};
