// modulesPage.js — the Modules page: every settings module as a table row (name, one
// line, state line, Settings link). Cards show state only; the main switch of a module
// (NAV `toggle`) is in its page header. Filters (all / on / off) are plain links, so
// they work without the script; the script adds a search box (data-module-search).

import { html, layout, moduleItems, path, queryString } from './html.js';

export const MODULE_FILTERS = ['all', 'on', 'off'];

/** The settings modules with their state: true / false (known) or null (no on/off). */
export function moduleEntries(moduleStates = {}) {
    return moduleItems().map((item) => ({
        ...item,
        on: item.state && Object.hasOwn(moduleStates, item.state) ? Boolean(moduleStates[item.state]) : null,
    }));
}

/**
 * Setup per module from the Getting-started checklist: Map key → { total, todo }. Each item
 * belongs to the module its link opens (/dashboard/<key>). Modules without items get no line.
 */
export function setupByModule(checklist) {
    const byModule = new Map();
    for (const item of checklist || []) {
        const key = String(item.href || '').split('/').pop();
        const entry = byModule.get(key) || { total: 0, todo: 0 };
        entry.total += 1;
        if (!item.done) entry.todo += 1;
        byModule.set(key, entry);
    }
    return byModule;
}

/**
 * The state line: On (green) / Off (grey) where the module has an on/off state, and
 * "Needs setup · N to do" (amber) while Getting-started items of the module are open.
 * Off wins: setup does not matter while a module is off. Always words, never colour alone.
 */
function stateLine(entry, setup) {
    const parts = [];
    if (entry.on === false) return html`<span class="module-state is-off">Off</span>`;
    if (entry.on === true) parts.push(html`<span class="module-state is-on">On</span>`);
    if (setup?.todo) parts.push(html`<span class="module-state is-setup">needs setup (${setup.todo})</span>`);
    else if (setup && entry.on === null) parts.push(html`<span class="module-state is-on">Set up</span>`);
    return parts.length ? html`${parts.map((p, i) => html`${i ? ', ' : ''}${p}`)}` : html`<span class="muted">-</span>`;
}

/** The text a search matches: name, one-liner, keywords and the module's setup steps (checklist labels). */
function searchText(entry, steps = []) {
    return `${entry.label} ${entry.summary || ''} ${entry.keywords || ''} ${steps.join(' ')}`.toLowerCase();
}

/** Setup step labels per module key, from the Getting-started checklist. */
function stepsByModule(checklist) {
    const steps = new Map();
    for (const item of checklist || []) {
        const key = String(item.href || '').split('/').pop();
        steps.set(key, [...(steps.get(key) || []), item.label]);
    }
    return steps;
}

/** One module as a table row: name (link), what it does, its state. */
function card(entry, opts) {
    const state = entry.on === null ? 'none' : entry.on ? 'on' : 'off';
    return html`<tr class="module-row" data-state="${state}" data-name="${searchText(entry, opts.steps?.get(entry.key))}">
<td><a href="${path(`/${entry.key}`)}"><b>${entry.label}</b></a></td><td class="muted">${entry.summary || ''}</td><td class="nowrap">${stateLine(entry, opts.setup?.get(entry.key))}</td></tr>`;
}

export function modulesPage({ session, access = null, moduleStates = {}, flash = null, editEnabled = false, show = 'all', q = '', checklist = null }) {
    const filter = MODULE_FILTERS.includes(show) ? show : 'all';
    const needle = String(q || '').trim().toLowerCase().slice(0, 60);
    const all = moduleEntries(moduleStates);
    // ?q= (top bar search): every word must appear in the name, one-liner or keywords.
    const words = needle.split(/\s+/).filter(Boolean);
    const steps = stepsByModule(checklist);
    const entries = words.length ? all.filter((e) => words.every((w) => searchText(e, steps.get(e.key)).includes(w))) : all;
    const known = entries.filter((e) => e.on !== null);
    const onCount = known.filter((e) => e.on).length;
    const visible = entries.filter((e) => filter === 'all' || (filter === 'on' ? e.on === true : e.on === false));
    const setup = setupByModule(checklist);
    const chips = MODULE_FILTERS.map((f) => {
        const count = f === 'all' ? entries.length : f === 'on' ? onCount : known.length - onCount;
        const label = { all: 'All', on: 'On', off: 'Off' }[f];
        return html`<a class="chip${f === filter ? ' is-active' : ''}" href="${path(`/modules${queryString({ show: f === 'all' ? '' : f, q: needle })}`)}"${f === filter ? html` aria-current="page"` : ''}>${label} <span class="chip-count">${count}</span></a>`;
    });
    const allKnown = all.filter((e) => e.on !== null);
    const body = html`<header class="page-head"><h1>Modules</h1><p class="muted">Every part of Mewvo in one place. ${allKnown.filter((e) => e.on).length} of ${allKnown.length} modules with an on/off state are on; open a module to change its settings.</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${needle ? html`<p class="search-result">${entries.length} module${entries.length === 1 ? ' matches' : 's match'} <strong>“${needle}”</strong> · <a href="${path('/modules')}">Show all</a></p>` : ''}
${!editEnabled ? html`<p class="notice">Read-only: editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED is not true).</p>` : ''}
<div class="toolbar"><nav class="chips" aria-label="Filter modules">${chips}</nav><span class="toolbar-search" data-module-search></span></div>
${visible.length ? html`<div class="scroll"><table class="module-table"><thead><tr><th>Module</th><th>What it does</th><th>State</th></tr></thead><tbody data-module-grid>${visible.map((e) => card(e, { setup, steps }))}</tbody></table></div>`
        : html`<p class="empty">${needle ? 'No module matches. Try another word, or browse all modules.' : `No modules ${filter === 'on' ? 'are on' : 'are off'}.`}</p>`}`;
    return layout({ title: 'Modules', active: 'modules', session, access, moduleStates, body });
}
