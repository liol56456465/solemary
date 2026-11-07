// ownerErasePages.js — Owner area "Erase a case" (privacy request): the form, the confirm
// page naming the case, and the result. Pure: data in, HTML out, everything escaped by the
// `html` template. No inline styles or scripts (CSP). Routes: ownerRoutes.js; the erase
// itself: services/privacy/caseErase.js.

import { formatDate, html, layout, path } from './html.js';
import { actionForm, confirmButtons } from './enforcementPages.js';
import { currentText, dashboardText } from './language.js';

const ACTIVE = 'owner/erase';

function notices({ flash = null, error = null, editEnabled = true }) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">${currentText().t('owner.common.readOnly')}</p>` : ''}`;
}

const EFFECT = {
    anonymise: 'owner.erase.effectAnonymise',
    delete: 'owner.erase.effectDelete',
};

/** The form: a case code. */
export function erasePage({ session, access = null, moduleStates = {}, flash = null, error = null, editEnabled = true, code = '' }) {
    const tr = dashboardText(session?.lang);
    const body = html`<header class="page-head"><h1>${tr.t('owner.erase.title')}</h1><p class="muted">${tr.t('owner.erase.help')}</p></header>
${notices({ flash, error, editEnabled })}
<section class="card">${actionForm(session.csrf, '/owner/erase/preview', html`<label>${tr.t('owner.erase.code')}<input name="code" maxlength="10" required autocomplete="off" value="${code}"></label>`, { submit: tr.t('owner.erase.show'), enabled: editEnabled })}
<p class="muted">${tr.t('owner.erase.note')}</p></section>`;
    return layout({ title: tr.t('owner.erase.title'), active: ACTIVE, session, access, moduleStates, body });
}

/** preview: previewCaseErase's result (mode set, no refusal). */
export function eraseConfirmPage({ session, access = null, moduleStates = {}, preview, token, hash }) {
    const c = preview.case;
    const n = preview.counts || {};
    const tr = dashboardText(session?.lang);
    const body = html`<p><a href="${path('/owner/erase')}">${tr.t('owner.common.backCancel')}</a></p>
<h1>${tr.t('owner.erase.confirmTitle', { code: preview.code })}</h1>
<section class="card confirm-card"><dl>
<dt>${tr.t('owner.erase.case')}</dt><dd><code>${preview.code}</code> · ${c.type} · ${c.name}</dd>
<dt>${tr.t('owner.erase.member')}</dt><dd>${c.target_username} <span class="muted">${c.target_user_id}</span></dd>
<dt>${tr.t('owner.common.server')}</dt><dd><span class="muted">${c.guild_id}</span></dd>
<dt>${tr.t('owner.common.created')}</dt><dd>${tr.t('owner.erase.createdBy', { date: formatDate(c.created_at), mod: c.moderator_username })}</dd>
<dt>${tr.t('owner.profile.status')}</dt><dd>${c.status}</dd>
<dt>${tr.t('owner.blacklist.reason')}</dt><dd>${c.reason}</dd>
<dt>${tr.t('owner.erase.stored')}</dt><dd>${tr.t('owner.erase.storedValue', { notes: n.notes ?? 0, evidence: n.evidence ?? 0, edits: n.edits ?? 0, appeals: n.appeals ?? 0 })}</dd>
<dt>${tr.t('owner.common.effect')}</dt><dd>${tr.t(EFFECT[preview.mode])}</dd></dl>
<p class="muted">${tr.t('owner.erase.cannotUndo')} ${tr.t('owner.common.confirmOnce')}</p>
${confirmButtons(session.csrf, '/owner/erase', { submit: preview.mode === 'anonymise' ? tr.t('owner.erase.anonymiseButton', { code: preview.code }) : tr.t('owner.erase.deleteButton', { code: preview.code }), hidden: { token, fh: hash, code: preview.code }, cancelHref: path('/owner/erase') })}</section>`;
    return layout({ title: tr.t('owner.erase.pageTitle', { code: preview.code }), active: ACTIVE, session, access, moduleStates, body });
}
