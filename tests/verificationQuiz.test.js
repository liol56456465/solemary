// Rules quiz at verification (services/verificationQuiz.js, handlers/verificationQuiz.js):
// validation, shuffling keeps the right answer, pass / fail / cooldown, expiry, the gate before
// verification and the answer buttons (wrong user refused, expired, passed, failed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DISTRACTORS, NOT_YOUR_QUIZ_MESSAGE, QUIZ_EXPIRED_MESSAGE, QUIZ_LIMITS, QUIZ_TTL_MS, QuizPatchSchema,
    createQuizStore, isCorrectChoice, normalizeQuiz, parseQuizButtonArgs, questionPayload, questionProblem, quizGate, shuffledOrder, suggestQuestions,
} from '../src/services/verificationQuiz.js';
import { handleQuizButton } from '../src/handlers/verificationQuiz.js';
import { updateVerificationSettings } from '../src/services/verificationSettingsService.js';

const GUILD = '100000000000000001';
const USER = '300000000000000004';
const OTHER = '300000000000000005';
const ROLE = '600000000000000001';
const Q = (question, answers, correctIndex) => ({ question, answers, correctIndex });
const QUIZ = { enabled: true, cooldownMinutes: 5, questions: [Q('Is spam allowed?', ['No', 'Yes'], 0), Q('Who decides?', ['Anyone', 'Staff', 'Bots', 'Nobody'], 1)] };

function clock(start = 1_700_000_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}
const json = (value) => JSON.stringify(value);
const buttons = (payload) => payload.components[0].toJSON().components;

/** The shown position of the right answer for question `step` of an attempt. */
function rightChoice(attempt, step) {
    return attempt.orders[step].indexOf(attempt.questions[step].correctIndex);
}

// ── validation ────────────────────────────────────────────────────────────

test('validation: lengths, 2–4 answers, correct answer in range, distinct answers, at most 5 questions, cooldown 1–60', () => {
    assert.equal(questionProblem(Q('Fine?', ['Yes', 'No'], 1)), null);
    assert.match(questionProblem(Q('x'.repeat(151), ['Yes', 'No'], 0)), /at most 150/);
    assert.equal(questionProblem(Q('x'.repeat(150), ['Yes', 'No'], 0)), null);
    assert.match(questionProblem(Q('Q', ['y'.repeat(81), 'No'], 0)), /at most 80/);
    assert.match(questionProblem(Q('Q', ['Only'], 0)), /2 to 4 answers/);
    assert.match(questionProblem(Q('Q', ['a', 'b', 'c', 'd', 'e'], 0)), /2 to 4 answers/);
    assert.match(questionProblem(Q('Q', ['a', 'b'], 2)), /not one of the answers/);
    assert.match(questionProblem(Q('Q', ['a', 'b'], -1)), /not one of the answers/);
    assert.match(questionProblem(Q('Q', ['a', 'b'], 0.5)), /whole number/);
    assert.match(questionProblem(Q('Q', ['Same', 'same'], 0)), /all be different/);
    assert.match(questionProblem(Q('Two\nlines', ['a', 'b'], 0)), /one line/);
    assert.match(questionProblem(Q('', ['a', 'b'], 0)), /cannot be empty/);
    assert.match(questionProblem({ ...Q('Q', ['a', 'b'], 0), extra: 1 }), /Unrecognized|unrecognized/i);

    const six = Array.from({ length: 6 }, (_, i) => Q(`Q${i}`, ['a', 'b'], 0));
    assert.equal(QuizPatchSchema.safeParse({ questions: six.slice(0, 5) }).success, true);
    assert.equal(QuizPatchSchema.safeParse({ questions: six }).success, false);
    for (const [minutes, ok] of [[0, false], [1, true], [60, true], [61, false], [2.5, false], ['5', false]]) {
        assert.equal(QuizPatchSchema.safeParse({ cooldownMinutes: minutes }).success, ok, `cooldown ${minutes}`);
    }
    assert.equal(QuizPatchSchema.safeParse({ enabled: 'yes' }).success, false);
    assert.equal(QuizPatchSchema.safeParse({ unknown: true }).success, false);
});

test('settings service: a bad quiz patch is refused before anything is written', async () => {
    let wrote = false;
    const client = { db: { get: async () => { wrote = true; }, set: async () => { wrote = true; } } };
    for (const quiz of [{ questions: [Q('Q', ['a'], 0)] }, { cooldownMinutes: 0 }, { enabled: 1 }, { questions: [Q('Q', ['a', 'b'], 3)] }]) {
        await assert.rejects(updateVerificationSettings(client, GUILD, { quiz }), (error) => error.type === 'validation' && /quiz/i.test(error.userMessage), json(quiz));
    }
    assert.equal(wrote, false);
});

