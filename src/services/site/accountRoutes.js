// accountRoutes.js — Mewvo accounts on the website, inside the member portal (/me).
// Off unless MEMBER_ACCOUNTS_ENABLED=true (and the member portal is on).
//
//   GET/POST /me/signup            username, email, password, date of birth (13+), terms
//   GET/POST /me/resend            send the confirmation email again (no enumeration)
//   GET/POST /me/confirm           confirm the email (GET shows a button, POST uses the link)
//   GET/POST /me/login-password    username or email + password
//   GET/POST /me/login-2fa         the code step when two-step login is on
//   GET/POST /me/forgot            password reset link (no enumeration)
//   GET/POST /me/reset             new password from the link; ends every session of the account
//   POST     /me/link              starts the Discord link (the portal's OAuth, identify scope)
//   GET      /me/linked            the bonus result + the 1-letter claim
//   POST     /me/letter[/decline]  claim or decline a 1-letter username
//   GET      /me/account           settings; POST /me/account/{password,email,2fa/start,
//                                  2fa/enable,2fa/disable,unlink,delete}
//
// Every POST: same origin + a CSRF token (the session's, or before login a signed
// double-submit cookie, Path=/me). Rate limits per IP, per login name and per account.
// Never logged: passwords, hashes, tokens, codes, 2FA secrets, email links.

import crypto from 'node:crypto';
import { afterPremiumChange } from '../billing/premiumEffects.js';
import { logger } from '../../utils/logger.js';
import {
    AccountError, CONFIRM_TOKEN_TTL_MS, MIN_AGE, PRO_BONUS_DAYS, RESET_TOKEN_TTL_MS, SCRYPT_PARAMS, base32Decode, base32Encode, checkAge, cleanToken,
    createRecoveryCodes, createToken, createTotpSecret, decryptSecret, encryptSecret, groupedBase32, hashPassword, hashRecoveryCode,
    normalizeLetter, normalizeRecoveryCode, otpauthUri, totpEncryptionKey, validateEmail, validatePassword, validateUsername,
    verifyAgainstDummy, verifyPassword, verifyTotp,
} from '../accounts/accountCore.js';
import { clearCookie, createRateLimiter, hmac, isSameOrigin, parseCookies, safeEqual, serializeCookie, signValue, verifySignedValue } from '../dashboard/security.js';
import {
    accountMessagePage, accountSettingsPage, checkEmailPage, confirmPage, deletedPage, doneLoginPage, forgotPage, linkDiscordPage, linkInvalidPage,
    linkedPage, passwordLoginPage, recoveryCodesPage, resendPage, resetPage, signupPage, totpSetupPage, twoStepPage, unconfirmedPage,
} from './accountPages.js';

export const FORM_COOKIE = 'mewvo_me_form';
export const TWO_STEP_COOKIE = 'mewvo_me_2fa';
export const TWO_STEP_TTL_MS = 5 * 60 * 1000;
const TWO_STEP_MAX_TRIES = 5;
const FIFTEEN_MIN = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const ACCOUNT_LIMITS = {
    loginIp: { limit: 10, windowMs: FIFTEEN_MIN },
    confirmIp: { limit: 10, windowMs: FIFTEEN_MIN }, // password tries on the confirm page
    loginName: { limit: 10, windowMs: FIFTEEN_MIN },
    code: { limit: 10, windowMs: FIFTEEN_MIN },
    signupIp: { limit: 5, windowMs: HOUR },
    emailIp: { limit: 10, windowMs: HOUR },
    emailAddress: { limit: 3, windowMs: HOUR },
};

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim());
const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
// Passwords are taken as typed (no trim), only capped.
const secretField = (value) => (typeof value === 'string' ? value.slice(0, 400) : '');

/** MEMBER_ACCOUNTS_ENABLED and what it needs: { requested, enabled, problems, totpKey }. */
export function memberAccountSettings(env = process.env, portal = null) {
    const requested = truthy(env.MEMBER_ACCOUNTS_ENABLED);
    const settings = { requested, enabled: false, problems: [], totpKey: null };
    if (!requested) return settings;
    if (!portal?.enabled) settings.problems.push('the member portal (MEMBER_PORTAL_ENABLED) is not on');
    try {
        settings.totpKey = totpEncryptionKey(env.SESSION_SECRET);
    } catch {
        settings.problems.push('SESSION_SECRET must be at least 32 characters');
    }
    if (String(env.RESEND_API_KEY || '').trim() && !String(env.EMAIL_FROM || '').trim()) settings.problems.push('EMAIL_FROM is not set (RESEND_API_KEY is)');
    settings.enabled = settings.problems.length === 0;
    return settings;
}

