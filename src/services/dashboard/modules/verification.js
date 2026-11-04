// verification.js — Verification (button panel) and auto-verify. Writes go through
// services/verificationSettingsService.js (row-locked), shared with /verification.
// Setting up and (re)posting the panel go through services/verificationPanelService.js,
// as /verification setup and /verification dashboard do (Administrators only).

import { botConfig } from '../../../config/bot.js';
import { html, path } from '../html.js';
import {
    InputError, PERMS, autoRoleField, boolField, buttonForm, channelField, channelName, channelPicker, choiceField, intField, numberInput, postForm, rolePicker,
    selectInput, text, textArea, textInput, toggleForm, channelWarnings,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, registryValue, saveRegistry, section, table } from './common.js';
import { QUIZ_LIMITS, normalizeQuiz, questionProblem, suggestQuestions } from '../../verificationQuiz.js';

const CRITERIA = [['none', 'Everyone'], ['account_age', 'Accounts older than the days below'], ['server_size', 'Everyone, while the server is still small']];
const NESTED = ['autoVerify', 'quiz'];

async function update(ctx, patch, message, options = {}) {
    if (!Object.keys(patch).length) return NOTHING;
    const { before, after } = await ctx.services.updateVerificationSettings(ctx.client, ctx.guildId, patch, options);
    const changes = [
        ...diffSnapshots(before, after, Object.keys(patch).filter((k) => !NESTED.includes(k)), 'verification.'),
        ...NESTED.flatMap((k) => (patch[k] ? diffSnapshots(before?.[k] || {}, after?.[k] || {}, Object.keys(patch[k]), `verification.${k}.`) : [])),
    ];
    return { changes, message: changes.length ? message : 'Nothing changed.' };
}

// ── Rules quiz (services/verificationQuiz.js) ────────────────────────────

const SLOTS = Array.from({ length: QUIZ_LIMITS.maxQuestions }, (_, i) => i + 1);
const ANSWER_SLOTS = Array.from({ length: QUIZ_LIMITS.maxAnswers }, (_, i) => i + 1);

/**
 * The question editor's posted fields → questions. Field names: q<N> (question), q<N>a<K>
 * (answers), q<N>c (number of the correct answer). A slot with nothing typed is skipped (that is
 * how a question is removed); a half-filled slot is refused, naming the question.
 */
export function parseQuizForm(form) {
    const questions = [];
    for (const n of SLOTS) {
        const question = text(form, `q${n}`, QUIZ_LIMITS.questionMax);
        const typed = ANSWER_SLOTS.map((k) => ({ k, value: text(form, `q${n}a${k}`, QUIZ_LIMITS.answerMax) }));
        const answers = typed.filter((a) => a.value);
        if (!question && !answers.length) continue;
        const label = `Question ${n}`;
        if (!question) throw new InputError(`${label}: write the question, or clear its answers to remove it.`, 400, `q${n}`);
        if (answers.length < QUIZ_LIMITS.minAnswers) throw new InputError(`${label}: give ${QUIZ_LIMITS.minAnswers} to ${QUIZ_LIMITS.maxAnswers} answers.`, 400, `q${n}a1`);
        const correct = intField(form, `q${n}c`, { min: 1, max: QUIZ_LIMITS.maxAnswers, label: `${label}: correct answer` });
        const correctIndex = answers.findIndex((a) => a.k === correct);
        if (correctIndex === -1) throw new InputError(`${label}: the correct answer (answer ${correct}) is empty.`, 400, `q${n}c`);
        const entry = { question, answers: answers.map((a) => a.value), correctIndex };
        const problem = questionProblem(entry);
        if (problem) throw new InputError(`${label}: ${problem}`, 400, `q${n}`);
        questions.push(entry);
    }
    return questions;
}

