import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    parseYoutubeChannelId, decodeXml, parseYoutubeFeed, selectNewEntries, renderFeedMessage, templateRoleIds, feedUrl,
    fetchYoutubeFeed, DEFAULT_FEED_TEMPLATE,
} = await import('../../src/services/community/feedService.js');

const CHANNEL = 'UCabcdefghijklmnopqrstuv';

export function sampleFeed(ids) {
    const entries = ids.map((id, i) => `
 <entry>
  <id>yt:video:${id}</id>
  <yt:videoId>${id}</yt:videoId>
  <yt:channelId>${CHANNEL}</yt:channelId>
  <title>Video ${i} &amp; friends &#39;ep&#x21;&#39;</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>
  <author>
   <name>Cat Channel</name>
   <uri>https://www.youtube.com/channel/${CHANNEL}</uri>
  </author>
  <published>2026-10-2${i}T12:00:00+00:00</published>
  <media:group><media:title>ignored</media:title></media:group>
 </entry>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}"/>
 <id>yt:channel:abcdefghijklmnopqrstuv</id>
 <title>Cat Channel</title>
 <author>
  <name>Cat Channel</name>
 </author>${entries}
</feed>`;
}

test('channel id: raw ids and /channel/ links; handles rejected', () => {
    assert.equal(parseYoutubeChannelId(CHANNEL), CHANNEL);
    assert.equal(parseYoutubeChannelId(`https://www.youtube.com/channel/${CHANNEL}?si=x`), CHANNEL);
    assert.throws(() => parseYoutubeChannelId('@catchannel'), /channel id/);
    assert.throws(() => parseYoutubeChannelId('UCshort'), /channel id/);
    assert.equal(feedUrl(CHANNEL), `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`);
});

test('XML: entities and CDATA decoded', () => {
    assert.equal(decodeXml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x1F431;'), 'a & b <c> "d" \'e\' 🐱');
    assert.equal(decodeXml('<![CDATA[raw <b>]]>'), 'raw <b>');
    assert.equal(decodeXml('&bogus; &#0;'), '&bogus; &#0;');
});

test('RSS: entries parsed newest first with title, link, author, published', () => {
    const entries = parseYoutubeFeed(sampleFeed(['vid_AAAAAAA', 'vid_BBBBBBB']));
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
        id: 'vid_AAAAAAA',
        title: "Video 0 & friends 'ep!'",
        url: 'https://www.youtube.com/watch?v=vid_AAAAAAA',
        author: 'Cat Channel',
        published: '2026-10-20T12:00:00+00:00',
    });
    assert.deepEqual(parseYoutubeFeed('<feed></feed>'), []);
    assert.deepEqual(parseYoutubeFeed('not xml at all'), []);
    assert.deepEqual(parseYoutubeFeed('<entry><yt:videoId>bad id with spaces</yt:videoId></entry>'), []);
});

test('new entries: none on first sight, oldest first, capped, nothing when the marker vanished', () => {
    const entries = ['e', 'd', 'c', 'b', 'a'].map((id) => ({ id }));
    assert.deepEqual(selectNewEntries(entries, null), { toPost: [], marker: 'e' });
    assert.deepEqual(selectNewEntries(entries, 'e'), { toPost: [], marker: 'e' });
    assert.deepEqual(selectNewEntries(entries, 'c').toPost.map((e) => e.id), ['d', 'e']);
    assert.deepEqual(selectNewEntries(entries, 'a', 3).toPost.map((e) => e.id), ['c', 'd', 'e']);
    assert.deepEqual(selectNewEntries(entries, 'gone'), { toPost: [], marker: 'e' });
    assert.deepEqual(selectNewEntries([], 'x'), { toPost: [], marker: 'x' });
});

test('template: placeholders filled; only role mentions written by the admin may ping', () => {
    const entry = { title: 'Hi <@&999999999999999999> @everyone', url: 'https://youtu.be/x', author: 'Cat' };
    assert.equal(renderFeedMessage(null, entry), DEFAULT_FEED_TEMPLATE.replace('{author}', 'Cat').replace('{title}', entry.title).replace('{url}', entry.url));
    assert.equal(renderFeedMessage('<@&123456789012345678> {author}: {title} {url} {unknown}', entry),
        `<@&123456789012345678> Cat: ${entry.title} https://youtu.be/x {unknown}`);
    assert.deepEqual(templateRoleIds('<@&123456789012345678> {title}'), ['123456789012345678']);
    assert.deepEqual(templateRoleIds(null), []);
});

test('fetch: HTTP errors carry the status; body parsed', async () => {
    const ok = async (url) => ({ ok: true, status: 200, text: async () => sampleFeed(['vid_CCCCCCC']), url });
    assert.equal((await fetchYoutubeFeed(CHANNEL, ok))[0].id, 'vid_CCCCCCC');
    const missing = async () => ({ ok: false, status: 404, text: async () => '' });
    await assert.rejects(fetchYoutubeFeed(CHANNEL, missing), (error) => error.status === 404);
});
