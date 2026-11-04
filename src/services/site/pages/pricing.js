// pricing.js: /pricing. The plans as cards side by side (stacked on phones), each with its
// price, who it is for, its perks and a button; then the comparison table and a short FAQ,
// all from config/site/plans.js (the one file to edit). Nothing is on sale unless test
// checkout is on (ctx.billing: PREMIUM_TEST_CHECKOUT=true + the member portal); then each paid
// plan has Buy buttons for a month or a year and Gift links. Otherwise "Coming soon", never a link.

import { html } from '../../dashboard/html.js';
import {
    COMPARISON, PLANS, PRICING_FAQ, YEARLY_MONTHS_CHARGED, euros, yearlyCents,
} from '../../../config/site/plans.js';
import { layout } from '../shell.js';
import { TEST_NOTICE, checkoutHref, vatLine } from '../billing.js';

const FREE_MONTHS = 12 - YEARLY_MONTHS_CHARGED;
const PLANNED = html`<span class="planned">(planned)</span>`;

/** The button(s) at the bottom of a plan card. */
function planActions(ctx, plan) {
    if (!plan.monthlyCents) {
        const invite = ctx.mainInvite || ctx.supportInvite;
        return invite
            ? html`<a class="button button-quiet" href="${invite}" rel="noopener">${ctx.mainInvite ? 'Join the server' : 'Join the support server'}</a>`
            : html`<a class="button button-quiet" href="/features">See every feature</a>`;
    }
    if (!ctx.billing) return html`<span class="button button-disabled" aria-disabled="true">Coming soon</span>`;
    const href = (period, kind) => checkoutHref({ planId: plan.id, period, kind });
    return html`<a class="button${plan.featured ? '' : ' button-quiet'}" href="${href('monthly', 'personal')}">Buy a month</a>
<a class="button button-quiet" href="${href('yearly', 'personal')}">Buy a year</a>
<p class="plan-card-gift">As a gift: <a href="${href('monthly', 'gift')}">a month</a> · <a href="${href('yearly', 'gift')}">a year</a></p>`;
}

/**
 * One plan card: name, price, the yearly price, who it is for, then (not `compact`) the perks
 * and the button. The home page shows the compact cards in one row.
 */
export function planCard(ctx, plan, { compact = false } = {}) {
    const year = plan.monthlyCents
        ? html`<p class="plan-card-year">or ${euros(yearlyCents(plan))} a year (${FREE_MONTHS} months free)</p>`
        : html`<p class="plan-card-year">Free for good</p>`;
    return html`<li class="plan-card${plan.featured ? ' is-featured' : ''}"><h3 class="plan-card-name">${plan.name}</h3>
<p class="plan-card-price"><span class="plan-card-amount">${plan.monthlyCents ? euros(plan.monthlyCents) : '€0'}</span><span class="plan-card-per">/ month</span></p>${year}
<p class="plan-card-for">${plan.summary}</p>${compact ? '' : html`
<ul class="plan-card-perks">${plan.perks.map((perk) => html`<li>${perk.text}${perk.planned ? html` ${PLANNED}` : ''}</li>`)}</ul>
<div class="plan-card-actions">${planActions(ctx, plan)}</div>`}</li>`;
}

function cell(value) {
    if (value === true) return html`<td class="yes">Yes</td>`;
    if (value === false || value === '' || value == null) return html`<td class="no">No</td>`;
    return html`<td>${value}</td>`;
}

function comparisonTable() {
    return html`<div class="table-wrap compare-wrap" role="region" aria-labelledby="compare-title" tabindex="0"><table class="compare">
<caption class="visually-hidden">Plan comparison. Rows marked planned are not built yet; the Free column is what Mewvo does today.</caption>
<thead><tr><th scope="col">Feature</th>${PLANS.map((p) => html`<th scope="col">${p.name}</th>`)}</tr></thead>
${COMPARISON.map((group) => html`<tbody><tr class="compare-group"><th scope="rowgroup" colspan="${PLANS.length + 1}">${group.group}</th></tr>
${group.rows.map((row) => html`<tr><th scope="row">${row.label}${row.planned ? html` ${PLANNED}` : ''}</th>${PLANS.map((p) => cell(row.values[p.id]))}</tr>`)}</tbody>`)}
</table></div>`;
}

const TEST_FAQ = { q: 'Can I buy a plan now?', a: 'Only as a test. The checkout works end to end (for you or as a gift key), but no payment provider is connected: no card is asked for and nobody is charged. Perks marked planned are not built yet.' };

export function pricingPage(ctx) {
    const faq = ctx.billing ? PRICING_FAQ.map((item) => (item.q === TEST_FAQ.q ? TEST_FAQ : item)) : PRICING_FAQ;
    return layout(ctx, {
        title: 'Pricing', active: 'pricing', path: '/pricing',
        description: 'Mewvo is free today. Planned paid plans: Normal €1.99, Pro €4.99 and Max €9.99 a month, or two months free with yearly billing.',
        body: html`<div class="wrap page pricing">
<header class="page-head"><h1>Plans and prices</h1>
${ctx.billing
        ? html`<p class="lead">Free covers everything Mewvo does today. Paid plans add room and tools; buy one for your account or as a gift key for someone else. <a href="/me/redeem">Have a key?</a></p>
<p class="test-banner" role="note"><strong>Test mode.</strong> ${TEST_NOTICE}</p>`
        : html`<p class="lead">Everything Mewvo does now is free. Paid plans start when Mewvo opens to other servers; until then nothing can be bought.${ctx.supportInvite ? html` <a href="${ctx.supportInvite}" rel="noopener">Join the support server</a> to hear first.` : ''}</p>`}</header>
<section aria-labelledby="plans-title"><h2 class="visually-hidden" id="plans-title">Plans</h2>
<ul class="plan-cards">${PLANS.map((plan) => planCard(ctx, plan))}</ul>
<p class="note plans-note">Prices in euros. Limits such as tags follow the plan of the server owner. Perks marked (planned) are not built yet and may change before paid plans start.</p>
${ctx.billing ? html`<p class="note plans-note">Prices are the total you pay. ${vatLine(ctx.legal)} Each purchase is one payment for 30 or 365 days, with no automatic renewal. You can withdraw within 14 days: <a href="/withdrawal">right of withdrawal</a>.</p>` : ''}</section>
<section class="pricing-section" aria-labelledby="compare-title"><h2 id="compare-title">What each plan includes</h2>${comparisonTable()}</section>
<section class="pricing-section pricing-faq" aria-labelledby="pricing-faq-title"><h2 id="pricing-faq-title">Questions about pricing</h2>
<dl class="qa">${faq.map((item) => html`<div><dt>${item.q}</dt><dd>${item.a}</dd></div>`)}</dl>
<p>More answers in the <a href="/faq">FAQ</a>.</p></section></div>`,
    });
}
