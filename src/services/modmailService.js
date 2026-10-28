// modmailService.js — members DM the bot to talk to staff privately.
//
// A DM from a main-server member (outside an open conversation) gets a
// "Send to staff?" prompt. Confirming opens a private channel in the ticket
// category that only staff can see. From then on:
// - the member's DMs are copied into the channel,
// - staff messages in the channel are DM'd to the member, except messages that
//   start with `//` (internal notes) or the command prefix.
// Staff close the conversation with the Close button or /modmail close; the
// transcript goes to the ticket transcript channel and the channel is deleted.
//
// The channel topic `modmail:<userId>` is the only state, so open conversations
// survive restarts. Blocked members are stored in the guild config.
// Relayed text goes out as message content, not embeds: embeds.js strips emoji
// from embed descriptions.

import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType,
    EmbedBuilder, PermissionFlagsBits,
} from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { getCommandPrefix } from '../config/bot.js';
import { getGuildConfig } from './config/guildConfig.js';
import { updateGuildConfigAtomic } from '../utils/database/guildConfigStorage.js';
import { generateTranscript } from './ticket.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';

const TOPIC_PREFIX = 'modmail:';
const NOTE_PREFIX = '//';
const MAX_MESSAGE = 2000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // Discord's upload limit for bots in unboosted servers
const NO_MENTIONS = { parse: [] };

const opening = new Set(); // userIds with a channel being created right now

export const MODMAIL_BUTTONS = { open: 'modmail_open', cancel: 'modmail_cancel', close: 'modmail_close' };

export function getMainGuild(client) {
    return client.guilds.cache.get(enforcementConfig.mainGuildId) ?? null;
}

/** The userId a modmail channel belongs to, or null for any other channel. */
export function modmailUserId(channel) {
    const topic = channel?.topic;
    if (!topic?.startsWith(TOPIC_PREFIX)) return null;
    const id = topic.slice(TOPIC_PREFIX.length).trim();
    return /^\d{17,20}$/.test(id) ? id : null;
}

export function findModmailChannel(guild, userId) {
    return guild.channels.cache.find((c) => c.type === ChannelType.GuildText && modmailUserId(c) === userId) ?? null;
}

export async function isModmailBlocked(client, guildId, userId) {
    const config = await getGuildConfig(client, guildId);
    return Array.isArray(config.modmailBlocked) && config.modmailBlocked.includes(userId);
}

/** Blocks or unblocks a member from modmail, under the guild config's row lock. */
export async function setModmailBlocked(client, guildId, userId, blocked) {
    await updateGuildConfigAtomic(client, guildId, (config) => {
        const current = new Set(Array.isArray(config.modmailBlocked) ? config.modmailBlocked : []);
        if (blocked) current.add(userId);
        else current.delete(userId);
        return { ...config, modmailBlocked: [...current] };
    }, { operation: 'setModmailBlocked' });
}

/** Staff = Administrator, Manage Channels, or the ticket staff role. */
export function isModmailStaff(member, config) {
    if (!member) return false;
    if (member.guild?.ownerId === member.id) return true;
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    if (member.permissions?.has?.(PermissionFlagsBits.ManageChannels)) return true;
    return Boolean(config?.ticketStaffRoleId && member.roles?.cache?.has(config.ticketStaffRoleId));
}

/** Splits text into chunks Discord accepts, preferring line breaks. */
export function chunkText(text, size = MAX_MESSAGE) {
    const chunks = [];
    let rest = text;
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size / 2) cut = size;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
    return chunks;
}

/** Re-uploads attachments that fit; larger ones become links. */
function splitAttachments(message) {
    const files = [];
    const links = [];
    let total = 0;
    for (const attachment of message.attachments.values()) {
        if (total + attachment.size <= MAX_UPLOAD_BYTES) {
            total += attachment.size;
            files.push(new AttachmentBuilder(attachment.url, { name: attachment.name }));
        } else {
            links.push(attachment.url);
        }
    }
    return { files, links };
}