function quizSlot(n, q) {
    const answers = q?.answers || [];
    return html`<fieldset class="quiz-slot"><legend>Question ${n}</legend><div class="grid">
${textInput(`q${n}`, q?.question || '', { label: 'Question', max: QUIZ_LIMITS.questionMax, placeholder: n === 1 ? 'Which of these is a rule here?' : '' })}
${selectInput(`q${n}c`, q ? q.correctIndex + 1 : 1, ANSWER_SLOTS.map((k) => [String(k), `Answer ${k}`]), { label: 'Correct answer' })}
${ANSWER_SLOTS.map((k) => textInput(`q${n}a${k}`, answers[k - 1] || '', { label: `Answer ${k}${k > QUIZ_LIMITS.minAnswers ? ' (optional)' : ''}`, max: QUIZ_LIMITS.answerMax }))}</div></fieldset>`;
}

function quizCard(ctx, v, rulesValue) {
    const quiz = normalizeQuiz(v.quiz);
    const suggesting = ctx.query?.quiz === 'suggest';
    const drafts = suggesting ? suggestQuestions(rulesValue).slice(0, QUIZ_LIMITS.maxQuestions - quiz.questions.length) : [];
    const slots = [...quiz.questions, ...drafts];
    const warnings = [];
    if (quiz.enabled && !quiz.active) warnings.push('The quiz is on but has no valid questions, so it is treated as off: members are not asked anything. Add a question below.');
    if (quiz.invalidCount > 0) warnings.push(`${quiz.invalidCount} stored question${quiz.invalidCount === 1 ? ' is' : 's are'} not valid and skipped. Save the questions again to clean this up.`);
    if (quiz.active && !v.enabled) warnings.push('The verification panel is off, so nobody gets the quiz until it is on.');
    let suggestNote = '';
    if (suggesting) {
        if (quiz.questions.length >= QUIZ_LIMITS.maxQuestions) suggestNote = `All ${QUIZ_LIMITS.maxQuestions} questions are used. Remove one to get a suggestion.`;
        else if (!drafts.length) suggestNote = 'There are no server rules to suggest from yet. Add them on the Rules page first.';
        else suggestNote = `${drafts.length} suggested question${drafts.length === 1 ? ' is' : 's are'} filled in below. Nothing is saved yet: check them, edit them, then press Save questions.`;
    }
    const last = quiz.questions.length - 1;
    const rows = quiz.questions.map((q, i) => [
        html`<span class="num">${i + 1}</span>`,
        html`<strong>${q.question}</strong><br><span class="muted">Right answer: ${q.answers[q.correctIndex]}</span>`,
        html`<div class="row-actions">${i > 0 ? buttonForm(ctx, 'verification', 'quiz-move', 'Move up', { index: i, direction: 'up', question: q.question }) : ''}${i < last ? buttonForm(ctx, 'verification', 'quiz-move', 'Move down', { index: i, direction: 'down', question: q.question }) : ''}${buttonForm(ctx, 'verification', 'quiz-remove', 'Remove', { index: i, question: q.question })}</div>`,
    ]);
    const body = html`${warnings.map((w) => html`<p class="warn">${w}</p>`)}${toggleForm(ctx, 'verification', 'quiz-enabled', quiz.enabled, { label: 'Rules quiz' })}
${table(['#', 'Question', ''], rows, 'No questions yet.')}
<p><a class="button-link" href="${path('/verification?quiz=suggest#s-rules-quiz')}">Suggest questions from my rules</a></p>${suggestNote ? html`<p class="muted" role="status">${suggestNote}</p>` : ''}
${postForm(ctx, 'verification', 'quiz', html`${SLOTS.map((n) => quizSlot(n, slots[n - 1]))}<div class="grid">
${numberInput('cooldownMinutes', quiz.cooldownMinutes, { label: 'Wait after a wrong try (minutes)', min: QUIZ_LIMITS.cooldownMin, max: QUIZ_LIMITS.cooldownMax, help: `${QUIZ_LIMITS.cooldownMin} to ${QUIZ_LIMITS.cooldownMax} minutes.` })}</div>`, { submit: 'Save questions' })}
<p class="muted">Empty question slots are skipped; clear a slot to remove that question. The answers are shown in a random order each time.</p>`;
    return section('Rules quiz', body, `Before members get verified, they answer up to ${QUIZ_LIMITS.maxQuestions} questions about your rules. They need every answer right; after a wrong try they wait before trying again, and they are not told which answer was wrong. Members who pass go on to the normal verification step. Off by default.`);
}

