// features.js — /features: the full feature reference, grouped by area. Plain and specific;
// written from the commands, config/enforcement.js, config/automod.js and CLAUDE.md.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';

export const FEATURE_GROUPS = [
    {
        key: 'enforcement', title: 'Enforcement',
        intro: 'Warn, mute, kick and ban from one panel, with a record for every action.',
        items: [
            ['/enforcements panel', 'Shows the member’s account age, time in the server, counted warnings, ladder level, active punishments and last three cases, then offers only the actions that make sense right now (Ban, Kick, Mute, Warn, Unban, Unmute, Remove warn).'],
            ['Reasons', 'A list of prebuilt reasons, some marked severe (a severe ban is unappealable by default), or a custom reason.'],
            ['Case codes', 'Every action gets a short, unique code such as k7xq2: 5 to 7 lowercase letters and digits, without the look-alikes 0, o, 1, l and i.'],
            ['DMs', 'The member gets the reason, who acted, the date, the duration and end time, the case code and how to appeal. Kicked members get a one-time invite back (one use, 7 days).'],
            ['Mutes', 'A managed Muted role instead of Discord timeouts, so mutes can last longer than 28 days. It is applied to new channels too and re-applied if the member leaves and rejoins.'],
            ['Safety checks', 'Refuses the server owner, the bot, yourself and anyone with an equal or higher role. The Administrator role is checked again on every click.'],
            ['Mass-action guard', 'More than 5 bans or kicks in 10 minutes by one moderator blocks them for an hour and alerts the owner. Mutes have their own limit of 10.'],
            ['Case tools', '/case edit, void and history, evidence (message links with an excerpt, or images), case search, and /background for a member’s full history.'],
            ['Warn for this message', 'Right-click a message to warn its author with the message attached as evidence.'],
            ['Simulation', '/test sends you the exact DM a member would get, without doing anything.'],
            ['No-contact orders', 'Ask two members not to contact each other until a set time. It is not a punishment and doesn’t count as a warning.'],
        ],
    },
    {
        key: 'ladder', title: 'Warning ladder',
        intro: 'Escalation that is the same for everyone and visible to the member.',
        items: [
            ['Levels', 'Warnings 1 and 2 are a DM. Warning 3 is an automatic 7-day ban (level 1). The next warning after that is a 30-day ban (level 2), then a permanent ban (level 3).'],
            ['Never resets', 'The ladder is kept per member and per server and doesn’t quietly reset over time.'],
            ['Corrections', 'Removing a warning lowers the count. Bans given by hand don’t move the ladder. An accepted appeal of a ladder ban lowers the level by one.'],
            ['Level 3 appeals', 'A permanent ladder ban can be appealed for 6 months. After that, or after a denied appeal, it can’t be appealed.'],
            ['My standing', 'Members can check their own warnings and what the next one would do, from the appeal panel or the My record page.'],
        ],
    },
    {
        key: 'appeals', title: 'Appeals and reports',
        intro: 'A way back that ends with a decision by a person.',
        items: [
            ['Appeal panel', '/setappeal posts the panel with Appeal, My appeals and My standing buttons, in the main server and the support server.'],
            ['Appeal form', 'Why it should be lifted, the case code from the DM, and anything else staff should know.'],
            ['Ban and kick appeals', 'Open a channel in the support server with the member in it, so the conversation works after a ban. The case and history go to an admin-only staff channel with Accept and Deny.'],
            ['Limits', 'One pending appeal per case and 7 days before trying again after a denial. Bans and mutes can be appealed while active, warnings and kicks within 30 days.'],
            ['Decisions', 'Accept lifts what is still active and DMs a one-time invite back; Deny DMs the member. /appeals decides from a command too.'],
            ['Banned role', 'Members with an active ban get a role in the support server, removed when the ban ends.'],
            ['Staff reports', 'Members can report a staff member privately. Only administrators see reports; one open report per person and three a day.'],
        ],
    },
    {
        key: 'automod', title: 'Automod and raids',
        intro: 'Automatic actions that are normal cases, with a person reviewing them.',
        items: [
            ['14 rules', 'Scam links, NSFW, sexual harassment, harassment, personal info, advertising, impersonation, language, disrespect, mass mentions, spam, caps, fancy characters and English only.'],
            ['Punishment steps', 'Each rule has its own steps (for example spam: warn, mute 1 hour, mute 1 day), counted over 30 days. When a message breaks several rules, only the most severe counts.'],
            ['Review cards', 'Every automatic action posts a card for staff with Keep, Undo and Change to….'],
            ['Modes', 'Each rule is on, monitor (card only) or off, globally or per channel. Trusted roles and channel exceptions.'],
            ['Hard to dodge', 'Text is folded back to plain letters, so fancy fonts, look-alike letters, zalgo and invisible characters don’t get around the rules.'],
            ['New members', 'Links, attachments and fast posting are limited for a member’s first 3 days. A join gate can flag or kick new accounts that fail its checks.'],
            ['Raids', 'Ten joins in a minute locks the server down: the verification level goes up, invites and DMs pause (panic mode) and admins are alerted. /automod lockdown-end restores everything and posts a report.'],
            ['Member reports', 'When 3 members react to a message with the flag emoji, it is removed and sent to the review channel.'],
            ['Native AutoMod', 'A bridge to Discord’s built-in AutoMod rules, so both work together.'],
        ],
    },
    {
        key: 'tickets', title: 'Tickets and modmail',
        intro: 'Private conversations between members and staff, kept in Discord.',
        items: [
            ['Ticket panel', 'Members open a ticket from a button. Staff claim it, set a priority and answer with saved replies.'],
            ['Transcripts', 'When a ticket or modmail conversation closes, a transcript goes to a staff-only channel.'],
            ['Modmail', 'DM the bot and press Send to staff: the conversation becomes a staff channel. Lines starting with // are internal notes.'],
            ['Commands', '/modmail close, block and unblock. Open reports and modmail channels are capped so a flood can’t bury the server.'],
        ],
    },
    {
        key: 'dashboard', title: 'Web dashboard',
        intro: 'The server’s settings and moderation in the browser.',
        items: [
            ['Sign-in', 'Log in with Discord (identify only). Administrator is checked again on every request; a moderator role can be given view access to the moderation pages.'],
            ['Moderate', 'Overview with what needs you, an inbox, members (filters, roles, nicknames, timeouts, bulk actions), bans, cases, appeals, no-contact orders and staff activity.'],
            ['Settings', 'Every module on its own page: tickets, welcome, leveling, reaction roles, messages, giveaways, birthdays, applications, community, automod, enforcement, logging, verification and more.'],
            ['Audit log', 'Every change is recorded: who changed which setting, from what, to what.'],
            ['Temporary roles', 'Give a role for a set time; it is removed when the time is up and re-applied if the member rejoins early.'],
        ],
    },
    {
        key: 'community', title: 'Community',
        intro: 'The friendly side of the server.',
        items: [
            ['Leveling', 'XP for chatting, level-up messages, role rewards, channels without XP and a public leaderboard.'],
            ['Tags', 'Saved answers anyone can call up with /tag. Up to 100 per server.'],
            ['Suggestions', 'A suggestions channel with votes.'],
            ['Starboard', 'Messages with enough stars are copied to a highlights channel.'],
            ['Sticky messages', 'Kept at the bottom of a channel. Up to 10 per server.'],
            ['YouTube feeds', 'New uploads posted to a channel. Up to 20 feeds.'],
            ['Reaction roles', 'Self-assign role menus with buttons or a select menu.'],
            ['Giveaways', 'Start, end and reroll.'],
            ['Birthdays', 'Announcements and a birthday role, with time zones.'],
            ['Applications', 'Role applications with your own questions.'],
            ['Join to create', 'Temporary voice channels.'],
            ['Welcome and goodbye', 'Join and leave messages, roles on join.'],
            ['Counters', 'Member count channels and a counting game.'],
        ],
    },
    {
        key: 'server', title: 'Logging, verification and tools',
        intro: 'The plumbing.',
        items: [
            ['Logging', 'Joins, leaves, role changes, edited and deleted messages and more, each to the channel you choose, with ignored channels.'],
            ['Verification', 'A verify panel or verification on join. “Verify with Discord” can also add the member to the support server so appeal messages still reach them.'],
            ['Posting as the bot', 'Messages, embeds, polls and countdowns from the dashboard or commands.'],
            ['Member tools', 'To-do lists (also shared), a calculator and converters, weather, server and user info, and /wipedata to delete your own levels and balance.'],
        ],
    },
];

