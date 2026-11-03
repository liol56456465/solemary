import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    ALERT_COOLDOWN_MS, WATCH_MAX_DAYS, alertWatched, buildWatchIndex, expireWatchlist, getActiveWatch, isWatchlistCacheLoaded,
    setWatchlistCacheForTests, validateWatchInput, watchListLine, watchlistLine,
} = await import('../src/services/enforcement/watchlistService.js');
const { formatModLogLine, ACTION_KINDS, channelPurposeFor } = await import('../src/services/automod/channelRouting.js');

const G = '100000000000000001';
const A = '200000000000000002';
const B = '300000000000000003';
const MOD = '900000000000000009';
const hourAgo = new Date(Date.now() - 3600000);
const future = new Date(Date.now() + 3600000);

const row = (fields) => ({ id: '5', guild_id: G, user_id: A, reason: 'alt of a banned member', created_at: hourAgo, until: null, ...fields });

function recorder({ fail = false } = {}) {
    const posts = [];
    const post = async (client, kind, fields) => {
        if (fail) throw new Error('channel gone');
        posts.push({ kind, fields });
    };
    return { posts, post };
}

test('index: one entry per guild member; until null = no end date; expired entries are gone at once', () => {
    const index = buildWatchIndex([row({}), row({ id: '6', user_id: B, until: future })]);
    assert.deepEqual(index.get(`${G}:${A}`), { id: 5, reason: 'alt of a banned member', createdAt: hourAgo.getTime(), until: null });
    assert.equal(index.get(`${G}:${B}`).until, future.getTime());

    setWatchlistCacheForTests([row({}), row({ id: '6', user_id: B, until: new Date(Date.now() - 1000) })]);
    assert.equal(isWatchlistCacheLoaded(), true);
    assert.equal(getActiveWatch(G, A).id, 5);
    assert.equal(getActiveWatch(G, B), null, 'past until: not watched any more, before the expiry job runs');
    assert.equal(getActiveWatch('999', A), null, 'other guild');
    // Still active one second before its end, gone at its end.
    setWatchlistCacheForTests([row({ until: future })]);
    assert.ok(getActiveWatch(G, A, future.getTime() - 1000));
    assert.equal(getActiveWatch(G, A, future.getTime()), null);
});

test('validation: no bots, not yourself, days 1–365 or empty, a reason is required', () => {
    const ok = { userId: A, createdById: MOD, reason: '  watch for alts  ' };
    assert.deepEqual(validateWatchInput(ok), { days: null, reason: 'watch for alts' });
    assert.deepEqual(validateWatchInput({ ...ok, days: 30 }), { days: 30, reason: 'watch for alts' });
    assert.throws(() => validateWatchInput({ ...ok, isBot: true }), /Bots cannot/);
    assert.throws(() => validateWatchInput({ ...ok, createdById: A }), /yourself/);
    for (const days of [0, -1, WATCH_MAX_DAYS + 1, 1.5]) {
        assert.throws(() => validateWatchInput({ ...ok, days }), /between 1 and 365/, String(days));
    }
    assert.throws(() => validateWatchInput({ ...ok, reason: '   ' }), /reason is required/);
    assert.equal(validateWatchInput({ ...ok, reason: 'x'.repeat(900) }).reason.length, 500);
    // Errors are user errors (shown as-is, not as a crash).
    assert.throws(() => validateWatchInput({ ...ok, isBot: true }), (error) => error.type === 'user_input' && error.context.expected === true
        && error.userMessage === 'Bots cannot be put on the watchlist.');
});

