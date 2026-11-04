// billing.js — subscriptions on the website, inside "My record" (/me). TEST CHECKOUT ONLY:
// no payment provider is connected, no card details are asked for, nobody is charged.
// Off unless PREMIUM_TEST_CHECKOUT=true (and the member portal is on).
//
//   GET  /me/billing                  subscription, redeem form, gift keys bought, orders
//   GET  /me/checkout?plan=&period=&for=   the order summary (switch plan / billing / for me or gift)
//   POST /me/checkout                 "Order and pay" → a test order (premiumService.purchase)
//   GET  /me/billing/orders/:id       the receipt; for a gift it shows the key (own orders only)
//   GET  /me/redeem[?code=]           the redeem form (code pre-filled from a gift link)
//   POST /me/redeem                   redeems a key for the logged-in account
//   GET  /me/withdraw                 "Withdraw from contract here": the orders still in their 14 days
//   GET  /me/billing/orders/:id/withdraw   name + contract → "Confirm withdrawal" (CRD Art. 11a)
//   POST /me/billing/orders/:id/withdraw   records it (test mode: plan time taken back, refund due noted)
//   GET  /me/billing/orders/:id/withdrawal the acknowledgement (also sent as a Discord DM)
//
// EU consumer law (Directive 2011/83/EU): the checkout shows who sells, what, how long, the
// total and the VAT line, no automatic renewal; three unticked required boxes (start now /
// Terms / 18+ or permission) are checked again on the server; the button says "Order and pay".
// After an order and after a withdrawal the member gets a Discord DM (no email exists).
//
// Not logged in: GET pages show "Log in with Discord" with a return path (/me/login?next=…).
// POSTs: logged in + same origin + CSRF (like logout); redeem is rate limited separately.
// A database error is a 503 page; nothing is shown as bought unless the transaction committed.

//
// Text: content/site/<lang>/billing.json (pages read it with textOf(ctx)). The consent checkbox
// labels (billing.consent.*) are legal wording: the English text must stay the same as
// CONSENT_TEXTS in premiumService.js, which is what is stored with the order (a test checks it).

import { html, formatDate } from '../dashboard/html.js';
import { YEARLY_MONTHS_CHARGED, paymentCurrency, paymentCurrencyFor } from '../../config/site/plans.js';
import {
    CONSENT_TEXTS, GIFT_MESSAGE_MAX, GIFT_TO_MAX, PAID_PLANS, PERIODS, PremiumError, WITHDRAWAL_DAYS, WITHDRAWAL_NAME_MAX,
    canWithdraw, checkoutConsent, conversion, keyStatus, normalizeKeyCode, orderCurrency, planName, priceCents, quote, withdrawalDeadline, withdrawalQuote,
} from '../billing/premiumService.js';
import { afterPremiumChange, orderConfirmationDm, sendPremiumDm, withdrawalAckDm } from '../billing/premiumEffects.js';
import { LEGAL_UPDATED } from './pages/legal.js';
import { isSameOrigin, safeEqual } from '../dashboard/security.js';
import { logger } from '../../utils/logger.js';
import { layout } from './shell.js';
import { DEFAULT_LANG, LANG_CODES, hasKey, textOf, translate } from './i18n.js';
import { approxLocal, money } from './currency.js';

/** The test-mode notice in the page's language (English without a ctx). */
export const testNotice = (ctx = null) => textOf(ctx).t('billing.test.notice');
/** English texts for code outside the website pages (tests, logs). Pages use the catalog keys. */
export const TEST_NOTICE = translate(DEFAULT_LANG, 'billing.test.notice');
/** Next to the pay button while no payment provider is connected. */
export const TEST_PAY_NOTE = translate(DEFAULT_LANG, 'billing.test.payNote');
/**
 * The VAT line on the checkout, receipt and confirmation (English; the words are billing.vat.* in
 * the catalog). OWNER: confirm both with an accountant before real payments.
 */
export const VAT_TEXT = Object.freeze({
    get registered() { return translate(DEFAULT_LANG, 'billing.vat.registered'); },
    get notRegistered() { return translate(DEFAULT_LANG, 'billing.vat.notRegistered'); },
});
/**
 * The VAT line: with LEGAL_VAT_NO set (ctx.legal.vatRegistered) "includes VAT", else "not charged".
 * In the page's language with a ctx; English without one (the Discord DMs stay English).
 */
export const vatLine = (legal, ctx = null) => textOf(ctx).t(legal?.vatRegistered ? 'billing.vat.registered' : 'billing.vat.notRegistered');
/** The pay button's label (CRD Art. 8(2): "order with obligation to pay"). */
export const payLabel = (amountText, ctx = null) => textOf(ctx).t('billing.checkout.pay', { amount: amountText });
const DAY_MS = 24 * 60 * 60 * 1000;
// Session flash marker: the withdrawal acknowledgement DM was not delivered (shown once on the ack page).
// Compared, not translated: the ack page shows billing.withdrawalAck.dmFailed instead.
const WITHDRAWAL_DM_FAILED = 'The withdrawal acknowledgement DM could not be delivered.';
const daysText = (tp, ms) => {
    const d = Math.round(ms / DAY_MS * 10) / 10;
    return tp('billing.common.day', d);
};
/**
 * A PremiumError in the page's language: billing.errorCodes.<code> with the error's params (numbers,
 * plan names, dates; never what the visitor typed). An error without a known code: its English text.
 */
export function premiumErrorText(error, ctx = null) {
    const { t, tp } = textOf(ctx);
    const code = typeof error?.code === 'string' && /^[a-zA-Z]+$/.test(error.code) ? error.code : '';
    const key = `billing.errorCodes.${code}`;
    const params = error?.params || {};
    if (code === 'consentMissing') {
        const items = (Array.isArray(params.missing) ? params.missing : [])
            .filter((id) => /^[a-zA-Z]+$/.test(id) && hasKey('en', `billing.errorCodes.consentItems.${id}`))
            .map((id) => t(`billing.errorCodes.consentItems.${id}`));
        return items.length ? t(key, { items: items.join(', ') }) : String(error?.userMessage ?? '');
    }
    if (code && hasKey('en', `${key}.other`)) return tp(key, params.count, params);
    if (code && hasKey('en', key)) return t(key, params);
    return String(error?.userMessage ?? '');
}