async function quizQuestions(ctx) {
    const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
    return normalizeQuiz(v.quiz).questions;
}

/** The saved question at form.index, checked against the posted text (the list may have changed). */
function pickQuestion(questions, form) {
    const index = intField(form, 'index', { min: 0, max: QUIZ_LIMITS.maxQuestions - 1, label: 'Question' });
    if (!questions[index] || questions[index].question !== text(form, 'question', QUIZ_LIMITS.questionMax)) {
        throw new InputError('The quiz questions changed in the meantime. Reload the page and try again.');
    }
    return index;
}

async function autoRoleConfigured(ctx) {
    const [config, welcome] = await Promise.all([
        ctx.services.getGuildConfig(ctx.client, ctx.guildId),
        ctx.services.getWelcomeSettings(ctx.client, ctx.guildId),
    ]);
    return Boolean(config.autoRole) || (Array.isArray(welcome.roleIds) && welcome.roleIds.length > 0);
}

export default {
    key: 'verification',
    label: 'Verification',
    state: 'verification',
    help: 'Verification keeps bots and raiders out. New members only see the rest of the server after they get the verified role. They get it by pressing a button on the verification panel (a message Mewvo posts) or by signing in with Discord. Auto-verify gives the role as soon as they join instead. You can use one or the other, not both.',

    async load(ctx) {
        return {
            v: await ctx.services.getVerificationSettings(ctx.client, ctx.guildId),
            redirect: registryValue(ctx, 'verifySuccessRedirect'),
            rules: ctx.query?.quiz === 'suggest' ? registryValue(ctx, 'serverRules') : null,
        };
    },

    render(ctx, { v, redirect, rules }) {
        const g = ctx.guild;
        const auto = v.autoVerify || {};
        const canPost = ctx.canEdit && ctx.canAct;
        const panel = v.channelId
            ? html`<div class="panel-row"><p>Panel in ${channelName(g, v.channelId)}${channelWarnings(g, v.channelId, PERMS.post).map((w) => html` <span class="field-warn">${w}</span>`)}.</p>
${buttonForm(ctx, 'verification', 'panel-publish', 'Update or re-post the panel', {}, { danger: false, canEdit: canPost })}</div>`
            : html`<p class="warn">No verification panel yet.</p>${postForm(ctx, 'verification', 'setup', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Post the panel in', perms: PERMS.post, optional: false, help: 'Pick a channel new members can see before they are verified.' })}
${rolePicker(g, 'roleId', null, { label: 'Verified role', autoAssign: true, optional: false, help: 'The role members get once verified. Set your channels so that only this role can see them.' })}
${textInput('buttonText', botConfig.verification?.defaultButtonText || 'Verify', { label: 'Button text', max: 80 })}
${textArea('message', botConfig.verification?.defaultMessage || '', { label: 'Panel message', max: 2000, help: 'The text above the button.' })}</div>`, { submit: 'Set up and post the panel', canEdit: canPost })}`;
        const manual = html`${toggleForm(ctx, 'verification', 'enabled', v.enabled === true, { label: 'Verification' })}${panel}
