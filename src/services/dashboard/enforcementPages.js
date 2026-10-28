// enforcementPages.js — Phase 3 pages: member lookup and member page (standing, notes,
// cases, actions), the action confirm page, appeal detail and its confirm page,
// no-contact orders, the staff coverage heatmap and mass-action blocks, and the
// action forms on a case page. Pure: data in, HTML out, everything escaped by the
// `html` template. No inline styles or scripts (CSP).

import { ENFORCEMENT_REASONS, CUSTOM_REASON_KEY } from '../../config/enforcement.js';
import { ACTION_LABELS, RECORD_ACTIONS, countedWarnsText } from '../enforcement/flowBuilder.js';
import { nextWarningText } from '../enforcement/standingService.js';
import { caseStatusLabel } from '../enforcement/caseService.js';
import { MAX_LINKS_PER_FORM, NOTE_MAX as EVIDENCE_NOTE_MAX } from '../enforcement/evidenceService.js';
import { NO_CONTACT_MAX_DAYS } from '../enforcement/noContactService.js';
import { NOTE_MAX } from '../enforcement/staffNotesService.js';
import { WEEKDAYS, intensityLevel, slotLabel } from '../staffCoverageService.js';
import { formatAge, formatDate, html, icon, layout, path, queryString, raw, section, typeBadge } from './html.js';
import { isAllowedImageUrl, isSafeLink } from './pages.js';
import { JOINED_FILTERS, SORTS, STATE_FILTERS } from './membersData.js';
import { BAN_FILTERS } from './bansData.js';
import { NICKNAME_MAX, REASON_MAX, TIMEOUTS } from './memberActions.js';
import { BULK_ACTIONS, BULK_LIMIT } from './bulkActions.js';
import { TEMP_ROLE_LENGTHS } from '../members/tempRoleService.js';

export const DURATION_CHOICES = ['30m', '1h', '6h', '12h', '1d', '3d', '7d', '14d', '1mo', '3mo'];

const caseHref = (code) => path(`/cases/${encodeURIComponent(code)}`);
const userHref = (id) => path(`/users/${encodeURIComponent(id)}`);
const caseLink = (code) => html`<a href="${caseHref(code)}"><code>${code}</code></a>`;

function link(url, label = url) {
    return isSafeLink(url) ? html`<a href="${url}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>` : html`<span>${label}</span>`;
}

function notices({ flash = null, error = null, editEnabled = true, canAct = true, actLabel = 'take enforcement actions' } = {}) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">Read-only: editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED is not true). Use the bot's commands.</p>`
        : !canAct ? html`<p class="notice">View only: you need Administrator in the main server to ${actLabel} here.</p>` : ''}`;
}

/**
 * A POST form to any dashboard path, with the CSRF token; disabled when `enabled` is
 * false. `submit: null` leaves the button out (the fields bring their own).
 */
export function actionForm(csrf, actionPath, fields, { submit = 'Save', hidden = {}, danger = false, secondary = false, inline = false, enabled = true, className = '', multipart = false, confirm = '' } = {}) {
    const classes = [inline ? 'inline-form' : 'settings-form', className].filter(Boolean).join(' ');
    const attrs = html`${multipart ? raw(' enctype="multipart/form-data"') : ''}${confirm ? html` data-confirm="${confirm}"` : ''}`;
    return html`<form method="post" action="${path(actionPath)}" class="${classes}"${attrs}><input type="hidden" name="csrf" value="${csrf}">
${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<fieldset${enabled ? '' : raw(' disabled')}>${fields}${enabled && submit !== null ? html`<button type="submit" class="${danger ? 'danger' : secondary ? 'secondary' : 'primary'}">${submit}</button>` : ''}</fieldset></form>`;
}

function option(value, label, selected = false) {
    return html`<option value="${value}"${selected ? raw(' selected') : ''}>${label}</option>`;
}

export const MEMBER_TABS = { list: ['Members', '/users'], rules: ['Role rules', '/users/rules'], insights: ['Insights', '/users/insights'] };

/** The tab row of the Members area (chips; the current one has aria-current). */
export function memberTabs(active) {
    return html`<nav class="chips member-tabs" aria-label="Members area">${Object.entries(MEMBER_TABS).map(([key, [label, href]]) => html`<a class="chip" href="${path(href)}"${key === active ? raw(' aria-current="page"') : ''}>${label}</a>`)}</nav>`;
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
    const opt = (value, label, current) => html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`;
    const keep = { q: filters.q, role: filters.role, joined: filters.joined, state: filters.state, sort: filters.sort };
    const pageLink = (page, label) => html`<a class="btn" href="${path(`/users${queryString({ ...keep, page: page || '' })}`)}">${label}</a>`;
    const rows = list?.rows || [];
    const roleCell = (row) => (row.roles.length
        ? html`${row.roles.slice(0, 3).map((r) => html`<span class="role-chip">@${r.name}</span>`)}${row.roles.length > 3 ? html`<span class="muted"> +${row.roles.length - 3}</span>` : ''}`
        : html`<span class="muted">no roles</span>`);
    const warnCell = (row) => (row.level > 0 ? html`level ${row.level}${row.warns ? html` · ${row.warns} warn${row.warns === 1 ? '' : 's'}` : ''}`
        : row.warns ? html`${row.warns} of 3` : html`<span class="muted">—</span>`);
    const tick = (row) => (canWrite ? html`<td class="tick"><input type="checkbox" name="ids" value="${row.id}" form="bulk-form" aria-label="Select ${row.displayName}"></td>` : '');
    const table = rows.length ? html`<div class="table-wrap"><table class="members"><thead><tr>${canWrite ? html`<th class="tick"><input type="checkbox" data-select-all="ids" aria-label="Select everyone on this page"></th>` : ''}<th>Member</th><th>Roles</th><th>Joined</th><th>Warns</th><th>State</th></tr></thead><tbody>
${rows.map((row) => html`<tr>${tick(row)}<td><a class="member-cell" href="${userHref(row.id)}">${row.avatarUrl && isAllowedImageUrl(row.avatarUrl)
        ? html`<img class="avatar-sm" src="${row.avatarUrl}" alt="" width="32" height="32" loading="lazy" referrerpolicy="no-referrer">`
        : html`<span class="avatar-sm" aria-hidden="true">${row.displayName.slice(0, 1).toUpperCase()}</span>`}<span><b>${row.displayName}</b>${row.bot ? html` <span class="tag">bot</span>` : ''}<small>${row.username} · ${row.id}</small></span></a></td>
<td class="roles-cell">${roleCell(row)}</td><td class="nowrap">${row.joinedAt ? html`<time datetime="${new Date(row.joinedAt).toISOString()}" data-relative>${formatDate(new Date(row.joinedAt))}</time>` : html`<span class="muted">unknown</span>`}</td>
<td class="nowrap">${warnCell(row)}</td><td>${row.muted ? html`<span class="state-word is-warn"><span class="dot dot-warn" aria-hidden="true"></span>Muted</span>` : html`<span class="muted">—</span>`}</td></tr>`)}
</tbody></table></div>
<nav class="pager" aria-label="Pages"><span class="muted">Page ${list.page + 1} of ${list.pages} · ${list.total} member${list.total === 1 ? '' : 's'}</span>${list.page > 0 ? pageLink(list.page - 1, '← Previous') : ''}${list.page + 1 < list.pages ? pageLink(list.page + 1, 'Next →') : ''}</nav>`
        : ['q', 'role', 'joined', 'state'].some((key) => filters[key])
            ? html`<p class="empty">No member matches these filters. <a href="${path('/users')}">Clear filters</a></p>`
            : html`<p class="empty">No members to show yet. The list fills once the bot has loaded the main server.</p>`;
    // Quick filters as chips (the other filters stay as they are); the bulk form folds away.
    const chips = html`<nav class="chips" aria-label="Show">${Object.entries(STATE_FILTERS).map(([k, v]) => html`<a class="chip" href="${path(`/users${queryString({ ...keep, state: k, page: '' })}`)}"${(filters.state || '') === k ? raw(' aria-current="page"') : ''}>${v}</a>`)}</nav>`;
    const count = list ? html`${list.total} member${list.total === 1 ? '' : 's'}${list.memberCount && list.total !== list.memberCount ? ` of ${list.memberCount}` : ''}` : '';
    const body = html`<header class="page-head"><h1>Members</h1><p class="muted">${count ? html`${count} · ` : ''}open a member to change their roles or take an action.</p></header>
${memberTabs('list')}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${list && list.memberCount && list.cached < list.memberCount * 0.9 ? html`<p class="notice">Showing ${list.cached} of ${list.memberCount} members: the member list is still loading. Reload in a minute.</p>` : ''}
${loading ? html`<p class="notice">The member list is not available right now (the bot cannot see the main server).</p>` : ''}
${chips}
<form class="filters" method="get" action="${path('/users')}" role="search"><input type="hidden" name="state" value="${filters.state || ''}">
<label class="wide-filter">Search<input type="search" name="q" value="${filters.q || ''}" maxlength="40" autocomplete="off" placeholder="Name, nickname or user ID"></label>
<label>Role<select name="role">${opt('', 'Any role', filters.role || '')}${roles.map((r) => opt(r.id, `@${r.name}`, filters.role))}</select></label>
<label>Joined<select name="joined">${Object.entries(JOINED_FILTERS).map(([k, v]) => opt(k, v, filters.joined || ''))}</select></label>
<label>Sort<select name="sort">${Object.entries(SORTS).map(([k, v]) => opt(k, v, filters.sort || 'joined_desc'))}</select></label>
<button class="primary" type="submit">Apply</button> <a href="${path('/users')}">Clear</a></form>
${canWrite && list?.rows?.length ? html`<details class="bulk-wrap"><summary class="btn">${icon('users')}Bulk action<span class="muted"> · tick members below, or use everyone matching the filters</span></summary>${bulkForm(session.csrf, list, filters, roles)}</details>` : ''}
${list ? table : ''}`;
    return layout({ title: 'Members', active: 'users', session, access, moduleStates, body });
}

