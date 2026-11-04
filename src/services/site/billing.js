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

import { html, formatDate } from '../dashboard/html.js';
import { euros } from '../../config/site/plans.js';
import {
    CONSENT_TEXTS, GIFT_MESSAGE_MAX, GIFT_TO_MAX, PAID_PLANS, PERIODS, PremiumError, WITHDRAWAL_DAYS, WITHDRAWAL_NAME_MAX,
    canWithdraw, checkoutConsent, conversion, keyStatus, normalizeKeyCode, planName, priceCents, quote, withdrawalDeadline, withdrawalQuote,
} from '../billing/premiumService.js';
import { afterPremiumChange, orderConfirmationDm, sendPremiumDm, withdrawalAckDm } from '../billing/premiumEffects.js';
import { LEGAL_UPDATED } from './pages/legal.js';
import { isSameOrigin, safeEqual } from '../dashboard/security.js';
import { logger } from '../../utils/logger.js';
import { layout } from './shell.js';

export const TEST_NOTICE = 'No payment provider is connected. Completing a purchase creates a test order; no card is asked for and nobody is charged.';
/** Next to the pay button while no payment provider is connected. */
export const TEST_PAY_NOTE = 'Test mode — no money is taken';
/**
 * The VAT line on the checkout, receipt and confirmation. OWNER: confirm both with an
 * accountant before real payments; this is the one place to change the wording.
 */
export const VAT_TEXT = {
    registered: 'Price includes VAT.',
    notRegistered: 'VAT is not charged (the seller is not VAT registered).',
};
/** The VAT line: with LEGAL_VAT_NO set (ctx.legal.vatRegistered) "includes VAT", else "not charged". */
export const vatLine = (legal) => (legal?.vatRegistered ? VAT_TEXT.registered : VAT_TEXT.notRegistered);
/** The pay button's label (CRD Art. 8(2): "order with obligation to pay"). */
export const payLabel = (amountText) => `Order and pay · ${amountText}`;
const KIND_LABEL = { personal: 'For me', gift: 'Gift' };
const STATUS_LABEL = { unused: 'Not redeemed yet', redeemed: 'Redeemed', revoked: 'Cancelled', expired: 'Expired (not redeemed)' };
const SOURCE_TEXT = { key: 'Last added with a key.', purchase: 'Last added with a purchase.', owner: 'Given by the bot owner.', bonus: 'Early Mewvo account bonus.' };
const DAY_MS = 24 * 60 * 60 * 1000;
// Session flash marker: the withdrawal acknowledgement DM was not delivered (shown once on the ack page).
const WITHDRAWAL_DM_FAILED = 'The withdrawal acknowledgement DM could not be delivered.';
const daysText = (ms) => { const d = Math.round(ms / DAY_MS * 10) / 10; return `${d} day${d === 1 ? '' : 's'}`; };

const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/** A checkout query from the address bar, with safe defaults. Pure. */
export function checkoutChoice(q = {}) {
    return {
        planId: pick(str(q.plan, 20), PAID_PLANS.map((p) => p.id), (PAID_PLANS.find((p) => p.featured) || PAID_PLANS[0]).id),
        period: pick(str(q.period, 10), Object.keys(PERIODS), 'monthly'),
        kind: pick(str(q.for, 10), ['personal', 'gift'], 'personal'),
    };
}

export function checkoutHref({ planId, period, kind }) {
    return `/me/checkout?${new URLSearchParams({ plan: planId, period, for: kind })}`;
}

function when(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? html`<time datetime="${date.toISOString()}">${formatDate(date)}</time>` : '-';
}

/** "By …, you accept the Terms and Conditions. Privacy Policy." under every form that adds a plan. */
const TERMS_LINE = (action) => html`By ${action}, you accept the <a href="/terms">Terms and Conditions</a>. How your data is used: <a href="/privacy">Privacy Policy</a>.`;

const testBanner = () => html`<p class="test-banner" role="note"><span class="planned">Test mode</span> ${TEST_NOTICE}</p>`;
const notices = ({ flash = null, error = null }) => html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${error ? html`<p class="error" role="alert">${error}</p>` : ''}`;

function seg(label, options) {
    return html`<div class="seg-group"><p class="seg-label">${label}</p><ul class="seg">${options.map((o) => html`<li><a href="${o.href}"${o.current ? html` aria-current="true"` : ''}>${o.label}${o.sub ? html`<small>${o.sub}</small>` : ''}</a></li>`)}</ul></div>`;
}

export function loginNeededPage(ctx, next, what = 'manage your subscription') {
    return layout(ctx, {
        title: 'Log in', active: 'me',
        body: html`<div class="wrap page prose"><h1>Log in to continue</h1>
