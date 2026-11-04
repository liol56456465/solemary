// /weather on MET Norway + OSM Nominatim: no real network calls — fetch, clock and sleep are injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createWeatherClient, truncateCoord, userAgent, describeSymbol, currentConditions, compassPoint,
    MET_ATTRIBUTION, OSM_ATTRIBUTION,
} from '../src/services/weatherService.js';
import { buildWeatherEmbed, SOURCES_LINE, FOOTER_TEXT } from '../src/commands/Utility/weather.js';
import { wiktionaryCredit } from '../src/commands/Search/modules/search_define.js';

function res(status, body, headers = {}) {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => body };
}

const T0 = Date.parse('2026-11-04T12:10:00Z');
const MET_BODY = {
    properties: {
        timeseries: [
            { time: '2026-11-04T11:00:00Z', data: { instant: { details: { air_temperature: 1 } } } },
            {
                time: '2026-11-04T12:00:00Z',
                data: {
                    instant: { details: { air_temperature: 4.6, relative_humidity: 81.2, wind_speed: 5, wind_from_direction: 225 } },
                    next_1_hours: { summary: { symbol_code: 'lightrainshowers_day' }, details: { precipitation_amount: 0.3 } },
                },
            },
            { time: '2026-11-04T13:00:00Z', data: { instant: { details: { air_temperature: 99 } } } },
        ],
    },
};

function harness(handler) {
    let clock = T0;
    const calls = [];
    const sleeps = [];
    const client = createWeatherClient({
        fetchImpl: async (url, opts) => { calls.push({ url, opts, at: clock }); return handler(url, opts, calls.length); },
        now: () => clock,
        sleep: async (ms) => { sleeps.push(ms); clock += ms; },
        env: { PUBLIC_URL: 'https://mewvo.example/' },
    });
    return { client, calls, sleeps, advance: (ms) => { clock += ms; }, now: () => clock };
}

test('coordinates are truncated (not rounded) to 4 decimals', () => {
    assert.equal(truncateCoord(59.913868), 59.9138);
    assert.equal(truncateCoord(-0.12345999), -0.1234);
    assert.equal(truncateCoord('10.75'), 10.75);
    assert.throws(() => truncateCoord('x'));
});

test('User-Agent identifies Mewvo with a contact URL, falls back to the repo, never an email', () => {
    assert.equal(userAgent({ PUBLIC_URL: 'https://mewvo.example/' }), 'Mewvo/1.0 (+https://mewvo.example)');
    assert.equal(userAgent({}), 'Mewvo/1.0 (+https://github.com/liol56456465/solemary)');
    assert.ok(!userAgent({}).includes('@'));
});

test('MET request: 4-decimal coords, User-Agent, cached until Expires, then If-Modified-Since and 304 reuse', async () => {
    const h = harness((url, opts, n) => {
        if (n === 1) return res(200, MET_BODY, { Expires: new Date(T0 + 60_000).toUTCString(), 'Last-Modified': 'Wed, 04 Nov 2026 11:55:00 GMT' });
        return res(304, null, { Expires: new Date(T0 + 600_000).toUTCString() });
    });
    const first = await h.client.forecast(59.913868, 10.752245);
    assert.equal(h.calls[0].url, 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.9138&lon=10.7522');
    assert.equal(h.calls[0].opts.headers['User-Agent'], 'Mewvo/1.0 (+https://mewvo.example)');
    assert.equal(h.calls[0].opts.headers['If-Modified-Since'], undefined);

    // Same truncated point before Expires → no request.
    assert.equal(await h.client.forecast(59.91389, 10.75229), first);
    assert.equal(h.calls.length, 1);

    h.advance(61_000);
    assert.equal(await h.client.forecast(59.913868, 10.752245), first, '304 reuses cached data');
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].opts.headers['If-Modified-Since'], 'Wed, 04 Nov 2026 11:55:00 GMT');

    h.advance(60_000); // the 304 moved Expires 10 min ahead
    await h.client.forecast(59.913868, 10.752245);
    assert.equal(h.calls.length, 2);
});

test('MET errors become WeatherError (429 → rate_limited, 500 → unavailable)', async () => {
    const h = harness((url, opts, n) => res(n === 1 ? 429 : 500, {}));
    await assert.rejects(h.client.forecast(1, 2), { code: 'rate_limited' });
    await assert.rejects(h.client.forecast(1, 2), { code: 'unavailable' });
});

