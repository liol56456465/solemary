// plans.js — the plans on the website's Pricing page (/pricing) and the Home teaser.
//
// DRAFT FOR THE OWNER TO EDIT. Nothing here is on sale: paid plans start when Meowist opens
// to other servers, and every paid perk below is PLANNED (not built yet) unless the row says
// otherwise. Change names, prices, perks and the comparison freely; the pages read only this file.
//
// Prices are whole euro cents. Yearly = 10 × monthly (two months free). The per-month figure
// shown for yearly billing is yearly / 12, rounded to the cent.
//
// `planned: true` on a perk or a comparison row puts a "Planned" label next to it on the page.
// Free's values are what the bot does today (limits from the code: tags 100, sticky messages 10,
// YouTube feeds 20 per server; src/services/community/*Service.js).

export const CURRENCY = 'EUR';
export const YEARLY_MONTHS_CHARGED = 10;

export const PLANS = [
    {
        id: 'free',
        name: 'Free',
        monthlyCents: 0,
        summary: 'Everything Meowist does today, for one server.',
        perks: [
            { text: 'Enforcement panel, case codes and DMs' },
            { text: 'Warning ladder and appeals' },
            { text: 'Automod with 14 rules and review cards' },
            { text: 'Tickets, modmail and the web dashboard' },
            { text: 'Leveling, tags, suggestions, starboard, feeds' },
        ],
    },
    {
        id: 'normal',
        name: 'Normal',
        monthlyCents: 199,
        summary: 'More room for busy community servers.',
        perks: [
            { text: 'Everything in Free' },
            { text: '250 tags, 25 sticky messages, 40 YouTube feeds', planned: true },
            { text: '10 scheduled messages', planned: true },
            { text: 'Case export (CSV), last 90 days', planned: true },
        ],
    },
    {
        id: 'pro',
        name: 'Pro',
        monthlyCents: 499,
        summary: 'For servers with a real staff team.',
        featured: true,
        perks: [
            { text: 'Everything in Normal' },
            { text: '25 custom automod rules', planned: true },
            { text: 'Staff and automod analytics on the dashboard', planned: true },
            { text: 'Custom bot name and avatar in your server', planned: true },
            { text: 'Full case history export', planned: true },
        ],
    },
    {
        id: 'max',
        name: 'Max',
        monthlyCents: 999,
        summary: 'For people who run several servers.',
        perks: [
            { text: 'Everything in Pro' },
            { text: 'One dashboard for up to 5 servers', planned: true },
            { text: 'Shared case history across your servers', planned: true },
            { text: 'Priority help in the support server', planned: true },
            { text: 'Highest limits on everything', planned: true },
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
            { label: 'Case export (CSV)', planned: true, values: { free: false, normal: 'Last 90 days', pro: 'Full history', max: 'Full history' } },
            { label: 'Shared cases across servers', planned: true, values: { free: false, normal: false, pro: false, max: true } },
        ],
    },
    {
        group: 'Automod',
        rows: [
            { label: 'Built-in rules with review cards', values: { free: '14', normal: '14', pro: '14', max: '14' } },
            { label: 'Custom automod rules', planned: true, values: { free: false, normal: '5', pro: '25', max: '100' } },
        ],
    },
    {
        group: 'Community',
        rows: [
            { label: 'Tags', planned: true, values: { free: '100', normal: '250', pro: '500', max: '1,000' } },
            { label: 'Sticky messages', planned: true, values: { free: '10', normal: '25', pro: '50', max: '100' } },
            { label: 'YouTube feeds', planned: true, values: { free: '20', normal: '40', pro: '75', max: '150' } },
            { label: 'Scheduled messages', planned: true, values: { free: false, normal: '10', pro: '50', max: '200' } },
        ],
    },
    {
        group: 'Dashboard and support',
        rows: [
            { label: 'Web dashboard with audit log', values: { free: true, normal: true, pro: true, max: true } },
            { label: 'Staff and automod analytics', planned: true, values: { free: false, normal: false, pro: true, max: true } },
            { label: 'Custom bot name and avatar', planned: true, values: { free: false, normal: false, pro: true, max: true } },
            { label: 'Servers in one dashboard', planned: true, values: { free: '1', normal: '1', pro: '1', max: 'Up to 5' } },
            { label: 'Help in the support server', planned: true, values: { free: 'Yes', normal: 'Yes', pro: 'Yes', max: 'Priority' } },
        ],
    },
];

/** Short answers under the plans. Plain text (escaped on the page). */
export const PRICING_FAQ = [
    { q: 'Can I buy a plan now?', a: 'No. Meowist runs only on its own server for now. Paid plans start when it opens to other servers; until then nothing can be bought and nobody is charged.' },
    { q: 'What currency are prices in?', a: 'Euros. The prices on this page are the planned monthly and yearly prices.' },
    { q: 'Can I cancel?', a: 'Yes, any time. A paid plan is meant to run until the end of the period you paid for and then fall back to Free.' },
    { q: 'What does Free keep?', a: 'Everything Meowist does today: enforcement, the warning ladder, appeals, automod, tickets, modmail, the dashboard and the community tools. Your case history is never deleted when a plan ends.' },
    { q: 'What happens to extra tags or feeds if I go back to Free?', a: 'The plan is that nothing is deleted: items over the Free limit stop working until you remove some or upgrade again. This may still change before launch.' },
];

/** "€1.99" from cents (always two decimals). */
export function euros(cents) {
    return `€${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
}

/** Yearly price in cents: 10 × monthly. */
export function yearlyCents(plan) {
    return plan.monthlyCents * YEARLY_MONTHS_CHARGED;
}

/** What a year costs per month, in cents, rounded. */
export function yearlyPerMonthCents(plan) {
    return Math.round(yearlyCents(plan) / 12);
}
