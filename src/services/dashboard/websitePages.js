// websitePages.js — Owner area → Website pages: text overview, one text group (namespace), one
// key with a form per language, the images. Pure: data in, HTML out, everything escaped by the
// `html` template (the preview is i18n.js's own safe rendering). No inline styles or scripts (CSP).
// Routes: websiteRoutes.js.

import { formatDate, html, layout, path, queryString, raw } from './html.js';
import { actionForm } from './enforcementPages.js';
import { DEFAULT_LANG, LANGUAGES } from '../site/i18n.js';
import { STATES, TEXT_MAX } from '../site/siteContent.js';

const ACTIVE = 'owner/website';
export const NS_FILTERS = { all: 'All', 'needs-update': 'Needs update', missing: 'Missing', edited: 'Edited' };
const TONE = { translated: 'on', 'needs-update': 'warn', missing: 'bad', edited: 'on', default: 'off' };
const langName = (code) => LANGUAGES.find((l) => l.code === code)?.name || code;
const stateWord = (state) => html`<span class="state-word is-${TONE[state] || 'off'}"><span class="dot dot-${TONE[state] || 'off'}" aria-hidden="true"></span>${STATES[state] || state}</span>`;
const opt = (value, label, current) => html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`;
const short = (value, max = 160) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function notices({ flash = null, error = null, editEnabled = true }) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">Read-only: editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED is not true).</p>` : ''}`;
}

function tabs(current) {
    const items = [['text', 'Text', '/owner/website'], ['images', 'Images', '/owner/website/images']];
    return html`<nav class="chips" aria-label="Website editor">${items.map(([key, label, href]) => html`<a class="chip" href="${path(href)}"${key === current ? raw(' aria-current="page"') : ''}>${label}</a>`)}</nav>`;
}

const MARKUP_HELP = html`<p class="muted">Formatting: <code>**bold**</code>, <code>*italic*</code>, <code>\`code\`</code>, <code>[text](/features)</code> for a link, a blank line for a new paragraph, lines starting with <code>- </code> for a list. HTML is not supported (tags show as typed text). Words in braces like <code>{count}</code> are filled in by the website: keep the same ones as the English text.</p>`;

// ── Overview ──────────────────────────────────────────────────────────────

/** rows: [{ ns, keys, langs: { [code]: { total, translated, needsUpdate, missing, edited } } }]. */
export function websiteHomePage({ session, access = null, moduleStates = {}, flash = null, editEnabled = true, rows = [] }) {
    const others = LANGUAGES.filter((l) => l.code !== DEFAULT_LANG);
    const cell = (c) => html`<td>${c.translated}/${c.total}${c.needsUpdate ? html`<br><small class="state-word is-warn">${c.needsUpdate} to update</small>` : ''}${c.missing ? html`<br><small class="muted">${c.missing} missing</small>` : ''}</td>`;
    const total = (code) => rows.reduce((sum, r) => {
        const c = r.langs[code];
        return { total: sum.total + c.total, translated: sum.translated + c.translated, needsUpdate: sum.needsUpdate + c.needsUpdate, missing: sum.missing + c.missing };
    }, { total: 0, translated: 0, needsUpdate: 0, missing: 0 });
    const body = html`<header class="page-head"><h1>Website</h1><p class="muted">Change the website's text in every language and replace its images, without code. Changes are live as soon as you save. Each text group is one part of the site; open one to see and edit its texts.</p></header>
${tabs('text')}
${notices({ flash, editEnabled })}
<section class="card"><h2>Texts by group</h2>
<p class="muted">Per language: texts translated / all texts. <strong>To update</strong>: the English text changed after the translation was made. <strong>Missing</strong>: the website shows English there. English shows how many texts you edited.</p>
<div class="scroll"><table><thead><tr><th>Group</th><th>Texts</th><th>English edited</th>${others.map((l) => html`<th>${l.name}</th>`)}</tr></thead><tbody>
${rows.map((r) => html`<tr><td><a href="${path(`/owner/website/ns/${r.ns}`)}">${r.ns}</a></td><td>${r.keys}</td><td>${r.langs[DEFAULT_LANG].edited}</td>${others.map((l) => cell(r.langs[l.code]))}</tr>`)}
<tr><th>All</th><td>${rows.reduce((n, r) => n + r.keys, 0)}</td><td>${rows.reduce((n, r) => n + r.langs[DEFAULT_LANG].edited, 0)}</td>${others.map((l) => cell(total(l.code)))}</tr>
</tbody></table></div></section>
<section class="card"><h2>Not edited here</h2><p class="muted">The legal pages (Privacy Policy, Terms, Legal notice, Contact, Withdrawal) are legal texts: they are edited in code and reviewed, not here. They exist in English only.</p></section>`;
    return layout({ title: 'Website', active: ACTIVE, session, access, moduleStates, body });
}

