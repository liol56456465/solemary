// memberToolsPages.js — the Members area's Role rules and Insights pages (and the tab row the
// three Members pages share). Pure: data in, HTML out, everything escaped by `html`. No inline
// styles or scripts (CSP): the chart is SVG with presentation attributes and CSS classes that
// take the theme's chart colours (--c-* in dashboard.css).
// Text: src/content/dashboard/<lang>/memberTools.json (docs/dashboard-i18n.md).

import { html, layout, path, raw } from './html.js';
import { actionForm, memberTabs } from './enforcementPages.js';
import { currentText, dashboardText } from './language.js';
import { MAX_DAYS, MAX_LEVEL, MAX_RULES, NAME_MAX, RULE_TRIGGERS, RUN_CHANGE_LIMIT, describeRule } from '../members/roleRuleService.js';
import { CHART_DAYS, INACTIVE_DAYS, OFFENDER_DAYS, RETENTION_DAYS } from '../members/memberInsightsService.js';

const userHref = (id) => path(`/users/${encodeURIComponent(id)}`);
export const PREVIEW_NAMES = 50;

/** A plural text node (tx keeps the catalog's quotes; SafeHtml params as markup): base.one / .few / .other … */
function pluralTx(tr, base, count, params = {}) {
    const zero = Number(count) === 0 && tr.has(`${base}.zero`);
    const category = zero ? 'zero' : new Intl.PluralRules(tr.lang).select(Number(count));
    return tr.tx(tr.has(`${base}.${category}`) ? `${base}.${category}` : `${base}.other`, params);
}

/** A trigger's word: English keeps roleRuleService's label; other languages memberTools.trigger.*. */
function triggerLabel(tr, key) {
    const k = `memberTools.trigger.${key}`;
    return tr.lang !== 'en' && tr.has(k) ? tr.t(k) : RULE_TRIGGERS[key];
}

function notices({ flash = null, error = null, editEnabled = true, canAct = true }, tr = currentText()) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">${tr.t('memberTools.notice.readOnly')}</p>`
        : !canAct ? html`<p class="notice">${tr.t('memberTools.notice.viewOnly')}</p>` : ''}`;
}

const opt = (value, label, current) => html`<option value="${value}"${String(value) === String(current ?? '') ? raw(' selected') : ''}>${label}</option>`;

// ── Role rules ───────────────────────────────────────────────────────────

/**
 * The rule form (new or edit). values: the rule's fields as form strings. givable: roles a rule
 * may give ([{ id, name }]); roles: every role for the trigger.
 */
function ruleForm(csrf, values, { givable, roles, enabled }, tr = currentText()) {
    const v = values || {};
    return actionForm(csrf, '/users/rules/preview', html`<div class="grid">
