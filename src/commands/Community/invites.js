// /invites — invite tracking (services/invites/). One top-level command.
//   everyone (commandAccess.js):  view [user]       counts only (owner decision 6: anyone may look
//                                                   at another member's counts, never who they invited)
//                                 leaderboard [page] (cached 60 s)
//   Administrator (not listed, so the dispatcher's gate refuses everyone else before execute):
//                                 who user          how this member joined
//                                 list user         the members this member invited
//                                 bonus add|remove user amount
//                                 reset [user]      confirm button (invreset:…, re-checked on click)
//                                 setup             the dashboard link and the current state
// Every answer is ephemeral (the user's language); deferred first (3 s).

import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { describe, replyText } from '../../utils/commandLocalizations.js';
import { dashboardUrlFor } from '../../services/site/shell.js';
import {
    cachedLeaderboard, forgetLeaderboard, inviteCounts, inviteSettings, joinsByInviter, LEADERBOARD_PAGE_SIZE,
} from '../../services/invites/inviteStats.js';
import { changeBonus, latestJoin } from '../../services/invites/inviteStore.js';
import { applyMilestoneRoles } from '../../services/invites/inviteRoles.js';
import { canReadInvites, getInviteState } from '../../services/invites/inviteCache.js';
import { safeCode } from '../../services/invites/inviteTracker.js';

export const INVITE_RESET_BUTTON = 'invreset';
export const NO_MENTIONS = Object.freeze({ parse: [] });
export const BONUS_MAX_STEP = 10000;
const LIST_LIMIT = 25;
const DAY_MS = 86_400_000;

const ts = (value, style = 'f') => {
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:${style}>` : '?';
};

/** "@x (`code`)" / "the vanity URL" … in the reader's language; pure. */
export function sourceText(tr, { source, code, inviterId }) {
    const c = safeCode(code);
    if (inviterId) return tr.t('invites.source.inviter', { inviter: `<@${inviterId}>`, code: c ? ` (\`${c}\`)` : '' });
    const key = ['invite', 'vanity', 'widget', 'discovery', 'bot', 'ambiguous', 'not_ready', 'no_permission'].includes(source) ? source : 'unknown';
    return tr.t(`invites.source.${key}`, { code: c ? ` (\`${c}\`)` : '' });
}

/** The counts embed of one member; pure. */
export function countsEmbed(tr, userId, counts) {
    return createEmbed({
        title: tr.t('invites.view.title'),
        description: tr.t('invites.view.text', {
            user: `<@${userId}>`, total: counts.total, invited: counts.invited, left: counts.left, fake: counts.fake, bonus: counts.bonus,
        }),
        color: 'info',
    });
}

/** The leaderboard embed of one page; pure. */
export function leaderboardEmbed(tr, rows, page) {
    if (!rows.length) {
        return createEmbed({ title: tr.t('invites.leaderboard.title'), description: tr.t(page > 1 ? 'invites.leaderboard.emptyPage' : 'invites.leaderboard.empty', { page }), color: 'info' });
    }
    const lines = rows.map((r) => tr.t('invites.leaderboard.line', { rank: r.rank, user: `<@${r.userId}>`, total: r.total, invited: r.invited, left: r.left, fake: r.fake }));
    return createEmbed({
        title: tr.t('invites.leaderboard.title'),
        description: lines.join('\n').slice(0, 4000),
        footer: { text: tr.t('invites.leaderboard.footer', { page }) },
        color: 'info',
    });
}

