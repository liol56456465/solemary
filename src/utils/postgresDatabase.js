// postgresDatabase.js

import pg from 'pg';
import { pgConfig, resolvePostgresPoolConfig } from '../config/database/postgres.js';
import { logger } from './logger.js';
import { assertAllowlistedIdentifier, quoteIdentifier } from './sqlIdentifiers.js';
import {
    canonicalizeKey,
    getLegacyVariantsForCanonical,
} from './database/keys.js';
import {
    parseKey,
    isTempBackedType,
    getStructuredListPlan,
} from './database/keyParser.js';
import { runKeyMigration } from './database/keyMigration.js';
import { createError, ErrorTypes } from './errorHandler.js';
import {
    tableStatements,
    indexStatements,
    UPDATE_TIMESTAMP_FUNCTION,
    triggerDefinitions,
} from './database/schema.js';

// Connection-level failures mark the database unhealthy until a health check
// succeeds. Ordinary query errors (bad SQL, constraint violations) don't.
const CONNECTION_ERROR_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
    '57P01', '57P02', '57P03', // admin shutdown, crash shutdown, cannot connect now
    '08000', '08001', '08003', '08004', '08006',
]);
const CONNECTION_ERROR_PATTERN = /connection terminated|timeout exceeded when trying to connect|connection error|server closed the connection/i;
const HEALTH_RETRY_MAX_MS = 30_000;
const DATABASE_USER_MESSAGE = 'The database is not responding right now, so nothing was changed. Please try again in a moment.';

// Types with their own tables. Every other key type lives in temp_data.
const STRUCTURED_TYPES = new Set([
    'guild_config', 'guild_birthdays', 'guild_giveaways', 'welcome_config', 'leveling_config',
    'user_level', 'economy', 'afk_status', 'ticket', 'counters',
]);

function isTempStored(type) {
    return type !== 'cache' && (isTempBackedType(type) || !STRUCTURED_TYPES.has(type));
}

export function isConnectionError(error) {
    return Boolean(error) && (CONNECTION_ERROR_CODES.has(error.code) || CONNECTION_ERROR_PATTERN.test(error.message || ''));
}

/**
 * Wraps a failure as a typed database error, so callers and the error handler show
 * "nothing was changed". Errors that aren't from the database (a validation error
 * thrown by an update() mutator, say) pass through unchanged.
 */
function asDatabaseError(error, message) {
    if (error?.name === 'TitanBotError') return error;
    const fromDatabase = isConnectionError(error) || (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code));
    if (error && !fromDatabase) return error;
    return createError(`${message}: ${error?.message || 'unavailable'}`, ErrorTypes.DATABASE, DATABASE_USER_MESSAGE,
        { pgCode: error?.code });
}

function unavailableError() {
    return createError('PostgreSQL unavailable', ErrorTypes.DATABASE, DATABASE_USER_MESSAGE, { expected: true });
}

function clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
}

class PostgreSQLDatabase {
    constructor() {
        this.pool = null;
        this.isConnected = false;
        this.connectionPromise = null;
        this.allowedTableIdentifiers = new Set(Object.values(pgConfig.tables));
        this.allowedMigrationIdentifiers = new Set([pgConfig.migration.table]);
        this.lastFailureReason = null;
        this.lastFailureMessage = null;
        this.knownDown = false; // a health check failed; retries run in the background
        this.healthCheckPromise = null;
        this.healthTimer = null;
        this.healthRetryMs = 0;
        this.closing = false;
    }

    async connect() {
        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        this.connectionPromise = this._establishConnection();
        return this.connectionPromise;
    }

