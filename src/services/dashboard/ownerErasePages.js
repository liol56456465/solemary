// ownerErasePages.js — Owner area "Erase a case" (privacy request): the form, the confirm
// page naming the case, and the result. Pure: data in, HTML out, everything escaped by the
// `html` template. No inline styles or scripts (CSP). Routes: ownerRoutes.js; the erase
// itself: services/privacy/caseErase.js.

import { formatDate, html, layout, path } from './html.js';
import { actionForm, confirmButtons } from './enforcementPages.js';

const ACTIVE = 'owner/erase';

function notices({ flash = null, error = null, editEnabled = true }) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">Read-only: editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED is not true).</p>` : ''}`;
}

const EFFECT = {
    anonymise: 'This is a warn that still counts on the warn ladder, so the case stays as a counted row: its reason, name, tags, notes, edit history and appeal texts are replaced with “[removed on request]”, its evidence is deleted. The ladder does not change.',
    delete: 'The case is deleted with its notes, evidence, edit history and appeals. The warn ladder does not change.',
};

/** The form: a case code. */
export function erasePage({ session, access = null, moduleStates = {}, flash = null, error = null, editEnabled = true, code = '' }) {
    const body = html`<header class="page-head"><h1>Erase a case</h1><p class="muted">For a privacy request (right to erasure). Enter the case code; the next page shows the case and what will happen before anything changes.</p></header>
${notices({ flash, error, editEnabled })}
<section class="card">${actionForm(session.csrf, '/owner/erase/preview', html`<label>Case code<input name="code" maxlength="10" required autocomplete="off" value="${code}"></label>`, { submit: 'Show the case', enabled: editEnabled })}
<p class="muted">The values in the dashboard audit log for this case are replaced too (who and when stay). Messages the bot already posted (mod log, DMs) are not changed; delete those in Discord if needed.</p></section>`;
    return layout({ title: 'Erase a case', active: ACTIVE, session, access, moduleStates, body });
}

/** preview: previewCaseErase's result (mode set, no refusal). */
export function eraseConfirmPage({ session, access = null, moduleStates = {}, preview, token, hash }) {
    const c = preview.case;
    const n = preview.counts || {};
    const body = html`<p><a href="${path('/owner/erase')}">← Back (cancel)</a></p>
<h1>Confirm: erase case ${preview.code}</h1>
<section class="card confirm-card"><dl>
<dt>Case</dt><dd><code>${preview.code}</code> · ${c.type} · ${c.name}</dd>
<dt>Member</dt><dd>${c.target_username} <span class="muted">${c.target_user_id}</span></dd>
<dt>Server</dt><dd><span class="muted">${c.guild_id}</span></dd>
<dt>Created</dt><dd>${formatDate(c.created_at)} by ${c.moderator_username}</dd>
<dt>Status</dt><dd>${c.status}</dd>
<dt>Reason</dt><dd>${c.reason}</dd>
<dt>Stored with it</dt><dd>${n.notes ?? 0} note(s), ${n.evidence ?? 0} evidence item(s), ${n.edits ?? 0} edit(s), ${n.appeals ?? 0} appeal(s) / report(s)</dd>
<dt>Effect</dt><dd>${EFFECT[preview.mode]}</dd></dl>
<p class="muted">This cannot be undone. This confirmation works once and expires in 5 minutes.</p>
${confirmButtons(session.csrf, '/owner/erase', { submit: preview.mode === 'anonymise' ? `Anonymise case ${preview.code} for good` : `Delete case ${preview.code} for good`, hidden: { token, fh: hash, code: preview.code }, cancelHref: path('/owner/erase') })}</section>`;
    return layout({ title: `Erase ${preview.code}`, active: ACTIVE, session, access, moduleStates, body });
}
