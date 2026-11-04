// accountPages.js — the pages of Mewvo accounts on the website (/me/signup, /me/login-password,
// /me/account …). Plain HTML forms that work without JavaScript. Pure: (ctx, values) → page.
// Text: src/content/site/<lang>/account.json (textOf(ctx); English without a language).

import { html, formatDate } from '../dashboard/html.js';
import { layout } from './shell.js';
import { textOf, translator } from './i18n.js';
import { MIN_AGE, PASSWORD_MAX, PASSWORD_MIN, PRO_BONUS_LABEL, PRO_BONUS_LIMIT, USERNAME_MAX, USERNAME_MIN } from '../accounts/accountCore.js';
import { planName } from '../billing/premiumService.js';

const notices = ({ flash = null, error = null }) => html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${error ? html`<p class="error" role="alert">${error}</p>` : ''}`;
const csrfField = (token) => html`<input type="hidden" name="csrf" value="${token}">`;

function when(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? html`<time datetime="${date.toISOString()}">${formatDate(date)}</time>` : '-';
}

// One narrow column in the middle of the page: forms read top to bottom, buttons line up on
// the left edge of the fields.
function page(ctx, title, body) {
    return layout(ctx, { title, active: 'me', body: html`<div class="wrap page"><div class="account">${body}</div></div>` });
}

const field = (id, label, input, hint = '') => html`<div class="form-field"><label for="${id}">${label}</label>${input}${hint ? html`<p class="form-hint" id="${id}-hint">${hint}</p>` : ''}</div>`;

export function signupPage(ctx, { csrf, values = {}, error = null }) {
    const { t, ti } = textOf(ctx);
    return page(ctx, t('account.signup.title'), html`<h1>${t('account.signup.heading')}</h1>
<p class="lead">${t('account.signup.lead')}</p>
${notices({ error })}
<form class="form-stack" method="post" action="/me/signup">${csrfField(csrf)}
${field('su-username', t('account.fields.username'), html`<input id="su-username" name="username" required minlength="${USERNAME_MIN}" maxlength="${USERNAME_MAX}" pattern="[A-Za-z0-9_]+" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="su-username-hint" value="${values.username || ''}">`,
        t('account.signup.usernameHint', { min: USERNAME_MIN, max: USERNAME_MAX }))}
${field('su-password', t('account.fields.password'), html`<input id="su-password" name="password" type="password" required minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" autocomplete="new-password" aria-describedby="su-password-hint">`,
        t('account.fields.passwordHint', { min: PASSWORD_MIN }))}
${field('su-birth', t('account.signup.birthDate'), html`<input id="su-birth" name="birth_date" type="date" required aria-describedby="su-birth-hint" placeholder="${t('account.signup.birthPlaceholder')}">`,
        t('account.signup.birthHint', { age: MIN_AGE }))}
<div class="form-check"><input id="su-accept" name="accept" type="checkbox" value="yes" required><label for="su-accept">${ti('account.signup.accept')}</label></div>
<p class="form-actions"><button class="button" type="submit">${t('account.signup.submit')}</button></p></form>
<p class="note account-foot">${ti('account.signup.haveAccount')}</p>`);
}

export function passwordLoginPage(ctx, { csrf, identifier = '', error = null, flash = null }) {
    const { t, ti } = textOf(ctx);
    return page(ctx, t('account.login.title'), html`<h1>${t('account.login.heading')}</h1>
