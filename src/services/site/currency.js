// currency.js — money on the website pages, in the page's language.
//
//   money(lang, cents, currency)       a real price: "$4.99" (English, as before) / "4,99 €" / "US$ 4,99"
//   approxLocal(lang, cents, currency) the approximate local amount for pl / pt-BR ("≈ 22 zł"), else null
//
// The payment currency per language and the per-currency prices live in config/site/plans.js.
// Approximate amounts use the ECB rates (exchangeRates.js), are rounded to whole units and are only
// ever shown NEXT TO the real price, never instead of it (and never on receipts or in DMs).

import { DISPLAY_CURRENCY_BY_LANG, formatPrice } from '../../config/site/plans.js';
import { DEFAULT_LANG, isLanguage } from './i18n.js';
import { convert, currentRates } from './exchangeRates.js';

const FORMATS = new Map();
function numberFormat(lang, currency, digits) {
    const id = `${lang}|${currency}|${digits}`;
    if (!FORMATS.has(id)) {
        FORMATS.set(id, new Intl.NumberFormat(lang, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }));
    }
    return FORMATS.get(id);
}

/** A real price from cents in the page's language (English keeps formatPrice: "€1.99", "$1.99"). */
export function money(lang, cents, currency) {
    if (!isLanguage(lang) || lang === DEFAULT_LANG) return formatPrice(cents, currency);
    return numberFormat(lang, currency, 2).format(Math.round(Number(cents) || 0) / 100);
}

/** A whole-unit amount ("0 zł", "R$ 55", "$0") in the page's language. */
export function wholeMoney(lang, amount, currency) {
    const code = isLanguage(lang) && lang !== DEFAULT_LANG ? lang : 'en-US';
    return numberFormat(code, currency, 0).format(Math.round(Number(amount) || 0));
}

/**
 * The approximate local amount for a real price, when the language shows a local currency
 * (DISPLAY_CURRENCY_BY_LANG: pl, pt-BR only; English never shows one, even for a euro checkout):
 * { currency: 'PLN', text: '44 zł', date } (no "≈": the caller adds it), else null. Never throws.
 */
export function approxLocal(lang, cents, paymentCurrency) {
    const local = DISPLAY_CURRENCY_BY_LANG[lang];
    if (!local || local === paymentCurrency) return null;
    try {
        const { rates, date } = currentRates();
        const amount = convert((Number(cents) || 0) / 100, paymentCurrency, local, rates);
        if (amount == null || !Number.isFinite(amount)) return null;
        return { currency: local, text: wholeMoney(lang, amount, local), date };
    } catch {
        return null;
    }
}
