// commands.js — /commands: the command explorer. Every command, subcommand and right-click menu
// the bot has (commandCatalog.js; /database and other owner tools are never listed), one card each
// with an anchor (/commands#case-search), its description in the page's language, its options,
// an example, who may use it and the dashboard page that replaces it.
//
// Search and filters work without a script: GET /commands?q=&cat=&who= marks the cards that do not
// match `hidden` (all cards are always sent, so the static script can filter live without a reload).
// The filter form needs form-action 'self' (COMMANDS_CSP, on this page only; the rest of the site
// keeps form-action 'none'). /commands/<slug> → 301 to the anchor (site.js).
// Text: content/site/<lang>/pages.json → commands.*. Values are never ids: no OWNER_IDS, server or channel ids.

import { html, queryString } from '../../dashboard/html.js';
import { SECURITY_HEADERS, layout } from '../shell.js';
import { textOf } from '../i18n.js';
import { ACCESS_TIERS, LABELLED_GROUPS, commandCatalog } from '../commandCatalog.js';

/** The site's CSP with form-action 'self': the filter form submits to this page (GET). */
export const COMMANDS_CSP = SECURITY_HEADERS['Content-Security-Policy'].replace("form-action 'none'", "form-action 'self'");
if (!COMMANDS_CSP.includes("form-action 'self'")) throw new Error('commands page: the site CSP has no form-action to relax');

/** Discord option types → the catalog's name for them (pages.commands.types.<name>, .placeholders.<name>). */
export const OPTION_TYPES = Object.freeze({ 3: 'text', 4: 'integer', 5: 'boolean', 6: 'member', 7: 'channel', 8: 'role', 9: 'mentionable', 10: 'number', 11: 'file' });

/** Commands with a hand-written example (pages.commands.examples.<slug>); the rest get a generated one. */
export const HAND_EXAMPLES = Object.freeze([
    'remind-me', 'todo-add', 'birthday-set', 'fun-roll', 'weather', 'report-file', 'rank',
    'enforcements', 'case-search', 'purge', 'giveaway-create', 'poll-create',
]);

export const QUERY_MAX = 100;

const first = (value) => (Array.isArray(value) ? value[0] : value);

/** ?q= ?cat= ?who= checked: q trimmed and cut to 100 characters, cat one of `groups`, who an access tier; anything else is ''. */
export function commandFilters(query = {}, groups = []) {
    const text = (value) => (typeof value === 'string' ? value : '');
    const q = text(first(query.q)).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, QUERY_MAX).trim();
    const cat = text(first(query.cat));
    const who = text(first(query.who));
    return { q, cat: groups.includes(cat) ? cat : '', who: ACCESS_TIERS.includes(who) ? who : '' };
}

/** The tiers a card answers to: the owner kit is Administrator-only too, so ?who=admin lists it. */
const whoOf = (entry) => (entry.access === 'ownerkit' ? ['admin', 'ownerkit'] : [entry.access]);

/** True when an entry matches the filters (every word of q, the category, the tier). static/site.js does the same. */
export function matchesFilters(entry, { q = '', cat = '', who = '' }) {
    if (cat && entry.group !== cat) return false;
    if (who && !whoOf(entry).includes(who)) return false;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((word) => entry.search.includes(word));
}

function groupLabel(t, entry) {
    return LABELLED_GROUPS.includes(entry.group) ? t(`pages.commands.groups.${entry.group}`) : entry.category.replace(/_/g, ' ');
}

function exampleText(t, entry) {
    if (HAND_EXAMPLES.includes(entry.slug)) return t(`pages.commands.examples.${entry.slug}`);
    const parts = entry.example.map((o) => `${o.name}:${o.value ?? (OPTION_TYPES[o.type] ? t(`pages.commands.placeholders.${OPTION_TYPES[o.type]}`) : '…')}`);
    return [`/${entry.key}`, ...parts].join(' ');
}

function optionsTable(t, entry) {
    if (!entry.options.length) return '';
    return html`<div class="table-wrap cmd-options-wrap"><table class="cmd-options"><caption>${t('pages.commands.options.caption', { command: `/${entry.key}` })}</caption>
<thead><tr><th scope="col">${t('pages.commands.options.name')}</th><th scope="col">${t('pages.commands.options.type')}</th><th scope="col">${t('pages.commands.options.required')}</th><th scope="col">${t('pages.commands.options.description')}</th></tr></thead>
<tbody>${entry.options.map((o) => html`<tr><th scope="row"><code>${o.name}</code></th><td>${OPTION_TYPES[o.type] ? t(`pages.commands.types.${OPTION_TYPES[o.type]}`) : ''}</td><td>${t(o.required ? 'pages.commands.options.yes' : 'pages.commands.options.no')}</td><td>${o.description}${o.choices.length ? html`<span class="cmd-choices">${t('pages.commands.options.choices', { list: o.choices.join(', ') })}</span>` : ''}</td></tr>`)}</tbody></table></div>`;
}

