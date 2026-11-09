// legal.js — the Privacy Policy, the Terms and Conditions, the Legal notice (/legal) and the
// contact and illegal-content reporting page (/contact).
//
// Written from what the code stores and does (utils/database/schema.js, oauthVerification.js,
// verificationGuard.js, memberBackupService.js, wipedataService.js, privacy/dataExport.js,
// dashboard/security.js, site/memberPortal.js, site/accountRoutes.js, billing/premiumService.js,
// accounts/accountStore.js, automod/*, utils/logger.js). Nothing here is invented: when the code
// changes what it stores, change this page and LEGAL_UPDATED with it.
//
// Who runs Mewvo comes from env, never from the code (none of these are secrets):
//   LEGAL_OPERATOR   the operator's name            LEGAL_EMAIL      a contact address
//   LEGAL_ADDRESS    a postal address (/legal)      LEGAL_REG_NO     registration / individual activity number
//   LEGAL_VAT_NO     VAT number (unset: "Not VAT registered", only when LEGAL_OPERATOR is set)
//   DB_REGION_LABEL  where the database runs, e.g. "EU (Frankfurt)" (unset: a general line)
// Without them the pages point to the support server instead.
// This is not legal advice; the owner should have the pages checked before real payments.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';

export const LEGAL_UPDATED = '2026-11-09';
const UPDATED_TEXT = '9 November 2026';

const EMAIL = /^[^\s@<>"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;

/** One line of plain text from env: trimmed, spaces collapsed, null when empty or too long. */
function envLine(value, max) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    return text && text.length <= max ? text : null;
}

/** The operator details from env; each null when unset or malformed. */
export function legalContact(env = process.env) {
    const email = String(env.LEGAL_EMAIL || '').trim();
    return {
        operator: envLine(env.LEGAL_OPERATOR, 120),
        email: EMAIL.test(email) ? email : null,
        address: envLine(env.LEGAL_ADDRESS, 200),
        regNo: envLine(env.LEGAL_REG_NO, 60),
        vatNo: envLine(env.LEGAL_VAT_NO, 30),
        dbRegion: envLine(env.DB_REGION_LABEL, 60),
    };
}

const updatedLine = () => html`<p class="note">Last updated <time datetime="${LEGAL_UPDATED}">${UPDATED_TEXT}</time>.</p>`;

const supportLink = (ctx) => (ctx.supportInvite
    ? html`<a href="${ctx.supportInvite}" rel="noopener">the support server</a>`
    : 'the staff team on the Mewvo server');

/** "email x or ask in the support server", whichever exist. */
function contactLine(ctx) {
    const email = ctx.legal?.email;
    return email
        ? html`email <a href="mailto:${email}">${email}</a> or ask in ${supportLink(ctx)}`
        : html`ask in ${supportLink(ctx)}`;
}

/** For people who cannot use the support server (for example after a ban); nothing without LEGAL_EMAIL. */
function cannotReachLine(ctx) {
    const email = ctx.legal?.email;
    return email
        ? html`If you can’t reach the support server, for example because you are banned, email <a href="mailto:${email}">${email}</a>. A ban never stops you from using your rights.`
        : '';
}

function whoLine(ctx) {
    const operator = ctx.legal?.operator;
    return operator
        ? html`Mewvo is run by ${operator}, a private individual in Lithuania, who decides how the data below is used (the “controller” under the GDPR).`
        : 'Mewvo is run by one private individual in Lithuania, its owner, who decides how the data below is used (the “controller” under the GDPR).';
}

const row = (what, why, kept) => html`<tr><th scope="row">${what}</th><td>${why}</td><td>${kept}</td></tr>`;

function dbRegionText(ctx) {
    const region = ctx.legal?.dbRegion;
    return region
        ? `The database runs in this region: ${region}.`
        : 'The database runs in the EU or in the US, depending on the region chosen for it; this page names the region once it is set.';
}

