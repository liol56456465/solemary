// memberToolsPages.js — the Members area's Role rules and Insights pages (and the tab row the
// three Members pages share). Pure: data in, HTML out, everything escaped by `html`. No inline
// styles or scripts (CSP): the chart is SVG with presentation attributes and CSS classes that
// take the theme's chart colours (--c-* in dashboard.css).

import { formatDate, html, layout, path, raw } from './html.js';
import { actionForm, memberTabs } from './enforcementPages.js';
import { MAX_DAYS, MAX_LEVEL, MAX_RULES, NAME_MAX, RULE_TRIGGERS, RUN_CHANGE_LIMIT, describeRule } from '../members/roleRuleService.js';
import { CHART_DAYS, INACTIVE_DAYS, OFFENDER_DAYS, RETENTION_DAYS } from '../members/memberInsightsService.js';

const userHref = (id) => path(`/users/${encodeURIComponent(id)}`);
export const PREVIEW_NAMES = 50;

function notices({ flash = null, error = null, editEnabled = true, canAct = true }) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">Read-only: editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED is not true).</p>`
        : !canAct ? html`<p class="notice">View only: you need Administrator in the main server to change role rules.</p>` : ''}`;
}

const opt = (value, label, current) => html`<option value="${value}"${String(value) === String(current ?? '') ? raw(' selected') : ''}>${label}</option>`;

// ── Role rules ───────────────────────────────────────────────────────────

/**
 * The rule form (new or edit). values: the rule's fields as form strings. givable: roles a rule
 * may give ([{ id, name }]); roles: every role for the trigger.
 */
function ruleForm(csrf, values, { givable, roles, enabled }) {
    const v = values || {};
    return actionForm(csrf, '/users/rules/preview', html`<div class="grid">
<label>Name<input name="name" value="${v.name || ''}" maxlength="${NAME_MAX}" required placeholder="e.g. Regulars after 30 days"></label>
<label>When<select name="trigger" required>${Object.entries(RULE_TRIGGERS).map(([k, label]) => opt(k, label, v.trigger || 'days_in_server'))}</select></label>
<label>Days or level<input type="number" name="threshold" value="${v.threshold ?? ''}" min="0" max="${Math.max(MAX_DAYS, MAX_LEVEL)}" step="1"><span class="hint">Days in the server (0 = on joining, up to ${MAX_DAYS}) or the leveling level (1–${MAX_LEVEL}). Not used for "Has a role".</span></label>
<label>Trigger role<select name="triggerRoleId">${opt('', '— only for "Has a role" —', v.triggerRoleId)}${roles.map((r) => opt(r.id, `@${r.name}`, v.triggerRoleId))}</select></label>
<label>Give this role<select name="roleId" required>${opt('', '— choose —', v.roleId)}${givable.map((r) => opt(r.id, `@${r.name}`, v.roleId))}</select><span class="hint">Only roles below Mewvo (and below your own top role), not managed, without staff permissions.</span></label>
</div>
<label class="check"><input type="checkbox" name="removeWhenFalse" value="1"${v.removeWhenFalse ? raw(' checked') : ''}> Take the role away again when the condition is no longer true</label>
<p class="muted">Taking away also applies to members who got the role by hand; a member still matched by another enabled rule for the same role keeps it.</p>
<label class="check"><input type="checkbox" name="enabled" value="1"${v.enabled ?? true ? raw(' checked') : ''}> Turn the rule on when saving</label>
${v.id ? html`<input type="hidden" name="id" value="${v.id}">` : ''}
<p class="muted">Nothing changes yet: the next page shows how many members, and who, the rule would change.</p>`, { submit: 'Dry run', enabled });
}

/** A rule's fields as form values (for the edit form and the "Turn on…" button). */
export function ruleValues(rule) {
    return {
        id: rule.id, name: rule.name, trigger: rule.trigger, threshold: rule.threshold ?? '', triggerRoleId: rule.triggerRoleId || '',
        roleId: rule.roleId, removeWhenFalse: rule.removeWhenFalse ? '1' : '', enabled: '1',
    };
}

function ruleRow(rule, { csrf, canWrite, roleName, problem }) {
    const status = rule.enabled
        ? (problem ? html`<span class="state-word is-warn"><span class="dot dot-warn" aria-hidden="true"></span>On, paused</span>` : html`<span class="state-word is-on"><span class="dot dot-on" aria-hidden="true"></span>On</span>`)
        : html`<span class="muted">Off</span>`;
    const last = rule.lastRunAt
        ? html`<small class="muted">Last run ${formatDate(rule.lastRunAt)}: +${rule.lastAdded} −${rule.lastRemoved}${rule.lastFailed ? html`, ${rule.lastFailed} failed` : ''}</small>`
        : html`<small class="muted">Not run yet</small>`;
    const hidden = Object.fromEntries(Object.entries(ruleValues(rule)).map(([k, value]) => [k, String(value)]));
    const actions = canWrite ? html`<div class="row-actions">
