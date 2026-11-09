// oauthVerification.js — verification through Discord OAuth2 instead of a plain button.
//
// The Verify button answers with a private "Verify with Discord" link. The link's
// `state` is signed (HMAC with the client secret), names the guild and the user who
// pressed the button, and expires after 10 minutes. Discord sends the user back to
// GET /oauth/callback; the bot exchanges the code, checks the authorizing account is
// the one that pressed Verify, gives the verified role, stores the OAuth tokens
// encrypted (AES-256-GCM with OAUTH_TOKEN_KEY) so guilds.join can be used later (Mewvo's own servers only), and
// records which server the authorization was given in (oauth_verified_guilds, schema v12: a
// member restore only uses it for that server), and sends the browser on to the Mewvo invite (VERIFY_SUCCESS_REDIRECT; another server: only the
// link it stored, else a "You are verified" page — successRedirectFor). Accounts under
// 7 days old and likely ban-evasion alts are held for staff approval instead
// (see verificationGuard.js).
//
// Scopes per server (owner decision D3, 2026-11-09): Mewvo's own servers (main, support,
// MEMBER_RESTORE_GUILD_IDS) ask for `identify guilds.join` and keep the token for the member
// backup, exactly as before; any other server asks for `identify` only and keeps nothing of the
// token (no row in oauth_verified_guilds either: the member restore is home-only). The result
// pages are in the language stored in the state (the member's Discord language), else the
// mewvo_lang cookie / Accept-Language (site i18n, catalog site/<lang>/verify.json).
//
// Enabled when DISCORD_CLIENT_SECRET and PUBLIC_URL are set; otherwise the button
// verifies directly as before. The redirect URL <PUBLIC_URL>/oauth/callback must be
// added under OAuth2 → Redirects in the Discord Developer Portal.

import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { Routes } from 'discord.js';
import { getFromDb, setInDb, deleteFromDb, db } from '../utils/database.js';
import { verificationSetupProblem, verifyUser } from './verificationService.js';
import { query, T } from './enforcement/db.js';
import { enforcementConfig } from '../config/enforcement.js';
import { assessVerification, postVerificationHold } from './verificationGuard.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getConfiguredSetting, isHomeGuild, resolveSetting } from './settings/guildSettings.js';
import { privacyUrl } from '../utils/privacyNotice.js';
import { clearExpectedBotAdd, expectBotAdd } from './invites/expectedAdds.js';
import { allowedRestoreGuildIds } from './memberBackupService.js';
import { DEFAULT_LANG, isLanguage, translator } from './site/i18n.js';
import { requestLanguage } from './site/language.js';
import { botText } from '../utils/botText.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_KEY_PREFIX = 'oauth:tokens:';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const ME_URL = 'https://discord.com/api/v10/users/@me';
const HOME_SCOPES = Object.freeze(['identify', 'guilds.join']);
const SERVER_SCOPES = Object.freeze(['identify']);
// Where the browser goes after a successful verification in one of Mewvo's own servers: the main
// Mewvo server's invite. Never used for any other server (successRedirectFor).
const DEFAULT_SUCCESS_REDIRECT = 'https://discord.gg/WyceK9YENP';
const STATE_TTL_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10000;

// Single use: a used state's nonce is kept in memory (fast path, same process) and in the
// key-value store with a TTL until the state would have expired anyway (survives a restart).
const usedStates = new Map();
const USED_STATE_KEY_PREFIX = 'oauth:state_used:';

function settings() {
    const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    return {
        clientId: (process.env.CLIENT_ID || '').trim(),
        clientSecret: (process.env.DISCORD_CLIENT_SECRET || '').trim(),
        redirectUri: publicUrl ? `${publicUrl}/oauth/callback` : '',
        tokenKey: /^[0-9a-f]{64}$/i.test(process.env.OAUTH_TOKEN_KEY || '')
            ? Buffer.from(process.env.OAUTH_TOKEN_KEY, 'hex')
            : null,
    };
}

export function isOAuthVerificationEnabled() {
    const { clientId, clientSecret, redirectUri } = settings();
    return Boolean(clientId && clientSecret && redirectUri);
}

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Whether a verification in `guildId` asks for guilds.join and keeps the token: Mewvo's own
 * servers (MAIN_GUILD_ID / SUPPORT_GUILD_ID) and the member-restore targets
 * (MEMBER_RESTORE_GUILD_IDS, memberBackupService.js). Any other server: false (identify only).
 */
