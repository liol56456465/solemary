// starboardService.js — starboard (/community starboard set | off).
//
// When a message gets `threshold` reactions with the starboard emoji (not
// counting the author's own reaction or bots), it is copied to the starboard
// channel. The post's count follows reactions added and removed, its text
// follows edits of the original, and it is removed when the original is
// deleted or drops below the threshold. Bot messages are never starred.
//
// Settings come from the in-memory community settings and posts from an
// in-memory map (loaded at startup), so a reaction that is not the starboard
// emoji costs nothing, and one below the threshold costs no API call.

import { logger } from '../../utils/logger.js';
import { createEmbed } from '../../utils/embeds.js';
import { Mutex } from '../../utils/mutex.js';
import { CT, query, isCommunityDbAvailable, userError } from './db.js';
import { getCommunitySettings } from './settingsService.js';

export const STARBOARD_MAX_THRESHOLD = 100;
const UNKNOWN_MESSAGE = 10008;

// sourceMessageId → { guildId, sourceChannelId, starChannelId, starMessageId, count }
const posts = new Map();
const byStarMessage = new Map(); // starMessageId → sourceMessageId

const CUSTOM_EMOJI = /^<a?:\w{2,32}:(\d{17,20})>$/;

/** Validates an emoji typed by an admin; returns the string to store; throws a user error. */
export function normalizeStarEmoji(input) {
    const text = String(input ?? '').trim();
    if (!text) return '⭐';
    if (CUSTOM_EMOJI.test(text)) return text;
    if (text.length <= 16 && !/\s/.test(text) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text) && !/[A-Za-z0-9]/.test(text)) {
        return text;
    }
    throw userError('Use one emoji: a standard one like ⭐ or a custom emoji from this server.');
}

/** Comparable key for a stored emoji: the id of a custom emoji, else the text without variation selectors; pure. */
export function emojiKey(stored) {
    const custom = CUSTOM_EMOJI.exec(String(stored ?? ''));
    return custom ? custom[1] : String(stored ?? '').replace(/️/g, '');
}

/** Comparable key for a reaction's emoji; pure. */
export function reactionEmojiKey(emoji) {
    return emoji?.id || String(emoji?.name ?? '').replace(/️/g, '');
}

/** Stars that count: no bots, no self-star. `extra` is reactions beyond the fetched page; pure. */
export function countStars(users, authorId, extra = 0) {
    let count = 0;
    for (const user of users) if (!user.bot && user.id !== authorId) count += 1;
    return count + Math.max(0, extra);
}

/** What to do with the starboard post; pure. */
export function decideStarAction({ count, threshold, existing }) {
    if (!existing) return count >= threshold ? 'create' : 'none';
    if (count < threshold) return 'delete';
    return count === existing.count ? 'none' : 'update';
}

function firstImage(message) {
    for (const attachment of message.attachments?.values?.() ?? []) {
        if (attachment.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || '')) return attachment.url;
    }
    const embedImage = message.embeds?.find?.((embed) => embed.image?.url || embed.thumbnail?.url);
    return embedImage?.image?.url || embedImage?.thumbnail?.url || null;
}

/** The starboard post for a message; pure apart from reading the message. */
export function buildStarPost(message, count, emoji) {
    const author = message.author;
    const name = message.member?.displayName || author?.username || 'Unknown';
    const attachmentsNote = message.attachments?.size && !firstImage(message) ? `\n\n📎 ${message.attachments.size} attachment(s)` : '';
    const embed = createEmbed({
        description: `${message.content || ''}${attachmentsNote}`.trim() || '*(no text)*',
        color: 'warning',
        author: { name, ...(author?.displayAvatarURL ? { iconURL: author.displayAvatarURL() } : {}) },
        fields: [{ name: 'Source', value: `[Jump to message](${message.url})` }],
        footer: { text: `${message.id}` },
        image: firstImage(message),
        timestamp: message.createdAt instanceof Date ? message.createdAt : true,
    });
    return {
        content: `${emoji} **${count}** · <#${message.channelId}>`,
        embeds: [embed],
        allowedMentions: { parse: [] },
    };
}

export async function loadStarboardPosts() {
    if (!isCommunityDbAvailable()) return null;
    const { rows } = await query(`SELECT * FROM ${CT.starboard}`);
    posts.clear();
    byStarMessage.clear();
    for (const row of rows) remember(row);
    return rows.length;
}

function remember(row) {
    const entry = {
        guildId: row.guild_id,
        sourceChannelId: row.source_channel_id,
        starChannelId: row.star_channel_id,
        starMessageId: row.star_message_id,
        count: Number(row.count),
    };
    posts.set(row.source_message_id, entry);
    byStarMessage.set(entry.starMessageId, row.source_message_id);
    return entry;
}

function forget(sourceId) {
    const entry = posts.get(sourceId);
    if (entry) byStarMessage.delete(entry.starMessageId);
    posts.delete(sourceId);
}

export function getStarboardPost(sourceId) {
    return posts.get(sourceId) || null;
}

async function deleteRow(sourceId) {
    forget(sourceId);
    await query(`DELETE FROM ${CT.starboard} WHERE source_message_id = $1`, [sourceId]);
}

async function fetchStarMessage(guild, entry) {
    const channel = guild.channels.cache.get(entry.starChannelId);
    if (!channel) return null;
    return channel.messages.fetch(entry.starMessageId).catch((error) => {
        if (error?.code !== UNKNOWN_MESSAGE) logger.warn(`Starboard: could not fetch post ${entry.starMessageId}: ${error.message}`);
        return null;
    });
}