<p class="lead">Log in with Discord to ${what}. Mewvo asks Discord only who you are (identify): no email, nothing else.</p>
<p><a class="button" href="/me/login?${new URLSearchParams({ next })}">Log in with Discord</a></p>${testBanner()}</div>`,
    });
}

/**
 * What buying this for yourself does to the current plan: { kind: 'new' | 'extend' | 'upgrade' |
 * 'blocked', text }. Pure.
 */
export function checkoutEffect(current, choice, now = Date.now()) {
    if (!current) return { kind: 'new', text: 'Starts now.' };
    if (current.plan_id === choice.planId) return { kind: 'extend', text: `Added to your current ${planName(current.plan_id)} time (now until ${new Date(current.expires_at).toISOString().slice(0, 10)}).` };
    try {
        const c = conversion(current, choice.planId, now);
        return { kind: 'upgrade', text: `Upgrade: your remaining ${daysText(c.remainingMs)} of ${planName(c.fromPlanId)} become ${daysText(c.convertedMs)} of ${planName(choice.planId)}, then the new time is added.` };
    } catch (error) {
        if (error instanceof PremiumError) return { kind: 'blocked', text: error.userMessage };
        throw error;
    }
}

export function checkoutPage(ctx, { session, choice, current = null, values = {}, error = null }) {
    const q = quote(choice);
    const effect = choice.kind === 'personal' ? checkoutEffect(current, choice) : null;
    const others = (patch) => checkoutHref({ ...choice, ...patch });
    const gift = choice.kind === 'gift';
    const per = choice.period === 'yearly' ? 'year' : 'month';
    return layout(ctx, {
        title: 'Checkout', active: 'me',
        body: html`<div class="wrap page"><a class="back-link" href="/pricing">← Plans</a>
<header class="page-head"><h1>${gift ? `Gift Mewvo ${q.plan.name}` : `Mewvo ${q.plan.name}`}</h1></header>
${testBanner()}${notices({ error })}
<div class="checkout"><div class="checkout-options">
${seg('Plan', PAID_PLANS.map((p) => ({ label: p.name, sub: `${euros(priceCents(p.id, choice.period))}/${per}`, href: others({ planId: p.id }), current: p.id === choice.planId })))}
${seg('Billing', Object.entries(PERIODS).map(([id, p]) => ({ label: p.label, sub: id === 'yearly' ? '2 months free' : `${p.days} days`, href: others({ period: id }), current: id === choice.period })))}
${seg('Who is it for', [
        { label: 'For me', sub: 'starts on your account now', href: others({ kind: 'personal' }), current: !gift },
        { label: 'As a gift', sub: 'you get a key to give away', href: others({ kind: 'gift' }), current: gift },
    ])}
<section class="checkout-plan"><h2>${q.plan.name} includes</h2><ul class="plan-perks">${q.plan.perks.map((perk) => html`<li>${perk.text}${perk.planned ? html` <span class="planned">Planned</span>` : ''}</li>`)}</ul></section>
</div>
<aside class="summary" aria-labelledby="summary-title"><h2 id="summary-title">Order summary</h2>
<dl class="summary-rows">
<div><dt>Plan</dt><dd>Mewvo ${q.plan.name}</dd></div>
<div><dt>Billing</dt><dd>${PERIODS[choice.period].label} (${q.days} days)</dd></div>
<div><dt>For</dt><dd>${gift ? 'A gift key' : html`Your account (${session.username})`}</dd></div>
<div class="summary-total"><dt>Total</dt><dd>${q.amountText}</dd></div></dl>
<p class="note summary-vat">${vatLine(ctx.legal)} One payment for ${q.days} days. No automatic renewal: the plan ends unless you buy more time.</p>
<p class="note${effect?.kind === 'upgrade' ? ' summary-upgrade' : ''}">${gift
        ? 'You get a key like MEWVO-XXXX-XXXX-XXXX, valid for a year. Anyone who logs in on this site can redeem it once.'
        : effect.text}</p>
