// enforcement.js — Enforcement & appeals: the per-server settings moved into
// guild_settings (channels, roles, appeal timings, mass-action guard, stale reports),
// plus the warn ladder, reasons and automod steps read-only (owner decision 3).

import { ENFORCEMENT_REASONS, enforcementConfig } from '../../../config/enforcement.js';
import { AUTOMOD_RULES } from '../../../config/automod.js';
import { formatDuration } from '../../enforcement/format.js';
import { html } from '../html.js';
import { PERMS, channelField, channelPicker, numberInput, postForm, roleField, rolePicker, text, textInput } from '../forms.js';
import { DAY, MINUTE, changedOnly, durationField, registryValue, saveRegistry, section, table, NOTHING } from './common.js';

const KEYS = [
    'adminRequestChannelId', 'modLogChannelId', 'evidenceChannelId', 'appealsCategoryId', 'mutedRoleId', 'warnRoleIds',
    'supportServerInvite', 'appealWindowMs', 'appealCooldownMs', 'rejoinInviteMaxAgeSeconds', 'staleReportMs',
    'staleAppealReminderMs', 'massActionLimit', 'massMuteLimit', 'massActionWindowMs', 'massActionBlockMs',
];

function current(ctx) {
    return Object.fromEntries(KEYS.map((key) => [key, registryValue(ctx, key)]));
}

function stepText(step) {
    if (step.type === 'warn') return 'warn';
    if (!step.durationMs) return `${step.type} (permanent)`;
    return `${step.type} ${formatDuration(step.durationMs)}`;
}

