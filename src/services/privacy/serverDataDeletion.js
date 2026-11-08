// serverDataDeletion.js — "Delete this server's data" on request (owner decision 2026-11-07).
//
// A server's data is kept after Mewvo is removed, until the server's OWNER asks for it to be
// deleted (dashboard danger zone, /serverdata delete, or the dashboard after the bot was removed).
//
// Who: only the server's owner. In the server: guild.ownerId fetched fresh from Discord
// (liveGuildOwner). After the bot was removed: the `owner` flag of the user's own OAuth server list
// (GET /users/@me/guilds at dashboard login), read at most OAUTH_OWNER_FRESH_MS ago. Not admins,
// not OWNER_IDS. Mewvo's own servers (main + support) are refused entirely.
//
// Flow: preview (counts per kind, serverDataInventory.js) → Confirm → a request in the key-value
// store (temp_data key serverdata:deletion:<guildId>; no schema change) due GRACE_DAYS later,
// cancellable until then → the daily job (runDueDeletions) deletes it: one transaction per table
// group, in batches. Then: the server's caches are dropped (the bot, if still there, falls back to
// defaults), a short DM to the owner (if reachable), one log line + an owner-audit row (no member
// data), and optionally the bot leaves.
//
// Safety: every statement takes the server id as its only parameter ($1); deleteServerData refuses
// anything but one valid, non-home snowflake. tests/db/serverDataDeletion.test.js proves a second
// server is untouched.

import { pgConfig } from '../../config/database/postgres.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { DELETION_KEY_PREFIX, GROUP_ORDER, KINDS, LOGS_COUNT_SQL, TABLES, entriesOf } from './serverDataInventory.js';

export const GRACE_DAYS = 7;
export const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
/** The OAuth server list must be this fresh to prove ownership of a server the bot left. */
export const OAUTH_OWNER_FRESH_MS = 10 * 60 * 1000;
/** A finished request stays visible this long ("deleted on …"), then the record goes too. */
export const DONE_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A run that died half-way (restart) is retried after this long. */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;
export const BATCH_SIZE = 1000;

/** Mewvo's own servers, always refused (also when the env names others). */
export const HOME_GUILD_IDS = Object.freeze(['1527697154926182492', '1564312871976829009']);

const SNOWFLAKE = /^\d{17,20}$/;

export function isHomeServerId(guildId, config = enforcementConfig) {
    const id = String(guildId || '');
    return HOME_GUILD_IDS.includes(id) || (Boolean(config?.mainGuildId) && id === String(config.mainGuildId))
        || (Boolean(config?.supportGuildId) && id === String(config.supportGuildId));
}

/** null when a deletion may be asked for this id; else 'badId' or 'home'. */
export function serverRefusal(guildId, config = enforcementConfig) {
    if (!SNOWFLAKE.test(String(guildId || ''))) return 'badId';
    if (isHomeServerId(guildId, config)) return 'home';
    return null;
}

export const deletionKey = (guildId) => `${DELETION_KEY_PREFIX}${guildId}`;

async function defaultDb() {
    const db = await import('../enforcement/db.js');
    return { query: db.query, withTransaction: db.withTransaction };
}

/**
 * The server's owner, fresh from Discord: { inGuild, ownerId }. ownerId null = could not be
 * checked (Discord did not answer): callers refuse then (fail closed).
 */
export async function liveGuildOwner(client, guildId) {
    const guild = client?.guilds?.cache?.get?.(String(guildId));
    if (!guild) return { inGuild: false, ownerId: null };
    try {
        const fresh = typeof guild.fetch === 'function' ? await guild.fetch() : guild;
        return { inGuild: true, ownerId: fresh?.ownerId ? String(fresh.ownerId) : null };
    } catch {
        return { inGuild: true, ownerId: null };
    }
}

/**
 * May `userId` ask for this server's data to be deleted? { allowed, reason, inGuild }.
 * reason: 'badId' | 'home' | 'notOwner' | 'unknown' (owner not checkable now) | 'stale' (the OAuth
 * list is too old: log in again) | null. `oauthEntry`: the user's OAuth list entry for this server
 * (only used when the bot is not in it).
 */