// ── One group ─────────────────────────────────────────────────────────────

/** rows: [{ key, english, text, from, state, edited }] for the language. */
export function namespacePage({ session, access = null, moduleStates = {}, flash = null, editEnabled = true, ns, lang, filter = 'all', q = '', rows = [] }) {
    const english = lang === DEFAULT_LANG;
    const body = html`<p><a href="${path('/owner/website')}">← Website</a></p>
<header class="page-head"><h1>Texts: ${ns}</h1><p class="muted">Every text in this group with the English text and the ${langName(lang)} text. Open a text to edit it.</p></header>
${notices({ flash, editEnabled })}
<form class="filters" method="get" action="${path(`/owner/website/ns/${ns}`)}" role="search">
<label>Language<select name="lang">${LANGUAGES.map((l) => opt(l.code, l.name, lang))}</select></label>
<label>Show<select name="filter">${Object.entries(NS_FILTERS).map(([k, label]) => opt(k, label, filter))}</select></label>
<label class="wide-filter">Search<input type="search" name="q" value="${q}" maxlength="100" autocomplete="off" placeholder="Key or text"></label>
<button class="primary" type="submit">Show</button> <a href="${path(`/owner/website/ns/${ns}${queryString({ lang })}`)}">Clear</a></form>
<p class="muted">${rows.length} text${rows.length === 1 ? '' : 's'}.</p>
${rows.length ? html`<div class="scroll"><table><thead><tr><th>Key</th><th>English</th>${english ? '' : html`<th>${langName(lang)}</th>`}<th>State</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td><a href="${path(`/owner/website/key${queryString({ k: r.key })}`)}#lang-${lang}"><code>${r.key}</code></a></td><td>${short(r.english)}</td>${english ? '' : html`<td>${r.from === 'english' ? html`<span class="muted">(English shown)</span>` : short(r.text)}</td>`}<td>${stateWord(r.state)}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">No texts match.</p>`}`;
    return layout({ title: `Website: ${ns}`, active: ACTIVE, session, access, moduleStates, body });
}

// ── One key ───────────────────────────────────────────────────────────────

