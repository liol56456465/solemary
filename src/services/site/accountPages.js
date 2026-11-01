// accountPages.js — the pages of Mewvo accounts on the website (/me/signup, /me/login-password,
// /me/account …). Plain HTML forms that work without JavaScript. Pure: (ctx, values) → page.

import { html, formatDate } from '../dashboard/html.js';
import { layout } from './shell.js';
import { MIN_AGE, PASSWORD_MAX, PASSWORD_MIN, PRO_BONUS_LABEL, USERNAME_MAX, USERNAME_MIN } from '../accounts/accountCore.js';

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
<p class="lead">With an account you log in to this website with a username and password. No email is needed. Right after you sign up, you link your Discord account once; that is also how you reset a forgotten password.</p>
${notices({ error })}
<form class="form-stack" method="post" action="/me/signup">${csrfField(csrf)}
${field('su-username', 'Username', html`<input id="su-username" name="username" required minlength="${USERNAME_MIN}" maxlength="${USERNAME_MAX}" pattern="[A-Za-z0-9_]+" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="su-username-hint" value="${values.username || ''}">`,
        `${USERNAME_MIN} to ${USERNAME_MAX} characters: letters, numbers and underscores only.`)}
${field('su-password', 'Password', html`<input id="su-password" name="password" type="password" required minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" autocomplete="new-password" aria-describedby="su-password-hint">`,
        `At least ${PASSWORD_MIN} characters.`)}
${field('su-birth', 'Date of birth', html`<input id="su-birth" name="birth_date" type="date" required aria-describedby="su-birth-hint" placeholder="YYYY-MM-DD">`,
        `You must be at least ${MIN_AGE}. We only check your age and save that you are ${MIN_AGE} or older, never the date.`)}
<div class="form-check"><input id="su-accept" name="accept" type="checkbox" value="yes" required><label for="su-accept">I accept the <a href="/terms">Terms and Conditions</a> and the <a href="/privacy">Privacy Policy</a>.</label></div>
<p><button class="button" type="submit">Create account</button></p></form>
<p class="note">Already have an account? <a href="/me/login-password">Log in</a>.</p>`);
}

export function passwordLoginPage(ctx, { csrf, identifier = '', error = null, flash = null }) {
    return page(ctx, 'Log in', html`<h1>Log in to your Mewvo account</h1>
${notices({ flash, error })}
<form class="form-stack" method="post" action="/me/login-password">${csrfField(csrf)}
${field('li-id', 'Username', html`<input id="li-id" name="identifier" required maxlength="${USERNAME_MAX}" autocomplete="username" autocapitalize="none" spellcheck="false" value="${identifier}">`)}
${field('li-password', 'Password', html`<input id="li-password" name="password" type="password" required maxlength="${PASSWORD_MAX}" autocomplete="current-password">`)}
<p><button class="button" type="submit">Log in</button></p></form>
<p class="note"><a href="/me/forgot">Forgot your password?</a> · <a href="/me/signup">Create an account</a> · <a href="/me/login">Log in with Discord instead</a></p>`);
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

export function forgotPage(ctx, { csrf, error = null }) {
    return page(ctx, 'Forgot password', html`<h1>Forgot your password?</h1>
${notices({ error })}
<p class="lead">Log in with the Discord account that is linked to your Mewvo account. Then you choose a new password.</p>
<form class="form-stack" method="post" action="/me/forgot">${csrfField(csrf)}
<p><button class="button" type="submit">Log in with Discord</button></p></form>
<p class="note">Mewvo asks Discord only who you are. If two-step login is on, you still enter a code from your app after the new password. No Discord account linked? Then the password cannot be reset; <a href="/me/signup">create a new account</a>.</p>`);
}

export function resetPage(ctx, { csrf, username, twoStep = false, error = null }) {
    return page(ctx, 'Choose a new password', html`<h1>Choose a new password</h1>
