// pricing.js: /pricing. One plain table of plans (both prices shown, no switch), the
// comparison table and a short FAQ, all from config/site/plans.js (the one file to edit).
// Nothing is on sale unless test checkout is on (ctx.billing: PREMIUM_TEST_CHECKOUT=true +
// the member portal); then each paid plan has Buy and Gift links for a month or a year.

import { html } from '../../dashboard/html.js';
import {
    COMPARISON, PLANS, PRICING_FAQ, YEARLY_MONTHS_CHARGED, euros, yearlyCents,
} from '../../../config/site/plans.js';
import { layout } from '../shell.js';
import { TEST_NOTICE, checkoutHref } from '../billing.js';

const FREE_MONTHS = 12 - YEARLY_MONTHS_CHARGED;
const PLANNED = html`<span class="planned">(planned)</span>`;

/** Buy / Gift links for one plan and period (test checkout), or nothing. */
function buyLinks(ctx, plan, period) {
    if (!plan.monthlyCents) return '';
    if (!ctx.billing) return html`<br><span class="muted">Coming soon</span>`;
    return html`<br><a href="${checkoutHref({ planId: plan.id, period, kind: 'personal' })}">Buy</a> · <a href="${checkoutHref({ planId: plan.id, period, kind: 'gift' })}">Gift</a>`;
}

function plansTable(ctx) {
    return html`<div class="table-wrap" role="region" aria-labelledby="plans-title" tabindex="0"><table class="plans-table">
<caption class="visually-hidden">Plans and prices in euros.</caption>
<thead><tr><th scope="col">Plan</th><th scope="col">For</th><th scope="col">Per month</th><th scope="col">Per year</th></tr></thead>
<tbody>${PLANS.map((plan) => html`<tr><th scope="row">${plan.name}</th><td>${plan.summary}</td>
<td>${plan.monthlyCents ? html`${euros(plan.monthlyCents)}${buyLinks(ctx, plan, 'monthly')}` : 'Free'}</td>
<td>${plan.monthlyCents ? html`${euros(yearlyCents(plan))} <span class="muted">(${FREE_MONTHS} months free)</span>${buyLinks(ctx, plan, 'yearly')}` : 'Free'}</td></tr>`)}</tbody>
</table></div>`;
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
        body: html`<div class="wrap page narrow-page">
<header class="page-head"><h1>Plans and prices</h1>
${ctx.billing
        ? html`<p class="lead">Free covers everything Mewvo does today. Paid plans add room and tools; buy one for your account or as a gift key for someone else. <a href="/me/redeem">Have a key?</a></p>
<p class="test-banner" role="note"><strong>Test mode.</strong> ${TEST_NOTICE}</p>`
        : html`<p class="lead">Everything Mewvo does now is free. Paid plans start when Mewvo opens to other servers; until then nothing can be bought.${ctx.supportInvite ? html` <a href="${ctx.supportInvite}" rel="noopener">Join the support server</a> to hear first.` : ''}</p>`}</header>
<h2 id="plans-title">Plans</h2>
${plansTable(ctx)}
<p class="note">Prices in euros. Limits such as tags follow the plan of the server owner.</p>
<h2 id="compare-title">What each plan includes</h2>${comparisonTable()}
<p class="note">Rows marked (planned) are not built yet and may change before paid plans start.</p>
<h2 id="pricing-faq-title">Questions about pricing</h2>
<dl class="qa">${faq.map((item) => html`<div><dt>${item.q}</dt><dd>${item.a}</dd></div>`)}</dl>
<p>More answers in the <a href="/faq">FAQ</a>.</p></div>`,
    });
}