${rule.enabled ? actionForm(csrf, `/users/rules/${rule.id}/disable`, '', { submit: 'Turn off', inline: true, secondary: true })
        : actionForm(csrf, '/users/rules/preview', '', { submit: 'Turn on…', inline: true, secondary: true, hidden })}
<a class="btn small" href="${path(`/users/rules?edit=${rule.id}`)}#s-rule-form">Edit</a>
${actionForm(csrf, `/users/rules/${rule.id}/delete`, '', { submit: 'Delete', inline: true, danger: true, confirm: `Delete the rule "${rule.name}"? Roles it already gave stay.` })}</div>` : '';
    return html`<tr><td><b>${rule.name}</b><br><span>${describeRule(rule, roleName)}</span>${problem ? html`<br><span class="error-text">${problem}</span>` : ''}</td>
<td class="nowrap">${status}<br>${last}</td><td>${actions}</td></tr>`;
}

/**
 * The Role rules page. rules: from listRoleRules; problems: Map ruleId → why it cannot run now;
 * editing: the rule being edited (or null); values: form values to show again after an error.
 */
export function roleRulesPage({ session, access = null, moduleStates = {}, rules = [], problems = new Map(), roleName = (id) => id, givable = [], roles = [], canWrite = false, editEnabled = true, canAct = true, flash = null, error = null, editing = null, values = null, levelingOn = true, loadError = null }) {
    const csrf = session?.csrf;
    const formValues = values || (editing ? ruleValues(editing) : null);
    const table = rules.length ? html`<div class="table-wrap"><table class="rules"><thead><tr><th>Rule</th><th>State</th><th></th></tr></thead><tbody>
${rules.map((rule) => ruleRow(rule, { csrf, canWrite, roleName, problem: problems.get(rule.id) || null }))}</tbody></table></div>`
        : loadError ? '' : html`<p class="empty">No role rules yet.</p>`;
    const full = rules.length >= MAX_RULES && !editing;
    const body = html`<header class="page-head"><h1>Role rules</h1><p class="muted">Roles Mewvo gives by itself: checked every 10 minutes (at most ${RUN_CHANGE_LIMIT} role changes per run, one at a time), and right away when a member joins, levels up or gets a role.</p></header>
${memberTabs('rules')}
${notices({ flash, error, editEnabled, canAct })}
${loadError ? html`<p class="error" role="alert">${loadError}</p>` : ''}
${!levelingOn && rules.some((r) => r.trigger === 'level_reached') ? html`<p class="notice">Leveling is off: levels do not change, so level rules only use the levels already stored.</p>` : ''}
<section class="card"><h2>Rules (${rules.length} of ${MAX_RULES})</h2>${table}<p class="muted">Turning a rule off or deleting it keeps the roles it already gave.</p></section>
${canWrite && !loadError ? html`<details class="card section" id="s-rule-form" data-key="rule-form"${editing || values ? raw(' open') : ''}><summary><h2>${editing ? `Edit "${editing.name}"` : 'New rule'}</h2></summary><div class="section-body">
${full ? html`<p class="notice">This server has ${MAX_RULES} rules, the most allowed. Delete one first.</p>` : ruleForm(csrf, formValues, { givable, roles, enabled: true })}
${editing ? html`<p><a href="${path('/users/rules')}">Cancel editing</a></p>` : ''}</div></details>` : ''}`;
    return layout({ title: 'Role rules', active: 'users', session, access, moduleStates, body });
}

/** Names for a dry-run list: the first PREVIEW_NAMES, then "and N more". */
function nameList(entries) {
    if (!entries.length) return html`<p class="empty">Nobody.</p>`;
    const shown = entries.slice(0, PREVIEW_NAMES);
    return html`<ul class="name-list">${shown.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a></li>`)}</ul>${entries.length > shown.length ? html`<p class="muted">… and ${entries.length - shown.length} more.</p>` : ''}`;
}

/**
 * The dry run of a rule before it is saved: how many and which members it would change now.
 * add / remove: [{ id, name }]. Save needs the one-time token.
 */
