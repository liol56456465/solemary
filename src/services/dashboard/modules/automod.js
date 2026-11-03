// automod.js — Automod: global on/off and mode, per-rule modes, custom rules (by plan), channel exceptions,
// trusted members, second chance, mood alerts, panic mode, join gate, native AutoMod
// policies, review/alerts channels — plus the stats (1/7/30 days, ?days=), and the live
// operations of /automod: the review queue (/automod queue), members on probation
// (/automod probation end) and ending a raid lockdown (/automod lockdown-end). Every
// change goes through the same services /automod uses (automodSettings.js is row-locked).
//
// Test run (backtest.js): an Administrator picks up to 20 text channels and 1, 3 or 7 days
// (plus an optional draft custom rule); a background job reads that history and runs the
// content checks with the current settings. Nothing is acted on, saved or logged; the
// result stays in memory for 30 minutes. The page shows idle / running / done / failed.
// The result lists per rule the messages, members, share of checked messages, a "may be
// too strict" hint (backtest.js looksTooStrict) and the masked matched words, with
// one-click fixes: test-run-rule (watch only / off / on, the same setRuleMode writes and
// audit keys as the Rule modes form, the rule key re-checked on every click), custom-toggle
// for a custom rule, and custom-add for the draft rule (plan limit and validation as usual).
//
// Review cards are decided on the card in Discord: their buttons (keep, undo, change,
// apply, dismiss, delete) act on the card message and the select menu of that
// interaction (reviewCards.js handleReviewAction), so the queue here links to each card.

import { AUTOMOD_RULES } from '../../../config/automod.js';
import {
    CHANNEL_RULE_MODES, HEADS_UP_CUSTOM_KEY, HEADS_UP_SETTING_KEYS, RULE_MODES, headsUpEnabled, headsUpSettingKey, ruleMode,
} from '../../automod/policy.js';
import { JOIN_GATE_ACTIONS, JOIN_GATE_CHECKS, normalizeJoinGate } from '../../automod/joinGate.js';
import { NATIVE_POLICIES, policyFor } from '../../automod/nativeBridge.js';
import { formatDate, html, path, queryString, raw, timeTag } from '../html.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelListField, channelName, channelPicker, checkbox, checkboxInput, switchInput, choiceField,
    intField, list, numberInput, plainText, postForm, roleField, rolePicker, selectInput, text, textArea, textInput, toggleForm, userIdField,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, registryValue, saveRegistry, section, table, topic } from './common.js';
import {
    CUSTOM_RULE_ACTIONS, CUSTOM_RULE_NAME_MAX, CUSTOM_RULE_WORDS_MAX, CUSTOM_RULE_WORD_MAX, actionLabel, cleanCustomRules,
    limitForPlan, overLimitIds, resetCustomRulesCache, runningRules,
} from '../../automod/customRules.js';
import { editRule } from '../../automod/customRuleEdits.js';
import {
    BACKTEST_DAY_CHOICES, BACKTEST_MAX_CHANNELS, BacktestError, DRAFT_KEY, MAX_EXAMPLES, MAX_MESSAGES,
    STRICT_MIN_HITS, STRICT_MIN_MEMBERS, STRICT_MIN_SHARE,
} from '../../automod/backtest.js';
import { guildPlan as defaultGuildPlan } from '../../billing/premiumEffects.js';
import { planName } from '../../billing/premiumService.js';

/** The server owner's plan (ctx.services.guildPlan in tests). */
const planOfGuild = (ctx) => (typeof ctx.services?.guildPlan === 'function' ? ctx.services.guildPlan(ctx.guildId) : defaultGuildPlan(ctx.guildId));

function storedCustomRules(ctx) {
    const value = registryValue(ctx, 'automodCustomRules');
    return Array.isArray(value) ? value : [];
}

/** Saves a new custom rule list (cleaned first) and applies it at once. */
async function saveCustomRules(ctx, next, message) {
    let clean;
    try {
        clean = cleanCustomRules(next);
    } catch (error) {
        throw new InputError(error.userMessage || 'That custom rule is not valid.');
    }
    const result = await saveRegistry(ctx, { automodCustomRules: clean }, 'automod');
    resetCustomRulesCache();
    return { ...result, message };
}

function customRuleById(ctx, form) {
    const id = text(form, 'id', 20);
    const rule = storedCustomRules(ctx).find((r) => r.id === id);
    if (!rule) throw new InputError('That custom rule is gone already. Reload the page.');
    return rule;
}

function customRulesSection(ctx, data) {
    const { rules, limit, planId } = data.custom;
    const plan = planId === 'free' ? 'Free' : planName(planId);
    const pricing = html`<a href="/pricing">See the plans</a>.`;
    if (!limit && !rules.length) {
        return html`<p>Custom rules come with the Normal, Pro and Max plans. The server owner's plan counts. This server is on ${plan}. ${pricing}</p>`;
    }
    const over = new Set(overLimitIds(rules, limit));
    const running = runningRules(rules, limit).length;
    const state = (rule) => {
        if (rule.enabled === false) return 'off';
        return over.has(rule.id) ? html`<span class="warn">not running (over the plan's limit)</span>` : 'on';
    };
    const list = table(['Name', 'Words', 'Action', 'State', '', ''], rules.map((rule) => [
        rule.name,
        String(rule.words.length),
        actionLabel(rule),
        state(rule),
        buttonForm(ctx, 'automod', 'custom-toggle', rule.enabled === false ? 'Turn on' : 'Turn off', { id: rule.id, enabled: rule.enabled === false ? 'true' : 'false' }),
        buttonForm(ctx, 'automod', 'custom-remove', 'Remove', { id: rule.id }, { confirm: `Remove the custom rule "${rule.name}"?` }),
    ]), 'No custom rules yet.');
    const summary = html`<p>${running} of ${limit} custom rule${limit === 1 ? '' : 's'} run on the ${plan} plan.${over.size ? html` ${over.size} turned-on rule${over.size === 1 ? '' : 's'} over the limit ${over.size === 1 ? 'does' : 'do'} not run. Turn some off or remove them, or move to a higher plan. ${pricing}` : ''}</p>`;
    const add = rules.length >= limit
        ? html`<p class="muted">This server has ${rules.length} custom rule${rules.length === 1 ? '' : 's'}, the most the ${plan} plan allows. ${limit < 100 ? pricing : ''}</p>`
        : postForm(ctx, 'automod', 'custom-add', html`<div class="grid">
${textInput('name', '', { label: 'Name', max: CUSTOM_RULE_NAME_MAX, placeholder: 'Other servers', help: 'A name so you can tell your rules apart.' })}
${selectInput('action', 'delete', CUSTOM_RULE_ACTIONS.map((a) => [a, a === 'delete' ? 'Delete the message' : a === 'warn' ? 'Delete and warn' : 'Delete and mute']), { label: 'What to do' })}
${textInput('muteDuration', '', { label: 'Mute for', max: 20, placeholder: '1h', help: 'Only used for mutes. For example 30m (30 minutes), 1h (one hour) or 1d (one day). At most 28d.' })}
${textArea('words', '', { label: 'Words or phrases', rows: 5, max: 4000, help: `Put each word or phrase on its own line. Up to ${CUSTOM_RULE_WORDS_MAX} lines, each up to ${CUSTOM_RULE_WORD_MAX} characters.` })}</div>`, { submit: 'Add rule' });
    const edit = rules.length ? html`<h3>Change a rule</h3>${rules.map((rule) => html`<details class="rule-edit"><summary>Change "${rule.name}"</summary>
${postForm(ctx, 'automod', 'custom-edit', html`<input type="hidden" name="id" value="${rule.id}"><div class="grid">
${selectInput('action', rule.action, CUSTOM_RULE_ACTIONS.map((a) => [a, a === 'delete' ? 'Delete the message' : a === 'warn' ? 'Delete and warn' : 'Delete and mute']), { label: 'What to do' })}
${textInput('muteDuration', rule.muteDuration || '', { label: 'Mute for', max: 20, placeholder: '1h', help: 'Only used for mutes, like 30m, 1h or 1d.' })}
${textArea('words', rule.words.join('\n'), { label: 'Words or phrases', rows: 5, max: 4000, help: 'One per line. This replaces the old list.' })}</div>`, { submit: 'Save changes' })}</details>`)}` : '';
    return html`${summary}${list}${edit}${add}`;
}

