// modmailService.js — members DM the bot to talk to staff privately.
//
// A DM to the bot (outside an open conversation) goes to a server that shares the member and
// has modmail set up (multi-server B1): with one such server the member gets a "Send to
// staff?" prompt, with several a "Which server?" select menu (up to 25), with none a clear
// refusal. Mewvo's main server is always set up (as before); any other server once it has a
// modmail category or a /ticket category. The Support server has no modmail. Confirming opens
// a private channel in that server's modmail category (else its ticket category) that only
// staff can see. One open conversation per member at a time, across servers. From then on:
// - the member's DMs are copied into the channel,
// - staff messages in the channel are DM'd to the member, except messages that
//   start with `//` (internal notes) or the command prefix.
// Staff close the conversation with the Close button or /modmail close; the
// transcript goes to the ticket transcript channel and the channel is deleted.
//
// modmail_links (guild, channel, member) is the only state, so open conversations survive
// restarts. Blocked members are stored in each server's guild config.
// Relayed text goes out as message content, not embeds: embeds.js strips emoji
// from embed descriptions.

import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType,
    EmbedBuilder, PermissionFlagsBits, StringSelectMenuBuilder,
} from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { getCommandPrefix } from '../config/bot.js';
import { getGuildConfig } from './config/guildConfig.js';
import { onGuildConfigSaved, updateGuildConfigAtomic } from '../utils/database/guildConfigStorage.js';
import { GUILD_SQL, guildIdsFromSql } from './scheduling/guildScan.js';
import { generateTranscript } from './ticket.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { linkModmailChannel, linkedChannelId, linkedChannelsForUser, linkedUserId, unlinkModmailChannel } from './modmailLinks.js';
import { withOpenChannelSlot } from './openChannelCap.js';
import { isHomeGuild, resolveSetting } from './settings/guildSettings.js';
import { blacklistHit } from './owner/blacklistCache.js';
import { privacyUrl } from '../utils/privacyNotice.js';

const NOTE_PREFIX = '//';
const MAX_MESSAGE = 2000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // Discord's upload limit for bots in unboosted servers
const NO_MENTIONS = { parse: [] };

const opening = new Set(); // userIds with a channel being created right now

/** "-# Privacy: <url>" under member-facing modmail messages, or '' without PUBLIC_URL. */
function privacySuffix() {
    const url = privacyUrl();
    return url ? `\n-# Privacy: <${url}>` : '';
}

export const MODMAIL_BUTTONS = { open: 'modmail_open', cancel: 'modmail_cancel', close: 'modmail_close' };
/** The "Which server?" select menu under the DM prompt: `modmail_pick:<messageId>`, value = guild id. */
export const MODMAIL_PICK = 'modmail_pick';
/** Discord's limit on select menu options. */
export const MAX_SERVER_CHOICES = 25;

export function getMainGuild(client) {
    return client.guilds.cache.get(enforcementConfig.mainGuildId) ?? null;
}

const isMainGuild = (guildId) => Boolean(guildId) && guildId === enforcementConfig.mainGuildId;

/** "the Mewvo staff" for the main server (wording as before), "the staff of <name>" elsewhere. */
export function staffLabel(guild) {
    return !guild || isMainGuild(guild.id) ? 'the Mewvo staff' : `the staff of ${guild.name}`;
}

/** Where a conversation opens: the server's modmail category, else its /ticket category, else null. */
export function findModmailCategory(guild, config) {
    const categoryOf = (id) => (id ? guild.channels.cache.get(id) : null);
    return [categoryOf(resolveSetting(guild.id, 'modmailCategoryId')), categoryOf(config?.ticketCategoryId)]
        .find((c) => c?.type === ChannelType.GuildCategory) || null;
}

/**
 * Does this server take modmail? The main server always (as before: without a category the
 * channel opens at the top). The Support server never (Mewvo's help server, no modmail). Any
 * other server once it has a modmail or /ticket category. Throws SettingsUnavailableError
 * when the server's settings could not be read (callers skip that server).
 */