/** Sends `header` + the message's text and files to `target`, split to fit. */
async function relay(target, header, message) {
    const { files, links } = splitAttachments(message);
    const body = [message.content, ...links].filter(Boolean).join('\n');
    const chunks = chunkText(`${header}\n${body}`.trim());
    for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        await target.send({
            content: chunks[i],
            files: last ? files : [],
            allowedMentions: NO_MENTIONS,
        });
    }
}

function promptRow(messageId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${MODMAIL_BUTTONS.open}:${messageId}`).setLabel('Send to staff').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(MODMAIL_BUTTONS.cancel).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
}

function closeRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(MODMAIL_BUTTONS.close).setLabel('Close').setStyle(ButtonStyle.Danger),
    );
}

/** Why this user can't use modmail right now, or null when they can. */
async function modmailRefusal(client, guild, userId) {
    if (!guild) return 'Modmail is not available right now.';
    if (await isModmailBlocked(client, guild.id, userId)) return 'You can\'t use modmail.';
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        return 'Modmail is for members of the Meowist server. If you were banned, use the appeal panel in the support server.';
    }
    return null;
}

/** Entry point for every DM the bot receives. */
export async function handleModmailDm(message, client) {
    const userId = message.author.id;
    if (!(await checkRateLimit(`modmail:dm:${userId}`, 8, 10_000))) return;

    const guild = getMainGuild(client);
    const refusal = await modmailRefusal(client, guild, userId);
    if (refusal) {
        if (await checkRateLimit(`modmail:refusal:${userId}`, 1, 60_000)) {
            await message.reply({ content: refusal, allowedMentions: NO_MENTIONS }).catch(() => {});
        }
        return;
    }

    const channel = findModmailChannel(guild, userId);
    if (channel) {
        try {
            await relay(channel, `**${message.author.username}:**`, message);
            await message.react('✅').catch(() => {});
        } catch (error) {
            logger.warn(`Modmail relay to ${channel.id} failed: ${error.message}`);
            await message.react('❌').catch(() => {});
        }
        return;
    }

    if (!(await checkRateLimit(`modmail:prompt:${userId}`, 3, 60_000))) return;
    await message.reply({
        content: 'Do you want to send this message to the Meowist staff? They will reply here in DMs.',
        components: [promptRow(message.id)],
        allowedMentions: NO_MENTIONS,
    }).catch((error) => logger.warn(`Modmail prompt failed for ${userId}: ${error.message}`));
}

/**
 * Opens a conversation for the DM `messageId` (the member pressed "Send to staff").
 * Returns a short status line for the prompt.
 */
export async function openModmail(client, user, dmChannel, messageId) {
    const guild = getMainGuild(client);
    const refusal = await modmailRefusal(client, guild, user.id);
    if (refusal) return refusal;
    if (findModmailChannel(guild, user.id)) return 'You already have an open conversation. Just send your messages here.';
    if (opening.has(user.id)) return 'Your conversation is being opened.';

    const original = await dmChannel.messages.fetch(messageId).catch(() => null);
    if (!original || original.author.id !== user.id) return 'That message is gone. Send it again.';

    opening.add(user.id);
    try {
        const config = await getGuildConfig(client, guild.id);
        const member = await guild.members.fetch(user.id);
        const staffRoleId = config.ticketStaffRoleId || null;
        const staffAccess = [
            PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory,
        ];
        const category = config.ticketCategoryId ? guild.channels.cache.get(config.ticketCategoryId) : null;
        const safeName = user.username.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80) || user.id;

        const channel = await guild.channels.create({
            name: `modmail-${safeName}`,
            type: ChannelType.GuildText,
            parent: category?.type === ChannelType.GuildCategory ? category.id : undefined,
            topic: `${TOPIC_PREFIX}${user.id}`,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: client.user.id, allow: [...staffAccess, PermissionFlagsBits.ManageChannels] },
                ...(staffRoleId ? [{ id: staffRoleId, allow: staffAccess }] : []),
            ],
            reason: `Modmail from ${user.tag} (${user.id})`,
        });

        const header = new EmbedBuilder()
            .setTitle('Modmail')
            .setColor(0x5865f2)
            .setDescription([
                `**Member:** ${member} (${user.tag}, \`${user.id}\`)`,
                `**Account created:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
                `**Joined:** ${member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'unknown'}`,
                '',
                'Everything you type here is sent to the member by DM.',
                'Start a message with `//` for an internal note (bot commands aren\'t sent either).',
            ].join('\n'));
        await channel.send({
            content: staffRoleId ? `<@&${staffRoleId}> new modmail` : 'New modmail',
            embeds: [header],
            components: [closeRow()],
            allowedMentions: { roles: staffRoleId ? [staffRoleId] : [] },
        });
        await relay(channel, `**${user.username}:**`, original);
        await original.react('✅').catch(() => {});
        logger.info(`Modmail opened for ${user.id} in ${channel.id}`);
        return 'Sent to staff. They will reply here; anything else you send here goes to them too.';
    } finally {
        opening.delete(user.id);
    }
}

