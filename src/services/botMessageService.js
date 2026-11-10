// botMessageService.js — posting as the bot: a message and/or embed, a native Discord
// poll (and ending one early), a reaction poll, a countdown with pause/cancel buttons. Shared by /poll, /countdown and the
// dashboard's Messages page, so both post exactly the same thing.
//
// Every send uses allowedMentions { parse: [] }: typed text never pings @everyone,
// @here, roles or members. The one exception is an announcement's explicit ping
// (postBotMessage `ping`): the admin picks one role, members (the home "New moderators"
// template) or ticks "ping everyone", and allowedMentions allows exactly those and nothing
// else. The bot's permissions in the channel are checked first; a missing one refuses with
// a clear message and nothing is posted.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
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
// Link buttons under an announcement (Discord: label 80, URL 512).
export const LINK_BUTTON_MAX = 3;
export const LINK_BUTTON_LABEL_MAX = 80;
export const LINK_BUTTON_URL_MAX = 512;
// Members one announcement may ping by name (the "New moderators" template).
export const PING_USERS_MAX = 5;

export const POLL_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
export const POLL_MAX_OPTIONS = POLL_EMOJIS.length;
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;

// Native Discord polls (Discord's poll create request: question text 300, answer text 55,
// up to 10 answers, duration in hours). Discord allows up to 32 days; the owner chose 7.
export const NATIVE_POLL_QUESTION_MAX = 300;
export const NATIVE_POLL_ANSWER_MAX = 55;
export const NATIVE_POLL_MAX_ANSWERS = 10;
export const NATIVE_POLL_MIN_HOURS = 1;
export const NATIVE_POLL_MAX_HOURS = 168;
export const NATIVE_POLL_DEFAULT_HOURS = 24;

export const COUNTDOWN_MAX_SECONDS = 86400;
export const COUNTDOWN_TITLE_MAX = 200;

/** Permissions the bot needs in the channel (names of PermissionFlagsBits). */
export const POST_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
/** A plain-text post (no embed, no file) needs no Embed Links. */
export const TEXT_PERMISSIONS = ['ViewChannel', 'SendMessages'];
export const POLL_PERMISSIONS = [...POST_PERMISSIONS, 'AddReactions', 'ReadMessageHistory'];
/** A native poll needs Send Polls (no embed, no reactions). */
export const NATIVE_POLL_PERMISSIONS = ['ViewChannel', 'SendMessages', 'SendPolls'];
/** Ending a poll: the bot has to read the message first. */
export const END_POLL_PERMISSIONS = ['ViewChannel', 'ReadMessageHistory'];

const hexOf = (value) => `#${Number(getColor(value)).toString(16).padStart(6, '0').toUpperCase()}`;

/** The fixed colour choices: [key, label, '#RRGGBB']. */
export const EMBED_COLOURS = [
    ['primary', 'White (default)', hexOf('primary')],
    ['purple', 'Purple', '#9B59B6'],
    ['blurple', 'Discord blurple', '#5865F2'],
    ['green', 'Green', hexOf('success')],
    ['yellow', 'Yellow', hexOf('warning')],
    ['red', 'Red', hexOf('error')],
    ['grey', 'Grey', hexOf('gray')],
];