export function privacyPage(ctx) {
    return layout(ctx, {
        title: 'Privacy Policy', active: 'privacy', path: '/privacy',
        description: 'What the Mewvo bot and website store about you, why, for how long, and your rights.',
        body: html`<div class="wrap page prose"><h1>Privacy Policy</h1>
${updatedLine()}
<p class="lead">What Mewvo stores about you, why, for how long, who else sees it, and how to get a copy or have it deleted. Your data is never sold, never used for advertising and never used to train AI models.</p>

<h2>Who is responsible</h2>
<p>${whoLine(ctx)} To reach them about your data, ${contactLine(ctx)}. The full operator details are in the <a href="/legal">Legal notice</a>.</p>

<h2>In short</h2>
<ul><li>Mewvo works with Discord IDs (the numbers that identify accounts, servers and channels). Where a record needs a readable name, such as a moderation case, the username at that moment is saved with it.</li>
<li>The text of your messages is never stored. Technical logs keep only message IDs and lengths.</li>
<li>Everything is kept in a PostgreSQL database used only by the bot.</li>
<li>The bot never asks for your email address, a password or payment details. A Mewvo account on this website never asks for an email address either: only if you choose to create one, Mewvo stores a username and a one-way hash of your password (see below).</li>
<li>This website has no analytics, no ads, no tracking and no third-party scripts or cookies.</li></ul>

<h2>What is stored, why, and for how long</h2>
<div class="table-wrap" role="region" aria-labelledby="data-title" tabindex="0"><table class="legal-table">
<caption id="data-title">Each kind of data, the reason for it and how long it is kept.</caption>
<thead><tr><th scope="col">Data</th><th scope="col">Why</th><th scope="col">Kept</th></tr></thead>
<tbody>
${row('Levels: XP, level and when your last message counted', 'To run leveling and the leaderboards you see on Discord and on this website (server display name, level and total XP). The text of your messages is not saved.', 'Until you run /wipedata or ask for them to be deleted. Leaving the server does not delete them, so your level and level roles come back if you rejoin. If you have left, ask for deletion using the contact under “Who is responsible”, or rejoin and run /wipedata.')}
${row('Voice time (only if the server turns on Voice XP): the minutes you spent in voice channels in each server, the XP they gave and today’s count for the daily limit. Not who you talked with, and no audio: Mewvo never listens to or records voice.', 'To give XP for time in voice, keep the daily limit and show voice time in /rank, /profile and the voice leaderboard.', 'Until you run /wipedata or ask for it to be deleted (it is deleted with your level data). Leaving the server does not delete it.')}
${row('Economy: your balance and bank in each server', 'To run the server’s economy commands.', 'Until you run /wipedata or ask.')}
${row('Moderation cases: code, type, reason, moderator, time, duration, whether it can be appealed, whether the DM arrived, and the edit history', 'To enforce server rules, to show you why you were punished, and to let decisions be checked and appealed.', 'As long as the server uses Mewvo. A voided case stays on record so decisions can be reviewed. You can ask for a case to be removed: the owner can erase it or remove your name and ID from it.')}
${row('Evidence attached by staff: message links, a short excerpt of the text, images (re-posted in a staff-only channel)', 'So a case can still be checked if the original message is deleted. This is the only place a piece of message text is kept, and only because a staff member attached it.', 'With the case.')}
${row('Staff notes and tags on a case', 'So staff can record context for a decision.', 'With the case.')}
${row('Warning ladder step, per server', 'The automatic steps of the warning ladder.', 'With the cases. It is never reset automatically.')}
${row('Appeals and staff reports: what you write, the decision, who made it, the staff note; a transcript posted to a staff channel. “Contest this” on an automod DM: your reason.', 'To decide your appeal, report or contest and keep a record of the decision.', 'Appeals and reports: as long as the server uses Mewvo. A contest reason: 30 days.')}
${row('Staff watchlist: a private staff note that a member should be watched, with the reason, who added it and until when', 'So staff notice if someone with a history joins again, gets a new case or trips automod. You are not told when it is added, but it is included in your data export.', 'Deleted 1 year after the entry ends.')}
${row('No-contact orders: the two members, the reason, who set it and until when', 'To enforce an order that two members leave each other alone.', 'Deleted 1 year after the order ends.')}
${row('Temporary roles given by staff: the role, the reason, who gave it, until when', 'To remove the role at the right time and give it back if you rejoin before then.', 'Until the role ends.')}
${row('Raid records: when a join raid ended, the accounts that joined during it and what the bot did; the raid timeline (short events of what the bot and staff did, no message text)', 'So staff can review a raid and release members who did nothing wrong.', 'Raid records: 1 year. Raid timelines: 90 days after the raid ends.')}
${row('Short automod records: a flag from the join checks, probation after a ban ended, the “heads-up first” and “second chance” markers', 'So automod treats a repeat in the same way each time and staff can review flags.', 'Join check flags 14 days, probation 7 days, heads-up and second-chance markers 30 days.')}
${row('Staff only: warnings the owner gives staff, weekly activity counts (messages, reviews, tickets claimed) and staff roles removed by the safety guard', 'To keep the staff team accountable and give roles back with /staff restore.', 'As long as the server uses Mewvo; removed roles until they are given back.')}
${row('Tickets and modmail: who opened it, its state, which channel belongs to which member; a transcript posted to a staff channel when it closes', 'To answer you and keep a record of support conversations.', 'As long as the server uses Mewvo.')}
${row('Ticket and modmail ratings: the stars (1–5) and optional comment you give after a ticket closes, when, and which staff member handled it. Comments are checked against the server’s word filter and only marked for staff, never blocked', 'To let the server see how well its support works.', 'Comments 180 days; ratings 2 years; a rating request you never answered 30 days after it closed.')}
${row('Role applications: your answers, the status, the reviewer and their notes', 'To decide your application.', 'Open applications 30 days, decided ones 14 days (a server can change both).')}
${row('Invites: which invite you joined through and who created it, and how often each invite was used', 'Invite statistics and rewards for the staff team.', 'As long as the server uses Mewvo.')}
${row('Starboard: which messages got enough stars, and the starboard post (a copy on Discord)', 'To run the starboard.', 'Until the post is removed or the server stops using Mewvo.')}
${row('Things you choose to save: birthday, AFK message, suggestions and votes, giveaway entries, to-do lists (also shared ones)', 'To provide the feature you used.', 'Until you remove them, run /wipedata (where it covers them) or ask. Giveaway entries: until the giveaway is deleted.')}
${row('Reminders: what you asked to be reminded about, when, and the channel you set it in', 'To send the reminder (by DM, or in that channel if your DMs are closed).', 'Until it is sent, then 30 more days. Delete one any time with /remind delete.')}
${row('Verification (“Verify with Discord”): your Discord ID and name, and an encrypted Discord login token (AES-256-GCM)', 'The token is used to add you to the Mewvo support server, so appeal messages still reach you after a ban, and, only for Mewvo’s own servers, to add verified members back if a server has to be restored.', 'Until you run /wipedata or ask. You can also remove Mewvo under Authorized Apps in your Discord settings; the token then stops working.')}
${row('Verification history: what happened and when (verified, held, approved, denied)', 'So staff can check how a verification went.', '1 year.')}
${row('A keyed one-way hash of the IP address you verified from (never the address itself)', 'To spot someone returning on a new account after a ban. A match alone never refuses anyone: a person on the staff team decides.', '60 days, longer only while that account has an active ban on the Mewvo server.')}
${row('Joins and leaves', 'Member statistics for the staff team.', '90 days.')}
${row('Plans and keys: your plan, start and end date, test orders (plan, period, amount), keys you bought or redeemed, and a gift’s “to” name and message', 'To give you the plan you chose and send DMs when it starts and ends.', 'As long as you have an account with Mewvo, or until you ask. When real payments start, invoices are kept as long as tax law requires.')}
${row('Mewvo account on this website (only if you create one): username, a one-way scrypt hash of your password (never the password itself), that you confirmed your age and when (never your date of birth), when you accepted the terms, the linked Discord ID and name, when you last logged in and changed your password. No email address. Accounts made before November 2026 may still hold the email address given then.', 'To let you log in with a username and password, reset a forgotten password through your linked Discord account and show your record and plans.', 'Until you delete the account in Account settings. An account that is not linked to Discord within 7 days is deleted automatically.')}
${row('Two-step login (only if you turn it on): the secret of your authenticator app, encrypted (AES-256-GCM), the last code step used, and one-way hashes of your recovery codes', 'To ask for a code when you log in, and to stop a code from being used twice.', 'Until you turn two-step login off or delete the account.')}
${row('Early-account bonus: for each Discord account the first time it is linked, its number in the order of links, whether the 6 months of Pro were given and which 1-letter username it claimed', 'So the first 30 and first 100 links get their bonus and no Discord account gets it twice.', 'Kept with the Discord ID, also after the Mewvo account is deleted or unlinked, so the bonus is not given again. Ask to have it deleted.')}
${row('Website and dashboard sign-in: a hash of the session ID with your ID, username and avatar (for a Mewvo account: the account and the linked Discord ID)', 'To keep you signed in and protect forms against forgery.', '1 hour for “My record”, 12 hours for the staff dashboard.')}
<!-- OWNER REVIEW: legal text (dashboard server list, multi-server B3) -->
${row('Dashboard server list: when you log in to the dashboard, Mewvo asks Discord for the list of servers you are in (the “guilds” permission). Of that list it keeps only the ID, name and icon of the servers Mewvo is in or that you can manage.', 'Only to show the server picker, so you can choose which server’s dashboard to open. Whether you may open a server is checked again with Discord through the bot each time.', 'Only in the memory of the running server, for up to 12 hours (until your dashboard sign-in ends, or sooner if the bot restarts). It is never written to the database, and the Discord login token used to fetch it is not kept.')}
${row('Dashboard audit log: who changed which setting, from what, to what', 'So the staff team can see and undo changes.', 'As long as the server uses Mewvo.')}
${row('Blocks: accounts or servers blocked from the bot, with the reason', 'To stop abuse of the bot.', 'As history, also after the block is lifted.')}
${row('Technical logs of what the bot did and the errors it hit. They hold IDs, message IDs and message lengths, never message text, and in production never more detail than the “info” level (rarely an IP address in an error).', 'To find and fix problems.', '7 days, error logs 14 days. Anything printed to the console is also kept by the hosting provider’s log store for as long as that provider keeps it.')}
</tbody></table></div>
<!-- OWNER REVIEW: legal text (server data kept after removal, owner decision 2026-11-07) -->
<p><strong>When Mewvo is removed from a server.</strong> “As long as the server uses Mewvo” in the table above includes the time after Mewvo is removed: removing the bot does not delete that server’s data, so its settings, cases and levels are still there if the bot is added back. The data is kept until the server asks for it to be deleted. To ask, ${contactLine(ctx)} and give the server’s ID. The request must come from the owner of the server: Mewvo checks this, then deletes the server’s data within one month. Members can still ask for their own data to be deleted at any time; see “Your rights” below.</p>
<p>If a server turns on logging, events such as joins, leaves, role changes and edited or deleted messages (including their text) are posted to that server’s staff log channels on Discord. Those posts live on Discord, not in Mewvo’s database.</p>

<h2>Why this is allowed (legal bases)</h2>
<ul><li><strong>Providing what you use</strong> (GDPR Art. 6(1)(b)): leveling, tickets, modmail, things you save, plans and keys, and your Mewvo account.</li>
<li><strong>Legitimate interests</strong> (Art. 6(1)(f)): keeping servers safe, enforcing their rules, the staff watchlist, no-contact orders, raid records, preventing ban evasion and abuse, and keeping the bot running. You can object to this; see your rights below.</li>
<li><strong>Legal obligations</strong> (Art. 6(1)(c)): for example, keeping invoices once real payments start, and answering lawful requests from authorities.</li></ul>

<h2>Automatic decisions</h2>
<p>Some decisions are made by the bot without a person in the moment:</p>
<ul><li><strong>Automod</strong> can delete or flag a message, and warn, mute or kick, when a message breaks a rule the server has turned on.</li>
<li><strong>The warning ladder</strong> bans automatically at the third warning and at the later steps.</li>
<li><strong>Raid lockdown</strong> restricts new members while many accounts join at once.</li>
<li><strong>Verification</strong> holds an account that is younger than 7 days, or that matches the network of a banned account, for a person to approve.</li></ul>
<p>Every one of these can be reviewed by a person. An automatic action becomes a normal case with a card in the staff channel, where staff can keep, undo or change it; you can appeal it like any other case, or press “Contest this” in the automod DM. You can also ask for a person to look at the decision and explain your side using the contact above (GDPR Art. 22(3)).</p>

<h2>Who else sees your data</h2>
<ul><li><strong>Discord</strong>, which the bot runs on, is an independent controller of your Discord data. <a href="https://discord.com/privacy" rel="noopener">Discord’s own privacy policy</a> covers what it does with it.</li>
<li><strong>Replit</strong> (Replit, Inc., USA) hosts the bot and this website.</li>
<li><strong>Neon</strong> hosts the database. ${dbRegionText(ctx)}</li>
<li><strong>The staff of the server</strong> you are in see the moderation, appeal, ticket and modmail records of that server.</li></ul>
<p>Replit and Neon process the data only to provide their service, under a data processing agreement. Where data goes to the US, the transfer relies on the EU–US Data Privacy Framework if the provider is certified under it, and otherwise on the European Commission’s Standard Contractual Clauses. You can ask for a copy of these safeguards using the contact above.</p>
<p>A few commands look something up on another service. That service receives only what you typed, never your Discord ID or name:</p>
<ul><li><code>/shorten</code>: the link, sent to is.gd;</li>
<li><code>/weather</code>: the place name, sent to OpenStreetMap Nominatim (to find the place) and MET Norway (api.met.no, for the forecast);</li>
<li><code>/define</code>: the word, sent to dictionaryapi.dev;</li>
<li><code>/hexcolor</code>: the colour code, put into an image link that Discord loads from dummyimage.com.</li></ul>
<p>Nothing is sold or given to anyone else, unless the law requires it.</p>

<h2>Cookies</h2>
<p>This website sets no analytics, advertising or third-party cookies. Each cookie below is either strictly necessary for something you asked for (signing in, a form) or set only when you click a choice, so no cookie banner is needed.</p>
<div class="table-wrap" role="region" aria-labelledby="cookie-title" tabindex="0"><table class="legal-table">
<caption id="cookie-title">Every cookie the website and dashboard set.</caption>
<thead><tr><th scope="col">Cookie</th><th scope="col">Purpose</th><th scope="col">Lifetime</th></tr></thead>
<tbody>
${row(html`<code>mewvo_dash</code>`, 'Keeps you signed in to the staff dashboard.', '12 hours, or until you log out.')}
${row(html`<code>mewvo_dash_state</code>`, 'Protects the Discord sign-in step of the dashboard.', '10 minutes.')}
${row(html`<code>mewvo_me</code>`, 'Keeps you signed in to “My record” and your Mewvo account.', '1 hour, or until you log out.')}
${row(html`<code>mewvo_me_state</code>, <code>mewvo_me_next</code>, <code>mewvo_me_link</code>, <code>mewvo_me_forgot</code>`, 'Protect the Discord sign-in step of “My record”: the check against forgery, the page to return to, linking an account and resetting a password.', '10 minutes.')}
${row(html`<code>mewvo_me_form</code>`, 'Protects the sign-up and log-in forms against forgery.', '2 hours.')}
${row(html`<code>mewvo_me_2fa</code>`, 'Remembers that the password step is done while you enter your two-step code.', '5 minutes.')}
${row(html`<code>mewvo_me_reset</code>`, 'Lets you set a new password after the Discord check.', '10 minutes.')}
${row(html`<code>mewvo_theme</code>`, 'Remembers the light or dark theme you chose in the dashboard. Set only when you click it.', '1 year.')}
${row(html`<code>mewvo_nav</code>`, 'Remembers whether the dashboard sidebar shows all pages. Set only when you click it.', '1 year.')}
${row(html`<code>mewvo_lang</code>`, 'Remembers the website language you chose in the language picker. Set only when you click it.', '1 year.')}
</tbody></table></div>

<h2>Your rights</h2>
<p>Under the GDPR you can ask for:</p>
<ul><li>a copy of the data Mewvo has about you (access, Art. 15), also in a machine-readable form (portability, Art. 20);</li>
<li>wrong data to be corrected (rectification, Art. 16);</li>
<li>your data to be deleted (erasure, Art. 17), or its use to be limited (Art. 18);</li>
<li>your data to no longer be used for a legitimate interest (objection, Art. 21);</li>
<li>a person to review an automatic decision (Art. 22(3)).</li></ul>
${ctx.memberPortal ? html`<p>You can download a copy of your data yourself: log in on <a href="/me">My record</a> and choose <strong>Download my data</strong>. You get a JSON file with what Mewvo stores about your Discord account in every server: levels, economy, cases, appeals and reports, watchlist entries and no-contact orders about you, staff notes on your cases, tickets, modmail, the ticket ratings you gave (staff: the stars and dates of ratings about tickets they handled), giveaway entries, invites, raid entries, verification, plans, your Mewvo account and more. Left out is what would reveal other people, such as who reported something or another member’s message. Evidence excerpts attached to your cases are not in the file yet; ask through the contact address and we send the ones that are yours.</p>
` : ''}<p>To use any of these, ${contactLine(ctx)}. ${cannotReachLine(ctx)} You get an answer within one month. Some safety records, such as an active ban, may be kept for as long as they are still needed to keep a server safe; if so, you are told why.</p>
<p>You can also delete data yourself:</p>
<ul><li>Run <code>/wipedata</code> in a server to delete your levels and XP, your economy balance, your AFK status and your birthday in that server, your personal to-do list and reminders, and your stored Discord login token. It also removes your name and comment from the ticket ratings you gave (the stars stay, without your name). It does not delete moderation records, appeals, reports or the verification history. Levels are kept when you leave a server; if you have left and want them deleted, ${contactLine(ctx)}, or rejoin and run <code>/wipedata</code>.</li>
<li>If you have a Mewvo account, delete it in <strong>Account settings</strong> on the website (your password is needed). This deletes the username, password hash and two-step login at once. A plan and the early-account bonus record stay with your Discord account; ask if you want those deleted too.</li></ul>
<p>If you think your data is handled wrongly, you can complain to the Lithuanian data protection authority, the State Data Protection Inspectorate (Valstybinė duomenų apsaugos inspekcija, VDAI, <a href="https://vdai.lrv.lt" rel="noopener">vdai.lrv.lt</a>), or to the authority of the EU country where you live or work (GDPR Art. 77). Asking Mewvo first is often faster, but you don’t have to.</p>

<h2>Children</h2>
<p>The bot is meant for people old enough to use Discord: at least 13, or older where the law of your country says so. A Mewvo account on this website needs you to be at least 14, the age at which you can agree to online services yourself in Lithuania. When you create an account you enter your date of birth; it is only used to check your age and is not saved. Mewvo does not knowingly collect data about anyone younger. If you think it has, ${contactLine(ctx)} and it will be deleted.</p>

<h2>Security</h2>
<p>Sign-in tokens are encrypted, IP addresses are only stored as keyed hashes, session IDs are only stored as hashes, passwords only as scrypt hashes, two-step login secrets only encrypted, recovery codes only as hashes, the database connection uses TLS, and staff permissions are checked again on every action.</p>

<h2>Changes</h2>
<p>When what Mewvo stores changes, this page is updated along with the date at the top. Bigger changes are also announced in ${supportLink(ctx)}.</p></div>`,
    });
}