// ── Emails (plain text; the links are secrets and never logged) ────────────

export function accountEmail(kind, { username = '', link = '', email = '' } = {}) {
    const sign = '\n\nMewvo';
    switch (kind) {
    case 'confirm':
        return { subject: 'Confirm your Mewvo account', text: `Hi ${username},\n\nOpen this link to confirm your email and finish creating your Mewvo account:\n${link}\n\nThe link works for 24 hours and only once. If you did not create an account, ignore this email; the account is deleted after 7 days.${sign}` };
    case 'email_change':
        return { subject: 'Confirm your new email for Mewvo', text: `Hi ${username},\n\nOpen this link to make this your Mewvo email address:\n${link}\n\nThe link works for 24 hours and only once. If you did not ask for this, ignore this email.${sign}` };
    case 'reset':
        return { subject: 'Reset your Mewvo password', text: `Hi ${username},\n\nOpen this link to choose a new password:\n${link}\n\nThe link works for 1 hour and only once. If you did not ask for this, ignore this email; your password stays the same.${sign}` };
    case 'exists':
        return { subject: 'Someone tried to sign up with your email', text: `Hi,\n\nSomeone tried to create a Mewvo account with this email address, but it already has an account (${username}). If it was you, log in or reset your password on the website. If not, you can ignore this email.${sign}` };
    case 'email_changed':
        return { subject: 'Your Mewvo email was changed', text: `Hi ${username},\n\nThe email address of your Mewvo account was changed to ${email}. If you did not do this, reset your password and contact the staff.${sign}` };
    case 'password_changed':
        return { subject: 'Your Mewvo password was changed', text: `Hi ${username},\n\nThe password of your Mewvo account was changed and other logins were ended. If you did not do this, reset your password now.${sign}` };
    case 'two_step_off':
        return { subject: 'Two-step login was turned off', text: `Hi ${username},\n\nTwo-step login was turned off for your Mewvo account. If you did not do this, reset your password now.${sign}` };
    default:
        throw new Error(`unknown email ${kind}`);
    }
}

/** The text shown after linking Discord, honest about what this link got. Pure. */
export function bonusText(bonus) {
    if (!bonus || bonus.kind === 'repeat') {
        return 'Your Discord account is linked. This Discord account was linked to a Mewvo account before, so it does not get the early-account bonus again.';
    }
    const n = `You are number ${bonus.linkNumber} to link a Discord account to Mewvo.`;
    if (bonus.pro && bonus.letter) return `${n} You get Mewvo Pro for ${PRO_BONUS_DAYS} days, and you can pick a 1-letter username below.`;
    if (bonus.pro) return `${n} You get Mewvo Pro for ${PRO_BONUS_DAYS} days.`;
    if (bonus.proNote && bonus.letter) return `${n} A Pro month was due, but it could not be added: ${bonus.proNote} You can still pick a 1-letter username below.`;
    if (bonus.proNote) return `${n} A Pro month was due, but it could not be added: ${bonus.proNote}`;
    if (bonus.letter) return `${n} You can pick a 1-letter username below.`;
    return `${n} The early-account bonuses went to the first 100 accounts, so there is no bonus for this one.`;
}

/**
 * The handlers. core: { settings (portal), accountSettings, store, mailer, sessions, ctx, send,
 * clientIp, cookieOptions, key, sessionCookie, cookieSessionId, readSession, startLink(req, res, accountId),
 * limits, hashParams (scrypt cost; tests use a low one), after (premium follow-up) }.
 */
