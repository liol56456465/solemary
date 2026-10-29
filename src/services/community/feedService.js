// feedService.js — YouTube upload feeds (/community feed add | remove | list).
//
// Every 15 minutes (cron in app.js) each YouTube channel's public RSS feed
// (https://www.youtube.com/feeds/videos.xml?channel_id=…) is fetched once, no
// matter how many Discord channels follow it, and videos newer than the last
// one seen are posted with the feed's message template. The feed list and the
// last-seen video ids are held in memory; a poll reads nothing from the
// database and writes last_item_id only when it posts a new video.
//
// When a feed is added its current newest video is recorded, so old uploads
// are never posted. If the last-seen video disappears from the RSS window
// (deleted or 15+ uploads since), nothing is posted for that poll and the
// newest video becomes the new marker: missing a video beats reposting.

import { logger } from '../../utils/logger.js';
import { CT, query, isCommunityDbAvailable, isUniqueViolation, userError } from './db.js';

export const FEED_MAX_PER_GUILD = 20;
export const FEED_TEMPLATE_MAX = 500;
export const FEED_MAX_POSTS_PER_POLL = 3;
export const DEFAULT_FEED_TEMPLATE = '📺 **{author}** posted a new video: **{title}**\n{url}';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FEED_BYTES = 1_000_000;
const YOUTUBE_CHANNEL_ID = /^UC[\w-]{22}$/;

let feeds = []; // [{ id, guildId, kind, sourceId, channelId, template, lastItemId }]
let loaded = false;

/** A YouTube channel id from an id or a /channel/ URL; throws a user error otherwise; pure. */
export function parseYoutubeChannelId(input) {
    const text = String(input ?? '').trim();
    const fromUrl = /youtube\.com\/channel\/(UC[\w-]{22})/i.exec(text);
    const id = fromUrl ? fromUrl[1] : text;
    if (YOUTUBE_CHANNEL_ID.test(id)) return id;
    throw userError('Give the YouTube channel id (starts with UC, 24 characters), or a youtube.com/channel/UC… link. @handles are not supported: open the channel, then Share → Copy channel ID.');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes XML entities and CDATA; pure. */
export function decodeXml(text) {
    return String(text ?? '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
            if (entity[0] === '#') {
                const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
                return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
            }
            return ENTITIES[entity.toLowerCase()] ?? match;
        })
        .trim();
}

function tag(block, name) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
    return match ? decodeXml(match[1]) : null;
}

