// incidentPages.js: Dashboard → Moderate → Raid timeline. The list of incidents (join-raid
// lockdowns, kept 90 days) and one incident minute by minute: a header with start, end,
// duration, trigger, joins and the actions taken by type, a chart of joins and actions,
// then every minute with something in it as an expandable row (quiet minutes are folded
// into one line). Data: services/automod/incidentTimeline.js (buildTimeline).
// Server-rendered and escaped (html``); no inline styles or scripts (CSP): bar heights are
// CSS classes, rows expand with <details>.

import { html, layout, path, formatDate, typeBadge } from './html.js';
import { EVENT_KINDS, MAX_EVENTS_PER_INCIDENT, RETENTION_DAYS, TRIGGERS, formatSpan } from '../automod/incidentTimeline.js';

const MINUTE_MS = 60_000;
const clock = (value) => new Date(value).toISOString().slice(11, 19);
const hhmm = (value) => new Date(value).toISOString().slice(11, 16);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A member: name (from the bot's cache) or the id, linked to the member page. */
function person(id, names, fallback = null) {
    if (!id) return html`<span class="muted">Mewvo</span>`;
    const name = names?.get?.(id) || fallback;
    return html`<a href="${path(`/users/${id}`)}">${name || id}</a>`;
}

function statusText(header) {
    if (header.status === 'ongoing') return html`<span class="bad">Still running</span>`;
    if (header.status === 'unknown') return 'Not recorded';
    if (header.status === 'unread') return 'Could not be read';
    return formatDate(header.ended);
}

// ── The list ─────────────────────────────────────────────────────────────

/**
 * rows: incident rows (newest first) or null when they could not be read. activeId: the
 * running incident. stateUnread: the lockdown state could not be read.
 */
export function incidentListPage({ session, access = null, moduleStates = {}, rows = null, activeId = null, stateUnread = false, now = Date.now() }) {
    const head = html`<header class="page-head"><h1>Raid timeline</h1><p class="muted">Every join-raid lockdown of the last ${RETENTION_DAYS} days, minute by minute: who joined and what Mewvo and staff did. Times are UTC. No message content is kept.</p></header>`;
    let body;
    if (rows === null) {
        body = html`${head}<p class="error" role="alert">The incidents could not be loaded (database). Reload the page to try again.</p>`;
    } else if (!rows.length) {
        body = html`${head}<p class="empty">No raids in the last ${RETENTION_DAYS} days. When many accounts join at once, Mewvo starts a lockdown by itself and its timeline appears here.</p>`;
    } else {
        body = html`${head}<div class="scroll"><table><thead><tr><th>Started</th><th>Ended</th><th>Duration</th><th>Trigger</th><th>Events recorded</th><th><span class="sr">Open</span></th></tr></thead><tbody>
${rows.map((row) => {
        const running = !row.ended_at && activeId && String(row.id) === String(activeId);
        const unread = !row.ended_at && stateUnread;
        const end = row.ended_at ? new Date(row.ended_at).getTime() : running ? now : null;
        return html`<tr><td>${formatDate(row.started_at)}</td><td>${row.ended_at ? formatDate(row.ended_at) : running ? html`<span class="bad">Still running</span>` : unread ? 'Could not be read' : 'Not recorded'}</td>
<td>${end === null ? '-' : formatSpan(end - new Date(row.started_at).getTime())}</td><td>${TRIGGERS[row.trigger_kind] || row.trigger_kind}</td>
<td>${row.event_count}${Number(row.dropped_events) ? html` <span class="muted">(+${row.dropped_events} not kept)</span>` : ''}</td><td><a href="${path(`/incidents/${row.id}`)}">Open timeline</a></td></tr>`;
    })}</tbody></table></div>`;
    }
    return layout({ title: 'Raid timeline', active: 'incidents', session, access, moduleStates, body });
}

// ── One incident ─────────────────────────────────────────────────────────

const ACTION_LABELS = [
    ['ban', 'Bans'], ['kick', 'Kicks'], ['mute', 'Mutes'], ['warn', 'Warnings'],
    ['gate_kick', 'Join gate kicks'], ['gate_flag', 'Join gate flags'], ['automod', 'Automod without a case'], ['mass_block', 'Mass-action blocks'],
];

function fact(label, value) {
    return html`<div class="fact"><dt>${label}</dt><dd><b>${value}</b></dd></div>`;
}

/** Bars for one field of the chart buckets (heights in 10 % steps), with a text alternative. */
export function minuteChart(chart, field, label) {
    const { buckets, bucketMinutes } = chart;
    const max = Math.max(1, ...buckets.map((b) => b[field]));
    const total = buckets.reduce((sum, b) => sum + b[field], 0);
    const every = Math.max(1, Math.ceil(buckets.length / 6));
    const step = bucketMinutes === 1 ? 'minute' : `${bucketMinutes} minutes`;
    return html`<div class="chart chart-wide" role="img" aria-label="${label} per ${step}: ${total} in total over ${buckets.length} bars. The minute by minute list below has every event.">${buckets.map((b, i) => html`<div class="bar" title="${hhmm(b.start)} UTC: ${b[field]}"><i class="h-${Math.round((b[field] / max) * 10)}"></i><span class="bar-label">${i % every === 0 ? hhmm(b.start) : ''}</span></div>`)}</div>`;
}

function itemRow(item, names) {
    const kind = EVENT_KINDS[item.kind];
    let what;
    if (item.kind === 'case') {
        what = html`${typeBadge(item.caseType)} ${person(item.targetId, names, item.targetName)} <a href="${path(`/cases/${item.code}`)}">case ${item.code}</a>${item.detail ? html` <span class="muted">${item.detail}</span>` : ''}`;
    } else if (item.kind === 'join' || item.kind === 'leave') {
        what = html`<b>${kind.label}</b> ${person(item.targetId, names)}${item.detail ? html` <span class="tag">${item.detail}</span>` : ''}`;
    } else {
        const target = item.targetId ? html` ${person(item.targetId, names)}` : '';
        const actor = item.actorId && item.kind !== 'dashboard' ? html` <span class="muted">by</span> ${person(item.actorId, names)}` : '';
        what = html`<b>${kind.label}</b>${target}${item.detail ? html`: ${item.detail}` : ''}${actor}`;
    }
    return html`<li class="tl-${item.kind}"><span class="muted">${clock(item.at)}</span> ${what}</li>`;
}

function minuteSummary(counts) {
    return [
        counts.joins ? plural(counts.joins, 'join') : null,
        counts.leaves ? plural(counts.leaves, 'leave') : null,
        counts.actions ? plural(counts.actions, 'action') : null,
        counts.steps ? plural(counts.steps, 'lockdown step') : null,
    ].filter(Boolean).join(' · ');
}

function minuteList(minutes, names) {
    if (!minutes.length) return html`<p class="empty">Nothing was recorded for this incident.</p>`;
    const open = minutes.length <= 5;
    const out = [];
    let previous = null;
    for (const minute of minutes) {
        if (previous !== null) {
            const gap = Math.round((minute.start - previous) / MINUTE_MS) - 1;
            if (gap > 0) out.push(html`<li class="minute-gap muted">${plural(gap, 'quiet minute')}</li>`);
        }
        const day = previous === null || new Date(previous).toISOString().slice(0, 10) !== new Date(minute.start).toISOString().slice(0, 10)
            ? `${new Date(minute.start).toISOString().slice(0, 10)} ` : '';
        out.push(html`<li class="minute"><details${open ? html` open` : ''}><summary><b>${day}${hhmm(minute.start)} UTC</b> <span class="muted">${minuteSummary(minute.counts)}</span></summary>
<ol class="timeline">${minute.items.map((item) => itemRow(item, names))}</ol></details></li>`);
        previous = minute.start;
    }
    return html`<ol class="minutes">${out}</ol>`;
}

/** timeline: buildTimeline() result, or null when it could not be read. names: Map id → name. */
export function incidentDetailPage({ session, access = null, moduleStates = {}, timeline = null, names = new Map() }) {
    const back = html`<p><a href="${path('/incidents')}">All incidents</a></p>`;
    if (!timeline) {
        const body = html`<header class="page-head">${back}<h1>Raid timeline</h1></header><p class="error" role="alert">This incident could not be loaded (database). Reload the page to try again.</p>`;
        return layout({ title: 'Raid timeline', active: 'incidents', session, access, moduleStates, body });
    }
    const h = timeline.header;
    const notes = [
        h.dropped ? html`<p class="notice">Only the first ${MAX_EVENTS_PER_INCIDENT} lockdown, join gate and automod events were kept; ${h.dropped} more happened.</p>` : '',
        h.truncated?.members || h.truncated?.cases || h.truncated?.audit ? html`<p class="notice">This incident is very large: only the first rows of joins and leaves, cases or dashboard changes are shown.</p>` : '',
        h.status === 'unread' ? html`<p class="notice">Whether this lockdown is still running could not be read (database). Reload the page to try again.</p>` : '',
        h.status === 'unknown' ? html`<p class="notice">The end of this lockdown was not recorded (for example the bot restarted on an older version). The timeline ends with the last event.</p>` : '',
    ];
    const body = html`<header class="page-head">${back}<h1>Raid on ${formatDate(h.started)}</h1><p class="muted">${h.trigger}. Times are UTC.</p></header>
${notes}
<dl class="facts">
${fact('Started', formatDate(h.started))}
${fact('Ended', statusText(h))}
${fact('Duration', `${formatSpan(h.durationMs)}${h.status === 'ongoing' ? ' so far' : ''}`)}
${fact('Joined', h.joins)}
${fact('Left', h.leaves)}
${h.raidJoiners === null ? '' : fact('Raid joiners', h.raidJoiners)}
${h.endedBy ? fact('Ended by', person(h.endedBy, names)) : ''}
</dl>
<section class="card"><h2>What was done</h2>
<div class="scroll"><table><thead><tr>${ACTION_LABELS.map(([, label]) => html`<th>${label}</th>`)}</tr></thead><tbody><tr>${ACTION_LABELS.map(([key]) => html`<td>${h.actions[key]}</td>`)}</tr></tbody></table></div>
<p class="facts-line"><b>Verification level:</b> ${h.verification || 'Not recorded'}</p>
<p class="facts-line"><b>Invites and DMs:</b> ${h.panic || 'Not recorded'}</p>
${h.released ? html`<p class="facts-line"><b>Non-offenders released:</b> ${formatDate(h.released.at)} by ${person(h.released.by, names)}</p>` : ''}
</section>
<section class="card"><h2>Joins and actions <span class="muted">· ${timeline.chart.bucketMinutes === 1 ? 'per minute' : `per ${timeline.chart.bucketMinutes} minutes`}</span></h2>
<p class="muted">Joins:</p>${minuteChart(timeline.chart, 'joins', 'Joins')}
<p class="muted">Actions (cases, join gate, automod, mass-action guard):</p>${minuteChart(timeline.chart, 'actions', 'Actions')}</section>
<section class="card"><h2>Minute by minute <span class="muted">· ${plural(timeline.total, 'event')}</span></h2>
${minuteList(timeline.minutes, names)}</section>`;
    return layout({ title: 'Raid timeline', active: 'incidents', session, access, moduleStates, body });
}
