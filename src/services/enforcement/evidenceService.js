// evidenceService.js — evidence attached to enforcement cases (mod_case_evidence).
//
// Two kinds:
//   link  — a URL, usually a Discord message link. For a message in the main server
//           a text excerpt (≤ 500 chars) is stored when it is added, so the evidence
//           survives the message being deleted.
//   image — an attachment re-hosted by posting it in the private evidence channel
//           (EVIDENCE_CHANNEL_ID, falling back to the mod log). Discord CDN URLs
//           expire, so displays re-fetch that stored message for a fresh URL.
//
// addEvidence() is the single write path; automod can call it directly later.

import { enforcementConfig } from '../../config/enforcement.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { query, T } from './db.js';
import { dateStamp, truncate } from './format.js';

export const EXCERPT_MAX = 500;
export const NOTE_MAX = 300;
export const MAX_EVIDENCE_PER_CASE = 25;
/** How many links one panel form may attach (each one is a message fetch). */
export const MAX_LINKS_PER_FORM = 5;

const KINDS = new Set(['link', 'image']);
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const MESSAGE_LINK_RE = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})(?:[/?#].*)?$/i;

function userError(message) {
    return createError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Discord message link → { guildId, channelId, messageId, url } (canonical URL), else null. */
export function parseMessageLink(text) {
    const match = MESSAGE_LINK_RE.exec(String(text || '').trim().replace(/[)>.,;]+$/, ''));
    if (!match) return null;
    const [, guildId, channelId, messageId] = match;
    return { guildId, channelId, messageId, url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}` };
}

/**
 * Every http(s) URL in free text, deduplicated, in order. Discord message links
 * are canonicalised and carry their ids under `message`.
 */
export function parseEvidenceUrls(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || '').match(URL_RE) || []) {
        const cleaned = raw.replace(/[)>.,;]+$/, '');
        const message = parseMessageLink(cleaned);
        const url = message ? message.url : cleaned;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ url, message });
    }
    return out;
}

/** "username: content [+2 attachments]", at most EXCERPT_MAX characters. */
export function messageExcerpt(message) {
    const author = message?.author?.username || 'unknown';
    const parts = [];
    const content = String(message?.content || '').trim();
    if (content) parts.push(content);
    const attachments = message?.attachments?.size || 0;
    if (attachments) parts.push(`[+${attachments} attachment${attachments === 1 ? '' : 's'}]`);
    const embeds = message?.embeds?.length || 0;
    if (!content && embeds) parts.push(`[${embeds} embed${embeds === 1 ? '' : 's'}]`);
    return truncate(`${author}: ${parts.join(' ') || '(no text)'}`, EXCERPT_MAX);
}

function jumpLink(channelId, messageId, guildId = enforcementConfig.mainGuildId) {
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function quote(text, max) {
    return `"${truncate(String(text).replace(/\s+/g, ' '), max)}"`;
}

/**
 * Display lines for evidence rows. `freshUrls` maps row id → a current attachment
 * URL for images (see resolveImageUrls); without one the stored message is linked.
 */
export function evidenceLines(rows, freshUrls = new Map(), { excerptMax = 160 } = {}) {
    return rows.map((row) => {
        const meta = `${row.added_by_username}, ${dateStamp(row.added_at)}`;
        const note = row.note ? ` — ${truncate(row.note, 120)}` : '';
        if (row.kind === 'image') {
            const fresh = freshUrls.get(String(row.id));
            const stored = row.store_channel_id && row.store_message_id ? jumpLink(row.store_channel_id, row.store_message_id) : null;
            const links = [fresh ? `[image](${fresh})` : null, stored ? `[stored](${stored})` : null].filter(Boolean);
            return `**#${row.id}** 🖼️ ${links.join(' · ') || 'image (stored message missing)'}${note} · ${meta}`;
        }
        const excerpt = row.excerpt ? ` ${quote(row.excerpt, excerptMax)}` : '';
        return `**#${row.id}** 🔗 ${row.url}${excerpt}${note} · ${meta}`;
    });
}

