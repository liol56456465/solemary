// accountPages.js — the pages of Mewvo accounts on the website (/me/signup, /me/login-password,
// /me/account …). Plain HTML forms that work without JavaScript. Pure: (ctx, values) → page.

import { html, formatDate } from '../dashboard/html.js';
import { layout } from './shell.js';
import { MIN_AGE, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from '../accounts/accountCore.js';

const notices = ({ flash = null, error = null }) => html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${error ? html`<p class="error" role="alert">${error}</p>` : ''}`;
const csrfField = (token) => html`<input type="hidden" name="csrf" value="${token}">`;

function when(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? html`<time datetime="${date.toISOString()}">${formatDate(date)}</time>` : '-';
}

function page(ctx, title, body) {
    return layout(ctx, { title, active: 'me', body: html`<div class="wrap page prose">${body}</div>` });
}

const field = (id, label, input, hint = '') => html`<div class="form-field"><label for="${id}">${label}</label>${input}${hint ? html`<p class="form-hint" id="${id}-hint">${hint}</p>` : ''}</div>`;

export function signupPage(ctx, { csrf, values = {}, error = null }) {
    return page(ctx, 'Create an account', html`<h1>Create a Mewvo account</h1>
<p class="lead">With an account you can log in to this website with a username and password instead of Discord. After you confirm your email, you link your Discord account once.</p>
${notices({ error })}
<form class="form-stack" method="post" action="/me/signup">${csrfField(csrf)}
${field('su-username', 'Username', html`<input id="su-username" name="username" required minlength="${USERNAME_MIN}" maxlength="${USERNAME_MAX}" pattern="[A-Za-z0-9_]+" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="su-username-hint" value="${values.username || ''}">`,
        `${USERNAME_MIN} to ${USERNAME_MAX} characters: letters, numbers and underscores only.`)}
${field('su-email', 'Email', html`<input id="su-email" name="email" type="email" required maxlength="254" autocomplete="email" aria-describedby="su-email-hint" value="${values.email || ''}">`,
        'We send a link to confirm it. It is also used to reset your password.')}
${field('su-password', 'Password', html`<input id="su-password" name="password" type="password" required minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" autocomplete="new-password" aria-describedby="su-password-hint">`,
        `At least ${PASSWORD_MIN} characters.`)}
${field('su-birth', 'Date of birth', html`<input id="su-birth" name="birth_date" type="date" required aria-describedby="su-birth-hint" placeholder="YYYY-MM-DD">`,
        `You must be at least ${MIN_AGE}. We only check your age and save that you are ${MIN_AGE} or older, never the date.`)}
<div class="form-check"><input id="su-accept" name="accept" type="checkbox" value="yes" required><label for="su-accept">I accept the <a href="/terms">Terms and Conditions</a> and the <a href="/privacy">Privacy Policy</a>.</label></div>
<p><button class="button" type="submit">Create account</button></p></form>
<p class="note">Already have an account? <a href="/me/login-password">Log in</a>.</p>`);
}

export function checkEmailPage(ctx, { email = null, sendFailed = false } = {}) {
    return page(ctx, 'Check your email', html`<h1>Check your email</h1>
<p class="lead">${email ? html`If <strong>${email}</strong> can get a Mewvo account, we sent a link to it.` : 'If that address can get a Mewvo account, we sent a link to it.'} Open the link within 24 hours to confirm your email.</p>
${sendFailed ? html`<p class="error" role="alert">The email could not be sent right now. Try <strong>Send the email again</strong> in a few minutes.</p>` : ''}
<p class="note">Nothing arrived after a few minutes? Check your spam folder, or <a href="/me/resend">send the email again</a>. Accounts that are not confirmed within 7 days are deleted.</p>`);
}

export function resendPage(ctx, { csrf, error = null, done = false }) {
    return page(ctx, 'Send the email again', html`<h1>Send the confirmation email again</h1>
${done ? html`<p class="flash" role="status">If that address has an account that is not confirmed yet, we sent a new link. Older links no longer work.</p>` : ''}${notices({ error })}
<form class="form-stack" method="post" action="/me/resend">${csrfField(csrf)}
${field('rs-email', 'Email', html`<input id="rs-email" name="email" type="email" required maxlength="254" autocomplete="email">`)}
<p><button class="button" type="submit">Send the email again</button></p></form>`);
}

export function confirmPage(ctx, { csrf, token, purpose }) {
    return page(ctx, 'Confirm your email', html`<h1>Confirm your email</h1>
<p class="lead">${purpose === 'email_change' ? 'Press the button to make this your new email address.' : 'Press the button to confirm your email and log in.'}</p>
<form method="post" action="/me/confirm">${csrfField(csrf)}<input type="hidden" name="token" value="${token}">
<button class="button" type="submit">Confirm my email</button></form>`);
}

export function linkInvalidPage(ctx, what = 'This link') {
    return page(ctx, 'Link not valid', html`<h1>This link does not work</h1>
<p class="lead">${what} is not valid, has expired or was already used.</p>
<p><a class="button" href="/me/login-password">Log in</a> <a class="button button-quiet" href="/me/resend">Send the confirmation email again</a> <a class="button button-quiet" href="/me/forgot">Reset my password</a></p>`);
}

export function passwordLoginPage(ctx, { csrf, identifier = '', error = null, flash = null }) {
    return page(ctx, 'Log in', html`<h1>Log in to your Mewvo account</h1>
${notices({ flash, error })}
<form class="form-stack" method="post" action="/me/login-password">${csrfField(csrf)}
${field('li-id', 'Username or email', html`<input id="li-id" name="identifier" required maxlength="254" autocomplete="username" autocapitalize="none" spellcheck="false" value="${identifier}">`)}
${field('li-password', 'Password', html`<input id="li-password" name="password" type="password" required maxlength="${PASSWORD_MAX}" autocomplete="current-password">`)}
<p><button class="button" type="submit">Log in</button></p></form>
<p class="note"><a href="/me/forgot">Forgot your password?</a> · <a href="/me/signup">Create an account</a> · <a href="/me/login">Log in with Discord instead</a></p>`);
}

export function unconfirmedPage(ctx, { csrf }) {
    return page(ctx, 'Email not confirmed', html`<h1>Confirm your email first</h1>
<p class="lead">Your email address is not confirmed yet, so you cannot log in. Open the link we sent you, or send it again.</p>
<form class="form-stack" method="post" action="/me/resend">${csrfField(csrf)}
${field('uc-email', 'Email', html`<input id="uc-email" name="email" type="email" required maxlength="254" autocomplete="email">`)}
<p><button class="button" type="submit">Send the email again</button></p></form>`);
}

export function twoStepPage(ctx, { csrf, error = null }) {
    return page(ctx, 'Two-step login', html`<h1>Enter your login code</h1>
<p class="lead">Open your authenticator app and enter the 6-digit code for Mewvo. Lost your phone? Enter one of your recovery codes instead.</p>
${notices({ error })}
<form class="form-stack" method="post" action="/me/login-2fa">${csrfField(csrf)}
${field('tf-code', 'Code', html`<input id="tf-code" name="code" required maxlength="20" autocomplete="one-time-code" inputmode="text" autocapitalize="none" spellcheck="false">`)}
<p><button class="button" type="submit">Log in</button></p></form>
<p class="note">The code step lasts 5 minutes. After that, <a href="/me/login-password">log in again</a>.</p>`);
}

export function forgotPage(ctx, { csrf, error = null, done = false }) {
    return page(ctx, 'Reset your password', html`<h1>Reset your password</h1>
${done ? html`<p class="flash" role="status">If that email has an account, we sent a link to reset the password. The link works for 1 hour.</p>` : ''}${notices({ error })}
<form class="form-stack" method="post" action="/me/forgot">${csrfField(csrf)}
${field('fg-email', 'Email', html`<input id="fg-email" name="email" type="email" required maxlength="254" autocomplete="email">`)}
<p><button class="button" type="submit">Send the link</button></p></form>`);
}

export function resetPage(ctx, { csrf, token, error = null }) {
    return page(ctx, 'Choose a new password', html`<h1>Choose a new password</h1>
${notices({ error })}
<form class="form-stack" method="post" action="/me/reset">${csrfField(csrf)}<input type="hidden" name="token" value="${token}">
${field('rp-password', 'New password', html`<input id="rp-password" name="password" type="password" required minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" autocomplete="new-password">`, `At least ${PASSWORD_MIN} characters.`)}
<p><button class="button" type="submit">Save the new password</button></p></form>
<p class="note">Saving logs you out everywhere. Then log in with the new password.</p>`);
}

export function doneLoginPage(ctx, title, message) {
    return page(ctx, title, html`<h1>${title}</h1><p class="lead">${message}</p><p><a class="button" href="/me/login-password">Log in</a></p>`);
}

export function linkDiscordPage(ctx, { session, account }) {
    return page(ctx, 'Link your Discord', html`<h1>Link your Discord account</h1>
<p class="lead">Logged in as <strong>${account.username}</strong>. Link your Discord account once to see your record, plans and gifts here. After that you log in with your username and password only.</p>
<form method="post" action="/me/link">${csrfField(session.csrf)}<button class="button" type="submit">Link Discord</button></form>
<p class="note">Mewvo asks Discord only who you are (the identify permission): no email, no servers. One Discord account can be linked to one Mewvo account.</p>
<p><a class="button button-quiet" href="/me/account">Account settings</a></p>
<form method="post" action="/me/logout">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">Log out</button></form>`);
}

