// enforcementPages.js — Phase 3 pages: member lookup and member page (standing, notes,
// cases, actions), the action confirm page, appeal detail and its confirm page,
// no-contact orders, the staff coverage heatmap and mass-action blocks, and the
// action forms on a case page. Pure: data in, HTML out, everything escaped by the
// `html` template. No inline styles or scripts (CSP).
//
// Text: the members / cases / staff namespaces of the dashboard catalog (docs/dashboard-i18n.md).
// Words that come from the enforcement services (status, warning stage, durations) go through
// the helpers in pages.js, which keep the services' English on English pages.

import { ENFORCEMENT_REASONS, CUSTOM_REASON_KEY } from '../../config/enforcement.js';
import { RECORD_ACTIONS } from '../enforcement/flowBuilder.js';
import { MAX_LINKS_PER_FORM, NOTE_MAX as EVIDENCE_NOTE_MAX } from '../enforcement/evidenceService.js';
import { NO_CONTACT_MAX_DAYS } from '../enforcement/noContactService.js';
import { NOTE_MAX } from '../enforcement/staffNotesService.js';
import { WEEKDAYS, intensityLevel, slotLabel } from '../staffCoverageService.js';
import { html, icon, layout, path, queryString, raw, section, typeBadge } from './html.js';
import { currentText, dashboardText } from './language.js';
import {
    actionLabelText, ageIn, caseStatusText, countedWarnsIn, dateIn, isAllowedImageUrl, isSafeLink, nextWarningIn, stageLabelText, stageText,
} from './pages.js';
import { JOINED_FILTERS, SORTS, STATE_FILTERS } from './membersData.js';
import { BAN_FILTERS } from './bansData.js';
import { NICKNAME_MAX, REASON_MAX, TIMEOUTS, timeoutLabel } from './memberActions.js';
import { BULK_ACTIONS, BULK_LIMIT, bulkActionLabel } from './bulkActions.js';
import { TEMP_ROLE_LENGTHS } from '../members/tempRoleService.js';
import { memberField, parseUserRef } from './memberSearch.js';

export const DURATION_CHOICES = ['30m', '1h', '6h', '12h', '1d', '3d', '7d', '14d', '1mo', '3mo'];

const caseHref = (code) => path(`/cases/${encodeURIComponent(code)}`);
const userHref = (id) => path(`/users/${encodeURIComponent(id)}`);
const caseLink = (code) => html`<a href="${caseHref(code)}"><code>${code}</code></a>`;

function link(url, label = url) {
    return isSafeLink(url) ? html`<a href="${url}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>` : html`<span>${label}</span>`;
}

/** "ban", "remove warn", "time out": an action as a lowercase word in a sentence. */
const actionVerb = (type, tr) => tr.t(`cases.actionVerb.${type}`);

/** act: what View only is about: actions | cases | appeals | orders. */
function notices({ flash = null, error = null, editEnabled = true, canAct = true, act = 'actions' } = {}, tr = currentText()) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">${tr.tx('members.notice.readOnly')}</p>`
        : !canAct ? html`<p class="notice">${tr.tx(`members.notice.viewOnly.${act}`)}</p>` : ''}`;
}

/**
 * A POST form to any dashboard path, with the CSRF token; disabled when `enabled` is
 * false. `submit: null` leaves the button out (the fields bring their own).
 */
export function actionForm(csrf, actionPath, fields, { submit = currentText().t('members.form.save'), hidden = {}, danger = false, secondary = false, inline = false, enabled = true, className = '', multipart = false, confirm = '' } = {}) {
    const classes = [inline ? 'inline-form' : 'settings-form', className].filter(Boolean).join(' ');
    const attrs = html`${multipart ? raw(' enctype="multipart/form-data"') : ''}${confirm ? html` data-confirm="${confirm}"` : ''}`;
    return html`<form method="post" action="${path(actionPath)}" class="${classes}"${attrs}><input type="hidden" name="csrf" value="${csrf}">