export async function checkServerOwner({ client, guildId, userId, oauthEntry = null, now = Date.now(), config = enforcementConfig, owner = liveGuildOwner }) {
    const refusal = serverRefusal(guildId, config);
    if (refusal) return { allowed: false, reason: refusal, inGuild: false };
    if (!SNOWFLAKE.test(String(userId || ''))) return { allowed: false, reason: 'notOwner', inGuild: false };
    const live = await owner(client, String(guildId));
    if (live.inGuild) {
        if (!live.ownerId) return { allowed: false, reason: 'unknown', inGuild: true };
        return live.ownerId === String(userId) ? { allowed: true, reason: null, inGuild: true } : { allowed: false, reason: 'notOwner', inGuild: true };
    }
    if (oauthEntry?.owner !== true || String(oauthEntry?.id) !== String(guildId)) return { allowed: false, reason: 'notOwner', inGuild: false };
    const at = Number(oauthEntry.listedAt);
    if (!Number.isFinite(at) || now - at > OAUTH_OWNER_FRESH_MS || at > now + 60_000) return { allowed: false, reason: 'stale', inGuild: false };
    return { allowed: true, reason: null, inGuild: false };
}

function assertDeletable(guildId, config) {
    const refusal = serverRefusal(guildId, config);
    if (refusal) throw new Error(`Server data deletion refused for ${String(guildId).slice(0, 25)}: ${refusal}`);
    return String(guildId);
}

/**
 * The preview: { guildId, kinds: { cases: n, … }, tables: [{ key, kind, count }], total }.
 * Throws on a database error (never shows a guessed 0).
 */
export async function previewServerData(guildId, { query = null, tables = pgConfig.tables, config = enforcementConfig } = {}) {
    const id = assertDeletable(guildId, config);
    const run = query || (await defaultDb()).query;
    const kinds = Object.fromEntries(KINDS.map((k) => [k, 0]));
    const rows = [];
    for (const entry of TABLES) {
        const { rows: [r] } = await run(`SELECT COUNT(*)::int AS n FROM ${tables[entry.key]} WHERE ${entry.where(tables)}`, [id]);
        const count = Number(r?.n) || 0;
        rows.push({ key: entry.key, table: tables[entry.key], kind: entry.kind, count, note: entry.note || null, mode: entry.mode || 'delete' });
        kinds[entry.kind] += count;
    }
    const { rows: [logs] } = await run(LOGS_COUNT_SQL(tables), [id]);
    kinds.logs = Number(logs?.n) || 0;
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    return { guildId: id, kinds, tables: rows, total };
}

/** The stored request (scheduled / running / done), or null. Throws on a database error. */
export async function getDeletionRequest(guildId, { query = null, tables = pgConfig.tables } = {}) {
    if (!SNOWFLAKE.test(String(guildId || ''))) return null;
    const run = query || (await defaultDb()).query;
    const { rows } = await run(
        `SELECT value FROM ${tables.temp_data} WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`, [deletionKey(guildId)]);
    return rows[0]?.value || null;
}

/** Pending = scheduled or running (a run in progress cannot be cancelled any more). */
export const isPending = (record) => record?.status === 'scheduled' || record?.status === 'running';

/**
 * Schedules the deletion GRACE_DAYS from now. { record, created }: created false when one was
 * already pending (that one is returned, unchanged). Throws on a database error.
 * The caller has checked ownership (checkServerOwner) just before.
 */
