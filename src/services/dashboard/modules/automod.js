// automod.js — Automod: global on/off and mode, per-rule modes, custom rules (by plan), channel exceptions,
// trusted members, second chance, mood alerts, panic mode, join gate, native AutoMod
// policies, review/alerts channels — plus the stats (1/7/30 days, ?days=), and the live
// operations of /automod: the review queue (/automod queue), members on probation
// (/automod extrawatch end) and ending a raid lockdown (/automod lockdown-end). Every
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
// Immune members (owner, 2026-11-13): roles (up to 10) and user ids (up to 50) whose messages
// automod checks but never deletes or punishes (automodService.js handleImmuneHits). Every
// Administrator sees the list; changing it needs Administrator (like every automod action) and
// being the server owner or OWNER_IDS with owner power here (canManageImmunity, on every save).
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
import { html, path, queryString, raw, timeTag } from '../html.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelListField, channelName, channelPicker, checkbox, checkboxInput, switchInput, choiceField,
    intField, list, numberInput, plainText, postForm, roleField, roleName, rolePicker, selectInput, text, textArea, textInput, toggleForm, userIdField,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { changedOnly, registryValue, saveRegistry, saveRegistryWith, section, table, topic } from './common.js';
import {
    CUSTOM_RULE_ACTIONS, CUSTOM_RULE_NAME_MAX, CUSTOM_RULE_WORDS_MAX, CUSTOM_RULE_WORD_MAX, cleanCustomRules,
    limitForPlan, overLimitIds, resetCustomRulesCache, runningRules,
} from '../../automod/customRules.js';
import { editRule } from '../../automod/customRuleEdits.js';
import {
    BACKTEST_DAY_CHOICES, BACKTEST_MAX_CHANNELS, BacktestError, DRAFT_KEY, MAX_EXAMPLES, MAX_MESSAGES,
    STRICT_MIN_HITS, STRICT_MIN_MEMBERS, STRICT_MIN_SHARE,
} from '../../automod/backtest.js';
import { guildPlan as defaultGuildPlan } from '../../billing/premiumEffects.js';
import { planName } from '../../billing/premiumService.js';
import { textFor } from '../language.js';
import { IMMUNE_ROLES_MAX, IMMUNE_USERS_MAX, isLegacyAutomodGuild, shouldNudgeToEnforce } from '../../automod/automodSettings.js';
import { hasOwnerPower } from '../../../utils/ownerPower.js';
import { requireCanAct, adminOnlyActions } from './serverScope.js';

// Words: src/content/dashboard/<lang>/automod.json. English rule, join-gate check and policy names
// come from config/automod.js, joinGate.js and nativeBridge.js as before; other languages take
// automod.ruleNames / automod.gate / automod.native.policies. Messages from the automod services
// (custom rule validation, test run refusals, trusted role problems) stay as those services word them.

/** The server owner's plan (ctx.services.guildPlan in tests). */
const planOfGuild = (ctx) => (typeof ctx.services?.guildPlan === 'function' ? ctx.services.guildPlan(ctx.guildId) : defaultGuildPlan(ctx.guildId));

const isEnglish = (tr) => tr.lang === 'en';

/** A built-in rule's name: config/automod.js in English, automod.ruleNames.<key> otherwise. */
function ruleName(tr, key) {
    const own = `automod.ruleNames.${key}`;
    if (!isEnglish(tr) && AUTOMOD_RULES[key] && tr.has(own)) return tr.t(own);
    return AUTOMOD_RULES[key]?.label || key;
}

const LABEL_KEYS = new Map(Object.entries(AUTOMOD_RULES).map(([key, rule]) => [rule.label, key]));
/** A rule label as a test run stored it (built-in name or "Draft: …"), in the page language. */
function storedLabel(tr, label) {
    if (isEnglish(tr) || typeof label !== 'string') return label;
    if (LABEL_KEYS.has(label)) return ruleName(tr, LABEL_KEYS.get(label));
    if (label.startsWith('Draft: ')) return tr.t('automod.testRun.draftLabel', { name: label.slice(7) });
    return label;
}

/** A join gate check's name (joinGate.js in English). */
function gateCheckName(tr, check) {
    const own = `automod.gate.checks.${check}`;
    return !isEnglish(tr) && tr.has(own) ? tr.t(own) : JOIN_GATE_CHECKS[check]?.label || check;
}

/** What people see for a join gate action / native policy value (the values stay). */
function valueWord(tr, group, value) {
    const own = `automod.${group}.${value}`;
    return !isEnglish(tr) && tr.has(own) ? tr.t(own) : value;
}

/** "Nothing changed." in the page language. */
const nothing = (tr) => ({ changes: [], message: tr.t('errors.nothingChanged') });

function storedCustomRules(ctx) {
    const value = registryValue(ctx, 'automodCustomRules');
    return Array.isArray(value) ? value : [];
}

/**
 * Changes the custom rule list under the settings row lock (saveRegistryWith): change(list)
 * gets the locked stored list and returns the new one (or null: nothing to change); it may throw
 * an InputError. The result is cleaned, saved and applied at once. `message`: text, or a
 * function called after the save (for words that need the locked rule, like its name).
 */
async function saveCustomRules(ctx, change, message) {
    const tr = textFor(ctx);
    const result = await saveRegistryWith(ctx, ['automodCustomRules'], (valueOf) => {
        const stored = valueOf('automodCustomRules');
        const next = change(Array.isArray(stored) ? stored : []);
        if (next === null) return null;
        try {
            return { automodCustomRules: cleanCustomRules(next) };
        } catch (error) {
            throw new InputError(error.userMessage || tr.t('automod.custom.invalid'));
        }
    }, 'automod');
    if (!result.changes.length) return nothing(tr);
    resetCustomRulesCache();
    return { ...result, message: typeof message === 'function' ? message() : message };
}

/** The rule with this id in `list`, else "gone" (an InputError). */
function ruleIn(ctx, list, id) {
    const rule = list.find((r) => r.id === id);
    if (!rule) throw new InputError(textFor(ctx).t('automod.custom.gone'));
    return rule;
}

/** A custom rule's action for the list (customRules.js actionLabel, in the page language). */
function customActionLabel(tr, rule) {
    if (rule.action === 'mute') return tr.t('automod.custom.actionMute', { duration: rule.muteDuration });
    return rule.action === 'warn' ? tr.t('automod.custom.actionWarn') : tr.t('automod.custom.actionDelete');
}

const customActionChoices = (tr) => CUSTOM_RULE_ACTIONS.map((a) => [a, a === 'delete' ? tr.t('automod.custom.do.delete') : a === 'warn' ? tr.t('automod.custom.do.warn') : tr.t('automod.custom.do.mute')]);