${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<fieldset${enabled ? '' : raw(' disabled')}>${fields}${enabled && submit !== null ? html`<button type="submit" class="${danger ? 'danger' : secondary ? 'secondary' : 'primary'}">${submit}</button>` : ''}</fieldset></form>`;
}

/**
 * The buttons of a confirm page: [Confirm] posts the one-time token back, [Cancel] is a
 * link back (a plain GET, so it never changes anything).
 */
export function confirmButtons(csrf, actionPath, { submit, hidden = {}, danger = true, cancelHref }) {
    return html`<form method="post" action="${path(actionPath)}" class="settings-form confirm-form"><input type="hidden" name="csrf" value="${csrf}">
${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<div class="buttons"><button type="submit" class="${danger ? 'danger' : 'primary'}">${submit}</button> <a class="btn" href="${cancelHref}">${currentText().t('members.confirm.cancel')}</a></div></form>`;
}

/**
 * A confirm page: what will happen (rows of label/value, an optional list, notes), then
 * [Confirm] [Cancel]. Used where a tick box or a typed word used to stand in for this step.
 * rows: [{ label, value }]; list: { title, items: [text] } | null; notes: [text].
 */
export function confirmPage({ session, access = null, moduleStates = {}, active = null, title, heading, rows = [], list = null, notes = [], actionPath, hidden = {}, submit, danger = true, cancelHref }) {
    const tr = dashboardText(session?.lang);
    const body = html`<p><a href="${cancelHref}">${tr.t('members.confirm.back')}</a></p>
<h1>${heading}</h1>
<section class="card confirm-card">${rows.length ? html`<dl>${rows.map((row) => html`<dt>${row.label}</dt><dd>${row.value}</dd>`)}</dl>` : ''}
${list ? html`<h2>${list.title}</h2><ul class="name-list">${list.items.map((item) => html`<li>${item}</li>`)}</ul>` : ''}
${notes.map((n) => html`<p class="muted">${n}</p>`)}
<p class="muted">${tr.t('members.confirm.nothingYet')}</p>
${confirmButtons(session.csrf, actionPath, { submit, hidden, danger, cancelHref })}</section>`;
    return layout({ title, active, session, access, moduleStates, body });
}

function option(value, label, selected = false) {
    return html`<option value="${value}"${selected ? raw(' selected') : ''}>${label}</option>`;
}

export const MEMBER_TABS = { list: ['Members', '/users'], rules: ['Role rules', '/users/rules'], insights: ['Insights', '/users/insights'] };

/** The tab row of the Members area (chips; the current one has aria-current). */
export function memberTabs(active, tr = currentText()) {
    return html`<nav class="chips member-tabs" aria-label="${tr.t('members.tabs.label')}">${Object.entries(MEMBER_TABS).map(([key, [, href]]) => html`<a class="chip" href="${path(href)}"${key === active ? raw(' aria-current="page"') : ''}>${tr.t(`members.tabs.${key}`)}</a>`)}</nav>`;
}

// ── Member lookup ─────────────────────────────────────────────────────────

/** input: { q, results: [{ id, username, globalName, nickname, bot }], error }. */
/**
 * The Members list: every member of the main server (50 per page) with filters, roles, join
 * date, counted warns and whether they are muted now. list from membersData.listMembers;
 * filters = the current query; roles = [{ id, name }] for the role filter. An ID in the search
 * box opens that member's page (also people who are not in the server).
 */
export function membersPage({ session, access = null, moduleStates = {}, list, filters = {}, roles = [], error = null, loading = false, canWrite = false }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const opt = (value, label, current) => html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`;
    const keep = { q: filters.q, role: filters.role, joined: filters.joined, state: filters.state, sort: filters.sort };
    const pageLink = (page, label) => html`<a class="btn" href="${path(`/users${queryString({ ...keep, page: page || '' })}`)}">${label}</a>`;
    const rows = list?.rows || [];
    const roleCell = (row) => (row.roles.length
        ? html`${row.roles.slice(0, 3).map((r) => html`<span class="role-chip">@${r.name}</span>`)}${row.roles.length > 3 ? html`<span class="muted"> +${row.roles.length - 3}</span>` : ''}`
        : html`<span class="muted">${t('members.list.noRoles')}</span>`);
    const warnCell = (row) => (row.level > 0 ? html`${t('members.list.level', { n: row.level })}${row.warns ? html` · ${tr.tp('members.list.warns', row.warns)}` : ''}`
        : row.warns ? t('members.list.warnsOf', { n: row.warns }) : html`<span class="muted">-</span>`);
    const tick = (row) => (canWrite ? html`<td class="tick"><input type="checkbox" name="ids" value="${row.id}" form="bulk-form" aria-label="${t('members.list.select', { name: row.displayName })}"></td>` : '');
    const table = rows.length ? html`<div class="table-wrap"><table class="members"><thead><tr>${canWrite ? html`<th class="tick"><input type="checkbox" data-select-all="ids" aria-label="${t('members.list.selectAll')}"></th>` : ''}<th>${t('members.list.member')}</th><th>${t('members.list.roles')}</th><th>${t('members.list.joined')}</th><th>${t('members.list.warnsHead')}</th><th>${t('members.list.state')}</th></tr></thead><tbody>
${rows.map((row) => html`<tr>${tick(row)}<td><a class="member-cell" href="${userHref(row.id)}">${row.avatarUrl && isAllowedImageUrl(row.avatarUrl)
        ? html`<img class="avatar-sm" src="${row.avatarUrl}" alt="" width="32" height="32" loading="lazy" referrerpolicy="no-referrer">`
        : html`<span class="avatar-sm" aria-hidden="true">${row.displayName.slice(0, 1).toUpperCase()}</span>`}<span><b>${row.displayName}</b>${row.bot ? html` <span class="tag">bot</span>` : ''}<small>${row.username} · ${row.id}</small></span></a></td>
<td class="roles-cell">${roleCell(row)}</td><td class="nowrap">${row.joinedAt ? html`<time datetime="${new Date(row.joinedAt).toISOString()}" data-relative>${dateIn(new Date(row.joinedAt), tr)}</time>` : html`<span class="muted">${t('members.list.unknown')}</span>`}</td>
<td class="nowrap">${warnCell(row)}</td><td>${row.muted ? html`<span class="state-word is-warn"><span class="dot dot-warn" aria-hidden="true"></span>${t('members.list.muted')}</span>` : html`<span class="muted">-</span>`}</td></tr>`)}
</tbody></table></div>
<nav class="pager" aria-label="${t('frame.pager.label')}"><span class="muted">${t('frame.pager.pageOf', { page: tr.fmtNumber(list.page + 1), pages: tr.fmtNumber(list.pages) })} · ${tr.tp('members.list.count', list.total)}</span>${list.page > 0 ? pageLink(list.page - 1, t('frame.pager.previous')) : ''}${list.page + 1 < list.pages ? pageLink(list.page + 1, t('frame.pager.next')) : ''}</nav>`
        : ['q', 'role', 'joined', 'state'].some((key) => filters[key])
            ? html`<p class="empty">${t('members.list.noMatch')} <a href="${path('/users')}">${t('members.list.clearFilters')}</a></p>`
            : html`<p class="empty">${t('members.list.empty')}</p>`;
    // Quick filters as chips (the other filters stay as they are); the bulk form folds away.
    const chips = html`<nav class="chips" aria-label="${t('members.list.show')}">${Object.entries(STATE_FILTERS).map(([k, v]) => html`<a class="chip" href="${path(`/users${queryString({ ...keep, state: k, page: '' })}`)}"${(filters.state || '') === k ? raw(' aria-current="page"') : ''}>${v}</a>`)}</nav>`;
    const count = list ? html`${tr.tp('members.list.count', list.total)}${list.memberCount && list.total !== list.memberCount ? t('members.list.ofTotal', { total: tr.fmtNumber(list.memberCount) }) : ''}` : '';
    const body = html`<header class="page-head"><h1>${t('members.list.title')}</h1><p class="muted">${count ? html`${count} · ` : ''}${t('members.list.help')}</p></header>
${memberTabs('list', tr)}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${list && list.memberCount && list.cached < list.memberCount * 0.9 ? html`<p class="notice">${t('members.list.stillLoading', { cached: tr.fmtNumber(list.cached), total: tr.fmtNumber(list.memberCount) })}</p>` : ''}
${loading ? html`<p class="notice">${t('members.list.unavailable')}</p>` : ''}
${chips}
<form class="filters" method="get" action="${path('/users')}" role="search"><input type="hidden" name="state" value="${filters.state || ''}">
<label class="wide-filter">${t('members.list.search')}<input type="search" name="q" value="${filters.q || ''}" maxlength="40" autocomplete="off" placeholder="${t('members.list.searchPlaceholder')}"></label>
<label>${t('members.list.role')}<select name="role">${opt('', t('members.list.anyRole'), filters.role || '')}${roles.map((r) => opt(r.id, `@${r.name}`, filters.role))}</select></label>
<label>${t('members.list.joined')}<select name="joined">${Object.entries(JOINED_FILTERS).map(([k, v]) => opt(k, v, filters.joined || ''))}</select></label>
<label>${t('members.list.sort')}<select name="sort">${Object.entries(SORTS).map(([k, v]) => opt(k, v, filters.sort || 'joined_desc'))}</select></label>
<button class="primary" type="submit">${t('members.list.apply')}</button> <a href="${path('/users')}">${t('members.list.clear')}</a></form>
${canWrite && list?.rows?.length ? html`<details class="bulk-wrap"><summary class="btn">${icon('users')}${t('members.bulk.summary')}<span class="muted">${t('members.bulk.summaryHint')}</span></summary>${bulkForm(session.csrf, list, filters, roles, tr)}</details>` : ''}
${list ? table : ''}`;
    return layout({ title: t('members.list.title'), active: 'users', session, access, moduleStates, body });
}

/** The Banned page: Discord's ban list joined with the open ban cases; Unban runs on the member page. */
export function bansPage({ session, access = null, moduleStates = {}, list, filters = {}, error = null, canAct = false }) {
    const tr = dashboardText(session?.lang);
    const { t, tx } = tr;
    const keep = { q: filters.q, filter: filters.filter };
    const chips = html`<nav class="chips" aria-label="${t('members.list.show')}">${Object.entries(BAN_FILTERS).map(([k, v]) => html`<a class="chip" href="${path(`/bans${queryString({ ...keep, filter: k, page: '' })}`)}"${(filters.filter || '') === k ? raw(' aria-current="page"') : ''}>${v}</a>`)}</nav>`;
    const pageLink = (page, label) => html`<a class="btn" href="${path(`/bans${queryString({ ...keep, page: page || '' })}`)}">${label}</a>`;
    const kind = (row) => {
        if (!row.record) return html`<span class="muted">${t('members.bans.noCase')}</span>`;
        const ladder = row.record.is_auto ? html` <span class="muted">· ${stageLabelText(row.record.ladder_level_after, tr)}</span>` : '';
        return row.permanent ? html`${t('members.bans.permanent')}${ladder}` : html`${t('members.bans.until', { date: dateIn(row.record.expires_at, tr) })}${ladder}`;
    };
    const rows = list?.rows || [];
    const table = rows.length ? html`<div class="table-wrap"><table class="members"><thead><tr><th>${t('members.list.member')}</th><th>${t('cases.table.reason')}</th><th>${t('cases.table.case')}</th><th>${t('members.bans.ban')}</th><th></th></tr></thead><tbody>
${rows.map((row) => html`<tr><td><a class="member-cell" href="${userHref(row.id)}">${row.avatarUrl && isAllowedImageUrl(row.avatarUrl)
        ? html`<img class="avatar-sm" src="${row.avatarUrl}" alt="" width="32" height="32" loading="lazy" referrerpolicy="no-referrer">`
        : html`<span class="avatar-sm" aria-hidden="true">${row.displayName.slice(0, 1).toUpperCase()}</span>`}<span><b>${row.displayName}</b><small>${row.username} · ${row.id}</small></span></a></td>
<td>${row.reason || html`<span class="muted">${t('members.bans.noReason')}</span>`}</td>
<td class="nowrap">${row.record ? html`${caseLink(row.record.case_code)}${row.record.status === 'appeal_pending' ? html`<br><a class="state-word is-warn" href="${path(`/appeals/${encodeURIComponent(row.record.case_code)}`)}"><span class="dot dot-warn" aria-hidden="true"></span>${t('members.bans.appealPending')}</a>` : ''}` : html`<span class="muted">-</span>`}</td>
<td>${kind(row)}${row.record ? html`<br><small class="muted">${t('members.bans.by', { name: row.record.moderator_username, date: dateIn(row.record.created_at, tr) })}</small>` : ''}</td>
<td class="nowrap"><a class="btn small" href="${userHref(row.id)}#s-member-actions">${canAct ? t('members.bans.unban') : t('members.bans.open')}<span class="sr"> ${row.displayName}</span></a></td></tr>`)}
</tbody></table></div>
<nav class="pager" aria-label="${t('frame.pager.label')}"><span class="muted">${t('frame.pager.pageOf', { page: tr.fmtNumber(list.page + 1), pages: tr.fmtNumber(list.pages) })} · ${tr.tp('members.bans.count', list.total)}</span>${list.page > 0 ? pageLink(list.page - 1, t('frame.pager.previous')) : ''}${list.page + 1 < list.pages ? pageLink(list.page + 1, t('frame.pager.next')) : ''}</nav>`
        : list && (filters.q || filters.filter)
            ? html`<p class="empty">${t('members.bans.noMatch')} <a href="${path('/bans')}">${t('members.bans.showAll')}</a></p>`
            : list ? html`<p class="empty">${t('members.bans.empty')}</p>` : '';
    const body = html`<header class="page-head"><h1>${t('members.bans.title')}</h1><p class="muted">${list ? html`${t('members.bans.bannedCount', { count: tr.fmtNumber(list.banned) })} · ` : ''}${tx('members.bans.help')}</p></header>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${list?.truncated ? html`<p class="notice" role="status">${t('members.bans.truncated', { count: tr.fmtNumber(list.banned) })}</p>` : ''}
${list ? html`${chips}<form class="filters" method="get" action="${path('/bans')}" role="search"><input type="hidden" name="filter" value="${filters.filter || ''}">
<label class="wide-filter">${t('members.list.search')}<input type="search" name="q" value="${filters.q || ''}" maxlength="40" autocomplete="off" placeholder="${t('members.bans.searchPlaceholder')}"></label>
<button class="primary" type="submit">${t('cases.filter.search')}</button> <a href="${path('/bans')}">${t('members.list.clear')}</a></form>${table}` : ''}`;
    return layout({ title: t('members.bans.title'), active: 'bans', session, access, moduleStates, body });
}

// ── Member page ───────────────────────────────────────────────────────────

function standingSection(view, tr) {
    const { t, tx } = tr;
    const d = (v) => dateIn(v, tr);
    const { state, countedWarns = [], appealStatuses = new Map() } = view;
    const ladder = state.ladder;
    const active = [];
    if (state.activeBan) {
        active.push(state.activeBan.expires_at
            ? tx('members.standing.banEnds', { case: caseLink(state.activeBan.case_code), date: d(state.activeBan.expires_at) })
            : tx('members.standing.banPermanent', { case: caseLink(state.activeBan.case_code) }));
    } else if (state.banned) active.push(tx('members.standing.bannedOutside'));
    if (state.activeMute) active.push(tx('members.standing.muteEnds', { case: caseLink(state.activeMute.case_code), date: d(state.activeMute.expires_at) }));
    else if (state.muted) active.push(tx('members.standing.mutedRole'));
    const pending = [...appealStatuses].filter(([, status]) => status === 'pending').map(([code]) => code);
    return html`<dl>
<dt>${t('members.standing.counted')}</dt><dd>${countedWarnsIn(ladder, tr)}${countedWarns.length ? html` · ${countedWarns.map((w, i) => html`${i ? ', ' : ''}${caseLink(w.case_code)}`)}` : ''}</dd>
<dt>${t('members.standing.stage')}</dt><dd>${stageText(ladder.level, tr)}</dd>
<dt>${t('members.standing.next')}</dt><dd>${nextWarningIn(ladder, tr)}</dd>
<dt>${t('members.standing.active')}</dt><dd>${active.length ? active.map((a, i) => html`${i ? '; ' : ''}${a}`) : t('members.standing.none')}</dd>
<dt>${t('members.standing.pending')}</dt><dd>${pending.length ? pending.map((code, i) => html`${i ? ', ' : ''}<a href="${path(`/appeals/${encodeURIComponent(code)}`)}"><code>${code}</code></a>`) : t('members.standing.none')}</dd>
</dl>`;
}

/**
 * The member page header: avatar, name, ID, joined date, and the standing at a glance
 * (counted warns, ladder level, what is active). The full details follow in sections.
 */
function memberHeader(view, now, tr) {
    const { t } = tr;
    const { user, member, state } = view;
    const avatar = user.avatarUrl && isAllowedImageUrl(user.avatarUrl)
        ? html`<img class="avatar" src="${user.avatarUrl}" alt="" width="64" height="64" referrerpolicy="no-referrer">`
        : html`<span class="avatar avatar-initials-lg" aria-hidden="true">${String(user.username || '?').slice(0, 1).toUpperCase()}</span>`;
    const joined = member ? (member.joinedAt ? t('members.header.joined', { date: dateIn(member.joinedAt, tr) }) : t('members.header.inServer')) : t('members.header.notInServer');
    const ladder = state.ladder;
    const active = state.activeBan || state.banned ? 'banned' : state.activeMute || state.muted ? 'muted' : null;
    return html`<header class="member-header">${avatar}<div class="member-title"><h1>${user.username}${user.bot ? html` <span class="tag">bot</span>` : ''}</h1>
<p class="muted"><span class="nowrap">${t('members.header.id', { id: user.id })}</span><span class="nowrap">${joined}</span></p></div>
<ul class="member-facts"><li><span class="label">${t('members.standing.counted')}</span><span class="value">${countedWarnsIn(ladder, tr)}</span></li>
<li><span class="label">${t('members.standing.stage')}</span><span class="value">${stageText(ladder.level, tr)}</span></li>
<li><span class="label">${t('members.header.active')}</span><span class="value">${active === null ? t('members.header.none') : html`<span class="dot dot-bad" aria-hidden="true"></span>${t(`members.header.${active}`)}`}</span></li></ul></header>`;
}

function profileSection(user, member, now, tr) {
    const { t } = tr;
    const d = (v) => dateIn(v, tr);
    const avatar = user.avatarUrl && isAllowedImageUrl(user.avatarUrl)
        ? html`<img class="avatar" src="${user.avatarUrl}" alt="" width="64" height="64" referrerpolicy="no-referrer">` : '';
    const roles = member?.roles || [];
    return html`<div class="profile">${avatar}<dl>
<dt>${t('members.profile.username')}</dt><dd>${user.username}${user.bot ? html` <span class="tag">bot</span>` : ''} <span class="muted">${user.id}</span></dd>
<dt>${t('members.profile.displayName')}</dt><dd>${user.globalName || '-'}</dd>
${member ? html`<dt>${t('members.profile.nickname')}</dt><dd>${member.nickname || '-'}</dd>` : ''}
<dt>${t('members.profile.created')}</dt><dd>${t('members.profile.dateAgo', { date: d(user.createdAt), age: ageIn(user.createdAt, now, tr) })}</dd>
<dt>${t('members.profile.inServer')}</dt><dd>${member ? (member.joinedAt ? t('members.profile.yesJoined', { date: d(member.joinedAt), age: ageIn(member.joinedAt, now, tr) }) : t('members.profile.yesUnknown')) : t('members.profile.no')}</dd>
${member ? html`<dt>${t('members.profile.roles', { count: roles.length })}</dt><dd>${roles.length ? roles.map((r, i) => html`${i ? ', ' : ''}@${r.name}`) : t('members.standing.none')}</dd>` : ''}
</dl></div>`;
}

/**
 * Roles, nickname and timeout of a member in the server: current roles (with Remove where this
 * moderator may take them), a role picker of the roles they may give, nickname, timeout. When
 * the member cannot be changed (owner, bot, yourself, equal or higher role) it says why.
 */
/** The bulk card under the Members list: what to do with the ticked members (or everyone matching). */
function bulkForm(csrf, list, filters, roles, tr = currentText()) {
    const { t, tx } = tr;
    const canAll = list.total <= BULK_LIMIT;
    return html`<form class="card bulk" id="bulk-form" method="post" action="${path('/users/bulk/preview')}"><input type="hidden" name="csrf" value="${csrf}">
${['q', 'joined', 'state', 'sort'].map((k) => html`<input type="hidden" name="${k}" value="${filters[k] || ''}">`)}<input type="hidden" name="frole" value="${filters.role || ''}">
<fieldset class="bulk-scope"><legend class="sr">${t('members.bulk.which')}</legend>
<label class="check"><input type="radio" name="scope" value="selected" checked> ${t('members.bulk.ticked')}</label>
<label class="check"><input type="radio" name="scope" value="filter"${canAll ? '' : raw(' disabled')}> ${t('members.bulk.everyone', { count: tr.fmtNumber(list.total) })}${canAll ? '' : html` <span class="muted">${t('members.bulk.tooMany', { max: BULK_LIMIT })}</span>`}</label></fieldset>
<div class="grid">
<label>${t('members.bulk.doThis')}<select name="action" required><option value="">${t('members.form.choose')}</option>${Object.keys(BULK_ACTIONS).map((k) => html`<option value="${k}">${bulkActionLabel(k, tr)}</option>`)}</select></label>
<label class="only-role">${t('members.list.role')}<select name="roleId" data-search><option value="">${t('members.form.choose')}</option>${roles.map((r) => html`<option value="${r.id}">@${r.name}</option>`)}</select></label>
<label class="only-role-add">${t('members.form.for')}<select name="for"><option value="">${t('members.form.permanently')}</option>${Object.entries(TEMP_ROLE_LENGTHS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></label>
<label class="only-timeout">${t('members.form.timeoutLength')}<select name="timeout"><option value="">${t('members.form.choose')}</option>${Object.keys(TIMEOUTS).map((k) => html`<option value="${k}">${timeoutLabel(k, tr)}</option>`)}</select></label>
<label class="only-record">${t('cases.table.reason')}<select name="reasonKey">${ENFORCEMENT_REASONS.map((r) => html`<option value="${r.key}">${r.label}</option>`)}<option value="${CUSTOM_REASON_KEY}">${t('members.form.custom')}</option></select></label>
<label class="only-record">${t('members.form.customReason')}<input name="custom_reason" maxlength="500"><span class="hint">${tx('members.bulk.customHint')}</span></label>
<label class="only-ban">${t('members.bulk.banLength')}<input name="duration" maxlength="20" placeholder="${t('members.bulk.banLengthPlaceholder')}"></label>
<label class="only-plain">${t('members.form.reasonAudit')}<input name="reason" maxlength="${REASON_MAX}"></label>
</div>
<p class="muted">${t('members.bulk.note', { max: BULK_LIMIT })}</p>
<div class="form-actions"><button type="submit" class="primary">${t('members.form.preview')}</button></div></form>`;
}

/** Who a bulk action will change and who is skipped (with the reason); Run needs the one-time token. */
export function bulkPreviewPage({ session, access = null, moduleStates = {}, action, label, role, timeout, plan, token, hash, guardLeft, precedent = null }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const forLength = timeout ? t('members.bulk.forLength', { length: timeout.label }) : '';
    const what = `${label}${role ? ` @${role.name}` : ''}${forLength}`;
    const destructive = action === 'kick' || action === 'ban';
    const n = tr.tp('members.list.count', plan.run.length);
    const verb = {
        'role-add': () => `${t('members.bulk.verb.roleAdd', { role: role?.name, members: n })}${forLength}`,
        'role-remove': () => t('members.bulk.verb.roleRemove', { role: role?.name, members: n }),
        timeout: () => t('members.bulk.verb.timeout', { members: n }),
        kick: () => t('members.bulk.verb.kick', { members: n }),
        ban: () => t('members.bulk.verb.ban', { members: n }),
    }[action]?.() || `${label} ${n}`;
    const body = html`<a class="back" href="${path('/users')}">${t('members.back')}</a>
<header class="page-head"><h1>${what}: ${n}</h1><p class="muted">${t('members.bulk.check')}</p></header>
${precedent ? html`<p class="muted">${precedent}</p>` : ''}
${destructive && Number.isFinite(guardLeft) ? html`<p class="notice">${tr.tp('members.bulk.guard', guardLeft)}</p>` : ''}
<section class="card"><h2>${t('members.bulk.willChange', { count: plan.run.length })}</h2>${plan.run.length ? html`<ul class="name-list">${plan.run.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a></li>`)}</ul>` : html`<p class="empty">${t('members.bulk.nobody')}</p>`}</section>
${plan.skipped.length ? html`<section class="card"><h2>${t('members.bulk.skipped', { count: plan.skipped.length })}</h2><ul class="skip-list">${plan.skipped.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a><span class="muted">${m.why}</span></li>`)}</ul></section>` : ''}
${plan.run.length ? html`<section class="card confirm-card"><p class="muted">${t('members.bulk.runs')}${destructive ? ` ${t('members.bulk.sameDm')}` : ''} ${t('members.confirm.once')}</p>
${confirmButtons(session.csrf, '/users/bulk/execute', { submit: verb, hidden: { token, fh: hash }, danger: destructive, cancelHref: path('/users') })}</section>` : ''}`;
    return layout({ title: t('members.bulk.title', { what }), active: 'users', session, access, moduleStates, body });
}

