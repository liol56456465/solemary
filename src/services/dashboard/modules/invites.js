// invites.js: Community → Invites. Invite tracking (services/invites/): on/off, the fake rule,
// milestone roles, and read-only cards: the leaderboard, the latest joins, the invite codes, and
// a warning when Mewvo lacks Manage Server (no invite list → nothing can be matched).
// Stored as the registry setting `inviteTracking` (guild_settings; this server's own row, B3),
// saved under the row lock (saveRegistryWith), one dashboard_audit row per change.
// Every action is Administrator-only: the page shows who invited whom, and milestone roles are
// handed out by the bot (autoRoleField: no staff permissions, below the bot's role).
// Page text: src/content/dashboard/<lang>/invites.json.

import { html } from '../html.js';
import {
    InputError, autoRoleField, checkbox, intField, numberInput, postForm, rolePicker, switchInput, text,
} from '../forms.js';
import { textFor } from '../language.js';
import { guildRole } from '../../settings/guildSettings.js';
import { INVITE_LIMITS } from '../../settings/settingsRegistry.js';
import { normalizeInviteSettings } from '../../invites/inviteStats.js';
import { registryValue, saveRegistryWith, section, table } from './common.js';
import { adminOnlyActions } from './serverScope.js';

const KEY = 'inviteTracking';
const SLOTS = INVITE_LIMITS.maxMilestones;

/** The member as text: their name when cached, else the id (never a ping on a web page). */
function memberName(guild, id) {
    if (!id) return html`<span class="muted">—</span>`;
    const member = guild?.members?.cache?.get?.(id);
    const name = member?.displayName || member?.user?.username || null;
    return name ? html`${name} <span class="muted">(${id})</span>` : html`<span class="muted">${id}</span>`;
}

const when = (value) => {
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? html`<time datetime="${new Date(ms).toISOString()}">${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}</time>` : '';
};

function sourceLabel(tr, row) {
    const known = ['invite', 'vanity', 'widget', 'discovery', 'bot', 'ambiguous', 'unknown', 'not_ready', 'no_permission'];
    return tr.t(`invites.source.${known.includes(row.source) ? row.source : 'unknown'}`);
}

/** Saves a change of some keys of the setting under the row lock. */
function saveInvites(ctx, change) {
    return saveRegistryWith(ctx, [KEY], (valueOf) => ({ [KEY]: { ...normalizeInviteSettings(valueOf(KEY)), ...change } }), 'invites');
}

