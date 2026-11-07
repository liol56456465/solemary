// pages.js — the dashboard's records pages, the audit page and the module page frame. Pure: data in, HTML string out. Every value
// goes through the escaping `html` template (html.js).

import { formatDuration, ladderStageShort, LADDER_STAGE_BANS } from '../enforcement/format.js';
import { SEARCH_STATUSES, SEARCH_TYPES } from '../enforcement/caseSearchService.js';
import { ACTION_LABELS, countedWarnsText } from '../enforcement/flowBuilder.js';
import { nextWarningSteps, nextWarningText } from '../enforcement/standingService.js';
import { caseStatusCode, caseStatusLabel } from '../enforcement/caseService.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { STATS_PERIODS } from '../staffActivityService.js';
import { escapeHtml, formatAge, html, icon, layout, navItems, navLabel, path, queryString, raw, section, timeTag, typeBadge } from './html.js';
import { currentText, dashboardText, namespaceOf } from './language.js';
import { fixPermissionsLink, moduleSwitch } from './forms.js';

const IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** Only Discord CDN https URLs may be shown as images (matches the CSP img-src). */
export function isAllowedImageUrl(url) {
    try {
        const parsed = new URL(String(url));
        return parsed.protocol === 'https:' && IMAGE_HOSTS.has(parsed.hostname);
    } catch {
        return false;
    }
}

/** http(s) links only; anything else (javascript:, data:, …) is shown as text. */
export function isSafeLink(url) {
    try {
        const parsed = new URL(String(url));
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
        return false;
    }
}

function link(url, label = url) {
    return isSafeLink(url)
        ? html`<a href="${url}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>`
        : html`<span>${label}</span>`;
}

const caseLink = (code) => html`<a href="/dashboard/cases/${encodeURIComponent(code)}"><code>${code}</code></a>`;

function statusClass(label) {
    if (/active|pending/.test(label)) return 'warn';
    if (/removed|lifted|reversed/.test(label)) return 'muted';
    return '';
}

function option(value, label, selected) {
    return html`<option value="${value}"${selected ? raw(' selected') : ''}>${label}</option>`;
}

// ── Enforcement words in the page's language ──────────────────────────────
// The enforcement services return English (also used in Discord). English pages keep exactly
// those words; other languages build the same facts from the dashboard catalog (cases.json).

const isEnglish = (tr) => tr.lang === 'en';

/** A case's status: caseStatusCode → cases.status.<code>; English: caseStatusLabel. */
export function caseStatusText(row, appealStatus = null, tr = currentText()) {
    if (isEnglish(tr)) return caseStatusLabel(row, appealStatus);
    const code = caseStatusCode(row, appealStatus);
    return tr.has(`cases.status.${code}`) ? tr.t(`cases.status.${code}`) : code;
}

// The English status words (caseStatusLabel) → their code, for pages that get the label only.
const STATUS_CODE_OF = Object.freeze({
    'removed (a mistake)': 'voided', 'lifted by appeal': 'liftedByAppeal', 'reversed by a moderator': 'reversed', 'lifted early': 'lifted',
    'appeal pending': 'appealPending', 'active, appeal denied': 'activeAppealDenied', expired: 'expired', active: 'active',
});
/** An English status label (from caseStatusLabel) in the page's language. */
export function statusLabelText(label, tr = currentText()) {
    if (isEnglish(tr)) return label;
    const code = STATUS_CODE_OF[label];
    return code && tr.has(`cases.status.${code}`) ? tr.t(`cases.status.${code}`) : label;
}

/** "Ban", "Remove warn" … (ACTION_LABELS) in the page's language. */
export function actionLabelText(type, tr = currentText()) {
    if (isEnglish(tr) || !tr.has(`cases.action.${type}`)) return ACTION_LABELS[type] ?? type;
    return tr.t(`cases.action.${type}`);
}

/** "1 of 3 (7-day ban)" (ladderStageShort) in the page's language. */
export function stageText(level, tr = currentText()) {
    if (isEnglish(tr)) return ladderStageShort(level);
    const n = Math.max(0, Math.min(3, Number(level) || 0));
    if (n === 0) return tr.t('cases.stage.none');
    const ms = LADDER_STAGE_BANS[n];
    if (ms == null) return tr.t('cases.stage.permanent', { n });
    return tr.tp('cases.stage.days', Math.round(ms / (24 * 60 * 60 * 1000)), { n });
}

