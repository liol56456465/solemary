import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    parseTwitchLogin, isTwitchConfigured, streamToEntry, parseStreamsResponse, createTwitchClient,
    TWITCH_TOKEN_URL,
} = await import('../../src/services/community/twitchService.js');
const {
    addFeed, pollTwitchFeeds, pollFeeds, selectTwitchAlerts, renderFeedMessage, setFeedsForTests, listFeeds,
    DEFAULT_TWITCH_TEMPLATE,
} = await import('../../src/services/community/feedService.js');

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';

function stream(login, id, extra = {}) {
    return { id, user_id: '9', user_login: login, user_name: login.toUpperCase(), game_id: '1', game_name: 'Just Chatting', type: 'live', title: `${login} stream`, ...extra };
}

function json(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** A fake Twitch: records calls; `streams` = Map login → stream item (mutable). */
function fakeTwitchFetch({ streams = new Map(), users = new Set(), tokenSeq = ['tok1', 'tok2', 'tok3'], unauthorizedTokens = new Set() } = {}) {
    const calls = [];
    let tokenIndex = 0;
    const impl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (String(url) === TWITCH_TOKEN_URL) {
            return json(200, { access_token: tokenSeq[tokenIndex++] ?? 'tokN', expires_in: 3600, token_type: 'bearer' });
        }
        const token = String(init.headers?.authorization || '').replace('Bearer ', '');
        if (unauthorizedTokens.has(token)) return json(401, { error: 'Unauthorized' });
        const parsed = new URL(url);
        if (parsed.pathname === '/helix/streams') {
            return json(200, { data: parsed.searchParams.getAll('user_login').map((login) => streams.get(login)).filter(Boolean), pagination: {} });
        }
        if (parsed.pathname === '/helix/users') {
            const login = parsed.searchParams.get('login');
            return json(200, { data: users.has(login) ? [{ id: '9', login, display_name: login.toUpperCase() }] : [] });
        }
        return json(404, {});
    };
    return { impl, calls };
}

function fakeClient() {
    const sent = [];
    const channel = { isTextBased: () => true, send: async (payload) => { sent.push(payload); return {}; } };
    return { sent, client: { channels: { cache: { get: (id) => (id === CHANNEL ? channel : undefined) } } } };
}

function twitchRow(id, login, lastItemId = null, template = null) {
    return { id, guild_id: GUILD, kind: 'twitch', source_id: login, channel_id: CHANNEL, message_template: template, last_item_id: lastItemId };
}

test('login: plain names and twitch.tv links, lowercased; junk refused', () => {
    assert.equal(parseTwitchLogin('CatStreamer'), 'catstreamer');
    assert.equal(parseTwitchLogin('@cat_streamer'), 'cat_streamer');
    assert.equal(parseTwitchLogin('https://www.twitch.tv/Cat_Streamer?ref=x'), 'cat_streamer');
    assert.equal(parseTwitchLogin('twitch.tv/catstreamer/videos'), 'catstreamer');
    assert.equal(parseTwitchLogin('m.twitch.tv/cat'), 'cat');
    assert.throws(() => parseTwitchLogin('https://twitch.tv/directory'), /Twitch login/);
    assert.throws(() => parseTwitchLogin('has spaces'), /Twitch login/);
    assert.throws(() => parseTwitchLogin('x'.repeat(26)), /Twitch login/);
    assert.throws(() => parseTwitchLogin(''), /Twitch login/);
});

test('streams: live items parsed into entries keyed by login; non-live and broken items skipped', () => {
    const live = parseStreamsResponse({ data: [
        stream('catstreamer', '4001', { title: '  Hi <@&123456789012345678> @everyone ' }),
        stream('other', '4002', { type: '' }),
        { id: '', user_login: 'broken', type: 'live' },
        stream('nogame', '4003', { game_name: '', title: '' }),
    ] });
    assert.deepEqual([...live.keys()], ['catstreamer', 'nogame']);
    assert.deepEqual(live.get('catstreamer'), {
        id: '4001', title: 'Hi <@&123456789012345678> @everyone', url: 'https://www.twitch.tv/catstreamer',
        author: 'CATSTREAMER', game: 'Just Chatting', login: 'catstreamer',
    });
    assert.equal(live.get('nogame').title, '(untitled)');
    assert.equal(live.get('nogame').game, '');
    assert.equal(parseStreamsResponse(null).size, 0);
    assert.equal(streamToEntry({}).author, 'Twitch');
});

