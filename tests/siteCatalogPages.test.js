// The pricing, FAQ, docs and checkout pages read all their words from the text catalog
// (content/site/en/{pricing,faq,docs,plans,billing}.json): every page renders in English with
// every key present, and every key in those files is used by some page.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogs, translator, PLURAL_CATEGORIES, hasKey } from '../src/services/site/i18n.js';

const { pricingPage, planCard } = await import('../src/services/site/pages/pricing.js');
const { faqPage } = await import('../src/services/site/pages/faq.js');
const { docsPage, guidePage, GUIDES } = await import('../src/services/site/pages/docs.js');
const billing = await import('../src/services/site/billing.js');
const { PLANS } = await import('../src/config/site/plans.js');
const { CONSENT_TEXTS, PremiumError } = await import('../src/services/billing/premiumService.js');
const { readFileSync } = await import('node:fs');
/** Every PremiumError code premiumService.js throws (new PremiumError(…, status, 'code' …)). */
const PREMIUM_CODES = [...new Set([...readFileSync(new URL('../src/services/billing/premiumService.js', import.meta.url), 'utf8')
    .matchAll(/new PremiumError\([\s\S]*?, \d{3},\s*'([a-zA-Z]+)'/g)].map((m) => m[1]))];

const NAMESPACES = ['pricing', 'faq', 'docs', 'plans', 'billing'];
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

/** A page context whose t/ti/tb record every key they are asked for. */
function recordingCtx(used, extra = {}) {
    const en = translator('en');
    const wrap = (fn) => (key, params) => { used.add(key); return fn(key, params); };
    const forms = (key) => { for (const c of PLURAL_CATEGORIES) if (hasKey('en', `${key}.${c}`)) used.add(`${key}.${c}`); };
    return {
        ...extra, lang: 'en', t: wrap(en.t), ti: wrap(en.ti), tb: wrap(en.tb),
        tp: (key, count, params) => { forms(key); return en.tp(key, count, params); },
        tpi: (key, count, params) => { forms(key); return en.tpi(key, count, params); },
    };
}

function renderAll(used) {
    const legal = { operator: 'R. Example', email: 'hi@example.com' };
    const variants = [
        {},
        { supportInvite: 'https://discord.gg/abc', mainInvite: 'https://discord.gg/main' },
        { supportInvite: 'https://discord.gg/abc', publicSite: true, memberPortal: true, dashboardEnabled: true },
        { billing: true, memberPortal: true, legal: { ...legal, vatRegistered: false }, origin: 'https://site.example' },
        { billing: true, memberPortal: true, legal: { ...legal, vatRegistered: true } },
    ];
    const pages = [];
    const now = Date.now();
    const session = { id: 's', userId: '1', username: 'ana', csrf: 'c' };
    const consent = { texts: [CONSENT_TEXTS.startNow], at: iso(now - DAY), version: 'v' };
    const order = { id: 7, kind: 'personal', plan_id: 'pro', period: 'monthly', amount_cents: 499, test: true, created_at: iso(now - DAY), legal: { consent } };
    const giftOrder = { ...order, id: 8, kind: 'gift', test: false };
    const oldOrder = { ...order, id: 9, created_at: iso(now - 40 * DAY), legal: null };
    const withdrawal = { at: iso(now), name: 'Ana', usedDays: 1, totalDays: 30, refundCents: 480, refundStatus: 'test-not-paid', planEnded: true };
    const withdrawn = { ...order, id: 10, legal: { withdrawal } };
    const withdrawnPaid = { ...order, id: 11, test: false, legal: { withdrawal: { ...withdrawal, refundStatus: 'due', planEnded: false } } };
    const keys = ['unused', 'redeemed', 'revoked', 'expired'].map((s, i) => ({
        code: `MEWVO-AAAA-BBBB-CCC${i}`, plan_id: 'max', duration_days: 30, gift_to: i ? null : 'Bob', gift_message: 'hi', created_at: iso(now - DAY),
        expires_at: s === 'expired' ? iso(now - 1) : iso(now + 300 * DAY), redeemed_at: s === 'redeemed' ? iso(now) : null, revoked_at: s === 'revoked' ? iso(now) : null,
    }));
    const subs = [null, ...['key', 'purchase', 'owner', 'bonus'].map((source) => ({ plan_id: 'normal', expires_at: iso(now + 10 * DAY), source }))];
    for (const v of variants) {
        const ctx = recordingCtx(used, v);
        pages.push(pricingPage(ctx), faqPage(ctx), docsPage(ctx), ...GUIDES.map((g) => guidePage(ctx, g)), ...PLANS.map((p) => planCard(ctx, p, { compact: true })));
        pages.push(...PLANS.map((p) => billing.planButtons(p, ctx)));
        for (const reason of ['manage', 'buyPlan', 'buyAny', 'redeem', 'withdraw']) pages.push(billing.loginNeededPage(ctx, '/me', reason, { plan: 'Pro' }));
        for (const planId of ['normal', 'pro', 'max']) {
            for (const period of ['monthly', 'yearly']) {
                for (const kind of ['personal', 'gift']) {
                    for (const current of [null, { plan_id: planId, expires_at: iso(now + DAY) }, { plan_id: 'normal', expires_at: iso(now + DAY) }, { plan_id: 'max', expires_at: iso(now + DAY) }]) {
                        pages.push(billing.checkoutPage(ctx, { session, choice: { planId, period, kind }, current }));
                    }
                }
            }
        }
        for (const subscription of subs) pages.push(billing.billingPage(ctx, { session, account: { subscription, orders: [order, giftOrder, oldOrder, withdrawn, withdrawnPaid], gifts: keys }, flash: 'f', error: 'e' }));
        pages.push(billing.billingPage(ctx, { session, account: { subscription: null, orders: [], gifts: [] } }));
        for (const o of [order, giftOrder, oldOrder, withdrawn]) for (const key of [null, ...keys]) pages.push(billing.receiptPage(ctx, { session, order: o, key }));
        for (const peek of [null, { planId: 'pro', days: 30 }, { from: 'A', planId: 'pro', days: 30 }, { giftTo: 'B', planId: 'pro', days: 30, expiresAt: iso(now + DAY) }, { from: 'A', giftTo: 'B', planId: 'pro', days: 30, giftMessage: 'm' }]) {
            pages.push(billing.redeemPage(ctx, { session, peek }));
        }
        pages.push(billing.withdrawListPage(ctx, { session, orders: [order, oldOrder] }), billing.withdrawListPage(ctx, { session, orders: [] }));
        for (const o of [order, giftOrder]) pages.push(billing.withdrawConfirmPage(ctx, { session, order: o, quote: { usedDays: 1, totalDays: 30, refundCents: 480 } }));
        for (const o of [withdrawn, withdrawnPaid]) for (const dmDelivered of [null, false]) pages.push(billing.withdrawalAckPage(ctx, { session, order: o, dmDelivered }));
        billing.checkoutEffect({ plan_id: 'normal', expires_at: iso(now + DAY) }, { planId: 'max' }, now, ctx);
        billing.checkoutEffect({ plan_id: 'normal', expires_at: iso(now + 1.5 * DAY) }, { planId: 'normal' }, now, ctx);
        const params = { max: 100, date: '2026-01-01', count: 14, current: 'Max', until: '2026-01-01', plan: 'Pro', missing: ['start', 'startGift', 'terms', 'age'] };
        for (const code of PREMIUM_CODES) pages.push(billing.premiumErrorText(new PremiumError('English', 400, code, params), ctx));
    }
    return { pages, session, order, oldOrder, withdrawn };
}

async function runHandlers(used) {
    const sent = [];
    const ctx = () => recordingCtx(used, { billing: true, memberPortal: true });
    const { session, order, oldOrder, withdrawn } = renderAll(new Set());
    const core = (over = {}) => ({
        readSession: async () => (over.noSession ? null : { ...session }),
        sessions: { setFlash: async (id, value) => { sent.push(String(value)); } },
        settings: { publicOrigin: 'https://site.example' },
        ctx,
        send: (res, status, body) => { sent.push(String(body)); },
        store: {
            accountOf: async () => ({ subscription: null, orders: [order, oldOrder, withdrawn], gifts: [] }),
            redeem: async () => ({ key: { code: 'MEWVO-1', plan_id: 'pro', duration_days: 30 }, subscription: { expires_at: iso(Date.now() + DAY) }, next: over.converted ? { converted: { fromPlanId: 'normal' } } : null }),
        },
        redeemLimiter: { allow: () => !over.limited },
        clientIp: () => '1',
        after: async () => {},
        notify: async () => true,
    });
    const res = { set() {}, redirect() {} };
    const good = { origin: 'https://site.example' };
    const h = (over) => billing.createBillingHandlers(core(over));
    await h({ noSession: true }).checkout({ query: {} }, res);
    await h().checkoutPost({ headers: {}, body: {} }, res);
    await h().redeemPost({ headers: {}, body: {} }, res);
    await h().withdrawPost({ headers: {}, body: {}, params: { id: '7' } }, res);
    await h().receipt({ params: { id: '999' } }, res);
    await h({ limited: true }).redeemPost({ headers: good, body: { csrf: 'c' } }, res);
    await h().redeemPost({ headers: good, body: { csrf: 'c' } }, res);
    await h({ converted: true }).redeemPost({ headers: good, body: { csrf: 'c' } }, res);
    await h().withdrawForm({ params: { id: String(oldOrder.id) } }, res);
    await h().withdrawalAck({ params: { id: String(order.id) } }, res);
    return sent;
}

test('pricing, FAQ, docs and checkout render in English with every key present; every key is used', async () => {
    const used = new Set();
    const { pages } = renderAll(used);
    const sent = await runHandlers(used);
    for (const page of [...pages.map(String), ...sent]) {
        assert.ok(!/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(page.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')), 'no unfilled {param}');
        assert.ok(!page.includes('undefined'), 'no undefined text');
    }
    const en = loadCatalogs().get('en');
    const mine = [...en.keys()].filter((key) => NAMESPACES.includes(key.split('.')[0]));
    assert.ok(mine.length > 300, `catalog keys found (${mine.length})`);
    const unused = mine.filter((key) => !used.has(key));
    assert.deepEqual(unused, [], 'every catalog key in these namespaces is used by a page');
    for (const key of used) assert.ok(en.has(key), `${key} exists in English`);
});

test('consent checkboxes: the English labels are the CONSENT_TEXTS stored with each order', () => {
    const { t } = translator('en');
    assert.equal(t('billing.consent.startNow'), CONSENT_TEXTS.startNow);
    assert.equal(t('billing.consent.startNowGift'), CONSENT_TEXTS.startNowGift);
    assert.equal(t('billing.consent.age'), CONSENT_TEXTS.age);
    assert.equal(t('billing.consent.terms').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'), CONSENT_TEXTS.terms);
});

test('the Discord DM helpers stay English: vatLine and payLabel without a ctx', () => {
    assert.equal(billing.vatLine({ vatRegistered: true }), 'Price includes VAT.');
    assert.equal(billing.payLabel('€1.99'), 'Order and pay · €1.99');
    assert.equal(billing.testNotice(), billing.TEST_NOTICE);
});
