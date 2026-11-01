// accountRoutes.js — Mewvo accounts on the website, inside the member portal (/me).
// On whenever the member portal is on, unless MEMBER_ACCOUNTS_ENABLED=false. No email at all
// (owner, 2026-11-01): an account is a username and a password, and Discord must be linked.
//
//   GET/POST /me/signup            username, password, date of birth (13+), terms; then the link step
//   GET/POST /me/login-password    username + password (an unlinked account lands on the link step)
//   GET/POST /me/login-2fa         the code step when two-step login is on
//   GET/POST /me/forgot            "Forgot password?": POST starts a Discord login in reset mode
//   GET/POST /me/reset             after that Discord login: a new password for the account that
//                                  Discord id is linked to; ends every session, then logs in
//   GET/POST /me/link              the link step (GET) and the start of the Discord link (POST)
//   GET      /me/linked            the bonus result + the 1-letter claim
//   POST     /me/letter[/decline]  claim or decline a 1-letter username
//   GET      /me/account           settings; POST /me/account/{password,2fa/start,
//                                  2fa/enable,2fa/disable,unlink,delete}
//
// Linking Discord is required: until the account has a Discord id, every /me page except the
// link step, the OAuth callback, logout and delete account redirects to /me/link
// (memberPortal.js, forceLink).
//
// Every POST: same origin + a CSRF token (the session's, or before login a signed
// double-submit cookie, Path=/me). Rate limits per IP, per login name and per account.
// Never logged: passwords, hashes, codes, 2FA secrets.

import crypto from 'node:crypto';
import { afterPremiumChange } from '../billing/premiumEffects.js';
import { logger } from '../../utils/logger.js';
import {
    AccountError, MIN_AGE, PRO_BONUS_LABEL, SCRYPT_PARAMS, base32Decode, base32Encode, checkAge,
    createRecoveryCodes, createTotpSecret, decryptSecret, encryptSecret, groupedBase32, hashPassword, hashRecoveryCode,
    normalizeLetter, normalizeRecoveryCode, otpauthUri, totpEncryptionKey, validatePassword, validateUsername,
    verifyAgainstDummy, verifyPassword, verifyTotp,
} from '../accounts/accountCore.js';
import { clearCookie, createRateLimiter, hmac, isSameOrigin, parseCookies, safeEqual, serializeCookie, signValue, verifySignedValue } from '../dashboard/security.js';
import {
    accountMessagePage, accountSettingsPage, deletedPage, doneLoginPage, forgotPage, linkDiscordPage, linkedPage, passwordLoginPage,
    recoveryCodesPage, resetPage, signupPage, totpSetupPage, twoStepPage,
} from './accountPages.js';

export const FORM_COOKIE = 'mewvo_me_form';
export const TWO_STEP_COOKIE = 'mewvo_me_2fa';
export const TWO_STEP_TTL_MS = 5 * 60 * 1000;
export const RESET_COOKIE = 'mewvo_me_reset';
/** How long the new-password form works after the Discord login (single use). */
export const RESET_TTL_MS = 10 * 60 * 1000;
const TWO_STEP_MAX_TRIES = 5;
const FIFTEEN_MIN = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const ACCOUNT_LIMITS = {
    loginIp: { limit: 10, windowMs: FIFTEEN_MIN },
    loginName: { limit: 10, windowMs: FIFTEEN_MIN },
    code: { limit: 10, windowMs: FIFTEEN_MIN },
    signupIp: { limit: 5, windowMs: HOUR },
    resetIp: { limit: 10, windowMs: HOUR }, // "Forgot password?" Discord logins started
};

const explicitlyOff = (value) => /^(0|false|no|off)$/i.test(String(value ?? '').trim());
const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
// Passwords are taken as typed (no trim), only capped.
const secretField = (value) => (typeof value === 'string' ? value.slice(0, 400) : '');

/**
 * Accounts are on whenever the member portal is on; MEMBER_ACCOUNTS_ENABLED=false (or 0/no/off)
 * turns them off. No email settings are needed. { requested, enabled, problems, totpKey }.
 */
export function memberAccountSettings(env = process.env, portal = null) {
    const requested = !explicitlyOff(env.MEMBER_ACCOUNTS_ENABLED);
    const settings = { requested, enabled: false, problems: [], totpKey: null };
    if (!requested || !portal?.enabled) return settings;
    try {
        settings.totpKey = totpEncryptionKey(env.SESSION_SECRET);
    } catch {
        settings.problems.push('SESSION_SECRET must be at least 32 characters');
    }
    settings.enabled = settings.problems.length === 0;
    return settings;
}

