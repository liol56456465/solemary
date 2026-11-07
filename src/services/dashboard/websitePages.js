// websitePages.js — Owner area → Website pages: text overview, one text group (namespace), one
// key with a form per language, the images. Pure: data in, HTML out, everything escaped by the
// `html` template (the preview is i18n.js's own safe rendering). No inline styles or scripts (CSP).
// Routes: websiteRoutes.js.

import { formatDate, html, layout, path, queryString, raw } from './html.js';
import { actionForm } from './enforcementPages.js';
import { DEFAULT_LANG, LANGUAGES } from '../site/i18n.js';
import { STATES, TEXT_MAX } from '../site/siteContent.js';
import { currentText, dashboardText } from './language.js';

const ACTIVE = 'owner/website';
export const NS_FILTERS = { all: 'All', 'needs-update': 'Needs update', missing: 'Missing', edited: 'Edited' };
const TONE = { translated: 'on', 'needs-update': 'warn', missing: 'bad', edited: 'on', default: 'off' };
const langName = (code) => LANGUAGES.find((l) => l.code === code)?.name || code;
const stateWord = (state) => html`<span class="state-word is-${TONE[state] || 'off'}"><span class="dot dot-${TONE[state] || 'off'}" aria-hidden="true"></span>${STATES[state] ? stateText(state) : state}</span>`;
// The site catalog's state words (siteContent STATES) and image slots (siteImages) in the dashboard's language; their English stays theirs.
const stateText = (state) => (currentText().has(`ownerWebsite.state.${state}`) ? currentText().t(`ownerWebsite.state.${state}`) : STATES[state]);
const slotText = (tr, def, field) => (tr.has(`ownerWebsite.slot.${def.slot}.${field}`) ? tr.t(`ownerWebsite.slot.${def.slot}.${field}`) : def[field]);
const opt = (value, label, current) => html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`;
const short = (value, max = 160) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function notices({ flash = null, error = null, editEnabled = true }) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">${currentText().t('ownerWebsite.common.readOnly')}</p>` : ''}`;
}

function tabs(current) {
    const tr = currentText();
    const items = [['text', tr.t('ownerWebsite.tabs.text'), '/owner/website'], ['images', tr.t('ownerWebsite.tabs.images'), '/owner/website/images']];
    return html`<nav class="chips" aria-label="${tr.t('ownerWebsite.tabs.label')}">${items.map(([key, label, href]) => html`<a class="chip" href="${path(href)}"${key === current ? raw(' aria-current="page"') : ''}>${label}</a>`)}</nav>`;
}

const MARKUP_HELP = (tr) => html`<p class="muted">${tr.t('ownerWebsite.markup.formatting')} <code>**${tr.t('ownerWebsite.markup.bold')}**</code>, <code>*${tr.t('ownerWebsite.markup.italic')}*</code>, <code>\`${tr.t('ownerWebsite.markup.code')}\`</code>, <code>[${tr.t('ownerWebsite.markup.text')}](/features)</code> ${tr.t('ownerWebsite.markup.rest1')} <code>- </code> ${tr.t('ownerWebsite.markup.rest2')} <code>{count}</code> ${tr.t('ownerWebsite.markup.rest3')}</p>`;

// ── Overview ──────────────────────────────────────────────────────────────

