// serverDataPages.js — "Delete this server's data" on the dashboard (owner decision 2026-11-07):
// the Overview danger-zone card (server owner only), the preview / status page in a server, and
// the same page for a server Mewvo already left (no sidebar: the server is not open any more).
// Pure: data in, HTML out, escaped by the `html` template; no inline styles or scripts (CSP).
// Routes: serverDataRoutes.js; the work: services/privacy/serverDataDeletion.js.

import { html, layout, path, rootPath } from './html.js';
import { dashboardText } from './language.js';
import { KINDS } from '../privacy/serverDataInventory.js';
import { GRACE_DAYS } from '../privacy/serverDataDeletion.js';

const fmtDate = (tr, iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : tr.fmtDateTime(date);
};

/** A small POST form with one button (CSRF token included). */
function postButton(csrf, action, label, { danger = false, fields = '' } = {}) {
    return html`<form method="post" action="${action}" class="settings-form confirm-form"><input type="hidden" name="csrf" value="${csrf}">${fields}
<div class="buttons"><button type="submit" class="${danger ? 'danger' : 'secondary'}">${label}</button></div></form>`;
}

/** The status of a pending or finished request, with [Cancel deletion] while it can be cancelled. */
function statusBlock(record, { csrf, cancelAction, tr }) {
    if (!record) return '';
    if (record.status === 'done') return html`<p class="notice" role="status">${tr.t('serverData.status.done', { date: fmtDate(tr, record.doneAt) })}</p>`;
    if (record.status === 'running') return html`<p class="notice" role="status">${tr.t('serverData.status.running')}</p>`;
    return html`<p class="notice" role="status">${tr.t('serverData.status.scheduled', { date: fmtDate(tr, record.dueAt) })}${record.removeBot ? html` ${tr.t('serverData.status.leave')}` : ''}</p>
${record.lastError ? html`<p class="muted">${tr.t('serverData.status.retry')}</p>` : ''}
${postButton(csrf, cancelAction, tr.t('serverData.card.cancel'))}`;
}

/**
 * The Overview card, only rendered for the server's owner: a link to the preview, or the pending
 * request with its Cancel button. info: { record } (record null = nothing pending).
 */
export function serverDataCard(info, { csrf, tr = dashboardText('en') } = {}) {
    if (!info) return '';
    const record = info.record || null;
    const pending = record && (record.status === 'scheduled' || record.status === 'running');
    const body = pending
        ? statusBlock(record, { csrf, cancelAction: path('/server-data/cancel'), tr })
        : html`<p class="muted">${tr.t('serverData.card.intro')}</p><p><a class="btn" href="${path('/server-data')}">${tr.t('serverData.card.open')}</a></p>`;
    return html`<section class="tile-card ov-card ov-wide danger-zone"><header class="card-top card-top-row"><h2>${tr.t('serverData.card.title')}</h2></header><div class="section-body">${body}</div></section>`;
}

/** The counts per kind, and per table in a <details>. */
function countsBlock(preview, tr) {
    const kinds = KINDS.filter((kind) => preview.kinds[kind] > 0);
    if (!kinds.length) return html`<p class="muted">${tr.t('serverData.note.empty')}</p>`;
    const tables = preview.tables.filter((row) => row.count > 0);
    return html`<dl>${kinds.map((kind) => html`<dt>${tr.t(`serverData.kind.${kind}`)}</dt><dd>${tr.fmtNumber(preview.kinds[kind])}</dd>`)}</dl>
<p class="muted">${tr.t('serverData.page.total', { count: tr.fmtNumber(preview.total) })}</p>
<details><summary>${tr.t('serverData.page.details')}</summary><ul class="name-list">${tables.map((row) => html`<li><code>${row.table}</code>${row.note ? html` <span class="muted">(${row.note})</span>` : ''}: ${tr.fmtNumber(row.count)}</li>`)}</ul></details>`;
}

const NOTES = ['record', 'active', 'untouched'];