export async function requestServerDeletion({ guildId, userId, removeBot = false, source = 'dashboard', lang = 'en', guildName = null, now = Date.now(), query = null, tables = pgConfig.tables, config = enforcementConfig }) {
    const id = assertDeletable(guildId, config);
    if (!SNOWFLAKE.test(String(userId || ''))) throw new Error('requestServerDeletion: bad user id');
    const run = query || (await defaultDb()).query;
    const record = {
        guildId: id, status: 'scheduled', requestedBy: String(userId), requestedAt: new Date(now).toISOString(),
        dueAt: new Date(now + GRACE_MS).toISOString(), removeBot: Boolean(removeBot), source: String(source).slice(0, 20),
        lang: String(lang || 'en').slice(0, 10), guildName: guildName ? String(guildName).slice(0, 100) : null,
    };
    // A pending request is never replaced (two clicks, two tabs): only a missing or finished one.
    const { rows } = await run(
        `INSERT INTO ${tables.temp_data} (key, value, expires_at) VALUES ($1, $2::jsonb, NULL)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL
         WHERE ${tables.temp_data}.value->>'status' NOT IN ('scheduled', 'running')
            OR (${tables.temp_data}.expires_at IS NOT NULL AND ${tables.temp_data}.expires_at <= NOW())
         RETURNING value`,
        [deletionKey(id), JSON.stringify(record)]);
    if (rows[0]) {
        logger.info(`Server data deletion requested for server ${id} by its owner ${record.requestedBy} (${record.source}); due ${record.dueAt}${record.removeBot ? ', then Mewvo leaves' : ''}`,
            { event: 'serverdata.requested', guildId: id });
        await ownerAudit(run, tables, config, id, record.requestedBy, 'scheduled');
        return { record: rows[0].value, created: true };
    }
    return { record: await getDeletionRequest(id, { query: run, tables }), created: false };
}

/**
 * Cancels a scheduled deletion. { cancelled, record }: cancelled false when there was none, or it
 * is already running / done. Throws on a database error.
 */
export async function cancelServerDeletion({ guildId, userId, query = null, tables = pgConfig.tables, config = enforcementConfig }) {
    const id = assertDeletable(guildId, config);
    const run = query || (await defaultDb()).query;
    const { rows } = await run(
        `DELETE FROM ${tables.temp_data} WHERE key = $1 AND value->>'status' = 'scheduled' RETURNING value`, [deletionKey(id)]);
    if (rows[0]) {
        logger.info(`Server data deletion for server ${id} cancelled by its owner ${userId}`, { event: 'serverdata.cancelled', guildId: id });
        await ownerAudit(run, tables, config, id, String(userId), 'cancelled');
        return { cancelled: true, record: rows[0].value };
    }
    return { cancelled: false, record: await getDeletionRequest(id, { query: run, tables }) };
}

/**
 * Deletes everything serverDataInventory.js lists for ONE server: one transaction per group
 * (GROUP_ORDER), each table in batches of `batchSize`. Returns { counts: { table: n }, kinds, total }.
 * Throws (that group rolled back; earlier groups stay deleted, the job retries the rest).
 */
export async function deleteServerData(guildId, { withTransaction = null, tables = pgConfig.tables, batchSize = BATCH_SIZE, config = enforcementConfig } = {}) {
    const id = assertDeletable(guildId, config);
    const tx = withTransaction || (await defaultDb()).withTransaction;
    const size = Math.max(1, Math.min(10_000, Number(batchSize) || BATCH_SIZE));
    const counts = {};
    const kinds = Object.fromEntries(KINDS.map((k) => [k, 0]));
    // The logging setup is part of the guilds row: count it before that row goes.
    await tx(async (c) => {
        const { rows: [r] } = await c.query(LOGS_COUNT_SQL(tables), [id]);
        kinds.logs = Number(r?.n) || 0;
    });
    for (const group of GROUP_ORDER) {
        const entries = entriesOf(group);
        if (!entries.length) continue;
        await tx(async (c) => {
            for (const entry of entries) {
                const table = tables[entry.key];
                const where = entry.where(tables);
                const sql = entry.mode === 'detach'
                    ? `UPDATE ${table} SET ${entry.set} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT $2)`
                    : `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT $2)`;
                let done = 0;
                for (;;) {
                    const { rowCount } = await c.query(sql, [id, size]);
                    done += rowCount || 0;
                    if (!rowCount || rowCount < size) break;
                }
                const name = entry.note ? `${table} (${entry.note})` : table;
                counts[name] = (counts[name] || 0) + done;
                kinds[entry.kind] += done;
            }
        });
    }
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return { counts, kinds, total };
}