/** Joins lines into one embed field value (≤ max), noting how many were left out. */
export function fitLines(lines, max = 1024) {
    const out = [];
    let length = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const line = truncate(lines[i], 400);
        const more = `…and ${lines.length - i} more`;
        // Keep room for the "…and N more" marker unless this is the last line.
        const reserve = i < lines.length - 1 ? more.length + 1 : 0;
        const sep = out.length ? 1 : 0;
        if (length + sep + line.length + reserve > max) {
            out.push(more);
            break;
        }
        out.push(line);
        length += sep + line.length;
    }
    return out.join('\n');
}

// ── Database ───────────────────────────────────────────────────────────────

/**
 * Attaches one piece of evidence to a case and returns the stored row.
 * addedBy: { id, username }. Throws on an unknown case, a full case or a DB error.
 */
export async function addEvidence(caseCode, {
    url = null, kind = 'link', excerpt = null, note = null, sourceMessageUrl = null,
    storeChannelId = null, storeMessageId = null, addedBy,
} = {}) {
    if (!KINDS.has(kind)) throw userError(`Unknown evidence kind: ${kind}`);
    if (!addedBy?.id) throw userError('Evidence needs the user who added it.');
    if (kind === 'link' && !url) throw userError('Link evidence needs a URL.');
    if (kind === 'image' && !(storeChannelId && storeMessageId)) throw userError('Image evidence needs its stored message.');

    let rows;
    try {
        ({ rows } = await query(
            `INSERT INTO ${T.caseEvidence}
                (case_code, kind, url, store_channel_id, store_message_id, source_message_url, excerpt, note, added_by, added_by_username)
             SELECT $1::varchar, $2::varchar, $3::text, $4::varchar, $5::varchar, $6::text, $7::text, $8::text, $9::varchar, $10::varchar
             WHERE (SELECT COUNT(*) FROM ${T.caseEvidence} WHERE case_code = $1::varchar) < $11::int
             RETURNING *`,
            [
                caseCode, kind, url, storeChannelId, storeMessageId, sourceMessageUrl,
                excerpt == null ? null : truncate(String(excerpt), EXCERPT_MAX),
                note == null || note === '' ? null : truncate(String(note), NOTE_MAX),
                addedBy.id, truncate(String(addedBy.username || addedBy.id), 100),
                MAX_EVIDENCE_PER_CASE,
            ]
        ));
    } catch (error) {
        if (error?.code === '23503') throw userError(`No case with code \`${caseCode}\`.`);
        throw error;
    }
    if (!rows[0]) throw userError(`Case \`${caseCode}\` already has ${MAX_EVIDENCE_PER_CASE} pieces of evidence. Remove one first.`);
    return rows[0];
}

export async function listEvidence(caseCode) {
    const { rows } = await query(
        `SELECT * FROM ${T.caseEvidence} WHERE case_code = $1 ORDER BY added_at, id`,
        [caseCode]
    );
    return rows;
}

/** Deletes one row of this case; returns it, or null when there is none. */
export async function removeEvidence(caseCode, id) {
    const { rows } = await query(
        `DELETE FROM ${T.caseEvidence} WHERE case_code = $1 AND id = $2 RETURNING *`,
        [caseCode, id]
    );
    return rows[0] || null;
}

// ── Discord ────────────────────────────────────────────────────────────────

/** The message behind a link in `guild`, or null (other server, no access, deleted). */
export async function fetchLinkedMessage(guild, link) {
    if (!guild || !link || link.guildId !== guild.id) return null;
    try {
        const channel = guild.channels.cache.get(link.channelId) || await guild.channels.fetch(link.channelId);
        if (!channel?.messages) return null;
        return await channel.messages.fetch(link.messageId);
    } catch {
        return null;
    }
}