${effect?.kind === 'blocked' ? html`<p class="button button-disabled summary-pay" aria-disabled="true">Not available while your plan runs</p>`
        : html`<form method="post" action="/me/checkout"><input type="hidden" name="csrf" value="${session.csrf}">
<input type="hidden" name="plan" value="${choice.planId}"><input type="hidden" name="period" value="${choice.period}"><input type="hidden" name="for" value="${choice.kind}">
${gift ? html`<div class="gift-fields"><label for="gift-to">To (optional)</label><input id="gift-to" name="gift_to" maxlength="${GIFT_TO_MAX}" autocomplete="off" value="${values.giftTo || ''}" placeholder="Their name">
<label for="gift-message">Message (optional)</label><textarea id="gift-message" name="gift_message" maxlength="${GIFT_MESSAGE_MAX}" rows="3" placeholder="Shown when they open the gift link">${values.giftMessage || ''}</textarea></div>` : ''}
<fieldset class="consent"><legend class="seg-label">Before you order</legend>
${consentBox('consent_start', gift ? CONSENT_TEXTS.startNowGift : CONSENT_TEXTS.startNow, values.consent?.start)}
${consentBox('consent_terms', html`I accept the <a href="/terms">Terms and Conditions</a>.`, values.consent?.terms)}
${consentBox('consent_age', CONSENT_TEXTS.age, values.consent?.age)}</fieldset>
<button class="button summary-pay" type="submit">${payLabel(q.amountText)}</button> <span class="planned test-pay-note">${TEST_PAY_NOTE}</span></form>`}
<p class="note">How your data is used: <a href="/privacy">Privacy Policy</a>. You can withdraw within ${WITHDRAWAL_DAYS} days: <a href="/withdrawal">right of withdrawal</a>.${gift ? ' For a gift, the right of withdrawal is yours as the buyer, not the recipient\'s.' : ''}</p></aside></div>
${sellerInfo(ctx, q, gift)}</div>`,
    });
}

/** One required, unticked checkbox (ticked again only when the form comes back with an error). */
function consentBox(name, label, checked = false) {
    return html`<label class="consent-box"><input type="checkbox" name="${name}" value="yes" required${checked ? html` checked` : ''}> <span>${label}</span></label>`;
}

/** Who sells (CRD Art. 6(1)(b)–(c)) and the key facts, under the order summary. */
function sellerInfo(ctx, q, gift) {
    const legal = ctx.legal || {};
    return html`<section class="checkout-seller" aria-labelledby="seller-title"><h2 id="seller-title">Before you order</h2>
<dl class="summary-rows">
<div><dt>Seller</dt><dd>${legal.operator || 'Mewvo'}${legal.email ? html`, <a href="mailto:${legal.email}">${legal.email}</a>` : ''} · <a href="/legal">Legal details</a></dd></div>
<div><dt>What you get</dt><dd>Mewvo ${q.plan.name} (the list above)${gift ? ', as a key you can give away' : ' on your Discord account'}</dd></div>
<div><dt>Duration</dt><dd>${q.days} days from ${gift ? 'when the key is redeemed' : 'the order'}; no automatic renewal</dd></div>
<div><dt>Total price</dt><dd>${q.amountText}. ${vatLine(legal)}</dd></div>
<div><dt>Withdrawal</dt><dd>${WITHDRAWAL_DAYS} days. If the plan already started, you pay for the days used. <a href="/withdrawal">How to withdraw</a></dd></div></dl></section>`;
}

/** The order's withdrawal state for lists: a link while open, the outcome once withdrawn. */
function withdrawalCell(order, now = Date.now()) {
    const w = order.legal?.withdrawal;
    if (w) return html`<a href="/me/billing/orders/${order.id}/withdrawal">Withdrawn</a><br><small class="note">${when(w.at)} · refund due ${euros(w.refundCents)}${w.refundStatus === 'test-not-paid' ? ' (test)' : ''}</small>`;
    if (canWithdraw(order, now)) return html`<a href="/me/billing/orders/${order.id}/withdraw">Withdraw from contract here</a><br><small class="note">until ${when(withdrawalDeadline(order))}</small>`;
    return '';
}

function subscriptionCard(subscription) {
    if (!subscription) {
        return html`<li class="feature"><h2>Your plan</h2><p class="record-big">Free</p><p>No paid plan on this account. <a href="/pricing">See plans</a>.</p></li>`;
    }
    return html`<li class="feature"><h2>Your plan</h2><p class="record-big">${planName(subscription.plan_id)}</p>
