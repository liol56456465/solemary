// faq.js — /faq: real questions with short answers (from CLAUDE.md and the code). Each answer
// is a <details> block: opens with the keyboard, works without a script.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';

function faqItems(ctx) {
    const support = ctx.supportInvite
        ? html`<a href="${ctx.supportInvite}" rel="noopener">the support server</a>`
        : 'the support server';
    return [
        {
            group: 'About Mewvo',
            items: [
                ['What does Mewvo do?', html`<p>It moderates a Discord server and runs its community features. Staff warn, mute, kick and ban from one panel; every action becomes a case with a code and the member gets a DM saying why, until when and how to appeal. Around that: a warning ladder, appeals, automod, tickets and modmail, a web dashboard, leveling and other community tools. The <a href="/features">features page</a> lists everything.</p>`],
                ['Why can’t I add it to my server yet?', html`<p>${ctx.publicSite ? 'You can now: use the Add to Discord button at the top of the page.' : 'Mewvo is built for and runs on the Mewvo server only for now. Opening it to other servers needs more work first, such as settings and limits per server. When it opens, a button to add it to your server appears on this site, and the paid plans on the pricing page start then too.'}</p>`],
                ['Is it free?', html`<p>Yes. Everything it does today is free. Paid plans with higher limits are planned for when Mewvo opens to other servers; see <a href="/pricing">Pricing</a>.</p>`],
            ],
        },
        {
            group: 'Warnings and appeals',
            items: [
                ['How does the warning ladder work?', html`<p>Warnings 1 and 2 are a DM. Warning 3 is an automatic 7-day ban. After that, the next warning is a 30-day ban, and the next a permanent ban that can be appealed for 6 months. The ladder never resets on its own; an accepted appeal of a ladder ban steps it down by one. <a href="/docs/warnings">The full guide</a>.</p>`],
                ['How do I appeal?', html`<p>Use the link in the DM you got. Press <strong>Appeal</strong> on the appeal panel and enter why it should be lifted and the case code from the DM. If you are banned, use the panel in ${support}. You get the decision by DM. <a href="/docs/appeals">How appeals work</a>.</p>`],
                ['I lost my case code.', html`<p>Press <strong>My standing</strong> on the appeal panel: it lists your warnings and any active ban or mute with their codes${ctx.memberPortal ? html`. <a href="/me">My record</a> on this site shows all your cases` : ''}.</p>`],
                ['Can every punishment be appealed?', html`<p>Most can. Bans and mutes can be appealed while they last, warnings and kicks within 30 days. A permanent ladder ban stops being appealable after 6 months or after a denied appeal, and staff can mark a severe ban as unappealable. The DM always says which.</p>`],
            ],
        },
        {
            group: 'Data and contact',
            items: [
                ['What data does Mewvo store?', html`<p>Discord IDs, your levels and XP, moderation cases, appeals and what you write in forms or tickets, and a few things you choose to save, such as a birthday. No email, no password, never sold. The <a href="/privacy">privacy page</a> has the full list, and <code>/wipedata</code> deletes your levels, balance and AFK status.</p>`],
                ['How do I reach the staff?', html`<p>Three ways: DM the bot and choose <strong>Send to staff</strong> (modmail), open a ticket from the ticket panel, or ask in ${support}. To report a staff member, use <strong>Report staff</strong> on the appeal panel in the support server; only administrators see those reports.</p>`],
                ['Is the bot down?', html`<p>Check the <a href="/status">status page</a>. It shows whether the bot is online and refreshes every minute.</p>`],
            ],
        },
    ];
}

export function faqPage(ctx) {
    const groups = faqItems(ctx);
    return layout(ctx, {
        title: 'FAQ', active: 'faq', path: '/faq',
        description: 'Answers about Mewvo: what it does, the warning ladder, appeals, stored data and how to reach staff.',
        body: html`<div class="wrap page">
<header class="page-head page-head-split"><div><p class="section-num">Help</p><h1>Questions and answers</h1></div>
<p class="lead">Short answers. For step-by-step guides, see the <a href="/docs">docs</a>.</p></header>
${groups.map((g, i) => html`<section class="faq-group split split-narrow" aria-labelledby="faq-${i}"><div class="split-copy"><p class="section-num"><span class="section-index">${String(i + 1).padStart(2, '0')}</span></p><h2 id="faq-${i}">${g.group}</h2></div>
<div class="faq-list">${g.items.map(([q, a]) => html`<details class="faq"><summary>${q}</summary><div class="faq-answer">${a}</div></details>`)}</div></section>`)}</div>`,
    });
}
