// caseService.js — reads and writes mod_cases rows.

import { query, T, isUniqueViolation } from './db.js';
import { generateCaseCode } from './format.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';

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
                    is_imported, import_key, dm_delivered, status, is_test
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, NOW()),$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
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
                    Boolean(record.isTest),
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

/** Records whether the "your ban/mute has ended" DM reached the user (once; never retried). */
export async function setEndDmDelivered(caseIds, delivered) {
    if (!caseIds.length) return true;
    await query(`UPDATE ${T.cases} SET end_dm_delivered = $2 WHERE id = ANY($1::bigint[])`, [caseIds, delivered]);
    return true;
}

/**
 * The "server" a guild id counts as for case access: Mewvo's main and support servers are one
 * ('home'), as in appealService.isCaseOfCallerServer; any other server is only itself.
 */
function caseServerOf(guildId) {
    const id = guildId == null ? '' : String(guildId);
    if (!id) return null;
    const home = [enforcementConfig.mainGuildId, enforcementConfig.supportGuildId].filter(Boolean).map(String);
    return home.includes(id) ? 'home' : id;
}

/** The guild ids whose cases count as `guildId`'s own: both home servers, or just that server. */
export function caseServerGuildIds(guildId) {
    const scope = caseServerOf(guildId);
    if (!scope) return [];
    if (scope !== 'home') return [scope];
    return [...new Set([enforcementConfig.mainGuildId, enforcementConfig.supportGuildId].filter(Boolean).map(String))];
}

/** Whether a case of `caseGuildId` may be read or changed from `callerGuildId` (home servers count as one). */
export function isSameCaseServer(caseGuildId, callerGuildId) {
    const own = caseServerOf(caseGuildId);
    return own !== null && own === caseServerOf(callerGuildId);
}

/**
 * One case by its code, only when it belongs to the caller's server (`guildId`; main + support
 * count as one). Another server's case gives null, exactly like an unknown code, so codes of
 * other servers can't be read or probed. `guildId` is required.
 */
export async function getCaseByCode(caseCode, guildId) {
    if (!guildId) throw new TypeError('getCaseByCode needs the guildId of the caller (use getCaseByCodeAnyServer for a deliberate any-server lookup)');
    const record = await getCaseByCodeAnyServer(caseCode);
    return record && isSameCaseServer(record.guild_id, guildId) ? record : null;
}

/**
 * One case by its code, in whichever server it belongs to. Only for callers that check access
 * another way (the member's own case by user id, owner tools, jobs working from a stored row);
 * every caller says why next to the call.
 */