${notices({ flash, error })}
<form class="form-stack" method="post" action="/me/login-password">${csrfField(csrf)}
${field('li-id', t('account.fields.username'), html`<input id="li-id" name="identifier" required maxlength="${USERNAME_MAX}" autocomplete="username" autocapitalize="none" spellcheck="false" value="${identifier}">`)}
${field('li-password', t('account.fields.password'), html`<input id="li-password" name="password" type="password" required maxlength="${PASSWORD_MAX}" autocomplete="current-password">`)}
<p class="form-actions"><button class="button" type="submit">${t('account.common.logIn')}</button><a href="/me/forgot">${t('account.login.forgot')}</a></p></form>
<ul class="account-links"><li><a href="/me/login">${t('account.login.withDiscord')}</a></li><li>${ti('account.login.noAccount')}</li></ul>`);
}

export function twoStepPage(ctx, { csrf, error = null }) {
    const { t, ti } = textOf(ctx);
    return page(ctx, t('account.twoStep.title'), html`<h1>${t('account.twoStep.heading')}</h1>
<p class="lead">${t('account.twoStep.lead')}</p>
${notices({ error })}
<form class="form-stack" method="post" action="/me/login-2fa">${csrfField(csrf)}
${field('tf-code', t('account.twoStep.code'), html`<input id="tf-code" name="code" required maxlength="20" autocomplete="one-time-code" inputmode="text" autocapitalize="none" spellcheck="false">`)}
<p class="form-actions"><button class="button" type="submit">${t('account.common.logIn')}</button></p></form>
<p class="note account-foot">${ti('account.twoStep.foot')}</p>`);
}

export function forgotPage(ctx, { csrf, error = null }) {
    const { t, ti } = textOf(ctx);
    return page(ctx, t('account.forgot.title'), html`<h1>${t('account.forgot.heading')}</h1>
${notices({ error })}
<p class="lead">${t('account.forgot.lead')}</p>
<form class="form-stack" method="post" action="/me/forgot">${csrfField(csrf)}
<p class="form-actions"><button class="button" type="submit">${t('account.forgot.submit')}</button></p></form>
<p class="note account-foot">${ti('account.forgot.foot')}</p>`);
}

export function resetPage(ctx, { csrf, username, twoStep = false, error = null }) {
    const { t, ti } = textOf(ctx);
    return page(ctx, t('account.reset.title'), html`<h1>${t('account.reset.heading')}</h1>
${notices({ error })}
<p class="lead">${ti('account.reset.lead', { username })}</p>
<form class="form-stack" method="post" action="/me/reset">${csrfField(csrf)}
${field('rp-password', t('account.fields.newPassword'), html`<input id="rp-password" name="password" type="password" required minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" autocomplete="new-password">`, t('account.fields.passwordHint', { min: PASSWORD_MIN }))}
${twoStep ? field('rp-code', t('account.reset.code'), html`<input id="rp-code" name="code" type="text" required maxlength="40" autocomplete="one-time-code" inputmode="text">`, t('account.reset.codeHint')) : ''}
<p class="form-actions"><button class="button" type="submit">${t('account.reset.submit')}</button></p></form>
<p class="note account-foot">${t('account.reset.foot')}</p>`);
}

export function doneLoginPage(ctx, title, message) {
    const { t } = textOf(ctx);
    return page(ctx, title, html`<h1>${title}</h1><p class="lead">${message}</p><p class="form-actions"><a class="button" href="/me/login-password">${t('account.common.logIn')}</a></p>`);
}

export function linkDiscordPage(ctx, { session, account, flash = null, error = null }) {
    const { t, ti } = textOf(ctx);
    const twoStep = Boolean(account.totp_enabled_at);
    return page(ctx, t('account.link.title'), html`<h1>${t('account.link.heading')}</h1>
${notices({ flash, error })}
<p class="lead">${ti('account.link.lead', { username: account.username, bonus: PRO_BONUS_LABEL })}</p>
<div class="form-actions"><form method="post" action="/me/link">${csrfField(session.csrf)}<button class="button" type="submit">${t('account.link.submit')}</button></form>
<form method="post" action="/me/logout">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">${t('account.common.logOut')}</button></form></div>
<p class="note account-foot">${t('account.link.foot')}</p>

