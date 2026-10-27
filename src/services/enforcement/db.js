// db.js — direct PostgreSQL access for the enforcement tables.
//
// Enforcement needs transactions, row locks and UNIQUE constraints, so it talks
// to the pool directly instead of going through the key/value wrapper. There is
// no in-memory fallback: without Postgres the panel refuses to act.

import { pgDb, isConnectionError } from '../../utils/postgresDatabase.js';
import { pgConfig } from '../../config/database/postgres.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';

export const T = {
    cases: pgConfig.tables.mod_cases,
    ladder: pgConfig.tables.mod_ladder,
    appeals: pgConfig.tables.mod_appeals,
    caseEdits: pgConfig.tables.mod_case_edits,
    settings: pgConfig.tables.enforcement_settings,
    staffWarnings: pgConfig.tables.staff_warnings,
    verificationIps: pgConfig.tables.verification_ips,
    staffActivity: pgConfig.tables.staff_activity,
    serverSnapshots: pgConfig.tables.server_snapshots,
    tickets: pgConfig.tables.tickets,
};

export function isEnforcementDbAvailable() {
    return Boolean(pgDb.isAvailable());
}

function unavailable() {
    return createError(
        'Enforcement database unavailable',
        ErrorTypes.DATABASE,
        'The database is unavailable, so no enforcement action was taken. Try again later.',
        { expected: true }
    );
}

/** The pool, after a health check when the last connection was lost. */
async function requirePool() {
    try {
        await pgDb.ensureAvailable();
    } catch {
        throw unavailable();
    }
    return pgDb.pool;
}

export async function query(text, params = []) {
    const pool = await requirePool();
    try {
        return await pool.query(text, params);
    } catch (error) {
        pgDb.noteQueryError(error);
        throw error;
    }
}

/** Runs fn(client) inside BEGIN/COMMIT; rolls back and rethrows on error. */
export async function withTransaction(fn) {
    const pool = await requirePool();
    let client;
    try {
        client = await pool.connect();
    } catch (error) {
        pgDb.noteQueryError(error);
        throw unavailable();
    }
    let failure = null;
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        failure = error;
        await client.query('ROLLBACK').catch(() => {});
        pgDb.noteQueryError(error);
        throw error;
    } finally {
        client.release(isConnectionError(failure) ? failure : undefined);
    }
}

export function isUniqueViolation(error, constraintFragment = '') {
    return error?.code === '23505' && String(error?.constraint || '').includes(constraintFragment);
}
