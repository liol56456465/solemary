import { pgDb } from '../postgresDatabase.js';
import { MemoryStorage } from '../memoryStorage.js';
import { logger } from '../logger.js';
import { validateGuildConfigOrThrow } from '../schemas.js';
import { Mutex } from '../mutex.js';

const GUILD_CONFIG_KEY = /^guild:[^:]+:config$/;

// Production (NODE_ENV=production, or any Replit deployment) must not silently run on
// in-memory storage; ALLOW_MEMORY_DB=true is the explicit opt-out.
function memoryFallbackAllowed() {
    const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.REPLIT_DEPLOYMENT);
    return !isProduction || process.env.ALLOW_MEMORY_DB === 'true';
}

function validateIfGuildConfig(key, value) {
    if (typeof key === 'string' && GUILD_CONFIG_KEY.test(key)) {
        validateGuildConfigOrThrow(value, { guildId: key.split(':')[1], errorCode: 'VALIDATION_FAILED' });
    }
}

class DatabaseWrapper {
    constructor() {
        this.initialized = false;
        this.db = null;
        this.useFallback = false;
        this.connectionType = 'none';
        this.degradedModeWarningShown = false;
        this.degradedReason = null;
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        try {
            logger.info('Attempting to connect to PostgreSQL...');
            const pgConnected = await pgDb.connect();
            if (pgConnected) {
                this.db = pgDb;
                this.connectionType = 'postgresql';
                this.degradedReason = null;
                logger.info('✅ PostgreSQL Database initialized - using persistent database');
                this.initialized = true;
                return;
            }

            const pgFailure = pgDb.getLastFailure?.();
            if (pgFailure?.reason === 'SCHEMA_VERSION_MISMATCH') {
                const schemaError = new Error(
                    `Schema version mismatch detected (${pgFailure.message}). Run migrations before startup.`,
                );
                schemaError.code = 'SCHEMA_VERSION_MISMATCH';
                throw schemaError;
            }
        } catch (error) {
            logger.warn('PostgreSQL connection failed:', error.message);

            if (error.code === 'SCHEMA_VERSION_MISMATCH') {
                throw error;
            }
        }

        if (!memoryFallbackAllowed()) {
            const requiredError = new Error(
                'PostgreSQL is unavailable and in-memory storage is not allowed in production ' +
                '(data would be lost on restart). Fix DATABASE_URL, or set ALLOW_MEMORY_DB=true to accept that.',
            );
            requiredError.code = 'DATABASE_REQUIRED';
            throw requiredError;
        }

        this.db = new MemoryStorage();
        this.useFallback = true;
        this.connectionType = 'memory';
        this.degradedReason = 'POSTGRES_UNAVAILABLE';
        logger.warn('⚠️ DATABASE DEGRADED MODE ENABLED - Using in-memory storage (data will be lost on restart)');
        logger.warn('⚠️ Please check PostgreSQL connection and restart the bot when fixed');
        this.initialized = true;
        this.degradedModeWarningShown = true;
    }

    async set(key, value, ttl = null) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Writing to memory: ${key}`);
        }

        validateIfGuildConfig(key, value);
        return this.db.set(key, value, ttl);
    }

    /**
     * Atomic read-modify-write: mutator(current) returns the new value, which is
     * saved and returned. On Postgres the row is locked for the whole step; a
     * failure anywhere leaves the stored value as it was.
     */
    async update(key, mutator, defaultValue = null) {
        const checked = async (current) => {
            const next = await mutator(current);
            validateIfGuildConfig(key, next);
            return next;
        };
        if (typeof this.db.update === 'function') {
            return this.db.update(key, checked, defaultValue);
        }
        // In-memory fallback: serialize per key so concurrent updates don't interleave.
        return Mutex.runExclusive(`db-update:${key}`, async () => {
            const current = await this.db.get(key, null);
            const next = await checked(current ?? structuredClone(defaultValue));
            await this.db.set(key, next);
            return next;
        });
    }

    /** Postgres-only row writes (birthdays, giveaways); null when running on memory. */
    rows() {
        return this.useFallback ? null : this.db;
    }

    async get(key, defaultValue = null) {
        return this.db.get(key, defaultValue);
    }

    async delete(key) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Deleting from memory: ${key}`);
        }
        return this.db.delete(key);
    }

    async list(prefix) {
        return this.db.list(prefix);
    }

    async exists(key) {
        if (this.db.exists) {
            return this.db.exists(key);
        }
        const value = await this.db.get(key);
        return value !== null;
    }

    async increment(key, amount = 1) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Incrementing in memory: ${key}`);
        }
        if (this.db.increment) {
            return this.db.increment(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current + amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    async decrement(key, amount = 1) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Decrementing in memory: ${key}`);
        }
        if (this.db.decrement) {
            return this.db.decrement(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current - amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    isDegraded() {
        return this.useFallback;
    }

    isAvailable() {
        return this.db && !this.useFallback;
    }

    getStatus() {
        return {
            initialized: this.initialized,
            connectionType: this.connectionType,
            isDegraded: this.useFallback,
            isAvailable: this.isAvailable(),
            degradedReason: this.degradedReason,
        };
    }

    getConnectionType() {
        return this.connectionType;
    }
}

export const db = new DatabaseWrapper();

export async function initializeDatabase() {
    try {
        logger.info('Initializing Database (PostgreSQL > Memory fallback)...');
        await db.initialize();
        logger.info('✅ Database initialized');
        return { db };
    } catch (error) {
        logger.error('❌ Database Initialization Error:', error);

        if (error.code === 'SCHEMA_VERSION_MISMATCH' || error.code === 'DATABASE_REQUIRED') {
            throw error;
        }

        return { db };
    }
}

// These pass database errors on: a failed read must not look like "no data",
// and a failed write must not look saved.
export async function getFromDb(key, defaultValue = null) {
    const value = await db.get(key);
    return value === null ? defaultValue : value;
}

export async function setInDb(key, value, ttl = null) {
    await db.set(key, value, ttl);
    return true;
}

export async function deleteFromDb(key) {
    await db.delete(key);
    return true;
}
