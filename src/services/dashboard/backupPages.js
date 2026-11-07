// backupPages.js: Dashboard → Settings backup (services/settings/settingsBackup.js).
// Download every setting as a file; load a file back after seeing exactly what changes.

import { html, layout, path } from './html.js';
import { currentText, dashboardText } from './language.js';

const shortValue = (value, tr = currentText()) => {
    const text = value === null || value === undefined ? tr.t('backups.none') : typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
};

function uploadForm(csrf, tr) {
    return html`<form method="post" action="${path('/backup/preview')}" enctype="multipart/form-data" class="settings-form" data-dirty><input type="hidden" name="csrf" value="${csrf}">
<label class="wide">${tr.t('backups.page.file')}<input type="file" name="file" accept="application/json,.json" required></label>
<div class="form-actions"><button class="primary" type="submit">${tr.t('backups.page.check')}</button></div></form>`;
}

export function backupPage({ session, access = null, moduleStates = {}, canWrite = false, flash = null, error = null }) {
    const tr = dashboardText(session?.lang);
    const title = tr.t('frame.nav.items.backup');
    const body = html`<header class="page-head"><h1>${title}</h1><p class="muted">${tr.t('backups.page.intro')}</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<section class="card"><h2>${tr.t('backups.page.download')}</h2><p><a class="btn primary" href="${path('/backup/download')}" download>${tr.t('backups.page.downloadButton')}</a></p></section>
<section class="card"><h2>${tr.t('backups.page.load')}</h2>
${canWrite ? html`<p class="muted">${tr.t('backups.page.loadHelp')}</p>${uploadForm(session.csrf, tr)}`
        : html`<p class="muted">${tr.t('backups.page.loadNeedsAdmin')}</p>`}</section>`;
    return layout({ title, active: 'backup', session, access, moduleStates, body });
}

/** The preview after an upload: changes, skipped entries, and Apply (with a one-time token). */
export function backupPreviewPage({ session, access = null, moduleStates = {}, plan, token }) {
    const tr = dashboardText(session?.lang);
    const count = plan.changes.length;
    const body = html`<p><a href="${path('/backup')}">← ${tr.t('frame.nav.items.backup')}</a></p>
<header class="page-head"><h1>${tr.t('backups.preview.title')}</h1></header>
${count ? html`<section class="card"><h2>${tr.tp('backups.preview.wouldChange', count)}</h2>
<div class="scroll"><table><thead><tr><th>${tr.t('backups.preview.server')}</th><th>${tr.t('backups.preview.setting')}</th><th>${tr.t('backups.preview.now')}</th><th>${tr.t('backups.preview.fromFile')}</th></tr></thead><tbody>
${plan.changes.map((c) => html`<tr><td>${c.guild}</td><td>${c.label}</td><td class="value">${shortValue(c.old, tr)}</td><td class="value">${shortValue(c.new, tr)}</td></tr>`)}
</tbody></table></div>
<form method="post" action="${path('/backup/apply')}" class="settings-form" data-confirm="${tr.tp('backups.preview.confirm', count)}"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="token" value="${token}">
<div class="form-actions"><button class="danger" type="submit">${tr.t('backups.preview.apply')}</button> <a href="${path('/backup')}">${tr.t('backups.preview.cancel')}</a></div></form>
<p class="muted">${tr.t('backups.preview.once')}</p></section>`
        : html`<p class="notice">${tr.t('backups.preview.same')}</p>`}
${plan.problems.length ? html`<section class="card"><h2>${tr.t('backups.preview.skipped', { n: tr.fmtNumber(plan.problems.length) })}</h2><ul>${plan.problems.map((p) => html`<li>${p}</li>`)}</ul></section>` : ''}`;
    return layout({ title: tr.t('backups.preview.title'), active: 'backup', session, access, moduleStates, body });
}