const PERMISSION_LABELS = {
    ViewChannel: 'View Channel', SendMessages: 'Send Messages', SendMessagesInThreads: 'Send Messages in Threads',
    EmbedLinks: 'Embed Links', AddReactions: 'Add Reactions', ReadMessageHistory: 'Read Message History', AttachFiles: 'Attach Files', SendPolls: 'Send Polls',
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

const isThreadChannel = (channel) => (typeof channel?.isThread === 'function' ? channel.isThread() : false);

/** The permission names of `permissions` the bot lacks in `channel`; threads need Send Messages in Threads. */
function missingPermissionNames(guild, channel, permissions) {
    const me = guild?.members?.me;
    const granted = channel?.permissionsFor?.(me) ?? (me?.permissionsIn ? me.permissionsIn(channel) : null);
    const isThread = typeof channel?.isThread === 'function' ? channel.isThread() : false;
    const names = permissions.map((p) => (isThread && p === 'SendMessages' ? 'SendMessagesInThreads' : p));
    if (!granted?.has) return names;
    return names.filter((p) => !granted.has(PermissionFlagsBits[p]));
}

/** The permissions the bot lacks in `channel` (labels); threads need Send Messages in Threads. */
export function missingPermissions(guild, channel, permissions = POST_PERMISSIONS) {
    return missingPermissionNames(guild, channel, permissions).map((p) => PERMISSION_LABELS[p] || p);
}

/**
 * Refuses (nothing posted) when the channel is not a text channel or a permission is missing.
 * The refusal carries `fix` ({ channelId, perms }) so the dashboard can offer Fix permissions.
 */
export function assertCanPost(guild, channel, permissions = POST_PERMISSIONS) {
    if (!channel || !POSTABLE_TYPES.has(channel.type)) throw validation('Pick a text or announcement channel.');
    const names = missingPermissionNames(guild, channel, permissions);
    if (names.length) {
        const missing = names.map((p) => PERMISSION_LABELS[p] || p);
        const text = `I am missing ${missing.join(', ')} in #${channel.name}. Nothing was posted.`;
        const error = createError(`Bot cannot post in ${channel.id}: ${missing.join(', ')}`, ErrorTypes.PERMISSION, text, { channelId: channel.id, expected: true });
        // A thread uses its channel's permissions: the fix goes to the parent channel.
        const fixId = isThreadChannel(channel) ? channel.parentId : channel.id;
        throw Object.assign(error, fixId ? { fix: { channelId: fixId, perms: names.map((p) => (p === 'SendMessagesInThreads' ? 'SendMessages' : p)) } } : {});
    }
}

/** What a post needs: Embed Links only with an embed, Attach Files only with a file. */
export function permissionsForPost({ embeds = false, files = false } = {}) {
    return [...TEXT_PERMISSIONS, ...(embeds ? ['EmbedLinks'] : []), ...(files ? ['AttachFiles'] : [])];
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

// ── Announcement extras: an explicit ping and link buttons ──────────────

const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * The ping of an announcement, cleaned: { everyone, roleIds (at most 1), userIds (at most
 * PING_USERS_MAX) }; ids that are not snowflakes are dropped. Empty → no ping at all.
 */
export function cleanPing(ping) {
    const ids = (list, max) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((id) => SNOWFLAKE_RE.test(id)))].slice(0, max);
    return { everyone: ping?.everyone === true, roleIds: ids(ping?.roleIds, 1), userIds: ids(ping?.userIds, PING_USERS_MAX) };
}

/** True when the ping notifies nobody. */
export function isEmptyPing(ping) {
    const p = cleanPing(ping);
    return !p.everyone && !p.roleIds.length && !p.userIds.length;
}

/** The mentions put in front of the text: "@everyone <@&role> <@user>" (only what was picked). */
export function pingLine(ping) {
    const p = cleanPing(ping);
    return [p.everyone ? '@everyone' : '', ...p.roleIds.map((id) => `<@&${id}>`), ...p.userIds.map((id) => `<@${id}>`)].filter(Boolean).join(' ');
}

/**
 * allowedMentions for a post: exactly what was picked. Nothing picked → { parse: [] } (no
 * pings at all). "everyone" only when ticked; roles and users only the picked ids, so a role,
 * member, @everyone or @here typed in the text never pings unless it was picked.
 */
export function announcementMentions(ping) {
    const p = cleanPing(ping);
    if (!p.everyone && !p.roleIds.length && !p.userIds.length) return noMentions();
    return { parse: p.everyone ? ['everyone'] : [], roles: p.roleIds, users: p.userIds };
}

