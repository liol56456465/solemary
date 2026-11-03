// backtest.js — the automod test run of the dashboard Automod page ("Test run"): reads the
// recent history of up to 20 text channels and runs automod's CONTENT checks on it
// (automodService.contentHits) with the current settings and rule modes, plus an optional
// draft custom rule. Rate and timing checks (spam, the ad-bot cross-channel pattern,
// harassment over time) are skipped: they depend on live order and timing.
//
// Read only: no actions, no DMs, no log posts, no database writes, and message content is
// never logged. Reading: newest first across all picked channels, at most MAX_MESSAGES in
// total, stopping at the day cutoff; channel.messages.fetch({ limit: 100, before }) pages,
// awaited one after another (discord.js queues them by the rate limits). Bots, webhooks and
// system messages are skipped, and so are administrators (automod skips them live too).
//
// Jobs live in memory, one per guild at a time (lost on restart); a finished or failed
// result is kept for RESULT_TTL_MS. The result holds per-rule counts and up to
// MAX_EXAMPLES examples with a short, masked excerpt (maskExcerpt).
//
// Per rule (result.byRule, and result.offRules for built-in rules that are turned off but
// would have caught messages): messages, distinct members, the matched words of word
// based rules (masked with maskTerm, top MAX_WORDS_LISTED, never the raw word), and
// mayBeTooStrict (looksTooStrict: a conservative "catches a lot" hint, never a verdict).
// The raw words and member ids are counted in this job's closure only and turned into
// masked words and plain counts when the job ends.

import { PermissionFlagsBits } from 'discord.js';
import { AUTOMOD_RULES } from '../../config/automod.js';
import { logger } from '../../utils/logger.js';
import { isAdministrator } from '../enforcement/enforcementService.js';
import { applyRuleModes, contentHits, inviteGuildIsForeign } from './automodService.js';
import { resolveRuleMode, ruleMode } from './policy.js';
import { CustomRuleError, cleanCustomRule, compileRules, matchCompiled } from './customRules.js';
import { findBlockedWord, findInsult, findPersonalInfo, findSexualWord, normalizeText } from './filters.js';

export const BACKTEST_MAX_CHANNELS = 20;
export const BACKTEST_DAY_CHOICES = [1, 3, 7];
export const MAX_MESSAGES = 2000;
export const MAX_EXAMPLES = 20;
export const RESULT_TTL_MS = 30 * 60 * 1000;
const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
// Each distinct invite code costs one API call; past this many they are not looked up.
const MAX_INVITE_LOOKUPS = 50;
const EXCERPT_TOKENS_BEFORE = 6;
const EXCERPT_TOKENS_AFTER = 8;
const EXCERPT_TOKEN_MAX = 40;
const DRAFT_ID = 'draftrule';
export const DRAFT_KEY = 'draft';
// Matched words listed per rule (the most frequent first); the rest are only counted.
export const MAX_WORDS_LISTED = 10;
// looksTooStrict: a rule "may be too strict" only when ALL three hold. Deliberately
// conservative: a handful of hits, or one member tripping it again and again, is never enough.
export const STRICT_MIN_HITS = 10;
export const STRICT_MIN_MEMBERS = 3;
export const STRICT_MIN_SHARE = 0.02;

/**
 * Whether a rule's test run count looks high enough to be worth a second look: at least
 * STRICT_MIN_HITS messages, from at least STRICT_MIN_MEMBERS different members, and at
 * least STRICT_MIN_SHARE (2%) of the checked messages. A hint only: a rule can catch a lot
 * because members really do break it often.
 */
export function looksTooStrict(entry, checked) {
    const count = Number(entry?.count) || 0;
    const members = Number(entry?.members) || 0;
    const total = Number(checked) || 0;
    return total > 0 && count >= STRICT_MIN_HITS && members >= STRICT_MIN_MEMBERS && count / total >= STRICT_MIN_SHARE;
}

/** A refusal or failure meant for the admin (userMessage is plain English). */
export class BacktestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BacktestError';
        this.userMessage = message;
    }
}

const fail = (message) => { throw new BacktestError(message); };

// ── Masking ───────────────────────────────────────────────────────────────

