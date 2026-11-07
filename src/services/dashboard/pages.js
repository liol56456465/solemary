// pages.js — the dashboard's records pages, the audit page and the module page frame. Pure: data in, HTML string out. Every value
// goes through the escaping `html` template (html.js).

import { formatDuration } from '../enforcement/format.js';
import { SEARCH_STATUSES, SEARCH_TYPES } from '../enforcement/caseSearchService.js';
import { STATS_PERIODS } from '../staffActivityService.js';
import { escapeHtml, formatAge, formatDate, html, icon, layout, navItems, navLabel, path, queryString, raw, section, timeTag, typeBadge } from './html.js';
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
    if (/voided|lifted|reversed/.test(label)) return 'muted';
    return '';
}

function option(value, label, selected) {
    return html`<option value="${value}"${selected ? raw(' selected') : ''}>${label}</option>`;
}

// ── Settings (read-only table of registry values) ─────────────────────────

const SOURCE_LABEL = { database: 'saved', env: 'from env (seed)', default: 'built-in default' };

/**
 * Current values of a module's registry settings. rows: [{ key, label, display, source }]
 * where `display` is text or SafeHtml (channel/role names resolved by the caller).
 */
export function settingsSection(rows = [], title = 'Settings') {
    if (!rows.length) return '';
    return html`<h2>${title}</h2>
<div class="scroll"><table><thead><tr><th>Setting</th><th>Value</th><th>Source</th></tr></thead><tbody>
${rows.map((row) => html`<tr><td>${row.label} <span class="muted"><code>${row.key}</code></span></td><td>${row.display}</td><td class="muted">${SOURCE_LABEL[row.source] || row.source}</td></tr>`)}
</tbody></table></div>`;
}

// ── Cases ─────────────────────────────────────────────────────────────────

/**
 * input: { session, query (raw strings as typed), rows, total, page, pageSize, error,
 * statusLabel(row) }.
 */