test('alert: only for watched members, one per member per minute, nobody pinged', async () => {
    setWatchlistCacheForTests([row({})]);
    const { posts, post } = recorder();
    const now = Date.now();

    assert.equal(await alertWatched({}, { guildId: G, userId: B, username: 'bob', event: 'joined the server' }, { post, now }), false, 'not watched');
    assert.equal(posts.length, 0);

    assert.equal(await alertWatched({}, { guildId: G, userId: A, username: 'alice', event: 'joined the server' }, { post, now }), true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, 'watch');
    const line = formatModLogLine('watch', posts[0].fields);
    assert.match(line, /^\*\*Watchlist\*\* · alice <@200000000000000002> \(200000000000000002\) · joined the server · Watched for: alt of a banned member · Entry: #5$/);

    // Same member again within a minute (any event): dropped.
    assert.equal(await alertWatched({}, { guildId: G, userId: A, event: 'new case `abcde` (warn) by mod' }, { post, now: now + 30000 }), false);
    assert.equal(await alertWatched({}, { guildId: G, userId: A, event: 'triggered automod' }, { post, now: now + ALERT_COOLDOWN_MS - 1 }), false);
    assert.equal(posts.length, 1);
    // After the minute: posted again.
    assert.equal(await alertWatched({}, { guildId: G, userId: A, event: 'triggered automod (spam)' }, { post, now: now + ALERT_COOLDOWN_MS }), true);
    assert.equal(posts.length, 2);

    // The throttle is per member: another watched member is not held back.
    setWatchlistCacheForTests([row({}), row({ id: '6', user_id: B })]);
    assert.equal(await alertWatched({}, { guildId: G, userId: A, event: 'x' }, { post, now }), true);
    assert.equal(await alertWatched({}, { guildId: G, userId: B, event: 'x' }, { post, now }), true);

    // The mod log routes 'watch' as a one-line enforcement record (postModLog sends allowedMentions { parse: [] }).
    assert.ok(ACTION_KINDS.has('watch'));
    assert.equal(channelPurposeFor('watch'), 'modlog');
});

test('alert: an expired entry stops alerting at once; a failing post never throws', async () => {
    const now = Date.now();
    setWatchlistCacheForTests([row({ until: new Date(now + 1000) })]);
    const { posts, post } = recorder();
    assert.equal(await alertWatched({}, { guildId: G, userId: A, event: 'joined the server' }, { post, now: now + 1000 }), false);
    assert.equal(posts.length, 0);

    setWatchlistCacheForTests([row({})]);
    const failing = recorder({ fail: true });
    assert.equal(await alertWatched({}, { guildId: G, userId: A, event: 'joined the server' }, { post: failing.post, now }), false);
    assert.equal(await alertWatched({}, { guildId: null, userId: A, event: 'x' }, { post, now }), false);
});

test('lines: /background shows since + reason; /case watch list shows period, author and reason', () => {
    const created = Math.floor(hourAgo.getTime() / 1000);
    assert.equal(watchlistLine({ id: 5, reason: 'alt', createdAt: hourAgo.getTime(), until: null }), `On watchlist since <t:${created}:R> — alt (entry #5)`);
    assert.match(watchlistLine({ id: 5, reason: 'alt', createdAt: hourAgo.getTime(), until: future.getTime() }), /— alt \(until <t:\d+:f>\) \(entry #5\)$/);
    assert.equal(watchListLine({ id: '5', user_id: A, created_by: MOD, created_at: hourAgo, until: null, reason: 'alt' }),
        `**#5** <@${A}> · since <t:${created}:R> · no end date · by <@${MOD}> · alt`);
});

test('expiry job: does nothing without the database', async () => {
    assert.equal(await expireWatchlist({}), 0);
});

test('/case watch: add (member, reason, optional days), list, end', async () => {
    const { default: command } = await import('../src/commands/Enforcement/case.js');
    const json = command.data.toJSON();
    assert.ok(json.description.length <= 100);
    const watch = json.options.find((option) => option.name === 'watch');
    assert.ok(watch, 'watch group');
    assert.deepEqual(watch.options.map((sub) => sub.name), ['add', 'list', 'end']);
    const add = watch.options[0].options;
    assert.deepEqual(add.map((option) => [option.name, Boolean(option.required)]), [['member', true], ['reason', true], ['days', false]]);
    assert.equal(add[2].max_value, WATCH_MAX_DAYS);
    assert.equal(command.scope, 'main');
});

test('alert throttle is per kind: a join alert never swallows the ban case that follows', async () => {
    setWatchlistCacheForTests([row({})]);
    const { posts, post } = recorder();
    const now = Date.now();
    assert.equal(await alertWatched({}, { guildId: G, userId: A, event: 'joined the server', kind: 'join' }, { post, now }), true);
    assert.equal(await alertWatched({}, { guildId: G, userId: A, event: 'new case `abcde` (ban) by automod', kind: 'case' }, { post, now: now + 5000 }), true);
    assert.equal(await alertWatched({}, { guildId: G, userId: A, event: 'new case `fghjk` (warn) by mod', kind: 'case' }, { post, now: now + 6000 }), false, 'same kind within a minute');
    assert.equal(posts.length, 2);
});