    async _establishConnection() {
        const retries = Number.isFinite(pgConfig.options.retries) ? pgConfig.options.retries : 0;
        const baseDelay = Number.isFinite(pgConfig.options.backoffBase) ? pgConfig.options.backoffBase : 100;
        const multiplier = Number.isFinite(pgConfig.options.backoffMultiplier) ? pgConfig.options.backoffMultiplier : 2;
        const attempts = Math.max(1, retries + 1);

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                await new Promise(resolve => setTimeout(resolve, 100));

                this.pool = new pg.Pool(resolvePostgresPoolConfig());

                // An idle client failed (Neon scaling to zero, network drop, restart).
                this.pool.on('error', (error) => this.markUnhealthy(error));

                // Poolers (Supabase Supavisor) drop the statement_timeout startup
                // parameter, so set it on each new connection as well.
                const statementTimeout = resolvePostgresPoolConfig().statement_timeout;
                if (statementTimeout > 0) {
                    this.pool.on('connect', (client) => {
                        client.query(`SET statement_timeout = ${Number(statementTimeout)}`)
                            .catch((error) => logger.warn(`Could not set statement_timeout: ${error.message}`));
                    });
                }

                const client = await this.pool.connect();
                await client.query('SELECT NOW()');
                client.release();

                this.lastFailureReason = null;
                this.lastFailureMessage = null;

                this.isConnected = true;
                logger.info('PostgreSQL Database initialized successfully');

                if (pgConfig.features.autoCreateTables) {
                    await this.createTables();

                    try {
                        const columnCheck = await this.pool.query(`
                            SELECT column_name 
                            FROM information_schema.columns 
                            WHERE table_name = 'guilds' AND column_name = 'counters'
                        `);

                        if (columnCheck.rows.length === 0) {
                            await this.pool.query(`
                                ALTER TABLE ${pgConfig.tables.guilds} 
                                ADD COLUMN counters JSONB DEFAULT '[]'
                            `);
                            logger.info('Added counters column to guilds table');
                        }
                    } catch (error) {
                        logger.warn('Could not add counters column to guilds table:', error.message);
                    }
                }

                if (pgConfig.migration.enabled) {
                    const migrationCheck = await this.verifySchemaVersion();
                    if (!migrationCheck.ok) {
                        const shouldBootstrapSchema =
                            migrationCheck.reason === 'MISSING_MIGRATION_VERSION'
                            && pgConfig.features.autoMigrate;

                        // Every schema statement is additive (CREATE … IF NOT EXISTS) and was
                        // just applied above, so an older ledger can be moved forward safely.
                        const shouldUpgradeSchema =
                            migrationCheck.reason === 'SCHEMA_VERSION_MISMATCH'
                            && pgConfig.features.autoMigrate
                            && pgConfig.features.autoCreateTables
                            && this.lastSchemaFailures === 0
                            && migrationCheck.currentVersion < migrationCheck.expectedVersion;

                        if (shouldUpgradeSchema) {
                            await this.setSchemaVersion(
                                pgConfig.migration.expectedVersion,
                                pgConfig.migration.expectedLabel
                            );
                            logger.warn(
                                `Schema ledger upgraded from v${migrationCheck.currentVersion} to v${pgConfig.migration.expectedVersion} (${pgConfig.migration.expectedLabel}).`
                            );
                            await this.runStartupKeyMigration();
                            return true;
                        }

                        if (shouldBootstrapSchema) {
                            await this.setSchemaVersion(
                                pgConfig.migration.expectedVersion,
                                pgConfig.migration.expectedLabel
                            );
                            logger.warn(
                                `No schema version found. Bootstrapped schema ledger to version ${pgConfig.migration.expectedVersion} (${pgConfig.migration.expectedLabel}).`
                            );
                            await this.runStartupKeyMigration();
                            return true;
                        }

                        const error = new Error(
                            `Schema version check failed: expected ${migrationCheck.expectedVersion} but found ${migrationCheck.currentVersion === null ? 'none' : migrationCheck.currentVersion}`
                        );
                        error.code = 'SCHEMA_VERSION_MISMATCH';
                        throw error;
                    }
                }

                await this.runStartupKeyMigration();
                return true;
            } catch (error) {
                this.lastFailureReason = error.code || 'POSTGRES_CONNECTION_FAILED';
                this.lastFailureMessage = error.message || 'Unknown PostgreSQL error';

                if (this.pool) {
                    try {
                        await this.pool.end();
                    } catch (closeError) {
                        logger.warn('Failed to close PostgreSQL pool after error:', closeError.message);
                    }
                    this.pool = null;
                }

                const isLastAttempt = attempt >= attempts;
                const isSchemaMismatch = error.code === 'SCHEMA_VERSION_MISMATCH';
                if (isLastAttempt) {
                    logger.error('Failed to initialize PostgreSQL Database:', error);
                    this.isConnected = false;
                    return false;
                }

                if (isSchemaMismatch) {
                    logger.error('Failed to initialize PostgreSQL Database:', error);
                    this.isConnected = false;
                    return false;
                }

                logger.warn(`PostgreSQL connection attempt ${attempt} failed: ${error.message}`);
                const backoff = Math.round(baseDelay * Math.pow(multiplier, attempt - 1));
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }

