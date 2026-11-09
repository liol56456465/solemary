// channelLock.js — /lock and /unlock (and the dashboard's Channel tools lock/unlock).
//
// Locking a channel denies Send Messages on the channel's own permission overwrites for:
//   - @everyone (as before), and
//   - every role that has its OWN allow for Send Messages on that channel (audit 3.8): a role
//     overwrite allow beats the @everyone deny, so without this those members kept talking.
//     Staff roles (Administrator, Manage Channels, Manage Messages, Moderate/Kick/Ban Members)
//     and bot-managed roles keep their allow, so moderators can still talk in a locked channel.
// Member overwrites are not touched.
//
// What was changed is stored BEFORE anything changes in Discord (key-value store temp_data, key
// channel_lock:<guildId>:<channelId>; no schema change): for each overwrite its Send Messages
// state before the lock (allow true / unset null). Unlock puts exactly those states back, and only
// on overwrites that still deny Send Messages (what the lock set); one someone changed since is
// left alone (counted as `skipped`). No stored record (a lock from before this change, or done by
// hand): unlock clears the @everyone deny, as before.
//
// Optional `durationMs`: the record keeps unlockAt; runChannelLockExpiry (cron once a minute and
// at startup, app.js) unlocks due channels, so a restart still unlocks them. A failed auto-unlock
// is retried (next try in 10 minutes, 5 tries), then dropped with a warning.
//
// The store is injectable (createMemoryLockStore for tests); the default writes Postgres and
// throws when the database does not answer, so nothing changes in Discord without a record.

import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';

export const LOCK_KEY_PREFIX = 'channel_lock:';
export const LOCK_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const LOCK_MIN_MS = 60 * 1000;
export const LOCK_RETRY_MS = 10 * 60 * 1000;
export const LOCK_MAX_ATTEMPTS = 5;
const EXPIRY_BATCH = 25;
const SEND = PermissionFlagsBits.SendMessages;

/** Roles that keep their own Send Messages allow when a channel is locked. */
const STAFF_BITS = [
    PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers,
];

export const lockKey = (guildId, channelId) => `${LOCK_KEY_PREFIX}${guildId}:${channelId}`;

/** A refusal with a `code` the commands translate and an English `userMessage` (dashboard). */
export function lockError(code, message, type = 'validation', params = {}) {
    return Object.assign(new Error(message), { code, type, userMessage: message, params });
}

/** Send Messages on one overwrite: true (allowed), false (denied), null (not set / no overwrite). */
export function sendState(overwrite) {
    if (!overwrite) return null;
    if (overwrite.allow?.has?.(SEND)) return true;
    if (overwrite.deny?.has?.(SEND)) return false;
    return null;
}

function overwriteOf(channel, id) {
    return channel?.permissionOverwrites?.cache?.get?.(id) || null;
}

function overwriteList(channel) {
    const cache = channel?.permissionOverwrites?.cache;
    return cache?.values ? [...cache.values()] : [];
}

/** True for a role that keeps its allow (staff, bot-managed). Unknown roles are not kept. */
export function isKeptRole(role) {
    if (!role) return false;
    if (role.managed) return true;
    const perms = role.permissions;
    return Boolean(perms?.any ? perms.any(STAFF_BITS) : STAFF_BITS.some((bit) => perms?.has?.(bit)));
}

function everyoneCanSend(guild, channel) {
    const everyone = guild.roles?.everyone || guild.roles?.cache?.get?.(guild.id) || guild.id;
    const perms = channel.permissionsFor?.(everyone);
    return perms ? perms.has(SEND) !== false : true;
}

/**
 * Pure: what /lock would change in `channel`.
 * { alreadyLocked, changes: [{ id, kind: 'everyone'|'role', prev }], kept: [roleId] }
 * alreadyLocked: @everyone cannot send there already (nothing is planned then).
 */
export function planLock(guild, channel) {
    if (!everyoneCanSend(guild, channel)) return { alreadyLocked: true, changes: [], kept: [] };
    const changes = [{ id: guild.id, kind: 'everyone', prev: sendState(overwriteOf(channel, guild.id)) }];
    const kept = [];
    for (const overwrite of overwriteList(channel)) {
        if (!overwrite || overwrite.id === guild.id) continue;
        if (overwrite.type !== undefined && overwrite.type !== OverwriteType.Role) continue;
        if (sendState(overwrite) !== true) continue;
        const role = guild.roles?.cache?.get?.(overwrite.id) || null;
        if (!role) continue;
        if (isKeptRole(role)) { kept.push(role.id); continue; }
        changes.push({ id: role.id, kind: 'role', prev: true });
    }
    return { alreadyLocked: false, changes, kept };
}