export function termsPage(ctx) {
    const operator = ctx.legal?.operator;
    return layout(ctx, {
        title: 'Terms and Conditions', active: 'terms', path: '/terms',
        description: 'The rules for using the Mewvo bot, its website and its plans.',
        body: html`<div class="wrap page prose"><h1>Terms and Conditions</h1>
${updatedLine()}
<p class="lead">The rules for using the Mewvo Discord bot, this website and its plans. By using the free features you accept these terms. A paid plan needs you to accept them at checkout.</p>

<h2>Who runs Mewvo</h2>
<p>${operator ? html`Mewvo is run by ${operator}, a private individual in Lithuania.` : 'Mewvo is run by one private individual in Lithuania, its owner.'} Contact: ${contactLine(ctx)}. The full details are in the <a href="/legal">Legal notice</a>. Mewvo is not made by, affiliated with or endorsed by Discord.</p>

<h2>Who can use it</h2>
<ul><li>The bot: you must be allowed to use Discord, which means at least 13 years old, or older where the law of your country says so, and you must follow <a href="https://discord.com/terms" rel="noopener">Discord’s Terms of Service</a> and <a href="https://discord.com/guidelines" rel="noopener">Community Guidelines</a>.</li>
<li>A Mewvo account on this website: at least 14 years old.</li>
<li>Buying a plan: at least 18 years old, or with the permission of a parent or guardian.</li></ul>

<h2>Using the bot</h2>
<ul><li>Follow the rules of the server you are in.</li>
<li>Don’t use Mewvo to harass anyone, to spam, to share illegal content or to get around a punishment.</li>
<li>Don’t try to break, overload, reverse engineer or misuse the bot, this website or the dashboard, and don’t look for or use security holes. If you find one, please report it privately.</li></ul>

<h2>Content moderation</h2>
<p><strong>Server staff decide, not Mewvo.</strong> Warnings, mutes, kicks and bans in a server are decisions of that server’s staff team; Mewvo carries them out. Automod and the warning ladder follow the rules that server has turned on. The owner of Mewvo is not responsible for the decisions a server’s staff make with it.</p>
<p><strong>What Mewvo itself restricts.</strong> The owner of Mewvo can block an account or a server from using the bot (the bot blocklist), for example for abusing the bot, sharing illegal content through it or breaking these terms. On the Mewvo server itself, its staff moderate under the <a href="/rules">server rules</a>.</p>
<p><strong>Automated tools.</strong> Automod can delete or flag messages and warn, mute or kick; the warning ladder bans automatically at the third warning and later steps; raid lockdown restricts new members during a join raid; verification holds very new accounts and possible ban-evasion accounts for a person to approve. Each automatic action is shown to staff, who can keep, undo or change it.</p>
<p><strong>Human review and complaints.</strong> Every punishment can be reviewed by a person. If a punishment can be appealed, the DM about it says how; for automod, the DM also has “Contest this”. One appeal per case can be open at a time, and staff decide and tell you the result. Some punishments cannot be appealed; the DM says so. To complain about a block by Mewvo itself, or to report illegal content, see <a href="/contact">Contact and reports</a>.</p>

<h2>What you post</h2>
<p>What you write stays yours. You allow Mewvo to store and show it only as far as needed to run the feature you used, for example to show your appeal to staff or your suggestion in the suggestions channel.</p>

<h2>Plans and keys</h2>
<ul><li><strong>No payments are taken yet.</strong> The checkout on this website is a test: no money is charged and no payment details are asked for. A test plan can be ended or removed at any time.</li>
<li>A plan belongs to your Discord account and lasts for the time shown at checkout. It does not renew by itself, so there is nothing to cancel.</li>
<li>Higher limits for a server (tags, sticky messages, feeds, scheduled messages) come from the plan of that server’s owner.</li>
<li>Buying or redeeming a higher plan while one is running converts the time left into the new plan, by price. A lower plan cannot be added while a higher one runs.</li>
<li>A key can be redeemed once, by one account. Gift keys must be redeemed within one year; other keys show their own date, if any. Keys cannot be exchanged for money, except for refunds the law requires.</li>
<li>Keys obtained by fraud or abuse, or plans used to break these terms, can be revoked.</li>
<li>Features marked “Planned” are not built yet and are not part of what a plan gives you today.</li></ul>
<p>Before real payments start, these terms will be updated with the price, taxes and payment, and you will be asked to accept them at checkout. Nothing changes for a test plan you already have.</p>

<h2>Right of withdrawal</h2>
<p>When you buy a paid plan, you can withdraw from the purchase within 14 days without giving a reason. If you asked for the plan to start right away and then withdraw, you get your money back minus the days you already used. How to withdraw, and a form you can use, are on the <a href="/withdrawal">Withdrawal</a> page.</p>

<h2>Being blocked</h2>
<p>If the owner of Mewvo blocks your account or server, the bot answers “You can’t use this bot.” You can ask for the reason and for a person to review the block; see <a href="/contact">Contact and reports</a>. You get the reason and the result of the review. You can stop using Mewvo at any time; see the <a href="/privacy">Privacy Policy</a> for how to have your data deleted.</p>

<h2>Availability</h2>
<p>The free features are provided as they are. Mewvo may change, pause or stop, and it may have errors or be unavailable at times. Important changes are announced in ${supportLink(ctx)}. A paid plan gives you what was described at checkout for the period you paid for.</p>

<h2>Liability</h2>
<p>As far as the law allows, the owner of Mewvo is not liable for indirect damage or lost profits from using or not being able to use Mewvo, and for the free features also not for lost data. Nothing in these terms limits liability that the law does not allow to be limited, such as for intent or gross negligence, or for injury to life, body or health. This does not limit your legal rights as a consumer, including if a paid plan does not work as described.</p>

<h2>Open source</h2>
<p>Mewvo started as a fork of TitanBot, which is open source under the MIT License. That license and its copyright notice are kept with Mewvo’s code.</p>

<h2>Your data</h2>
<p>The <a href="/privacy">Privacy Policy</a> explains what Mewvo stores, why, for how long and how to have it deleted.</p>

<h2>Changes to these terms</h2>
<p>These terms can change. The date at the top shows the latest version, and bigger changes are announced in ${supportLink(ctx)} before they apply.</p>
<ul><li>For the free features, the new terms apply once they are announced and in force.</li>
<li>For a paid plan, terms change only for a valid reason, such as security, a change in the law or new features. You are told in advance and asked to accept the new terms; just continuing to use Mewvo does not count as accepting. If a change makes your paid plan worse, you can end the plan and get a refund for the time left.</li></ul>

<h2>Law and disputes</h2>
<p>These terms are governed by Lithuanian law. If you are a consumer, this does not take away the protection that the mandatory law of the country where you live gives you, and you can bring a claim in the courts where you live.</p>
<p>If we can’t solve a problem together, consumers can turn to the Lithuanian out-of-court consumer dispute body, the State Consumer Rights Protection Authority (Valstybinė vartotojų teisių apsaugos tarnyba, VVTAT, <a href="https://vvtat.lrv.lt" rel="noopener">vvtat.lrv.lt</a>).</p></div>`,
    });
}

