// queryPolicy.js — what /play accepts: search terms, or links to a few music sites.
// Any other URL is refused, so members can't make the Lavalink host fetch
// arbitrary (or internal) addresses.

import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';

// Host suffixes: youtube.com also covers www., m. and music.youtube.com.
const ALLOWED_HOSTS = ['youtube.com', 'youtu.be', 'soundcloud.com', 'open.spotify.com'];
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_URL = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i;
// Lavalink source prefixes that read files or raw addresses.
const BLOCKED_PREFIXES = /^(?:local|file|http|https):/i;

function refuse(detail) {
    return new TitanBotError(`Play query refused: ${detail}`, ErrorTypes.USER_INPUT,
        'Use a song name, or a link from YouTube, SoundCloud or Spotify.');
}

function isAllowedHost(hostname) {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Throws a user-facing error unless the query is a search term or an allowed link. */
export function assertAllowedPlayQuery(query) {
    const trimmed = String(query || '').trim();
    const looksLikeUrl = URL_SCHEME.test(trimmed) || BARE_URL.test(trimmed);
    if (!looksLikeUrl) {
        if (BLOCKED_PREFIXES.test(trimmed)) throw refuse('blocked source prefix');
        return;
    }

    let url;
    try {
        url = new URL(URL_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
        throw refuse('unparseable URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw refuse(`scheme ${url.protocol}`);
    if (url.username || url.password) throw refuse('credentials in URL');
    if (!isAllowedHost(url.hostname)) throw refuse(`host ${url.hostname}`);
}