/**
 * Merges a new lock's changes with a stored record of the same channel (a lock whose @everyone
 * deny was lifted by hand: its role denies are still ours to restore). New entries win.
 */
export function mergeChanges(previous, next) {
    const ids = new Set(next.map((c) => c.id));
    return [...next, ...(Array.isArray(previous) ? previous.filter((c) => c && !ids.has(c.id)) : [])];
}

async function editSend(channel, id, value, reason) {
    await channel.permissionOverwrites.edit(id, { SendMessages: value }, { type: OverwriteType.Role, reason });
}

/**
 * Locks `channel`. Stores the record first, then applies the changes; when Discord refuses one,
 * the applied ones are undone, the record removed, and it throws (code 'partial').
 * Returns { record, changed: [roleIds of roles locked], kept: [roleIds], unlockAt }.
 */
export async function lockChannelWithState({ guild, channel, moderatorId, durationMs = null, auditReason, store = defaultLockStore(), now = Date.now() }) {
    if (durationMs != null && (!Number.isFinite(durationMs) || durationMs < LOCK_MIN_MS || durationMs > LOCK_MAX_MS)) {
        throw lockError('badDuration', 'That duration is not valid: use 1 minute to 30 days.');
    }
    const plan = planLock(guild, channel);
    if (plan.alreadyLocked) throw lockError('alreadyLocked', `#${channel.name} is already locked.`);
    let previous = null;
    try {
        previous = await store.get(guild.id, channel.id);
    } catch (error) {
        throw lockError('dbDown', 'The database is not responding, so the channel was not locked. Nothing was changed.', 'database', { cause: error.message });
    }
    const record = {
        v: 1, guildId: guild.id, channelId: channel.id, lockedBy: moderatorId ? String(moderatorId) : null,
        lockedAt: new Date(now).toISOString(), unlockAt: durationMs ? new Date(now + durationMs).toISOString() : null,
        changes: mergeChanges(previous?.changes, plan.changes), attempts: 0,
    };
    try {
        await store.save(record);
    } catch (error) {
        throw lockError('dbDown', 'The database is not responding, so the channel was not locked. Nothing was changed.', 'database', { cause: error.message });
    }
    const applied = [];
    try {
        for (const change of plan.changes) {
            await editSend(channel, change.id, false, auditReason);
            applied.push(change);
        }
    } catch (error) {
        for (const change of applied.reverse()) {
            await editSend(channel, change.id, change.prev, 'Lock undone: Discord refused part of it').catch(() => {});
        }
        if (previous) await store.save(previous).catch(() => {});
        else await store.remove(guild.id, channel.id).catch(() => {});
        logger.warn(`Lock of ${channel.id} in ${guild.id} undone: ${error.message}`);
        throw lockError('partial', `Discord refused part of the lock in #${channel.name}, so it was undone. Check Mewvo's Manage Channels and Manage Permissions there.`, 'permission');
    }
    return {
        record,
        changed: plan.changes.filter((c) => c.kind === 'role').map((c) => c.id),
        kept: plan.kept,
        unlockAt: record.unlockAt,
    };
}

/**
 * Pure: what unlocking with `record` would do in `channel`. A change is restored only while its
 * overwrite still denies Send Messages (what the lock set). { restore: [change], skipped: [change] }
 */
export function planUnlock(channel, record) {
    const restore = [];
    const skipped = [];
    for (const change of Array.isArray(record?.changes) ? record.changes : []) {
        if (!change?.id) continue;
        if (sendState(overwriteOf(channel, change.id)) === false) restore.push(change);
        else skipped.push(change);
    }
    return { restore, skipped };
}

/**
 * Unlocks `channel`: the stored record exactly, else (no record) the @everyone deny is cleared
 * as before. Throws code 'notLocked' / 'notOverwrite' / 'dbDown'. The record is removed after
 * the changes went through (a failed edit keeps it, so it can be tried again).
 * Returns { restored: [ids], skipped: [ids], legacy: boolean }.
 */
