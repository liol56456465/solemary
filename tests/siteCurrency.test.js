// Local currency per language on the website (owner, 2026-11-05): what a buyer pays (EUR or USD,
// config/site/plans.js), the approximate złoty / real amounts from the ECB rates
// (services/site/exchangeRates.js; the fetch is always mocked here), and that checkout, receipts
// and DMs only ever show the real payment currency (no approximation outside the checkout summary).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DISPLAY_CURRENCY_BY_LANG, PAYMENT_CURRENCY_BY_LANG, displayCurrencyFor, paymentCurrencyFor,
} from '../src/config/site/plans.js';
import {
    FALLBACK_RATES, convert, currentRates, parseEcbXml, refreshRates, resetRatesForTest,
} from '../src/services/site/exchangeRates.js';
import { LANG_CODES, translator } from '../src/services/site/i18n.js';
import { pricingPage } from '../src/services/site/pages/pricing.js';
import { checkoutPage, createBillingHandlers, receiptPage } from '../src/services/site/billing.js';
import { PremiumError, priceCents, quote } from '../src/services/billing/premiumService.js';
import { orderConfirmationDm, withdrawalAckDm } from '../src/services/billing/premiumEffects.js';

const ecbXml = ({ date = '2026-11-04', usd = '1.1000', pln = '4.3000', brl = '6.0000' } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<Cube>
		<Cube time='${date}'>
			<Cube currency='USD' rate='${usd}'/>
			<Cube currency='JPY' rate='178.30'/>
			<Cube currency='PLN' rate='${pln}'/>
			<Cube currency='BRL' rate='${brl}'/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;
const fetchOk = (body) => async () => ({ ok: true, status: 200, text: async () => body });
/** Intl puts (narrow) no-break spaces in currency amounts; compare with plain spaces. */
const plain = (value) => String(value).replace(/[  ]/g, ' ');
const DAY = 86400000;

// 1 EUR = 1.1 USD = 4.3 PLN = 6 BRL: Max €9.99 ≈ 42.96 zł → "43 zł"; Max $9.99 ≈ R$ 54.49 → "R$ 54".
async function knownRates() {
    resetRatesForTest();
    await refreshRates({ fetchImpl: fetchOk(ecbXml()) });
}

test('ECB XML: date and rates parsed; malformed XML refused', () => {
    const parsed = parseEcbXml(ecbXml());
    assert.equal(parsed.date, '2026-11-04');
    assert.deepEqual(parsed.rates, { EUR: 1, USD: 1.1, JPY: 178.3, PLN: 4.3, BRL: 6 });
    assert.throws(() => parseEcbXml('<html>maintenance</html>'), /no date/);
    assert.throws(() => parseEcbXml(ecbXml({ pln: 'abc' })), /missing PLN/);
    assert.throws(() => parseEcbXml(ecbXml({ brl: '0' })), /missing BRL/);
    assert.throws(() => parseEcbXml(''), /no date/);
    assert.throws(() => parseEcbXml(null), /no date/);
});

test('ECB fetch: success replaces the rates; HTTP error, network error and bad XML keep the last good ones', async () => {
    resetRatesForTest();
    assert.equal(currentRates(), FALLBACK_RATES, 'the bundled table before any fetch');
    assert.match(FALLBACK_RATES.date, /^\d{4}-\d{2}-\d{2}$/, 'the fallback is dated');
    for (const code of ['USD', 'PLN', 'BRL']) assert.ok(FALLBACK_RATES.rates[code] > 0, code);

    // Fetch error before any success → the fallback stays, nothing throws.
    const failed = await refreshRates({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
    assert.equal(failed, FALLBACK_RATES);

    let asked = null;
    const ok = await refreshRates({ fetchImpl: async (url, opts) => { asked = { url, opts }; return fetchOk(ecbXml({ date: '2026-11-05', usd: '1.2' }))(); } });
    assert.equal(asked.url, 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    assert.ok(asked.opts.signal, 'the fetch has a timeout');
    assert.deepEqual([ok.source, ok.date, ok.rates.USD], ['ecb', '2026-11-05', 1.2]);

    for (const fetchImpl of [
        async () => ({ ok: false, status: 503, text: async () => '' }),
        async () => { throw new Error('timeout'); },
        fetchOk('<Cube time="2026-11-06"><Cube currency="USD" rate="1.3"/></Cube>'), // PLN/BRL missing
        fetchOk('not xml at all'),
    ]) {
        const kept = await refreshRates({ fetchImpl });
        assert.deepEqual([kept.source, kept.date, kept.rates.USD], ['ecb', '2026-11-05', 1.2], 'previous good rates kept');
    }
    assert.equal(convert(1, 'USD', 'BRL', { EUR: 1, USD: 2, BRL: 6 }), 3);
    assert.equal(convert(1, 'USD', 'RUB', { EUR: 1, USD: 2 }), null, 'unknown currency → null');
    resetRatesForTest();
});

test('language → currency: one map for all 8 languages; only pl and pt-BR show a local amount', () => {
    assert.deepEqual(PAYMENT_CURRENCY_BY_LANG, { en: 'USD', ru: 'USD', de: 'EUR', fr: 'EUR', it: 'EUR', pl: 'EUR', es: 'EUR', 'pt-BR': 'USD' });
    assert.deepEqual(Object.keys(PAYMENT_CURRENCY_BY_LANG).sort(), [...LANG_CODES].sort(), 'every site language has a payment currency');
    assert.deepEqual(DISPLAY_CURRENCY_BY_LANG, { pl: 'PLN', 'pt-BR': 'BRL' });
    assert.deepEqual(LANG_CODES.map((l) => [l, displayCurrencyFor(l)]), [
        ['en', 'USD'], ['ru', 'USD'], ['de', 'EUR'], ['fr', 'EUR'], ['it', 'EUR'], ['pl', 'PLN'], ['es', 'EUR'], ['pt-BR', 'BRL'],
    ]);
    assert.equal(paymentCurrencyFor('xx'), 'EUR', 'unknown language → EUR');
    assert.equal(priceCents('max', 'yearly', 'USD'), 9990);
    assert.equal(priceCents('max', 'monthly', 'GBP'), null);
    assert.deepEqual([quote({ planId: 'pro', period: 'monthly', kind: 'personal', currency: 'USD' })].map((q) => [q.currency, q.amountCents, q.amountText]), [['USD', 499, '$4.99']]);
    assert.equal(quote({ planId: 'pro', period: 'monthly', kind: 'personal' }).currency, 'EUR', 'default EUR');
    assert.throws(() => quote({ planId: 'pro', period: 'monthly', kind: 'personal', currency: 'PLN' }), (e) => e instanceof PremiumError && e.code === 'chooseCurrency', 'never charged in złoty');
});

const pageCtx = (lang, extra = {}) => ({ ...translator(lang), billing: true, memberPortal: true, legal: { operator: 'R. Example' }, ...extra });
const mainOf = (page) => plain(String(page)).slice(String(page).indexOf('<main'));

test('pricing in Polish: ≈ złoty big, the real euro charge next to it, ECB date + "you pay in EUR"', async () => {
    await knownRates();
    const main = mainOf(pricingPage(pageCtx('pl')));
    assert.ok(main.includes('<span class="plan-card-amount">≈ 43 zł</span>'), 'Max ≈ 43 zł');
    assert.ok(main.includes('<p class="plan-card-pay">Płacisz 9,99 €</p>'), 'the real charge right under it');
    assert.ok(main.includes('≈ 9 zł') && main.includes('Płacisz 1,99 €') && main.includes('≈ 21 zł') && main.includes('Płacisz 4,99 €'));
    assert.ok(main.includes('<span class="plan-card-amount">0 zł</span>'), 'Free: exact, no ≈');
    assert.equal((main.match(/≈ /g) || []).length, (main.match(/Płacisz \d/g) || []).length, 'never a local amount without the real one');
    assert.ok(main.includes('99,90 € rocznie') || main.includes('99,90 €'), 'yearly line in the real currency');
    assert.ok(main.includes('Kwoty w złotych są przybliżone, według kursu Europejskiego Banku Centralnego z 4 listopada 2026. Płacisz w EUR.'));
    assert.ok(main.includes('cur=EUR'), 'Buy links carry the currency shown');
    resetRatesForTest();
});

test('pricing in Brazilian Portuguese: ≈ R$ with the US$ charge; English unchanged apart from USD; German in euros', async () => {
    await knownRates();
    const pt = mainOf(pricingPage(pageCtx('pt-BR')));
    assert.ok(pt.includes('<span class="plan-card-amount">≈ R$ 54</span>'), 'Max ≈ R$ 54');
    assert.ok(pt.includes('<p class="plan-card-pay">Você paga US$ 9,99</p>'));
    assert.ok(pt.includes('Você paga em USD.') && pt.includes('cur=USD'));

    const en = mainOf(pricingPage(pageCtx('en')));
    assert.ok(en.includes('<span class="plan-card-amount">$9.99</span>') && en.includes('$99.90 a year'));
    assert.ok(!en.includes('≈') && !en.includes('plan-card-pay') && !en.includes('€'), 'no approximation, no euros');
    assert.ok(en.includes('Prices in US dollars.'));

    const de = mainOf(pricingPage(pageCtx('de')));
    assert.ok(de.includes('<span class="plan-card-amount">9,99 €</span>') && de.includes('Preise in Euro.') && !de.includes('≈'));
    const ru = mainOf(pricingPage(pageCtx('ru')));
    assert.ok(ru.includes('9,99 $') && ru.includes('Цены в долларах США.') && !ru.includes('₽') && !ru.includes('≈'), 'Russian: USD, no RUB');
    resetRatesForTest();
});

test('checkout: the real total in the payment currency; "approx." only in the summary total, never on the button or seller box', async () => {
    await knownRates();
    const session = { id: 's', userId: '1', username: 'ana', csrf: 'c' };
    const choice = { planId: 'max', period: 'monthly', kind: 'personal' };
    const pl = plain(checkoutPage(pageCtx('pl'), { session, choice }));
    assert.ok(pl.includes('<dd>9,99 € <small class="summary-approx">(ok. 43 zł)</small></dd>'), 'summary total + approx in brackets');
    assert.equal((pl.match(/\d zł/g) || []).length, 1, 'a złoty amount exactly once: the summary total');
    assert.ok(pl.includes('Zamawiam i płacę · 9,99 €'), 'pay button: real amount only');
    assert.ok(pl.includes('<input type="hidden" name="cur" value="EUR">'));

    const pt = plain(checkoutPage(pageCtx('pt-BR'), { session, choice }));
    assert.ok(pt.includes('US$ 9,99 <small class="summary-approx">(aprox. R$ 54)</small>'));
    assert.equal((pt.match(/R\$/g) || []).length, 1);

    // A link from the Polish pricing page opened in English keeps the euros it showed.
    const en = plain(checkoutPage(pageCtx('en'), { session, choice: { ...choice, currency: 'EUR' } }));
    assert.ok(en.includes('Order and pay · €9.99') && en.includes('name="cur" value="EUR"') && !en.includes('approx.'));
    assert.ok(plain(checkoutPage(pageCtx('en'), { session, choice })).includes('Order and pay · $9.99'));
    resetRatesForTest();
});

test('checkout POST records the payment currency; receipts and DMs show it without any approximation', async () => {
    await knownRates();
    const purchases = [];
    const dms = [];
    let n = 0;
    const handlers = (lang) => createBillingHandlers({
        readSession: async () => ({ id: 's', userId: '200000000000000002', username: 'ana', csrf: 'c' }),
        sessions: {}, settings: { publicOrigin: 'https://site.example' }, ctx: () => pageCtx(lang),
        send: () => {}, redeemLimiter: { allow: () => true }, clientIp: () => '1',
        store: {
            purchase: async (args) => {
                purchases.push(args);
                n += 1;
                return { order: { id: n, kind: 'personal', plan_id: args.planId, period: args.period, amount_cents: priceCents(args.planId, args.period, args.currency), currency: args.currency, test: true, created_at: new Date() }, subscription: null, key: null };
            },
        },
        after: async () => {}, notify: async (_id, content) => { dms.push(content); return true; },
    });
    const res = { redirect() {}, set() {} };
    const post = (lang, body) => handlers(lang).checkoutPost({
        headers: { origin: 'https://site.example' },
        body: { csrf: 'c', plan: 'pro', period: 'monthly', for: 'personal', consent_start: 'yes', consent_terms: 'yes', consent_age: 'yes', ...body },
    }, res);
    await post('pl', { lang: 'pl' });
    await post('en', { lang: 'pt-BR' });
    await post('en', { lang: 'pl', cur: 'USD' });
    await post('de', { lang: 'de', cur: 'PLN' }); // not a payment currency → the language's
    assert.deepEqual(purchases.map((p) => p.currency), ['EUR', 'USD', 'USD', 'EUR']);
    assert.ok(dms[0].includes('Total: €4.99.') && dms[1].includes('Total: $4.99.'));
    for (const dm of dms) assert.ok(!/zł|R\$|≈|approx/.test(dm), 'no approximation in a DM');

    const session = { username: 'ana' };
    const order = { id: 7, kind: 'personal', plan_id: 'pro', period: 'monthly', amount_cents: 499, test: false, created_at: new Date(Date.now() - DAY) };
    const plEur = plain(receiptPage(pageCtx('pl'), { session, order: { ...order, currency: 'EUR' } }));
    assert.ok(plEur.includes('<dd>4,99 €</dd>') && !/\d zł|≈|\(ok\. /.test(plEur.slice(plEur.indexOf('<main'))), 'Polish receipt: euros only');
    const ptUsd = plain(receiptPage(pageCtx('pt-BR'), { session, order: { ...order, currency: 'USD' } }));
    assert.ok(ptUsd.includes('<dd>US$ 4,99</dd>') && !ptUsd.includes('R$ '), 'Brazilian receipt: US$ only');
    assert.ok(plain(receiptPage(pageCtx('en'), { session, order })).includes('<dd>€4.99</dd>'), 'an order without a currency is EUR');
    assert.ok(plain(receiptPage(pageCtx('en'), { session, order: { ...order, currency: 'USD' } })).includes('<dd>$4.99</dd>'));

    const ack = withdrawalAckDm({ order: { ...order, currency: 'USD' }, withdrawal: { at: new Date().toISOString(), name: 'A', usedDays: 1, totalDays: 30, refundCents: 482, refundStatus: 'due' } });
    assert.ok(ack.includes(', $4.99') && ack.includes('Refund due: $4.82'));
    assert.ok(orderConfirmationDm({ order: { ...order, currency: 'USD' } }).includes('Total: $4.99.'));
    resetRatesForTest();
});
