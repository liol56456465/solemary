// pages.js — the dashboard's records pages (read-only in Phase 1). Pure: data in, HTML string out. Every value
// goes through the escaping `html` template (html.js).

import { AUTOMOD_RULES } from '../../config/automod.js';
import { formatDuration } from '../enforcement/format.js';
import { SEARCH_STATUSES, SEARCH_TYPES } from '../enforcement/caseSearchService.js';
import { STATS_PERIODS } from '../staffActivityService.js';
import { formatAge, formatDate, html, layout, queryString, raw } from './html.js';

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

// ── Settings (read-only in Phase 1) ───────────────────────────────────────

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
</tbody></table></div><p class="muted">Read-only for now; editing arrives in Phase 2.</p>`;
}

// ── Cases ─────────────────────────────────────────────────────────────────

/**
 * input: { session, query (raw strings as typed), rows, total, page, pageSize, error,
 * statusLabel(row) }.
 */
export function casesPage({ session, access = null, moduleStates = {}, query = {}, rows = [], total = 0, page = 0, pageSize = 25, error = null, statusLabel = (r) => r.status }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const keep = { member: query.member, moderator: query.moderator, type: query.type, status: query.status, text: query.text, from: query.from, to: query.to };
    const pager = html`<div class="pager">
${page > 0 ? html`<a href="/dashboard/cases${queryString({ ...keep, page: page - 1 })}">← Newer</a>` : ''}
<span class="muted">Page ${page + 1} of ${pages} · ${total} case${total === 1 ? '' : 's'}</span>
${page + 1 < pages ? html`<a href="/dashboard/cases${queryString({ ...keep, page: page + 1 })}">Older →</a>` : ''}
</div>`;
    const body = html`<h1>Cases</h1>
<form class="filters" method="get" action="/dashboard/cases">
<label>Member ID<input name="member" value="${query.member || ''}" inputmode="numeric" maxlength="20"></label>
<label>Moderator ID<input name="moderator" value="${query.moderator || ''}" inputmode="numeric" maxlength="20"></label>
<label>Type<select name="type">${option('', 'any', !query.type)}${SEARCH_TYPES.map((t) => option(t, t, query.type === t))}</select></label>
<label>Status<select name="status">${option('', 'any', !query.status)}${SEARCH_STATUSES.map((s) => option(s, s, query.status === s))}</select></label>
<label>Text<input name="text" value="${query.text || ''}" maxlength="100"></label>
<label>From<input type="date" name="from" value="${query.from || ''}"></label>
<label>To<input type="date" name="to" value="${query.to || ''}"></label>
<button class="primary" type="submit">Search</button> <a href="/dashboard/cases">Clear</a>
</form>
${error ? html`<p class="bad">${error}</p>` : ''}
${rows.length ? html`<div class="scroll"><table><thead><tr><th>Case</th><th>Type</th><th>Member</th><th>Moderator</th><th>Reason</th><th>Date</th><th>Status</th></tr></thead><tbody>
${rows.map((row) => {
        const label = statusLabel(row);
        return html`<tr><td>${caseLink(row.case_code)}</td><td>${row.type}${row.is_test ? html` <span class="muted">(test)</span>` : ''}</td>
<td>${row.target_username} <span class="muted">${row.target_user_id}</span></td><td>${row.moderator_username}</td>
<td>${row.reason}</td><td>${formatDate(row.created_at)}</td><td class="${statusClass(label)}">${label}</td></tr>`;
    })}
</tbody></table></div>${pager}` : html`<p class="muted">No cases match.</p>`}`;
    return layout({ title: 'Cases', active: 'cases', session, access, moduleStates, body });
}

// ── Case detail ───────────────────────────────────────────────────────────

function durationText(record) {
    if (record.type === 'warn' || record.type === 'kick') return '—';
    if (!record.duration_ms) return record.type === 'ban' ? 'permanent' : '—';
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
export function caseDetailPage({ session, access = null, moduleStates = {}, record, statusLabel, edits = [], evidence = [], appeals = [] }) {
    const r = record;
    const body = html`<p><a href="/dashboard/cases">← Cases</a></p>