export function casesPage({ session, access = null, moduleStates = {}, query = {}, rows = [], total = 0, page = 0, pageSize = 25, error = null, statusLabel = (r) => r.status, exportDays = null, canExport = false, canBulk = false, flash = null, saved = [], canSaveSearch = false }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const keep = { member: query.member, moderator: query.moderator, type: query.type, status: query.status, text: query.text, from: query.from, to: query.to, tag: query.tag };
    const pager = html`<div class="pager">
${page > 0 ? html`<a href="/dashboard/cases${queryString({ ...keep, page: page - 1 })}">← Newer</a>` : ''}
<span class="muted">Page ${page + 1} of ${pages} · ${total} case${total === 1 ? '' : 's'}</span>
${page + 1 < pages ? html`<a href="/dashboard/cases${queryString({ ...keep, page: page + 1 })}">Older →</a>` : ''}
</div>`;
    const filtered = Object.values(keep).some(Boolean);
    const exportLine = !canExport ? '' : exportDays === null
        ? html`<p class="muted">Case export (CSV) comes with Mewvo Normal and up, on the server owner's plan. <a href="/pricing">Plans</a></p>`
        : html`<p><a class="btn" href="/dashboard/cases/export.csv" download>Download CSV</a> <span class="muted">${Number.isFinite(exportDays) ? `The last ${exportDays} days (Mewvo Normal).` : 'The full history.'}</span></p>`;
    const body = html`<header class="page-head"><h1>Cases</h1><p class="muted">Every enforcement action, newest first. Filter by member, moderator, type, status, tag or date.</p>${exportLine}</header>
<form class="filters" method="get" action="/dashboard/cases">
<label>Member ID<input name="member" value="${query.member || ''}" inputmode="numeric" maxlength="20"></label>
<label>Moderator ID<input name="moderator" value="${query.moderator || ''}" inputmode="numeric" maxlength="20"></label>
<label>Type<select name="type">${option('', 'any', !query.type)}${SEARCH_TYPES.map((t) => option(t, t, query.type === t))}</select></label>
<label>Status<select name="status">${option('', 'any', !query.status)}${SEARCH_STATUSES.map((s) => option(s, s, query.status === s))}</select></label>
<label>Text<input name="text" value="${query.text || ''}" maxlength="100"></label>
<label>Tag<input name="tag" value="${query.tag || ''}" maxlength="21" placeholder="e.g. scam"></label>
<label>From<input type="date" name="from" value="${query.from || ''}"></label>
<label>To<input type="date" name="to" value="${query.to || ''}"></label>
<button class="primary" type="submit">Search</button> <a href="/dashboard/cases">Clear</a>
</form>
${saved.length ? html`<p class="saved-searches">Saved: ${saved.map((s, i) => html`${i ? ' · ' : ''}<a href="/dashboard/cases${queryString(s.query)}">${s.name}</a>${canSaveSearch ? html` <form method="post" action="/dashboard/cases/searches/delete" class="inline-form"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="name" value="${s.name}"><button type="submit" class="link-button" aria-label="Delete saved search ${s.name}">(delete)</button></form>` : ''}`)}</p>` : ''}
${canSaveSearch && filtered ? html`<form method="post" action="/dashboard/cases/searches/save" class="inline-form save-search"><input type="hidden" name="csrf" value="${session.csrf}">${Object.entries(keep).filter(([, v]) => v).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<label>Save this search as <input name="name" maxlength="40" required placeholder="e.g. scam this month"></label> <button type="submit">Save</button></form>` : ''}
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="bad">${error}</p>` : ''}
${rows.length && canBulk ? html`<form method="post" action="/dashboard/cases/bulk" id="bulk-cases" class="filters bulk-cases"><input type="hidden" name="csrf" value="${session.csrf}">
<label>With the ticked cases<select name="action"><option value="tag-add">Add a tag</option><option value="tag-remove">Remove a tag</option><option value="void">Void them</option></select></label>
<label>Tag<input name="tag" maxlength="21" placeholder="scam"></label>
<label class="wide">Reason (for voiding; the members see it)<input name="reason" maxlength="500"></label>
<label class="check"><input type="checkbox" name="confirm" value="1"> I want to void the ticked cases</label>
<button class="primary" type="submit">Apply</button></form>
<p class="muted">Tags: up to 25 cases at once. Voiding: up to 10, and each member gets the usual DM.</p>` : ''}
${rows.length ? html`<div class="scroll"><table><thead><tr>${canBulk ? html`<th><span class="sr">Select</span></th>` : ''}<th>Case</th><th>Type</th><th>Member</th><th>Moderator</th><th>Reason</th><th>Date</th><th>Status</th></tr></thead><tbody>
${rows.map((row) => {
        const label = statusLabel(row);
        return html`<tr>${canBulk ? html`<td><input type="checkbox" name="codes" value="${row.case_code}" form="bulk-cases" aria-label="Select case ${row.case_code}"></td>` : ''}<td>${caseLink(row.case_code)}</td><td>${typeBadge(row.type)}${row.is_test ? html` <span class="muted">(test)</span>` : ''}</td>
<td>${row.target_username} <span class="muted">${row.target_user_id}</span></td><td>${row.moderator_username}</td>
<td>${row.reason}</td><td>${timeTag(row.created_at)}</td><td class="${statusClass(label)}">${label}</td></tr>`;
    })}
</tbody></table></div>${pager}` : error ? '' : filtered
        ? html`<p class="empty">No cases match these filters. <a href="/dashboard/cases">Clear filters</a></p>`
        : html`<p class="empty">No cases yet. They show up here after the first warn, mute, kick or ban.</p>`}`;
    return layout({ title: 'Cases', active: 'cases', session, access, moduleStates, body });
}

// ── Case detail ───────────────────────────────────────────────────────────

function durationText(record) {
    if (record.type === 'warn' || record.type === 'kick') return '-';
    if (!record.duration_ms) return record.type === 'ban' ? 'permanent' : '-';
    return formatDuration(Number(record.duration_ms));
}

function evidenceItem({ row, freshUrl }) {
    const meta = html`<span class="muted">#${row.id} · ${row.added_by_username} · ${formatDate(row.added_at)}</span>`;
    const note = row.note ? html`<div>${row.note}</div>` : '';
    if (row.kind === 'image') {
        const image = freshUrl && isAllowedImageUrl(freshUrl)
            ? html`<a href="${freshUrl}" rel="noopener noreferrer" target="_blank"><img src="${freshUrl}" alt="Evidence image ${row.id}" loading="lazy" referrerpolicy="no-referrer"></a>`
            : html`<div class="muted">Image not available (the stored message is gone).</div>`;
        return html`<li>${meta}${note}${image}</li>`;
    }
    return html`<li>${meta} ${row.url ? link(row.url) : ''}${note}${row.excerpt ? html`<blockquote>${row.excerpt}</blockquote>` : ''}</li>`;
}

