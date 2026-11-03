// rulesPost.js — posts the server rules in a Discord channel as embeds, styled on the
// dashboard Rules page (title, colour, intro, banner, thumbnail, footer, layout), and edits
// that post in place later ("Update posted message").
//
// buildRulesMessages is pure: it turns the rules + design into message payloads that keep
// Discord's limits (description 4096, field 1024, 25 fields and 6000 characters per embed,
// 10 embeds and 6000 characters per message). The banner is its own image-only embed on
// top (Discord draws an embed image under the text); the thumbnail sits on the first rules
// embed; the footer on the last one.
//
// Images: a link goes into the embed as it is. An uploaded image is kept in the audit log
// channel (utils/welcomeImageStore.js); at post time a fresh link is fetched from that
// message and the file is attached to the rules message itself, so the post keeps its
// picture after Discord's attachment links expire.
//
// Every send and edit uses allowedMentions { parse: [] }.

import { EmbedBuilder } from 'discord.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { RULES_POST_LIMITS } from '../settings/settingsRegistry.js';
import { isExpiredDiscordCdnUrl } from '../../utils/welcomeImageStore.js';
import { POST_PERMISSIONS, assertCanPost, colourFromKey, noMentions } from '../botMessageService.js';

export const DESCRIPTION_MAX = 4096;
export const FIELD_NAME_MAX = 256;
export const FIELD_VALUE_MAX = 1024;
export const FIELDS_PER_EMBED = 25;
export const EMBED_CHARS_MAX = 6000;
export const EMBEDS_PER_MESSAGE = 10;
const ZERO_WIDTH = '\u200b';

const validation = (message) => createError(message, ErrorTypes.VALIDATION, message, { expected: true });

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** "**1. No spam**\nText\n*Consequence: Warning*" for the list layout. */
export function ruleBlock(rule) {
    const lines = [`**${rule.number}. ${oneLine(rule.title)}**`];
    if (rule.text) lines.push(rule.text);
    if (rule.consequence) lines.push(`*Consequence: ${oneLine(rule.consequence)}*`);
    return lines.join('\n');
}

/** { name, value } for the fields layout: the consequence goes in the name (title ≤ 80 + ≤ 100 fits 256). */
export function ruleField(rule) {
    const name = `${rule.number}. ${oneLine(rule.title)}${rule.consequence ? ` · ${oneLine(rule.consequence)}` : ''}`;
    return { name: name.slice(0, FIELD_NAME_MAX), value: rule.text ? rule.text.slice(0, FIELD_VALUE_MAX) : ZERO_WIDTH };
}