/** "fuck" → "f**k", "fag" → "f**", "ab" → "a*": the first (and from 4 letters the last) character stays. */
export function maskWord(word) {
    const chars = [...String(word)];
    if (chars.length <= 1) return '*';
    if (chars.length <= 3) return `${chars[0]}${'*'.repeat(chars.length - 1)}`;
    return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/** A matched word or phrase, every part masked like maskWord: "buy followers" -> "b** f*******s". */
export function maskTerm(term) {
    const parts = String(term ?? '').trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts.map(maskWord).join(' ') : '*';
}

const keyOf = (token) => normalizeText(token).replace(/[^a-z0-9]/g, '');
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;

/**
 * A short excerpt of `text` around the first matched word, every matched word partly
 * masked. `terms`: the matched words and phrases. Blocked and sexual words are always
 * masked, wherever they are. `hidePersonal`: e-mail addresses and digits are hidden too.
 * Returns null when any term could not be found in the text to mask it (for example
 * letters spelled out one by one): then nothing of the text is shown.
 */
export function maskExcerpt(text, terms = [], { hidePersonal = false } = {}) {
    let value = String(text || '').replace(/\s+/g, ' ').trim();
    if (hidePersonal) value = value.replace(EMAIL, '[e-mail]').replace(/\d/g, '#');
    if (!value) return '';
    // Per term: its tokens (2+ characters) and its joined-up form (4+ characters).
    const wanted = terms.filter(Boolean).map((term) => {
        const parts = normalizeText(term).split(/[^a-z0-9]+/).filter((part) => part.length >= 2);
        const joined = parts.join('');
        return { parts: new Set(parts), joined: joined.length >= 4 ? joined : null, found: false };
    });
    const tokens = value.split(' ');
    let first = -1;
    const shown = tokens.map((token, i) => {
        const key = keyOf(token);
        if (!key) return token;
        let matched = false;
        for (const term of wanted) {
            if (term.parts.has(key) || (term.joined && key.includes(term.joined))) {
                term.found = true;
                matched = true;
            }
        }
        if (matched && first < 0) first = i;
        return matched || findBlockedWord(token) || findSexualWord(token) ? maskWord(token) : token;
    });
    // Every matched word must be masked somewhere; one we cannot place hides the whole excerpt.
    if (wanted.some((term) => !term.found)) return null;
    const from = Math.max(0, (first < 0 ? 0 : first) - EXCERPT_TOKENS_BEFORE);
    const to = Math.min(shown.length, (first < 0 ? 0 : first) + EXCERPT_TOKENS_AFTER + (first < 0 ? EXCERPT_TOKENS_BEFORE : 0));
    const cut = shown.slice(from, to).map((token) => ([...token].length > EXCERPT_TOKEN_MAX ? `${[...token].slice(0, EXCERPT_TOKEN_MAX).join('')}…` : token));
    return `${from > 0 ? '… ' : ''}${cut.join(' ')}${to < shown.length ? ' …' : ''}`;
}

// ── Validation ────────────────────────────────────────────────────────────

const PERMISSION_LABELS = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
];

/** The bot's missing read permissions in a channel (labels), [] when it can read it. */
export function missingReadPermissions(guild, channel) {
    const me = guild?.members?.me;
    const granted = me?.permissionsIn?.(channel);
    if (!granted) return PERMISSION_LABELS.map(([, label]) => label);
    return PERMISSION_LABELS.filter(([flag]) => !granted.has(flag)).map(([, label]) => label);
}

/** The draft rule cleaned like a stored custom rule (customRules.cleanCustomRule), or null. */
export function cleanDraftRule(draft) {
    if (!draft) return null;
    const name = String(draft.name ?? '').trim();
    const words = draft.words;
    const hasWords = Array.isArray(words) ? words.some((w) => String(w ?? '').trim()) : String(words ?? '').trim() !== '';
    if (!name && !hasWords) return null;
    try {
        return cleanCustomRule({ id: DRAFT_ID, name: name || 'Draft rule', words, action: 'delete' });
    } catch (error) {
        if (error instanceof CustomRuleError) fail(`Draft rule: ${error.userMessage}`);
        throw error;
    }
}

function channelLabel(channel) {
    return `#${channel?.name || channel?.id || 'unknown'}`;
}

// ── The runner ────────────────────────────────────────────────────────────

/**
 * A set of jobs (one per guild). `now` and `resultTtlMs` are replaceable for tests.
 * start() checks everything first and throws BacktestError; the reading runs in the
 * background (done(guildId) is its promise, for tests).
 */