export default {
    key: 'invites',
    label: 'Invites',
    // The page help shows {inviter} literally (a welcome placeholder).
    helpParams: { inviter: '{inviter}' },
    help: 'See which invite each member joined through: counts per inviter, a leaderboard, roles for reaching an invite count, and {inviter} in welcome messages. Off by default.',

    async load(ctx) {
        const settings = normalizeInviteSettings(registryValue(ctx, KEY));
        const support = guildRole(ctx.guildId, ctx.env || process.env) === 'support';
        const data = ctx.guild && !support && ctx.services.getInvitePageData
            ? await ctx.services.getInvitePageData(ctx.guild, settings)
            : { canRead: true, cacheStatus: null, leaderboard: [], recent: [], codes: [] };
        return { settings, data, support };
    },

    render(ctx, { settings, data, support }) {
        const tr = textFor(ctx);
        const g = ctx.guild;
        if (support) return section(tr.t('invites.support.title'), html`<p>${tr.t('invites.support.text')}</p>`, '', { key: 'support' });
        const canEdit = ctx.canEdit && ctx.canAct;
        const warning = !data.canRead
            ? section(tr.t('invites.permission.title'), html`<p class="field-warn">${tr.t('invites.permission.text')}</p>`, '', { key: 'permission' })
            : '';
        const settingsForm = postForm(ctx, 'invites', 'settings', html`${switchInput('enabled', settings.enabled, { label: tr.t('invites.settings.enabled'), help: tr.t('invites.settings.enabledHelp') })}
<div class="grid">${numberInput('fakeAccountDays', settings.fakeAccountDays, { label: tr.t('invites.settings.fakeDays'), min: 0, max: INVITE_LIMITS.maxAccountDays, help: tr.t('invites.settings.fakeDaysHelp') })}
${numberInput('fakeLeaveHours', settings.fakeLeaveHours, { label: tr.t('invites.settings.fakeHours'), min: 0, max: INVITE_LIMITS.maxLeaveHours, help: tr.t('invites.settings.fakeHoursHelp') })}</div>`, { canEdit });

        const rows = Array.from({ length: SLOTS }, (_, i) => settings.milestones[i] || null);
        const milestoneForm = postForm(ctx, 'invites', 'milestones', html`${switchInput('stackRoles', settings.stackRoles, { label: tr.t('invites.milestones.stack'), help: tr.t('invites.milestones.stackHelp') })}
${rows.map((m, i) => html`<div class="grid">${numberInput(`count_${i + 1}`, m?.count ?? '', { label: tr.t('invites.milestones.count', { n: i + 1 }), min: 1, max: INVITE_LIMITS.maxCount })}
${rolePicker(g, `role_${i + 1}`, m?.roleId || null, { label: tr.t('invites.milestones.role', { n: i + 1 }), autoAssign: true, noneLabel: tr.t('invites.milestones.none') })}</div>`)}`, { canEdit });

        const unreadable = html`<p class="field-warn">${tr.t('invites.unreadable')}</p>`;
        const board = data.leaderboard === null ? unreadable : table(
            [tr.t('invites.board.rank'), tr.t('invites.board.member'), tr.t('invites.board.total'), tr.t('invites.board.invited'), tr.t('invites.board.left'), tr.t('invites.board.fake'), tr.t('invites.board.bonus')],
            data.leaderboard.map((r) => [String(r.rank), memberName(g, r.userId), String(r.total), String(r.invited), String(r.left), String(r.fake), String(r.bonus)]),
            tr.t('invites.board.empty'));
        const recent = data.recent === null ? unreadable : table(
            [tr.t('invites.recent.member'), tr.t('invites.recent.via'), tr.t('invites.recent.joined'), tr.t('invites.recent.state')],
            data.recent.map((r) => [memberName(g, r.userId),
                html`${sourceLabel(tr, r)}${r.inviterId ? html` · ${memberName(g, r.inviterId)}` : ''}${r.code ? html` <code>${r.code}</code>` : ''}`,
                when(r.joinedAt),
                [r.fake ? tr.t('invites.recent.fake') : '', r.leftAt ? tr.t('invites.recent.left') : '', r.counted === false ? tr.t('invites.recent.repeat') : ''].filter(Boolean).join(', ') || '—']),
            tr.t('invites.recent.empty'));
        const codes = data.codes === null ? unreadable : table(
            [tr.t('invites.codes.code'), tr.t('invites.codes.creator'), tr.t('invites.codes.uses')],
            data.codes.map((c) => [html`<code>${c.code}</code>${c.deleted ? html` <span class="muted">${tr.t('invites.codes.deleted')}</span>` : ''}`,
                memberName(g, c.inviterId), c.maxUses ? `${c.uses} / ${c.maxUses}` : String(c.uses)]),
            tr.t('invites.codes.empty'));
        const loading = settings.enabled && data.canRead && data.cacheStatus !== 'ready' ? html`<p class="muted">${tr.t('invites.codes.loading')}</p>` : '';
        const reset = settings.resetAt ? html`<p class="muted">${tr.t('invites.board.resetAt')} ${when(settings.resetAt)}</p>` : '';

        return html`${warning}
${section(tr.t('invites.settings.title'), settingsForm, tr.t('invites.settings.help'), { key: 'settings' })}
${section(tr.t('invites.milestones.title'), milestoneForm, tr.t('invites.milestones.help'), { key: 'milestones' })}
${section(tr.t('invites.board.title'), html`${reset}${board}`, tr.t('invites.board.help'), { key: 'leaderboard' })}
${section(tr.t('invites.recent.title'), recent, tr.t('invites.recent.help'), { key: 'recent' })}
${section(tr.t('invites.codes.title'), html`${loading}${codes}`, tr.t('invites.codes.help'), { key: 'codes' })}
${section(tr.t('invites.commands.title'), html`<p>${tr.t('invites.commands.text')}</p>`, '', { key: 'commands' })}`;
    },

    actions: adminOnlyActions({
        async settings(ctx, form) {
            const tr = textFor(ctx);
            if (guildRole(ctx.guildId, ctx.env || process.env) === 'support') throw new InputError(tr.t('invites.support.text'));
            const enabled = checkbox(form, 'enabled');
            const fakeAccountDays = intField(form, 'fakeAccountDays', { min: 0, max: INVITE_LIMITS.maxAccountDays, label: tr.t('invites.settings.fakeDays') });
            const fakeLeaveHours = intField(form, 'fakeLeaveHours', { min: 0, max: INVITE_LIMITS.maxLeaveHours, label: tr.t('invites.settings.fakeHours') });
            const result = await saveInvites(ctx, { enabled, fakeAccountDays, fakeLeaveHours });
            // Turned on: load the invite list now, so the next join can be matched.
            if (enabled && ctx.guild) ctx.services.warmInviteCache?.(ctx.guild);
            return { ...result, message: tr.t(enabled ? 'invites.saved.on' : 'invites.saved.off') };
        },
        async milestones(ctx, form) {
            const tr = textFor(ctx);
            if (guildRole(ctx.guildId, ctx.env || process.env) === 'support') throw new InputError(tr.t('invites.support.text'));
            const milestones = [];
            const counts = new Set();
            const roles = new Set();
            for (let i = 1; i <= SLOTS; i += 1) {
                const countRaw = text(form, `count_${i}`, 20);
                const roleRaw = text(form, `role_${i}`, 25);
                if (!countRaw && !roleRaw) continue;
                if (!countRaw || !roleRaw) throw new InputError(tr.t('invites.milestones.incomplete', { n: i }), 400, countRaw ? `role_${i}` : `count_${i}`);
                const count = intField(form, `count_${i}`, { min: 1, max: INVITE_LIMITS.maxCount, label: tr.t('invites.milestones.count', { n: i }) });
                const roleId = autoRoleField(ctx.guild, form, `role_${i}`, { optional: false, label: tr.t('invites.milestones.role', { n: i }) });
                if (counts.has(count)) throw new InputError(tr.t('invites.milestones.sameCount', { count }), 400, `count_${i}`);
                if (roles.has(roleId)) throw new InputError(tr.t('invites.milestones.sameRole'), 400, `role_${i}`);
                counts.add(count);
                roles.add(roleId);
                milestones.push({ count, roleId });
            }
            milestones.sort((a, b) => a.count - b.count);
            const result = await saveInvites(ctx, { milestones, stackRoles: checkbox(form, 'stackRoles') });
            return { ...result, message: tr.t('invites.saved.milestones') };
        },
    }),
};