/** Entries of a YouTube RSS feed, newest first: [{ id, title, url, author, published }]; pure. */
export function parseYoutubeFeed(xml) {
    const text = String(xml ?? '');
    const feedAuthor = tag(/<author>[\s\S]*?<\/author>/.exec(text.split('<entry>')[0])?.[0] || '', 'name');
    const entries = [];
    for (const [, block] of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const id = tag(block, 'yt:videoId');
        if (!id || !/^[\w-]{6,20}$/.test(id)) continue;
        const link = /<link\s[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(block)?.[1];
        const author = tag(/<author>[\s\S]*?<\/author>/.exec(block)?.[0] || '', 'name') || feedAuthor || 'YouTube';
        entries.push({
            id,
            title: tag(block, 'title') || '(untitled)',
            url: link ? decodeXml(link) : `https://www.youtube.com/watch?v=${id}`,
            author,
            published: tag(block, 'published'),
        });
    }
    return entries;
}

/**
 * Entries to post, oldest first, and the new marker; pure.
 * lastId null → nothing to post, marker = newest. lastId missing from the feed →
 * nothing to post, marker = newest (see header).
 */
export function selectNewEntries(entries, lastId, max = FEED_MAX_POSTS_PER_POLL) {
    if (!entries.length) return { toPost: [], marker: lastId ?? null };
    const newest = entries[0].id;
    if (!lastId) return { toPost: [], marker: newest };
    const index = entries.findIndex((entry) => entry.id === lastId);
    if (index === -1) return { toPost: [], marker: newest };
    return { toPost: entries.slice(0, index).slice(0, max).reverse(), marker: newest };
}

/** Fills a template's {title} {url} {author} placeholders; pure. */
export function renderFeedMessage(template, entry) {
    const values = { title: entry.title, url: entry.url, author: entry.author, channel: entry.author };
    return String(template || DEFAULT_FEED_TEMPLATE)
        .replace(/\{(title|url|author|channel)\}/g, (match, key) => values[key])
        .slice(0, 2000);
}

/** Role mentions an admin wrote into a template; only these may ping; pure. */
export function templateRoleIds(template) {
    return [...String(template || '').matchAll(/<@&(\d{17,20})>/g)].map((match) => match[1]);
}

export function feedUrl(sourceId) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(sourceId)}`;
}

/** Fetches and parses one feed; throws on HTTP or network failure. */
export async function fetchYoutubeFeed(sourceId, fetchImpl = fetch) {
    const response = await fetchImpl(feedUrl(sourceId), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'Mewvo Discord bot (feed reader)' },
    });
    if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    const text = await response.text();
    return parseYoutubeFeed(text.length > MAX_FEED_BYTES ? text.slice(0, MAX_FEED_BYTES) : text);
}

function toFeed(row) {
    return {
        id: Number(row.id),
        guildId: row.guild_id,
        kind: row.kind,
        sourceId: row.source_id,
        channelId: row.channel_id,
        template: row.message_template || null,
        lastItemId: row.last_item_id || null,
    };
}

export async function loadFeeds() {
    if (!isCommunityDbAvailable()) return null;
    const { rows } = await query(`SELECT * FROM ${CT.feeds} ORDER BY id`);
    feeds = rows.map(toFeed);
    loaded = true;
    return rows.length;
}

export function listFeeds(guildId) {
    return feeds.filter((feed) => feed.guildId === guildId);
}

/** Adds a feed after checking the YouTube channel exists; records its newest video. */
export async function addFeed({ guildId, sourceInput, channelId, template = null, createdBy }, fetchImpl = fetch) {
    const sourceId = parseYoutubeChannelId(sourceInput);
    const text = template == null ? null : String(template).trim() || null;
    if (text && text.length > FEED_TEMPLATE_MAX) throw userError(`The message is limited to ${FEED_TEMPLATE_MAX} characters.`);
    if (listFeeds(guildId).length >= FEED_MAX_PER_GUILD) throw userError(`A server can have at most ${FEED_MAX_PER_GUILD} feeds.`);
    let entries;
    try {
        entries = await fetchYoutubeFeed(sourceId, fetchImpl);
    } catch (error) {
        if (error.status === 404) throw userError('YouTube has no channel with that id.');
        throw userError(`Could not reach YouTube to check that channel (${error.message}). Try again later.`);
    }
    let row;
    try {
        ({ rows: [row] } = await query(
            `INSERT INTO ${CT.feeds} (guild_id, kind, source_id, channel_id, message_template, last_item_id, created_by)
             VALUES ($1, 'youtube', $2, $3, $4, $5, $6) RETURNING *`,
            [guildId, sourceId, channelId, text, entries[0]?.id ?? null, createdBy]
        ));
    } catch (error) {
        if (isUniqueViolation(error)) throw userError('That YouTube channel is already posted to that Discord channel.');
        throw error;
    }
    const feed = toFeed(row);
    feeds.push(feed);
    return { feed, latest: entries[0] || null };
}

/** Removes a feed of the guild; true when there was one. */
export async function removeFeed(guildId, id) {
    const { rowCount } = await query(`DELETE FROM ${CT.feeds} WHERE guild_id = $1 AND id = $2`, [guildId, id]);
    feeds = feeds.filter((feed) => !(feed.guildId === guildId && feed.id === id));
    return rowCount > 0;
}

async function postEntries(client, feed, entries) {
    const channel = client.channels.cache.get(feed.channelId);
    if (!channel?.isTextBased?.()) {
        logger.warn(`Feed #${feed.id}: channel ${feed.channelId} is missing`);
        return 0;
    }
    let posted = 0;
    for (const entry of entries) {
        const ok = await channel.send({
            content: renderFeedMessage(feed.template, entry),
            allowedMentions: { parse: [], roles: templateRoleIds(feed.template) },
        }).then(() => true).catch((error) => {
            logger.warn(`Feed #${feed.id}: could not post in ${feed.channelId}: ${error.message}`);
            return false;
        });
        if (ok) posted += 1;
    }
    return posted;
}

/** One poll of every feed (cron, every 15 minutes). Returns { sources, posted }. */
export async function pollFeeds(client, fetchImpl = fetch) {
    if (!loaded) {
        if (!isCommunityDbAvailable()) return { sources: 0, posted: 0 };
        await loadFeeds();
    }
    const bySource = new Map();
    for (const feed of feeds) {
        if (!bySource.has(feed.sourceId)) bySource.set(feed.sourceId, []);
        bySource.get(feed.sourceId).push(feed);
    }
    let posted = 0;
    for (const [sourceId, followers] of bySource) {
        let entries;
        try {
            entries = await fetchYoutubeFeed(sourceId, fetchImpl);
        } catch (error) {
            logger.warn(`YouTube feed ${sourceId} could not be fetched: ${error.message}`);
            continue;
        }
        for (const feed of followers) {
            const { toPost, marker } = selectNewEntries(entries, feed.lastItemId);
            if (!marker || marker === feed.lastItemId) continue;
            if (toPost.length) posted += await postEntries(client, feed, toPost);
            feed.lastItemId = marker;
            // The marker only moves when a new video was posted, or (rarely) when it was
            // missing or fell out of the feed, so this is the only write a poll makes.
            await query(`UPDATE ${CT.feeds} SET last_item_id = $2 WHERE id = $1`, [feed.id, marker])
                .catch((error) => logger.warn(`Feed #${feed.id}: marker not saved: ${error.message}`));
        }
    }
    return { sources: bySource.size, posted };
}

/** For tests: replace the in-memory feeds. */
export function setFeedsForTests(rows) {
    feeds = rows.map(toFeed);
    loaded = true;
}
