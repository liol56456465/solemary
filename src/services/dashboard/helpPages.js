// helpPages.js: two pages for people new to running a Discord server.
//   /dashboard/help   "Words explained": the Discord and Mewvo words the dashboard uses.
//   /dashboard/setup  the Getting started steps (overview.js gettingStarted), one at a time, each
//                     with its state and a small form for its one setting (setupForms.js).

import { html, layout, path, raw } from './html.js';
import { dashboardText, textFor } from './language.js';
import { permissionsList } from './overview.js';
import { setupStepForm } from './setupForms.js';

/** The words, in the order someone new meets them. [term, explanation, optional page link]. */
export const GLOSSARY = Object.freeze([
    { group: 'Discord basics', key: 'basics', words: [
        ['Server', 'Your Discord community. Mewvo works in one main server and an optional support server.'],
        ['Channel', 'A place to talk inside the server, like #general. Text channels hold messages, voice channels hold calls.'],
        ['Category', 'A folder that groups channels in the channel list. Mewvo puts tickets and appeals in their own categories.'],
        ['Thread', 'A short side conversation that hangs off one message in a channel.'],
        ['Role', 'A label you give members, like "Moderator" or "Level 10". Roles decide what members can see and do, and can give a name colour.'],
        ['Permission', 'One thing a role allows, like "Manage Messages" or "Ban Members". Channels can change permissions for a role.'],
        ['Administrator', 'The permission that allows everything. In Mewvo, only people with it can change settings or punish members.'],
        ['DM', 'A direct message: a private chat between two people, or between a member and Mewvo. Members can turn DMs from servers off.'],
        ['Mention', 'A name with @ in front, like @Sam. It sends that person a notification. Mewvo never mentions @everyone from text people type.'],
        ['Slash command', 'A command you start by typing / in the message box, like /rank. Discord shows a list as you type.'],
        ['Embed', 'A message box with a coloured edge, a bold title and text. Bots use them for tidy messages.'],
        ['ID', 'A long number Discord gives every server, channel, role and person. Turn on Developer Mode in Discord (Settings, Advanced), then right-click something and choose Copy ID.'],
    ] },
    { group: 'Keeping the server safe', key: 'safety', words: [
        ['Warn', 'A written warning. The member gets a DM. Three warnings lead to a ban by themselves (see warn ladder).', '/enforcement'],
        ['Mute', 'The member stays in the server but cannot write or talk, for a set time. Mewvo does this with a "Muted" role.', '/enforcement'],
        ['Timeout', 'Discord\'s own short mute, at most 28 days. Mewvo\'s mute uses a role instead, so it can last longer.'],
        ['Kick', 'Removes the member from the server. They can come back with an invite. Mewvo sends them a new invite.'],
        ['Ban', 'Removes the member and stops them from coming back, for a set time or for good.', '/bans'],
        ['Case', 'The record of one warning, mute, kick or ban: who, why, when and by whom.', '/cases'],
        ['Case code', 'A short code like "k7fq2" that names one case. Members use it when they appeal.'],
        ['Warn ladder', 'What happens as warnings add up: warning 3 is a 7-day ban, the next one after that is 30 days, then a permanent ban.', '/docs/warnings'],
        ['Appeal', 'A member asking staff to lift or shorten a punishment. Staff accept or deny it.', '/appeals'],
        ['Automod', 'Mewvo checking messages by itself and removing spam, bad words, invite links and raids.', '/automod'],
        ['Review card', 'A short message Mewvo posts for staff when automod does something, with buttons to keep it or undo it.'],
        ['Raid', 'Many new accounts joining at once to spam. When Mewvo sees one, it can make joining harder for a while (a lockdown).'],
        ['Mod log', 'A staff-only channel where Mewvo writes down every punishment, so everyone can look back later.'],
        ['Audit log', 'A list of every change made on this dashboard: who changed which setting, and when.', '/audit'],
    ] },
    { group: 'Mewvo moderation words', key: 'moderation', words: [
        ['Remove case', 'For a case given by mistake. Mewvo lifts what is still in effect, DMs the member, and the case stops counting. It stays on record, marked "Removed". (The slash command is /case remove.)', '/cases'],
        ['Lifted early', 'A ban, mute or warning that ended before its time: staff used Unban, Unmute or Remove warn, or accepted an appeal.'],
        ['Warning stage', 'Where a member is on the warn ladder: stage 0 of 3 (no warning ban yet), 1 of 3 (7-day ban), 2 of 3 (30-day ban), 3 of 3 (permanent ban). It does not go back by itself.', '/docs/warnings'],
        ['Can they appeal?', 'Whether the member may ask staff to lift a punishment. Yes for almost everything. No for a severe ban that staff marked so, and for a stage 3 ban after 6 months or after a denied appeal.'],
        ['What staff usually gave for this reason', 'A hint next to a punishment: what staff gave for the same reason in the last 180 days, so members get similar punishments for similar things.'],
        ['Record so far', 'A member\'s counted warnings, warning stage, active punishments and appeals, shown on their member page. Members see their own with the "My record" button on the appeal panel.'],
        ['Extra-watch period after a ban', 'For 7 days after a member comes back from a ban, automod is stricter with them: it starts one punishment step higher, with no friendly notice and no trusted-member leniency. (The slash command is /automod extrawatch.)', '/automod'],
        ['Warn privately first (2 min to fix)', 'For small automod rules: the first time in 30 days, the member gets a private message and 2 minutes to edit or delete the message. If they fix it, nothing else happens.', '/automod'],
        ['Friendly notice for a first small offence', 'A member\'s first small slip in 30 days (caps, odd characters, English only, mild language) gets a short notice instead of a warning.', '/automod'],
        ['Report only (don\'t delete)', 'An automod mode: staff get a review card about the message, but nothing is deleted and nobody is punished until staff apply it. Good for trying a rule out.', '/automod'],
        ['Keep apart', 'Staff ask two members to leave each other alone until a set time. Mentions and replies between them are removed. It is not a punishment and does not count as a warning.', '/nocontact'],
        ['Safety limit: too many bans or kicks in 10 minutes', 'By default, if one moderator bans or kicks more than 5 members in 10 minutes (mutes: 10), Mewvo stops them for an hour and tells the bot owner. Owners can change these numbers. It protects the server if a moderator account is misused.', '/staff'],
        ['Show what changed', 'A button on a staff alert after many channels or roles were deleted: it compares the last server backup with the server now, so you can put things back with /backup revert.'],
    ] },
    { group: 'Talking with members', key: 'members', words: [
        ['Ticket', 'A private channel where one member talks with staff, opened with a button.', '/tickets'],
        ['Modmail', 'A member sends Mewvo a DM, and staff answer it in a private channel. Mewvo passes the messages back and forth.', '/tickets'],
        ['Support server', 'A second, small server where banned members can still appeal, since they cannot see the main one.', '/support'],
        ['Inbox', 'This dashboard\'s list of everything waiting for staff: appeals, tickets, modmail and automod reviews.', '/inbox'],
    ] },
    { group: 'Fun and community', key: 'fun', words: [
        ['XP and levels', 'Members earn points (XP) for chatting. Enough XP is a new level, and levels can give roles.', '/leveling'],
        ['Reaction roles', 'A message with buttons or a menu where members pick roles for themselves, like "Gamer" or "News".', '/reaction-roles'],
        ['Verification', 'New members press a button to show they are a real person before they can chat.', '/verification'],
        ['Plan', 'Mewvo is free. Paid plans (Normal, Pro, Max) raise some limits. The server owner\'s plan counts for the server.'],
    ] },
]);