/** Characters Discord counts for an embed (title, description, field names/values, footer, author). */
export function embedLength(data) {
    return (data.title?.length || 0) + (data.description?.length || 0) + (data.footer?.text?.length || 0) + (data.author?.name?.length || 0)
        + (data.fields || []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
}

/**
 * The text of the rules embeds (no images), grouped per message: [[chunk, …], …], each
 * chunk { description, fields } is one embed. Embeds are filled up to what the message has
 * left of its 6000 characters (a description holds at most 4096), so long rules need as few
 * messages as possible. `reserved` = what the title and footer may add; `firstTaken` = the
 * embeds already in the first message (the banner). Pure.
 */
function packChunks(rules, layout, intro, reserved, firstTaken) {
    const messages = [[]];
    let used = 0;
    let count = firstTaken;
    const room = () => {
        const left = EMBED_CHARS_MAX - reserved - used;
        return layout === 'fields' ? left : Math.min(DESCRIPTION_MAX, left);
    };
    const fresh = (description = '') => ({ description, fields: [], size: description.length });
    let current = fresh(intro || '');
    const close = () => {
        messages.at(-1).push(current);
        used += current.size;
        count += 1;
    };
    for (const rule of rules) {
        let item;
        let add;
        if (layout === 'fields') {
            item = ruleField(rule);
            add = item.name.length + item.value.length;
            if (current.fields.length < FIELDS_PER_EMBED && current.size + add <= room()) {
                current.fields.push(item);
                current.size += add;
                continue;
            }
        } else {
            item = ruleBlock(rule);
            add = current.size ? item.length + 2 : item.length;
            if (current.size + add <= room()) {
                current.description = current.size ? `${current.description}\n\n${item}` : item;
                current.size += add;
                continue;
            }
        }
        // It does not fit: close this embed (when it has anything) and start the next one,
        // in a new message when this one is full.
        const nonEmpty = current.size > 0 || current.fields.length > 0;
        if (nonEmpty) close();
        const len = layout === 'fields' ? add : item.length;
        if (count >= EMBEDS_PER_MESSAGE || len > room()) {
            messages.push([]);
            used = 0;
            count = 0;
        }
        current = layout === 'fields' ? { description: '', fields: [item], size: len } : fresh(item);
    }
    close();
    return messages;
}

/**
 * The messages to send: [{ embeds: [EmbedBuilder], files: [{ attachment, name }] }].
 * `images` = { banner, thumbnail }, each { url } (a link) or { attachment, name } (a file to
 * attach), or null. Throws a user error when there is nothing to post or more than
 * RULES_POST_LIMITS.maxMessages would be needed. Pure.
 */
export function buildRulesMessages(rules, design, images = {}) {
    if (!rules.length) throw validation('There are no rules to post yet. Add a rule first.');
    const colour = Number.isInteger(design.colour) ? design.colour : colourFromKey('primary');
    const title = String(design.title ?? '').trim();
    const footer = String(design.footer ?? '').trim();
    const imageRef = (image) => (image?.attachment ? `attachment://${image.name}` : image?.url || null);
    const files = [images.banner, images.thumbnail].filter((image) => image?.attachment).map(({ attachment, name }) => ({ attachment, name }));
    const bannerUrl = imageRef(images.banner);
    const thumbnailUrl = imageRef(images.thumbnail);

    const grouped = packChunks(rules, design.layout === 'fields' ? 'fields' : 'list', String(design.intro ?? '').trim(), title.length + footer.length, bannerUrl ? 1 : 0);
    const total = grouped.reduce((sum, chunks) => sum + chunks.length, 0);
    let index = 0;
    const messages = grouped.map((chunks, m) => {
        const embeds = [];
        // The banner is its own image-only embed on top (Discord draws an embed image under the text).
        if (m === 0 && bannerUrl) embeds.push(new EmbedBuilder().setColor(colour).setImage(bannerUrl));
        for (const chunk of chunks) {
            const embed = new EmbedBuilder().setColor(colour);
            if (index === 0 && title) embed.setTitle(title);
            if (index === 0 && thumbnailUrl) embed.setThumbnail(thumbnailUrl);
            if (chunk.description) embed.setDescription(chunk.description);
            if (chunk.fields.length) embed.addFields(chunk.fields);
            if (index === total - 1 && footer) embed.setFooter({ text: footer });
            embeds.push(embed);
            index += 1;
        }
        // Attached images belong to the first message (the banner and the thumbnail are both there).
        return { embeds, files: m === 0 ? files : [] };
    });
    if (messages.length > RULES_POST_LIMITS.maxMessages) {
        throw validation(`The rules need ${messages.length} messages, more than ${RULES_POST_LIMITS.maxMessages}. Shorten some rule texts.`);
    }
    return messages;
}

/**
 * The images for a post: a link stays a link; an uploaded image (with a ref) gets a fresh
 * link from its stored message and is attached as a file. `resolve` = resolveWelcomeImageUrl.
 */
export async function resolveRulesImages(client, guildId, design, resolve) {
    const one = async (image, name) => {
        if (!image?.url) return null;
        if (!image.ref) return { url: image.url };
        const fresh = await Promise.resolve(resolve(client, image.url, image.ref, { guildId, label: `rules ${name}` })).catch(() => null);
        // The store falls back to the saved link when its message is gone; an expired one cannot be posted.
        if (!fresh || isExpiredDiscordCdnUrl(fresh)) throw validation(`The uploaded ${name} could not be loaded from its stored copy (was that message in the log channel deleted?). Upload it again or remove it.`);
        let pathname = '';
        try {
            pathname = new URL(fresh).pathname;
        } catch {
            pathname = '';
        }
        const ext = (/\.(png|jpe?g|gif|webp)$/i.exec(pathname)?.[1] || 'png').toLowerCase();
        return { attachment: fresh, name: `rules-${name}.${ext}` };
    };
    return { banner: await one(design.banner, 'banner'), thumbnail: await one(design.thumbnail, 'thumbnail') };
}

const POST_WITH_FILES = [...POST_PERMISSIONS, 'AttachFiles'];
const permissionsFor = (messages, extra = []) => [...(messages.some((m) => m.files.length) ? POST_WITH_FILES : POST_PERMISSIONS), ...extra];

/**
 * Posts the messages in `channel`. When one send fails, the ones already posted are
 * deleted again (no half post) and the error is thrown. Returns the message ids.
 */
export async function postRulesMessages(guild, channel, messages) {
    assertCanPost(guild, channel, permissionsFor(messages));
    const sent = [];
    try {
        for (const message of messages) {
            sent.push(await channel.send({ embeds: message.embeds, files: message.files, allowedMentions: noMentions() }));
        }
    } catch (error) {
        await Promise.all(sent.map((m) => Promise.resolve(m.delete?.()).catch(() => {})));
        throw error;
    }
    return sent.map((m) => m.id);
}

/**
 * Edits the earlier post in place: the stored messages are edited in order and extra new
 * ones are sent after them. Refuses (nothing changed) when the channel or one of the stored
 * messages is gone. Returns { channel, ids, added, leftovers }: `added` = the new messages,
 * `leftovers` = old messages the post no longer needs. The caller deletes the leftovers once
 * the new ids are saved (or deletes `added` when the save fails), so the stored ids always
 * match what is in Discord.
 */
export async function updateRulesMessages(guild, posted, messages) {
    const channel = guild.channels.cache.get(posted.channelId);
    if (!channel) throw validation('The channel of the posted rules no longer exists. Post them again.');
    // Read Message History: fetching the posted messages by id needs it.
    assertCanPost(guild, channel, permissionsFor(messages, ['ReadMessageHistory']));
    const old = [];
    for (const id of posted.messageIds) {
        let message = null;
        try {
            message = await channel.messages.fetch(id);
        } catch (error) {
            // 10008 Unknown Message: really deleted. Anything else (network, rate limit) is not.
            if (error?.code !== 10008) throw error;
        }
        if (!message) throw validation(`One of the posted rules messages was deleted in #${channel.name}. Use Post to send a new copy.`);
        old.push(message);
    }
    const ids = [];
    const added = [];
    try {
        for (let i = 0; i < messages.length; i++) {
            const { embeds, files } = messages[i];
            if (i < old.length) {
                // attachments: [] drops the old attached images; files adds the current ones.
                await old[i].edit({ embeds, files, attachments: [], allowedMentions: noMentions() });
                ids.push(old[i].id);
            } else {
                const sent = await channel.send({ embeds, files, allowedMentions: noMentions() });
                added.push(sent);
                ids.push(sent.id);
            }
        }
    } catch (error) {
        // New messages sent before the failure are removed again; the stored post stays as it was.
        await Promise.all(added.map((m) => Promise.resolve(m.delete?.()).catch(() => {})));
        throw error;
    }
    return { channel, ids, added, leftovers: old.slice(messages.length) };
}
