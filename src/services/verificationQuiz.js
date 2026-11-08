// verificationQuiz.js — the optional rules quiz a member answers before verification.
//
// Settings: guildConfig.verification.quiz = { enabled, questions: [{ question, answers, correctIndex }],
// cooldownMinutes } (no own table; written through verificationSettingsService.js, row-locked).
// Off by default. Enabled with no valid question = off (the dashboard warns).
//
// Flow: Verify (button or /verify) → if the quiz is active and the member is not verified
// and has not passed: one ephemeral message per question with one button per answer, the
// answers shuffled per attempt. All questions are answered before the result, so a failed
// attempt never says which answer was wrong or right. All correct → the normal verification
// step (OAuth link or the role). Any wrong → a retry cooldown (default 5 minutes).
//
// State lives in memory (bounded, TTL), lost on restart by design:
//   - attempts:  guild+user → { nonce, step, orders, picks, … }; 10 minutes; the custom id carries
//                the nonce, so only the newest attempt's buttons work.
//   - passes:    guild+user → fingerprint of the questions passed; 24 hours. Passing only has to
//                last until the verification step is done (the OAuth link lives 10 minutes); after
//                a restart the member simply answers again. Changing the questions asks again.
//   - cooldowns: guild+user → time the next attempt is allowed.
// Nothing here writes to the database, so a quiz click can never fail on a database error.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { z } from 'zod';
import { infoEmbed, warningEmbed } from '../utils/embeds.js';
import { getGuildConfig } from './config/guildConfig.js';
import { isHomeGuild, resolveSetting } from './settings/guildSettings.js';
import { numberedRules } from './rules/serverRules.js';
import { siteOrigin } from './site/shell.js';
import { botText, textForInteraction } from '../utils/botText.js';

export const QUIZ_LIMITS = Object.freeze({
    maxQuestions: 5, questionMax: 150, answerMax: 80, minAnswers: 2, maxAnswers: 4,
    cooldownMin: 1, cooldownMax: 60, cooldownDefault: 5,
});

export const QUIZ_PREFIX = 'vquiz';
export const QUIZ_TTL_MS = 10 * 60 * 1000;
export const PASS_TTL_MS = 24 * 60 * 60 * 1000;
export const QUIZ_MAX_ENTRIES = 5000;
export const QUIZ_EXPIRED_MESSAGE = 'This quiz expired, click Verify again.';
export const NOT_YOUR_QUIZ_MESSAGE = 'This quiz is not yours. Click Verify to start your own.';
const NO_MENTIONS = Object.freeze({ parse: [] });

// ── Validation (one place: the settings service and the runtime both use these) ──

const line = (label, max) => z.string({ error: `${label} must be text.` })
    .trim()
    .min(1, `${label} cannot be empty.`)
    .max(max, `${label} must be at most ${max} characters.`)
    .refine((v) => !/[\r\n]/.test(v), `${label} must be one line.`);

export const QuizQuestionSchema = z.strictObject({
    question: line('Quiz question', QUIZ_LIMITS.questionMax),
    answers: z.array(line('Quiz answer', QUIZ_LIMITS.answerMax), { error: 'Quiz answers must be a list.' })
        .min(QUIZ_LIMITS.minAnswers, `Each quiz question needs ${QUIZ_LIMITS.minAnswers} to ${QUIZ_LIMITS.maxAnswers} answers.`)
        .max(QUIZ_LIMITS.maxAnswers, `Each quiz question needs ${QUIZ_LIMITS.minAnswers} to ${QUIZ_LIMITS.maxAnswers} answers.`),
    correctIndex: z.number({ error: 'Quiz correct answer must be a number.' }).int('Quiz correct answer must be a whole number.').min(0, 'Quiz correct answer is not one of the answers.'),
}).superRefine((q, ctx) => {
    if (q.correctIndex >= q.answers.length) {
        ctx.addIssue({ code: 'custom', path: ['correctIndex'], message: 'Quiz correct answer is not one of the answers.' });
    }
    const seen = new Set(q.answers.map((a) => a.toLowerCase()));
    if (seen.size !== q.answers.length) {
        ctx.addIssue({ code: 'custom', path: ['answers'], message: 'Quiz answers of one question must all be different.' });
    }
});