        this.isConnected = false;
        return false;
    }

    async runStartupKeyMigration() {
        if (pgConfig.features.autoMigrate === false) {
            return;
        }

        try {
            const result = await runKeyMigration({ pool: this.pool, logger });
            if (result?.alreadyDone) {
                logger.debug('Key migration already applied, skipping.');
            } else if (result && (result.migrated > 0 || result.errors > 0)) {
                logger.info('Startup key migration finished', result);
            }
        } catch (error) {
            // Never block startup on key migration; legacy reads still work via fallback.
            logger.error('Startup key migration failed (continuing with legacy fallback):', error);
        }
    }

    /**
     * False only while the database is known to be down (a health check failed) or
     * not set up. A lost idle connection doesn't count: the next query re-checks.
     */
    isAvailable() {
        return Boolean(this.pool) && !this.closing && !this.knownDown;
    }

    getLastFailure() {
        return {
            reason: this.lastFailureReason,
            message: this.lastFailureMessage
        };
    }

    async ensureMigrationLedger() {
        const migrationTable = assertAllowlistedIdentifier(
            pgConfig.migration.table,
            this.allowedMigrationIdentifiers,
            'PostgreSQL migration table identifier'
        );
        const safeMigrationTable = quoteIdentifier(migrationTable);

        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${safeMigrationTable} (
                version INTEGER PRIMARY KEY,
                label VARCHAR(255) NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        return safeMigrationTable;
    }

    async getLatestSchemaVersion() {
        const safeMigrationTable = await this.ensureMigrationLedger();
        const result = await this.pool.query(
            `SELECT version, label, applied_at FROM ${safeMigrationTable} ORDER BY version DESC LIMIT 1`
        );

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0];
    }

    async setSchemaVersion(version, label) {
        const safeMigrationTable = await this.ensureMigrationLedger();
        await this.pool.query(
            `INSERT INTO ${safeMigrationTable} (version, label)
             VALUES ($1, $2)
             ON CONFLICT (version)
             DO UPDATE SET label = EXCLUDED.label, applied_at = CURRENT_TIMESTAMP`,
            [version, label]
        );
    }

    async verifySchemaVersion() {
        const latest = await this.getLatestSchemaVersion();
        const expectedVersion = Number(pgConfig.migration.expectedVersion);

        if (!latest) {
            return {
                ok: false,
                expectedVersion,
                currentVersion: null,
                reason: 'MISSING_MIGRATION_VERSION'
            };
        }

        const currentVersion = Number(latest.version);
        const isValid = currentVersion === expectedVersion;

        return {
            ok: isValid,
            expectedVersion,
            currentVersion,
            label: latest.label,
            appliedAt: latest.applied_at,
            reason: isValid ? 'OK' : 'SCHEMA_VERSION_MISMATCH'
        };
    }

    async createTables() {
        let failures = 0;
        for (const table of tableStatements) {
            try {
                await this.pool.query(table);
            } catch (error) {
                failures += 1;
                logger.error('Error creating table:', error);
            }
        }
        
        logger.info('Database tables created/verified');
        
        failures += await this.createIndexes();
        await this.createAuditTriggers();
        this.lastSchemaFailures = failures;
        return failures;
    }

    async createIndexes() {
        let failures = 0;
        for (const index of indexStatements) {
            try {
                await this.pool.query(index);
            } catch (error) {
                failures += 1;
                logger.warn('Error creating index:', error.message);
            }
        }
        
        logger.info('Performance indexes created/verified');
        return failures;
    }

    async createAuditTriggers() {
        try {
            await this.pool.query(UPDATE_TIMESTAMP_FUNCTION);

            const triggers = triggerDefinitions;

            const allowedTriggerIdentifiers = new Set(triggers.map(trigger => trigger.name));

            for (const trigger of triggers) {
                try {
                    const safeTriggerIdentifier = assertAllowlistedIdentifier(
                        trigger.name,
                        allowedTriggerIdentifiers,
                        'Trigger identifier'
                    );
                    const safeTableIdentifier = assertAllowlistedIdentifier(
                        trigger.table,
                        this.allowedTableIdentifiers,
                        'Trigger table identifier'
                    );

                    await this.pool.query(
                        `DROP TRIGGER IF EXISTS ${quoteIdentifier(safeTriggerIdentifier)} ON ${quoteIdentifier(safeTableIdentifier)};`
                    );
                    await this.pool.query(
                        `CREATE TRIGGER ${quoteIdentifier(safeTriggerIdentifier)}
                         BEFORE UPDATE ON ${quoteIdentifier(safeTableIdentifier)}
                         FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`
                    );
                } catch (error) {
                    logger.warn(`Error creating trigger ${trigger.name} on ${trigger.table}: ${error.message}`);
                }
            }
            
            logger.info('Audit triggers created/verified');
        } catch (error) {
            logger.warn('Error creating audit triggers:', error.message);
        }
    }

    // --- Health -------------------------------------------------------------

    /**
     * Stops trusting the pool after a connection failure. The next query runs a
     * health check first. No check is sent right away: Neon closes idle
     * connections when it scales to zero, and an immediate SELECT 1 would wake it
     * straight back up. Background retries start only when a check fails.
     */
    markUnhealthy(error) {
        if (!this.pool || this.closing) return;
        if (this.isConnected) {
            this.isConnected = false;
            logger.warn(`PostgreSQL connection lost (${error?.message || error}); the next query re-checks it`);
        }
    }

    /** Call with any error from a direct pool query (enforcement tables). */
    noteQueryError(error) {
        if (isConnectionError(error)) this.markUnhealthy(error);
    }

    /** One SELECT 1, shared by everyone waiting on it. Resolves true when the database answers. */
    checkHealth() {
        if (!this.pool) return Promise.resolve(false);
        if (!this.healthCheckPromise) {
            this.healthCheckPromise = this.pool.query('SELECT 1')
                .then(() => {
                    if (this.knownDown) logger.info('PostgreSQL is reachable again');
                    this.isConnected = true;
                    this.knownDown = false;
                    this.healthRetryMs = 0;
                    return true;
                })
                .catch((error) => {
                    this.isConnected = false;
                    if (!this.knownDown) logger.error(`PostgreSQL health check failed: ${error.message}`);
                    this.knownDown = true;
                    this._scheduleHealthCheck();
                    return false;
                })
                .finally(() => {
                    this.healthCheckPromise = null;
                });
        }
        return this.healthCheckPromise;
    }

    _scheduleHealthCheck() {
        if (this.healthTimer || this.closing) return;
        this.healthTimer = setTimeout(async () => {
            this.healthTimer = null;
            if (this.isConnected || await this.checkHealth()) return;
            this.healthRetryMs = Math.min(HEALTH_RETRY_MAX_MS, Math.max(1000, this.healthRetryMs * 2));
            this._scheduleHealthCheck();
        }, this.healthRetryMs);
        this.healthTimer.unref?.();
    }

    /** Throws the typed "database unavailable" error unless a query can be sent now. */
    async ensureAvailable() {
        if (this.isConnected && this.pool) return;
        if (this.pool && !this.closing && await this.checkHealth()) return;
        throw unavailableError();
    }

    async _query(text, params = []) {
        await this.ensureAvailable();
        try {
            return await this.pool.query(text, params);
        } catch (error) {
            this.noteQueryError(error);
            throw asDatabaseError(error, 'PostgreSQL query failed');
        }
    }

    /**
     * Runs fn(client) between BEGIN and COMMIT on one connection; any error rolls
     * back everything fn did and is rethrown.
     */
    async transaction(fn) {
        await this.ensureAvailable();
        let client;
        try {
            client = await this.pool.connect();
        } catch (error) {
            this.noteQueryError(error);
            throw asDatabaseError(error, 'PostgreSQL connect failed');
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
            this.noteQueryError(error);
            throw asDatabaseError(error, 'PostgreSQL transaction failed');
        } finally {
            // A connection-level failure leaves the client unusable; destroy it instead of pooling it.
            client.release(isConnectionError(failure) ? failure : undefined);
        }
    }

    // --- Key/value API ---------------------------------------------------------
    // Missing data returns defaultValue; a failed read or write throws. A read must
    // never turn an outage into defaults that a later write would save.

    async _getTempValue(key, defaultValue = null) {
        const result = await this._query(
            `SELECT value FROM ${pgConfig.tables.temp_data} WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
            [key],
        );
        return result.rows.length > 0 ? result.rows[0].value : defaultValue;
    }

    async _getWithLegacyFallback(canonicalKey, originalKey, defaultValue) {
        let value = await this._getTempValue(canonicalKey, defaultValue);
        if (value !== defaultValue) {
            return value;
        }

        for (const legacyKey of this._legacyKeys(canonicalKey, originalKey)) {
            value = await this._getTempValue(legacyKey, defaultValue);
            if (value !== defaultValue) {
                return value;
            }
        }

        return defaultValue;
    }

    _legacyKeys(canonicalKey, originalKey) {
        return [...new Set([
            ...(originalKey !== canonicalKey ? [originalKey] : []),
            ...getLegacyVariantsForCanonical(canonicalKey),
        ])];
    }

    async get(key, defaultValue = null) {
        const canonicalKey = canonicalizeKey(key);
        const parsedKey = parseKey(canonicalKey);

        if (isTempStored(parsedKey.type)) {
            return await this._getWithLegacyFallback(parsedKey.fullKey, key, defaultValue);
        }

        if (parsedKey.type === 'cache') {
            const result = await this._query(
                `SELECT value FROM ${pgConfig.tables.cache_data} WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
                [parsedKey.fullKey],
            );
            return result.rows.length > 0 ? result.rows[0].value : defaultValue;
        }

        const structuredValue = await this.getStructuredData(parsedKey, defaultValue);
        if (structuredValue !== defaultValue) {
            return structuredValue;
        }

        if (canonicalKey !== key) {
            const legacyParsed = parseKey(key);
            if (legacyParsed.fullKey !== parsedKey.fullKey && STRUCTURED_TYPES.has(legacyParsed.type)) {
                return await this.getStructuredData(legacyParsed, defaultValue);
            }
        }

        return structuredValue;
    }

    /** Saves a value. Resolves true or throws; never reports a failed write as done. */
    async set(key, value, ttl = null) {
        const canonicalKey = canonicalizeKey(key);
        const parsedKey = parseKey(canonicalKey);
        const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;
        const jsonValue = JSON.stringify(value ?? null);

        if (isTempStored(parsedKey.type)) {
            await this._query(
                `INSERT INTO ${pgConfig.tables.temp_data} (key, value, expires_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (key) DO UPDATE SET value = $2, expires_at = $3`,
                [parsedKey.fullKey, jsonValue, expiresAt],
            );
            return true;
        }

        if (parsedKey.type === 'cache') {
            await this._query(
                `INSERT INTO ${pgConfig.tables.cache_data} (key, value, expires_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (key) DO UPDATE SET value = $2, expires_at = $3`,
                [parsedKey.fullKey, jsonValue, expiresAt],
            );
            return true;
        }

        return await this.setStructuredData(parsedKey, value, ttl);
    }

    async delete(key) {
        const canonicalKey = canonicalizeKey(key);
        const parsedKey = parseKey(canonicalKey);
        let deleted = false;

        if (isTempStored(parsedKey.type)) {
            await this._query(`DELETE FROM ${pgConfig.tables.temp_data} WHERE key = $1`, [parsedKey.fullKey]);
            deleted = true;
        } else if (parsedKey.type === 'cache') {
            await this._query(`DELETE FROM ${pgConfig.tables.cache_data} WHERE key = $1`, [parsedKey.fullKey]);
            deleted = true;
        } else {
            deleted = await this.deleteStructuredData(parsedKey);
        }

        const legacyKeys = this._legacyKeys(canonicalKey, key);
        if (legacyKeys.length > 0) {
            await this._query(`DELETE FROM ${pgConfig.tables.temp_data} WHERE key = ANY($1::text[])`, [legacyKeys]);
        }

        return deleted;
    }

    async list(prefix) {
        const keys = new Set();
        const plan = getStructuredListPlan(prefix, pgConfig.tables);
        const tempPrefixes = plan.tempPrefixes ?? [prefix];

        for (const tempPrefix of tempPrefixes) {
            const tempResult = await this._query(
                `SELECT key FROM ${pgConfig.tables.temp_data} WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > NOW())`,
                [`${tempPrefix}%`],
            );
            for (const row of tempResult.rows) {
                keys.add(canonicalizeKey(row.key));
            }
        }

        const cacheResult = await this._query(
            `SELECT key FROM ${pgConfig.tables.cache_data} WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > NOW())`,
            [`${prefix}%`],
        );
        for (const row of cacheResult.rows) {
            keys.add(row.key);
        }

        for (const query of plan.queries) {
            const result = await this._query(query.sql, query.params);
            for (const row of result.rows) {
                keys.add(query.mapKey(row));
            }
        }

        for (const staticKey of plan.staticKeys ?? []) {
            if (!staticKey.startsWith(prefix)) continue;
            if (await this.exists(staticKey)) {
                keys.add(staticKey);
            }
        }

        return [...keys];
    }

    async insertVerificationAudit(record) {
        const {
            guildId,
            userId,
            action,
            source = null,
            moderatorId = null,
            metadata = {},
            createdAt = new Date()
        } = record;

        const timestamp = createdAt instanceof Date ? createdAt : new Date(createdAt);

        await this._query(
            `INSERT INTO ${pgConfig.tables.verification_audit} (guild_id, user_id, action, source, moderator_id, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [guildId, userId, action, source, moderatorId, metadata, timestamp]
        );

        return true;
    }

    async exists(key) {
        return (await this.get(key)) !== null;
    }

    async increment(key, amount = 1) {
        return this.update(key, (current) => (typeof current === 'number' ? current : 0) + amount, 0);
    }

    async decrement(key, amount = 1) {
        return this.increment(key, -amount);
    }

    // --- Atomic read-modify-write ------------------------------------------------

    /**
     * Where update() can lock a single JSON value: the statements that create the
     * row if missing, select it FOR UPDATE, and write it back.
     */
    _lockedCell(parsedKey, originalKey) {
        const t = pgConfig.tables;
        const ensureGuild = { sql: `INSERT INTO ${t.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING RETURNING id`, params: [parsedKey.guildId] };

        if (isTempStored(parsedKey.type)) {
            const key = parsedKey.fullKey;
            return {
                ensure: [{ sql: `INSERT INTO ${t.temp_data} (key, value) VALUES ($1, 'null'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`, params: [key] }],
                select: { sql: `SELECT value, (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired FROM ${t.temp_data} WHERE key = $1 FOR UPDATE`, params: [key] },
                read: (row) => (row && !row.expired ? row.value : null),
                write: (value) => ({
                    sql: `UPDATE ${t.temp_data} SET value = $2, expires_at = CASE WHEN expires_at <= NOW() THEN NULL ELSE expires_at END WHERE key = $1`,
                    params: [key, JSON.stringify(value ?? null)],
                }),
                legacyKeys: this._legacyKeys(key, originalKey),
            };
        }

        switch (parsedKey.type) {
            case 'guild_config':
            case 'counters': {
                const column = parsedKey.type === 'guild_config' ? 'config' : 'counters';
                return {
                    ensure: [ensureGuild],
                    select: { sql: `SELECT ${column} AS value FROM ${t.guilds} WHERE id = $1 FOR UPDATE`, params: [parsedKey.guildId] },
                    read: (row) => row?.value ?? null,
                    write: (value) => ({
                        sql: `UPDATE ${t.guilds} SET ${column} = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                        params: [parsedKey.guildId, JSON.stringify(value ?? (column === 'counters' ? [] : {}))],
                    }),
                };
            }
            case 'welcome_config':
            case 'leveling_config': {
                const table = parsedKey.type === 'welcome_config' ? t.welcome_configs : t.leveling_configs;
                return {
                    ensure: [ensureGuild, { sql: `INSERT INTO ${table} (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING RETURNING guild_id`, params: [parsedKey.guildId] }],
                    select: { sql: `SELECT config AS value FROM ${table} WHERE guild_id = $1 FOR UPDATE`, params: [parsedKey.guildId] },
                    read: (row) => row?.value ?? null,
                    write: (value) => ({
                        sql: `UPDATE ${table} SET config = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $1`,
                        params: [parsedKey.guildId, JSON.stringify(value ?? {})],
                    }),
                };
            }
            default:
                throw new Error(`update() does not support key type ${parsedKey.type} (${parsedKey.fullKey})`);
        }
    }

    /**
     * Atomic read-modify-write: locks the value's row, passes the current value (or
     * a copy of defaultValue when there is none) to mutator, and saves what it
     * returns, all in one transaction. Concurrent updates of the same key wait for
     * each other, and a failure at any point leaves the stored value untouched.
     */
    async update(key, mutator, defaultValue = null) {
        const parsedKey = parseKey(canonicalizeKey(key));
        const cell = this._lockedCell(parsedKey, key);
        return this.transaction(async (client) => {
            let created = false;
            for (const statement of cell.ensure) {
                const result = await client.query(statement.sql, statement.params);
                created = result.rowCount > 0;
            }
            const { rows } = await client.query(cell.select.sql, cell.select.params);
            let current = created ? null : cell.read(rows[0]);
            if ((current === null || current === undefined) && cell.legacyKeys?.length) {
                const legacy = await client.query(
                    `SELECT value FROM ${pgConfig.tables.temp_data} WHERE key = ANY($1::text[]) AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
                    [cell.legacyKeys],
                );
                current = legacy.rows[0]?.value ?? null;
            }
            const next = await mutator(current === null || current === undefined ? clone(defaultValue) : current);
            const write = cell.write(next);
            await client.query(write.sql, write.params);
            return next;
        });
    }

    // --- Row-level writes for collections ------------------------------------------
    // One member's birthday or one giveaway is written on its own, so concurrent
    // changes to other rows can't be overwritten by a stale copy of the collection.

    async upsertBirthday(guildId, userId, month, day) {
        await this.transaction(async (client) => {
            await client.query(`INSERT INTO ${pgConfig.tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [guildId]);
            await client.query(`INSERT INTO ${pgConfig.tables.users} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [userId]);
            await client.query(
                `INSERT INTO ${pgConfig.tables.birthdays} (guild_id, user_id, month, day) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (guild_id, user_id) DO UPDATE SET month = $3, day = $4`,
                [guildId, userId, month, day],
            );
        });
        return true;
    }

    async deleteBirthday(guildId, userId) {
        const result = await this._query(`DELETE FROM ${pgConfig.tables.birthdays} WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
        return result.rowCount > 0;
    }

    async upsertGiveaway(guildId, giveaway) {
        await this.transaction(async (client) => {
            await client.query(`INSERT INTO ${pgConfig.tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [guildId]);
            await client.query(
                `INSERT INTO ${pgConfig.tables.giveaways} (guild_id, message_id, data, ends_at)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (guild_id, message_id) DO UPDATE SET data = $3, ends_at = $4, updated_at = CURRENT_TIMESTAMP`,
                [guildId, String(giveaway.messageId), giveaway, giveaway.endsAt ? new Date(giveaway.endsAt) : null],
            );
        });
        return true;
    }

    async deleteGiveaway(guildId, messageId) {
        const result = await this._query(`DELETE FROM ${pgConfig.tables.giveaways} WHERE guild_id = $1 AND message_id = $2`, [guildId, String(messageId)]);
        return result.rowCount > 0;
    }

    // --- Row-level reads ------------------------------------------------------------

    /** One page of a guild's level leaderboard, highest level first. */
    async topUserLevels(guildId, limit = 10, offset = 0) {
        const result = await this._query(
            `SELECT user_id, xp, level, total_xp FROM ${pgConfig.tables.user_levels}
             WHERE guild_id = $1 AND (total_xp > 0 OR level > 0)
             ORDER BY level DESC, total_xp DESC, xp DESC, user_id
             LIMIT $2 OFFSET $3`,
            [guildId, limit, offset],
        );
        return result.rows.map((row) => ({
            userId: row.user_id,
            xp: Number(row.xp) || 0,
            level: Number(row.level) || 0,
            totalXp: Number(row.total_xp) || 0,
        }));
    }

    // --- Structured tables ---------------------------------------------------------

    async getStructuredData(parsedKey, defaultValue) {
        switch (parsedKey.type) {
            case 'guild_config': {
                const guildResult = await this._query(
                    `SELECT config FROM ${pgConfig.tables.guilds} WHERE id = $1`,
                    [parsedKey.guildId]
                );
                return guildResult.rows[0]?.config ?? defaultValue;
            }

            case 'guild_birthdays': {
                const birthdayResult = await this._query(
                    `SELECT user_id, month, day FROM ${pgConfig.tables.birthdays} WHERE guild_id = $1`,
                    [parsedKey.guildId]
                );
                const birthdays = {};
                birthdayResult.rows.forEach(row => {
                    birthdays[row.user_id] = { month: row.month, day: row.day };
                });
                return birthdays;
            }

            case 'guild_giveaways': {
                const giveawayResult = await this._query(
                    `SELECT data FROM ${pgConfig.tables.giveaways} WHERE guild_id = $1`,
                    [parsedKey.guildId]
                );
                return giveawayResult.rows.map(row => row.data);
            }

            case 'welcome_config': {
                const welcomeResult = await this._query(
                    `SELECT config FROM ${pgConfig.tables.welcome_configs} WHERE guild_id = $1`,
                    [parsedKey.guildId]
                );
                return welcomeResult.rows.length > 0 ? welcomeResult.rows[0].config : defaultValue;
            }

            case 'leveling_config': {
                const levelingConfigResult = await this._query(
                    `SELECT config FROM ${pgConfig.tables.leveling_configs} WHERE guild_id = $1`,
                    [parsedKey.guildId]
                );
                return levelingConfigResult.rows.length > 0 ? levelingConfigResult.rows[0].config : defaultValue;
            }

            case 'user_level': {
                const userLevelResult = await this._query(
                    `SELECT xp, level, total_xp, last_message, rank FROM ${pgConfig.tables.user_levels} WHERE guild_id = $1 AND user_id = $2`,
                    [parsedKey.guildId, parsedKey.userId]
                );
                if (userLevelResult.rows.length === 0) return defaultValue;
                // Map snake_case columns to the camelCase shape consumers expect
                const levelRow = userLevelResult.rows[0];
                return {
                    xp: Number(levelRow.xp) || 0,
                    level: Number(levelRow.level) || 0,
                    totalXp: Number(levelRow.total_xp) || 0,
                    lastMessage: Number(levelRow.last_message) || 0,
                    rank: Number(levelRow.rank) || 0,
                };
            }

            case 'economy': {
                const economyResult = await this._query(
                    `SELECT balance, bank, data FROM ${pgConfig.tables.economy} WHERE guild_id = $1 AND user_id = $2`,
                    [parsedKey.guildId, parsedKey.userId]
                );
                if (economyResult.rows.length === 0) return defaultValue;
                const row = economyResult.rows[0];

                if (row.data && typeof row.data === 'object' && Object.keys(row.data).length > 0) {
                    return row.data;
                }
                return { wallet: row.balance ?? 0, bank: row.bank ?? 0 };
            }

            case 'afk_status': {
                const afkResult = await this._query(
                    `SELECT reason, status_at, expires_at FROM ${pgConfig.tables.afk_status} WHERE guild_id = $1 AND user_id = $2`,
                    [parsedKey.guildId, parsedKey.userId],
                );
                if (afkResult.rows.length === 0) return defaultValue;
                const row = afkResult.rows[0];
                return {
                    reason: row.reason,
                    setAt: row.status_at,
                    expiresAt: row.expires_at,
                };
            }

            case 'ticket': {
                const ticketResult = await this._query(
                    `SELECT data FROM ${pgConfig.tables.tickets} WHERE guild_id = $1 AND channel_id = $2`,
                    [parsedKey.guildId, parsedKey.channelId]
                );
                return ticketResult.rows.length > 0 ? ticketResult.rows[0].data : defaultValue;
            }

            case 'counters': {
                const counterResult = await this._query(
                    `SELECT counters FROM ${pgConfig.tables.guilds} WHERE id = $1`,
                    [parsedKey.guildId]
                );
                return counterResult.rows[0]?.counters ?? defaultValue;
            }

            default:
                throw new Error(`No structured table for key type ${parsedKey.type} (${parsedKey.fullKey})`);
        }
    }

    async setStructuredData(parsedKey, value, ttl) {
        const t = pgConfig.tables;
        const ensureGuild = (runner = this) => (runner === this ? this._query.bind(this) : runner.query.bind(runner))(
            `INSERT INTO ${t.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
            [parsedKey.guildId]
        );

        switch (parsedKey.type) {
            case 'guild_config':
                await this._query(
                    `INSERT INTO ${t.guilds} (id, config, updated_at)
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (id) DO UPDATE SET config = $2, updated_at = CURRENT_TIMESTAMP`,
                    [parsedKey.guildId, value]
                );
                return true;

            case 'guild_birthdays': {
                // Whole-collection write (imports, restores). Upsert every row and delete
                // the rest in one transaction, so a failure midway changes nothing.
                // Day-to-day changes use upsertBirthday/deleteBirthday instead.
                const entries = Object.entries(value || {});
                await this.transaction(async (client) => {
                    await ensureGuild(client);
                    for (const [userId, birthday] of entries) {
                        await client.query(`INSERT INTO ${t.users} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [userId]);
                        await client.query(
                            `INSERT INTO ${t.birthdays} (guild_id, user_id, month, day) VALUES ($1, $2, $3, $4)
                             ON CONFLICT (guild_id, user_id) DO UPDATE SET month = $3, day = $4`,
                            [parsedKey.guildId, userId, birthday.month, birthday.day]
                        );
                    }
                    await client.query(
                        `DELETE FROM ${t.birthdays} WHERE guild_id = $1 AND NOT (user_id = ANY($2::varchar[]))`,
                        [parsedKey.guildId, entries.map(([userId]) => userId)]
                    );
                });
                return true;
            }

            case 'guild_giveaways': {
                // Whole-collection write, same rules as birthdays; saveGiveaway uses upsertGiveaway.
                const giveaways = (Array.isArray(value)
                    ? value
                    : (value && typeof value === 'object' ? Object.values(value) : [])
                ).filter(giveaway => giveaway?.messageId);

                await this.transaction(async (client) => {
                    await ensureGuild(client);
                    for (const giveaway of giveaways) {
                        await client.query(
                            `INSERT INTO ${t.giveaways} (guild_id, message_id, data, ends_at)
                             VALUES ($1, $2, $3, $4)
                             ON CONFLICT (guild_id, message_id) DO UPDATE SET data = $3, ends_at = $4, updated_at = CURRENT_TIMESTAMP`,
                            [parsedKey.guildId, String(giveaway.messageId), giveaway, giveaway.endsAt ? new Date(giveaway.endsAt) : null]
                        );
                    }
                    await client.query(
                        `DELETE FROM ${t.giveaways} WHERE guild_id = $1 AND NOT (message_id = ANY($2::varchar[]))`,
                        [parsedKey.guildId, giveaways.map(giveaway => String(giveaway.messageId))]
                    );
                });
                return true;
            }

            case 'welcome_config':
            case 'leveling_config': {
                const table = parsedKey.type === 'welcome_config' ? t.welcome_configs : t.leveling_configs;
                await ensureGuild();
                await this._query(
                    `INSERT INTO ${table} (guild_id, config, updated_at)
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (guild_id) DO UPDATE SET config = $2, updated_at = CURRENT_TIMESTAMP`,
                    [parsedKey.guildId, value]
                );
                return true;
            }

            case 'user_level':
                await this.transaction(async (client) => {
                    await ensureGuild(client);
                    await client.query(`INSERT INTO ${t.users} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [parsedKey.userId]);
                    await client.query(
                        `INSERT INTO ${t.user_levels} (guild_id, user_id, xp, level, total_xp, last_message, rank, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
                         ON CONFLICT (guild_id, user_id) DO UPDATE SET
                         xp = $3, level = $4, total_xp = $5, last_message = $6, rank = $7, updated_at = CURRENT_TIMESTAMP`,
                        [parsedKey.guildId, parsedKey.userId, value.xp || 0, value.level || 0, value.totalXp || 0, value.lastMessage || new Date(), value.rank || 0]
                    );
                });
                return true;

            case 'economy':
                await this.transaction(async (client) => {
                    await ensureGuild(client);
                    await client.query(`INSERT INTO ${t.users} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [parsedKey.userId]);
                    await client.query(
                        `INSERT INTO ${t.economy} (guild_id, user_id, balance, bank, data, updated_at)
                         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                         ON CONFLICT (guild_id, user_id) DO UPDATE SET
                         balance = $3, bank = $4, data = $5, updated_at = CURRENT_TIMESTAMP`,
                        [parsedKey.guildId, parsedKey.userId, value.wallet ?? value.balance ?? 0, value.bank ?? 0, value]
                    );
                });
                return true;

            case 'afk_status':
                await this.transaction(async (client) => {
                    await ensureGuild(client);
                    await client.query(`INSERT INTO ${t.users} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [parsedKey.userId]);
                    await client.query(
                        `INSERT INTO ${t.afk_status} (guild_id, user_id, reason, expires_at)
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (guild_id, user_id) DO UPDATE SET
                         reason = $3, expires_at = $4, status_at = CURRENT_TIMESTAMP`,
                        [parsedKey.guildId, parsedKey.userId, value.reason, (value.expiresAt ?? value.expires_at) ? new Date(value.expiresAt ?? value.expires_at) : null]
                    );
                });
                return true;

            case 'ticket':
                await ensureGuild();
                await this._query(
                    `INSERT INTO ${t.tickets} (guild_id, channel_id, data, expires_at)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (channel_id) DO UPDATE SET
                     data = $3, expires_at = $4, updated_at = CURRENT_TIMESTAMP`,
                    [parsedKey.guildId, parsedKey.channelId, value, ttl ? new Date(Date.now() + ttl * 1000) : null]
                );
                return true;

            case 'counters':
                await this._query(
                    `INSERT INTO ${t.guilds} (id, counters, updated_at)
                     VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
                     ON CONFLICT (id) DO UPDATE SET counters = $2::jsonb, updated_at = CURRENT_TIMESTAMP`,
                    [parsedKey.guildId, JSON.stringify(Array.isArray(value) ? value : [])]
                );
                return true;

            default:
                throw new Error(`No structured table for key type ${parsedKey.type} (${parsedKey.fullKey})`);
        }
    }

    async deleteStructuredData(parsedKey) {
        const t = pgConfig.tables;
        switch (parsedKey.type) {
            case 'guild_config':
                await this._query(`DELETE FROM ${t.guilds} WHERE id = $1`, [parsedKey.guildId]);
                return true;

            case 'guild_birthdays':
                await this._query(`DELETE FROM ${t.birthdays} WHERE guild_id = $1`, [parsedKey.guildId]);
                return true;

            case 'guild_giveaways':
                await this._query(`DELETE FROM ${t.giveaways} WHERE guild_id = $1`, [parsedKey.guildId]);
                return true;

            case 'welcome_config':
                await this._query(`DELETE FROM ${t.welcome_configs} WHERE guild_id = $1`, [parsedKey.guildId]);
                return true;

            case 'leveling_config':
                await this._query(`DELETE FROM ${t.leveling_configs} WHERE guild_id = $1`, [parsedKey.guildId]);
                return true;

            case 'user_level':
                await this._query(`DELETE FROM ${t.user_levels} WHERE guild_id = $1 AND user_id = $2`, [parsedKey.guildId, parsedKey.userId]);
                return true;

            case 'economy':
                await this._query(`DELETE FROM ${t.economy} WHERE guild_id = $1 AND user_id = $2`, [parsedKey.guildId, parsedKey.userId]);
                return true;

            case 'afk_status':
                await this._query(`DELETE FROM ${t.afk_status} WHERE guild_id = $1 AND user_id = $2`, [parsedKey.guildId, parsedKey.userId]);
                return true;

            case 'ticket':
                await this._query(`DELETE FROM ${t.tickets} WHERE guild_id = $1 AND channel_id = $2`, [parsedKey.guildId, parsedKey.channelId]);
                return true;

            case 'counters':
                await this._query(
                    `UPDATE ${t.guilds} SET counters = '[]'::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [parsedKey.guildId],
                );
                return true;

            default:
                throw new Error(`No structured table for key type ${parsedKey.type} (${parsedKey.fullKey})`);
        }
    }

    async disconnect() {
        this.closing = true;
        clearTimeout(this.healthTimer);
        this.healthTimer = null;
        try {
            if (this.pool) {
                await this.pool.end();
                logger.info('PostgreSQL connection closed');
            }
        } catch (error) {
            logger.error('Error closing PostgreSQL connection:', error);
        }
    }

    async getInfo() {
        try {
            if (!this.isAvailable()) {
                return null;
            }

            const result = await this.pool.query('SELECT version()');
            return {
                version: result.rows[0].version,
                connected: this.isConnected,
                poolSize: this.pool.totalCount,
                idleCount: this.pool.idleCount,
                waitingCount: this.pool.waitingCount
            };
        } catch (error) {
            logger.error('Error getting PostgreSQL info:', error);
            return null;
        }
    }
}

const pgDb = new PostgreSQLDatabase();

export { PostgreSQLDatabase, pgDb };