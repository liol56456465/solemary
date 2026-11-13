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
import { html, path } from '../html.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelName, channelPicker, checkbox, choiceField, switchInput, intField, isSnowflake, multiline,
    numberInput, pill, postForm, roleField, rolePicker, roleName, selectInput, text, textArea, textInput,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { changedOnly, section, table } from './common.js';
import { textFor } from '../language.js';

// Words: src/content/dashboard/<lang>/applications.json.

const PENDING_SHOWN = 25;
// The page reads the newest applications only (database.js getApplications reads in batches).
export const APPLICATIONS_READ = 200;
const REVIEWED_SHOWN = 10;
const APPLICATION_ID = /^[0-9a-z-]{1,40}$/i;
const time = (value) => {
    const ms = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ms) ? ms : 0;
};

/** "Nothing changed." in the request's language (the same words routes.js uses). */
const nothing = (ctx) => ({ changes: [], message: textFor(ctx).t('errors.nothingChanged') });

/** Pending applications (newest first, capped) and the latest reviewed ones. */
export function splitApplications(applications = []) {
    const sorted = [...applications].sort((a, b) => time(b.createdAt) - time(a.createdAt));
    const pending = sorted.filter((a) => a.status === 'pending');
    const reviewed = sorted.filter((a) => a.status !== 'pending')
        .sort((a, b) => time(b.reviewedAt || b.createdAt) - time(a.reviewedAt || a.createdAt));
    return { pending: pending.slice(0, PENDING_SHOWN), pendingTotal: pending.length, reviewed: reviewed.slice(0, REVIEWED_SHOWN) };
}

function submittedSection(ctx, { pending, pendingTotal, reviewed, capped = false }) {
    const tr = textFor(ctx);
    const canReview = ctx.canEdit && ctx.canAct;
    const who = (a) => html`${a.username || tr.t('applications.submitted.unknownUser')} <span class="muted">${a.userId}</span>`;
    const pendingBlocks = pending.map((a) => html`<details class="sub" data-key="submitted-${a.id}"><summary>${a.roleName || tr.t('applications.submitted.unknownRole')} · ${a.username || a.userId} · ${a.createdAt ? tr.fmtDateTime(a.createdAt) : tr.t('applications.submitted.unknownDate')}</summary>
<p>${tr.tx('applications.submitted.appliedFor', { who: who(a), role: roleName(ctx.guild, a.roleId) })} <span class="muted">${tr.tx('applications.submitted.id', { id: a.id })}</span></p>
${(a.answers || []).length ? html`<dl>${a.answers.map((item, i) => html`<dt>${tr.tx('applications.submitted.question', { number: i + 1, question: item.question })}</dt><dd class="value">${item.answer || html`<span class="muted">${tr.tx('applications.submitted.noAnswer')}</span>`}</dd>`)}</dl>` : html`<p class="muted">${tr.tx('applications.submitted.noAnswers')}</p>`}
${postForm(ctx, 'applications', 'review', html`<div class="grid">
${selectInput('decision', 'approve', [['approve', tr.t('applications.submitted.approve')], ['deny', tr.t('applications.submitted.deny')]], { label: tr.t('applications.submitted.decision') })}
${textArea('note', '', { label: tr.t('applications.submitted.note'), max: REVIEW_NOTE_MAX, rows: 2, help: tr.t('applications.submitted.noteHelp') })}</div>`,
        { submit: tr.t('applications.submitted.submit'), hidden: { id: a.id }, canEdit: canReview, confirm: tr.t('applications.submitted.confirm', { name: a.username || a.userId }) })}</details>`);
    const reviewedRows = reviewed.map((a) => [a.roleName || tr.t('applications.submitted.unknownRole'), who(a), pill(a.status === 'approved', a.status === 'approved' ? tr.t('applications.submitted.approved') : tr.t('applications.submitted.denied'), a.status === 'approved' ? 'on' : 'off'),
        a.reviewMessage || '-', a.reviewedAt ? tr.fmtDateTime(a.reviewedAt) : '-']);
    const waiting = pendingTotal > pending.length
        ? tr.tp('applications.submitted.waitingShown', pendingTotal, { shown: tr.fmtNumber(pending.length) })
        : tr.tp('applications.submitted.waiting', pendingTotal);
    const cappedNote = capped ? html`<p class="muted">${tr.t('applications.submitted.capped', { count: tr.fmtNumber(APPLICATIONS_READ) })}</p>` : '';
    return html`${cappedNote}${pendingTotal ? html`<p>${waiting}</p>${pendingBlocks}` : html`<p class="muted">${tr.tx('applications.submitted.none')}</p>`}
${canReview ? '' : html`<p class="muted">${tr.tx('applications.submitted.needsAdmin')}</p>`}
<h3>${tr.tx('applications.submitted.recent')}</h3>${table([tr.t('applications.submitted.application'), tr.t('applications.submitted.member'), tr.t('applications.submitted.decision'), tr.t('applications.submitted.noteColumn'), tr.t('applications.submitted.reviewed')], reviewedRows, tr.t('applications.submitted.nothingReviewed'))}`;
}

