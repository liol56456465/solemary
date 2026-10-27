// audit.js — the dashboard audit trail: one dashboard_audit row per changed key (who,
// module, key, old → new) and one line in the mod log per saved form.
//
// Settings in guild_settings are audited by guildSettings.updateSettings itself (same
// transaction). Every other store (guild config, welcome config, automod settings,
// community tables, …) is audited here from the before/after snapshot the dashboard
// takes around the service call.

import { query as dbQuery } from '../enforcement/db.js';
import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';

const MAX_VALUE_TEXT = 120;
export const AUDIT_PAGE_SIZE = 50;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The changed keys between two snapshots: [{ key, old, new }]. `keys` limits the
 * comparison (default: every key in either). Nested objects compare as a whole.
 */
export function diffSnapshots(before = {}, after = {}, keys = null, prefix = '') {
    const names = keys || [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
    const out = [];
    for (const key of names) {
        const a = before?.[key];
        const b = after?.[key];
        if (!same(a, b)) out.push({ key: `${prefix}${key}`, old: a ?? null, new: b ?? null });
    }
    return out;
}

/** A value as short text for the audit page and the mod log line. */
export function valueText(value) {
    if (value === null || value === undefined || value === '') return '—';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT - 1)}…` : text;
}

/** "key: old → new; key2: …" (capped) for the mod log. */
export function changeSummary(changes, max = 1500) {
    const text = changes.map((c) => `${c.key}: ${valueText(c.old)} → ${valueText(c.new)}`).join('; ');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The audit store: writeRows(guildId, actor, module, changes) and list(guildId, filters).
 * `query` / `table` are injectable for tests.
 */
export function createAuditStore({ query = dbQuery, table = pgConfig.tables.dashboard_audit } = {}) {
    async function writeRows(guildId, actor, module, changes) {
        for (const change of changes) {
            await query(
                `INSERT INTO ${table} (guild_id, user_id, username, module, key, old, new)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
                [guildId, actor.userId || null, String(actor.username || '').slice(0, 100) || null, String(module).slice(0, 40),
                    String(change.key).slice(0, 80), JSON.stringify(change.old ?? null), JSON.stringify(change.new ?? null)]);
        }
        return changes.length;
    }

    /** { rows, total } newest first; filters: { userId, module, page, pageSize }. */
    async function list(guildId, { userId = null, module = null, page = 0, pageSize = AUDIT_PAGE_SIZE } = {}) {
        const where = ['guild_id = $1'];
        const params = [guildId];
        if (userId) {
            params.push(userId);
            where.push(`user_id = $${params.length}`);
        }
        if (module) {
            params.push(module);
            where.push(`module = $${params.length}`);
        }
        const size = Math.min(200, Math.max(1, pageSize));
        const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where.join(' AND ')}`, params);
        const { rows } = await query(
            `SELECT id, guild_id, user_id, username, module, key, old, new, created_at FROM ${table}
             WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${size} OFFSET ${Math.max(0, page) * size}`, params);
        return { rows, total: Number(count) || 0 };
    }

    /** Users who appear in the audit log (for the filter): [{ user_id, username }]. */
    async function users(guildId) {
        const { rows } = await query(
            `SELECT user_id, MAX(username) AS username FROM ${table} WHERE guild_id = $1 AND user_id IS NOT NULL
             GROUP BY user_id ORDER BY MAX(username) LIMIT 100`, [guildId]);
        return rows;
    }

    return { writeRows, list, users };
}

/**
 * After a successful dashboard change: audit rows (unless the service wrote them) and
 * one mod-log line. Failures are logged, never thrown: the change itself is saved.
 */
export async function recordDashboardChange({ store, postModLog, client, guildId, actor, module, moduleLabel, changes, audited = false }) {
    if (!changes.length) return;
    if (!audited) {
        await store.writeRows(guildId, actor, module, changes).catch((error) => logger.error(`Dashboard audit write failed (${module}): ${error.message}`));
    }
    const line = `${actor.username || actor.userId} (${actor.userId}) changed ${moduleLabel || module}: ${changeSummary(changes)}`;
    await Promise.resolve(postModLog(client, 'dashboard', [], { description: line }))
        .catch((error) => logger.warn(`Dashboard mod log post failed: ${error.message}`));
}