/** rows: [{ ns, keys, langs: { [code]: { total, translated, needsUpdate, missing, edited } } }]. */
export function websiteHomePage({ session, access = null, moduleStates = {}, flash = null, editEnabled = true, rows = [] }) {
    const others = LANGUAGES.filter((l) => l.code !== DEFAULT_LANG);
    const tr = dashboardText(session?.lang);
    const cell = (c) => html`<td>${c.translated}/${c.total}${c.needsUpdate ? html`<br><small class="state-word is-warn">${tr.t('ownerWebsite.home.toUpdate', { count: c.needsUpdate })}</small>` : ''}${c.missing ? html`<br><small class="muted">${tr.t('ownerWebsite.home.missing', { count: c.missing })}</small>` : ''}</td>`;
    const total = (code) => rows.reduce((sum, r) => {
        const c = r.langs[code];
        return { total: sum.total + c.total, translated: sum.translated + c.translated, needsUpdate: sum.needsUpdate + c.needsUpdate, missing: sum.missing + c.missing };
    }, { total: 0, translated: 0, needsUpdate: 0, missing: 0 });
    const body = html`<header class="page-head"><h1>${tr.t('ownerWebsite.home.title')}</h1><p class="muted">${tr.tx('ownerWebsite.home.help')}</p></header>
${tabs('text')}
${notices({ flash, editEnabled })}
<section class="card"><h2>${tr.t('ownerWebsite.home.byGroup')}</h2>
<p class="muted">${tr.ti('ownerWebsite.home.byGroupHelp')}</p>
<div class="scroll"><table><thead><tr><th>${tr.t('ownerWebsite.home.group')}</th><th>${tr.t('ownerWebsite.home.texts')}</th><th>${tr.t('ownerWebsite.home.englishEdited')}</th>${others.map((l) => html`<th>${l.name}</th>`)}</tr></thead><tbody>
${rows.map((r) => html`<tr><td><a href="${path(`/owner/website/ns/${r.ns}`)}">${r.ns}</a></td><td>${r.keys}</td><td>${r.langs[DEFAULT_LANG].edited}</td>${others.map((l) => cell(r.langs[l.code]))}</tr>`)}
<tr><th>${tr.t('ownerWebsite.home.all')}</th><td>${rows.reduce((n, r) => n + r.keys, 0)}</td><td>${rows.reduce((n, r) => n + r.langs[DEFAULT_LANG].edited, 0)}</td>${others.map((l) => cell(total(l.code)))}</tr>
</tbody></table></div></section>
<section class="card"><h2>${tr.t('ownerWebsite.home.notHere')}</h2><p class="muted">${tr.t('ownerWebsite.home.notHereHelp')}</p></section>`;
    return layout({ title: tr.t('ownerWebsite.home.title'), active: ACTIVE, session, access, moduleStates, body });
}

// ── One group ─────────────────────────────────────────────────────────────

/** rows: [{ key, english, text, from, state, edited }] for the language. */
export function namespacePage({ session, access = null, moduleStates = {}, flash = null, editEnabled = true, ns, lang, filter = 'all', q = '', rows = [] }) {
    const english = lang === DEFAULT_LANG;
    const tr = dashboardText(session?.lang);
    const body = html`<p><a href="${path('/owner/website')}">← ${tr.t('ownerWebsite.home.title')}</a></p>
<header class="page-head"><h1>${tr.t('ownerWebsite.ns.title', { ns })}</h1><p class="muted">${tr.t('ownerWebsite.ns.help', { lang: langName(lang) })}</p></header>
${notices({ flash, editEnabled })}
<form class="filters" method="get" action="${path(`/owner/website/ns/${ns}`)}" role="search">
<label>${tr.t('ownerWebsite.ns.language')}<select name="lang">${LANGUAGES.map((l) => opt(l.code, l.name, lang))}</select></label>
<label>${tr.t('ownerWebsite.ns.show')}<select name="filter">${Object.keys(NS_FILTERS).map((k) => opt(k, tr.t(`ownerWebsite.filter.${k}`), filter))}</select></label>
<label class="wide-filter">${tr.t('ownerWebsite.ns.search')}<input type="search" name="q" value="${q}" maxlength="100" autocomplete="off" placeholder="${tr.t('ownerWebsite.ns.searchPlaceholder')}"></label>
<button class="primary" type="submit">${tr.t('ownerWebsite.ns.showButton')}</button> <a href="${path(`/owner/website/ns/${ns}${queryString({ lang })}`)}">${tr.t('ownerWebsite.common.clear')}</a></form>
<p class="muted">${tr.tp('ownerWebsite.ns.count', rows.length)}</p>
${rows.length ? html`<div class="scroll"><table><thead><tr><th>${tr.t('ownerWebsite.ns.key')}</th><th>${tr.t('ownerWebsite.ns.english')}</th>${english ? '' : html`<th>${langName(lang)}</th>`}<th>${tr.t('ownerWebsite.ns.state')}</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td><a href="${path(`/owner/website/key${queryString({ k: r.key })}`)}#lang-${lang}"><code>${r.key}</code></a></td><td>${short(r.english)}</td>${english ? '' : html`<td>${r.from === 'english' ? html`<span class="muted">${tr.t('ownerWebsite.ns.englishShown')}</span>` : short(r.text)}</td>`}<td>${stateWord(r.state)}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${tr.t('ownerWebsite.ns.noMatch')}</p>`}`;
    return layout({ title: tr.t('ownerWebsite.ns.pageTitle', { name: ns }), active: ACTIVE, session, access, moduleStates, body });
}

