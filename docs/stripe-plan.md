# Stripe payments — plan (2026-11-10, WAITING FOR OWNER OK, no code yet)

Replaces the TEST CHECKOUT premium flow with real Stripe payments. Read-only plan (Plan agent; Stripe API facts
for 2025-03-31+ checked via context7). file:line as of 8cb64007. [I#] = unverified.

## What exists (verified)
- `purchase()` writes order + consent (KV `premium_order:<id>`) + key/subscription in one transaction
  (premiumService.js:389-420); withdrawal is modelled (refundDue / withdrawalQuote / endAfterWithdrawal :272-330,
  withdraw() ~:612); consent boxes incl. 14-day + age (:66-75). Plans normal/pro/max, EUR or USD by page language
  (plans.js:31-37). Tables premium_subscriptions / premium_orders / premium_keys (schema.js:706-756). Schema v14.
- No global body parser (routes set their own, memberPortal.js:810-822). Member-portal CSP `form-action 'self'
  https://discord.com` (memberPortal.js:117-118) would silently block a redirect to checkout.stripe.com.
- No Stripe SDK installed; gitleaks uses its default rules (no .gitleaks.toml).

## Design
- **Products/prices:** owner creates them in the Stripe dashboard (3 products, 6 recurring prices monthly/yearly,
  EUR with a USD currency option); ids in env `STRIPE_PRICE_{NORMAL,PRO,MAX}_{MONTHLY,YEARLY}`. Startup reads the
  6 prices once; an amount different from plans.js or an inactive price switches checkout off (logged, no secrets).
- **Checkout Sessions:** subscriptions `mode=subscription`; gifts `mode=payment` with the server-side amount. The
  client sends only plan/period/kind (`checkoutChoice`, billing.js:105). `client_reference_id` = Discord id +
  metadata. Customer per Discord account (`stripe_customer_id`), created under the existing row lock with an
  idempotency key. Checkout collects the email (Discord gives none). Consent boxes checked BEFORE the redirect and
  saved in `premium_checkouts`; gift text never goes to Stripe.
- **Success page grants nothing** ("payment processing"). Only webhooks grant.
- **Customer Portal** (owner configures): cancel at period end, card, invoices, plan switch; `POST /me/billing/portal`.
- **Webhook `POST /stripe/webhook`:** raw body + `stripe.webhooks.constructEvent` (signature, 300 s tolerance);
  own rate limit; livemode must match `STRIPE_MODE`; logs only event id/type. Idempotent: `stripe_events` insert
  in the same transaction as the effect (duplicate → 200; error → rollback + 500 so Stripe retries).
- **Events:** checkout.session.completed / async_payment_succeeded (gift → key; subscription → link), invoice.paid
  (order row; `expires_at` = item `current_period_end`), invoice.payment_failed (past_due, grace 7 days + DM with
  portal link), customer.subscription.updated / deleted, charge.refunded (full refund ends that order's time and
  revokes an unused gift key; partial recorded), charge.dispute.created (end premium, cancel sub, revoke keys,
  flag for the owner). Every effect: audit row + DM.
- **Upgrades:** Stripe proration for card subscriptions; the price-ratio rule stays for keys / owner grants.
- **Keys while a Stripe sub is active:** same plan extends (trial_end) [I2]; other plan refused.
- **Withdrawal:** `withdraw()` also creates the Stripe refund (idempotency key `wd-<orderId>`); only the first
  order of a subscription [I3, legal check].

## Security
- `STRIPE_SECRET_KEY` = a restricted `rk_` key [I4]; `STRIPE_WEBHOOK_SECRET`. Only in Replit Secrets and
  ~/.config/mewvo; never in the repo, logs or error texts. `.env.example` placeholders only.
- `STRIPE_MODE=test|live`; startup refuses a key whose prefix doesn't match; webhooks check livemode.
- `PREMIUM_PAYMENTS=stripe` replaces `PREMIUM_TEST_CHECKOUT`; both together refused in production.
- `.gitleaks.toml` extending the defaults with a `whsec_` rule [I5]. Checkout creation 5 per 10 min per user.
  SDK `apiVersion` pinned. CSP: add checkout.stripe.com + billing.stripe.com to form-action on the portal only.

## Data — schema v15 (additive; /schema-change)
- premium_subscriptions + stripe_customer_id, stripe_subscription_id, stripe_status, stripe_price_id,
  cancel_at_period_end, grace_until.
- premium_orders + stripe_checkout_id, stripe_invoice_id, stripe_payment_intent_id, refunded_cents, status;
  unique partial indexes on invoice / checkout ids.
- New premium_checkouts (consent, gift text, session id; pruned after 7 days); new stripe_events.

## Files / tests / rollout
- New: services/billing/stripeClient.js, stripeWebhook.js, scripts/stripe-webhook-preview.js (webhook + local DB,
  no Discord login), docs/stripe-setup.md (owner runbook). Change: premiumService.js, site/billing.js,
  memberPortal.js, app.js, premiumEffects.js, pricing + plans copy (8 languages), legal.js, withdrawal.js,
  schema.js, .env.example. Dependency `stripe` pinned exactly [I9].
- Tests: signatures via `generateTestHeaderString` + fake secret (good / bad / stale / wrong livemode), duplicate
  event once, every event type, success URL grants nothing, refunds / disputes, gift → key, client amount ignored,
  withdrawal refund idempotent, DB error → 500 + rollback.
- Rollout: 1 test keys on Replit (migrate v15, owner OK) → 2 owner test purchases with test cards (4242 success,
  4000 0000 0000 0341 failed renewal, 4000 0025 0000 3155 3-D Secure, a dispute card, portal cancel) → 3 legal
  pages done → 4 live keys + live webhook, one real purchase then refund → 5 move the webhook when PUBLIC_URL
  moves to mewvo.com.
- Agents: T1 schema v15 + store + DB tests → T2 Stripe client + webhook (parallel with T3) / T3 checkout, portal,
  success, CSP, withdrawal refund, DMs, texts / T4 legal + pricing copy, env placeholders, .gitleaks.toml, runbook.

## Owner decisions (D = recommended)
1. Merchant: individual activity (individuali veikla) or a company (D: individual activity for now) [I6].
2. Stripe Tax / OSS (D: on, prices tax-inclusive) [I7 — check with an accountant].
3. Currency (D: EUR + USD as now; simpler alternative EUR only).
4. Prices created in the Stripe dashboard, ids in env (D: yes).
5. Upgrades by Stripe proration (D: yes; keys keep the ratio rule).
6. Failed payment grace (D: 7 days + DM).
7. Withdrawal only on a subscription's first order (D: yes, after a lawyer check).
8. A dispute ends premium at once (D: yes).
9. Instant payment methods only (D: card, Apple Pay, Google Pay).
10. Statement descriptor (D: "MEWVO").
11. A key while a subscription is active (D: same plan extends, other plan refused).
12. Stripe-hosted invoices are the legal document (D: yes).
Also needed from the owner before live: Stripe account (LT) verified; LEGAL_* contact details; legal review of
Terms/Privacy (Stripe as processor, auto-renewal, cancellation, refunds); minors [I8].