<p>Active until ${when(subscription.expires_at)}. ${SOURCE_TEXT[subscription.source] || ''}</p>
<p><a href="${checkoutHref({ planId: subscription.plan_id, period: 'monthly', kind: 'personal' })}">Add more time</a></p></li>`;
}

function redeemForm(session, code = '') {
    return html`<form class="redeem-form" method="post" action="/me/redeem"><input type="hidden" name="csrf" value="${session.csrf}">
<label for="redeem-code">Key</label><div class="redeem-row"><input id="redeem-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="MEWVO-XXXX-XXXX-XXXX" required value="${code}">
<button class="button" type="submit">Redeem</button></div></form>
<p class="note">${TERMS_LINE('redeeming a key')}</p>`;
}

export function billingPage(ctx, { session, account, flash = null, error = null, code = '' }) {
    const { subscription, orders, gifts } = account;
    return layout(ctx, {
        title: 'Subscription', active: 'me',
        body: html`<div class="wrap page record"><div class="record-head"><div><h1>Subscription</h1>
<p class="lead">Your Mewvo plan, keys and orders, logged in as <strong>${session.username}</strong>.</p></div>
<nav class="record-links" aria-label="My account"><a class="button button-quiet" href="/me">My record</a> <a class="button" href="/pricing">Plans</a></nav></div>
${testBanner()}${notices({ flash, error })}
<ul class="record-summary">${subscriptionCard(subscription)}
<li class="feature"><h2>Redeem a key</h2>${redeemForm(session, code)}<p class="note">A key adds its plan and time to your account. Same plan: added to the end date. A higher plan converts your remaining time.</p></li></ul>
<h2 id="gifts-title">Gift keys you bought</h2>
${gifts.length ? html`<div class="table-wrap" role="region" aria-labelledby="gifts-title" tabindex="0"><table class="record-table"><thead><tr><th scope="col">Key</th><th scope="col">Plan</th><th scope="col">Time</th><th scope="col">Bought</th><th scope="col">Status</th></tr></thead>
<tbody>${gifts.map((k) => html`<tr><td><code class="key-code">${k.code}</code>${k.gift_to ? html`<br><small class="note">To ${k.gift_to}</small>` : ''}</td><td>${planName(k.plan_id)}</td><td>${k.duration_days} days</td><td>${when(k.created_at)}</td><td>${STATUS_LABEL[keyStatus(k)]}${k.redeemed_at ? html`<br><small class="note">${when(k.redeemed_at)}</small>` : ''}</td></tr>`)}</tbody></table></div>`
        : html`<p>No gift keys yet. Choose <strong>As a gift</strong> at checkout to get one.</p>`}
<h2 id="orders-title">Orders</h2>
${orders.length ? html`<div class="table-wrap" role="region" aria-labelledby="orders-title" tabindex="0"><table class="record-table"><thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Plan</th><th scope="col">For</th><th scope="col">Amount</th><th scope="col">Withdrawal</th><th scope="col"></th></tr></thead>
<tbody>${orders.map((o) => html`<tr><td><code>#${o.id}</code></td><td>${when(o.created_at)}</td><td>${planName(o.plan_id)} · ${PERIODS[o.period]?.label || o.period}</td><td>${KIND_LABEL[o.kind] || o.kind}</td><td>${euros(o.amount_cents)}${o.test ? html` <span class="planned">Test</span>` : ''}</td><td>${withdrawalCell(o)}</td><td><a href="/me/billing/orders/${o.id}">Receipt</a></td></tr>`)}</tbody></table></div>
<p class="note">You can withdraw from an order within ${WITHDRAWAL_DAYS} days of buying it. <a href="/withdrawal">Right of withdrawal</a>.</p>`
        : html`<p>No orders yet.</p>`}</div>`,
    });
}