test('normalizeQuiz: off by default; invalid questions dropped; on with no valid question is treated as off', () => {
    for (const stored of [undefined, null, 'x', [], {}]) {
        const quiz = normalizeQuiz(stored);
        assert.equal(quiz.enabled, false);
        assert.equal(quiz.active, false);
        assert.equal(quiz.cooldownMinutes, QUIZ_LIMITS.cooldownDefault);
    }
    const mixed = normalizeQuiz({ enabled: true, cooldownMinutes: 99, questions: [Q('Ok', ['a', 'b'], 1), Q('Bad', ['a'], 0), 'junk'] });
    assert.equal(mixed.questions.length, 1);
    assert.equal(mixed.invalidCount, 2);
    assert.equal(mixed.active, true);
    assert.equal(mixed.cooldownMinutes, 5, 'an out-of-range cooldown falls back to 5');
    const empty = normalizeQuiz({ enabled: true, questions: [Q('Bad', ['a'], 0)] });
    assert.equal(empty.enabled, true);
    assert.equal(empty.active, false);
    assert.notEqual(normalizeQuiz(QUIZ).fingerprint, normalizeQuiz({ ...QUIZ, questions: QUIZ.questions.slice(1) }).fingerprint);
});

// ── shuffling ─────────────────────────────────────────────────────────────

test('shuffling: every order is a permutation and the shown right answer is always the stored right answer', () => {
    const seen = new Set();
    for (let run = 0; run < 300; run += 1) {
        const store = createQuizStore();
        const attempt = store.start(GUILD, USER, normalizeQuiz(QUIZ));
        attempt.questions.forEach((question, step) => {
            const order = attempt.orders[step];
            assert.deepEqual([...order].sort(), question.answers.map((_, i) => i));
            const payload = questionPayload({ ...attempt, step });
            const labels = buttons(payload).map((b) => b.label);
            // The button labelled with the right answer is the one counted as right, and only that one.
            labels.forEach((label, shown) => {
                assert.equal(isCorrectChoice(question, order, shown), label === question.answers[question.correctIndex]);
            });
            if (step === 1) seen.add(order.join(''));
        });
    }
    assert.ok(seen.size > 10, `answer order varies between attempts (${seen.size} orders seen)`);
    // A fixed random source gives a fixed order (Fisher–Yates from the end).
    assert.deepEqual(shuffledOrder(4, () => 0), [1, 2, 3, 0]);
    assert.equal(isCorrectChoice(QUIZ.questions[0], [0, 1], 5), false);
});

test('buttons: custom id vquiz:<user>:<nonce>:<step>:<choice>, labels ≤ 80, no mentions; parse refuses junk', () => {
    const store = createQuizStore();
    const attempt = store.start(GUILD, USER, normalizeQuiz(QUIZ));
    const payload = questionPayload(attempt);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    for (const [shown, button] of buttons(payload).entries()) {
        assert.equal(button.custom_id, `vquiz:${USER}:${attempt.nonce}:0:${shown}`);
        assert.ok(button.custom_id.length <= 100);
        assert.deepEqual(parseQuizButtonArgs(button.custom_id.split(':').slice(1)), { userId: USER, nonce: attempt.nonce, step: 0, choice: shown });
    }
    assert.match(json(payload.embeds[0]), /question 1 of 2/);
    for (const args of [[], ['abc', attempt.nonce, '0', '0'], [USER, 'zz', '0', '0'], [USER, attempt.nonce, '10', '0'], [USER, attempt.nonce, '0', '-1']]) {
        assert.equal(parseQuizButtonArgs(args), null, json(args));
    }
});

// ── pass / fail / cooldown / expiry ───────────────────────────────────────

