// modulesPage.js — the Modules page: every settings module as a card (icon, name, one
// line, status). Modules with a main switch (NAV `toggle`) can be turned on/off right on
// the card; the others link to their page. Filters (all / on / off) are plain links, so
// they work without the script; the script adds a search box (data-module-search).

import { NAV, html, icon, layout, path, queryString } from './html.js';
import { moduleSwitch, pill } from './forms.js';

export const MODULE_FILTERS = ['all', 'on', 'off'];

/** The settings modules with their state: true / false (known) or null (no on/off). */
export function moduleEntries(moduleStates = {}) {
    const items = NAV.find((item) => item.group === 'Settings')?.items || [];
    return items.map((item) => ({
        ...item,
        on: item.state && Object.hasOwn(moduleStates, item.state) ? Boolean(moduleStates[item.state]) : null,
    }));
}

function status(entry, { csrf, canEdit }) {
    if (entry.on === null) return '';
    if (entry.toggle) {
        return moduleSwitch({ csrf, canEdit, module: entry.key, action: entry.toggle, enabled: entry.on, label: entry.label, back: 'modules' });
    }
    // On/off follows from the module's setup (a channel or category), not a switch.
    return entry.on ? pill(true, 'Active') : pill(false, 'Not set up');
}

/** The text a search matches: name, one-liner and keywords. */
function searchText(entry) {
    return `${entry.label} ${entry.summary || ''} ${entry.keywords || ''}`.toLowerCase();
}

function card(entry, opts) {
    const state = entry.on === null ? 'none' : entry.on ? 'on' : 'off';
    return html`<li class="module-card" data-state="${state}" data-name="${searchText(entry)}">
<div class="module-card-top"><span class="module-icon" aria-hidden="true">${icon(entry.key)}</span>${status(entry, opts)}</div>
<h3 class="module-card-name"><a href="${path(`/${entry.key}`)}">${entry.label}</a></h3>
<p class="module-summary">${entry.summary || ''}</p>
<span class="module-card-foot" aria-hidden="true">Settings ${icon('chevron', 'icon icon-sm')}</span></li>`;
}

export function modulesPage({ session, access = null, moduleStates = {}, flash = null, editEnabled = false, show = 'all', q = '' }) {
    const filter = MODULE_FILTERS.includes(show) ? show : 'all';
    const needle = String(q || '').trim().toLowerCase().slice(0, 60);
    const all = moduleEntries(moduleStates);
    // ?q= (top bar search): every word must appear in the name, one-liner or keywords.
    const words = needle.split(/\s+/).filter(Boolean);
    const entries = words.length ? all.filter((e) => words.every((w) => searchText(e).includes(w))) : all;
    const known = entries.filter((e) => e.on !== null);
    const onCount = known.filter((e) => e.on).length;
    const visible = entries.filter((e) => filter === 'all' || (filter === 'on' ? e.on === true : e.on === false));
    const canEdit = Boolean(editEnabled && access?.canView !== false);
    const chips = MODULE_FILTERS.map((f) => {
        const count = f === 'all' ? entries.length : f === 'on' ? onCount : known.length - onCount;
        const label = { all: 'All', on: 'On', off: 'Off' }[f];
        return html`<a class="chip${f === filter ? ' is-active' : ''}" href="${path(`/modules${queryString({ show: f === 'all' ? '' : f, q: needle })}`)}"${f === filter ? html` aria-current="page"` : ''}>${label} <span class="chip-count">${count}</span></a>`;
    });
    const allKnown = all.filter((e) => e.on !== null);
    const body = html`<header class="page-head"><h1>Modules</h1><p>${allKnown.filter((e) => e.on).length} of ${allKnown.length} modules with an on/off state are on. Open a module for its settings.</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${needle ? html`<p class="search-result">${entries.length} module${entries.length === 1 ? '' : 's'} match <strong>“${needle}”</strong> · <a href="${path('/modules')}">Show all</a></p>` : ''}
${!editEnabled ? html`<p class="notice">Read-only: editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED is not true).</p>` : ''}
<div class="toolbar"><nav class="chips" aria-label="Filter modules">${chips}</nav><span class="toolbar-search" data-module-search></span></div>
${visible.length ? html`<ul class="module-grid" data-module-grid>${visible.map((e) => card(e, { csrf: session?.csrf, canEdit }))}</ul>`
        : html`<p class="empty">${needle ? 'No module matches. Try another word, or browse all modules.' : `No modules ${filter === 'on' ? 'are on' : 'are off'}.`}</p>`}`;
    return layout({ title: 'Modules', active: 'modules', session, access, moduleStates, body });
}