export function createAccountHandlers(core) {
    const {
        settings, accountSettings, store, mailer, sessions, ctx, send, clientIp, cookieOptions, key, sessionCookie, cookieSessionId, readSession,
        startLink, limits = ACCOUNT_LIMITS, hashParams = SCRYPT_PARAMS, after = afterPremiumChange, sessionTtlMs,
    } = core;
    const formKey = hmac('mewvo member form v1', key);
    const twoStepKey = hmac('mewvo member 2fa v1', key);
    const totpKey = accountSettings.totpKey;
    const lim = (name) => createRateLimiter(limits[name] || ACCOUNT_LIMITS[name]);
    const loginIpLimiter = lim('loginIp');
    const loginNameLimiter = lim('loginName');
    const codeLimiter = lim('code');
    const confirmLimiter = lim('confirmIp');
    const signupLimiter = lim('signupIp');
    const emailIpLimiter = lim('emailIp');
    const emailAddressLimiter = lim('emailAddress');
    const challenges = new Map(); // id → { accountId, expiresAt, tries }
    const pending = new Set();
    const baseUrl = settings.publicUrl || settings.publicOrigin || '';
    const page = (res, status, html) => send(res, status, html);
    const tooMany = (res, render) => { res.set('Retry-After', '60'); return page(res, 429, render('Too many tries. Wait a few minutes and try again.')); };

    // ── CSRF before login: a signed double-submit cookie ─────────────────

    function formToken(req, res) {
        const existing = verifySignedValue(parseCookies(req.headers?.cookie)[FORM_COOKIE], formKey);
        if (existing) return existing;
        const token = crypto.randomBytes(24).toString('base64url');
        res.append('Set-Cookie', serializeCookie(FORM_COOKIE, signValue(token, formKey), { ...cookieOptions, maxAgeMs: 2 * HOUR }));
        return token;
    }
    function formOk(req) {
        const cookie = verifySignedValue(parseCookies(req.headers?.cookie)[FORM_COOKIE], formKey);
        return Boolean(cookie) && isSameOrigin(req, settings.publicOrigin) && safeEqual(str(req.body?.csrf, 100), cookie);
    }
    const sessionOk = (req, session) => isSameOrigin(req, settings.publicOrigin) && safeEqual(str(req.body?.csrf, 100), session.csrf);
    const notAllowed = (res) => page(res, 403, accountMessagePage(ctx(), 'Not allowed', 'This form did not come from this site, or it was open too long. Go back, reload the page and try again. Nothing was changed.'));

    /** Sends without making the answer wait (same timing whether or not an account exists). */
    function background(task) {
        const run = Promise.resolve().then(task).catch((error) => logger.warn(`Account email failed: ${error.message}`));
        pending.add(run);
        run.finally(() => pending.delete(run));
    }
    const idle = async () => { while (pending.size) await Promise.all([...pending]); };

    async function mail(to, kind, values) {
        const message = accountEmail(kind, values);
        await mailer.send({ to, ...message });
    }
    async function sendToken(account, purpose, email) {
        const { token, hash } = createToken();
        await store.saveToken({ accountId: account.id, purpose, hash, email, ttlMs: purpose === 'reset' ? RESET_TOKEN_TTL_MS : CONFIRM_TOKEN_TTL_MS });
        const path = purpose === 'reset' ? '/me/reset' : '/me/confirm';
        await mail(email, purpose === 'reset' ? 'reset' : purpose, { username: account.username, link: `${baseUrl}${path}?${new URLSearchParams({ token })}` });
    }

    async function startSession(req, res, account) {
        const session = await sessions.rotate(cookieSessionId(req), { userId: account.discord_user_id || null, username: account.username, accountId: account.id });
        res.append('Set-Cookie', serializeCookie(sessionCookie, signValue(session.id, key), { ...cookieOptions, maxAgeMs: sessionTtlMs }));
        await store.recordLogin(account.id);
        logger.info(`Member account login: account ${account.id}`);
        return session;
    }

    /** The logged-in account (session with accountId and an existing row), or null. */
    async function current(req) {
        const session = await readSession(req);
        if (!session?.accountId) return null;
        const account = await store.findById(session.accountId);
        if (!account) return null;
        return { session, account };
    }
    const toLogin = (res) => res.redirect(303, '/me/login-password');

    /** A TOTP code or a recovery code for this account; uses it up. */
    async function checkCode(account, input) {
        const recovery = normalizeRecoveryCode(input);
        // Recovery codes are 10 characters, app codes 6 digits.
        if (recovery) return store.useRecoveryCode(account.id, hashRecoveryCode(recovery));
        const secret = decryptSecret(account.totp_secret_enc, totpKey);
        if (!secret) {
            logger.error(`Account ${account.id}: the 2FA secret does not decrypt (SESSION_SECRET changed?)`);
            return false;
        }
        const step = verifyTotp(secret, input, { afterStep: account.totp_last_step });
        return step !== null && store.useTotpStep(account.id, step);
    }

    // ── Sign up ──────────────────────────────────────────────────────────

    function signupForm(req, res) {
        return page(res, 200, signupPage(ctx(), { csrf: formToken(req, res) }));
    }

    async function signupPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        const csrf = formToken(req, res);
        const values = { username: str(req.body?.username, 60), email: str(req.body?.email, 300) };
        const again = (status, error) => page(res, status, signupPage(ctx(), { csrf, values, error }));
        if (!signupLimiter.allow(clientIp(req))) { res.set('Retry-After', '600'); return again(429, 'Too many new accounts from your address. Try again later.'); }
        const username = validateUsername(values.username);
        if (!username.ok) return again(400, username.error);
        const email = validateEmail(values.email);
        if (!email.ok) return again(400, email.error);
        const password = validatePassword(req.body?.password);
        if (!password.ok) return again(400, password.error);
        const age = checkAge(req.body?.birth_date);
        if (!age.ok) return again(400, age.error);
        if (req.body?.accept !== 'yes') return again(400, 'Accept the Terms and Conditions and the Privacy Policy to create an account.');
        const passwordHash = await hashPassword(password.value, hashParams);
        let created;
        try {
            created = await store.createAccount({ username: username.value, email: email.value, passwordHash });
        } catch (error) {
            if (error instanceof AccountError) return again(error.status, error.userMessage);
            throw error;
        }
        if (created.emailTaken) {
            // Same answer as a new account; the owner of the address gets a notice instead.
            if (emailAddressLimiter.allow(email.value)) {
                background(async () => {
                    const owner = await store.findByEmail(email.value);
                    if (owner) await mail(email.value, 'exists', { username: owner.username });
                });
            }
            return page(res, 200, checkEmailPage(ctx(), { email: email.value }));
        }
        logger.info(`Member account created: account ${created.account.id} (not confirmed yet)`);
        let sendFailed = false;
        try {
            emailAddressLimiter.allow(email.value);
            await sendToken(created.account, 'confirm', email.value);
        } catch (error) {
            logger.warn(`Confirmation email for account ${created.account.id} failed: ${error.message}`);
            sendFailed = true;
        }
        return page(res, 200, checkEmailPage(ctx(), { email: email.value, sendFailed }));
    }

    function resendForm(req, res) {
        return page(res, 200, resendPage(ctx(), { csrf: formToken(req, res) }));
    }

    async function resendPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        const csrf = formToken(req, res);
        const email = validateEmail(str(req.body?.email, 300));
        if (!email.ok) return page(res, 400, resendPage(ctx(), { csrf, error: email.error }));
        if (!emailIpLimiter.allow(clientIp(req))) return tooMany(res, (error) => resendPage(ctx(), { csrf, error }));
        if (emailAddressLimiter.allow(email.value)) {
            background(async () => {
                const account = await store.findByEmail(email.value);
                if (account && !account.email_confirmed_at) await sendToken(account, 'confirm', account.email);
            });
        }
        return page(res, 200, resendPage(ctx(), { csrf, done: true }));
    }

    async function confirmForm(req, res) {
        const token = cleanToken(req.query?.token);
        const row = token ? await store.peekToken(token, null) : null;
        if (!row || !['confirm', 'email_change'].includes(row.purpose)) return page(res, 400, linkInvalidPage(ctx(), 'This confirmation link'));
        return page(res, 200, confirmPage(ctx(), { csrf: formToken(req, res), token, purpose: row.purpose }));
    }

    async function confirmPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        const token = cleanToken(req.body?.token);
        // A new account is confirmed only with its password: someone who only has the email
        // cannot confirm (and then share) an account a stranger signed up with their address.
        const pending = token ? await store.peekToken(token, null) : null;
        if (pending?.purpose === 'confirm') {
            const csrf = formToken(req, res);
            if (!confirmLimiter.allow(clientIp(req))) return tooMany(res, (error) => confirmPage(ctx(), { csrf, token, purpose: 'confirm', error }));
            const account = await store.findById(pending.account_id);
            const ok = account
                ? await verifyPassword(secretField(req.body?.password), account.password_hash)
                : await verifyAgainstDummy(secretField(req.body?.password));
            if (!ok) return page(res, 401, confirmPage(ctx(), { csrf, token, purpose: 'confirm', error: 'That password is not right. Type the password you chose when you signed up.' }));
        }
        const result = token ? await store.confirmEmail(token) : { error: 'missing' };
        if (result.error === 'email_taken') return page(res, 409, accountMessagePage(ctx(), 'Email already in use', 'That email address now belongs to another account, so it was not changed.', { href: '/me/account', label: 'Account settings' }));
        if (result.error) return page(res, 400, linkInvalidPage(ctx(), 'This confirmation link'));
        const { account } = result;
        if (result.purpose === 'email_change') {
            logger.info(`Member account ${account.id}: email changed`);
            if (result.oldEmail) background(() => mail(result.oldEmail, 'email_changed', { username: account.username, email: account.email }));
            return page(res, 200, accountMessagePage(ctx(), 'Email changed', `Your email address is now ${account.email}.`, { href: '/me/account', label: 'Account settings' }));
        }
        logger.info(`Member account ${account.id}: email confirmed`);
        await startSession(req, res, account);
        return res.redirect(303, '/me');
    }

    // ── Log in ───────────────────────────────────────────────────────────

    function loginForm(req, res) {
        return page(res, 200, passwordLoginPage(ctx(), { csrf: formToken(req, res) }));
    }

    async function loginPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        const csrf = formToken(req, res);
        const identifier = str(req.body?.identifier, 300).toLowerCase();
        const password = secretField(req.body?.password);
        const wrong = (status = 401) => page(res, status, passwordLoginPage(ctx(), { csrf, identifier, error: 'Wrong username/email or password.' }));
        const ipOk = loginIpLimiter.allow(clientIp(req));
        const nameOk = loginNameLimiter.allow(identifier || '-');
        if (!ipOk || !nameOk) return tooMany(res, (error) => passwordLoginPage(ctx(), { csrf, identifier, error }));
        if (!identifier || !password) return wrong(400);
        const account = await store.findByLogin(identifier);
        if (!account) {
            await verifyAgainstDummy(password, hashParams);
            return wrong();
        }
        if (!(await verifyPassword(password, account.password_hash))) return wrong();
        if (!account.email_confirmed_at) return page(res, 403, unconfirmedPage(ctx(), { csrf }));
        if (account.totp_enabled_at) {
            const id = crypto.randomBytes(24).toString('base64url');
            const now = Date.now();
            for (const [k, c] of challenges) if (c.expiresAt <= now) challenges.delete(k);
            challenges.set(id, { accountId: account.id, expiresAt: now + TWO_STEP_TTL_MS, tries: 0 });
            res.append('Set-Cookie', serializeCookie(TWO_STEP_COOKIE, signValue(id, twoStepKey), { ...cookieOptions, maxAgeMs: TWO_STEP_TTL_MS }));
            return res.redirect(303, '/me/login-2fa');
        }
        await startSession(req, res, account);
        return res.redirect(303, '/me');
    }

    function challengeOf(req) {
        const id = verifySignedValue(parseCookies(req.headers?.cookie)[TWO_STEP_COOKIE], twoStepKey);
        const challenge = id ? challenges.get(id) : null;
        if (!challenge || challenge.expiresAt <= Date.now()) return null;
        return { id, challenge };
    }

    function twoStepForm(req, res) {
        if (!challengeOf(req)) return toLogin(res);
        return page(res, 200, twoStepPage(ctx(), { csrf: formToken(req, res) }));
    }

    async function twoStepPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        const csrf = formToken(req, res);
        const found = challengeOf(req);
        if (!found) return page(res, 400, doneLoginPage(ctx(), 'Log in again', 'The code step expired. Log in again with your password.'));
        const { id, challenge } = found;
        if (!codeLimiter.allow(`login:${challenge.accountId}`) || !loginIpLimiter.allow(clientIp(req))) {
            return tooMany(res, (error) => twoStepPage(ctx(), { csrf, error }));
        }
        const account = await store.findById(challenge.accountId);
        const ok = account?.totp_enabled_at ? await checkCode(account, str(req.body?.code, 40)) : false;
        if (!ok) {
            challenge.tries += 1;
            if (challenge.tries >= TWO_STEP_MAX_TRIES) {
                challenges.delete(id);
                res.append('Set-Cookie', clearCookie(TWO_STEP_COOKIE, cookieOptions));
                return page(res, 401, doneLoginPage(ctx(), 'Log in again', 'Too many wrong codes. Log in again with your password.'));
            }
            return page(res, 401, twoStepPage(ctx(), { csrf, error: 'That code is not right. Try the newest code from your app.' }));
        }
        challenges.delete(id);
        res.append('Set-Cookie', clearCookie(TWO_STEP_COOKIE, cookieOptions));
        await startSession(req, res, account);
        return res.redirect(303, '/me');
    }

    // ── Password reset ───────────────────────────────────────────────────

    function forgotForm(req, res) {
        return page(res, 200, forgotPage(ctx(), { csrf: formToken(req, res) }));
    }

    async function forgotPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        const csrf = formToken(req, res);
        const email = validateEmail(str(req.body?.email, 300));
        if (!email.ok) return page(res, 400, forgotPage(ctx(), { csrf, error: email.error }));
        if (!emailIpLimiter.allow(clientIp(req))) return tooMany(res, (error) => forgotPage(ctx(), { csrf, error }));
        if (emailAddressLimiter.allow(email.value)) {
            background(async () => {
                const account = await store.findByEmail(email.value);
                if (!account) return;
                // Also for an unconfirmed account: the reset link confirms the email, so the
                // address's owner can take over an account someone else made with it.
                await sendToken(account, 'reset', account.email);
            });
        }
        return page(res, 200, forgotPage(ctx(), { csrf, done: true }));
    }

    async function resetForm(req, res) {
        const token = cleanToken(req.query?.token);
        const row = token ? await store.peekToken(token, 'reset') : null;
        if (!row) return page(res, 400, linkInvalidPage(ctx(), 'This password reset link'));
        return page(res, 200, resetPage(ctx(), { csrf: formToken(req, res), token }));
    }

    async function resetPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        const csrf = formToken(req, res);
        const token = cleanToken(req.body?.token);
        if (!token) return page(res, 400, linkInvalidPage(ctx(), 'This password reset link'));
        const password = validatePassword(req.body?.password);
        if (!password.ok) return page(res, 400, resetPage(ctx(), { csrf, token, error: password.error }));
        const result = await store.resetPassword(token, await hashPassword(password.value, hashParams));
        if (result.error) return page(res, 400, linkInvalidPage(ctx(), 'This password reset link'));
        const { account } = result;
        await sessions.destroyForAccount(account.id);
        res.append('Set-Cookie', clearCookie(sessionCookie, cookieOptions));
        logger.info(`Member account ${account.id}: password reset, all sessions ended`);
        background(() => mail(account.email, 'password_changed', { username: account.username }));
        return page(res, 200, doneLoginPage(ctx(), 'Password changed', 'Your new password is saved and you were logged out everywhere. Log in with the new password.'));
    }

    // ── Discord link and bonuses ─────────────────────────────────────────

    async function linkPost(req, res) {
        const me = await current(req);
        if (!me) return toLogin(res);
        if (!sessionOk(req, me.session)) return notAllowed(res);
        if (me.account.discord_user_id) return res.redirect(303, '/me/account');
        return startLink(req, res, me.account.id);
    }

    /** Called by the portal's OAuth callback in link mode, with the Discord user. */
    async function linkCallback(req, res, { session, discordUser }) {
        let result;
        try {
            result = await store.linkDiscord({ accountId: session.accountId, discordUserId: String(discordUser.id), discordUsername: discordUser.global_name || discordUser.username || null });
        } catch (error) {
            if (!(error instanceof AccountError)) throw error;
            return page(res, error.status, accountMessagePage(ctx(), 'Not linked', error.userMessage, { href: '/me/account', label: 'Account settings' }));
        }
        if (result.premium) await after(result.premium, 'bonus');
        const { account, bonus } = result;
        logger.info(`Member account ${account.id}: linked Discord ${account.discord_user_id} (${bonus.kind === 'new' ? `link #${bonus.linkNumber}${bonus.pro ? ', Pro bonus' : ''}${bonus.letter ? ', letter claim' : ''}` : 'linked before, no bonus'})`);
        const fresh = await sessions.rotate(session.id, { userId: account.discord_user_id, username: account.username, accountId: account.id });
        res.append('Set-Cookie', serializeCookie(sessionCookie, signValue(fresh.id, key), { ...cookieOptions, maxAgeMs: sessionTtlMs }));
        await sessions.setFlash?.(fresh.id, bonusText(bonus));
        return res.redirect(303, '/me/linked');
    }

    async function letterOffer(account) {
        const bonus = account.discord_user_id ? await store.bonusOf(account.discord_user_id) : null;
        if (!store.canClaimLetter(bonus, account)) return null;
        return { letters: await store.freeLetters() };
    }

    async function linked(req, res) {
        const me = await current(req);
        if (!me) return toLogin(res);
        if (!me.account.discord_user_id) return res.redirect(303, '/me');
        const flash = me.session.flash || null;
        if (flash) await sessions.setFlash?.(me.session.id, null);
        return page(res, 200, linkedPage(ctx(), { session: me.session, account: me.account, flash, offer: await letterOffer(me.account) }));
    }

    async function letterPost(req, res) {
        const me = await current(req);
        if (!me) return toLogin(res);
        if (!sessionOk(req, me.session)) return notAllowed(res);
        const letter = normalizeLetter(req.body?.letter);
        if (!letter) return page(res, 400, linkedPage(ctx(), { session: me.session, account: me.account, flash: 'Pick one letter or number.', offer: await letterOffer(me.account) }));
        try {
            const account = await store.claimLetter({ accountId: me.account.id, letter });
            logger.info(`Member account ${account.id}: claimed a 1-letter username`);
            const fresh = await sessions.rotate(me.session.id, { userId: account.discord_user_id, username: account.username, accountId: account.id });
            res.append('Set-Cookie', serializeCookie(sessionCookie, signValue(fresh.id, key), { ...cookieOptions, maxAgeMs: sessionTtlMs }));
            await sessions.setFlash?.(fresh.id, `Your username is now ${account.username}. Use it to log in.`);
            return res.redirect(303, '/me/account');
        } catch (error) {
            if (!(error instanceof AccountError)) throw error;
            return page(res, error.status, linkedPage(ctx(), { session: me.session, account: me.account, flash: error.userMessage, offer: await letterOffer(me.account) }));
        }
    }

    async function letterDecline(req, res) {
        const me = await current(req);
        if (!me) return toLogin(res);
        if (!sessionOk(req, me.session)) return notAllowed(res);
        await store.declineLetter(me.account.id);
        await sessions.setFlash?.(me.session.id, `You kept the username ${me.account.username}.`);
        return res.redirect(303, '/me/account');
    }

    // ── Account settings ─────────────────────────────────────────────────

    async function renderSettings(res, me, status = 200, { error = null } = {}) {
        let flash = null;
        if (status === 200 && me.session.flash) {
            flash = me.session.flash;
            await sessions.setFlash?.(me.session.id, null);
        }
        const recoveryLeft = me.account.totp_enabled_at ? await store.recoveryCodesLeft(me.account.id) : 0;
        const canClaim = Boolean(await letterOffer(me.account));
        return page(res, status, accountSettingsPage(ctx(), { session: me.session, account: me.account, flash, error, recoveryLeft, canClaim }));
    }

    async function settingsPage(req, res) {
        const me = await current(req);
        if (!me) return toLogin(res);
        return renderSettings(res, me);
    }

    /** POST guard for settings: logged in, same origin + CSRF, and a password-try budget. */
    async function settingsGuard(req, res) {
        const me = await current(req);
        if (!me) { toLogin(res); return null; }
        if (!sessionOk(req, me.session)) { notAllowed(res); return null; }
        if (!codeLimiter.allow(`settings:${me.account.id}`)) {
            res.set('Retry-After', '60');
            await renderSettings(res, me, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
            return null;
        }
        return me;
    }

    async function flashBack(res, me, text) {
        await sessions.setFlash?.(me.session.id, text);
        return res.redirect(303, '/me/account');
    }

    async function passwordPost(req, res) {
        const me = await settingsGuard(req, res);
        if (!me) return undefined;
        if (!(await verifyPassword(secretField(req.body?.password), me.account.password_hash))) return renderSettings(res, me, 401, { error: 'The current password is wrong. Nothing was changed.' });
        const next = validatePassword(req.body?.new_password);
        if (!next.ok) return renderSettings(res, me, 400, { error: next.error });
        await store.setPassword(me.account.id, await hashPassword(next.value, hashParams));
        await sessions.destroyForAccount(me.account.id, me.session.id);
        logger.info(`Member account ${me.account.id}: password changed, other sessions ended`);
        background(() => mail(me.account.email, 'password_changed', { username: me.account.username }));
        return flashBack(res, me, 'Your password was changed. Other logins were ended.');
    }

    async function emailPost(req, res) {
        const me = await settingsGuard(req, res);
        if (!me) return undefined;
        if (!(await verifyPassword(secretField(req.body?.password), me.account.password_hash))) return renderSettings(res, me, 401, { error: 'The password is wrong. Nothing was changed.' });
        const email = validateEmail(str(req.body?.email, 300));
        if (!email.ok) return renderSettings(res, me, 400, { error: email.error });
        if (email.value === me.account.email) return renderSettings(res, me, 400, { error: 'That is already your email address.' });
        const result = await store.setPendingEmail(me.account.id, email.value);
        // A taken address gets the same answer (and no email), so this cannot be used to test addresses.
        if (!result.emailTaken && emailAddressLimiter.allow(email.value)) {
            background(() => sendToken(me.account, 'email_change', email.value));
        }
        return flashBack(res, me, `If ${email.value} can be used, we sent a confirmation link to it. Your email changes when you open the link.`);
    }

    async function twoStepStart(req, res) {
        const me = await settingsGuard(req, res);
        if (!me) return undefined;
        if (me.account.totp_enabled_at) return flashBack(res, me, 'Two-step login is already on.');
        const secret = createTotpSecret();
        return page(res, 200, setupView(me, secret));
    }

    function setupView(me, secret, error = null) {
        // The new secret travels in the form, encrypted and bound to this account, until it is confirmed.
        const pendingBlob = encryptSecret(Buffer.from(`${me.account.id}:${base32Encode(secret)}`), totpKey);
        return totpSetupPage(ctx(), { session: me.session, pending: pendingBlob, secretText: groupedBase32(secret), uri: otpauthUri(secret, me.account.username), error });
    }

    async function twoStepEnable(req, res) {
        const me = await settingsGuard(req, res);
        if (!me) return undefined;
        if (me.account.totp_enabled_at) return flashBack(res, me, 'Two-step login is already on.');
        const plain = decryptSecret(str(req.body?.pending, 400), totpKey)?.toString('utf8') || '';
        const [owner, base32] = plain.split(':');
        if (owner !== String(me.account.id) || !base32) return notAllowed(res);
        const secret = base32Decode(base32);
        const step = verifyTotp(secret, str(req.body?.code, 20));
        if (step === null) return page(res, 400, setupView(me, secret, 'That code is not right. Check the time on your phone and enter the newest code.'));
        const codes = createRecoveryCodes();
        await store.enableTotp(me.account.id, { secretEnc: encryptSecret(secret, totpKey), step, codeHashes: codes.map(hashRecoveryCode) });
        logger.info(`Member account ${me.account.id}: two-step login turned on`);
        return page(res, 200, recoveryCodesPage(ctx(), { codes }));
    }

    async function twoStepDisable(req, res) {
        const me = await settingsGuard(req, res);
        if (!me) return undefined;
        if (!me.account.totp_enabled_at) return flashBack(res, me, 'Two-step login is already off.');
        const passwordOk = await verifyPassword(secretField(req.body?.password), me.account.password_hash);
        const codeOk = passwordOk && await checkCode(me.account, str(req.body?.code, 40));
        if (!codeOk) return renderSettings(res, me, 401, { error: 'The password or the code is wrong. Two-step login is still on.' });
        await store.disableTotp(me.account.id);
        logger.info(`Member account ${me.account.id}: two-step login turned off`);
        background(() => mail(me.account.email, 'two_step_off', { username: me.account.username }));
        return flashBack(res, me, 'Two-step login is off.');
    }

    async function unlinkPost(req, res) {
        const me = await settingsGuard(req, res);
        if (!me) return undefined;
        if (!me.account.discord_user_id) return flashBack(res, me, 'No Discord account is linked.');
        await store.unlinkDiscord(me.account.id);
        await sessions.destroyForAccount(me.account.id, me.session.id);
        const fresh = await sessions.rotate(me.session.id, { userId: null, username: me.account.username, accountId: me.account.id });
        res.append('Set-Cookie', serializeCookie(sessionCookie, signValue(fresh.id, key), { ...cookieOptions, maxAgeMs: sessionTtlMs }));
        logger.info(`Member account ${me.account.id}: Discord unlinked`);
        await sessions.setFlash?.(fresh.id, 'Your Discord account was unlinked.');
        return res.redirect(303, '/me/account');
    }

    async function deletePost(req, res) {
        const me = await settingsGuard(req, res);
        if (!me) return undefined;
        if (req.body?.sure !== 'yes') return renderSettings(res, me, 400, { error: 'Tick the box to confirm that you want to delete your account.' });
        let ok = await verifyPassword(secretField(req.body?.password), me.account.password_hash);
        if (ok && me.account.totp_enabled_at) ok = await checkCode(me.account, str(req.body?.code, 40));
        if (!ok) return renderSettings(res, me, 401, { error: me.account.totp_enabled_at ? 'The password or the code is wrong. Nothing was deleted.' : 'The password is wrong. Nothing was deleted.' });
        await store.deleteAccount(me.account.id);
        await sessions.destroyForAccount(me.account.id);
        await sessions.destroy(me.session.id);
        res.append('Set-Cookie', clearCookie(sessionCookie, cookieOptions));
        logger.info(`Member account ${me.account.id}: deleted by its owner`);
        return page(res, 200, deletedPage(ctx()));
    }

    /** /me for an account without Discord: only "Link your Discord". */
    function linkNeeded(res, me) {
        return page(res, 200, linkDiscordPage(ctx(), me));
    }

    return {
        signupForm, signupPost, resendForm, resendPost, confirmForm, confirmPost, loginForm, loginPost, twoStepForm, twoStepPost,
        forgotForm, forgotPost, resetForm, resetPost, linkPost, linkCallback, linked, letterPost, letterDecline, settingsPage,
        passwordPost, emailPost, twoStepStart, twoStepEnable, twoStepDisable, unlinkPost, deletePost, linkNeeded, current, idle,
        minAge: MIN_AGE,
    };
}
