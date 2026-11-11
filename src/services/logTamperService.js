// logTamperService.js — a Mewvo log message deleted by someone else is posted again in the same
// channel ("Restored"), with who deleted it, and noted in the staff mod log.
//
// - Log channels: every Logging page channel, the old log channel, ticket logs/transcripts and the
//   staff channels (mod log, alerts, review, evidence).
// - Mewvo's own deletes: code that deletes its own messages calls markOwnDelete first (ignored);
//   /purge passes the moderator, so a purge in a log channel counts as theirs.
// - Who: the Discord audit log (needs View Audit Log). Discord merges repeated deletes by one person
//   in one channel into one entry and only raises its count, so each delete uses up one unit of the
//   count (consumed < count). Deletes in one channel are handled one at a time.
// - No audit entry while the log is readable: Mewvo deleted it (bots make no entry for their own).
//   An entry seen for the first time that is old but merged (count > 1, e.g. after a restart): noted
//   as "possibly", not restored. Audit log not readable: noted only, never restored (it might be ours).
// - Server owner / OWNER_IDS: not restored (they may clean up), only noted.
// - Content: only messages still in the bot's cache (about an hour) are posted again; files are
//   listed by name (Discord removes them with the message). At most RESTORE_LIMIT restores per
//   channel per RESTORE_WINDOW_MS; after that the mod log line only.
// Staff logs are in English, like the other log entries.