/** Sends staff text (e.g. a canned answer) from a modmail channel to the member by DM. */
export async function sendStaffTextToMember(channel, staffName, text) {
    const userId = modmailUserId(channel);
    if (!userId) return false;
    const user = await channel.client.users.fetch(userId);
    for (const chunk of chunkText(`**${staffName} (staff):**\n${text}`)) {
        await user.send({ content: chunk, allowedMentions: NO_MENTIONS });
    }
    return true;
}

/** Copies a staff message from a modmail channel to the member. Returns true when it was a modmail channel. */
export async function handleModmailStaffMessage(message, prefix = getCommandPrefix()) {
    const userId = modmailUserId(message.channel);
    if (!userId) return false;
    const text = message.content.trimStart();
    if (text.startsWith(NOTE_PREFIX) || (prefix && text.startsWith(prefix))) return true;

    try {
        const user = await message.client.users.fetch(userId);
        const name = message.member?.displayName || message.author.username;
        await relay(user, `**${name} (staff):**`, message);
        await message.react('✅').catch(() => {});
    } catch (error) {
        logger.warn(`Modmail DM to ${userId} failed: ${error.message}`);
        await message.react('❌').catch(() => {});
        await message.reply({
            content: 'Could not DM the member (they left the server or closed their DMs).',
            allowedMentions: NO_MENTIONS,
        }).catch(() => {});
    }
    return true;
}

/** Ends a conversation: tells the member, files the transcript, deletes the channel. */
export async function closeModmail(channel, closer, reason = '') {
    const userId = modmailUserId(channel);
    if (!userId) return false;
    const client = channel.client;
    const note = reason ? `\nReason: ${reason}` : '';

    const user = await client.users.fetch(userId).catch(() => null);
    await user?.send({
        content: `Your conversation with the Meowist staff was closed.${note}\nSend a new message here any time to start another one.`,
        allowedMentions: NO_MENTIONS,
    }).catch(() => {});

    try {
        const config = await getGuildConfig(client, channel.guild.id);
        const transcriptChannel = config.ticketTranscriptChannelId
            ? await client.channels.fetch(config.ticketTranscriptChannelId).catch(() => null)
            : null;
        const transcript = transcriptChannel?.isSendable() ? await generateTranscript(channel) : null;
        if (transcript) {
            await transcriptChannel.send({
                content: `Modmail with <@${userId}> (\`${userId}\`) closed by ${closer}.${note}`,
                files: [new AttachmentBuilder(transcript.buffer, { name: `modmail-${userId}.html` })],
                allowedMentions: NO_MENTIONS,
            });
        }
    } catch (error) {
        logger.warn(`Modmail transcript for ${channel.id} failed: ${error.message}`);
    }

    // Clear the topic first so a DM arriving during deletion isn't copied into a dying channel.
    await channel.setTopic(null).catch(() => {});
    await channel.delete(`Modmail closed by ${closer.tag ?? closer.id}`);
    logger.info(`Modmail for ${userId} closed by ${closer.id}`);
    return true;
}