export function keepsVerifyToken(guildId, env = process.env) {
    const id = String(guildId || '');
    if (!id) return false;
    return isHomeGuild(id, env) || allowedRestoreGuildIds(enforcementConfig, env).has(id);
}

/** The OAuth scopes a verification in `guildId` asks for (see keepsVerifyToken). */
export function oauthScopesFor(guildId, env = process.env) {
    return [...(keepsVerifyToken(guildId, env) ? HOME_SCOPES : SERVER_SCOPES)];
}

function createState(guildId, userId, lang = null) {
    const payload = Buffer.from(JSON.stringify({
        g: guildId,
        u: userId,
        e: Date.now() + STATE_TTL_MS,
        n: crypto.randomBytes(8).toString('hex'),
        // The member's language for the result pages (only a known code; never shown raw).
        ...(isLanguage(lang) ? { l: lang } : {}),
    })).toString('base64url');
    return `${payload}.${sign(payload, settings().clientSecret)}`;
}

/** The decoded payload of a correctly signed state (expired or used ones too), else null. */
function signedPayload(state) {
    const [payload, signature] = String(state || '').split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload, settings().clientSecret));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return data && typeof data === 'object' ? data : null;
    } catch {
        return null;
    }
}

/**
 * The language a signed state carries (also an expired or used one: the "link expired" page is
 * still in the member's language), else null. Only a known language code is ever returned.
 */
export function stateLanguage(state) {
    const lang = signedPayload(state)?.l;
    return isLanguage(lang) ? lang : null;
}

/**
 * Returns { guildId, userId, lang } for a valid, unexpired, unused state, else null, and marks it
 * used. Throws when the store cannot be read or written (the link is then burned in memory:
 * the member presses Verify again).
 */
export async function readState(state, { getStored = getFromDb, setStored = setInDb } = {}) {
    const data = signedPayload(state);
    if (!data) return null;
    const now = Date.now();
    if (!data?.g || !data?.u || !(data.e > now) || usedStates.has(data.n)) return null;

    for (const [nonce, expiresAt] of usedStates) {
        if (expiresAt <= now) usedStates.delete(nonce);
    }
    // Marked in memory before any await, so two requests in this process can never both pass.
    usedStates.set(data.n, data.e);

    const key = `${USED_STATE_KEY_PREFIX}${data.n}`;
    if (await getStored(key, null)) return null;
    await setStored(key, true, Math.ceil((data.e - now) / 1000) + 60);
    return { guildId: data.g, userId: data.u, ...(isLanguage(data.l) ? { lang: data.l } : {}) };
}

/**
 * Where the browser goes after verifying in `guildId` (the guild named in the signed state), or
 * null for "show the verified page". Mewvo's own servers: VERIFY_SUCCESS_REDIRECT / the stored
 * value, else the main Mewvo invite, exactly as before. Any other server: only the link it stored
 * itself; never Mewvo's invite. Throws SettingsUnavailableError when that server's settings
 * cannot be read (the callback asks this before it changes anything).
 */
export function successRedirectFor(guildId, env = process.env) {
    if (isHomeGuild(guildId, env)) return getConfiguredSetting('verifySuccessRedirect', env) || DEFAULT_SUCCESS_REDIRECT;
    return resolveSetting(guildId, 'verifySuccessRedirect', env) || null;
}

/**
 * The Discord authorize link for this user to verify in this guild. Scopes per server
 * (oauthScopesFor); `lang` (the member's language) goes into the signed state for the result pages.
 */
export function buildVerifyUrl(guildId, userId, { lang = null } = {}) {
    const { clientId, redirectUri } = settings();
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: oauthScopesFor(guildId).join(' '),
        state: createState(guildId, userId, lang),
        prompt: 'consent',
    });
    return `${AUTHORIZE_URL}?${params}`;
}

async function discordFetch(url, options) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(`Discord answered ${response.status}: ${body.error_description || body.error || body.message || 'unknown error'}`);
        error.status = response.status;
        throw error;
    }
    return body;
}

function exchangeCode(code) {
    const { clientId, clientSecret, redirectUri } = settings();
    return discordFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
        }),
    });
}