export function createBacktestRunner({ now = () => Date.now(), resultTtlMs = RESULT_TTL_MS } = {}) {
    const jobs = new Map(); // guildId → job

    function snapshot(job) {
        const { promise, ...rest } = job;
        return structuredClone(rest);
    }

    function current(guildId) {
        const job = jobs.get(guildId);
        if (!job) return null;
        if (job.status !== 'running' && now() - job.finishedAt > resultTtlMs) {
            jobs.delete(guildId);
            return null;
        }
        return job;
    }

    /** The guild's job: { status: 'running' | 'done' | 'failed', progress, result, error, … } or null. */
    function get(guildId) {
        const job = current(guildId);
        return job ? snapshot(job) : null;
    }

    /**
     * Starts a test run. params: { guild, channelIds, days, settings (automod settings),
     * customRules (the rules that run now), draft ({ name, words } | null), startedBy }.
     */
    function start({ guild, channelIds, days, settings, customRules = [], draft = null, startedBy = null }) {
        if (!guild?.id) fail('The bot cannot see the server right now.');
        const ids = [...new Set(Array.isArray(channelIds) ? channelIds : [])];
        if (!ids.length) fail('Pick at least one channel.');
        if (ids.length > BACKTEST_MAX_CHANNELS) fail(`Pick at most ${BACKTEST_MAX_CHANNELS} channels.`);
        if (!BACKTEST_DAY_CHOICES.includes(Number(days))) fail('Pick 1, 3 or 7 days.');
        if (!settings) fail('The automod settings could not be read.');
        if (current(guild.id)?.status === 'running') fail('A test run is already running. Wait for it to finish, then start a new one.');
        const channels = ids.map((id) => {
            const channel = guild.channels?.cache?.get(id);
            if (!channel) fail(`Channel ${id} is not in the server.`);
            if (typeof channel.messages?.fetch !== 'function') fail(`${channelLabel(channel)} is not a text channel.`);
            const missing = missingReadPermissions(guild, channel);
            if (missing.length) fail(`I am missing ${missing.join(' and ')} in ${channelLabel(channel)}. Give me that permission there, or pick another channel.`);
            return channel;
        });
        const draftRule = cleanDraftRule(draft);
        const compiled = compileRules(customRules || []);
        const draftCompiled = draftRule ? compileRules([draftRule]) : null;
        const startedAt = now();
        const job = {
            guildId: guild.id,
            status: 'running',
            startedAt,
            finishedAt: null,
            startedBy,
            params: {
                channelIds: ids, days: Number(days), automodEnabled: Boolean(settings.enabled),
                // list: the admin's own draft words (cleaned), for "Add this rule" on the result.
                draft: draftRule ? { name: draftRule.name, words: draftRule.words.length, list: [...draftRule.words] } : null,
            },
            progress: { read: 0 },
            result: null,
            error: null,
        };
        jobs.set(guild.id, job);
        job.promise = run(job, { guild, channels, settings, compiled, draftCompiled, draftRule });
        return snapshot(job);
    }

    async function run(job, { guild, channels, settings, compiled, draftCompiled, draftRule }) {
        const cutoff = job.startedAt - job.params.days * DAY_MS;
        const result = {
            read: 0, checked: 0, skippedBots: 0, skippedAdmins: 0, hitMessages: 0, capped: false, invitesUnchecked: 0,
            byRule: {}, offRules: {}, examples: [],
            channels: channels.map((channel) => ({ id: channel.id, name: channel.name || channel.id, read: 0 })),
        };
        const members = new Map();     // author id → member | null (this job only)
        const invites = new Map();     // invite code → guild id | null (this job only)
        let inviteLookups = 0;
        // This job only, never in the result: "<bucket>:<rule key>" -> Set of author ids / Map of raw word -> count.
        const authorsByRule = new Map();
        const wordsByRule = new Map();
        const tally = (bucket, key, base, authorId, words) => {
            const entry = bucket[key] || (bucket[key] = { ...base, count: 0, members: 0 });
            const id = `${bucket === result.offRules ? 'off' : 'on'}:${key}`;
            entry.count += 1;
            const authors = authorsByRule.get(id) || new Set();
            authorsByRule.set(id, authors);
            if (authorId) authors.add(authorId);
            entry.members = authors.size;
            if (words.length) {
                const counts = wordsByRule.get(id) || new Map();
                wordsByRule.set(id, counts);
                for (const word of new Set(words)) counts.set(word, (counts.get(word) || 0) + 1);
            }
            return entry;
        };
        // When the job ends: masked word lists and the "may be too strict" hint.
        const finish = () => {
            for (const [bucket, prefix] of [[result.byRule, 'on'], [result.offRules, 'off']]) {
                for (const [key, entry] of Object.entries(bucket)) {
                    const counts = wordsByRule.get(`${prefix}:${key}`);
                    if (counts?.size) {
                        const sorted = [...counts].sort((a, b) => b[1] - a[1]);
                        entry.words = sorted.slice(0, MAX_WORDS_LISTED).map(([word, count]) => ({ word: maskTerm(word), count }));
                        entry.moreWords = Math.max(0, sorted.length - MAX_WORDS_LISTED);
                    }
                    entry.mayBeTooStrict = looksTooStrict(entry, result.checked);
                }
            }
            authorsByRule.clear();
            wordsByRule.clear();
        };

        const memberOf = async (message) => {
            const id = message.author.id;
            if (!members.has(id)) {
                const cached = message.member || guild.members?.cache?.get?.(id);
                members.set(id, cached || await guild.members?.fetch?.(id).catch(() => null) || null);
            }
            return members.get(id);
        };
        const isForeignInvite = async (code) => {
            if (!invites.has(code)) {
                if (inviteLookups >= MAX_INVITE_LOOKUPS) {
                    result.invitesUnchecked += 1;
                    return false;
                }
                inviteLookups += 1;
                const invite = await guild.client?.fetchInvite?.(code).catch(() => null);
                invites.set(code, invite?.guild?.id || null);
            }
            return inviteGuildIsForeign(invites.get(code));
        };

        const streams = channels.map((channel, index) => ({ channel, index, before: null, buffer: [], done: false }));
        const fill = async (stream) => {
            let batch;
            try {
                // cache: false, so old history never pushes the live recent messages out of the
                // channel's message cache (delete and edit logs need them).
                batch = await stream.channel.messages.fetch({ limit: PAGE_SIZE, cache: false, ...(stream.before ? { before: stream.before } : {}) });
            } catch (error) {
                if (error?.code === 50001 || error?.code === 50013) {
                    fail(`I could not read ${channelLabel(stream.channel)}: I am missing View Channel or Read Message History there.`);
                }
                fail(`Reading ${channelLabel(stream.channel)} failed (Discord error${error?.code ? ` ${error.code}` : ''}). Try again later.`);
            }
            const page = [...(batch?.values?.() || [])].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
            if (!page.length) {
                stream.done = true;
                return;
            }
            stream.before = page[page.length - 1].id;
            const kept = page.filter((message) => message.createdTimestamp >= cutoff);
            stream.buffer.push(...kept);
            if (kept.length < page.length || page.length < PAGE_SIZE) stream.done = true;
        };

        const check = async (message, stream) => {
            if (message.author?.bot || message.webhookId || message.system) {
                result.skippedBots += 1;
                return;
            }
            const member = await memberOf(message);
            if (isAdministrator(member)) {
                result.skippedAdmins += 1;
                return;
            }
            result.checked += 1;
            const text = message.content || '';
            let customWord = null;
            const allHits = await contentHits(message, member, {
                isForeignInvite,
                matchCustom: (value) => {
                    const found = matchCompiled(value, compiled);
                    customWord = found?.word || null;
                    return found;
                },
            });
            const hits = applyRuleModes(allHits, settings, stream.channel);
            // Built-in rules turned off for the whole server (not just in this channel): what
            // they would have caught, for "Turn on". Not counted as broken rules.
            const offHits = allHits.filter((hit) => AUTOMOD_RULES[hit.rule] && ruleMode(settings, hit.rule) === 'off'
                && resolveRuleMode(settings, hit.rule, stream.channel) === 'off');
            const draftHit = draftCompiled ? matchCompiled(text, draftCompiled) : null;
            const authorId = message.author?.id || null;
            // The matched word(s) of word based rules, per hit.
            const wordsOf = (hit) => {
                if (hit.rule === 'language') return [hit.slur ? findBlockedWord(text) : findSexualWord(text)].filter(Boolean);
                if (hit.rule === 'sexual') return [findSexualWord(text)].filter(Boolean);
                if (hit.rule === 'disrespect') return [findInsult(text)].filter(Boolean);
                if (hit.ruleLabel) return [customWord].filter(Boolean);
                return [];
            };
            // One count per rule per message (a slur and a sexual word are both "language").
            const grouped = (list) => {
                const byKey = new Map();
                for (const hit of list) {
                    const group = byKey.get(hit.rule) || { hit, modes: new Set(), words: [] };
                    group.modes.add(hit.mode);
                    group.words.push(...wordsOf(hit));
                    byKey.set(hit.rule, group);
                }
                return byKey;
            };
            for (const [rule, { words }] of grouped(offHits)) {
                tally(result.offRules, rule, { label: AUTOMOD_RULES[rule].label }, authorId, words);
            }
            if (!hits.length && !draftHit) return;
            result.hitMessages += 1;
            const labels = [];
            for (const [rule, { hit, modes, words }] of grouped(hits)) {
                const label = hit.ruleLabel || AUTOMOD_RULES[rule]?.label || rule;
                const entry = tally(result.byRule, rule, { label, on: 0, monitor: 0 }, authorId, words);
                entry[modes.has('monitor') && !modes.has('on') ? 'monitor' : 'on'] += 1;
                labels.push(label);
            }
            if (draftHit) {
                const label = `Draft: ${draftRule.name}`;
                tally(result.byRule, DRAFT_KEY, { label, on: 0, monitor: 0, draft: true }, authorId, [draftHit.word].filter(Boolean));
                labels.push(label);
            }
            if (result.examples.length >= MAX_EXAMPLES) return;
            const rules = new Set(hits.map((hit) => hit.rule));
            const terms = [
                rules.has('language') ? findBlockedWord(text) : null,
                rules.has('language') || rules.has('sexual') ? findSexualWord(text) : null,
                rules.has('disrespect') ? findInsult(text) : null,
                hits.some((hit) => hit.ruleLabel) ? customWord : null,
                draftHit?.word || null,
            ];
            result.examples.push({
                at: message.createdTimestamp,
                author: message.author?.tag || message.author?.username || message.author?.id,
                authorId: message.author?.id,
                channelId: stream.channel.id,
                channelName: stream.channel.name || stream.channel.id,
                url: message.url || null,
                rules: labels,
                // Personal info is hidden whenever the text has some, not only on a privacy hit.
                excerpt: maskExcerpt(text, terms, { hidePersonal: Boolean(findPersonalInfo(text)) }),
            });
        };

        try {
            while (result.read < MAX_MESSAGES) {
                for (const stream of streams) {
                    if (!stream.done && !stream.buffer.length) await fill(stream);
                }
                const open = streams.filter((stream) => stream.buffer.length);
                if (!open.length) break;
                const pick = open.reduce((a, b) => (b.buffer[0].createdTimestamp > a.buffer[0].createdTimestamp ? b : a));
                const message = pick.buffer.shift();
                result.read += 1;
                result.channels[pick.index].read += 1;
                job.progress.read = result.read;
                await check(message, pick);
            }
            result.capped = result.read >= MAX_MESSAGES && streams.some((stream) => stream.buffer.length || !stream.done);
            finish();
            job.result = result;
            job.status = 'done';
        } catch (error) {
            job.status = 'failed';
            finish();
            job.result = result;
            if (error instanceof BacktestError) {
                job.error = error.userMessage;
            } else {
                job.error = 'The test run stopped because of an unexpected error. Try again.';
                // The error message only, never message content.
                logger.warn(`Automod test run in ${job.guildId} failed: ${error?.message}`);
            }
        } finally {
            job.finishedAt = now();
        }
    }

    return {
        start,
        get,
        /** Test hook: the background promise of the guild's job. */
        done: (guildId) => jobs.get(guildId)?.promise || Promise.resolve(),
    };
}

const runner = createBacktestRunner();

/** Dashboard service: starts the guild's test run (see createBacktestRunner start). */
export function startAutomodBacktest(params) {
    return runner.start(params);
}

/** Dashboard service: the guild's current or last test run (kept 30 minutes), or null. */
export function getAutomodBacktest(guildId) {
    return runner.get(guildId);
}
