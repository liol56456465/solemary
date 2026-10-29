// mockups.js — HTML/CSS pictures of the real product for the website: the DMs the bot sends,
// the appeal form, the /enforcements panel, an automod review card, a modmail channel and the
// warning ladder. The wording is copied from the code (enforcement/dmTemplates.js,
// handlers/appealsHandler.js, handlers/enforcementPanel.js, automod/reviewFormat.js);
// names, codes and times are made up. No images, no inline styles: classes in site.css.
// Discord's <t:…:F> / <t:…:R> timestamps are shown as the text a member would see.

import { html } from '../../dashboard/html.js';
import { LOGO } from '../shell.js';

/** The support invite as text in a mock (the real one when set, else a placeholder). */
const inviteText = (ctx) => ctx.supportInvite || 'https://discord.gg/…';

/** A Discord message from the bot: avatar, name, APP tag, time, then the lines. */
function botMessage(lines, { time = 'Today at 14:05' } = {}) {
    return html`<div class="dc-msg"><span class="dc-avatar" aria-hidden="true">${LOGO}</span><div class="dc-content">
<p class="dc-meta"><span class="dc-name">Mewvo</span><span class="dc-app">APP</span><span class="dc-time">${time}</span></p>
${lines}</div></div>`;
}

function frame(label, body, { className = '', caption = '' } = {}) {
    return html`<figure class="mock${className ? ` ${className}` : ''}"><div class="mock-bar"><span class="mock-label">${label}</span></div>
<div class="dc">${body}</div>${caption ? html`<figcaption class="mock-caption">${caption}</figcaption>` : ''}</figure>`;
}

/** Warning 2 of 3: dmTemplates.warnDm. */
export function warnDmMock(ctx, { caption = '' } = {}) {
    return frame('Direct message · Mewvo', botMessage(html`<p><strong>Appeal here:</strong> <span class="dc-link">${inviteText(ctx)}</span></p>
<p><strong>Warning 2 of 3 in Mewvo</strong></p>
<p>By: mira</p>
<p>Reason: Spam in #general</p>
<p>Date: <span class="dc-stamp">Thursday, 29 October 2026 at 14:05</span></p>
<p>Case code: <code class="dc-code">k7xq2</code></p>
<p>At 3 warnings you will be banned.</p>`), { className: 'mock-dm', caption });
}

/** The automatic 7-day ban on the third warning: dmTemplates.banDm for a ladder ban. */
export function banDmMock(ctx, { caption = '' } = {}) {
    return frame('Direct message · Mewvo', botMessage(html`<p><strong>Appeal here:</strong> <span class="dc-link">${inviteText(ctx)}</span></p>
<p><strong>Banned from Mewvo</strong></p>
<p>By: Mewvo</p>
<p>Reason: Reached warning limit</p>
<p>Date: <span class="dc-stamp">Saturday, 31 October 2026 at 19:40</span></p>
<p>Duration: 7 days — ends <span class="dc-stamp">Saturday, 7 November 2026 at 19:40</span> <span class="dc-stamp">(in 7 days)</span></p>
<p>Case code: <code class="dc-code">w8hd3a</code></p>
<p>Appealing this code also removes the warning that caused this ban.</p>`, { time: 'Saturday at 19:40' }), { className: 'mock-dm', caption });
}

/** The appeal form: appealsHandler.appealModal. */
export function appealFormMock({ caption = '' } = {}) {
    const field = (label, description, value, { tall = false, required = true, placeholder = false } = {}) => html`<div class="dc-field"><p class="dc-field-label">${label}${required ? html`<span class="dc-req" aria-hidden="true"> *</span>` : ''}</p>
<p class="dc-field-help">${description}</p><p class="dc-input${tall ? ' dc-input-tall' : ''}${placeholder ? ' dc-input-empty' : ''}">${value}</p></div>`;
    return html`<figure class="mock mock-modal"><div class="mock-bar"><span class="mock-label">Appeal form · opens from the Appeal button</span></div>
<div class="dc dc-modal"><p class="dc-modal-title">Appeal a punishment</p>
${field('Why should it be lifted?', 'Why should you be unbanned, unmuted or unwarned?', 'I posted the same link three times because I thought it had not sent. I know the rule now and it won’t happen again.', { tall: true })}
${field('Case code', 'From the DM you got when you were punished, e.g. k7m2qx.', 'w8hd3a')}
${field('More info (optional)', 'Anything else the administrators should know.', '', { tall: true, required: false, placeholder: true })}
<p class="dc-modal-actions"><span class="dc-btn dc-btn-link">Cancel</span><span class="dc-btn dc-btn-primary">Submit</span></p></div>
${caption ? html`<figcaption class="mock-caption">${caption}</figcaption>` : ''}</figure>`;
}

