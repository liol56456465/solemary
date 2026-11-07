// activityPage.js: Dashboard → Activity. Messages, joins and leaves, and cases per day for
// the last 30 days (services/stats/activityService.js), as bar charts drawn with CSS classes
// (no inline styles, no script) and the same numbers as a table. Real data only.

import { html, layout } from './html.js';
import { AUTOMOD_RULES } from '../../config/automod.js';

const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLabel = (day) => SHORT.format(new Date(`${day}T00:00:00Z`));

/** One chart: 30 bars, a label every 5 days and on the last day. */
export function barChart(series, field, label) {
    const max = Math.max(1, ...series.map((d) => d[field]));
    const total = series.reduce((sum, d) => sum + d[field], 0);
    const last = series.length - 1;
    return html`<div class="chart chart-wide" role="img" aria-label="${label} per day for ${series.length} days, ${total} in total. The table below has every day.">${series.map((d, i) => html`<div class="bar${i === last ? ' today' : ''}" title="${dayLabel(d.day)}: ${d[field]}"><i class="h-${Math.round((d[field] / max) * 10)}"></i><span class="bar-label">${i % 5 === 0 || i === last ? dayLabel(d.day) : ''}</span></div>`)}</div>`;
}

/** Pro/Max: per moderator and per automod rule. analytics null = could not be read; locked = not on the plan. */
export function analyticsSection({ analytics = null, locked = false, days = 30 }) {
    if (locked) return html`<section class="card"><h2>Staff and automod</h2><p class="muted">Cases per moderator and how often each automod rule is undone come with Mewvo Pro and Max, on the server owner's plan. <a href="/pricing">Plans</a></p></section>`;
    if (!analytics) return html`<section class="card"><h2>Staff and automod</h2><p class="error" role="alert">These numbers could not be loaded (database). Reload the page to try again.</p></section>`;
    const ruleName = (key) => AUTOMOD_RULES[String(key).replace(/^automod:/, '')]?.label || String(key).replace(/^automod:/, '');
    const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : '-');
    return html`<section class="card"><h2>Cases per moderator <span class="muted">· last ${days} days</span></h2>
${analytics.moderators.length ? html`<div class="scroll"><table><thead><tr><th>Moderator</th><th>Total</th><th>Bans</th><th>Kicks</th><th>Mutes</th><th>Warns</th><th>Removed</th></tr></thead><tbody>
${analytics.moderators.map((m) => html`<tr><td>${m.name}</td><td>${m.total}</td><td>${m.ban}</td><td>${m.kick}</td><td>${m.mute}</td><td>${m.warn}</td><td>${m.voided}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No cases by people in this time.</p>`}</section>
<section class="card"><h2>Automod rules <span class="muted">· last ${days} days</span></h2>
${analytics.rules.length ? html`<div class="scroll"><table><thead><tr><th>Rule</th><th>Actions</th><th>Undone</th><th>Undone share</th></tr></thead><tbody>
${analytics.rules.map((r) => html`<tr><td>${ruleName(r.key)}</td><td>${r.total}</td><td>${r.undone}</td><td>${pct(r.undone, r.total)}</td></tr>`)}</tbody></table></div>
<p class="muted">A rule that is undone often may be too strict: consider Report only (don't delete) for it.</p>` : html`<p class="muted">Automod took no action in this time.</p>`}</section>`;
}

export function totals(series) {
    return series.reduce((acc, d) => ({
        messages: acc.messages + d.messages, joins: acc.joins + d.joins, leaves: acc.leaves + d.leaves, cases: acc.cases + d.cases,
    }), { messages: 0, joins: 0, leaves: 0, cases: 0 });
}

export function activityPage({ session, access = null, moduleStates = {}, series = null, extra = '' }) {
    const body = series === null
        ? html`<header class="page-head"><h1>Activity</h1></header><p class="error" role="alert">The numbers could not be loaded (database). Reload the page to try again.</p>`
        : (() => {
            const t = totals(series);
            const card = (title, field, sum) => html`<section class="card"><h2>${title} <span class="muted">· ${sum} in ${series.length} days</span></h2>${barChart(series, field, title)}</section>`;
            return html`<header class="page-head"><h1>Activity</h1><p class="muted">The last ${series.length} days in this server (UTC). Messages are counted from today on: only a number per day, not who wrote them or what.</p></header>
${card('Messages', 'messages', t.messages)}
<section class="card"><h2>Joins and leaves <span class="muted">· ${t.joins} joined, ${t.leaves} left</span></h2>${barChart(series, 'joins', 'Joins')}<p class="muted">Leaves:</p>${barChart(series, 'leaves', 'Leaves')}</section>
${card('Cases', 'cases', t.cases)}
${extra}
<details class="card"><summary>Every day as a table</summary><div class="scroll"><table><thead><tr><th>Day</th><th>Messages</th><th>Joins</th><th>Leaves</th><th>Cases</th></tr></thead><tbody>
${[...series].reverse().map((d) => html`<tr><td>${dayLabel(d.day)}</td><td>${d.messages}</td><td>${d.joins}</td><td>${d.leaves}</td><td>${d.cases}</td></tr>`)}
</tbody></table></div></details>`;
        })();
    return layout({ title: 'Activity', active: 'activity', session, access, moduleStates, body });
}