const periodLabel = (t, period) => (PERIODS[period] ? t(`billing.period.${period}`) : period);
const kindLabel = (t, kind) => (kind === 'personal' || kind === 'gift' ? t(`billing.kind.${kind}`) : kind);
const statusLabel = (t, status) => t(`billing.keyStatus.${status}`);
const SOURCES = ['key', 'purchase', 'owner', 'bonus'];

const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * A checkout query from the address bar, with safe defaults. Pure. `cur` (EUR or USD) is the payment
 * currency the pricing page showed; without it the checkout uses the page language's currency.
 */
export function checkoutChoice(q = {}) {
    const currency = paymentCurrency(str(q.cur, 3));
    return {
        planId: pick(str(q.plan, 20), PAID_PLANS.map((p) => p.id), (PAID_PLANS.find((p) => p.featured) || PAID_PLANS[0]).id),
        period: pick(str(q.period, 10), Object.keys(PERIODS), 'monthly'),
        kind: pick(str(q.for, 10), ['personal', 'gift'], 'personal'),
        ...(currency ? { currency } : {}),
    };
}

export function checkoutHref({ planId, period, kind, currency = null }) {
    return `/me/checkout?${new URLSearchParams({ plan: planId, period, for: kind, ...(currency ? { cur: currency } : {}) })}`;
}

/** The payment currency of a checkout: the one the link carried, else the page language's. */
const checkoutCurrency = (choice, lang) => choice.currency || paymentCurrencyFor(lang);
/** A real amount of an order in the page's language, in the order's own currency (never approximated). */
const orderMoney = (ctx, order, cents) => money(textOf(ctx).lang, cents, orderCurrency(order));

function when(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? html`<time datetime="${date.toISOString()}">${formatDate(date)}</time>` : '-';
}

const testBanner = (t) => html`<p class="test-banner" role="note"><span class="planned">${t('billing.test.label')}</span> ${t('billing.test.notice')}</p>`;
const notices = ({ flash = null, error = null }) => html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${error ? html`<p class="error" role="alert">${error}</p>` : ''}`;

function seg(label, options) {
    return html`<div class="seg-group"><p class="seg-label">${label}</p><ul class="seg">${options.map((o) => html`<li><a href="${o.href}"${o.current ? html` aria-current="true"` : ''}>${o.label}${o.sub ? html`<small>${o.sub}</small>` : ''}</a></li>`)}</ul></div>`;
}

/** Why the visitor must log in: a billing.login.reason.* key ('buyPlan' takes { plan }). */
const LOGIN_REASONS = ['manage', 'buyPlan', 'buyAny', 'redeem', 'withdraw'];

export function loginNeededPage(ctx, next, reason = 'manage', params = {}) {
    const { t } = textOf(ctx);
    const key = LOGIN_REASONS.includes(reason) ? reason : 'manage';
    return layout(ctx, {
        title: t('billing.login.title'), active: 'me',
        body: html`<div class="wrap page prose"><h1>${t('billing.login.heading')}</h1>
<p class="lead">${t(`billing.login.reason.${key}`, params)} ${t('billing.login.privacy')}</p>
<p><a class="button" href="/me/login?${new URLSearchParams({ next })}">${t('billing.login.button')}</a></p>${testBanner(t)}</div>`,
    });
}

/**
 * What buying this for yourself does to the current plan: { kind: 'new' | 'extend' | 'upgrade' |
 * 'blocked', text }. Pure. Text in ctx's language (English without one); a 'blocked' text is the
 * PremiumError from premiumService.js (premiumErrorText).
 */
export function checkoutEffect(current, choice, now = Date.now(), ctx = null) {
    const { t, tp } = textOf(ctx);
    if (!current) return { kind: 'new', text: t('billing.effect.new') };
    if (current.plan_id === choice.planId) {
        return { kind: 'extend', text: t('billing.effect.extend', { plan: planName(current.plan_id), until: new Date(current.expires_at).toISOString().slice(0, 10) }) };
    }
    try {
        const c = conversion(current, choice.planId, now);
        return {
            kind: 'upgrade',
            text: t('billing.effect.upgrade', {
                remaining: daysText(tp, c.remainingMs), fromPlan: planName(c.fromPlanId), converted: daysText(tp, c.convertedMs), plan: planName(choice.planId),
            }),
        };
    } catch (error) {
        if (error instanceof PremiumError) return { kind: 'blocked', text: premiumErrorText(error, ctx) };
        throw error;
    }
}

export function checkoutPage(ctx, { session, choice: picked, current = null, values = {}, error = null }) {
    const { t, ti, tp, lang } = textOf(ctx);
    const choice = { ...picked, currency: checkoutCurrency(picked, lang) };
    const quoted = quote(choice);
    // The real total in the payment currency; only here an approximate local amount may follow it.
    const q = { ...quoted, amountText: money(lang, quoted.amountCents, quoted.currency) };
    const approx = approxLocal(lang, quoted.amountCents, quoted.currency);
    const effect = choice.kind === 'personal' ? checkoutEffect(current, choice, Date.now(), ctx) : null;
    const others = (patch) => checkoutHref({ ...choice, ...patch });
    const gift = choice.kind === 'gift';
    const perKey = choice.period === 'yearly' ? 'billing.checkout.pricePerYear' : 'billing.checkout.pricePerMonth';
    return layout(ctx, {
        title: t('billing.checkout.title'), active: 'me',
        body: html`<div class="wrap page"><a class="back-link" href="${textOf(ctx).href('/pricing')}">${t('billing.checkout.back')}</a>
<header class="page-head"><h1>${t(gift ? 'billing.checkout.headingGift' : 'billing.checkout.heading', { plan: q.plan.name })}</h1></header>
${testBanner(t)}${notices({ error })}
<div class="checkout"><div class="checkout-options">
${seg(t('billing.checkout.planLabel'), PAID_PLANS.map((p) => ({ label: p.name, sub: t(perKey, { price: money(lang, priceCents(p.id, choice.period, choice.currency), choice.currency) }), href: others({ planId: p.id }), current: p.id === choice.planId })))}
${seg(t('billing.checkout.billingLabel'), Object.entries(PERIODS).map(([id, p]) => ({
        label: periodLabel(t, id), sub: id === 'yearly' ? tp('billing.checkout.monthsFree', 12 - YEARLY_MONTHS_CHARGED) : tp('billing.common.day', p.days), href: others({ period: id }), current: id === choice.period,
    })))}