<section class="account-section"><h2>${t('account.link.deleteHeading')}</h2>
<form class="form-stack" method="post" action="/me/account/delete">${csrfField(session.csrf)}
${field('dl-password', t('account.fields.password'), html`<input id="dl-password" name="password" type="password" required maxlength="${PASSWORD_MAX}" autocomplete="current-password">`)}
${twoStep ? field('dl-code', t('account.fields.codeOrRecovery'), html`<input id="dl-code" name="code" required maxlength="20" autocomplete="one-time-code" autocapitalize="none" spellcheck="false">`) : ''}
<div class="form-check"><input id="dl-sure" name="sure" type="checkbox" value="yes" required><label for="dl-sure">${t('account.delete.confirm')}</label></div>
<p class="form-actions"><button class="button button-danger" type="submit">${t('account.delete.submit')}</button></p></form></section>`);
}

function letterForm(t, session, letters) {
    if (!letters.length) return html`<p>${t('account.letter.allTaken')}</p>`;
    return html`<form method="post" action="/me/letter">${csrfField(session.csrf)}
<fieldset class="letter-grid"><legend>${t('account.letter.pick')}</legend><div class="letter-tiles">${letters.map((letter, i) => html`<label class="letter-choice"><input type="radio" name="letter" value="${letter}"${i === 0 ? html` required` : ''}><span>${letter}</span></label>`)}</div></fieldset>
<p class="form-actions"><button class="button" type="submit">${t('account.letter.claim')}</button></p></form>
<form class="letter-decline" method="post" action="/me/letter/decline">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">${t('account.letter.decline')}</button></form>
<p class="note account-foot">${t('account.letter.foot')}</p>`;
}

export function linkedPage(ctx, { session, account, flash, offer = null }) {
    const { t, ti } = textOf(ctx);
    return page(ctx, t('account.linked.title'), html`<h1>${t('account.linked.heading')}</h1>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${offer ? html`<section class="account-section"><h2>${t('account.letter.heading')}</h2>${letterForm(t, session, offer.letters)}</section>` : ''}
<section class="account-section"><p class="form-actions"><a class="button${offer ? ' button-quiet' : ''}" href="/me">${t('account.linked.toRecord')}</a><a class="button button-quiet" href="/me/account">${t('account.common.accountSettings')}</a></p>
<p class="note">${ti('account.common.loggedInAs', { username: account.username })}</p></section>`);
}

export function recoveryCodesPage(ctx, { codes }) {
    const { t } = textOf(ctx);
    return page(ctx, t('account.recovery.title'), html`<h1>${t('account.recovery.heading')}</h1>
<p class="lead">${t('account.recovery.lead')}</p>
<ul class="recovery-codes">${codes.map((code) => html`<li><code>${code}</code></li>`)}</ul>
<p class="form-actions"><a class="button" href="/me/account">${t('account.recovery.back')}</a></p>`);
}

export function totpSetupPage(ctx, { session, pending, secretText, uri, error = null }) {
    const { t, ti } = textOf(ctx);
    return page(ctx, t('account.totp.title'), html`<h1>${t('account.totp.heading')}</h1>