/** Progress of a bulk job; reloads itself every 2 s while running (meta refresh, CSP-safe). */
export function bulkJobPage({ session, access = null, moduleStates = {}, job }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const running = !job.finishedAt;
    const doneCount = job.done.length + job.failed.length;
    const body = html`<a class="back" href="${path('/users')}">${t('members.back')}</a>
<header class="page-head"><h1>${job.label}</h1><p class="muted">${running ? t('members.job.working', { done: doneCount, total: job.total }) : t('members.job.finished', { done: job.done.length, failed: job.failed.length })}</p></header>
<div class="progress-row"><progress value="${doneCount}" max="${job.total || 1}" aria-label="${t('members.job.progress')}"></progress><span class="muted">${doneCount} / ${job.total}</span></div>
${job.failed.length ? html`<section class="card"><h2>${t('members.job.failed', { count: job.failed.length })}</h2><ul class="skip-list">${job.failed.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a><span class="muted">${m.why}</span></li>`)}</ul></section>` : ''}
${job.done.length ? html`<section class="card"><h2>${t('members.job.done', { count: job.done.length })}</h2><ul class="name-list">${job.done.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a></li>`)}</ul></section>` : ''}`;
    return layout({ title: t('members.bulk.title', { what: job.label }), active: 'users', session, access, moduleStates, body, refreshSeconds: running ? 2 : 0 });
}

