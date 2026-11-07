// activityPage.js: Dashboard → Activity. Messages, joins and leaves, and cases per day for
// the last 30 days (services/stats/activityService.js), as bar charts drawn with CSS classes
// (no inline styles, no script) and the same numbers as a table. Real data only.

import { html, layout } from './html.js';
import { AUTOMOD_RULES } from '../../config/automod.js';
import { currentText, dashboardText } from './language.js';

const SHORT = new Map();
/** "27 Oct" (English, as before) or the language's own short day + month, UTC. */
function dayLabel(day, tr = currentText()) {
    const code = tr.lang === 'en' ? 'en-GB' : tr.lang;
    if (!SHORT.has(code)) SHORT.set(code, new Intl.DateTimeFormat(code, { day: 'numeric', month: 'short', timeZone: 'UTC' }));
    return SHORT.get(code).format(new Date(`${day}T00:00:00Z`));
}

/** One chart: 30 bars, a label every 5 days and on the last day. */
export function barChart(series, field, label, tr = currentText()) {
    const max = Math.max(1, ...series.map((d) => d[field]));
    const total = series.reduce((sum, d) => sum + d[field], 0);
    const last = series.length - 1;
    return html`<div class="chart chart-wide" role="img" aria-label="${tr.t('activity.chart.aria', { label, days: tr.fmtNumber(series.length), total: tr.fmtNumber(total) })}">${series.map((d, i) => html`<div class="bar${i === last ? ' today' : ''}" title="${dayLabel(d.day, tr)}: ${tr.fmtNumber(d[field])}"><i class="h-${Math.round((d[field] / max) * 10)}"></i><span class="bar-label">${i % 5 === 0 || i === last ? dayLabel(d.day, tr) : ''}</span></div>`)}</div>`;
}

/** Pro/Max: per moderator and per automod rule. analytics null = could not be read; locked = not on the plan. */
export function analyticsSection({ analytics = null, locked = false, days = 30 }) {
    const tr = currentText();
    if (locked) return html`<section class="card"><h2>${tr.t('activity.analytics.title')}</h2><p class="muted">${tr.tx('activity.analytics.locked')} <a href="/pricing">${tr.t('activity.analytics.plans')}</a></p></section>`;
    if (!analytics) return html`<section class="card"><h2>${tr.t('activity.analytics.title')}</h2><p class="error" role="alert">${tr.t('activity.analytics.unreadable')}</p></section>`;
    const ruleName = (key) => AUTOMOD_RULES[String(key).replace(/^automod:/, '')]?.label || String(key).replace(/^automod:/, '');
    const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : '-');
    const lastDays = tr.t('activity.analytics.lastDays', { days: tr.fmtNumber(days) });
    return html`<section class="card"><h2>${tr.t('activity.analytics.perModerator')} <span class="muted">· ${lastDays}</span></h2>
${analytics.moderators.length ? html`<div class="scroll"><table><thead><tr><th>${tr.t('activity.col.moderator')}</th><th>${tr.t('activity.col.total')}</th><th>${tr.t('activity.col.bans')}</th><th>${tr.t('activity.col.kicks')}</th><th>${tr.t('activity.col.mutes')}</th><th>${tr.t('activity.col.warns')}</th><th>${tr.t('activity.col.removed')}</th></tr></thead><tbody>
${analytics.moderators.map((m) => html`<tr><td>${m.name}</td><td>${tr.fmtNumber(m.total)}</td><td>${tr.fmtNumber(m.ban)}</td><td>${tr.fmtNumber(m.kick)}</td><td>${tr.fmtNumber(m.mute)}</td><td>${tr.fmtNumber(m.warn)}</td><td>${tr.fmtNumber(m.voided)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">${tr.t('activity.analytics.noCases')}</p>`}</section>
<section class="card"><h2>${tr.t('activity.analytics.rules')} <span class="muted">· ${lastDays}</span></h2>
${analytics.rules.length ? html`<div class="scroll"><table><thead><tr><th>${tr.t('activity.col.rule')}</th><th>${tr.t('activity.col.actions')}</th><th>${tr.t('activity.col.undone')}</th><th>${tr.t('activity.col.undoneShare')}</th></tr></thead><tbody>
${analytics.rules.map((r) => html`<tr><td>${ruleName(r.key)}</td><td>${tr.fmtNumber(r.total)}</td><td>${tr.fmtNumber(r.undone)}</td><td>${pct(r.undone, r.total)}</td></tr>`)}</tbody></table></div>
<p class="muted">${tr.tx('activity.analytics.tooStrict')}</p>` : html`<p class="muted">${tr.t('activity.analytics.noAutomod')}</p>`}</section>`;
}

export function totals(series) {
    return series.reduce((acc, d) => ({
        messages: acc.messages + d.messages, joins: acc.joins + d.joins, leaves: acc.leaves + d.leaves, cases: acc.cases + d.cases,
    }), { messages: 0, joins: 0, leaves: 0, cases: 0 });
}

export function activityPage({ session, access = null, moduleStates = {}, series = null, extra = '' }) {
    const tr = dashboardText(session?.lang);
    const title = tr.t('frame.nav.items.activity');
    const body = series === null
        ? html`<header class="page-head"><h1>${title}</h1></header><p class="error" role="alert">${tr.t('activity.page.unreadable')}</p>`
        : (() => {
            const t = totals(series);
            const days = tr.fmtNumber(series.length);
            const card = (cardTitle, field, sum) => html`<section class="card"><h2>${cardTitle} <span class="muted">· ${tr.t('activity.page.inDays', { sum: tr.fmtNumber(sum), days })}</span></h2>${barChart(series, field, cardTitle, tr)}</section>`;
            return html`<header class="page-head"><h1>${title}</h1><p class="muted">${tr.t('activity.page.intro', { days })}</p></header>
${card(tr.t('activity.page.messages'), 'messages', t.messages)}
<section class="card"><h2>${tr.t('activity.page.joinsLeaves')} <span class="muted">· ${tr.t('activity.page.joinedLeft', { joins: tr.fmtNumber(t.joins), leaves: tr.fmtNumber(t.leaves) })}</span></h2>${barChart(series, 'joins', tr.t('activity.page.joins'), tr)}<p class="muted">${tr.t('activity.page.leavesLabel')}</p>${barChart(series, 'leaves', tr.t('activity.page.leaves'), tr)}</section>
${card(tr.t('activity.page.cases'), 'cases', t.cases)}
${extra}
<details class="card"><summary>${tr.t('activity.page.table')}</summary><div class="scroll"><table><thead><tr><th>${tr.t('activity.col.day')}</th><th>${tr.t('activity.page.messages')}</th><th>${tr.t('activity.page.joins')}</th><th>${tr.t('activity.page.leaves')}</th><th>${tr.t('activity.page.cases')}</th></tr></thead><tbody>
${[...series].reverse().map((d) => html`<tr><td>${dayLabel(d.day, tr)}</td><td>${tr.fmtNumber(d.messages)}</td><td>${tr.fmtNumber(d.joins)}</td><td>${tr.fmtNumber(d.leaves)}</td><td>${tr.fmtNumber(d.cases)}</td></tr>`)}
</tbody></table></div></details>`;
        })();
    return layout({ title, active: 'activity', session, access, moduleStates, body });
}
