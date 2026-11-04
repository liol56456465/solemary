// weatherService.js — city lookup (OpenStreetMap Nominatim) and current weather (MET Norway
// Locationforecast 2.0) for /weather. Both allow commercial use; their usage rules are followed here:
// - MET Norway (https://api.met.no/doc/TermsOfService): identifying User-Agent, coordinates truncated
//   to max 4 decimals, no repeat request before `Expires`, `If-Modified-Since` on refresh, 203 logged.
//   Data licence CC BY 4.0 / NLOD (https://api.met.no/doc/License) — credit "MET Norway".
// - Nominatim (https://operations.osmfoundation.org/policies/nominatim/): at most 1 request/second for
//   the whole application, identifying User-Agent, results cached, attribution shown, no autocomplete.
//   Data © OpenStreetMap contributors, ODbL.

import { logger } from '../utils/logger.js';

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
export const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
export const MET_ATTRIBUTION = 'Weather data: MET Norway (CC BY 4.0)';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

const FALLBACK_CONTACT = 'https://github.com/liol56456465/solemary';
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_MIN_INTERVAL_MS = 1100; // policy: absolute max 1/s; a little margin for clock jitter
const GEO_MAX_WAITING = 20;
const MET_DEFAULT_TTL_MS = 30 * 60 * 1000; // only when MET sends no usable Expires header
const CACHE_MAX = 500;
const TIMEOUT_MS = 8000;

export class WeatherError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code; // 'busy' | 'unavailable' | 'rate_limited'
    }
}

export function userAgent(env = process.env) {
    const contact = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || FALLBACK_CONTACT;
    return `Mewvo/1.0 (+${contact})`;
}

/** Truncates (not rounds) to at most 4 decimals, as MET Norway requires. */
export function truncateCoord(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new TypeError('coordinate is not a number');
    return Math.trunc(n * 10000) / 10000;
}

/** Frees the connection when a response body will not be read. */
function discard(response) {
    try { response.body?.cancel?.().catch(() => {}); } catch { /* already consumed or no body */ }
}

/** Map with a size cap: the oldest entry goes first. */
class BoundedCache {
    constructor(max) { this.max = max; this.map = new Map(); }
    get(key) { return this.map.get(key); }
    set(key, value) {
        this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
    get size() { return this.map.size; }
}

/**
 * Factory so tests can inject fetch, a clock and a sleep function. The app uses the default instance.
 */
export function createWeatherClient({
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env = process.env,
} = {}) {
    const geoCache = new BoundedCache(CACHE_MAX);
    const metCache = new BoundedCache(CACHE_MAX);
    let geoChain = Promise.resolve();
    let geoLastStart = -Infinity;
    let geoWaiting = 0;
    const geoInFlight = new Map(); // same query asked twice at once → one request

    const headers = (extra = {}) => ({ 'User-Agent': userAgent(env), Accept: 'application/json', ...extra });

    /** Runs fn with at least GEO_MIN_INTERVAL_MS between request starts, one at a time, app-wide. */
    function throttled(fn) {
        if (geoWaiting >= GEO_MAX_WAITING) {
            return Promise.reject(new WeatherError('busy', 'Too many lookups queued'));
        }
        geoWaiting++;
        const run = geoChain.then(async () => {
            const wait = geoLastStart + GEO_MIN_INTERVAL_MS - now();
            if (wait > 0) await sleep(wait);
            geoLastStart = now();
            geoWaiting--;
            return fn();
        });
        geoChain = run.catch(() => {});
        return run;
    }

    /** City name → { lat, lon, name, country } or null when nothing matches. Cached 24 h (also misses). */
    async function geocode(query) {
        const key = String(query).trim().toLowerCase().replace(/\s+/g, ' ');
        const hit = geoCache.get(key);
        if (hit && hit.expires > now()) return hit.value;
        if (geoInFlight.has(key)) return geoInFlight.get(key);
        const pending = lookup(key, query).finally(() => geoInFlight.delete(key));
        geoInFlight.set(key, pending);
        return pending;
    }

    async function lookup(key, query) {

        const url = `${NOMINATIM_URL}?${new URLSearchParams({
            q: key, format: 'jsonv2', limit: '1', addressdetails: '1', 'accept-language': 'en',
        })}`;
        const response = await throttled(() => fetchImpl(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) }));
        if (!response.ok) {
            discard(response);
            if (response.status === 429) throw new WeatherError('rate_limited', 'Nominatim HTTP 429');
            throw new WeatherError('unavailable', `Nominatim HTTP ${response.status}`);
        }
        const body = await response.json();
        const first = Array.isArray(body) ? body[0] : null;
        let value = null;
        if (first && Number.isFinite(Number(first.lat)) && Number.isFinite(Number(first.lon))) {
            value = {
                lat: Number(first.lat),
                lon: Number(first.lon),
                name: first.name || first.address?.city || first.address?.town || first.address?.village
                    || String(first.display_name || query).split(',')[0],
                country: first.address?.country || null,
            };
        }
        geoCache.set(key, { value, expires: now() + GEO_TTL_MS });
        return value;
    }

    function expiryFrom(response) {
        const expires = Date.parse(response.headers.get('expires') || '');
        return Number.isFinite(expires) && expires > now() ? expires : now() + MET_DEFAULT_TTL_MS;
    }

    /** Locationforecast compact JSON for the point (truncated to 4 decimals), honouring Expires. */
    async function forecast(lat, lon) {
        const tLat = truncateCoord(lat);
        const tLon = truncateCoord(lon);
        const key = `${tLat},${tLon}`;
        const cached = metCache.get(key);
        if (cached && cached.expires > now()) return cached.data;

        const extra = cached?.lastModified ? { 'If-Modified-Since': cached.lastModified } : {};
        const url = `${MET_URL}?lat=${tLat}&lon=${tLon}`;
        const response = await fetchImpl(url, { headers: headers(extra), signal: AbortSignal.timeout(TIMEOUT_MS) });

        if (response.status === 304 && cached) {
            discard(response);
            metCache.set(key, { ...cached, expires: expiryFrom(response) });
            return cached.data;
        }
        if (response.status === 203) {
            logger.warn('MET Norway Locationforecast answered 203: this API version is deprecated, update weatherService.js');
        }
        if (!response.ok) {
            discard(response);
            if (response.status === 429) throw new WeatherError('rate_limited', 'MET Norway HTTP 429');
            throw new WeatherError('unavailable', `MET Norway HTTP ${response.status}`);
        }

        const data = await response.json();
        metCache.set(key, {
            data,
            expires: expiryFrom(response),
            lastModified: response.headers.get('last-modified') || null,
        });
        return data;
    }

    return { geocode, forecast, _caches: { geoCache, metCache } };
}

