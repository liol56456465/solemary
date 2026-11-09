// privacyNotice.js — the short privacy lines shown where the bot collects or uses
// personal data (Verify, enforcement DMs, modmail). The link only appears when
// PUBLIC_URL is a valid http(s) URL; without it the line has no link.

/** `<PUBLIC_URL origin>/privacy`, or null when PUBLIC_URL is not set or not http(s). */
export function privacyUrl(env = process.env) {
    const text = String(env.PUBLIC_URL || '').trim();
    if (!text) return null;
    try {
        const url = new URL(text);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        if (url.username || url.password) return null;
        return `${url.origin}/privacy`;
    } catch {
        return null;
    }
}

/** "Privacy: <url>" for an embed footer or the end of a message, or null without a URL. */
export function privacyFooterText(env = process.env) {
    const url = privacyUrl(env);
    return url ? `Privacy: ${url}` : null;
}

function withLink(sentence, env) {
    const footer = privacyFooterText(env);
    return footer ? `${sentence} ${footer}` : sentence;
}

/** The English sentence of the Verify with Discord note in a server that is not Mewvo's (identify only). */
export const OAUTH_SERVER_SENTENCE = 'Verify with Discord only shares your public Discord profile (ID, name, avatar) with Mewvo: '
    + 'no email, no server list, and no login token is kept. Mewvo stores your Discord ID and a scrambled fingerprint '
    + 'of your IP address, compared only with members banned from this server, to spot ban evasion.';

/**
 * Verify with Discord (OAuth): what the bot stores when the member authorizes. `home` (default):
 * Mewvo's own servers (identify + guilds.join, the token is kept); `home: false`: any other server
 * (identify only, no token kept; owner decision D3).
 */
export function oauthVerifyPrivacyNote(env = process.env, { home = true } = {}) {
    return withLink(
        home
            ? 'Verifying stores your Discord ID, an encrypted login token (to add you to the Mewvo support server) '
                + 'and a scrambled fingerprint of your IP address to spot ban evasion.'
            : OAUTH_SERVER_SENTENCE,
        env
    );
}

/** Direct verification (no OAuth): only the ID and a record of the verification. */
export function directVerifyPrivacyNote(env = process.env) {
    return withLink('Verifying stores your Discord ID and a record of when you verified.', env);
}