/** One owner-audit row in the main server's dashboard audit (Owner → Activity). Best effort. */
async function ownerAudit(run, tables, config, guildId, userId, status, extra = {}) {
    const main = config?.mainGuildId;
    if (!main || !SNOWFLAKE.test(String(main))) return;
    try {
        await run(
            `INSERT INTO ${tables.dashboard_audit} (guild_id, user_id, username, module, key, old, new) VALUES ($1, $2, $3, 'owner', $4, NULL, $5::jsonb)`,
            [String(main), String(userId || '') || null, 'server owner', `privacy.serverdata.${guildId}`, JSON.stringify({ status, ...extra })]);
    } catch (error) {
        logger.warn(`Owner audit row for the server data deletion of ${guildId} not written: ${error.message}`);
    }
}

/** Drops what the bot holds in memory for this server, so a bot still there uses defaults. Never throws. */
export async function forgetServerCaches(client, guildId) {
    const steps = [
        async () => (await import('../settings/guildSettings.js')).refreshGuildSettings(guildId),
        async () => (await import('../../utils/database/guildConfigStorage.js')).invalidateGuildConfigCache(client, guildId),
        async () => (await import('../community/settingsService.js')).forgetCommunitySettings(guildId),
        async () => (await import('../automod/automodSettings.js')).resetAutomodSettingsCache(),
        async () => (await import('../members/roleRuleService.js')).forgetRuleCache(guildId),
        async () => (await import('../enforcement/precedentService.js')).clearPrecedentCache(),
    ];
    for (const step of steps) {
        try {
            await step();
        } catch (error) {
            logger.warn(`Server data deletion: a cache of ${guildId} was not dropped: ${error.message}`);
        }
    }
}

/** The due requests: scheduled with dueAt ≤ now, or a run that died more than STALE_RUN_MS ago. */
export async function listDueDeletions({ now = Date.now(), query = null, tables = pgConfig.tables } = {}) {
    const run = query || (await defaultDb()).query;
    const { rows } = await run(
        `SELECT value FROM ${tables.temp_data} WHERE key LIKE $1 AND value->>'status' IN ('scheduled', 'running')`, [`${DELETION_KEY_PREFIX}%`]);
    return rows.map((r) => r.value).filter((v) => {
        if (!SNOWFLAKE.test(String(v?.guildId || ''))) return false;
        if (v.status === 'running') return now - Date.parse(v.startedAt || 0) > STALE_RUN_MS;
        return Date.parse(v.dueAt) <= now;
    });
}

async function claim(run, tables, record, now) {
    const { rows } = await run(
        `UPDATE ${tables.temp_data} SET value = value || $2::jsonb WHERE key = $1
           AND (value->>'status' = 'scheduled' OR (value->>'status' = 'running' AND value->>'startedAt' = $3))
         RETURNING value`,
        [deletionKey(record.guildId), JSON.stringify({ status: 'running', startedAt: new Date(now).toISOString() }), String(record.startedAt || '')]);
    return rows[0]?.value || null;
}

/** The DM to the owner after the deletion (their language from the request). Best effort. */
async function dmOwner(client, record, text) {
    try {
        const user = await client?.users?.fetch?.(record.requestedBy);
        if (!user?.send) return false;
        await user.send({ content: text, allowedMentions: { parse: [] } });
        return true;
    } catch {
        return false;
    }
}

/**
 * The daily job: runs every due deletion. deps (tests): { query, withTransaction, tables, now,
 * owner (liveGuildOwner), texts(lang) → { done(server) } }. Returns [{ guildId, result }].
 */