export async function getCaseByCodeAnyServer(caseCode) {
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

/**
 * One member's cases in EVERY server, newest first (the member portal's "My appeals" page: a
 * member appeals their own cases wherever they were issued). Only ever called with the user id
 * of the logged-in member; staff views must use listCasesForUser (one server).
 */
export async function listCasesForUserAllServers(userId, { limit = 200 } = {}) {
    if (!userId) throw new TypeError('listCasesForUserAllServers needs the member\'s user id');
    const { rows } = await query(
        `SELECT * FROM ${T.cases}
         WHERE target_user_id = $1 AND is_test = FALSE
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [userId, limit]
    );
    return rows;
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
           AND (expires_at IS NULL OR expires_at > NOW()) AND is_test = FALSE
         ORDER BY created_at DESC LIMIT 1`,
        [guildId, userId, type, OPEN_STATUSES]
    );
    return rows[0] || null;
}

/** Warns that currently count toward the ladder at the given level. */
export async function getCountedWarns(guildId, userId, level) {
    const { rows } = await query(
        `SELECT * FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND type = 'warn' AND is_imported = FALSE AND is_test = FALSE
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
         WHERE guild_id = $1 AND target_user_id = $2 AND type = $3 AND is_imported = FALSE AND is_test = FALSE`,
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

/**
 * One user's own appeals, newest first, with the case they were about. Every server by default:
 * the member's own list (/appeal, the member portal). `guildId` limits it to the cases of that
 * server (main + support as one), e.g. for a server's standing view.
 */
export async function listUserAppeals(userId, limit = 10, { guildId = null } = {}) {
    const scoped = guildId != null;
    const { rows } = await query(
        `SELECT a.case_code, a.status, a.created_at, a.decided_at, a.claimed_at, c.type, c.name, c.guild_id
         FROM ${T.appeals} a JOIN ${T.cases} c ON c.case_code = a.case_code
         WHERE a.user_id = $1 AND a.kind = 'appeal' AND NOT c.is_test${scoped ? ' AND c.guild_id = ANY($3::varchar[])' : ''}
         ORDER BY a.created_at DESC LIMIT $2`,
        scoped ? [userId, limit, caseServerGuildIds(guildId)] : [userId, limit]
    );
    return rows;
}

/**
 * Latest appeal status per case of one user in one server (main + support as one):
 * Map(case_code → 'pending' | 'accepted' | 'denied' | 'closed'). Staff views list pending
 * appeals from it, so appeals in other servers must never be in it. `guildId` is required.
 */
export async function getLatestAppealStatuses(userId, guildId) {
    if (!guildId) throw new TypeError('getLatestAppealStatuses needs the guildId of the caller');
    const { rows } = await query(
        `SELECT DISTINCT ON (a.case_code) a.case_code, a.status FROM ${T.appeals} a
         JOIN ${T.cases} c ON c.case_code = a.case_code
         WHERE a.user_id = $1 AND a.kind = 'appeal' AND c.guild_id = ANY($2::varchar[])
         ORDER BY a.case_code, a.created_at DESC`,
        [userId, caseServerGuildIds(guildId)]
    );
    return new Map(rows.map((row) => [row.case_code, row.status]));
}

/** Latest appeal status per case for a list of case codes: Map(case_code → status). */
export async function getLatestAppealStatusesForCases(caseCodes) {
    if (!caseCodes.length) return new Map();
    const { rows } = await query(
        `SELECT DISTINCT ON (case_code) case_code, status FROM ${T.appeals}
         WHERE case_code = ANY($1::varchar[]) AND kind = 'appeal' ORDER BY case_code, created_at DESC`,
        [caseCodes]
    );
    return new Map(rows.map((row) => [row.case_code, row.status]));
}

/**
 * A stable id for a case's status: voided, liftedByAppeal, reversed, lifted, appealPending,
 * expired, activeAppealDenied, or the row's own status (active, expired). The website shows
 * portal.status.case.<code> in the page's language; caseStatusLabel is the English words.
 */
export function caseStatusCode(row, appealStatus = null) {
    if (row.voided_at) return 'voided';
    if (row.status === 'revoked') {
        if (row.revoke_reason?.startsWith('Appeal accepted')) return 'liftedByAppeal';
        if (row.revoke_reason?.startsWith('Automod decision')) return 'reversed';
        return 'lifted';
    }
    if (row.status === 'appeal_pending') return 'appealPending';
    if (row.status === 'active' && row.expires_at && new Date(row.expires_at) <= new Date()) return 'expired';
    if (row.status === 'active' && appealStatus === 'denied') return 'activeAppealDenied';
    return row.status;
}

const CASE_STATUS_WORDS = Object.freeze({
    voided: 'removed (a mistake)', liftedByAppeal: 'lifted by appeal', reversed: 'reversed by a moderator', lifted: 'lifted early',
    appealPending: 'appeal pending', activeAppealDenied: 'active, appeal denied',
});

/** A short status for history lists: lifted by appeal, appeal pending, expired, … (English). */
export function caseStatusLabel(row, appealStatus = null) {
    const code = caseStatusCode(row, appealStatus);
    return Object.hasOwn(CASE_STATUS_WORDS, code) ? CASE_STATUS_WORDS[code] : code;
}