/** The Banned page: Discord's ban list joined with the open ban cases; Unban runs on the member page. */
export function bansPage({ session, access = null, moduleStates = {}, list, filters = {}, error = null, canAct = false }) {
    const keep = { q: filters.q, filter: filters.filter };
    const chips = html`<nav class="chips" aria-label="Show">${Object.entries(BAN_FILTERS).map(([k, v]) => html`<a class="chip" href="${path(`/bans${queryString({ ...keep, filter: k, page: '' })}`)}"${(filters.filter || '') === k ? raw(' aria-current="page"') : ''}>${v}</a>`)}</nav>`;
    const pageLink = (page, label) => html`<a class="btn" href="${path(`/bans${queryString({ ...keep, page: page || '' })}`)}">${label}</a>`;
    const kind = (row) => {
        if (!row.record) return html`<span class="muted">no case (banned outside the bot)</span>`;
        const ladder = row.record.is_auto ? html` <span class="muted">· warn ladder level ${row.record.ladder_level_after}</span>` : '';
        return row.permanent ? html`Permanent${ladder}` : html`Until ${formatDate(row.record.expires_at)}${ladder}`;
    };
    const rows = list?.rows || [];
    const table = rows.length ? html`<div class="table-wrap"><table class="members"><thead><tr><th>Member</th><th>Reason</th><th>Case</th><th>Ban</th><th></th></tr></thead><tbody>
${rows.map((row) => html`<tr><td><a class="member-cell" href="${userHref(row.id)}">${row.avatarUrl && isAllowedImageUrl(row.avatarUrl)
        ? html`<img class="avatar-sm" src="${row.avatarUrl}" alt="" width="32" height="32" loading="lazy" referrerpolicy="no-referrer">`
        : html`<span class="avatar-sm" aria-hidden="true">${row.displayName.slice(0, 1).toUpperCase()}</span>`}<span><b>${row.displayName}</b><small>${row.username} · ${row.id}</small></span></a></td>
<td>${row.reason || html`<span class="muted">no reason given</span>`}</td>
<td class="nowrap">${row.record ? html`${caseLink(row.record.case_code)}${row.record.status === 'appeal_pending' ? html`<br><a class="state-word is-warn" href="${path(`/appeals/${encodeURIComponent(row.record.case_code)}`)}"><span class="dot dot-warn" aria-hidden="true"></span>appeal pending</a>` : ''}` : html`<span class="muted">—</span>`}</td>
<td>${kind(row)}${row.record ? html`<br><small class="muted">by ${row.record.moderator_username}, ${formatDate(row.record.created_at)}</small>` : ''}</td>
<td class="nowrap"><a class="btn small" href="${userHref(row.id)}#s-member-actions">${canAct ? 'Unban…' : 'Open'}<span class="sr"> ${row.displayName}</span></a></td></tr>`)}
</tbody></table></div>
<nav class="pager" aria-label="Pages"><span class="muted">Page ${list.page + 1} of ${list.pages} · ${list.total} ban${list.total === 1 ? '' : 's'}</span>${list.page > 0 ? pageLink(list.page - 1, '← Previous') : ''}${list.page + 1 < list.pages ? pageLink(list.page + 1, 'Next →') : ''}</nav>`
        : list && (filters.q || filters.filter)
            ? html`<p class="empty">No ban matches. <a href="${path('/bans')}">Show everyone banned</a></p>`
            : list ? html`<p class="empty">Nobody is banned in the main server.</p>` : '';
    const body = html`<header class="page-head"><h1>Banned</h1><p class="muted">${list ? html`${list.banned} banned in the main server · ` : ''}Unban opens the member page: you see the effect, then confirm. The member gets a DM with an invite back.</p></header>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${list ? html`${chips}<form class="filters" method="get" action="${path('/bans')}" role="search"><input type="hidden" name="filter" value="${filters.filter || ''}">
<label class="wide-filter">Search<input type="search" name="q" value="${filters.q || ''}" maxlength="40" autocomplete="off" placeholder="Name or user ID"></label>
<button class="primary" type="submit">Search</button> <a href="${path('/bans')}">Clear</a></form>${table}` : ''}`;
    return layout({ title: 'Banned', active: 'bans', session, access, moduleStates, body });
}

// ── Member page ───────────────────────────────────────────────────────────

function standingSection(view) {
    const { state, countedWarns = [], appealStatuses = new Map() } = view;
    const ladder = state.ladder;
    const active = [];
    if (state.activeBan) active.push(html`ban ${caseLink(state.activeBan.case_code)} — ${state.activeBan.expires_at ? html`ends ${formatDate(state.activeBan.expires_at)}` : 'permanent'}`);
    else if (state.banned) active.push(html`banned (no record — banned outside the bot)`);
    if (state.activeMute) active.push(html`mute ${caseLink(state.activeMute.case_code)} — ends ${formatDate(state.activeMute.expires_at)}`);
    else if (state.muted) active.push(html`has the muted role (no record)`);
    const pending = [...appealStatuses].filter(([, status]) => status === 'pending').map(([code]) => code);
    return html`<dl>
<dt>Counted warns</dt><dd>${countedWarnsText(ladder)}${countedWarns.length ? html` · ${countedWarns.map((w, i) => html`${i ? ', ' : ''}${caseLink(w.case_code)}`)}` : ''}</dd>
<dt>Ladder level</dt><dd>${ladder.level} of 3</dd>
<dt>Next warning</dt><dd>${nextWarningText(ladder)}</dd>
<dt>Active punishment</dt><dd>${active.length ? active.map((a, i) => html`${i ? '; ' : ''}${a}`) : 'none'}</dd>
<dt>Pending appeals</dt><dd>${pending.length ? pending.map((code, i) => html`${i ? ', ' : ''}<a href="${path(`/appeals/${encodeURIComponent(code)}`)}"><code>${code}</code></a>`) : 'none'}</dd>
</dl>`;
}