export function roleRulePreviewPage({ session, access = null, moduleStates = {}, rule, description, add = [], remove = [], token, hash, cached = null, memberCount = null }) {
    const n = add.length + remove.length;
    const body = html`<a class="back" href="${path('/users/rules')}">← Role rules</a>
<header class="page-head"><h1>Dry run: ${rule.name}</h1><p class="muted">${description}</p></header>
<p class="notice">${rule.enabled ? html`Would change <b>${n}</b> member${n === 1 ? '' : 's'} now: give the role to ${add.length}, take it from ${remove.length}. Nothing has been changed yet.` : html`Saved switched off: nothing changes until you turn it on. If it were on now, it would change ${n} member${n === 1 ? '' : 's'}.`}</p>
${cached !== null && memberCount && cached < memberCount ? html`<p class="notice">Counted from ${cached} of ${memberCount} members (the member list is still loading); the real run uses everyone.</p>` : ''}
<section class="card"><h2>Gets the role (${add.length})</h2>${nameList(add)}</section>
${rule.removeWhenFalse ? html`<section class="card"><h2>Loses the role (${remove.length})</h2>${nameList(remove)}</section>` : ''}
${actionForm(session.csrf, '/users/rules/save', html`<p class="muted">${rule.enabled ? `Changes are made by the next run (within 10 minutes), at most ${RUN_CHANGE_LIMIT} per run.` : 'The rule is saved switched off.'}</p>`,
        { submit: rule.id ? 'Save changes' : 'Save rule', hidden: { token, fh: hash } })}`;
    return layout({ title: `Dry run: ${rule.name}`, active: 'users', session, access, moduleStates, body });
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
export function joinsChart(days) {
    const max = Math.max(1, ...days.map((d) => Math.max(d.joins, d.leaves)));
    const plotW = W - PAD_L;
    const plotH = H - PAD_B - PAD_T;
    const slot = plotW / days.length;
    const bar = Math.max(1, Math.floor((slot - 2) / 2));
    const y = (n) => PAD_T + plotH - (n / max) * plotH;
    const totalJ = days.reduce((s, d) => s + d.joins, 0);
    const totalL = days.reduce((s, d) => s + d.leaves, 0);
    const ticks = [...new Set([0, Math.round(max / 2), max])];
    return html`<svg class="ins-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Joins and leaves per day, last ${days.length} days: ${totalJ} joins, ${totalL} leaves">
${ticks.map((t) => html`<line class="ins-grid" x1="${PAD_L}" x2="${W}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line><text class="ins-tick" x="${PAD_L - 4}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${t}</text>`)}
${days.map((d, i) => {
        const x = PAD_L + i * slot + 1;
        return html`<g><title>${d.day}: ${d.joins} joined, ${d.leaves} left</title>${d.joins ? html`<rect class="ins-join" x="${x.toFixed(1)}" y="${y(d.joins).toFixed(1)}" width="${bar}" height="${(PAD_T + plotH - y(d.joins)).toFixed(1)}"></rect>` : ''}${d.leaves ? html`<rect class="ins-leave" x="${(x + bar).toFixed(1)}" y="${y(d.leaves).toFixed(1)}" width="${bar}" height="${(PAD_T + plotH - y(d.leaves)).toFixed(1)}"></rect>` : ''}</g>`;
    })}
${days.map((d, i) => ((days.length - 1 - i) % 7 === 0 ? html`<text class="ins-tick" x="${(PAD_L + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${d.day.slice(5)}</text>` : ''))}
</svg>`;
}

function legend() {
    const swatch = (cls) => html`<svg class="ins-swatch" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect class="${cls}" width="12" height="12" rx="2"></rect></svg>`;
    return html`<p class="ins-legend">${swatch('ins-join')} Joined ${swatch('ins-leave')} Left</p>`;
}

function memberLink(row, extra) {
    return html`<li><a href="${userHref(row.id)}">${row.displayName}</a> <small class="muted">${row.username}${extra ? html` · ${extra}` : ''}</small></li>`;
}

/**
 * The Insights page. Each part may be missing (null) with its own error, so one failing query
 * does not hide the rest. activity: { levelingOn, data } — data null when leveling is off.
 */
export function insightsPage({ session, access = null, moduleStates = {}, joins = null, joinsError = null, noRoles = null, offenders = null, offendersError = null, inactive = null, inactiveError = null, levelingOn = false, cached = null, memberCount = null }) {
    const totalJ = joins ? joins.days.reduce((s, d) => s + d.joins, 0) : 0;
    const totalL = joins ? joins.days.reduce((s, d) => s + d.leaves, 0) : 0;
    const joinsCard = joins ? html`<section class="card"><h2>Joins and leaves (last ${CHART_DAYS} days)</h2>
<p class="muted">${totalJ} joined · ${totalL} left · net ${totalJ - totalL >= 0 ? '+' : ''}${totalJ - totalL}. Days in UTC. ${joins.since ? html`Counting since ${formatDate(joins.since)}; earlier days show 0.` : 'Nothing counted yet: joins and leaves are recorded from now on.'} Kept ${RETENTION_DAYS} days.</p>
${joinsChart(joins.days)}${legend()}
<details class="ins-table"><summary>Show as a table</summary><div class="table-wrap"><table><thead><tr><th>Day</th><th>Joined</th><th>Left</th></tr></thead><tbody>${[...joins.days].reverse().map((d) => html`<tr><td>${d.day}</td><td>${d.joins}</td><td>${d.leaves}</td></tr>`)}</tbody></table></div></details></section>`
        : html`<section class="card"><h2>Joins and leaves</h2><p class="error" role="alert">${joinsError || 'Could not be loaded.'}</p></section>`;
    const noRolesCard = html`<section class="card"><h2>New members without a role after 24 hours${noRoles ? ` (${noRoles.total})` : ''}</h2>
<p class="muted">Joined in the last 30 days, more than 24 hours ago, and still no role (bots left out). Often: never verified.</p>
${noRoles ? (noRoles.rows.length ? html`<ul class="skip-list">${noRoles.rows.map((r) => memberLink(r, html`joined ${formatDate(r.joinedAt)}`))}</ul>${noRoles.total > noRoles.rows.length ? html`<p class="muted">… and ${noRoles.total - noRoles.rows.length} more.</p>` : ''}` : html`<p class="empty">None.</p>`)
        : html`<p class="muted">The bot cannot see the main server right now.</p>`}</section>`;
    const kinds = (r) => [['warns', 'warn'], ['mutes', 'mute'], ['kicks', 'kick'], ['bans', 'ban']].filter(([k]) => r[k]).map(([k, w]) => `${r[k]} ${w}${r[k] === 1 ? '' : 's'}`).join(', ');
    const offendersCard = html`<section class="card"><h2>Repeat offenders (last ${OFFENDER_DAYS} days)</h2>
<p class="muted">Members with two or more cases (voided, imported and test cases left out).</p>
${offenders ? (offenders.length ? html`<div class="table-wrap"><table><thead><tr><th>Member</th><th>Cases</th><th>Last</th></tr></thead><tbody>${offenders.map((r) => html`<tr><td><a href="${userHref(r.userId)}">${r.username}</a> <small class="muted">${r.userId}</small></td><td>${r.cases}<br><small class="muted">${kinds(r)}</small></td><td class="nowrap">${formatDate(r.lastAt)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">Nobody has two or more cases in the last ${OFFENDER_DAYS} days.</p>`)
        : html`<p class="error" role="alert">${offendersError || 'Could not be loaded.'}</p>`}</section>`;
    const inactiveCard = html`<section class="card"><h2>Inactive members (no XP for ${INACTIVE_DAYS}+ days)</h2>
${!levelingOn ? html`<p class="notice">Not available: the only activity time Mewvo stores is the last time leveling gave a member XP, and leveling is off. Turn leveling on to start measuring; nothing is guessed here.</p>`
        : inactive ? html`<p class="muted">Activity = the last time leveling gave the member XP (messages that earn XP). Members in the server for less than ${INACTIVE_DAYS} days and bots are left out. ${inactive.noRecord} member${inactive.noRecord === 1 ? ' has' : 's have'} no leveling record at all (never earned XP, or before leveling was on) and ${inactive.noRecord === 1 ? 'is' : 'are'} not listed.</p>
${inactive.rows.length ? html`<ul class="skip-list">${inactive.rows.map((r) => memberLink(r, html`last XP ${formatDate(r.lastActiveAt)}`))}</ul>${inactive.total > inactive.rows.length ? html`<p class="muted">… and ${inactive.total - inactive.rows.length} more.</p>` : ''}` : html`<p class="empty">Nobody with a leveling record has been quiet for ${INACTIVE_DAYS} days.</p>`}`
            : html`<p class="error" role="alert">${inactiveError || 'Could not be loaded.'}</p>`}</section>`;
    const body = html`<header class="page-head"><h1>Member insights</h1><p class="muted">Who comes and goes, who is stuck without a role, who keeps getting cases.</p></header>
${memberTabs('insights')}
${cached !== null && memberCount && cached < memberCount * 0.9 ? html`<p class="notice">Based on ${cached} of ${memberCount} members: the member list is still loading. Reload in a minute.</p>` : ''}
${joinsCard}
<div class="grid grid-wide">${noRolesCard}${offendersCard}</div>
${inactiveCard}`;
    return layout({ title: 'Member insights', active: 'users', session, access, moduleStates, body });
}