/** /legal — the Legal notice (e-Commerce Directive Art. 5): who provides Mewvo and how to reach them. */
export function legalNoticePage(ctx) {
    const legal = ctx.legal || {};
    const anySet = Boolean(legal.operator || legal.address || legal.regNo || legal.vatNo);
    const pending = 'Being added';
    const vat = legal.vatNo || (legal.operator ? 'Not VAT registered' : pending);
    const line = (label, value) => html`<tr><th scope="row">${label}</th><td>${value}</td></tr>`;
    return layout(ctx, {
        title: 'Legal notice', active: 'legal', path: '/legal',
        description: 'Who provides Mewvo and how to reach them.',
        body: html`<div class="wrap page prose"><h1>Legal notice</h1>
${updatedLine()}
<p class="lead">Who provides Mewvo, the Discord bot and this website, and how to reach them.</p>
${anySet ? '' : html`<p><strong>Operator details are being added.</strong> Until then, ${contactLine(ctx)}.</p>`}
<div class="table-wrap" role="region" aria-labelledby="notice-title" tabindex="0"><table class="legal-table">
<caption id="notice-title">Provider details.</caption>
<tbody>
${line('Provider', legal.operator ? `${legal.operator}, a private individual` : pending)}
${line('Address', legal.address || pending)}
${line('Registration or individual activity number', legal.regNo || pending)}
${line('VAT number', vat)}
${line('Email', legal.email ? html`<a href="mailto:${legal.email}">${legal.email}</a>` : html`Being added; until then, ask in ${supportLink(ctx)}`)}
${line('Country', 'Lithuania')}
</tbody></table></div>
<p>Contact for authorities and for users, and how to report illegal content: <a href="/contact">Contact and reports</a>. How data is handled: <a href="/privacy">Privacy Policy</a>. The rules: <a href="/terms">Terms and Conditions</a>.</p>
<p>Mewvo is not made by, affiliated with or endorsed by Discord.</p></div>`,
    });
}

