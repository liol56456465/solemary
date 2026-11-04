// exchangeRates.js — the European Central Bank's daily reference rates, for the APPROXIMATE local
// prices on the pricing page (Polish złoty, Brazilian real). Nothing is ever charged in these
// currencies: payment stays EUR or USD (config/site/plans.js), and checkout, receipts and DMs never
// use a rate.
//
// Source: https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml (free, no key; rates are
// "1 EUR = x", published on working days around 16:00 CET). Fetched at startup (not awaited) and
// once a day from the cron in src/app.js; kept in memory. A failed or malformed fetch keeps the
// last good rates, and before the first success the bundled FALLBACK_RATES are used. Nothing here
// throws into page rendering: currentRates() always returns a usable table.

import { logger } from '../../utils/logger.js';

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
/** The currencies the site needs a rate for (besides EUR itself). */
export const NEEDED_CURRENCIES = Object.freeze(['USD', 'PLN', 'BRL']);
const FETCH_TIMEOUT_MS = 10_000;
const MAX_XML_BYTES = 64 * 1024;

/** ECB reference rates of 2026-11-04 (fetched 2026-11-05). Used only until the first successful fetch. */
export const FALLBACK_RATES = Object.freeze({
    date: '2026-11-04',
    source: 'fallback',
    rates: Object.freeze({ EUR: 1, USD: 1.1267, PLN: 4.399, BRL: 6.1579 }),
});

let current = FALLBACK_RATES;

/**
 * Parses the ECB daily XML: { date: 'YYYY-MM-DD', rates: { EUR: 1, USD: …, … } }. Throws when the
 * date or any NEEDED_CURRENCIES rate is missing or not a positive number. Pure.
 */
export function parseEcbXml(xml) {
    const text = String(xml ?? '').slice(0, MAX_XML_BYTES);
    const date = text.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
    if (!date) throw new Error('ECB rates: no date in the XML');
    const rates = { EUR: 1 };
    for (const [, code, value] of text.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9]+(?:\.[0-9]+)?)['"]\s*\/>/g)) {
        const rate = Number(value);
        if (Number.isFinite(rate) && rate > 0) rates[code] = rate;
    }
    const missing = NEEDED_CURRENCIES.filter((code) => !rates[code]);
    if (missing.length) throw new Error(`ECB rates: missing ${missing.join(', ')}`);
    return { date, rates: Object.freeze(rates) };
}

/** The rates in use now: { date, source: 'ecb' | 'fallback', rates }. Never throws. */
export function currentRates() {
    return current;
}

/**
 * Fetches and parses the ECB rates; on success they replace the current ones. On any failure the
 * current rates stay (logged as a warning). Returns the rates in use afterwards; never throws.
 */
export async function refreshRates({ fetchImpl = globalThis.fetch, url = ECB_DAILY_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/xml, text/xml' } });
        if (!res?.ok) throw new Error(`ECB rates: HTTP ${res?.status}`);
        const parsed = parseEcbXml(await res.text());
        current = Object.freeze({ ...parsed, source: 'ecb' });
        logger.info(`Exchange rates: ECB reference rates of ${parsed.date} loaded`);
    } catch (error) {
        logger.warn(`Exchange rates: keeping the ${current.source} rates of ${current.date} (${error?.message || error})`);
    }
    return current;
}

/** For tests: put the rates back to the bundled fallback. */
export function resetRatesForTest() {
    current = FALLBACK_RATES;
}

/**
 * An amount converted between two currencies with the given rates (1 EUR = rates[code]); null when
 * either rate is unknown. Pure. Amounts are in major units (9.99, not cents).
 */
export function convert(amount, from, to, rates = current.rates) {
    const a = rates?.[from];
    const b = rates?.[to];
    if (!a || !b) return null;
    return (Number(amount) || 0) / a * b;
}
