// admins.js — /admins ("For server admins": what Mewvo needs and why, the first 10 minutes, what
// members see, appeals, data, limits per plan) and /added (where Discord sends an admin back after
// adding the bot, when INSTALL_REDIRECT_ENABLED is on; also reachable as a plain link).
// Text: content/site/<lang>/admins.json (admins.*, admins.added.*).
//
// The permission list is INSTALL_PERMISSIONS (shell.js), the same list the install link's
// permissions integer is built from, so the page and the link cannot drift apart. The limits
// table reads PLANS[].limits (config/site/plans.js), the numbers the bot enforces.
//
// /added never stores or checks anything: the server ID from Discord's redirect is only a hint
// (discord-api-docs, Advanced Bot Authorization), so it is used for one link to
// /dashboard/<id>, where the dashboard checks access itself. Anything that is not a snowflake is
// ignored; the ID is escaped like every other value (html``).

import { html } from '../../dashboard/html.js';
import { PLANS } from '../../../config/site/plans.js';
import { DASHBOARD_PATH, INSTALL_PERMISSIONS, addButton, installPermissionBits, isSnowflakeText, layout } from '../shell.js';
import { textOf } from '../i18n.js';

/** The limits shown per plan, in order: [limit key in PLANS[].limits, catalog label key]. */
export const LIMIT_ROWS = Object.freeze([
    ['tags', 'plans.comparison.community.rows.tags'],
    ['stickies', 'plans.comparison.community.rows.stickies'],
    ['feeds', 'plans.comparison.community.rows.feeds'],
    ['scheduled', 'plans.comparison.community.rows.scheduled'],
    ['customRules', 'plans.comparison.automod.rows.customRules'],
]);

/** The first ten minutes, in order (admins.first.steps.<key>). */
const FIRST_STEPS = ['setup', 'dashboard', 'logging', 'automod', 'staffGuard', 'appeals', 'test'];
/** What members see (admins.members.list.<key>); 'record' only with the member portal (/me). */
const MEMBER_POINTS = ['commands', 'dms', 'appeals', 'record', 'automod'];

function limitsTable(ctx) {
    const { t, fmtNumber } = textOf(ctx);
    return html`<div class="table-wrap compare-wrap" role="region" aria-labelledby="limits" tabindex="0"><table class="compare">
<caption class="visually-hidden">${t('admins.limits.caption')}</caption>
<thead><tr><th scope="col">${t('admins.limits.limit')}</th>${PLANS.map((p) => html`<th scope="col">${p.name}</th>`)}</tr></thead>
<tbody>${LIMIT_ROWS.map(([key, label]) => html`<tr><th scope="row">${t(label)}</th>${PLANS.map((p) => html`<td>${fmtNumber(p.limits?.[key] ?? 0)}</td>`)}</tr>`)}</tbody>
</table></div>`;
}