export async function runDueDeletions(client, { query = null, withTransaction = null, tables = pgConfig.tables, now = Date.now(), owner = liveGuildOwner, texts = null, config = enforcementConfig, batchSize = BATCH_SIZE } = {}) {
    const db = query && withTransaction ? { query, withTransaction } : await defaultDb();
    const run = query || db.query;
    const tx = withTransaction || db.withTransaction;
    const out = [];
    for (const due of await listDueDeletions({ now, query: run, tables })) {
        const id = String(due.guildId);
        if (serverRefusal(id, config)) {
            logger.error(`Server data deletion: refused a stored request for ${id} (Mewvo's own server or a bad id)`);
            out.push({ guildId: id, result: 'refused' });
            continue;
        }
        // Ownership changed during the grace period (bot still there): the request lapses.
        const live = await owner(client, id);
        if (live.inGuild && !live.ownerId) {
            logger.warn(`Server data deletion for ${id} postponed: the owner could not be checked with Discord`);
            out.push({ guildId: id, result: 'postponed' });
            continue;
        }
        if (live.inGuild && live.ownerId !== due.requestedBy) {
            await run(`DELETE FROM ${tables.temp_data} WHERE key = $1 AND value->>'status' IN ('scheduled', 'running')`, [deletionKey(id)]);
            logger.info(`Server data deletion for ${id} dropped: the server has a new owner since the request`, { event: 'serverdata.lapsed', guildId: id });
            await ownerAudit(run, tables, config, id, due.requestedBy, 'lapsed');
            out.push({ guildId: id, result: 'lapsed' });
            continue;
        }
        const claimed = await claim(run, tables, due, now);
        if (!claimed) {
            out.push({ guildId: id, result: 'skipped' });
            continue;
        }
        let result;
        try {
            result = await deleteServerData(id, { withTransaction: tx, tables, batchSize, config });
        } catch (error) {
            logger.error(`Server data deletion for ${id} failed (retried tomorrow): ${error.message}`, { event: 'serverdata.failed', guildId: id });
            await run(`UPDATE ${tables.temp_data} SET value = value || $2::jsonb WHERE key = $1`,
                [deletionKey(id), JSON.stringify({ status: 'scheduled', lastError: String(error.message).slice(0, 200), lastAttemptAt: new Date(now).toISOString() })]).catch(() => {});
            out.push({ guildId: id, result: 'failed' });
            continue;
        }
        const doneAt = new Date(now).toISOString();
        await run(`UPDATE ${tables.temp_data} SET value = $2::jsonb, expires_at = NOW() + ($3::text || ' seconds')::interval WHERE key = $1`,
            [deletionKey(id), JSON.stringify({ guildId: id, status: 'done', requestedBy: due.requestedBy, requestedAt: due.requestedAt, doneAt, total: result.total }), String(DONE_RECORD_TTL_SECONDS)]);
        await forgetServerCaches(client, id);
        const tr = texts ? texts(due.lang) : await defaultTexts(due.lang);
        const dmDelivered = await dmOwner(client, due, tr.done(due.guildName || id));
        let left = false;
        if (due.removeBot) {
            const guild = client?.guilds?.cache?.get?.(id);
            if (guild?.leave) left = await guild.leave().then(() => true, (error) => { logger.warn(`Server data deletion: could not leave ${id}: ${error.message}`); return false; });
        }
        logger.info(`Server data deleted for server ${id} (requested by its owner ${due.requestedBy} on ${due.requestedAt}): ${result.total} row(s) [${Object.entries(result.kinds).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing stored'}]; DM ${dmDelivered ? 'delivered' : 'not delivered'}${due.removeBot ? `; left the server: ${left}` : ''}`,
            { event: 'serverdata.deleted', guildId: id });
        await ownerAudit(run, tables, config, id, due.requestedBy, 'deleted', { total: result.total });
        out.push({ guildId: id, result: 'deleted', total: result.total, dmDelivered, left });
    }
    return out;
}

async function defaultTexts(lang) {
    const { botText } = await import('../../utils/botText.js');
    const tr = botText(lang);
    return { done: (server) => tr.t('serverdata.dm.done', { server }) };
}
