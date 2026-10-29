// docs.js — /docs (the guide hub) and /docs/<slug> (four short guides), written from the
// real behaviour: enforcement/flowBuilder.js, handlers/enforcementPanel.js, config/enforcement.js,
// enforcement/appealService.js, handlers/appealsHandler.js, dashboard/html.js NAV and CLAUDE.md.

import { html } from '../../dashboard/html.js';
import { DASHBOARD_PATH, layout } from '../shell.js';
import { appealFormMock, banDmMock, dashboardShot, ladderMock } from './mockups.js';

const supportLink = (ctx, text = 'the support server') => (ctx.supportInvite
    ? html`<a href="${ctx.supportInvite}" rel="noopener">${text}</a>`
    : text);

export const GUIDES = [
    {
        slug: 'getting-started', title: 'Getting started for staff', minutes: 4,
        summary: 'Who can use what, your first enforcement action, and the commands you’ll use every week.',
        body: (ctx) => html`<h2 id="access">Who can do what</h2>
<p>Everyday commands (help, rank, leaderboard, fun, to-do lists, reports and so on) are open to every member. Anything that moderates, changes settings, posts as the bot, affects other members or moves currency needs the <strong>Administrator</strong> role. The check runs every time a command or button is used, not only when it is first opened.</p>
<p>Members without Administrator who try a staff command are told so and pointed to the channel where they can request a role.</p>
<h2 id="first-action">Your first action</h2>
<ol class="steps-list"><li>Run <code>/enforcements user:@member</code>. The panel shows the member’s account age, time in the server, counted warnings, ladder level, any active punishment and their last cases. Only you can see it.</li>
<li>Press the action: <kbd>Ban</kbd>, <kbd>Kick</kbd>, <kbd>Mute</kbd> or <kbd>Warn</kbd> (or <kbd>Unban</kbd>, <kbd>Unmute</kbd>, <kbd>Remove warn</kbd> when they apply).</li>
<li>Choose a prebuilt reason or <strong>Custom…</strong> and type one.</li>
<li>For a mute, give a duration such as <code>30m</code>, <code>24h</code>, <code>7d</code> or <code>1mo</code>. For a ban, the same, or leave it blank for a permanent ban.</li>
<li>Check the summary and press <kbd>Confirm</kbd>.</li></ol>
<p>The member gets a DM before a kick or ban happens. If the DM can’t be delivered, the action still goes ahead and you are told. The panel expires after 15 minutes; run the command again if it does.</p>
<h2 id="every-week">Commands you’ll use</h2>
<dl class="ref-list"><div><dt><code>/background</code></dt><dd>A member’s full case history.</dd></div>
<div><dt><code>/case</code></dt><dd>Search cases, edit a reason or duration, void a mistaken case, see its history, attach evidence.</dd></div>
<div><dt><code>/appeals</code></dt><dd>Accept or deny an appeal by case code, with a note.</dd></div>
<div><dt><code>/test</code></dt><dd>Sends you the exact DM a member would get. Nothing is done to anyone.</dd></div>
<div><dt><code>/staff</code></dt><dd>Staff activity and stats.</dd></div>
<div><dt>Warn for this message</dt><dd>Right-click a message, then Apps: warns the author with the message attached.</dd></div></dl>
<h2 id="limits">Limits that protect the server</h2>
<p>Meowist refuses to act on the server owner, the bot, yourself, or anyone whose highest role is equal to or above yours. If one moderator bans or kicks more than 5 members in 10 minutes, they are blocked for an hour and the owner is told.</p>`,
    },
    {
        slug: 'warnings', title: 'How warnings and bans escalate', minutes: 3,
        summary: 'The warning ladder: three warnings, then 7 days, 30 days and a permanent ban.',
        body: (ctx) => html`<p>Every member has a ladder in each server. It starts at level 0 with no warnings, and it never resets on its own.</p>
${ladderMock()}
<h2 id="steps">The steps</h2>
<ol class="steps-list"><li><strong>Warnings 1 and 2</strong> are a DM: “Warning 1 of 3” and “Warning 2 of 3”.</li>
<li><strong>Warning 3</strong> is an automatic 7-day ban. The member is now at level 1.</li>
<li>After they return, the <strong>next warning</strong> is an automatic 30-day ban (level 2).</li>
<li>The <strong>warning after that</strong> is a permanent ban (level 3). It can be appealed for 6 months. After that, or after a denied appeal, it can no longer be appealed.</li></ol>
${banDmMock(ctx, { caption: 'The DM for the automatic ban at warning 3. Appealing this code also removes the warning that caused it.' })}
<h2 id="what-changes">What changes the ladder</h2>
<dl class="ref-list"><div><dt>Remove warn</dt><dd>Lowers the warning count.</dd></div>
<div><dt>Accepted appeal of a ladder ban</dt><dd>Lowers the level by one, never below 0.</dd></div>
<div><dt>A ban given by hand</dt><dd>Does not move the ladder.</dd></div>
<div><dt>Voiding a case</dt><dd>The case stays on record but no longer counts.</dd></div>
<div><dt>Imported old warnings</dt><dd>Shown as history only. They don’t count.</dd></div></dl>
<p>Members can check where they are with <strong>My standing</strong> on the appeal panel.</p>`,
    },
    {
        slug: 'appeals', title: 'Appeals: how they work', minutes: 3,
        summary: 'Where to appeal, what the form asks, who decides and how long it takes to try again.',
        body: (ctx) => html`<h2 id="where">Where to appeal</h2>
<p>Every punishment DM has the appeal link, or says it can’t be appealed. The appeal panel has three buttons: <strong>Appeal</strong>, <strong>My appeals</strong> and <strong>My standing</strong>. Muted or warned members use the panel in the main server. Banned members use the one in ${supportLink(ctx)}, which they can still reach after a ban.</p>
${appealFormMock()}
<h2 id="form">The form</h2>
<dl class="ref-list"><div><dt>Why should it be lifted?</dt><dd>At least 20 characters, at most 1000.</dd></div>
<div><dt>Case code</dt><dd>From the DM, for example <code>k7xq2</code>.</dd></div>
<div><dt>More info</dt><dd>Optional, anything else staff should know.</dd></div></dl>
<h2 id="after">What happens next</h2>
<ul class="ticks"><li><strong>Ban and kick appeals</strong> open a channel in the support server with you in it, so staff can ask questions.</li>
<li><strong>Mute and warning appeals</strong> are reviewed by staff in the main server.</li>
<li>The administrators decide. You get the decision by DM. An accepted appeal lifts what is still active and, for bans and kicks, comes with a one-time invite back.</li></ul>
<h2 id="limits">Limits</h2>
<ul class="ticks"><li>One pending appeal per case.</li>
<li>After a denial, wait 7 days before appealing the same case again.</li>
<li>Bans and mutes can be appealed while they last. Warnings and kicks within 30 days.</li>
<li>Some cases can’t be appealed, for example a permanent ladder ban after 6 months. The DM says so.</li></ul>`,
    },
    {
        slug: 'using-the-dashboard', title: 'Using the dashboard', minutes: 3,
        summary: 'Signing in, the four areas of the sidebar, and where changes are recorded.',
        body: (ctx) => html`<h2 id="sign-in">Signing in</h2>
<p>${ctx.dashboardEnabled ? html`Open <a href="${DASHBOARD_PATH}">the dashboard</a>` : 'Open the dashboard'} and log in with Discord. Meowist only asks Discord who you are (<code>identify</code>). You need the Administrator role in the server; it is checked again on every page and every save. A server can also give a moderator role view access to the moderation pages.</p>
${dashboardShot({ name: 'cases', alt: 'The Cases page of the Meowist dashboard: filters for member, moderator, type, status, text and dates above a table of cases with code, type, member, moderator, reason, date and status.', caption: 'Cases, with made-up members.' })}
<h2 id="areas">The four areas</h2>
<dl class="ref-list"><div><dt>Moderate</dt><dd>Overview (what needs you first), Inbox, Members, Banned, Cases, Appeals, No-contact, Staff and Channel tools.</dd></div>
<div><dt>Community</dt><dd>Tickets and modmail, Welcome and goodbye, Leveling, Reaction roles, Messages, Giveaways, Birthdays, Applications, Community and Join to create.</dd></div>
<div><dt>Server setup</dt><dd>Automod, Enforcement and appeals, Logging, Verification, Counters and the Support server.</dd></div>
<div><dt>Bot</dt><dd>All modules, Commands and the Audit log.</dd></div></dl>
<h2 id="changes">Changes and the audit log</h2>
<p>Settings are shown as rows; change one and save. Every change is written to the audit log: who changed which setting, from what, to what. Actions such as bans from the Members page use the same rules as the commands, including the DM and the safety checks.</p>
<p>The dashboard works on phones too, with a tab bar at the bottom, and has ten colour themes in the account menu.</p>`,
    },
];

