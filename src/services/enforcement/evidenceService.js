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

import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { query, T } from './db.js';
import { isHomeGuild, resolveSetting } from '../settings/guildSettings.js';
import { staffGuildId } from '../automod/channelRouting.js';
import { dateStamp, fitWholeLines, truncate } from './format.js';
import { botText } from '../../utils/botText.js';

export const EXCERPT_MAX = 500;
export const NOTE_MAX = 300;
export const MAX_EVIDENCE_PER_CASE = 25;
/** How many links one panel form may attach (each one is a message fetch). */
export const MAX_LINKS_PER_FORM = 5;

const KINDS = new Set(['link', 'image']);
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const MESSAGE_LINK_RE = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})(?:[/?#].*)?$/i;

// `i18n` ({ code, params }): /case shows the error in the reader's language (commands/Enforcement/case.js).
function userError(message, i18n = null) {
    const error = createError(message, ErrorTypes.VALIDATION, message, { expected: true });
    if (i18n) error.i18n = i18n;
    return error;
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

/** A message link, or null when the server is unknown (never guessed as the main server). */
function jumpLink(channelId, messageId, guildId) {
    return guildId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : null;
}

function quote(text, max) {
    return `"${truncate(String(text).replace(/\s+/g, ' '), max)}"`;
}

/**
 * Display lines for evidence rows. `freshUrls` maps row id → a current attachment
 * URL for images (see resolveImageUrls); without one the stored message is linked.
 */
export function evidenceLines(rows, freshUrls = new Map(), { excerptMax = 160, guildIdOf = () => null, caseGuildId = null, lang = 'en' } = {}) {
    // `lang`: the bot's words (English default, unchanged for the dashboard and the appeal dossier).
    const tr = lang === 'en' ? null : botText(lang);
    return rows.map((row) => {
        // The stored copy is in the evidence channel of the case's staff server (staffGuildId);
        // the channel's own guild wins when it is cached. Neither known: no link (never the main server).
        const storeGuildOf = (channelId) => {
            const caseGuild = row.case_guild_id || caseGuildId;
            return guildIdOf(channelId) || (caseGuild ? staffGuildId(caseGuild) : null);
        };
        const meta = `${row.added_by_username}, ${dateStamp(row.added_at)}`;
        const note = row.note ? `: ${truncate(row.note, 120)}` : '';
        if (row.kind === 'image') {
            const fresh = freshUrls.get(String(row.id));
            const stored = row.store_channel_id && row.store_message_id ? jumpLink(row.store_channel_id, row.store_message_id, storeGuildOf(row.store_channel_id)) : null;
            if (tr) {
                const links = [fresh ? `[${tr.t('staff.case.evidence.imageLink')}](${fresh})` : null, stored ? `[${tr.t('staff.case.evidence.storedLink')}](${stored})` : null].filter(Boolean);
                return `**#${row.id}** ${tr.t('staff.case.evidence.image', { links: links.join(' · ') || tr.t('staff.case.evidence.storedMissing') })}${note} · ${meta}`;
            }
            const links = [fresh ? `[image](${fresh})` : null, stored ? `[stored](${stored})` : null].filter(Boolean);
            return `**#${row.id}** Image: ${links.join(' · ') || 'image (stored message missing)'}${note} · ${meta}`;
        }
        const excerpt = row.excerpt ? ` ${quote(row.excerpt, excerptMax)}` : '';
        return `**#${row.id}** ${row.url}${excerpt}${note} · ${meta}`;
    });
}

/** Joins lines into one embed field value (≤ max), noting how many were left out. */
export function fitLines(lines, max = 1024) {
    return fitWholeLines(lines.map((line) => truncate(line, 400)), max);
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
        if (error?.code === '23503') throw userError(`No case with code \`${caseCode}\`.`, { code: 'noCaseAnywhere', params: { code: caseCode } });
        throw error;
    }
    if (!rows[0]) throw userError(`Case \`${caseCode}\` already has ${MAX_EVIDENCE_PER_CASE} pieces of evidence. Remove one first.`, { code: 'evidenceFull', params: { code: caseCode, max: MAX_EVIDENCE_PER_CASE } });
    return rows[0];
}

export async function listEvidence(caseCode) {
    const { rows } = await query(
        // case_guild_id: for the stored-image link (evidenceLines), the case's own server.
        `SELECT e.*, c.guild_id AS case_guild_id FROM ${T.caseEvidence} e
         JOIN ${T.cases} c ON c.case_code = e.case_code
         WHERE e.case_code = $1 ORDER BY e.added_at, e.id`,
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

/**
 * The case server's evidence channel (else its mod log); null when it has none or it is gone.
 * Home cases (main or support server) use the main server's channel, as channelRouting does.
 */
async function evidenceChannel(client, caseGuildId) {
    const guildId = staffGuildId(caseGuildId);
    const channelId = resolveSetting(guildId, 'evidenceChannelId') || resolveSetting(guildId, 'modLogChannelId');
    if (!channelId) return null;
    const guild = client.guilds.cache.get(guildId);
    const channel = guild && (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null));
    return channel?.isTextBased?.() ? channel : null;
}

/**
 * Re-hosts an image attachment in the evidence channel of the case's server (`guildId`) and
 * records it. Returns the evidence row. The stored message is removed again if the insert fails.
 */
export async function addImageEvidence(client, caseCode, attachment, { note = null, addedBy, guildId }) {
    if (!String(attachment?.contentType || '').startsWith('image/')) {
        throw userError('The attachment must be an image (PNG, JPG, GIF, WebP).', { code: 'notImage', params: {} });
    }
    if (!guildId) throw new TypeError('addImageEvidence needs the guildId of the case');
    const channel = await evidenceChannel(client, guildId);
    if (!channel) {
        throw isHomeGuild(guildId)
            ? userError('No evidence channel is set up (EVIDENCE_CHANNEL_ID or MOD_LOG_CHANNEL_ID), so the image cannot be stored.', { code: 'noEvidenceChannelHome', params: {} })
            : userError('Evidence images are not set up in this server: set an evidence or mod log channel in the dashboard first, then add the image again.', { code: 'noEvidenceChannel', params: {} });
    }

    let stored;
    try {
        stored = await channel.send({
            content: truncate(`Evidence for case \`${caseCode}\`, added by ${addedBy.username} (\`${addedBy.id}\`)${note ? `: ${note}` : ''}`, 2000),
            // A Discord attachment (url) or, from the web dashboard, the checked image bytes (data).
            files: [{ attachment: attachment.data ?? attachment.url, name: attachment.name || 'evidence.png' }],
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        throw createError(`Evidence upload failed: ${error.message}`, ErrorTypes.DISCORD_API,
            `I could not store the image in <#${channel.id}>: ${error.message}`, { expected: true });
    }

    try {
        return await addEvidence(caseCode, {
            kind: 'image',
            url: stored.attachments?.first?.()?.url || attachment.url || null,
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
export async function evidenceDisplay(client, caseCode, { max = 1024, excerptMax = 160, lang = 'en' } = {}) {
    const rows = await listEvidence(caseCode);
    if (rows.length === 0) return { field: null, imageUrl: null, rows };
    const fresh = await resolveImageUrls(client, rows);
    const firstImage = rows.find((row) => row.kind === 'image' && fresh.has(String(row.id)));
    return {
        field: { name: lang === 'en' ? `Evidence (${rows.length})` : botText(lang).t('staff.case.evidence.fieldName', { count: rows.length }), value: fitLines(evidenceLines(rows, fresh, {
            excerptMax,
            lang,
            // The stored image's link names the server its channel is in (another server's case is re-hosted there).
            guildIdOf: (channelId) => client?.channels?.cache?.get?.(channelId)?.guildId || null,
        }), max) },
        imageUrl: firstImage ? fresh.get(String(firstImage.id)) : null,
        rows,
    };
}
