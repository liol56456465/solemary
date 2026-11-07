// incidentPages.js: Dashboard → Moderate → Raid timeline. The list of incidents (join-raid
// lockdowns, kept 90 days) and one incident minute by minute: a header with start, end,
// duration, trigger, joins and the actions taken by type, a chart of joins and actions,
// then every minute with something in it as an expandable row (quiet minutes are folded
// into one line). Data: services/automod/incidentTimeline.js (buildTimeline).
// Server-rendered and escaped (html``); no inline styles or scripts (CSP): bar heights are
// CSS classes, rows expand with <details>.

import { html, layout, path, typeBadge } from './html.js';
import { currentText, dashboardText } from './language.js';
import { EVENT_KINDS, MAX_EVENTS_PER_INCIDENT, RETENTION_DAYS, TRIGGERS } from '../automod/incidentTimeline.js';

const MINUTE_MS = 60_000;
const clock = (value) => new Date(value).toISOString().slice(11, 19);
const hhmm = (value) => new Date(value).toISOString().slice(11, 16);
/** "2 h 5 min" / "under a minute" (the same steps as incidentTimeline.js formatSpan), in the page's language. */
function span(ms, tr = currentText()) {
    const minutes = Math.floor(ms / MINUTE_MS);
    if (minutes < 1) return tr.t('incidents.span.underMinute');
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    return [days ? tr.t('incidents.span.days', { n: tr.fmtNumber(days) }) : null, hours ? tr.t('incidents.span.hours', { n: tr.fmtNumber(hours) }) : null,
        rest ? tr.t('incidents.span.minutes', { n: tr.fmtNumber(rest) }) : null].filter(Boolean).join(' ');
}
/** An event kind's label (incidentTimeline.js EVENT_KINDS) in the page's language. */
const kindLabel = (kind, tr = currentText()) => (tr.has(`incidents.kind.${kind}`) ? tr.t(`incidents.kind.${kind}`) : EVENT_KINDS[kind]?.label || kind);
/** A trigger (TRIGGERS key, or its English text from buildTimeline) in the page's language. */
function triggerLabel(value, tr = currentText()) {
    const kind = Object.hasOwn(TRIGGERS, value) ? value : Object.keys(TRIGGERS).find((k) => TRIGGERS[k] === value);
    return kind && tr.has(`incidents.trigger.${kind}`) ? tr.t(`incidents.trigger.${kind}`) : TRIGGERS[value] || value;
}

/** A member: name (from the bot's cache) or the id, linked to the member page. */
function person(id, names, fallback = null) {
    if (!id) return html`<span class="muted">Mewvo</span>`;
    const name = names?.get?.(id) || fallback;
    return html`<a href="${path(`/users/${id}`)}">${name || id}</a>`;
}

function statusText(header, tr = currentText()) {
    if (header.status === 'ongoing') return html`<span class="bad">${tr.t('incidents.status.running')}</span>`;
    if (header.status === 'unknown') return tr.t('incidents.status.notRecorded');
    if (header.status === 'unread') return tr.t('incidents.status.unread');
    return tr.fmtDateTime(header.ended);
}

// ── The list ─────────────────────────────────────────────────────────────

/**
 * rows: incident rows (newest first) or null when they could not be read. activeId: the
 * running incident. stateUnread: the lockdown state could not be read.
 */
export function incidentListPage({ session, access = null, moduleStates = {}, rows = null, activeId = null, stateUnread = false, now = Date.now() }) {
    const tr = dashboardText(session?.lang);
    const title = tr.t('frame.nav.items.incidents');
    const head = html`<header class="page-head"><h1>${title}</h1><p class="muted">${tr.t('incidents.list.intro', { days: tr.fmtNumber(RETENTION_DAYS) })}</p></header>`;
    let body;
    if (rows === null) {
        body = html`${head}<p class="error" role="alert">${tr.t('incidents.list.unreadable')}</p>`;
    } else if (!rows.length) {
        body = html`${head}<p class="empty">${tr.t('incidents.list.empty', { days: tr.fmtNumber(RETENTION_DAYS) })}</p>`;
    } else {
        body = html`${head}<div class="scroll"><table><thead><tr><th>${tr.t('incidents.col.started')}</th><th>${tr.t('incidents.col.ended')}</th><th>${tr.t('incidents.col.duration')}</th><th>${tr.t('incidents.col.trigger')}</th><th>${tr.t('incidents.col.events')}</th><th><span class="sr">${tr.t('incidents.col.open')}</span></th></tr></thead><tbody>
${rows.map((row) => {
        const running = !row.ended_at && activeId && String(row.id) === String(activeId);
        const unread = !row.ended_at && stateUnread;
        const end = row.ended_at ? new Date(row.ended_at).getTime() : running ? now : null;
        return html`<tr><td>${tr.fmtDateTime(row.started_at)}</td><td>${row.ended_at ? tr.fmtDateTime(row.ended_at) : running ? html`<span class="bad">${tr.t('incidents.status.running')}</span>` : unread ? tr.t('incidents.status.unread') : tr.t('incidents.status.notRecorded')}</td>
<td>${end === null ? '-' : span(end - new Date(row.started_at).getTime(), tr)}</td><td>${triggerLabel(row.trigger_kind, tr)}</td>
<td>${tr.fmtNumber(row.event_count)}${Number(row.dropped_events) ? html` <span class="muted">${tr.t('incidents.list.notKept', { n: tr.fmtNumber(row.dropped_events) })}</span>` : ''}</td><td><a href="${path(`/incidents/${row.id}`)}">${tr.t('incidents.list.open')}</a></td></tr>`;
    })}</tbody></table></div>`;
    }
    return layout({ title, active: 'incidents', session, access, moduleStates, body });
}

