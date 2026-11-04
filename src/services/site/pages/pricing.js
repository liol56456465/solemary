// pricing.js: /pricing. The plans as cards side by side (stacked on phones), each with its
// price, who it is for, its perks and a button; then the comparison table and a short FAQ,
// all from config/site/plans.js (structure, names, prices) and the text catalog
// (content/site/<lang>/pricing.json and plans.json). Nothing is on sale unless test
// checkout is on (ctx.billing: PREMIUM_TEST_CHECKOUT=true + the member portal); then each paid
// plan has Buy buttons for a month or a year and Gift links. Otherwise "Coming soon", never a link.

import { html } from '../../dashboard/html.js';
import {
    COMPARISON, PLANS, PRICING_FAQ, YEARLY_MONTHS_CHARGED, displayCurrencyFor, monthlyCentsIn, paymentCurrencyFor, yearlyCents,
} from '../../../config/site/plans.js';
import { PERIODS, WITHDRAWAL_DAYS } from '../../billing/premiumService.js';
import { layout } from '../shell.js';
import { checkoutHref, testNotice, vatLine } from '../billing.js';
import { textOf } from '../i18n.js';
import { approxLocal, money, wholeMoney } from '../currency.js';
import { currentRates } from '../exchangeRates.js';

const FREE_MONTHS = 12 - YEARLY_MONTHS_CHARGED;
// The payment currency follows the page language (config/site/plans.js); Polish and Brazilian pages
// show an approximate local amount first, always with the real charge right under it.
const planned = (t) => html`<span class="planned">${t('pricing.card.planned')}</span>`;

/** The button(s) at the bottom of a plan card. */
function planActions(ctx, plan) {
    const { t, ti } = textOf(ctx);
    if (!plan.monthlyCents) {
        const invite = ctx.mainInvite || ctx.supportInvite;
        return invite
            ? html`<a class="button button-quiet" href="${invite}" rel="noopener">${ctx.mainInvite ? t('pricing.card.joinServer') : t('pricing.card.joinSupport')}</a>`
            : html`<a class="button button-quiet" href="${textOf(ctx).href('/features')}">${t('pricing.card.seeFeatures')}</a>`;
    }
    if (!ctx.billing) return html`<span class="button button-disabled" aria-disabled="true">${t('pricing.card.comingSoon')}</span>`;
    const currency = paymentCurrencyFor(textOf(ctx).lang);
    const href = (period, kind) => checkoutHref({ planId: plan.id, period, kind, currency });
    return html`<a class="button${plan.featured ? '' : ' button-quiet'}" href="${href('monthly', 'personal')}">${t('pricing.card.buyMonth')}</a>
<a class="button button-quiet" href="${href('yearly', 'personal')}">${t('pricing.card.buyYear')}</a>
<p class="plan-card-gift">${ti('pricing.card.gift', { monthly: href('monthly', 'gift'), yearly: href('yearly', 'gift') })}</p>`;
}

/**
 * One plan card: name, price, the yearly price, who it is for, then (not `compact`) the perks
 * and the button. The home page shows the compact cards in one row.
 */
export function planCard(ctx, plan, { compact = false } = {}) {
    const { t, tp, lang } = textOf(ctx);
    const currency = paymentCurrencyFor(lang);
    const monthly = monthlyCentsIn(plan, currency);
    // The yearly line is always the real charge (no approximation).
    const year = plan.monthlyCents
        ? html`<p class="plan-card-year">${tp('pricing.card.yearly', FREE_MONTHS, { price: money(lang, yearlyCents(plan, currency), currency) })}</p>`
        : html`<p class="plan-card-year">${t('pricing.card.freeForGood')}</p>`;
    const approx = plan.monthlyCents ? approxLocal(lang, monthly, currency) : null;
    const amount = !plan.monthlyCents ? wholeMoney(lang, 0, displayCurrencyFor(lang))
        : approx ? `≈ ${approx.text}` : money(lang, monthly, currency);
    const youPay = approx ? html`
<p class="plan-card-pay">${t('pricing.card.youPay', { price: money(lang, monthly, currency) })}</p>` : '';
    return html`<li class="plan-card${plan.featured ? ' is-featured' : ''}"><h3 class="plan-card-name">${plan.name}</h3>
<p class="plan-card-price"><span class="plan-card-amount">${amount}</span><span class="plan-card-per">${t('pricing.card.perMonth')}</span></p>${youPay}${year}
<p class="plan-card-for">${t(`plans.${plan.id}.summary`)}</p>${compact ? '' : html`
<ul class="plan-card-perks">${plan.perks.map((perk) => html`<li>${t(`plans.${plan.id}.perks.${perk.key}`)}${perk.planned ? html` ${planned(t)}` : ''}</li>`)}</ul>
<div class="plan-card-actions">${planActions(ctx, plan)}</div>`}</li>`;
}