export function receiptPage(ctx, { session, order, key = null }) {
    const gift = order.kind === 'gift';
    const redeemLink = key && ctx.origin ? `${ctx.origin}/me/redeem?${new URLSearchParams({ code: key.code })}` : null;
    return layout(ctx, {
        title: `Order #${order.id}`, active: 'me',
        body: html`<div class="wrap page prose"><a class="back-link" href="/me/billing">← Subscription</a>
<h1>${gift ? 'Your gift key is ready' : 'Thanks, your plan is active'}</h1>
${testBanner()}
${gift && key ? html`<div class="key-box"><p class="seg-label">Gift key · ${planName(key.plan_id)}, ${key.duration_days} days${key.gift_to ? ` · to ${key.gift_to}` : ''}</p><p class="key-big"><code>${key.code}</code></p>
${key.gift_message ? html`<blockquote class="gift-message">${key.gift_message}</blockquote>` : ''}
<p class="note">${keyStatus(key) === 'unused' ? html`Give this key to anyone. They log in on this site and redeem it under Subscription → Redeem a key, or in Discord with <code>/premium redeem</code>.${key.expires_at ? html` Redeem by ${when(key.expires_at)}.` : ''}` : `Status: ${STATUS_LABEL[keyStatus(key)]}.`}</p>
${redeemLink ? html`<p class="note">Direct link: <code class="key-link">${redeemLink}</code></p>` : ''}</div>` : ''}
<dl class="summary-rows receipt">
<div><dt>Order</dt><dd><code>#${order.id}</code></dd></div>
<div><dt>Date</dt><dd>${when(order.created_at)}</dd></div>
<div><dt>Account</dt><dd>${session.username}</dd></div>
<div><dt>Plan</dt><dd>Mewvo ${planName(order.plan_id)} · ${PERIODS[order.period]?.label || order.period}</dd></div>
<div><dt>For</dt><dd>${KIND_LABEL[order.kind] || order.kind}</dd></div>
<div class="summary-total"><dt>Total</dt><dd>${euros(order.amount_cents)}${order.test ? ' (test, not charged)' : ''}</dd></div>
<div><dt>VAT</dt><dd>${vatLine(ctx.legal)}</dd></div>
<div><dt>Renewal</dt><dd>None: the plan ends unless you buy more time</dd></div>
${order.legal?.consent ? html`<div><dt>You confirmed</dt><dd>${order.legal.consent.texts.map((t) => html`${t}<br>`)}<small class="note">${when(order.legal.consent.at)} · ${order.legal.consent.version} · Terms of ${LEGAL_UPDATED}</small></dd></div>` : ''}
<div><dt>Withdrawal</dt><dd>${withdrawalCell(order) || html`The ${WITHDRAWAL_DAYS}-day period ended. <a href="/withdrawal">Right of withdrawal</a>`}${gift ? html`<br><small class="note">For a gift, the right of withdrawal is yours as the buyer.</small>` : ''}</dd></div></dl>
<p class="note">This confirmation is also sent to you as a Discord DM (when your DMs from the bot are open). Keep it for your records.</p>
<p><a class="button" href="/me/billing">Go to Subscription</a></p></div>`,
    });
}

/** A gift link's card: who it is from, the plan and the message (peekKey; unused keys only). */
function giftCard(peek) {
    if (!peek) return '';
    return html`<div class="key-box gift-card"><p class="seg-label">${peek.from ? `A gift from ${peek.from}` : 'A Mewvo key'}${peek.giftTo ? ` for ${peek.giftTo}` : ''}</p>
<p class="key-big">Mewvo ${planName(peek.planId)} · ${peek.days} days</p>
${peek.giftMessage ? html`<blockquote class="gift-message">${peek.giftMessage}</blockquote>` : ''}
${peek.expiresAt ? html`<p class="note">Redeem by ${when(peek.expiresAt)}.</p>` : ''}</div>`;
}

export function redeemPage(ctx, { session, code = '', peek = null, error = null }) {
    return layout(ctx, {
        title: 'Redeem a key', active: 'me',
        body: html`<div class="wrap page prose"><h1>${peek?.from ? 'You got a gift' : 'Redeem a key'}</h1>
<p class="lead">Logged in as <strong>${session.username}</strong>. The key's plan is added to this account.</p>
${testBanner()}${notices({ error })}${giftCard(peek)}${redeemForm(session, code)}
<p class="note"><a href="/me/billing">Back to Subscription</a></p></div>`,
    });
}

const orderLine = (order) => `Mewvo ${planName(order.plan_id)} · ${PERIODS[order.period]?.label || order.period}${order.kind === 'gift' ? ' (gift)' : ''}`;

