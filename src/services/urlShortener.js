// urlShortener.js — shortens a link with is.gd. Shared by /shorten and the dashboard
// ("Shorten a link" on the Commands page). Throws TitanBotError with a userMessage
// (VALIDATION for bad input or a taken custom ending, NETWORK / UNKNOWN for the service).

import { createError, ErrorTypes } from '../utils/errorHandler.js';

export const MAX_SHORTEN_URL_LENGTH = 2000;
export const MAX_CUSTOM_ENDING_LENGTH = 30;
const CUSTOM_ENDING = /^[a-zA-Z0-9_-]+$/;
const TIMEOUT_MS = 10_000;

function userError(message, type = ErrorTypes.VALIDATION) {
    return createError(message, type, message);
}

/** The checks /shorten runs before calling is.gd; returns { url, custom } or throws. */
export function validateShortenInput(url, custom = '') {
    const value = typeof url === 'string' ? url.trim() : '';
    if (!value) throw userError('Enter a link to shorten.');
    if (value.length > MAX_SHORTEN_URL_LENGTH) throw userError(`The link is too long (at most ${MAX_SHORTEN_URL_LENGTH} characters).`);
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw userError('Invalid URL format. Include http:// or https://');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw userError('Invalid URL format. Include http:// or https://');
    const ending = typeof custom === 'string' ? custom.trim() : '';
    if (ending && (!CUSTOM_ENDING.test(ending) || ending.length > MAX_CUSTOM_ENDING_LENGTH)) {
        throw userError(`Custom URL can only contain letters, numbers, underscores, and hyphens (at most ${MAX_CUSTOM_ENDING_LENGTH}).`);
    }
    return { url: value, custom: ending };
}

/** The short link for `url` (optional custom ending). `fetchImpl` is injectable for tests. */
export async function shortenUrl(url, custom = '', { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
    const input = validateShortenInput(url, custom);
    let apiUrl = `https://is.gd/create.php?format=simple&url=${encodeURIComponent(input.url)}`;
    if (input.custom) apiUrl += `&shorturl=${encodeURIComponent(input.custom)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetchImpl(apiUrl, { signal: controller.signal, headers: { 'User-Agent': 'TitanBot URL Shortener/1.0' } });
    } catch (networkError) {
        throw userError(networkError?.name === 'AbortError'
            ? 'The URL shortener timed out. Please try again in a moment.'
            : 'Unable to reach the URL shortener service right now. Please try again later.', ErrorTypes.NETWORK);
    } finally {
        clearTimeout(timeout);
    }
    if (!response.ok) throw userError(`Shortener service returned HTTP ${response.status}. Please try again later.`, ErrorTypes.UNKNOWN);

    const shortUrl = String(await response.text()).trim();
    try {
        const parsed = new URL(shortUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('not http');
    } catch {
        if (shortUrl.includes('already exists')) throw userError('That custom URL is already taken. Try a different one.');
        if (shortUrl.includes('invalid')) throw userError('Invalid URL. Include http:// or https://');
        throw userError(`URL shortening failed: ${shortUrl.slice(0, 200)}`, ErrorTypes.UNKNOWN);
    }
    return shortUrl;
}
