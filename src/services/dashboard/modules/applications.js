// applications.js — Applications: on/off, log channel, manager roles, default
// questions and retention (applicationSettingsService, validated, row-locked), and the
// application roles members apply for with their own questions / log channel
// (applicationRoleService). Both are shared with /app-admin setup and /app-admin dashboard.
// Submitted applications are listed (like /app-admin list) and reviewed with
// applicationReviewService, the same function /app-admin review uses (status, DM to the
// applicant, the log message, the role on approval).

import { formatApplicationQuestionForEditing } from '../../../utils/applicationQuestions.js';
import { MAX_APPLICATION_QUESTIONS, parseQuestionLines } from '../../applicationSettingsService.js';
import { APPLICATION_NAME_MAX } from '../../applicationRoleService.js';
import { REVIEW_NOTE_MAX } from '../../applicationReviewService.js';
import { formatDate, html } from '../html.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelPicker, checkbox, checkboxInput, choiceField, switchInput, intField, isSnowflake, multiline,
    numberInput, pill, postForm, roleField, rolePicker, roleName, selectInput, text, textArea, textInput,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, section, table } from './common.js';

const PENDING_SHOWN = 25;
const REVIEWED_SHOWN = 10;
const APPLICATION_ID = /^[0-9a-z-]{1,40}$/i;
const time = (value) => {
    const ms = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ms) ? ms : 0;
};

/** Pending applications (newest first, capped) and the latest reviewed ones. */
export function splitApplications(applications = []) {
    const sorted = [...applications].sort((a, b) => time(b.createdAt) - time(a.createdAt));
    const pending = sorted.filter((a) => a.status === 'pending');
    const reviewed = sorted.filter((a) => a.status !== 'pending')
        .sort((a, b) => time(b.reviewedAt || b.createdAt) - time(a.reviewedAt || a.createdAt));
    return { pending: pending.slice(0, PENDING_SHOWN), pendingTotal: pending.length, reviewed: reviewed.slice(0, REVIEWED_SHOWN) };
}