/** can: { roles, nickname, timeout, unverify } — what this viewer may change (editing on + permissions.js). */
function memberEditSection(view, can, csrf, tr) {
    const { t, tx } = tr;
    const canWrite = can.roles;
    const id = view.user.id;
    const edit = view.memberEdit;
    const roles = view.member.roles;
    const current = html`<div class="role-list">${roles.length ? roles.map((r) => html`<span class="role-chip role-chip-lg">@${r.name}${edit?.tempRoles?.has(r.id) ? html` <span class="muted">${t('members.edit.until', { date: dateIn(edit.tempRoles.get(r.id), tr) })}</span>` : ''}${canWrite && !edit?.problem && edit?.removable?.has(r.id)
        ? actionForm(csrf, `/users/${id}/roles/remove`, '', { submit: t('members.form.remove'), hidden: { roleId: r.id }, inline: true, secondary: true, className: 'chip-form' }) : ''}</span>`) : html`<span class="muted">${t('members.edit.noRoles')}</span>`}</div>`;
    if (!can.roles && !can.nickname && !can.timeout && !can.unverify) return html`${current}<p class="muted">${t('members.edit.needsAdminEditing')}</p>`;
    if (edit?.problem) return html`${current}<p class="notice">${edit.problem}</p>`;
    const roleForm = edit.assignable.length
        ? actionForm(csrf, `/users/${id}/roles/add`, html`<div class="grid"><label>${t('members.edit.giveRole')}<select name="roleId" data-search required><option value="">${t('members.form.choose')}</option>${edit.assignable.map((r) => html`<option value="${r.id}">@${r.name}</option>`)}</select><span class="hint">${tx('members.edit.giveRoleHint')}</span></label>
<label>${t('members.form.for')}<select name="for"><option value="">${t('members.form.permanently')}</option>${Object.entries(TEMP_ROLE_LENGTHS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select><span class="hint">${t('members.edit.timedHint')}</span></label>
<label>${t('members.form.reasonAudit')}<input name="reason" maxlength="${REASON_MAX}"></label></div>`, { submit: t('members.edit.giveRoleSubmit') })
        : html`<p class="muted">${t('members.edit.noOtherRole')}</p>`;
    const nickForm = actionForm(csrf, `/users/${id}/nickname`, html`<div class="grid"><label>${t('members.profile.nickname')}<input name="nickname" maxlength="${NICKNAME_MAX}" value="${view.member.nickname || ''}" placeholder="${view.user.globalName || view.user.username}"><span class="hint">${t('members.edit.nicknameHint')}</span></label></div>`, { submit: t('members.edit.saveNickname') });
    const timeoutForm = html`${edit.timeoutUntil ? html`<p class="notice">${t('members.edit.timedOutUntil', { date: dateIn(edit.timeoutUntil, tr) })}</p>${actionForm(csrf, `/users/${id}/timeout`, '', { submit: t('members.edit.removeTimeout'), hidden: { duration: 'off' }, inline: true, secondary: true })}` : ''}
${actionForm(csrf, `/users/${id}/timeout`, html`<div class="grid"><label>${t('members.form.timeoutLength')}<select name="duration" required><option value="">${t('members.form.choose')}</option>${Object.keys(TIMEOUTS).map((k) => html`<option value="${k}">${timeoutLabel(k, tr)}</option>`)}</select><span class="hint">${tx('members.edit.timeoutHint')}</span></label>
<label>${t('members.form.reasonAudit')}<input name="reason" maxlength="${REASON_MAX}"></label></div>`, { submit: edit.timeoutUntil ? t('members.edit.changeTimeout') : t('members.edit.timeOut'), confirm: t('members.edit.timeOutConfirm', { name: view.user.username }) })}`;
    const verifyForm = edit.verifiedRole
        ? html`<h3>${t('members.edit.verification')}</h3><p>${t('members.edit.verified', { role: edit.verifiedRole.name })}</p>${actionForm(csrf, `/users/${id}/unverify`, html`<div class="grid"><label>${t('members.edit.unverifyReason')}<input name="reason" maxlength="${REASON_MAX}"></label></div>`, { submit: t('members.edit.unverify'), secondary: true, confirm: t('members.edit.unverifyConfirm', { name: view.user.username, role: edit.verifiedRole.name }) })}`
        : '';
    return html`${current}${can.roles ? roleForm : html`<p class="muted">${t('members.edit.needsAdmin')}</p>`}${can.nickname ? html`<h3>${t('members.profile.nickname')}</h3>${nickForm}` : ''}${can.timeout ? html`<h3>${t('members.edit.timeout')}</h3>${timeoutForm}` : ''}${can.unverify ? verifyForm : ''}`;
}