/** input: { session, record, statusLabel, edits, evidence: [{ row, freshUrl }], appeals }. */
export function caseDetailPage({ session, access = null, moduleStates = {}, record, statusLabel, edits = [], evidence = [], appeals = [], notes = [], top = '', bottom = '' }) {
    const r = record;
    const body = html`<a class="back" href="/dashboard/cases">← Cases</a>
<h1 class="title-with-badge">Case <code data-copy="${r.case_code}">${r.case_code}</code> ${typeBadge(r.type)}${r.is_test ? html` <span class="muted">(test)</span>` : ''}</h1>
${top}
<section class="card"><dl>
<dt>Name</dt><dd>${r.name}</dd>
<dt>Status</dt><dd class="${statusClass(statusLabel)}">${statusLabel}</dd>
<dt>Member</dt><dd><a href="/dashboard/users/${encodeURIComponent(r.target_user_id)}">${r.target_username}</a> <span class="muted">${r.target_user_id}</span> · <a href="/dashboard/cases${queryString({ member: r.target_user_id })}">all their cases</a></dd>
<dt>Moderator</dt><dd>${r.moderator_username} <span class="muted">${r.moderator_id}</span>${r.is_auto ? ' (automatic)' : ''}</dd>
<dt>Reason</dt><dd>${r.reason}${r.reason_key ? html` <span class="muted">(${r.reason_key})</span>` : ''}</dd>
<dt>Created</dt><dd>${formatDate(r.created_at)}</dd>
<dt>Duration</dt><dd>${durationText(r)}</dd>
${r.expires_at ? html`<dt>Ends</dt><dd>${formatDate(r.expires_at)}</dd>` : ''}
${r.appeal_deadline ? html`<dt>Appeal deadline</dt><dd>${formatDate(r.appeal_deadline)}</dd>` : ''}
<dt>Appealable</dt><dd>${r.unappealable ? 'no' : 'yes'}</dd>
<dt>DM delivered</dt><dd>${r.dm_delivered ? 'yes' : 'no'}</dd>
<dt>Ladder level after</dt><dd>${r.ladder_level_after ?? '-'}</dd>
<dt>Tags</dt><dd>${r.tags?.length ? r.tags.map((t) => html`<a class="role-chip" href="/dashboard/cases${queryString({ tag: t })}">#${t}</a>`) : html`<span class="muted">none</span>`}</dd>
${r.revoked_at ? html`<dt>Lifted</dt><dd>${formatDate(r.revoked_at)}${r.revoke_reason ? html`: ${r.revoke_reason}` : ''}</dd>` : ''}
${r.voided_at ? html`<dt>Voided</dt><dd>${formatDate(r.voided_at)}${r.void_reason ? html`: ${r.void_reason}` : ''}</dd>` : ''}
</dl></section>
${section(`History (${edits.length})`, html`${edits.length ? html`<div class="scroll"><table><thead><tr><th>When</th><th>By</th><th>Field</th><th>Old</th><th>New</th></tr></thead><tbody>
${edits.map((e) => html`<tr><td>${formatDate(e.edited_at)}</td><td>${e.edited_by_username}</td><td>${e.field}</td><td>${e.old_value ?? '-'}</td><td>${e.new_value ?? '-'}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">Never edited.</p>`}`, '', { key: 'case-history', open: false })}
${section(`Staff notes (${notes.length})`, notes.length ? html`<ul class="evidence">${notes.map((n) => html`<li><span class="muted">${n.author_username || n.author_id} · ${formatDate(n.created_at)}</span><div>${n.text}</div></li>`)}</ul>` : html`<p class="muted">No notes. Only staff can see notes.</p>`, '', { key: 'case-notes', open: notes.length > 0 })}
${section(`Evidence (${evidence.length})`, evidence.length ? html`<ul class="evidence">${evidence.map(evidenceItem)}</ul>` : html`<p class="muted">No evidence attached.</p>`, '', { key: 'case-evidence' })}
${section(`Appeals (${appeals.length})`, html`${appeals.length ? html`<div class="scroll"><table><thead><tr><th>Filed</th><th>Status</th><th>Decided</th><th>By</th><th>Note</th></tr></thead><tbody>
${appeals.map((a) => html`<tr><td>${formatDate(a.created_at)}</td><td>${a.status}</td><td>${formatDate(a.decided_at)}</td><td>${a.decided_by_username || '-'}</td><td>${a.note || ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">No appeals.</p>`}`, '', { key: 'case-appeals', open: appeals.length > 0 })}
${bottom}`;
    return layout({ title: `Case ${r.case_code}`, active: 'cases', session, access, moduleStates, body });
}

// ── Appeals ───────────────────────────────────────────────────────────────

export function appealsPage({ session, access = null, moduleStates = {}, settingsRows = [], appeals = [], now = Date.now(), flash = null, canWrite = false }) {
    const body = html`<header class="page-head"><h1>Pending appeals (${appeals.length})</h1><p>Appeals waiting for a decision, oldest first. Amber after a day, red after three.</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${appeals.length ? html`<div class="scroll"><table><thead><tr><th>Case</th><th>Type</th><th>Member</th><th>Filed</th><th>Waiting</th><th></th></tr></thead><tbody>
${appeals.map((a) => {
        const days = (now - new Date(a.created_at).getTime()) / 86400000;
        return html`<tr><td>${caseLink(a.case_code)}${a.needsSecondReviewer ? html` <span class="warn" title="You issued this punishment, so another staff member has to decide this appeal.">Needs second reviewer</span>` : ''}</td><td>${typeBadge(a.type)}${a.is_test ? ' (test)' : ''}</td><td>${a.username} <span class="muted">${a.user_id}</span></td>
<td>${formatDate(a.created_at)}</td><td class="${days >= 3 ? 'bad' : days >= 1 ? 'warn' : ''}">${formatAge(a.created_at, now)}</td>
<td><a href="/dashboard/appeals/${encodeURIComponent(a.case_code)}">${canWrite ? 'Review and decide' : 'Open'}</a></td></tr>`;
    })}
</tbody></table></div><p class="muted">${canWrite ? 'Decide here or in Discord (Accept / Deny on the appeal message): the effects are the same.' : 'Administrators decide appeals here (with editing on) or in Discord.'}</p>` : html`<p class="empty">No pending appeals. New appeals show up here and in the appeal channels in Discord.</p>`}`;
    return layout({ title: 'Appeals', active: 'appeals', session, access, moduleStates, body: html`${body}${settingsSection(settingsRows)}` });
}

// ── Staff stats ───────────────────────────────────────────────────────────

/** input: { session, period, rows (staffModerationStats) }. */
export function statsPage({ session, access = null, moduleStates = {}, settingsRows = [], period = '30d', rows = [], sections = [], flash = null, error = null }) {
    const periodChips = html`<nav class="chips" aria-label="Period">${Object.keys(STATS_PERIODS).map((key) => html`<a class="chip${key === period ? ' is-active' : ''}" href="/dashboard/staff${queryString({ period: key })}"${key === period ? raw(' aria-current="page"') : ''}>${STATS_PERIODS[key].label}</a>`)}</nav>`;
    const table = html`${rows.length ? html`<div class="scroll"><table><thead><tr><th>Moderator</th><th>Total</th><th>Bans</th><th>Kicks</th><th>Mutes</th><th>Warns</th><th>Appeals accepted</th><th>Appeals denied</th><th>Voided</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td><a href="/dashboard/cases${queryString({ moderator: r.moderatorId })}">${r.username}</a></td><td>${r.total}</td><td>${r.actions.ban}</td><td>${r.actions.kick}</td><td>${r.actions.mute}</td><td>${r.actions.warn}</td><td>${r.appealsAccepted}</td><td>${r.appealsDenied}</td><td>${r.voided}</td></tr>`)}
</tbody></table></div><p class="muted">Automatic (bot) and test cases are left out; voided cases are not in the totals.</p>` : html`<p class="empty">No moderation actions in this period.</p>`}`;
    const body = html`<header class="page-head"><h1>Staff</h1><p>Moderation per moderator, when the team is active, weekly activity, staff discipline and mass-action guard blocks.</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${section(`Moderation stats · ${STATS_PERIODS[period]?.label || period}`, html`${periodChips}${table}`, '', { key: 'staff-stats' })}
${sections}`;
    return layout({ title: 'Staff', active: 'staff', session, access, moduleStates, body: html`${body}${settingsSection(settingsRows, 'Enforcement settings')}` });
}

// ── Audit ─────────────────────────────────────────────────────────────────

const AUDIT_VALUE_PREVIEW = 120;
/** An audited value; a long one shows its start, the rest behind "Show all" (nothing is dropped). */
export function auditValue(value) {
    if (value === null || value === undefined) return '(none)';
    const full = typeof value === 'string' ? value : JSON.stringify(value);
    if (full.length <= AUDIT_VALUE_PREVIEW) return full;
    return html`<details class="long-value"><summary>${full.slice(0, AUDIT_VALUE_PREVIEW)}… <span class="muted">Show all (${full.length} characters)</span></summary><div class="long-value-full">${full}</div></details>`;
}

/**
 * input: { rows (dashboard_audit, newest first), total, page, pageSize, filters: { user, module },
 * users: [{ user_id, username }], modules: [{ key, label }] }.
 */
export function auditPage({ session, access = null, moduleStates = {}, rows = [], total = rows.length, page = 0, pageSize = 50, filters = {}, users = [], modules = [] }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const keep = { user: filters.user, module: filters.module };
    const pager = html`<div class="pager">
${page > 0 ? html`<a href="/dashboard/audit${queryString({ ...keep, page: page - 1 })}">← Newer</a>` : ''}
<span class="muted">Page ${page + 1} of ${pages} · ${total} change${total === 1 ? '' : 's'}</span>
${page + 1 < pages ? html`<a href="/dashboard/audit${queryString({ ...keep, page: page + 1 })}">Older →</a>` : ''}
</div>`;
    const moduleLabel = (key) => navItems().find((i) => i.key === key)?.label || modules.find((m) => m.key === key)?.label || key;
    const body = html`<header class="page-head"><h1>Audit log</h1><p class="muted">Every change made from the dashboard: who, when, old value → new value. Each saved form is also posted to the mod log.</p></header>
<form class="filters" method="get" action="/dashboard/audit">
<label>Who<select name="user">${option('', 'anyone', !filters.user)}${users.map((u) => option(u.user_id, `${u.username || u.user_id} (${u.user_id})`, filters.user === u.user_id))}</select></label>
<label>Module<select name="module">${option('', 'any', !filters.module)}${modules.map((m) => option(m.key, m.label, filters.module === m.key))}</select></label>
<button class="primary" type="submit">Filter</button> <a href="/dashboard/audit">Clear</a>
</form>
${rows.length ? html`<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Module</th><th>Setting</th><th>Old</th><th>New</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td>${timeTag(r.created_at)}</td><td>${r.username || r.user_id || '-'} <span class="muted">${r.user_id || ''}</span></td><td>${moduleLabel(r.module)}</td><td><code>${r.key}</code></td><td class="value">${auditValue(r.old)}</td><td class="value">${auditValue(r.new)}</td></tr>`)}
</tbody></table></div>${pager}` : filters.user || filters.module
        ? html`<p class="empty">No changes match these filters. <a href="/dashboard/audit">Clear filters</a></p>`
        : html`<p class="empty">No changes yet. Every save from the dashboard is listed here.</p>`}`;
    return layout({ title: 'Audit log', active: 'audit', session, access, moduleStates, body });
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
    const help = tr.has(helpKey) ? tr.t(helpKey) : module.help;
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
