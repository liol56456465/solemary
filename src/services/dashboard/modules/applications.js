// applications.js — Applications: on/off, log channel, manager roles, default
// questions and retention. Writes go through applicationSettingsService (validated,
// row-locked), shared with /app-admin dashboard. Application roles (what members apply
// for) are set up in Discord (/app-admin).

import { formatApplicationQuestionForEditing } from '../../../utils/applicationQuestions.js';
import { MAX_APPLICATION_QUESTIONS, parseQuestionLines } from '../../applicationSettingsService.js';
import { html } from '../html.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelPicker, intField, multiline, numberInput, postForm,
    roleField, rolePicker, roleName, text, textArea, toggleForm,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, section, table } from './common.js';

async function update(ctx, patch, message) {
    if (!Object.keys(patch).length) return NOTHING;
    const { before, after } = await ctx.services.updateApplicationSettings(ctx.client, ctx.guildId, patch);
    const changes = diffSnapshots(before, after, Object.keys(patch), 'applications.');
    return { changes, message: changes.length ? message : 'Nothing changed.' };
}

export default {
    key: 'applications',
    label: 'Applications',
    state: 'applications',
    help: 'Staff and role applications. Default questions apply to roles without their own; add "[min:10]" at the end of a question for a minimum answer length. Application roles are set up with /app-admin in Discord.',

    async load(ctx) {
        return { s: await ctx.services.getApplicationSettings(ctx.client, ctx.guildId) };
    },

    render(ctx, { s }) {
        const g = ctx.guild;
        const managers = s.managerRoles || [];
        const settings = postForm(ctx, 'applications', 'settings', html`<div class="grid">
${channelPicker(g, 'logChannelId', s.logChannelId || null, { label: 'Application log channel', perms: PERMS.post })}
${numberInput('pendingDays', s.pendingApplicationRetentionDays ?? 30, { label: 'Keep pending applications (days)', min: 1, max: 3650 })}
${numberInput('reviewedDays', s.reviewedApplicationRetentionDays ?? 14, { label: 'Keep reviewed applications (days)', min: 1, max: 3650 })}</div>`);
        const questions = postForm(ctx, 'applications', 'questions', textArea('questions', (s.questions || []).map(formatApplicationQuestionForEditing).join('\n'),
            { label: `Default questions (one per line, at most ${MAX_APPLICATION_QUESTIONS})`, rows: 6, max: 1000 }));
        const managerTable = html`${table(['Role', ''], managers.map((id) => [roleName(g, id), buttonForm(ctx, 'applications', 'manager-remove', 'Remove', { roleId: id })]), 'No manager roles.')}
${postForm(ctx, 'applications', 'manager-add', rolePicker(g, 'roleId', null, { label: 'Add manager role', optional: false, assign: false }), { submit: 'Add', inline: true })}`;
        return html`${section('Status', toggleForm(ctx, 'applications', 'enabled', s.enabled === true, { label: 'Applications' }))}
${section('Settings', settings, 'Setting the log channel here also sets the Applications log channel of Logging (as /app-admin does).')}
${section('Default questions', questions)}${section('Manager roles', managerTable, 'Members with these roles can review applications.')}`;
    },

    actions: {
        async enabled(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Applications');
            return update(ctx, { enabled }, `Applications are now ${enabled ? 'on' : 'off'}.`);
        },
        async settings(ctx, form) {
            const s = await ctx.services.getApplicationSettings(ctx.client, ctx.guildId);
            const logChannelId = channelField(ctx.guild, form, 'logChannelId', { label: 'Log channel' });
            const patch = changedOnly({
                logChannelId,
                pendingApplicationRetentionDays: intField(form, 'pendingDays', { min: 1, max: 3650, label: 'Pending retention' }),
                reviewedApplicationRetentionDays: intField(form, 'reviewedDays', { min: 1, max: 3650, label: 'Reviewed retention' }),
            }, s);
            const result = await update(ctx, patch, 'Application settings saved.');
            if (Object.hasOwn(patch, 'logChannelId') && logChannelId) {
                await ctx.services.setLogChannel(ctx.client, ctx.guildId, 'applications', logChannelId);
            }
            return result;
        },
        async questions(ctx, form) {
            const questions = parseQuestionLines(multiline(form, 'questions', 1000));
            const s = await ctx.services.getApplicationSettings(ctx.client, ctx.guildId);
            return update(ctx, changedOnly({ questions }, s), 'Default questions saved.');
        },
        async 'manager-add'(ctx, form) {
            const roleId = roleField(ctx.guild, form, 'roleId', { optional: false, label: 'Manager role' });
            const s = await ctx.services.getApplicationSettings(ctx.client, ctx.guildId);
            const current = s.managerRoles || [];
            if (current.includes(roleId)) return { changes: [], message: 'Already a manager role.' };
            return update(ctx, { managerRoles: [...current, roleId] }, 'Manager role added.');
        },
        async 'manager-remove'(ctx, form) {
            const roleId = text(form, 'roleId', 25);
            const s = await ctx.services.getApplicationSettings(ctx.client, ctx.guildId);
            const current = s.managerRoles || [];
            if (!current.includes(roleId)) throw new InputError('That role is not a manager role.');
            return update(ctx, { managerRoles: current.filter((id) => id !== roleId) }, 'Manager role removed.');
        },
    },
};