export async function unlockChannelWithState({ guild, channel, auditReason, store = defaultLockStore() }) {
    let record;
    try {
        record = await store.get(guild.id, channel.id);
    } catch (error) {
        throw lockError('dbDown', 'The database is not responding, so the channel was not unlocked. Nothing was changed.', 'database', { cause: error.message });
    }
    if (record) {
        const { restore, skipped } = planUnlock(channel, record);
        let done = 0;
        try {
            for (const change of restore) {
                await editSend(channel, change.id, change.prev ?? null, auditReason);
                done += 1;
            }
        } catch (error) {
            // The record stays: a second /unlock skips what is already back and does the rest.
            logger.warn(`Unlock of ${channel.id} in ${guild.id} stopped after ${done} of ${restore.length}: ${error.message}`);
            throw lockError('partialUnlock', `Discord refused part of the unlock in #${channel.name} (${done} of ${restore.length} done). Check Mewvo's Manage Channels and Manage Permissions there, then run unlock again.`,
                'permission', { done, total: restore.length });
        }
        // Discord is unlocked now; a record that cannot be cleared must not turn that into "failed".
        const recordKept = await store.remove(guild.id, channel.id).then(() => false, (error) => {
            logger.warn(`Unlocked ${channel.id} in ${guild.id}, but its lock record could not be cleared: ${error.message}`);
            return true;
        });
        if (!restore.length) {
            // Nothing of ours was left; the stale record is gone now.
            if (everyoneCanSend(guild, channel)) throw lockError('notLocked', `#${channel.name} is not locked (everyone can already send messages).`);
            throw lockError('notOverwrite', `#${channel.name} is not locked by a channel overwrite: Send Messages is denied by its category or the @everyone role, so unlocking here would change nothing.`);
        }
        return { restored: restore.map((c) => c.id), skipped: skipped.map((c) => c.id), legacy: false, recordKept };
    }
    if (sendState(overwriteOf(channel, guild.id)) !== false) {
        throw everyoneCanSend(guild, channel)
            ? lockError('notLocked', `#${channel.name} is not locked (everyone can already send messages).`)
            : lockError('notOverwrite', `#${channel.name} is not locked by a channel overwrite: Send Messages is denied by its category or the @everyone role, so unlocking here would change nothing.`);
    }
    await editSend(channel, guild.id, null, auditReason);
    return { restored: [guild.id], skipped: [], legacy: true };
}

/**
 * The auto-unlock job (cron once a minute and at startup). For each due record: the server or
 * channel is gone → the record is dropped; else the channel is unlocked (planUnlock) and
 * `onUnlocked(guild, channel, result)` is called (notice + log). A failure is retried later.
 * Returns the number of records handled. `store`, `onUnlocked`, `now` injectable.
 */
export async function runChannelLockExpiry(client, { store = defaultLockStore(), onUnlocked = null, now = Date.now() } = {}) {
    const due = await store.due(new Date(now), EXPIRY_BATCH);
    let handled = 0;
    for (const record of due) {
        handled += 1;
        const guild = client?.guilds?.cache?.get?.(record.guildId) || null;
        // An outage (unavailable guild) is not "gone": try again next minute, nothing dropped.
        if (guild && guild.available === false) continue;
        let channel = null;
        try {
            // Only Unknown Channel (10003) means the channel is gone; any other error is retried.
            channel = guild ? (guild.channels?.cache?.get?.(record.channelId)
                || await guild.channels?.fetch?.(record.channelId).catch((error) => (error?.code === 10003 ? null : Promise.reject(error)))) : null;
        } catch (error) {
            await retryLater(store, record, now, `${record.channelId} in ${record.guildId}`, error);
            continue;
        }
        if (!guild || !channel) {
            await store.remove(record.guildId, record.channelId);
            logger.info(`Auto-unlock: ${record.channelId} in ${record.guildId} is gone; lock record dropped`);
            continue;
        }
        try {
            const { restore, skipped } = planUnlock(channel, record);
            for (const change of restore) {
                await editSend(channel, change.id, change.prev ?? null, 'Lock time over (auto-unlock)');
            }
            // Unlocked in Discord: a record that cannot be cleared is only logged (a later run finds
            // nothing still denied by us and drops it), never retried as a failed unlock.
            await store.remove(record.guildId, record.channelId).catch((error) => logger.warn(`Auto-unlock: record of ${channel.id} not cleared: ${error.message}`));
            if (onUnlocked) await Promise.resolve(onUnlocked(guild, channel, { restored: restore.map((c) => c.id), skipped: skipped.map((c) => c.id), record })).catch((error) => {
                logger.warn(`Auto-unlock notice for ${channel.id} failed: ${error.message}`);
            });
        } catch (error) {
            await retryLater(store, record, now, `${channel.id} in ${guild.id}`, error);
        }
    }
    return handled;
}

