// blacklistCache.js — the in-memory copy of the global bot blacklist (table bot_blacklist,
// blacklistService.js), read synchronously by the command gate and interactionCreate.
// No database import here, so the gate stays cheap to load and easy to test.
//
// OWNER_IDS are never blocked, whatever the cache says (and the service refuses to add them).

import { isBotOwner } from '../../config/bot.js';

export const BLACKLIST_MESSAGE = "You can't use this bot.";

let users = new Set();
let guilds = new Set();
let loaded = false;

/** Replaces the cache with the active entries: [{ kind: 'user' | 'guild', target_id }]. */
export function setBlacklistCache(entries = []) {
    const nextUsers = new Set();
    const nextGuilds = new Set();
    for (const entry of entries) {
        const id = String(entry?.target_id ?? entry?.targetId ?? '');
        if (!id) continue;
        if (entry.kind === 'user') nextUsers.add(id);
        else if (entry.kind === 'guild') nextGuilds.add(id);
    }
    users = nextUsers;
    guilds = nextGuilds;
    loaded = true;
}

export function addToBlacklistCache(kind, id) {
    if (kind === 'user') users.add(String(id));
    else if (kind === 'guild') guilds.add(String(id));
}

export function removeFromBlacklistCache(kind, id) {
    if (kind === 'user') users.delete(String(id));
    else if (kind === 'guild') guilds.delete(String(id));
}

export function isBlacklistLoaded() {
    return loaded;
}

/**
 * null when the user may use the bot here; otherwise { kind: 'user' | 'guild' }.
 * A blacklisted user gets a short message; a blacklisted server is ignored silently.
 */
export function blacklistHit({ userId, guildId = null } = {}) {
    if (userId && isBotOwner(userId)) return null;
    if (userId && users.has(String(userId))) return { kind: 'user' };
    if (guildId && guilds.has(String(guildId))) return { kind: 'guild' };
    return null;
}

export function blacklistSizes() {
    return { users: users.size, guilds: guilds.size };
}