<label>${tr.t('memberTools.form.name')}<input name="name" value="${v.name || ''}" maxlength="${NAME_MAX}" required placeholder="${tr.t('memberTools.form.namePlaceholder')}"></label>
<label>${tr.t('memberTools.form.when')}<select name="trigger" required>${Object.keys(RULE_TRIGGERS).map((k) => opt(k, triggerLabel(tr, k), v.trigger || 'days_in_server'))}</select></label>
<label>${tr.t('memberTools.form.threshold')}<input type="number" name="threshold" value="${v.threshold ?? ''}" min="0" max="${Math.max(MAX_DAYS, MAX_LEVEL)}" step="1"><span class="hint">${tr.tx('memberTools.form.thresholdHint', { maxDays: tr.fmtNumber(MAX_DAYS), maxLevel: tr.fmtNumber(MAX_LEVEL) })}</span></label>
<label>${tr.t('memberTools.form.triggerRole')}<select name="triggerRoleId">${opt('', tr.t('memberTools.form.triggerRoleNone'), v.triggerRoleId)}${roles.map((r) => opt(r.id, `@${r.name}`, v.triggerRoleId))}</select></label>
<label>${tr.t('memberTools.form.give')}<select name="roleId" required>${opt('', tr.t('memberTools.form.choose'), v.roleId)}${givable.map((r) => opt(r.id, `@${r.name}`, v.roleId))}</select><span class="hint">${tr.t('memberTools.form.giveHint')}</span></label>
</div>
<label class="check"><input type="checkbox" name="removeWhenFalse" value="1"${v.removeWhenFalse ? raw(' checked') : ''}> ${tr.t('memberTools.form.removeWhenFalse')}</label>
<p class="muted">${tr.t('memberTools.form.removeHelp')}</p>
<label class="check"><input type="checkbox" name="enabled" value="1"${v.enabled ?? true ? raw(' checked') : ''}> ${tr.t('memberTools.form.enabled')}</label>
${v.id ? html`<input type="hidden" name="id" value="${v.id}">` : ''}
<p class="muted">${tr.t('memberTools.form.nothingYet')}</p>`, { submit: tr.t('memberTools.form.dryRun'), enabled });
}

/** A rule's fields as form values (for the edit form and the "Turn on…" button). */
export function ruleValues(rule) {
    return {
        id: rule.id, name: rule.name, trigger: rule.trigger, threshold: rule.threshold ?? '', triggerRoleId: rule.triggerRoleId || '',
        roleId: rule.roleId, removeWhenFalse: rule.removeWhenFalse ? '1' : '', enabled: '1',
    };
}

function ruleRow(rule, { csrf, canWrite, roleName, problem }, tr = currentText()) {
    const status = rule.enabled
        ? (problem ? html`<span class="state-word is-warn"><span class="dot dot-warn" aria-hidden="true"></span>${tr.t('memberTools.rules.onPaused')}</span>` : html`<span class="state-word is-on"><span class="dot dot-on" aria-hidden="true"></span>${tr.t('memberTools.rules.on')}</span>`)
        : html`<span class="muted">${tr.t('memberTools.rules.off')}</span>`;
    const last = rule.lastRunAt
        ? html`<small class="muted">${tr.t('memberTools.rules.lastRun', { date: tr.fmtDateTime(rule.lastRunAt), added: rule.lastAdded, removed: rule.lastRemoved })}${rule.lastFailed ? tr.t('memberTools.rules.lastFailed', { count: rule.lastFailed }) : ''}</small>`
        : html`<small class="muted">${tr.t('memberTools.rules.notRun')}</small>`;
    const hidden = Object.fromEntries(Object.entries(ruleValues(rule)).map(([k, value]) => [k, String(value)]));
    const actions = canWrite ? html`<div class="row-actions">
${rule.enabled ? actionForm(csrf, `/users/rules/${rule.id}/disable`, '', { submit: tr.t('memberTools.rules.turnOff'), inline: true, secondary: true })
        : actionForm(csrf, '/users/rules/preview', '', { submit: tr.t('memberTools.rules.turnOn'), inline: true, secondary: true, hidden })}
<a class="btn small" href="${path(`/users/rules?edit=${rule.id}`)}#s-rule-form">${tr.t('memberTools.rules.edit')}</a>
${actionForm(csrf, `/users/rules/${rule.id}/delete`, '', { submit: tr.t('memberTools.rules.delete'), inline: true, danger: true, confirm: tr.t('memberTools.rules.deleteConfirm', { name: rule.name }) })}</div>` : '';
    return html`<tr><td><b>${rule.name}</b><br><span>${describeRule(rule, roleName)}</span>${problem ? html`<br><span class="error-text">${problem}</span>` : ''}</td>
<td class="nowrap">${status}<br>${last}</td><td>${actions}</td></tr>`;
}

/**
 * The Role rules page. rules: from listRoleRules; problems: Map ruleId → why it cannot run now;
 * editing: the rule being edited (or null); values: form values to show again after an error.
 */
export function roleRulesPage({ session, access = null, moduleStates = {}, rules = [], problems = new Map(), roleName = (id) => id, givable = [], roles = [], canWrite = false, editEnabled = true, canAct = true, flash = null, error = null, editing = null, values = null, levelingOn = true, loadError = null }) {
    const tr = dashboardText(session?.lang);
    const csrf = session?.csrf;
    const formValues = values || (editing ? ruleValues(editing) : null);
    const table = rules.length ? html`<div class="table-wrap"><table class="rules"><thead><tr><th>${tr.t('memberTools.rules.rule')}</th><th>${tr.t('memberTools.rules.state')}</th><th></th></tr></thead><tbody>
${rules.map((rule) => ruleRow(rule, { csrf, canWrite, roleName, problem: problems.get(rule.id) || null }, tr))}</tbody></table></div>`
        : loadError ? '' : html`<p class="empty">${tr.t('memberTools.rules.none')}</p>`;
    const full = rules.length >= MAX_RULES && !editing;
    const body = html`<header class="page-head"><h1>${tr.t('memberTools.rules.title')}</h1><p class="muted">${tr.t('memberTools.rules.intro', { limit: tr.fmtNumber(RUN_CHANGE_LIMIT) })}</p></header>