${notices({ error })}
<p class="lead">For the Mewvo account <strong>${username}</strong>.</p>
<form class="form-stack" method="post" action="/me/reset">${csrfField(csrf)}
${field('rp-password', 'New password', html`<input id="rp-password" name="password" type="password" required minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" autocomplete="new-password">`, `At least ${PASSWORD_MIN} characters.`)}
${twoStep ? field('rp-code', 'Two-step code', html`<input id="rp-code" name="code" type="text" required maxlength="40" autocomplete="one-time-code" inputmode="text">`, 'The 6-digit code from your app, or one of your recovery codes.') : ''}
<p><button class="button" type="submit">Save the new password</button></p></form>
<p class="note">Saving ends every other login of this account and logs you in here. This form works for 10 minutes.</p>`);
}

export function doneLoginPage(ctx, title, message) {
    return page(ctx, title, html`<h1>${title}</h1><p class="lead">${message}</p><p><a class="button" href="/me/login-password">Log in</a></p>`);
}

export function linkDiscordPage(ctx, { session, account, flash = null, error = null }) {
    const twoStep = Boolean(account.totp_enabled_at);
    return page(ctx, 'Link your Discord', html`<h1>Link your Discord account</h1>
${notices({ flash, error })}
<p class="lead">Logged in as <strong>${account.username}</strong>. One more step: link your Discord account. Your Mewvo account works only once it is linked. The first 100 accounts to link get Mewvo Pro for ${PRO_BONUS_LABEL}.</p>
<form method="post" action="/me/link">${csrfField(session.csrf)}<button class="button" type="submit">Link Discord</button></form>
<p class="note">Mewvo asks Discord only who you are (the identify permission): no email, no servers. One Discord account can be linked to one Mewvo account. If you forget your password, you reset it by logging in with this Discord account. An account that never links Discord is deleted after 7 days.</p>
<form method="post" action="/me/logout">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">Log out</button></form>

<h2>Delete this account</h2>
<form class="form-stack" method="post" action="/me/account/delete">${csrfField(session.csrf)}
${field('dl-password', 'Password', html`<input id="dl-password" name="password" type="password" required maxlength="${PASSWORD_MAX}" autocomplete="current-password">`)}
${twoStep ? field('dl-code', 'Code from the app, or a recovery code', html`<input id="dl-code" name="code" required maxlength="20" autocomplete="one-time-code" autocapitalize="none" spellcheck="false">`) : ''}
<div class="form-check"><input id="dl-sure" name="sure" type="checkbox" value="yes" required><label for="dl-sure">Yes, delete my account.</label></div>
<p><button class="button button-quiet" type="submit">Delete my account</button></p></form>`);
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
<div><dt>Discord</dt><dd>${account.discord_user_id ? html`${account.discord_username || 'Linked'} <small class="note">(ID ${account.discord_user_id})</small>` : 'Not linked'}</dd></div>
<div><dt>Created</dt><dd>${when(account.created_at)}</dd></div></dl>
${canClaim ? html`<p><a class="button" href="/me/linked">Claim your 1-letter username</a></p>` : ''}
<form method="post" action="/me/account/unlink">${csrfField(session.csrf)}<button class="button button-quiet" type="submit">Unlink Discord</button></form>
<p class="note">A Mewvo account needs a linked Discord account: after unlinking, you can only link one again (or delete the account). A plan stays with your Discord account. A Discord account gets the early-account bonus only once.</p>

<h2>Change password</h2>
<form class="form-stack" method="post" action="/me/account/password">${csrfField(session.csrf)}
${field('cp-current', 'Current password', pw('cp-current'))}
${field('cp-new', 'New password', html`<input id="cp-new" name="new_password" type="password" required minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" autocomplete="new-password">`, `At least ${PASSWORD_MIN} characters. You stay logged in here; other logins end.`)}
<p><button class="button" type="submit">Change password</button></p></form>

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
<p>This deletes your Mewvo account: username, password and two-step login. It does not delete moderation records or a plan on your Discord account. See the <a href="/privacy">Privacy Policy</a>.</p>
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
