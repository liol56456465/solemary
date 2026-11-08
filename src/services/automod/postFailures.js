// postFailures.js — staff posts (mod log lines, alerts) that Mewvo could not make, kept in
// memory so the dashboard Overview can say "Mewvo couldn't post to #mod-log: missing Send
// Messages (3 times today)" instead of the post silently not happening.
//
// In memory only (no table): bounded per server (MAX_ENTRIES keys each, the oldest dropped first)
// and to MAX_GUILDS servers (the server that failed least recently dropped first), so a busy or
// broken server can never push another server's entries out. Counted per UTC day. A restart
// forgets them; the next failed post records it again.
// A successful post to a purpose clears that purpose's entries (the problem is fixed).

import { PermissionFlagsBits } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';

/** Per server. */
export const MAX_ENTRIES = 50;
/** Servers with entries; the one that failed least recently is dropped first. */
export const MAX_GUILDS = 200;

// Discord API error codes: 50001 Missing Access, 50013 Missing Permissions.
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

const byGuild = new Map(); // guildId → Map(`${purpose}:${reason}:${channelId}` → entry)

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Records one failed (or impossible) staff post.
 *   reason  'notSet'  no channel is configured for this purpose
 *           'missing' the channel is gone or is not a text channel
 *           'perms'   Discord refused: `missing` lists the permission names Mewvo lacks there
 *           'other'   any other refusal
 */
export function recordPostFailure({ guildId, purpose, channelId = null, channelName = null, reason, missing = [], now = Date.now() }) {
    if (!guildId || !purpose || !reason) return;
    const gid = String(guildId);
    const key = `${purpose}:${reason}:${channelId || ''}`;
    const day = utcDay(now);
    const entries = byGuild.get(gid) || new Map();
    byGuild.delete(gid); // re-insert: both Maps' order is "least recently failed first"
    byGuild.set(gid, entries);
    const old = entries.get(key);
    entries.delete(key);
    const count = old && old.day === day ? old.count + 1 : 1;
    entries.set(key, {
        guildId: gid, purpose: String(purpose), reason: String(reason),
        channelId: channelId ? String(channelId) : null,
        channelName: channelName ? String(channelName).slice(0, 100) : old?.channelName || null,
        missing: [...new Set(missing.map(String))].slice(0, 10), day, count, lastAt: now,
    });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    // The main server (where the home pair's staff posts go) is never the one dropped.
    while (byGuild.size > MAX_GUILDS) {
        const oldest = [...byGuild.keys()].find((id) => id !== enforcementConfig.mainGuildId);
        byGuild.delete(oldest);
    }
}

/** A post for this purpose worked: forget its failures (the channel is fine now). */
export function clearPostFailures(guildId, purpose) {
    const entries = byGuild.get(String(guildId));
    if (!entries) return;
    for (const [key, entry] of entries) {
        if (entry.purpose === purpose) entries.delete(key);
    }
    if (!entries.size) byGuild.delete(String(guildId));
}

/** Today's (UTC) failures of a guild, newest first: [{ purpose, reason, channelId, channelName, missing, count, lastAt }]. */
export function listPostFailures(guildId, now = Date.now()) {
    const day = utcDay(now);
    return [...(byGuild.get(String(guildId))?.values() || [])]
        .filter((e) => e.day === day)
        .sort((a, b) => b.lastAt - a.lastAt)
        .map((e) => ({ ...e, missing: [...e.missing] }));
}

/** Tests only. */
export function resetPostFailures() {
    byGuild.clear();
}

/** Tests only: { guilds, entries }. */
export function postFailureSizes() {
    let total = 0;
    for (const entries of byGuild.values()) total += entries.size;
    return { guilds: byGuild.size, entries: total };
}

/** The permission names Mewvo lacks in `channel` for a post (with files: Attach Files too). */
export function missingPostPermissions(channel, me, { files = false } = {}) {
    const needed = ['ViewChannel', 'SendMessages', 'EmbedLinks', ...(files ? ['AttachFiles'] : [])];
    let granted = null;
    try {
        granted = typeof channel?.permissionsFor === 'function' && me ? channel.permissionsFor(me) : null;
    } catch {
        granted = null;
    }
    if (!granted?.has) return [];
    return needed.filter((name) => !granted.has(PermissionFlagsBits[name]));
}

/** Records a failed channel.send(): permissions when Discord says so, else 'other'. */
export function recordSendError({ guildId, purpose, channel, error, files = false, now = Date.now() }) {
    const code = Number(error?.code);
    const permissionError = code === MISSING_PERMISSIONS || code === MISSING_ACCESS;
    const missing = permissionError ? missingPostPermissions(channel, channel?.guild?.members?.me, { files }) : [];
    recordPostFailure({
        guildId, purpose, channelId: channel?.id || null, channelName: channel?.name || null,
        reason: permissionError ? 'perms' : 'other',
        // Missing Access with nothing visibly missing: Mewvo cannot see the channel.
        missing: permissionError && !missing.length && code === MISSING_ACCESS ? ['ViewChannel'] : missing,
        now,
    });
}
