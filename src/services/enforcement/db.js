// db.js — direct PostgreSQL access for the enforcement tables.
//
// Enforcement needs transactions, row locks and UNIQUE constraints, so it talks
// to the pool directly instead of going through the key/value wrapper. There is
// no in-memory fallback: without Postgres the panel refuses to act.

import { pgDb } from '../../utils/postgresDatabase.js';
import { pgConfig } from '../../config/database/postgres.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';

export const T = {
    cases: pgConfig.tables.mod_cases,
    ladder: pgConfig.tables.mod_ladder,
    appeals: pgConfig.tables.mod_appeals,
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

function requirePool() {
    if (!pgDb.isAvailable()) {
        throw createError(
            'Enforcement database unavailable',
            ErrorTypes.DATABASE,
            'The database is unavailable, so no enforcement action was taken. Try again later.',
            { expected: true }
        );
    }
    return pgDb.pool;
}

export async function query(text, params = []) {
    return requirePool().query(text, params);
}

/** Runs fn(client) inside BEGIN/COMMIT; rolls back and rethrows on error. */
export async function withTransaction(fn) {
    const client = await requirePool().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

export function isUniqueViolation(error, constraintFragment = '') {
    return error?.code === '23505' && String(error?.constraint || '').includes(constraintFragment);
}