/** "Withdraw from contract here": the member's orders still inside their 14 days. */
export function withdrawListPage(ctx, { session, orders, now = Date.now() }) {
    const open = orders.filter((o) => canWithdraw(o, now));
    return layout(ctx, {
        title: 'Withdraw from a contract', active: 'me',
        body: html`<div class="wrap page prose"><a class="back-link" href="/me/billing">← Subscription</a>
<h1>Withdraw from contract here</h1>
<p class="lead">Logged in as <strong>${session.username}</strong>. Choose the order you want to withdraw from. You can withdraw within ${WITHDRAWAL_DAYS} days of the order, without giving a reason.</p>
${testBanner()}
${open.length ? html`<ul class="withdraw-list">${open.map((o) => html`<li><strong>Order <code>#${o.id}</code></strong>: ${orderLine(o)}, ${euros(o.amount_cents)}, ordered ${when(o.created_at)}. <a class="button" href="/me/billing/orders/${o.id}/withdraw">Withdraw from contract here</a></li>`)}</ul>`
        : html`<p>No order on this account is inside its ${WITHDRAWAL_DAYS}-day withdrawal period.</p>`}
<p class="note"><a href="/withdrawal">Your right of withdrawal</a> explains the rules and the other ways to withdraw.</p></div>`,
    });
}

/** Step 2 (CRD Art. 11a(2)–(3)): name, which contract, where the acknowledgement goes → "Confirm withdrawal". */
export function withdrawConfirmPage(ctx, { session, order, quote: wq, name = '', error = null }) {
    return layout(ctx, {
        title: 'Confirm withdrawal', active: 'me',
        body: html`<div class="wrap page prose"><a class="back-link" href="/me/withdraw">← Withdraw from contract here</a>
<h1>Withdraw from order #${order.id}</h1>
${testBanner()}${notices({ error })}
<form method="post" action="/me/billing/orders/${order.id}/withdraw"><input type="hidden" name="csrf" value="${session.csrf}">
<p><label for="w-name">Your name</label><br><input id="w-name" name="name" required maxlength="${WITHDRAWAL_NAME_MAX}" autocomplete="name" value="${name || session.username || ''}"></p>
<dl class="summary-rows">
<div><dt>Contract</dt><dd>Order <code>#${order.id}</code>: ${orderLine(order)}, ${euros(order.amount_cents)}${order.test ? ' (test)' : ''}, ordered ${when(order.created_at)}</dd></div>
<div><dt>Account</dt><dd>${session.username} (Discord)</dd></div>
<div><dt>Acknowledgement</dt><dd>Sent to you as a Discord DM and kept on this account under Subscription</dd></div>
<div><dt>Days used</dt><dd>${wq.usedDays} of ${wq.totalDays}</dd></div>
<div class="summary-total"><dt>Refund due</dt><dd>${euros(wq.refundCents)}${order.test ? ' (test order: nothing was charged, nothing is paid back)' : ''}</dd></div></dl>
<p>Statement: I withdraw from my contract for this order. ${order.kind === 'personal' ? 'The unused days are taken off my plan now.' : 'An unused gift key is cancelled; if it was redeemed, its unused days are taken off that plan.'}</p>
<p><button class="button" type="submit">Confirm withdrawal</button></p></form></div>`,
    });
}

/** Step 3 (CRD Art. 11a(4)): the acknowledgement with the content, date and time. */
export function withdrawalAckPage(ctx, { session, order, dmDelivered = null }) {
    const w = order.legal.withdrawal;
    return layout(ctx, {
        title: `Withdrawal from order #${order.id}`, active: 'me',
        body: html`<div class="wrap page prose"><a class="back-link" href="/me/billing">← Subscription</a>
<h1>We received your withdrawal</h1>
${testBanner()}
<dl class="summary-rows receipt">
<div><dt>Received</dt><dd>${when(w.at)} (${new Date(w.at).toISOString().replace('T', ' ').slice(0, 19)} UTC)</dd></div>
<div><dt>Name</dt><dd>${w.name}</dd></div>
<div><dt>Account</dt><dd>${session.username}</dd></div>
<div><dt>Contract</dt><dd>Order <code>#${order.id}</code>: ${orderLine(order)}, ${euros(order.amount_cents)}, ordered ${when(order.created_at)}</dd></div>
<div><dt>Statement</dt><dd>I withdraw from my contract for this order.</dd></div>
<div><dt>Days used</dt><dd>${w.usedDays} of ${w.totalDays}${w.planEnded ? ' · the plan has ended' : ''}</dd></div>
<div class="summary-total"><dt>Refund due</dt><dd>${euros(w.refundCents)}${w.refundStatus === 'test-not-paid' ? ' (test order: nothing was charged, nothing is paid back)' : ''}</dd></div></dl>
${dmDelivered === false ? html`<p class="error" role="alert">The Discord DM with this acknowledgement could not be delivered (your DMs may be closed). Save or print this page; it also stays on your account.</p>`
        : html`<p class="note">This acknowledgement is also sent to you as a Discord DM and stays on your account.</p>`}
<p><a class="button" href="/me/billing">Go to Subscription</a></p></div>`,
    });
}