/** Writes the changed rule modes ({ ruleKey: mode | 'default' }) one by one; returns the settings after. */
async function saveRuleModes(ctx, before, wanted) {
    let after = before;
    for (const [key, mode] of Object.entries(wanted)) after = await ctx.services.setRuleMode(ctx.guildId, key, mode);
    return after;
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
/** Stats periods offered on the page (/automod stats days); 7 is the default. */
export const STATS_DAY_CHOICES = [1, 7, 30];
const DEFAULT_STATS_DAYS = 7;
const QUEUE_LISTED = 20;

/** ?days= of the page, one of STATS_DAY_CHOICES, else 7. */
export function statsDays(query) {
    const days = Number.parseInt(String(query?.days ?? ''), 10);
    return STATS_DAY_CHOICES.includes(days) ? days : DEFAULT_STATS_DAYS;
}

/** Runs a read; a failure (or a missing service) becomes `fallback` so the page still loads. */
async function attempt(run, fallback) {
    try {
        return await run();
    } catch {
        return fallback;
    }
}

const isDiscordUrl = (url) => /^https:\/\/(?:[a-z]+\.)?discord\.com\/channels\/\d+\/\d+\/\d+$/.test(String(url || ''));
const memberName = (guild, id) => guild?.members?.cache?.get(id)?.user?.username || null;

/** before/after snapshot diff of the automod settings, as audit changes. */
function settingsChanges(before, after, keys) {
    return diffSnapshots(before, after, keys);
}

async function change(ctx, keys, run, message) {
    const before = await ctx.services.getAutomodSettings(ctx.guildId);
    const result = await run();
    const after = result?.settings || result;
    const changes = settingsChanges(before, after, keys);
    return { changes, message: changes.length ? message : 'Nothing changed.' };
}

/** Heads-up first on/off per setting key (policy.js HEADS_UP_SETTING_KEYS), for the audit diff. */
function headsUpSnapshot(settings) {
    return Object.fromEntries(HEADS_UP_SETTING_KEYS.map((key) => [key, settings?.headsUp?.[key] !== false]));
}

const HEADS_UP_HELP = 'Heads-up first: the first time in 30 days, the member gets a private message and 2 minutes to edit or delete the message, and nothing else happens. Personal info is removed at once without a warning. Scam, NSFW, ads, mass mentions, spam, raids and slurs always act at once.';

function headsUpLine(stats) {
    if (stats === null) return html`<p class="muted">Heads-up counts could not be read (database).</p>`;
    return html`<p>Heads-ups in the last 30 days: ${stats.sent} sent, ${stats.fixed} fixed by the member, ${stats.acted} acted on after the wait.</p>`;
}

// ── Test run ──────────────────────────────────────────────────────────────

const TEST_RUN_HELP = 'Check recent messages against your current automod settings without acting on anything. Nothing is deleted, nobody gets a message, nothing is saved or logged. Only checks that look at one message at a time run. Spam, the same text posted in many channels, and repeated insults over time are skipped, because they depend on timing. Trusted member leniency is not applied, and administrators are skipped like automod does. Messages from people who have left the server are still checked.';
const SKIPPED_CHECKS = 'Not checked in a test run: Spam, the ad bot pattern (the same text in many channels from a new account), and harassment over time. An insult aimed at someone counts as Disrespect here.';

const number = (n) => Number(n || 0).toLocaleString('en-US');

function testRunForm(ctx, canAct) {
    const g = ctx.guild;
    return html`${postForm(ctx, 'automod', 'test-run', html`<div class="grid">
${channelPicker(g, 'channels', [], { label: `Channels (up to ${BACKTEST_MAX_CHANNELS})`, kinds: ['text'], perms: PERMS.read, multiple: true, optional: false, help: 'Mewvo needs View Channel and Read Message History in each one.' })}
${selectInput('days', '7', BACKTEST_DAY_CHOICES.map((n) => [String(n), n === 1 ? 'Last day' : `Last ${n} days`]), { label: 'How far back', help: `At most ${number(MAX_MESSAGES)} messages in total, newest first.` })}
${textInput('draftName', '', { label: 'Draft rule name (optional)', max: CUSTOM_RULE_NAME_MAX, placeholder: 'Draft rule', help: 'Try a custom rule before you add it. It is not saved.' })}
${textArea('draftWords', '', { label: 'Draft rule words (optional)', rows: 3, max: 4000, help: `One word or phrase per line, up to ${CUSTOM_RULE_WORDS_MAX}. Matched like custom rules.` })}</div>`, { submit: 'Start test run', canEdit: canAct })}
${canAct ? '' : html`<p class="muted">To start a test run you need the Administrator permission in the main server.</p>`}`;
}

const STRICT_HELP = `"May be too strict" shows when a rule caught at least ${STRICT_MIN_HITS} messages, from at least ${STRICT_MIN_MEMBERS} different members, and at least ${STRICT_MIN_SHARE * 100}% of the checked messages. It is only a hint: members may really break that rule that often. Look at the examples and the matched words before you change anything.`;
const FIX_HELP = 'The buttons change the rule for the whole server right away, the same as the Rule modes form, and the change is logged. Watch only: staff are told, nothing is deleted. Turn on: the rule follows the main setting. Channel exceptions still apply in their channels.';
// The modes the one-click buttons may set (test-run-rule).
const QUICK_MODES = { monitor: 'watch only', off: 'off', default: 'on' };

function sharePct(count, checked) {
    if (!checked) return '-';
    const value = (count / checked) * 100;
    return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

const strictNote = (entry) => (entry.mayBeTooStrict ? html`<span class="warn">Catches a lot, may be too strict</span>` : '');

/** A test-run-rule button: the rule key and mode are checked again on the server. */
function quickRuleButton(ctx, key, mode, label) {
    const ruleLabel = AUTOMOD_RULES[key].label;
    const confirm = mode === 'off' ? `Turn off ${ruleLabel} for the whole server?`
        : mode === 'monitor' ? `Set ${ruleLabel} to watch only for the whole server?`
            : `Turn on ${ruleLabel} for the whole server? It follows the main setting.`;
    return buttonForm(ctx, 'automod', 'test-run-rule', label, { rule: key, mode }, { confirm, danger: mode === 'off' });
}

/** The fix buttons for one result row, from the CURRENT settings (no button for a no-op). */
function fixButtons(ctx, key, entry, settings, customRules) {
    if (AUTOMOD_RULES[key]) {
        const now = ruleMode(settings, key);
        if (now === 'off') return html`<span class="muted">off now</span>`;
        return html`${entry.on && now !== 'monitor' ? quickRuleButton(ctx, key, 'monitor', 'Set to watch only') : ''}${quickRuleButton(ctx, key, 'off', 'Turn off')}`;
    }
    if (key.startsWith('custom-')) {
        const rule = customRules.find((r) => `custom-${r.id}` === key);
        if (!rule) return html`<span class="muted">removed since</span>`;
        if (rule.enabled === false) return html`<span class="muted">off now</span>`;
        return buttonForm(ctx, 'automod', 'custom-toggle', 'Turn off', { id: rule.id, enabled: 'false' }, { confirm: `Turn off the custom rule "${rule.name}"?` });
    }
    return '';
}

function wordsCell(entry) {
    const words = (entry.words || []).map((w, i) => html`${i ? ', ' : ''}<code>${w.word}</code> ${number(w.count)}`);
    return html`${words}${entry.moreWords ? html` <span class="muted">and ${number(entry.moreWords)} more</span>` : ''}`;
}

/** "Add this rule" for the draft: posts the cleaned draft to custom-add (same checks and plan limit). */
function draftAdd(ctx, draft, custom) {
    if (!draft?.list?.length) return '';
    const name = String(draft.name || 'Draft rule');
    const limit = custom?.limit ?? 0;
    const count = custom?.rules?.length ?? 0;
    const head = html`<h3>Draft rule</h3><p>"${name}", ${number(draft.list.length)} word${draft.list.length === 1 ? '' : 's'} or phrase${draft.list.length === 1 ? '' : 's'}. It is not saved yet.</p>`;
    if (!limit) return html`${head}<p class="muted">Custom rules come with the Normal, Pro and Max plans. <a href="/pricing">See the plans</a>.</p>`;
    if (count >= limit) return html`${head}<p class="muted">This server already has ${count} custom rule${count === 1 ? '' : 's'}, the most its plan allows. Remove one under Custom rules first.</p>`;
    return html`${head}${buttonForm(ctx, 'automod', 'custom-add', 'Add this rule', { name, action: 'delete', muteDuration: '', words: draft.list.join('\n') }, { confirm: `Add the custom rule "${name}"? It starts deleting matching messages right away. You can change what it does under Custom rules.`, danger: false })}
<p class="muted">Added as a custom rule that deletes the message. Change it to warn or mute under Custom rules.</p>`;
}

function testRunResult(ctx, job, data = {}) {
    const r = job.result || {};
    const p = job.params || {};
    const settings = data.settings || {};
    const customRules = data.custom?.rules || [];
    const days = p.days === 1 ? 'the last day' : `the last ${p.days} days`;
    const channels = (p.channelIds || []).length;
    const rows = Object.entries(r.byRule || {}).sort((a, b) => b[1].count - a[1].count).map(([key, entry]) => {
        let mode = 'draft, not saved';
        if (key !== DRAFT_KEY) mode = [entry.on ? 'acts' : '', entry.monitor ? 'watch only' : ''].filter(Boolean).join(', ');
        return [entry.label, number(entry.count), number(entry.members), sharePct(entry.count, r.checked), mode, strictNote(entry), fixButtons(ctx, key, entry, settings, customRules)];
    });
    const offRows = Object.entries(r.offRules || {}).filter(([key]) => AUTOMOD_RULES[key]).sort((a, b) => b[1].count - a[1].count).map(([key, entry]) => [
        entry.label, number(entry.count), number(entry.members), sharePct(entry.count, r.checked), strictNote(entry),
        ruleMode(settings, key) === 'off' ? quickRuleButton(ctx, key, 'default', 'Turn on') : html`<span class="muted">on now</span>`,
    ]);
    const wordRows = [
        ...Object.values(r.byRule || {}),
        ...Object.values(r.offRules || {}).map((entry) => ({ ...entry, label: `${entry.label} (off)` })),
    ].filter((entry) => entry.words?.length).map((entry) => [entry.label, wordsCell(entry)]);
    const examples = (r.examples || []).map((ex) => [
        ex.at ? timeTag(new Date(ex.at)) : '-',
        html`${ex.author || ex.authorId} <span class="muted">${ex.authorId || ''}</span>`,
        `#${ex.channelName}`,
        (ex.rules || []).join(', '),
        ex.excerpt === null ? html`<span class="muted">hidden (the match could not be masked safely)</span>` : (ex.excerpt || html`<span class="muted">no text</span>`),
        isDiscordUrl(ex.url) ? html`<a href="${ex.url}" rel="noopener noreferrer" target="_blank">Open</a>` : '',
    ]);
    return html`<p>Read ${number(r.read)} message${r.read === 1 ? '' : 's'} from ${channels} channel${channels === 1 ? '' : 's'} in ${days}: ${number(r.checked)} checked, ${number(r.skippedBots)} from bots skipped, ${number(r.skippedAdmins)} from administrators skipped. ${number(r.hitMessages)} message${r.hitMessages === 1 ? '' : 's'} broke a rule.</p>
${r.capped ? html`<p class="warn">Stopped at the limit of ${number(MAX_MESSAGES)} messages. Older messages in that time may not have been checked.</p>` : ''}
${p.automodEnabled ? '' : html`<p class="warn">Automod is off right now. This shows what it would catch with these settings.</p>`}
${r.invitesUnchecked ? html`<p class="muted">${number(r.invitesUnchecked)} invite link${r.invitesUnchecked === 1 ? ' was' : 's were'} not looked up (lookup limit reached), so they are not counted.</p>` : ''}
<p class="muted">${SKIPPED_CHECKS}</p>
${table(['Rule', 'Messages', 'Members', 'Share of checked', 'Mode', 'Note', 'Suggested fix'], rows, 'No message broke a rule.')}
${offRows.length ? html`<h3>Turned off, but would have caught messages</h3>${table(['Rule', 'Messages', 'Members', 'Share of checked', 'Note', 'Suggested fix'], offRows, '')}` : ''}
<p class="muted">${STRICT_HELP}</p>
${rows.length || offRows.length ? html`<p class="muted">${FIX_HELP}</p>` : ''}
${wordRows.length ? html`<h3>Matched words</h3><p class="muted">How often each word or phrase matched, partly hidden like the examples.</p>${table(['Rule', 'Words'], wordRows, '')}` : ''}
${draftAdd(ctx, p.draft, data.custom)}
${examples.length ? html`<h3>Examples (up to ${MAX_EXAMPLES})</h3>${table(['When', 'Member', 'Channel', 'Rule', 'Excerpt', ''], examples, '')}` : ''}`;
}

/** The Test run card: idle / running / done / failed, then the form (not while running). */
function testRunSection(ctx, job, data) {
    const canAct = Boolean(ctx.canEdit && ctx.canAct);
    const reload = html`<a href="${path('/automod')}#s-test-run">Reload this page</a>`;
    if (job === undefined) {
        return html`<p class="error" role="alert">The test run state could not be read. ${reload} to try again.</p>`;
    }
    if (job?.status === 'running') {
        return html`<p role="status"><b>Test run in progress.</b> ${number(job.progress?.read)} of at most ${number(MAX_MESSAGES)} messages read so far, started ${timeTag(new Date(job.startedAt))}. ${reload} to see the progress.</p>`;
    }
    if (job?.status === 'failed') {
        return html`<p class="error" role="alert">The last test run failed: ${job.error || 'unknown error.'}</p>
${job.result?.read ? html`<p class="muted">${number(job.result.read)} messages were read before it stopped.</p>` : ''}
${testRunForm(ctx, canAct)}`;
    }
    if (job?.status === 'done') {
        return html`${testRunResult(ctx, job, data)}
<h3>Start a new test run</h3><p class="muted">A new run replaces this result. Results are kept for 30 minutes.</p>
${testRunForm(ctx, canAct)}`;
    }
    return testRunForm(ctx, canAct);
}

function nativeRows(ctx, rules, policies) {
    return rules.map((rule) => {
        const policy = policyFor(policies, rule.id);
        return [rule.name, policy.policy, `${policy.dedupeMinutes} min`];
    });
}

export default {
    key: 'automod',
    label: 'Automod',
    state: 'automod',
    help: 'Automod watches messages and joins in the main server and acts on spam, bad words, unwanted links and raids by itself, so staff do not have to catch everything. You can also change these with /automod in Discord.',

    async load(ctx) {
        const settings = await ctx.services.getAutomodSettings(ctx.guildId);
        let nativeRules = null;
        let policies = new Map();
        try {
            const fetched = await ctx.guild?.autoModerationRules?.fetch?.();
            nativeRules = fetched ? [...fetched.values()].map((r) => ({ id: r.id, name: r.name })) : [];
            policies = await ctx.services.loadNativePolicies(ctx.guildId);
        } catch {
            nativeRules = null;
        }
        const days = statsDays(ctx.query);
        const [byRule, stats, lockdown, reviews, probations, headsUp] = await Promise.all([
            attempt(() => ctx.services.automodRuleStats(ctx.guildId, days), {}),
            attempt(() => ctx.services.automodStats(ctx.guildId, days), { total: 0, byGroup: [] }),
            // undefined / null = could not be read (shown as such, never as "none").
            attempt(() => ctx.services.getLockdownState(ctx.guildId), undefined),
            attempt(() => ctx.services.collectOpenReviews(ctx.client), null),
            attempt(() => ctx.services.listProbations(ctx.guildId), null),
            attempt(() => ctx.services.headsUpStats(ctx.guildId, { days: 30 }), null),
        ]);
        const planId = planOfGuild(ctx);
        // undefined = could not be read; null = no test run (or its result expired).
        let backtest = null;
        try {
            backtest = typeof ctx.services.getAutomodBacktest === 'function' ? ctx.services.getAutomodBacktest(ctx.guildId) : null;
        } catch {
            backtest = undefined;
        }
        return {
            settings, nativeRules, policies, byRule, stats, days, lockdown, reviews, probations, headsUp, backtest,
            custom: { rules: storedCustomRules(ctx), limit: limitForPlan(planId), planId },
            registry: {
                reviewChannelId: registryValue(ctx, 'reviewChannelId'),
                alertsChannelId: registryValue(ctx, 'alertsChannelId'),
                extraBlockedWords: registryValue(ctx, 'extraBlockedWords'),
                exemptChannelIds: registryValue(ctx, 'exemptChannelIds'),
            },
        };
    },

    render(ctx, data) {
        const g = ctx.guild;
        const s = data.settings;
        const gate = normalizeJoinGate(s.joinGate);
        const ruleKeys = Object.keys(AUTOMOD_RULES);
        // The on/off switch is in the page header (pages.js moduleSettingsPage).
        const top = html`${postForm(ctx, 'automod', 'mode', html`<div class="grid grid-wide">${selectInput('mode', s.mode, [['enforce', 'Act: delete or warn, then tell staff'], ['monitor', 'Watch only: tell staff, do nothing']], { label: 'What automod does', help: 'Staff are told with a review card: a message in the review channel with buttons to keep or undo what automod did. In watch-only mode the card has an Apply button instead.' })}</div>`)}`;
        // Heads-up first: a checkbox on the rules that offer it (policy.js); "headsup-form" marks
        // that the column was on the page, so a missing checkbox means off.
        const headsUpCell = (key) => (headsUpSettingKey(key)
            ? checkboxInput(`headsup:${headsUpSettingKey(key)}`, headsUpEnabled(s, key), { label: 'Heads-up first' })
            : html`<span class="muted">acts at once</span>`);
        const rules = html`${postForm(ctx, 'automod', 'rules', html`<input type="hidden" name="headsup-form" value="1">${table(['Rule', 'Mode', 'Heads-up first'], [
            ...ruleKeys.map((key) => [
                AUTOMOD_RULES[key].label,
                selectInput(`rule:${key}`, s.ruleModes[key] || 'default', [['default', `default (${s.mode === 'monitor' ? 'monitor' : 'on'})`], ...RULE_MODES.map((m) => [m, m])], { label: '' }),
                headsUpCell(key),
            ]),
            ['Custom rules (all)', html`<span class="muted">see Custom rules</span>`, headsUpCell(HEADS_UP_CUSTOM_KEY)],
        ])}`, { submit: 'Save rules' })}
${headsUpLine(data.headsUp)}`;
        const exceptionRows = [];
        for (const [channelId, overrides] of Object.entries(s.channelRules)) {
            for (const [rule, mode] of Object.entries(overrides)) {
                exceptionRows.push([channelName(g, channelId), AUTOMOD_RULES[rule]?.label || rule, mode,
                    buttonForm(ctx, 'automod', 'channel-remove', 'Remove', { channel: channelId, rule })]);
            }
        }
        const exceptions = html`${table(['Channel or category', 'Rule', 'Mode', ''], exceptionRows, 'No per-channel rule exceptions.')}
${postForm(ctx, 'automod', 'channel-add', html`<div class="grid">${channelPicker(g, 'channel', null, { label: 'Channel or category', kinds: ['text', 'category'], perms: PERMS.read, optional: false, help: 'A category is a folder of channels. Picking one covers every channel in it.' })}
${selectInput('rule', ruleKeys[0], ruleKeys.map((k) => [k, AUTOMOD_RULES[k].label]), { label: 'Rule' })}
${selectInput('mode', 'off', CHANNEL_RULE_MODES.map((m) => [m, m]), { label: 'Mode there', help: 'off: the rule is skipped there. monitor: staff are told, nothing is deleted.' })}</div>`, { submit: 'Add exception' })}`;
        const exempt = html`${table(['Channel', ''], s.exemptChannelIds.map((id) => [channelName(g, id), buttonForm(ctx, 'automod', 'exempt-remove', 'Remove', { channel: id })]), 'Automod checks every channel.')}
${postForm(ctx, 'automod', 'exempt-add', channelPicker(g, 'channel', null, { label: 'Ignore this channel', kinds: ['text', 'category'], perms: PERMS.read, optional: false, help: 'Automod does not check any messages here.' }), { submit: 'Add', inline: true })}
${data.registry.exemptChannelIds.length ? html`<p class="muted">Also ignored (set by the bot owner outside the dashboard): ${data.registry.exemptChannelIds.map((id, i) => html`${i ? ', ' : ''}${channelName(g, id)}`)}</p>` : ''}`;
        const trusted = postForm(ctx, 'automod', 'trusted', html`<div class="grid">
${rolePicker(g, 'roleId', s.trusted.roleId, { label: 'Trusted role', assign: false, noneLabel: 'none', help: 'Members with this role are trusted.' })}
${numberInput('minLevel', s.trusted.minLevel, { label: 'Or from level', min: 0, max: 1000, help: 'Members at this leveling level or higher are trusted too. 0 turns this off.' })}</div>`);
        const secondChance = html`${toggleForm(ctx, 'automod', 'second-chance', s.secondChance, { label: 'Second chance: a friendly notice instead of a warning for a first small slip' })}
`;
        const mood = toggleForm(ctx, 'automod', 'mood', s.moodAlerts, { label: 'Mood alerts: when a channel gets heated, post a calm-down note and slow the chat for a short time' });
        const panic = html`
${postForm(ctx, 'automod', 'panic', html`<div class="grid">${switchInput('enabled', s.panic.enabled, { label: 'Panic mode: stop new invites and private messages between members when a raid lockdown starts' })}
${numberInput('hours', s.panic.hours, { label: 'Stop them for (hours)', min: 1, max: 24 })}</div>`)}`;
        const joinGate = postForm(ctx, 'automod', 'join-gate', html`<div class="grid">
${Object.entries(JOIN_GATE_CHECKS).map(([check, { label }]) => selectInput(`gate:${check}`, gate[check], JOIN_GATE_ACTIONS.map((a) => [a, a]), { label }))}
${numberInput('ageDays', gate.ageDays, { label: 'New account means younger than (days)', min: 1, max: 365 })}</div>`);
        const native = data.nativeRules === null
            ? html`<p class="warn">Could not read Discord's own AutoMod rules. Mewvo needs the Manage Server permission for that.</p>`
            : html`${table(['Discord rule', 'What Mewvo does', 'At most once per member every'], nativeRows(ctx, data.nativeRules, data.policies), 'This server has no Discord AutoMod rules. You make them in Discord under Server Settings, AutoMod.')}
${data.nativeRules.length ? postForm(ctx, 'automod', 'native', html`<div class="grid">${selectInput('ruleId', data.nativeRules[0].id, data.nativeRules.map((r) => [r.id, r.name]), { label: 'Discord rule' })}
${selectInput('policy', 'log', NATIVE_POLICIES.map((p) => [p, p]), { label: 'What Mewvo does', help: 'ignore: nothing. log: a short line in the review channel. warn: a warning and a review card.' })}
${numberInput('dedupeMinutes', '', { label: 'Act once per member every (minutes)', min: 1, max: 1440, help: 'More blocks by the same member in this time are only counted. Leave empty to keep the current value.' })}</div>`, { submit: 'Set policy' }) : ''}`;
        const channels = postForm(ctx, 'automod', 'channels', html`<div class="grid">
${channelPicker(g, 'reviewChannelId', data.registry.reviewChannelId, { label: 'Review channel', help: 'Where staff see review cards, member reports and verifications waiting for a check. Not set: the mod log channel.' })}
${channelPicker(g, 'alertsChannelId', data.registry.alertsChannelId, { label: 'Alerts channel', help: 'Where Mewvo warns staff about raids and other urgent things, and posts summaries. Not set: the mod log channel.' })}
${textArea('extraBlockedWords', data.registry.extraBlockedWords.join('\n'), { label: 'Extra blocked words', rows: 4, max: 20000, help: 'Added to the built-in bad word list. Put each word on its own line. They start working after the bot restarts.' })}</div>`);
        const rulesStats = Object.entries(data.byRule).sort((a, b) => b[1].actions - a[1].actions);
        const days = data.days || DEFAULT_STATS_DAYS;
        const dayChips = html`<nav class="chips" aria-label="Stats period">${STATS_DAY_CHOICES.map((n) => html`<a class="chip${n === days ? ' is-active' : ''}" href="${path(`/automod${queryString({ days: n })}`)}"${n === days ? raw(' aria-current="page"') : ''}>${n === 1 ? '1 day' : `${n} days`}</a>`)}</nav>`;
        const stats = html`${dayChips}<p>${data.stats.total} automatic action${data.stats.total === 1 ? '' : 's'} in ${days === 1 ? 'the last day' : `${days} days`}. <span class="muted">If staff undo 30% or more of a rule's actions, the rule is probably too strict.</span></p>
${table(['Rule', 'Actions', 'Undone', 'Changed', 'Undo rate'], rulesStats.map(([rule, t]) => {
        const rate = pct(t.undone + t.changed, t.actions);
        return [AUTOMOD_RULES[rule]?.label || rule, t.actions, t.undone, t.changed, html`<span class="${rate >= 30 ? 'bad' : ''}">${rate}%</span>`];
    }), 'No automod actions.')}`;
        // Live operations (admins act; OWNER_IDS without Administrator view them).
        const canAct = Boolean(ctx.canEdit && ctx.canAct);
        const lockdown = data.lockdown;
        const lockdownBody = lockdown === undefined
            ? html`<p class="error" role="alert">The lockdown state could not be read (database). Reload the page to try again.</p>`
            : lockdown?.active
                ? html`<p class="warn"><b>A raid lockdown is active</b>${lockdown.startedAt ? html` since ${formatDate(lockdown.startedAt)}` : ''}, ${(lockdown.joinerIds || []).length} raid joiner${(lockdown.joinerIds || []).length === 1 ? '' : 's'}.</p>
${buttonForm(ctx, 'automod', 'lockdown-end', 'End lockdown', {}, { confirm: 'End the raid lockdown? The verification level goes back to what it was and paused invites and DMs resume.', canEdit: canAct })}
${canAct ? '' : html`<p class="muted">To end a lockdown you need the Administrator permission in the main server.</p>`}
<p><a href="${path('/incidents')}">Follow it on the raid timeline</a></p>`
                : html`<p class="muted">No lockdown right now. One starts by itself when many accounts join at once (a raid). Past raids are on the <a href="${path('/incidents')}">raid timeline</a>.</p>`;
        const reviews = data.reviews;
        const queue = reviews === null
            ? html`<p class="error" role="alert">The review queue could not be read (review channel unavailable).</p>`
            : html`${table(['Card', 'Since', 'Messages'], reviews.slice(0, QUEUE_LISTED).map((item) => [
                isDiscordUrl(item.url) ? html`<a href="${item.url}" rel="noopener noreferrer" target="_blank">${item.title || 'Review card'}</a>` : (item.title || 'Review card'),
                item.at ? timeTag(new Date(item.at)) : '-',
                item.count || 1,
            ]), 'Nothing is waiting for review.')}
${reviews.length > QUEUE_LISTED ? html`<p class="muted">…and ${reviews.length - QUEUE_LISTED} more.</p>` : ''}
<p class="muted">Review cards waiting for staff: the ones posted since the bot last started, and the last 50 messages in the review channel that still have buttons. Short lines for small things are not listed. You decide on each card in Discord with its buttons (Keep, Undo, Change, Dismiss).</p>`;
        const probations = data.probations;
        const probation = probations === null
            ? html`<p class="error" role="alert">Probations could not be read (database). Reload the page to try again.</p>`
            : table(['Member', 'Until', 'Ban', ''], probations.map((p) => [
                html`<a href="${path(`/users/${encodeURIComponent(p.userId)}`)}">${memberName(g, p.userId) || p.userId}</a> <span class="muted">${p.userId}</span>`,
                formatDate(new Date(Number(p.until))),
                p.caseCode ? html`<a href="${path(`/cases/${encodeURIComponent(p.caseCode)}`)}"><code>${p.caseCode}</code></a>${p.how ? ` (${p.how})` : ''}` : '-',
                buttonForm(ctx, 'automod', 'probation-end', 'End probation', { user: p.userId }, { confirm: 'End this probation now?', canEdit: canAct }),
            ]), 'Nobody is on probation.');
        // v6: cards grouped by topic (common.js topic/section).
        const lockdownCard = section('Raid lockdown', lockdownBody, 'A lockdown starts by itself when many accounts join at once.', { size: 'full' });
        const live = topic('Right now', 'What is waiting for staff at this moment.', html`${lockdown?.active ? lockdownCard : ''}
${section(`Review queue${reviews ? ` (${reviews.length})` : ''}`, queue, '', { key: 'review-queue' })}
${section(`Probation${probations ? ` (${probations.length})` : ''}`, probation, 'Members who came back after a ban ended. Automod is stricter with them for a while: they skip straight to the next punishment step, and get no second chance or trusted-member leniency.', { key: 'probation' })}`);
        const ruleCards = topic('Rules', 'What automod checks, and what it does when a rule is broken.', html`${section('Global mode', top, 'What every rule does unless you change it below.')}
${section('Channels and words', channels, 'Where automod talks to staff, and your own blocked words.')}
${section('Rule modes', rules, `Change single rules. default: does what the main setting above says. on: acts. monitor: only tells staff. off: the rule is not checked. ${HEADS_UP_HELP}`, { size: 'full' })}
${section('Custom rules', customRulesSection(ctx, data), 'Your own lists of words and phrases to block. Like the built-in rules, they match whole words, do not care about capital letters, and catch look-alike letters (like 0 for o). A match deletes the message and posts a review card. Warn and mute also add it to the member\'s record (a case). They follow the main automod setting and skip ignored channels. How many you can have depends on the server owner\'s plan.', { size: 'full' })}
${section('Discord AutoMod', native, 'Discord has its own AutoMod built in. When one of its rules blocks a message, Mewvo can also log it or warn the member.', { size: 'full' })}`);
        // Small switch cards side by side, then the two forms side by side, then the list.
        const leniency = topic('Exceptions and leniency', 'Where automod looks away, and who gets a softer start.', html`${section('Second chance', secondChance, 'Go easy on a first small slip.')}
${section('Mood', mood, 'Slowmode makes members wait a few seconds between messages.')}
${section('Trusted members', trusted, 'Trusted members skip the rules for small things. Serious rules still apply. To turn this off, pick none and set the level to 0.')}
${section('Channel exceptions', exceptions, 'Turn one rule off, or to watch only, in one channel. For example, allow links in a links channel.')}
${section('Ignored channels', exempt, 'Channels where automod checks nothing at all.')}`);
        const raids = topic('Raids and new members', 'Checks at the door and what happens when many accounts join at once.', html`${section('Join gate', joinGate, 'Checks new members as they join. For each check: off does nothing; flag tells staff in the review channel, with Kick and Dismiss buttons; kick removes them and sends a private message saying how to come back.')}
${section('Panic', panic, 'A raid lockdown starts by itself when many accounts join at once. Panic mode makes it harder for raiders to spread.')}
${lockdown?.active ? '' : lockdownCard}`);
        const results = topic('Results', 'How often automod acted, and how often staff undid it.', html`${section(days === 1 ? 'Last day' : `Last ${days} days`, stats, '', { key: 'automod-stats', size: 'full' })}
${section('Test run', testRunSection(ctx, data.backtest, data), TEST_RUN_HELP, { key: 'test-run', size: 'full' })}`);
        return html`${live}${ruleCards}${leniency}${raids}${results}`;
    },

    actions: {
        async enabled(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Automod');
            return change(ctx, ['enabled'], () => ctx.services.setAutomodEnabled(ctx.guildId, enabled), `Automod is now ${enabled ? 'on' : 'off'}.`);
        },
        async mode(ctx, form) {
            const mode = choiceField(form, 'mode', ['enforce', 'monitor'], 'Mode');
            return change(ctx, ['mode'], () => ctx.services.setAutomodMode(ctx.guildId, mode), `Global mode: ${mode}.`);
        },
        async rules(ctx, form) {
            const before = await ctx.services.getAutomodSettings(ctx.guildId);
            const wanted = {};
            for (const key of Object.keys(AUTOMOD_RULES)) {
                const value = text(form, `rule:${key}`, 20) || 'default';
                if (value !== 'default' && !RULE_MODES.includes(value)) throw new InputError(`${AUTOMOD_RULES[key].label}: unknown mode.`);
                if ((before.ruleModes[key] || 'default') !== value) wanted[key] = value;
            }
            let after = await saveRuleModes(ctx, before, wanted);
            // Heads-up first (only when the form had the column).
            if (text(form, 'headsup-form', 5) === '1') {
                for (const key of HEADS_UP_SETTING_KEYS) {
                    const wantedOn = checkbox(form, `headsup:${key}`);
                    if ((after.headsUp?.[key] !== false) !== wantedOn) after = await ctx.services.setHeadsUp(ctx.guildId, key, wantedOn);
                }
            }
            const changes = [
                ...diffSnapshots(before.ruleModes, after.ruleModes, null, 'ruleModes.'),
                ...diffSnapshots(headsUpSnapshot(before), headsUpSnapshot(after), null, 'headsUp.'),
            ];
            return { changes, message: changes.length ? 'Rules saved.' : 'Nothing changed.' };
        },
        // A one-click fix on the test run result: one rule to watch only, off, or on (default).
        // The rule key and mode are checked here again, never taken from the stored result.
        async 'test-run-rule'(ctx, form) {
            const rule = choiceField(form, 'rule', Object.keys(AUTOMOD_RULES), 'Rule');
            const mode = choiceField(form, 'mode', Object.keys(QUICK_MODES), 'Mode');
            const before = await ctx.services.getAutomodSettings(ctx.guildId);
            const wanted = (before.ruleModes[rule] || 'default') === mode ? {} : { [rule]: mode };
            const after = await saveRuleModes(ctx, before, wanted);
            const changes = diffSnapshots(before.ruleModes, after.ruleModes, null, 'ruleModes.');
            const label = AUTOMOD_RULES[rule].label;
            const message = mode === 'default' ? `${label} is on. It follows the main setting.` : `${label} is now ${QUICK_MODES[mode]}.`;
            return { changes, message: changes.length ? message : 'Nothing changed.' };
        },
        async 'custom-add'(ctx, form) {
            const list = storedCustomRules(ctx);
            const planId = planOfGuild(ctx);
            const limit = limitForPlan(planId);
            if (list.length >= limit) {
                const plan = planId === 'free' ? 'Free' : planName(planId);
                throw new InputError(limit
                    ? `This server already has ${list.length} custom rules, the most the ${plan} plan allows. Remove one first.`
                    : 'Custom rules are part of the Normal, Pro and Max plans, on the server owner\'s plan.');
            }
            const rule = {
                name: text(form, 'name', CUSTOM_RULE_NAME_MAX + 20),
                action: text(form, 'action', 10),
                muteDuration: text(form, 'muteDuration', 20),
                words: String(form?.words ?? '').slice(0, 5000),
                enabled: true,
            };
            const result = await saveCustomRules(ctx, [...list, rule], 'Custom rule added.');
            return { ...result, message: `Custom rule "${rule.name.replace(/\s+/g, ' ').trim()}" added.` };
        },
        async 'custom-edit'(ctx, form) {
            const rule = customRuleById(ctx, form);
            let next;
            try {
                ({ list: next } = editRule(storedCustomRules(ctx), rule.id, {
                    words: String(form?.words ?? '').slice(0, 5000),
                    action: text(form, 'action', 10),
                    muteDuration: text(form, 'muteDuration', 20),
                }));
            } catch (error) {
                throw new InputError(error.userMessage || 'That custom rule is not valid.');
            }
            return saveCustomRules(ctx, next, `Custom rule "${rule.name}" saved.`);
        },
        async 'custom-toggle'(ctx, form) {
            const rule = customRuleById(ctx, form);
            const enabled = boolField(form, 'enabled', 'Custom rule');
            if ((rule.enabled !== false) === enabled) return NOTHING;
            const next = storedCustomRules(ctx).map((r) => (r.id === rule.id ? { ...r, enabled } : r));
            return saveCustomRules(ctx, next, `Custom rule "${rule.name}" is ${enabled ? 'on' : 'off'}.`);
        },
        async 'custom-remove'(ctx, form) {
            const rule = customRuleById(ctx, form);
            const next = storedCustomRules(ctx).filter((r) => r.id !== rule.id);
            return saveCustomRules(ctx, next, `Custom rule "${rule.name}" removed.`);
        },
        async 'channel-add'(ctx, form) {
            const channelId = channelField(ctx.guild, form, 'channel', { kinds: ['text', 'category'], optional: false, label: 'Channel or category' });
            const rule = choiceField(form, 'rule', Object.keys(AUTOMOD_RULES), 'Rule');
            const mode = choiceField(form, 'mode', CHANNEL_RULE_MODES, 'Mode');
            return change(ctx, ['channelRules'], () => ctx.services.setChannelRuleMode(ctx.guildId, channelId, rule, mode), 'Channel exception saved.');
        },
        async 'channel-remove'(ctx, form) {
            const channelId = text(form, 'channel', 25);
            const rule = choiceField(form, 'rule', Object.keys(AUTOMOD_RULES), 'Rule');
            if (!/^\d{17,20}$/.test(channelId)) throw new InputError('Channel: not a channel ID.');
            return change(ctx, ['channelRules'], () => ctx.services.setChannelRuleMode(ctx.guildId, channelId, rule, 'default'), 'Channel exception removed.');
        },
        async 'exempt-add'(ctx, form) {
            const channelId = channelField(ctx.guild, form, 'channel', { kinds: ['text', 'category'], optional: false, label: 'Ignore this channel' });
            return change(ctx, ['exemptChannelIds'], () => ctx.services.setExemptChannel(ctx.guildId, channelId, true), 'Automod now ignores that channel.');
        },
        async 'exempt-remove'(ctx, form) {
            const channelId = text(form, 'channel', 25);
            if (!/^\d{17,20}$/.test(channelId)) throw new InputError('Channel: not a channel ID.');
            return change(ctx, ['exemptChannelIds'], () => ctx.services.setExemptChannel(ctx.guildId, channelId, false), 'Automod checks that channel again.');
        },
        async trusted(ctx, form) {
            const roleId = roleField(ctx.guild, form, 'roleId', { label: 'Trusted role' });
            if (roleId) {
                const problem = ctx.services.getTrustedRoleProblem(ctx.guild, ctx.guild.roles.cache.get(roleId));
                if (problem) throw new InputError(plainText(problem));
            }
            const minLevel = intField(form, 'minLevel', { min: 0, max: 1000, label: 'Or from level', fallback: 0 });
            const clear = !roleId && minLevel === 0;
            return change(ctx, ['trusted'], () => ctx.services.setTrusted(ctx.guildId, clear ? { clear: true } : { roleId, minLevel }), 'Trusted members saved.');
        },
        async 'second-chance'(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Second chance');
            return change(ctx, ['secondChance'], () => ctx.services.setSecondChance(ctx.guildId, enabled), `Second chance is ${enabled ? 'on' : 'off'}.`);
        },
        async mood(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Mood alerts');
            return change(ctx, ['moodAlerts'], () => ctx.services.setMoodAlerts(ctx.guildId, enabled), `Mood alerts are ${enabled ? 'on' : 'off'}.`);
        },
        async panic(ctx, form) {
            const enabled = checkbox(form, 'enabled');
            const hours = intField(form, 'hours', { min: 1, max: 24, label: 'Stop them for (hours)' });
            const result = await change(ctx, ['panic'], () => ctx.services.setPanic(ctx.guildId, { enabled, hours }), `Panic mode is ${enabled ? 'on' : 'off'}.`);
            const canPause = ctx.guild?.members?.me?.permissions?.has?.('ManageGuild');
            if (enabled && canPause === false) result.warnings = ['I don\'t have Manage Server, so pausing invites and DMs will fail until I get it.'];
            return result;
        },
        async 'join-gate'(ctx, form) {
            const before = await ctx.services.getAutomodSettings(ctx.guildId);
            const gate = normalizeJoinGate(before.joinGate);
            const ageDays = intField(form, 'ageDays', { min: 1, max: 365, label: 'New account means younger than (days)' });
            let after = before;
            for (const check of Object.keys(JOIN_GATE_CHECKS)) {
                const action = choiceField(form, `gate:${check}`, JOIN_GATE_ACTIONS, JOIN_GATE_CHECKS[check].label);
                const days = check === 'age' && ageDays !== gate.ageDays ? ageDays : null;
                if (action !== gate[check] || days) after = await ctx.services.setJoinGateCheck(ctx.guildId, check, action, days);
            }
            const changes = diffSnapshots(normalizeJoinGate(before.joinGate), normalizeJoinGate(after.joinGate), null, 'joinGate.');
            return { changes, message: changes.length ? 'Join gate saved.' : 'Nothing changed.' };
        },
        async native(ctx, form) {
            const ruleId = text(form, 'ruleId', 25);
            if (!/^\d{17,20}$/.test(ruleId)) throw new InputError('Pick a Discord AutoMod rule from the list.');
            const policy = choiceField(form, 'policy', NATIVE_POLICIES, 'Policy');
            const dedupeMinutes = intField(form, 'dedupeMinutes', { min: 1, max: 1440, label: 'Act once per member every (minutes)', fallback: null });
            const rule = await ctx.guild?.autoModerationRules?.fetch?.(ruleId).catch(() => null);
            if (!rule) throw new InputError('That Discord AutoMod rule no longer exists.');
            const before = policyFor(await ctx.services.loadNativePolicies(ctx.guildId), ruleId);
            await ctx.services.setNativePolicy(ctx.guildId, ruleId, policy, dedupeMinutes, ctx.actor.userId);
            const after = policyFor(await ctx.services.loadNativePolicies(ctx.guildId), ruleId);
            const changes = diffSnapshots(before, after, null, `native.${ruleId}.`);
            return { changes, message: changes.length ? `Discord rule "${rule.name}" updated.` : 'Nothing changed.' };
        },
        // /automod lockdown-end: restores the verification level, resumes invites and DMs, posts the incident report.
        'lockdown-end': {
            admin: true,
            async run(ctx) {
                const state = await ctx.services.getLockdownState(ctx.guildId);
                if (!state?.active) throw new InputError('There is no lockdown right now.');
                const ended = await ctx.services.endLockdown(ctx.guild, { id: ctx.actor.userId, username: ctx.actor.username });
                if (!ended) throw new InputError('There is no lockdown right now.');
                return {
                    changes: [{ key: 'lockdown', old: { active: true, startedAt: state.startedAt || null, joiners: (state.joinerIds || []).length }, new: null }],
                    message: 'Lockdown ended. The verification level is back to what it was, and paused invites and DMs are resumed.',
                };
            },
        },
        // /automod probation user end:true
        'probation-end': {
            admin: true,
            async run(ctx, form) {
                const userId = userIdField(form, 'user', 'Member');
                const record = await ctx.services.endProbation(ctx.guildId, userId);
                if (!record) throw new InputError('That member is not on probation.');
                return {
                    changes: [{ key: `probation:${userId}`, old: { until: new Date(Number(record.until)).toISOString(), caseCode: record.caseCode || null }, new: null }],
                    message: `Probation for ${memberName(ctx.guild, userId) || userId} ended early.`,
                };
            },
        },
        // Test run: read-only, so nothing is audited (changes: []); Administrator only.
        'test-run': {
            admin: true,
            async run(ctx, form) {
                const picked = list(form, 'channels', { max: 100 });
                if (!picked.length) throw new InputError('Pick at least one channel.', 400, 'channels');
                if (picked.length > BACKTEST_MAX_CHANNELS) throw new InputError(`Pick at most ${BACKTEST_MAX_CHANNELS} channels (${picked.length} picked).`, 400, 'channels');
                const channelIds = channelListField(ctx.guild, form, 'channels', { kinds: ['text'], label: 'Channel', max: BACKTEST_MAX_CHANNELS });
                const days = Number(choiceField(form, 'days', BACKTEST_DAY_CHOICES.map(String), 'How far back'));
                const draftName = text(form, 'draftName', CUSTOM_RULE_NAME_MAX + 20);
                const draftWords = String(form?.draftWords ?? '').slice(0, 5000);
                const settings = await ctx.services.getAutomodSettings(ctx.guildId);
                // Automod checks nothing in ignored channels (automodSettings.isChannelExempt).
                const ignored = new Set([...(settings.exemptChannelIds || []), ...(registryValue(ctx, 'exemptChannelIds') || [])]);
                const skipped = channelIds.find((id) => ignored.has(id));
                if (skipped) throw new InputError(`Automod ignores #${ctx.guild.channels.cache.get(skipped)?.name || skipped}, so a test run there finds nothing. Pick another channel.`, 400, 'channels');
                const customRules = runningRules(storedCustomRules(ctx), limitForPlan(planOfGuild(ctx)));
                try {
                    ctx.services.startAutomodBacktest({
                        guild: ctx.guild, channelIds, days, settings, customRules,
                        draft: draftName || draftWords.trim() ? { name: draftName, words: draftWords } : null,
                        startedBy: ctx.actor.userId,
                    });
                } catch (error) {
                    if (error instanceof BacktestError || error?.name === 'BacktestError') throw new InputError(error.userMessage || error.message, 400, 'channels');
                    throw error;
                }
                return { changes: [], message: 'Test run started. Reload the page in a moment to see the progress.' };
            },
        },
        async channels(ctx, form) {
            const g = ctx.guild;
            const words = [...new Set(String(form?.extraBlockedWords ?? '').split(/[\n,]/).map((w) => w.trim().toLowerCase()).filter(Boolean))];
            const patch = changedOnly({
                reviewChannelId: channelField(g, form, 'reviewChannelId', { label: 'Review channel' }),
                alertsChannelId: channelField(g, form, 'alertsChannelId', { label: 'Alerts channel' }),
                extraBlockedWords: typeof form?.extraBlockedWords === 'string' ? words : registryValue(ctx, 'extraBlockedWords'),
            }, {
                reviewChannelId: registryValue(ctx, 'reviewChannelId'),
                alertsChannelId: registryValue(ctx, 'alertsChannelId'),
                extraBlockedWords: registryValue(ctx, 'extraBlockedWords'),
            });
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'automod');
        },
    },
};