${seg(t('billing.checkout.forLabel'), [
        { label: t('billing.checkout.forMe'), sub: t('billing.checkout.forMeSub'), href: others({ kind: 'personal' }), current: !gift },
        { label: t('billing.checkout.asGift'), sub: t('billing.checkout.asGiftSub'), href: others({ kind: 'gift' }), current: gift },
    ])}
<section class="checkout-plan"><h2>${t('billing.checkout.includes', { plan: q.plan.name })}</h2><ul class="plan-perks">${q.plan.perks.map((perk) => html`<li>${t(`plans.${q.plan.id}.perks.${perk.key}`)}${perk.planned ? html` <span class="planned">${t('billing.checkout.planned')}</span>` : ''}</li>`)}</ul></section>
</div>
<aside class="summary" aria-labelledby="summary-title"><h2 id="summary-title">${t('billing.summary.title')}</h2>
<dl class="summary-rows">
<div><dt>${t('billing.summary.plan')}</dt><dd>${t('billing.common.planLine', { plan: q.plan.name })}</dd></div>
<div><dt>${t('billing.summary.billing')}</dt><dd>${t('billing.summary.billingValue', { period: periodLabel(t, choice.period), days: q.days })}</dd></div>
<div><dt>${t('billing.summary.for')}</dt><dd>${gift ? t('billing.summary.forGift') : t('billing.summary.forAccount', { username: session.username })}</dd></div>
<div class="summary-total"><dt>${t('billing.summary.total')}</dt><dd>${q.amountText}${approx ? html` <small class="summary-approx">${t('billing.summary.approx', { amount: approx.text })}</small>` : ''}</dd></div></dl>
<p class="note summary-vat">${t('billing.summary.vatNote', { vat: vatLine(ctx.legal, ctx), days: q.days })}</p>
<p class="note${effect?.kind === 'upgrade' ? ' summary-upgrade' : ''}">${gift
        ? t('billing.summary.giftNote')
        : effect.text}</p>
${effect?.kind === 'blocked' ? html`<p class="button button-disabled summary-pay" aria-disabled="true">${t('billing.checkout.blocked')}</p>`
        : html`<form method="post" action="/me/checkout"><input type="hidden" name="csrf" value="${session.csrf}">
<input type="hidden" name="plan" value="${choice.planId}"><input type="hidden" name="period" value="${choice.period}"><input type="hidden" name="for" value="${choice.kind}"><input type="hidden" name="cur" value="${choice.currency}"><input type="hidden" name="lang" value="${lang}">
${gift ? html`<div class="gift-fields"><label for="gift-to">${t('billing.checkout.giftTo')}</label><input id="gift-to" name="gift_to" maxlength="${GIFT_TO_MAX}" autocomplete="off" value="${values.giftTo || ''}" placeholder="${t('billing.checkout.giftToPlaceholder')}">
<label for="gift-message">${t('billing.checkout.giftMessage')}</label><textarea id="gift-message" name="gift_message" maxlength="${GIFT_MESSAGE_MAX}" rows="3" placeholder="${t('billing.checkout.giftMessagePlaceholder')}">${values.giftMessage || ''}</textarea></div>` : ''}
<fieldset class="consent"><legend class="seg-label">${t('billing.consent.legend')}</legend>
${consentBox('consent_start', t(gift ? 'billing.consent.startNowGift' : 'billing.consent.startNow'), values.consent?.start)}
${consentBox('consent_terms', ti('billing.consent.terms'), values.consent?.terms)}
${consentBox('consent_age', t('billing.consent.age'), values.consent?.age)}</fieldset>
<button class="button summary-pay" type="submit">${payLabel(q.amountText, ctx)}</button> <span class="planned test-pay-note">${t('billing.test.payNote')}</span></form>`}
<p class="note">${ti(gift ? 'billing.checkout.privacyNoteGift' : 'billing.checkout.privacyNote', { days: WITHDRAWAL_DAYS })}</p></aside></div>
${sellerInfo(ctx, q, gift)}</div>`,
    });
}

/**
 * The three consent texts exactly as the checkout showed them in `lang` (plain text: a link keeps
 * its words, markup marks are dropped), in the order checkoutConsent stores them. English is
 * CONSENT_TEXTS itself (a test keeps the catalog equal to it).
 */
export function consentTexts(lang, kind = 'personal') {
    const gift = kind === 'gift';
    if (!LANG_CODES.includes(lang) || lang === DEFAULT_LANG) {
        return [gift ? CONSENT_TEXTS.startNowGift : CONSENT_TEXTS.startNow, CONSENT_TEXTS.terms, CONSENT_TEXTS.age];
    }
    const plain = (key) => translate(lang, key).replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1');
    return [plain(gift ? 'billing.consent.startNowGift' : 'billing.consent.startNow'), plain('billing.consent.terms'), plain('billing.consent.age')];
}

/** One required, unticked checkbox (ticked again only when the form comes back with an error). */
function consentBox(name, label, checked = false) {
    return html`<label class="consent-box"><input type="checkbox" name="${name}" value="yes" required${checked ? html` checked` : ''}> <span>${label}</span></label>`;
}

/** Who sells (CRD Art. 6(1)(b)–(c)) and the key facts, under the order summary. */
function sellerInfo(ctx, q, gift) {
    const { t, ti, tp } = textOf(ctx);
    const legal = ctx.legal || {};
    return html`<section class="checkout-seller" aria-labelledby="seller-title"><h2 id="seller-title">${t('billing.seller.title')}</h2>