/**
 * Resolves typed links into evidence entries { url, sourceMessageUrl, excerpt }.
 * Messages in `guild` are fetched for an excerpt; `prefetched` (url → excerpt)
 * skips the fetch for a message already in hand (the right-clicked one).
 */
export async function captureLinks(guild, entries, { prefetched = new Map() } = {}) {
    return Promise.all(entries.map(async ({ url, message }) => {
        if (!message) return { url, sourceMessageUrl: null, excerpt: null };
        if (prefetched.has(url)) return { url, sourceMessageUrl: url, excerpt: prefetched.get(url) };
        const fetched = await fetchLinkedMessage(guild, message);
        return { url, sourceMessageUrl: url, excerpt: fetched ? messageExcerpt(fetched) : null };
    }));
}

async function evidenceChannel(client) {
    const channelId = enforcementConfig.evidenceChannelId || enforcementConfig.modLogChannelId;
    if (!channelId) return null;
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    const channel = guild && (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null));
    return channel?.isTextBased?.() ? channel : null;
}

/**
 * Re-hosts an image attachment in the evidence channel and records it.
 * Returns the evidence row. The stored message is removed again if the insert fails.
 */
export async function addImageEvidence(client, caseCode, attachment, { note = null, addedBy }) {
    if (!String(attachment?.contentType || '').startsWith('image/')) {
        throw userError('The attachment must be an image (PNG, JPG, GIF, WebP).');
    }
    const channel = await evidenceChannel(client);
    if (!channel) {
        throw userError('No evidence channel is set up (EVIDENCE_CHANNEL_ID or MOD_LOG_CHANNEL_ID), so the image cannot be stored.');
    }

    let stored;
    try {
        stored = await channel.send({
            content: truncate(`Evidence for case \`${caseCode}\`, added by ${addedBy.username} (\`${addedBy.id}\`)${note ? `: ${note}` : ''}`, 2000),
            files: [{ attachment: attachment.url, name: attachment.name || 'evidence.png' }],
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        throw createError(`Evidence upload failed: ${error.message}`, ErrorTypes.DISCORD_API,
            `I could not store the image in <#${channel.id}>: ${error.message}`, { expected: true });
    }

    try {
        return await addEvidence(caseCode, {
            kind: 'image',
            url: stored.attachments.first()?.url || attachment.url,
            storeChannelId: channel.id,
            storeMessageId: stored.id,
            note,
            addedBy,
        });
    } catch (error) {
        await stored.delete().catch(() => {});
        throw error;
    }
}

/** Map row id → current attachment URL for image rows whose stored message still exists. */
export async function resolveImageUrls(client, rows) {
    const urls = new Map();
    if (!client) return urls;
    await Promise.all(rows.filter((row) => row.kind === 'image' && row.store_channel_id && row.store_message_id).map(async (row) => {
        try {
            const channel = client.channels.cache.get(row.store_channel_id) || await client.channels.fetch(row.store_channel_id);
            const message = await channel?.messages?.fetch(row.store_message_id);
            const url = message?.attachments?.first()?.url;
            if (url) urls.set(String(row.id), url);
        } catch (error) {
            logger.debug?.(`Evidence image ${row.id} could not be fetched: ${error.message}`);
        }
    }));
    return urls;
}

/**
 * Evidence for a case as one embed field plus the first image's fresh URL (for
 * embed.image). Returns { field: null } when the case has no evidence.
 */
export async function evidenceDisplay(client, caseCode, { max = 1024, excerptMax = 160 } = {}) {
    const rows = await listEvidence(caseCode);
    if (rows.length === 0) return { field: null, imageUrl: null, rows };
    const fresh = await resolveImageUrls(client, rows);
    const firstImage = rows.find((row) => row.kind === 'image' && fresh.has(String(row.id)));
    return {
        field: { name: `Evidence (${rows.length})`, value: fitLines(evidenceLines(rows, fresh, { excerptMax }), max) },
        imageUrl: firstImage ? fresh.get(String(firstImage.id)) : null,
        rows,
    };
}