// ── One key ───────────────────────────────────────────────────────────────

function historyTable(csrf, key, lang, rows, editEnabled) {
    const tr = currentText();
    if (rows === null) return html`<p class="error" role="alert">${tr.t('ownerWebsite.key.historyError')}</p>`;
    if (!rows.length) return html`<p class="muted">${tr.t('ownerWebsite.key.noChanges')}</p>`;
    return html`<details><summary>${tr.t('ownerWebsite.key.history', { count: rows.length, newest: rows.length >= 30 ? tr.t('ownerWebsite.key.newest30') : '' })}</summary><div class="scroll"><table><thead><tr><th>${tr.t('ownerWebsite.key.when')}</th><th>${tr.t('ownerWebsite.key.by')}</th><th>${tr.t('ownerWebsite.key.changedTo')}</th><th></th></tr></thead><tbody>
${rows.map((h) => html`<tr><td class="nowrap">${formatDate(h.changed_at)}</td><td><span class="muted">${h.changed_by}</span></td><td>${h.new_text === null ? html`<em>${tr.t('ownerWebsite.key.reset')}</em>` : html`<div class="long-value-full">${h.new_text}</div>`}</td>
<td class="nowrap">${actionForm(csrf, '/owner/website/text/restore', '', { submit: tr.t('ownerWebsite.key.restore'), hidden: { key, lang, id: String(h.id) }, inline: true, secondary: true, enabled: editEnabled })}</td></tr>`)}
</tbody></table></div></details>`;
}

/**
 * languages: [{ lang, text, from, state, edited, row }]; history: { [lang]: rows | null };
 * drafts: { [lang]: text } kept after a preview or a refusal; preview: { lang, html } (SafeHtml).
 */
export function keyPage({
    session, access = null, moduleStates = {}, flash = null, editEnabled = true, key, english, languages = [], history = {},
    error = null, errorLang = null, drafts = {}, preview = null, warnings = [],
}) {
    const csrf = session.csrf;
    const tr = dashboardText(session?.lang);
    const en = languages.find((l) => l.lang === DEFAULT_LANG);
    const ns = key.split('.')[0];
    const section = (l) => {
        const draft = Object.hasOwn(drafts, l.lang) ? drafts[l.lang] : (l.from === 'english' ? '' : l.text);
        const fromText = { edit: tr.t('ownerWebsite.key.fromEdit'), catalog: tr.t('ownerWebsite.key.fromCatalog'), english: tr.t('ownerWebsite.key.fromEnglish') }[l.from];
        return html`<section class="card" id="lang-${l.lang}"><h2>${langName(l.lang)} ${stateWord(l.edited && l.lang === DEFAULT_LANG ? 'edited' : l.state)}</h2>
${errorLang === l.lang && error ? html`<p class="error" role="alert">${error}</p>` : ''}
<p class="muted">${fromText}${l.row ? html` · ${tr.t('ownerWebsite.key.savedBy', { date: formatDate(l.row.updated_at), who: l.row.updated_by })}` : ''}</p>
${preview && preview.lang === l.lang ? html`<div class="card-note"><p class="muted">${tr.t('ownerWebsite.key.previewNotSaved')}</p>${preview.html}${warnings.length ? html`<p class="field-warn">${warnings.join(' ')}</p>` : ''}</div>` : ''}
<form method="post" action="${path('/owner/website/text/save')}" class="settings-form"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="key" value="${key}"><input type="hidden" name="lang" value="${l.lang}">
<fieldset${editEnabled ? '' : raw(' disabled')}><label class="wide">${tr.t('ownerWebsite.key.textIn', { lang: langName(l.lang) })}<textarea name="text" rows="${Math.min(14, Math.max(3, Math.ceil(String(draft || english).length / 90) + 1))}" maxlength="${TEXT_MAX}">${draft}</textarea></label>
${editEnabled ? html`<div class="form-actions"><button type="submit" name="do" value="preview" class="secondary">${tr.t('ownerWebsite.key.preview')}</button><button type="submit" name="do" value="save" class="primary">${tr.t('ownerWebsite.key.save')}</button></div>` : ''}</fieldset></form>
${l.row ? actionForm(csrf, '/owner/website/text/reset', '', { submit: tr.t('ownerWebsite.key.reset'), hidden: { key, lang: l.lang }, inline: true, danger: true, enabled: editEnabled, confirm: tr.t('ownerWebsite.key.resetConfirm', { lang: langName(l.lang) }) }) : ''}
${historyTable(csrf, key, l.lang, history[l.lang] ?? [], editEnabled)}</section>`;
    };
    const body = html`<p><a href="${path(`/owner/website/ns/${ns}`)}">← ${tr.t('ownerWebsite.ns.title', { ns })}</a></p>
<header class="page-head"><h1><code>${key}</code></h1><p class="muted">${tr.tx('ownerWebsite.key.help')}</p></header>
${notices({ flash, error: errorLang ? null : error, editEnabled })}
<section class="card"><h2>${tr.t('ownerWebsite.key.original')}</h2><div class="long-value-full">${english}</div>
${en?.row ? html`<p class="muted">${tr.tx('ownerWebsite.key.englishEdited')}</p>` : ''}
${MARKUP_HELP(tr)}</section>
${languages.map(section)}`;
    return layout({ title: tr.t('ownerWebsite.ns.pageTitle', { name: key }), active: ACTIVE, session, access, moduleStates, body });
}