export function isModmailSetUp(guild, config) {
    if (!guild) return false;
    if (isMainGuild(guild.id)) return true;
    if (isHomeGuild(guild.id)) return false;
    return Boolean(findModmailCategory(guild, config));
}

/**
 * The userId a modmail channel belongs to, or null for any other channel. Read from
 * modmail_links only; the channel topic is not trusted (see modmailLinks.js).
 */
export async function modmailUserId(channel) {
    return linkedUserId(channel);
}

/** The member's open modmail channel, or null. A link to a channel that is gone is removed. */
export async function findModmailChannel(guild, userId) {
    const channelId = await linkedChannelId(guild.id, userId);
    if (!channelId) return null;
    const channel = guild.channels.cache.get(channelId);
    if (channel) return channel;
    await unlinkModmailChannel(channelId).catch((error) => logger.warn(`Stale modmail link ${channelId} not removed: ${error.message}`));
    return null;
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

function promptRow(messageId, guildId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${MODMAIL_BUTTONS.open}:${messageId}:${guildId}`).setLabel('Send to staff').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(MODMAIL_BUTTONS.cancel).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
}

function closeRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(MODMAIL_BUTTONS.close).setLabel('Close').setStyle(ButtonStyle.Danger),
    );
}

const NOT_A_MEMBER_MAIN = 'Modmail is for members of the Mewvo server. If you were banned, use the appeal panel in the support server.';
export const NO_MODMAIL_SERVER = 'None of the servers you share with this bot takes modmail (or you are not a member there any more). '
    + 'Ask that server\'s staff another way. If you were banned from the Mewvo server, use the appeal panel in the support server.';
export const MODMAIL_BLOCKED = 'You can\'t use modmail.';

/** Why this user can't use modmail in `guild` right now, or null when they can. */
async function modmailRefusal(client, guild, userId) {
    if (!guild) return 'Modmail is not available right now.';
    if (await isModmailBlocked(client, guild.id, userId)) return MODMAIL_BLOCKED;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        return isMainGuild(guild.id) ? NOT_A_MEMBER_MAIN : `You are not a member of ${guild.name}, so its staff can't be reached through modmail.`;
    }
    return null;
}

// ── Which servers may take modmail (multi-server B5) ──────────────────────
// A DM used to read every server's config. A server takes modmail with a modmail category
// (settings registry, cached in memory) or a /ticket category (guild config). The servers with a
// ticket category are kept here as a set: loaded with one query, refreshed every 5 minutes and
// updated on every config write (onGuildConfigSaved). The set only narrows which configs are
// read: every candidate's config is still read fresh and checked (isModmailSetUp, blocked), and
// openModmail checks the chosen server again before opening, so a stale set can never send
// modmail to a server that turned it off. Without SQL or before the first load: every server.
const MODMAIL_SET_REFRESH_MS = 5 * 60 * 1000;
let ticketCategorySet = null; // Set<guildId> | null (not loaded)
let ticketCategoryLoadedAt = 0;
let ticketCategoryRefresh = null; // the running refresh, shared by concurrent DMs
let changesDuringRefresh = null; // Map<guildId, boolean> written while a refresh query ran

onGuildConfigSaved((guildId, config) => {
    const has = Boolean(config?.ticketCategoryId);
    changesDuringRefresh?.set(guildId, has);
    if (!ticketCategorySet) return;
    if (has) ticketCategorySet.add(guildId);
    else ticketCategorySet.delete(guildId);
});

async function ticketCategoryServers(client, { query, now = Date.now() } = {}) {
    if (ticketCategorySet && now - ticketCategoryLoadedAt < MODMAIL_SET_REFRESH_MS) return ticketCategorySet;
    if (!query && !client?.db?.rows?.()) return null;
    ticketCategoryRefresh ??= (async () => {
        const changes = new Map();
        changesDuringRefresh = changes;
        try {
            const ids = await guildIdsFromSql(client, GUILD_SQL.ticketCategory, [], { query });
            for (const [id, has] of changes) {
                if (has) ids.add(id);
                else ids.delete(id);
            }
            ticketCategorySet = ids;
            ticketCategoryLoadedAt = Date.now();
        } finally {
            changesDuringRefresh = null;
            ticketCategoryRefresh = null;
        }
    })();
    try {
        await ticketCategoryRefresh;
    } catch (error) {
        logger.warn(`Modmail: the list of servers with a ticket category could not be refreshed (${error.message}); ${ticketCategorySet ? 'using the last one' : 'checking every server'}`);
    }
    return ticketCategorySet;
}