import { AuditLogEvent, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { resolveChannelId } from './automod/channelRouting.js';
import { resolveSetting } from './settings/guildSettings.js';
import { postModLog } from './enforcement/enforcementService.js';
import { botConfig } from '../config/bot.js';
import { logger } from '../utils/logger.js';

export const AUDIT_FRESH_MS = 20_000;
export const AUDIT_WAIT_MS = 1_500;
export const AUDIT_RETRY_MS = 2_000;
export const MAX_RESTORE_PER_EVENT = 5;
export const RESTORE_LIMIT = 10;
export const RESTORE_WINDOW_MS = 10 * 60_000;
const SEEN_MAX = 500;
const NOTICE_MAX = 1800;
const OWN_DELETE_TTL_MS = 60_000;

// Audit entry id → how many of its merged deletes we already used (bounded; oldest dropped first).
const seenEntries = new Map();
// Message id → { by, at }: deletes Mewvo is about to make (by = null) or makes for a moderator (/purge).
const ownDeletes = new Map();
// Channel id → restore times in the window.
const restoreTimes = new Map();
// Channel id → the running check (one at a time per channel).
const channelQueue = new Map();

/** Call before Mewvo deletes its own messages; `by` = the moderator it deletes for (purge), else null. */
export function markOwnDelete(messageIds, by = null, now = Date.now()) {
    for (const [id, mark] of ownDeletes) if (now - mark.at > OWN_DELETE_TTL_MS) ownDeletes.delete(id);
    for (const id of [messageIds].flat()) if (id) ownDeletes.set(String(id), { by, at: now });
}

function takeOwnDelete(id) {
    const mark = ownDeletes.get(id);
    if (!mark) return undefined;
    ownDeletes.delete(id);
    return Date.now() - mark.at <= OWN_DELETE_TTL_MS ? mark : undefined;
}

/** How many restores this channel may still post now (and records `used`). */
export function restoreBudget(channelId, wanted, now = Date.now(), times = restoreTimes) {
    const recent = (times.get(channelId) || []).filter((at) => now - at < RESTORE_WINDOW_MS);
    const allowed = Math.max(0, Math.min(wanted, RESTORE_LIMIT - recent.length));
    for (let i = 0; i < allowed; i += 1) recent.push(now);
    times.set(channelId, recent);
    if (times.size > SEEN_MAX) times.delete(times.keys().next().value);
    return allowed;
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Every channel id Mewvo posts logs in for this server (strings, no nulls). */
export function logChannelIds(config, guildId, { staffIds = staffChannelIds(guildId) } = {}) {
    const ids = [
        ...Object.values(config?.logging?.channels || {}),
        config?.logging?.channelId, config?.logChannelId,
        config?.ticketLogsChannelId, config?.ticketTranscriptChannelId,
        ...staffIds,
    ];
    return new Set(ids.filter((id) => typeof id === 'string' && id !== ''));
}

function staffChannelIds(guildId) {
    const ids = [];
    for (const purpose of ['modlog', 'alerts', 'review']) {
        try { ids.push(resolveChannelId(guildId, purpose)); } catch { /* settings not loaded: skip */ }
    }
    try { ids.push(resolveSetting(guildId, 'evidenceChannelId')); } catch { /* same */ }
    return ids;
}

/**
 * The audit entry for this delete: { entry, certain } or null. MessageDelete: target = the bot,
 * extra.channel = the channel. MessageBulkDelete: target = the channel. Each delete uses one unit
 * of the entry's count (`seen` keeps the units used).
 */
export function pickAuditEntry(entries, { type, botId, channelId, now = Date.now(), seen = seenEntries, unknownAuthor = false }) {
    // An uncached message might be a member's: while someone is also deleting members' messages in
    // this channel, it must not use up a unit meant for a Mewvo log.
    if (unknownAuthor && type === AuditLogEvent.MessageDelete && entries.some((e) => e.targetId !== botId
        && (e.extra?.channel?.id ?? e.extra?.channelId) === channelId && now - e.createdTimestamp <= AUDIT_FRESH_MS)) {
        return null;
    }
    for (const entry of entries) {
        const matches = type === AuditLogEvent.MessageBulkDelete
            ? entry.targetId === channelId
            : entry.targetId === botId && (entry.extra?.channel?.id ?? entry.extra?.channelId) === channelId;
        if (!matches) continue;
        const count = Number(entry.extra?.count ?? 1);
        const used = seen.get(entry.id);
        if (used === undefined) {
            if (now - entry.createdTimestamp <= AUDIT_FRESH_MS) {
                remember(seen, entry.id, 1);
                return { entry, certain: true };
            }
            // Old but merged: a later delete joined it (we may have restarted since). Count it as all used.
            remember(seen, entry.id, count);
            if (count > 1) return { entry, certain: false };
            continue;
        }
        if (used < count) {
            remember(seen, entry.id, used + 1);
            return { entry, certain: true };
        }
    }
    return null;
}

function remember(seen, id, count) {
    seen.delete(id);
    seen.set(id, count);
    while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
}

/** Who may delete logs without them coming back: the server owner and OWNER_IDS. */
export function isTrustedDeleter(guild, userId, owners = botConfig.commands?.owners ?? []) {
    return Boolean(userId) && (userId === guild?.ownerId || owners.includes(userId));
}

/** The message posted again: a notice line + the original content and embeds (when cached). */
export function buildRestorePayload(message, { executorId = null, deletedAt = Date.now() } = {}) {
    const who = executorId ? `<@${executorId}> (\`${executorId}\`)` : 'unknown (Mewvo cannot read the audit log)';
    const posted = message.createdTimestamp ? ` · originally posted <t:${Math.floor(message.createdTimestamp / 1000)}:F>` : '';
    const lines = [`♻️ **Restored log message** · deleted by ${who} <t:${Math.floor(deletedAt / 1000)}:R>${posted}`];
    const cached = !message.partial && message.author;
    if (!cached) {
        lines.push('-# The content is not available (posted before Mewvo last restarted).');
    } else if (message.content) {
        lines.push(message.content.split('\n').map((line) => `> ${line}`).join('\n'));
    }
    const files = cached ? [...(message.attachments?.values?.() || [])].map((a) => a.name).filter(Boolean) : [];
    if (files.length) lines.push(`-# Files (removed by Discord with the message): ${files.join(', ')}`);
    const embeds = cached ? message.embeds.slice(0, 10).map((embed) => EmbedBuilder.from(embed)) : [];
    return { content: truncate(lines.join('\n'), NOTICE_MAX), embeds, allowedMentions: { parse: [] } };
}

async function findExecutor(guild, type, channelId, { unknownAuthor = false } = {}) {
    const me = guild.members?.me;
    if (!me?.permissions?.has?.(PermissionFlagsBits.ViewAuditLog)) return { readable: false, found: null };
    // The audit entry can show up a moment after the delete event: look twice before calling it ours.
    for (const wait of [AUDIT_WAIT_MS, AUDIT_RETRY_MS]) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        const logs = await guild.fetchAuditLogs({ type, limit: 10 }).catch((error) => {
            logger.warn(`Log tamper: audit log fetch failed in ${guild.id}: ${error.message}`);
            return null;
        });
        if (!logs) return { readable: false, found: null };
        const found = pickAuditEntry([...logs.entries.values()], { type, botId: guild.client.user.id, channelId, unknownAuthor });
        if (found) return { readable: true, found };
    }
    return { readable: true, found: null };
}

/**
 * One or more deleted messages in one channel. `messages`: discord.js Message objects (cached or
 * partial). `bulk`: from messageDeleteBulk. Never throws (logged instead). One check per channel
 * at a time, so merged audit entries are counted in order.
 */
export function handleDeletedMessages(client, guild, channel, messages, { bulk = false } = {}) {
    if (!guild || !channel || !messages.length) return Promise.resolve();
    const before = channelQueue.get(channel.id) || Promise.resolve();
    const run = before.then(() => checkDeleted(client, guild, channel, messages, bulk)).catch((error) => {
        logger.warn(`Log tamper check failed: ${error.message}`);
    });
    channelQueue.set(channel.id, run);
    run.finally(() => { if (channelQueue.get(channel.id) === run) channelQueue.delete(channel.id); });
    return run;
}

async function checkDeleted(client, guild, channel, messages, bulk) {
    const botId = client.user?.id;
    // A cached message from anyone else is not a Mewvo log; partials may be ours.
    let ours = messages.filter((m) => m.partial || !m.author || m.author.id === botId);
    if (!ours.length) return;
    // Mewvo's own deletes are skipped; /purge ones count as the moderator's.
    let purgedBy = null;
    ours = ours.filter((m) => {
        const mark = takeOwnDelete(m.id);
        if (mark === undefined) return true;
        if (mark.by) purgedBy = mark.by;
        return Boolean(mark.by);
    });
    if (!ours.length) return;
    const config = await getGuildConfig(client, guild.id).catch(() => null);
    if (!config || !logChannelIds(config, guild.id).has(channel.id)) return;

    let executorId = purgedBy;
    let certain = Boolean(purgedBy);
    let readable = Boolean(purgedBy);
    if (!purgedBy) {
        const type = bulk ? AuditLogEvent.MessageBulkDelete : AuditLogEvent.MessageDelete;
        const unknownAuthor = !bulk && ours.every((m) => m.partial || !m.author);
        const result = await findExecutor(guild, type, channel.id, { unknownAuthor });
        readable = result.readable;
        // No entry while the log is readable: Mewvo removed its own message.
        if (readable && !result.found) return;
        executorId = result.found?.entry?.executorId ?? null;
        certain = Boolean(result.found?.certain);
        if (executorId && executorId === botId) return;
    }
    // Unknown deleter: only what we know was ours (cached, posted by Mewvo) is worth a note.
    const known = readable ? ours : ours.filter((m) => !m.partial && m.author?.id === botId);
    if (!known.length) return;

    const trusted = isTrustedDeleter(guild, executorId);
    const cached = known.filter((m) => !m.partial && m.author);
    let restored = 0;
    let note = '';
    if (!readable) note = 'Mewvo could not read the audit log, so nothing was restored';
    else if (!certain) note = 'possibly this person (an older merged audit entry), so nothing was restored';
    else if (trusted) note = 'server owner / bot owner, not restored';
    else {
        const sorted = [...cached].sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));
        const allowed = restoreBudget(channel.id, Math.min(sorted.length, MAX_RESTORE_PER_EVENT));
        for (const message of sorted.slice(0, allowed)) {
            const ok = await channel.send(buildRestorePayload(message, { executorId })).then(() => true, (error) => {
                logger.warn(`Log tamper: restore failed in ${guild.id}/${channel.id}: ${error.message}`);
                return false;
            });
            if (ok) restored += 1;
        }
        const skipped = [];
        if (known.length > cached.length) skipped.push(`${known.length - cached.length} older than Mewvo's memory`);
        if (cached.length > restored) skipped.push(`${cached.length - restored} over the restore limit or failed`);
        note = skipped.join(', ');
    }
    await postModLog(client, 'logDeleted', [
        { name: 'Channel', value: `<#${channel.id}>` },
        { name: purgedBy ? 'Deleted by (/purge)' : 'Deleted by', value: executorId ? `<@${executorId}> (${executorId})` : 'Unknown' },
        { name: 'Messages', value: `${known.length} deleted, ${restored} restored${note ? ` (${note})` : ''}` },
    ], { guildId: guild.id });
}
