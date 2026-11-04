// plans.js — the plans on the website's Pricing page (/pricing) and the Home teaser.
//
// DRAFT FOR THE OWNER TO EDIT. Nothing here is on sale: paid plans start when Mewvo opens
// to other servers, and every paid perk below is PLANNED (not built yet) unless the row says
// otherwise. Change names, prices, perks and the comparison freely; the pages read only this file.
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
        summary: 'Everything Mewvo does today, for one server.',
        perks: [
            { text: 'Enforcement panel, case codes and DMs' },
            { text: 'Warning ladder and appeals' },
            { text: 'Automod with 14 rules and review cards' },
            { text: 'Tickets, modmail and the web dashboard' },
            { text: 'Leveling, tags, suggestions, starboard, feeds' },
            { text: 'Up to 50 scheduled messages' },
        ],
    },
    {
        id: 'normal',
        name: 'Normal',
        monthlyCents: 199,
        prices: { EUR: 199, USD: 199 },
        limits: { tags: 250, stickies: 25, feeds: 40, scheduled: 100, customRules: 5 },
        summary: 'More room for busy community servers.',
        perks: [
            { text: 'Everything in Free' },
            { text: '250 tags, 25 sticky messages, 40 YouTube feeds' },
            { text: '100 scheduled messages' },
            { text: '5 custom automod rules' },
            { text: 'Supporter role in the Mewvo server' },
            { text: 'Case export (CSV), last 90 days' },
        ],
    },
    {
        id: 'pro',
        name: 'Pro',
        monthlyCents: 499,
        prices: { EUR: 499, USD: 499 },
        limits: { tags: 500, stickies: 50, feeds: 75, scheduled: 200, customRules: 25 },
        summary: 'For servers with a real staff team.',
        featured: true,
        perks: [
            { text: 'Everything in Normal, with higher limits' },
            { text: '25 custom automod rules' },
            { text: 'Staff and automod analytics on the dashboard' },
            { text: 'Custom bot name and avatar in your server' },
            { text: 'Full case history export' },
        ],
    },
    {
        id: 'max',
        name: 'Max',
        monthlyCents: 999,
        prices: { EUR: 999, USD: 999 },
        limits: { tags: 1000, stickies: 100, feeds: 150, scheduled: 500, customRules: 100 },
        summary: 'For people who run several servers.',
        perks: [
            { text: 'Everything in Pro' },
            { text: 'One dashboard for up to 5 servers', planned: true },
            { text: 'Shared case history across your servers', planned: true },
            { text: 'Priority help in the support server', planned: true },
            { text: 'Highest limits on everything' },
        ],
    },
];

/**
 * The comparison table: groups of rows, one value per plan id. `true` = included (a check),
 * `false` / '' = not included (a dash), text = shown as is.
 */
export const COMPARISON = [
    {
        group: 'Moderation',
        rows: [
            { label: 'Enforcement panel, case codes, DMs', values: { free: true, normal: true, pro: true, max: true } },
            { label: 'Warning ladder and appeals', values: { free: true, normal: true, pro: true, max: true } },
            { label: 'Case history', values: { free: 'Kept for good', normal: 'Kept for good', pro: 'Kept for good', max: 'Kept for good' } },
            { label: 'Case export (CSV)', values: { free: false, normal: 'Last 90 days', pro: 'Full history', max: 'Full history' } },
            { label: 'Shared cases across servers', planned: true, values: { free: false, normal: false, pro: false, max: true } },
        ],
    },
    {
        group: 'Automod',
        rows: [
            { label: 'Built-in rules with review cards', values: { free: '14', normal: '14', pro: '14', max: '14' } },
            { label: 'Custom automod rules', values: { free: false, normal: '5', pro: '25', max: '100' } },
        ],
    },
    {
        group: 'Community',
        rows: [
            { label: 'Tags', values: { free: '100', normal: '250', pro: '500', max: '1,000' } },
            { label: 'Sticky messages', values: { free: '10', normal: '25', pro: '50', max: '100' } },
            { label: 'YouTube feeds', values: { free: '20', normal: '40', pro: '75', max: '150' } },
            { label: 'Scheduled messages', values: { free: '50', normal: '100', pro: '200', max: '500' } },
        ],
    },
    {
        group: 'Dashboard and support',
        rows: [
            { label: 'Web dashboard with audit log', values: { free: true, normal: true, pro: true, max: true } },
            { label: 'Staff and automod analytics', values: { free: false, normal: false, pro: true, max: true } },
            { label: 'Custom bot name and avatar', values: { free: false, normal: false, pro: true, max: true } },
            { label: 'Servers in one dashboard', planned: true, values: { free: '1', normal: '1', pro: '1', max: 'Up to 5' } },
            { label: 'Supporter role in the Mewvo server', values: { free: false, normal: true, pro: true, max: true } },
            { label: 'Help in the support server', planned: true, values: { free: 'Yes', normal: 'Yes', pro: 'Yes', max: 'Priority' } },
        ],
    },
];

/** Short answers under the plans. Plain text (escaped on the page). */
export const PRICING_FAQ = [
    { q: 'Can I buy a plan now?', a: 'No. Mewvo runs only on its own server for now. Paid plans start when it opens to other servers; until then nothing can be bought and nobody is charged.' },
    { q: 'What currency are prices in?', a: 'Euros. The prices on this page are the planned monthly and yearly prices.' },
    { q: 'Can I cancel or get my money back?', a: 'Plans don’t renew by themselves, so there is nothing to cancel: a plan runs for the period you chose and then falls back to Free. Once real payments start, you can withdraw from a purchase within 14 days. If you asked for the plan to start right away, you get your money back minus the days you already used. Details are on the Withdrawal page.' },
    { q: 'What does Free keep?', a: 'Everything Mewvo does today: enforcement, the warning ladder, appeals, automod, tickets, modmail, the dashboard and the community tools. Your case history is never deleted when a plan ends.' },
    { q: 'What happens to extra tags or feeds if I go back to Free?', a: 'The plan is that nothing is deleted: items over the Free limit stop working until you remove some or upgrade again. This may still change before launch.' },
];

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