<dl class="summary-rows">
<div><dt>${t('billing.seller.seller')}</dt><dd>${legal.operator || 'Mewvo'}${legal.email ? html`, <a href="mailto:${legal.email}">${legal.email}</a>` : ''} · <a href="${textOf(ctx).href('/legal')}">${t('billing.seller.legalDetails')}</a></dd></div>
<div><dt>${t('billing.seller.whatYouGet')}</dt><dd>${t(gift ? 'billing.seller.whatYouGetGift' : 'billing.seller.whatYouGetPersonal', { plan: q.plan.name })}</dd></div>
<div><dt>${t('billing.seller.duration')}</dt><dd>${tp(gift ? 'billing.seller.durationGift' : 'billing.seller.durationPersonal', q.days)}</dd></div>
<div><dt>${t('billing.seller.totalPrice')}</dt><dd>${t('billing.seller.totalPriceValue', { amount: q.amountText, vat: vatLine(legal, ctx) })}</dd></div>
<div><dt>${t('billing.seller.withdrawal')}</dt><dd>${ti('billing.seller.withdrawalValue', { days: WITHDRAWAL_DAYS })}</dd></div></dl></section>`;
}

/** The order's withdrawal state for lists: a link while open, the outcome once withdrawn. */
function withdrawalCell(ctx, order, now = Date.now()) {
    const { t, ti } = textOf(ctx);
    const w = order.legal?.withdrawal;
    if (w) {
        return html`<a href="/me/billing/orders/${order.id}/withdrawal">${t('billing.withdrawalCell.withdrawn')}</a><br><small class="note">${ti(w.refundStatus === 'test-not-paid' ? 'billing.withdrawalCell.refundDueTest' : 'billing.withdrawalCell.refundDue', { date: when(w.at), amount: orderMoney(ctx, order, w.refundCents) })}</small>`;
    }
    if (canWithdraw(order, now)) {
        return html`<a href="/me/billing/orders/${order.id}/withdraw">${t('billing.withdrawalCell.withdraw')}</a><br><small class="note">${ti('billing.withdrawalCell.until', { date: when(withdrawalDeadline(order)) })}</small>`;
    }
    return '';
}

function subscriptionCard(ctx, subscription) {
    const { t, ti } = textOf(ctx);
    if (!subscription) {
        return html`<li class="feature"><h2>${t('billing.plan.title')}</h2><p class="record-big">${planName('free')}</p><p>${ti('billing.plan.none')}</p></li>`;
    }
    const source = SOURCES.includes(subscription.source) ? t(`billing.source.${subscription.source}`) : '';
    return html`<li class="feature"><h2>${t('billing.plan.title')}</h2><p class="record-big">${planName(subscription.plan_id)}</p>
<p>${ti('billing.plan.activeUntil', { date: when(subscription.expires_at) })} ${source}</p>
<p><a href="${checkoutHref({ planId: subscription.plan_id, period: 'monthly', kind: 'personal' })}">${t('billing.plan.addTime')}</a></p></li>`;
}

function redeemForm(ctx, session, code = '') {
    const { t, ti } = textOf(ctx);
    return html`<form class="redeem-form" method="post" action="/me/redeem"><input type="hidden" name="csrf" value="${session.csrf}">
<label for="redeem-code">${t('billing.redeemForm.label')}</label><div class="redeem-row"><input id="redeem-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="MEWVO-XXXX-XXXX-XXXX" required value="${code}">
<button class="button" type="submit">${t('billing.redeemForm.button')}</button></div></form>
<p class="note">${ti('billing.redeemForm.terms')}</p>`;
}

export function billingPage(ctx, { session, account, flash = null, error = null, code = '' }) {
    const { t, ti, tp } = textOf(ctx);
    const { subscription, orders, gifts } = account;
    return layout(ctx, {
        title: t('billing.account.title'), active: 'me',
        body: html`<div class="wrap page record"><div class="record-head"><div><h1>${t('billing.account.title')}</h1>
<p class="lead">${ti('billing.account.lead', { username: session.username })}</p></div>
<nav class="record-links" aria-label="${t('billing.account.nav')}"><a class="button button-quiet" href="/me">${t('billing.account.myRecord')}</a> <a class="button" href="${textOf(ctx).href('/pricing')}">${t('billing.account.plans')}</a></nav></div>
${testBanner(t)}${notices({ flash, error })}
<ul class="record-summary">${subscriptionCard(ctx, subscription)}
<li class="feature"><h2>${t('billing.account.redeemTitle')}</h2>${redeemForm(ctx, session, code)}<p class="note">${t('billing.account.redeemNote')}</p></li></ul>
<h2 id="gifts-title">${t('billing.account.giftsTitle')}</h2>
${gifts.length ? html`<div class="table-wrap" role="region" aria-labelledby="gifts-title" tabindex="0"><table class="record-table"><thead><tr><th scope="col">${t('billing.account.giftsKey')}</th><th scope="col">${t('billing.account.giftsPlan')}</th><th scope="col">${t('billing.account.giftsTime')}</th><th scope="col">${t('billing.account.giftsBought')}</th><th scope="col">${t('billing.account.giftsStatus')}</th></tr></thead>
<tbody>${gifts.map((k) => html`<tr><td><code class="key-code">${k.code}</code>${k.gift_to ? html`<br><small class="note">${t('billing.account.giftTo', { name: k.gift_to })}</small>` : ''}</td><td>${planName(k.plan_id)}</td><td>${tp('billing.common.day', k.duration_days)}</td><td>${when(k.created_at)}</td><td>${statusLabel(t, keyStatus(k))}${k.redeemed_at ? html`<br><small class="note">${when(k.redeemed_at)}</small>` : ''}</td></tr>`)}</tbody></table></div>`
        : html`<p>${ti('billing.account.noGifts')}</p>`}
