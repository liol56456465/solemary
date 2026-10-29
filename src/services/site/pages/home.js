// home.js — the front page: hero with the warning DM, then seven numbered sections, each
// with a picture of the real thing, a pricing teaser and a closing call to action.
// Every claim is from the code or CLAUDE.md (enforcement, ladder, appeals, automod config).

import { html } from '../../dashboard/html.js';
import { PLANS, euros } from '../../../config/site/plans.js';
import { DASHBOARD_PATH, addButton, layout } from '../shell.js';
import {
    appealFormMock, dashboardShot, enforcementPanelMock, ladderMock, modmailMock, reviewCardMock, warnDmMock,
} from './mockups.js';

/** The primary actions: Add to Discord (public) or Join the server, then How it works and Dashboard. */
export function heroActions(ctx, { how = '#enforcement', howLabel = 'See how it works', dashboard = true } = {}) {
    const add = addButton(ctx);
    const join = !add && (ctx.mainInvite || ctx.supportInvite)
        ? html`<a class="button" href="${ctx.mainInvite || ctx.supportInvite}" rel="noopener">${ctx.mainInvite ? 'Join the server' : 'Join the support server'}</a>`
        : '';
    const primary = add || join;
    return html`<p class="hero-actions">${primary}<a class="button${primary ? ' button-quiet' : ''}" href="${how}">${howLabel}</a>${dashboard && ctx.dashboardEnabled ? html`<a class="button button-quiet" href="${DASHBOARD_PATH}">Open the dashboard</a>` : ''}</p>`;
}

function section({ id, number, label, title, body, visual, flip = false, wide = false }) {
    const heading = html`<p class="section-num"><span class="section-index">${number}</span>${label}</p><h2 id="${id}-title">${title}</h2>`;
    if (wide) {
        return html`<section class="block block-wide" id="${id}" aria-labelledby="${id}-title"><div class="wrap">
<div class="block-head"><div>${heading}</div><div class="block-text">${body}</div></div>${visual}</div></section>`;
    }
    return html`<section class="block" id="${id}" aria-labelledby="${id}-title"><div class="wrap split${flip ? ' split-flip' : ''}">
<div class="split-copy">${heading}${body}</div><div class="split-visual">${visual}</div></div></section>`;
}

const COMMUNITY = [
    ['Leveling', 'XP for chatting, level-up messages, role rewards and a public leaderboard.'],
    ['Tags', 'Saved answers anyone can call up by name. Up to 100 per server.'],
    ['Suggestions', 'A suggestions channel with votes and staff decisions.'],
    ['Starboard', 'Messages that get enough stars are copied to a highlights channel.'],
    ['Sticky messages', 'A message that stays at the bottom of a busy channel. Up to 10.'],
    ['YouTube feeds', 'New uploads from a channel posted for you. Up to 20 feeds.'],
    ['Reaction roles', 'Role menus with buttons or a select menu.'],
    ['Giveaways', 'Start, end and reroll, with winners picked at random.'],
    ['Birthdays', 'Birthday announcements and a birthday role for the day.'],
    ['Applications', 'Role applications with your own questions, reviewed by staff.'],
    ['Join to create', 'Temporary voice channels that clean up after themselves.'],
    ['Welcome and goodbye', 'Join and leave messages, and roles given on join.'],
];

