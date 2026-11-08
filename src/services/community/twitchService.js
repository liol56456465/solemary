// twitchService.js — the small Twitch Helix client behind Twitch "went live" feeds
// (/community feed add platform:twitch). Used by feedService.js.
//
// Auth: an app access token from the client credentials grant
// (POST https://id.twitch.tv/oauth2/token), cached in memory until shortly before it
// expires. A 401 from Helix drops the cached token, gets a new one and retries once.
// Env: TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET. Without both, Twitch is off: nothing is
// requested and adding a Twitch feed is refused with a plain message.

import { userError } from './db.js';
import { botText } from '../../utils/botText.js';

export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const TWITCH_API_URL = 'https://api.twitch.tv/helix';
export const TWITCH_MAX_LOGINS_PER_REQUEST = 100; // Get Streams / Get Users limit
const FETCH_TIMEOUT_MS = 10_000;
const TOKEN_EARLY_REFRESH_MS = 5 * 60_000; // renew a little before Twitch says it expires
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;
const RESERVED_PATHS = new Set(['directory', 'videos', 'settings', 'search', 'downloads', 'jobs', 'p', 'turbo', 'subscriptions', 'inventory', 'wallet', 'drops']);

/** A Twitch login from a login or a twitch.tv/<login> link (lowercased); throws a user error (in `lang`) otherwise; pure. */
export function parseTwitchLogin(input, { lang = 'en' } = {}) {
    let text = String(input ?? '').trim();
    const fromUrl = /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/([^/?#\s]+)/i.exec(text);
    if (fromUrl) text = fromUrl[1];
    const login = text.replace(/^@/, '').toLowerCase();
    if (TWITCH_LOGIN.test(login) && !RESERVED_PATHS.has(login)) return login;
    throw userError(botText(lang).t('community.feed.twitchLoginInvalid'));
}

/** True when both Twitch app credentials are set; pure apart from reading env. */
export function isTwitchConfigured(env = process.env) {
    return Boolean(String(env.TWITCH_CLIENT_ID || '').trim() && String(env.TWITCH_CLIENT_SECRET || '').trim());
}

/** A Get Streams item as a feed entry: { id, title, url, author, game, login }; pure. */
export function streamToEntry(stream) {
    const login = String(stream?.user_login || '').toLowerCase();
    return {
        id: String(stream?.id || ''),
        title: String(stream?.title || '').trim() || '(untitled)',
        url: `https://www.twitch.tv/${login}`,
        author: String(stream?.user_name || '').trim() || login || 'Twitch',
        game: String(stream?.game_name || '').trim(),
        login,
    };
}

/** Live streams from a Get Streams response body, keyed by lowercase login; pure. */
export function parseStreamsResponse(body) {
    const live = new Map();
    for (const stream of Array.isArray(body?.data) ? body.data : []) {
        if (stream?.type !== 'live' || !stream.id || !stream.user_login) continue;
        const entry = streamToEntry(stream);
        live.set(entry.login, entry);
    }
    return live;
}

function httpError(what, response) {
    const error = new Error(`${what}: HTTP ${response.status}`);
    error.status = response.status;
    return error;
}

/**
 * A Helix client. `fetchImpl` and `now` are injectable for tests; credentials are read
 * once when it is made. Never logs or returns the secret or the token.
 */
export function createTwitchClient({ clientId, clientSecret, fetchImpl = fetch, now = () => Date.now() } = {}) {
    let token = null; // { value, expiresAt }
    let pending = null;
    const configured = Boolean(clientId && clientSecret);

    async function requestToken() {
        const response = await fetchImpl(TWITCH_TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw httpError('Twitch token request failed', response);
        const body = await response.json();
        if (!body?.access_token) throw new Error('Twitch token response had no access_token');
        const lifetimeMs = Math.max(0, Number(body.expires_in) || 0) * 1000;
        token = { value: body.access_token, expiresAt: now() + Math.max(60_000, lifetimeMs - TOKEN_EARLY_REFRESH_MS) };
        return token.value;
    }

    async function getToken() {
        if (token && now() < token.expiresAt) return token.value;
        if (!pending) pending = requestToken().finally(() => { pending = null; });
        return pending;
    }

    async function helix(path, params) {
        if (!configured) throw new Error('Twitch is not configured');
        const url = `${TWITCH_API_URL}/${path}?${params.toString()}`;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const accessToken = await getToken();
            const response = await fetchImpl(url, {
                headers: { 'client-id': clientId, authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (response.status === 401 && attempt === 0) {
                // Expired or revoked: forget it (unless another call already renewed it) and retry once.
                if (token?.value === accessToken) token = null;
                continue;
            }
            if (!response.ok) throw httpError(`Twitch ${path}`, response);
            return response.json();
        }
        throw new Error(`Twitch ${path}: still unauthorized after a new token`);
    }

    return {
        configured,
        /** The user for a login, or null when Twitch has none: { id, login, displayName }. */
        async getUser(login) {
            const body = await helix('users', new URLSearchParams({ login }));
            const user = Array.isArray(body?.data) ? body.data[0] : null;
            return user?.login ? { id: String(user.id), login: String(user.login).toLowerCase(), displayName: user.display_name || user.login } : null;
        },
        /** The live streams among `logins`, keyed by lowercase login (batched by 100). */
        async getLiveStreams(logins) {
            const unique = [...new Set(logins.map((login) => String(login).toLowerCase()))];
            const live = new Map();
            for (let i = 0; i < unique.length; i += TWITCH_MAX_LOGINS_PER_REQUEST) {
                const params = new URLSearchParams({ type: 'live', first: String(TWITCH_MAX_LOGINS_PER_REQUEST) });
                for (const login of unique.slice(i, i + TWITCH_MAX_LOGINS_PER_REQUEST)) params.append('user_login', login);
                for (const [login, entry] of parseStreamsResponse(await helix('streams', params))) live.set(login, entry);
            }
            return live;
        },
    };
}

let defaultClient = null;

/** The client built from TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET (once). */
export function getTwitchClient() {
    if (!defaultClient) {
        defaultClient = createTwitchClient({
            clientId: String(process.env.TWITCH_CLIENT_ID || '').trim(),
            clientSecret: String(process.env.TWITCH_CLIENT_SECRET || '').trim(),
        });
    }
    return defaultClient;
}