<h2 id="orders-title">${t('billing.account.ordersTitle')}</h2>
${orders.length ? html`<div class="table-wrap" role="region" aria-labelledby="orders-title" tabindex="0"><table class="record-table"><thead><tr><th scope="col">${t('billing.account.ordersOrder')}</th><th scope="col">${t('billing.account.ordersDate')}</th><th scope="col">${t('billing.account.ordersPlan')}</th><th scope="col">${t('billing.account.ordersFor')}</th><th scope="col">${t('billing.account.ordersAmount')}</th><th scope="col">${t('billing.account.ordersWithdrawal')}</th><th scope="col"></th></tr></thead>
<tbody>${orders.map((o) => html`<tr><td><code>#${o.id}</code></td><td>${when(o.created_at)}</td><td>${t('billing.common.planWithPeriod', { plan: planName(o.plan_id), period: periodLabel(t, o.period) })}</td><td>${kindLabel(t, o.kind)}</td><td>${orderMoney(ctx, o, o.amount_cents)}${o.test ? html` <span class="planned">${t('billing.common.test')}</span>` : ''}</td><td>${withdrawalCell(ctx, o)}</td><td><a href="/me/billing/orders/${o.id}">${t('billing.account.receipt')}</a></td></tr>`)}</tbody></table></div>
<p class="note">${ti('billing.account.ordersNote', { days: WITHDRAWAL_DAYS })}</p>`
        : html`<p>${t('billing.account.noOrders')}</p>`}</div>`,
    });
}

export function receiptPage(ctx, { session, order, key = null }) {
    const { t, ti, tp, tpi } = textOf(ctx);
    const gift = order.kind === 'gift';
    const redeemLink = key && ctx.origin ? `${ctx.origin}/me/redeem?${new URLSearchParams({ code: key.code })}` : null;
    const giftKeyLabel = key ? tp(key.gift_to ? 'billing.receipt.giftKeyTo' : 'billing.receipt.giftKey', key.duration_days, { plan: planName(key.plan_id), name: key.gift_to || '' }) : '';
    return layout(ctx, {
        title: t('billing.receipt.title', { id: order.id }), active: 'me',
        body: html`<div class="wrap page prose"><a class="back-link" href="/me/billing">${t('billing.common.back')}</a>
<h1>${gift ? t('billing.receipt.headingGift') : t('billing.receipt.heading')}</h1>
${testBanner(t)}
${gift && key ? html`<div class="key-box"><p class="seg-label">${giftKeyLabel}</p><p class="key-big"><code>${key.code}</code></p>
${key.gift_message ? html`<blockquote class="gift-message">${key.gift_message}</blockquote>` : ''}
<p class="note">${keyStatus(key) === 'unused' ? html`${ti('billing.receipt.giveAway')}${key.expires_at ? html` ${ti('billing.receipt.redeemBy', { date: when(key.expires_at) })}` : ''}` : t('billing.receipt.status', { status: statusLabel(t, keyStatus(key)) })}</p>
${redeemLink ? html`<p class="note">${ti('billing.receipt.directLink', { link: html`<code class="key-link">${redeemLink}</code>` })}</p>` : ''}</div>` : ''}
<dl class="summary-rows receipt">
<div><dt>${t('billing.receipt.order')}</dt><dd><code>#${order.id}</code></dd></div>
<div><dt>${t('billing.receipt.date')}</dt><dd>${when(order.created_at)}</dd></div>
<div><dt>${t('billing.receipt.account')}</dt><dd>${session.username}</dd></div>
<div><dt>${t('billing.receipt.plan')}</dt><dd>${t('billing.common.planPeriod', { plan: planName(order.plan_id), period: periodLabel(t, order.period) })}</dd></div>
<div><dt>${t('billing.receipt.for')}</dt><dd>${kindLabel(t, order.kind)}</dd></div>
<div class="summary-total"><dt>${t('billing.receipt.total')}</dt><dd>${order.test ? t('billing.receipt.totalTest', { amount: orderMoney(ctx, order, order.amount_cents) }) : orderMoney(ctx, order, order.amount_cents)}</dd></div>
<div><dt>${t('billing.receipt.vat')}</dt><dd>${vatLine(ctx.legal, ctx)}</dd></div>
<div><dt>${t('billing.receipt.renewal')}</dt><dd>${t('billing.receipt.renewalNone')}</dd></div>
${order.legal?.consent ? html`<div><dt>${t('billing.receipt.confirmed')}</dt><dd>${order.legal.consent.texts.map((text) => html`${text}<br>`)}<small class="note">${ti('billing.receipt.confirmedMeta', { date: when(order.legal.consent.at), version: order.legal.consent.version, terms: LEGAL_UPDATED })}</small></dd></div>` : ''}
<div><dt>${t('billing.receipt.withdrawal')}</dt><dd>${withdrawalCell(ctx, order) || tpi('billing.receipt.periodEnded', WITHDRAWAL_DAYS)}${gift ? html`<br><small class="note">${t('billing.receipt.giftWithdrawal')}</small>` : ''}</dd></div></dl>
<p class="note">${t('billing.receipt.dmNote')}</p>
<p><a class="button" href="/me/billing">${t('billing.common.goToSubscription')}</a></p></div>`,
    });
}

/** A gift link's card: who it is from, the plan and the message (peekKey; unused keys only). */
function giftCard(ctx, peek) {
    if (!peek) return '';
    const { t, ti } = textOf(ctx);
    const head = peek.from
        ? t(peek.giftTo ? 'billing.gift.fromFor' : 'billing.gift.from', { from: peek.from, to: peek.giftTo || '' })
        : t(peek.giftTo ? 'billing.gift.keyFor' : 'billing.gift.key', { to: peek.giftTo || '' });
    return html`<div class="key-box gift-card"><p class="seg-label">${head}</p>
<p class="key-big">${t('billing.gift.plan', { plan: planName(peek.planId), days: peek.days })}</p>
${peek.giftMessage ? html`<blockquote class="gift-message">${peek.giftMessage}</blockquote>` : ''}
${peek.expiresAt ? html`<p class="note">${ti('billing.gift.redeemBy', { date: when(peek.expiresAt) })}</p>` : ''}</div>`;
}

export function redeemPage(ctx, { session, code = '', peek = null, error = null }) {
    const { t, ti } = textOf(ctx);
    return layout(ctx, {
        title: t('billing.redeem.title'), active: 'me',
        body: html`<div class="wrap page prose"><h1>${peek?.from ? t('billing.redeem.headingGift') : t('billing.redeem.heading')}</h1>
<p class="lead">${ti('billing.redeem.lead', { username: session.username })}</p>
${testBanner(t)}${notices({ error })}${giftCard(ctx, peek)}${redeemForm(ctx, session, code)}
<p class="note"><a href="/me/billing">${t('billing.common.backToSubscription')}</a></p></div>`,
    });
}