// ── Images ────────────────────────────────────────────────────────────────

const kb = (n) => `${Math.max(1, Math.round(Number(n) / 1024))} kB`;

/** slots: [{ def, image, defaultBytes }]; image = the uploaded one or null. */
export function imagesPage({ session, access = null, moduleStates = {}, flash = null, error = null, editEnabled = true, slots = [], maxBytes }) {
    const csrf = session.csrf;
    const tr = dashboardText(session?.lang);
    const card = ({ def, image, defaultBytes }) => html`<section class="card" id="img-${def.slot}"><h2>${slotText(tr, def, 'label')} ${image ? html`<span class="state-word is-on"><span class="dot dot-on" aria-hidden="true"></span>${tr.t('ownerWebsite.images.replaced')}</span>` : html`<span class="state-word is-off"><span class="dot dot-off" aria-hidden="true"></span>${tr.t('ownerWebsite.images.default')}</span>`}</h2>
<p class="muted">${tr.ti('ownerWebsite.images.where', { where: slotText(tr, def, 'where'), path: def.path, size: `${def.width}×${def.height}`, format: def.mime === 'image/webp' ? 'WebP' : 'PNG' })}</p>
<div class="image-current"><img class="image-preview" src="${def.path}?v=${image ? image.sha256.slice(0, 12) : 'default'}" width="${def.width}" height="${def.height}" alt="${tr.t('ownerWebsite.images.currentAlt', { label: slotText(tr, def, 'label') })}" loading="lazy">
<p class="muted">${image ? tr.t('ownerWebsite.images.uploaded', { date: formatDate(image.updated_at), who: image.updated_by, size: kb(image.bytes.length) }) : html`${tr.t('ownerWebsite.images.defaultFile')}${defaultBytes ? html`, ${kb(defaultBytes)}` : ''}`}</p></div>
${actionForm(csrf, `/owner/website/images/${def.slot}/upload`, html`<label class="wide">${tr.t('ownerWebsite.images.replace', { mb: Math.floor(maxBytes / 1024 / 1024) })}<input type="file" name="image" accept="image/png,image/jpeg,image/webp" required></label>`, { submit: tr.t('ownerWebsite.images.upload'), multipart: true, enabled: editEnabled })}
${image ? actionForm(csrf, `/owner/website/images/${def.slot}/reset`, '', { submit: tr.t('ownerWebsite.key.reset'), inline: true, danger: true, enabled: editEnabled, confirm: tr.t('ownerWebsite.images.resetConfirm', { label: tr.lang === 'en' ? def.label.toLowerCase() : slotText(tr, def, 'label') }) }) : ''}</section>`;
    const body = html`<header class="page-head"><h1>${tr.t('ownerWebsite.images.title')}</h1><p class="muted">${tr.tx('ownerWebsite.images.help')}</p></header>
${tabs('images')}
${notices({ flash, error, editEnabled })}
${slots.map(card)}`;
    return layout({ title: tr.t('ownerWebsite.images.title'), active: ACTIVE, session, access, moduleStates, body });
}
