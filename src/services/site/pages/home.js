// home.js: the front page. What Mewvo is (with the DM a member gets), the dashboard, the
// warning ladder, what it does as a grid, the plans as compact cards (as on /pricing), and
// where to ask.
// Every claim is from the code or CLAUDE.md. No eyebrow labels, numbering, tick lists or
// CTA band (owner, 2026-11-01).

import { html } from '../../dashboard/html.js';
import { PLANS } from '../../../config/site/plans.js';
import { DASHBOARD_PATH, addButton, layout } from '../shell.js';
import { dashboardShot, ladderMock, warnDmMock } from './mockups.js';
import { planCard } from './pricing.js';

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
    ['appeals', 'Appeals', 'Members appeal with a short form. Ban appeals open a channel in the support server, so they work even after a ban, and a person on the staff team decides.', '/docs/appeals', 'How appeals work'],
    ['automod', 'Automod', 'Fourteen rules, from scam links to mass mentions. Each automatic action is a normal case, with a card in the staff channel to keep, undo or change it.', '/features#f-automod', 'Automod rules'],
    ['tickets', 'Tickets and modmail', 'A ticket panel, and members can DM the bot to reach staff. Both become channels in your server; lines starting with // stay internal.', '/features#f-tickets', 'Tickets and modmail'],
    ['logging', 'Logging and tools', 'Joins, leaves, role changes, edited and deleted messages and more, each in the channel you choose. Verification and server tools sit next to it.', '/features#f-server', 'Logging and tools'],
    ['community', 'Community tools', 'Leveling, tags, suggestions, starboard, sticky messages, YouTube feeds, reaction roles, giveaways, birthdays, applications, join-to-create voice channels, welcome messages.', '/features#f-community', 'All community tools'],
];

export function homePage(ctx) {
    const body = html`<section class="hero"><div class="wrap hero-grid">
<div class="hero-copy"><h1>A Discord bot for moderation and appeals</h1>
<p class="lead">Mewvo warns, mutes, kicks and bans from one panel. The member gets a DM with the reason, the end time and how to appeal. Your staff get a case with a short code they can look up later.</p>
${heroActions(ctx)}
${ctx.publicSite ? '' : html`<p class="note">Mewvo runs on the Mewvo server for now. It can’t be added to other servers yet.</p>`}</div>
<div class="hero-visual">${warnDmMock(ctx, { caption: 'The DM a member gets for a second warning. Same wording as the bot.' })}</div></div></section>

<section class="band" id="dashboard" aria-labelledby="dash-title"><div class="wrap">
<div class="band-head"><h2 id="dash-title">Everything in one place</h2>
<p>Members, cases, appeals and every setting in the browser. Sign in with Discord; every change is in an audit log. <a href="/docs/using-the-dashboard">A tour of the dashboard</a></p></div>
${dashboardShot({ alt: 'The Mewvo dashboard overview: items that need staff, moderation over the last seven days, bot health and setup progress.' })}
</div></section>

<section class="block" id="ladder" aria-labelledby="ladder-title"><div class="wrap split-2">
<div class="split-copy"><h2 id="ladder-title">The same rules for everyone</h2>
<p>Warnings climb a fixed ladder per member and server. Two warnings are a DM. The third is a 7-day ban, then 30 days, then permanent. Manual bans don’t move it, and an accepted appeal moves it back down a step.</p>
<p>Members can check where they stand, so nobody is surprised by a ban. <a href="/docs/warnings">How warnings escalate</a></p></div>
<div class="split-visual">${ladderMock()}</div></div></section>

<section class="block" aria-labelledby="what-title"><div class="wrap">
<div class="band-head"><h2 id="what-title">What it does</h2>
<p>Moderation first, with the community tools a server needs next to it. <a href="/features">Every feature</a></p></div>
<ul class="cards">${WHAT_IT_DOES.map(([id, name, text, href, label]) => html`<li class="card" id="${id}"><h3>${name}</h3><p>${text}</p><a href="${href}">${label}</a></li>`)}</ul>
</div></section>

<section class="block" aria-labelledby="pricing-title"><div class="wrap">
<div class="band-head"><h2 id="pricing-title">Free to use</h2>
<p>Everything above is free. Paid plans only raise limits such as tags and sticky messages. <a href="/pricing">Plans and prices</a></p></div>
<ul class="plan-cards plan-cards-compact">${PLANS.map((p) => planCard(ctx, p, { compact: true }))}</ul>
</div></section>

<section class="block block-last" aria-labelledby="help-title"><div class="wrap help-row">
<div><h2 id="help-title">Questions?</h2>
<p>Start with the guides, or ask in the support server. A person answers.</p></div>
<p class="hero-actions"><a class="button button-quiet" href="/docs">Docs</a><a class="button button-quiet" href="/faq">Questions and answers</a>${ctx.supportInvite ? html`<a class="button button-quiet" href="${ctx.supportInvite}" rel="noopener">Support server</a>` : ''}</p>
</div></section>`;
    return layout(ctx, {
        title: 'Mewvo', active: 'home', path: '/',
        description: 'Mewvo is a Discord bot for moderation with case codes and DMs, a three-step warning ladder, appeals that reach a person, automod, tickets and community tools.',
        body,
    });
}
