// verification.js — Verification (button panel) and auto-verify. Writes go through
// services/verificationSettingsService.js (row-locked), shared with /verification.
// Setting up and (re)posting the panel go through services/verificationPanelService.js,
// as /verification setup and /verification dashboard do (Administrators only).
// Words: src/content/dashboard/<lang>/verification.json (the quiz service's own problem texts stay as they are).

import { botConfig } from '../../../config/bot.js';
import { html, path } from '../html.js';
import {
    InputError, PERMS, autoRoleField, boolField, buttonForm, channelField, channelName, channelPicker, choiceField, intField, numberInput, postForm, rolePicker,
    selectInput, text, textArea, textInput, toggleForm, channelWarnings,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { currentText, textFor } from '../language.js';
import { changedOnly, registryValue, saveRegistry, section, table } from './common.js';
import { QUIZ_LIMITS, normalizeQuiz, questionProblem, suggestQuestions } from '../../verificationQuiz.js';

const CRITERIA_KEYS = ['none', 'account_age', 'server_size'];
const CRITERIA_LABEL = { none: 'verification.auto.criteriaNone', account_age: 'verification.auto.criteriaAge', server_size: 'verification.auto.criteriaSmall' };
const criteria = (tr) => CRITERIA_KEYS.map((key) => [key, tr.t(CRITERIA_LABEL[key])]);
const NESTED = ['autoVerify', 'quiz'];
// Audit keys (dashboard_audit), not catalog keys.
const AUDIT = 'verification.';

/** "Nothing changed." in the request's language. */
function nothing(ctx) {
    return { changes: [], message: textFor(ctx).t('errors.nothingChanged') };
}

async function update(ctx, patch, message, options = {}) {
    if (!Object.keys(patch).length) return nothing(ctx);
    const { before, after } = await ctx.services.updateVerificationSettings(ctx.client, ctx.guildId, patch, options);
    const changes = [
        ...diffSnapshots(before, after, Object.keys(patch).filter((k) => !NESTED.includes(k)), AUDIT),
        ...NESTED.flatMap((k) => (patch[k] ? diffSnapshots(before?.[k] || {}, after?.[k] || {}, Object.keys(patch[k]), `verification.${k}.`) : [])),
    ];
    return { changes, message: changes.length ? message : textFor(ctx).t('errors.nothingChanged') };
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
    const tr = currentText();
    const questions = [];
    for (const n of SLOTS) {
        const question = text(form, `q${n}`, QUIZ_LIMITS.questionMax);
        const typed = ANSWER_SLOTS.map((k) => ({ k, value: text(form, `q${n}a${k}`, QUIZ_LIMITS.answerMax) }));
        const answers = typed.filter((a) => a.value);
        if (!question && !answers.length) continue;
        const label = tr.t('verification.quiz.questionN', { n: tr.fmtNumber(n) });
        if (!question) throw new InputError(tr.t('verification.error.noQuestion', { label }), 400, `q${n}`);
        if (answers.length < QUIZ_LIMITS.minAnswers) throw new InputError(tr.t('verification.error.answerCount', { label, min: tr.fmtNumber(QUIZ_LIMITS.minAnswers), max: tr.fmtNumber(QUIZ_LIMITS.maxAnswers) }), 400, `q${n}a1`);
        const correct = intField(form, `q${n}c`, { min: 1, max: QUIZ_LIMITS.maxAnswers, label: tr.t('verification.error.correctLabel', { label }) });
        const correctIndex = answers.findIndex((a) => a.k === correct);
        if (correctIndex === -1) throw new InputError(tr.t('verification.error.correctEmpty', { label, answer: tr.fmtNumber(correct) }), 400, `q${n}c`);
        const entry = { question, answers: answers.map((a) => a.value), correctIndex };
        const problem = questionProblem(entry);
        if (problem) throw new InputError(tr.t('forms.error.problem', { label, problem }), 400, `q${n}`);
        questions.push(entry);
    }
    return questions;
}

function quizSlot(tr, n, q) {
    const answers = q?.answers || [];
    return html`<fieldset class="quiz-slot"><legend>${tr.t('verification.quiz.questionN', { n: tr.fmtNumber(n) })}</legend><div class="grid">
${textInput(`q${n}`, q?.question || '', { label: tr.t('verification.quiz.question'), max: QUIZ_LIMITS.questionMax, placeholder: n === 1 ? tr.t('verification.quiz.placeholder') : '' })}
${selectInput(`q${n}c`, q ? q.correctIndex + 1 : 1, ANSWER_SLOTS.map((k) => [String(k), tr.t('verification.quiz.answerN', { n: tr.fmtNumber(k) })]), { label: tr.t('verification.quiz.correct') })}
${ANSWER_SLOTS.map((k) => textInput(`q${n}a${k}`, answers[k - 1] || '', { label: tr.t(k > QUIZ_LIMITS.minAnswers ? 'verification.quiz.answerOptional' : 'verification.quiz.answerN', { n: tr.fmtNumber(k) }), max: QUIZ_LIMITS.answerMax }))}</div></fieldset>`;
}

function quizCard(ctx, v, rulesValue) {
    const tr = textFor(ctx);
    const quiz = normalizeQuiz(v.quiz);
    const suggesting = ctx.query?.quiz === 'suggest';
    const drafts = suggesting ? suggestQuestions(rulesValue).slice(0, QUIZ_LIMITS.maxQuestions - quiz.questions.length) : [];
    const slots = [...quiz.questions, ...drafts];
    const warnings = [];
    if (quiz.enabled && !quiz.active) warnings.push(tr.t('verification.quiz.warnNoQuestions'));
    if (quiz.invalidCount > 0) warnings.push(tr.tp('verification.quiz.warnInvalid', quiz.invalidCount));
    if (quiz.active && !v.enabled) warnings.push(tr.t('verification.quiz.warnPanelOff'));
    let suggestNote = '';
    if (suggesting) {
        if (quiz.questions.length >= QUIZ_LIMITS.maxQuestions) suggestNote = tr.tp('verification.quiz.suggestFull', QUIZ_LIMITS.maxQuestions);
        else if (!drafts.length) suggestNote = tr.t('verification.quiz.suggestNoRules');
        else suggestNote = tr.tp('verification.quiz.suggested', drafts.length);
    }
    const last = quiz.questions.length - 1;
    const rows = quiz.questions.map((q, i) => [
        html`<span class="num">${i + 1}</span>`,
        html`<strong>${q.question}</strong><br><span class="muted">${tr.t('verification.quiz.rightAnswer', { answer: q.answers[q.correctIndex] })}</span>`,
        html`<div class="row-actions">${i > 0 ? buttonForm(ctx, 'verification', 'quiz-move', tr.t('verification.quiz.moveUp'), { index: i, direction: 'up', question: q.question }) : ''}${i < last ? buttonForm(ctx, 'verification', 'quiz-move', tr.t('verification.quiz.moveDown'), { index: i, direction: 'down', question: q.question }) : ''}${buttonForm(ctx, 'verification', 'quiz-remove', tr.t('verification.quiz.remove'), { index: i, question: q.question })}</div>`,
    ]);
    const body = html`${warnings.map((w) => html`<p class="warn">${w}</p>`)}${toggleForm(ctx, 'verification', 'quiz-enabled', quiz.enabled, { label: tr.t('verification.quiz.toggle') })}
${table(['#', tr.t('verification.quiz.question'), ''], rows, tr.t('verification.quiz.empty'))}
<p><a class="button-link" href="${path('/verification?quiz=suggest#s-rules-quiz')}">${tr.t('verification.quiz.suggest')}</a></p>${suggestNote ? html`<p class="muted" role="status">${suggestNote}</p>` : ''}
${postForm(ctx, 'verification', 'quiz', html`${SLOTS.map((n) => quizSlot(tr, n, slots[n - 1]))}<div class="grid">
${numberInput('cooldownMinutes', quiz.cooldownMinutes, { label: tr.t('verification.quiz.cooldown'), min: QUIZ_LIMITS.cooldownMin, max: QUIZ_LIMITS.cooldownMax, help: tr.tp('verification.quiz.cooldownHelp', QUIZ_LIMITS.cooldownMax, { min: tr.fmtNumber(QUIZ_LIMITS.cooldownMin) }) })}</div>`, { submit: tr.t('verification.quiz.submit'), reset: true })}
<p class="muted">${tr.t('verification.quiz.slotsNote')}</p>`;
    return section(tr.t('verification.quiz.title'), body, tr.tp('verification.quiz.help', QUIZ_LIMITS.maxQuestions), { key: 'rules-quiz' });
}

async function quizQuestions(ctx) {
    const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
    return normalizeQuiz(v.quiz).questions;
}

/** The saved question at form.index, checked against the posted text (the list may have changed). */
function pickQuestion(tr, questions, form) {
    const index = intField(form, 'index', { min: 0, max: QUIZ_LIMITS.maxQuestions - 1, label: tr.t('verification.quiz.question') });
    if (!questions[index] || questions[index].question !== text(form, 'question', QUIZ_LIMITS.questionMax)) {
        throw new InputError(tr.t('verification.error.quizChanged'));
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
        const tr = textFor(ctx);
        const g = ctx.guild;
        const auto = v.autoVerify || {};
        const canPost = ctx.canEdit && ctx.canAct;
        const panel = v.channelId
            ? html`<div class="panel-row"><p>${tr.tx('verification.panel.in', { channel: html`${channelName(g, v.channelId)}${channelWarnings(g, v.channelId, PERMS.post).map((w) => html` <span class="field-warn">${w}</span>`)}` })}</p>
${buttonForm(ctx, 'verification', 'panel-publish', tr.t('verification.panel.publish'), {}, { danger: false, canEdit: canPost })}</div>`
            : html`<p class="warn">${tr.t('verification.panel.none')}</p>${postForm(ctx, 'verification', 'setup', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: tr.t('verification.panel.channel'), perms: PERMS.post, optional: false, help: tr.t('verification.panel.channelHelp') })}
${rolePicker(g, 'roleId', null, { label: tr.t('verification.panel.role'), autoAssign: true, optional: false, help: tr.t('verification.panel.roleSetupHelp') })}
${textInput('buttonText', botConfig.verification?.defaultButtonText || 'Verify', { label: tr.t('verification.panel.buttonText'), max: 80 })}
${textArea('message', botConfig.verification?.defaultMessage || '', { label: tr.t('verification.panel.message'), max: 2000, help: tr.t('verification.panel.messageHelp') })}</div>`, { submit: tr.t('verification.panel.setup'), canEdit: canPost })}`;
        const manual = html`${toggleForm(ctx, 'verification', 'enabled', v.enabled === true, { label: tr.t('verification.panel.toggle') })}${panel}
${postForm(ctx, 'verification', 'settings', html`<div class="grid">
${rolePicker(g, 'roleId', v.roleId || null, { label: tr.t('verification.panel.role'), autoAssign: true, optional: false, help: tr.t('verification.panel.roleHelp') })}
${textInput('buttonText', v.buttonText || botConfig.verification?.defaultButtonText || 'Verify', { label: tr.t('verification.panel.buttonText'), max: 80 })}
${textArea('message', v.message || botConfig.verification?.defaultMessage || '', { label: tr.t('verification.panel.message'), max: 2000, help: tr.t('verification.panel.messageHelp') })}</div>`)}
<p class="muted">${tr.tx('verification.panel.savingNote')}</p>`;
        const autoForm = html`${toggleForm(ctx, 'verification', 'auto-enabled', auto.enabled === true, { label: tr.t('verification.auto.toggle') })}
${postForm(ctx, 'verification', 'auto', html`<div class="grid">
${selectInput('criteria', auto.criteria || 'none', criteria(tr), { label: tr.t('verification.auto.criteria'), help: tr.t('verification.auto.criteriaHelp') })}
${numberInput('accountAgeDays', auto.accountAgeDays ?? '', { label: tr.t('verification.auto.age'), min: 1, max: 365, help: tr.t('verification.auto.ageHelp') })}
${rolePicker(g, 'autoRoleId', auto.roleId || null, { label: tr.t('verification.auto.role'), autoAssign: true, noneLabel: tr.t('verification.auto.roleNone'), help: tr.t('verification.auto.roleHelp') })}</div>`)}`;
        const web = postForm(ctx, 'verification', 'redirect', html`<div class="grid">${textInput('verifySuccessRedirect', redirect, { label: tr.t('verification.web.page'), max: 500, placeholder: 'https://…', help: tr.t('verification.web.pageHelp') })}</div>`);
        // Keys: the English titles' slugs.
        return html`${section(tr.t('verification.panel.title'), manual, '', { key: 'verification-panel' })}${quizCard(ctx, v, rules)}${section(tr.t('verification.auto.title'), autoForm, '', { key: 'auto-verify' })}${section(tr.t('verification.web.title'), web, tr.t('verification.web.help'), { key: 'web-verification' })}`;
    },

    actions: {
        setup: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const g = ctx.guild;
                const channelId = channelField(g, form, 'channelId', { optional: false, label: tr.t('verification.panel.channel') });
                const roleId = autoRoleField(g, form, 'roleId', { optional: false, label: tr.t('verification.panel.role') });
                const before = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
                if (before.channelId) throw new InputError(tr.t('verification.error.alreadySetUp'));
                const { settings } = await ctx.services.setupVerification(ctx.client, g, {
                    channel: g.channels.cache.get(channelId), role: g.roles.cache.get(roleId),
                    message: text(form, 'message', 2000), buttonText: text(form, 'buttonText', 80),
                });
                return {
                    changes: ['enabled', 'channelId', 'roleId', 'message', 'buttonText'].map((key) => ({ key: `verification.${key}`, old: before[key] ?? null, new: settings[key] ?? null })),
                    message: tr.t('verification.action.setUp'),
                };
            },
        },
        'panel-publish': {
            admin: true,
            async run(ctx) {
                const { action, message } = await ctx.services.publishVerificationPanel(ctx.client, ctx.guild);
                return {
                    changes: [{ key: `${AUDIT}panel`, old: null, new: action === 'posted' ? { posted: message?.id || true } : { updated: true } }],
                    message: textFor(ctx).t(action === 'posted' ? 'verification.action.posted' : 'verification.action.updated'),
                };
            },
        },
        async enabled(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('verification.panel.toggle'));
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            if (enabled && v.autoVerify?.enabled) throw new InputError(tr.t('verification.error.autoIsOn'));
            if (enabled && !v.channelId) throw new InputError(tr.t('verification.error.notSetUp'));
            const result = await update(ctx, { enabled }, tr.t(enabled ? 'verification.action.on' : 'verification.action.off'));
            result.warnings = [tr.t('verification.action.toggleNote')];
            return result;
        },
        async settings(ctx, form) {
            const tr = textFor(ctx);
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            const buttonText = text(form, 'buttonText', 80);
            const message = text(form, 'message', 2000);
            if (!buttonText) throw new InputError(tr.t('verification.error.buttonEmpty'));
            if (!message) throw new InputError(tr.t('verification.error.messageEmpty'));
            return update(ctx, changedOnly({
                roleId: autoRoleField(ctx.guild, form, 'roleId', { optional: false, label: tr.t('verification.panel.role') }),
                buttonText,
                message,
            }, v), tr.t('verification.action.saved'));
        },
        async 'auto-enabled'(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('verification.auto.toggle'));
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            if (enabled) {
                const blocking = [];
                if (v.enabled) blocking.push(tr.t('verification.error.blockPanel'));
                if (await autoRoleConfigured(ctx)) blocking.push(tr.t('verification.error.blockAutoRoles'));
                if (blocking.length) throw new InputError(tr.t('verification.error.blocked', { list: blocking.join(', ') }));
            }
            return update(ctx, { autoVerify: { enabled } }, tr.t(enabled ? 'verification.action.autoOn' : 'verification.action.autoOff'));
        },
        async auto(ctx, form) {
            const tr = textFor(ctx);
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            const chosen = choiceField(form, 'criteria', CRITERIA_KEYS, tr.t('verification.auto.criteriaLabel'));
            const accountAgeDays = intField(form, 'accountAgeDays', { min: 1, max: 365, label: tr.t('verification.auto.age'), fallback: null });
            ctx.services.validateAutoVerifyCriteria(chosen, accountAgeDays);
            const roleId = autoRoleField(ctx.guild, form, 'autoRoleId', { label: tr.t('verification.auto.roleLabel') });
            const patch = changedOnly({ criteria: chosen, accountAgeDays: chosen === 'account_age' ? accountAgeDays : null, roleId }, v.autoVerify || {});
            if (!Object.keys(patch).length) return nothing(ctx);
            return update(ctx, { autoVerify: patch }, tr.t('verification.action.autoSaved'));
        },
        async 'quiz-enabled'(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('verification.quiz.toggle'));
            const questions = await quizQuestions(ctx);
            const result = await update(ctx, { quiz: { enabled } }, tr.t(enabled ? 'verification.action.quizOn' : 'verification.action.quizOff'));
            if (enabled && !questions.length) result.warnings = [tr.t('verification.action.quizEmpty')];
            return result;
        },
        async quiz(ctx, form) {
            const tr = textFor(ctx);
            const questions = parseQuizForm(form);
            const cooldownMinutes = intField(form, 'cooldownMinutes', { min: QUIZ_LIMITS.cooldownMin, max: QUIZ_LIMITS.cooldownMax, label: tr.t('verification.quiz.cooldown') });
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            const patch = changedOnly({ questions, cooldownMinutes }, v.quiz || {});
            if (!Object.keys(patch).length) return nothing(ctx);
            const result = await update(ctx, { quiz: patch }, tr.t('verification.action.quizSaved'));
            if (v.quiz?.enabled === true && !questions.length) result.warnings = [tr.t('verification.action.quizNowEmpty')];
            return result;
        },
        async 'quiz-move'(ctx, form) {
            const tr = textFor(ctx);
            const direction = choiceField(form, 'direction', ['up', 'down'], tr.t('verification.action.directionLabel'));
            const questions = await quizQuestions(ctx);
            const index = pickQuestion(tr, questions, form);
            const target = index + (direction === 'up' ? -1 : 1);
            if (target < 0 || target >= questions.length) throw new InputError(tr.t(direction === 'up' ? 'verification.error.atTop' : 'verification.error.atBottom'));
            const read = structuredClone(questions);
            [questions[index], questions[target]] = [questions[target], questions[index]];
            // The service re-checks the list under the row lock, so a save in between is not lost.
            return update(ctx, { quiz: { questions } }, tr.t(direction === 'up' ? 'verification.action.movedUp' : 'verification.action.movedDown'), { expectQuizQuestions: read });
        },
        async 'quiz-remove'(ctx, form) {
            const tr = textFor(ctx);
            const questions = await quizQuestions(ctx);
            const index = pickQuestion(tr, questions, form);
            const read = structuredClone(questions);
            questions.splice(index, 1);
            return update(ctx, { quiz: { questions } }, tr.t('verification.action.removed'), { expectQuizQuestions: read });
        },
        async redirect(ctx, form) {
            const value = text(form, 'verifySuccessRedirect', 500);
            if (value === registryValue(ctx, 'verifySuccessRedirect')) return nothing(ctx);
            return saveRegistry(ctx, { verifySuccessRedirect: value }, 'verification');
        },
    },
};
