// oauthVerification.js — verification through Discord OAuth2 instead of a plain button.
//
// The Verify button answers with a private "Verify with Discord" link. The link's
// `state` is signed (HMAC with the client secret), names the guild and the user who
// pressed the button, and expires after 10 minutes. Discord sends the user back to
// GET /oauth/callback; the bot exchanges the code, checks the authorizing account is
// the one that pressed Verify, gives the verified role, and stores the OAuth tokens
// encrypted (AES-256-GCM with OAUTH_TOKEN_KEY) so guilds.join can be used later.
//
// Enabled when DISCORD_CLIENT_SECRET and PUBLIC_URL are set; otherwise the button
// verifies directly as before. The redirect URL <PUBLIC_URL>/oauth/callback must be
// added under OAuth2 → Redirects in the Discord Developer Portal.

import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { setInDb } from '../utils/database.js';
import { verifyUser } from './verificationService.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const ME_URL = 'https://discord.com/api/v10/users/@me';
// messages.read is RPC-only and Discord rejects it for bots, so it is not requested.
const SCOPES = ['identify', 'email', 'guilds', 'guilds.join', 'gdm.join'];
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

function page(title, message, ok) {
    const color = ok ? '#3ba55d' : '#ed4245';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;color:#f2f3f5;font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:32px 24px;text-align:center}h1{color:${color};font-size:22px;margin:0 0 8px}p{margin:0;color:#b5bac1}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

/** Adds GET /oauth/callback to the bot's web server. */
export function registerOAuthRoutes(app, client) {
    if (!isOAuthVerificationEnabled()) {
        logger.info('OAuth verification is off (set DISCORD_CLIENT_SECRET and PUBLIC_URL to enable it)');
        return;
    }

    app.get('/oauth/callback', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const send = (status, title, message, ok = false) => res.status(status).type('html').send(page(title, message, ok));

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

            const result = await verifyUser(client, state.guildId, me.id, { source: 'oauth', moderatorId: null });
            const already = result.status === 'already_verified';
            return send(200, already ? 'Already verified' : 'You are verified!',
                `${already ? 'You already have' : 'You now have'} the <b>${result.roleName.replace(/[<>&"]/g, '')}</b> role. You can close this tab and go back to Discord.`, true);
        } catch (error) {
            logger.error(`OAuth verification failed for state user ${state.userId}: ${error.message}`);
            const message = (error.userMessage || 'Something went wrong. Go back to Discord and press Verify again.').replace(/[<>&"]/g, '');
            return send(error.status === 400 ? 400 : 500, 'Verification failed', message);
        }
    });
    logger.info('OAuth verification enabled at /oauth/callback');
}
