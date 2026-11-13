// logForum.js — "Advanced" log channels (owner, 2026-11-13): instead of one text channel, a kind
// of log goes to a forum channel with one post per member, named "<username> logs <user id>".
// Every log about that member in that kind is added to their post, so staff search the forum for
// a name or id and see the member's whole history there. Logs about no member (a channel or role
// changed) go to one "Server logs" post.
//
// Set per kind on the dashboard Logging page (config logging.forums: { kind: forumChannelId });
// a kind without a forum is "Normal" (its text channel, as before). Kinds: the Logging page
// destinations (loggingService.logEvent) plus 'modlog' (punishments) and 'dashboard' (website
// and dashboard changes), both posted by enforcementService.postModLog.
//
// Which post belongs to a member is stored per forum (key-value, no table): switching to another
// forum starts new posts there. A post that was deleted is created again. An archived post is
// reopened by the new message (Discord does that for unlocked posts); a locked one gets a new post.
// sendToLogForum returns null on any failure, and the caller posts in the kind's normal channel
// instead (never silently nothing when a normal channel is set).

import { ChannelType, PermissionFlagsBits, ThreadAutoArchiveDuration } from 'discord.js';
import { logger } from '../utils/logger.js';
import { BoundedMap } from '../utils/boundedMap.js';
import { Mutex } from '../utils/mutex.js';
import { getFromDb, setInDb } from '../utils/database.js';

/** The kinds that can be "Advanced" (Logging page order). */
export const LOG_FORUM_KINDS = Object.freeze(['audit', 'moderation', 'members', 'messages', 'server', 'community', 'dashboard', 'modlog']);

const SNOWFLAKE = /^\d{17,20}$/;
const SERVER_SUBJECT = 'server';
const NAME_MAX = 100; // Discord's limit for a post title
const FORUM_PERMS = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
];

// guild:forum:subject → post id, in front of the stored value (bounded for many servers).
const postCache = new BoundedMap(20000);
// Throttled warnings per forum (a missing permission would otherwise warn on every log).
const warnedAt = new BoundedMap(2000);
const WARN_EVERY_MS = 10 * 60 * 1000;
// A forum whose new posts Discord refused because of a limit (the server's active-thread cap, a rate
// limit): no new posts for a while, so a raid does not keep hammering it (logs use the normal channel).
const pausedUntil = new BoundedMap(2000);
const PAUSE_MS = 10 * 60 * 1000;
const MAX_ACTIVE_THREADS = 160006;
const UNKNOWN_CHANNEL = 10003;
const THREAD_LOCKED = 160005;

const postKey = (guildId, forumId, subject) => `logforum:${guildId}:${forumId}:${subject}`;

/** The forum channel id of a kind in this config, or null ("Normal"). Pure. */
export function logForumId(config, kind) {
    if (!LOG_FORUM_KINDS.includes(kind)) return null;
    const id = config?.logging?.forums?.[kind];
    return typeof id === 'string' && SNOWFLAKE.test(id) ? id : null;
}

/**
 * The post title for a member: "<username> logs <id>" (the id is always kept whole, the name
 * shortened to fit 100 characters), or "Server logs" without a member. Pure.
 */
export function logPostName(subject) {
    if (!subject?.id) return 'Server logs';
    const tail = ` logs ${subject.id}`;
    const name = String(subject.username || 'unknown').replace(/\s+/g, ' ').trim() || 'unknown';
    return `${name.slice(0, NAME_MAX - tail.length)}${tail}`;
}

function warnOnce(guildId, forumId, message, now = Date.now()) {
    const key = `${guildId}:${forumId}`;
    const last = warnedAt.get(key);
    if (last && now - last < WARN_EVERY_MS) return;
    warnedAt.set(key, now);
    logger.warn(message);
}

/** The usable forum channel, or null (missing, not a forum, other server, missing permissions). */
async function usableForum(guild, forumId) {
    const forum = guild.channels?.cache?.get(forumId) || await guild.channels?.fetch?.(forumId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum || (forum.guildId && String(forum.guildId) !== String(guild.id))) {
        warnOnce(guild.id, forumId, `Log forum ${forumId} in guild ${guild.id} is missing or not a forum; posting in the normal log channel`);
        return null;
    }
    const me = guild.members?.me;
    const perms = me ? forum.permissionsFor?.(me) : null;
    if (!perms || !perms.has(FORUM_PERMS)) {
        warnOnce(guild.id, forumId, `Mewvo lacks permissions in log forum ${forumId} (guild ${guild.id}); posting in the normal log channel`);
        return null;
    }
    return forum;
}