test('template: Twitch default, {game} filled, YouTube {game} empty', () => {
    const entry = { title: 'Speedrun', url: 'https://www.twitch.tv/cat', author: 'Cat', game: 'Celeste' };
    assert.equal(renderFeedMessage(null, entry, 'twitch'), '**Cat** is live on Twitch: **Speedrun**\nhttps://www.twitch.tv/cat');
    assert.equal(DEFAULT_TWITCH_TEMPLATE, '**{author}** is live on Twitch: **{title}**\n{url}');
    assert.equal(renderFeedMessage('{author} plays {game}: {title} {url}', entry, 'twitch'), 'Cat plays Celeste: Speedrun https://www.twitch.tv/cat');
    assert.equal(renderFeedMessage('{title} [{game}]', { title: 'v', url: 'u', author: 'a' }), 'v []');
});

test('missing env: Twitch is off; nothing is requested; adding a Twitch feed is refused plainly', async () => {
    assert.equal(isTwitchConfigured({}), false);
    assert.equal(isTwitchConfigured({ TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: ' ' }), false);
    assert.equal(isTwitchConfigured({ TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 'secret' }), true);
    const { impl, calls } = fakeTwitchFetch();
    const off = createTwitchClient({ clientId: '', clientSecret: '', fetchImpl: impl });
    assert.equal(off.configured, false);
    setFeedsForTests([twitchRow(1, 'catstreamer')]);
    const { client, sent } = fakeClient();
    assert.deepEqual(await pollTwitchFeeds(client, { twitch: off }), { sources: 0, posted: 0, skipped: 'not configured' });
    await assert.rejects(addFeed({ guildId: GUILD, platform: 'twitch', sourceInput: 'catstreamer', channelId: CHANNEL, createdBy: '3' }, impl, { twitch: off }),
        /Twitch alerts are not set up on this bot yet/);
    await assert.rejects(off.getLiveStreams(['catstreamer']), /not configured/);
    assert.equal(calls.length, 0);
    assert.equal(sent.length, 0);
});

test('offline → live posts once; the same stream id never again; a new stream posts again', async () => {
    const streams = new Map();
    const { impl } = fakeTwitchFetch({ streams });
    const twitch = createTwitchClient({ clientId: 'id', clientSecret: 'secret', fetchImpl: impl });
    setFeedsForTests([twitchRow(1, 'catstreamer', null, '<@&123456789012345678> {author} is live: {title} ({game})')]);
    const saved = [];
    const saveMarker = async (id, marker) => { saved.push([id, marker]); };
    const { client, sent } = fakeClient();

    assert.equal((await pollTwitchFeeds(client, { twitch, saveMarker })).posted, 0, 'offline: nothing');
    streams.set('catstreamer', stream('catstreamer', '5001', { title: 'Hi @everyone' }));
    assert.equal((await pollTwitchFeeds(client, { twitch, saveMarker })).posted, 1, 'went live: one post');
    assert.equal(sent[0].content, '<@&123456789012345678> CATSTREAMER is live: Hi @everyone (Just Chatting)');
    assert.deepEqual(sent[0].allowedMentions, { parse: [], roles: ['123456789012345678'] });
    assert.deepEqual(saved, [[1, '5001']]);

    assert.equal((await pollTwitchFeeds(client, { twitch, saveMarker })).posted, 0, 'still live: no repost');
    streams.delete('catstreamer');
    assert.equal((await pollTwitchFeeds(client, { twitch, saveMarker })).posted, 0, 'offline again: nothing');
    assert.equal(listFeeds(GUILD)[0].lastItemId, '5001', 'going offline keeps the marker');
    streams.set('catstreamer', stream('catstreamer', '5002'));
    assert.equal((await pollTwitchFeeds(client, { twitch, saveMarker })).posted, 1, 'next stream: posts');
    assert.equal(sent.length, 2);
    assert.deepEqual(saved, [[1, '5001'], [1, '5002']]);
});

