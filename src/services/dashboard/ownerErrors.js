// ownerErrors.js — Owner area → Recent errors: the system errors members saw a Ref for and the
// errors of background tasks (table error_events; recorded by utils/errorEvents.js).
//
//   GET /dashboard/owner/errors[?q=<Ref, trace or error code>]
//
// Grouped by error code + source, newest first, at most 50 groups: count, last seen, a sample
// trace (the part of the Ref after the code), the server. Access: the Owner area's requireOwner
// (routes.js; live OWNER_IDS check, everyone else gets the plain 404). Read-only: no POSTs.
// A database error answers 503 "database not responding", never an empty list.
// Text: catalog namespace ownerErrors (src/content/dashboard/<lang>/ownerErrors.json).

import { logger } from '../../utils/logger.js';
import { KEEP_ROWS } from '../../utils/errorEvents.js';
import { errorEventStore, parseErrorSearch } from '../owner/errorEventStore.js';
import { queryText } from './forms.js';
import { html, layout, path } from './html.js';
import { currentLanguage, dashboardText } from './language.js';

const ACTIVE = 'owner/errors';
const SEARCH_MAX = 100;

export const defaultErrorPageDeps = { store: errorEventStore };

/** The page (pure): groups from listErrorGroups, the search value, server names by ID. */
export function ownerErrorsPage({ session, access = null, moduleStates = {}, groups = [], total = 0, q = '', serverName = () => null }) {
    const tr = dashboardText(session?.lang || currentLanguage());
    const server = (id) => {
        if (!id) return html`<span class="muted">${tr.t('ownerErrors.table.noServer')}</span>`;
        const name = serverName(id);
        return name ? html`${name}<br><small class="muted">${id}</small>` : html`<small>${id}</small>`;
    };
    const rows = groups.map((g) => html`<tr>
<td><code>${g.error_code}</code><br><small class="muted">${g.error_type}</small></td>
<td><code>${g.source}</code>${g.message ? html`<br><small class="muted">${g.message}</small>` : ''}</td>
<td>${tr.fmtNumber(g.count)}</td>
<td class="nowrap">${tr.fmtDateTime(g.last_seen)}</td>
<td>${g.sample_trace ? html`<code>${g.error_code} · ${g.sample_trace}</code>` : html`<span class="muted">-</span>`}</td>
<td>${server(g.guild_id)}${g.servers > 1 ? html`<br><small class="muted">${tr.t('ownerErrors.table.moreServers', { count: tr.fmtNumber(g.servers) })}</small>` : ''}</td></tr>`);
    const empty = q ? tr.t('ownerErrors.noMatch', { q }) : tr.t('ownerErrors.empty');
    const table = groups.length
        ? html`<div class="table-wrap"><table><thead><tr><th>${tr.t('ownerErrors.table.error')}</th><th>${tr.t('ownerErrors.table.source')}</th><th>${tr.t('ownerErrors.table.count')}</th><th>${tr.t('ownerErrors.table.lastSeen')}</th><th>${tr.t('ownerErrors.table.sample')}</th><th>${tr.t('ownerErrors.table.server')}</th></tr></thead><tbody>
${rows}
</tbody></table></div>`
        : html`<p class="muted">${empty}</p>`;
    const body = html`<header class="page-head"><h1>${tr.t('ownerErrors.page.title')}</h1><p class="muted">${tr.t('ownerErrors.page.help')}</p></header>
<form class="filters" method="get" action="${path('/owner/errors')}" role="search"><label class="wide-filter">${tr.t('ownerErrors.search.label')}<input type="search" name="q" value="${q}" maxlength="${SEARCH_MAX}" autocomplete="off" placeholder="${tr.t('ownerErrors.search.placeholder')}"></label>
<button class="primary" type="submit">${tr.t('ownerErrors.search.submit')}</button>${q ? html` <a href="${path('/owner/errors')}">${tr.t('ownerErrors.search.clear')}</a>` : ''}</form>
<section class="card">
<p class="muted">${tr.t('ownerErrors.kept', { count: tr.fmtNumber(total), max: tr.fmtNumber(KEEP_ROWS) })}</p>
${table}
<p class="muted">${tr.t('ownerErrors.privacy')}</p></section>`;
    return layout({ title: tr.t('ownerErrors.page.title'), active: ACTIVE, session, access, moduleStates, body });
}

/** The GET handler; runs after requireUser + requireOwner (routes.js). */
export function createOwnerErrorsHandlers(core) {
    const { client, sendHtml, fail, helpers } = core;
    const deps = { ...defaultErrorPageDeps, ...(core.errors || {}) };
    const { page } = helpers;

    async function errors(req, res) {
        const q = queryText(req.query, 'q', SEARCH_MAX);
        const tr = dashboardText(req.dashboard?.lang || req.dashboard?.session?.lang || currentLanguage());
        let result;
        try {
            result = await deps.store.list(parseErrorSearch(q));
        } catch (error) {
            logger.error(`Owner recent errors: could not be read: ${error.message}`);
            return fail(res, 503, tr.t('ownerErrors.unavailable.title'), tr.t('ownerErrors.unavailable.text'), req);
        }
        const serverName = (id) => client?.guilds?.cache?.get?.(id)?.name || null;
        return sendHtml(res, 200, ownerErrorsPage({ ...page(req), groups: result.groups, total: result.total, q, serverName }));
    }

    return { errors };
}