/** The member's existing post in this forum, or null (none stored, deleted, locked). */
async function existingPost(guild, forum, subject) {
    const key = postKey(guild.id, forum.id, subject);
    let id = postCache.get(key);
    if (!id) {
        const stored = await getFromDb(key, null);
        id = stored?.threadId || null;
    }
    if (!id) return null;
    const thread = forum.threads?.cache?.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (!thread || thread.parentId !== forum.id || thread.locked) return null;
    postCache.set(key, id);
    return thread;
}

/** A tag to put on a new post when the forum requires one (the first one anyone may use), else none. */
function requiredTags(forum) {
    const requires = forum.flags?.has?.('RequireTag');
    const first = (forum.availableTags || []).find((tag) => !tag.moderated)?.id;
    return requires && first ? [first] : undefined;
}

/** A Discord refusal because of a limit (not this post): pause new posts in this forum. */
const isLimit = (error) => Number(error?.code) === MAX_ACTIVE_THREADS || Number(error?.status) === 429;

/**
 * Posts `payload` ({ embeds, content?, files? }) in the member's post of the log forum, creating the
 * post on first use. `subject`: { id, username } or null (the "Server logs" post). Returns the sent
 * message (or the new post), or null when it could not be posted (the caller uses the normal channel).
 */
export async function sendToLogForum({ guild, forumId, subject = null, payload }) {
    try {
        if (!guild || !forumId) return null;
        const forum = await usableForum(guild, forumId);
        if (!forum) return null;
        if ((pausedUntil.get(`${guild.id}:${forum.id}`) || 0) > Date.now()) return null;
        const who = subject?.id && SNOWFLAKE.test(String(subject.id)) ? String(subject.id) : SERVER_SUBJECT;
        let username = subject?.username || null;
        if (who !== SERVER_SUBJECT && !username) {
            const user = guild.client?.users?.cache?.get(who) || await guild.client?.users?.fetch?.(who).catch(() => null);
            username = user?.username || null;
        }
        const message = { ...payload, allowedMentions: { parse: [] } };
        return await Mutex.runExclusive(postKey(guild.id, forum.id, who), async () => {
            const post = await existingPost(guild, forum, who);
            if (post) {
                let gone = false;
                const sent = await post.send(message).catch((error) => {
                    // Only a post that no longer exists or was locked gets a new one; any other refusal
                    // (outage, slowmode) uses the normal channel, so a member's history is not split.
                    gone = [UNKNOWN_CHANNEL, THREAD_LOCKED].includes(Number(error?.code));
                    logger.warn(`Log forum post ${post.id} refused a log (${error.message})${gone ? '; starting a new post' : ''}`);
                    return null;
                });
                if (sent) return sent;
                if (!gone) return null;
            }
            const created = await forum.threads.create({
                name: logPostName(who === SERVER_SUBJECT ? null : { id: who, username }),
                message,
                appliedTags: requiredTags(forum),
                // Archived after an hour without logs, so log posts never fill the server's active-thread
                // limit; the next log about the member reopens the post.
                autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
                reason: 'Mewvo: log post for one member',
            }).catch((error) => {
                if (isLimit(error)) pausedUntil.set(`${guild.id}:${forum.id}`, Date.now() + PAUSE_MS);
                throw error;
            });
            const key = postKey(guild.id, forum.id, who);
            postCache.set(key, created.id);
            // Losing the stored id only means a second post next time; the log itself is posted.
            await setInDb(key, { threadId: created.id, at: Date.now() }).catch((error) =>
                logger.warn(`Could not store log forum post ${created.id}: ${error.message}`));
            return created;
        });
    } catch (error) {
        warnOnce(guild?.id, forumId, `Log forum ${forumId} failed (${error.message}); posting in the normal log channel`);
        return null;
    }
}

/** Forum ids of this config that are in use (any kind), for checks such as the tamper guard. Pure. */
export function logForumIds(config) {
    return LOG_FORUM_KINDS.map((kind) => logForumId(config, kind)).filter(Boolean);
}

/** True for a post Mewvo made in one of this config's log forums (its own create / archive logs are skipped). Pure. */
export function isLogForumPost(thread, config) {
    const botId = thread?.client?.user?.id;
    return Boolean(botId && thread?.ownerId === botId && thread.parentId && logForumIds(config).includes(thread.parentId));
}

/** Test hook. */
export function resetLogForumState() {
    postCache.clear();
    warnedAt.clear();
    pausedUntil.clear();
}