const anchor = (term) => `w-${term.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
// Links to the website (/docs/...) stay as they are; the rest are dashboard pages.
const linkFor = (target) => (target.startsWith('/docs/') ? target : path(target));
/** "Can they appeal?" → "canTheyAppeal": a word's key in help.json (help.words.<key>.term / .text). */
export const wordKey = (term) => term.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join('');

export function glossaryPage({ session, access = null, moduleStates = {} }) {
    const tr = dashboardText(session?.lang);
    const body = html`<header class="page-head"><h1>${tr.t('help.glossary.title')}</h1>
<p>${tr.t('help.glossary.intro')}</p></header>
${GLOSSARY.map((g) => html`<section class="plain-section"><h2>${tr.t(`help.groups.${g.key}`)}</h2><dl class="glossary">${g.words.map(([term, , target]) => html`<dt id="${anchor(term)}">${tr.t(`help.words.${wordKey(term)}.term`)}</dt><dd>${tr.t(`help.words.${wordKey(term)}.text`)}${target ? html` <a href="${linkFor(target)}">${tr.t('help.glossary.open')}</a>` : ''}</dd>`)}</dl></section>`)}`;
    return layout({ title: tr.t('help.glossary.title'), active: 'help', session, access, moduleStates, body });
}

/** The step to show: 1-based ?step= or a step key (?step=permissions), else the first open one, else 1. */
export function stepNumber(query, steps) {
    const raw = String(query?.step ?? '');
    const byKey = steps.findIndex((s) => s.key && s.key === raw);
    if (byKey !== -1) return byKey + 1;
    const n = /^\d{1,3}$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= steps.length) return n;
    const open = steps.findIndex((s) => !s.done);
    return open === -1 ? 1 : open + 1;
}

/**
 * The step's own part: the permission list (read-only), or a small form for its one setting
 * (setupForms.js, posting to the module's save route), or only the link to its page.
 */
function stepBody(step, { ctx, forms }, tr = textFor(ctx || {})) {
    if (step.key === 'permissions') {
        return html`${permissionsList(step.report || null, textFor(ctx || {}))}