test('pass: all right → passed and remembered for these questions; changed questions ask again', () => {
    const c = clock();
    const store = createQuizStore({ now: c.now });
    const quiz = normalizeQuiz(QUIZ);
    const attempt = store.start(GUILD, USER, quiz);
    assert.equal(store.answer(GUILD, USER, attempt.nonce, 0, rightChoice(attempt, 0)).status, 'next');
    assert.equal(store.answer(GUILD, USER, attempt.nonce, 1, rightChoice(attempt, 1)).status, 'passed');
    assert.equal(store.hasPassed(GUILD, USER, quiz.fingerprint), true);
    assert.equal(store.hasPassed(GUILD, USER, normalizeQuiz({ ...QUIZ, questions: QUIZ.questions.slice(1) }).fingerprint), false);
    assert.equal(store.hasPassed(GUILD, OTHER, quiz.fingerprint), false);
    assert.equal(store.cooldownLeft(GUILD, USER), 0);
    assert.equal(store.answer(GUILD, USER, attempt.nonce, 1, 0).status, 'expired', 'a finished attempt takes no more answers');
    c.advance(24 * 60 * 60 * 1000 + 1);
    assert.equal(store.hasPassed(GUILD, USER, quiz.fingerprint), false, 'the pass is bounded in time');
});

test('fail: one wrong answer fails only at the end (no hint which), then a cooldown of the set minutes', () => {
    const c = clock();
    const store = createQuizStore({ now: c.now });
    const quiz = normalizeQuiz({ ...QUIZ, cooldownMinutes: 7 });
    const attempt = store.start(GUILD, USER, quiz);
    const wrong = attempt.orders[0].findIndex((i) => i !== attempt.questions[0].correctIndex);
    assert.equal(store.answer(GUILD, USER, attempt.nonce, 0, wrong).status, 'next', 'the next question still comes');
    const result = store.answer(GUILD, USER, attempt.nonce, 1, rightChoice(attempt, 1));
    assert.equal(result.status, 'failed');
    assert.equal(store.hasPassed(GUILD, USER, quiz.fingerprint), false);
    assert.equal(store.cooldownLeft(GUILD, USER), 7 * 60 * 1000);
    c.advance(7 * 60 * 1000 - 1);
    assert.equal(store.cooldownLeft(GUILD, USER), 1);
    c.advance(1);
    assert.equal(store.cooldownLeft(GUILD, USER), 0, 'the wait is over');
});

test('expiry, stale clicks and a newer attempt: old buttons stop working', () => {
    const c = clock();
    const store = createQuizStore({ now: c.now });
    const quiz = normalizeQuiz(QUIZ);
    const first = store.start(GUILD, USER, quiz);
    assert.equal(store.answer(GUILD, USER, first.nonce, 1, 0).status, 'stale', 'a click for a later question is ignored');
    assert.equal(store.answer(GUILD, USER, first.nonce, 0, 9).status, 'stale', 'a choice that is not shown is ignored');
    assert.equal(first.step, 0);
    const second = store.start(GUILD, USER, quiz);
    assert.equal(store.answer(GUILD, USER, first.nonce, 0, 0).status, 'expired', 'the replaced attempt is gone');
    assert.equal(store.answer(GUILD, OTHER, second.nonce, 0, 0).status, 'expired', 'another user cannot use the nonce');
    c.advance(QUIZ_TTL_MS + 1);
    assert.equal(store.answer(GUILD, USER, second.nonce, 0, 0).status, 'expired');
});

test('the maps are bounded: the oldest entries go first', () => {
    const store = createQuizStore({ maxEntries: 3 });
    const quiz = normalizeQuiz(QUIZ);
    const ids = ['300000000000000011', '300000000000000012', '300000000000000013', '300000000000000014', '300000000000000015'];
    const attempts = ids.map((id) => store.start(GUILD, id, quiz));
    assert.equal(store.sizes().attempts, 3);
    assert.equal(store.get(GUILD, ids[0], attempts[0].nonce), null);
    assert.ok(store.get(GUILD, ids[4], attempts[4].nonce));
});

// ── the gate before verification ──────────────────────────────────────────

function gateInteraction({ roles = [] } = {}) {
    return {
        guild: { id: GUILD, channels: { cache: new Map() } },
        user: { id: USER },
        member: { roles: { cache: new Set(roles) } },
    };
}
const config = (verification) => async () => ({ verification });

