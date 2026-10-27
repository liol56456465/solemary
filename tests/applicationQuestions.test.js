import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeApplicationQuestions,
    parseApplicationQuestionInput,
    formatApplicationQuestionForEditing,
} from '../src/utils/applicationQuestions.js';
import { getDefaultApplicationQuestions } from '../src/config/bot.js';
import ApplicationService from '../src/services/applicationService.js';

test('stored questions in either shape normalize; strings default to minimum 1', () => {
    assert.deepEqual(
        normalizeApplicationQuestions(['How old are you?', { question: 'Why join?', minLength: 10 }, { question: 'Odd', minLength: 'x' }, '', null]),
        [
            { question: 'How old are you?', minLength: 1 },
            { question: 'Why join?', minLength: 10 },
            { question: 'Odd', minLength: 1 },
        ]
    );
});

test('editor [min:N] tag round-trips and plain text stays a string', () => {
    assert.equal(parseApplicationQuestionInput('  How old are you?  '), 'How old are you?');
    assert.deepEqual(parseApplicationQuestionInput('Why join? [min:10]'), { question: 'Why join?', minLength: 10 });
    assert.deepEqual(parseApplicationQuestionInput('Why join? [MIN 5000]'), { question: 'Why join?', minLength: 1000 });
    assert.equal(parseApplicationQuestionInput('Why join? [min:1]'), 'Why join?');
    assert.equal(parseApplicationQuestionInput('   '), null);
    assert.equal(formatApplicationQuestionForEditing({ question: 'Why join?', minLength: 10 }), 'Why join? [min:10]');
    assert.equal(formatApplicationQuestionForEditing('How old are you?'), 'How old are you?');
});

test('defaults keep 10 characters only for the open question', () => {
    const defaults = normalizeApplicationQuestions(getDefaultApplicationQuestions());
    assert.equal(defaults.find(q => /old/.test(q.question)).minLength, 1);
    assert.equal(defaults.find(q => /join/.test(q.question)).minLength, 10);
});

test('validation uses each answer\'s minimum: "18" passes for age, short reasons fail', () => {
    const base = { guildId: '1', userId: '2', roleId: '3' };
    assert.equal(ApplicationService.validateApplicationSubmission({
        ...base,
        answers: [{ question: 'How old are you?', answer: '18', minLength: 1 }, { question: 'Name?', answer: 'Al' }],
    }), true);
    assert.throws(() => ApplicationService.validateApplicationSubmission({
        ...base,
        answers: [{ question: 'Why join?', answer: 'fun', minLength: 10 }],
    }), (error) => /at least 10 characters/.test(error.userMessage));
});
