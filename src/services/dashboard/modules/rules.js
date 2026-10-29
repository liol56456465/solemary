// rules.js — Rules: the main server's rules (an ordered list, max 30: short title + text),
// shown on the public /rules page, and which prebuilt reason links to which rule. A case
// with a linked reason gets "Rule 3: No spam" (+ the /rules link when PUBLIC_URL is set)
// in the member's punishment DM (dmTemplates.js via services/rules/serverRules.js).
//
// Stored as two registry settings in guild_settings (serverRules, reasonRuleLinks), so the
// settings service validates them, writes under a row lock and writes the audit rows; the
// mod-log line names the rule that changed. Rules keep a stable id: moving or deleting one
// never re-points a reason link (a link to a deleted rule is removed with it).

import { ENFORCEMENT_REASONS } from '../../../config/enforcement.js';
import { formatDate, html } from '../html.js';
import { InputError, buttonForm, choiceField, postForm, selectInput, text, textArea, textInput } from '../forms.js';
import { NOTHING, registryValue, saveRegistry, section, table } from './common.js';
import {
    RULES_LIMITS, addRule, deleteRule, editRule, moveRule, numberedRules, pruneLinks,
} from '../../rules/serverRules.js';
import { siteOrigin } from '../../site/shell.js';

const { maxRules, titleMax, textMax } = RULES_LIMITS;
const RULE_ID = /^[a-z0-9]{4,16}$/;