test('gate: off, verification off, already verified or passed → normal verification; else the first question or the wait', async () => {
    const env = {};
    const store = createQuizStore();
    const on = { enabled: true, roleId: ROLE, quiz: QUIZ };
    assert.equal(await quizGate(null, gateInteraction(), { store, env, readConfig: config({ enabled: true, roleId: ROLE }) }), null, 'quiz not set');
    assert.equal(await quizGate(null, gateInteraction(), { store, env, readConfig: config({ ...on, quiz: { ...QUIZ, enabled: false } }) }), null, 'quiz off');
    assert.equal(await quizGate(null, gateInteraction(), { store, env, readConfig: config({ ...on, quiz: { enabled: true, questions: [] } }) }), null, 'on without questions = off');
    assert.equal(await quizGate(null, gateInteraction(), { store, env, readConfig: config({ ...on, enabled: false }) }), null, 'verification off');
    assert.equal(await quizGate(null, gateInteraction({ roles: [ROLE] }), { store, env, readConfig: config(on) }), null, 'already verified');

    const payload = await quizGate(null, gateInteraction(), { store, env, readConfig: config(on) });
    assert.match(buttons(payload)[0].custom_id, new RegExp(`^vquiz:${USER}:[0-9a-f]{12}:0:0$`));
    assert.deepEqual(payload.allowedMentions, { parse: [] });

    const nonce = buttons(payload)[0].custom_id.split(':')[2];
    const attempt = store.get(GUILD, USER, nonce);
    store.answer(GUILD, USER, nonce, 0, rightChoice(attempt, 0) === 0 ? 1 : 0);
    store.answer(GUILD, USER, nonce, 1, 0);
    const wait = await quizGate(null, gateInteraction(), { store, env, readConfig: config(on) });
    assert.match(json(wait.embeds[0]), /try again in 5 minutes/);
    assert.deepEqual(wait.components, []);

    const passed = createQuizStore();
    const p = passed.start(GUILD, USER, normalizeQuiz(QUIZ));
    passed.answer(GUILD, USER, p.nonce, 0, rightChoice(p, 0));
    passed.answer(GUILD, USER, p.nonce, 1, rightChoice(p, 1));
    assert.equal(await quizGate(null, gateInteraction(), { store: passed, env, readConfig: config(on) }), null, 'passed: no retake');
});

test('gate: a database error is thrown (never verifies past the quiz)', async () => {
    const readConfig = async () => { throw new Error('database not responding'); };
    await assert.rejects(quizGate(null, gateInteraction(), { store: createQuizStore(), readConfig }), /database not responding/);
});

// ── the answer buttons ────────────────────────────────────────────────────

function buttonInteraction(userId = USER) {
    const log = [];
    return {
        log,
        id: '900000000000000001', createdTimestamp: Date.now(),
        guild: { id: GUILD, channels: { cache: new Map() } },
        user: { id: userId },
        deferred: false, replied: false,
        deferUpdate: async function () { log.push('deferUpdate'); this.deferred = true; },
        reply: async function (payload) { log.push(['reply', payload]); this.replied = true; },
        editReply: async (payload) => { log.push(['editReply', payload]); },
        followUp: async (payload) => { log.push(['followUp', payload]); },
    };
}
const argsFor = (attempt, step, choice, userId = USER) => [userId, attempt.nonce, String(step), String(choice)];

test('button: someone else\'s quiz is refused privately, nothing deferred or recorded', async () => {
    const store = createQuizStore();
    const attempt = store.start(GUILD, USER, normalizeQuiz(QUIZ));
    const interaction = buttonInteraction(OTHER);
    await handleQuizButton(interaction, null, argsFor(attempt, 0, 0), { store, proceed: async () => assert.fail('must not verify') });
    assert.equal(interaction.log.length, 1);
    const [kind, payload] = interaction.log[0];
    assert.equal(kind, 'reply');
    assert.equal(payload.content, NOT_YOUR_QUIZ_MESSAGE);
    assert.ok(payload.flags, 'ephemeral');
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(attempt.step, 0, 'nothing recorded');
});

test('button: an expired quiz says so; deferUpdate comes first', async () => {
    const c = clock(Date.now());
    const store = createQuizStore({ now: c.now });
    const attempt = store.start(GUILD, USER, normalizeQuiz(QUIZ));
    c.advance(QUIZ_TTL_MS + 1);
    const interaction = buttonInteraction();
    await handleQuizButton(interaction, null, argsFor(attempt, 0, 0), { store });
    assert.equal(interaction.log[0], 'deferUpdate');
    assert.equal(interaction.log[1][0], 'editReply');
    assert.match(json(interaction.log[1][1]), new RegExp(QUIZ_EXPIRED_MESSAGE.replace('.', '\\.')));
    assert.deepEqual(interaction.log[1][1].components, []);
});