async function update(ctx, patch, message) {
    if (!Object.keys(patch).length) return nothing(ctx);
    const { before, after } = await ctx.services.updateApplicationSettings(ctx.client, ctx.guildId, patch);
    const changes = diffSnapshots(before, after, Object.keys(patch), 'applications.');
    return { changes, message: changes.length ? message : textFor(ctx).t('errors.nothingChanged') };
}

export default {
    key: 'applications',
    label: 'Applications',
    state: 'applications',
    help: 'Let members apply for a role, like moderator, by answering a few questions with /apply in Discord. Staff read the answers and approve or deny. Approving gives the role.',

    async load(ctx) {
        const [s, roles, submitted, config] = await Promise.all([
            ctx.services.getApplicationSettings(ctx.client, ctx.guildId),
            ctx.services.listApplicationRoles(ctx.client, ctx.guildId),
            ctx.services.getApplications(ctx.client, ctx.guildId, { limit: APPLICATIONS_READ }),
            ctx.services.getGuildConfig(ctx.client, ctx.guildId),
        ]);
        const list = submitted || [];
        // Where applications go (the Logging page channel, else one set the old way here).
        const appLogChannel = ctx.services.resolveLogChannel(config, 'applications') || s?.logChannelId || null;
        return { s, roles, appLogChannel, submitted: { ...splitApplications(list), capped: list.length >= APPLICATIONS_READ } };
    },

    render(ctx, { s, roles = [], appLogChannel = null, submitted = splitApplications([]) }) {
        const g = ctx.guild;
        const tr = textFor(ctx);
        const max = tr.fmtNumber(MAX_APPLICATION_QUESTIONS);
        const questionsHelp = tr.t('applications.roles.questionsHelp', { max });
        const questionText = (questions) => (questions || []).map(formatApplicationQuestionForEditing).join('\n');
        // Application roles (given on acceptance) and reviewer roles: Administrator only.
        const adminEdit = ctx.canEdit && ctx.canAct;
        // `reset: true`: a translated "Save …" is not recognised by its word (forms.js postForm).
        const roleBlocks = roles.map((r) => html`<details class="sub" data-key="app-${r.roleId}"><summary>${r.name} · ${roleName(g, r.roleId)} ${pill(r.enabled)}</summary>
${postForm(ctx, 'applications', 'role-update', html`<div class="grid">
${textInput('name', r.name, { label: tr.t('applications.roles.name'), max: APPLICATION_NAME_MAX })}
${switchInput('enabled', r.enabled, { label: tr.t('applications.roles.open'), help: tr.t('applications.roles.openHelp') })}
${channelPicker(g, 'logChannelId', r.logChannelId, { label: tr.t('applications.roles.logChannel'), perms: PERMS.post, noneLabel: tr.t('applications.roles.logChannelNone'), help: tr.t('applications.roles.logChannelHelp') })}
${textArea('questions', questionText(r.questions), { label: tr.t('applications.roles.questions'), rows: 5, max: 1000, help: questionsHelp })}</div>`,
        { submit: tr.t('applications.roles.save'), reset: true, hidden: { roleId: r.roleId }, canEdit: adminEdit })}
${postForm(ctx, 'applications', 'role-delete', html`<p class="muted">${tr.tx('applications.roles.deleteText', { name: r.name })}</p>`,
        { submit: tr.t('applications.roles.delete'), danger: true, hidden: { roleId: r.roleId }, canEdit: adminEdit })}</details>`);
        const roleCreate = postForm(ctx, 'applications', 'role-create', html`<div class="grid">
${rolePicker(g, 'roleId', null, { label: tr.t('applications.roles.role'), optional: false, help: tr.t('applications.roles.roleHelp') })}
${textInput('name', '', { label: tr.t('applications.roles.name'), max: APPLICATION_NAME_MAX, help: tr.t('applications.roles.nameHelp') })}
${textArea('questions', '', { label: tr.t('applications.roles.questions'), rows: 4, max: 1000, help: questionsHelp })}</div>`, { submit: tr.t('applications.roles.add'), canEdit: adminEdit });
        const managers = s.managerRoles || [];
        const settings = postForm(ctx, 'applications', 'settings', html`<div class="grid">
<p class="muted">${tr.tx('applications.settings.logLine', { channel: channelName(g, appLogChannel), link: html`<a href="${path('/logging')}#s-channels">${tr.t('applications.settings.logLineLink')}</a>` })}</p>
${numberInput('pendingDays', s.pendingApplicationRetentionDays ?? 30, { label: tr.t('applications.settings.pendingDays'), min: 1, max: 3650, help: tr.t('applications.settings.pendingDaysHelp') })}
${numberInput('reviewedDays', s.reviewedApplicationRetentionDays ?? 14, { label: tr.t('applications.settings.reviewedDays'), min: 1, max: 3650, help: tr.t('applications.settings.reviewedDaysHelp') })}</div>`);
        const questions = postForm(ctx, 'applications', 'questions', textArea('questions', (s.questions || []).map(formatApplicationQuestionForEditing).join('\n'),
            { label: tr.t('applications.questions.label'), rows: 6, max: 1000, help: tr.t('applications.questions.labelHelp', { max }) }));
        const managerTable = html`${table([tr.t('applications.managers.role'), ''], managers.map((id) => [roleName(g, id), buttonForm(ctx, 'applications', 'manager-remove', tr.t('applications.managers.remove'), { roleId: id }, { canEdit: adminEdit })]), tr.t('applications.managers.empty'))}
${postForm(ctx, 'applications', 'manager-add', rolePicker(g, 'roleId', null, { label: tr.t('applications.managers.addLabel'), optional: false, assign: false }), { submit: tr.t('applications.managers.add'), inline: true, canEdit: adminEdit })}`;
        // The on/off switch is in the page header (pages.js moduleSettingsPage). Explicit keys: the ids stay the English slugs.
        return html`${section(tr.tp('applications.submitted.title', submitted.pendingTotal), submittedSection(ctx, submitted), tr.t('applications.submitted.help'), { key: 'submitted' })}
${section(tr.t('applications.roles.title', { count: tr.fmtNumber(roles.length) }), html`${roles.length ? roleBlocks : html`<p class="muted">${tr.tx('applications.roles.empty')}</p>`}<h3>${tr.tx('applications.roles.new')}</h3>${roleCreate}`, tr.t('applications.roles.help'), { key: 'application-roles' })}
${section(tr.t('applications.settings.title'), settings, tr.t('applications.settings.help'), { key: 'settings' })}
${section(tr.t('applications.questions.title'), questions, tr.t('applications.questions.help'), { key: 'default-questions' })}${section(tr.t('applications.managers.title'), managerTable, tr.t('applications.managers.help'), { key: 'manager-roles' })}`;
    },

    actions: {
        review: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const id = text(form, 'id', 41);
                if (!APPLICATION_ID.test(id)) throw new InputError(tr.t('applications.action.unknown'));
                const action = choiceField(form, 'decision', ['approve', 'deny'], tr.t('applications.submitted.decision'));
                const note = multiline(form, 'note', REVIEW_NOTE_MAX + 1);
                if (note.length > REVIEW_NOTE_MAX) throw new InputError(tr.t('applications.action.noteTooLong', { max: tr.fmtNumber(REVIEW_NOTE_MAX) }), 400, 'note');
                const result = await ctx.services.reviewApplicationAndNotify(ctx.client, ctx.guild, id, { action, reason: note, reviewerId: ctx.actor.userId });
                const app = result.application || {};
                const name = app.username || app.userId || tr.t('applications.action.theApplicant');
                const warnings = [];
                if (!result.dmDelivered) warnings.push(tr.t('applications.action.notDmed', { name }));
                if (result.roleAdded === false) warnings.push(tr.t('applications.action.roleNotGiven'));
                const status = { approved: tr.t('applications.action.statusApproved'), denied: tr.t('applications.action.statusDenied') }[result.status] || result.status;
                return {
                    changes: [{ key: `applications.submitted.${id}`, old: 'pending', new: { status: result.status, note: result.reason, user: app.userId || null, role: app.roleName || null } }],
                    message: tr.t(result.status === 'approved' && result.roleAdded ? 'applications.action.reviewedGiven' : 'applications.action.reviewed', { name, role: app.roleName || tr.t('applications.action.theRole'), status }),
                    warnings,
                };
            },
        },
        // Administrator only: roles given on accepted applications, and who may review them.
        'role-create': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const roleId = roleField(ctx.guild, form, 'roleId', { optional: false, label: tr.t('applications.action.roleLabel') });
                const questions = multiline(form, 'questions', 1000);
                const { role, settings } = await ctx.services.createApplicationRole(ctx.client, ctx.guildId, {
                    roleId, name: text(form, 'name', APPLICATION_NAME_MAX + 1) || ctx.guild.roles.cache.get(roleId)?.name, questions: questions || null,
                });
                return { changes: [{ key: `applications.role.${roleId}`, old: null, new: { name: role.name, questions: settings.questions } }], message: tr.t('applications.action.added', { name: role.name }) };
            },
        },
        // Administrator only: roles given on accepted applications, and who may review them.
        'role-update': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const roleId = text(form, 'roleId', 25);
                if (!isSnowflake(roleId)) throw new InputError(tr.t('applications.action.unknown'));
                const questions = multiline(form, 'questions', 1000);
                const name = text(form, 'name', APPLICATION_NAME_MAX + 1);
                if (!name) throw new InputError(tr.t('applications.action.emptyName'));
                const roles = await ctx.services.listApplicationRoles(ctx.client, ctx.guildId);
                const current = roles.find((r) => r.roleId === roleId);
                if (!current) throw new InputError(tr.t('applications.action.roleGone'));
                const parsed = questions ? parseQuestionLines(questions) : null;
                const patch = changedOnly({
                    name,
                    enabled: checkbox(form, 'enabled'),
                    logChannelId: channelField(ctx.guild, form, 'logChannelId', { label: tr.t('applications.action.logChannelLabel') }),
                    questions: parsed,
                }, current);
                if (!Object.keys(patch).length) return nothing(ctx);
                const { before, after } = await ctx.services.updateApplicationRole(ctx.client, ctx.guildId, roleId, patch);
                return { changes: diffSnapshots(before, after, Object.keys(patch), `applications.role.${roleId}.`), message: tr.t('applications.action.saved', { name: after?.name || name }) };
            },
        },
        'role-delete': {
            admin: true,
            // Two steps (routes.js): confirm() names the application and how many submitted
            // applications go with it; run() only gets the form back with the one-time token.
            async confirm(ctx, form) {
                const tr = textFor(ctx);
                const roleId = text(form, 'roleId', 25);
                if (!isSnowflake(roleId)) throw new InputError(tr.t('applications.action.unknown'));
                const roles = await ctx.services.listApplicationRoles(ctx.client, ctx.guildId);
                const current = roles.find((r) => r.roleId === roleId);
                if (!current) throw new InputError(tr.t('applications.action.roleGone'));
                // getApplications also clears expired applications (as on every read, e.g. this page).
                const sent = (await ctx.services.getApplications(ctx.client, ctx.guildId, { limit: Infinity }) || []).filter((a) => a.roleId === roleId).length;
                return {
                    heading: tr.t('applications.confirm.heading', { name: current.name }),
                    rows: [
                        { label: tr.t('applications.confirm.application'), value: tr.t('applications.confirm.applicationValue', { name: current.name, role: ctx.guild.roles.cache.get(roleId)?.name || roleId }) },
                        { label: tr.t('applications.confirm.submitted'), value: tr.fmtNumber(sent) },
                        { label: tr.t('applications.confirm.effect'), value: tr.t('applications.confirm.effectText') },
                    ],
                    submit: tr.t('applications.confirm.submit'),
                };
            },
            async run(ctx, form) {
                const tr = textFor(ctx);
                const roleId = text(form, 'roleId', 25);
                if (!isSnowflake(roleId)) throw new InputError(tr.t('applications.action.unknown'));
                const { role, deletedApplications } = await ctx.services.deleteApplicationRole(ctx.client, ctx.guildId, roleId);
                return {
                    changes: [{ key: `applications.role.${roleId}`, old: { name: role.name }, new: null }],
                    message: tr.tp('applications.action.deleted', deletedApplications, { name: role.name }),
                };
            },
        },
        async enabled(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('applications.action.moduleLabel'));
            return update(ctx, { enabled }, tr.t(enabled ? 'applications.action.nowOn' : 'applications.action.nowOff'));
        },
        async settings(ctx, form) {
            const tr = textFor(ctx);
            const s = await ctx.services.getApplicationSettings(ctx.client, ctx.guildId);
            const patch = changedOnly({
                pendingApplicationRetentionDays: intField(form, 'pendingDays', { min: 1, max: 3650, label: tr.t('applications.action.pendingDaysLabel') }),
                reviewedApplicationRetentionDays: intField(form, 'reviewedDays', { min: 1, max: 3650, label: tr.t('applications.action.reviewedDaysLabel') }),
            }, s);
            // The log channel is set on the Logging page (one place for every log channel).
            return update(ctx, patch, tr.t('applications.action.settingsSaved'));
        },
        async questions(ctx, form) {
            const questions = parseQuestionLines(multiline(form, 'questions', 1000));
            const s = await ctx.services.getApplicationSettings(ctx.client, ctx.guildId);
            return update(ctx, changedOnly({ questions }, s), textFor(ctx).t('applications.action.questionsSaved'));
        },
        // Administrator only: roles given on accepted applications, and who may review them.
        'manager-add': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const roleId = roleField(ctx.guild, form, 'roleId', { optional: false, label: tr.t('applications.action.managerLabel') });
                const s = await ctx.services.getApplicationSettings(ctx.client, ctx.guildId);
                const current = s.managerRoles || [];
                if (current.includes(roleId)) return { changes: [], message: tr.t('applications.action.alreadyManager') };
                return update(ctx, { managerRoles: [...current, roleId] }, tr.t('applications.action.managerAdded'));
            },
        },
        // Administrator only: roles given on accepted applications, and who may review them.
        'manager-remove': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const roleId = text(form, 'roleId', 25);
                const s = await ctx.services.getApplicationSettings(ctx.client, ctx.guildId);
                const current = s.managerRoles || [];
                if (!current.includes(roleId)) throw new InputError(tr.t('applications.action.notManager'));
                return update(ctx, { managerRoles: current.filter((id) => id !== roleId) }, tr.t('applications.action.managerRemoved'));
            },
        },
    },
};