/**
 * The member page header: avatar, name, ID, joined date, and the standing at a glance
 * (counted warns, ladder level, what is active). The full details follow in sections.
 */
function memberHeader(view, now) {
    const { user, member, state } = view;
    const avatar = user.avatarUrl && isAllowedImageUrl(user.avatarUrl)
        ? html`<img class="avatar" src="${user.avatarUrl}" alt="" width="64" height="64" referrerpolicy="no-referrer">`
        : html`<span class="avatar avatar-initials-lg" aria-hidden="true">${String(user.username || '?').slice(0, 1).toUpperCase()}</span>`;
    const joined = member ? (member.joinedAt ? html`Joined ${formatDate(member.joinedAt)}` : 'In the server') : 'Not in the server';
    const ladder = state.ladder;
    const active = state.activeBan || state.banned ? 'Banned' : state.activeMute || state.muted ? 'Muted' : 'None';
    return html`<header class="member-header">${avatar}<div class="member-title"><h1>${user.username}${user.bot ? html` <span class="tag">bot</span>` : ''}</h1>
<p class="muted"><span class="nowrap">ID ${user.id}</span><span class="nowrap">${joined}</span></p></div>
<ul class="member-facts"><li><span class="label">Counted warns</span><span class="value">${countedWarnsText(ladder)}</span></li>
<li><span class="label">Ladder level</span><span class="value">${ladder.level} of 3</span></li>
<li><span class="label">Active</span><span class="value">${active === 'None' ? active : html`<span class="dot dot-bad" aria-hidden="true"></span>${active}`}</span></li></ul></header>`;
}

function profileSection(user, member, now) {
    const avatar = user.avatarUrl && isAllowedImageUrl(user.avatarUrl)
        ? html`<img class="avatar" src="${user.avatarUrl}" alt="" width="64" height="64" referrerpolicy="no-referrer">` : '';
    const roles = member?.roles || [];
    return html`<div class="profile">${avatar}<dl>
<dt>Username</dt><dd>${user.username}${user.bot ? html` <span class="tag">bot</span>` : ''} <span class="muted">${user.id}</span></dd>
<dt>Display name</dt><dd>${user.globalName || '—'}</dd>
${member ? html`<dt>Nickname</dt><dd>${member.nickname || '—'}</dd>` : ''}
<dt>Account created</dt><dd>${formatDate(user.createdAt)} (${formatAge(user.createdAt, now)} ago)</dd>
<dt>In server</dt><dd>${member ? html`yes, joined ${member.joinedAt ? html`${formatDate(member.joinedAt)} (${formatAge(member.joinedAt, now)} ago)` : 'at an unknown time'}` : 'no'}</dd>
${member ? html`<dt>Roles (${roles.length})</dt><dd>${roles.length ? roles.map((r, i) => html`${i ? ', ' : ''}@${r.name}`) : 'none'}</dd>` : ''}
</dl></div>`;
}

/**
 * Roles, nickname and timeout of a member in the server: current roles (with Remove where this
 * moderator may take them), a role picker of the roles they may give, nickname, timeout. When
 * the member cannot be changed (owner, bot, yourself, equal or higher role) it says why.
 */
/** The bulk card under the Members list: what to do with the ticked members (or everyone matching). */
function bulkForm(csrf, list, filters, roles) {
    const canAll = list.total <= BULK_LIMIT;
    return html`<form class="card bulk" id="bulk-form" method="post" action="${path('/users/bulk/preview')}"><input type="hidden" name="csrf" value="${csrf}">
${['q', 'joined', 'state', 'sort'].map((k) => html`<input type="hidden" name="${k}" value="${filters[k] || ''}">`)}<input type="hidden" name="frole" value="${filters.role || ''}">
<fieldset class="bulk-scope"><legend class="sr">Which members</legend>
<label class="check"><input type="radio" name="scope" value="selected" checked> The members ticked below</label>
<label class="check"><input type="radio" name="scope" value="filter"${canAll ? '' : raw(' disabled')}> Everyone matching these filters (${list.total})${canAll ? '' : html` <span class="muted">more than ${BULK_LIMIT}: narrow the filters</span>`}</label></fieldset>
<div class="grid">
<label>Do this<select name="action" required><option value="">— choose —</option>${Object.entries(BULK_ACTIONS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
<label class="only-role">Role<select name="roleId" data-search><option value="">— choose —</option>${roles.map((r) => html`<option value="${r.id}">@${r.name}</option>`)}</select></label>
<label class="only-role-add">For<select name="for"><option value="">Permanently</option>${Object.entries(TEMP_ROLE_LENGTHS).map(([k, t]) => html`<option value="${k}">${t.label}</option>`)}</select></label>
<label class="only-timeout">Timeout length<select name="timeout"><option value="">— choose —</option>${Object.entries(TIMEOUTS).map(([k, t]) => html`<option value="${k}">${t.label}</option>`)}</select></label>
<label class="only-record">Reason<select name="reasonKey">${ENFORCEMENT_REASONS.map((r) => html`<option value="${r.key}">${r.label}</option>`)}<option value="${CUSTOM_REASON_KEY}">Custom…</option></select></label>
<label class="only-record">Custom reason<input name="custom_reason" maxlength="500"><span class="hint">Only used with "Custom…". Each member gets the same DM and case as one-by-one.</span></label>
<label class="only-ban">Ban length<input name="duration" maxlength="20" placeholder="e.g. 7d, 1mo, permanent"></label>
<label class="only-plain">Reason (optional, Discord audit log)<input name="reason" maxlength="${REASON_MAX}"></label>
</div>
<p class="muted">Nothing happens yet: the next page shows exactly who will be changed and who is skipped, and why. At most ${BULK_LIMIT} members; kicks and bans only as many as the mass-action guard still allows.</p>
<div class="form-actions"><button type="submit" class="primary">Preview</button></div></form>`;
}

/** Who a bulk action will change and who is skipped (with the reason); Run needs the one-time token. */
export function bulkPreviewPage({ session, access = null, moduleStates = {}, action, label, role, timeout, plan, token, hash, guardLeft }) {
    const what = `${label}${role ? ` @${role.name}` : ''}${timeout ? ` for ${timeout.label}` : ''}`;
    const destructive = action === 'kick' || action === 'ban';
    const n = `${plan.run.length} member${plan.run.length === 1 ? '' : 's'}`;
    const verb = { 'role-add': `Give @${role?.name} to ${n}${timeout ? ` for ${timeout.label}` : ''}`, 'role-remove': `Take @${role?.name} from ${n}`, timeout: `Time out ${n}`, kick: `Kick ${n}`, ban: `Ban ${n}` }[action] || `${label} ${n}`;
    const body = html`<a class="back" href="${path('/users')}">← Members</a>
<header class="page-head"><h1>${what}: ${plan.run.length} member${plan.run.length === 1 ? '' : 's'}</h1><p class="muted">Check the list. Nothing has been changed yet.</p></header>
${destructive && Number.isFinite(guardLeft) ? html`<p class="notice">The mass-action guard allows ${guardLeft} more ban${guardLeft === 1 ? '' : 's'}/kick${guardLeft === 1 ? '' : 's'} in this 10-minute window; members beyond that are skipped.</p>` : ''}
<section class="card"><h2>Will be changed (${plan.run.length})</h2>${plan.run.length ? html`<ul class="name-list">${plan.run.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a></li>`)}</ul>` : html`<p class="empty">Nobody: every selected member is skipped.</p>`}</section>
${plan.skipped.length ? html`<section class="card"><h2>Skipped (${plan.skipped.length})</h2><ul class="skip-list">${plan.skipped.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a><span class="muted">${m.why}</span></li>`)}</ul></section>` : ''}
${plan.run.length ? actionForm(session.csrf, '/users/bulk/execute', html`<p class="muted">Runs one member at a time (Discord rate limits); you can leave the page and come back to the progress.${destructive ? ' Every member gets the same DM and case as a single action.' : ''}</p>`,
        { submit: verb, hidden: { token, fh: hash }, danger: destructive, confirm: destructive ? `${verb}?` : '' }) : ''}`;
    return layout({ title: `Bulk: ${what}`, active: 'users', session, access, moduleStates, body });
}