// ── One incident ─────────────────────────────────────────────────────────

/** The "What was done" columns: header.actions keys (labels: incidents.actions.<key>). */
const ACTION_KEYS = ['ban', 'kick', 'mute', 'warn', 'gate_kick', 'gate_flag', 'automod', 'mass_block'];

function fact(label, value) {
    return html`<div class="fact"><dt>${label}</dt><dd><b>${value}</b></dd></div>`;
}

/** Bars for one field of the chart buckets (heights in 10 % steps), with a text alternative. */
export function minuteChart(chart, field, label, tr = currentText()) {
    const { buckets, bucketMinutes } = chart;
    const max = Math.max(1, ...buckets.map((b) => b[field]));
    const total = buckets.reduce((sum, b) => sum + b[field], 0);
    const every = Math.max(1, Math.ceil(buckets.length / 6));
    const aria = bucketMinutes === 1
        ? tr.t('incidents.chart.ariaMinute', { label, total: tr.fmtNumber(total), bars: tr.fmtNumber(buckets.length) })
        : tr.t('incidents.chart.ariaMinutes', { label, minutes: tr.fmtNumber(bucketMinutes), total: tr.fmtNumber(total), bars: tr.fmtNumber(buckets.length) });
    return html`<div class="chart chart-wide" role="img" aria-label="${aria}">${buckets.map((b, i) => html`<div class="bar" title="${hhmm(b.start)} UTC: ${b[field]}"><i class="h-${Math.round((b[field] / max) * 10)}"></i><span class="bar-label">${i % every === 0 ? hhmm(b.start) : ''}</span></div>`)}</div>`;
}

function itemRow(item, names, tr = currentText()) {
    let what;
    if (item.kind === 'case') {
        what = html`${typeBadge(item.caseType)} ${person(item.targetId, names, item.targetName)} <a href="${path(`/cases/${item.code}`)}">${tr.t('incidents.item.case', { code: item.code })}</a>${item.detail ? html` <span class="muted">${item.detail}</span>` : ''}`;
    } else if (item.kind === 'join' || item.kind === 'leave') {
        what = html`<b>${kindLabel(item.kind, tr)}</b> ${person(item.targetId, names)}${item.detail ? html` <span class="tag">${item.detail}</span>` : ''}`;
    } else {
        const target = item.targetId ? html` ${person(item.targetId, names)}` : '';
        const actor = item.actorId && item.kind !== 'dashboard' ? html` <span class="muted">${tr.t('incidents.item.by')}</span> ${person(item.actorId, names)}` : '';
        what = html`<b>${kindLabel(item.kind, tr)}</b>${target}${item.detail ? html`: ${item.detail}` : ''}${actor}`;
    }
    return html`<li class="tl-${item.kind}"><span class="muted">${clock(item.at)}</span> ${what}</li>`;
}

function minuteSummary(counts, tr = currentText()) {
    return [
        counts.joins ? tr.tp('incidents.count.joins', counts.joins) : null,
        counts.leaves ? tr.tp('incidents.count.leaves', counts.leaves) : null,
        counts.actions ? tr.tp('incidents.count.actions', counts.actions) : null,
        counts.steps ? tr.tp('incidents.count.steps', counts.steps) : null,
    ].filter(Boolean).join(' · ');
}

function minuteList(minutes, names, tr = currentText()) {
    if (!minutes.length) return html`<p class="empty">${tr.t('incidents.detail.nothing')}</p>`;
    const open = minutes.length <= 5;
    const out = [];
    let previous = null;
    for (const minute of minutes) {
        if (previous !== null) {
            const gap = Math.round((minute.start - previous) / MINUTE_MS) - 1;
            if (gap > 0) out.push(html`<li class="minute-gap muted">${tr.tp('incidents.count.quiet', gap)}</li>`);
        }
        const day = previous === null || new Date(previous).toISOString().slice(0, 10) !== new Date(minute.start).toISOString().slice(0, 10)
            ? `${new Date(minute.start).toISOString().slice(0, 10)} ` : '';
        out.push(html`<li class="minute"><details${open ? html` open` : ''}><summary><b>${day}${hhmm(minute.start)} UTC</b> <span class="muted">${minuteSummary(minute.counts, tr)}</span></summary>
<ol class="timeline">${minute.items.map((item) => itemRow(item, names, tr))}</ol></details></li>`);
        previous = minute.start;
    }
    return html`<ol class="minutes">${out}</ol>`;
}