test('Nominatim: User-Agent, parses the first hit, caches 24 h (misses too)', async () => {
    const h = harness((url) => (url.includes('q=nowhere')
        ? res(200, [])
        : res(200, [{ lat: '59.9133301', lon: '10.7389701', name: 'Oslo', address: { country: 'Norway' } }])));
    const place = await h.client.geocode('  Oslo ');
    assert.deepEqual(place, { lat: 59.9133301, lon: 10.7389701, name: 'Oslo', country: 'Norway' });
    assert.match(h.calls[0].url, /^https:\/\/nominatim\.openstreetmap\.org\/search\?q=oslo&format=jsonv2&limit=1/);
    assert.equal(h.calls[0].opts.headers['User-Agent'], 'Mewvo/1.0 (+https://mewvo.example)');

    assert.deepEqual(await h.client.geocode('OSLO'), place);
    assert.equal(h.calls.length, 1, 'cached');

    assert.equal(await h.client.geocode('nowhere'), null);
    assert.equal(await h.client.geocode('nowhere'), null);
    assert.equal(h.calls.length, 2, 'a miss is cached too');

    h.advance(24 * 60 * 60 * 1000 + 1);
    await h.client.geocode('oslo');
    assert.equal(h.calls.length, 3, 'expired after 24 h');
});

test('Nominatim limiter: at most one request per second across all callers', async () => {
    const h = harness(() => res(200, []));
    await Promise.all(['a', 'b', 'c', 'd'].map((q) => h.client.geocode(q)));
    assert.equal(h.calls.length, 4);
    for (let i = 1; i < h.calls.length; i++) {
        assert.ok(h.calls[i].at - h.calls[i - 1].at >= 1000, `gap ${i} is ${h.calls[i].at - h.calls[i - 1].at} ms`);
    }
});

test('Nominatim limiter: the same query asked at once makes one request; a full queue is refused', async () => {
    const h = harness(() => res(200, []));
    await Promise.all([h.client.geocode('x'), h.client.geocode('x')]);
    assert.equal(h.calls.length, 1);

    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = createWeatherClient({ fetchImpl: async () => { await gate; return res(200, []); }, now: () => 0, sleep: async () => {}, env: {} });
    const pending = Array.from({ length: 20 }, (_, i) => slow.geocode(`q${i}`));
    await assert.rejects(slow.geocode('one too many'), { code: 'busy' });
    release();
    await Promise.all(pending);
});

test('MET symbol codes map to text and emoji', () => {
    assert.deepEqual(describeSymbol('clearsky_night'), { text: 'Clear sky', emoji: '🌙' });
    assert.deepEqual(describeSymbol('clearsky_day'), { text: 'Clear sky', emoji: '☀️' });
    assert.deepEqual(describeSymbol('heavyrainandthunder'), { text: 'Heavy rain and thunder', emoji: '⛈️' });
    assert.deepEqual(describeSymbol('partlycloudy_polartwilight'), { text: 'Partly cloudy', emoji: '⛅' });
    assert.equal(describeSymbol('somethingnew').text, 'Unknown conditions');
    assert.equal(describeSymbol(undefined).text, 'Unknown conditions');
});

test('currentConditions picks the latest step not in the future', () => {
    const now = currentConditions(MET_BODY, T0);
    assert.equal(now.temperature, 4.6);
    assert.equal(now.humidity, 81.2);
    assert.equal(now.windSpeedMs, 5);
    assert.equal(now.precipitationMm, 0.3);
    assert.equal(now.symbol.text, 'Light rain showers');
    assert.equal(currentConditions({ properties: { timeseries: [] } }), null);
    assert.equal(compassPoint(225), 'SW');
    assert.equal(compassPoint(359), 'N');
});

test('weather embed shows values, MET Norway + OSM attribution and licence links', () => {
    const embed = buildWeatherEmbed({ name: 'Oslo', country: 'Norway' }, currentConditions(MET_BODY, T0), 59.9133301, 10.7389701).toJSON();
    assert.equal(embed.title, 'Weather in Oslo, Norway');
    const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.equal(fields.Temperature, '5°C');
    assert.equal(fields.Humidity, '81%');
    assert.equal(fields.Wind, '18 km/h from SW');
    assert.ok(embed.footer.text.includes(MET_ATTRIBUTION));
    assert.ok(embed.footer.text.includes(OSM_ATTRIBUTION));
    assert.equal(MET_ATTRIBUTION, 'Weather data: MET Norway (CC BY 4.0)');
    assert.equal(OSM_ATTRIBUTION, '© OpenStreetMap contributors (ODbL)');
    assert.ok(FOOTER_TEXT.length < 2048);
    assert.ok(embed.description.includes(SOURCES_LINE));
    assert.match(SOURCES_LINE, /creativecommons\.org\/licenses\/by\/4\.0/);
    assert.match(SOURCES_LINE, /openstreetmap\.org\/copyright/);
});

test('/define credits Wiktionary with the licence and source URL from the API', () => {
    const credit = wiktionaryCredit({
        license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0' },
        sourceUrls: ['https://en.wiktionary.org/wiki/cat'],
    });
    assert.equal(credit.footer, 'Definitions from Wiktionary (CC BY-SA)');
    assert.equal(credit.line, 'Definitions from [Wiktionary](https://en.wiktionary.org/wiki/cat) ([CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0))');

    const fallback = wiktionaryCredit({ sourceUrls: ['javascript:alert(1)'] });
    assert.equal(fallback.line, 'Definitions from Wiktionary ([CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0))');
});