/** The /enforcements panel: enforcementPanel.buildPanel (summary lines + action buttons). */
export function enforcementPanelMock({ caption = '' } = {}) {
    return frame('#staff-commands', html`<p class="dc-command"><span class="dc-slash">/enforcements</span> <span class="dc-opt">user</span> <span class="dc-mention">@pixelfox</span></p>
${botMessage(html`<div class="dc-embed"><p class="dc-embed-title">Enforcements — pixelfox</p>
<p><strong>User:</strong> pixelfox (<span class="dc-mention">@pixelfox</span>)</p>
<p><strong>Account created:</strong> <span class="dc-stamp">2 years ago</span></p>
<p><strong>In server:</strong> yes, joined <span class="dc-stamp">5 months ago</span> · 3 roles</p>
<p><strong>Counted warns:</strong> 1 of 3 · <strong>Ladder level:</strong> 0</p>
<p><strong>Active punishment:</strong> none</p>
<p class="dc-embed-field">Last cases (1 of 1)</p>
<p><code class="dc-code">p2nfe</code> <strong>warn</strong> · Off-topic · 12/10/2026 · active</p></div>
<p class="dc-buttons"><span class="dc-btn dc-btn-danger">Ban</span><span class="dc-btn dc-btn-danger">Kick</span><span class="dc-btn dc-btn-primary">Mute</span><span class="dc-btn dc-btn-primary">Warn</span><span class="dc-btn dc-btn-grey">Remove warn</span></p>
<p class="dc-ephemeral">Only you can see this</p>`)}`, { className: 'mock-panel', caption });
}

/** An automod review card in the staff review channel (reviewFormat: Keep / Undo / Change to…). */
export function reviewCardMock({ caption = '' } = {}) {
    return frame('#automod-review', botMessage(html`<div class="dc-embed dc-embed-warn"><p class="dc-embed-title">Warned — Spam</p>
<p><span class="dc-mention">@pixelfox</span> sent 6 messages in 5 seconds in <span class="dc-mention">#general</span>.</p>
<p>1st Spam offence in 30 days.</p>
<p class="dc-embed-field">Message (deleted)</p><p class="dc-quote">anyone up for ranked??</p>
<p class="dc-embed-field">Case</p><p><code class="dc-code">m3kpv</code></p>
<p class="dc-embed-foot">pixelfox</p></div>
<p class="dc-buttons"><span class="dc-btn dc-btn-success">Keep</span><span class="dc-btn dc-btn-danger">Undo</span></p>
<p class="dc-select">Change to…</p>`), { className: 'mock-review', caption });
}

/** A modmail channel: the member's message relayed, a staff reply, and an internal note. */
export function modmailMock({ caption = '' } = {}) {
    const line = (initial, name, tag, text, { note = false } = {}) => html`<div class="dc-msg${note ? ' dc-note' : ''}"><span class="dc-avatar dc-avatar-letter" aria-hidden="true">${initial}</span><div class="dc-content">
<p class="dc-meta"><span class="dc-name">${name}</span>${tag ? html`<span class="dc-app">${tag}</span>` : ''}<span class="dc-time">Today at 09:12</span></p><p>${text}</p></div></div>`;
    return frame('#modmail-nightowl', html`${line('N', 'nightowl_', 'via DM', 'Hi, someone keeps sending me weird links in DMs after I left #trading. Can you look?')}
${line('T', 'tobi', '', 'Thanks for telling us. Can you send the username and a screenshot?')}
${line('M', 'mira', '', '// same account as case r4mzp, checking the join date', { note: true })}`, { className: 'mock-modmail', caption });
}

/** The warning ladder as a list of steps (enforcementConfig: 3 warns, 7 days, 30 days, permanent). */
export function ladderMock({ caption = '' } = {}) {
    const step = (key, what, result, { strong = false } = {}) => html`<li class="ladder-step${strong ? ' is-ban' : ''}"><span class="ladder-key">${key}</span><span class="ladder-what">${what}</span><span class="ladder-result">${result}</span></li>`;
    return html`<figure class="mock mock-ladder"><div class="mock-bar"><span class="mock-label">Warning ladder · per member, per server</span></div>
<ol class="ladder">
${step('Warn 1', 'DM: “Warning 1 of 3”', 'Level 0')}
${step('Warn 2', 'DM: “Warning 2 of 3”', 'Level 0')}
${step('Warn 3', 'Automatic ban', '7 days · level 1', { strong: true })}
${step('Next warn', 'Automatic ban', '30 days · level 2', { strong: true })}
${step('Next warn', 'Permanent ban', 'Appealable for 6 months · level 3', { strong: true })}
</ol>${caption ? html`<figcaption class="mock-caption">${caption}</figcaption>` : ''}</figure>`;
}

/**
 * The dashboard: real screenshots (rendered locally from the dashboard's own page code with
 * made-up data), light and dark, picked by the device's colour scheme without a script.
 */
export function dashboardShot({ name = 'overview', alt, caption = '', eager = false } = {}) {
    return html`<figure class="shot"><picture><source srcset="/img/screen-${name}-dark.webp" media="(prefers-color-scheme: dark)" type="image/webp">
<img src="/img/screen-${name}-light.webp" width="1280" height="800" alt="${alt}"${eager ? '' : html` loading="lazy"`} decoding="async"></picture>${caption ? html`<figcaption class="mock-caption">${caption}</figcaption>` : ''}</figure>`;
}
