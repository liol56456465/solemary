// mockups.js — HTML/CSS pictures of the real product for the website: the DMs the bot sends,
// the appeal form, the /enforcements panel, an automod review card, a modmail channel and the
// warning ladder. The wording is copied from the code (enforcement/dmTemplates.js,
// handlers/appealsHandler.js, handlers/enforcementPanel.js, automod/reviewFormat.js);
// names, codes and times are made up. No images, no inline styles: classes in site.css.
// Discord's <t:…:F> / <t:…:R> timestamps are shown as the text a member would see.
// Text: src/content/site/<lang>/mockups.json. Every mock takes the page context first (for its
// language); called without one it is English.

import { html } from '../../dashboard/html.js';
import { textOf } from '../i18n.js';
import { LOGO } from '../shell.js';

/** The support invite as text in a mock (the real one when set, else a placeholder). */
const inviteText = (ctx) => ctx?.supportInvite || 'https://discord.gg/…';

/** A Discord message from the bot: avatar, name, APP tag, time, then the lines. */
function botMessage(ctx, lines, { time = null } = {}) {
    const { t } = textOf(ctx);
    return html`<div class="dc-msg"><span class="dc-avatar" aria-hidden="true">${LOGO}</span><div class="dc-content">
<p class="dc-meta"><span class="dc-name">${t('common.brand')}</span><span class="dc-app">${t('mockups.bot.appTag')}</span><span class="dc-time">${time ?? t('mockups.bot.timeToday')}</span></p>
${lines}</div></div>`;
}

function frame(label, body, { className = '', caption = '' } = {}) {
    return html`<figure class="mock${className ? ` ${className}` : ''}"><div class="mock-bar"><span class="mock-label">${label}</span></div>
<div class="dc">${body}</div>${caption ? html`<figcaption class="mock-caption">${caption}</figcaption>` : ''}</figure>`;
}

/** The lines every punishment DM starts and ends with: appeal link, date, case code. */
function dmParts(ctx) {
    const { ti } = textOf(ctx);
    return {
        appealHere: html`<p>${ti('mockups.dm.appealHere', { invite: html`<span class="dc-link">${inviteText(ctx)}</span>` })}</p>`,
        stamp: (text) => html`<span class="dc-stamp">${text}</span>`,
        date: (text) => html`<p>${ti('mockups.dm.date', { date: html`<span class="dc-stamp">${text}</span>` })}</p>`,
        caseCode: (code) => html`<p>${ti('mockups.dm.caseCode', { code: html`<code class="dc-code">${code}</code>` })}</p>`,
    };
}

/** Warning 2 of 3: dmTemplates.warnDm. */
export function warnDmMock(ctx = {}, { caption = '' } = {}) {
    const { t, ti } = textOf(ctx);
    const dm = dmParts(ctx);
    return frame(t('mockups.dm.frameLabel'), botMessage(ctx, html`${dm.appealHere}
<p>${ti('mockups.warnDm.title')}</p>
<p>${t('mockups.warnDm.by')}</p>
<p>${t('mockups.warnDm.reason')}</p>
${dm.date(t('mockups.warnDm.dateValue'))}
${dm.caseCode('k7xq2')}
<p>${t('mockups.warnDm.limit')}</p>`), { className: 'mock-dm', caption });
}

/** The automatic 7-day ban on the third warning: dmTemplates.banDm for a ladder ban. */
export function banDmMock(ctx = {}, { caption = '' } = {}) {
    const { t, ti } = textOf(ctx);
    const dm = dmParts(ctx);
    return frame(t('mockups.dm.frameLabel'), botMessage(ctx, html`${dm.appealHere}
<p>${ti('mockups.banDm.title')}</p>
<p>${t('mockups.banDm.by')}</p>
<p>${t('mockups.banDm.reason')}</p>
${dm.date(t('mockups.banDm.dateValue'))}
<p>${ti('mockups.banDm.duration', { end: dm.stamp(t('mockups.banDm.endValue')), relative: dm.stamp(t('mockups.banDm.relativeValue')) })}</p>
${dm.caseCode('w8hd3a')}
<p>${t('mockups.banDm.ladderNote')}</p>`, { time: t('mockups.banDm.time') }), { className: 'mock-dm', caption });
}

/** The appeal form: appealsHandler.appealModal. */
export function appealFormMock(ctx = {}, { caption = '' } = {}) {
    const { t } = textOf(ctx);
    const field = (label, description, value, { tall = false, required = true, placeholder = false } = {}) => html`<div class="dc-field"><p class="dc-field-label">${label}${required ? html`<span class="dc-req" aria-hidden="true"> *</span>` : ''}</p>
<p class="dc-field-help">${description}</p><p class="dc-input${tall ? ' dc-input-tall' : ''}${placeholder ? ' dc-input-empty' : ''}">${value}</p></div>`;
    const f = (name, part) => t(`mockups.appealForm.${name}.${part}`);
    return html`<figure class="mock mock-modal"><div class="mock-bar"><span class="mock-label">${t('mockups.appealForm.frameLabel')}</span></div>
<div class="dc dc-modal"><p class="dc-modal-title">${t('mockups.appealForm.title')}</p>
${field(f('reason', 'label'), f('reason', 'help'), f('reason', 'example'), { tall: true })}
${field(f('caseCode', 'label'), f('caseCode', 'help'), 'w8hd3a')}
${field(f('moreInfo', 'label'), f('moreInfo', 'help'), '', { tall: true, required: false, placeholder: true })}
<p class="dc-modal-actions"><span class="dc-btn dc-btn-link">${t('mockups.appealForm.cancel')}</span><span class="dc-btn dc-btn-primary">${t('mockups.appealForm.submit')}</span></p></div>
${caption ? html`<figcaption class="mock-caption">${caption}</figcaption>` : ''}</figure>`;
}

/** The ladder steps in order (catalog keys under mockups.ladder.steps); the bans are drawn stronger. */
const LADDER_STEPS = [['warn1', false], ['warn2', false], ['warn3', true], ['level2', true], ['level3', true]];

/** The warning ladder as a list of steps (enforcementConfig: 3 warns, 7 days, 30 days, permanent). */
export function ladderMock(ctx = {}, { caption = '' } = {}) {
    const { t } = textOf(ctx);
    const s = (name, part) => t(`mockups.ladder.steps.${name}.${part}`);
    const step = (name, strong) => html`<li class="ladder-step${strong ? ' is-ban' : ''}"><span class="ladder-key">${s(name, 'key')}</span><span class="ladder-what">${s(name, 'what')}</span><span class="ladder-result">${s(name, 'result')}</span></li>`;
    return html`<figure class="mock mock-ladder"><div class="mock-bar"><span class="mock-label">${t('mockups.ladder.frameLabel')}</span></div>
<ol class="ladder">
${LADDER_STEPS.map(([name, strong]) => html`${step(name, strong)}\n`)}</ol>${caption ? html`<figcaption class="mock-caption">${caption}</figcaption>` : ''}</figure>`;
}

/**
 * The dashboard: real screenshots (rendered locally from the dashboard's own page code with
 * made-up data). Always the dark one: the site is dark gray in every colour scheme. No text of
 * its own: the caller passes `alt` and `caption` from its catalog.
 */
export function dashboardShot({ name = 'overview', alt, caption = '', eager = false } = {}) {
    return html`<figure class="shot"><img src="/img/screen-${name}-dark.webp" width="1280" height="800" alt="${alt}"${eager ? '' : html` loading="lazy"`} decoding="async">${caption ? html`<figcaption class="mock-caption">${caption}</figcaption>` : ''}</figure>`;
}