export function docsPage(ctx) {
    return layout(ctx, {
        title: 'Docs', active: 'docs', path: '/docs',
        description: 'Short guides to Meowist: getting started for staff, how warnings escalate, how appeals work and using the dashboard.',
        body: html`<div class="wrap page">
<header class="page-head page-head-split"><div><p class="section-num">Docs</p><h1>Guides</h1></div>
<p class="lead">Short, accurate guides to how Meowist behaves. For every command members can use, see <a href="/commands">Commands</a>.</p></header>
<ol class="guide-list">${GUIDES.map((g, i) => html`<li><a class="guide" href="/docs/${g.slug}"><span class="guide-num">${String(i + 1).padStart(2, '0')}</span><span class="guide-text"><span class="guide-title">${g.title}</span><span class="guide-summary">${g.summary}</span></span><span class="guide-time">${g.minutes} min read</span></a></li>`)}</ol></div>`,
    });
}

export function guidePage(ctx, guide) {
    const index = GUIDES.indexOf(guide);
    const next = GUIDES[index + 1] || null;
    return layout(ctx, {
        title: guide.title, active: 'docs', path: `/docs/${guide.slug}`,
        description: guide.summary,
        body: html`<div class="wrap page"><div class="doc">
<nav class="crumbs" aria-label="Breadcrumb"><a href="/docs">Docs</a><span aria-hidden="true">/</span><span>${String(index + 1).padStart(2, '0')}</span></nav>
<header class="doc-head"><h1>${guide.title}</h1><p class="lead">${guide.summary}</p></header>
<div class="prose doc-body">${guide.body(ctx)}</div>
<nav class="doc-next" aria-label="Next guide">${next ? html`<a href="/docs/${next.slug}"><span class="doc-next-label">Next</span>${next.title}</a>` : html`<a href="/faq"><span class="doc-next-label">Still have questions?</span>Read the FAQ</a>`}</nav></div></div>`,
    });
}