test('after a restart the saved stream id is not posted again', async () => {
    const streams = new Map([['catstreamer', stream('catstreamer', '6001')]]);
    const { impl } = fakeTwitchFetch({ streams });
    const twitch = createTwitchClient({ clientId: 'id', clientSecret: 'secret', fetchImpl: impl });
    setFeedsForTests([twitchRow(1, 'catstreamer', '6001')]); // as loaded from the database
    const { client, sent } = fakeClient();
    assert.equal((await pollTwitchFeeds(client, { twitch, saveMarker: async () => {} })).posted, 0);
    assert.equal(sent.length, 0);
    assert.deepEqual(selectTwitchAlerts(listFeeds(GUILD), parseStreamsResponse({ data: [stream('catstreamer', '6001')] })), []);
});

test('marker not saved → not posted (retried next poll); Twitch down → nothing posted', async () => {
    const streams = new Map([['catstreamer', stream('catstreamer', '7001')]]);
    const { impl } = fakeTwitchFetch({ streams });
    const twitch = createTwitchClient({ clientId: 'id', clientSecret: 'secret', fetchImpl: impl });
    setFeedsForTests([twitchRow(1, 'catstreamer')]);
    const { client, sent } = fakeClient();
    let failing = true;
    const saveMarker = async () => { if (failing) throw new Error('database not responding'); };
    assert.equal((await pollTwitchFeeds(client, { twitch, saveMarker })).posted, 0);
    assert.equal(listFeeds(GUILD)[0].lastItemId, null);
    failing = false;
    assert.equal((await pollTwitchFeeds(client, { twitch, saveMarker })).posted, 1);
    assert.equal(sent.length, 1);

    // Removed while the poll waited on Twitch: the marker update matches no row → not posted.
    setFeedsForTests([twitchRow(3, 'catstreamer')]);
    const gone = async () => { throw new Error('the feed was removed'); };
    assert.equal((await pollTwitchFeeds(client, { twitch, saveMarker: gone })).posted, 0);
    assert.equal(sent.length, 1);

    const down = { configured: true, getLiveStreams: async () => { throw new Error('HTTP 503'); } };
    setFeedsForTests([twitchRow(2, 'other')]);
    assert.deepEqual(await pollTwitchFeeds(client, { twitch: down, saveMarker }), { sources: 1, posted: 0, skipped: 'twitch' });
});

test('YouTube poll ignores Twitch feeds (no RSS request for a login)', async () => {
    setFeedsForTests([twitchRow(1, 'catstreamer')]);
    let fetched = 0;
    const result = await pollFeeds(fakeClient().client, async () => { fetched += 1; return json(200, {}); });
    assert.deepEqual(result, { sources: 0, posted: 0 });
    assert.equal(fetched, 0);
});

