// modulesPage.js — the Modules page: every settings module as a table row (name, one
// line, state line, Settings link). Cards show state only; the main switch of a module
// (NAV `toggle`) is in its page header. Filters (all / on / off) are plain links, so
// they work without the script; the script adds a search box (data-module-search).

import { html, layout, moduleItems, navLabel, path, queryString } from './html.js';
import { currentText, dashboardText } from './language.js';

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
        const key = String(item.href || '').split(/[?#]/)[0].split('/').pop();
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
function stateLine(entry, setup, tr = currentText()) {
    const parts = [];
    if (entry.on === false) return html`<span class="module-state is-off">${tr.t('moduleList.state.off')}</span>`;
    if (entry.on === true) parts.push(html`<span class="module-state is-on">${tr.t('moduleList.state.on')}</span>`);
    if (setup?.todo) parts.push(html`<span class="module-state is-setup">${tr.t('moduleList.state.needsSetup', { n: tr.fmtNumber(setup.todo) })}</span>`);
    else if (setup && entry.on === null) parts.push(html`<span class="module-state is-on">${tr.t('moduleList.state.setUp')}</span>`);
    return parts.length ? html`${parts.map((p, i) => html`${i ? ', ' : ''}${p}`)}` : html`<span class="muted">-</span>`;
}

/** The module's name and one-liner in the page's language (English: the NAV words as they are). */
function nameOf(entry, tr = currentText()) {
    return tr.lang === 'en' ? entry.label : navLabel(entry, tr);
}
function summaryOf(entry, tr = currentText()) {
    const key = `moduleList.summary.${entry.key}`;
    return tr.lang !== 'en' && tr.has(key) ? tr.t(key) : entry.summary || '';
}

/**
 * The text a search matches: name, one-liner, keywords and the module's setup steps (checklist
 * labels). In other languages the translated name and one-liner are added, so both words match.
 */
function searchText(entry, steps = [], tr = currentText()) {
    const local = tr.lang === 'en' ? '' : ` ${nameOf(entry, tr)} ${summaryOf(entry, tr)}`;
    return `${entry.label} ${entry.summary || ''} ${entry.keywords || ''} ${steps.join(' ')}${local}`.toLowerCase();
}

/** Setup step labels per module key, from the Getting-started checklist. */
function stepsByModule(checklist) {
    const steps = new Map();
    for (const item of checklist || []) {
        const key = String(item.href || '').split(/[?#]/)[0].split('/').pop();
        steps.set(key, [...(steps.get(key) || []), item.label]);
    }
    return steps;
}

/** One module as a table row: name (link), what it does, its state. */
function card(entry, opts, tr = currentText()) {
    const state = entry.on === null ? 'none' : entry.on ? 'on' : 'off';
    return html`<tr class="module-row" data-state="${state}" data-name="${searchText(entry, opts.steps?.get(entry.key), tr)}">
<td><a href="${path(`/${entry.key}`)}"><b>${nameOf(entry, tr)}</b></a></td><td class="muted">${summaryOf(entry, tr)}</td><td class="nowrap">${stateLine(entry, opts.setup?.get(entry.key), tr)}</td></tr>`;
}

export function modulesPage({ session, access = null, moduleStates = {}, flash = null, editEnabled = false, show = 'all', q = '', checklist = null }) {
    const tr = dashboardText(session?.lang);
    const filter = MODULE_FILTERS.includes(show) ? show : 'all';
    const needle = String(q || '').trim().toLowerCase().slice(0, 60);
    const all = moduleEntries(moduleStates);
    // ?q= (top bar search): every word must appear in the name, one-liner or keywords.
    const words = needle.split(/\s+/).filter(Boolean);
    const steps = stepsByModule(checklist);
    const entries = words.length ? all.filter((e) => words.every((w) => searchText(e, steps.get(e.key), tr).includes(w))) : all;
    const known = entries.filter((e) => e.on !== null);
    const onCount = known.filter((e) => e.on).length;
    const visible = entries.filter((e) => filter === 'all' || (filter === 'on' ? e.on === true : e.on === false));
    const setup = setupByModule(checklist);
    const chips = MODULE_FILTERS.map((f) => {
        const count = f === 'all' ? entries.length : f === 'on' ? onCount : known.length - onCount;
        const label = tr.t(`moduleList.filter.${f}`);
        return html`<a class="chip${f === filter ? ' is-active' : ''}" href="${path(`/modules${queryString({ show: f === 'all' ? '' : f, q: needle })}`)}"${f === filter ? html` aria-current="page"` : ''}>${label} <span class="chip-count">${count}</span></a>`;
    });
    const allKnown = all.filter((e) => e.on !== null);
    const title = tr.t('moduleList.page.title');
    const body = html`<header class="page-head"><h1>${title}</h1><p class="muted">${tr.t('moduleList.page.intro', { on: tr.fmtNumber(allKnown.filter((e) => e.on).length), total: tr.fmtNumber(allKnown.length) })}</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${needle ? html`<p class="search-result">${tr.tp('moduleList.page.matches', entries.length)} <strong>“${needle}”</strong> · <a href="${path('/modules')}">${tr.t('moduleList.page.showAll')}</a></p>` : ''}
${!editEnabled ? html`<p class="notice">${tr.t('moduleList.page.readOnly')}</p>` : ''}
<div class="toolbar"><nav class="chips" aria-label="${tr.t('moduleList.filter.label')}">${chips}</nav><span class="toolbar-search" data-module-search></span></div>
${visible.length ? html`<div class="scroll"><table class="module-table"><thead><tr><th>${tr.t('moduleList.col.module')}</th><th>${tr.t('moduleList.col.what')}</th><th>${tr.t('moduleList.col.state')}</th></tr></thead><tbody data-module-grid>${visible.map((e) => card(e, { setup, steps }, tr))}</tbody></table></div>`
        : html`<p class="empty">${needle ? tr.t('moduleList.page.noMatch') : filter === 'on' ? tr.t('moduleList.page.noneOn') : tr.t('moduleList.page.noneOff')}</p>`}`;
    return layout({ title, active: 'modules', session, access, moduleStates, body });
}