const orderLine = (t, order) => t(order.kind === 'gift' ? 'billing.orderLine.gift' : 'billing.orderLine.personal', { plan: planName(order.plan_id), period: periodLabel(t, order.period) });
const orderCode = (order) => html`<code>#${order.id}</code>`;

/** "Withdraw from contract here": the member's orders still inside their 14 days. */
export function withdrawListPage(ctx, { session, orders, now = Date.now() }) {
    const { t, ti, tpi } = textOf(ctx);
    const open = orders.filter((o) => canWithdraw(o, now));
    return layout(ctx, {
        title: t('billing.withdrawList.title'), active: 'me',
        body: html`<div class="wrap page prose"><a class="back-link" href="/me/billing">${t('billing.common.back')}</a>
<h1>${t('billing.withdrawList.heading')}</h1>
<p class="lead">${tpi('billing.withdrawList.lead', WITHDRAWAL_DAYS, { username: session.username })}</p>
${testBanner(t)}
${open.length ? html`<ul class="withdraw-list">${open.map((o) => html`<li>${ti('billing.withdrawList.item', { order: orderCode(o), line: orderLine(t, o), amount: orderMoney(ctx, o, o.amount_cents), date: when(o.created_at) })} <a class="button" href="/me/billing/orders/${o.id}/withdraw">${t('billing.withdrawList.button')}</a></li>`)}</ul>`
        : html`<p>${t('billing.withdrawList.none', { days: WITHDRAWAL_DAYS })}</p>`}
<p class="note">${ti('billing.withdrawList.note')}</p></div>`,
    });
}

/** Step 2 (CRD Art. 11a(2)–(3)): name, which contract, where the acknowledgement goes → "Confirm withdrawal". */
export function withdrawConfirmPage(ctx, { session, order, quote: wq, name = '', error = null }) {
    const { t, ti } = textOf(ctx);
    const contract = { order: orderCode(order), line: orderLine(t, order), amount: orderMoney(ctx, order, order.amount_cents), date: when(order.created_at) };
    return layout(ctx, {
        title: t('billing.withdrawConfirm.title'), active: 'me',
        body: html`<div class="wrap page prose"><a class="back-link" href="/me/withdraw">${t('billing.withdrawConfirm.back')}</a>
<h1>${t('billing.withdrawConfirm.heading', { id: order.id })}</h1>
${testBanner(t)}${notices({ error })}
<form method="post" action="/me/billing/orders/${order.id}/withdraw"><input type="hidden" name="csrf" value="${session.csrf}">
<p><label for="w-name">${t('billing.withdrawConfirm.name')}</label><br><input id="w-name" name="name" required maxlength="${WITHDRAWAL_NAME_MAX}" autocomplete="name" value="${name || session.username || ''}"></p>
<dl class="summary-rows">
<div><dt>${t('billing.withdrawConfirm.contract')}</dt><dd>${ti(order.test ? 'billing.withdrawConfirm.contractValueTest' : 'billing.withdrawConfirm.contractValue', contract)}</dd></div>
<div><dt>${t('billing.withdrawConfirm.account')}</dt><dd>${t('billing.withdrawConfirm.accountValue', { username: session.username })}</dd></div>
<div><dt>${t('billing.withdrawConfirm.ack')}</dt><dd>${t('billing.withdrawConfirm.ackValue')}</dd></div>
<div><dt>${t('billing.withdrawConfirm.daysUsed')}</dt><dd>${t('billing.withdrawConfirm.daysUsedValue', { used: wq.usedDays, total: wq.totalDays })}</dd></div>
<div class="summary-total"><dt>${t('billing.withdrawConfirm.refundDue')}</dt><dd>${order.test ? t('billing.withdrawConfirm.refundTest', { amount: orderMoney(ctx, order, wq.refundCents) }) : orderMoney(ctx, order, wq.refundCents)}</dd></div></dl>
<p>${t(order.kind === 'personal' ? 'billing.withdrawConfirm.statementPersonal' : 'billing.withdrawConfirm.statementGift')}</p>
<p><button class="button" type="submit">${t('billing.withdrawConfirm.button')}</button></p></form></div>`,
    });
}

/** Step 3 (CRD Art. 11a(4)): the acknowledgement with the content, date and time. */
export function withdrawalAckPage(ctx, { session, order, dmDelivered = null }) {
    const { t, ti } = textOf(ctx);
    const w = order.legal.withdrawal;
    return layout(ctx, {
        title: t('billing.withdrawalAck.title', { id: order.id }), active: 'me',
        body: html`<div class="wrap page prose"><a class="back-link" href="/me/billing">${t('billing.common.back')}</a>
<h1>${t('billing.withdrawalAck.heading')}</h1>
${testBanner(t)}
<dl class="summary-rows receipt">
<div><dt>${t('billing.withdrawalAck.received')}</dt><dd>${ti('billing.withdrawalAck.receivedValue', { date: when(w.at), utc: new Date(w.at).toISOString().replace('T', ' ').slice(0, 19) })}</dd></div>
<div><dt>${t('billing.withdrawalAck.name')}</dt><dd>${w.name}</dd></div>
<div><dt>${t('billing.withdrawalAck.account')}</dt><dd>${session.username}</dd></div>
<div><dt>${t('billing.withdrawalAck.contract')}</dt><dd>${ti('billing.withdrawConfirm.contractValue', { order: orderCode(order), line: orderLine(t, order), amount: orderMoney(ctx, order, order.amount_cents), date: when(order.created_at) })}</dd></div>
<div><dt>${t('billing.withdrawalAck.statement')}</dt><dd>${t('billing.withdrawalAck.statementValue')}</dd></div>
<div><dt>${t('billing.withdrawalAck.daysUsed')}</dt><dd>${t(w.planEnded ? 'billing.withdrawalAck.daysUsedEnded' : 'billing.withdrawConfirm.daysUsedValue', { used: w.usedDays, total: w.totalDays })}</dd></div>
<div class="summary-total"><dt>${t('billing.withdrawalAck.refundDue')}</dt><dd>${w.refundStatus === 'test-not-paid' ? t('billing.withdrawConfirm.refundTest', { amount: orderMoney(ctx, order, w.refundCents) }) : orderMoney(ctx, order, w.refundCents)}</dd></div></dl>
${dmDelivered === false ? html`<p class="error" role="alert">${t('billing.withdrawalAck.dmFailed')}</p>`
        : html`<p class="note">${t('billing.withdrawalAck.dmNote')}</p>`}
<p><a class="button" href="/me/billing">${t('billing.common.goToSubscription')}</a></p></div>`,
    });
}