export default {
    key: 'enforcement',
    label: 'Enforcement & appeals',
    help: 'Where enforcement actions are logged, which roles mark muted and warned members, and how appeals and the mass-action guard behave. The same settings the bot reads for /enforcements and appeals.',

    async load(ctx) {
        return { values: current(ctx) };
    },

    render(ctx, { values: v }) {
        const g = ctx.guild;
        const warn = v.warnRoleIds || [];
        const channels = postForm(ctx, 'enforcement', 'channels', html`<div class="grid">
${channelPicker(g, 'modLogChannelId', v.modLogChannelId, { label: 'Mod log channel', perms: PERMS.post, help: 'One line per enforcement action; review and alerts fall back to it.' })}
${channelPicker(g, 'evidenceChannelId', v.evidenceChannelId, { label: 'Evidence channel', perms: PERMS.postFiles, help: 'Re-hosted evidence images (falls back to the mod log).' })}
${channelPicker(g, 'adminRequestChannelId', v.adminRequestChannelId, { label: 'Admin request channel', perms: PERMS.post, help: 'Where moderators ask an administrator to act.' })}
${channelPicker(g, 'appealsCategoryId', v.appealsCategoryId, { label: 'Appeals / reports category', kinds: ['category'], perms: PERMS.category, help: 'Used when /ticket has no category.' })}
${textInput('supportServerInvite', v.supportServerInvite, { label: 'Support server invite', max: 100, placeholder: 'https://discord.gg/…', help: 'Sent to banned members so they can appeal.' })}
</div>`);
        const roles = postForm(ctx, 'enforcement', 'roles', html`<div class="grid">
${rolePicker(g, 'mutedRoleId', v.mutedRoleId, { label: 'Muted role', help: 'Created automatically on the first mute when not set.' })}
${rolePicker(g, 'warnRole1', warn[0] || null, { label: 'Warning role: 1 warning' })}
${rolePicker(g, 'warnRole2', warn[1] || null, { label: 'Warning role: 2 warnings' })}
${rolePicker(g, 'warnRole3', warn[2] || null, { label: 'Warning role: 3+ warnings' })}
</div>`);
        const timings = postForm(ctx, 'enforcement', 'timings', html`<div class="grid">
${numberInput('appealWindowDays', Math.round(v.appealWindowMs / DAY), { label: 'Appeal window (days)', min: 1, max: 365 })}
${numberInput('appealCooldownDays', Math.round(v.appealCooldownMs / DAY), { label: 'Cooldown after a denied appeal (days)', min: 0, max: 90 })}
${numberInput('rejoinInviteHours', Math.round(v.rejoinInviteMaxAgeSeconds / 3600), { label: 'Rejoin invite lifetime (hours)', min: 1, max: 168 })}
${numberInput('staleReportDays', Math.round(v.staleReportMs / DAY), { label: 'Close quiet report channels after (days)', min: 1, max: 90 })}
${numberInput('staleAppealReminderDays', Math.round(v.staleAppealReminderMs / DAY), { label: 'Remind staff about a quiet appeal after (days)', min: 1, max: 90 })}
</div>`);
        const mass = postForm(ctx, 'enforcement', 'mass-action', html`<div class="grid">
${numberInput('massActionLimit', v.massActionLimit, { label: 'Bans/kicks allowed in the window', min: 1, max: 100 })}
${numberInput('massMuteLimit', v.massMuteLimit, { label: 'Mutes allowed in the window', min: 1, max: 200 })}
${numberInput('massActionWindowMinutes', Math.round(v.massActionWindowMs / MINUTE), { label: 'Window (minutes)', min: 1, max: 1440 })}
${numberInput('massActionBlockMinutes', Math.round(v.massActionBlockMs / MINUTE), { label: 'Block length (minutes)', min: 1, max: 10080 })}
</div>`);
        const ladder = table(['Level', 'Warn ladder ban'], Object.entries(enforcementConfig.ladderBans).map(([level, ms]) => [level, ms ? formatDuration(ms) : 'permanent']));
        const reasons = table(['Key', 'Reason', 'Severe'], ENFORCEMENT_REASONS.map((r) => [html`<code>${r.key}</code>`, r.label, r.severe ? 'yes' : 'no']));
        const steps = table(['Rule', 'Steps (1st, 2nd, 3rd+ offence)'], Object.values(AUTOMOD_RULES).map((r) => [r.label, r.steps.map(stepText).join(' → ')]));
        const appealPanels = postForm(ctx, 'enforcement', 'appeal-panels',
            channelPicker(g, 'channelId', null, { label: 'Main-server panel channel', perms: PERMS.post, optional: false, help: 'The support server panel goes to its #appeals channel (created when missing).' }),
            { submit: 'Post the appeal panels', canEdit: ctx.canEdit && ctx.canAct, confirm: 'Post the appeal panels now? Earlier appeal panels in these channels are replaced.' });
        return html`${section('Appeal panels', appealPanels, `Same as /setappeal: posts (or replaces) the appeal panel here and in the support server.${ctx.canAct ? '' : ' Needs Administrator in the main server.'}`)}
${section('Channels', channels)}${section('Roles', roles, 'Warning roles are given for 1, 2 and 3+ active warnings.')}
${section('Appeals and reports', timings)}${section('Mass-action guard', mass, 'A moderator who bans or kicks this many members within the window is blocked from the panel; bot owners get a DM.')}
${section('Warn ladder', html`<p class="muted">${enforcementConfig.warnsPerLevel} warnings at level 0 ban; at level 1 and above the first warning bans. Read-only for now.</p>${ladder}`)}
${section('Reasons', reasons, 'Read-only for now (the keys are stored with each case).')}
${section('Automod steps', steps, 'Read-only for now.')}`;
    },

    actions: {
        'appeal-panels': {
            admin: true,
            async run(ctx, form) {
                const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: 'Main-server panel channel' });
                const { mainChannel, supportChannel, created } = await ctx.services.postAppealPanels(ctx.client, ctx.guild, ctx.guild.channels.cache.get(channelId), { reason: `dashboard: ${ctx.actor.username}` });
                return {
                    changes: [{ key: 'appealPanels', old: null, new: { main: mainChannel.id, support: supportChannel.id } }],
                    message: `Appeal panels posted in #${mainChannel.name} and in #${supportChannel.name} of the support server${created ? ' (created)' : ''}.`,
                };
            },
        },
        async channels(ctx, form) {
            const g = ctx.guild;
            const invite = text(form, 'supportServerInvite', 100);
            const patch = changedOnly({
                modLogChannelId: channelField(g, form, 'modLogChannelId', { label: 'Mod log channel' }),
                evidenceChannelId: channelField(g, form, 'evidenceChannelId', { label: 'Evidence channel' }),
                adminRequestChannelId: channelField(g, form, 'adminRequestChannelId', { label: 'Admin request channel' }),
                appealsCategoryId: channelField(g, form, 'appealsCategoryId', { kinds: ['category'], label: 'Appeals category' }),
                ...(invite ? { supportServerInvite: invite } : {}),
            }, current(ctx));
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'enforcement');
        },
        async roles(ctx, form) {
            const g = ctx.guild;
            const warn = ['warnRole1', 'warnRole2', 'warnRole3'].map((name, i) => roleField(g, form, name, { label: `Warning role ${i + 1}` })).filter(Boolean);
            const patch = changedOnly({
                mutedRoleId: roleField(g, form, 'mutedRoleId', { label: 'Muted role' }),
                warnRoleIds: warn,
            }, current(ctx));
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'enforcement');
        },
        async timings(ctx, form) {
            const patch = changedOnly({
                appealWindowMs: durationField(form, 'appealWindowDays', DAY, { min: 1, max: 365, label: 'Appeal window' }),
                appealCooldownMs: durationField(form, 'appealCooldownDays', DAY, { min: 0, max: 90, label: 'Appeal cooldown' }),
                rejoinInviteMaxAgeSeconds: durationField(form, 'rejoinInviteHours', 3600, { min: 1, max: 168, label: 'Rejoin invite lifetime' }),
                staleReportMs: durationField(form, 'staleReportDays', DAY, { min: 1, max: 90, label: 'Stale report' }),
                staleAppealReminderMs: durationField(form, 'staleAppealReminderDays', DAY, { min: 1, max: 90, label: 'Stale appeal reminder' }),
            }, current(ctx));
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'enforcement');
        },
        async 'mass-action'(ctx, form) {
            const patch = changedOnly({
                massActionLimit: durationField(form, 'massActionLimit', 1, { min: 1, max: 100, label: 'Bans/kicks allowed' }),
                massMuteLimit: durationField(form, 'massMuteLimit', 1, { min: 1, max: 200, label: 'Mutes allowed' }),
                massActionWindowMs: durationField(form, 'massActionWindowMinutes', MINUTE, { min: 1, max: 1440, label: 'Window' }),
                massActionBlockMs: durationField(form, 'massActionBlockMinutes', MINUTE, { min: 1, max: 10080, label: 'Block length' }),
            }, current(ctx));
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'enforcement');
        },
    },
};
