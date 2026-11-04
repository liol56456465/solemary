// withdrawal.js — /withdrawal: the right of withdrawal for plans bought on the website
// (Directive 2011/83/EU: Art. 9–16, the model withdrawal form of Annex I(B), and the online
// withdrawal function of Art. 11a added by Directive (EU) 2023/2673, applicable since 19 June 2026).
//
// While the test checkout is on (ctx.billing) the page carries the "Withdraw from contract here"
// button to /me/withdraw (log in → choose the order → "Confirm withdrawal" → acknowledgement,
// site/billing.js). Without it, and always as an alternative, it explains how to withdraw by
// email (LEGAL_EMAIL) with the model form. Not legal advice: the owner has it checked.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';
import { WITHDRAWAL_DAYS } from '../../billing/premiumService.js';

/** The model withdrawal form (CRD Annex I(B)), adapted to a Mewvo plan. Plain text lines. */
export function modelWithdrawalForm(legal = {}) {
    const to = [legal.operator || 'Mewvo (the operator named on /legal)', legal.email || null].filter(Boolean).join(', ');
    return [
        '(Complete and return this form only if you wish to withdraw from the contract.)',
        `To: ${to}`,
        'I hereby give notice that I withdraw from my contract for the provision of the following service: Mewvo plan (name the plan and the order number, e.g. "Pro, monthly, order #123").',
        'Ordered on: (date)',
        'Name of consumer:',
        'Discord username or user ID used for the order:',
        'Address of consumer (optional):',
        'Date:',
    ];
}

export function withdrawalPage(ctx) {
    const legal = ctx.legal || {};
    const email = legal.email;
    return layout(ctx, {
        title: 'Right of withdrawal', active: 'withdrawal', path: '/withdrawal',
        description: `How to withdraw from a Mewvo plan within ${WITHDRAWAL_DAYS} days, the model withdrawal form, and the online withdrawal button.`,
        body: html`<div class="wrap page prose"><h1>Right of withdrawal</h1>
<p class="lead">If you live in the EU, you can withdraw from a plan you bought on this website within ${WITHDRAWAL_DAYS} days, without giving any reason.</p>
${ctx.billing ? html`<p class="withdraw-cta"><a class="button" href="/me/withdraw">Withdraw from contract here</a></p>
<p class="note">Log in with the Discord account you bought with, choose the order and press <strong>Confirm withdrawal</strong>. You get an acknowledgement with the date and time right away, on the page and as a Discord DM.</p>` : ''}
<h2>The period</h2>
<p>The withdrawal period ends at the end of the ${WITHDRAWAL_DAYS}th day after the day you placed the order (midnight UTC). To meet the deadline, it is enough that you send your withdrawal before the period ends.</p>
<h2>If your plan already started</h2>
<p>At checkout you ask for your plan to start right away. If you then withdraw, you pay only for the days already used: the refund is the price × the unused days ÷ the days in the plan. Example: 6 days into a 30-day plan for €4.99, the refund is €4.99 × 24 ÷ 30 = €3.99. A part day is not charged.</p>
<p>The unused days are taken off your plan when the withdrawal is received. If nothing else was added to your plan, the plan ends.</p>
<h2>Gift keys</h2>
<p>For a gift key, the right of withdrawal belongs to you as the buyer, not to the person who gets the key. If the key has not been redeemed, it is cancelled and you get the full price back. If it was redeemed, the days are counted from the redemption.</p>
<h2>Refunds</h2>
<p>We pay the refund without undue delay and at the latest within 14 days of receiving your withdrawal, using the same payment method you used, at no cost to you. While Mewvo is in test mode no money is taken, so there is nothing to pay back.</p>
<h2>How to withdraw</h2>
<ul>
${ctx.billing ? html`<li><strong>Online:</strong> <a href="/me/withdraw">Withdraw from contract here</a> (log in first).</li>` : ''}
<li><strong>By email:</strong> ${email ? html`send a clear statement (for example the form below) to <a href="mailto:${email}">${email}</a>.` : html`send a clear statement (for example the form below) to the contact address on the <a href="/legal">legal page</a>.`} Include the order number and the Discord account you bought with. We confirm receipt.</li>
</ul>
<p>You do not have to use the form below; any clear statement works.</p>
<h2 id="model-form">Model withdrawal form</h2>
<div class="key-box model-form">${modelWithdrawalForm(legal).map((line) => html`<p>${line}</p>`)}</div>
<p class="note">More in the <a href="/terms">Terms and Conditions</a>. Who sells: see the <a href="/legal">legal page</a>.</p></div>`,
    });
}