<p class="lead">${t('account.totp.lead')}</p>
${notices({ error })}
<ol class="account-steps"><li>${t('account.totp.stepAdd')}</li>
<li>${ti('account.totp.stepKey', { key: html`<code class="key-code">${secretText}</code>` })}</li>
<li>${ti('account.totp.stepUri', { uri: html`<code class="key-link">${uri}</code>` })}</li></ol>
<form class="form-stack" method="post" action="/me/account/2fa/enable">${csrfField(session.csrf)}<input type="hidden" name="pending" value="${pending}">
${field('ts-code', t('account.fields.codeFromApp'), html`<input id="ts-code" name="code" required maxlength="6" pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code">`)}
<p class="form-actions"><button class="button" type="submit">${t('account.totp.submit')}</button><a href="/me/account">${t('account.common.cancel')}</a></p></form>`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Where the plan came from (premium source → key under account.plan.source).
const PLAN_SOURCES = new Set(['bonus', 'purchase', 'key', 'owner']);

/** "183 days left" / "1 day left" / "Ends today" (less than a day). Pure. */
export function daysLeftText(expiresAt, now = Date.now(), { t } = translator()) {
    const days = Math.floor((new Date(expiresAt).getTime() - now) / DAY_MS);
    if (days < 1) return t('account.plan.endsToday');
    return t(days === 1 ? 'account.plan.dayLeft' : 'account.plan.daysLeft', { days });
}

/**
 * The early-account bonus line for Account settings, or null when this Discord account has no
 * bonus record. bonus: a member_account_bonuses row. Pure.
 */
export function bonusStatusText(bonus, { t, ti } = translator()) {
    if (!bonus) return null;
    const n = bonus.link_number;
    if (bonus.pro_granted_at) return ti('account.bonus.granted', { n, bonus: PRO_BONUS_LABEL, date: when(bonus.pro_granted_at) });
    if (bonus.pro_skip_reason) return t('account.bonus.skipped', { n, bonus: PRO_BONUS_LABEL, reason: bonus.pro_skip_reason });
    if (Number(bonus.link_number) > PRO_BONUS_LIMIT) return t('account.bonus.tooLate', { n, limit: PRO_BONUS_LIMIT });
    return t('account.bonus.none', { n });
}

/** "Your plan" on Account settings: plan (or Free), end date, days left, where it came from, the bonus. */
function planSection(ctx, { plan, bonus, now }) {
    const text = textOf(ctx);
    const { t } = text;
    const bonusLine = bonusStatusText(bonus, text);
    const manage = ctx.billing
        ? html`<a class="button button-quiet" href="/me/billing">${t('account.plan.manage')}</a>`
        : html`<a class="button button-quiet" href="/pricing">${t('account.plan.seePlans')}</a>`;
    return html`<section class="account-section"><h2>${t('account.plan.heading')}</h2>
<dl class="summary-rows account-facts">
<div><dt>${t('account.plan.plan')}</dt><dd>${plan ? html`<strong>${planName(plan.plan_id)}</strong>` : t('account.plan.free')}</dd></div>
${plan ? html`<div><dt>${t('account.plan.activeUntil')}</dt><dd>${when(plan.expires_at)} <small class="note">(${daysLeftText(plan.expires_at, now, text)})</small></dd></div>
${PLAN_SOURCES.has(plan.source) ? html`<div><dt>${t('account.plan.lastAddedBy')}</dt><dd>${t(`account.plan.source.${plan.source}`)}</dd></div>` : ''}` : ''}
${bonusLine ? html`<div><dt>${t('account.plan.bonus')}</dt><dd>${bonusLine}</dd></div>` : ''}</dl>
<p class="form-actions">${manage}</p>
<p class="note account-foot">${t('account.plan.foot')}</p></section>`;
}

export function accountSettingsPage(ctx, { session, account, flash = null, error = null, recoveryLeft = 0, canClaim = false, plan = null, bonus = null, now = Date.now() }) {
    const { t, ti } = textOf(ctx);
    const twoStep = Boolean(account.totp_enabled_at);
    const pw = (id) => html`<input id="${id}" name="password" type="password" required maxlength="${PASSWORD_MAX}" autocomplete="current-password">`;
    const code = (id) => html`<input id="${id}" name="code" required maxlength="20" autocomplete="one-time-code" autocapitalize="none" spellcheck="false">`;
    return layout(ctx, {
        title: t('account.settings.title'), active: 'me',
        body: html`<div class="wrap page"><div class="account account-settings"><h1>${t('account.settings.title')}</h1>