function cell(ctx, value) {
    const { t, fmtNumber } = textOf(ctx);
    if (value === true) return html`<td class="yes">${t('pricing.compare.yes')}</td>`;
    if (value === false || value === '' || value == null) return html`<td class="no">${t('pricing.compare.no')}</td>`;
    if (typeof value === 'number') return html`<td>${fmtNumber(value)}</td>`;
    if (value.word) return html`<td>${t(`plans.comparison.values.${value.word}`)}</td>`;
    return html`<td>${value}</td>`;
}

function comparisonTable(ctx) {
    const { t } = textOf(ctx);
    return html`<div class="table-wrap compare-wrap" role="region" aria-labelledby="compare-title" tabindex="0"><table class="compare">
<caption class="visually-hidden">${t('pricing.compare.caption')}</caption>
<thead><tr><th scope="col">${t('pricing.compare.feature')}</th>${PLANS.map((p) => html`<th scope="col">${p.name}</th>`)}</tr></thead>
${COMPARISON.map((group) => html`<tbody><tr class="compare-group"><th scope="rowgroup" colspan="${PLANS.length + 1}">${t(`plans.comparison.${group.key}.title`)}</th></tr>
${group.rows.map((row) => html`<tr><th scope="row">${t(`plans.comparison.${group.key}.rows.${row.key}`)}${row.planned ? html` ${planned(t)}` : ''}</th>${PLANS.map((p) => cell(ctx, row.values[p.id]))}</tr>`)}</tbody>`)}
</table></div>`;
}

/** The pricing questions: [question, answer] (in test checkout, "Can I buy a plan now?" gets the test answer). */
export function pricingFaq(ctx) {
    const { t } = textOf(ctx);
    return PRICING_FAQ.map((key) => [
        t(`plans.faq.${key}.q`),
        ctx.billing && key === 'buyNow' ? t('pricing.faq.buyNowTest') : t(`plans.faq.${key}.a`),
    ]);
}

/** Under the cards: which currency you pay in, or (local amounts shown) the ECB rate date + that. */
function currencyNote(ctx) {
    const { t, lang, fmtDate } = textOf(ctx);
    const currency = paymentCurrencyFor(lang);
    if (displayCurrencyFor(lang) === currency) return t(`pricing.plans.currency.${currency}`);
    return t('pricing.plans.ratesNote', { date: fmtDate(`${currentRates().date}T12:00:00Z`), currency });
}

export function pricingPage(ctx) {
    const { t, ti, lang } = textOf(ctx);
    const currency = paymentCurrencyFor(lang);
    const price = (id) => money(lang, monthlyCentsIn(PLANS.find((p) => p.id === id) || { monthlyCents: 0 }, currency), currency);
    const name = (id) => PLANS.find((p) => p.id === id)?.name ?? id;
    return layout(ctx, {
        title: t('pricing.meta.title'), active: 'pricing', path: '/pricing',
        description: t('pricing.meta.description', {
            normal: name('normal'), normalPrice: price('normal'), pro: name('pro'), proPrice: price('pro'), max: name('max'), maxPrice: price('max'),
        }),
        body: html`<div class="wrap page pricing">
<header class="page-head"><h1>${t('pricing.head.title')}</h1>
${ctx.billing
        ? html`<p class="lead">${ti('pricing.head.leadBilling')}</p>
<p class="test-banner" role="note">${ti('pricing.head.testMode', { notice: testNotice(ctx) })}</p>`
        : html`<p class="lead">${ctx.supportInvite ? ti('pricing.head.leadSupport', { url: ctx.supportInvite }) : t('pricing.head.lead')}</p>`}</header>
<section aria-labelledby="plans-title"><h2 class="visually-hidden" id="plans-title">${t('pricing.plans.title')}</h2>
<ul class="plan-cards">${PLANS.map((plan) => planCard(ctx, plan))}</ul>
<p class="note plans-note">${currencyNote(ctx)} ${t('pricing.plans.note')}</p>
${ctx.billing ? html`<p class="note plans-note">${ti('pricing.plans.billingNote', {
        vat: vatLine(ctx.legal, ctx), monthDays: PERIODS.monthly.days, yearDays: PERIODS.yearly.days, withdrawalDays: WITHDRAWAL_DAYS,
    })}</p>` : ''}</section>
<section class="pricing-section" aria-labelledby="compare-title"><h2 id="compare-title">${t('pricing.compare.title')}</h2>${comparisonTable(ctx)}</section>
<section class="pricing-section pricing-faq" aria-labelledby="pricing-faq-title"><h2 id="pricing-faq-title">${t('pricing.faq.title')}</h2>
<dl class="qa">${pricingFaq(ctx).map(([q, a]) => html`<div><dt>${q}</dt><dd>${a}</dd></div>`)}</dl>
<p>${ti('pricing.faq.more')}</p></section></div>`,
    });
}
