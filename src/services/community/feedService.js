// feedService.js — YouTube upload feeds and Twitch "went live" feeds
// (/community feed add | remove | list).
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
//
// Twitch (kind 'twitch', source_id = lowercase login): every 2 minutes (own cron
// in app.js) one Get Streams request per 100 followed logins. A live stream whose
// id differs from last_item_id is posted once; the stream id is saved BEFORE the
// post, so the same broadcast is never posted twice, also across restarts (if the
// save fails, nothing is posted and the next poll tries again). Going offline
// changes nothing. When a feed is added while the streamer is live, that stream is
// recorded and not posted. Without TWITCH_CLIENT_ID/SECRET Twitch is off
// (twitchService.js): adding is refused and polling skips Twitch feeds.

import { logger } from '../../utils/logger.js';
import { CT, query, isCommunityDbAvailable, isUniqueViolation, userError } from './db.js';
import { limitMessage, planLimit } from '../billing/premiumEffects.js';
import { getTwitchClient, parseTwitchLogin } from './twitchService.js';
import { botText, textForGuild } from '../../utils/botText.js';

// Free's limit; a server owner's plan raises it (planLimit, plans.js).
export const FEED_MAX_PER_GUILD = 20;
export const FEED_TEMPLATE_MAX = 500;
export const FEED_MAX_POSTS_PER_POLL = 3;
export const DEFAULT_FEED_TEMPLATE = '**{author}** posted a new video: **{title}**\n{url}';
export const DEFAULT_TWITCH_TEMPLATE = '**{author}** is live on Twitch: **{title}**\n{url}';
export const FEED_PLATFORMS = ['youtube', 'twitch'];
const FETCH_TIMEOUT_MS = 15_000;
// A YouTube poll: 4 feeds fetched at once, and it stops after about 10 minutes (the cron runs
// every 15); the next poll starts with the feeds this one did not reach.
export const FEED_POLL_CONCURRENCY = 4;
export const FEED_POLL_BUDGET_MS = 10 * 60_000;
let feedCursor = null; // the source id the next poll starts with, or null (from the start)
const MAX_FEED_BYTES = 1_000_000;
const YOUTUBE_CHANNEL_ID = /^UC[\w-]{22}$/;

let feeds = []; // [{ id, guildId, kind, sourceId, channelId, template, lastItemId }]
let loaded = false;