${notices({ flash, error })}
<section class="account-section"><h2>${t('account.settings.yourAccount')}</h2>
<dl class="summary-rows account-facts">
<div><dt>${t('account.fields.username')}</dt><dd>${account.username}</dd></div>
<div><dt>${t('account.settings.discord')}</dt><dd>${account.discord_user_id ? html`${account.discord_username || t('account.settings.linked')} <small class="note">(${t('account.settings.discordId', { id: account.discord_user_id })})</small>` : t('account.settings.notLinked')}</dd></div>
<div><dt>${t('account.settings.created')}</dt><dd>${when(account.created_at)}</dd></div></dl>
<div class="form-actions">${canClaim ? html`<a class="button" href="/me/linked">${t('account.settings.claimLetter')}</a>` : ''}<form method="post" action="/me/account/unlink">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">${t('account.settings.unlink')}</button></form></div>
<p class="note account-foot">${t('account.settings.unlinkFoot')}</p></section>

${planSection(ctx, { plan, bonus, now })}

<section class="account-section"><h2>${t('account.password.heading')}</h2>
<form class="form-stack" method="post" action="/me/account/password">${csrfField(session.csrf)}
${field('cp-current', t('account.password.current'), pw('cp-current'))}
${field('cp-new', t('account.fields.newPassword'), html`<input id="cp-new" name="new_password" type="password" required minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" autocomplete="new-password">`, t('account.password.newHint', { min: PASSWORD_MIN }))}
<p class="form-actions"><button class="button" type="submit">${t('account.password.submit')}</button></p></form></section>

<section class="account-section"><h2>${t('account.twoStepSettings.heading')}</h2>
${twoStep
        ? html`<p>${ti('account.twoStepSettings.on', { date: when(account.totp_enabled_at), left: recoveryLeft })}</p>
<form class="form-stack" method="post" action="/me/account/2fa/disable">${csrfField(session.csrf)}
${field('td-password', t('account.fields.password'), pw('td-password'))}
${field('td-code', t('account.fields.codeOrRecovery'), code('td-code'))}
<p class="form-actions"><button class="button button-quiet" type="submit">${t('account.twoStepSettings.turnOff')}</button></p></form>`
        : html`<p>${ti('account.twoStepSettings.off')}</p>
<form method="post" action="/me/account/2fa/start">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">${t('account.twoStepSettings.turnOn')}</button></form>`}</section>

<section class="account-section"><h2>${t('account.settings.yourData')}</h2>
<p class="form-actions"><a class="button button-quiet" href="/me/data" download>${t('account.settings.download')}</a></p></section>

<section class="account-section"><h2>${t('account.delete.heading')}</h2>
<p>${ti('account.delete.lead')}</p>
<form class="form-stack" method="post" action="/me/account/delete">${csrfField(session.csrf)}
${field('da-password', t('account.fields.password'), pw('da-password'))}
${twoStep ? field('da-code', t('account.fields.codeOrRecovery'), code('da-code')) : ''}
<div class="form-check"><input id="da-sure" name="sure" type="checkbox" value="yes" required><label for="da-sure">${t('account.delete.confirm')}</label></div>
<p class="form-actions"><button class="button button-danger" type="submit">${t('account.delete.submit')}</button></p></form></section>

<section class="account-section"><form method="post" action="/me/logout">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">${t('account.common.logOut')}</button></form></section></div></div>`,
    });
}

export function deletedPage(ctx) {
    const { t } = textOf(ctx);
    return page(ctx, t('account.deleted.title'), html`<h1>${t('account.deleted.heading')}</h1>
<p class="lead">${t('account.deleted.lead')}</p>
<p class="form-actions"><a class="button" href="/">${t('account.deleted.home')}</a></p>`);
}

export function accountMessagePage(ctx, title, message, { href = '/me', label = null } = {}) {
    const { t } = textOf(ctx);
    return page(ctx, title, html`<h1>${title}</h1><p class="lead">${message}</p><p class="form-actions"><a class="button" href="${href}">${label ?? t('account.common.backToRecord')}</a></p>`);
}