export const QuizPatchSchema = z.strictObject({
    enabled: z.boolean({ error: 'Rules quiz must be on or off.' }).optional(),
    questions: z.array(QuizQuestionSchema, { error: 'Quiz questions must be a list.' })
        .max(QUIZ_LIMITS.maxQuestions, `At most ${QUIZ_LIMITS.maxQuestions} quiz questions.`).optional(),
    cooldownMinutes: z.number({ error: 'Quiz retry wait must be a number.' }).int('Quiz retry wait must be a whole number of minutes.')
        .min(QUIZ_LIMITS.cooldownMin, `Quiz retry wait must be between ${QUIZ_LIMITS.cooldownMin} and ${QUIZ_LIMITS.cooldownMax} minutes.`)
        .max(QUIZ_LIMITS.cooldownMax, `Quiz retry wait must be between ${QUIZ_LIMITS.cooldownMin} and ${QUIZ_LIMITS.cooldownMax} minutes.`).optional(),
});

/** The first problem with one question (a user-facing sentence), or null when it is valid. */
export function questionProblem(question) {
    const parsed = QuizQuestionSchema.safeParse(question);
    return parsed.success ? null : parsed.error.issues[0].message;
}

/**
 * The quiz as the bot uses it, from whatever is stored (never throws): invalid questions are
 * dropped (counted in `invalidCount`), a bad cooldown falls back to the default.
 * `active` = enabled and at least one valid question.
 */
export function normalizeQuiz(stored) {
    const value = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const rawQuestions = Array.isArray(value.questions) ? value.questions.slice(0, QUIZ_LIMITS.maxQuestions) : [];
    const questions = [];
    for (const raw of rawQuestions) {
        const parsed = QuizQuestionSchema.safeParse(raw);
        if (parsed.success) questions.push(parsed.data);
    }
    const minutes = Number(value.cooldownMinutes);
    const cooldownMinutes = Number.isInteger(minutes) && minutes >= QUIZ_LIMITS.cooldownMin && minutes <= QUIZ_LIMITS.cooldownMax
        ? minutes : QUIZ_LIMITS.cooldownDefault;
    const enabled = value.enabled === true;
    return {
        enabled,
        questions,
        cooldownMinutes,
        invalidCount: (Array.isArray(value.questions) ? value.questions.length : 0) - questions.length,
        active: enabled && questions.length > 0,
        fingerprint: quizFingerprint(questions),
    };
}

/** A short hash of the questions: a pass only counts for the questions that were passed. */
export function quizFingerprint(questions) {
    return createHash('sha256').update(JSON.stringify(questions || [])).digest('hex').slice(0, 16);
}

// ── Shuffling ─────────────────────────────────────────────────────────────