function customRulesSection(ctx, data) {
    const tr = textFor(ctx);
    const { rules, limit, planId } = data.custom;
    const plan = planId === 'free' ? 'Free' : planName(planId);
    const pricing = html`<a href="/pricing">${tr.t('automod.custom.seePlans')}</a>.`;
    if (!limit && !rules.length) {
        return html`<p>${tr.tx('automod.custom.noPlan', { plan, pricing })}</p>`;
    }
    const over = new Set(overLimitIds(rules, limit));
    const running = runningRules(rules, limit).length;
    const state = (rule) => {
        if (rule.enabled === false) return tr.t('automod.custom.stateOff');
        return over.has(rule.id) ? html`<span class="warn">${tr.tx('automod.custom.overLimit')}</span>` : tr.t('automod.custom.stateOn');
    };
    const list = table([tr.t('automod.custom.colName'), tr.t('automod.custom.colWords'), tr.t('automod.custom.colAction'), tr.t('automod.custom.colState'), '', ''], rules.map((rule) => [
        rule.name,
        tr.fmtNumber(rule.words.length),
        customActionLabel(tr, rule),
        state(rule),
        buttonForm(ctx, 'automod', 'custom-toggle', tr.t(rule.enabled === false ? 'forms.turnOn' : 'forms.turnOff'), { id: rule.id, enabled: rule.enabled === false ? 'true' : 'false' }),
        buttonForm(ctx, 'automod', 'custom-remove', tr.t('automod.common.remove'), { id: rule.id }, { confirm: tr.t('automod.custom.removeConfirm', { name: rule.name }) }),
    ]), tr.t('automod.custom.empty'));
    const summary = html`<p>${tr.tp('automod.custom.running', limit, { running: tr.fmtNumber(running), plan })}${over.size ? html` ${tr.tp('automod.custom.overLimitCount', over.size)} ${pricing}` : ''}</p>`;
    const add = rules.length >= limit
        ? html`<p class="muted">${tr.tp('automod.custom.atLimit', rules.length, { plan })} ${limit < 100 ? pricing : ''}</p>`
        : postForm(ctx, 'automod', 'custom-add', html`<div class="grid">
${textInput('name', '', { label: tr.t('automod.custom.name'), max: CUSTOM_RULE_NAME_MAX, placeholder: tr.t('automod.custom.namePlaceholder'), help: tr.t('automod.custom.nameHelp') })}
${selectInput('action', 'delete', customActionChoices(tr), { label: tr.t('automod.custom.whatToDo') })}
${textInput('muteDuration', '', { label: tr.t('automod.custom.muteFor'), max: 20, placeholder: '1h', help: tr.t('automod.custom.muteForHelp') })}
${textArea('words', '', { label: tr.t('automod.custom.words'), rows: 5, max: 4000, help: tr.t('automod.custom.wordsHelp', { lines: tr.fmtNumber(CUSTOM_RULE_WORDS_MAX), chars: tr.fmtNumber(CUSTOM_RULE_WORD_MAX) }) })}</div>`, { submit: tr.t('automod.custom.add') });
    const edit = rules.length ? html`<h3>${tr.t('automod.custom.changeTitle')}</h3>${rules.map((rule) => html`<details class="rule-edit"><summary>${tr.tx('automod.custom.changeRule', { name: rule.name })}</summary>
${postForm(ctx, 'automod', 'custom-edit', html`<input type="hidden" name="id" value="${rule.id}"><div class="grid">
${selectInput('action', rule.action, customActionChoices(tr), { label: tr.t('automod.custom.whatToDo') })}
${textInput('muteDuration', rule.muteDuration || '', { label: tr.t('automod.custom.muteFor'), max: 20, placeholder: '1h', help: tr.t('automod.custom.muteForHelpShort') })}
${textArea('words', rule.words.join('\n'), { label: tr.t('automod.custom.words'), rows: 5, max: 4000, help: tr.t('automod.custom.wordsHelpEdit') })}</div>`, { submit: tr.t('forms.save') })}</details>`)}` : '';
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

/** Who may change the immune list: the server owner (live), or OWNER_IDS with owner power here (ctx.services.hasOwnerPower in tests). */
export function canManageImmunity(ctx) {
    const userId = ctx.actor?.userId;
    if (!userId) return false;
    if (ctx.guild?.ownerId && String(ctx.guild.ownerId) === String(userId)) return true;
    const power = typeof ctx.services?.hasOwnerPower === 'function' ? ctx.services.hasOwnerPower : hasOwnerPower;
    return Boolean(power(String(userId), ctx.guildId));
}

const immuneField = (kind) => (kind === 'role' ? 'roleIds' : 'userIds');
/** The immune lists of loaded settings (always present from getAutomodSettings; older stores and fakes may lack them). */
const immuneOf = (settings) => ({ roleIds: settings?.immune?.roleIds || [], userIds: settings?.immune?.userIds || [] });

/** One immune entry as audit / mod-log text: "@Mods (id)" or "name (id)". */
function immuneEntryText(guild, kind, id) {
    const name = kind === 'role' ? guild?.roles?.cache?.get(id)?.name && `@${guild.roles.cache.get(id).name}` : memberName(guild, id);
    return name ? `${name} (${id})` : id;
}

/** The Immune members card: two lists, and the add forms for the owner only. */
function immuneSection(ctx, settings) {
    const tr = textFor(ctx);
    const g = ctx.guild;
    const canEdit = Boolean(ctx.canEdit && ctx.canAct && canManageImmunity(ctx));
    const remove = tr.t('automod.common.remove');
    const removeButton = (kind, id) => (canEdit ? buttonForm(ctx, 'automod', 'immune-remove', remove, { kind, id }, { canEdit }) : '');
    const userCell = (id) => {
        const name = memberName(g, id);
        return name ? html`${name} <span class="muted">(${id})</span>` : html`${id} <span class="muted">${tr.t('automod.immune.notInServer')}</span>`;
    };
    const { roleIds, userIds } = immuneOf(settings);
    const roles = table([tr.t('automod.immune.role'), ''], roleIds.map((id) => [roleName(g, id), removeButton('role', id)]), tr.t('automod.immune.noRoles'));
    const users = table([tr.t('automod.immune.user'), ''], userIds.map((id) => [userCell(id), removeButton('user', id)]), tr.t('automod.immune.noUsers'));
    const forms = canEdit
        ? html`${roleIds.length < IMMUNE_ROLES_MAX ? postForm(ctx, 'automod', 'immune-add', rolePicker(g, 'roleId', null, { label: tr.t('automod.immune.addRoleLabel'), assign: false, optional: false, help: tr.t('automod.immune.addRoleHelp', { max: IMMUNE_ROLES_MAX }) }), { submit: tr.t('automod.immune.add'), hidden: { kind: 'role' }, inline: true, canEdit }) : html`<p class="muted">${tr.t('automod.immune.rolesFull', { max: IMMUNE_ROLES_MAX })}</p>`}
${userIds.length < IMMUNE_USERS_MAX ? postForm(ctx, 'automod', 'immune-add', textInput('userId', '', { label: tr.t('automod.immune.addUserLabel'), max: 40, help: tr.t('automod.immune.addUserHelp', { max: IMMUNE_USERS_MAX }) }), { submit: tr.t('automod.immune.add'), hidden: { kind: 'user' }, inline: true, canEdit }) : html`<p class="muted">${tr.t('automod.immune.usersFull', { max: IMMUNE_USERS_MAX })}</p>`}`
        : html`<p class="muted">${tr.t('automod.immune.ownerOnly')}</p>`;
    return html`${roles}${users}${forms}<p class="muted">${tr.t('automod.immune.nativeNote')}</p>`;
}

/** Owner check + one add/remove through the service; the change as readable audit text. */
async function changeImmune(ctx, kind, id, immune) {
    const tr = textFor(ctx);
    if (!canManageImmunity(ctx)) throw new InputError(tr.t('automod.error.immuneOwnerOnly'), 403);
    const before = await ctx.services.getAutomodSettings(ctx.guildId);
    const list = immuneOf(before)[immuneField(kind)];
    if (immune && !list.includes(id)) {
        const max = kind === 'role' ? IMMUNE_ROLES_MAX : IMMUNE_USERS_MAX;
        if (list.length >= max) throw new InputError(tr.t(kind === 'role' ? 'automod.error.immuneRolesFull' : 'automod.error.immuneUsersFull', { max }));
    }
    const { settings } = await ctx.services.setImmuneEntry(ctx.guildId, kind, id, immune);
    const after = immuneOf(settings)[immuneField(kind)];
    const asText = (ids) => (ids.length ? ids.map((x) => immuneEntryText(ctx.guild, kind, x)).join(', ') : null);
    const key = kind === 'role' ? 'immune.roles' : 'immune.users';
    const changes = diffSnapshots({ [key]: asText(list) }, { [key]: asText(after) }, [key]);
    const who = immuneEntryText(ctx.guild, kind, id);
    return { changes, message: changes.length ? tr.t(immune ? 'automod.action.immuneAdded' : 'automod.action.immuneRemoved', { name: who }) : tr.t('errors.nothingChanged') };
}

// Immune members: Administrator (adminOnlyActions, the routes gate) and canManageImmunity, on every save.
const immuneActions = {
    'immune-add': {
        async run(ctx, form) {
            const tr = textFor(ctx);
            if (!canManageImmunity(ctx)) throw new InputError(tr.t('automod.error.immuneOwnerOnly'), 403);
            const kind = choiceField(form, 'kind', ['role', 'user'], tr.t('automod.immune.title'));
            const id = kind === 'role'
                ? roleField(ctx.guild, form, 'roleId', { optional: false, label: tr.t('automod.immune.addRoleLabel') })
                : userIdField(form, 'userId', tr.t('automod.immune.addUserLabel'));
            return changeImmune(ctx, kind, id, true);
        },
    },
    'immune-remove': {
        async run(ctx, form) {
            const tr = textFor(ctx);
            if (!canManageImmunity(ctx)) throw new InputError(tr.t('automod.error.immuneOwnerOnly'), 403);
            const kind = choiceField(form, 'kind', ['role', 'user'], tr.t('automod.immune.title'));
            const id = text(form, 'id', 25);
            if (!/^\d{17,20}$/.test(id)) throw new InputError(tr.t('forms.error.userId', { label: tr.t('automod.immune.title') }));
            return changeImmune(ctx, kind, id, false);
        },
    },
};

/** before/after snapshot diff of the automod settings, as audit changes. */
function settingsChanges(before, after, keys) {
    return diffSnapshots(before, after, keys);
}

/** Where automod review cards go in this server: the review channel, else the mod log (channelRouting.js), or null. */
function reviewChannelOf(ctx) {
    return registryValue(ctx, 'reviewChannelId') || registryValue(ctx, 'modLogChannelId') || null;
}

async function change(ctx, keys, run, message) {
    const before = await ctx.services.getAutomodSettings(ctx.guildId);
    const result = await run();
    const after = result?.settings || result;
    const changes = settingsChanges(before, after, keys);
    return { changes, message: changes.length ? message : textFor(ctx).t('errors.nothingChanged') };
}

/** Heads-up first on/off per setting key (policy.js HEADS_UP_SETTING_KEYS), for the audit diff. */
function headsUpSnapshot(settings) {
    return Object.fromEntries(HEADS_UP_SETTING_KEYS.map((key) => [key, settings?.headsUp?.[key] !== false]));
}

function headsUpLine(tr, stats) {
    if (stats === null) return html`<p class="muted">${tr.t('automod.rules.headsUpUnreadable')}</p>`;
    return html`<p>${tr.t('automod.rules.headsUpCounts', { sent: tr.fmtNumber(stats.sent), fixed: tr.fmtNumber(stats.fixed), acted: tr.fmtNumber(stats.acted) })}</p>`;
}

// ── Test run ──────────────────────────────────────────────────────────────

const number = (n) => Number(n || 0).toLocaleString('en-US');
/** A count in text: English keeps "2,000" (en-US grouping, as the page always showed); others their own. */
const num = (tr, n) => (isEnglish(tr) ? number(n) : tr.fmtNumber(Number(n || 0)));

/** "Last day" / "Last 7 days" (titles, choices). */
const lastDays = (tr, n) => (n === 1 ? tr.t('automod.period.lastDay') : tr.tp('automod.period.lastDays', n));

function testRunForm(ctx, canAct) {
    const tr = textFor(ctx);
    const g = ctx.guild;
    return html`${postForm(ctx, 'automod', 'test-run', html`<div class="grid">
${channelPicker(g, 'channels', [], { label: tr.t('automod.testRun.channels', { max: tr.fmtNumber(BACKTEST_MAX_CHANNELS) }), kinds: ['text'], perms: PERMS.read, multiple: true, optional: false, help: tr.t('automod.testRun.channelsHelp') })}
${selectInput('days', '7', BACKTEST_DAY_CHOICES.map((n) => [String(n), lastDays(tr, n)]), { label: tr.t('automod.testRun.howFarBack'), help: tr.t('automod.testRun.howFarBackHelp', { max: num(tr, MAX_MESSAGES) }) })}
${textInput('draftName', '', { label: tr.t('automod.testRun.draftName'), max: CUSTOM_RULE_NAME_MAX, placeholder: tr.t('automod.testRun.draftDefault'), help: tr.t('automod.testRun.draftNameHelp') })}
${textArea('draftWords', '', { label: tr.t('automod.testRun.draftWordsLabel'), rows: 3, max: 4000, help: tr.t('automod.testRun.draftWordsHelp', { max: tr.fmtNumber(CUSTOM_RULE_WORDS_MAX) }) })}</div>`, { submit: tr.t('automod.testRun.start'), canEdit: canAct })}
${canAct ? '' : html`<p class="muted">${tr.t('automod.testRun.needsAdmin')}</p>`}`;
}

// The modes the one-click buttons may set (test-run-rule).
const QUICK_MODES = { monitor: "report only (don't delete)", off: 'off', default: 'on' };
// What people see for a rule mode value (the values stay: policy.js RULE_MODES, CHANNEL_RULE_MODES).
const MODE_KEYS = { on: 'automod.mode.on', monitor: 'automod.mode.monitor', off: 'automod.mode.off' };
const modeWord = (tr, mode) => (MODE_KEYS[mode] ? tr.t(MODE_KEYS[mode]) : mode);

function sharePct(tr, count, checked) {
    if (!checked) return '-';
    const value = (count / checked) * 100;
    if (isEnglish(tr)) return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
    return `${tr.fmtNumber(value < 10 ? Math.round(value * 10) / 10 : Math.round(value), { maximumFractionDigits: 1 })}%`;
}

const strictNote = (tr, entry) => (entry.mayBeTooStrict ? html`<span class="warn">${tr.t('automod.testRun.strictNote')}</span>` : '');

/** A test-run-rule button: the rule key and mode are checked again on the server. */
function quickRuleButton(ctx, key, mode, label) {
    const tr = textFor(ctx);
    const rule = ruleName(tr, key);
    const confirm = mode === 'off' ? tr.t('automod.fix.confirmOff', { rule })
        : mode === 'monitor' ? tr.t('automod.fix.confirmMonitor', { rule })
            : tr.t('automod.fix.confirmOn', { rule });
    return buttonForm(ctx, 'automod', 'test-run-rule', label, { rule: key, mode }, { confirm, danger: mode === 'off' });
}

/** The fix buttons for one result row, from the CURRENT settings (no button for a no-op). */
function fixButtons(ctx, key, entry, settings, customRules) {
    const tr = textFor(ctx);
    if (AUTOMOD_RULES[key]) {
        const now = ruleMode(settings, key);
        if (now === 'off') return html`<span class="muted">${tr.t('automod.fix.offNow')}</span>`;
        return html`${entry.on && now !== 'monitor' ? quickRuleButton(ctx, key, 'monitor', tr.t('automod.fix.setMonitor')) : ''}${quickRuleButton(ctx, key, 'off', tr.t('forms.turnOff'))}`;
    }
    if (key.startsWith('custom-')) {
        const rule = customRules.find((r) => `custom-${r.id}` === key);
        if (!rule) return html`<span class="muted">${tr.t('automod.fix.removedSince')}</span>`;
        if (rule.enabled === false) return html`<span class="muted">${tr.t('automod.fix.offNow')}</span>`;
        return buttonForm(ctx, 'automod', 'custom-toggle', tr.t('forms.turnOff'), { id: rule.id, enabled: 'false' }, { confirm: tr.t('automod.fix.confirmCustomOff', { name: rule.name }) });
    }
    return '';
}

function wordsCell(tr, entry) {
    const words = (entry.words || []).map((w, i) => html`${i ? ', ' : ''}<code>${w.word}</code> ${num(tr, w.count)}`);
    return html`${words}${entry.moreWords ? html` <span class="muted">${tr.t('automod.testRun.moreWords', { more: num(tr, entry.moreWords) })}</span>` : ''}`;
}

/** "Add this rule" for the draft: posts the cleaned draft to custom-add (same checks and plan limit). */
function draftAdd(ctx, draft, custom) {
    if (!draft?.list?.length) return '';
    const tr = textFor(ctx);
    const name = String(draft.name || tr.t('automod.testRun.draftDefault'));
    const limit = custom?.limit ?? 0;
    const count = custom?.rules?.length ?? 0;
    const words = tr.tp('automod.testRun.draftWords', draft.list.length, { count: num(tr, draft.list.length) });
    const head = html`<h3>${tr.t('automod.testRun.draftTitle')}</h3><p>${tr.tx('automod.testRun.draftHead', { name, words })}</p>`;
    if (!limit) return html`${head}<p class="muted">${tr.t('automod.testRun.draftNoPlan')} <a href="/pricing">${tr.t('automod.custom.seePlans')}</a>.</p>`;
    if (count >= limit) return html`${head}<p class="muted">${tr.tp('automod.testRun.draftAtLimit', count)}</p>`;
    return html`${head}${buttonForm(ctx, 'automod', 'custom-add', tr.t('automod.testRun.draftAdd'), { name, action: 'delete', muteDuration: '', words: draft.list.join('\n') }, { confirm: tr.t('automod.testRun.draftAddConfirm', { name }), danger: false })}
<p class="muted">${tr.t('automod.testRun.draftAddNote')}</p>`;
}

function testRunResult(ctx, job, data = {}) {
    const tr = textFor(ctx);
    const r = job.result || {};
    const p = job.params || {};
    const settings = data.settings || {};
    const customRules = data.custom?.rules || [];
    const period = p.days === 1 ? tr.t('automod.period.inLastDay') : tr.tp('automod.period.inLastDays', p.days);
    const channels = (p.channelIds || []).length;
    const rows = Object.entries(r.byRule || {}).sort((a, b) => b[1].count - a[1].count).map(([key, entry]) => {
        let mode = tr.t('automod.testRun.modeDraft');
        if (key !== DRAFT_KEY) mode = [entry.on ? tr.t('automod.testRun.modeActs') : '', entry.monitor ? tr.t('automod.mode.monitor') : ''].filter(Boolean).join(', ');
        return [storedLabel(tr, entry.label), num(tr, entry.count), num(tr, entry.members), sharePct(tr, entry.count, r.checked), mode, strictNote(tr, entry), fixButtons(ctx, key, entry, settings, customRules)];
    });
    const offRows = Object.entries(r.offRules || {}).filter(([key]) => AUTOMOD_RULES[key]).sort((a, b) => b[1].count - a[1].count).map(([key, entry]) => [
        storedLabel(tr, entry.label), num(tr, entry.count), num(tr, entry.members), sharePct(tr, entry.count, r.checked), strictNote(tr, entry),
        ruleMode(settings, key) === 'off' ? quickRuleButton(ctx, key, 'default', tr.t('forms.turnOn')) : html`<span class="muted">${tr.t('automod.fix.onNow')}</span>`,
    ]);
    const wordRows = [
        ...Object.values(r.byRule || {}).map((entry) => ({ ...entry, label: storedLabel(tr, entry.label) })),
        ...Object.values(r.offRules || {}).map((entry) => ({ ...entry, label: tr.t('automod.testRun.offSuffix', { rule: storedLabel(tr, entry.label) }) })),
    ].filter((entry) => entry.words?.length).map((entry) => [entry.label, wordsCell(tr, entry)]);
    const examples = (r.examples || []).map((ex) => [
        ex.at ? timeTag(new Date(ex.at)) : '-',
        html`${ex.author || ex.authorId} <span class="muted">${ex.authorId || ''}</span>`,
        `#${ex.channelName}`,
        (ex.rules || []).map((label) => storedLabel(tr, label)).join(', '),
        ex.excerpt === null ? html`<span class="muted">${tr.t('automod.testRun.excerptHidden')}</span>` : (ex.excerpt || html`<span class="muted">${tr.t('automod.testRun.noText')}</span>`),
        isDiscordUrl(ex.url) ? html`<a href="${ex.url}" rel="noopener noreferrer" target="_blank">${tr.t('automod.common.open')}</a>` : '',
    ]);
    const ruleCol = tr.t('automod.testRun.colRule');
    const summary = tr.t('automod.testRun.summary', {
        read: tr.tp('automod.testRun.readMessages', r.read, { count: num(tr, r.read) }),
        from: tr.tp('automod.testRun.fromChannels', channels),
        period,
        checked: num(tr, r.checked),
        bots: num(tr, r.skippedBots),
        admins: num(tr, r.skippedAdmins),
        hits: tr.tp('automod.testRun.hitMessages', r.hitMessages, { count: num(tr, r.hitMessages) }),
    });
    return html`<p>${summary}</p>
${r.capped ? html`<p class="warn">${tr.t('automod.testRun.capped', { max: num(tr, MAX_MESSAGES) })}</p>` : ''}
${p.automodEnabled ? '' : html`<p class="warn">${tr.t('automod.testRun.automodOff')}</p>`}
${r.invitesUnchecked ? html`<p class="muted">${tr.tp('automod.testRun.invitesUnchecked', r.invitesUnchecked, { count: num(tr, r.invitesUnchecked) })}</p>` : ''}
<p class="muted">${tr.t('automod.testRun.skippedChecks')}</p>
${table([ruleCol, tr.t('automod.testRun.colMessages'), tr.t('automod.testRun.colMembers'), tr.t('automod.testRun.colShare'), tr.t('automod.testRun.colMode'), tr.t('automod.testRun.colNote'), tr.t('automod.testRun.colFix')], rows, tr.t('automod.testRun.noHits'))}
${offRows.length ? html`<h3>${tr.t('automod.testRun.offTitle')}</h3>${table([ruleCol, tr.t('automod.testRun.colMessages'), tr.t('automod.testRun.colMembers'), tr.t('automod.testRun.colShare'), tr.t('automod.testRun.colNote'), tr.t('automod.testRun.colFix')], offRows, '')}` : ''}
<p class="muted">${tr.t('automod.testRun.strictHelp', { hits: tr.fmtNumber(STRICT_MIN_HITS), members: tr.fmtNumber(STRICT_MIN_MEMBERS), share: tr.fmtNumber(STRICT_MIN_SHARE * 100) })}</p>
${rows.length || offRows.length ? html`<p class="muted">${tr.t('automod.testRun.fixHelp')}</p>` : ''}
${wordRows.length ? html`<h3>${tr.t('automod.testRun.wordsTitle')}</h3><p class="muted">${tr.t('automod.testRun.wordsHelp')}</p>${table([ruleCol, tr.t('automod.testRun.colWords')], wordRows, '')}` : ''}
${draftAdd(ctx, p.draft, data.custom)}
${examples.length ? html`<h3>${tr.t('automod.testRun.examplesTitle', { max: tr.fmtNumber(MAX_EXAMPLES) })}</h3>${table([tr.t('automod.testRun.colWhen'), tr.t('automod.testRun.colMember'), tr.t('automod.testRun.colChannel'), ruleCol, tr.t('automod.testRun.colExcerpt'), ''], examples, '')}` : ''}`;
}

/** The Test run card: idle / running / done / failed, then the form (not while running). */
function testRunSection(ctx, job, data) {
    const tr = textFor(ctx);
    const canAct = Boolean(ctx.canEdit && ctx.canAct);
    const reload = html`<a href="${path('/automod')}#s-test-run">${tr.t('automod.testRun.reload')}</a>`;
    if (job === undefined) {
        return html`<p class="error" role="alert">${tr.tx('automod.testRun.stateUnreadable', { reload })}</p>`;
    }
    if (job?.status === 'running') {
        return html`<p role="status"><b>${tr.t('automod.testRun.inProgress')}</b> ${tr.tx('automod.testRun.progress', { read: num(tr, job.progress?.read), max: num(tr, MAX_MESSAGES), started: timeTag(new Date(job.startedAt)), reload })}</p>`;
    }
    if (job?.status === 'failed') {
        return html`<p class="error" role="alert">${tr.tx('automod.testRun.failed', { error: job.error || tr.t('automod.testRun.unknownError') })}</p>
${job.result?.read ? html`<p class="muted">${tr.tp('automod.testRun.readBeforeStop', job.result.read, { count: num(tr, job.result.read) })}</p>` : ''}
${testRunForm(ctx, canAct)}`;
    }
    if (job?.status === 'done') {
        return html`${testRunResult(ctx, job, data)}
<h3>${tr.t('automod.testRun.newTitle')}</h3><p class="muted">${tr.t('automod.testRun.newHelp')}</p>
${testRunForm(ctx, canAct)}`;
    }
    return testRunForm(ctx, canAct);
}

function nativeRows(ctx, rules, policies) {
    const tr = textFor(ctx);
    return rules.map((rule) => {
        const policy = policyFor(policies, rule.id);
        return [rule.name, valueWord(tr, 'native.policies', policy.policy), tr.t('automod.native.minutes', { count: tr.fmtNumber(policy.dedupeMinutes) })];
    });
}

export default {
    key: 'automod',
    label: 'Automod',
    state: 'automod',
    help: 'Automod watches messages and joins in this server and acts on spam, bad words, unwanted links and raids by itself, so staff do not have to catch everything. You can also change these with /automod in Discord.',

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
            attempt(() => ctx.services.collectOpenReviews(ctx.client, ctx.guildId), null),
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
        const tr = textFor(ctx);
        const g = ctx.guild;
        const s = data.settings;
        const gate = normalizeJoinGate(s.joinGate);
        const ruleKeys = Object.keys(AUTOMOD_RULES);
        const remove = tr.t('automod.common.remove');
        const ruleCol = tr.t('automod.common.rule');
        const modeCol = tr.t('automod.common.mode');
        // The on/off switch is in the page header (pages.js moduleSettingsPage).
        const top = html`${postForm(ctx, 'automod', 'mode', html`<div class="grid grid-wide">${selectInput('mode', s.mode, [['enforce', tr.t('automod.global.enforce')], ['monitor', tr.t('automod.global.monitor')]], { label: tr.t('automod.global.label'), help: tr.t('automod.global.labelHelp') })}</div>`)}`;
        // Heads-up first: a checkbox on the rules that offer it (policy.js); "headsup-form" marks
        // that the column was on the page, so a missing checkbox means off.
        const headsUpLabel = tr.t('automod.rules.headsUp');
        const headsUpCell = (key) => (headsUpSettingKey(key)
            ? checkboxInput(`headsup:${headsUpSettingKey(key)}`, headsUpEnabled(s, key), { label: headsUpLabel })
            : html`<span class="muted">${tr.t('automod.rules.actsAtOnce')}</span>`);
        const rules = html`${postForm(ctx, 'automod', 'rules', html`<input type="hidden" name="headsup-form" value="1">${table([ruleCol, modeCol, headsUpLabel], [
            ...ruleKeys.map((key) => [
                ruleName(tr, key),
                selectInput(`rule:${key}`, s.ruleModes[key] || 'default', [['default', tr.t('automod.rules.defaultOption', { mode: modeWord(tr, s.mode === 'monitor' ? 'monitor' : 'on') })], ...RULE_MODES.map((m) => [m, modeWord(tr, m)])], { label: '' }),
                headsUpCell(key),
            ]),
            [tr.t('automod.rules.customAll'), html`<span class="muted">${tr.t('automod.rules.seeCustom')}</span>`, headsUpCell(HEADS_UP_CUSTOM_KEY)],
        ])}`, { submit: tr.t('automod.rules.save') })}
${headsUpLine(tr, data.headsUp)}`;
        const exceptionRows = [];
        for (const [channelId, overrides] of Object.entries(s.channelRules)) {
            for (const [rule, mode] of Object.entries(overrides)) {
                exceptionRows.push([channelName(g, channelId), ruleName(tr, rule), modeWord(tr, mode),
                    buttonForm(ctx, 'automod', 'channel-remove', remove, { channel: channelId, rule })]);
            }
        }
        const channelOrCategory = tr.t('automod.exceptions.channel');
        const exceptions = html`${table([channelOrCategory, ruleCol, modeCol, ''], exceptionRows, tr.t('automod.exceptions.empty'))}
${postForm(ctx, 'automod', 'channel-add', html`<div class="grid">${channelPicker(g, 'channel', null, { label: channelOrCategory, kinds: ['text', 'category'], perms: PERMS.read, optional: false, help: tr.t('automod.exceptions.channelHelp') })}
${selectInput('rule', ruleKeys[0], ruleKeys.map((k) => [k, ruleName(tr, k)]), { label: ruleCol })}
${selectInput('mode', 'off', CHANNEL_RULE_MODES.map((m) => [m, modeWord(tr, m)]), { label: tr.t('automod.exceptions.modeThere'), help: tr.t('automod.exceptions.modeThereHelp') })}</div>`, { submit: tr.t('automod.exceptions.add') })}`;
        const exempt = html`${table([tr.t('automod.exempt.channel'), ''], s.exemptChannelIds.map((id) => [channelName(g, id), buttonForm(ctx, 'automod', 'exempt-remove', remove, { channel: id })]), tr.t('automod.exempt.empty'))}
${postForm(ctx, 'automod', 'exempt-add', channelPicker(g, 'channel', null, { label: tr.t('automod.exempt.ignore'), kinds: ['text', 'category'], perms: PERMS.read, optional: false, help: tr.t('automod.exempt.ignoreHelp') }), { submit: tr.t('automod.exempt.add'), inline: true })}
${data.registry.exemptChannelIds.length ? html`<p class="muted">${tr.tx('automod.exempt.alsoIgnored', { channels: html`${data.registry.exemptChannelIds.map((id, i) => html`${i ? ', ' : ''}${channelName(g, id)}`)}` })}</p>` : ''}`;
        const trusted = postForm(ctx, 'automod', 'trusted', html`<div class="grid">
${rolePicker(g, 'roleId', s.trusted.roleId, { label: tr.t('automod.trusted.role'), assign: false, noneLabel: tr.t('automod.trusted.none'), help: tr.t('automod.trusted.roleHelp') })}
${numberInput('minLevel', s.trusted.minLevel, { label: tr.t('automod.trusted.minLevel'), min: 0, max: 1000, help: tr.t('automod.trusted.minLevelHelp') })}</div>`, { canEdit: ctx.canEdit && ctx.canAct });
        const secondChance = html`${toggleForm(ctx, 'automod', 'second-chance', s.secondChance, { label: tr.t('automod.secondChance.label') })}
`;
        const mood = toggleForm(ctx, 'automod', 'mood', s.moodAlerts, { label: tr.t('automod.mood.label') });
        const panic = html`
${postForm(ctx, 'automod', 'panic', html`<div class="grid">${switchInput('enabled', s.panic.enabled, { label: tr.t('automod.panic.label') })}
${numberInput('hours', s.panic.hours, { label: tr.t('automod.panic.hours'), min: 1, max: 24 })}</div>`)}`;
        const joinGate = postForm(ctx, 'automod', 'join-gate', html`<div class="grid">
${Object.keys(JOIN_GATE_CHECKS).map((check) => selectInput(`gate:${check}`, gate[check], JOIN_GATE_ACTIONS.map((a) => [a, valueWord(tr, 'gate.actions', a)]), { label: gateCheckName(tr, check) }))}
${numberInput('ageDays', gate.ageDays, { label: tr.t('automod.gate.ageDays'), min: 1, max: 365 })}</div>`);
        const discordRule = tr.t('automod.native.rule');
        const whatMewvoDoes = tr.t('automod.native.policy');
        const native = data.nativeRules === null
            ? html`<p class="warn">${tr.tx('automod.native.unreadable')}</p>`
            : html`${table([discordRule, whatMewvoDoes, tr.t('automod.native.once')], nativeRows(ctx, data.nativeRules, data.policies), tr.t('automod.native.empty'))}
${data.nativeRules.length ? postForm(ctx, 'automod', 'native', html`<div class="grid">${selectInput('ruleId', data.nativeRules[0].id, data.nativeRules.map((r) => [r.id, r.name]), { label: discordRule })}
${selectInput('policy', 'log', NATIVE_POLICIES.map((p) => [p, valueWord(tr, 'native.policies', p)]), { label: whatMewvoDoes, help: tr.t('automod.native.policyHelp') })}
${numberInput('dedupeMinutes', '', { label: tr.t('automod.native.dedupe'), min: 1, max: 1440, help: tr.t('automod.native.dedupeHelp') })}</div>`, { submit: tr.t('automod.native.submit') }) : ''}`;
        const channels = postForm(ctx, 'automod', 'channels', html`<div class="grid">
${channelPicker(g, 'reviewChannelId', data.registry.reviewChannelId, { label: tr.t('automod.channels.review'), help: tr.t('automod.channels.reviewHelp') })}
${channelPicker(g, 'alertsChannelId', data.registry.alertsChannelId, { label: tr.t('automod.channels.alerts'), help: tr.t('automod.channels.alertsHelp') })}
${textArea('extraBlockedWords', data.registry.extraBlockedWords.join('\n'), { label: tr.t('automod.channels.words'), rows: 4, max: 20000, help: tr.t('automod.channels.wordsHelp') })}</div>`);
        const rulesStats = Object.entries(data.byRule).sort((a, b) => b[1].actions - a[1].actions);
        const days = data.days || DEFAULT_STATS_DAYS;
        const dayChips = html`<nav class="chips" aria-label="${tr.t('automod.stats.period')}">${STATS_DAY_CHOICES.map((n) => html`<a class="chip${n === days ? ' is-active' : ''}" href="${path(`/automod${queryString({ days: n })}`)}"${n === days ? raw(' aria-current="page"') : ''}>${n === 1 ? tr.t('automod.period.oneDay') : tr.tp('automod.period.days', n)}</a>`)}</nav>`;
        const statsPeriod = days === 1 ? tr.t('automod.period.theLastDay') : tr.tp('automod.period.days', days);
        const stats = html`${dayChips}<p>${tr.tp('automod.stats.total', data.stats.total, { period: statsPeriod })} <span class="muted">${tr.tx('automod.stats.undoHint')}</span></p>
${table([ruleCol, tr.t('automod.stats.actions'), tr.t('automod.stats.undone'), tr.t('automod.stats.changed'), tr.t('automod.stats.undoRate')], rulesStats.map(([rule, t]) => {
        const rate = pct(t.undone + t.changed, t.actions);
        return [ruleName(tr, rule), t.actions, t.undone, t.changed, html`<span class="${rate >= 30 ? 'bad' : ''}">${rate}%</span>`];
    }), tr.t('automod.stats.empty'))}`;
        // Live operations (admins act; OWNER_IDS without Administrator view them).
        const canAct = Boolean(ctx.canEdit && ctx.canAct);
        const lockdown = data.lockdown;
        const timeline = html`<a href="${path('/incidents')}">${tr.t('automod.lockdown.timelineLink')}</a>`;
        const joiners = (lockdown?.joinerIds || []).length;
        const lockdownBody = lockdown === undefined
            ? html`<p class="error" role="alert">${tr.t('automod.lockdown.unreadable')}</p>`
            : lockdown?.active
                ? html`<p class="warn"><b>${tr.t('automod.lockdown.active')}</b>${lockdown.startedAt ? html` ${tr.t('automod.lockdown.since', { date: tr.fmtDateTime(lockdown.startedAt) })}` : ''}, ${tr.tp('automod.lockdown.joiners', joiners)}.</p>
${buttonForm(ctx, 'automod', 'lockdown-end', tr.t('automod.lockdown.end'), {}, { confirm: tr.t('automod.lockdown.endConfirm'), canEdit: canAct })}
${canAct ? '' : html`<p class="muted">${tr.t('automod.lockdown.needsAdmin')}</p>`}
<p><a href="${path('/incidents')}">${tr.t('automod.lockdown.follow')}</a></p>`
                : html`<p class="muted">${tr.tx('automod.lockdown.none', { timeline })}</p>`;
        const reviews = data.reviews;
        const reviewCard = tr.t('automod.queue.card');
        const queue = reviews === null
            ? html`<p class="error" role="alert">${tr.t('automod.queue.unreadable')}</p>`
            : html`${table([tr.t('automod.queue.colCard'), tr.t('automod.queue.colSince'), tr.t('automod.queue.colMessages')], reviews.slice(0, QUEUE_LISTED).map((item) => [
                isDiscordUrl(item.url) ? html`<a href="${item.url}" rel="noopener noreferrer" target="_blank">${item.title || reviewCard}</a>` : (item.title || reviewCard),
                item.at ? timeTag(new Date(item.at)) : '-',
                item.count || 1,
            ]), tr.t('automod.queue.empty'))}
${reviews.length > QUEUE_LISTED ? html`<p class="muted">${tr.t('automod.queue.more', { count: tr.fmtNumber(reviews.length - QUEUE_LISTED) })}</p>` : ''}
<p class="muted">${tr.t('automod.queue.help')}</p>`;
        const probations = data.probations;
        const probation = probations === null
            ? html`<p class="error" role="alert">${tr.t('automod.probation.unreadable')}</p>`
            : table([tr.t('automod.probation.colMember'), tr.t('automod.probation.colUntil'), tr.t('automod.probation.colBan'), ''], probations.map((p) => [
                html`<a href="${path(`/users/${encodeURIComponent(p.userId)}`)}">${memberName(g, p.userId) || p.userId}</a> <span class="muted">${p.userId}</span>`,
                tr.fmtDateTime(new Date(Number(p.until))),
                p.caseCode ? html`<a href="${path(`/cases/${encodeURIComponent(p.caseCode)}`)}"><code>${p.caseCode}</code></a>${p.how ? ` (${p.how})` : ''}` : '-',
                buttonForm(ctx, 'automod', 'probation-end', tr.t('automod.probation.end'), { user: p.userId }, { confirm: tr.t('automod.probation.endConfirm'), canEdit: canAct }),
            ]), tr.t('automod.probation.empty'));
        // v6: cards grouped by topic (common.js topic/section). Keys: the slugs of the English titles.
        const lockdownCard = section(tr.t('automod.lockdown.title'), lockdownBody, tr.t('automod.lockdown.help'), { key: 'raid-lockdown', size: 'full' });
        // Beginner audit 2.2: no channel for review cards; Report only explained, and after 24 h the nudge.
        const noChannel = s.enabled && !reviewChannelOf(ctx)
            ? html`<p class="warn" role="alert">${tr.t('automod.notice.noReviewChannel')}</p>` : '';
        const monitorNote = s.enabled && s.mode === 'monitor'
            ? html`<p class="muted">${tr.t('automod.notice.monitor')}</p>${shouldNudgeToEnforce(s)
                ? html`<p><strong>${tr.t('automod.notice.nudge')}</strong> ${buttonForm(ctx, 'automod', 'mode', tr.t('automod.notice.switchOn'), { mode: 'enforce' }, { canEdit: ctx.canEdit && ctx.canAct })}</p>` : ''}`
            : '';
        const notices = noChannel || monitorNote ? section(tr.t('automod.notice.title'), html`${noChannel}${monitorNote}`, '', { key: 'automod-notices', size: 'full' }) : '';
        const live = topic(tr.t('automod.topics.now'), tr.t('automod.topics.nowLine'), html`${notices}${lockdown?.active ? lockdownCard : ''}
${section(reviews ? tr.t('automod.queue.titleCount', { count: tr.fmtNumber(reviews.length) }) : tr.t('automod.queue.title'), queue, '', { key: 'review-queue' })}
${section(probations ? tr.t('automod.probation.titleCount', { count: tr.fmtNumber(probations.length) }) : tr.t('automod.probation.title'), probation, tr.t('automod.probation.help'), { key: 'probation' })}`, { key: 'right-now' });
        const ruleCards = topic(tr.t('automod.topics.rules'), tr.t('automod.topics.rulesLine'), html`${section(tr.t('automod.global.title'), top, tr.t('automod.global.help'), { key: 'global-mode' })}
${section(tr.t('automod.channels.title'), channels, tr.t('automod.channels.help'), { key: 'channels-and-words' })}
${section(tr.t('automod.rules.title'), rules, tr.t('automod.rules.help'), { key: 'rule-modes', size: 'full' })}
${section(tr.t('automod.custom.title'), customRulesSection(ctx, data), tr.t('automod.custom.help'), { key: 'custom-rules', size: 'full' })}
${section(tr.t('automod.native.title'), native, tr.t('automod.native.help'), { key: 'discord-automod', size: 'full' })}`, { key: 'rules' });
        // Small switch cards side by side, then the two forms side by side, then the list.
        const leniency = topic(tr.t('automod.topics.leniency'), tr.t('automod.topics.leniencyLine'), html`${section(tr.t('automod.secondChance.title'), secondChance, tr.t('automod.secondChance.help'), { key: 'friendly-notice-for-a-first-small-offence' })}
${section(tr.t('automod.mood.title'), mood, tr.t('automod.mood.help'), { key: 'mood' })}
${section(tr.t('automod.trusted.title'), trusted, tr.t('automod.trusted.help'), { key: 'trusted-members' })}
${section(tr.t('automod.immune.title'), immuneSection(ctx, s), tr.t('automod.immune.help'), { key: 'immune-members' })}
${section(tr.t('automod.exceptions.title'), exceptions, tr.t('automod.exceptions.help'), { key: 'channel-exceptions' })}
${section(tr.t('automod.exempt.title'), exempt, tr.t('automod.exempt.help'), { key: 'ignored-channels' })}`, { key: 'exceptions-and-leniency' });
        const raids = topic(tr.t('automod.topics.raids'), tr.t('automod.topics.raidsLine'), html`${section(tr.t('automod.gate.title'), joinGate, tr.t('automod.gate.help'), { key: 'join-gate' })}
${section(tr.t('automod.panic.title'), panic, tr.t('automod.panic.help'), { key: 'panic' })}
${lockdown?.active ? '' : lockdownCard}`, { key: 'raids-and-new-members' });
        const results = topic(tr.t('automod.topics.results'), tr.t('automod.topics.resultsLine'), html`${section(lastDays(tr, days), stats, '', { key: 'automod-stats', size: 'full' })}
${section(tr.t('automod.testRun.title'), testRunSection(ctx, data.backtest, data), tr.t('automod.testRun.help'), { key: 'test-run', size: 'full' })}`, { key: 'results' });
        return html`${live}${ruleCards}${leniency}${raids}${results}`;
    },

    // Safety module: every action needs Administrator (serverScope.js adminOnlyActions).
    actions: adminOnlyActions({
        // Turning automod on: any editor. Turning it off is a safety change: Administrator, and while
        // the staff guard is on only the server owner (turning automod off also stops the guard),
        // the same rule as /automod enable (commands/Enforcement/automod.js).
        async enabled(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('frame.nav.items.automod'));
            if (!enabled) {
                requireCanAct(ctx, tr.t('automod.error.offNeedsAdmin'));
                if (!isLegacyAutomodGuild(ctx.guildId) && ctx.actor?.userId !== ctx.guild?.ownerId) {
                    const settings = await ctx.services.getAutomodSettings(ctx.guildId);
                    if (settings?.staffGuard) throw new InputError(tr.t('automod.error.staffGuardOwnerOnly'), 403);
                }
            }
            // Review cards need a channel (review, else the mod log): refuse to turn on without one.
            if (enabled && !reviewChannelOf(ctx)) throw new InputError(tr.t('automod.error.needReviewChannel'), 400);
            let startedInMonitor = false;
            const result = await change(ctx, ['enabled', 'mode'], async () => {
                const saved = await ctx.services.setAutomodEnabled(ctx.guildId, enabled);
                startedInMonitor = Boolean(saved?.startedInMonitor);
                return saved;
            }, tr.t(enabled ? 'automod.action.automodOn' : 'automod.action.automodOff'));
            // First time on in another server: it starts in Report only (automodSettings.setAutomodEnabled).
            if (startedInMonitor) result.message = `${result.message} ${tr.t('automod.action.startedMonitor')}`;
            return result;
        },
        async mode(ctx, form) {
            const tr = textFor(ctx);
            const mode = choiceField(form, 'mode', ['enforce', 'monitor'], tr.t('automod.common.mode'));
            return change(ctx, ['mode'], () => ctx.services.setAutomodMode(ctx.guildId, mode), tr.t(mode === 'monitor' ? 'automod.action.modeMonitor' : 'automod.action.modeEnforce'));
        },
        async rules(ctx, form) {
            const tr = textFor(ctx);
            const before = await ctx.services.getAutomodSettings(ctx.guildId);
            const wanted = {};
            for (const key of Object.keys(AUTOMOD_RULES)) {
                const value = text(form, `rule:${key}`, 20) || 'default';
                if (value !== 'default' && !RULE_MODES.includes(value)) throw new InputError(tr.t('automod.error.unknownMode', { rule: ruleName(tr, key) }));
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
            return { changes, message: tr.t(changes.length ? 'automod.action.rulesSaved' : 'errors.nothingChanged') };
        },
        // A one-click fix on the test run result: one rule to watch only, off, or on (default).
        // The rule key and mode are checked here again, never taken from the stored result.
        async 'test-run-rule'(ctx, form) {
            const tr = textFor(ctx);
            const rule = choiceField(form, 'rule', Object.keys(AUTOMOD_RULES), tr.t('automod.common.rule'));
            const mode = choiceField(form, 'mode', Object.keys(QUICK_MODES), tr.t('automod.common.mode'));
            const before = await ctx.services.getAutomodSettings(ctx.guildId);
            const wanted = (before.ruleModes[rule] || 'default') === mode ? {} : { [rule]: mode };
            const after = await saveRuleModes(ctx, before, wanted);
            const changes = diffSnapshots(before.ruleModes, after.ruleModes, null, 'ruleModes.');
            const label = ruleName(tr, rule);
            const message = mode === 'default' ? tr.t('automod.action.quickOn', { rule: label })
                : mode === 'monitor' ? tr.t('automod.action.quickMonitor', { rule: label }) : tr.t('automod.action.quickOff', { rule: label });
            return { changes, message: changes.length ? message : tr.t('errors.nothingChanged') };
        },
        async 'custom-add'(ctx, form) {
            const tr = textFor(ctx);
            const planId = planOfGuild(ctx);
            const limit = limitForPlan(planId);
            const rule = {
                name: text(form, 'name', CUSTOM_RULE_NAME_MAX + 20),
                action: text(form, 'action', 10),
                muteDuration: text(form, 'muteDuration', 20),
                words: String(form?.words ?? '').slice(0, 5000),
                enabled: true,
            };
            const name = rule.name.replace(/\s+/g, ' ').trim();
            return saveCustomRules(ctx, (list) => {
                // The plan limit counts the locked list, so two adds at once cannot pass it.
                if (list.length >= limit) {
                    const plan = planId === 'free' ? 'Free' : planName(planId);
                    throw new InputError(limit
                        ? tr.tp('automod.error.customAtLimit', list.length, { plan })
                        : tr.t('automod.error.customNoPlan'));
                }
                return [...list, rule];
            }, tr.t('automod.action.customAddedName', { name }));
        },
        async 'custom-edit'(ctx, form) {
            const tr = textFor(ctx);
            const id = text(form, 'id', 20);
            let name = '';
            return saveCustomRules(ctx, (list) => {
                name = ruleIn(ctx, list, id).name;
                try {
                    return editRule(list, id, {
                        words: String(form?.words ?? '').slice(0, 5000),
                        action: text(form, 'action', 10),
                        muteDuration: text(form, 'muteDuration', 20),
                    }).list;
                } catch (error) {
                    throw new InputError(error.userMessage || tr.t('automod.custom.invalid'));
                }
            }, () => tr.t('automod.action.customSaved', { name }));
        },
        async 'custom-toggle'(ctx, form) {
            const tr = textFor(ctx);
            const id = text(form, 'id', 20);
            const enabled = boolField(form, 'enabled', tr.t('automod.custom.ruleLabel'));
            let name = '';
            return saveCustomRules(ctx, (list) => {
                const rule = ruleIn(ctx, list, id);
                name = rule.name;
                if ((rule.enabled !== false) === enabled) return null;
                return list.map((r) => (r.id === id ? { ...r, enabled } : r));
            }, () => tr.t(enabled ? 'automod.action.customOn' : 'automod.action.customOff', { name }));
        },
        async 'custom-remove'(ctx, form) {
            const tr = textFor(ctx);
            const id = text(form, 'id', 20);
            let name = '';
            return saveCustomRules(ctx, (list) => {
                name = ruleIn(ctx, list, id).name;
                return list.filter((r) => r.id !== id);
            }, () => tr.t('automod.action.customRemoved', { name }));
        },
        async 'channel-add'(ctx, form) {
            const tr = textFor(ctx);
            const channelId = channelField(ctx.guild, form, 'channel', { kinds: ['text', 'category'], optional: false, label: tr.t('automod.exceptions.channel') });
            const rule = choiceField(form, 'rule', Object.keys(AUTOMOD_RULES), tr.t('automod.common.rule'));
            const mode = choiceField(form, 'mode', CHANNEL_RULE_MODES, tr.t('automod.common.mode'));
            return change(ctx, ['channelRules'], () => ctx.services.setChannelRuleMode(ctx.guildId, channelId, rule, mode), tr.t('automod.action.exceptionSaved'));
        },
        async 'channel-remove'(ctx, form) {
            const tr = textFor(ctx);
            const channelId = text(form, 'channel', 25);
            const rule = choiceField(form, 'rule', Object.keys(AUTOMOD_RULES), tr.t('automod.common.rule'));
            if (!/^\d{17,20}$/.test(channelId)) throw new InputError(tr.t('forms.error.notChannelId', { label: tr.t('automod.exempt.channel') }));
            return change(ctx, ['channelRules'], () => ctx.services.setChannelRuleMode(ctx.guildId, channelId, rule, 'default'), tr.t('automod.action.exceptionRemoved'));
        },
        async 'exempt-add'(ctx, form) {
            const tr = textFor(ctx);
            const channelId = channelField(ctx.guild, form, 'channel', { kinds: ['text', 'category'], optional: false, label: tr.t('automod.exempt.ignore') });
            return change(ctx, ['exemptChannelIds'], () => ctx.services.setExemptChannel(ctx.guildId, channelId, true), tr.t('automod.action.exemptAdded'));
        },
        async 'exempt-remove'(ctx, form) {
            const tr = textFor(ctx);
            const channelId = text(form, 'channel', 25);
            if (!/^\d{17,20}$/.test(channelId)) throw new InputError(tr.t('forms.error.notChannelId', { label: tr.t('automod.exempt.channel') }));
            return change(ctx, ['exemptChannelIds'], () => ctx.services.setExemptChannel(ctx.guildId, channelId, false), tr.t('automod.action.exemptRemoved'));
        },
        // Administrator only: trusted members skip automod (a safety setting).
        trusted: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const roleId = roleField(ctx.guild, form, 'roleId', { label: tr.t('automod.trusted.role') });
                if (roleId) {
                    const problem = ctx.services.getTrustedRoleProblem(ctx.guild, ctx.guild.roles.cache.get(roleId));
                    if (problem) throw new InputError(plainText(problem));
                }
                const minLevel = intField(form, 'minLevel', { min: 0, max: 1000, label: tr.t('automod.trusted.minLevel'), fallback: 0 });
                const clear = !roleId && minLevel === 0;
                return change(ctx, ['trusted'], () => ctx.services.setTrusted(ctx.guildId, clear ? { clear: true } : { roleId, minLevel }), tr.t('automod.action.trustedSaved'));
            },
        },
        async 'second-chance'(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('automod.secondChance.title'));
            return change(ctx, ['secondChance'], () => ctx.services.setSecondChance(ctx.guildId, enabled), tr.t(enabled ? 'automod.action.secondChanceOn' : 'automod.action.secondChanceOff'));
        },
        async mood(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('automod.mood.alerts'));
            return change(ctx, ['moodAlerts'], () => ctx.services.setMoodAlerts(ctx.guildId, enabled), tr.t(enabled ? 'automod.action.moodOn' : 'automod.action.moodOff'));
        },
        async panic(ctx, form) {
            const tr = textFor(ctx);
            const enabled = checkbox(form, 'enabled');
            const hours = intField(form, 'hours', { min: 1, max: 24, label: tr.t('automod.panic.hours') });
            const result = await change(ctx, ['panic'], () => ctx.services.setPanic(ctx.guildId, { enabled, hours }), tr.t(enabled ? 'automod.action.panicOn' : 'automod.action.panicOff'));
            const canPause = ctx.guild?.members?.me?.permissions?.has?.('ManageGuild');
            if (enabled && canPause === false) result.warnings = [tr.t('automod.action.panicNoPerm')];
            return result;
        },
        async 'join-gate'(ctx, form) {
            const tr = textFor(ctx);
            const before = await ctx.services.getAutomodSettings(ctx.guildId);
            const gate = normalizeJoinGate(before.joinGate);
            const ageDays = intField(form, 'ageDays', { min: 1, max: 365, label: tr.t('automod.gate.ageDays') });
            let after = before;
            for (const check of Object.keys(JOIN_GATE_CHECKS)) {
                const action = choiceField(form, `gate:${check}`, JOIN_GATE_ACTIONS, gateCheckName(tr, check));
                const days = check === 'age' && ageDays !== gate.ageDays ? ageDays : null;
                if (action !== gate[check] || days) after = await ctx.services.setJoinGateCheck(ctx.guildId, check, action, days);
            }
            const changes = diffSnapshots(normalizeJoinGate(before.joinGate), normalizeJoinGate(after.joinGate), null, 'joinGate.');
            return { changes, message: tr.t(changes.length ? 'automod.action.gateSaved' : 'errors.nothingChanged') };
        },
        async native(ctx, form) {
            const tr = textFor(ctx);
            const ruleId = text(form, 'ruleId', 25);
            if (!/^\d{17,20}$/.test(ruleId)) throw new InputError(tr.t('automod.error.pickNative'));
            const policy = choiceField(form, 'policy', NATIVE_POLICIES, tr.t('automod.native.policyLabel'));
            const dedupeMinutes = intField(form, 'dedupeMinutes', { min: 1, max: 1440, label: tr.t('automod.native.dedupe'), fallback: null });
            const rule = await ctx.guild?.autoModerationRules?.fetch?.(ruleId).catch(() => null);
            if (!rule) throw new InputError(tr.t('automod.error.nativeGone'));
            const before = policyFor(await ctx.services.loadNativePolicies(ctx.guildId), ruleId);
            await ctx.services.setNativePolicy(ctx.guildId, ruleId, policy, dedupeMinutes, ctx.actor.userId);
            const after = policyFor(await ctx.services.loadNativePolicies(ctx.guildId), ruleId);
            const changes = diffSnapshots(before, after, null, `native.${ruleId}.`);
            return { changes, message: changes.length ? tr.t('automod.action.nativeSaved', { name: rule.name }) : tr.t('errors.nothingChanged') };
        },
        // /automod lockdown-end: restores the verification level, resumes invites and DMs, posts the incident report.
        'lockdown-end': {
            admin: true,
            async run(ctx) {
                const tr = textFor(ctx);
                const state = await ctx.services.getLockdownState(ctx.guildId);
                if (!state?.active) throw new InputError(tr.t('automod.error.noLockdown'));
                const ended = await ctx.services.endLockdown(ctx.guild, { id: ctx.actor.userId, username: ctx.actor.username });
                if (!ended) throw new InputError(tr.t('automod.error.noLockdown'));
                return {
                    changes: [{ key: 'lockdown', old: { active: true, startedAt: state.startedAt || null, joiners: (state.joinerIds || []).length }, new: null }],
                    message: tr.t('automod.action.lockdownEnded'),
                };
            },
        },
        // /automod extrawatch user end:true
        'probation-end': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const userId = userIdField(form, 'user', tr.t('automod.probation.colMember'));
                const record = await ctx.services.endProbation(ctx.guildId, userId);
                if (!record) throw new InputError(tr.t('automod.error.noProbation'));
                return {
                    changes: [{ key: `probation:${userId}`, old: { until: new Date(Number(record.until)).toISOString(), caseCode: record.caseCode || null }, new: null }],
                    message: tr.t('automod.action.probationEnded', { member: memberName(ctx.guild, userId) || userId }),
                };
            },
        },
        // Test run: read-only, so nothing is audited (changes: []); Administrator only.
        'test-run': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const picked = list(form, 'channels', { max: 100 });
                if (!picked.length) throw new InputError(tr.t('automod.error.pickChannel'), 400, 'channels');
                if (picked.length > BACKTEST_MAX_CHANNELS) throw new InputError(tr.t('automod.error.tooManyChannels', { max: tr.fmtNumber(BACKTEST_MAX_CHANNELS), picked: tr.fmtNumber(picked.length) }), 400, 'channels');
                const channelIds = channelListField(ctx.guild, form, 'channels', { kinds: ['text'], label: tr.t('automod.exempt.channel'), max: BACKTEST_MAX_CHANNELS });
                const days = Number(choiceField(form, 'days', BACKTEST_DAY_CHOICES.map(String), tr.t('automod.testRun.howFarBack')));
                const draftName = text(form, 'draftName', CUSTOM_RULE_NAME_MAX + 20);
                const draftWords = String(form?.draftWords ?? '').slice(0, 5000);
                const settings = await ctx.services.getAutomodSettings(ctx.guildId);
                // Automod checks nothing in ignored channels (automodSettings.isChannelExempt).
                const ignored = new Set([...(settings.exemptChannelIds || []), ...(registryValue(ctx, 'exemptChannelIds') || [])]);
                const skipped = channelIds.find((id) => ignored.has(id));
                if (skipped) throw new InputError(tr.t('automod.error.ignoredChannel', { channel: ctx.guild.channels.cache.get(skipped)?.name || skipped }), 400, 'channels');
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
                return { changes: [], message: tr.t('automod.action.testRunStarted') };
            },
        },
        async channels(ctx, form) {
            const tr = textFor(ctx);
            const g = ctx.guild;
            const words = [...new Set(String(form?.extraBlockedWords ?? '').split(/[\n,]/).map((w) => w.trim().toLowerCase()).filter(Boolean))];
            // A channel absent from the form stays unchanged (Setup step by step sends only one).
            const patch = changedOnly({
                ...(form?.reviewChannelId !== undefined ? { reviewChannelId: channelField(g, form, 'reviewChannelId', { label: tr.t('automod.channels.review') }) } : {}),
                ...(form?.alertsChannelId !== undefined ? { alertsChannelId: channelField(g, form, 'alertsChannelId', { label: tr.t('automod.channels.alerts') }) } : {}),
                extraBlockedWords: typeof form?.extraBlockedWords === 'string' ? words : registryValue(ctx, 'extraBlockedWords'),
            }, {
                reviewChannelId: registryValue(ctx, 'reviewChannelId'),
                alertsChannelId: registryValue(ctx, 'alertsChannelId'),
                extraBlockedWords: registryValue(ctx, 'extraBlockedWords'),
            });
            if (!Object.keys(patch).length) return nothing(tr);
            return saveRegistry(ctx, patch, 'automod');
        },
        // Administrator (like every automod action) and the server owner or OWNER_IDS (checked inside).
        ...immuneActions,
    }),
};
