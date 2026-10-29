// pricing.js — /pricing: the plans from config/site/plans.js (the one file to edit), a
// Monthly / Yearly switch done with two radio inputs and `:checked ~` selectors (no script,
// keyboard: Tab to the group, arrow keys to switch), a comparison table and a short FAQ.
// Nothing is on sale: every plan button is a non-link "Coming soon".

import { html } from '../../dashboard/html.js';
import {
    COMPARISON, PLANS, PRICING_FAQ, YEARLY_MONTHS_CHARGED, euros, yearlyCents, yearlyPerMonthCents,
} from '../../../config/site/plans.js';
import { layout } from '../shell.js';

const FREE_MONTHS = 12 - YEARLY_MONTHS_CHARGED;
const PLANNED = html`<span class="planned">Planned</span>`;

function priceBlock(plan) {
    if (!plan.monthlyCents) {
        return html`<div class="plan-price"><p class="price"><span class="price-num">€0</span><span class="price-per">forever</span></p><p class="price-note">Free today, and it stays free.</p></div>`;
    }
    return html`<div class="plan-price">
<div class="price-monthly"><p class="price"><span class="price-num">${euros(plan.monthlyCents)}</span><span class="price-per">/month</span></p><p class="price-note">Billed monthly</p></div>
<div class="price-yearly"><p class="price"><span class="price-num">${euros(yearlyCents(plan))}</span><span class="price-per">/year</span></p><p class="price-note">${euros(yearlyPerMonthCents(plan))} a month · ${FREE_MONTHS} months free</p></div></div>`;
}

function planCard(plan, ctx) {
    const action = plan.monthlyCents
        ? html`<span class="button button-disabled" aria-disabled="true">Coming soon</span>`
        : html`<a class="button button-quiet" href="${ctx.supportInvite || '/features'}"${ctx.supportInvite ? html` rel="noopener"` : ''}>${ctx.supportInvite ? 'Join the support server' : 'See what’s included'}</a>`;
    return html`<li class="plan${plan.featured ? ' plan-featured' : ''}"><div class="plan-head"><h3 class="plan-name">${plan.name}</h3></div>
<p class="plan-summary">${plan.summary}</p>${priceBlock(plan)}${action}
<ul class="plan-perks">${plan.perks.map((perk) => html`<li>${perk.text}${perk.planned ? html` ${PLANNED}` : ''}</li>`)}</ul></li>`;
}

function cell(value) {
    if (value === true) return html`<td class="yes"><span aria-hidden="true">✓</span><span class="visually-hidden">Included</span></td>`;
    if (value === false || value === '' || value == null) return html`<td class="no"><span aria-hidden="true">—</span><span class="visually-hidden">Not included</span></td>`;
    return html`<td>${value}</td>`;
}

function comparisonTable() {
    return html`<div class="table-wrap compare-wrap" role="region" aria-labelledby="compare-title" tabindex="0"><table class="compare">
<caption class="visually-hidden">Plan comparison. Rows marked Planned are not built yet; the Free column is what Meowist does today.</caption>
<thead><tr><th scope="col">Feature</th>${PLANS.map((p) => html`<th scope="col">${p.name}</th>`)}</tr></thead>
${COMPARISON.map((group) => html`<tbody><tr class="compare-group"><th scope="rowgroup" colspan="${PLANS.length + 1}">${group.group}</th></tr>
${group.rows.map((row) => html`<tr><th scope="row">${row.label}${row.planned ? html` ${PLANNED}` : ''}</th>${PLANS.map((p) => cell(row.values[p.id]))}</tr>`)}</tbody>`)}
</table></div>`;
}

export function pricingPage(ctx) {
    return layout(ctx, {
        title: 'Pricing', active: 'pricing', path: '/pricing',
        description: 'Meowist is free today. Planned paid plans: Normal €1.99, Pro €4.99 and Max €9.99 a month, or two months free with yearly billing.',
        body: html`<div class="wrap page">
<header class="page-head page-head-split"><div><p class="section-num">Pricing</p><h1>Free today. Paid plans later.</h1></div>
<p class="lead">Everything Meowist does now is free. Paid plans start when Meowist opens to other servers; until then nothing can be bought.${ctx.supportInvite ? html` <a href="${ctx.supportInvite}" rel="noopener">Join the support server</a> to hear first.` : ''}</p></header>
<div class="billing">
<input class="billing-input" type="radio" name="billing" id="billing-monthly" value="monthly" checked>
<input class="billing-input" type="radio" name="billing" id="billing-yearly" value="yearly">
<div class="billing-switch"><span class="billing-legend" id="billing-legend">Billing</span><label for="billing-monthly">Monthly</label><label for="billing-yearly">Yearly <span class="billing-save">${FREE_MONTHS} months free</span></label></div>
<ul class="plans">${PLANS.map((plan) => planCard(plan, ctx))}</ul></div>
<p class="note plans-note">Prices in euros. <span class="planned">Planned</span> means the perk is not built yet and may change before paid plans start.</p>
<section class="block-tight" aria-labelledby="compare-title"><h2 id="compare-title">Compare plans</h2>${comparisonTable()}</section>
<section class="block-tight split split-narrow" aria-labelledby="pricing-faq-title"><div class="split-copy"><h2 id="pricing-faq-title">Questions about pricing</h2><p>More answers in the <a href="/faq">FAQ</a>.</p></div>
<dl class="qa">${PRICING_FAQ.map((item) => html`<div><dt>${item.q}</dt><dd>${item.a}</dd></div>`)}</dl></section></div>`,
    });
}