<h1>Case <code>${r.case_code}</code> · ${r.type}${r.is_test ? ' (test)' : ''}</h1>
<dl>
<dt>Name</dt><dd>${r.name}</dd>
<dt>Status</dt><dd class="${statusClass(statusLabel)}">${statusLabel}</dd>
<dt>Member</dt><dd>${r.target_username} <span class="muted">${r.target_user_id}</span> · <a href="/dashboard/cases${queryString({ member: r.target_user_id })}">all their cases</a></dd>
<dt>Moderator</dt><dd>${r.moderator_username} <span class="muted">${r.moderator_id}</span>${r.is_auto ? ' (automatic)' : ''}</dd>
<dt>Reason</dt><dd>${r.reason}${r.reason_key ? html` <span class="muted">(${r.reason_key})</span>` : ''}</dd>
<dt>Created</dt><dd>${formatDate(r.created_at)}</dd>
<dt>Duration</dt><dd>${durationText(r)}</dd>
${r.expires_at ? html`<dt>Ends</dt><dd>${formatDate(r.expires_at)}</dd>` : ''}
${r.appeal_deadline ? html`<dt>Appeal deadline</dt><dd>${formatDate(r.appeal_deadline)}</dd>` : ''}
<dt>Appealable</dt><dd>${r.unappealable ? 'no' : 'yes'}</dd>
<dt>DM delivered</dt><dd>${r.dm_delivered ? 'yes' : 'no'}</dd>
<dt>Ladder level after</dt><dd>${r.ladder_level_after ?? '—'}</dd>
${r.revoked_at ? html`<dt>Lifted</dt><dd>${formatDate(r.revoked_at)}${r.revoke_reason ? html` — ${r.revoke_reason}` : ''}</dd>` : ''}
${r.voided_at ? html`<dt>Voided</dt><dd>${formatDate(r.voided_at)}${r.void_reason ? html` — ${r.void_reason}` : ''}</dd>` : ''}
</dl>
<h2>History (${edits.length})</h2>
${edits.length ? html`<div class="scroll"><table><thead><tr><th>When</th><th>By</th><th>Field</th><th>Old</th><th>New</th></tr></thead><tbody>
${edits.map((e) => html`<tr><td>${formatDate(e.edited_at)}</td><td>${e.edited_by_username}</td><td>${e.field}</td><td>${e.old_value ?? '—'}</td><td>${e.new_value ?? '—'}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">Never edited.</p>`}
<h2>Evidence (${evidence.length})</h2>
${evidence.length ? html`<ul class="evidence">${evidence.map(evidenceItem)}</ul>` : html`<p class="muted">No evidence attached.</p>`}
<h2>Appeals (${appeals.length})</h2>
${appeals.length ? html`<div class="scroll"><table><thead><tr><th>Filed</th><th>Status</th><th>Decided</th><th>By</th><th>Note</th></tr></thead><tbody>
${appeals.map((a) => html`<tr><td>${formatDate(a.created_at)}</td><td>${a.status}</td><td>${formatDate(a.decided_at)}</td><td>${a.decided_by_username || '—'}</td><td>${a.note || ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">No appeals.</p>`}`;
    return layout({ title: `Case ${r.case_code}`, active: 'cases', session, access, moduleStates, body });
}

// ── Appeals ───────────────────────────────────────────────────────────────

export function appealsPage({ session, access = null, moduleStates = {}, settingsRows = [], appeals = [], now = Date.now() }) {
    const body = html`<h1>Pending appeals (${appeals.length})</h1>
${appeals.length ? html`<div class="scroll"><table><thead><tr><th>Case</th><th>Type</th><th>Member</th><th>Filed</th><th>Waiting</th></tr></thead><tbody>
${appeals.map((a) => {
        const days = (now - new Date(a.created_at).getTime()) / 86400000;
        return html`<tr><td>${caseLink(a.case_code)}</td><td>${a.type}${a.is_test ? ' (test)' : ''}</td><td>${a.username} <span class="muted">${a.user_id}</span></td>
<td>${formatDate(a.created_at)}</td><td class="${days >= 3 ? 'bad' : days >= 1 ? 'warn' : ''}">${formatAge(a.created_at, now)}</td></tr>`;
    })}
</tbody></table></div><p class="muted">Decide appeals in Discord (Accept / Deny on the appeal message or <code>/appeals</code>).</p>` : html`<p class="muted">No pending appeals.</p>`}`;
    return layout({ title: 'Appeals', active: 'appeals', session, access, moduleStates, body: html`${body}${settingsSection(settingsRows)}` });
}

// ── Automod ───────────────────────────────────────────────────────────────

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

/** input: { session, byRule (automodRuleStats), stats (automodStats, 7 days) }. */
export function automodPage({ session, access = null, moduleStates = {}, settingsRows = [], byRule = {}, stats = { total: 0, byGroup: [] }, days = 7 }) {
    const rules = Object.entries(byRule).sort((a, b) => b[1].actions - a[1].actions);
    const body = html`<h1>Automod · last ${days} days</h1>
<p>${stats.total} automatic action${stats.total === 1 ? '' : 's'}. <span class="muted">Undo rate = moderators reversed or changed the decision; 30% or more suggests the rule is too strict.</span></p>
<h2>By rule</h2>
${rules.length ? html`<div class="scroll"><table><thead><tr><th>Rule</th><th>Actions</th><th>Undone</th><th>Changed</th><th>Undo rate</th></tr></thead><tbody>
${rules.map(([rule, t]) => {
        const rate = pct(t.undone + t.changed, t.actions);
        return html`<tr><td>${AUTOMOD_RULES[rule]?.label || rule}</td><td>${t.actions}</td><td>${t.undone}</td><td>${t.changed}</td><td class="${rate >= 30 ? 'bad' : ''}">${rate}%</td></tr>`;
    })}
</tbody></table></div>` : html`<p class="muted">No automod actions.</p>`}
<h2>By group (with accepted appeals)</h2>
${stats.byGroup.length ? html`<div class="scroll"><table><thead><tr><th>Group</th><th>Actions</th><th>Undone</th><th>Changed</th><th>Appeals accepted</th><th>Undo rate</th></tr></thead><tbody>
${stats.byGroup.map((g) => {
        const rate = pct(g.undone + g.changed, g.actions);
        return html`<tr><td>${g.label}</td><td>${g.actions}</td><td>${g.undone}</td><td>${g.changed}</td><td>${g.appealed}</td><td class="${rate >= 30 ? 'bad' : ''}">${rate}%</td></tr>`;
    })}
</tbody></table></div>` : html`<p class="muted">None.</p>`}`;
    return layout({ title: 'Automod', active: 'automod', session, access, moduleStates, body: html`${body}${settingsSection(settingsRows)}` });
}

// ── Staff stats ───────────────────────────────────────────────────────────

/** input: { session, period, rows (staffModerationStats) }. */
export function statsPage({ session, access = null, moduleStates = {}, settingsRows = [], period = '30d', rows = [] }) {
    const body = html`<h1>Staff moderation stats · ${STATS_PERIODS[period]?.label || period}</h1>
<p>${Object.keys(STATS_PERIODS).map((key) => (key === period
        ? html`<strong>${STATS_PERIODS[key].label}</strong> `
        : html`<a href="/dashboard/staff${queryString({ period: key })}">${STATS_PERIODS[key].label}</a> `))}</p>
${rows.length ? html`<div class="scroll"><table><thead><tr><th>Moderator</th><th>Total</th><th>Bans</th><th>Kicks</th><th>Mutes</th><th>Warns</th><th>Appeals accepted</th><th>Appeals denied</th><th>Voided</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td><a href="/dashboard/cases${queryString({ moderator: r.moderatorId })}">${r.username}</a></td><td>${r.total}</td><td>${r.actions.ban}</td><td>${r.actions.kick}</td><td>${r.actions.mute}</td><td>${r.actions.warn}</td><td>${r.appealsAccepted}</td><td>${r.appealsDenied}</td><td>${r.voided}</td></tr>`)}
</tbody></table></div><p class="muted">Automatic (bot) and test cases are left out; voided cases are not in the totals.</p>` : html`<p class="muted">No moderation actions in this period.</p>`}`;
    return layout({ title: 'Staff stats', active: 'staff', session, access, moduleStates, body: html`${body}${settingsSection(settingsRows, 'Enforcement settings')}` });
}

// ── Audit ─────────────────────────────────────────────────────────────────

const auditValue = (value) => (value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value));

/** input: { session, rows (dashboard_audit, newest first) }. */
export function auditPage({ session, access = null, moduleStates = {}, rows = [] }) {
    const body = html`<h1>Audit log</h1>
<p class="muted">Every settings change made from the dashboard: who, when, old value → new value.</p>
${rows.length ? html`<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Module</th><th>Setting</th><th>Old</th><th>New</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td>${formatDate(r.created_at)}</td><td>${r.username || r.user_id || '—'} <span class="muted">${r.user_id || ''}</span></td><td>${r.module}</td><td><code>${r.key}</code></td><td>${auditValue(r.old)}</td><td>${auditValue(r.new)}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">No changes yet.</p>`}`;
    return layout({ title: 'Audit', active: 'audit', session, access, moduleStates, body });
}

// ── Modules not built yet ─────────────────────────────────────────────────

/** A Phase 2 module page: what it will hold, plus its current values (read-only). */
export function modulePage({ session, access = null, moduleStates = {}, item, enabled = null, settingsRows = [], note = '' }) {
    const body = html`<h1>${item.label}</h1>
${enabled === null ? '' : html`<p>Status: <span class="state ${enabled ? 'state-on' : 'state-off'}">${enabled ? 'on' : 'off'}</span></p>`}
<p>Settings for this module arrive in Phase 2. Until then, configure it with the bot's slash commands.</p>
${note ? html`<p class="muted">${note}</p>` : ''}
${settingsSection(settingsRows, 'Current settings')}`;
    return layout({ title: item.label, active: item.key, session, access, moduleStates, body });
}
