// legal.js — the Privacy Policy and the Terms and Conditions.
//
// Written from what the code stores and does (utils/database/schema.js, oauthVerification.js,
// verificationGuard.js, wipedataService.js, dashboard/security.js, site/memberPortal.js,
// billing/premiumService.js, accounts/accountStore.js, utils/logger.js). Nothing here is invented: when the code changes
// what it stores, change this page and LEGAL_UPDATED with it.
//
// Who runs Mewvo comes from env, never from the code: LEGAL_OPERATOR (a name) and LEGAL_EMAIL
// (a contact address). Without them the pages point to the support server instead.
// This is not legal advice; the owner should have both pages checked before real payments.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';

export const LEGAL_UPDATED = '2026-11-03';
const UPDATED_TEXT = '3 November 2026';

const EMAIL = /^[^\s@<>"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;

/** { operator, email } from env; each null when unset or malformed. */
export function legalContact(env = process.env) {
    const operator = String(env.LEGAL_OPERATOR || '').trim().replace(/\s+/g, ' ');
    const email = String(env.LEGAL_EMAIL || '').trim();
    return {
        operator: operator && operator.length <= 120 ? operator : null,
        email: EMAIL.test(email) ? email : null,
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

function whoLine(ctx) {
    const operator = ctx.legal?.operator;
    return operator
        ? html`Mewvo is run by ${operator}, a private individual, who decides how the data below is used (the “controller” under the GDPR).`
        : 'Mewvo is run by one private individual, its owner, who decides how the data below is used (the “controller” under the GDPR).';
}

const row = (what, why, kept) => html`<tr><th scope="row">${what}</th><td>${why}</td><td>${kept}</td></tr>`;

export function privacyPage(ctx) {
    return layout(ctx, {
        title: 'Privacy Policy', active: 'privacy', path: '/privacy',
        description: 'What the Mewvo bot and website store about you, why, for how long, and your rights.',
        body: html`<div class="wrap page prose"><h1>Privacy Policy</h1>
${updatedLine()}
<p class="lead">What Mewvo stores about you, why, for how long, who else sees it, and how to get a copy or have it deleted. Your data is never sold, never used for advertising and never used to train AI models.</p>

<h2>Who is responsible</h2>
<p>${whoLine(ctx)} To reach them about your data, ${contactLine(ctx)}.</p>

<h2>In short</h2>
<ul><li>Mewvo works with Discord IDs (the numbers that identify accounts, servers and channels). Where a record needs a readable name, such as a moderation case, the username at that moment is saved with it.</li>
<li>Everything is kept in a PostgreSQL database used only by the bot.</li>
<li>The bot never asks for your email address, a password or payment details. A Mewvo account on this website never asks for an email address either: only if you choose to create one, Mewvo stores a username and a one-way hash of your password (see below).</li>
<li>This website has no analytics, no ads, no tracking and no third-party scripts. It sets cookies only to keep you signed in.</li></ul>

<h2>What is stored, why, and for how long</h2>
<div class="table-wrap" role="region" aria-labelledby="data-title" tabindex="0"><table class="legal-table">
<caption id="data-title">Each kind of data, the reason for it and how long it is kept.</caption>
<thead><tr><th scope="col">Data</th><th scope="col">Why</th><th scope="col">Kept</th></tr></thead>
<tbody>
${row('Levels: XP, level and when your last message counted', 'To run leveling and the leaderboards you see on Discord and on this website (server display name, level and total XP). The text of your messages is not saved.', 'Until you run /wipedata or ask for them to be deleted. Leaving the server does not delete them, so your level and level roles come back if you rejoin. If you have left, ask for deletion using the contact under “Who is responsible”, or rejoin and run /wipedata.')}
${row('Moderation cases: code, type, reason, moderator, time, duration, whether it can be appealed, whether the DM arrived, and the edit history', 'To enforce server rules, to show you why you were punished, and to let decisions be checked and appealed.', 'As long as the server uses Mewvo. A case can be voided but stays on record so that decisions can be reviewed. You can ask for an old case to be removed.')}
${row('Evidence attached by staff: message links, a short excerpt of the text, images (re-posted in a staff-only channel)', 'So a case can still be checked if the original message is deleted.', 'With the case.')}
${row('Warning ladder step, per server', 'The automatic steps of the warning ladder.', 'With the cases. It is never reset automatically.')}
${row('Appeals and staff reports: what you write, the decision, who made it, the staff note; a transcript posted to a staff channel', 'To decide your appeal or report and keep a record of the decision.', 'As long as the server uses Mewvo.')}
${row('Tickets and modmail: who opened it, its state, which channel belongs to which member; a transcript posted to a staff channel when it closes', 'To answer you and keep a record of support conversations.', 'As long as the server uses Mewvo.')}
${row('Verification: your account ID and name, encrypted Discord sign-in tokens (AES-256-GCM), what happened and when', 'To check that you are a real member and add you to the support server, so appeal messages still reach you after a ban.', 'Until you ask for deletion.')}
${row('A keyed one-way hash of the IP address you verified from (never the address itself)', 'To spot someone returning on a new account after a ban. A match alone never refuses anyone: a person on the staff team decides.', '60 days, or longer while that account has an active ban on the Mewvo server.')}
${row('Joins and leaves', 'Member statistics for the staff team.', '90 days.')}
${row('Things you choose to save: birthday, AFK message, suggestions and votes, giveaway entries, to-do items', 'To provide the feature you used.', 'Until you remove them, run /wipedata (where it covers them) or ask.')}
${row('Reminders: what you asked to be reminded about, when, and the channel you set it in', 'To send the reminder (by DM, or in that channel if your DMs are closed).', 'Until it is sent, then 30 more days. Delete one any time with /remind delete.')}
${row('Plans and keys: your plan, start and end date, test orders (plan, period, amount), keys you bought or redeemed, and a gift’s “to” name and message', 'To give you the plan you chose and send DMs when it starts and ends.', 'As long as you have an account with Mewvo, or until you ask. When real payments start, invoices are kept as long as tax law requires.')}
${row('Mewvo account on this website (only if you create one): username, a one-way scrypt hash of your password (never the password itself), that you confirmed you are 13 or older and when (never your date of birth), when you accepted the terms, the linked Discord ID and name, when you last logged in and changed your password. No email address. Accounts made before November 2026 may still hold the email address given then.', 'To let you log in with a username and password, reset a forgotten password through your linked Discord account and show your record and plans.', 'Until you delete the account in Account settings. An account that is not linked to Discord within 7 days is deleted automatically.')}
${row('Two-step login (only if you turn it on): the secret of your authenticator app, encrypted (AES-256-GCM), the last code step used, and one-way hashes of your recovery codes', 'To ask for a code when you log in, and to stop a code from being used twice.', 'Until you turn two-step login off or delete the account.')}
${row('Early-account bonus: for each Discord account the first time it is linked, its number in the order of links, whether the 6 months of Pro were given and which 1-letter username it claimed', 'So the first 30 and first 100 links get their bonus and no Discord account gets it twice.', 'Kept with the Discord ID, also after the Mewvo account is deleted or unlinked, so the bonus is not given again. Ask to have it deleted.')}
${row('Website and dashboard sign-in: a hash of the session ID with your ID, username and avatar (for a Mewvo account: the account and the linked Discord ID)', 'To keep you signed in and protect forms against forgery.', '1 hour for “My record”, 12 hours for the staff dashboard.')}
${row('Dashboard audit log: who changed which setting, from what, to what', 'So the staff team can see and undo changes.', 'As long as the server uses Mewvo.')}
${row('Blocks: accounts or servers blocked from the bot, with the reason', 'To stop abuse of the bot.', 'As history, also after the block is lifted.')}
${row('Technical logs of what the bot did and the errors it hit (they can contain IDs and, rarely, an IP address)', 'To find and fix problems.', '7 days, error logs 14 days.')}
</tbody></table></div>
<p>If a server turns on logging, events such as joins, leaves, role changes and edited or deleted messages (including their text) are posted to that server’s staff log channels on Discord. Those posts live on Discord, not in Mewvo’s database.</p>

<h2>Why this is allowed (legal bases)</h2>
<ul><li><strong>Providing what you use</strong> (GDPR Art. 6(1)(b)): leveling, tickets, modmail, things you save, plans and keys, and your Mewvo account.</li>
<li><strong>Legitimate interests</strong> (Art. 6(1)(f)): keeping servers safe, enforcing their rules, preventing ban evasion and abuse, and keeping the bot running. You can object to this; see your rights below.</li>
<li><strong>Legal obligations</strong> (Art. 6(1)(c)): for example, keeping invoices once real payments start.</li></ul>

<h2>Automatic decisions</h2>
<p>Automod can warn, mute or kick automatically when a message breaks a rule the server has turned on, and the warning ladder bans automatically after the third warning. Every automatic action becomes a normal case with a card in the staff channel, where a person can keep, undo or change it, and you can appeal it the same way as any other case.</p>

<h2>Who else sees your data</h2>
<ul><li><strong>Discord</strong>, which the bot runs on. <a href="https://discord.com/privacy" rel="noopener">Discord’s own privacy policy</a> covers what it does with your data.</li>
<li><strong>The hosting provider</strong> that runs the bot and the <strong>database provider</strong> that stores its data. They process it only to provide their service.</li>
<li><strong>The staff of the server</strong> you are in see the moderation, appeal, ticket and modmail records of that server.</li></ul>
<p>Some of these providers may process data outside the EU and EEA. Where they do, they rely on the safeguards the GDPR requires, such as the European Commission’s standard contractual clauses. Nothing is sold or given to anyone else, unless the law requires it.</p>

<h2>Cookies</h2>
<p>The website only sets cookies that are needed to sign in and stay signed in: a session cookie, and short-lived cookies that protect the sign-in forms, the Discord sign-in step and the two-step login step. They are not used for tracking and are deleted when you sign out or when they expire. Because they are strictly necessary, no cookie banner is needed. Your theme choice in the dashboard is a cookie too.</p>

<h2>Your rights</h2>
<p>Under the GDPR you can ask for:</p>
<ul><li>a copy of the data Mewvo has about you (access, Art. 15), also in a machine-readable form (portability, Art. 20);</li>
<li>wrong data to be corrected (Art. 16);</li>
<li>your data to be deleted (Art. 17), or its use to be limited (Art. 18);</li>
<li>your data to no longer be used for a legitimate interest (objection, Art. 21).</li></ul>
${ctx.memberPortal ? html`<p>You can download a copy of your data yourself: log in on <a href="/me">My record</a> and choose <strong>Download my data</strong>. You get a JSON file with everything Mewvo stores about your account, except what would reveal other people, such as staff notes or who reported something.</p>
` : ''}<p>To use any of these, ${contactLine(ctx)}. You get an answer within one month. Some safety records, such as an active ban, may be kept for as long as they are still needed to keep a server safe; if so, you are told why.</p>
<p>If you have a Mewvo account, you can delete it yourself in <strong>Account settings</strong> on the website (your password is needed). This deletes the username, password hash and two-step login at once. A plan and the early-account bonus record stay with your Discord account; ask if you want those deleted too.</p>
<p>You can also delete some data yourself: run <code>/wipedata</code> in a server to delete your levels and XP, your economy balance, your AFK status and your birthday in that server, and your personal to-do list and reminders. It does not delete moderation records, appeals, reports or verification records. Levels are kept when you leave a server; if you have left and want them deleted, ${contactLine(ctx)}, or rejoin and run <code>/wipedata</code>.</p>
<p>If you think your data is handled wrongly, you can complain to the data protection authority of the EU country where you live or work, or where the problem happened.</p>

<h2>Children</h2>
<p>Mewvo is meant for people old enough to use Discord: at least 13, or older where the law of your country says so. To create a Mewvo account you enter your date of birth; it is only used to check that you are 13 or older and is not saved. It does not knowingly collect data about anyone younger. If you think it has, ${contactLine(ctx)} and it will be deleted.</p>

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
<p class="lead">The rules for using the Mewvo Discord bot, this website and its plans. By using any of them you accept these terms. If you don’t, please don’t use them.</p>

<h2>Who runs Mewvo</h2>
<p>${operator ? html`Mewvo is run by ${operator}, a private individual.` : 'Mewvo is run by one private individual, its owner.'} Contact: ${contactLine(ctx)}. Mewvo is not made by, affiliated with or endorsed by Discord.</p>

<h2>Who can use it</h2>
<p>You must be allowed to use Discord, which means at least 13 years old, or older where the law of your country says so, and you must follow <a href="https://discord.com/terms" rel="noopener">Discord’s Terms of Service</a> and <a href="https://discord.com/guidelines" rel="noopener">Community Guidelines</a>.</p>

<h2>Using the bot</h2>
<ul><li>Follow the rules of the server you are in.</li>
<li>Don’t use Mewvo to harass anyone, to spam, to share illegal content or to get around a punishment.</li>
<li>Don’t try to break, overload, reverse engineer or misuse the bot, this website or the dashboard, and don’t look for or use security holes. If you find one, please report it privately.</li></ul>

<h2>Moderation decisions</h2>
<p>Mewvo carries out what a server’s staff decide. Warnings, mutes, kicks and bans are decisions of that server’s staff team; automod and the warning ladder follow the rules that server has set. The owner of Mewvo is not responsible for decisions a server’s staff make with it.</p>

<h2>Appeals</h2>
<p>If a punishment can be appealed, the DM about it says how. One appeal per case can be open at a time, and staff decide and tell you the result. Some punishments cannot be appealed; the DM says so.</p>

<h2>What you post</h2>
<p>What you write stays yours. You allow Mewvo to store and show it only as far as needed to run the feature you used, for example to show your appeal to staff or your suggestion in the suggestions channel.</p>

<h2>Plans and keys</h2>
<ul><li><strong>No payments are taken yet.</strong> The checkout on this website is a test: no money is charged and no payment details are asked for. A test plan can be ended or removed at any time.</li>
<li>A plan belongs to your Discord account and lasts for the time shown at checkout. It does not renew by itself.</li>
<li>Higher limits for a server (tags, sticky messages, feeds, scheduled messages) come from the plan of that server’s owner.</li>
<li>Buying or redeeming a higher plan while one is running converts the time left into the new plan, by price. A lower plan cannot be added while a higher one runs.</li>
<li>A key can be redeemed once, by one account. Gift keys must be redeemed within one year; other keys show their own date, if any. Keys cannot be exchanged for money.</li>
<li>Keys obtained by fraud or abuse, or plans used to break these terms, can be revoked.</li>
<li>Features marked “Planned” are not built yet and are not part of what a plan gives you today.</li></ul>
<p>Before real payments start, these terms will be updated with the price, taxes, payment, renewal, cancellation and your right of withdrawal, and you will be asked to accept them at checkout. Nothing changes for a test plan you already have.</p>

<h2>Being blocked</h2>
<p>The owner of Mewvo can block an account or a server from using the bot, for example for abusing it or breaking these terms. You can stop using Mewvo at any time; see the <a href="/privacy">Privacy Policy</a> for how to have your data deleted.</p>

<h2>Availability</h2>
<p>Mewvo is provided as it is. It may change, pause or stop, and it may have errors or be unavailable at times. Important changes are announced in ${supportLink(ctx)}.</p>

<h2>Liability</h2>
<p>As far as the law allows, the owner of Mewvo is not liable for indirect damage, lost data or lost profits from using or not being able to use Mewvo. Nothing in these terms limits liability that the law does not allow to be limited, such as for intent or gross negligence, or for injury to life, body or health, and nothing takes away your rights as a consumer under the law of the country where you live.</p>

<h2>Open source</h2>
<p>Mewvo started as a fork of TitanBot, which is open source under the MIT License. That license and its copyright notice are kept with Mewvo’s code.</p>

<h2>Your data</h2>
<p>The <a href="/privacy">Privacy Policy</a> explains what Mewvo stores, why, for how long and how to have it deleted.</p>

<h2>Changes to these terms</h2>
<p>These terms can change. The date at the top shows the latest version, and bigger changes are announced in ${supportLink(ctx)} before they apply. If you keep using Mewvo after that, the new terms apply.</p></div>`,
    });
}