/** "Warning stage 1 of 3 (7-day ban)" (ladderStageLabel) in the page's language. */
export function stageLabelText(level, tr = currentText()) {
    return isEnglish(tr) ? `Warning stage ${ladderStageShort(level)}` : tr.t('cases.stage.label', { stage: stageText(level, tr) });
}

/** "2 months 3 days" (formatDuration) in the page's language. */
export function durationIn(ms, tr = currentText()) {
    if (isEnglish(tr)) return formatDuration(ms);
    if (ms == null) return tr.t('cases.duration.permanent');
    const sizes = [['month', 30 * 86400000], ['day', 86400000], ['hour', 3600000], ['minute', 60000]];
    const parts = [];
    let rest = ms;
    for (const [unit, size] of sizes) {
        const count = Math.floor(rest / size);
        if (count > 0) {
            parts.push(tr.tp(`cases.duration.${unit}`, count));
            rest -= count * size;
        }
    }
    return parts.slice(0, 2).join(' ') || tr.t('cases.duration.underMinute');
}

/** "3 d", "5 h", "12 min" (formatAge) in the page's language. */
export function ageIn(value, now = Date.now(), tr = currentText()) {
    if (isEnglish(tr)) return formatAge(value, now);
    const minutes = Math.floor(Math.max(0, now - new Date(value).getTime()) / 60000);
    if (minutes < 60) return tr.t('cases.age.minutes', { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return tr.t('cases.age.hours', { n: hours });
    return tr.t('cases.age.days', { n: Math.floor(hours / 24) });
}

/** "1 of 3" / "0 (next warn bans)" (countedWarnsText) in the page's language. */
export function countedWarnsIn(ladder, tr = currentText()) {
    if (isEnglish(tr)) return countedWarnsText(ladder);
    return ladder.level === 0
        ? tr.t('cases.warns.of', { n: ladder.warns_since_level, max: enforcementConfig.warnsPerLevel })
        : tr.t('cases.warns.nextBans', { n: ladder.warns_since_level });
}

/** What the next warning would do (nextWarningText) in the page's language. */
export function nextWarningIn(ladder, tr = currentText()) {
    if (isEnglish(tr)) return nextWarningText(ladder);
    const step = nextWarningSteps(ladder);
    const ban = step.banMs == null ? tr.t('cases.duration.permanentLower') : durationIn(step.banMs, tr);
    if (step.escalates) return tr.t('cases.next.limit', { ban, stage: step.nextLevel });
    const after = step.left === 1 ? tr.t('cases.next.oneAfter', { ban }) : tr.tp('cases.next.moreAfter', step.left, { ban });
    return `${tr.t('cases.next.would', { n: step.warnNumber, max: step.threshold })} ${after}`;
}

/** A date + time: "2026-10-27 14:03 UTC" in English (formatDate), the language's own format otherwise. */
export const dateIn = (value, tr = currentText()) => tr.fmtDateTime(value);

// ── Settings (read-only table of registry values) ─────────────────────────

/**
 * Current values of a module's registry settings. rows: [{ key, label, display, source }]
 * where `display` is text or SafeHtml (channel/role names resolved by the caller).
 */
export function settingsSection(rows = [], title = null) {
    if (!rows.length) return '';
    const tr = currentText();
    const source = (s) => (['database', 'env', 'default'].includes(s) ? tr.t(`cases.settings.source.${s}`) : s);
    return html`<h2>${title ?? tr.t('cases.settings.title')}</h2>
<div class="scroll"><table><thead><tr><th>${tr.t('cases.settings.setting')}</th><th>${tr.t('cases.settings.value')}</th><th>${tr.t('cases.settings.source.title')}</th></tr></thead><tbody>
${rows.map((row) => html`<tr><td>${row.label} <span class="muted"><code>${row.key}</code></span></td><td>${row.display}</td><td class="muted">${source(row.source)}</td></tr>`)}
</tbody></table></div>`;
}

// ── Cases ─────────────────────────────────────────────────────────────────

/**
 * input: { session, query (raw strings as typed), rows, total, page, pageSize, error,
 * statusLabel(row) }.
 */
export function casesPage({ session, access = null, moduleStates = {}, query = {}, rows = [], total = 0, page = 0, pageSize = 25, error = null, statusLabel = (r) => r.status, exportDays = null, canExport = false, canBulk = false, flash = null, saved = [], canSaveSearch = false }) {
    const tr = dashboardText(session?.lang);
    const { t, tx } = tr;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const keep = { member: query.member, moderator: query.moderator, type: query.type, status: query.status, text: query.text, from: query.from, to: query.to, tag: query.tag };
    const pager = html`<div class="pager">
${page > 0 ? html`<a href="/dashboard/cases${queryString({ ...keep, page: page - 1 })}">${t('cases.pager.newer')}</a>` : ''}
<span class="muted">${t('frame.pager.pageOf', { page: tr.fmtNumber(page + 1), pages: tr.fmtNumber(pages) })} · ${tr.tp('cases.list.count', total)}</span>
${page + 1 < pages ? html`<a href="/dashboard/cases${queryString({ ...keep, page: page + 1 })}">${t('cases.pager.older')}</a>` : ''}
</div>`;
    const filtered = Object.values(keep).some(Boolean);
    const exportLine = !canExport ? '' : exportDays === null
        ? html`<p class="muted">${tx('cases.list.exportPlan', { plans: html`<a href="/pricing">${t('cases.list.plans')}</a>` })}</p>`
        : html`<p><a class="btn" href="/dashboard/cases/export.csv" download>${t('cases.list.download')}</a> <span class="muted">${Number.isFinite(exportDays) ? tr.tp('cases.list.exportDays', exportDays) : t('cases.list.exportAll')}</span></p>`;
    const typeOption = (v) => (tr.has(`cases.type.${v}`) ? t(`cases.type.${v}`) : v);
    const statusOption = (v) => (tr.has(`cases.searchStatus.${v}`) ? t(`cases.searchStatus.${v}`) : v);
    const body = html`<header class="page-head"><h1>${t('cases.list.title')}</h1><p class="muted">${t('cases.list.help')}</p>${exportLine}</header>
<form class="filters" method="get" action="/dashboard/cases">
<label>${t('cases.filter.member')}<input name="member" value="${query.member || ''}" inputmode="numeric" maxlength="20"></label>
<label>${t('cases.filter.moderator')}<input name="moderator" value="${query.moderator || ''}" inputmode="numeric" maxlength="20"></label>
<label>${t('cases.filter.type')}<select name="type">${option('', t('cases.filter.any'), !query.type)}${SEARCH_TYPES.map((v) => option(v, typeOption(v), query.type === v))}</select></label>
<label>${t('cases.filter.status')}<select name="status">${option('', t('cases.filter.any'), !query.status)}${SEARCH_STATUSES.map((s) => option(s, statusOption(s), query.status === s))}</select></label>
<label>${t('cases.filter.text')}<input name="text" value="${query.text || ''}" maxlength="100"></label>
<label>${t('cases.filter.tag')}<input name="tag" value="${query.tag || ''}" maxlength="21" placeholder="${t('cases.filter.tagPlaceholder')}"></label>
<label>${t('cases.filter.from')}<input type="date" name="from" value="${query.from || ''}"></label>
<label>${t('cases.filter.to')}<input type="date" name="to" value="${query.to || ''}"></label>
<button class="primary" type="submit">${t('cases.filter.search')}</button> <a href="/dashboard/cases">${t('cases.filter.clear')}</a>
</form>
${saved.length ? html`<p class="saved-searches">${t('cases.saved.label')} ${saved.map((s, i) => html`${i ? ' · ' : ''}<a href="/dashboard/cases${queryString(s.query)}">${s.name}</a>${canSaveSearch ? html` <form method="post" action="/dashboard/cases/searches/delete" class="inline-form"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="name" value="${s.name}"><button type="submit" class="link-button" aria-label="${t('cases.saved.deleteLabel', { name: s.name })}">${t('cases.saved.delete')}</button></form>` : ''}`)}</p>` : ''}
${canSaveSearch && filtered ? html`<form method="post" action="/dashboard/cases/searches/save" class="inline-form save-search"><input type="hidden" name="csrf" value="${session.csrf}">${Object.entries(keep).filter(([, v]) => v).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<label>${t('cases.saved.saveAs')} <input name="name" maxlength="40" required placeholder="${t('cases.saved.namePlaceholder')}"></label> <button type="submit">${t('cases.saved.save')}</button></form>` : ''}
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="bad">${error}</p>` : ''}
${rows.length && canBulk ? html`<form method="post" action="/dashboard/cases/bulk" id="bulk-cases" class="filters bulk-cases"><input type="hidden" name="csrf" value="${session.csrf}">
<label>${t('cases.bulk.with')}<select name="action"><option value="tag-add">${t('cases.bulk.tagAdd')}</option><option value="tag-remove">${t('cases.bulk.tagRemove')}</option><option value="void">${t('cases.bulk.void')}</option></select></label>
<label>${t('cases.filter.tag')}<input name="tag" maxlength="21" placeholder="scam"></label>
<label class="wide">${t('cases.bulk.reason')}<input name="reason" maxlength="500"></label>
<button class="primary" type="submit">${t('cases.bulk.apply')}</button></form>
<p class="muted">${t('cases.bulk.help')}</p>` : ''}
${rows.length ? html`<div class="scroll"><table><thead><tr>${canBulk ? html`<th><span class="sr">${t('cases.table.select')}</span></th>` : ''}<th>${t('cases.table.case')}</th><th>${t('cases.table.type')}</th><th>${t('cases.table.member')}</th><th>${t('cases.table.moderator')}</th><th>${t('cases.table.reason')}</th><th>${t('cases.table.date')}</th><th>${t('cases.table.status')}</th></tr></thead><tbody>
${rows.map((row) => {
        const label = statusLabel(row);
        return html`<tr>${canBulk ? html`<td><input type="checkbox" name="codes" value="${row.case_code}" form="bulk-cases" aria-label="${t('cases.table.selectCase', { code: row.case_code })}"></td>` : ''}<td>${caseLink(row.case_code)}</td><td>${typeBadge(row.type)}${row.is_test ? html` <span class="muted">${t('cases.test')}</span>` : ''}</td>
<td>${row.target_username} <span class="muted">${row.target_user_id}</span></td><td>${row.moderator_username}</td>
<td>${row.reason}</td><td>${timeTag(row.created_at)}</td><td class="${statusClass(label)}">${statusLabelText(label, tr)}</td></tr>`;
    })}
</tbody></table></div>${pager}` : error ? '' : filtered
        ? html`<p class="empty">${t('cases.list.noMatch')} <a href="/dashboard/cases">${t('cases.list.clearFilters')}</a></p>`
        : html`<p class="empty">${t('cases.list.empty')}</p>`}`;
    return layout({ title: t('cases.list.title'), active: 'cases', session, access, moduleStates, body });
}

// ── Case detail ───────────────────────────────────────────────────────────

function durationText(record, tr) {
    if (record.type === 'warn' || record.type === 'kick') return '-';
    if (!record.duration_ms) return record.type === 'ban' ? tr.t('cases.duration.permanentLower') : '-';
    return durationIn(Number(record.duration_ms), tr);
}

function evidenceItem({ row, freshUrl }, tr) {
    const meta = html`<span class="muted">#${row.id} · ${row.added_by_username} · ${dateIn(row.added_at, tr)}</span>`;
    const note = row.note ? html`<div>${row.note}</div>` : '';
    if (row.kind === 'image') {
        const image = freshUrl && isAllowedImageUrl(freshUrl)
            ? html`<a href="${freshUrl}" rel="noopener noreferrer" target="_blank"><img src="${freshUrl}" alt="${tr.t('cases.evidence.imageAlt', { id: row.id })}" loading="lazy" referrerpolicy="no-referrer"></a>`
            : html`<div class="muted">${tr.t('cases.evidence.imageGone')}</div>`;
        return html`<li>${meta}${note}${image}</li>`;
    }
    return html`<li>${meta} ${row.url ? link(row.url) : ''}${note}${row.excerpt ? html`<blockquote>${row.excerpt}</blockquote>` : ''}</li>`;
}

/** input: { session, record, statusLabel, edits, evidence: [{ row, freshUrl }], appeals }. */
export function caseDetailPage({ session, access = null, moduleStates = {}, record, statusLabel, edits = [], evidence = [], appeals = [], notes = [], top = '', bottom = '' }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const d = (v) => dateIn(v, tr);
    const r = record;
    const appealStatus = (s) => (tr.has(`cases.appealStatus.${s}`) ? t(`cases.appealStatus.${s}`) : s);
    const body = html`<a class="back" href="/dashboard/cases">${t('cases.detail.back')}</a>
<h1 class="title-with-badge">${t('cases.detail.case')} <code data-copy="${r.case_code}">${r.case_code}</code> ${typeBadge(r.type)}${r.is_test ? html` <span class="muted">${t('cases.test')}</span>` : ''}</h1>
${top}
<section class="card"><dl>
<dt>${t('cases.detail.name')}</dt><dd>${r.name}</dd>
<dt>${t('cases.table.status')}</dt><dd class="${statusClass(statusLabel)}">${statusLabelText(statusLabel, tr)}</dd>
<dt>${t('cases.table.member')}</dt><dd><a href="/dashboard/users/${encodeURIComponent(r.target_user_id)}">${r.target_username}</a> <span class="muted">${r.target_user_id}</span> · <a href="/dashboard/cases${queryString({ member: r.target_user_id })}">${t('cases.detail.allTheirCases')}</a></dd>
<dt>${t('cases.table.moderator')}</dt><dd>${r.moderator_username} <span class="muted">${r.moderator_id}</span>${r.is_auto ? t('cases.detail.automatic') : ''}</dd>
<dt>${t('cases.table.reason')}</dt><dd>${r.reason}${r.reason_key ? html` <span class="muted">(${r.reason_key})</span>` : ''}</dd>
<dt>${t('cases.detail.created')}</dt><dd>${d(r.created_at)}</dd>
<dt>${t('cases.detail.duration')}</dt><dd>${durationText(r, tr)}</dd>
${r.expires_at ? html`<dt>${t('cases.detail.ends')}</dt><dd>${d(r.expires_at)}</dd>` : ''}
${r.appeal_deadline ? html`<dt>${t('cases.detail.appealDeadline')}</dt><dd>${d(r.appeal_deadline)}</dd>` : ''}
<dt>${t('cases.detail.canAppeal')}</dt><dd>${r.unappealable ? t('cases.detail.no') : t('cases.detail.yes')}</dd>
<dt>${t('cases.detail.dmDelivered')}</dt><dd>${r.dm_delivered ? t('cases.detail.yesLower') : t('cases.detail.noLower')}</dd>
<dt>${t('cases.detail.stageAfter')}</dt><dd>${r.ladder_level_after == null ? '-' : stageText(r.ladder_level_after, tr)}</dd>
<dt>${t('cases.detail.tags')}</dt><dd>${r.tags?.length ? r.tags.map((tag) => html`<a class="role-chip" href="/dashboard/cases${queryString({ tag })}">#${tag}</a>`) : html`<span class="muted">${t('cases.detail.none')}</span>`}</dd>
${r.revoked_at ? html`<dt>${t('cases.detail.liftedEarly')}</dt><dd>${d(r.revoked_at)}${r.revoke_reason ? html`: ${r.revoke_reason}` : ''}</dd>` : ''}
${r.voided_at ? html`<dt>${t('cases.detail.removed')}</dt><dd>${d(r.voided_at)}${r.void_reason ? html`: ${r.void_reason}` : ''}</dd>` : ''}
</dl></section>
${section(t('cases.detail.history', { count: edits.length }), html`${edits.length ? html`<div class="scroll"><table><thead><tr><th>${t('cases.detail.when')}</th><th>${t('cases.detail.by')}</th><th>${t('cases.detail.field')}</th><th>${t('cases.detail.old')}</th><th>${t('cases.detail.new')}</th></tr></thead><tbody>
${edits.map((e) => html`<tr><td>${d(e.edited_at)}</td><td>${e.edited_by_username}</td><td>${e.field}</td><td>${e.old_value ?? '-'}</td><td>${e.new_value ?? '-'}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">${t('cases.detail.neverEdited')}</p>`}`, '', { key: 'case-history', open: false })}
${section(t('cases.detail.notes', { count: notes.length }), notes.length ? html`<ul class="evidence">${notes.map((n) => html`<li><span class="muted">${n.author_username || n.author_id} · ${d(n.created_at)}</span><div>${n.text}</div></li>`)}</ul>` : html`<p class="muted">${t('cases.detail.noNotes')}</p>`, '', { key: 'case-notes', open: notes.length > 0 })}
${section(t('cases.detail.evidence', { count: evidence.length }), evidence.length ? html`<ul class="evidence">${evidence.map((item) => evidenceItem(item, tr))}</ul>` : html`<p class="muted">${t('cases.detail.noEvidence')}</p>`, '', { key: 'case-evidence' })}
${section(t('cases.detail.appeals', { count: appeals.length }), html`${appeals.length ? html`<div class="scroll"><table><thead><tr><th>${t('cases.detail.filed')}</th><th>${t('cases.table.status')}</th><th>${t('cases.detail.decided')}</th><th>${t('cases.detail.by')}</th><th>${t('cases.detail.note')}</th></tr></thead><tbody>
${appeals.map((a) => html`<tr><td>${d(a.created_at)}</td><td>${appealStatus(a.status)}</td><td>${d(a.decided_at)}</td><td>${a.decided_by_username || '-'}</td><td>${a.note || ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">${t('cases.detail.noAppeals')}</p>`}`, '', { key: 'case-appeals', open: appeals.length > 0 })}
${bottom}`;
    return layout({ title: t('cases.detail.title', { code: r.case_code }), active: 'cases', session, access, moduleStates, body });
}

// ── Appeals ───────────────────────────────────────────────────────────────

export function appealsPage({ session, access = null, moduleStates = {}, settingsRows = [], appeals = [], now = Date.now(), flash = null, canWrite = false }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const body = html`<header class="page-head"><h1>${t('cases.appeals.title', { count: appeals.length })}</h1><p>${t('cases.appeals.help')}</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${appeals.length ? html`<div class="scroll"><table><thead><tr><th>${t('cases.table.case')}</th><th>${t('cases.table.type')}</th><th>${t('cases.table.member')}</th><th>${t('cases.detail.filed')}</th><th>${t('cases.appeals.waiting')}</th><th></th></tr></thead><tbody>
${appeals.map((a) => {
        const days = (now - new Date(a.created_at).getTime()) / 86400000;
        return html`<tr><td>${caseLink(a.case_code)}${a.needsSecondReviewer ? html` <span class="warn" title="${t('cases.appeals.secondReviewerTitle')}">${t('cases.appeals.secondReviewer')}</span>` : ''}</td><td>${typeBadge(a.type)}${a.is_test ? ` ${t('cases.test')}` : ''}</td><td>${a.username} <span class="muted">${a.user_id}</span></td>
<td>${dateIn(a.created_at, tr)}</td><td class="${days >= 3 ? 'bad' : days >= 1 ? 'warn' : ''}">${ageIn(a.created_at, now, tr)}</td>
<td><a href="/dashboard/appeals/${encodeURIComponent(a.case_code)}">${canWrite ? t('cases.appeals.review') : t('cases.appeals.open')}</a></td></tr>`;
    })}
</tbody></table></div><p class="muted">${canWrite ? t('cases.appeals.decideHere') : t('cases.appeals.adminsDecide')}</p>` : html`<p class="empty">${t('cases.appeals.empty')}</p>`}`;
    return layout({ title: t('cases.appeals.pageTitle'), active: 'appeals', session, access, moduleStates, body: html`${body}${settingsSection(settingsRows)}` });
}

// ── Staff stats ───────────────────────────────────────────────────────────

/** "last 30 days" (STATS_PERIODS label) in the page's language. */
export function periodLabel(key, tr = currentText()) {
    if (isEnglish(tr) || !tr.has(`staffPage.period.${key}`)) return STATS_PERIODS[key]?.label;
    return tr.t(`staffPage.period.${key}`);
}

/** input: { session, period, rows (staffModerationStats) }. */
export function statsPage({ session, access = null, moduleStates = {}, settingsRows = [], period = '30d', rows = [], sections = [], flash = null, error = null }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const periodChips = html`<nav class="chips" aria-label="${t('staffPage.stats.period')}">${Object.keys(STATS_PERIODS).map((key) => html`<a class="chip${key === period ? ' is-active' : ''}" href="/dashboard/staff${queryString({ period: key })}"${key === period ? raw(' aria-current="page"') : ''}>${periodLabel(key, tr)}</a>`)}</nav>`;
    const table = html`${rows.length ? html`<div class="scroll"><table><thead><tr><th>${t('staffPage.stats.moderator')}</th><th>${t('staffPage.stats.total')}</th><th>${t('staffPage.stats.bans')}</th><th>${t('staffPage.stats.kicks')}</th><th>${t('staffPage.stats.mutes')}</th><th>${t('staffPage.stats.warns')}</th><th>${t('staffPage.stats.accepted')}</th><th>${t('staffPage.stats.denied')}</th><th>${t('staffPage.stats.removed')}</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td><a href="/dashboard/cases${queryString({ moderator: r.moderatorId })}">${r.username}</a></td><td>${r.total}</td><td>${r.actions.ban}</td><td>${r.actions.kick}</td><td>${r.actions.mute}</td><td>${r.actions.warn}</td><td>${r.appealsAccepted}</td><td>${r.appealsDenied}</td><td>${r.voided}</td></tr>`)}
</tbody></table></div><p class="muted">${t('staffPage.stats.note')}</p>` : html`<p class="empty">${t('staffPage.stats.empty')}</p>`}`;
    const body = html`<header class="page-head"><h1>${t('staffPage.title')}</h1><p>${t('staffPage.help')}</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${section(t('staffPage.stats.title', { period: periodLabel(period, tr) || period }), html`${periodChips}${table}`, '', { key: 'staff-stats' })}
${sections}`;
    return layout({ title: t('staffPage.title'), active: 'staff', session, access, moduleStates, body: html`${body}${settingsSection(settingsRows, t('staffPage.settings'))}` });
}

// ── Audit ─────────────────────────────────────────────────────────────────

const AUDIT_VALUE_PREVIEW = 120;
/** An audited value; a long one shows its start, the rest behind "Show all" (nothing is dropped). */
export function auditValue(value, tr = currentText()) {
    if (value === null || value === undefined) return tr.t('audit.none');
    const full = typeof value === 'string' ? value : JSON.stringify(value);
    if (full.length <= AUDIT_VALUE_PREVIEW) return full;
    return html`<details class="long-value"><summary>${full.slice(0, AUDIT_VALUE_PREVIEW)}… <span class="muted">${tr.t('audit.showAll', { count: tr.fmtNumber(full.length) })}</span></summary><div class="long-value-full">${full}</div></details>`;
}

/**
 * input: { rows (dashboard_audit, newest first), total, page, pageSize, filters: { user, module },
 * users: [{ user_id, username }], modules: [{ key, label }] }.
 */
export function auditPage({ session, access = null, moduleStates = {}, rows = [], total = rows.length, page = 0, pageSize = 50, filters = {}, users = [], modules = [] }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const keep = { user: filters.user, module: filters.module };
    const pager = html`<div class="pager">
${page > 0 ? html`<a href="/dashboard/audit${queryString({ ...keep, page: page - 1 })}">${t('cases.pager.newer')}</a>` : ''}
<span class="muted">${t('frame.pager.pageOf', { page: tr.fmtNumber(page + 1), pages: tr.fmtNumber(pages) })} · ${tr.tp('audit.count', total)}</span>
${page + 1 < pages ? html`<a href="/dashboard/audit${queryString({ ...keep, page: page + 1 })}">${t('cases.pager.older')}</a>` : ''}
</div>`;
    const navItem = (key) => navItems().find((i) => i.key === key);
    const moduleLabel = (key) => (navItem(key) ? navLabel(navItem(key), tr) : null) || modules.find((m) => m.key === key)?.label || key;
    const body = html`<header class="page-head"><h1>${t('audit.title')}</h1><p class="muted">${t('audit.help')}</p></header>
<form class="filters" method="get" action="/dashboard/audit">
<label>${t('audit.who')}<select name="user">${option('', t('audit.anyone'), !filters.user)}${users.map((u) => option(u.user_id, `${u.username || u.user_id} (${u.user_id})`, filters.user === u.user_id))}</select></label>
<label>${t('audit.module')}<select name="module">${option('', t('cases.filter.any'), !filters.module)}${modules.map((m) => option(m.key, navItem(m.key) && navItem(m.key).label === m.label ? navLabel(navItem(m.key), tr) : m.label, filters.module === m.key))}</select></label>
<button class="primary" type="submit">${t('audit.filter')}</button> <a href="/dashboard/audit">${t('cases.filter.clear')}</a>
</form>
${rows.length ? html`<div class="scroll"><table><thead><tr><th>${t('cases.detail.when')}</th><th>${t('audit.who')}</th><th>${t('audit.module')}</th><th>${t('audit.setting')}</th><th>${t('cases.detail.old')}</th><th>${t('cases.detail.new')}</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td>${timeTag(r.created_at)}</td><td>${r.username || r.user_id || '-'} <span class="muted">${r.user_id || ''}</span></td><td>${moduleLabel(r.module)}</td><td><code>${r.key}</code></td><td class="value">${auditValue(r.old, tr)}</td><td class="value">${auditValue(r.new, tr)}</td></tr>`)}
</tbody></table></div>${pager}` : filters.user || filters.module
        ? html`<p class="empty">${t('audit.noMatch')} <a href="/dashboard/audit">${t('cases.list.clearFilters')}</a></p>`
        : html`<p class="empty">${t('audit.empty')}</p>`}`;
    return layout({ title: t('audit.title'), active: 'audit', session, access, moduleStates, body });
}

// ── Module (settings) pages ───────────────────────────────────────────────

/**
 * "On this page": jump links above the cards of a settings page. Pages grouped by topic
 * list their topics (two or more); other pages list their cards (four or more). Titles
 * are read from the page's own markup (already escaped).
 */
function sectionLinks(body, tr = currentText()) {
    const text = String(body);
    const topics = [...text.matchAll(/<section class="topic" id="(g-[a-z0-9-]+)"><header class="topic-head"><h2>([^<]+)<\/h2>/g)];
    const cards = [...text.matchAll(/<section class="tile-card[^"]*" id="(s-[a-z0-9-]+)"[^>]*><header class="card-top"><h[23] class="card-title"[^>]*>([^<]+)<\/h[23]>/g)];
    const found = topics.length >= 2 ? topics : cards.length >= 4 ? cards : [];
    if (!found.length) return '';
    return html`<nav class="section-links" aria-label="${tr.t('frame.module.onThisPage')}"><span class="section-links-label">${tr.t('frame.module.onThisPage')}</span>${found.map(([, id, title]) => html`<a href="#${id}">${raw(title)}</a>`)}</nav>`;
}

/**
 * The error of a refused form, inside that form (its section), linked to the field it is
 * about (aria-invalid + aria-describedby). `action` only selects the form; nothing from it
 * is written into the page. null when the form is not on the page (the caller then shows
 * the error at the top).
 */
/** " Fix permissions" after a refusal that carries { channelId, perms } (see forms.js fixPermissionsLink). */
function fixLinkOf(fix) {
    if (!fix || typeof fix !== 'object') return '';
    const link = fixPermissionsLink(fix.channelId, fix.perms);
    return link ? html` ${link}` : '';
}

export function placeFormError(body, { moduleKey, action, field, message, fix = null }, tr = currentText()) {
    const text = String(body);
    const marker = `action="${path(`/${moduleKey}/${action}`)}"`;
    const at = action ? text.indexOf(marker) : -1;
    if (at === -1) return null;
    const open = text.indexOf('>', at) + 1;
    const close = text.indexOf('</form>', open);
    let form = text.slice(open, close === -1 ? text.length : close);
    if (field) {
        const name = `name="${escapeHtml(field)}"`;
        if (form.includes(name)) form = form.replace(name, `${name} aria-invalid="true" aria-describedby="form-error"`);
    }
    const note = html`<p class="error form-error" role="alert" id="form-error">${tr.t('frame.module.notSaved', { message })}${fixLinkOf(fix)}</p>`;
    return raw(`${text.slice(0, open)}${note}${form}${close === -1 ? '' : text.slice(close)}`);
}

/**
 * The frame of a module page: title, help line, read-only / Administrator notices, the
 * flash message after a save, the error of a refused form (inside that form when it can
 * be found, else at the top), then the module's body.
 */
export function moduleSettingsPage({ session, access = null, moduleStates = {}, module, body, flash = null, error = null, errorAction = null, errorField = null, errorFix = null, warnings = [], editEnabled = false }) {
    const tr = dashboardText(session?.lang);
    const placed = error ? placeFormError(body, { moduleKey: module.key, action: errorAction, field: errorField, message: error, fix: errorFix }, tr) : null;
    if (placed) {
        body = placed;
        error = null;
    }
    const notices = html`${!editEnabled ? html`<p class="notice">${tr.tx('frame.module.readOnly')}</p>` : ''}
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}${fixLinkOf(errorFix)}</p>` : ''}
${warnings.length ? html`<ul class="warnings">${warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}`;
    const item = navItems().find((i) => i.key === module.key) || {};
    const state = item.toggle && Object.hasOwn(moduleStates, item.state) ? moduleStates[item.state] : null;
    const canEdit = Boolean(editEnabled && session && access?.canView !== false);
    // Title: the sidebar's word for the page (same English label); help line: <namespace>.page.help
    // when the module's catalog has it (docs/dashboard-i18n.md), else the module's own English line.
    const title = item.key && item.label === module.label ? navLabel(item, tr) : module.label;
    const helpKey = `${namespaceOf(module.key)}.page.help`;
    // helpParams: names a help line shows literally (Welcome's {user}, {server} …), mapped to themselves.
    const help = tr.has(helpKey) ? tr.t(helpKey, module.helpParams) : module.help;
    const main = state === null ? '' : moduleSwitch({ csrf: session?.csrf, canEdit, module: module.key, action: item.toggle, enabled: state, label: title, lang: tr.lang });
    const head = html`<header class="module-header"><span class="module-icon" aria-hidden="true">${icon(module.key)}</span>
<div class="module-title"><h1>${title}</h1>${help ? html`<p class="help">${help}</p>` : ''}</div>${main ? html`<div class="module-main">${main}</div>` : ''}</header>`;
    // v6: "On this page" as a row of jump links, then the cards in a grid (grouped by topic
    // on the busy pages: each topic has its own grid).
    const links = sectionLinks(body, tr);
    const grouped = String(body).includes('<section class="topic"');
    const page = html`${head}<div class="settings-layout">${links}<div class="settings-main">${notices}${grouped ? body : html`<div class="card-grid">${body}</div>`}</div></div>`;
    return layout({ title, active: module.key, session, access, moduleStates, body: page, lang: tr.lang });
}