/** The text shown after linking Discord, honest about what this link got. Pure. */
export function bonusText(bonus) {
    if (!bonus || bonus.kind === 'repeat') {
        return 'Your Discord account is linked. This Discord account was linked to a Mewvo account before, so it does not get the early-account bonus again.';
    }
    const n = `You are number ${bonus.linkNumber} to link a Discord account to Mewvo.`;
    if (bonus.pro && bonus.letter) return `${n} You get Mewvo Pro for ${PRO_BONUS_LABEL}, and you can pick a 1-letter username below.`;
    if (bonus.pro) return `${n} You get Mewvo Pro for ${PRO_BONUS_LABEL}.`;
    if (bonus.proNote && bonus.letter) return `${n} ${PRO_BONUS_LABEL} of Pro were due, but they could not be added: ${bonus.proNote} You can still pick a 1-letter username below.`;
    if (bonus.proNote) return `${n} ${PRO_BONUS_LABEL} of Pro were due, but they could not be added: ${bonus.proNote}`;
    if (bonus.letter) return `${n} You can pick a 1-letter username below.`;
    return `${n} The early-account bonuses went to the first 100 accounts, so there is no bonus for this one.`;
}


/**
 * The handlers. core: { settings (portal), accountSettings, store, sessions, ctx, send,
 * clientIp, cookieOptions, key, sessionCookie, cookieSessionId, readSession, startLink(req, res, accountId),
 * startReset(req, res) (a Discord login in reset mode), limits, hashParams (scrypt cost; tests
 * use a low one), after (premium follow-up) }.
 */
