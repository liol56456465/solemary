// home.js: the front page. Deliberately plain: what Mewvo is, one example of the DM a member
// gets, a list of what it does with links to the details, the price in one line, and links.
// Every claim is from the code or CLAUDE.md.

import { html } from '../../dashboard/html.js';
import { PLANS, euros } from '../../../config/site/plans.js';
import { DASHBOARD_PATH, addButton, layout } from '../shell.js';
import { warnDmMock } from './mockups.js';

/** The actions: Add to Discord (public) or Join the server, then a docs link and the dashboard. */
export function heroActions(ctx, { how = '/docs', howLabel = 'Read the docs', dashboard = true } = {}) {
    const add = addButton(ctx);
    const join = !add && (ctx.mainInvite || ctx.supportInvite)
        ? html`<a class="button" href="${ctx.mainInvite || ctx.supportInvite}" rel="noopener">${ctx.mainInvite ? 'Join the server' : 'Join the support server'}</a>`
        : '';
    const primary = add || join;
    return html`<p class="hero-actions">${primary}<a class="button${primary ? ' button-quiet' : ''}" href="${how}">${howLabel}</a>${dashboard && ctx.dashboardEnabled ? html`<a class="button button-quiet" href="${DASHBOARD_PATH}">Open the dashboard</a>` : ''}</p>`;
}

/** What Mewvo does: [anchor id, name, text, link, link text]. */
const WHAT_IT_DOES = [
    ['enforcement', 'Moderation', 'Warn, mute, kick and ban from one panel that shows the member’s history first. Every action is a case with a short code that staff can edit, void or add evidence to later.', '/docs/getting-started', 'Getting started'],
    ['ladder', 'Warning ladder', 'Warnings 1 and 2 are a DM. The third is a 7-day ban, then a 30-day ban, then a permanent one. It is the same for everyone and members can check where they stand.', '/docs/warnings', 'How warnings escalate'],
    ['appeals', 'Appeals', 'Members appeal with a short form. Ban appeals open a channel in the support server, so they work even after a ban, and a person on the staff team decides.', '/docs/appeals', 'How appeals work'],
    ['automod', 'Automod', 'Fourteen rules, from scam links to mass mentions. Each automatic action is a normal case, with a card in the staff channel to keep, undo or change it.', '/features#f-automod', 'Automod rules'],
    ['tickets', 'Tickets and modmail', 'A ticket panel, and members can DM the bot to reach staff. Both become channels in your server; lines starting with // stay internal.', '/features#f-tickets', 'Tickets and modmail'],
    ['dashboard', 'Web dashboard', 'Members, cases, appeals and every setting in the browser. Sign in with Discord; every change is in an audit log.', '/docs/using-the-dashboard', 'A tour of the dashboard'],
    ['community', 'Community tools', 'Leveling, tags, suggestions, starboard, sticky messages, YouTube feeds, reaction roles, giveaways, birthdays, applications, join-to-create voice channels, welcome messages.', '/features#f-community', 'All community tools'],
];

export function homePage(ctx) {
    const paid = PLANS.filter((p) => p.monthlyCents > 0);
    const body = html`<section class="hero"><div class="wrap hero-grid">
<div class="hero-copy"><h1>A Discord bot for moderation and appeals</h1>
<p class="lead">Mewvo warns, mutes, kicks and bans from one panel. The member gets a DM with the reason, the end time and how to appeal, and your staff get a case they can review later.</p>
${heroActions(ctx)}
${ctx.publicSite ? '' : html`<p class="note">Mewvo runs on the Mewvo server for now. It can’t be added to other servers yet.</p>`}</div>
<div class="hero-visual">${warnDmMock(ctx, { caption: 'The DM a member gets for a second warning. Same wording as the bot.' })}</div></div></section>

<section class="block" aria-labelledby="what-title"><div class="wrap narrow">
<h2 id="what-title">What it does</h2>
<dl class="what-list">${WHAT_IT_DOES.map(([id, name, text, href, label]) => html`<div id="${id}"><dt>${name}</dt><dd>${text} <a href="${href}">${label}</a></dd></div>`)}</dl>

<h2 id="pricing-title">Price</h2>
<p>Mewvo is free. Paid plans raise limits such as tags and sticky messages: ${paid.map((p, i) => html`${i ? (i === paid.length - 1 ? ' and ' : ', ') : ''}${p.name} ${euros(p.monthlyCents)}`)} a month. <a href="/pricing">Plans and prices</a></p>

<h2 id="more-title">More</h2>
<p><a href="/features">Every feature</a> · <a href="/commands">Commands</a> · <a href="/docs">Docs</a> · <a href="/faq">Questions and answers</a>${ctx.supportInvite ? html` · <a href="${ctx.supportInvite}" rel="noopener">Support server</a>` : ''}</p>
</div></section>`;
    return layout(ctx, {
        title: 'Mewvo', active: 'home', path: '/',
        description: 'Mewvo is a Discord bot for moderation with case codes and DMs, a three-step warning ladder, appeals that reach a person, automod, tickets and community tools.',
        body,
    });
}