function messagePage(ctx, title, message) {
    const { t } = textOf(ctx);
    return layout(ctx, {
        title, active: 'me',
        body: html`<div class="wrap page prose"><h1>${title}</h1><p class="lead">${message}</p><p><a class="button" href="/me/billing">${t('billing.common.backToSubscription')}</a></p></div>`,
    });
}

/**
 * The handlers. core: { readSession, sessions, settings (portal), ctx (), send, store, redeemLimiter, clientIp }.
 */
export function createBillingHandlers(core) {
    const {
        readSession, sessions, settings, ctx, send, store, redeemLimiter, clientIp, after = afterPremiumChange, notify = sendPremiumDm,
    } = core;
    // title/message: billing.errors.* keys (params for the message).
    const fail = (res, status, titleKey, messageKey, params) => {
        const c = ctx();
        const { t } = textOf(c);
        return send(res, status, messagePage(c, t(`billing.errors.${titleKey}`), t(`billing.errors.${messageKey}`, params)));
    };
    const postOk = (req, session) => isSameOrigin(req, settings.publicOrigin) && safeEqual(str(req.body?.csrf, 100), session.csrf);

    async function takeFlash(session) {
        if (!session.flash) return null;
        await sessions.setFlash?.(session.id, null);
        return session.flash;
    }

    async function renderBilling(res, session, status = 200, { error = null, code = '' } = {}) {
        const account = await store.accountOf(session.userId);
        const flash = status === 200 ? await takeFlash(session) : null;
        return send(res, status, billingPage(ctx(), { session, account, flash, error, code }));
    }

    async function billing(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 200, loginNeededPage(ctx(), '/me/billing'));
        return renderBilling(res, session);
    }

    async function checkout(req, res) {
        const choice = checkoutChoice(req.query);
        const session = await readSession(req);
        if (!session) return send(res, 200, loginNeededPage(ctx(), checkoutHref(choice), 'buyPlan', { plan: planName(choice.planId) }));
        const { subscription } = await store.accountOf(session.userId);
        return send(res, 200, checkoutPage(ctx(), { session, choice, current: subscription }));
    }

    async function checkoutPost(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 401, loginNeededPage(ctx(), '/pricing', 'buyAny'));
        if (!postOk(req, session)) return fail(res, 403, 'notAllowed', 'purchaseOrigin');
        const choice = checkoutChoice(req.body);
        const values = {
            giftTo: str(req.body?.gift_to, 200), giftMessage: str(req.body?.gift_message, 2000),
            consent: { start: req.body?.consent_start === 'yes', terms: req.body?.consent_terms === 'yes', age: req.body?.consent_age === 'yes' },
        };
        try {
            // Checked before anything is written: no order without all three boxes ticked.
            // The language the buyer saw: the form's own field (the page they ticked), else this request's.
            const consentLang = LANG_CODES.find((code) => code === req.body?.lang) || textOf(ctx()).lang;
            const consent = checkoutConsent(req.body, choice.kind, Date.now(), { lang: consentLang, texts: consentTexts(consentLang, choice.kind) });
            // The currency the checkout showed (its hidden field), else the language's: never a rate.
            const currency = checkoutCurrency(choice, consentLang);
            const result = await store.purchase({ userId: session.userId, username: session.username, ...choice, currency, giftTo: values.giftTo, giftMessage: values.giftMessage, consent });
            const { order } = result;
            logger.info(`Premium test order #${order.id}: ${session.userId} ${choice.kind} ${choice.planId}/${choice.period} (consent ${consent.version})`);
            // The confirmation DM replaces the plain "plan is active" DM for website orders.
            if (order.kind === 'personal') await after(result, 'purchase', { sendDm: false });
            const c = ctx();
            // The DM stays English for now: vatLine without a ctx is the English line.
            await notify(session.userId, orderConfirmationDm({
                order, subscription: result.subscription, key: result.key, origin: c.origin || '', seller: c.legal, vatText: vatLine(c.legal), termsVersion: LEGAL_UPDATED,
            }));
            return res.redirect(303, `/me/billing/orders/${order.id}`);
        } catch (error) {
            if (!(error instanceof PremiumError)) throw error;
            const { subscription } = await store.accountOf(session.userId);
            return send(res, error.status === 409 ? 409 : 400, checkoutPage(ctx(), { session, choice, current: subscription, values, error: premiumErrorText(error, ctx()) }));
        }
    }

    async function receipt(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 200, loginNeededPage(ctx(), '/me/billing'));
        const id = /^\d{1,18}$/.test(String(req.params.id || '')) ? String(req.params.id) : null;
        const account = id ? await store.accountOf(session.userId) : null;
        // Only the logged-in account's own orders (no lookup by id alone).
        const order = account?.orders.find((o) => String(o.id) === id) || null;
        if (!order) return fail(res, 404, 'notFound', 'noOrder');
        const key = order.key_code ? account.gifts.find((k) => k.code === order.key_code) || null : null;
        return send(res, 200, receiptPage(ctx(), { session, order, key }));
    }

    async function redeemForm(req, res) {
        const code = normalizeKeyCode(req.query?.code) || str(req.query?.code, 40);
        const session = await readSession(req);
        if (!session) return send(res, 200, loginNeededPage(ctx(), code ? `/me/redeem?${new URLSearchParams({ code })}` : '/me/redeem', 'redeem'));
        const peek = code && store.peekKey ? await store.peekKey(code) : null;
        return send(res, 200, redeemPage(ctx(), { session, code, peek }));
    }

    async function redeemPost(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 401, loginNeededPage(ctx(), '/me/redeem', 'redeem'));
        if (!postOk(req, session)) return fail(res, 403, 'notAllowed', 'redeemOrigin');
        const code = str(req.body?.code, 40);
        if (!redeemLimiter.allow(`${clientIp(req)}|${session.userId}`)) {
            res.set('Retry-After', '60');
            return renderBilling(res, session, 429, { error: textOf(ctx()).t('billing.errors.tooManyTries'), code });
        }
        try {
            const result = await store.redeem({ code, userId: session.userId, username: session.username });
            const { key, subscription } = result;
            await after(result, 'key');
            logger.info(`Premium key …${key.code.slice(-4)} redeemed by ${session.userId}`);
            const until = new Date(subscription.expires_at).toISOString().slice(0, 10);
            const converted = result.next?.converted;
            const flash = textOf(ctx()).t(converted ? 'billing.flash.redeemedConverted' : 'billing.flash.redeemed', {
                plan: planName(key.plan_id), days: key.duration_days, until, fromPlan: converted ? planName(converted.fromPlanId) : '',
            });
            await sessions.setFlash?.(session.id, flash);
            return res.redirect(303, '/me/billing');
        } catch (error) {
            if (!(error instanceof PremiumError)) throw error;
            return renderBilling(res, session, error.status === 409 ? 409 : 400, { error: premiumErrorText(error, ctx()), code });
        }
    }

    /** The "DM not delivered" marker after a committed withdrawal: a failure here must never hide it. */
    async function quietFlash(session, value) {
        try {
            await sessions.setFlash?.(session.id, value);
        } catch (error) {
            logger.warn(`Withdrawal notice flash not saved for ${session.userId}: ${error.message}`);
        }
    }

    /** The logged-in account's own order by :id, or null (never a lookup by id alone). */
    async function ownOrder(session, rawId) {
        const id = /^\d{1,18}$/.test(String(rawId || '')) ? String(rawId) : null;
        if (!id) return null;
        const account = await store.accountOf(session.userId);
        return account.orders.find((o) => String(o.id) === id) || null;
    }

    async function withdrawList(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 200, loginNeededPage(ctx(), '/me/withdraw', 'withdraw'));
        const { orders } = await store.accountOf(session.userId);
        return send(res, 200, withdrawListPage(ctx(), { session, orders }));
    }

    function withdrawGone(res, order) {
        if (order.legal?.withdrawal) return res.redirect(303, `/me/billing/orders/${order.id}/withdrawal`);
        return fail(res, 409, 'periodOver', 'periodOverText', { days: WITHDRAWAL_DAYS, id: order.id, date: withdrawalDeadline(order).toISOString().slice(0, 10) });
    }

    async function startedAtOf(session, order) {
        if (order.kind !== 'gift') return order.created_at;
        const { gifts } = await store.accountOf(session.userId);
        return gifts.find((k) => k.code === order.key_code)?.redeemed_at || null;
    }

    async function withdrawForm(req, res) {
        const session = await readSession(req);
        const id = /^\d{1,18}$/.test(String(req.params.id || '')) ? String(req.params.id) : null;
        if (!session) return send(res, 200, loginNeededPage(ctx(), id ? `/me/billing/orders/${id}/withdraw` : '/me/withdraw', 'withdraw'));
        const order = await ownOrder(session, id);
        if (!order) return fail(res, 404, 'notFound', 'noOrder');
        if (!canWithdraw(order)) return withdrawGone(res, order);
        const wq = withdrawalQuote(order, { startedAt: await startedAtOf(session, order) });
        return send(res, 200, withdrawConfirmPage(ctx(), { session, order, quote: wq }));
    }

    async function withdrawPost(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 401, loginNeededPage(ctx(), '/me/withdraw', 'withdraw'));
        if (!postOk(req, session)) return fail(res, 403, 'notAllowed', 'withdrawOrigin');
        const name = str(req.body?.name, 300);
        try {
            const result = await store.withdraw({ userId: session.userId, orderId: req.params.id, name });
            const { order, withdrawal } = result;
            logger.info(`Premium withdrawal: order #${order.id} by ${session.userId}, ${withdrawal.usedDays}/${withdrawal.totalDays} days used`);
            if (result.subscription) await after({ subscription: result.subscription }, 'withdrawal', { sendDm: false });
            const c = ctx();
            const delivered = await notify(session.userId, withdrawalAckDm({ order, withdrawal, origin: c.origin || '', seller: c.legal }));
            if (!delivered) await quietFlash(session, WITHDRAWAL_DM_FAILED);
            return res.redirect(303, `/me/billing/orders/${order.id}/withdrawal`);
        } catch (error) {
            if (!(error instanceof PremiumError)) throw error;
            const order = await ownOrder(session, req.params.id);
            if (!order) return fail(res, 404, 'notFound', 'noOrder');
            if (!canWithdraw(order)) return withdrawGone(res, order);
            const wq = withdrawalQuote(order, { startedAt: await startedAtOf(session, order) });
            return send(res, error.status === 409 ? 409 : 400, withdrawConfirmPage(ctx(), { session, order, quote: wq, name, error: premiumErrorText(error, ctx()) }));
        }
    }

    async function withdrawalAck(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 200, loginNeededPage(ctx(), '/me/billing'));
        const order = await ownOrder(session, req.params.id);
        if (!order?.legal?.withdrawal) return fail(res, 404, 'notFound', 'noWithdrawal');
        let dmDelivered = null;
        if (session.flash === WITHDRAWAL_DM_FAILED) {
            dmDelivered = false;
            await quietFlash(session, null);
        }
        return send(res, 200, withdrawalAckPage(ctx(), { session, order, dmDelivered }));
    }

    return { billing, checkout, checkoutPost, receipt, redeemForm, redeemPost, withdrawList, withdrawForm, withdrawPost, withdrawalAck };
}

/** For the pricing page: the plan buttons when test checkout is on. */
export function planButtons(plan, ctx = null) {
    const { t } = textOf(ctx);
    return Object.keys(PERIODS).map((period) => html`<div class="plan-actions plan-actions-${period}">
<a class="button" href="${checkoutHref({ planId: plan.id, period, kind: 'personal' })}">${t('billing.planButtons.buy', { plan: plan.name })}</a>
<a class="button button-quiet" href="${checkoutHref({ planId: plan.id, period, kind: 'gift' })}">${t('billing.planButtons.gift')}</a></div>`);
}