/** timeline: buildTimeline() result, or null when it could not be read. names: Map id → name. */
export function incidentDetailPage({ session, access = null, moduleStates = {}, timeline = null, names = new Map() }) {
    const tr = dashboardText(session?.lang);
    const title = tr.t('frame.nav.items.incidents');
    const back = html`<p><a href="${path('/incidents')}">${tr.t('incidents.detail.all')}</a></p>`;
    if (!timeline) {
        const body = html`<header class="page-head">${back}<h1>${title}</h1></header><p class="error" role="alert">${tr.t('incidents.detail.unreadable')}</p>`;
        return layout({ title, active: 'incidents', session, access, moduleStates, body });
    }
    const h = timeline.header;
    const notRecorded = tr.t('incidents.status.notRecorded');
    const notes = [
        h.dropped ? html`<p class="notice">${tr.t('incidents.detail.dropped', { max: tr.fmtNumber(MAX_EVENTS_PER_INCIDENT), n: tr.fmtNumber(h.dropped) })}</p>` : '',
        h.truncated?.members || h.truncated?.cases || h.truncated?.audit ? html`<p class="notice">${tr.t('incidents.detail.truncated')}</p>` : '',
        h.status === 'unread' ? html`<p class="notice">${tr.t('incidents.detail.stateUnread')}</p>` : '',
        h.status === 'unknown' ? html`<p class="notice">${tr.t('incidents.detail.endUnknown')}</p>` : '',
    ];
    const duration = h.status === 'ongoing' ? tr.t('incidents.detail.soFar', { span: span(h.durationMs, tr) }) : span(h.durationMs, tr);
    const body = html`<header class="page-head">${back}<h1>${tr.t('incidents.detail.title', { date: tr.fmtDateTime(h.started) })}</h1><p class="muted">${tr.t('incidents.detail.trigger', { trigger: triggerLabel(h.trigger, tr) })}</p></header>
${notes}
<dl class="facts">
${fact(tr.t('incidents.col.started'), tr.fmtDateTime(h.started))}
${fact(tr.t('incidents.col.ended'), statusText(h, tr))}
${fact(tr.t('incidents.col.duration'), duration)}
${fact(tr.t('incidents.detail.joined'), tr.fmtNumber(h.joins))}
${fact(tr.t('incidents.detail.left'), tr.fmtNumber(h.leaves))}
${h.raidJoiners === null ? '' : fact(tr.t('incidents.detail.raidJoiners'), tr.fmtNumber(h.raidJoiners))}
${h.endedBy ? fact(tr.t('incidents.detail.endedBy'), person(h.endedBy, names)) : ''}
</dl>
<section class="card"><h2>${tr.t('incidents.detail.done')}</h2>
<div class="scroll"><table><thead><tr>${ACTION_KEYS.map((key) => html`<th>${tr.t(`incidents.actions.${key}`)}</th>`)}</tr></thead><tbody><tr>${ACTION_KEYS.map((key) => html`<td>${tr.fmtNumber(h.actions[key])}</td>`)}</tr></tbody></table></div>
<p class="facts-line"><b>${tr.t('incidents.detail.verification')}</b> ${h.verification || notRecorded}</p>
<p class="facts-line"><b>${tr.t('incidents.detail.panic')}</b> ${h.panic || notRecorded}</p>
${h.released ? html`<p class="facts-line"><b>${tr.t('incidents.detail.released')}</b> ${tr.t('incidents.detail.releasedAt', { date: tr.fmtDateTime(h.released.at) })} ${person(h.released.by, names)}</p>` : ''}
</section>
<section class="card"><h2>${tr.t('incidents.detail.chartTitle')} <span class="muted">· ${timeline.chart.bucketMinutes === 1 ? tr.t('incidents.detail.perMinute') : tr.t('incidents.detail.perMinutes', { minutes: tr.fmtNumber(timeline.chart.bucketMinutes) })}</span></h2>
<p class="muted">${tr.t('incidents.detail.joinsLabel')}</p>${minuteChart(timeline.chart, 'joins', tr.t('incidents.detail.joins'), tr)}
<p class="muted">${tr.t('incidents.detail.actionsLabel')}</p>${minuteChart(timeline.chart, 'actions', tr.t('incidents.detail.actions'), tr)}</section>
<section class="card"><h2>${tr.t('incidents.detail.minutes')} <span class="muted">· ${tr.tp('incidents.count.events', timeline.total)}</span></h2>
${minuteList(timeline.minutes, names, tr)}</section>`;
    return layout({ title, active: 'incidents', session, access, moduleStates, body });
}