export function homePage(ctx) {
    const paid = PLANS.filter((p) => p.monthlyCents > 0);
    const body = html`<section class="hero"><div class="wrap hero-grid">
<div class="hero-copy"><p class="kicker"><span class="kbd">Discord bot</span><span>Moderation, appeals and community tools</span></p>
<h1>Discord moderation with a paper trail.</h1>
<p class="lead">Mewvo warns, mutes, kicks and bans from one panel. The member gets a DM with the reason, the end time and how to appeal. Your staff get a case they can review, correct or void.</p>
${heroActions(ctx)}
${ctx.publicSite ? '' : html`<p class="note">Mewvo runs on its own server for now. It can’t be added to other servers yet.</p>`}</div>
<div class="hero-visual">${warnDmMock(ctx, { caption: 'The DM a member gets for a second warning. Wording from the bot, names made up.' })}</div></div></section>

<section class="facts" aria-label="Mewvo in numbers that never change"><div class="wrap"><dl class="facts-list">
<div><dt>Case codes</dt><dd>5–7 characters, like <code>k7xq2</code>. No 0, o, 1, l or i.</dd></div>
<div><dt>Warnings</dt><dd>3 per level, then an automatic ban.</dd></div>
<div><dt>Appeals</dt><dd>One open per case, decided by a person.</dd></div>
<div><dt>Staff checks</dt><dd>Administrator re-checked on every action.</dd></div>
</dl></div></section>

${section({
        id: 'enforcement', number: '01', label: 'Enforcement',
        title: 'One panel, with the member’s history on top.',
        body: html`<p>Run <code>/enforcements</code> on a member and Mewvo shows their account age, warnings, ladder level, active punishments and last cases before you choose what to do.</p>
<p class="flow" aria-label="The steps"><kbd>Action</kbd><span aria-hidden="true">→</span><kbd>Reason</kbd><span aria-hidden="true">→</span><kbd>Duration</kbd><span aria-hidden="true">→</span><kbd>Confirm</kbd></p>
<ul class="ticks"><li>The DM goes out before a kick or ban, so it still reaches the member. If it fails, the moderator is told.</li>
<li>Every action is a case with a short code, and staff can edit it, void it or attach evidence later.</li>
<li>It refuses the server owner, the bot, yourself and anyone with an equal or higher role.</li>
<li>More than 5 bans or kicks in 10 minutes blocks that moderator for an hour and alerts the owner.</li></ul>`,
        visual: enforcementPanelMock({ caption: 'The /enforcements panel. Only the moderator who ran it can see it.' }),
    })}

${section({
        id: 'ladder', number: '02', label: 'Warning ladder', flip: true,
        title: 'Three warnings, then a ban. No surprises.',
        body: html`<p>The ladder counts per member and per server, and it never quietly resets. Each warning DM says which one it is. The third is an automatic 7-day ban. After that, the next warning is a 30-day ban, and the one after is permanent, still open to appeal for six months.</p>
<ul class="ticks"><li>Bans a moderator gives by hand don’t move the ladder.</li>
<li>Removing a warning lowers the count again.</li>
<li>An accepted appeal of a ladder ban steps the level down by one.</li></ul>
<p><a class="more" href="/docs/warnings">How warnings escalate, step by step</a></p>`,
        visual: ladderMock(),
    })}

${section({
        id: 'appeals', number: '03', label: 'Appeals',
        title: 'Appeals reach a person, even after a ban.',
        body: html`<p>Members press <strong>Appeal</strong> on the appeal panel and fill in three fields. Ban and kick appeals open a private channel in the support server, so the conversation works even when they can’t see your server any more. Staff see the case and the member’s history next to Accept and Deny.</p>
<ul class="ticks"><li>One pending appeal per case. After a denial, the member waits 7 days to try again.</li>
<li>Bans and mutes can be appealed while they last; warnings and kicks within 30 days.</li>
<li>Accepting lifts the punishment and DMs a one-time invite back to the server.</li></ul>
<p><a class="more" href="/docs/appeals">How appeals work</a></p>`,
        visual: appealFormMock({ caption: 'The appeal form, as Discord shows it. Case code from the member’s DM.' }),
    })}

${section({
        id: 'automod', number: '04', label: 'Automod', flip: true,
        title: 'Automod that shows its work.',
        body: html`<p>Fourteen rules, from scam links and mass mentions to caps and fancy fonts. Each rule has its own punishment steps, and every automatic action is a normal case with a review card in your staff channel: keep it, undo it or change it.</p>
<ul class="ticks"><li>Text is folded back to plain letters first, so look-alike characters and zalgo don’t slip past.</li>
<li>Links, attachments and fast posting are limited for new members in their first 3 days.</li>
<li>Ten joins in a minute counts as a raid: the server locks down, invites and DMs pause, and admins are alerted.</li>
<li>Works next to Discord’s own AutoMod, with a bridge for its rules.</li></ul>`,
        visual: reviewCardMock({ caption: 'A review card in the staff channel after an automatic warning.' }),
    })}

${section({
        id: 'tickets', number: '05', label: 'Tickets and modmail',
        title: 'Tickets and modmail in channels your staff already use.',
        body: html`<p>A ticket panel with claim, priority, saved answers and a transcript when the ticket closes. Members can also DM the bot and choose <strong>Send to staff</strong>: the conversation becomes a staff channel, and anything a moderator starts with <code>//</code> stays internal.</p>
<ul class="ticks"><li>Close, block and unblock with <code>/modmail</code>.</li>
<li>Members can report a staff member privately; only administrators see those reports.</li></ul>`,
        visual: modmailMock({ caption: 'A modmail channel. The grey line is an internal note the member never sees.' }),
    })}

${section({
        id: 'dashboard', number: '06', label: 'Dashboard', wide: true,
        title: 'The whole server in a browser tab.',
        body: html`<p>Members, cases, appeals, the staff inbox and every module’s settings, on one page per area. Sign in with Discord. Administrator is checked again on every request, and every change is written to an audit log with the old and the new value.</p>
<p><a class="more" href="/docs/using-the-dashboard">A tour of the dashboard</a></p>`,
        visual: dashboardShot({ name: 'overview', alt: 'The Mewvo dashboard Overview page: a “Needs you” list with two appeals waiting, open tickets and a setup step, a bar chart of moderation actions over the last seven days, member and sanction counts, and the bot’s health.', caption: 'The Overview page of the dashboard, with made-up members and cases.', eager: true }),
    })}

<section class="block" id="community" aria-labelledby="community-title"><div class="wrap split split-narrow">
<div class="split-copy"><p class="section-num"><span class="section-index">07</span>Community tools</p><h2 id="community-title">The everyday parts, too.</h2>
<p>The same bot runs the friendly side of the server, set up from the same dashboard.</p><p><a class="more" href="/features">Every feature</a></p></div>
<dl class="spec-list">${COMMUNITY.map(([name, text]) => html`<div><dt>${name}</dt><dd>${text}</dd></div>`)}</dl></div></section>

<section class="block block-pricing" aria-labelledby="pricing-title"><div class="wrap split split-narrow">
<div class="split-copy"><p class="section-num"><span class="section-index">€</span>Pricing</p><h2 id="pricing-title">Free while it runs on one server.</h2>
<p>Everything above is free. Paid plans with higher limits come when Mewvo opens to other servers.</p><p><a class="more" href="/pricing">Compare plans</a></p></div>
<ul class="price-rows"><li><span class="price-name">Free</span><span class="price-desc">Everything on this page</span><span class="price-amount">€0</span></li>
${paid.map((p) => html`<li><span class="price-name">${p.name}</span><span class="price-desc">${p.summary}</span><span class="price-amount">${euros(p.monthlyCents)}<span class="per">/month</span></span></li>`)}</ul></div></section>

<section class="cta" aria-labelledby="cta-title"><div class="wrap cta-inner"><div><h2 id="cta-title">See it on a real server.</h2>
<p>${ctx.publicSite ? 'Add Mewvo to your server, or look around ours first.' : 'Mewvo runs the Mewvo Discord server. Join it to see the appeal panel, the leaderboard and the bot at work.'}</p></div>
${heroActions(ctx, { how: '/docs', howLabel: 'Read the docs', dashboard: false })}</div></section>`;
    return layout(ctx, {
        title: 'Mewvo', active: 'home', path: '/',
        description: 'Mewvo is a Discord bot for moderation with case codes and DMs, a three-step warning ladder, appeals that reach a person, automod, tickets and community tools.',
        body,
    });
}