async function createPost(guild, settings, message, count) {
    const channel = guild.channels.cache.get(settings.starboardChannelId);
    if (!channel?.isTextBased?.()) return false;
    // Never move an NSFW message into a channel that is not NSFW.
    if (message.channel?.nsfw && !channel.nsfw) return false;
    const sent = await channel.send(buildStarPost(message, count, settings.starboardEmoji)).catch((error) => {
        logger.warn(`Starboard: could not post in ${channel.id}: ${error.message}`);
        return null;
    });
    if (!sent) return false;
    const row = {
        source_message_id: message.id, guild_id: guild.id, source_channel_id: message.channelId,
        star_channel_id: channel.id, star_message_id: sent.id, count,
    };
    await query(
        `INSERT INTO ${CT.starboard} (source_message_id, guild_id, source_channel_id, star_channel_id, star_message_id, count)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_message_id) DO UPDATE SET star_channel_id = EXCLUDED.star_channel_id,
            star_message_id = EXCLUDED.star_message_id, count = EXCLUDED.count, updated_at = NOW()`,
        [row.source_message_id, row.guild_id, row.source_channel_id, row.star_channel_id, row.star_message_id, row.count]
    );
    remember(row);
    return true;
}

/** Brings the starboard post of one message in line with its reactions. Serialized per message. */
async function syncStar(reaction) {
    const guild = reaction.message.guild;
    const settings = getCommunitySettings(guild.id);
    if (!settings.starboardChannelId) return;
    const existing = posts.get(reaction.message.id) || null;

    if (reaction.partial) reaction = await reaction.fetch().catch(() => reaction);
    // reaction.count includes self-stars and bots, so below the threshold nothing can change.
    if (!existing && (reaction.count ?? 0) < settings.starboardThreshold) return;

    const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
    if (!message?.author || message.author.bot) return;

    const users = (reaction.count ?? 0) > 0 ? await reaction.users.fetch({ limit: 100 }).catch(() => null) : new Map();
    if (!users) return;
    const count = countStars(users.values(), message.author.id, (reaction.count ?? 0) - users.size);
    const action = decideStarAction({ count, threshold: settings.starboardThreshold, existing });

    if (action === 'create') {
        await createPost(guild, settings, message, count);
    } else if (action === 'update') {
        const post = await fetchStarMessage(guild, existing);
        if (!post) {
            // The post was deleted by hand: post it again.
            await deleteRow(message.id);
            await createPost(guild, settings, message, count);
            return;
        }
        await post.edit(buildStarPost(message, count, settings.starboardEmoji));
        existing.count = count;
        await query(`UPDATE ${CT.starboard} SET count = $2, updated_at = NOW() WHERE source_message_id = $1`, [message.id, count]);
    } else if (action === 'delete') {
        const post = await fetchStarMessage(guild, existing);
        await post?.delete().catch(() => {});
        await deleteRow(message.id);
    }
}

/** messageReactionAdd / messageReactionRemove hook. Never throws. */
export async function handleStarReaction(reaction, user) {
    try {
        const guild = reaction.message?.guild;
        if (!guild || user?.bot) return;
        const settings = getCommunitySettings(guild.id);
        if (!settings.starboardChannelId || reactionEmojiKey(reaction.emoji) !== emojiKey(settings.starboardEmoji)) return;
        if (reaction.message.channelId === settings.starboardChannelId) return;
        await Mutex.runExclusive(`starboard:${reaction.message.id}`, () => syncStar(reaction));
    } catch (error) {
        logger.warn(`Starboard reaction failed: ${error.message}`);
    }
}

/** messageUpdate hook: refreshes the starboard copy of an edited message. Never throws. */
export async function handleStarSourceEdit(newMessage) {
    try {
        const entry = posts.get(newMessage.id);
        if (!entry || !newMessage.guild) return;
        await Mutex.runExclusive(`starboard:${newMessage.id}`, async () => {
            const current = posts.get(newMessage.id);
            if (!current) return;
            const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
            if (!message) return;
            const post = await fetchStarMessage(message.guild, current);
            if (!post) return;
            await post.edit(buildStarPost(message, current.count, getCommunitySettings(message.guild.id).starboardEmoji));
        });
    } catch (error) {
        logger.warn(`Starboard edit sync failed: ${error.message}`);
    }
}

/** messageDelete hook: removes the starboard copy of a deleted message, or forgets a deleted post. Never throws. */
export async function handleStarMessageDelete(message) {
    try {
        if (!message.guild) return;
        const sourceId = posts.has(message.id) ? message.id : byStarMessage.get(message.id);
        if (!sourceId) return;
        await Mutex.runExclusive(`starboard:${sourceId}`, async () => {
            const entry = posts.get(sourceId);
            if (!entry) return;
            if (sourceId === message.id) {
                const post = await fetchStarMessage(message.guild, entry);
                await post?.delete().catch(() => {});
            }
            await deleteRow(sourceId);
        });
    } catch (error) {
        logger.warn(`Starboard delete sync failed: ${error.message}`);
    }
}

/** Validates starboard settings from the command; returns the patch for updateCommunitySettings. */
export function starboardSettingsPatch({ channelId, emoji, threshold }) {
    const value = threshold ?? 3;
    if (!Number.isInteger(value) || value < 1 || value > STARBOARD_MAX_THRESHOLD) {
        throw userError(`threshold must be between 1 and ${STARBOARD_MAX_THRESHOLD}.`);
    }
    return { starboardChannelId: channelId, starboardEmoji: normalizeStarEmoji(emoji), starboardThreshold: value };
}

/** For tests. */
export function setStarboardPostsForTests(rows) {
    posts.clear();
    byStarMessage.clear();
    for (const row of rows) remember(row);
}