/** A random order of 0..n-1 (Fisher–Yates). `rand(max)` returns an integer in [0, max). */
export function shuffledOrder(n, rand = randomInt) {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i -= 1) {
        const j = rand(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}

/** True when the shown button `choice` (position in `order`) is the question's correct answer. */
export function isCorrectChoice(question, order, choice) {
    return Number.isInteger(choice) && choice >= 0 && choice < order.length && order[choice] === question.correctIndex;
}

// ── State ─────────────────────────────────────────────────────────────────

/**
 * In-memory quiz state. `now` and `rand` can be replaced in tests.
 * Every map is bounded (oldest dropped first) and entries expire.
 */
export function createQuizStore({ now = () => Date.now(), rand = randomInt, ttlMs = QUIZ_TTL_MS, passTtlMs = PASS_TTL_MS, maxEntries = QUIZ_MAX_ENTRIES } = {}) {
    const attempts = new Map();
    const passes = new Map();
    const cooldowns = new Map();
    const key = (guildId, userId) => `${guildId}:${userId}`;

    function prune(map) {
        const t = now();
        for (const [k, entry] of map) {
            if (entry.expiresAt <= t) map.delete(k);
        }
        while (map.size > maxEntries) map.delete(map.keys().next().value);
    }
    function put(map, k, entry) {
        map.delete(k); // re-insert at the end (newest)
        map.set(k, entry);
        prune(map);
    }
    function live(map, k) {
        const entry = map.get(k);
        if (!entry) return null;
        if (entry.expiresAt <= now()) {
            map.delete(k);
            return null;
        }
        return entry;
    }

    return {
        /** Starts a new attempt (replacing an older one of this member). */
        start(guildId, userId, quiz) {
            const attempt = {
                guildId, userId,
                nonce: randomBytes(6).toString('hex'),
                step: 0,
                questions: quiz.questions,
                orders: quiz.questions.map((q) => shuffledOrder(q.answers.length, rand)),
                picks: [],
                cooldownMinutes: quiz.cooldownMinutes,
                fingerprint: quiz.fingerprint,
                expiresAt: now() + ttlMs,
            };
            put(attempts, key(guildId, userId), attempt);
            return attempt;
        },

        /** The live attempt with this nonce, else null (expired, replaced or never started). */
        get(guildId, userId, nonce) {
            const attempt = live(attempts, key(guildId, userId));
            return attempt && attempt.nonce === nonce ? attempt : null;
        },

        /**
         * Records the answer to question `step`. Returns { status, attempt }:
         *   'expired' — no such live attempt; 'stale' — a click on an older question (ignored);
         *   'next' — show attempt.step; 'passed' / 'failed' — the attempt is over.
         */
        answer(guildId, userId, nonce, step, choice) {
            const attempt = this.get(guildId, userId, nonce);
            if (!attempt) return { status: 'expired', attempt: null };
            const order = attempt.orders[attempt.step];
            if (step !== attempt.step || !Number.isInteger(choice) || choice < 0 || choice >= order.length) {
                return { status: 'stale', attempt };
            }
            attempt.picks.push(choice);
            attempt.step += 1;
            if (attempt.step < attempt.questions.length) return { status: 'next', attempt };

            attempts.delete(key(guildId, userId));
            const allCorrect = attempt.questions.every((q, i) => isCorrectChoice(q, attempt.orders[i], attempt.picks[i]));
            if (allCorrect) {
                put(passes, key(guildId, userId), { fingerprint: attempt.fingerprint, expiresAt: now() + passTtlMs });
                cooldowns.delete(key(guildId, userId));
                return { status: 'passed', attempt };
            }
            put(cooldowns, key(guildId, userId), { expiresAt: now() + attempt.cooldownMinutes * 60 * 1000 });
            return { status: 'failed', attempt };
        },

        /** Milliseconds until this member may try again (0 = now). */
        cooldownLeft(guildId, userId) {
            const entry = live(cooldowns, key(guildId, userId));
            return entry ? entry.expiresAt - now() : 0;
        },

        /** True when this member passed these questions (same fingerprint) in the last PASS_TTL_MS. */
        hasPassed(guildId, userId, fingerprint) {
            const entry = live(passes, key(guildId, userId));
            return Boolean(entry && entry.fingerprint === fingerprint);
        },

        sizes() {
            return { attempts: attempts.size, passes: passes.size, cooldowns: cooldowns.size };
        },

        clear() {
            attempts.clear();
            passes.clear();
            cooldowns.clear();
        },
    };
}

export const quizStore = createQuizStore();

// ── Messages ──────────────────────────────────────────────────────────────

/** `vquiz:<userId>:<nonce>:<step>:<choice>` (routed by the part before the first ':'). */
export function quizButtonId(userId, nonce, step, choice) {
    return `${QUIZ_PREFIX}:${userId}:${nonce}:${step}:${choice}`;
}

/** [userId, nonce, step, choice] from the custom id parts after the prefix, or null. */
export function parseQuizButtonArgs(args) {
    const [userId, nonce, step, choice] = Array.isArray(args) ? args : [];
    if (!/^\d{17,20}$/.test(userId || '') || !/^[0-9a-f]{12}$/.test(nonce || '')) return null;
    if (!/^\d$/.test(step || '') || !/^\d$/.test(choice || '')) return null;
    return { userId, nonce, step: Number(step), choice: Number(choice) };
}

/** The ephemeral message for the attempt's current question (in `lang`, the member's Discord language). */
export function questionPayload(attempt, { lang } = {}) {
    const tr = botText(lang);
    const question = attempt.questions[attempt.step];
    const order = attempt.orders[attempt.step];
    const total = attempt.questions.length;
    const row = new ActionRowBuilder().addComponents(order.map((answerIndex, shown) => new ButtonBuilder()
        .setCustomId(quizButtonId(attempt.userId, attempt.nonce, attempt.step, shown))
        .setLabel(question.answers[answerIndex])
        .setStyle(ButtonStyle.Secondary)));
    return {
        embeds: [infoEmbed(
            tr.t('verification.quiz.questionTitle', { step: attempt.step + 1, total }),
            `${question.question}\n\n-# ${total === 1
                ? tr.t('verification.quiz.footerOne', { minutes: Math.round(QUIZ_TTL_MS / 60000) })
                : tr.tp('verification.quiz.footerMany', total, { minutes: Math.round(QUIZ_TTL_MS / 60000) })}`,
        )],
        components: [row],
        allowedMentions: NO_MENTIONS,
    };
}

const minutesText = (tr, minutes) => tr.tp('verification.quiz.minutes', minutes);

/**
 * Where to read the rules: this server's posted rules channel, else the /rules page (it shows the
 * main server's rules, so only for Mewvo's own servers), else plain words.
 */
export function rulesLocation(guild, env = process.env, { lang } = {}) {
    const plainWords = botText(lang).t('verification.quiz.rulesChannel');
    const guildId = guild?.id;
    try {
        const posted = resolveSetting(guildId, 'rulesPost', env)?.posted;
        if (posted?.channelId && (!guild?.channels?.cache || guild.channels.cache.has(posted.channelId))) return `<#${posted.channelId}>`;
        if (!isHomeGuild(guildId, env)) return plainWords;
        const rules = numberedRules(resolveSetting(guildId, 'serverRules', env)).rules;
        const origin = siteOrigin(env);
        if (rules.length && origin) return `<${origin}/rules>`;
    } catch {
        // Settings not readable (or no server): fall through to the plain words (the message must still go out).
    }
    return plainWords;
}

export function failedPayload(minutes, where, { lang } = {}) {
    const tr = botText(lang);
    return {
        embeds: [warningEmbed(tr.t('verification.quiz.failedTitle'), tr.t('verification.quiz.failedText', { where, wait: minutesText(tr, minutes) }))],
        components: [],
        allowedMentions: NO_MENTIONS,
    };
}

export function cooldownPayload(msLeft, where, { lang } = {}) {
    const tr = botText(lang);
    const minutes = Math.max(1, Math.ceil(msLeft / 60000));
    return {
        embeds: [warningEmbed(tr.t('verification.quiz.cooldownTitle'), tr.t('verification.quiz.cooldownText', { where, wait: minutesText(tr, minutes) }))],
        components: [],
        allowedMentions: NO_MENTIONS,
    };
}

export function expiredPayload({ lang } = {}) {
    const tr = botText(lang);
    return { embeds: [warningEmbed(tr.t('verification.quiz.expiredTitle'), tr.t('verification.quiz.expired'))], components: [], allowedMentions: NO_MENTIONS };
}

/** The private refusal when someone clicks another member's quiz. */
export function notYourQuizMessage({ lang } = {}) {
    return botText(lang).t('verification.quiz.notYours');
}

// ── The gate before verification ──────────────────────────────────────────

/**
 * Called after the Verify interaction is deferred (ephemeral). Returns the message to show
 * instead of verifying (the first question, or the retry wait), or null to go on with the
 * normal verification step. Throws when the config cannot be read (database down): the caller
 * shows its error, it never verifies past the quiz on an error.
 */
export async function quizGate(client, interaction, { store = quizStore, readConfig = getGuildConfig, env = process.env } = {}) {
    const guild = interaction.guild;
    if (!guild) return null;
    const config = await readConfig(client, guild.id);
    const verification = config?.verification || {};
    // Verification off: the normal step answers with its own message, as before.
    if (!verification.enabled) return null;
    const quiz = normalizeQuiz(verification.quiz);
    if (!quiz.active) return null;
    const userId = interaction.user.id;
    // An ephemeral answer: the member's own Discord language.
    const { lang } = textForInteraction(interaction);
    // Already verified: the normal step says so.
    if (verification.roleId && interaction.member?.roles?.cache?.has?.(verification.roleId)) return null;
    if (store.hasPassed(guild.id, userId, quiz.fingerprint)) return null;
    const left = store.cooldownLeft(guild.id, userId);
    if (left > 0) return cooldownPayload(left, rulesLocation(guild, env, { lang }), { lang });
    return questionPayload(store.start(guild.id, userId, quiz), { lang });
}

// ── Suggestions for the dashboard ─────────────────────────────────────────

// Wrong answers for "Which of these is a rule here?": things no server rule allows.
export const DISTRACTORS = Object.freeze([
    'Spamming is fine in every channel',
    'Advertising other servers is welcome',
    'You can ignore what staff ask',
    'Sharing other members\' private info is okay',
    'NSFW content is allowed in general chat',
    'Insulting other members is allowed',
    'Pinging everyone for attention is encouraged',
    'Using alt accounts to dodge a ban is fine',
]);

/**
 * Draft questions from the server's rules (stored value or numbered list): "Which of these is
 * a rule here?" with one real rule title and wrong answers. Nothing is saved; the admin edits
 * the drafts first. At most `count` drafts, from the first rules.
 */
export function suggestQuestions(rulesValue, { count = 3, rand = randomInt } = {}) {
    const rules = numberedRules(rulesValue).rules
        .map((r) => String(r.title || '').replace(/\s+/g, ' ').trim().slice(0, QUIZ_LIMITS.answerMax))
        .filter(Boolean);
    const drafts = [];
    for (const [i, title] of rules.slice(0, Math.min(count, QUIZ_LIMITS.maxQuestions)).entries()) {
        const pool = DISTRACTORS.filter((d) => d.toLowerCase() !== title.toLowerCase());
        const wrong = [0, 1, 2].map((k) => pool[(i * 3 + k) % pool.length]);
        const correctIndex = rand(wrong.length + 1);
        const answers = [...wrong];
        answers.splice(correctIndex, 0, title);
        drafts.push({ question: 'Which of these is a rule here?', answers, correctIndex });
    }
    return drafts;
}