test('button: next question, then pass → the normal verification step; fail → "Not quite" without the answer', async () => {
    const store = createQuizStore();
    const attempt = store.start(GUILD, USER, normalizeQuiz(QUIZ));
    let proceeded = 0;
    const proceed = async () => { proceeded += 1; };
    const one = buttonInteraction();
    await handleQuizButton(one, null, argsFor(attempt, 0, rightChoice(attempt, 0)), { store, proceed });
    assert.match(json(one.log[1][1].embeds[0]), /question 2 of 2/);
    const two = buttonInteraction();
    await handleQuizButton(two, null, argsFor(attempt, 1, rightChoice(attempt, 1)), { store, proceed });
    assert.equal(proceeded, 1);
    assert.deepEqual(two.log, ['deferUpdate']);

    const failing = createQuizStore();
    const f = failing.start(GUILD, USER, normalizeQuiz(QUIZ));
    await handleQuizButton(buttonInteraction(), null, argsFor(f, 0, rightChoice(f, 0)), { store: failing, proceed });
    const last = buttonInteraction();
    const wrong = f.orders[1].findIndex((i) => i !== f.questions[1].correctIndex);
    await handleQuizButton(last, null, argsFor(f, 1, wrong), { store: failing, proceed });
    assert.equal(proceeded, 1, 'a failed quiz never verifies');
    const text = json(last.log[1][1]);
    assert.match(text, /Not quite. Read the rules in the rules channel and try again in 5 minutes\./);
    assert.ok(!text.includes('Staff'), 'the right answer is not revealed');
    assert.deepEqual(last.log[1][1].components, []);
    assert.deepEqual(last.log[1][1].allowedMentions, { parse: [] });
});

test('button: pass but the verification step fails → the quiz buttons are removed, the error goes on', async () => {
    const store = createQuizStore();
    const attempt = store.start(GUILD, USER, normalizeQuiz({ ...QUIZ, questions: QUIZ.questions.slice(0, 1) }));
    const interaction = buttonInteraction();
    const proceed = async () => { throw new Error('cannot assign role'); };
    await handleQuizButton(interaction, null, argsFor(attempt, 0, rightChoice(attempt, 0)), { store, proceed });
    const edits = interaction.log.filter((e) => Array.isArray(e) && e[0] === 'editReply');
    assert.ok(edits.some(([, p]) => Array.isArray(p.components) && p.components.length === 0), 'buttons cleared');
    assert.equal(store.hasPassed(GUILD, USER, normalizeQuiz({ ...QUIZ, questions: QUIZ.questions.slice(0, 1) }).fingerprint), true, 'the pass is kept');
});

test('settings service: move/remove is refused under the lock when the questions changed in between', async () => {
    let stored = { verification: { enabled: true, quiz: { ...QUIZ } } };
    const client = { db: { update: async (key, change) => { stored = await change(stored); return stored; } } };
    const read = QUIZ.questions;
    const swapped = [QUIZ.questions[1], QUIZ.questions[0]];
    const { after } = await updateVerificationSettings(client, GUILD, { quiz: { questions: swapped } }, { expectQuizQuestions: read });
    assert.deepEqual(after.quiz.questions, swapped);
    await assert.rejects(
        updateVerificationSettings(client, GUILD, { quiz: { questions: [read[0]] } }, { expectQuizQuestions: read }),
        (error) => error.type === 'validation' && /changed in the meantime/.test(error.userMessage),
    );
    assert.deepEqual(stored.verification.quiz.questions, swapped, 'nothing overwritten');
});

// ── suggestions ───────────────────────────────────────────────────────────

test('suggestions: one real rule title among wrong answers, valid questions, nothing else touched', () => {
    const rules = { rules: [{ id: 'a', title: 'No spam', text: '' }, { id: 'b', title: 'Be kind', text: '' }, { id: 'c', title: 'No NSFW', text: '' }, { id: 'd', title: 'Listen to staff', text: '' }] };
    const drafts = suggestQuestions(rules, { rand: () => 2 });
    assert.equal(drafts.length, 3);
    drafts.forEach((d, i) => {
        assert.equal(questionProblem(d), null);
        assert.equal(d.answers[d.correctIndex], rules.rules[i].title);
        assert.equal(d.correctIndex, 2);
        assert.ok(d.answers.filter((a, k) => k !== d.correctIndex).every((a) => DISTRACTORS.includes(a)));
    });
    assert.deepEqual(suggestQuestions({ rules: [] }), []);
    assert.deepEqual(suggestQuestions(null), []);
    assert.equal(suggestQuestions(rules, { count: 9 }).length, 4, 'at most one per rule');
});