function encrypt(text, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
}

function decrypt(payload, key) {
    const [iv, tag, data] = String(payload).split('.').map((part) => Buffer.from(part, 'base64'));
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed encrypted token');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

let warnedNoTokenKey = false;

async function storeTokens(userId, token) {
    const { tokenKey } = settings();
    if (!tokenKey) {
        if (!warnedNoTokenKey) {
            logger.warn('OAUTH_TOKEN_KEY is not set (64 hex characters); OAuth tokens are not stored, so guilds.join cannot be used later');
            warnedNoTokenKey = true;
        }
        return;
    }
    await setInDb(`oauth:tokens:${userId}`, {
        scope: token.scope,
        expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
        tokens: encrypt(JSON.stringify({ access: token.access_token, refresh: token.refresh_token }), tokenKey),
        updatedAt: new Date().toISOString(),
    });
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The privacy line on a callback page, in `lang`: the sentence for this kind of server (`home`:
 * Mewvo's own servers keep a token; any other server does not), plus a link when PUBLIC_URL is set.
 */
export function privacyNoteHtml(env = process.env, { lang = DEFAULT_LANG, home = true } = {}) {
    const sentence = escapeHtml(botText(lang).t(home ? 'verification.privacy.oauth' : 'verification.privacy.oauthServer'));
    const url = privacyUrl(env);
    return url ? `${sentence} <a href="${escapeHtml(url)}">${escapeHtml(translator(lang).t('verify.privacyLink'))}</a>` : sentence;
}

// The result pages' one stylesheet. Fixed text, so the page's CSP allows exactly this style by its
// hash (no 'unsafe-inline', no script, nothing loaded from anywhere).
const PAGE_STYLE = 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;color:#f2f3f5;font:16px/1.5 system-ui,sans-serif}'
    + 'main{max-width:420px;padding:32px 24px;text-align:center}h1{color:#ed4245;font-size:22px;margin:0 0 8px}h1.ok{color:#57f287}h1.wait{color:#fee75c}'
    + 'p{margin:0;color:#b5bac1}p.note{margin-top:16px;font-size:13px}a{color:#c9cdfb}';
const PAGE_STYLE_HASH = crypto.createHash('sha256').update(PAGE_STYLE).digest('base64');
/** The Content-Security-Policy of the /oauth/callback pages. */
export const RESULT_PAGE_CSP = `default-src 'none'; style-src 'sha256-${PAGE_STYLE_HASH}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const ACCENT_CLASS = { '#57f287': 'ok', '#fee75c': 'wait' };

/**
 * A result page. `title` and `message` are HTML (callers escape what they did not write);
 * `accent`: '#57f287' green, '#fee75c' yellow, anything else red. `lang`: the <html lang>.
 */
export function errorPage(title, message, accent = '#ed4245', { note = null, lang = DEFAULT_LANG } = {}) {
    const tone = ACCENT_CLASS[accent];
    return `<!doctype html><html lang="${isLanguage(lang) ? lang : DEFAULT_LANG}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1${tone ? ` class="${tone}"` : ''}>${title}</h1><p>${message}</p>${note ? `<p class="note">${note}</p>` : ''}</main></body></html>`;
}

async function isAlreadyVerified(client, guildId, userId) {
    const guild = client.guilds.cache.get(guildId);
    const config = guild ? await getGuildConfig(client, guildId).catch(() => null) : null;
    const roleId = config?.verification?.roleId;
    const member = roleId ? await guild.members.fetch(userId).catch(() => null) : null;
    return Boolean(member?.roles.cache.has(roleId));
}

// A held verification posts one staff card per user per hour, however often they retry.
const HOLD_CARD_INTERVAL_MS = 60 * 60 * 1000;
const recentHolds = new Map();

async function holdForStaff(client, guildId, userId, reasons, items = null) {
    const key = `${guildId}:${userId}`;
    if (Date.now() - (recentHolds.get(key) || 0) < HOLD_CARD_INTERVAL_MS) return;
    recentHolds.set(key, Date.now());
    const user = await client.users.fetch(userId);
    await postVerificationHold(client, guildId, user, reasons, items);
    logger.info(`Verification of ${userId} in ${guildId} held for staff: ${reasons.join('; ')}`);
}

/**
 * GET /oauth/callback (exported for tests). Every page is in the member's language and sent with
 * RESULT_PAGE_CSP. Mewvo's own servers: identify + guilds.join, the token kept for the member
 * backup. Any other server: identify only; nothing of the token is read, recorded or stored
 * (owner decision D3).
 */
export async function handleOAuthCallback(client, req, res, deps = {}) {
    const {
        read = readState, setupProblem = verificationSetupProblem, exchange = exchangeCode, fetchMe = (token) => discordFetch(ME_URL, { headers: { Authorization: `Bearer ${token.access_token}` } }),
        getStored = getFromDb, record = recordAuthorization, store = storeTokens, alreadyVerified = isAlreadyVerified,
        assess = assessVerification, hold = holdForStaff, verify = verifyUser, markVerified = markVerifiedIn, redirectFor = successRedirectFor,
        env = process.env,
    } = deps;
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', RESULT_PAGE_CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    // The member's language from the signed state (set when the link was built), else the
    // website's cookie / Accept-Language. Only known codes; nothing from the request is echoed.
    let lang = stateLanguage(req.query?.state) || requestLanguage(req);
    let tr = translator(lang);
    const send = (status, key, accent, { note = null, message = null } = {}) => res.status(status).type('html')
        .send(errorPage(escapeHtml(tr.t(`verify.${key}.title`)), message ?? escapeHtml(tr.t(`verify.${key}.message`)), accent, { note, lang }));

    if (req.query?.error) return send(400, 'cancelled');
    let state;
    try {
        state = await read(req.query?.state);
    } catch (error) {
        logger.warn(`OAuth verification: could not check the link (database): ${error.message}`);
        return send(503, 'unavailable');
    }
    if (!state || typeof req.query?.code !== 'string') return send(400, 'expired');
    // The state that was read is the authority (readState only returns known codes).
    if (state.lang && state.lang !== lang) {
        lang = state.lang;
        tr = translator(lang);
    }
    const home = keepsVerifyToken(state.guildId, env);
    const note = () => privacyNoteHtml(env, { lang, home });

    try {
        // Read first: a server whose settings cannot be read fails here, before anything changed.
        const redirect = redirectFor(state.guildId);
        // That server's own verification must be set up, before anything is stored.
        const problem = await setupProblem(client, state.guildId, { lang });
        if (problem) return send(409, 'notSetUp', undefined, { message: escapeHtml(problem.replace(/`/g, '')) });
        const token = await exchange(req.query.code);
        const me = await fetchMe(token);
        if (me.id !== state.userId) return send(403, 'wrongAccount');

        // Mewvo's own servers. The server comes first: a token is only stored once the server it
        // was given in is recorded, so a stored token always says where it may be used (member
        // restore). If the stored token cannot even be read, nothing is recorded or stored: the rows
        // could not be kept consistent with it (a pre-v12 token would lose its home server, stale
        // rows could stay). Any other server: nothing (an identify-only token cannot add anyone
        // anywhere, and must never replace a member's home-server token).
        let recorded = false;
        if (home) {
            const hadToken = await getStored(`${TOKEN_KEY_PREFIX}${me.id}`, null).then(Boolean, () => null);
            recorded = hadToken !== null && await record(me.id, state.guildId, { hadToken })
                .then(() => true, (error) => {
                    logger.error(`Could not record the OAuth authorization of ${me.id} in ${state.guildId}; token not stored: ${error.message}`);
                    return false;
                });
            if (hadToken === null) logger.error(`Could not read the stored OAuth token of ${me.id}; authorization in ${state.guildId} not recorded, token not stored`);
            if (recorded) {
                await store(me.id, token).catch((error) => logger.error(`Could not store OAuth tokens for ${me.id}: ${error.message}`));
            }
        }

        if (!(await alreadyVerified(client, state.guildId, me.id))) {
            const assessment = await assess(state.guildId, me.id, req.ip);
            if (assessment.hold) {
                await hold(client, state.guildId, me.id, assessment.reasons, assessment.items);
                return send(202, 'held', '#fee75c', { note: note() });
            }
        }

        await verify(client, state.guildId, me.id, { source: 'oauth', moderatorId: null });
        if (recorded) {
            await markVerified(me.id, state.guildId)
                .catch((error) => logger.error(`Could not record the verification of ${me.id} in ${state.guildId}: ${error.message}`));
        }
        if (redirect) return res.redirect(303, redirect);
        return send(200, 'verified', '#57f287', { note: note() });
    } catch (error) {
        logger.error(`OAuth verification failed for state user ${state.userId}: ${error.message}`);
        // A service's own message is English: shown only on an English page; otherwise the translated one.
        const own = lang === DEFAULT_LANG && error.userMessage ? escapeHtml(String(error.userMessage).replace(/[<>&"]/g, '')) : null;
        return send(error.status === 400 ? 400 : 500, 'failed', undefined, { message: own });
    }
}

/** Adds GET /oauth/callback to the bot's web server. */
export function registerOAuthRoutes(app, client) {
    if (!isOAuthVerificationEnabled()) {
        logger.info('OAuth verification is off (set DISCORD_CLIENT_SECRET and PUBLIC_URL to enable it)');
        return;
    }

    app.get('/oauth/callback', (req, res) => handleOAuthCallback(client, req, res));
    logger.info('OAuth verification enabled at /oauth/callback');
}

// ── Where each member verified (schema v12, multi-server B1) ──────────────

/**
 * Records that `userId` authorized "Verify with Discord" in `guildId` (verified_at stays as it
 * was: markVerifiedIn sets it once they are verified). `hadToken` (true / false / null = unknown):
 *   - true: if the stored token is from before v12 (no rows yet), that authorization came from
 *     Mewvo's own servers, so `homeGuildId` is recorded as verified first and keeps counting there;
 *   - false: no token is stored, so rows left from an earlier, deleted token no longer apply and
 *     are removed (a fresh authorization only covers this server);
 *   - null: the token could not be read; existing rows are left alone.
 * Throws on a database error.
 */
export async function recordAuthorization(userId, guildId, { hadToken = null, homeGuildId = enforcementConfig.mainGuildId, q = query } = {}) {
    if (hadToken === false) {
        await q(`DELETE FROM ${T.oauthVerifiedGuilds} WHERE user_id = $1`, [userId]);
    }
    if (hadToken === true && homeGuildId) {
        await q(
            `INSERT INTO ${T.oauthVerifiedGuilds} (user_id, guild_id, authorized_at, verified_at)
             SELECT $1::varchar, $2::varchar, NOW(), NOW()
             WHERE NOT EXISTS (SELECT 1 FROM ${T.oauthVerifiedGuilds} WHERE user_id = $1::varchar)
             ON CONFLICT (user_id, guild_id) DO NOTHING`,
            [userId, homeGuildId]
        );
    }
    await q(
        `INSERT INTO ${T.oauthVerifiedGuilds} (user_id, guild_id, authorized_at) VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, guild_id) DO UPDATE SET authorized_at = NOW()`,
        [userId, guildId]
    );
}

/** Marks the member as verified in `guildId` (they authorized there first). Returns whether a row changed; throws on a database error. */
export async function markVerifiedIn(userId, guildId, { q = query } = {}) {
    const { rowCount } = await q(
        `UPDATE ${T.oauthVerifiedGuilds} SET verified_at = NOW() WHERE user_id = $1 AND guild_id = $2`,
        [userId, guildId]
    );
    return rowCount > 0;
}

/** Deletes the member's rows (with their token: /wipedata). Throws on a database error. */
export async function forgetVerifiedGuilds(userId, { q = query } = {}) {
    await q(`DELETE FROM ${T.oauthVerifiedGuilds} WHERE user_id = $1`, [userId]);
}

/**
 * The servers each of `userIds` was verified in: Map userId → Set(guildId). A user with no rows at
 * all is missing from the map (token from before v12); a user with rows but no verified one has an
 * empty Set. Throws on a database error.
 */
export async function verifiedGuildsOf(userIds, { q = query } = {}) {
    const result = new Map();
    if (!userIds.length) return result;
    const { rows } = await q(
        `SELECT user_id, guild_id, verified_at FROM ${T.oauthVerifiedGuilds} WHERE user_id = ANY($1::varchar[])`,
        [userIds]
    );
    for (const row of rows) {
        if (!result.has(row.user_id)) result.set(row.user_id, new Set());
        if (row.verified_at) result.get(row.user_id).add(row.guild_id);
    }
    return result;
}

/**
 * Whether the member verified with "Verify with Discord" in one of `guildIds` (a stored token is
 * required). A token from before v12 counts for `homeIds` (Mewvo's own servers) only. Throws on a
 * database error.
 */
export async function hasVerifiedIn(userId, guildIds, { homeIds = [enforcementConfig.mainGuildId, enforcementConfig.supportGuildId], q = query } = {}) {
    if (!(await getFromDb(`${TOKEN_KEY_PREFIX}${userId}`, null))) return false;
    const verified = (await verifiedGuildsOf([userId], { q })).get(userId);
    const wanted = guildIds.map(String);
    if (!verified) return wanted.some((id) => homeIds.map(String).includes(id));
    return wanted.some((id) => verified.has(id));
}

// ── Member backup (guilds.join) ───────────────────────────────────────────
const REFRESH_MARGIN_MS = 60 * 1000;

/** User ids with stored OAuth tokens. */
export async function listStoredTokenUsers() {
    // A database error throws (never "nobody stored"): a restore must not report 0 on an outage.
    const keys = await db.list(TOKEN_KEY_PREFIX);
    return keys.map((key) => key.slice(TOKEN_KEY_PREFIX.length)).filter((id) => /^\d{17,20}$/.test(id));
}

function refreshToken(refresh) {
    const { clientId, clientSecret } = settings();
    return discordFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refresh,
        }),
    });
}

// One lookup/refresh per user at a time: Discord rotates the refresh token, so a second
// refresh running alongside would get invalid_grant and delete the tokens the first one
// just stored.
const tokenLookups = new Map();

/**
 * A usable access token for this user (refreshed and re-stored when it has expired),
 * or null when none is stored, it lacks guilds.join, or the user revoked access
 * (then the stored record is deleted).
 */
export function getUsableAccessToken(userId) {
    const running = tokenLookups.get(userId);
    if (running) return running;
    const lookup = usableAccessToken(userId).finally(() => tokenLookups.delete(userId));
    tokenLookups.set(userId, lookup);
    return lookup;
}

async function usableAccessToken(userId) {
    const { tokenKey } = settings();
    const record = await getFromDb(`${TOKEN_KEY_PREFIX}${userId}`, null);
    if (!tokenKey || !record?.tokens || !String(record.scope || '').includes('guilds.join')) return null;

    let tokens;
    try {
        tokens = JSON.parse(decrypt(record.tokens, tokenKey));
    } catch {
        logger.warn(`Stored OAuth tokens for ${userId} could not be decrypted (OAUTH_TOKEN_KEY changed?)`);
        return null;
    }
    if (Number(record.expiresAt) > Date.now() + REFRESH_MARGIN_MS) return tokens.access;

    try {
        const fresh = await refreshToken(tokens.refresh);
        await storeTokens(userId, fresh);
        return fresh.access_token;
    } catch (error) {
        if (error.status === 400 || error.status === 401) {
            // invalid_grant: the user removed the app's access; the tokens are useless now, and so is
            // the list of servers they were given in.
            await deleteFromDb(`${TOKEN_KEY_PREFIX}${userId}`);
            await forgetVerifiedGuilds(userId).catch((cleanup) => logger.warn(`Could not delete the verified servers of ${userId}: ${cleanup.message}`));
            return null;
        }
        throw error;
    }
}

/**
 * Adds a user to a guild with their stored authorization. The bot must be in that
 * guild with Create Invite. Returns 'added' | 'already' | 'no_token'.
 */
export async function addMemberWithStoredToken(client, guildId, userId) {
    const accessToken = await getUsableAccessToken(userId);
    if (!accessToken) return 'no_token';
    // Invite tracking: the join this causes is Mewvo's own add ('bot'), not an invite use.
    expectBotAdd(guildId, userId);
    // discord.js REST waits out rate limits on its own. 201 = added, 204 = already a member.
    let result;
    try {
        result = await client.rest.put(Routes.guildMember(guildId, userId), { body: { access_token: accessToken } });
    } catch (error) {
        clearExpectedBotAdd(guildId, userId);
        throw error;
    }
    if (!result) clearExpectedBotAdd(guildId, userId);
    return result ? 'added' : 'already';
}