${postForm(ctx, 'verification', 'settings', html`<div class="grid">
${rolePicker(g, 'roleId', v.roleId || null, { label: 'Verified role', autoAssign: true, optional: false, help: 'The role members get once verified.' })}
${textInput('buttonText', v.buttonText || botConfig.verification?.defaultButtonText || 'Verify', { label: 'Button text', max: 80 })}
${textArea('message', v.message || botConfig.verification?.defaultMessage || '', { label: 'Panel message', max: 2000, help: 'The text above the button.' })}</div>`)}
<p class="muted">Saving does not change the message already in Discord. Press "Update or re-post the panel" to show the new text.</p>`;
        const autoForm = html`${toggleForm(ctx, 'verification', 'auto-enabled', auto.enabled === true, { label: 'Auto-verify' })}
${postForm(ctx, 'verification', 'auto', html`<div class="grid">
${selectInput('criteria', auto.criteria || 'none', CRITERIA, { label: 'Who is auto-verified', help: 'Members who do not match still have to use the panel.' })}
${numberInput('accountAgeDays', auto.accountAgeDays ?? '', { label: 'Account older than (days)', min: 1, max: 365, help: 'Only used when you pick accounts older than the days below. New accounts are more often bots.' })}
${rolePicker(g, 'autoRoleId', auto.roleId || null, { label: 'Role given', autoAssign: true, noneLabel: 'the verified role', help: 'The role auto-verified members get.' })}</div>`)}`;
        const web = postForm(ctx, 'verification', 'redirect', html`<div class="grid">${textInput('verifySuccessRedirect', redirect, { label: 'Page after "Verify with Discord"', max: 500, placeholder: 'https://…', help: 'The web page members land on after they verify by signing in with Discord. Leave empty for the default page.' })}</div>`);
        return html`${section('Verification panel', manual)}${quizCard(ctx, v, rules)}${section('Auto-verify', autoForm)}${section('Web verification', web, 'Members can also verify on a web page by signing in with their Discord account.')}`;
    },

    actions: {
        setup: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const channelId = channelField(g, form, 'channelId', { optional: false, label: 'Post the panel in' });
                const roleId = autoRoleField(g, form, 'roleId', { optional: false, label: 'Verified role' });
                const before = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
                if (before.channelId) throw new InputError('The verification panel is already set up. Use "Update or re-post the panel" instead.');
                const { settings } = await ctx.services.setupVerification(ctx.client, g, {
                    channel: g.channels.cache.get(channelId), role: g.roles.cache.get(roleId),
                    message: text(form, 'message', 2000), buttonText: text(form, 'buttonText', 80),
                });
                return {
                    changes: ['enabled', 'channelId', 'roleId', 'message', 'buttonText'].map((key) => ({ key: `verification.${key}`, old: before[key] ?? null, new: settings[key] ?? null })),
                    message: 'Verification set up: the panel is posted and verification is on.',
                };
            },
        },
        'panel-publish': {
            admin: true,
            async run(ctx) {
                const { action, message } = await ctx.services.publishVerificationPanel(ctx.client, ctx.guild);
                return {
                    changes: [{ key: 'verification.panel', old: null, new: action === 'posted' ? { posted: message?.id || true } : { updated: true } }],
                    message: action === 'posted' ? 'The panel was missing: a new one is posted.' : 'The live panel now shows the saved text.',
                };
            },
        },
        async enabled(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Verification');
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            if (enabled && v.autoVerify?.enabled) throw new InputError('Auto-verify is on. Turn auto-verify off before turning the verification panel on.');
            if (enabled && !v.channelId) throw new InputError('The verification panel is not set up yet. Set it up first.');
            const result = await update(ctx, { enabled }, `Verification is now ${enabled ? 'on' : 'off'}.`);
            result.warnings = ['Turning it on or off does not post or remove the panel message. Use "Update or re-post the panel" for that.'];
            return result;
        },
        async settings(ctx, form) {
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            const buttonText = text(form, 'buttonText', 80);
            const message = text(form, 'message', 2000);
            if (!buttonText) throw new InputError('Button text cannot be empty.');
            if (!message) throw new InputError('The panel message cannot be empty.');
            return update(ctx, changedOnly({
                roleId: autoRoleField(ctx.guild, form, 'roleId', { optional: false, label: 'Verified role' }),
                buttonText,
                message,
            }, v), 'Verification settings saved.');
        },
        async 'auto-enabled'(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Auto-verify');
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            if (enabled) {
                const blocking = [];
                if (v.enabled) blocking.push('the verification panel is on');
                if (await autoRoleConfigured(ctx)) blocking.push('auto roles are configured (Welcome & goodbye)');
                if (blocking.length) throw new InputError(`To turn auto-verify on, first turn off: ${blocking.join(', ')}.`);
            }
            return update(ctx, { autoVerify: { enabled } }, `Auto-verify is now ${enabled ? 'on' : 'off'}.`);
        },
        async auto(ctx, form) {
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            const criteria = choiceField(form, 'criteria', CRITERIA.map(([c]) => c), 'Criteria');
            const accountAgeDays = intField(form, 'accountAgeDays', { min: 1, max: 365, label: 'Account older than (days)', fallback: null });
            ctx.services.validateAutoVerifyCriteria(criteria, accountAgeDays);
            const roleId = autoRoleField(ctx.guild, form, 'autoRoleId', { label: 'Auto-verify role' });
            const patch = changedOnly({ criteria, accountAgeDays: criteria === 'account_age' ? accountAgeDays : null, roleId }, v.autoVerify || {});
            if (!Object.keys(patch).length) return NOTHING;
            return update(ctx, { autoVerify: patch }, 'Auto-verify settings saved.');
        },
        async 'quiz-enabled'(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Rules quiz');
            const questions = await quizQuestions(ctx);
            const result = await update(ctx, { quiz: { enabled } }, `The rules quiz is now ${enabled ? 'on' : 'off'}.`);
            if (enabled && !questions.length) result.warnings = ['It has no questions yet, so it is treated as off until you add one.'];
            return result;
        },
        async quiz(ctx, form) {
            const questions = parseQuizForm(form);
            const cooldownMinutes = intField(form, 'cooldownMinutes', { min: QUIZ_LIMITS.cooldownMin, max: QUIZ_LIMITS.cooldownMax, label: 'Wait after a wrong try (minutes)' });
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            const patch = changedOnly({ questions, cooldownMinutes }, v.quiz || {});
            if (!Object.keys(patch).length) return NOTHING;
            const result = await update(ctx, { quiz: patch }, 'Rules quiz saved.');
            if (v.quiz?.enabled === true && !questions.length) result.warnings = ['The quiz is on but has no questions now, so it is treated as off.'];
            return result;
        },
        async 'quiz-move'(ctx, form) {
            const direction = choiceField(form, 'direction', ['up', 'down'], 'Direction');
            const questions = await quizQuestions(ctx);
            const index = pickQuestion(questions, form);
            const target = index + (direction === 'up' ? -1 : 1);
            if (target < 0 || target >= questions.length) throw new InputError(`That question is already at the ${direction === 'up' ? 'top' : 'bottom'}.`);
            const read = structuredClone(questions);
            [questions[index], questions[target]] = [questions[target], questions[index]];
            // The service re-checks the list under the row lock, so a save in between is not lost.
            return update(ctx, { quiz: { questions } }, `Question moved ${direction}.`, { expectQuizQuestions: read });
        },
        async 'quiz-remove'(ctx, form) {
            const questions = await quizQuestions(ctx);
            const index = pickQuestion(questions, form);
            const read = structuredClone(questions);
            questions.splice(index, 1);
            return update(ctx, { quiz: { questions } }, 'Question removed.', { expectQuizQuestions: read });
        },
        async redirect(ctx, form) {
            const value = text(form, 'verifySuccessRedirect', 500);
            if (value === registryValue(ctx, 'verifySuccessRedirect')) return NOTHING;
            return saveRegistry(ctx, { verifySuccessRedirect: value }, 'verification');
        },
    },
};