${memberTabs('rules')}
${notices({ flash, error, editEnabled, canAct }, tr)}
${loadError ? html`<p class="error" role="alert">${loadError}</p>` : ''}
${!levelingOn && rules.some((r) => r.trigger === 'level_reached') ? html`<p class="notice">${tr.t('memberTools.rules.levelingOff')}</p>` : ''}
<section class="card"><h2>${tr.t('memberTools.rules.heading', { count: tr.fmtNumber(rules.length), max: tr.fmtNumber(MAX_RULES) })}</h2>${table}<p class="muted">${tr.t('memberTools.rules.keepRoles')}</p></section>
${canWrite && !loadError ? html`<details class="card section" id="s-rule-form" data-key="rule-form"${editing || values ? raw(' open') : ''}><summary><h2>${editing ? tr.t('memberTools.rules.editHeading', { name: editing.name }) : tr.t('memberTools.rules.newRule')}</h2></summary><div class="section-body">
${full ? html`<p class="notice">${tr.t('memberTools.rules.full', { max: tr.fmtNumber(MAX_RULES) })}</p>` : ruleForm(csrf, formValues, { givable, roles, enabled: true }, tr)}
${editing ? html`<p><a href="${path('/users/rules')}">${tr.t('memberTools.rules.cancelEdit')}</a></p>` : ''}</div></details>` : ''}`;
    return layout({ title: tr.t('memberTools.rules.title'), active: 'users', session, access, moduleStates, body });
}

/** Names for a dry-run list: the first PREVIEW_NAMES, then "and N more". */
function nameList(entries, tr = currentText()) {
    if (!entries.length) return html`<p class="empty">${tr.t('memberTools.preview.nobody')}</p>`;
    const shown = entries.slice(0, PREVIEW_NAMES);
    return html`<ul class="name-list">${shown.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a></li>`)}</ul>${entries.length > shown.length ? html`<p class="muted">${tr.t('memberTools.andMore', { count: tr.fmtNumber(entries.length - shown.length) })}</p>` : ''}`;
}

/**
 * The dry run of a rule before it is saved: how many and which members it would change now.
 * add / remove: [{ id, name }]. Save needs the one-time token.
 */
export function roleRulePreviewPage({ session, access = null, moduleStates = {}, rule, description, add = [], remove = [], token, hash, cached = null, memberCount = null }) {
    const tr = dashboardText(session?.lang);
    const n = add.length + remove.length;
    const body = html`<a class="back" href="${path('/users/rules')}">${tr.t('memberTools.preview.back')}</a>
<header class="page-head"><h1>${tr.t('memberTools.preview.title', { name: rule.name })}</h1><p class="muted">${description}</p></header>
<p class="notice">${rule.enabled
        ? pluralTx(tr, 'memberTools.preview.wouldChange', n, { count: html`<b>${tr.fmtNumber(n)}</b>`, add: tr.fmtNumber(add.length), remove: tr.fmtNumber(remove.length) })
        : tr.tp('memberTools.preview.savedOff', n)}</p>
${cached !== null && memberCount && cached < memberCount ? html`<p class="notice">${tr.t('memberTools.preview.partial', { cached: tr.fmtNumber(cached), total: tr.fmtNumber(memberCount) })}</p>` : ''}
<section class="card"><h2>${tr.t('memberTools.preview.gets', { count: tr.fmtNumber(add.length) })}</h2>${nameList(add, tr)}</section>
${rule.removeWhenFalse ? html`<section class="card"><h2>${tr.t('memberTools.preview.loses', { count: tr.fmtNumber(remove.length) })}</h2>${nameList(remove, tr)}</section>` : ''}
${actionForm(session.csrf, '/users/rules/save', html`<p class="muted">${rule.enabled ? tr.t('memberTools.preview.nextRun', { limit: tr.fmtNumber(RUN_CHANGE_LIMIT) }) : tr.t('memberTools.preview.savedOffShort')}</p>`,
        { submit: rule.id ? tr.t('memberTools.preview.saveChanges') : tr.t('memberTools.preview.saveRule'), hidden: { token, fh: hash } })}`;
    return layout({ title: tr.t('memberTools.preview.title', { name: rule.name }), active: 'users', session, access, moduleStates, body });
}

// ── Insights ─────────────────────────────────────────────────────────────

const W = 600;
const H = 160;
const PAD_L = 28;
const PAD_B = 20;
const PAD_T = 8;