/** A YouTube channel id from an id or a /channel/ URL; throws a user error (in `lang`) otherwise; pure. */
export function parseYoutubeChannelId(input, { lang = 'en' } = {}) {
    const text = String(input ?? '').trim();
    const fromUrl = /youtube\.com\/channel\/(UC[\w-]{22})/i.exec(text);
    const id = fromUrl ? fromUrl[1] : text;
    if (YOUTUBE_CHANNEL_ID.test(id)) return id;
    throw userError(botText(lang).t('community.feed.youtubeIdInvalid'));
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

// The catalog's default messages keep their {author} {title} {url} tokens for renderFeedMessage to fill.
const TEMPLATE_TOKENS = { author: '{author}', title: '{title}', url: '{url}' };

/** The default message of a feed kind (English: DEFAULT_FEED_TEMPLATE / DEFAULT_TWITCH_TEMPLATE); pure. */
export function defaultTemplate(kind, { lang = 'en' } = {}) {
    if (lang === 'en') return kind === 'twitch' ? DEFAULT_TWITCH_TEMPLATE : DEFAULT_FEED_TEMPLATE;
    const tr = botText(lang);
    return kind === 'twitch' ? tr.t('community.feed.defaultTwitch', TEMPLATE_TOKENS) : tr.t('community.feed.defaultYoutube', TEMPLATE_TOKENS);
}

/**
 * Fills a template's {title} {url} {author} {game} placeholders; pure. An admin's template is used as
 * written; without one the default message is in `lang` (the server's: a public post).
 */
export function renderFeedMessage(template, entry, kind = 'youtube', { lang = 'en' } = {}) {
    const values = { title: entry.title, url: entry.url, author: entry.author, channel: entry.author, game: entry.game || '' };
    return String(template || defaultTemplate(kind, { lang }))
        .replace(/\{(title|url|author|channel|game)\}/g, (match, key) => values[key] ?? '')
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

async function ensureLoaded() {
    if (loaded) return true;
    if (!isCommunityDbAvailable()) return false;
    await loadFeeds();
    return true;
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

function checkNewFeed(guildId, template, tr) {
    const text = template == null ? null : String(template).trim() || null;
    if (text && text.length > FEED_TEMPLATE_MAX) throw userError(tr.t('community.feed.tooLong', { max: FEED_TEMPLATE_MAX }));
    // YouTube and Twitch feeds share one per-server limit.
    if (listFeeds(guildId).length >= planLimit(guildId, 'feeds')) throw userError(limitMessage(guildId, 'feeds', 'feeds (YouTube and Twitch together)'));
    return text;
}

async function insertFeed({ guildId, kind, sourceId, channelId, text, lastItemId, createdBy }, tr) {
    let row;
    try {
        ({ rows: [row] } = await query(
            `INSERT INTO ${CT.feeds} (guild_id, kind, source_id, channel_id, message_template, last_item_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [guildId, kind, sourceId, channelId, text, lastItemId, createdBy]
        ));
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw userError(kind === 'twitch'
                ? tr.t('community.feed.twitchDuplicate')
                : tr.t('community.feed.youtubeDuplicate'));
        }
        throw error;
    }
    const feed = toFeed(row);
    feeds.push(feed);
    return feed;
}

/**
 * Adds a feed after checking the source exists. YouTube: records its newest video.
 * Twitch: records the stream that is live right now, if any. Returns { feed, latest }.
 */
// lang: the language of the errors and of the preview's example stream (the admin's).
export async function addFeed({ guildId, platform = 'youtube', sourceInput, channelId, template = null, createdBy, lang = 'en' }, fetchImpl = fetch, { twitch = getTwitchClient() } = {}) {
    const tr = botText(lang);
    if (platform === 'twitch') return addTwitchFeed({ guildId, sourceInput, channelId, template, createdBy }, twitch, tr);
    if (platform !== 'youtube') throw userError(tr.t('community.feed.choosePlatform'));
    const sourceId = parseYoutubeChannelId(sourceInput, { lang: tr.lang });
    const text = checkNewFeed(guildId, template, tr);
    let entries;
    try {
        entries = await fetchYoutubeFeed(sourceId, fetchImpl);
    } catch (error) {
        if (error.status === 404) throw userError(tr.t('community.feed.youtubeNoChannel'));
        throw userError(tr.t('community.feed.youtubeUnreachable', { error: error.message }));
    }
    const feed = await insertFeed({ guildId, kind: 'youtube', sourceId, channelId, text, lastItemId: entries[0]?.id ?? null, createdBy }, tr);
    return { feed, latest: entries[0] || null };
}

async function addTwitchFeed({ guildId, sourceInput, channelId, template, createdBy }, twitch, tr) {
    if (!twitch?.configured) throw userError(tr.t('community.feed.twitchOff'));
    const login = parseTwitchLogin(sourceInput, { lang: tr.lang });
    const text = checkNewFeed(guildId, template, tr);
    let user;
    let live;
    try {
        user = await twitch.getUser(login);
        live = user ? (await twitch.getLiveStreams([user.login])).get(user.login) || null : null;
    } catch (error) {
        throw userError(tr.t('community.feed.twitchUnreachable', { error: error.message }));
    }
    if (!user) throw userError(tr.t('community.feed.twitchNoChannel'));
    const feed = await insertFeed({ guildId, kind: 'twitch', sourceId: user.login, channelId, text, lastItemId: live?.id ?? null, createdBy }, tr);
    return {
        feed,
        user,
        live,
        // For the preview: the live stream, or a sample built from the channel name.
        latest: live || { id: null, title: tr.t('community.feed.exampleTitle'), url: `https://www.twitch.tv/${user.login}`, author: user.displayName, game: 'Just Chatting' },
    };
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
            content: renderFeedMessage(feed.template, entry, feed.kind, { lang: textForGuild(feed.guildId, { purpose: 'public' }).lang }),
            allowedMentions: { parse: [], roles: templateRoleIds(feed.template) },
        }).then(() => true).catch((error) => {
            logger.warn(`Feed #${feed.id}: could not post in ${feed.channelId}: ${error.message}`);
            return false;
        });
        if (ok) posted += 1;
    }
    return posted;
}

/**
 * The poll order: source ids sorted, starting at `cursor` (the first one not reached last time),
 * then wrapping around; pure.
 */
export function feedPollOrder(sourceIds, cursor) {
    const ids = [...sourceIds].sort();
    if (!cursor) return ids;
    const start = ids.findIndex((id) => id >= cursor);
    return start <= 0 ? ids : [...ids.slice(start), ...ids.slice(0, start)];
}

/**
 * One poll of the YouTube feeds (cron, every 15 minutes): FEED_POLL_CONCURRENCY fetches at once,
 * no new fetch after FEED_POLL_BUDGET_MS; the feeds not reached go first next time. Returns
 * { sources, posted }, plus `stoppedAt` (feeds left) when the time ran out.
 * `options` (tests): concurrency, budgetMs, now().
 */
export async function pollFeeds(client, fetchImpl = fetch, { concurrency = FEED_POLL_CONCURRENCY, budgetMs = FEED_POLL_BUDGET_MS, now = Date.now } = {}) {
    if (!(await ensureLoaded())) return { sources: 0, posted: 0 };
    const bySource = new Map();
    for (const feed of feeds) {
        if (feed.kind !== 'youtube') continue;
        if (!bySource.has(feed.sourceId)) bySource.set(feed.sourceId, []);
        bySource.get(feed.sourceId).push(feed);
    }
    const order = feedPollOrder(bySource.keys(), feedCursor);
    const deadline = now() + budgetMs;
    let next = 0;
    let posted = 0;
    const worker = async () => {
        while (next < order.length && now() < deadline) {
            const sourceId = order[next++];
            posted += await pollSource(client, sourceId, bySource.get(sourceId), fetchImpl);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, order.length)) }, worker));
    const result = { sources: bySource.size, posted };
    if (next < order.length) {
        feedCursor = order[next];
        result.stoppedAt = order.length - next;
        logger.warn(`YouTube feeds: poll stopped after ${Math.round(budgetMs / 60000)} min with ${result.stoppedAt} of ${order.length} channel(s) left; they go first next time`);
    } else {
        feedCursor = null;
    }
    return result;
}

