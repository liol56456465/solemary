// botMessageService.js — posting as the bot: a message and/or embed, a reaction poll,
// a countdown with pause/cancel buttons. Shared by /poll, /countdown and the
// dashboard's Messages page, so both post exactly the same thing.
//
// Every send uses allowedMentions { parse: [] }: typed text never pings @everyone,
// @here, roles or members. The bot's permissions in the channel are checked first;
// a missing one refuses with a clear message and nothing is posted.

import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { successEmbed } from '../utils/embeds.js';
import { getColor } from '../config/bot.js';
import { createControlButtons, formatTime, startCountdown } from '../handlers/countdownButtons.js';

export const MESSAGE_CONTENT_MAX = 2000;
export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_FOOTER_MAX = 2048;
export const EMBED_TOTAL_MAX = 6000;
export const IMAGE_URL_MAX = 2048;

export const POLL_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
export const POLL_MAX_OPTIONS = POLL_EMOJIS.length;
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;

export const COUNTDOWN_MAX_SECONDS = 86400;
export const COUNTDOWN_TITLE_MAX = 200;

/** Permissions the bot needs in the channel (names of PermissionFlagsBits). */
export const POST_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
export const POLL_PERMISSIONS = [...POST_PERMISSIONS, 'AddReactions', 'ReadMessageHistory'];

const hexOf = (value) => `#${Number(getColor(value)).toString(16).padStart(6, '0').toUpperCase()}`;

/** The fixed colour choices: [key, label, '#RRGGBB']. */
export const EMBED_COLOURS = [
    ['primary', 'Meowist blue', hexOf('primary')],
    ['purple', 'Purple', '#9B59B6'],
    ['blurple', 'Discord blurple', '#5865F2'],
    ['green', 'Green', hexOf('success')],
    ['yellow', 'Yellow', hexOf('warning')],
    ['red', 'Red', hexOf('error')],
    ['grey', 'Grey', hexOf('gray')],
];

const PERMISSION_LABELS = {
    ViewChannel: 'View Channel', SendMessages: 'Send Messages', SendMessagesInThreads: 'Send Messages in Threads',
    EmbedLinks: 'Embed Links', AddReactions: 'Add Reactions', ReadMessageHistory: 'Read Message History',
};

const POSTABLE_TYPES = new Set([
    ChannelType.GuildText, ChannelType.GuildAnnouncement,
    ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread,
]);

/** No pings from typed text, ever (a fresh object per send). */
export function noMentions() {
    return { parse: [] };
}

const validation = (userMessage) => createError(userMessage, ErrorTypes.VALIDATION, userMessage, { expected: true });

/**
 * An image URL Discord may load for an embed: https only, a real host name, no
 * user:password part, no spaces, at most IMAGE_URL_MAX characters.
 */
export function isEmbedImageUrl(url) {
    if (typeof url !== 'string' || !url || url.length > IMAGE_URL_MAX || /\s/.test(url)) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && Boolean(parsed.hostname) && parsed.hostname.includes('.')
            && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

/** '#9b59b6' or '9B59B6' → 0x9B59B6; anything else → null. */
export function parseHexColour(value) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
    return match ? Number.parseInt(match[1], 16) : null;
}

/** A colour key from EMBED_COLOURS → its number; unknown → null. */
export function colourFromKey(key) {
    const entry = EMBED_COLOURS.find(([k]) => k === key);
    return entry ? Number.parseInt(entry[2].replace('#', ''), 16) : null;
}

/** The permissions the bot lacks in `channel` (labels); threads need Send Messages in Threads. */
export function missingPermissions(guild, channel, permissions = POST_PERMISSIONS) {
    const me = guild?.members?.me;
    const granted = channel?.permissionsFor?.(me) ?? (me?.permissionsIn ? me.permissionsIn(channel) : null);
    const isThread = typeof channel?.isThread === 'function' ? channel.isThread() : false;
    const names = permissions.map((p) => (isThread && p === 'SendMessages' ? 'SendMessagesInThreads' : p));
    if (!granted?.has) return names.map((p) => PERMISSION_LABELS[p] || p);
    return names.filter((p) => !granted.has(PermissionFlagsBits[p])).map((p) => PERMISSION_LABELS[p] || p);
}

/** Refuses (nothing posted) when the channel is not a text channel or a permission is missing. */
export function assertCanPost(guild, channel, permissions = POST_PERMISSIONS) {
    if (!channel || !POSTABLE_TYPES.has(channel.type)) throw validation('Pick a text or announcement channel.');
    const missing = missingPermissions(guild, channel, permissions);
    if (missing.length) {
        const text = `I am missing ${missing.join(', ')} in #${channel.name}. Nothing was posted.`;
        throw createError(`Bot cannot post in ${channel.id}: ${missing.join(', ')}`, ErrorTypes.PERMISSION, text, { channelId: channel.id, expected: true });
    }
}

/**
 * An embed from { title, description, colour (number), imageUrl, footer }, or null when
 * every part is empty. Over-long parts and bad image URLs throw (never cut silently).
 */