function notesSection(view, canWrite, csrf, tr) {
    const { t } = tr;
    const notes = view.notes || [];
    const id = view.user.id;
    return html`${notes.length ? html`<div class="scroll"><table><thead><tr><th>#</th><th>${t('members.notes.note')}</th><th>${t('cases.detail.by')}</th><th>${t('cases.detail.when')}</th><th></th></tr></thead><tbody>
${notes.map((note, i) => html`<tr><td>${i + 1}</td><td class="value">${note.content}</td><td>${note.author || t('members.list.unknown')}</td><td>${note.timestamp ? dateIn(note.timestamp, tr) : '-'}</td>
<td>${canWrite ? actionForm(csrf, `/users/${id}/notes/remove`, '', { submit: t('members.form.remove'), hidden: { note: String(note.id ?? '') }, inline: true, danger: true }) : ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${t('members.notes.empty')}</p>`}
${canWrite ? actionForm(csrf, `/users/${id}/notes/add`, html`<label class="wide">${t('members.notes.new')}<textarea name="note" maxlength="${NOTE_MAX}" rows="2" required></textarea></label>`, { submit: t('members.notes.add') }) : ''}`;
}

function casesSection(view, tr) {
    const { t } = tr;
    const { cases = [], casesTotal = 0, appealStatuses = new Map(), user } = view;
    return html`${cases.length ? html`<div class="scroll"><table><thead><tr><th>${t('cases.table.case')}</th><th>${t('cases.table.type')}</th><th>${t('cases.detail.name')}</th><th>${t('cases.table.reason')}</th><th>${t('cases.table.date')}</th><th>${t('cases.table.status')}</th></tr></thead><tbody>
${cases.map((row) => html`<tr><td>${caseLink(row.case_code)}</td><td>${typeBadge(row.type)}${row.is_test ? html` <span class="muted">${t('cases.test')}</span>` : ''}</td><td>${row.name}</td><td>${row.reason}</td>
<td>${dateIn(row.created_at, tr)}</td><td>${caseStatusText(row, appealStatuses.get(row.case_code), tr)}</td></tr>`)}
</tbody></table></div>${casesTotal > cases.length ? html`<p><a href="${path(`/cases${queryString({ member: user.id })}`)}">${tr.tp('members.cases.all', casesTotal)}</a></p>` : ''}` : html`<p class="muted">${t('members.cases.none')}</p>`}`;
}

function noContactSection(orders, names = new Map(), tr = currentText()) {
    if (!orders.length) return '';
    return html`<ul>${orders.map((o) => html`<li>${tr.tx('members.keepApart.item', { name: names.get(o.otherId) || o.otherId, id: html`<span class="muted">${o.otherId}</span>`, date: dateIn(o.until, tr), order: o.id })}</li>`)}</ul>`;
}

function precedentSection(view, tr) {
    const { t } = tr;
    const reasonKey = view.precedentReason || '';
    return html`<form class="filters" method="get" action="${userHref(view.user.id)}">
<label>${t('members.precedent.question')}<select name="reason">${option('', t('members.precedent.choose'), !reasonKey)}${ENFORCEMENT_REASONS.map((r) => option(r.key, r.label, r.key === reasonKey))}</select></label>
<button type="submit">${t('members.precedent.show')}</button></form>
${reasonKey ? html`<p>${view.precedent || html`<span class="muted">${t('members.precedent.none')}</span>`}</p>` : ''}`;
}

function reasonFields(type, values = {}, tr = currentText()) {
    const { t, tx } = tr;
    return html`<label>${t('cases.table.reason')}<select name="reason" required>${ENFORCEMENT_REASONS.map((r) => option(r.key, `${r.label}${type === 'ban' && r.severe ? t('members.action.severe') : ''}`, values.reason === r.key))}${option(CUSTOM_REASON_KEY, t('members.form.custom'), values.reason === CUSTOM_REASON_KEY)}</select></label>
<label>${t('members.form.customReason')}<input name="custom_reason" maxlength="500" value="${values.custom_reason || ''}"><span class="hint">${tx('members.action.customHint')}</span></label>`;
}

function durationField(type, value = '', tr = currentText()) {
    const id = `durations-${type}`;
    return html`<label>${tr.t('cases.detail.duration')}<input name="duration" maxlength="20" list="${id}" value="${value}"${type === 'mute' ? raw(' required') : ''}>
<span class="hint">${type === 'ban' ? tr.t('members.action.banDurationHint') : tr.t('members.action.muteDurationHint')}</span></label>
<datalist id="${id}">${DURATION_CHOICES.map((d) => html`<option value="${d}"></option>`)}</datalist>`;
}

/** One action's form (posts to the preview step). */
function actionBlock(view, type, csrf, values = {}, tr = currentText()) {
    const { t, tx } = tr;
    const id = view.user.id;
    let fields;
    if (RECORD_ACTIONS.has(type)) {
        fields = html`<div class="grid">${reasonFields(type, values, tr)}
${type === 'ban' || type === 'mute' ? durationField(type, values.duration || '', tr) : ''}
${type === 'ban' ? html`<label>${t('cases.detail.canAppeal')}<select name="unappealable">${option('default', t('members.action.appealDefault'), !values.unappealable || values.unappealable === 'default')}${option('no', t('cases.detail.yes'), values.unappealable === 'no')}${option('yes', t('cases.detail.no'), values.unappealable === 'yes')}</select></label>` : ''}
<label>${t('members.action.name')}<input name="name" maxlength="100" value="${values.name || ''}"><span class="hint">${tx('members.action.nameHint', { name: view.user.username, type })}</span></label>
<label class="wide">${t('members.action.evidence')}<textarea name="evidence" rows="2" maxlength="1000">${values.evidence || ''}</textarea><span class="hint">${t('members.action.evidenceHint', { max: MAX_LINKS_PER_FORM })}</span></label></div>`;
    } else {
        fields = html`<div class="grid">${type === 'removewarn' ? html`<label>${t('members.action.warning')}<select name="warn" required>${(view.countedWarns || []).map((w) => option(w.case_code, `${w.case_code} · ${w.name} · ${w.reason}`, values.warn === w.case_code))}</select></label>` : ''}
<label class="wide">${t('members.action.reasonOptional')}<input name="reason" maxlength="500" value="${values.reason || ''}"></label></div>`;
    }
    return html`<details class="action"${values.type === type ? raw(' open') : ''}><summary>${actionLabelText(type, tr)}</summary>
${actionForm(csrf, `/users/${id}/action/preview`, fields, { submit: t('members.form.preview'), hidden: { type } })}</details>`;
}

/**
 * The member page. view: { user: { id, username, globalName, bot, createdAt, avatarUrl },
 * member: { nickname, joinedAt, roles: [name] } | null, state, countedWarns, cases,
 * casesTotal, appealStatuses, noContact, noContactNames, notes, actions, precedentReason,
 * precedent, block }.
 */
/** Everything about the member in date order (memberTimeline.js); null = could not be read. */
function timelineSection(timeline, tr = currentText()) {
    if (timeline === null) return html`<p class="error" role="alert">${tr.t('members.timeline.error')}</p>`;
    if (!timeline?.length) return html`<p class="muted">${tr.t('members.timeline.empty')}</p>`;
    return html`<ol class="timeline">${timeline.map((e) => html`<li class="tl-${e.kind}"><span class="muted">${dateIn(e.at, tr)}</span> ${e.text}${e.code ? html` · ${caseLink(e.code)}` : ''}</li>`)}</ol>
<p class="muted">${tr.t('members.timeline.note')}</p>`;
}

export function userPage({ session, access = null, moduleStates = {}, view, canAct = false, allow = null, editEnabled = false, flash = null, error = null, values = {}, now = Date.now() }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    // allow(key): permissions.js for this viewer (the Moderator level runs some actions); default canAct for everything.
    const may = (key) => Boolean(editEnabled && (allow ? allow(key) : canAct));
    const canWrite = canAct && editEnabled;
    const can = { roles: may('member.roles'), nickname: may('member.nickname'), timeout: may('member.timeout'), unverify: may('member.unverify') };
    const actions = view.actions.filter((type) => may(`action:${type}`));
    const limited = !canAct && actions.length > 0;
    const body = html`<a class="back" href="${path('/users')}">${t('members.back')}</a>
${memberHeader(view, now, tr)}
${notices({ flash, error, editEnabled, canAct: canAct || limited || can.timeout }, tr)}
${editEnabled && !canAct && (limited || can.timeout) ? html`<p class="notice">${t('members.member.moderatorCan', { actions: [...actions.map((type) => actionVerb(type, tr)), ...(can.timeout ? [actionVerb('timeout', tr)] : [])].join(', ') })}</p>` : ''}
${section(t('members.member.profile'), profileSection(view.user, view.member, now, tr), '', { key: 'member-profile', open: false })}
${section(t('members.member.record'), standingSection(view, tr), '', { key: 'member-standing' })}
${view.member ? section(t('members.member.roles', { count: view.member.roles.length }), memberEditSection(view, can, session.csrf, tr), '', { key: 'member-roles' }) : ''}
${(view.noContact || []).length ? section(t('members.member.keepApart'), noContactSection(view.noContact, view.noContactNames, tr), '', { key: 'member-nocontact' }) : ''}
${section(t('members.member.actions'), html`${view.block ? html`<p class="error">${t('members.member.blocked', { date: dateIn(view.block.until, tr) })}</p>` : ''}
${canWrite || limited ? (actions.length ? html`<p class="muted">${t('members.member.sameActions')}</p>${actions.map((type) => actionBlock(view, type, session.csrf, values.type === type ? values : {}, tr))}` : html`<p class="muted">${t('members.member.noActions')}</p>`)
        : html`<p class="muted">${t('members.member.available', { actions: view.actions.map((type) => actionLabelText(type, tr)).join(', ') || t('members.standing.none') })}</p>`}`, '', { key: 'member-actions' })}
${section(t('members.member.precedent'), precedentSection(view, tr), '', { key: 'member-precedent', open: Boolean(view.precedentReason) })}
${section(t('members.member.timeline'), timelineSection(view.timeline, tr), '', { key: 'member-timeline', open: false })}
${section(t('members.member.caseHistory', { count: view.casesTotal || 0 }), casesSection(view, tr), '', { key: 'member-cases', open: false })}
${section(t('members.member.staffNotes', { count: (view.notes || []).length }), notesSection(view, may('member.notes'), session.csrf, tr), '', { key: 'member-notes' })}`;
    return layout({ title: view.user.username, active: 'users', session, access, moduleStates, body });
}

// ── Confirm pages ─────────────────────────────────────────────────────────

/** The confirm step of an action. summary from flowBuilder.flowSummary. */
export function actionConfirmPage({ session, access = null, moduleStates = {}, userId, type, summary, token, hash, block = null }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const label = actionLabelText(type, tr);
    const body = html`<p><a href="${userHref(userId)}">${t('members.confirm.back')}</a></p>
<h1>${t('members.confirm.heading', { action: label })}</h1>
<section class="card confirm-card"><dl>${summary.rows.map((row) => html`<dt>${row.label}</dt><dd>${row.code ? html`<code>${row.value}</code>` : row.value}${row.id ? html` <span class="muted">${row.id}</span>` : ''}</dd>`)}
${summary.evidence.length ? html`<dt>${t('members.confirm.evidence')}</dt><dd><ul class="plain">${summary.evidence.map((e) => html`<li>${link(e.url)}${e.excerpt ? html` <blockquote>${e.excerpt}</blockquote>` : e.unreadable ? html` <span class="muted">${t('members.confirm.unreadable')}</span>` : ''}</li>`)}</ul></dd>` : ''}
${summary.effect ? html`<dt>${t('members.confirm.effect')}</dt><dd>${summary.effect}</dd>` : ''}
</dl>
${summary.notes.map((n) => html`<p>${n}</p>`)}
${summary.precedent ? html`<p class="muted">${summary.precedent}</p>` : ''}
${summary.memberHint ? html`<p class="muted">${summary.memberHint}</p>` : ''}
${summary.ruleHint ? html`<p class="muted">${summary.ruleHint}</p>` : ''}
${block ? html`<p class="error">${t('members.confirm.blocked', { date: dateIn(block.until, tr) })}</p>` : ''}
<p class="muted">${t('members.confirm.once')}</p>
${confirmButtons(session.csrf, `/users/${userId}/action/execute`, { submit: t('members.confirm.submit', { action: actionVerb(type, tr) }), hidden: { token, fh: hash }, cancelHref: userHref(userId) })}</section>`;
    return layout({ title: t('members.confirm.title', { action: label }), active: 'users', session, access, moduleStates, body });
}

// ── Case page actions ─────────────────────────────────────────────────────

/** Edit / void / evidence forms under a case (Administrators, editing on). */
export function caseActions({ record, evidence = [], csrf, canWrite, flash = null, error = null, editEnabled = true, canAct = true }) {
    const tr = currentText();
    const { t, tx } = tr;
    const code = record.case_code;
    const open = ['active', 'appeal_pending'].includes(record.status);
    const timed = (record.type === 'ban' || record.type === 'mute') && open && !record.is_auto && !record.is_imported;
    const top = notices({ flash, error, editEnabled, canAct, act: 'cases' }, tr);
    if (!canWrite) return { top, bottom: '' };
    const bottom = html`<h2>${t('cases.change.title')}</h2>
${record.voided_at ? html`<p class="muted">${t('cases.change.removedNoEdit')}</p>` : html`<div class="card"><h3>${t('cases.change.edit')}</h3>
${actionForm(csrf, `/cases/${code}/edit`, html`<div class="grid"><label class="wide">${t('cases.change.newReason')}<input name="reason" maxlength="500" value="${record.reason}"></label>
${timed ? html`<label>${t('cases.change.newDuration')}<input name="duration" maxlength="20" list="durations-edit" placeholder="${t('cases.change.unchanged')}"><span class="hint">${record.type === 'ban' ? t('cases.change.durationHintBan') : t('cases.change.durationHint')}</span></label>
<datalist id="durations-edit">${DURATION_CHOICES.map((d) => html`<option value="${d}"></option>`)}${record.type === 'ban' ? html`<option value="permanent"></option>` : ''}</datalist>` : ''}</div>`, { submit: t('cases.change.save') })}</div>
<div class="card"><h3>${t('cases.change.remove')}</h3><p class="muted">${t('cases.change.removeHelp')}</p>
${actionForm(csrf, `/cases/${code}/void`, html`<label class="wide">${t('cases.change.removeReason')}<input name="reason" maxlength="500" required></label>
<p class="muted">${t('cases.change.removeNext')}</p>`, { submit: t('cases.change.removeSubmit'), danger: true })}</div>`}
<div class="card"><h3>${t('members.confirm.evidence')}</h3>
${actionForm(csrf, `/cases/${code}/evidence/add`, html`<div class="grid"><label class="wide">${t('cases.change.link')}<input name="link" maxlength="500" required></label>
<label class="wide">${t('cases.change.noteOptional')}<input name="note" maxlength="${EVIDENCE_NOTE_MAX}"></label></div>`, { submit: t('cases.change.addEvidence') })}
${actionForm(csrf, `/cases/${code}/evidence/upload`, html`<div class="grid"><label class="wide">${t('cases.change.image')}<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required></label>
<label class="wide">${t('cases.change.noteOptional')}<input name="note" maxlength="${EVIDENCE_NOTE_MAX}"></label></div>`, { submit: t('cases.change.upload'), multipart: true })}
<p class="muted">${t('cases.change.rehosted')}</p>
${evidence.length ? html`<p>${evidence.map(({ row }) => actionForm(csrf, `/cases/${code}/evidence/remove`, '', { submit: t('cases.change.removeEvidence', { id: row.id }), hidden: { id: String(row.id) }, inline: true, danger: true, confirm: t('cases.change.removeEvidenceConfirm', { id: row.id }) }))}</p>` : ''}</div>
<div class="card"><h3>${t('cases.change.notesTags')}</h3><p class="muted">${t('cases.change.staffOnly')}</p>
${actionForm(csrf, `/cases/${code}/notes`, html`<label class="wide">${t('cases.change.newNote')}<textarea name="text" rows="3" maxlength="1000" required></textarea></label>`, { submit: t('members.notes.add') })}
${actionForm(csrf, `/cases/${code}/tags`, html`<label class="wide">${t('cases.detail.tags')}<input name="tags" maxlength="250" value="${(record.tags || []).join(', ')}" placeholder="scam, alt"><span class="hint">${t('cases.change.tagsHint')}</span></label>`, { submit: t('cases.change.saveTags') })}</div>`;
    return { top, bottom };
}

// ── Appeals ───────────────────────────────────────────────────────────────

/**
 * One appeal with its dossier. data: { record, appeal (pending or latest), answers,
 * history (earlier appeals), others (other cases), othersTotal, ladder, evidence }.
 */
export function appealDetailPage({ session, access = null, moduleStates = {}, data, canWrite = false, flash = null, error = null, editEnabled = true, canAct = true, now = Date.now() }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const d = (v) => dateIn(v, tr);
    const appealStatus = (s) => (tr.has(`cases.appealStatus.${s}`) ? t(`cases.appealStatus.${s}`) : s);
    const { record: r, appeal, answers = [], history = [], others = [], othersTotal = 0, ladder = null, evidence = [], review = { required: false } } = data;
    const pending = appeal?.status === 'pending';
    const body = html`<p><a href="${path('/appeals')}">${t('cases.appeal.back')}</a></p>
<h1 class="title-with-badge">${t('cases.appeal.heading')} <code data-copy="${r.case_code}">${r.case_code}</code> ${typeBadge(r.type)}${r.is_test ? html` <span class="muted">${t('cases.appeal.testCase')}</span>` : ''}</h1>
${notices({ flash, error, editEnabled, canAct, act: 'appeals' }, tr)}
${r.is_test ? html`<p class="notice">${t('cases.appeal.testNotice')}</p>` : ''}
<dl>
<dt>${t('cases.table.member')}</dt><dd><a href="${userHref(r.target_user_id)}">${r.target_username}</a> <span class="muted">${r.target_user_id}</span></dd>
<dt>${t('cases.table.case')}</dt><dd>${caseLink(r.case_code)} · ${r.name}</dd>
<dt>${t('cases.table.reason')}</dt><dd>${r.reason}</dd>
<dt>${t('cases.appeal.givenBy')}</dt><dd>${r.moderator_username}${r.is_auto ? t('cases.appeal.automatic') : ''} · ${d(r.created_at)}</dd>
${review.required ? html`<dt>${t('cases.appeal.review')}</dt><dd class="warn">${t('cases.appeal.reviewNeeded', { name: review.issuer })}</dd>` : ''}
${r.type === 'ban' || r.type === 'mute' ? html`<dt>${t('cases.detail.ends')}</dt><dd>${r.expires_at ? d(r.expires_at) : t('cases.duration.permanentLower')}</dd>` : ''}
${ladder ? html`<dt>${t('cases.appeal.ladder')}</dt><dd>${t('cases.appeal.ladderValue', { stage: stageLabelText(ladder.level, tr), count: ladder.warns_since_level })}</dd>` : ''}
</dl>
${pending && !appeal.channel_id ? html`<p class="notice">${t('cases.appeal.noChannel')}</p>` : ''}
${appeal ? html`<h2>${t('cases.appeal.appealHead', { status: appealStatus(appeal.status), date: d(appeal.created_at), age: ageIn(appeal.created_at, now, tr) })}</h2>
<dl>${answers.length ? answers.map((a) => html`<dt>${a.label}</dt><dd class="value">${a.value}</dd>`) : html`<dt>${t('cases.appeal.answers')}</dt><dd class="muted">${t('cases.detail.none')}</dd>`}</dl>` : html`<p class="muted">${t('cases.appeal.noAppeal')}</p>`}
<h2>${t('cases.detail.evidence', { count: evidence.length })}</h2>
${evidence.length ? html`<ul class="evidence">${evidence.map(({ row, freshUrl }) => html`<li><span class="muted">#${row.id} · ${row.added_by_username} · ${d(row.added_at)}</span> ${row.note ? html`<div>${row.note}</div>` : ''}
${row.kind === 'image' ? (freshUrl && isAllowedImageUrl(freshUrl) ? html`<a href="${freshUrl}" rel="noopener noreferrer" target="_blank"><img src="${freshUrl}" alt="${t('cases.evidence.imageAlt', { id: row.id })}" loading="lazy" referrerpolicy="no-referrer"></a>` : html`<div class="muted">${t('cases.appeal.imageGone')}</div>`)
        : html`${row.url ? link(row.url) : ''}${row.excerpt ? html`<blockquote>${row.excerpt}</blockquote>` : ''}`}</li>`)}</ul>` : html`<p class="muted">${t('cases.detail.noEvidence')}</p>`}
<h2>${t('cases.appeal.earlier', { count: history.length })}</h2>
${history.length ? html`<ul>${history.map((a) => html`<li>${d(a.created_at)} · ${appealStatus(a.status)}${a.decided_by_username ? t('cases.appeal.byName', { name: a.decided_by_username }) : ''}${a.note ? html`: ${a.note}` : ''}</li>`)}</ul>` : html`<p class="muted">${t('cases.appeal.none')}</p>`}
<h2>${t('cases.appeal.others', { count: othersTotal })}</h2>
${others.length ? html`<ul>${others.map((c) => html`<li>${caseLink(c.case_code)} ${typeBadge(c.type)} · ${d(c.created_at)} · ${caseStatusText(c, null, tr)} · ${c.reason}</li>`)}</ul>` : html`<p class="muted">${t('cases.appeal.none')}</p>`}
${pending && canWrite && review.blocked ? html`<h2>${t('cases.appeal.decide')}</h2><p class="notice">${review.message}</p>` : ''}
${pending && canWrite && !review.blocked ? html`<h2>${t('cases.appeal.decide')}</h2>${review.ownerOverride ? html`<p class="notice">${t('cases.appeal.ownerOverride')}</p>` : ''}${actionForm(session.csrf, `/appeals/${r.case_code}/preview`, html`<label class="wide">${t('cases.appeal.note')}<textarea name="note" rows="2" maxlength="500"></textarea></label>
<div class="buttons"><button type="submit" name="decision" value="accept" class="primary">${t('cases.appeal.accept')}</button> <button type="submit" name="decision" value="deny" class="danger">${t('cases.appeal.deny')}</button></div>`, { submit: null })}` : ''}`;
    return layout({ title: t('cases.appeal.title', { code: r.case_code }), active: 'appeals', session, access, moduleStates, body });
}

/** The confirm step of an appeal decision. */
export function appealConfirmPage({ session, access = null, moduleStates = {}, record, decision, note, token, hash }) {
    const tr = dashboardText(session?.lang);
    const { t, tx } = tr;
    const accept = decision === 'accept';
    const effect = accept
        ? (record.is_test ? t('cases.appealConfirm.effect.test')
            : record.type === 'ban' ? t('cases.appealConfirm.effect.ban')
                : record.type === 'mute' ? t('cases.appealConfirm.effect.mute')
                    : record.type === 'warn' ? t('cases.appealConfirm.effect.warn')
                        : t('cases.appealConfirm.effect.lifted'))
        : t('cases.appealConfirm.effect.deny');
    const code = html`<code>${record.case_code}</code>`;
    const body = html`<p><a href="${path(`/appeals/${encodeURIComponent(record.case_code)}`)}">${t('members.confirm.back')}</a></p>
<h1>${accept ? tx('cases.appealConfirm.headingAccept', { code }) : tx('cases.appealConfirm.headingDeny', { code })}</h1>
<section class="card confirm-card"><dl><dt>${t('cases.table.member')}</dt><dd>${record.target_username} <span class="muted">${record.target_user_id}</span></dd>
<dt>${t('cases.table.case')}</dt><dd>${typeBadge(record.type)} · ${record.name}</dd>
<dt>${t('cases.detail.note')}</dt><dd>${note || '-'}</dd>
<dt>${t('members.confirm.effect')}</dt><dd>${effect}${!accept && record.is_auto && record.ladder_level_after === 3 ? t('cases.appealConfirm.stage3') : ''}</dd></dl>
<p class="muted">${t('cases.appealConfirm.channel')}</p>
${confirmButtons(session.csrf, `/appeals/${record.case_code}/decide`, { submit: accept ? t('cases.appealConfirm.accept') : t('cases.appealConfirm.deny'), hidden: { token, fh: hash }, danger: !accept, cancelHref: path(`/appeals/${encodeURIComponent(record.case_code)}`) })}</section>`;
    return layout({ title: t('cases.appealConfirm.title', { code: record.case_code }), active: 'appeals', session, access, moduleStates, body });
}

// ── No-contact orders ─────────────────────────────────────────────────────

/** The staff watchlist card (rows: listActiveWatches). Members are added with /case watch add. */
function watchlistSection({ session, rows = [], names = new Map(), canWrite = false }, tr = currentText()) {
    const { t, tx } = tr;
    const who = (id) => html`<a href="${userHref(id)}">${names.get(id) || id}</a> <span class="muted">${id}</span>`;
    return section(t('members.watch.title', { count: rows.length }), html`<p class="muted help">${tx('members.watch.help', { command: html`<code>/case watch add</code>` })}</p>
${rows.length ? html`<div class="scroll"><table><thead><tr><th>#</th><th>${t('cases.table.member')}</th><th>${t('members.watch.since')}</th><th>${t('members.watch.until')}</th><th>${t('cases.detail.by')}</th><th>${t('cases.table.reason')}</th><th></th></tr></thead><tbody>
${rows.map((w) => html`<tr><td>${w.id}</td><td>${who(w.user_id)}</td><td>${dateIn(w.created_at, tr)}</td><td>${w.until ? dateIn(w.until, tr) : t('members.watch.noEnd')}</td><td>${names.get(w.created_by) || w.created_by}</td><td class="value">${w.reason}</td>
<td>${canWrite ? actionForm(session.csrf, '/watchlist/end', '', { submit: t('members.keepApart.endNow'), hidden: { id: String(w.id) }, inline: true, danger: true }) : ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${t('members.watch.empty')}</p>`}`, '', { key: 'watchlist-active' });
}

/** A member field of "Start an order": "Find a member" comes back here with the other member kept. */
function noContactMember(name, label, values, guild) {
    const keep = Object.fromEntries(['user_a', 'user_b'].map((k) => [k, parseUserRef(String(values[k] || '')) || undefined]));
    return memberField({ name, label, value: values[name] || '', required: true, back: path(`/nocontact${queryString(keep)}`), anchor: 'nocontact-start', guild });
}

/** rows: listActiveNoContactOrders; names: Map(userId → username). */
export function noContactPage({ session, access = null, moduleStates = {}, rows = [], watchRows = [], showWatch = false, names = new Map(), canWrite = false, flash = null, error = null, editEnabled = true, canAct = true, values = {}, guild = null }) {
    const tr = dashboardText(session?.lang);
    const { t } = tr;
    const who = (id) => html`<a href="${userHref(id)}">${names.get(id) || id}</a> <span class="muted">${id}</span>`;
    const body = html`<header class="page-head"><h1>${t('members.keepApart.heading', { count: rows.length })}</h1></header>
<p class="muted help">${t('members.keepApart.help')}</p>
${notices({ flash, error, editEnabled, canAct, act: 'orders' }, tr)}
${section(t('members.keepApart.active', { count: rows.length }), html`${rows.length ? html`<div class="scroll"><table><thead><tr><th>#</th><th>${t('members.keepApart.members')}</th><th>${t('members.watch.until')}</th><th>${t('cases.detail.by')}</th><th>${t('cases.table.reason')}</th><th></th></tr></thead><tbody>
${rows.map((o) => html`<tr><td>${o.id}</td><td>${who(o.user_a)} ↔ ${who(o.user_b)}</td><td>${dateIn(o.until, tr)}</td><td>${names.get(o.created_by) || o.created_by}</td><td class="value">${o.reason}</td>
<td>${canWrite ? actionForm(session.csrf, '/nocontact/end', '', { submit: t('members.keepApart.endNow'), hidden: { id: String(o.id) }, inline: true, danger: true }) : ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${t('members.keepApart.none')}</p>`}`, '', { key: 'nocontact-active' })}
${canWrite ? section(t('members.keepApart.start'), actionForm(session.csrf, '/nocontact/add', html`<div class="grid">
${noContactMember('user_a', t('members.keepApart.first'), values, guild)}
${noContactMember('user_b', t('members.keepApart.second'), values, guild)}
<label>${t('members.keepApart.days')}<input type="number" name="days" min="1" max="${NO_CONTACT_MAX_DAYS}" step="1" required value="${values.days || ''}"></label>
<label class="wide">${t('members.keepApart.reason')}<input name="reason" maxlength="500" required value="${values.reason || ''}"></label></div>`, { submit: t('members.keepApart.startSubmit') }), '', { key: 'nocontact-start' }) : ''}
${showWatch ? watchlistSection({ session, rows: watchRows, names, canWrite }, tr) : ''}`;
    return layout({ title: t('members.keepApart.title'), active: 'nocontact', session, access, moduleStates, body });
}

// ── Staff: coverage heatmap and mass-action blocks ────────────────────────

// Monday 1 January 2024 + day: the weekday names of the heatmap rows (WEEKDAYS starts on Monday).
const weekdayName = (day, tr) => (tr.lang === 'en' ? WEEKDAYS[day] : tr.weekday(new Date(Date.UTC(2024, 0, 1 + day))));
const pad = (n) => String(n).padStart(2, '0');
const slotText = (slot, tr) => (tr.lang === 'en' ? slotLabel(slot) : `${weekdayName(slot.day, tr)} ${pad(slot.hour)}:00–${pad((slot.hour + 1) % 24)}:00`);

function heatTable(title, grid, max, tr) {
    return html`<div class="heat-wrap"><table class="heat"><caption>${title}</caption><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>
${grid.map((hours, day) => html`<tr><th scope="row">${weekdayName(day, tr)}</th>${hours.map((count, hour) => html`<td class="heat-${intensityLevel(count, max)}" title="${weekdayName(day, tr)} ${hour}:00 · ${count}">${count || ''}</td>`)}</tr>`)}
</tbody></table></div>`;
}

/** report: buildCoverageReport (with its grids); period: '7d' | '30d'. */
export function coverageSection({ report, period, periods, statsPeriod }) {
    const tr = currentText();
    const { t } = tr;
    const chips = html`<nav class="chips" aria-label="${t('staffPage.coverage.period')}">${Object.keys(periods).map((key) => html`<a class="chip${key === period ? ' is-active' : ''}" href="${path(`/staff${queryString({ period: statsPeriod, coverage: key })}`)}"${key === period ? raw(' aria-current="page"') : ''}>${tr.tp('staffPage.coverage.days', periods[key])}</a>`)}</nav>`;
    return section(tr.tp('staffPage.coverage.title', periods[period], { zone: report.timeZone }), html`${chips}
${heatTable(t('staffPage.coverage.incidents', { count: report.totalIncidents }), report.incidentGrid, report.maxIncidents, tr)}
${heatTable(t('staffPage.coverage.staff', { count: report.totalStaff }), report.staffGrid, report.maxStaff, tr)}
<p class="muted">${tr.tx('staffPage.coverage.note', { zone: report.timeZone })}</p>
<h3>${t('staffPage.coverage.gaps')}</h3>
${report.gaps.length ? html`<ol>${report.gaps.map((slot) => html`<li>${slotText(slot, tr)}: ${tr.tp('staffPage.coverage.incidentCount', slot.incidents)}, ${tr.tp('staffPage.coverage.actionCount', slot.staff)}</li>`)}</ol>` : html`<p class="muted">${t('staffPage.coverage.none')}</p>`}`, '', { key: 'staff-coverage' });
}

/** blocks: listMassActionBlocks (failed: it could not be loaded); names: Map(id → username); canLift: OWNER_IDS (like /staff restore). */
export function blocksSection({ blocks = [], failed = false, names = new Map(), canLift = false, csrf, editEnabled = true }) {
    const tr = currentText();
    const { t } = tr;
    if (failed || !blocks) return section(t('staffPage.blocks.title', { count: '?' }), html`<p class="muted">${t('staffPage.blocks.failed')}</p>`, '', { key: 'staff-blocks' });
    return section(t('staffPage.blocks.title', { count: blocks.length }), html`${blocks.length ? html`<div class="scroll"><table><thead><tr><th>${t('staffPage.stats.moderator')}</th><th>${t('staffPage.blocks.until')}</th><th>${t('staffPage.blocks.count')}</th><th>${t('members.watch.since')}</th><th></th></tr></thead><tbody>
${blocks.map((b) => html`<tr><td>${names.get(b.moderatorId) || b.moderatorId} <span class="muted">${b.moderatorId}</span></td><td>${dateIn(b.until, tr)}</td><td>${b.count ?? '-'}</td><td>${dateIn(b.at, tr)}</td>
<td>${canLift && editEnabled ? actionForm(csrf, '/staff/blocks/lift', '', { submit: t('staffPage.blocks.lift'), hidden: { moderator: b.moderatorId }, inline: true, danger: true }) : ''}</td></tr>`)}
</tbody></table></div>${canLift ? '' : html`<p class="muted">${t('staffPage.blocks.ownersOnly')}</p>`}` : html`<p class="muted">${t('staffPage.blocks.none')}</p>`}`, '', { key: 'staff-blocks' });
}

// ── Staff: weekly activity and discipline (/staff activity, warn, warnings, restore) ──

export const STAFF_WEEKS = { this: 'This week', last: 'Last week' };

/**
 * rows: staffActivityForWeek (null = could not be loaded); week: 'this' | 'last'; start: YYYY-MM-DD.
 * `keep`: the other query values of the staff page (stats period, coverage) for the links.
 * `warningsLink`: owners get a "Warnings" link per member.
 * `partial`: the member list was not fully loaded (member fetch gate); a note says so.
 */
export function activitySection({ rows, week = 'this', start, keep = {}, warningsLink = false, partial = false }) {
    const tr = currentText();
    const { t } = tr;
    const chips = html`<nav class="chips" aria-label="${t('staffPage.activity.week')}">${Object.keys(STAFF_WEEKS).map((key) => html`<a class="chip${key === week ? ' is-active' : ''}" href="${path(`/staff${queryString({ ...keep, week: key })}`)}"${key === week ? raw(' aria-current="page"') : ''}>${t(`staffPage.activity.weeks.${key}`)}</a>`)}</nav>`;
    const body = rows === null
        ? html`<p class="muted">${t('staffPage.activity.error')}</p>`
        : rows.length
            ? html`<div class="scroll"><table><thead><tr><th>${t('staffPage.activity.member')}</th><th>${t('staffPage.activity.messages')}</th><th>${t('staffPage.activity.actions')}</th><th>${t('staffPage.activity.appeals')}</th><th>${t('staffPage.activity.reviews')}</th><th>${t('staffPage.activity.tickets')}</th><th></th></tr></thead><tbody>
${rows.map((r) => html`<tr><td><a href="${userHref(r.userId)}">${r.username}</a>${r.isOwner ? html` <span class="muted">${t('staffPage.activity.owner')}</span>` : ''}</td><td>${r.messages}</td><td>${r.actions}</td><td>${r.appeals}</td><td>${r.reviews}</td><td>${r.tickets}</td>
<td>${r.inactive ? html`<span class="warn">${t('staffPage.activity.inactive')}</span> ` : ''}${warningsLink ? html`<a href="${path(`/staff${queryString({ ...keep, week, warnings: r.userId })}`)}#staff-discipline">${t('staffPage.activity.warnings')}</a>` : ''}</td></tr>`)}
</tbody></table></div><p class="muted">${t('staffPage.activity.note')}</p>`
            : html`<p class="muted">${t('staffPage.activity.none')}</p>`;
    const partialNote = rows !== null && partial ? html`<p class="notice">${t('staffPage.activity.partial')}</p>` : '';
    return section(t('staffPage.activity.title', { start }), html`${chips}${partialNote}${body}`, '', { key: 'staff-activity' });
}

/**
 * Owner-only discipline: warn a staff member, look up their warnings, give back removed roles.
 * staff: [{ userId, username }] for the picker; lookup: { userId, name, rows (null = failed) } | null;
 * removed: listRemovedStaffRoles (null = failed); roleNames: Map(roleId → name); names: Map(userId → username).
 */
export function disciplineSection({
    isOwner = false, csrf, editEnabled = true, staff = [], lookup = null, removed = [], roleNames = new Map(), names = new Map(),
    warnLimit = 3, keep = {}, now = Date.now(), guild = null, picked = {},
}) {
    const tr = currentText();
    const { t } = tr;
    if (!isOwner) {
        return section(t('staffPage.discipline.title'), html`<p class="muted">${t('staffPage.discipline.ownersOnly')}</p>`, '', { key: 'staff-discipline' });
    }
    const canWrite = Boolean(editEnabled);
    const who = (id) => html`<a href="${userHref(id)}">${names.get(id) || id}</a> <span class="muted">${id}</span>`;
    // "Find a member" comes back to the staff page with the same filters; picked: { warn, restore } from its query.
    const staffBack = path(`/staff${queryString(Object.fromEntries(Object.entries(keep).filter(([, v]) => v && /^[A-Za-z0-9_-]+$/.test(String(v)))))}`);
    const warnForm = actionForm(csrf, '/staff/warn', html`<div class="grid">
${memberField({ name: 'user', label: t('staffPage.activity.member'), value: picked.warn || lookup?.userId || '', required: true, pick: 'warn_user', back: staffBack, anchor: 'staff-discipline', guild, list: 'staff-members' })}
<datalist id="staff-members">${staff.map((m) => html`<option value="${m.userId}">${m.username}</option>`)}</datalist>
<label class="wide">${t('staffPage.discipline.reason')}<input name="reason" maxlength="500" required></label></div>`, { submit: t('staffPage.discipline.give'), enabled: canWrite, confirm: t('staffPage.discipline.giveConfirm', { limit: warnLimit }) });
    const lookupForm = html`<form method="get" action="${path('/staff')}" class="inline-form">${Object.entries(keep).filter(([, v]) => v).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
${memberField({ name: 'warnings', label: t('staffPage.discipline.showOf'), value: lookup?.userId || '', pick: 'warnings', back: staffBack, anchor: 'staff-discipline', guild, inline: true, list: 'staff-members' })}<button type="submit" class="secondary">${t('members.precedent.show')}</button></form>`;
    const lookupBody = !lookup ? '' : lookup.rows === null
        ? html`<p class="muted">${t('staffPage.discipline.warningsError')}</p>`
        : html`<h3>${t('staffPage.discipline.warningsOf', { name: lookup.name || lookup.userId })}</h3>${lookup.rows.length ? html`<div class="scroll"><table><thead><tr><th>${t('cases.table.status')}</th><th>${t('staffPage.discipline.given')}</th><th>${t('cases.detail.by')}</th><th>${t('cases.table.reason')}</th></tr></thead><tbody>
${lookup.rows.map((w) => html`<tr><td>${new Date(w.expires_at).getTime() > now ? html`<b>${t('staffPage.discipline.active')}</b>` : html`<span class="muted">${t('staffPage.discipline.expired')}</span>`}</td><td>${dateIn(w.created_at, tr)}</td><td>${w.given_by_username || w.given_by}</td><td class="value">${w.reason}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">${t('cases.appeal.none')}</p>`}`;
    const removedBody = removed === null
        ? html`<p class="muted">${t('staffPage.discipline.removedError')}</p>`
        : removed.length
            ? html`<div class="scroll"><table><thead><tr><th>${t('staffPage.activity.member')}</th><th>${t('staffPage.discipline.removedRoles')}</th><th>${t('staffPage.discipline.why')}</th><th>${t('cases.detail.when')}</th><th></th></tr></thead><tbody>
${removed.map((r) => html`<tr><td>${who(r.userId)}</td><td>${r.roleIds.map((id, i) => html`${i ? ', ' : ''}${roleNames.get(id) || id}`)}</td><td class="value">${r.reason || '-'}</td><td>${dateIn(r.at, tr)}</td>
<td>${canWrite ? actionForm(csrf, '/staff/restore', '', { submit: t('staffPage.discipline.restore'), hidden: { user: r.userId }, inline: true, confirm: t('staffPage.discipline.restoreConfirm') }) : ''}</td></tr>`)}
</tbody></table></div>`
            : html`<p class="muted">${t('staffPage.discipline.noneSaved')}</p>`;
    const restoreById = actionForm(csrf, '/staff/restore', memberField({ name: 'user', label: t('staffPage.discipline.restoreOf'), value: picked.restore || '', required: true, pick: 'restore_user', back: staffBack, anchor: 'staff-discipline', guild, inline: true }), { submit: t('staffPage.discipline.restore'), inline: true, enabled: canWrite, secondary: true });
    return section(t('staffPage.discipline.title'), html`<p class="muted">${t('staffPage.discipline.help', { limit: warnLimit })}</p>
${warnForm}
${lookupForm}
${lookupBody}
<h3>${t('staffPage.discipline.removedTitle')}</h3>
${removedBody}
${restoreById}
<p class="muted">${t('staffPage.discipline.restoreNote')}</p>`, '', { key: 'staff-discipline' });
}
