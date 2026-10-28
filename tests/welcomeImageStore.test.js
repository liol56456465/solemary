import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpiredDiscordCdnUrl, resolveWelcomeImageUrl } from '../src/utils/welcomeImageStore.js';

const hex = (ms) => Math.floor(ms / 1000).toString(16);

test('only Discord CDN URLs past their ex= timestamp count as expired', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    const past = `https://cdn.discordapp.com/attachments/1/2/a.png?ex=${hex(now - 1000)}&is=0&hm=abc`;
    const future = `https://cdn.discordapp.com/attachments/1/2/a.png?ex=${hex(now + 3600_000)}&is=0&hm=abc`;
    assert.equal(isExpiredDiscordCdnUrl(past, now), true);
    assert.equal(isExpiredDiscordCdnUrl(future, now), false);
    assert.equal(isExpiredDiscordCdnUrl('https://media.discordapp.net/attachments/1/2/a.png', now), false);
    assert.equal(isExpiredDiscordCdnUrl(`https://example.com/a.png?ex=${hex(now - 1000)}`, now), false);
    assert.equal(isExpiredDiscordCdnUrl('not a url', now), false);
});

function fakeClient(attachmentUrl, calls) {
    return {
        channels: {
            fetch: async (id) => {
                calls.push(id);
                if (attachmentUrl instanceof Error) throw attachmentUrl;
                return { messages: { fetch: async () => ({ attachments: { first: () => ({ url: attachmentUrl }) } }) } };
            },
        },
    };
}

test('a stored image message gives a fresh URL and is cached', async () => {
    const calls = [];
    const ref = { channelId: 'c1', messageId: 'm1', url: 'https://cdn.discordapp.com/old.png' };
    const client = fakeClient('https://cdn.discordapp.com/fresh.png', calls);
    const opts = { guildId: 'g', label: 'welcome' };
    assert.equal(await resolveWelcomeImageUrl(client, ref.url, ref, opts), 'https://cdn.discordapp.com/fresh.png');
    assert.equal(await resolveWelcomeImageUrl(client, ref.url, ref, opts), 'https://cdn.discordapp.com/fresh.png');
    assert.equal(calls.length, 1, 'second lookup served from cache');
});

test('falls back to the saved URL when the message is gone or the URL was changed', async () => {
    const calls = [];
    const opts = { guildId: 'g', label: 'goodbye' };
    const ref = { channelId: 'c2', messageId: 'm2', url: 'https://cdn.discordapp.com/saved.png' };
    assert.equal(await resolveWelcomeImageUrl(fakeClient(new Error('Unknown Message'), calls), ref.url, ref, opts), ref.url);
    // A URL set elsewhere (e.g. /goodbye setup) wins over an old stored copy.
    assert.equal(await resolveWelcomeImageUrl(fakeClient('x', calls), 'https://example.com/new.png', ref, opts), 'https://example.com/new.png');
    assert.equal(await resolveWelcomeImageUrl(fakeClient('x', calls), null, ref, opts), null);
});
