// caseService.js — reads and writes mod_cases rows.

import { query, T, isUniqueViolation } from './db.js';
import { generateCaseCode } from './format.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';

const MAX_CODE_ATTEMPTS = 8;
export const OPEN_STATUSES = ['active', 'appeal_pending'];

/**
 * Inserts a case with a fresh random code, retrying on code collisions.
 * `db` may be a transaction client; defaults to the pool.
 */
export async function insertCase(db, record) {
    const run = db ? (text, params) => db.query(text, params) : query;

    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
        const caseCode = generateCaseCode();
        try {
            const { rows } = await run(
                `INSERT INTO ${T.cases} (
                    guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username,
                    type, name, reason, prebuilt_or_custom, reason_key, duration_ms, created_at, expires_at,
                    unappealable, appeal_deadline, ladder_level_after, counts_toward_level, is_auto,
                    is_imported, import_key, dm_delivered, status
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, NOW()),$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
                RETURNING *`,
                [
                    record.guildId,
                    caseCode,
                    record.targetUserId,
                    record.targetUsername,
                    record.moderatorId,
                    record.moderatorUsername,
                    record.type,
                    record.name,
                    record.reason,
                    record.reasonSource || 'prebuilt',
                    record.reasonKey || null,
                    record.durationMs ?? null,
                    record.createdAt || null,
                    record.expiresAt || null,
                    Boolean(record.unappealable),
                    record.appealDeadline || null,
                    record.ladderLevelAfter ?? 0,
                    record.countsTowardLevel ?? null,
                    Boolean(record.isAuto),
                    Boolean(record.isImported),
                    record.importKey || null,
                    Boolean(record.dmDelivered),
                    record.status || 'active',
                ]
            );
            return rows[0];
        } catch (error) {
            if (isUniqueViolation(error, 'case_code')) {
                continue;
            }
            if (isUniqueViolation(error, 'guild_name')) {
                throw createError(
                    'Duplicate case name',
                    ErrorTypes.VALIDATION,
                    `A record named **${record.name}** already exists in this server. Pick another name.`,
                    { expected: true }
                );
            }
            throw error;
        }
    }

    throw createError('Could not allocate a unique case code', ErrorTypes.DATABASE,
        'Could not create a unique case code. Please try again.');
}

export async function setDmDelivered(caseId, delivered) {
    await query(`UPDATE ${T.cases} SET dm_delivered = $2 WHERE id = $1`, [caseId, delivered]);
}

export async function getCaseByCode(caseCode) {
    const { rows } = await query(`SELECT * FROM ${T.cases} WHERE case_code = $1`, [caseCode]);
    return rows[0] || null;
}

export async function getCaseByName(guildId, name) {
    const { rows } = await query(
        `SELECT * FROM ${T.cases} WHERE guild_id = $1 AND lower(name) = lower($2)`,
        [guildId, name]
    );
    return rows[0] || null;
}

export async function isNameTaken(guildId, name) {
    return Boolean(await getCaseByName(guildId, name));
}

export async function listCasesForUser(guildId, userId, { limit = 10, offset = 0 } = {}) {
    const { rows } = await query(
        `SELECT *, COUNT(*) OVER() AS total_count FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT $3 OFFSET $4`,
        [guildId, userId, limit, offset]
    );
    return { rows, total: rows.length ? Number(rows[0].total_count) : 0 };
}

export async function searchCaseNames(guildId, userId, prefix, limit = 25) {
    const { rows } = await query(
        `SELECT name, type, case_code FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND name ILIKE $3
         ORDER BY created_at DESC LIMIT $4`,
        [guildId, userId, `%${String(prefix || '').replace(/[%_\\]/g, (c) => `\\${c}`)}%`, limit]
    );
    return rows;
}

export async function getActiveCase(guildId, userId, type) {
    const { rows } = await query(
        `SELECT * FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND type = $3 AND status = ANY($4)
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC LIMIT 1`,
        [guildId, userId, type, OPEN_STATUSES]
    );
    return rows[0] || null;
}

/** Warns that currently count toward the ladder at the given level. */
export async function getCountedWarns(guildId, userId, level) {
    const { rows } = await query(
        `SELECT * FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND type = 'warn' AND is_imported = FALSE
           AND status = ANY($3) AND counts_toward_level = $4
         ORDER BY created_at DESC LIMIT 25`,
        [guildId, userId, OPEN_STATUSES, level]
    );
    return rows;
}

/** Next number for the default "<username> <type> <n>" name. */
export async function nextDefaultName(guildId, userId, username, type) {
    const { rows } = await query(
        `SELECT COUNT(*)::int AS count FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND type = $3 AND is_imported = FALSE`,
        [guildId, userId, type]
    );
    let n = (rows[0]?.count || 0) + 1;
    // Names are unique per server; skip numbers already taken (e.g. after a username change).
    for (let guard = 0; guard < 50; guard += 1, n += 1) {
        const candidate = `${username} ${type} ${n}`;
        if (!(await isNameTaken(guildId, candidate))) {
            return candidate;
        }
    }
    return `${username} ${type} ${Date.now()}`;
}

export async function getAppealHistory(caseCode) {
    const { rows } = await query(
        `SELECT * FROM ${T.appeals} WHERE case_code = $1 AND kind = 'appeal' ORDER BY created_at DESC LIMIT 10`,
        [caseCode]
    );
    return rows;
}