/**
 * The page body (shared by both paths). opts: { preview, record, csrf, requestAction, cancelAction,
 * backHref, backText, intro, inGuild, editEnabled, tr }.
 */
function pageBody({ preview, record, csrf, requestAction, cancelAction, backHref, backText, intro, inGuild, editEnabled, flash = null, error = null, tr }) {
    const pending = record && (record.status === 'scheduled' || record.status === 'running');
    const confirm = pending || !editEnabled ? '' : html`<form method="post" action="${requestAction}" class="settings-form confirm-form"><input type="hidden" name="csrf" value="${csrf}">
${inGuild ? html`<label class="check"><input type="checkbox" name="removeBot" value="1"> ${tr.t('serverData.page.removeBot')}</label>` : ''}
<div class="buttons"><button type="submit" class="danger">${tr.t('serverData.page.confirm', { days: GRACE_DAYS })}</button> <a class="btn" href="${backHref}">${tr.t('members.confirm.cancel')}</a></div></form>`;
    return html`<p><a href="${backHref}">${backText}</a></p>
<header class="page-head"><h1>${tr.t('serverData.page.title')}</h1><p class="muted">${intro}</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">${tr.t('owner.common.readOnly')}</p>` : ''}
<section class="card confirm-card">${statusBlock(record, { csrf, cancelAction, tr })}
${preview ? countsBlock(preview, tr) : ''}
${NOTES.map((key) => html`<p class="muted">${tr.t(`serverData.note.${key}`)}</p>`)}
${pending ? '' : html`<p class="muted">${tr.t('serverData.note.grace', { days: GRACE_DAYS })}</p>`}
${confirm}</section>`;
}

/** In a server (sidebar layout): /dashboard/<guildId>/server-data. */
export function serverDataPage({ session, access = null, moduleStates = {}, preview, record = null, guildName = '', editEnabled = true, flash = null, error = null }) {
    const tr = dashboardText(session?.lang);
    const body = pageBody({
        preview, record, csrf: session.csrf, requestAction: path('/server-data/request'), cancelAction: path('/server-data/cancel'),
        backHref: path('/overview'), backText: tr.t('serverData.page.back'), intro: tr.t('serverData.page.intro', { name: guildName }),
        inGuild: true, editEnabled, flash, error, tr,
    });
    return layout({ title: tr.t('serverData.page.title'), active: 'overview', session, access, moduleStates, body, lang: tr.lang });
}

/** A server Mewvo left (no sidebar): /dashboard/removed/<guildId>/data. */
export function removedServerDataPage({ csrf, lang, theme = 'system', guildId, guildName = '', preview, record = null, editEnabled = true, flash = null, error = null }) {
    const tr = dashboardText(lang);
    const base = rootPath(`/removed/${guildId}/data`);
    const body = html`<div class="picker">${pageBody({
        preview, record, csrf, requestAction: `${base}/request`, cancelAction: `${base}/cancel`,
        backHref: rootPath(), backText: tr.t('serverData.page.backPicker'), intro: tr.t('serverData.page.introRemoved', { name: guildName || guildId }),
        inGuild: false, editEnabled, flash, error, tr,
    })}</div>`;
    return layout({ title: tr.t('serverData.page.title'), session: null, body, theme, lang: tr.lang });
}

/** The OAuth server list is too old to prove ownership: one button that asks Discord again. */
export function verifyOwnerPage({ lang, theme = 'system', guildId, guildName = '' }) {
    const tr = dashboardText(lang);
    const body = html`<div class="picker"><p><a href="${rootPath()}">${tr.t('serverData.page.backPicker')}</a></p>
<section class="card"><h1>${tr.t('serverData.verify.title')}</h1><p>${tr.t('serverData.verify.text', { name: guildName || guildId })}</p>
<p><a class="button-link" href="${rootPath(`/removed/${guildId}/data/verify`)}">${tr.t('serverData.verify.button')}</a></p></section></div>`;
    return layout({ title: tr.t('serverData.verify.title'), session: null, body, theme, lang: tr.lang });
}