function letterForm(session, letters) {
    if (!letters.length) return html`<p>All 1-letter usernames are taken.</p>`;
    return html`<form method="post" action="/me/letter">${csrfField(session.csrf)}
<fieldset class="letter-grid"><legend>Pick a 1-letter username</legend>${letters.map((letter, i) => html`<label class="letter-choice"><input type="radio" name="letter" value="${letter}"${i === 0 ? html` required` : ''}> <code>${letter}</code></label>`)}</fieldset>
<p><button class="button" type="submit">Claim this username</button></p></form>
<form method="post" action="/me/letter/decline">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">No thanks, keep my username</button></form>
<p class="note">You can claim a 1-letter username only once. Your current username stops working when you claim one.</p>`;
}

export function linkedPage(ctx, { session, account, flash, offer = null }) {
    return page(ctx, 'Discord linked', html`<h1>Your Discord account is linked</h1>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${offer ? html`<h2>Your 1-letter username</h2>${letterForm(session, offer.letters)}` : ''}
<p><a class="button" href="/me">Go to My record</a> <a class="button button-quiet" href="/me/account">Account settings</a></p>
<p class="note">Logged in as <strong>${account.username}</strong>.</p>`);
}

export function recoveryCodesPage(ctx, { codes }) {
    return page(ctx, 'Recovery codes', html`<h1>Two-step login is on</h1>
<p class="lead">Save these recovery codes somewhere safe. Each one works once, if you lose your authenticator app. They are shown only now.</p>
<ul class="recovery-codes">${codes.map((code) => html`<li><code>${code}</code></li>`)}</ul>
<p><a class="button" href="/me/account">Back to Account settings</a></p>`);
}