function messagePage(ctx, title, message) {
    return layout(ctx, {
        title, active: 'me',
        body: html`<div class="wrap page prose"><h1>${title}</h1><p class="lead">${message}</p><p><a class="button" href="/me/billing">Back to Subscription</a></p></div>`,
    });
}

/**
 * The handlers. core: { readSession, sessions, settings (portal), ctx (), send, store, redeemLimiter, clientIp }.
 */
export function createBillingHandlers(core) {
    const {
        readSession, sessions, settings, ctx, send, store, redeemLimiter, clientIp, after = afterPremiumChange, notify = sendPremiumDm,
    } = core;
    const fail = (res, status, title, message) => send(res, status, messagePage(ctx(), title, message));
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
        if (!session) return send(res, 200, loginNeededPage(ctx(), checkoutHref(choice), `buy Mewvo ${planName(choice.planId)}`));
        const { subscription } = await store.accountOf(session.userId);
        return send(res, 200, checkoutPage(ctx(), { session, choice, current: subscription }));
    }

    async function checkoutPost(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 401, loginNeededPage(ctx(), '/pricing', 'buy a plan'));
        if (!postOk(req, session)) return fail(res, 403, 'Not allowed', 'This purchase did not come from this site. Nothing was bought.');
        const choice = checkoutChoice(req.body);
        const values = {
            giftTo: str(req.body?.gift_to, 200), giftMessage: str(req.body?.gift_message, 2000),
            consent: { start: req.body?.consent_start === 'yes', terms: req.body?.consent_terms === 'yes', age: req.body?.consent_age === 'yes' },
        };
        try {
            // Checked before anything is written: no order without all three boxes ticked.
            const consent = checkoutConsent(req.body, choice.kind);
            const result = await store.purchase({ userId: session.userId, username: session.username, ...choice, giftTo: values.giftTo, giftMessage: values.giftMessage, consent });
            const { order } = result;
            logger.info(`Premium test order #${order.id}: ${session.userId} ${choice.kind} ${choice.planId}/${choice.period} (consent ${consent.version})`);
            // The confirmation DM replaces the plain "plan is active" DM for website orders.
            if (order.kind === 'personal') await after(result, 'purchase', { sendDm: false });
            const c = ctx();
            await notify(session.userId, orderConfirmationDm({
                order, subscription: result.subscription, key: result.key, origin: c.origin || '', seller: c.legal, vatText: vatLine(c.legal), termsVersion: LEGAL_UPDATED,
            }));
            return res.redirect(303, `/me/billing/orders/${order.id}`);
        } catch (error) {
            if (!(error instanceof PremiumError)) throw error;
            const { subscription } = await store.accountOf(session.userId);
            return send(res, error.status === 409 ? 409 : 400, checkoutPage(ctx(), { session, choice, current: subscription, values, error: error.userMessage }));
        }
    }

    async function receipt(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 200, loginNeededPage(ctx(), '/me/billing'));
        const id = /^\d{1,18}$/.test(String(req.params.id || '')) ? String(req.params.id) : null;
        const account = id ? await store.accountOf(session.userId) : null;
        // Only the logged-in account's own orders (no lookup by id alone).
        const order = account?.orders.find((o) => String(o.id) === id) || null;
        if (!order) return fail(res, 404, 'Not found', 'There is no such order on your account.');
        const key = order.key_code ? account.gifts.find((k) => k.code === order.key_code) || null : null;
        return send(res, 200, receiptPage(ctx(), { session, order, key }));
    }

    async function redeemForm(req, res) {
        const code = normalizeKeyCode(req.query?.code) || str(req.query?.code, 40);
        const session = await readSession(req);
        if (!session) return send(res, 200, loginNeededPage(ctx(), code ? `/me/redeem?${new URLSearchParams({ code })}` : '/me/redeem', 'redeem a key'));
        const peek = code && store.peekKey ? await store.peekKey(code) : null;
        return send(res, 200, redeemPage(ctx(), { session, code, peek }));
    }

    async function redeemPost(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 401, loginNeededPage(ctx(), '/me/redeem', 'redeem a key'));
        if (!postOk(req, session)) return fail(res, 403, 'Not allowed', 'This form did not come from this site. Nothing was redeemed.');
        const code = str(req.body?.code, 40);
        if (!redeemLimiter.allow(`${clientIp(req)}|${session.userId}`)) {
            res.set('Retry-After', '60');
            return renderBilling(res, session, 429, { error: 'Too many tries. Wait a minute and try again.', code });
        }
        try {
            const result = await store.redeem({ code, userId: session.userId, username: session.username });
            const { key, subscription } = result;
            await after(result, 'key');
            logger.info(`Premium key …${key.code.slice(-4)} redeemed by ${session.userId}`);
            const until = new Date(subscription.expires_at).toISOString().slice(0, 10);
            const up = result.next?.converted ? ` Your remaining ${planName(result.next.converted.fromPlanId)} time was converted.` : '';
            await sessions.setFlash?.(session.id, `Key redeemed: Mewvo ${planName(key.plan_id)}, ${key.duration_days} days added.${up} Active until ${until}.`);
            return res.redirect(303, '/me/billing');
        } catch (error) {
            if (!(error instanceof PremiumError)) throw error;
            return renderBilling(res, session, error.status === 409 ? 409 : 400, { error: error.userMessage, code });
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
        if (!session) return send(res, 200, loginNeededPage(ctx(), '/me/withdraw', 'withdraw from an order'));
        const { orders } = await store.accountOf(session.userId);
        return send(res, 200, withdrawListPage(ctx(), { session, orders }));
    }

    function withdrawGone(res, order) {
        if (order.legal?.withdrawal) return res.redirect(303, `/me/billing/orders/${order.id}/withdrawal`);
        return fail(res, 409, 'Withdrawal period over', `The ${WITHDRAWAL_DAYS}-day withdrawal period for order #${order.id} ended on ${withdrawalDeadline(order).toISOString().slice(0, 10)}. Contact us if you think this is wrong.`);
    }

    async function startedAtOf(session, order) {
        if (order.kind !== 'gift') return order.created_at;
        const { gifts } = await store.accountOf(session.userId);
        return gifts.find((k) => k.code === order.key_code)?.redeemed_at || null;
    }

    async function withdrawForm(req, res) {
        const session = await readSession(req);
        const id = /^\d{1,18}$/.test(String(req.params.id || '')) ? String(req.params.id) : null;
        if (!session) return send(res, 200, loginNeededPage(ctx(), id ? `/me/billing/orders/${id}/withdraw` : '/me/withdraw', 'withdraw from an order'));
        const order = await ownOrder(session, id);
        if (!order) return fail(res, 404, 'Not found', 'There is no such order on your account.');
        if (!canWithdraw(order)) return withdrawGone(res, order);
        const wq = withdrawalQuote(order, { startedAt: await startedAtOf(session, order) });
        return send(res, 200, withdrawConfirmPage(ctx(), { session, order, quote: wq }));
    }

    async function withdrawPost(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 401, loginNeededPage(ctx(), '/me/withdraw', 'withdraw from an order'));
        if (!postOk(req, session)) return fail(res, 403, 'Not allowed', 'This form did not come from this site. Nothing was withdrawn.');
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
            if (!order) return fail(res, 404, 'Not found', 'There is no such order on your account.');
            if (!canWithdraw(order)) return withdrawGone(res, order);
            const wq = withdrawalQuote(order, { startedAt: await startedAtOf(session, order) });
            return send(res, error.status === 409 ? 409 : 400, withdrawConfirmPage(ctx(), { session, order, quote: wq, name, error: error.userMessage }));
        }
    }

    async function withdrawalAck(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 200, loginNeededPage(ctx(), '/me/billing'));
        const order = await ownOrder(session, req.params.id);
        if (!order?.legal?.withdrawal) return fail(res, 404, 'Not found', 'There is no withdrawal for such an order on your account.');
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
export function planButtons(plan) {
    return Object.keys(PERIODS).map((period) => html`<div class="plan-actions plan-actions-${period}">
<a class="button" href="${checkoutHref({ planId: plan.id, period, kind: 'personal' })}">Buy ${plan.name}</a>
<a class="button button-quiet" href="${checkoutHref({ planId: plan.id, period, kind: 'gift' })}">Gift it</a></div>`);
}