function historyTable(csrf, key, lang, rows, editEnabled) {
    if (rows === null) return html`<p class="error" role="alert">The history could not be loaded (database). Reload the page to try again.</p>`;
    if (!rows.length) return html`<p class="muted">No changes yet.</p>`;
    return html`<details><summary>History (${rows.length}${rows.length >= 30 ? ', newest 30' : ''})</summary><div class="scroll"><table><thead><tr><th>When</th><th>By</th><th>Changed to</th><th></th></tr></thead><tbody>
${rows.map((h) => html`<tr><td class="nowrap">${formatDate(h.changed_at)}</td><td><span class="muted">${h.changed_by}</span></td><td>${h.new_text === null ? html`<em>Reset to default</em>` : html`<div class="long-value-full">${h.new_text}</div>`}</td>
<td class="nowrap">${actionForm(csrf, '/owner/website/text/restore', '', { submit: 'Restore this version', hidden: { key, lang, id: String(h.id) }, inline: true, secondary: true, enabled: editEnabled })}</td></tr>`)}
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
    const en = languages.find((l) => l.lang === DEFAULT_LANG);
    const ns = key.split('.')[0];
    const section = (l) => {
        const draft = Object.hasOwn(drafts, l.lang) ? drafts[l.lang] : (l.from === 'english' ? '' : l.text);
        const fromText = { edit: 'Your edit', catalog: 'Default text', english: 'No text in this language: the website shows English' }[l.from];
        return html`<section class="card" id="lang-${l.lang}"><h2>${langName(l.lang)} ${stateWord(l.edited && l.lang === DEFAULT_LANG ? 'edited' : l.state)}</h2>
${errorLang === l.lang && error ? html`<p class="error" role="alert">${error}</p>` : ''}
<p class="muted">${fromText}${l.row ? html` · saved ${formatDate(l.row.updated_at)} by ${l.row.updated_by}` : ''}</p>
${preview && preview.lang === l.lang ? html`<div class="card-note"><p class="muted">Preview (not saved):</p>${preview.html}${warnings.length ? html`<p class="field-warn">${warnings.join(' ')}</p>` : ''}</div>` : ''}
<form method="post" action="${path('/owner/website/text/save')}" class="settings-form"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="key" value="${key}"><input type="hidden" name="lang" value="${l.lang}">
<fieldset${editEnabled ? '' : raw(' disabled')}><label class="wide">Text (${langName(l.lang)})<textarea name="text" rows="${Math.min(14, Math.max(3, Math.ceil(String(draft || english).length / 90) + 1))}" maxlength="${TEXT_MAX}">${draft}</textarea></label>
${editEnabled ? html`<div class="form-actions"><button type="submit" name="do" value="preview" class="secondary">Preview</button><button type="submit" name="do" value="save" class="primary">Save</button></div>` : ''}</fieldset></form>
${l.row ? actionForm(csrf, '/owner/website/text/reset', '', { submit: 'Reset to default', hidden: { key, lang: l.lang }, inline: true, danger: true, enabled: editEnabled, confirm: `Reset the ${langName(l.lang)} text to the default?` }) : ''}
${historyTable(csrf, key, l.lang, history[l.lang] ?? [], editEnabled)}</section>`;
    };
    const body = html`<p><a href="${path(`/owner/website/ns/${ns}`)}">← Texts: ${ns}</a></p>
<header class="page-head"><h1><code>${key}</code></h1><p class="muted">One text of the website in every language. Saving makes it live right away; "Reset to default" brings back the original text.</p></header>
${notices({ flash, error: errorLang ? null : error, editEnabled })}
<section class="card"><h2>English (original)</h2><div class="long-value-full">${english}</div>
${en?.row ? html`<p class="muted">The website shows your English edit instead (below). Translations made before it are marked "Needs update".</p>` : ''}
${MARKUP_HELP}</section>
${languages.map(section)}`;
    return layout({ title: `Website: ${key}`, active: ACTIVE, session, access, moduleStates, body });
}

// ── Images ────────────────────────────────────────────────────────────────

const kb = (n) => `${Math.max(1, Math.round(Number(n) / 1024))} kB`;

/** slots: [{ def, image, defaultBytes }]; image = the uploaded one or null. */
export function imagesPage({ session, access = null, moduleStates = {}, flash = null, error = null, editEnabled = true, slots = [], maxBytes }) {
    const csrf = session.csrf;
    const card = ({ def, image, defaultBytes }) => html`<section class="card" id="img-${def.slot}"><h2>${def.label} ${image ? html`<span class="state-word is-on"><span class="dot dot-on" aria-hidden="true"></span>Replaced</span>` : html`<span class="state-word is-off"><span class="dot dot-off" aria-hidden="true"></span>Default</span>`}</h2>
<p class="muted">${def.where}. Path <code>${def.path}</code>, ${def.width}×${def.height}, ${def.mime === 'image/webp' ? 'WebP' : 'PNG'}.</p>
<div class="image-current"><img class="image-preview" src="${def.path}?v=${image ? image.sha256.slice(0, 12) : 'default'}" width="${def.width}" height="${def.height}" alt="Current image: ${def.label}" loading="lazy">
<p class="muted">${image ? html`Uploaded ${formatDate(image.updated_at)} by ${image.updated_by}, ${kb(image.bytes.length)}` : html`The default file${defaultBytes ? html`, ${kb(defaultBytes)}` : ''}`}</p></div>
${actionForm(csrf, `/owner/website/images/${def.slot}/upload`, html`<label class="wide">Replace (PNG, JPEG or WebP, up to ${Math.floor(maxBytes / 1024 / 1024)} MB)<input type="file" name="image" accept="image/png,image/jpeg,image/webp" required></label>`, { submit: 'Upload', multipart: true, enabled: editEnabled })}
${image ? actionForm(csrf, `/owner/website/images/${def.slot}/reset`, '', { submit: 'Reset to default', inline: true, danger: true, enabled: editEnabled, confirm: `Put the default ${def.label.toLowerCase()} back?` }) : ''}</section>`;
    const body = html`<header class="page-head"><h1>Website images</h1><p class="muted">The images the website uses. An upload is converted (metadata such as camera or location data is removed) and fitted to the slot's size: an image in another shape is cropped at the edges. Live right away; browsers may show the old image for up to 5 minutes.</p></header>
${tabs('images')}
${notices({ flash, error, editEnabled })}
${slots.map(card)}`;
    return layout({ title: 'Website images', active: ACTIVE, session, access, moduleStates, body });
}