function submittedSection(ctx, { pending, pendingTotal, reviewed }) {
    const canReview = ctx.canEdit && ctx.canAct;
    const who = (a) => html`${a.username || 'unknown user'} <span class="muted">${a.userId}</span>`;
    const pendingBlocks = pending.map((a) => html`<details class="sub" data-key="submitted-${a.id}"><summary>${a.roleName || 'Unknown role'} · ${a.username || a.userId} · ${a.createdAt ? formatDate(a.createdAt) : 'unknown date'}</summary>
<p>${who(a)} applied for ${roleName(ctx.guild, a.roleId)}. <span class="muted">ID ${a.id}</span></p>
${(a.answers || []).length ? html`<dl>${a.answers.map((item, i) => html`<dt>Q${i + 1}: ${item.question}</dt><dd class="value">${item.answer || html`<span class="muted">No answer</span>`}</dd>`)}</dl>` : html`<p class="muted">No answers.</p>`}
${postForm(ctx, 'applications', 'review', html`<div class="grid">
${selectInput('decision', 'approve', [['approve', 'Approve (gives the role)'], ['deny', 'Deny']], { label: 'Decision' })}
${textArea('note', '', { label: 'Note to the applicant (optional)', max: REVIEW_NOTE_MAX, rows: 2 })}</div>`,
        { submit: 'Send decision', hidden: { id: a.id }, canEdit: canReview, confirm: `Send this decision to ${a.username || a.userId}? They get a DM.` })}</details>`);
    const reviewedRows = reviewed.map((a) => [a.roleName || 'Unknown role', who(a), pill(a.status === 'approved', a.status === 'approved' ? 'approved' : 'denied', a.status === 'approved' ? 'on' : 'off'),
        a.reviewMessage || '—', a.reviewedAt ? formatDate(a.reviewedAt) : '—']);
    return html`${pendingTotal ? html`<p>${pendingTotal} waiting${pendingTotal > pending.length ? html` (newest ${pending.length} shown)` : ''}.</p>${pendingBlocks}` : html`<p class="muted">No applications are waiting for review.</p>`}
${canReview ? '' : html`<p class="muted">Reviewing needs Administrator in the main server.</p>`}
<h3>Recently reviewed</h3>${table(['Application', 'Member', 'Decision', 'Note', 'Reviewed'], reviewedRows, 'Nothing reviewed yet.')}`;
}

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
    help: 'Staff and role applications. Default questions apply to roles without their own; add "[min:10]" at the end of a question for a minimum answer length.',

    async load(ctx) {
        const [s, roles, submitted] = await Promise.all([
            ctx.services.getApplicationSettings(ctx.client, ctx.guildId),
            ctx.services.listApplicationRoles(ctx.client, ctx.guildId),
            ctx.services.getApplications(ctx.client, ctx.guildId, { limit: 1000 }),
        ]);
        return { s, roles, submitted: splitApplications(submitted || []) };
    },

    render(ctx, { s, roles = [], submitted = splitApplications([]) }) {
        const g = ctx.guild;
        const questionText = (questions) => (questions || []).map(formatApplicationQuestionForEditing).join('\n');
        const roleBlocks = roles.map((r) => html`<details class="sub" data-key="app-${r.roleId}"><summary>${r.name} · ${roleName(g, r.roleId)} ${pill(r.enabled)}</summary>
${postForm(ctx, 'applications', 'role-update', html`<div class="grid">
${textInput('name', r.name, { label: 'Name', max: APPLICATION_NAME_MAX })}
${switchInput('enabled', r.enabled, { label: 'Open for applications' })}
${channelPicker(g, 'logChannelId', r.logChannelId, { label: 'Log channel for this role', perms: PERMS.post, noneLabel: 'the application log channel' })}
${textArea('questions', questionText(r.questions), { label: `Questions (one per line, at most ${MAX_APPLICATION_QUESTIONS}; empty = default questions)`, rows: 5, max: 1000 })}</div>`,
        { submit: 'Save application', hidden: { roleId: r.roleId } })}
${postForm(ctx, 'applications', 'role-delete', checkboxInput('confirm', false, { label: `Also delete every application for ${r.name} (required)` }),
        { submit: 'Delete application', danger: true, hidden: { roleId: r.roleId }, confirm: `Delete the ${r.name} application and every application submitted for it?` })}</details>`);
        const roleCreate = postForm(ctx, 'applications', 'role-create', html`<div class="grid">
${rolePicker(g, 'roleId', null, { label: 'Role members apply for', optional: false })}
${textInput('name', '', { label: 'Name (e.g. Moderator)', max: APPLICATION_NAME_MAX })}
${textArea('questions', '', { label: `Questions (one per line, at most ${MAX_APPLICATION_QUESTIONS}; empty = default questions)`, rows: 4, max: 1000 })}</div>`, { submit: 'Add application' });
        const managers = s.managerRoles || [];
        const settings = postForm(ctx, 'applications', 'settings', html`<div class="grid">
${channelPicker(g, 'logChannelId', s.logChannelId || null, { label: 'Application log channel', perms: PERMS.post })}
${numberInput('pendingDays', s.pendingApplicationRetentionDays ?? 30, { label: 'Keep pending applications (days)', min: 1, max: 3650 })}
${numberInput('reviewedDays', s.reviewedApplicationRetentionDays ?? 14, { label: 'Keep reviewed applications (days)', min: 1, max: 3650 })}</div>`);
        const questions = postForm(ctx, 'applications', 'questions', textArea('questions', (s.questions || []).map(formatApplicationQuestionForEditing).join('\n'),
            { label: `Default questions (one per line, at most ${MAX_APPLICATION_QUESTIONS})`, rows: 6, max: 1000 }));
        const managerTable = html`${table(['Role', ''], managers.map((id) => [roleName(g, id), buttonForm(ctx, 'applications', 'manager-remove', 'Remove', { roleId: id })]), 'No manager roles.')}
${postForm(ctx, 'applications', 'manager-add', rolePicker(g, 'roleId', null, { label: 'Add manager role', optional: false, assign: false }), { submit: 'Add', inline: true })}`;
        // The on/off switch is in the page header (pages.js moduleSettingsPage).
        return html`${section(`Submitted applications (${submitted.pendingTotal} waiting)`, submittedSection(ctx, submitted), 'Approving gives the role and DMs the applicant; denying DMs them. The log message is updated, as with /app-admin review.', { key: 'submitted' })}
${section(`Applications (${roles.length})`, html`${roles.length ? roleBlocks : html`<p class="muted">No applications yet.</p>`}<h3>New application</h3>${roleCreate}`, 'What members can apply for with /apply. Each has its own questions, or uses the default questions.', { key: 'application-roles' })}
${section('Settings', settings, 'Setting the log channel here also sets the Applications log channel of Logging (as /app-admin does).')}
${section('Default questions', questions)}${section('Manager roles', managerTable, 'Members with these roles can review applications.')}`;
    },

    actions: {
        review: {
            admin: true,
            async run(ctx, form) {
                const id = text(form, 'id', 41);
                if (!APPLICATION_ID.test(id)) throw new InputError('Unknown application.');
                const action = choiceField(form, 'decision', ['approve', 'deny'], 'Decision');
                const note = multiline(form, 'note', REVIEW_NOTE_MAX + 1);
                if (note.length > REVIEW_NOTE_MAX) throw new InputError(`The note is limited to ${REVIEW_NOTE_MAX} characters.`, 400, 'note');
                const result = await ctx.services.reviewApplicationAndNotify(ctx.client, ctx.guild, id, { action, reason: note, reviewerId: ctx.actor.userId });
                const app = result.application || {};
                const name = app.username || app.userId || 'the applicant';
                const warnings = [];
                if (!result.dmDelivered) warnings.push(`${name} could not be DMed.`);
                if (result.roleAdded === false) warnings.push('The role could not be given (check my Manage Roles permission and the role order).');
                return {
                    changes: [{ key: `applications.submitted.${id}`, old: 'pending', new: { status: result.status, note: result.reason, user: app.userId || null, role: app.roleName || null } }],
                    message: `Application of ${name} for ${app.roleName || 'the role'} ${result.status}.${result.status === 'approved' && result.roleAdded ? ' The role was given.' : ''}`,
                    warnings,
                };
            },
        },
        async 'role-create'(ctx, form) {
            const roleId = roleField(ctx.guild, form, 'roleId', { optional: false, label: 'Role' });
            const questions = multiline(form, 'questions', 1000);
            const { role, settings } = await ctx.services.createApplicationRole(ctx.client, ctx.guildId, {
                roleId, name: text(form, 'name', APPLICATION_NAME_MAX + 1) || ctx.guild.roles.cache.get(roleId)?.name, questions: questions || null,
            });
            return { changes: [{ key: `applications.role.${roleId}`, old: null, new: { name: role.name, questions: settings.questions } }], message: `Application "${role.name}" added.` };
        },
        async 'role-update'(ctx, form) {
            const roleId = text(form, 'roleId', 25);
            if (!isSnowflake(roleId)) throw new InputError('Unknown application.');
            const questions = multiline(form, 'questions', 1000);
            const name = text(form, 'name', APPLICATION_NAME_MAX + 1);
            if (!name) throw new InputError('The application name cannot be empty.');
            const roles = await ctx.services.listApplicationRoles(ctx.client, ctx.guildId);
            const current = roles.find((r) => r.roleId === roleId);
            if (!current) throw new InputError('That application role no longer exists.');
            const parsed = questions ? parseQuestionLines(questions) : null;
            const patch = changedOnly({
                name,
                enabled: checkbox(form, 'enabled'),
                logChannelId: channelField(ctx.guild, form, 'logChannelId', { label: 'Log channel' }),
                questions: parsed,
            }, current);
            if (!Object.keys(patch).length) return NOTHING;
            const { before, after } = await ctx.services.updateApplicationRole(ctx.client, ctx.guildId, roleId, patch);
            return { changes: diffSnapshots(before, after, Object.keys(patch), `applications.role.${roleId}.`), message: `Application "${after?.name || name}" saved.` };
        },
        async 'role-delete'(ctx, form) {
            const roleId = text(form, 'roleId', 25);
            if (!isSnowflake(roleId)) throw new InputError('Unknown application.');
            if (!checkbox(form, 'confirm')) throw new InputError('Tick the box to confirm: deleting removes every application for this role.');
            const { role, deletedApplications } = await ctx.services.deleteApplicationRole(ctx.client, ctx.guildId, roleId);
            return {
                changes: [{ key: `applications.role.${roleId}`, old: { name: role.name }, new: null }],
                message: `Application "${role.name}" deleted with ${deletedApplications} submitted application(s).`,
            };
        },
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