const clip = (value, max = 120) => {
    const t = String(value ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// One change at a time: each action reads the list, changes it and writes it back.
let queue = Promise.resolve();
function serialized(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

function current(ctx) {
    return { value: registryValue(ctx, 'serverRules'), links: registryValue(ctx, 'reasonRuleLinks') || {} };
}

/** Title (required, one line, ≤ 80) and text (≤ 1000, line breaks kept). Never cut silently. */
function ruleFields(form) {
    const title = text(form, 'title', titleMax);
    if (!title) throw new InputError('A rule needs a title.', 400, 'title');
    if (/[\r\n]/.test(title)) throw new InputError('The title must be one line.', 400, 'title');
    const raw = typeof form?.text === 'string' ? form.text.replace(/\r\n?/g, '\n').trim() : '';
    if (raw.length > textMax) throw new InputError(`Rule text is too long: at most ${textMax} characters (${raw.length} entered).`, 400, 'text');
    return { title, text: raw };
}

/** The posted rule id, which must be a rule that exists now. */
function existingRule(ctx, form) {
    const id = text(form, 'id', 16);
    const { rules } = numberedRules(current(ctx).value);
    const rule = RULE_ID.test(id) ? rules.find((r) => r.id === id) : null;
    if (!rule) throw new InputError('That rule no longer exists. Reload the page.');
    return rule;
}

function ruleText(rule) {
    return rule ? `${rule.title}${rule.text ? ` — ${clip(rule.text, 200)}` : ''}` : null;
}

export default {
    key: 'rules',
    label: 'Rules',
    help: 'The server rules members see on the website, and which reasons point to which rule. A punishment DM for a linked reason names the rule and links to it.',

    async load(ctx) {
        const { value, links } = current(ctx);
        return { ...numberedRules(value), links, origin: siteOrigin(ctx.env || process.env) };
    },

    render(ctx, d) {
        const last = d.rules.length - 1;
        const rows = d.rules.map((rule, i) => [
            html`<span class="num">${rule.number}</span>`,
            html`<strong>${rule.title}</strong>${rule.text ? html`<br><span class="muted">${clip(rule.text)}</span>` : ''}`,
            html`<div class="row-actions">${i > 0 ? buttonForm(ctx, 'rules', 'rule-move', 'Move up', { id: rule.id, direction: 'up' }) : ''}${i < last ? buttonForm(ctx, 'rules', 'rule-move', 'Move down', { id: rule.id, direction: 'down' }) : ''}${buttonForm(ctx, 'rules', 'rule-delete', 'Delete', { id: rule.id }, { confirm: `Delete rule ${rule.number} ("${clip(rule.title, 60)}")? Rules after it move up one number, and reasons linked to it are unlinked.` })}</div>`,
        ]);
        const edits = d.rules.map((rule) => html`<details class="sub" data-key="rule-${rule.id}"><summary>Edit rule ${rule.number}: ${clip(rule.title, 60)}</summary>
${postForm(ctx, 'rules', 'rule-edit', html`<div class="grid">
${textInput('title', rule.title, { label: 'Title', max: titleMax })}
${textArea('text', rule.text, { label: 'Text', max: textMax, rows: 4, help: 'Optional. Line breaks are kept on the website.' })}</div>`, { submit: 'Save rule', hidden: { id: rule.id } })}</details>`);
        const full = d.rules.length >= maxRules;
        const add = full
            ? html`<p class="muted">The server has ${maxRules} rules, the most there can be. Delete one to add another.</p>`
            : postForm(ctx, 'rules', 'rule-add', html`<div class="grid">
${textInput('title', '', { label: 'Title', max: titleMax, placeholder: 'No spam' })}
${textArea('text', '', { label: 'Text', max: textMax, rows: 4, help: 'Optional. Line breaks are kept on the website.' })}</div>`, { submit: 'Add rule', inline: false });
        const choices = [['', 'No rule'], ...d.rules.map((r) => [r.id, `Rule ${r.number}: ${clip(r.title, 60)}`])];
        const links = d.rules.length
            ? postForm(ctx, 'rules', 'links', html`<div class="grid">${ENFORCEMENT_REASONS.map((reason) => selectInput(`link_${reason.key}`, d.links[reason.key] || '', choices, { label: reason.label }))}</div>`)
            : html`<p class="muted">Add a rule first; then each reason can point to one.</p>`;
        const updated = d.updatedAt ? html` Last changed ${formatDate(d.updatedAt)}.` : '';
        const page = d.origin
            ? html` Members see them at <a href="${`${d.origin}/rules`}" rel="noopener">${d.origin}/rules</a>.`
            : ' Members see them at /rules on the website. PUBLIC_URL is not set, so DMs name the rule without a link.';
        return html`${section('Rules', html`${table(['No.', 'Rule', ''], rows, 'No rules yet. The website says the server has not published its rules.')}${edits}`,
            html`${d.rules.length} of ${maxRules}. Numbers follow the order.${updated}${page}`)}
${section('Add a rule', add)}
${section('Reasons linked to rules', links, 'For the prebuilt reasons of /enforcements. A punishment with a linked reason names the rule in the member\'s DM ("Rule 3: No spam") with a link to it. Custom reasons never get a rule line.')}`;
    },

    actions: {
        'rule-add'(ctx, form) {
            const fields = ruleFields(form);
            return serialized(async () => {
                const { value } = current(ctx);
                const next = addRule(value, fields);
                if (!next) throw new InputError(`The server already has ${maxRules} rules. Delete one first.`);
                await saveRegistry(ctx, { serverRules: next }, 'rules');
                const number = next.rules.length;
                return { changes: [{ key: `rule ${number}`, old: null, new: ruleText(fields) }], audited: true, message: `Rule ${number} added.` };
            });
        },
        'rule-edit'(ctx, form) {
            const fields = ruleFields(form);
            return serialized(async () => {
                const rule = existingRule(ctx, form);
                if (rule.title === fields.title && rule.text === fields.text) return NOTHING;
                await saveRegistry(ctx, { serverRules: editRule(current(ctx).value, rule.id, fields) }, 'rules');
                return { changes: [{ key: `rule ${rule.number}`, old: ruleText(rule), new: ruleText(fields) }], audited: true, message: `Rule ${rule.number} saved.` };
            });
        },
        'rule-delete'(ctx, form) {
            return serialized(async () => {
                const rule = existingRule(ctx, form);
                const { value, links } = current(ctx);
                const next = deleteRule(value, rule.id);
                const pruned = pruneLinks(links, next);
                const patch = { serverRules: next };
                if (Object.keys(pruned).length !== Object.keys(links).length) patch.reasonRuleLinks = pruned;
                await saveRegistry(ctx, patch, 'rules');
                return { changes: [{ key: `rule ${rule.number}`, old: ruleText(rule), new: null }], audited: true, message: `Rule ${rule.number} deleted.` };
            });
        },
        'rule-move'(ctx, form) {
            const direction = choiceField(form, 'direction', ['up', 'down'], 'Direction');
            return serialized(async () => {
                const rule = existingRule(ctx, form);
                const next = moveRule(current(ctx).value, rule.id, direction === 'up' ? -1 : 1);
                if (!next) throw new InputError(`Rule ${rule.number} is already the ${direction === 'up' ? 'first' : 'last'} one.`);
                await saveRegistry(ctx, { serverRules: next }, 'rules');
                const to = rule.number + (direction === 'up' ? -1 : 1);
                return { changes: [{ key: `rule ${rule.number}`, old: `rule ${rule.number}: ${rule.title}`, new: `rule ${to}: ${rule.title}` }], audited: true, message: `"${clip(rule.title, 60)}" is now rule ${to}.` };
            });
        },
        links(ctx, form) {
            return serialized(async () => {
                const { value, links } = current(ctx);
                const { rules } = numberedRules(value);
                const byId = new Map(rules.map((r) => [r.id, r]));
                const next = {};
                for (const reason of ENFORCEMENT_REASONS) {
                    const id = text(form, `link_${reason.key}`, 16);
                    if (!id) continue;
                    if (!byId.has(id)) throw new InputError(`${reason.label}: that rule no longer exists. Reload the page.`, 400, `link_${reason.key}`);
                    next[reason.key] = id;
                }
                const label = (id) => (id && byId.get(id) ? `rule ${byId.get(id).number}: ${byId.get(id).title}` : null);
                const changes = ENFORCEMENT_REASONS
                    .filter((reason) => (links[reason.key] || null) !== (next[reason.key] || null))
                    .map((reason) => ({ key: `reason ${reason.key}`, old: label(links[reason.key]), new: label(next[reason.key]) }));
                if (!changes.length) return NOTHING;
                await saveRegistry(ctx, { reasonRuleLinks: next }, 'rules');
                return { changes, audited: true, message: 'Reason links saved.' };
            });
        },
    },
};
