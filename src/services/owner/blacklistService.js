// blacklistService.js — the global bot blacklist (Owner area of the dashboard): users or
// whole servers that may not use the bot. Table bot_blacklist; an entry is "active" until
// removed_at is set (undo keeps the row, so the list shows who added and who removed it).
// The gate reads the in-memory copy (blacklistCache.js), loaded on ready and kept in step
// with every change made here.
//
// Refused: OWNER_IDS (never blacklisted), the main and the support server.

import { isBotOwner } from '../../config/bot.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { pgConfig } from '../../config/database/postgres.js';
import { query as dbQuery, isUniqueViolation } from '../enforcement/db.js';
import { addToBlacklistCache, removeFromBlacklistCache, setBlacklistCache } from './blacklistCache.js';

export const BLACKLIST_KINDS = ['user', 'guild'];
export const BLACKLIST_REASON_MAX = 300;
const SNOWFLAKE = /^\d{17,20}$/;

export class BlacklistError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BlacklistError';
        this.userMessage = message;
        this.type = 'validation';
    }
}

/** Why this entry may not be added (a message), or null. Pure. */
export function blacklistProblem({ kind, targetId, reason }, {
    isOwner = isBotOwner, protectedGuildIds = [enforcementConfig.mainGuildId, enforcementConfig.supportGuildId],
} = {}) {
    if (!BLACKLIST_KINDS.includes(kind)) return 'Choose user or server.';
    if (!SNOWFLAKE.test(String(targetId || ''))) return 'Enter a Discord ID (17–20 digits).';
    if (!String(reason || '').trim()) return 'Give a reason.';
    if (String(reason).length > BLACKLIST_REASON_MAX) return `The reason is longer than ${BLACKLIST_REASON_MAX} characters.`;
    if (kind === 'user' && isOwner(targetId)) return 'Bot owners (OWNER_IDS) can never be blacklisted.';
    if (kind === 'guild' && protectedGuildIds.filter(Boolean).includes(String(targetId))) {
        return 'The main and the support server cannot be blacklisted.';
    }
    return null;
}

export function createBlacklistStore({ query = dbQuery, table = pgConfig.tables.bot_blacklist } = {}) {
    /** Reads every active entry into the gate's cache. Returns the count. */
    async function load() {
        const { rows } = await query(`SELECT kind, target_id FROM ${table} WHERE removed_at IS NULL`);
        setBlacklistCache(rows);
        return rows.length;
    }

    /** Active entries, newest first, plus the 20 most recently removed ones. */
    async function list() {
        const { rows: active } = await query(
            `SELECT * FROM ${table} WHERE removed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 500`);
        const { rows: removed } = await query(
            `SELECT * FROM ${table} WHERE removed_at IS NOT NULL ORDER BY removed_at DESC, id DESC LIMIT 20`);
        return { active, removed };
    }

    /** Adds an entry; throws BlacklistError for refused input or an existing active entry. */
    async function add({ kind, targetId, reason, actor }, options = {}) {
        const problem = blacklistProblem({ kind, targetId, reason }, options);
        if (problem) throw new BlacklistError(problem);
        try {
            const { rows: [row] } = await query(
                `INSERT INTO ${table} (kind, target_id, reason, added_by, added_by_username)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [kind, String(targetId), String(reason).trim().slice(0, BLACKLIST_REASON_MAX), String(actor.userId), String(actor.username || '').slice(0, 100) || null]);
            if (!row) throw new Error('blacklist insert returned no row');
            addToBlacklistCache(kind, targetId);
            return row;
        } catch (error) {
            if (isUniqueViolation(error, 'bot_blacklist')) throw new BlacklistError(`That ${kind === 'user' ? 'user' : 'server'} is already blacklisted.`);
            throw error;
        }
    }

    /** Undo: marks an active entry removed. Returns the row, or null when there was none. */
    async function remove(id, actor) {
        if (!/^\d{1,18}$/.test(String(id || ''))) return null;
        const { rows: [row] } = await query(
            `UPDATE ${table} SET removed_at = NOW(), removed_by = $2, removed_by_username = $3
             WHERE id = $1 AND removed_at IS NULL RETURNING *`,
            [String(id), String(actor.userId), String(actor.username || '').slice(0, 100) || null]);
        if (!row) return null;
        removeFromBlacklistCache(row.kind, row.target_id);
        return row;
    }

    return { load, list, add, remove };
}

export const blacklistStore = createBlacklistStore();
export const loadBlacklist = () => blacklistStore.load();

/**
 * Loads the blacklist, and if the database does not answer, keeps retrying in the background
 * (15 s, doubling up to 5 min) until it does, so a database hiccup at startup does not leave
 * blacklisted users and servers able to use the bot until the next restart.
 * Resolves with the count, or null when the first try failed (the retries go on).
 */
export async function loadBlacklistWithRetry({ load = loadBlacklist, log = () => {}, firstDelayMs = 15_000, maxDelayMs = 300_000, schedule = setTimeout } = {}) {
    try {
        return await load();
    } catch (error) {
        log(`Bot blacklist could not be loaded: ${error.message}; retrying in the background`);
        let delay = firstDelayMs;
        const retry = () => {
            load().then((count) => log(`Bot blacklist loaded on retry: ${count} active`)).catch((err) => {
                log(`Bot blacklist still not loaded: ${err.message}`);
                delay = Math.min(delay * 2, maxDelayMs);
                schedule(retry, delay)?.unref?.();
            });
        };
        schedule(retry, delay)?.unref?.();
        return null;
    }
}