function card(ctx, entry, shown) {
    const { t } = textOf(ctx);
    const name = entry.menu ? entry.key : `/${entry.key}`;
    const description = entry.menu ? t(`pages.commands.menu.${entry.menu}`, { command: entry.key }) : entry.description;
    const moved = entry.page && ctx.adminCommandsRetired && entry.access === 'admin';
    return html`<article class="cmd-card" id="${entry.slug}" data-search="${entry.search}" data-cat="${entry.group}" data-who="${whoOf(entry).join(' ')}"${shown ? '' : html` hidden`}>
<h3 class="cmd-name"><code>${name}</code> <a class="cmd-anchor" href="#${entry.slug}" aria-label="${t('pages.commands.selfLink', { command: name })}">#</a></h3>
<p class="cmd-tags"><span class="tag tag-strong">${t(`pages.commands.access.${entry.access}`)}</span>${entry.note ? html` <span class="tag">${t(`pages.commands.notes.${entry.note}`)}</span>` : ''}</p>
<p class="cmd-desc">${description}</p>
${optionsTable(t, entry)}${entry.example ? html`<p class="cmd-example"><span class="cmd-label">${t('pages.commands.example')}</span> <code>${exampleText(t, entry)}</code></p>` : ''}
${entry.page ? html`<p class="cmd-page">${t(moved ? 'pages.commands.dashboard.moved' : 'pages.commands.dashboard.also', { page: t(`pages.commands.dashboardPages.${entry.page}`) })}</p>` : ''}</article>`;
}

/** The explorer page; `query` is the request's query (?q=&cat=&who=). */
export function commandsPage(ctx, query = {}) {
    const { t, ti, href, lang, fmtNumber } = textOf(ctx);
    const entries = commandCatalog(ctx.commands, lang || 'en');
    const groups = [];
    for (const entry of entries) {
        const last = groups[groups.length - 1];
        if (last?.key === entry.group) last.items.push(entry);
        else groups.push({ key: entry.group, label: groupLabel(t, entry), items: [entry] });
    }
    const filters = commandFilters(query, groups.map((g) => g.key));
    const shown = new Set(entries.filter((e) => matchesFilters(e, filters)));
    const link = (who) => href(`/commands${queryString({ q: filters.q, cat: filters.cat, who })}`);
    const whoLinks = ['', ...ACCESS_TIERS].map((who) => html`<li><a href="${link(who)}"${filters.who === who ? html` aria-current="true"` : ''}>${t(`pages.commands.who.${who || 'all'}`)}</a></li>`);
    const groupShown = (g) => g.items.some((e) => shown.has(e));
    const body = entries.length ? html`
<form class="cmd-filter" method="get" action="${href('/commands')}" role="search" aria-label="${t('pages.commands.search.formLabel')}">
<p class="form-field cmd-filter-q"><label for="cmd-q">${t('pages.commands.search.label')}</label><input id="cmd-q" type="search" name="q" value="${filters.q}" maxlength="${QUERY_MAX}" autocomplete="off" spellcheck="false" placeholder="${t('pages.commands.search.placeholder')}" data-cmd-q></p>
<p class="form-field"><label for="cmd-cat">${t('pages.commands.search.category')}</label><select id="cmd-cat" name="cat" data-cmd-cat><option value="">${t('pages.commands.search.allCategories')}</option>${groups.map((g) => html`<option value="${g.key}"${filters.cat === g.key ? html` selected` : ''}>${g.label}</option>`)}</select></p>
<p class="form-field"><label for="cmd-who">${t('pages.commands.search.who')}</label><select id="cmd-who" name="who" data-cmd-who>${['', ...ACCESS_TIERS].map((who) => html`<option value="${who}"${filters.who === who ? html` selected` : ''}>${t(`pages.commands.who.${who || 'all'}`)}</option>`)}</select></p>
<p class="form-actions cmd-filter-actions"><button class="button" type="submit">${t('pages.commands.search.submit')}</button><a href="${href('/commands')}">${t('pages.commands.search.reset')}</a></p>
</form>
<nav class="cmd-who" aria-label="${t('pages.commands.who.label')}"><ul>${whoLinks}</ul></nav>
<p class="cmd-count" aria-live="polite">${ti('pages.commands.search.count', { shown: html`<span data-cmd-shown>${fmtNumber(shown.size)}</span>`, total: fmtNumber(entries.length) })}</p>
<p class="cmd-empty" data-cmd-empty${shown.size ? html` hidden` : ''}>${t('pages.commands.search.empty')}</p>
${groups.length > 1 ? html`<nav class="jump" aria-label="${t('pages.commands.jumpLabel')}"><ul>${groups.map((g) => html`<li data-cmd-jump="${g.key}"${groupShown(g) ? '' : html` hidden`}><a href="#c-${g.key}">${g.label}</a></li>`)}</ul></nav>` : ''}
${groups.map((g) => html`<section class="cmd-group" id="c-${g.key}" aria-labelledby="h-${g.key}" data-cmd-group="${g.key}"${groupShown(g) ? '' : html` hidden`}><h2 id="h-${g.key}">${g.label}</h2>
<div class="cmd-cards">${g.items.map((e) => card(ctx, e, shown.has(e)))}</div></section>`)}` : html`<p class="note">${t('pages.commands.loading')}</p>`;
    return layout(ctx, {
        title: t('pages.commands.title'), active: 'commands', path: '/commands',
        description: t('pages.commands.description'),
        body: html`<div class="wrap page" data-cmd-explorer><header class="page-head page-head-split"><div><h1>${t('pages.commands.heading')}</h1></div>
<p class="lead">${t('pages.commands.lead')}</p></header>${body}</div>`,
    });
}

/**
 * Where /commands/<slug> points: the card with that slug, else the first card of that command
 * (/commands/case → #case-edit); null when no card matches. Slugs are the same in every language.
 */
export function commandAnchor(commands, slug) {
    const value = String(slug || '').toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(value)) return null;
    const entries = commandCatalog(commands, 'en');
    return (entries.find((e) => e.slug === value) || entries.find((e) => e.slug.startsWith(`${value}-`)))?.slug || null;
}