export function featuresPage(ctx) {
    return layout(ctx, {
        title: 'Features', active: 'features', path: '/features',
        description: 'Everything Mewvo does: enforcement, the warning ladder, appeals, automod, tickets and modmail, the web dashboard and community tools.',
        body: html`<div class="wrap page">
<header class="page-head"><p class="section-num">Reference</p><h1>Features</h1>
<p class="lead">Everything Mewvo does today, grouped by area. Nothing on this page is planned or paid; for what may come with paid plans, see <a href="/pricing">Pricing</a>.</p></header>
<div class="with-index"><nav class="index" aria-label="Feature areas"><ol>${FEATURE_GROUPS.map((g, i) => html`<li><a href="#f-${g.key}"><span class="index-num">${String(i + 1).padStart(2, '0')}</span>${g.title}</a></li>`)}</ol></nav>
<div class="index-body">${FEATURE_GROUPS.map((g, i) => html`<section class="ref-group" id="f-${g.key}" aria-labelledby="f-${g.key}-title">
<p class="section-num"><span class="section-index">${String(i + 1).padStart(2, '0')}</span>${g.intro}</p><h2 id="f-${g.key}-title">${g.title}</h2>
<dl class="ref-list">${g.items.map(([term, text]) => html`<div><dt>${term}</dt><dd>${text}</dd></div>`)}</dl></section>`)}</div></div></div>`,
    });
}