<p class="muted">${tr.ti('help.setup.checkAgain', { href: path('/setup?step=permissions') })}</p>`;
    }
    const form = ctx ? setupStepForm(ctx, step, forms) : null;
    if (!form) {
        return html`<p>${step.done ? html`<b class="ok-text">${tr.t('help.setup.done')}</b> ${tr.t('help.setup.changeOnPage')}` : tr.t('help.setup.ownPage')}</p>
<p><a class="btn primary" href="${step.href}">${step.done ? tr.t('help.setup.openSetting') : tr.t('help.setup.setUp')}</a></p>`;
    }
    return html`<p>${step.done ? html`<b class="ok-text">${tr.t('help.setup.done')}</b> ${tr.t('help.setup.changeHere')}` : tr.t('help.setup.pickHere')}</p>
${form}
<p class="muted">${tr.ti('help.setup.moreSettings', { href: step.href })}</p>`;
}

/**
 * One setup step at a time; `steps` is the Getting started checklist, or null when unreadable.
 * `ctx` + `forms` (routes.js: the module context and setupStepData) give the step its form.
 */
export function setupPage({ session, access = null, moduleStates = {}, steps, query = {}, ctx = null, forms = null, flash = null }) {
    const tr = dashboardText(session?.lang);
    const title = tr.t('frame.nav.items.setup');
    if (!steps) {
        const body = html`<header class="page-head"><h1>${title}</h1></header><p class="error" role="alert">${tr.t('help.setup.unreadable')}</p>`;
        return layout({ title, active: 'setup', session, access, moduleStates, body });
    }
    const n = stepNumber(query, steps);
    const step = steps[n - 1];
    const done = steps.filter((s) => s.done).length;
    const link = (k, text) => html`<a class="btn" href="${path(`/setup?step=${k}`)}">${text}</a>`;
    const body = html`<header class="page-head"><h1>${title}</h1>
<p>${tr.t('help.setup.progress', { done: tr.fmtNumber(done), total: tr.fmtNumber(steps.length) })}</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
<section class="plain-section setup-step"><p class="muted">${tr.t('help.setup.stepOf', { n: tr.fmtNumber(n), total: tr.fmtNumber(steps.length) })}</p><h2>${step.label}</h2><p>${step.hint}</p>
${stepBody(step, { ctx, forms }, tr)}
<p class="setup-nav">${n > 1 ? link(n - 1, tr.t('help.setup.back')) : ''} ${n < steps.length ? link(n + 1, step.done ? tr.t('help.setup.next') : tr.t('help.setup.skip')) : html`<a class="btn" href="${path('/overview')}">${tr.t('help.setup.finish')}</a>`}</p></section>
<section class="plain-section"><h2>${tr.t('help.setup.allSteps')}</h2><ol class="setup-all">${steps.map((s, i) => html`<li><a href="${path(`/setup?step=${i + 1}`)}"${i + 1 === n ? raw(' aria-current="step"') : ''}>${s.label}</a>${s.done ? tr.t('help.setup.doneMark') : ''}</li>`)}</ol>
<p class="muted">${tr.ti('help.setup.newWords', { href: path('/help') })}</p></section>`;
    return layout({ title, active: 'setup', session, access, moduleStates, body });
}