/**
 * Joins and leaves per day as an SVG bar chart (two bars a day). Presentation attributes and
 * classes only; colours from the theme (.ins-join / .ins-leave in dashboard.css).
 */
export function joinsChart(days, tr = currentText()) {
    const max = Math.max(1, ...days.map((d) => Math.max(d.joins, d.leaves)));
    const plotW = W - PAD_L;
    const plotH = H - PAD_B - PAD_T;
    const slot = plotW / days.length;
    const bar = Math.max(1, Math.floor((slot - 2) / 2));
    const y = (n) => PAD_T + plotH - (n / max) * plotH;
    const totalJ = days.reduce((s, d) => s + d.joins, 0);
    const totalL = days.reduce((s, d) => s + d.leaves, 0);
    const ticks = [...new Set([0, Math.round(max / 2), max])];
    return html`<svg class="ins-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${tr.tp('memberTools.chart.label', days.length, { joins: tr.fmtNumber(totalJ), leaves: tr.fmtNumber(totalL) })}">
${ticks.map((t) => html`<line class="ins-grid" x1="${PAD_L}" x2="${W}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line><text class="ins-tick" x="${PAD_L - 4}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${t}</text>`)}
${days.map((d, i) => {
        const x = PAD_L + i * slot + 1;
        return html`<g><title>${tr.t('memberTools.chart.day', { day: d.day, joins: tr.fmtNumber(d.joins), leaves: tr.fmtNumber(d.leaves) })}</title>${d.joins ? html`<rect class="ins-join" x="${x.toFixed(1)}" y="${y(d.joins).toFixed(1)}" width="${bar}" height="${(PAD_T + plotH - y(d.joins)).toFixed(1)}"></rect>` : ''}${d.leaves ? html`<rect class="ins-leave" x="${(x + bar).toFixed(1)}" y="${y(d.leaves).toFixed(1)}" width="${bar}" height="${(PAD_T + plotH - y(d.leaves)).toFixed(1)}"></rect>` : ''}</g>`;
    })}
${days.map((d, i) => ((days.length - 1 - i) % 7 === 0 ? html`<text class="ins-tick" x="${(PAD_L + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${d.day.slice(5)}</text>` : ''))}
</svg>`;
}

function legend(tr = currentText()) {
    const swatch = (cls) => html`<svg class="ins-swatch" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect class="${cls}" width="12" height="12" rx="2"></rect></svg>`;
    return html`<p class="ins-legend">${swatch('ins-join')} ${tr.t('memberTools.chart.joined')} ${swatch('ins-leave')} ${tr.t('memberTools.chart.left')}</p>`;
}

function memberLink(row, extra) {
    return html`<li><a href="${userHref(row.id)}">${row.displayName}</a> <small class="muted">${row.username}${extra ? html` · ${extra}` : ''}</small></li>`;
}

const CASE_KINDS = [['warns', 'memberTools.insights.warns'], ['mutes', 'memberTools.insights.mutes'], ['kicks', 'memberTools.insights.kicks'], ['bans', 'memberTools.insights.bans']];

/**
 * The Insights page. Each part may be missing (null) with its own error, so one failing query
 * does not hide the rest. activity: { levelingOn, data } — data null when leveling is off.
 */
export function insightsPage({ session, access = null, moduleStates = {}, joins = null, joinsError = null, noRoles = null, offenders = null, offendersError = null, inactive = null, inactiveError = null, levelingOn = false, cached = null, memberCount = null }) {
    const tr = dashboardText(session?.lang);
    const n = (value) => tr.fmtNumber(value);
    const notLoaded = tr.t('memberTools.insights.notLoaded');
    const more = (total, shown) => (total > shown ? html`<p class="muted">${tr.t('memberTools.andMore', { count: n(total - shown) })}</p>` : '');
    const totalJ = joins ? joins.days.reduce((s, d) => s + d.joins, 0) : 0;
    const totalL = joins ? joins.days.reduce((s, d) => s + d.leaves, 0) : 0;
    const net = totalJ - totalL;
    const joinsCard = joins ? html`<section class="card"><h2>${tr.tp('memberTools.insights.joinsTitle', CHART_DAYS)}</h2>
<p class="muted">${tr.t('memberTools.insights.joinsSummary', { joined: n(totalJ), left: n(totalL), net: `${net >= 0 ? '+' : ''}${n(net)}` })} ${joins.since ? tr.t('memberTools.insights.countingSince', { date: tr.fmtDateTime(joins.since) }) : tr.t('memberTools.insights.nothingYet')} ${tr.tp('memberTools.insights.kept', RETENTION_DAYS)}</p>
${joinsChart(joins.days, tr)}${legend(tr)}
<details class="ins-table"><summary>${tr.t('memberTools.insights.showTable')}</summary><div class="table-wrap"><table><thead><tr><th>${tr.t('memberTools.insights.day')}</th><th>${tr.t('memberTools.chart.joined')}</th><th>${tr.t('memberTools.chart.left')}</th></tr></thead><tbody>${[...joins.days].reverse().map((d) => html`<tr><td>${d.day}</td><td>${d.joins}</td><td>${d.leaves}</td></tr>`)}</tbody></table></div></details></section>`
        : html`<section class="card"><h2>${tr.t('memberTools.insights.joinsTitleShort')}</h2><p class="error" role="alert">${joinsError || notLoaded}</p></section>`;
    const noRolesCard = html`<section class="card"><h2>${tr.t('memberTools.insights.noRolesTitle')}${noRoles ? ` (${n(noRoles.total)})` : ''}</h2>
<p class="muted">${tr.t('memberTools.insights.noRolesHelp')}</p>
${noRoles ? (noRoles.rows.length ? html`<ul class="skip-list">${noRoles.rows.map((r) => memberLink(r, tr.t('memberTools.insights.joinedAt', { date: tr.fmtDateTime(r.joinedAt) })))}</ul>${more(noRoles.total, noRoles.rows.length)}` : html`<p class="empty">${tr.t('memberTools.insights.none')}</p>`)
        : html`<p class="muted">${tr.t('memberTools.insights.noGuild')}</p>`}</section>`;
    const kinds = (r) => CASE_KINDS.filter(([k]) => r[k]).map(([k, key]) => tr.tp(key, r[k])).join(', ');
    const offendersCard = html`<section class="card"><h2>${tr.tp('memberTools.insights.offendersTitle', OFFENDER_DAYS)}</h2>
<p class="muted">${tr.t('memberTools.insights.offendersHelp')}</p>
${offenders ? (offenders.length ? html`<div class="table-wrap"><table><thead><tr><th>${tr.t('memberTools.insights.member')}</th><th>${tr.t('memberTools.insights.cases')}</th><th>${tr.t('memberTools.insights.last')}</th></tr></thead><tbody>${offenders.map((r) => html`<tr><td><a href="${userHref(r.userId)}">${r.username}</a> <small class="muted">${r.userId}</small></td><td>${r.cases}<br><small class="muted">${kinds(r)}</small></td><td class="nowrap">${tr.fmtDateTime(r.lastAt)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">${tr.tp('memberTools.insights.noOffenders', OFFENDER_DAYS)}</p>`)
        : html`<p class="error" role="alert">${offendersError || notLoaded}</p>`}</section>`;
    const inactiveCard = html`<section class="card"><h2>${tr.tp('memberTools.insights.inactiveTitle', INACTIVE_DAYS)}</h2>
${!levelingOn ? html`<p class="notice">${tr.t('memberTools.insights.inactiveOff')}</p>`
        : inactive ? html`<p class="muted">${tr.tp('memberTools.insights.inactiveHelp', INACTIVE_DAYS)} ${tr.tp('memberTools.insights.noRecord', inactive.noRecord)}</p>
${inactive.rows.length ? html`<ul class="skip-list">${inactive.rows.map((r) => memberLink(r, tr.t('memberTools.insights.lastXp', { date: tr.fmtDateTime(r.lastActiveAt) })))}</ul>${more(inactive.total, inactive.rows.length)}` : html`<p class="empty">${tr.tp('memberTools.insights.noInactive', INACTIVE_DAYS)}</p>`}`
            : html`<p class="error" role="alert">${inactiveError || notLoaded}</p>`}</section>`;
    const body = html`<header class="page-head"><h1>${tr.t('memberTools.insights.title')}</h1><p class="muted">${tr.t('memberTools.insights.intro')}</p></header>
${memberTabs('insights')}
${cached !== null && memberCount && cached < memberCount * 0.9 ? html`<p class="notice">${tr.t('memberTools.insights.partial', { cached: n(cached), total: n(memberCount) })}</p>` : ''}
${joinsCard}
<div class="grid grid-wide">${noRolesCard}${offendersCard}</div>
${inactiveCard}`;
    return layout({ title: tr.t('memberTools.insights.title'), active: 'users', session, access, moduleStates, body });
}
