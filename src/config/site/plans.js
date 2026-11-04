// plans.js — the plans on the website's Pricing page (/pricing) and the Home teaser.
//
// DRAFT FOR THE OWNER TO EDIT. Nothing here is on sale: paid plans start when Mewvo opens
// to other servers, and every paid perk below is PLANNED (not built yet) unless the row says
// otherwise. Change names, prices, perks and the comparison freely; the pages read only this file
// and its text catalog.
//
// Words shown on the website live in the text catalog src/content/site/<lang>/plans.json:
// `plans.<planId>.summary`, `plans.<planId>.perks.<key>`, `plans.comparison.<group>.title`,
// `plans.comparison.<group>.rows.<key>`, `plans.comparison.values.<word>` and
// `plans.faq.<key>.q|a`. This file holds the structure (which perks, rows and questions, in what
// order), the plan names (product names, also used by the bot's DMs) and the numbers.
//
// Prices are whole euro cents. Yearly = 10 × monthly (two months free). The per-month figure
// shown for yearly billing is yearly / 12, rounded to the cent.
//
// `limits` are LIVE (since 2026-10-31): a server's tags, sticky messages, YouTube feeds,
// scheduled messages and custom automod rules are capped by the plan of the server's OWNER
// (services/billing/premiumEffects.js, planLimit). Free's numbers are the old fixed limits;
// custom automod rules are new (Free 0; services/automod/customRules.js).
//
// `planned: true` on a perk or a comparison row puts a "Planned" label next to it on the page.
// Free's values are what the bot does today (limits from the code: tags 100, sticky messages 10,
// YouTube feeds 20 per server; src/services/community/*Service.js).

// Display currencies. `prices` on each plan holds the monthly price per currency in cents; the
// numbers are the same for now (owner, 2026-11-03: EUR for everyone, USD only via a picker that
// is not built yet). `monthlyCents` stays the EUR price that the rest of the code reads.
export const CURRENCY = 'EUR';
export const CURRENCIES = Object.freeze({ EUR: '€', USD: '$' });
export const YEARLY_MONTHS_CHARGED = 10;

export const PLANS = [
    {
        id: 'free',
        name: 'Free',
        monthlyCents: 0,
        prices: { EUR: 0, USD: 0 },
        limits: { tags: 100, stickies: 10, feeds: 20, scheduled: 50, customRules: 0 },
        perks: [
            { key: 'enforcement' },
            { key: 'ladderAppeals' },
            { key: 'automod' },
            { key: 'ticketsDashboard' },
            { key: 'community' },
            { key: 'scheduled' },
        ],
    },
    {
        id: 'normal',
        name: 'Normal',
        monthlyCents: 199,
        prices: { EUR: 199, USD: 199 },
        limits: { tags: 250, stickies: 25, feeds: 40, scheduled: 100, customRules: 5 },
        perks: [
            { key: 'everythingFree' },
            { key: 'limits' },
            { key: 'scheduled' },
            { key: 'customRules' },
            { key: 'supporterRole' },
            { key: 'caseExport' },
        ],
    },
    {
        id: 'pro',
        name: 'Pro',
        monthlyCents: 499,
        prices: { EUR: 499, USD: 499 },
        limits: { tags: 500, stickies: 50, feeds: 75, scheduled: 200, customRules: 25 },
        featured: true,
        perks: [
            { key: 'everythingNormal' },
            { key: 'customRules' },
            { key: 'analytics' },
            { key: 'customBot' },
            { key: 'caseExport' },
        ],
    },
    {
        id: 'max',
        name: 'Max',
        monthlyCents: 999,
        prices: { EUR: 999, USD: 999 },
        limits: { tags: 1000, stickies: 100, feeds: 150, scheduled: 500, customRules: 100 },
        perks: [
            { key: 'everythingPro' },
            { key: 'oneDashboard', planned: true },
            { key: 'sharedCases', planned: true },
            { key: 'priorityHelp', planned: true },
            { key: 'highestLimits' },
        ],
    },
];

/** A comparison cell that is a word from the catalog (plans.comparison.values.<key>). */
const word = (key) => Object.freeze({ word: key });

/**
 * The comparison table: groups of rows, one value per plan id. `true` = included, `false` / '' =
 * not included, a number = shown as a number in the page's language, word('…') = a catalog word.
 * Group and row labels: plans.comparison.<group key>.title / .rows.<row key>.
 */
export const COMPARISON = [
    {
        key: 'moderation',
        rows: [
            { key: 'enforcement', values: { free: true, normal: true, pro: true, max: true } },
            { key: 'ladderAppeals', values: { free: true, normal: true, pro: true, max: true } },
            { key: 'caseHistory', values: { free: word('keptForGood'), normal: word('keptForGood'), pro: word('keptForGood'), max: word('keptForGood') } },
            { key: 'caseExport', values: { free: false, normal: word('last90Days'), pro: word('fullHistory'), max: word('fullHistory') } },
            { key: 'sharedCases', planned: true, values: { free: false, normal: false, pro: false, max: true } },
        ],
    },
    {
        key: 'automod',
        rows: [
            { key: 'builtIn', values: { free: 14, normal: 14, pro: 14, max: 14 } },
            { key: 'customRules', values: { free: false, normal: 5, pro: 25, max: 100 } },
        ],
    },
    {
        key: 'community',
        rows: [
            { key: 'tags', values: { free: 100, normal: 250, pro: 500, max: 1000 } },
            { key: 'stickies', values: { free: 10, normal: 25, pro: 50, max: 100 } },
            { key: 'feeds', values: { free: 20, normal: 40, pro: 75, max: 150 } },
            { key: 'scheduled', values: { free: 50, normal: 100, pro: 200, max: 500 } },
        ],
    },
    {
        key: 'dashboard',
        rows: [
            { key: 'auditLog', values: { free: true, normal: true, pro: true, max: true } },
            { key: 'analytics', values: { free: false, normal: false, pro: true, max: true } },
            { key: 'customBot', values: { free: false, normal: false, pro: true, max: true } },
            { key: 'servers', planned: true, values: { free: 1, normal: 1, pro: 1, max: word('upTo5') } },
            { key: 'supporterRole', values: { free: false, normal: true, pro: true, max: true } },
            { key: 'help', planned: true, values: { free: word('yes'), normal: word('yes'), pro: word('yes'), max: word('priority') } },
        ],
    },
];

/** The questions under the plans, in order: plans.faq.<key>.q / .a (plain text, escaped on the page). */
export const PRICING_FAQ = ['buyNow', 'currency', 'cancel', 'freeKeeps', 'backToFree'];


/** "€1.99" / "$1.99" from cents (always two decimals). Unknown currencies throw. */
export function formatPrice(cents, currency = CURRENCY) {
    const symbol = CURRENCIES[currency];
    if (!symbol) throw new Error(`Unknown currency: ${currency}`);
    return `${symbol}${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
}

/** "€1.99" from cents (always two decimals). Kept for existing callers. */
export function euros(cents) {
    return formatPrice(cents, 'EUR');
}

/** A plan's monthly price in cents for a display currency (falls back to EUR). */
export function monthlyCentsIn(plan, currency = CURRENCY) {
    return plan.prices?.[currency] ?? plan.monthlyCents;
}

/** Yearly price in cents: 10 × monthly. */
export function yearlyCents(plan) {
    return plan.monthlyCents * YEARLY_MONTHS_CHARGED;
}

/** What a year costs per month, in cents, rounded. */
export function yearlyPerMonthCents(plan) {
    return Math.round(yearlyCents(plan) / 12);
}