/** /contact — DSA single points of contact (Art. 11, 12) and notices of illegal content (Art. 16). */
export function contactPage(ctx) {
    const email = ctx.legal?.email;
    const emailLink = email ? html`<a href="mailto:${email}">${email}</a>` : null;
    return layout(ctx, {
        title: 'Contact and reports', active: 'contact', path: '/contact',
        description: 'How users and authorities reach Mewvo, and how to report illegal content.',
        body: html`<div class="wrap page prose"><h1>Contact and reports</h1>
${updatedLine()}
<p class="lead">How to reach Mewvo, and how to report illegal content in what Mewvo stores or posts.</p>

<h2>Point of contact</h2>
<p>${emailLink
        ? html`Users (EU Digital Services Act, Art. 12) and authorities of the EU member states, the European Commission and the European Board for Digital Services (Art. 11) can reach Mewvo at ${emailLink}.`
        : html`Users (EU Digital Services Act, Art. 12) and authorities (Art. 11) can reach Mewvo in ${supportLink(ctx)}. An email address for this is being added.`}
Messages are read and answered by a person, not by an automated system. You can write in English or Lithuanian.</p>
<p>For questions about your data, see the <a href="/privacy">Privacy Policy</a>. To appeal a punishment in a server, use the appeal link in the DM you got: those decisions are made by that server’s staff, not by Mewvo.</p>

<h2>Report illegal content</h2>
<p>If something Mewvo stores or posts is illegal, for example a tag, a suggestion, a message the bot posted, or something on this website, ${emailLink ? html`email ${emailLink}` : html`tell us in ${supportLink(ctx)}`} (Digital Services Act, Art. 16). Please include:</p>
<ul><li><strong>Where it is</strong>: the exact link (a Discord message link or a web address) and anything else that helps find it;</li>
<li><strong>Why it is illegal</strong>: a short explanation, and the law it breaks if you know it;</li>
<li><strong>Your name and email address</strong>, except when the report is about child sexual abuse material, which you can report without them;</li>
<li><strong>A statement</strong> that you believe in good faith that the information and claims in your report are accurate and complete.</li></ul>
<p>You get a confirmation that the report arrived. A person reviews it, decides, and tells you the decision and how to contest it. If the content is removed or an account is blocked, the person affected is told why where Mewvo can reach them.</p>
<p>Content in a Discord server that Mewvo did not post is hosted by Discord: report it to the server’s staff and to <a href="https://discord.com/safety" rel="noopener">Discord</a>.</p>

<h2>Threats to life or safety</h2>
<p>If Mewvo becomes aware of information that suggests a criminal offence threatening someone’s life or safety, it informs the police or judicial authorities of the country concerned (Digital Services Act, Art. 18). If someone is in immediate danger, call the emergency number 112.</p>

<p>Who provides Mewvo: <a href="/legal">Legal notice</a>.</p></div>`,
    });
}