/** A link a button may open: https only, a real host name, no user:password, no spaces. */
export function isLinkButtonUrl(url) {
    if (typeof url !== 'string' || !url || url.length > LINK_BUTTON_URL_MAX || /\s/.test(url)) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && Boolean(parsed.hostname) && parsed.hostname.includes('.') && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

/** [{ label, url }] → at most LINK_BUTTON_MAX checked buttons; a bad one throws (never dropped silently). */
export function cleanLinkButtons(buttons) {
    const list = Array.isArray(buttons) ? buttons : [];
    if (list.length > LINK_BUTTON_MAX) throw validation(`At most ${LINK_BUTTON_MAX} link buttons.`);
    return list.map((b) => {
        const label = String(b?.label ?? '').trim();
        const url = String(b?.url ?? '').trim();
        if (!label || label.length > LINK_BUTTON_LABEL_MAX) throw validation(`A button label needs 1 to ${LINK_BUTTON_LABEL_MAX} characters.`);
        if (!isLinkButtonUrl(url)) throw validation('A button link must be a full https:// link.');
        return { label, url };
    });
}

/** The link buttons as one action row (or none). */
export function linkButtonRows(buttons) {
    const clean = cleanLinkButtons(buttons);
    if (!clean.length) return [];
    return [new ActionRowBuilder().addComponents(clean.map((b) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(b.label).setURL(b.url)))];
}

/**
 * Posts `content` and/or `embed` (the fields of buildMessageEmbed) in `channel` as the bot.
 * `ping` ({ everyone, roleIds, userIds }) puts those mentions in front of the text and is the
 * only thing allowedMentions lets through; `buttons` ([{ label, url }], https) adds link
 * buttons. Returns { message }.
 */
export async function postBotMessage(guild, { channel, content = '', embed = null, ping = null, buttons = [] } = {}) {
    const typed = String(content ?? '').trim();
    const line = pingLine(ping);
    const text = line ? (typed ? `${line}\n${typed}` : line) : typed;
    if (text.length > MESSAGE_CONTENT_MAX) throw validation(`The message text is limited to ${MESSAGE_CONTENT_MAX} characters.`);
    const built = embed ? buildMessageEmbed(embed) : null;
    if (!typed && !built) throw validation('Write a message or fill in the embed: there is nothing to post.');
    const components = linkButtonRows(buttons);
    assertCanPost(guild, channel, permissionsForPost({ embeds: Boolean(built) }));
    const message = await channel.send({
        ...(text ? { content: text } : {}),
        ...(built ? { embeds: [built] } : {}),
        ...(components.length ? { components } : {}),
        allowedMentions: announcementMentions(ping),
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
        ? '\n*Anonymous poll: votes aren\'t tied to names.*'
        : '\n*React with the number to vote.*';
    return successEmbed(anonymous ? 'Anonymous poll' : 'Poll', description);
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

/**
 * A native poll's question, 2–10 answers and options, trimmed and checked against
 * Discord's limits (refused, never cut). `durationHours` 1–168 (default 24).
 */
export function cleanNativePoll(question, answers, { durationHours = NATIVE_POLL_DEFAULT_HOURS, multiSelect = false } = {}) {
    const q = String(question ?? '').trim();
    if (!q) throw validation('The poll needs a question.');
    if (q.length > NATIVE_POLL_QUESTION_MAX) throw validation(`The question is limited to ${NATIVE_POLL_QUESTION_MAX} characters.`);
    const list = (Array.isArray(answers) ? answers : []).map((a) => String(a ?? '').trim()).filter(Boolean);
    if (list.length < 2) throw validation('You must provide at least 2 options for the poll.');
    if (list.length > NATIVE_POLL_MAX_ANSWERS) throw validation(`A poll has at most ${NATIVE_POLL_MAX_ANSWERS} options.`);
    const long = list.find((a) => a.length > NATIVE_POLL_ANSWER_MAX);
    if (long) throw validation(`Each option of a Discord poll is limited to ${NATIVE_POLL_ANSWER_MAX} characters ("${long.slice(0, 20)}..." has ${long.length}). Shorten it, or use an anonymous poll (up to ${POLL_OPTION_MAX} characters).`);
    const hours = durationHours === null || durationHours === undefined || durationHours === '' ? NATIVE_POLL_DEFAULT_HOURS : Number(durationHours);
    if (!Number.isInteger(hours) || hours < NATIVE_POLL_MIN_HOURS || hours > NATIVE_POLL_MAX_HOURS) {
        throw validation(`The poll can stay open from ${NATIVE_POLL_MIN_HOURS} hour to ${NATIVE_POLL_MAX_HOURS} hours (7 days), in whole hours.`);
    }
    return { question: q, options: list, durationHours: hours, multiSelect: Boolean(multiSelect) };
}

/** The channel.send payload of a native poll (already cleaned). No pings, ever. */
export function buildNativePollPayload({ question, options, durationHours, multiSelect }) {
    return {
        poll: {
            question: { text: question },
            answers: options.map((text) => ({ text })),
            duration: durationHours,
            allowMultiselect: Boolean(multiSelect),
        },
        allowedMentions: noMentions(),
    };
}

/**
 * Posts a native Discord poll. Members vote with Discord's poll buttons, and anyone can
 * see who voted for what (use createPoll for the reaction poll). Returns
 * { message, question, options, durationHours, multiSelect, endsAt (ms) }.
 */
export async function createNativePoll(guild, { channel, question, options, durationHours = NATIVE_POLL_DEFAULT_HOURS, multiSelect = false } = {}) {
    const poll = cleanNativePoll(question, options, { durationHours, multiSelect });
    assertCanPost(guild, channel, NATIVE_POLL_PERMISSIONS);
    const message = await channel.send(buildNativePollPayload(poll));
    const endsAt = message?.poll?.expiresTimestamp ?? Date.now() + poll.durationHours * 3600 * 1000;
    return { message, ...poll, endsAt };
}

const MESSAGE_LINK_RE = /^<?https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?>?$/i;

/** A Discord message link → { guildId, channelId, messageId }, else null. */
export function parseMessageLink(text) {
    const match = MESSAGE_LINK_RE.exec(String(text ?? '').trim());
    if (!match) return null;
    const [, guildId, channelId, messageId] = match;
    return { guildId, channelId, messageId };
}

const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const noAccess = () => validation('I cannot read that message: I have no access to that channel or thread. The poll was not ended.');

/**
 * Ends a native poll right away (the "End now" of /poll end and the dashboard). `link` is
 * the poll message's link. Refuses, with a readable message, a link to another server, a
 * channel or message that is gone, a message that is not a native poll, a poll Mewvo did not
 * post (Discord lets a bot end only its own polls) and a poll that already ended.
 * Returns { message, channel, question }.
 */
export async function endPoll(guild, link) {
    const target = parseMessageLink(link);
    if (!target) throw validation('That is not a message link. In Discord, right-click the poll (or long-press it), choose Copy Message Link and paste it here.');
    if (target.guildId !== guild?.id) throw validation('That message is in another server. Only polls in this server can be ended here.');
    let channel = guild.channels?.cache?.get(target.channelId) ?? null;
    if (!channel && guild.channels?.fetch) {
        channel = await guild.channels.fetch(target.channelId).catch((error) => {
            if (error?.code === UNKNOWN_CHANNEL || error?.status === 404) return null;
            throw error;
        });
    }
    if (!channel || typeof channel.messages?.fetch !== 'function') throw validation('I could not find the channel of that message. It may have been deleted.');
    const missing = missingPermissions(guild, channel, END_POLL_PERMISSIONS);
    if (missing.length) {
        const text = `I am missing ${missing.join(', ')} in #${channel.name}, so I cannot read that message. The poll was not ended.`;
        throw createError(`Bot cannot read ${channel.id}: ${missing.join(', ')}`, ErrorTypes.PERMISSION, text, { channelId: channel.id, expected: true });
    }
    const message = await channel.messages.fetch(target.messageId).catch((error) => {
        if (error?.code === UNKNOWN_MESSAGE || error?.status === 404) return null;
        if (error?.code === MISSING_ACCESS || error?.code === MISSING_PERMISSIONS) throw noAccess();
        throw error;
    });
    if (!message) throw validation('I could not find that message. It may have been deleted.');
    if (!message.poll) throw validation('That message is not a Discord poll. Reaction polls (the anonymous kind) cannot be ended: delete the message instead if you want to close it.');
    const botId = guild.client?.user?.id ?? guild.members?.me?.id;
    if (!botId || message.author?.id !== botId) throw validation('That poll was not posted by Mewvo. Discord only lets Mewvo end its own polls.');
    const expires = message.poll.expiresTimestamp;
    if (message.poll.resultsFinalized || (expires !== null && expires !== undefined && expires <= Date.now())) {
        throw validation('That poll has already ended.');
    }
    try {
        await message.poll.end();
    } catch (error) {
        // discord.js refuses an expired poll (PollAlreadyExpired); Discord can also refuse a finalized one.
        if (error?.code === 'PollAlreadyExpired' || message.poll.resultsFinalized) throw validation('That poll has already ended.');
        if (error?.code === MISSING_ACCESS || error?.code === MISSING_PERMISSIONS) throw noAccess();
        throw error;
    }
    return { message, channel, question: message.poll.question?.text || '' };
}

/** Running countdowns by id (the pause/cancel buttons look them up here). */
export const activeCountdowns = new Map();

/**
 * Starts a countdown in `channel` (same message and buttons as /countdown). `totalSeconds`
 * 1–86400. Returns { message, countdownId, endTime }.
 */
export async function startCountdownMessage(guild, { channel, totalSeconds, title = '' } = {}) {
    const seconds = Number(totalSeconds);
    if (!Number.isInteger(seconds) || seconds <= 0) throw validation('The duration has to be at least 1 second.');
    if (seconds > COUNTDOWN_MAX_SECONDS) throw validation('Countdown cannot be longer than 24 hours.');
    const name = String(title ?? '').trim() || 'Countdown';
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