/** Progress of a bulk job; reloads itself every 2 s while running (meta refresh, CSP-safe). */
export function bulkJobPage({ session, access = null, moduleStates = {}, job }) {
    const running = !job.finishedAt;
    const doneCount = job.done.length + job.failed.length;
    const body = html`<a class="back" href="${path('/users')}">← Members</a>
<header class="page-head"><h1>${job.label}</h1><p class="muted">${running ? html`Working… ${doneCount} of ${job.total} done. This page updates itself.` : html`Finished: ${job.done.length} done, ${job.failed.length} failed.`}</p></header>
<div class="progress-row"><progress value="${doneCount}" max="${job.total || 1}" aria-label="Progress"></progress><span class="muted">${doneCount} / ${job.total}</span></div>
${job.failed.length ? html`<section class="card"><h2>Failed (${job.failed.length})</h2><ul class="skip-list">${job.failed.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a><span class="muted">${m.why}</span></li>`)}</ul></section>` : ''}
${job.done.length ? html`<section class="card"><h2>Done (${job.done.length})</h2><ul class="name-list">${job.done.map((m) => html`<li><a href="${userHref(m.id)}">${m.name}</a></li>`)}</ul></section>` : ''}`;
    return layout({ title: `Bulk: ${job.label}`, active: 'users', session, access, moduleStates, body, refreshSeconds: running ? 2 : 0 });
}

/** can: { roles, nickname, timeout, unverify } — what this viewer may change (editing on + permissions.js). */
function memberEditSection(view, can, csrf) {
    const canWrite = can.roles;
    const id = view.user.id;
    const edit = view.memberEdit;
    const roles = view.member.roles;
    const current = html`<div class="role-list">${roles.length ? roles.map((r) => html`<span class="role-chip role-chip-lg">@${r.name}${edit?.tempRoles?.has(r.id) ? html` <span class="muted">until ${formatDate(edit.tempRoles.get(r.id))}</span>` : ''}${canWrite && !edit?.problem && edit?.removable?.has(r.id)
        ? actionForm(csrf, `/users/${id}/roles/remove`, '', { submit: 'Remove', hidden: { roleId: r.id }, inline: true, secondary: true, className: 'chip-form' }) : ''}</span>`) : html`<span class="muted">No roles.</span>`}</div>`;
    if (!can.roles && !can.nickname && !can.timeout && !can.unverify) return html`${current}<p class="muted">Changing roles needs Administrator and editing turned on.</p>`;
    if (edit?.problem) return html`${current}<p class="notice">${edit.problem}</p>`;
    const roleForm = edit.assignable.length
        ? actionForm(csrf, `/users/${id}/roles/add`, html`<div class="grid"><label>Give a role<select name="roleId" data-search required><option value="">— choose —</option>${edit.assignable.map((r) => html`<option value="${r.id}">@${r.name}</option>`)}</select><span class="hint">Only roles below your highest role and Meowist's; staff roles only for the server owner or bot owners.</span></label>
<label>For<select name="for"><option value="">Permanently</option>${Object.entries(TEMP_ROLE_LENGTHS).map(([k, t]) => html`<option value="${k}">${t.label}</option>`)}</select><span class="hint">Timed roles are taken off automatically, and given back if they rejoin before the end.</span></label>
<label>Reason (optional, Discord audit log)<input name="reason" maxlength="${REASON_MAX}"></label></div>`, { submit: 'Give role' })
        : html`<p class="muted">There is no other role you can give.</p>`;
    const nickForm = actionForm(csrf, `/users/${id}/nickname`, html`<div class="grid"><label>Nickname<input name="nickname" maxlength="${NICKNAME_MAX}" value="${view.member.nickname || ''}" placeholder="${view.user.globalName || view.user.username}"><span class="hint">Empty removes the nickname.</span></label></div>`, { submit: 'Save nickname' });
    const timeoutForm = html`${edit.timeoutUntil ? html`<p class="notice">Timed out until ${formatDate(edit.timeoutUntil)}.</p>${actionForm(csrf, `/users/${id}/timeout`, '', { submit: 'Remove timeout', hidden: { duration: 'off' }, inline: true, secondary: true })}` : ''}
${actionForm(csrf, `/users/${id}/timeout`, html`<div class="grid"><label>Timeout length<select name="duration" required><option value="">— choose —</option>${Object.entries(TIMEOUTS).map(([k, t]) => html`<option value="${k}">${t.label}</option>`)}</select><span class="hint">Discord's own timeout (max 28 days): they can read but not write or talk. For longer, use Mute.</span></label>
<label>Reason (optional, Discord audit log)<input name="reason" maxlength="${REASON_MAX}"></label></div>`, { submit: edit.timeoutUntil ? 'Change timeout' : 'Time out', confirm: `Time out ${view.user.username}?` })}`;
    const verifyForm = edit.verifiedRole
        ? html`<h3>Verification</h3><p>Verified (@${edit.verifiedRole.name}).</p>${actionForm(csrf, `/users/${id}/unverify`, html`<div class="grid"><label>Reason (optional, Discord audit log and verification log)<input name="reason" maxlength="${REASON_MAX}"></label></div>`, { submit: 'Unverify', secondary: true, confirm: `Remove verification from ${view.user.username}? They lose @${edit.verifiedRole.name} and must verify again.` })}`
        : '';
    return html`${current}${can.roles ? roleForm : html`<p class="muted">Changing roles needs Administrator.</p>`}${can.nickname ? html`<h3>Nickname</h3>${nickForm}` : ''}${can.timeout ? html`<h3>Timeout</h3>${timeoutForm}` : ''}${can.unverify ? verifyForm : ''}`;
}

function notesSection(view, canWrite, csrf) {
    const notes = view.notes || [];
    const id = view.user.id;
    return html`${notes.length ? html`<div class="scroll"><table><thead><tr><th>#</th><th>Note</th><th>By</th><th>When</th><th></th></tr></thead><tbody>
${notes.map((note, i) => html`<tr><td>${i + 1}</td><td class="value">${note.content}</td><td>${note.author || 'unknown'}</td><td>${note.timestamp ? formatDate(note.timestamp) : '—'}</td>
<td>${canWrite ? actionForm(csrf, `/users/${id}/notes/remove`, '', { submit: 'Remove', hidden: { note: String(note.id ?? '') }, inline: true, danger: true }) : ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">No staff notes yet. Add one below; only staff can see them.</p>`}
${canWrite ? actionForm(csrf, `/users/${id}/notes/add`, html`<label class="wide">New note (only staff can see it)<textarea name="note" maxlength="${NOTE_MAX}" rows="2" required></textarea></label>`, { submit: 'Add note' }) : ''}`;
}

function casesSection(view) {
    const { cases = [], casesTotal = 0, appealStatuses = new Map(), user } = view;
    return html`${cases.length ? html`<div class="scroll"><table><thead><tr><th>Case</th><th>Type</th><th>Name</th><th>Reason</th><th>Date</th><th>Status</th></tr></thead><tbody>
${cases.map((row) => html`<tr><td>${caseLink(row.case_code)}</td><td>${typeBadge(row.type)}${row.is_test ? html` <span class="muted">(test)</span>` : ''}</td><td>${row.name}</td><td>${row.reason}</td>
<td>${formatDate(row.created_at)}</td><td>${caseStatusLabel(row, appealStatuses.get(row.case_code))}</td></tr>`)}
</tbody></table></div>${casesTotal > cases.length ? html`<p><a href="${path(`/cases${queryString({ member: user.id })}`)}">All ${casesTotal} cases →</a></p>` : ''}` : html`<p class="muted">No cases.</p>`}`;
}

function noContactSection(orders, names = new Map()) {
    if (!orders.length) return '';
    return html`<ul>${orders.map((o) => html`<li>with ${names.get(o.otherId) || o.otherId} <span class="muted">${o.otherId}</span> until ${formatDate(o.until)} (order #${o.id})</li>`)}</ul>`;
}

function precedentSection(view) {
    const reasonKey = view.precedentReason || '';
    return html`<form class="filters" method="get" action="${userHref(view.user.id)}">
<label>How was this reason handled before?<select name="reason">${option('', 'choose a reason', !reasonKey)}${ENFORCEMENT_REASONS.map((r) => option(r.key, r.label, r.key === reasonKey))}</select></label>
<button type="submit">Show</button></form>
${reasonKey ? html`<p>${view.precedent || html`<span class="muted">No precedent available for this reason.</span>`}</p>` : ''}`;
}

function reasonFields(type, values = {}) {
    return html`<label>Reason<select name="reason" required>${ENFORCEMENT_REASONS.map((r) => option(r.key, `${r.label}${type === 'ban' && r.severe ? ' (severe: unappealable by default)' : ''}`, values.reason === r.key))}${option(CUSTOM_REASON_KEY, 'Custom…', values.reason === CUSTOM_REASON_KEY)}</select></label>
<label>Custom reason<input name="custom_reason" maxlength="500" value="${values.custom_reason || ''}"><span class="hint">Only used with "Custom…".</span></label>`;
}

function durationField(type, value = '') {
    const id = `durations-${type}`;
    return html`<label>Duration<input name="duration" maxlength="20" list="${id}" value="${value}"${type === 'mute' ? raw(' required') : ''}>
<span class="hint">${type === 'ban' ? 'e.g. 30m, 24h, 7d, 1mo. Blank = permanent.' : 'Required. e.g. 30m, 24h, 7d, 1mo.'}</span></label>
<datalist id="${id}">${DURATION_CHOICES.map((d) => html`<option value="${d}"></option>`)}</datalist>`;
}

/** One action's form (posts to the preview step). */
function actionBlock(view, type, csrf, values = {}) {
    const id = view.user.id;
    let fields;
    if (RECORD_ACTIONS.has(type)) {
        fields = html`<div class="grid">${reasonFields(type, values)}
${type === 'ban' || type === 'mute' ? durationField(type, values.duration || '') : ''}
${type === 'ban' ? html`<label>Appealable<select name="unappealable">${option('default', 'default (severe reasons: no)', !values.unappealable || values.unappealable === 'default')}${option('no', 'yes, appealable', values.unappealable === 'no')}${option('yes', 'no, unappealable', values.unappealable === 'yes')}</select></label>` : ''}
<label>Name (optional)<input name="name" maxlength="100" value="${values.name || ''}"><span class="hint">Default: ${view.user.username} ${type} &lt;n&gt;</span></label>
<label class="wide">Evidence (message links, optional)<textarea name="evidence" rows="2" maxlength="1000">${values.evidence || ''}</textarea><span class="hint">Up to ${MAX_LINKS_PER_FORM} links, one per line. Their text is saved now. Images can be uploaded on the case page afterwards.</span></label></div>`;
    } else {
        fields = html`<div class="grid">${type === 'removewarn' ? html`<label>Warning<select name="warn" required>${(view.countedWarns || []).map((w) => option(w.case_code, `${w.case_code} · ${w.name} · ${w.reason}`, values.warn === w.case_code))}</select></label>` : ''}
<label class="wide">Reason (optional)<input name="reason" maxlength="500" value="${values.reason || ''}"></label></div>`;
    }
    return html`<details class="action"${values.type === type ? raw(' open') : ''}><summary>${ACTION_LABELS[type]}</summary>
${actionForm(csrf, `/users/${id}/action/preview`, fields, { submit: 'Preview', hidden: { type } })}</details>`;
}

/**
 * The member page. view: { user: { id, username, globalName, bot, createdAt, avatarUrl },
 * member: { nickname, joinedAt, roles: [name] } | null, state, countedWarns, cases,
 * casesTotal, appealStatuses, noContact, noContactNames, notes, actions, precedentReason,
 * precedent, block }.
 */
export function userPage({ session, access = null, moduleStates = {}, view, canAct = false, allow = null, editEnabled = false, flash = null, error = null, values = {}, now = Date.now() }) {
    // allow(key): permissions.js for this viewer (the Moderator level runs some actions); default canAct for everything.
    const may = (key) => Boolean(editEnabled && (allow ? allow(key) : canAct));
    const canWrite = canAct && editEnabled;
    const can = { roles: may('member.roles'), nickname: may('member.nickname'), timeout: may('member.timeout'), unverify: may('member.unverify') };
    const actions = view.actions.filter((type) => may(`action:${type}`));
    const limited = !canAct && actions.length > 0;
    const body = html`<a class="back" href="${path('/users')}">← Members</a>
${memberHeader(view, now)}
${notices({ flash, error, editEnabled, canAct: canAct || limited || can.timeout })}
${editEnabled && !canAct && (limited || can.timeout) ? html`<p class="notice">Moderator: you can ${[...actions.map((t) => ACTION_LABELS[t].toLowerCase()), ...(can.timeout ? ['time out'] : [])].join(', ')} here. Ban, unban, roles, nickname and notes need Administrator.</p>` : ''}
${section('Profile', profileSection(view.user, view.member, now), '', { key: 'member-profile', open: false })}
${section('Standing', standingSection(view), '', { key: 'member-standing' })}
${view.member ? section(`Roles (${view.member.roles.length}), nickname and timeout`, memberEditSection(view, can, session.csrf), '', { key: 'member-roles' }) : ''}
${(view.noContact || []).length ? section('No-contact orders', noContactSection(view.noContact, view.noContactNames), '', { key: 'member-nocontact' }) : ''}
${section('Actions', html`${view.block ? html`<p class="error">You are blocked by the mass-action guard until ${formatDate(view.block.until)}; actions will be refused.</p>` : ''}
${canWrite || limited ? (actions.length ? html`<p class="muted">Same actions, DMs, ladder and checks as /enforcements. Each one shows a confirmation first.</p>${actions.map((type) => actionBlock(view, type, session.csrf, values.type === type ? values : {}))}` : html`<p class="muted">No actions available.</p>`)
        : html`<p class="muted">Available: ${view.actions.map((t) => ACTION_LABELS[t]).join(', ') || 'none'}.</p>`}`, '', { key: 'member-actions' })}
${section('Precedent', precedentSection(view), '', { key: 'member-precedent', open: Boolean(view.precedentReason) })}
${section(`Case history (${view.casesTotal || 0})`, casesSection(view), '', { key: 'member-cases', open: false })}
${section(`Staff notes (${(view.notes || []).length})`, notesSection(view, may('member.notes'), session.csrf), '', { key: 'member-notes' })}`;
    return layout({ title: view.user.username, active: 'users', session, access, moduleStates, body });
}

// ── Confirm pages ─────────────────────────────────────────────────────────

/** The confirm step of an action. summary from flowBuilder.flowSummary. */
export function actionConfirmPage({ session, access = null, moduleStates = {}, userId, type, summary, token, hash, block = null }) {
    const body = html`<p><a href="${userHref(userId)}">← Back (cancel)</a></p>
<h1>Confirm: ${ACTION_LABELS[type]}</h1>
<section class="card confirm-card"><dl>${summary.rows.map((row) => html`<dt>${row.label}</dt><dd>${row.code ? html`<code>${row.value}</code>` : row.value}${row.id ? html` <span class="muted">${row.id}</span>` : ''}</dd>`)}
${summary.evidence.length ? html`<dt>Evidence</dt><dd><ul class="plain">${summary.evidence.map((e) => html`<li>${link(e.url)}${e.excerpt ? html` <blockquote>${e.excerpt}</blockquote>` : e.unreadable ? html` <span class="muted">(message not readable, link only)</span>` : ''}</li>`)}</ul></dd>` : ''}
${summary.effect ? html`<dt>Effect</dt><dd>${summary.effect}</dd>` : ''}
</dl>
${summary.notes.map((n) => html`<p>${n}</p>`)}
${summary.precedent ? html`<p class="muted">${summary.precedent}</p>` : ''}
${block ? html`<p class="error">You are blocked by the mass-action guard until ${formatDate(block.until)}; this will be refused.</p>` : ''}
<p class="muted">This confirmation works once and expires in 5 minutes.</p>
${actionForm(session.csrf, `/users/${userId}/action/execute`, '', { submit: `Confirm ${ACTION_LABELS[type].toLowerCase()}`, hidden: { token, fh: hash }, danger: true })}</section>`;
    return layout({ title: `Confirm ${ACTION_LABELS[type]}`, active: 'users', session, access, moduleStates, body });
}

// ── Case page actions ─────────────────────────────────────────────────────

/** Edit / void / evidence forms under a case (Administrators, editing on). */
export function caseActions({ record, evidence = [], csrf, canWrite, flash = null, error = null, editEnabled = true, canAct = true }) {
    const code = record.case_code;
    const open = ['active', 'appeal_pending'].includes(record.status);
    const timed = (record.type === 'ban' || record.type === 'mute') && open && !record.is_auto && !record.is_imported;
    const top = notices({ flash, error, editEnabled, canAct, actLabel: 'change cases' });
    if (!canWrite) return { top, bottom: '' };
    const bottom = html`<h2>Change this case</h2>
${record.voided_at ? html`<p class="muted">Voided cases can no longer be edited.</p>` : html`<div class="card"><h3>Edit</h3>
${actionForm(csrf, `/cases/${code}/edit`, html`<div class="grid"><label class="wide">New reason<input name="reason" maxlength="500" value="${record.reason}"></label>
${timed ? html`<label>New duration<input name="duration" maxlength="20" list="durations-edit" placeholder="unchanged"><span class="hint">Total from when it was given, e.g. 7d, 1mo${record.type === 'ban' ? ', permanent' : ''}.</span></label>
<datalist id="durations-edit">${DURATION_CHOICES.map((d) => html`<option value="${d}"></option>`)}${record.type === 'ban' ? html`<option value="permanent"></option>` : ''}</datalist>` : ''}</div>`, { submit: 'Save changes' })}</div>
<div class="card"><h3>Void</h3><p class="muted">Marks the case as a mistake: lifts what is still in effect (unban, unmute, warning removed, ladder stepped back) and DMs the member the reason.</p>
${actionForm(csrf, `/cases/${code}/void`, html`<label class="wide">Reason (shown to the member)<input name="reason" maxlength="500" required></label>
<label class="check"><input type="checkbox" name="confirm" value="1" required> I want to void ${code}</label>`, { submit: 'Void case', danger: true })}</div>`}
<div class="card"><h3>Evidence</h3>
${actionForm(csrf, `/cases/${code}/evidence/add`, html`<div class="grid"><label class="wide">Link (e.g. a Discord message link: its text is saved)<input name="link" maxlength="500" required></label>
<label class="wide">Note (optional)<input name="note" maxlength="${EVIDENCE_NOTE_MAX}"></label></div>`, { submit: 'Add evidence' })}
${actionForm(csrf, `/cases/${code}/evidence/upload`, html`<div class="grid"><label class="wide">Image (PNG, JPEG, GIF or WebP, up to 8 MB)<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required></label>
<label class="wide">Note (optional)<input name="note" maxlength="${EVIDENCE_NOTE_MAX}"></label></div>`, { submit: 'Upload image', multipart: true })}
<p class="muted">Images are re-hosted in the evidence channel, as with /case evidence add.</p>
${evidence.length ? html`<p>${evidence.map(({ row }) => actionForm(csrf, `/cases/${code}/evidence/remove`, '', { submit: `Remove #${row.id}`, hidden: { id: String(row.id) }, inline: true, danger: true, confirm: `Remove evidence #${row.id}?` }))}</p>` : ''}</div>`;
    return { top, bottom };
}

// ── Appeals ───────────────────────────────────────────────────────────────

/**
 * One appeal with its dossier. data: { record, appeal (pending or latest), answers,
 * history (earlier appeals), others (other cases), othersTotal, ladder, evidence }.
 */
export function appealDetailPage({ session, access = null, moduleStates = {}, data, canWrite = false, flash = null, error = null, editEnabled = true, canAct = true, now = Date.now() }) {
    const { record: r, appeal, answers = [], history = [], others = [], othersTotal = 0, ladder = null, evidence = [] } = data;
    const pending = appeal?.status === 'pending';
    const body = html`<p><a href="${path('/appeals')}">← Appeals</a></p>
<h1 class="title-with-badge">Appeal · <code data-copy="${r.case_code}">${r.case_code}</code> ${typeBadge(r.type)}${r.is_test ? html` <span class="muted">(test case)</span>` : ''}</h1>
${notices({ flash, error, editEnabled, canAct, actLabel: 'decide appeals' })}
${r.is_test ? html`<p class="notice">Test case created with /test: nothing was executed, accepting it changes nothing.</p>` : ''}
<dl>
<dt>Member</dt><dd><a href="${userHref(r.target_user_id)}">${r.target_username}</a> <span class="muted">${r.target_user_id}</span></dd>
<dt>Case</dt><dd>${caseLink(r.case_code)} · ${r.name}</dd>
<dt>Reason</dt><dd>${r.reason}</dd>
<dt>Given by</dt><dd>${r.moderator_username}${r.is_auto ? ' (automatic, warn ladder)' : ''} · ${formatDate(r.created_at)}</dd>
${r.type === 'ban' || r.type === 'mute' ? html`<dt>Ends</dt><dd>${r.expires_at ? formatDate(r.expires_at) : 'permanent'}</dd>` : ''}
${ladder ? html`<dt>Warn ladder</dt><dd>level ${ladder.level}, ${ladder.warns_since_level} counted warn(s)</dd>` : ''}
</dl>
${appeal ? html`<h2>Appeal (${appeal.status}) · filed ${formatDate(appeal.created_at)} · waiting ${formatAge(appeal.created_at, now)}</h2>
<dl>${answers.length ? answers.map((a) => html`<dt>${a.label}</dt><dd class="value">${a.value}</dd>`) : html`<dt>Answers</dt><dd class="muted">none</dd>`}</dl>` : html`<p class="muted">No appeal on this case.</p>`}
<h2>Evidence (${evidence.length})</h2>
${evidence.length ? html`<ul class="evidence">${evidence.map(({ row, freshUrl }) => html`<li><span class="muted">#${row.id} · ${row.added_by_username} · ${formatDate(row.added_at)}</span> ${row.note ? html`<div>${row.note}</div>` : ''}
${row.kind === 'image' ? (freshUrl && isAllowedImageUrl(freshUrl) ? html`<a href="${freshUrl}" rel="noopener noreferrer" target="_blank"><img src="${freshUrl}" alt="Evidence image ${row.id}" loading="lazy" referrerpolicy="no-referrer"></a>` : html`<div class="muted">Image not available.</div>`)
        : html`${row.url ? link(row.url) : ''}${row.excerpt ? html`<blockquote>${row.excerpt}</blockquote>` : ''}`}</li>`)}</ul>` : html`<p class="muted">No evidence attached.</p>`}
<h2>Earlier appeals on this case (${history.length})</h2>
${history.length ? html`<ul>${history.map((a) => html`<li>${formatDate(a.created_at)} · ${a.status}${a.decided_by_username ? html` by ${a.decided_by_username}` : ''}${a.note ? html` — ${a.note}` : ''}</li>`)}</ul>` : html`<p class="muted">None.</p>`}
<h2>Other cases (${othersTotal})</h2>
${others.length ? html`<ul>${others.map((c) => html`<li>${caseLink(c.case_code)} ${typeBadge(c.type)} · ${formatDate(c.created_at)} · ${caseStatusLabel(c)} · ${c.reason}</li>`)}</ul>` : html`<p class="muted">None.</p>`}
${pending && canWrite ? html`<h2>Decide</h2>${actionForm(session.csrf, `/appeals/${r.case_code}/preview`, html`<label class="wide">Note (optional, shown in the appeal channel and the log)<textarea name="note" rows="2" maxlength="500"></textarea></label>
<div class="buttons"><button type="submit" name="decision" value="accept" class="primary">Accept…</button> <button type="submit" name="decision" value="deny" class="danger">Deny…</button></div>`, { submit: null })}` : ''}`;
    return layout({ title: `Appeal ${r.case_code}`, active: 'appeals', session, access, moduleStates, body });
}

/** The confirm step of an appeal decision. */
export function appealConfirmPage({ session, access = null, moduleStates = {}, record, decision, note, token, hash }) {
    const accept = decision === 'accept';
    const effect = accept
        ? (record.is_test ? 'Test case: only the record is closed.'
            : record.type === 'ban' ? 'The member is unbanned (if still banned), DMed with an invite back, and the case is lifted.'
                : record.type === 'mute' ? 'The member is unmuted (if still muted), DMed, and the case is lifted.'
                    : record.type === 'warn' ? 'The warning is removed (the ladder count drops; an automatic ban it caused is lifted) and the member is DMed.'
                        : 'The case is lifted and the member is DMed.')
        : 'The punishment stays. The member is DMed that the appeal was denied.';
    const body = html`<p><a href="${path(`/appeals/${encodeURIComponent(record.case_code)}`)}">← Back (cancel)</a></p>
<h1>Confirm: ${accept ? 'accept' : 'deny'} the appeal on <code>${record.case_code}</code></h1>
<section class="card confirm-card"><dl><dt>Member</dt><dd>${record.target_username} <span class="muted">${record.target_user_id}</span></dd>
<dt>Case</dt><dd>${typeBadge(record.type)} · ${record.name}</dd>
<dt>Note</dt><dd>${note || '—'}</dd>
<dt>Effect</dt><dd>${effect}${!accept && record.is_auto && record.ladder_level_after === 3 ? ' This level-3 ladder ban becomes unappealable.' : ''}</dd></dl>
<p class="muted">The appeal channel gets the decision and is deleted 10 seconds later (its transcript goes to the mod log). This confirmation works once and expires in 5 minutes.</p>
${actionForm(session.csrf, `/appeals/${record.case_code}/decide`, '', { submit: accept ? 'Accept appeal' : 'Deny appeal', hidden: { token, fh: hash }, danger: !accept })}</section>`;
    return layout({ title: `Confirm appeal ${record.case_code}`, active: 'appeals', session, access, moduleStates, body });
}

// ── No-contact orders ─────────────────────────────────────────────────────

/** rows: listActiveNoContactOrders; names: Map(userId → username). */
export function noContactPage({ session, access = null, moduleStates = {}, rows = [], names = new Map(), canWrite = false, flash = null, error = null, editEnabled = true, canAct = true, values = {} }) {
    const who = (id) => html`<a href="${userHref(id)}">${names.get(id) || id}</a> <span class="muted">${id}</span>`;
    const body = html`<header class="page-head"><h1>No-contact orders (${rows.length})</h1></header>
<p class="muted help">Two members may not mention or reply to each other; breaking messages are deleted and logged. Both members are DMed when an order starts and ends.</p>
${notices({ flash, error, editEnabled, canAct, actLabel: 'start or end orders' })}
${section(`Active orders (${rows.length})`, html`${rows.length ? html`<div class="scroll"><table><thead><tr><th>#</th><th>Members</th><th>Until</th><th>By</th><th>Reason</th><th></th></tr></thead><tbody>
${rows.map((o) => html`<tr><td>${o.id}</td><td>${who(o.user_a)} ↔ ${who(o.user_b)}</td><td>${formatDate(o.until)}</td><td>${names.get(o.created_by) || o.created_by}</td><td class="value">${o.reason}</td>
<td>${canWrite ? actionForm(session.csrf, '/nocontact/end', '', { submit: 'End now', hidden: { id: String(o.id) }, inline: true, danger: true }) : ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">No active orders.</p>`}`, '', { key: 'nocontact-active' })}
${canWrite ? section('Start an order', actionForm(session.csrf, '/nocontact/add', html`<div class="grid">
<label>First member (user ID)<input name="user_a" inputmode="numeric" maxlength="20" required value="${values.user_a || ''}"></label>
<label>Second member (user ID)<input name="user_b" inputmode="numeric" maxlength="20" required value="${values.user_b || ''}"></label>
<label>Days<input type="number" name="days" min="1" max="${NO_CONTACT_MAX_DAYS}" step="1" required value="${values.days || ''}"></label>
<label class="wide">Reason (shown to both members)<input name="reason" maxlength="500" required value="${values.reason || ''}"></label></div>`, { submit: 'Start order' }), '', { key: 'nocontact-start' }) : ''}`;
    return layout({ title: 'No-contact', active: 'nocontact', session, access, moduleStates, body });
}

// ── Staff: coverage heatmap and mass-action blocks ────────────────────────

function heatTable(title, grid, max) {
    return html`<div class="heat-wrap"><table class="heat"><caption>${title}</caption><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>
${grid.map((hours, day) => html`<tr><th scope="row">${WEEKDAYS[day]}</th>${hours.map((count, hour) => html`<td class="heat-${intensityLevel(count, max)}" title="${WEEKDAYS[day]} ${hour}:00 · ${count}">${count || ''}</td>`)}</tr>`)}
</tbody></table></div>`;
}

/** report: buildCoverageReport (with its grids); period: '7d' | '30d'. */
export function coverageSection({ report, period, periods, statsPeriod }) {
    const chips = html`<nav class="chips" aria-label="Coverage period">${Object.keys(periods).map((key) => html`<a class="chip${key === period ? ' is-active' : ''}" href="${path(`/staff${queryString({ period: statsPeriod, coverage: key })}`)}"${key === period ? raw(' aria-current="page"') : ''}>${periods[key]} days</a>`)}</nav>`;
    return section(`Coverage · last ${periods[period]} days (${report.timeZone})`, html`${chips}
${heatTable(`Incidents (cases created, automatic included): ${report.totalIncidents}`, report.incidentGrid, report.maxIncidents)}
${heatTable(`Staff activity (cases by human moderators + appeals decided): ${report.totalStaff}`, report.staffGrid, report.maxStaff)}
<p class="muted">Stronger shade = busier, in quarter steps up to the busiest hour. Columns are hours 0–23 in ${report.timeZone} (the server's birthday time zone, set under Birthdays; UTC when none is set).</p>
<h3>Most under-covered slots</h3>
${report.gaps.length ? html`<ol>${report.gaps.map((slot) => html`<li>${slotLabel(slot)} — ${slot.incidents} incident${slot.incidents === 1 ? '' : 's'}, ${slot.staff} staff action${slot.staff === 1 ? '' : 's'}</li>`)}</ol>` : html`<p class="muted">No incidents in this period.</p>`}`, '', { key: 'staff-coverage' });
}

/** blocks: listMassActionBlocks; names: Map(id → username); canLift: OWNER_IDS (like /staff restore). */
export function blocksSection({ blocks = [], names = new Map(), canLift = false, csrf, editEnabled = true }) {
    return section(`Mass-action guard blocks (${blocks.length})`, html`${blocks.length ? html`<div class="scroll"><table><thead><tr><th>Moderator</th><th>Blocked until</th><th>Bans/kicks</th><th>Since</th><th></th></tr></thead><tbody>
${blocks.map((b) => html`<tr><td>${names.get(b.moderatorId) || b.moderatorId} <span class="muted">${b.moderatorId}</span></td><td>${formatDate(b.until)}</td><td>${b.count ?? '—'}</td><td>${formatDate(b.at)}</td>
<td>${canLift && editEnabled ? actionForm(csrf, '/staff/blocks/lift', '', { submit: 'Lift block', hidden: { moderator: b.moderatorId }, inline: true, danger: true }) : ''}</td></tr>`)}
</tbody></table></div>${canLift ? '' : html`<p class="muted">Only the bot owners can lift a block (like /staff restore).</p>`}` : html`<p class="muted">Nobody is blocked.</p>`}`, '', { key: 'staff-blocks' });
}

// ── Staff: weekly activity and discipline (/staff activity, warn, warnings, restore) ──

export const STAFF_WEEKS = { this: 'This week', last: 'Last week' };

/**
 * rows: staffActivityForWeek (null = could not be loaded); week: 'this' | 'last'; start: YYYY-MM-DD.
 * `keep`: the other query values of the staff page (stats period, coverage) for the links.
 * `warningsLink`: owners get a "Warnings" link per member.
 */
export function activitySection({ rows, week = 'this', start, keep = {}, warningsLink = false }) {
    const chips = html`<nav class="chips" aria-label="Week">${Object.keys(STAFF_WEEKS).map((key) => html`<a class="chip${key === week ? ' is-active' : ''}" href="${path(`/staff${queryString({ ...keep, week: key })}`)}"${key === week ? raw(' aria-current="page"') : ''}>${STAFF_WEEKS[key]}</a>`)}</nav>`;
    const body = rows === null
        ? html`<p class="muted">Activity could not be loaded (database unavailable).</p>`
        : rows.length
            ? html`<div class="scroll"><table><thead><tr><th>Staff member</th><th>Messages</th><th>Actions</th><th>Appeals</th><th>Reviews</th><th>Tickets</th><th></th></tr></thead><tbody>
${rows.map((r) => html`<tr><td><a href="${userHref(r.userId)}">${r.username}</a>${r.isOwner ? html` <span class="muted">owner</span>` : ''}</td><td>${r.messages}</td><td>${r.actions}</td><td>${r.appeals}</td><td>${r.reviews}</td><td>${r.tickets}</td>
<td>${r.inactive ? html`<span class="warn">Inactive</span> ` : ''}${warningsLink ? html`<a href="${path(`/staff${queryString({ ...keep, week, warnings: r.userId })}`)}#staff-discipline">Warnings</a>` : ''}</td></tr>`)}
</tbody></table></div><p class="muted">Inactive = no moderation work and under 20 messages. Actions are cases they created; reviews are automod and verification cards.</p>`
            : html`<p class="muted">No staff found.</p>`;
    return section(`Staff activity · week of ${start}`, html`${chips}${body}`, '', { key: 'staff-activity' });
}

/**
 * Owner-only discipline: warn a staff member, look up their warnings, give back removed roles.
 * staff: [{ userId, username }] for the picker; lookup: { userId, name, rows (null = failed) } | null;
 * removed: listRemovedStaffRoles (null = failed); roleNames: Map(roleId → name); names: Map(userId → username).
 */
export function disciplineSection({
    isOwner = false, csrf, editEnabled = true, staff = [], lookup = null, removed = [], roleNames = new Map(), names = new Map(),
    warnLimit = 3, keep = {}, now = Date.now(),
}) {
    if (!isOwner) {
        return section('Staff discipline', html`<p class="muted">Only the bot owners can warn staff members, see their staff warnings or give back removed staff roles (like /staff warn, warnings and restore).</p>`, '', { key: 'staff-discipline' });
    }
    const canWrite = Boolean(editEnabled);
    const who = (id) => html`<a href="${userHref(id)}">${names.get(id) || id}</a> <span class="muted">${id}</span>`;
    const warnForm = actionForm(csrf, '/staff/warn', html`<div class="grid">
<label>Staff member (user ID)<input name="user" inputmode="numeric" maxlength="20" required list="staff-members" value="${lookup?.userId || ''}"></label>
<datalist id="staff-members">${staff.map((m) => html`<option value="${m.userId}">${m.username}</option>`)}</datalist>
<label class="wide">Reason: which admin rule they broke (sent to them)<input name="reason" maxlength="500" required></label></div>`, { submit: 'Give staff warning', enabled: canWrite, confirm: `Give this staff member a warning? At ${warnLimit} active warnings their staff roles are removed.` });
    const lookupForm = html`<form method="get" action="${path('/staff')}" class="inline-form">${Object.entries(keep).filter(([, v]) => v).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<label>Show warnings of (user ID)<input name="warnings" inputmode="numeric" maxlength="20" list="staff-members" value="${lookup?.userId || ''}"></label><button type="submit" class="secondary">Show</button></form>`;
    const lookupBody = !lookup ? '' : lookup.rows === null
        ? html`<p class="muted">Warnings could not be loaded (database unavailable).</p>`
        : html`<h3>Staff warnings: ${lookup.name || lookup.userId}</h3>${lookup.rows.length ? html`<div class="scroll"><table><thead><tr><th>Status</th><th>Given</th><th>By</th><th>Reason</th></tr></thead><tbody>
${lookup.rows.map((w) => html`<tr><td>${new Date(w.expires_at).getTime() > now ? html`<b>active</b>` : html`<span class="muted">expired</span>`}</td><td>${formatDate(w.created_at)}</td><td>${w.given_by_username || w.given_by}</td><td class="value">${w.reason}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">None.</p>`}`;
    const removedBody = removed === null
        ? html`<p class="muted">Removed staff roles could not be loaded (database unavailable).</p>`
        : removed.length
            ? html`<div class="scroll"><table><thead><tr><th>Staff member</th><th>Removed roles</th><th>Why</th><th>When</th><th></th></tr></thead><tbody>
${removed.map((r) => html`<tr><td>${who(r.userId)}</td><td>${r.roleIds.map((id, i) => html`${i ? ', ' : ''}${roleNames.get(id) || id}`)}</td><td class="value">${r.reason || '—'}</td><td>${formatDate(r.at)}</td>
<td>${canWrite ? actionForm(csrf, '/staff/restore', '', { submit: 'Restore roles', hidden: { user: r.userId }, inline: true, confirm: 'Give these staff roles back?' }) : ''}</td></tr>`)}
</tbody></table></div>`
            : html`<p class="muted">No removed staff roles are saved.</p>`;
    const restoreById = actionForm(csrf, '/staff/restore', html`<label>Restore by user ID<input name="user" inputmode="numeric" maxlength="20" required></label>`, { submit: 'Restore roles', inline: true, enabled: canWrite, secondary: true });
    return section('Staff discipline', html`<p class="muted">Staff warnings expire; at ${warnLimit} active warnings the staff roles are removed (the staff guard removes them too). The member is DMed and the mod log gets a line.</p>
${warnForm}
${lookupForm}
${lookupBody}
<h3>Removed staff roles</h3>
${removedBody}
${restoreById}
<p class="muted">Restoring gives back the saved roles the bot can still manage. A mass-action panel block is lifted separately (Mass-action guard blocks).</p>`, '', { key: 'staff-discipline' });
}