/** For tests: forget the loaded set. */
export function _resetModmailServerSetForTests() {
    ticketCategorySet = null;
    ticketCategoryLoadedAt = 0;
    ticketCategoryRefresh = null;
    changesDuringRefresh = null;
}

/**
 * Can this server take modmail, judged without its config? True for the main server, a server
 * in the ticket-category set, one whose modmail category exists, and whenever unsure (no set
 * loaded, settings unreadable): the config check that follows decides.
 */
function mayTakeModmail(guild, ticketServers) {
    if (!ticketServers || isMainGuild(guild.id) || ticketServers.has(String(guild.id))) return true;
    try {
        const id = resolveSetting(guild.id, 'modmailCategoryId');
        return Boolean(id) && guild.channels.cache.get(id)?.type === ChannelType.GuildCategory;
    } catch {
        return true;
    }
}

/**
 * The servers this member can send modmail to: the bot is in it, the member is in it, modmail
 * is set up there and the member is not blocked there. Main server first, then by name.
 * Returns { servers: [guild], blockedSomewhere }. A server whose settings or config could not be
 * read is skipped (logged), never guessed. `getConfig` is for tests.
 *
 * Cost: the modmail setup is checked first (settings cache / DB, no Discord API call), so the
 * member is only fetched from Discord for servers that take modmail. Servers where the member is
 * already cached are taken first; the rest are fetched one by one.
 */
export async function modmailServersFor(client, userId, { getConfig = getGuildConfig, query } = {}) {
    const ticketServers = await ticketCategoryServers(client, { query });
    const candidates = [];
    for (const guild of client.guilds.cache.values()) {
        if (blacklistHit({ guildId: guild.id })) continue;
        if (isHomeGuild(guild.id) && !isMainGuild(guild.id)) continue; // the Support server has no modmail
        if (!mayTakeModmail(guild, ticketServers)) continue; // no category at all: no config read
        try {
            const config = await getConfig(client, guild.id);
            if (!isModmailSetUp(guild, config)) continue;
            const blocked = Array.isArray(config?.modmailBlocked) && config.modmailBlocked.includes(userId);
            candidates.push({ guild, blocked, cached: guild.members.cache.has(userId) });
        } catch (error) {
            logger.warn(`Modmail: server ${guild.id} skipped for ${userId} (${error.message})`);
        }
    }
    candidates.sort((a, b) => Number(b.cached) - Number(a.cached));
    const servers = [];
    let blockedSomewhere = false;
    for (const { guild, blocked, cached } of candidates) {
        const member = cached || await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;
        if (blocked) {
            blockedSomewhere = true;
            continue;
        }
        servers.push(guild);
    }
    servers.sort((a, b) => (isMainGuild(b.id) - isMainGuild(a.id)) || String(a.name).localeCompare(String(b.name)));
    return { servers, blockedSomewhere };
}

/**
 * The member's open conversation, in any server: { guild, channel } or null. A link to a channel
 * that is gone is removed. Only one conversation is open at a time; if older data holds several,
 * the main server's comes first, then the first found.
 */
export async function findOpenModmail(client, userId) {
    const links = await linkedChannelsForUser(userId);
    links.sort((a, b) => isMainGuild(b.guildId) - isMainGuild(a.guildId));
    for (const link of links) {
        const guild = client.guilds.cache.get(link.guildId);
        const channel = guild?.channels.cache.get(link.channelId);
        if (channel) return { guild, channel };
        if (guild) {
            await unlinkModmailChannel(link.channelId).catch((error) => logger.warn(`Stale modmail link ${link.channelId} not removed: ${error.message}`));
        }
    }
    return null;
}

/**
 * The DM reply for the member's servers (pure, exported for tests):
 *   none → the refusal text; one → "Send to staff?" with the server in the button;
 *   several → "Which server?" with a select menu (first 25) and Cancel.
 */
