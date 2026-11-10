// Verification in 8 languages (src/content/bot/<lang>/verification.json): English output is the
// text the code had before; other languages translate and keep placeholders and Discord markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText } from '../src/utils/botText.js';
import { directVerifyPrivacyNote, oauthVerifyPrivacyNote } from '../src/utils/privacyNotice.js';
import { VERIFICATION_NOT_SET_UP, verificationSetupProblem } from '../src/services/verificationService.js';
import {
    NOT_YOUR_QUIZ_MESSAGE, QUIZ_EXPIRED_MESSAGE, cooldownPayload, createQuizStore, expiredPayload, failedPayload, normalizeQuiz, notYourQuizMessage, questionPayload,
} from '../src/services/verificationQuiz.js';
import { verifyPrivacyNote } from '../src/handlers/verificationButtons.js';
import { buildVerificationPanelPayload } from '../src/services/verificationPanelService.js';
import { holdReasonText } from '../src/services/verificationGuard.js';
import { botConfig } from '../src/config/bot.js';

const GUILD = '300000000000000003';
const USER = '400000000000000004';
const QUIZ = {
    enabled: true,
    questions: [
        { question: 'Be kind?', answers: ['Yes', 'No'], correctIndex: 0 },
        { question: 'Spam?', answers: ['Never', 'Always'], correctIndex: 0 },
    ],
};
const embed = (payload) => payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0].data;

test('English unchanged: privacy notes, setup problem, quiz messages, panel defaults', async () => {
    for (const env of [{}, { PUBLIC_URL: 'https://mewvo.example' }]) {
        assert.equal(verifyPrivacyNote('oauth', { env }), oauthVerifyPrivacyNote(env));
        assert.equal(verifyPrivacyNote('direct', { env }), directVerifyPrivacyNote(env));
    }
    const client = { guilds: { cache: new Map([[GUILD, { roles: { cache: new Map() } }]]) } };
    assert.equal(await verificationSetupProblem(client, GUILD, { readConfig: async () => ({}) }), VERIFICATION_NOT_SET_UP);
    assert.equal(notYourQuizMessage(), NOT_YOUR_QUIZ_MESSAGE);
    assert.match(JSON.stringify(embed(expiredPayload())), new RegExp(QUIZ_EXPIRED_MESSAGE.replace('.', '\\.')));

    const attempt = createQuizStore().start(GUILD, USER, normalizeQuiz(QUIZ));
    const question = embed(questionPayload(attempt));
    assert.match(question.title, /Rules quiz: question 1 of 2/);
    assert.ok(question.description.endsWith('-# Answer all 2 questions to continue to verification. The quiz expires after 10 minutes.'), question.description);
    const one = embed(questionPayload({ ...attempt, questions: attempt.questions.slice(0, 1) }));
    assert.ok(one.description.endsWith('-# Answer this question to continue to verification. The quiz expires after 10 minutes.'));
    assert.ok(embed(failedPayload(1, '<#1>')).description.includes('Not quite. Read the rules in <#1> and try again in 1 minute.'));
    assert.ok(embed(cooldownPayload(5 * 60000, '<#1>')).description.includes('Read the rules in <#1> and try again in 5 minutes.'));

    const panel = buildVerificationPanelPayload({});
    assert.equal(panel.embeds[0].data.title, 'Server verification');
    assert.equal(panel.embeds[0].data.description, botConfig.verification.defaultMessage);
    assert.equal(panel.components[0].components[0].data.label, botConfig.verification.defaultButtonText);
    assert.equal(holdReasonText(botText('en'), { kind: 'network', username: 'x', userId: '1', caseCode: 'abc23k' }), 'Same network as banned member x (`1`, ban `abc23k`)');
});

test('other languages: the stored English default panel text is translated, an admin\'s own text is kept', () => {
    const defaults = { message: botConfig.verification.defaultMessage, buttonText: botConfig.verification.defaultButtonText };
    const de = buildVerificationPanelPayload(defaults, { lang: 'de' });
    assert.equal(de.embeds[0].data.title, botText('de').t('verification.panel.title'));
    assert.equal(de.embeds[0].data.description, botText('de').t('verification.panel.defaultMessage'));
    assert.equal(de.components[0].components[0].data.custom_id, 'verify_user');
    const own = buildVerificationPanelPayload({ message: 'Hallo!', buttonText: 'Los' }, { lang: 'de' });
    assert.equal(own.embeds[0].data.description, 'Hallo!');
    assert.equal(own.components[0].components[0].data.label, 'Los');
});

test('every language: quiz, privacy and review texts render, markup and placeholders kept, labels within limits', () => {
    const attempt = createQuizStore().start(GUILD, USER, normalizeQuiz(QUIZ));
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const q = embed(questionPayload(attempt, { lang }));
        assert.ok(q.title.includes('1') && q.title.includes('2'), `${lang}: ${q.title}`);
        assert.ok(q.description.includes('\n\n-# '), lang);
        for (const text of [q.description, embed(failedPayload(3, '<#9>', { lang })).description, embed(cooldownPayload(60000, '<#9>', { lang })).description]) {
            assert.ok(!/\{[a-zA-Z]+\}/.test(text), `${lang}: placeholder left in ${text}`);
        }
        assert.ok(embed(failedPayload(3, '<#9>', { lang })).description.includes('<#9>'), lang);
        assert.ok(verifyPrivacyNote('oauth', { lang, env: { PUBLIC_URL: 'https://mewvo.example' } }).endsWith('https://mewvo.example/privacy'), lang);
        assert.ok(tr.t('verification.review.dmApproved', { server: 'S' }).startsWith('**'), lang);
        assert.ok(tr.t('verification.button.verifiedText', { role: 'R', privacy: 'P' }).includes('**R**'), lang);
        assert.ok(tr.t('verification.button.verifiedText', { role: 'R', privacy: 'P' }).endsWith('\n\n-# P'), lang);
        for (const key of ['verification.button.oauthButton', 'verification.panel.defaultButton', 'verification.hold.approve', 'verification.hold.deny',
            'verification.vdash.repostButton', 'verification.vdash.toggleButton', 'verification.adash.criteriaButton', 'verification.adash.toggleButton']) {
            assert.ok(tr.t(key).length <= 80, `${lang}: ${key}`);
        }
        for (const key of ['verification.vdash.optChannel', 'verification.vdash.optChannelDesc', 'verification.vdash.optRoleDesc', 'verification.vdash.optMessageDesc',
            'verification.adash.optRoleDesc', 'verification.adash.criteriaOptAgeDesc', 'verification.adash.criteriaOptNoneDesc', 'verification.vdash.messageLabel',
            'verification.vdash.buttonLabel', 'verification.adash.ageLabel', 'verification.vdash.messageModal', 'verification.adash.ageModal']) {
            // Modal titles and text input labels: 45; select option labels and descriptions: 100.
            const limit = /Label|Modal/.test(key) ? 45 : 100;
            assert.ok(tr.t(key, { days: 7 }).length <= limit, `${lang}: ${key} is over ${limit} characters`);
        }
        assert.ok(holdReasonText(tr, { kind: 'young', ageMs: 2 * 86400000, minMs: 7 * 86400000 }).length > 10, lang);
    }
});