/** Fetches one YouTube channel and posts its new videos to every feed following it; the number posted. */
async function pollSource(client, sourceId, followers, fetchImpl) {
    let entries;
    try {
        entries = await fetchYoutubeFeed(sourceId, fetchImpl);
    } catch (error) {
        logger.warn(`YouTube feed ${sourceId} could not be fetched: ${error.message}`);
        return 0;
    }
    let posted = 0;
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
    return posted;
}

/**
 * Which Twitch feeds to post: those whose login is live with a stream id other than
 * the saved one. Offline logins and already-posted streams give nothing; pure.
 */
export function selectTwitchAlerts(twitchFeeds, liveByLogin) {
    const alerts = [];
    for (const feed of twitchFeeds) {
        const entry = liveByLogin.get(String(feed.sourceId).toLowerCase());
        if (entry?.id && entry.id !== feed.lastItemId) alerts.push({ feed, entry });
    }
    return alerts;
}

/**
 * One poll of every Twitch feed (cron, every 2 minutes). Returns { sources, posted, skipped }.
 * Twitch off (no credentials) or no Twitch feeds: no request at all. A failed Twitch
 * request posts nothing (it never counts as "offline").
 */
export async function pollTwitchFeeds(client, { twitch = getTwitchClient(), saveMarker = saveFeedMarker } = {}) {
    if (!twitch?.configured) return { sources: 0, posted: 0, skipped: 'not configured' };
    if (!(await ensureLoaded())) return { sources: 0, posted: 0, skipped: 'database' };
    const twitchFeeds = feeds.filter((feed) => feed.kind === 'twitch');
    const logins = [...new Set(twitchFeeds.map((feed) => feed.sourceId))];
    if (!logins.length) return { sources: 0, posted: 0 };
    let live;
    try {
        live = await twitch.getLiveStreams(logins);
    } catch (error) {
        logger.warn(`Twitch streams could not be fetched: ${error.message}`);
        return { sources: logins.length, posted: 0, skipped: 'twitch' };
    }
    let posted = 0;
    for (const { feed, entry } of selectTwitchAlerts(twitchFeeds, live)) {
        try {
            await saveMarker(feed.id, entry.id);
        } catch (error) {
            logger.warn(`Feed #${feed.id}: stream marker not saved, not posting yet: ${error.message}`);
            continue;
        }
        feed.lastItemId = entry.id;
        posted += await postEntries(client, feed, [entry]);
    }
    return { sources: logins.length, posted };
}

async function saveFeedMarker(id, marker) {
    const { rowCount } = await query(`UPDATE ${CT.feeds} SET last_item_id = $2 WHERE id = $1`, [id, marker]);
    // Removed (/community feed remove) while this poll waited on Twitch: don't post.
    if (!rowCount) throw new Error('the feed was removed');
}

/** For tests: replace the in-memory feeds. */
export function setFeedsForTests(rows) {
    feeds = rows.map(toFeed);
    loaded = true;
}
