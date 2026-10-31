// backupPages.js: Dashboard → Settings backup (services/settings/settingsBackup.js).
// Download every setting as a file; load a file back after seeing exactly what changes.

import { html, layout, path } from './html.js';

const shortValue = (value) => {
    const text = value === null || value === undefined ? '(none)' : typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
};

function uploadForm(csrf) {
    return html`<form method="post" action="${path('/backup/preview')}" enctype="multipart/form-data" class="settings-form" data-dirty><input type="hidden" name="csrf" value="${csrf}">
<label class="wide">Backup file (.json)<input type="file" name="file" accept="application/json,.json" required></label>
<div class="form-actions"><button class="primary" type="submit">Check this file</button></div></form>`;
}

export function backupPage({ session, access = null, moduleStates = {}, canWrite = false, flash = null, error = null }) {
    const body = html`<header class="page-head"><h1>Settings backup</h1><p class="muted">Every dashboard setting of the main and the support server in one file. Use it before big changes, or to move to a new host. Secrets are never in it.</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<section class="card"><h2>Download</h2><p><a class="button" href="${path('/backup/download')}" download>Download settings (.json)</a></p></section>
<section class="card"><h2>Load a backup</h2>
${canWrite ? html`<p class="muted">Nothing changes yet: you first see every setting the file would change, then choose to apply it.</p>${uploadForm(session.csrf)}`
        : html`<p class="muted">Loading a backup needs Administrator and editing turned on.</p>`}</section>`;
    return layout({ title: 'Settings backup', active: 'backup', session, access, moduleStates, body });
}

/** The preview after an upload: changes, skipped entries, and Apply (with a one-time token). */
export function backupPreviewPage({ session, access = null, moduleStates = {}, plan, token }) {
    const body = html`<p><a href="${path('/backup')}">← Settings backup</a></p>
<header class="page-head"><h1>Check the backup</h1></header>
${plan.changes.length ? html`<section class="card"><h2>${plan.changes.length} setting${plan.changes.length === 1 ? '' : 's'} would change</h2>
<div class="scroll"><table><thead><tr><th>Server</th><th>Setting</th><th>Now</th><th>From the file</th></tr></thead><tbody>
${plan.changes.map((c) => html`<tr><td>${c.guild}</td><td>${c.label}</td><td class="value">${shortValue(c.old)}</td><td class="value">${shortValue(c.new)}</td></tr>`)}
</tbody></table></div>
<form method="post" action="${path('/backup/apply')}" class="settings-form" data-confirm="Apply ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'} from the backup?"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="token" value="${token}">
<div class="form-actions"><button class="danger" type="submit">Apply these changes</button> <a href="${path('/backup')}">Cancel</a></div></form>
<p class="muted">This works once and expires in 10 minutes. Every change goes to the audit log.</p></section>`
        : html`<p class="notice">The file matches the current settings. Nothing would change.</p>`}
${plan.problems.length ? html`<section class="card"><h2>Skipped (${plan.problems.length})</h2><ul>${plan.problems.map((p) => html`<li>${p}</li>`)}</ul></section>` : ''}`;
    return layout({ title: 'Check the backup', active: 'backup', session, access, moduleStates, body });
}