export function modmailPromptPayload(servers, messageId, { blockedSomewhere = false } = {}) {
    if (!servers.length) {
        return { content: blockedSomewhere ? MODMAIL_BLOCKED : NO_MODMAIL_SERVER, components: [], allowedMentions: NO_MENTIONS };
    }
    if (servers.length === 1) {
        const [guild] = servers;
        return {
            content: `Do you want to send this message to ${staffLabel(guild)}? They will reply here in DMs.${privacySuffix()}`,
            components: [promptRow(messageId, guild.id)],
            allowedMentions: NO_MENTIONS,
        };
    }
    const shown = servers.slice(0, MAX_SERVER_CHOICES);
    const select = new StringSelectMenuBuilder()
        .setCustomId(`${MODMAIL_PICK}:${messageId}`)
        .setPlaceholder('Choose a server')
        .addOptions(shown.map((guild) => ({ label: String(guild.name || guild.id).slice(0, 100), value: guild.id })));
    const more = servers.length > shown.length ? `\n-# Only the first ${MAX_SERVER_CHOICES} servers are listed.` : '';
    return {
        content: `Which server's staff should get this message? They will reply here in DMs.${more}${privacySuffix()}`,
        components: [
            new ActionRowBuilder().addComponents(select),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(MODMAIL_BUTTONS.cancel).setLabel('Cancel').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: NO_MENTIONS,
    };
}

/** Entry point for every DM the bot receives. `getConfig` is for tests. */
export async function handleModmailDm(message, client, { getConfig = getGuildConfig } = {}) {
    const userId = message.author.id;
    if (!(await checkRateLimit(`modmail:dm:${userId}`, 8, 10_000))) return;

    const open = await findOpenModmail(client, userId);
    if (open) {
        const refusal = await modmailRefusal(client, open.guild, userId);
        if (refusal) {
            if (await checkRateLimit(`modmail:refusal:${userId}`, 1, 60_000)) {
                await message.reply({ content: refusal, allowedMentions: NO_MENTIONS }).catch(() => {});
            }
            return;
        }
        const { channel } = open;
        try {
            await relay(channel, `**${message.author.username}:**`, message);
            await message.react('✅').catch(() => {});
        } catch (error) {
            logger.warn(`Modmail relay to ${channel.id} failed: ${error.message}`);
            await message.react('❌').catch(() => {});
        }
        return;
    }

    // Limited before the server lookup, which checks membership in every server the bot is in.
    if (!(await checkRateLimit(`modmail:prompt:${userId}`, 3, 60_000))) return;
    const { servers, blockedSomewhere } = await modmailServersFor(client, userId, { getConfig });
    if (!servers.length) {
        if (await checkRateLimit(`modmail:refusal:${userId}`, 1, 60_000)) {
            await message.reply(modmailPromptPayload(servers, message.id, { blockedSomewhere })).catch(() => {});
        }
        return;
    }
    await message.reply(modmailPromptPayload(servers, message.id))
        .catch((error) => logger.warn(`Modmail prompt failed for ${userId}: ${error.message}`));
}

/**
 * Opens a conversation in server `guildId` for the DM `messageId` (the member pressed "Send to
 * staff" or picked the server). Prompts sent before multi-server carry no server: the main one.
 * Every check is re-run here (member, not blocked, set up). Returns a short status line.
 */
export async function openModmail(client, user, dmChannel, messageId, guildId = enforcementConfig.mainGuildId, { getConfig = getGuildConfig } = {}) {
    const guild = (guildId && client.guilds.cache.get(guildId)) || null;
    if (guild && blacklistHit({ guildId: guild.id })) return 'Modmail is not available right now.';
    const refusal = await modmailRefusal(client, guild, user.id);
    if (refusal) return refusal;
    if (await findOpenModmail(client, user.id)) return 'You already have an open conversation. Just send your messages here.';
    if (opening.has(user.id)) return 'Your conversation is being opened.';
    const setupConfig = await getConfig(client, guild.id);
    if (!isModmailSetUp(guild, setupConfig)) return `${guild.name} does not take modmail right now.`;

    const original = await dmChannel.messages.fetch(messageId).catch(() => null);
    if (!original || original.author.id !== user.id) return 'That message is gone. Send it again.';

    opening.add(user.id);
    try {
        const config = setupConfig;
        const member = await guild.members.fetch(user.id);
        const staffRoleId = config.ticketStaffRoleId || null;
        const staffAccess = [
            PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory,
        ];
        // Its own category (dashboard), else the /ticket category as before.
        const category = findModmailCategory(guild, config);
        const safeName = user.username.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80) || user.id;

        // Modmail counts toward the open-channel cap (with staff reports); appeals never do.
        const slot = await withOpenChannelSlot(guild, 'modmail conversation', async () => {
            const created = await guild.channels.create({
                name: `modmail-${safeName}`,
                type: ChannelType.GuildText,
                parent: category?.type === ChannelType.GuildCategory ? category.id : undefined,
                // For people only; the bot reads the member from modmail_links, never from the topic.
                topic: `Modmail with ${user.username} (${user.id})`,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: client.user.id, allow: [...staffAccess, PermissionFlagsBits.ManageChannels] },
                    ...(staffRoleId ? [{ id: staffRoleId, allow: staffAccess }] : []),
                ],
                reason: `Modmail from ${user.tag} (${user.id})`,
            });
            // The link is what makes it a modmail channel; without it the channel is useless.
            try {
                await linkModmailChannel(guild.id, created.id, user.id);
            } catch (error) {
                await created.delete('Modmail link could not be saved').catch(() => {});
                throw error;
            }
            return { channel: created };
        });
        if (slot.refused) return slot.refused;
        const { channel } = slot;

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
        const to = isMainGuild(guild.id) ? 'staff' : `the staff of ${guild.name}`;
        return `Sent to ${to}. They will reply here; anything else you send here goes to them too.${privacySuffix()}`;
    } finally {
        opening.delete(user.id);
    }
}

