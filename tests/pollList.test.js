// Open polls for "End a poll" (pollList.js): candidates from the dashboard audit log and the
// bot's message cache, each checked on the message (Mewvo's, a native poll, still open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPollCandidates, listOpenPolls, openPollsFor } from '../src/services/dashboard/pollList.js';

const GUILD = '100000000000000001';
const BOT = '999999999999999998';
const TEXT = '500000000000000001';
const OTHER_CH = '500000000000000002';
const NOW = Date.UTC(2026, 10, 7, 12);
const id = (n) => `71000000000000${String(n).padStart(4, '0')}`;

const poll = (n, { author = BOT, finalized = false, expires = NOW + 3600_000, question = `Q${n}` } = {}) => ({
    id: id(n), author: { id: author }, url: `https://discord.com/channels/${GUILD}/${TEXT}/${id(n)}`,
    poll: { resultsFinalized: finalized, expiresTimestamp: expires, question: { text: question } },
});

function makeGuild({ cached = [], remote = [] } = {}) {
    const fetches = [];
    const channel = (cid, name) => ({
        id: cid, name,
        messages: {
            cache: new Map(cid === TEXT ? cached.map((m) => [m.id, m]) : []),
            fetch: async (mid) => { fetches.push(mid); return remote.find((m) => m.id === mid) || null; },
        },
    });
    const guild = {
        id: GUILD, client: { user: { id: BOT } },
        channels: { cache: new Map([[TEXT, channel(TEXT, 'general')], [OTHER_CH, channel(OTHER_CH, 'other')]]) },
    };
    return { guild, fetches };
}

test('audit candidates: dashboard polls of the last days, newest first; ended and anonymous ones left out', async () => {
    const seen = [];
    const rows = [
        { key: `poll.${id(3)}.ended`, new: { channelId: TEXT } },
        { key: `poll.${id(3)}`, new: { channelId: TEXT, anonymous: false } },
        { key: `poll.${id(2)}`, new: { channelId: TEXT, anonymous: true } },
        { key: `poll.${id(1)}`, new: { channelId: OTHER_CH, anonymous: false } },
        { key: 'poll.notanid', new: { channelId: TEXT } },
        { key: `poll.${id(4)}`, new: null },
    ];
    const query = async (sql, params) => { seen.push({ sql, params }); return { rows }; };
    const out = await auditPollCandidates(GUILD, { query, table: 'dashboard_audit' });
    assert.deepEqual(out, [{ messageId: id(1), channelId: OTHER_CH }]);
    assert.match(seen[0].sql, /module = 'messages' AND key LIKE 'poll\.%'/);
    assert.deepEqual(seen[0].params, [GUILD, 8, 50], 'guild, 8 days back, capped');
});

test('open polls: cached and fetched candidates checked; not Mewvo\'s, ended, expired and gone are dropped; soonest end first', async () => {
    const { guild, fetches } = makeGuild({
        cached: [poll(1, { expires: NOW + 7200_000 }), poll(2, { author: '123456789012345678' }), poll(3, { finalized: true }), poll(4, { expires: NOW - 1 }), { id: id(5), author: { id: BOT } }],
        remote: [poll(6, { expires: NOW + 60_000, question: 'Pizza <b>?' })],
    });
    guild.channels.cache.get(OTHER_CH).messages.fetch = async (mid) => { fetches.push(mid); return mid === id(6) ? { ...poll(6, { expires: NOW + 60_000, question: 'Pizza <b>?' }) } : null; };
    const polls = await listOpenPolls(guild, {
        now: NOW,
        candidates: [{ messageId: id(1), channelId: TEXT }, { messageId: id(6), channelId: OTHER_CH }, { messageId: id(7), channelId: OTHER_CH }, { messageId: id(8), channelId: '500000000000000099' }],
    });
    assert.deepEqual(polls.map((p) => [p.messageId, p.channelId, p.channelName]), [[id(6), OTHER_CH, 'other'], [id(1), TEXT, 'general']]);
    assert.equal(polls[0].question, 'Pizza <b>?', 'raw here; the page escapes it');
    assert.deepEqual(fetches, [id(6), id(7)], 'a cached poll is not fetched again; an unknown channel is skipped');
});

test('open polls: at most maxFetch reads; no guild → empty; a failed audit read still lists the cached polls (partial)', async () => {
    const { guild, fetches } = makeGuild({ remote: [] });
    const candidates = Array.from({ length: 30 }, (_, i) => ({ messageId: id(100 + i), channelId: TEXT }));
    assert.deepEqual(await listOpenPolls(guild, { now: NOW, candidates, maxFetch: 5 }), []);
    assert.equal(fetches.length, 5);
    assert.deepEqual(await listOpenPolls(null), []);
    const cachedOnly = makeGuild({ cached: [poll(1, { expires: Date.now() + 3600_000 })] });
    const result = await openPollsFor(cachedOnly.guild, GUILD, { query: async () => { throw new Error('db down'); } });
    assert.equal(result.partial, true);
    assert.deepEqual(result.polls.map((p) => p.messageId), [id(1)]);
});