test('token: cached between calls, renewed once on a 401, renewed after expiry; secret only in the token request', async () => {
    let clock = 1_000_000;
    const unauthorizedTokens = new Set(['tok1']);
    const { impl, calls } = fakeTwitchFetch({ streams: new Map([['cat', stream('cat', '8001')]]), unauthorizedTokens });
    const twitch = createTwitchClient({ clientId: 'id', clientSecret: 'shh-secret', fetchImpl: impl, now: () => clock });

    const live = await twitch.getLiveStreams(['cat']);
    assert.equal(live.get('cat').id, '8001');
    const tokenCalls = () => calls.filter((call) => call.url === TWITCH_TOKEN_URL).length;
    assert.equal(tokenCalls(), 2, 'tok1 got a 401, tok2 was fetched once');
    assert.equal(calls.length, 4, 'token, 401, token, 200');
    assert.equal(calls[3].init.headers.authorization, 'Bearer tok2');
    assert.equal(calls[3].init.headers['client-id'], 'id');
    assert.ok(calls[0].init.body.includes('grant_type=client_credentials'));
    assert.ok(calls[0].init.signal, 'fetch has a timeout signal');
    assert.ok(calls.filter((call) => call.url !== TWITCH_TOKEN_URL).every((call) => !JSON.stringify(call).includes('shh-secret')));

    await twitch.getLiveStreams(['cat']);
    assert.equal(tokenCalls(), 2, 'cached token reused');
    clock += 3600 * 1000;
    await twitch.getLiveStreams(['cat']);
    assert.equal(tokenCalls(), 3, 'expired token renewed');
});

test('token: a second 401 after renewing is an error, not a loop; a failed token request throws', async () => {
    const { impl, calls } = fakeTwitchFetch({ unauthorizedTokens: new Set(['tok1', 'tok2']) });
    const twitch = createTwitchClient({ clientId: 'id', clientSecret: 'secret', fetchImpl: impl });
    await assert.rejects(twitch.getLiveStreams(['cat']), (error) => error.status === 401);
    assert.equal(calls.length, 4);
    const broken = createTwitchClient({ clientId: 'id', clientSecret: 'bad', fetchImpl: async () => json(400, { message: 'invalid client secret' }) });
    await assert.rejects(broken.getUser('cat'), (error) => error.status === 400 && !error.message.includes('bad'));
});

test('streams: more than 100 logins are split into requests of 100', async () => {
    const { impl, calls } = fakeTwitchFetch();
    const twitch = createTwitchClient({ clientId: 'id', clientSecret: 'secret', fetchImpl: impl });
    const logins = Array.from({ length: 150 }, (_, i) => `user${i}`);
    await twitch.getLiveStreams([...logins, 'USER0']);
    const streamCalls = calls.filter((call) => call.url.includes('/helix/streams'));
    assert.deepEqual(streamCalls.map((call) => new URL(call.url).searchParams.getAll('user_login').length), [100, 50]);
    assert.ok(streamCalls.every((call) => new URL(call.url).searchParams.get('type') === 'live'));
});

test('add (Twitch): unknown login refused; Twitch down is a user error; limit shared with YouTube', async () => {
    const { impl } = fakeTwitchFetch({ users: new Set(['catstreamer']) });
    const twitch = createTwitchClient({ clientId: 'id', clientSecret: 'secret', fetchImpl: impl });
    setFeedsForTests([]);
    await assert.rejects(addFeed({ guildId: GUILD, platform: 'twitch', sourceInput: 'nobody_here', channelId: CHANNEL, createdBy: '3' }, impl, { twitch }),
        /Twitch has no channel with that name/);
    const down = { configured: true, getUser: async () => { throw new Error('HTTP 500'); } };
    await assert.rejects(addFeed({ guildId: GUILD, platform: 'twitch', sourceInput: 'catstreamer', channelId: CHANNEL, createdBy: '3' }, impl, { twitch: down }),
        /Could not reach Twitch/);
    await assert.rejects(addFeed({ guildId: GUILD, platform: 'tiktok', sourceInput: 'x', channelId: CHANNEL, createdBy: '3' }, impl, { twitch }), /YouTube or Twitch/);

    setFeedsForTests(Array.from({ length: 20 }, (_, i) => ({ ...twitchRow(i + 1, `u${i}`), kind: i % 2 ? 'twitch' : 'youtube' })));
    await assert.rejects(addFeed({ guildId: GUILD, platform: 'twitch', sourceInput: 'catstreamer', channelId: CHANNEL, createdBy: '3' }, impl, { twitch }),
        /at most 20 feeds \(YouTube and Twitch together\)/);
    setFeedsForTests([]);
});
