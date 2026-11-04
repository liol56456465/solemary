// home.js: the front page. What Mewvo is (with the DM a member gets), the dashboard, the
// warning ladder, what it does as a two-column list, the plans as compact cards (as on /pricing), and
// where to ask.
// Every claim is from the code or CLAUDE.md. No eyebrow labels, numbering, tick lists or
// CTA band (owner, 2026-11-01). Text: src/content/site/<lang>/home.json.

import { html } from '../../dashboard/html.js';
import { PLANS } from '../../../config/site/plans.js';
import { textOf } from '../i18n.js';
import { DASHBOARD_PATH, addButton, layout } from '../shell.js';
import { dashboardShot, ladderMock, warnDmMock } from './mockups.js';
import { planCard } from './pricing.js';

/** The actions: Add to Discord (public) or Join the server, then the docs; the dashboard as a plain link. */
export function heroActions(ctx, { how = '/docs', howLabel = null, dashboard = true } = {}) {
    const { t, ti } = textOf(ctx);
    const add = addButton(ctx);
    const join = !add && (ctx.mainInvite || ctx.supportInvite)
        ? html`<a class="button" href="${ctx.mainInvite || ctx.supportInvite}" rel="noopener">${t(ctx.mainInvite ? 'home.actions.joinServer' : 'home.actions.joinSupportServer')}</a>`
        : '';
    const primary = add || join;
    return html`<p class="hero-actions">${primary}<a class="button${primary ? ' button-quiet' : ''}" href="${how}">${howLabel ?? t('home.actions.readDocs')}</a></p>${dashboard && ctx.dashboardEnabled ? html`<p class="hero-more">${ti('home.actions.openDashboard', { url: DASHBOARD_PATH })}</p>` : ''}`;
}

/** What Mewvo does: [anchor id (also the key under home.what.items), link]. */
const WHAT_IT_DOES = [
    ['enforcement', '/docs/getting-started'],
    ['appeals', '/docs/appeals'],
    ['automod', '/features#f-automod'],
    ['tickets', '/features#f-tickets'],
    ['logging', '/features#f-server'],
    ['community', '/features#f-community'],
];

export function homePage(ctx) {
    const { t, ti, tb } = textOf(ctx);
    const item = (id, part) => t(`home.what.items.${id}.${part}`);
    const body = html`<section class="hero"><div class="wrap hero-grid">
<div class="hero-copy"><h1>${t('home.hero.title')}</h1>
<p class="lead">${t('home.hero.lead')}</p>
${heroActions(ctx)}
${ctx.publicSite ? '' : html`<p class="note">${t('home.hero.notPublic')}</p>`}</div>
<div class="hero-visual">${warnDmMock(ctx, { caption: t('home.hero.dmCaption') })}</div></div></section>

<section class="band" id="dashboard" aria-labelledby="dash-title"><div class="wrap">
<div class="band-head"><h2 id="dash-title">${t('home.dashboard.title')}</h2>
<p>${ti('home.dashboard.text')}</p></div>
${dashboardShot({ alt: t('home.dashboard.shotAlt') })}
</div></section>

<section class="block" id="ladder" aria-labelledby="ladder-title"><div class="wrap split-2">
<div class="split-copy"><h2 id="ladder-title">${t('home.ladder.title')}</h2>
${tb('home.ladder.text')}</div>
<div class="split-visual">${ladderMock(ctx)}</div></div></section>

<section class="block" aria-labelledby="what-title"><div class="wrap">
<div class="band-head"><h2 id="what-title">${t('home.what.title')}</h2>
<p>${ti('home.what.text')}</p></div>
<ul class="what-grid">${WHAT_IT_DOES.map(([id, href]) => html`<li id="${id}"><h3>${item(id, 'name')}</h3><p>${item(id, 'text')}</p><a href="${href}">${item(id, 'link')}</a></li>`)}</ul>
</div></section>

<section class="block" aria-labelledby="pricing-title"><div class="wrap">
<div class="band-head"><h2 id="pricing-title">${t('home.pricing.title')}</h2>
<p>${ti('home.pricing.text')}</p></div>
<ul class="plan-cards plan-cards-compact">${PLANS.map((p) => planCard(ctx, p, { compact: true }))}</ul>
</div></section>

<section class="block block-last" aria-labelledby="help-title"><div class="wrap help-row">
<h2 id="help-title">${t('home.help.title')}</h2>
<p>${ti('home.help.text')}${ctx.supportInvite ? html` ${ti('home.help.support', { url: ctx.supportInvite })}` : ''}</p>
</div></section>`;
    return layout(ctx, {
        title: t('common.brand'), active: 'home', path: '/',
        description: t('home.meta.description'),
        body,
    });
}