export function buildMessageEmbed({ title = '', description = '', colour = null, imageUrl = '', footer = '' } = {}) {
    const t = String(title ?? '').trim();
    const d = String(description ?? '').trim();
    const f = String(footer ?? '').trim();
    const image = String(imageUrl ?? '').trim();
    if (!t && !d && !image && !f) return null;
    if (t.length > EMBED_TITLE_MAX) throw validation(`The embed title is limited to ${EMBED_TITLE_MAX} characters.`);
    if (d.length > EMBED_DESCRIPTION_MAX) throw validation(`The embed description is limited to ${EMBED_DESCRIPTION_MAX} characters.`);
    if (f.length > EMBED_FOOTER_MAX) throw validation(`The embed footer is limited to ${EMBED_FOOTER_MAX} characters.`);
    if (t.length + d.length + f.length > EMBED_TOTAL_MAX) throw validation(`An embed holds at most ${EMBED_TOTAL_MAX} characters in total.`);
    if (image && !isEmbedImageUrl(image)) throw validation('The image URL must be a full https:// link.');
    if (!t && !d && !image) throw validation('An embed needs a title, a description or an image (a footer alone is not shown).');
    const embed = new EmbedBuilder().setColor(Number.isInteger(colour) ? colour : colourFromKey('primary'));
    if (t) embed.setTitle(t);
    if (d) embed.setDescription(d);
    if (image) embed.setImage(image);
    // utils/embeds.js patches setFooter (drops "unimportant" footers): write it directly.
    if (f) embed.data.footer = { text: f };
    return embed;
}

/**
 * Posts `content` and/or `embed` (the fields of buildMessageEmbed) in `channel` as the bot.
 * Returns { message }.
 */
export async function postBotMessage(guild, { channel, content = '', embed = null } = {}) {
    const text = String(content ?? '').trim();
    if (text.length > MESSAGE_CONTENT_MAX) throw validation(`The message text is limited to ${MESSAGE_CONTENT_MAX} characters.`);
    const built = embed ? buildMessageEmbed(embed) : null;
    if (!text && !built) throw validation('Write a message or fill in the embed: there is nothing to post.');
    assertCanPost(guild, channel, POST_PERMISSIONS);
    const message = await channel.send({
        ...(text ? { content: text } : {}),
        ...(built ? { embeds: [built] } : {}),
        allowedMentions: noMentions(),
    });
    return { message };
}

/** The poll question and 2–10 options, trimmed and checked. */
export function cleanPoll(question, options) {
    const q = String(question ?? '').trim();
    if (!q) throw validation('The poll needs a question.');
    if (q.length > POLL_QUESTION_MAX) throw validation(`The question is limited to ${POLL_QUESTION_MAX} characters.`);
    const opts = (Array.isArray(options) ? options : []).map((o) => String(o ?? '').trim()).filter(Boolean);
    if (opts.length < 2) throw validation('You must provide at least 2 options for the poll.');
    if (opts.length > POLL_MAX_OPTIONS) throw validation(`A poll has at most ${POLL_MAX_OPTIONS} options.`);
    const long = opts.find((o) => o.length > POLL_OPTION_MAX);
    if (long) throw validation(`Each option is limited to ${POLL_OPTION_MAX} characters.`);
    return { question: q, options: opts };
}

/** The poll embed, exactly as /poll has always posted it. */
export function buildPollEmbed(question, options, anonymous) {
    let description = `**${question}**\n\n`;
    options.forEach((option, index) => {
        description += `${POLL_EMOJIS[index]} ${option}\n`;
    });
    description += anonymous
        ? '\n*This is an anonymous poll. Votes are not tracked to users.*'
        : '\n*React with the emoji to vote!*';
    return successEmbed(`📊 ${anonymous ? 'Anonymous ' : ''}Poll`, description);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Posts a reaction poll (same embed and number reactions as /poll). Returns
 * { message, reacted } — reacted < options.length when Discord refused a reaction.
 */
export async function createPoll(guild, { channel, question, options, anonymous = false, reactDelayMs = 500 } = {}) {
    const poll = cleanPoll(question, options);
    assertCanPost(guild, channel, POLL_PERMISSIONS);
    const message = await channel.send({ embeds: [buildPollEmbed(poll.question, poll.options, Boolean(anonymous))], allowedMentions: noMentions() });
    let reacted = 0;
    for (let i = 0; i < poll.options.length; i++) {
        try {
            await message.react(POLL_EMOJIS[i]);
            reacted += 1;
        } catch {
            break;
        }
        if (reactDelayMs > 0 && i < poll.options.length - 1) await wait(reactDelayMs);
    }
    return { message, reacted, ...poll };
}

/** Running countdowns by id (the pause/cancel buttons look them up here). */
export const activeCountdowns = new Map();

/**
 * Starts a countdown in `channel` (same message and buttons as /countdown). `totalSeconds`
 * 1–86400. Returns { message, countdownId, endTime }.
 */
export async function startCountdownMessage(guild, { channel, totalSeconds, title = '' } = {}) {
    const seconds = Number(totalSeconds);
    if (!Number.isInteger(seconds) || seconds <= 0) throw validation('Please specify a duration of at least 1 second.');
    if (seconds > COUNTDOWN_MAX_SECONDS) throw validation('Countdown cannot be longer than 24 hours.');
    const name = String(title ?? '').trim() || 'Countdown Timer';
    if (name.length > COUNTDOWN_TITLE_MAX) throw validation(`The countdown title is limited to ${COUNTDOWN_TITLE_MAX} characters.`);
    assertCanPost(guild, channel, POST_PERMISSIONS);

    const endTime = Date.now() + seconds * 1000;
    const countdownId = `${channel.id}-${Date.now()}`;
    const message = await channel.send({
        embeds: [successEmbed(`⏱️ ${name}`, `Time remaining: **${formatTime(seconds)}** (ends <t:${Math.ceil(endTime / 1000)}:R>)`)],
        components: [createControlButtons(countdownId)],
        allowedMentions: noMentions(),
    });
    const countdownData = { message, endTime, remainingTime: seconds * 1000, isPaused: false, title: name, interval: null };
    activeCountdowns.set(countdownId, countdownData);
    startCountdown(countdownId, countdownData, activeCountdowns);
    return { message, countdownId, endTime };
}
