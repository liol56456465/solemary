// billing.js — subscriptions on the website, inside "My record" (/me). TEST CHECKOUT ONLY:
// no payment provider is connected, no card details are asked for, nobody is charged.
// Off unless PREMIUM_TEST_CHECKOUT=true (and the member portal is on).
//
//   GET  /me/billing                  subscription, redeem form, gift keys bought, orders
//   GET  /me/checkout?plan=&period=&for=   the order summary (switch plan / billing / for me or gift)
//   POST /me/checkout                 "Complete test purchase" → a test order (premiumService.purchase)
//   GET  /me/billing/orders/:id       the receipt; for a gift it shows the key (own orders only)
//   GET  /me/redeem[?code=]           the redeem form (code pre-filled from a gift link)
//   POST /me/redeem                   redeems a key for the logged-in account
//
// Not logged in: GET pages show "Log in with Discord" with a return path (/me/login?next=…).
// POSTs: logged in + same origin + CSRF (like logout); redeem is rate limited separately.
// A database error is a 503 page; nothing is shown as bought unless the transaction committed.

import { html, formatDate } from '../dashboard/html.js';
import { euros } from '../../config/site/plans.js';
import {
    GIFT_MESSAGE_MAX, GIFT_TO_MAX, PAID_PLANS, PERIODS, PremiumError, conversion, keyStatus, normalizeKeyCode, planName, priceCents, quote,
} from '../billing/premiumService.js';
import { afterPremiumChange } from '../billing/premiumEffects.js';
import { isSameOrigin, safeEqual } from '../dashboard/security.js';
import { logger } from '../../utils/logger.js';
import { layout } from './shell.js';

export const TEST_NOTICE = 'No payment provider is connected. Completing a purchase creates a test order; no card is asked for and nobody is charged.';
const KIND_LABEL = { personal: 'For me', gift: 'Gift' };
const STATUS_LABEL = { unused: 'Not redeemed yet', redeemed: 'Redeemed', revoked: 'Cancelled', expired: 'Expired (not redeemed)' };
const SOURCE_TEXT = { key: 'Last added with a key.', purchase: 'Last added with a purchase.', owner: 'Given by the bot owner.' };
const DAY_MS = 24 * 60 * 60 * 1000;
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
<p class="note${effect?.kind === 'upgrade' ? ' summary-upgrade' : ''}">${gift
        ? 'You get a key like MEWVO-XXXX-XXXX-XXXX, valid for a year. Anyone who logs in on this site can redeem it once.'
        : effect.text}</p>
${effect?.kind === 'blocked' ? html`<p class="button button-disabled summary-pay" aria-disabled="true">Not available while your plan runs</p>`
        : html`<form method="post" action="/me/checkout"><input type="hidden" name="csrf" value="${session.csrf}">
<input type="hidden" name="plan" value="${choice.planId}"><input type="hidden" name="period" value="${choice.period}"><input type="hidden" name="for" value="${choice.kind}">
${gift ? html`<div class="gift-fields"><label for="gift-to">To (optional)</label><input id="gift-to" name="gift_to" maxlength="${GIFT_TO_MAX}" autocomplete="off" value="${values.giftTo || ''}" placeholder="Their name">
<label for="gift-message">Message (optional)</label><textarea id="gift-message" name="gift_message" maxlength="${GIFT_MESSAGE_MAX}" rows="3" placeholder="Shown when they open the gift link">${values.giftMessage || ''}</textarea></div>` : ''}
<button class="button summary-pay" type="submit">Complete test purchase · ${q.amountText}</button></form>`}
<p class="note">No payment is taken in test mode. ${TERMS_LINE('completing the purchase')}</p></aside></div></div>`,
    });
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
${orders.length ? html`<div class="table-wrap" role="region" aria-labelledby="orders-title" tabindex="0"><table class="record-table"><thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Plan</th><th scope="col">For</th><th scope="col">Amount</th><th scope="col"></th></tr></thead>
<tbody>${orders.map((o) => html`<tr><td><code>#${o.id}</code></td><td>${when(o.created_at)}</td><td>${planName(o.plan_id)} · ${PERIODS[o.period]?.label || o.period}</td><td>${KIND_LABEL[o.kind] || o.kind}</td><td>${euros(o.amount_cents)}${o.test ? html` <span class="planned">Test</span>` : ''}</td><td><a href="/me/billing/orders/${o.id}">Receipt</a></td></tr>`)}</tbody></table></div>`
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
<div class="summary-total"><dt>Total</dt><dd>${euros(order.amount_cents)}${order.test ? ' (test, not charged)' : ''}</dd></div></dl>
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
    const { readSession, sessions, settings, ctx, send, store, redeemLimiter, clientIp, after = afterPremiumChange } = core;
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
        const values = { giftTo: str(req.body?.gift_to, 200), giftMessage: str(req.body?.gift_message, 2000) };
        try {
            const result = await store.purchase({ userId: session.userId, username: session.username, ...choice, giftTo: values.giftTo, giftMessage: values.giftMessage });
            const { order } = result;
            logger.info(`Premium test order #${order.id}: ${session.userId} ${choice.kind} ${choice.planId}/${choice.period}`);
            if (order.kind === 'personal') await after(result, 'purchase');
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

    return { billing, checkout, checkoutPost, receipt, redeemForm, redeemPost };
}

/** For the pricing page: the plan buttons when test checkout is on. */
export function planButtons(plan) {
    return Object.keys(PERIODS).map((period) => html`<div class="plan-actions plan-actions-${period}">
<a class="button" href="${checkoutHref({ planId: plan.id, period, kind: 'personal' })}">Buy ${plan.name}</a>
<a class="button button-quiet" href="${checkoutHref({ planId: plan.id, period, kind: 'gift' })}">Gift it</a></div>`);
}