/** Sends staff text (e.g. a canned answer) from a modmail channel to the member by DM. */
export async function sendStaffTextToMember(channel, staffName, text) {
    const userId = await modmailUserId(channel);
    if (!userId) return false;
    const user = await channel.client.users.fetch(userId);
    for (const chunk of chunkText(`**${staffName} (staff):**\n${text}`)) {
        await user.send({ content: chunk, allowedMentions: NO_MENTIONS });
    }
    return true;
}

/** Copies a staff message from a modmail channel to the member. Returns true when it was a modmail channel. */
export async function handleModmailStaffMessage(message, prefix = getCommandPrefix()) {
    const userId = await modmailUserId(message.channel);
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

/** A transcript channel of the conversation's own server that the bot can post in (never another server's). */
export function isOwnTranscriptChannel(transcriptChannel, guildId) {
    return Boolean(transcriptChannel && guildId && transcriptChannel.guildId === guildId && transcriptChannel.isSendable?.());
}

/** Ends a conversation: tells the member, files the transcript, deletes the channel. */
export async function closeModmail(channel, closer, reason = '') {
    const userId = await modmailUserId(channel);
    if (!userId) return false;
    const client = channel.client;
    const note = reason ? `\nReason: ${reason}` : '';

    const user = await client.users.fetch(userId).catch(() => null);
    await user?.send({
        content: `Your conversation with ${staffLabel(channel.guild)} was closed.${note}\nSend a new message here any time to start another one.`,
        allowedMentions: NO_MENTIONS,
    }).catch(() => {});

    try {
        const config = await getGuildConfig(client, channel.guild.id);
        const transcriptChannel = config.ticketTranscriptChannelId
            ? await client.channels.fetch(config.ticketTranscriptChannelId).catch(() => null)
            : null;
        const transcript = isOwnTranscriptChannel(transcriptChannel, channel.guild.id) ? await generateTranscript(channel) : null;
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

    // Unlink first so a DM arriving during deletion isn't copied into a dying channel.
    await unlinkModmailChannel(channel.id);
    await channel.delete(`Modmail closed by ${closer.tag ?? closer.id}`);
    logger.info(`Modmail for ${userId} closed by ${closer.id}`);
    return true;
}