export function adminsPage(ctx) {
    const { t, ti } = textOf(ctx);
    const k = (key) => `admins.${key}`;
    return layout(ctx, {
        title: t(k('meta.title')), active: 'admins', path: '/admins',
        description: t(k('meta.description')),
        body: html`<div class="wrap page"><div class="doc">
<header class="doc-head"><h1>${t(k('head.title'))}</h1><p class="lead">${ti(k('head.lead'))}</p></header>
<div class="prose doc-body">
<p>${ti(k('head.justAdded'))}</p>
<h2 id="permissions">${t(k('permissions.title'))}</h2>
<p>${ti(k('permissions.intro'), { bits: installPermissionBits().toString() })}</p>
<dl class="cmd-list">${INSTALL_PERMISSIONS.map((name) => html`<div class="cmd"><dt><strong>${t(k(`permissions.items.${name}.name`))}</strong></dt><dd>${t(k(`permissions.items.${name}.why`))}</dd></div>`)}</dl>
<p>${ti(k('permissions.later'))}</p>
<h2 id="first">${t(k('first.title'))}</h2>
<p>${ti(k('first.intro'))}</p>
<ol class="steps-list">${FIRST_STEPS.map((key) => html`<li>${ti(k(`first.steps.${key}`), { dashboard: DASHBOARD_PATH })}</li>`)}</ol>
<h2 id="members">${t(k('members.title'))}</h2>
<ul>${MEMBER_POINTS.filter((key) => key !== 'record' || ctx.memberPortal).map((key) => html`<li>${ti(k(`members.list.${key}`))}</li>`)}</ul>
<h2 id="appeals">${t(k('appeals.title'))}</h2>
<p>${ti(k('appeals.who'))}</p>
<ul><li>${ti(k('appeals.panel'))}</li>
${ctx.memberPortal ? html`<li>${ti(k('appeals.web'))}</li>` : ''}</ul>
<p>${ti(k('appeals.home'))}</p>
<h2 id="data">${t(k('data.title'))}</h2>
<p>${ti(k('data.kept'))}</p>
<p>${ti(k('data.delete'))}</p>
<h2 id="limits">${t(k('limits.title'))}</h2>
<p>${ti(k('limits.intro'))}</p>
${limitsTable(ctx)}
<p>${ti(k('limits.more'))}</p>
</div></div></div>`,
    });
}

/**
 * Which /added state a query gives: { state: 'added' | 'unknown' | 'cancelled', guildId }.
 * guildId is a snowflake string or null; nothing else from the query is used.
 */
export function addedState(query = {}) {
    const one = (value) => (Array.isArray(value) ? value[0] : value);
    const error = one(query.error);
    if (typeof error === 'string' && error) return { state: 'cancelled', guildId: null };
    const id = one(query.guild_id);
    return isSnowflakeText(id) ? { state: 'added', guildId: id } : { state: 'unknown', guildId: null };
}

export function addedPage(ctx, { state = 'unknown', guildId = null } = {}) {
    const { t, ti, href } = textOf(ctx);
    const k = (key) => `admins.added.${key}`;
    const id = state === 'added' && isSnowflakeText(guildId) ? guildId : null;
    const dashboardHref = id ? `${DASHBOARD_PATH}/${id}` : DASHBOARD_PATH;
    const heading = state === 'cancelled' ? t(k('cancelled.title')) : id ? t(k('added.title')) : t(k('unknown.title'));
    const lead = state === 'cancelled' ? ti(k('cancelled.lead')) : id ? ti(k('added.lead')) : ti(k('unknown.lead'));
    const actions = state === 'cancelled'
        ? html`<p class="hero-actions">${addButton(ctx)}<a class="button button-quiet" href="${href('/admins')}">${t(k('readFirst'))}</a></p>`
        : html`<p class="hero-actions">${ctx.dashboardEnabled ? html`<a class="button" href="${dashboardHref}">${t(id ? k('openDashboard') : k('pickServer'))}</a>` : ''}<a class="button button-quiet" href="${href('/docs/setup')}">${t(k('setupGuide'))}</a></p>
${ctx.dashboardEnabled ? '' : html`<p class="notice">${ti(k('noDashboard'))}</p>`}
<h2 id="first">${t(k('firstSteps'))}</h2>
<ol class="steps-list"><li>${ti(k('steps.setup'))}</li>
<li>${ti(k('steps.logging'))}</li>
<li>${ti(k('steps.automod'))}</li>
<li>${ti(k('steps.staffGuard'))}</li>
<li>${ti(k('steps.appeals'))}</li></ol>
<p>${ti(k('more'))}</p>
<p class="muted">${t(k('accessNote'))}</p>`;
    return layout(ctx, {
        title: heading, active: 'added', path: '/added',
        description: t(k('description')),
        body: html`<div class="wrap page"><div class="doc">
<header class="doc-head"><h1>${heading}</h1><p class="lead">${lead}</p></header>
<div class="prose doc-body">${actions}</div></div></div>`,
    });
}