/** The reset confirmation (buttons carry the invoker and the target: 'all' or a user id). */
export function resetConfirm(tr, invokerId, target) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${INVITE_RESET_BUTTON}:confirm:${invokerId}:${target}`).setStyle(ButtonStyle.Danger).setLabel(tr.t('invites.reset.confirmButton')),
        new ButtonBuilder().setCustomId(`${INVITE_RESET_BUTTON}:cancel:${invokerId}:${target}`).setStyle(ButtonStyle.Secondary).setLabel(tr.t('invites.reset.cancelButton')),
    );
    return {
        embeds: [createEmbed({
            title: tr.t('invites.reset.title'),
            description: target === 'all' ? tr.t('invites.reset.askAll') : tr.t('invites.reset.askUser', { user: `<@${target}>` }),
            color: 'warning',
        })],
        components: [row],
        allowedMentions: NO_MENTIONS,
    };
}

function say(interaction, tr, description, color = 'warning') {
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({ title: tr.t('invites.title'), description, color })], components: [], allowedMentions: NO_MENTIONS,
    });
}

const builder = describe(new SlashCommandBuilder().setName('invites'), 'invites.cmd.desc')
    .addSubcommand((sub) => describe(sub.setName('view'), 'invites.cmd.view')
        .addUserOption((o) => describe(o.setName('user'), 'invites.cmd.viewUser')))
    .addSubcommand((sub) => describe(sub.setName('leaderboard'), 'invites.cmd.leaderboard')
        .addIntegerOption((o) => describe(o.setName('page'), 'invites.cmd.page').setMinValue(1).setMaxValue(100)))
    .addSubcommand((sub) => describe(sub.setName('who'), 'invites.cmd.who')
        .addUserOption((o) => describe(o.setName('user'), 'invites.cmd.whoUser').setRequired(true)))
    .addSubcommand((sub) => describe(sub.setName('list'), 'invites.cmd.list')
        .addUserOption((o) => describe(o.setName('user'), 'invites.cmd.listUser').setRequired(true)))
    .addSubcommandGroup((group) => describe(group.setName('bonus'), 'invites.cmd.bonus')
        .addSubcommand((sub) => describe(sub.setName('add'), 'invites.cmd.bonusAdd')
            .addUserOption((o) => describe(o.setName('user'), 'invites.cmd.bonusUser').setRequired(true))
            .addIntegerOption((o) => describe(o.setName('amount'), 'invites.cmd.amount').setRequired(true).setMinValue(1).setMaxValue(BONUS_MAX_STEP)))
        .addSubcommand((sub) => describe(sub.setName('remove'), 'invites.cmd.bonusRemove')
            .addUserOption((o) => describe(o.setName('user'), 'invites.cmd.bonusUser').setRequired(true))
            .addIntegerOption((o) => describe(o.setName('amount'), 'invites.cmd.amount').setRequired(true).setMinValue(1).setMaxValue(BONUS_MAX_STEP))))
    .addSubcommand((sub) => describe(sub.setName('reset'), 'invites.cmd.reset')
        .addUserOption((o) => describe(o.setName('user'), 'invites.cmd.resetUser')))
    .addSubcommand((sub) => describe(sub.setName('setup'), 'invites.cmd.setup'))
    .setDMPermission(false);

export default {
    slashOnly: true,
    category: 'Community',
    data: builder,

    /** deps (tests): settings(guildId), counts, leaderboard, latest, joins, bonus, milestones, now. */
    async execute(interaction, guildConfig, client, deps = {}) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const tr = replyText(interaction);
        const guildId = interaction.guildId;
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        let settings;
        try {
            settings = (deps.settings || inviteSettings)(guildId);
        } catch {
            return say(interaction, tr, tr.t('invites.error.dbDown'));
        }

        if (sub === 'setup') return say(interaction, tr, setupText(tr, interaction, settings), 'info');
        if (!settings.enabled) return say(interaction, tr, tr.t('invites.off'));

        try {
            if (sub === 'view') {
                const user = interaction.options.getUser('user') || interaction.user;
                if (user.bot) return say(interaction, tr, tr.t('invites.view.bot'));
                const counts = await (deps.counts || inviteCounts)(guildId, user.id, settings);
                return InteractionHelper.safeEditReply(interaction, { embeds: [countsEmbed(tr, user.id, counts)], allowedMentions: NO_MENTIONS });
            }
            if (sub === 'leaderboard') {
                const page = interaction.options.getInteger('page') || 1;
                const rows = await (deps.leaderboard || cachedLeaderboard)(guildId, settings, { page, pageSize: LEADERBOARD_PAGE_SIZE });
                return InteractionHelper.safeEditReply(interaction, { embeds: [leaderboardEmbed(tr, rows, page)], allowedMentions: NO_MENTIONS });
            }
            if (sub === 'who') {
                const user = interaction.options.getUser('user', true);
                const row = await (deps.latest || latestJoin)(guildId, user.id);
                if (!row) return say(interaction, tr, tr.t('invites.who.none', { user: `<@${user.id}>` }), 'info');
                const ageDays = row.accountCreatedAt ? Math.max(0, Math.floor((new Date(row.joinedAt) - new Date(row.accountCreatedAt)) / DAY_MS)) : null;
                const lines = [
                    tr.t('invites.who.via', { user: `<@${user.id}>`, via: sourceText(tr, row) }),
                    tr.t('invites.who.joined', { at: ts(row.joinedAt) }),
                ];
                if (ageDays !== null) lines.push(tr.t('invites.who.age', { days: ageDays }));
                if (row.leftAt) lines.push(tr.t('invites.who.left', { at: ts(row.leftAt) }));
                if (row.counted === false) lines.push(tr.t('invites.who.notCounted'));
                return say(interaction, tr, lines.join('\n'), 'info');
            }
            if (sub === 'list') {
                const user = interaction.options.getUser('user', true);
                const rows = await (deps.joins || joinsByInviter)(guildId, user.id, settings, { limit: LIST_LIMIT });
                if (!rows.length) return say(interaction, tr, tr.t('invites.list.none', { user: `<@${user.id}>` }), 'info');
                const lines = rows.map((r) => {
                    const marks = [];
                    if (r.fake) marks.push(tr.t('invites.list.fake'));
                    else if (r.leftAt) marks.push(tr.t('invites.list.left'));
                    if (!r.counted) marks.push(tr.t('invites.list.repeat'));
                    if (!r.current) marks.push(tr.t('invites.list.beforeReset'));
                    return `<@${r.userId}> ${ts(r.joinedAt, 'd')}${marks.length ? ` · ${marks.join(', ')}` : ''}`;
                });
                return say(interaction, tr, `${tr.t('invites.list.header', { user: `<@${user.id}>`, count: rows.length })}\n${lines.join('\n')}`.slice(0, 4000), 'info');
            }
            if (group === 'bonus') {
                const user = interaction.options.getUser('user', true);
                if (user.bot) return say(interaction, tr, tr.t('invites.view.bot'));
                const amount = interaction.options.getInteger('amount', true);
                const delta = sub === 'remove' ? -amount : amount;
                let bonus;
                try {
                    bonus = await (deps.bonus || changeBonus)(guildId, user.id, delta, { actorId: interaction.user.id, serverResetAt: settings.resetAt });
                } catch (error) {
                    if (error?.code === 'bonusRange') return say(interaction, tr, tr.t('invites.bonus.range'));
                    throw error;
                }
                forgetLeaderboard(guildId);
                logger.info(`/invites bonus ${sub}: ${interaction.user.id} changed ${user.id} by ${delta} in guild ${guildId}`);
                // Saved: from here on a failed read must not say "nothing was changed".
                let counts;
                try {
                    counts = await (deps.counts || inviteCounts)(guildId, user.id, settings);
                } catch (error) {
                    logger.warn(`/invites bonus: total of ${user.id} not read after the change in guild ${guildId}: ${error.message}`);
                    return say(interaction, tr, tr.t('invites.bonus.doneNoTotal', { user: `<@${user.id}>`, bonus }), 'success');
                }
                if (delta > 0 && settings.milestones.length && interaction.guild) {
                    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
                    if (member) {
                        void (deps.milestones || applyMilestoneRoles)(interaction.guild, member, counts.total, settings)
                            .catch((error) => logger.warn(`Invite milestone roles not given in guild ${guildId}: ${error.message}`));
                    }
                }
                return say(interaction, tr, tr.t('invites.bonus.done', { user: `<@${user.id}>`, bonus, total: counts.total }), 'success');
            }
            if (sub === 'reset') {
                const user = interaction.options.getUser('user');
                return InteractionHelper.safeEditReply(interaction, resetConfirm(tr, interaction.user.id, user ? user.id : 'all'));
            }
        } catch (error) {
            logger.warn(`/invites ${group ? `${group} ` : ''}${sub} failed in guild ${guildId}: ${error.message}`);
            return say(interaction, tr, tr.t('invites.error.dbDown'));
        }
        return say(interaction, tr, tr.t('invites.error.dbDown'));
    },
};

/** The /invites setup text: state, Manage Server, the dashboard page; pure apart from the cache read. */
export function setupText(tr, interaction, settings) {
    const lines = [tr.t(settings.enabled ? 'invites.setup.on' : 'invites.setup.off')];
    if (interaction.guild && !canReadInvites(interaction.guild)) lines.push(tr.t('invites.setup.noManageServer'));
    else if (settings.enabled && getInviteState(interaction.guildId)?.status !== 'ready') lines.push(tr.t('invites.setup.loading'));
    if (settings.milestones.length && !interaction.guild?.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) lines.push(tr.t('invites.setup.noManageRoles'));
    const base = dashboardUrlFor(interaction.guildId);
    lines.push(base ? tr.t('invites.setup.link', { url: `${base}/invites` }) : tr.t('invites.setup.noLink'));
    return lines.join('\n');
}
