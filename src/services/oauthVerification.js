// oauthVerification.js — verification through Discord OAuth2 instead of a plain button.
//
// The Verify button answers with a private "Verify with Discord" link. The link's
// `state` is signed (HMAC with the client secret), names the guild and the user who
// pressed the button, and expires after 10 minutes. Discord sends the user back to
// GET /oauth/callback; the bot exchanges the code, checks the authorizing account is
// the one that pressed Verify, gives the verified role, stores the OAuth tokens
// encrypted (AES-256-GCM with OAUTH_TOKEN_KEY) so guilds.join can be used later, and
// sends the browser on to the Meowist invite (VERIFY_SUCCESS_REDIRECT). Accounts under
// 7 days old and likely ban-evasion alts are held for staff approval instead
// (see verificationGuard.js).
//
// Enabled when DISCORD_CLIENT_SECRET and PUBLIC_URL are set; otherwise the button
// verifies directly as before. The redirect URL <PUBLIC_URL>/oauth/callback must be
// added under OAuth2 → Redirects in the Discord Developer Portal.

import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { Routes } from 'discord.js';
import { getFromDb, setInDb, deleteFromDb, db } from '../utils/database.js';
import { verifyUser } from './verificationService.js';
import { assessVerification, postVerificationHold } from './verificationGuard.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getConfiguredSetting } from './settings/guildSettings.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const ME_URL = 'https://discord.com/api/v10/users/@me';
const SCOPES = ['identify', 'guilds.join'];
// Where the browser goes after a successful verification: the main Meowist server's invite.
const DEFAULT_SUCCESS_REDIRECT = 'https://discord.gg/WyceK9YENP';
const STATE_TTL_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10000;

const usedStates = new Map();

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

function createState(guildId, userId) {
    const payload = Buffer.from(JSON.stringify({
        g: guildId,
        u: userId,
        e: Date.now() + STATE_TTL_MS,
        n: crypto.randomBytes(8).toString('hex'),
    })).toString('base64url');
    return `${payload}.${sign(payload, settings().clientSecret)}`;
}

/** Returns { guildId, userId } for a valid, unexpired, unused state, else null. */
function readState(state) {
    const [payload, signature] = String(state || '').split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload, settings().clientSecret));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

    let data;
    try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    const now = Date.now();
    if (!data?.g || !data?.u || !(data.e > now) || usedStates.has(data.n)) return null;

    for (const [nonce, expiresAt] of usedStates) {
        if (expiresAt <= now) usedStates.delete(nonce);
    }
    usedStates.set(data.n, data.e);
    return { guildId: data.g, userId: data.u };
}

/** The Discord authorize link for this user to verify in this guild. */
export function buildVerifyUrl(guildId, userId) {
    const { clientId, redirectUri } = settings();
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES.join(' '),
        state: createState(guildId, userId),
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

function errorPage(title, message, accent = '#ed4245') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;color:#f2f3f5;font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:32px 24px;text-align:center}h1{color:${accent};font-size:22px;margin:0 0 8px}p{margin:0;color:#b5bac1}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
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

async function holdForStaff(client, guildId, userId, reasons) {
    const key = `${guildId}:${userId}`;
    if (Date.now() - (recentHolds.get(key) || 0) < HOLD_CARD_INTERVAL_MS) return;
    recentHolds.set(key, Date.now());
    const user = await client.users.fetch(userId);
    await postVerificationHold(client, guildId, user, reasons);
    logger.info(`Verification of ${userId} in ${guildId} held for staff: ${reasons.join('; ')}`);
}

/** Adds GET /oauth/callback to the bot's web server. */
export function registerOAuthRoutes(app, client) {
    if (!isOAuthVerificationEnabled()) {
        logger.info('OAuth verification is off (set DISCORD_CLIENT_SECRET and PUBLIC_URL to enable it)');
        return;
    }

    app.get('/oauth/callback', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const send = (status, title, message, accent) => res.status(status).type('html').send(errorPage(title, message, accent));

        if (req.query.error) {
            return send(400, 'Verification cancelled', 'You did not authorize the bot. Go back to Discord and press Verify again if you want to verify.');
        }
        const state = readState(req.query.state);
        if (!state || typeof req.query.code !== 'string') {
            return send(400, 'Link expired', 'This verification link is invalid, expired or already used. Go back to Discord and press Verify again.');
        }

        try {
            const token = await exchangeCode(req.query.code);
            const me = await discordFetch(ME_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
            if (me.id !== state.userId) {
                return send(403, 'Wrong account', 'You authorized with a different Discord account than the one that pressed Verify. Log in with the right account and try again.');
            }

            await storeTokens(me.id, token).catch((error) => logger.error(`Could not store OAuth tokens for ${me.id}: ${error.message}`));

            if (!(await isAlreadyVerified(client, state.guildId, me.id))) {
                const assessment = await assessVerification(me.id, req.ip);
                if (assessment.hold) {
                    await holdForStaff(client, state.guildId, me.id, assessment.reasons);
                    return send(202, 'Waiting for approval',
                        'Thanks! A staff member needs to approve your verification first. You will get a DM when it is done.', '#fee75c');
                }
            }

            await verifyUser(client, state.guildId, me.id, { source: 'oauth', moderatorId: null });
            return res.redirect(303, getConfiguredSetting('verifySuccessRedirect') || DEFAULT_SUCCESS_REDIRECT);
        } catch (error) {
            logger.error(`OAuth verification failed for state user ${state.userId}: ${error.message}`);
            const message = (error.userMessage || 'Something went wrong. Go back to Discord and press Verify again.').replace(/[<>&"]/g, '');
            return send(error.status === 400 ? 400 : 500, 'Verification failed', message);
        }
    });
    logger.info('OAuth verification enabled at /oauth/callback');
}

// ── Member backup (guilds.join) ───────────────────────────────────────────

const TOKEN_KEY_PREFIX = 'oauth:tokens:';
const REFRESH_MARGIN_MS = 60 * 1000;

/** User ids with stored OAuth tokens. */
export async function listStoredTokenUsers() {
    const keys = await db.list(TOKEN_KEY_PREFIX).catch(() => []);
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
            // invalid_grant: the user removed the app's access; the tokens are useless now.
            await deleteFromDb(`${TOKEN_KEY_PREFIX}${userId}`);
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
    // discord.js REST waits out rate limits on its own. 201 = added, 204 = already a member.
    const result = await client.rest.put(Routes.guildMember(guildId, userId), { body: { access_token: accessToken } });
    return result ? 'added' : 'already';
}