export function totpSetupPage(ctx, { session, pending, secretText, uri, error = null }) {
    return page(ctx, 'Turn on two-step login', html`<h1>Turn on two-step login</h1>
<p class="lead">Add Mewvo to an authenticator app, then enter the 6-digit code it shows.</p>
${notices({ error })}
<ol><li>In your authenticator app, choose to add an account by entering a key.</li>
<li>Enter this key: <code class="key-code">${secretText}</code> (time based, 6 digits, 30 seconds).</li>
<li>Or paste this address, if your app accepts it: <code class="key-link">${uri}</code></li></ol>
<form class="form-stack" method="post" action="/me/account/2fa/enable">${csrfField(session.csrf)}<input type="hidden" name="pending" value="${pending}">
${field('ts-code', 'Code from the app', html`<input id="ts-code" name="code" required maxlength="6" pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code">`)}
<p><button class="button" type="submit">Turn on</button></p></form>
<p class="note"><a href="/me/account">Cancel</a></p>`);
}

export function accountSettingsPage(ctx, { session, account, flash = null, error = null, recoveryLeft = 0, canClaim = false }) {
    const twoStep = Boolean(account.totp_enabled_at);
    const pw = (id) => html`<input id="${id}" name="password" type="password" required maxlength="${PASSWORD_MAX}" autocomplete="current-password">`;
    const code = (id) => html`<input id="${id}" name="code" required maxlength="20" autocomplete="one-time-code" autocapitalize="none" spellcheck="false">`;
    return layout(ctx, {
        title: 'Account settings', active: 'me',
        body: html`<div class="wrap page prose"><h1>Account settings</h1>
${notices({ flash, error })}
<h2>Your account</h2>
<dl class="summary-rows">
<div><dt>Username</dt><dd>${account.username}</dd></div>
<div><dt>Email</dt><dd>${account.email}${account.pending_email ? html`<br><small class="note">Waiting for confirmation: ${account.pending_email}</small>` : ''}</dd></div>
<div><dt>Discord</dt><dd>${account.discord_user_id ? html`${account.discord_username || 'Linked'} <small class="note">(ID ${account.discord_user_id})</small>` : 'Not linked'}</dd></div>
<div><dt>Created</dt><dd>${when(account.created_at)}</dd></div></dl>
${canClaim ? html`<p><a class="button" href="/me/linked">Claim your 1-letter username</a></p>` : ''}
${account.discord_user_id
        ? html`<form method="post" action="/me/account/unlink">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">Unlink Discord</button></form>
<p class="note">After unlinking, My record and plans are hidden here until you link again. A plan stays with your Discord account. A Discord account gets the early-account bonus only once.</p>`
        : html`<form method="post" action="/me/link">${csrfField(session.csrf)}<button class="button" type="submit">Link Discord</button></form>`}

<h2>Change password</h2>
<form class="form-stack" method="post" action="/me/account/password">${csrfField(session.csrf)}
${field('cp-current', 'Current password', pw('cp-current'))}
${field('cp-new', 'New password', html`<input id="cp-new" name="new_password" type="password" required minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" autocomplete="new-password">`, `At least ${PASSWORD_MIN} characters. You stay logged in here; other logins end.`)}
<p><button class="button" type="submit">Change password</button></p></form>

<h2>Change email</h2>
<form class="form-stack" method="post" action="/me/account/email">${csrfField(session.csrf)}
${field('ce-email', 'New email', html`<input id="ce-email" name="email" type="email" required maxlength="254" autocomplete="email">`, 'We send a link to the new address. Your email changes when you open it.')}
${field('ce-password', 'Current password', pw('ce-password'))}
<p><button class="button" type="submit">Change email</button></p></form>

<h2>Two-step login</h2>
${twoStep
        ? html`<p>Two-step login is <strong>on</strong> since ${when(account.totp_enabled_at)}. Recovery codes left: ${recoveryLeft}.</p>
<form class="form-stack" method="post" action="/me/account/2fa/disable">${csrfField(session.csrf)}
${field('td-password', 'Password', pw('td-password'))}
${field('td-code', 'Code from the app, or a recovery code', code('td-code'))}
<p><button class="button button-quiet" type="submit">Turn off two-step login</button></p></form>`
        : html`<p>Two-step login is <strong>off</strong>. When it is on, you also enter a code from an authenticator app when you log in.</p>
<form method="post" action="/me/account/2fa/start">${csrfField(session.csrf)}<button class="button" type="submit">Turn on two-step login</button></form>`}

<h2>Your data</h2>
<p><a class="button button-quiet" href="/me/data" download>Download my data</a></p>

<h2>Delete account</h2>
<p>This deletes your Mewvo account: username, email, password and two-step login. It does not delete moderation records or a plan on your Discord account. See the <a href="/privacy">Privacy Policy</a>.</p>
<form class="form-stack" method="post" action="/me/account/delete">${csrfField(session.csrf)}
${field('da-password', 'Password', pw('da-password'))}
${twoStep ? field('da-code', 'Code from the app, or a recovery code', code('da-code')) : ''}
<div class="form-check"><input id="da-sure" name="sure" type="checkbox" value="yes" required><label for="da-sure">Yes, delete my account.</label></div>
<p><button class="button button-quiet" type="submit">Delete my account</button></p></form>

<form method="post" action="/me/logout">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">Log out</button></form></div>`,
    });
}

export function deletedPage(ctx) {
    return page(ctx, 'Account deleted', html`<h1>Your account was deleted</h1>
<p class="lead">Your Mewvo account is gone and you are logged out. A plan on your Discord account stays with it, and moderation records are not affected.</p>
<p><a class="button" href="/">Home</a></p>`);
}

export function accountMessagePage(ctx, title, message, { href = '/me', label = 'Back to My record' } = {}) {
    return page(ctx, title, html`<h1>${title}</h1><p class="lead">${message}</p><p><a class="button" href="${href}">${label}</a></p>`);
}