/** A failed auto-unlock: next try in 10 minutes; after LOCK_MAX_ATTEMPTS tries the record is dropped (logged). */
async function retryLater(store, record, now, label, error) {
    const attempts = (Number(record.attempts) || 0) + 1;
    if (attempts >= LOCK_MAX_ATTEMPTS) {
        await store.remove(record.guildId, record.channelId).catch(() => {});
        logger.warn(`Auto-unlock of ${label} gave up after ${attempts} tries: ${error.message}`);
    } else {
        await store.save({ ...record, attempts, unlockAt: new Date(now + LOCK_RETRY_MS).toISOString() }).catch(() => {});
        logger.warn(`Auto-unlock of ${label} failed (try ${attempts}): ${error.message}`);
    }
}

/**
 * After an auto-unlock: a notice in the channel (the server's language, no pings) and the mod
 * log entry. Either may fail on its own (no Send Messages, no log channel); the unlock stands.
 */
export async function announceAutoUnlock(guild, channel, result, { log = null, text = null } = {}) {
    const tr = text || (await import('../../utils/botText.js')).textForGuild(guild.id, { purpose: 'public' });
    await channel.send?.({ content: tr.t('moderation.unlock.autoDone', { channel: String(channel) }), allowedMentions: { parse: [] } })
        .catch((error) => logger.debug(`Auto-unlock notice not posted in ${channel.id}: ${error.message}`));
    const logFn = log || (await import('../../utils/moderation.js')).logEvent;
    await logFn({
        client: guild.client,
        guild,
        event: {
            action: 'Channel Unlocked',
            target: channel.toString(),
            executor: `Mewvo (${guild.client?.user?.id || 'bot'})`,
            reason: tr.t('moderation.unlock.autoReason'),
            metadata: { channelId: channel.id, category: channel.parent?.name || 'None', lockedBy: result?.record?.lockedBy || undefined, via: 'auto-unlock' },
        },
    });
}

// ── Stores ────────────────────────────────────────────────────────────────

/** In-memory store (tests). */
export function createMemoryLockStore(initial = []) {
    const rows = new Map(initial.map((r) => [lockKey(r.guildId, r.channelId), structuredClone(r)]));
    return {
        rows,
        async get(guildId, channelId) { const r = rows.get(lockKey(guildId, channelId)); return r ? structuredClone(r) : null; },
        async save(record) { rows.set(lockKey(record.guildId, record.channelId), structuredClone(record)); },
        async remove(guildId, channelId) { rows.delete(lockKey(guildId, channelId)); },
        async due(now, limit) {
            return [...rows.values()].filter((r) => r.unlockAt && new Date(r.unlockAt) <= now)
                .sort((a, b) => String(a.unlockAt).localeCompare(String(b.unlockAt))).slice(0, limit).map((r) => structuredClone(r));
        },
    };
}

/** Postgres store on temp_data. `query` injectable; the default is enforcement/db.js (throws when down). */
export function createDbLockStore({ query = null, table = pgConfig.tables.temp_data } = {}) {
    const run = async (text, params) => {
        const fn = query || (await import('../enforcement/db.js')).query;
        return fn(text, params);
    };
    // Kept a week past the unlock time (retention prunes expired rows); open-ended locks never expire.
    const expiresOf = (record) => (record.unlockAt ? new Date(new Date(record.unlockAt).getTime() + 7 * 86_400_000) : null);
    return {
        async get(guildId, channelId) {
            const { rows } = await run(`SELECT value FROM ${table} WHERE key = $1`, [lockKey(guildId, channelId)]);
            return rows[0]?.value || null;
        },
        async save(record) {
            await run(
                `INSERT INTO ${table} (key, value, expires_at) VALUES ($1, $2::jsonb, $3)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
                [lockKey(record.guildId, record.channelId), JSON.stringify(record), expiresOf(record)]);
        },
        async remove(guildId, channelId) {
            await run(`DELETE FROM ${table} WHERE key = $1`, [lockKey(guildId, channelId)]);
        },
        async due(now, limit) {
            const { rows } = await run(
                `SELECT value FROM ${table}
                 WHERE key LIKE '${LOCK_KEY_PREFIX}%' AND value->>'unlockAt' IS NOT NULL AND (value->>'unlockAt')::timestamptz <= $1
                 ORDER BY (value->>'unlockAt')::timestamptz LIMIT ${Number(limit) || EXPIRY_BATCH}`, [now]);
            return rows.map((r) => r.value);
        },
    };
}

let defaultStore = null;
export function defaultLockStore() {
    if (!defaultStore) defaultStore = createDbLockStore();
    return defaultStore;
}