const SYMBOLS = {
    clearsky: ['Clear sky', '☀️'],
    fair: ['Fair', '🌤️'],
    partlycloudy: ['Partly cloudy', '⛅'],
    cloudy: ['Cloudy', '☁️'],
    fog: ['Fog', '🌫️'],
    lightrainshowers: ['Light rain showers', '🌦️'],
    rainshowers: ['Rain showers', '🌦️'],
    heavyrainshowers: ['Heavy rain showers', '🌧️'],
    lightrain: ['Light rain', '🌧️'],
    rain: ['Rain', '🌧️'],
    heavyrain: ['Heavy rain', '🌧️'],
    lightsleetshowers: ['Light sleet showers', '🌨️'],
    sleetshowers: ['Sleet showers', '🌨️'],
    heavysleetshowers: ['Heavy sleet showers', '🌨️'],
    lightsleet: ['Light sleet', '🌨️'],
    sleet: ['Sleet', '🌨️'],
    heavysleet: ['Heavy sleet', '🌨️'],
    lightsnowshowers: ['Light snow showers', '🌨️'],
    snowshowers: ['Snow showers', '🌨️'],
    heavysnowshowers: ['Heavy snow showers', '❄️'],
    lightsnow: ['Light snow', '🌨️'],
    snow: ['Snow', '❄️'],
    heavysnow: ['Heavy snow', '❄️'],
};

/** MET symbol_code (e.g. "partlycloudy_night", "heavyrainandthunder") → { text, emoji }. */
export function describeSymbol(code) {
    if (!code) return { text: 'Unknown conditions', emoji: '' };
    const base = String(code).replace(/_(day|night|polartwilight)$/, '');
    const thunder = base.endsWith('andthunder');
    const entry = SYMBOLS[thunder ? base.slice(0, -'andthunder'.length) : base];
    if (!entry) return { text: thunder ? 'Thunder' : 'Unknown conditions', emoji: thunder ? '⛈️' : '' };
    if (thunder) return { text: `${entry[0]} and thunder`, emoji: '⛈️' };
    const night = /_night$/.test(String(code)) && (base === 'clearsky' || base === 'fair');
    return { text: entry[0], emoji: night ? '🌙' : entry[1] };
}

/** Picks the time step for "now" (latest step not in the future) and pulls the values /weather shows. */
export function currentConditions(data, nowMs = Date.now()) {
    const series = data?.properties?.timeseries;
    if (!Array.isArray(series) || series.length === 0) return null;
    let step = series[0];
    for (const s of series) {
        if (Date.parse(s.time) <= nowMs) step = s; else break;
    }
    const d = step.data?.instant?.details || {};
    const next = step.data?.next_1_hours || step.data?.next_6_hours || step.data?.next_12_hours || {};
    return {
        time: step.time,
        temperature: d.air_temperature ?? null,
        humidity: d.relative_humidity ?? null,
        windSpeedMs: d.wind_speed ?? null,
        windFrom: d.wind_from_direction ?? null,
        // Only the 1-hour block: the 6/12-hour totals would be mislabelled as "next hour".
        precipitationMm: step.data?.next_1_hours?.details?.precipitation_amount ?? null,
        symbol: describeSymbol(next.summary?.symbol_code),
    };
}

export function compassPoint(deg) {
    if (deg == null || !Number.isFinite(Number(deg))) return '';
    const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return points[Math.round(((Number(deg) % 360) + 360) % 360 / 45) % 8];
}

export const weatherClient = createWeatherClient();