export function createAccountHandlers(core) {
    const {
        settings, accountSettings, store, sessions, ctx, send, clientIp, cookieOptions, key, sessionCookie, cookieSessionId, readSession,
        startLink, startReset, limits = ACCOUNT_LIMITS, hashParams = SCRYPT_PARAMS, after = afterPremiumChange, sessionTtlMs,
    } = core;
    const formKey = hmac('mewvo member form v1', key);
    const twoStepKey = hmac('mewvo member 2fa v1', key);
    const resetKey = hmac('mewvo member reset v1', key);
    const totpKey = accountSettings.totpKey;
    const lim = (name) => createRateLimiter(limits[name] || ACCOUNT_LIMITS[name]);
    const loginIpLimiter = lim('loginIp');
    const loginNameLimiter = lim('loginName');
    const codeLimiter = lim('code');
    const signupLimiter = lim('signupIp');
    const resetIpLimiter = lim('resetIp');
    const challenges = new Map(); // id → { accountId, expiresAt, tries }
    const resets = new Map(); // id → { accountId, discordUserId, expiresAt }
    const page = (res, status, html) => send(res, status, html);
    const tooMany = (res, render) => { res.set('Retry-After', '60'); return page(res, 429, render('Too many tries. Wait a few minutes and try again.')); };
    const home = (account) => (account.discord_user_id ? '/me' : '/me/link');

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

    /** Password (or the Discord reset) done, 2FA on: the code step, bound to this browser. */
    function beginTwoStep(res, account) {
        const id = crypto.randomBytes(24).toString('base64url');
        const now = Date.now();
        for (const [k, c] of challenges) if (c.expiresAt <= now) challenges.delete(k);
        challenges.set(id, { accountId: account.id, expiresAt: now + TWO_STEP_TTL_MS, tries: 0 });
        res.append('Set-Cookie', serializeCookie(TWO_STEP_COOKIE, signValue(id, twoStepKey), { ...cookieOptions, maxAgeMs: TWO_STEP_TTL_MS }));
        return res.redirect(303, '/me/login-2fa');
    }

    // ── Sign up ──────────────────────────────────────────────────────────

    function signupForm(req, res) {
        return page(res, 200, signupPage(ctx(), { csrf: formToken(req, res) }));
    }

    async function signupPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        const csrf = formToken(req, res);
        const values = { username: str(req.body?.username, 60) };
        const again = (status, error) => page(res, status, signupPage(ctx(), { csrf, values, error }));
        if (!signupLimiter.allow(clientIp(req))) { res.set('Retry-After', '600'); return again(429, 'Too many new accounts from your address. Try again later.'); }
        const username = validateUsername(values.username);
        if (!username.ok) return again(400, username.error);
        const password = validatePassword(req.body?.password);
        if (!password.ok) return again(400, password.error);
        const age = checkAge(req.body?.birth_date);
        if (!age.ok) return again(400, age.error);
        if (req.body?.accept !== 'yes') return again(400, 'Accept the Terms and Conditions and the Privacy Policy to create an account.');
        const passwordHash = await hashPassword(password.value, hashParams);
        let created;
        try {
            created = await store.createAccount({ username: username.value, passwordHash });
        } catch (error) {
            if (error instanceof AccountError) return again(error.status, error.userMessage);
            throw error;
        }
        logger.info(`Member account created: account ${created.account.id} (Discord not linked yet)`);
        // Logged in at once; the next step is linking Discord, which is required.
        await startSession(req, res, created.account);
        return res.redirect(303, '/me/link');
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
        const wrong = (status = 401) => page(res, status, passwordLoginPage(ctx(), { csrf, identifier, error: 'Wrong username or password.' }));
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
        if (account.totp_enabled_at) return beginTwoStep(res, account);
        await startSession(req, res, account);
        return res.redirect(303, home(account));
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
        return res.redirect(303, home(account));
    }

    // ── Forgotten password: through the linked Discord account ───────────

    function forgotForm(req, res) {
        return page(res, 200, forgotPage(ctx(), { csrf: formToken(req, res) }));
    }

    /** POST /me/forgot: a Discord login in reset mode (portal OAuth, state + a reset cookie bound to it). */
    async function forgotPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        if (!resetIpLimiter.allow(clientIp(req))) return tooMany(res, (error) => forgotPage(ctx(), { csrf: formToken(req, res), error }));
        return startReset(req, res);
    }

    function resetOf(req) {
        const id = verifySignedValue(parseCookies(req.headers?.cookie)[RESET_COOKIE], resetKey);
        const grant = id ? resets.get(id) : null;
        if (!grant || grant.expiresAt <= Date.now()) return null;
        return { id, grant };
    }
    const resetExpired = (res) => page(res, 400, accountMessagePage(ctx(), 'Start again',
        'This password reset expired or was already used. Choose Forgot password? again and log in with Discord.', { href: '/me/forgot', label: 'Forgot password?' }));

    /**
     * Called by the portal's OAuth callback in reset mode, with the Discord user who just
     * proved they own that Discord account. Only that person learns whether it has a Mewvo account.
     */
    async function resetCallback(req, res, { discordUser }) {
        const account = await store.findByDiscordId(String(discordUser.id));
        if (!account) {
            return page(res, 404, accountMessagePage(ctx(), 'No account found',
                'No Mewvo account is linked to this Discord account, so there is no password to reset. You can create a new account instead.', { href: '/me/signup', label: 'Create an account' }));
        }
        const id = crypto.randomBytes(24).toString('base64url');
        const now = Date.now();
        for (const [k, g] of resets) if (g.expiresAt <= now) resets.delete(k);
        resets.set(id, { accountId: String(account.id), discordUserId: String(discordUser.id), expiresAt: now + RESET_TTL_MS });
        res.append('Set-Cookie', serializeCookie(RESET_COOKIE, signValue(id, resetKey), { ...cookieOptions, maxAgeMs: RESET_TTL_MS }));
        logger.info(`Member account ${account.id}: password reset started through Discord`);
        return res.redirect(303, '/me/reset');
    }

    async function resetForm(req, res) {
        const found = resetOf(req);
        if (!found) return resetExpired(res);
        const account = await store.findById(found.grant.accountId);
        if (!account) return resetExpired(res);
        return page(res, 200, resetPage(ctx(), { csrf: formToken(req, res), username: account.username }));
    }

    async function resetPost(req, res) {
        if (!formOk(req)) return notAllowed(res);
        const csrf = formToken(req, res);
        const found = resetOf(req);
        if (!found) return resetExpired(res);
        const { id, grant } = found;
        const account = await store.findById(grant.accountId);
        // Unlinked or relinked since the Discord login: that login no longer proves anything.
        if (!account || account.discord_user_id !== grant.discordUserId) {
            resets.delete(id);
            res.append('Set-Cookie', clearCookie(RESET_COOKIE, cookieOptions));
            return resetExpired(res);
        }
        const password = validatePassword(req.body?.password);
        if (!password.ok) return page(res, 400, resetPage(ctx(), { csrf, username: account.username, error: password.error }));
        resets.delete(id);
        res.append('Set-Cookie', clearCookie(RESET_COOKIE, cookieOptions));
        await store.setPassword(account.id, await hashPassword(password.value, hashParams));
        await sessions.destroyForAccount(account.id);
        logger.info(`Member account ${account.id}: password reset through Discord, all sessions ended`);
        // Two-step login stays: Discord replaces the password, not the code.
        if (account.totp_enabled_at) return beginTwoStep(res, account);
        const session = await startSession(req, res, account);
        await sessions.setFlash?.(session.id, 'Your new password is saved. Every other login was ended.');
        return res.redirect(303, '/me/account');
    }

    // ── Discord link (required) and bonuses ──────────────────────────────

    /** GET /me/link: the link step. Every other page sends an unlinked account here. */
    async function linkPage(req, res) {
        const me = await current(req);
        if (!me) return toLogin(res);
        if (me.account.discord_user_id) {
            // Linked meanwhile (in another browser): this session gets the Discord id too.
            if (!me.session.userId) {
                const fresh = await sessions.rotate(me.session.id, { userId: me.account.discord_user_id, username: me.account.username, accountId: me.account.id });
                res.append('Set-Cookie', serializeCookie(sessionCookie, signValue(fresh.id, key), { ...cookieOptions, maxAgeMs: sessionTtlMs }));
            }
            return res.redirect(303, '/me');
        }
        let flash = null;
        if (me.session.flash) {
            flash = me.session.flash;
            await sessions.setFlash?.(me.session.id, null);
        }
        return page(res, 200, linkDiscordPage(ctx(), { session: me.session, account: me.account, flash }));
    }

    async function linkPost(req, res) {
        const me = await current(req);
        if (!me) return toLogin(res);
        if (!sessionOk(req, me.session)) return notAllowed(res);
        if (me.account.discord_user_id) return res.redirect(303, '/me/link');
        return startLink(req, res, me.account.id);
    }

    /** Called by the portal's OAuth callback in link mode, with the Discord user. */
    async function linkCallback(req, res, { session, discordUser }) {
        let result;
        try {
            result = await store.linkDiscord({ accountId: session.accountId, discordUserId: String(discordUser.id), discordUsername: discordUser.global_name || discordUser.username || null });
        } catch (error) {
            if (!(error instanceof AccountError)) throw error;
            return page(res, error.status, accountMessagePage(ctx(), 'Not linked', error.userMessage, { href: '/me/link', label: 'Back' }));
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
        if (!me.account.discord_user_id) return res.redirect(303, '/me/link');
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
        // Not linked: only the link step (with Delete account) is open.
        if (!me.account.discord_user_id) return page(res, status, linkDiscordPage(ctx(), { session: me.session, account: me.account, error }));
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
        if (!me.account.discord_user_id) return res.redirect(303, '/me/link');
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
        return flashBack(res, me, 'Your password was changed. Other logins were ended.');
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
        return flashBack(res, me, 'Two-step login is off.');
    }

    async function unlinkPost(req, res) {
        const me = await settingsGuard(req, res);
        if (!me) return undefined;
        if (!me.account.discord_user_id) return res.redirect(303, '/me/link');
        await store.unlinkDiscord(me.account.id);
        await sessions.destroyForAccount(me.account.id, me.session.id);
        const fresh = await sessions.rotate(me.session.id, { userId: null, username: me.account.username, accountId: me.account.id });
        res.append('Set-Cookie', serializeCookie(sessionCookie, signValue(fresh.id, key), { ...cookieOptions, maxAgeMs: sessionTtlMs }));
        logger.info(`Member account ${me.account.id}: Discord unlinked`);
        await sessions.setFlash?.(fresh.id, 'Your Discord account was unlinked. Link a Discord account again to keep using your Mewvo account.');
        return res.redirect(303, '/me/link');
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

    return {
        signupForm, signupPost, loginForm, loginPost, twoStepForm, twoStepPost, forgotForm, forgotPost, resetCallback, resetForm, resetPost,
        linkPage, linkPost, linkCallback, linked, letterPost, letterDecline, settingsPage, passwordPost, twoStepStart, twoStepEnable,
        twoStepDisable, unlinkPost, deletePost, current, minAge: MIN_AGE,
    };
}
