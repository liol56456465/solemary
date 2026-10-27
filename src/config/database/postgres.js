import fs from 'node:fs';
import { assertAllowlistedIdentifier } from '../../utils/sqlIdentifiers.js';
import { EXPECTED_SCHEMA_LABEL, EXPECTED_SCHEMA_VERSION } from './schemaVersion.js';

const configuredTables = {
    guilds: 'guilds',
    users: 'users',
    guild_users: 'guild_users',
    birthdays: 'birthdays',
    giveaways: 'giveaways',
    tickets: 'ticket_data',
    afk_status: 'afk_status',
    welcome_configs: 'welcome_configs',
    leveling_configs: 'leveling_configs',
    user_levels: 'user_levels',
    economy: 'economy',
    invite_tracking: 'invite_tracking',
    application_roles: 'application_roles',
    verification_audit: 'verification_audit',
    temp_data: 'temp_data',
    cache_data: 'cache_data',
    mod_cases: 'mod_cases',
    mod_ladder: 'mod_ladder',
    mod_appeals: 'mod_appeals',
    mod_case_edits: 'mod_case_edits',
    mod_case_evidence: 'mod_case_evidence',
    enforcement_settings: 'enforcement_settings',
    staff_warnings: 'staff_warnings',
    verification_ips: 'verification_ips',
    staff_activity: 'staff_activity',
    server_snapshots: 'server_snapshots',
};

const allowedTableIdentifiers = new Set([
    'guilds',
    'users',
    'guild_users',
    'birthdays',
    'giveaways',
    'ticket_data',
    'afk_status',
    'welcome_configs',
    'leveling_configs',
    'user_levels',
    'economy',
    'invite_tracking',
    'application_roles',
    'verification_audit',
    'temp_data',
    'cache_data',
    'mod_cases',
    'mod_ladder',
    'mod_appeals',
    'mod_case_edits',
    'mod_case_evidence',
    'enforcement_settings',
    'staff_warnings',
    'verification_ips',
    'staff_activity',
    'server_snapshots',
]);

const validatedTables = Object.fromEntries(
    Object.entries(configuredTables).map(([key, value]) => [
        key,
        assertAllowlistedIdentifier(value, allowedTableIdentifiers, `PostgreSQL table identifier (${key})`),
    ])
);

const DEFAULT_POSTGRES_URL = 'postgresql://localhost:5432/titanbot';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);
// pg lets these URL parameters override the ssl option; they are stripped so the
// code below is the only thing deciding (sslmode=require used to mean "verify"
// and becomes "don't verify" in pg v9).
const SSL_URL_PARAMS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

function databaseUrl() {
    return (process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^\[|\]$/g, '');
    } catch {
        return '';
    }
}

/**
 * TLS settings for a database URL. Remote hosts (Neon) always get TLS with
 * certificate and hostname verification, whatever the URL says. Only a local
 * database may run without TLS. POSTGRES_SSL=no-verify is the explicit escape
 * hatch for a provider with a self-signed certificate.
 */
export function resolveSslConfig(url = databaseUrl()) {
    const host = hostOf(url) || process.env.POSTGRES_HOST || 'localhost';
    const sslEnv = process.env.POSTGRES_SSL?.toLowerCase();
    if (LOCAL_HOSTS.has(host)) {
        return sslEnv === 'true' || sslEnv === '1' ? { rejectUnauthorized: true } : false;
    }
    const ca = caFromEnv();
    if (sslEnv === 'no-verify') {
        if (ca) throw new Error('POSTGRES_SSL=no-verify and a CA certificate are both set; remove one (verification stays on with the CA)');
        return { rejectUnauthorized: false };
    }
    // With a CA (Supabase signs with its own root), only that CA is trusted.
    return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

/**
 * The database's CA certificate, for providers whose root is not publicly
 * trusted (Supabase: "Supabase Root 2021 CA", prod-ca-2021.crt). POSTGRES_CA_CERT
 * holds the PEM text (a secret can store "\n" for line breaks); POSTGRES_CA_FILE
 * is a path to it.
 */
function caFromEnv() {
    const pem = process.env.POSTGRES_CA_CERT?.trim();
    if (pem) return pem.replace(/\\n/g, '\n');
    const file = process.env.POSTGRES_CA_FILE?.trim();
    return file ? fs.readFileSync(file, 'utf8') : undefined;
}

/** The URL without TLS parameters, so pg can't override resolveSslConfig(). */
export function sanitizeConnectionString(url) {
    try {
        const parsed = new URL(url);
        for (const param of SSL_URL_PARAMS) parsed.searchParams.delete(param);
        return parsed.toString();
    } catch {
        return url;
    }
}

function intFromEnv(name, fallback) {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isFinite(value) ? value : fallback;
}

export function resolvePostgresPoolConfig() {
    const url = databaseUrl();
    const sharedOptions = {
        max: intFromEnv('POSTGRES_MAX_CONNECTIONS', 20),
        // 0 lets idle connections close; Neon drops them anyway when it scales to zero.
        min: intFromEnv('POSTGRES_MIN_CONNECTIONS', 0),
        idleTimeoutMillis: intFromEnv('POSTGRES_IDLE_TIMEOUT', 30000),
        connectionTimeoutMillis: intFromEnv('POSTGRES_CONNECTION_TIMEOUT', 10000),
        application_name: 'titanbot',
        statement_timeout: process.env.NODE_ENV === 'production' ? 30000 : 0,
        keepAlive: true,
        keepAliveInitialDelayMillis: 30000,
        ssl: resolveSslConfig(url),
    };

    if (url && url !== DEFAULT_POSTGRES_URL) {
        return { connectionString: sanitizeConnectionString(url), ...sharedOptions };
    }

    return {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT) || 5432,
        database: process.env.POSTGRES_DB || 'titanbot',
        user: process.env.POSTGRES_USER || 'postgres',
        password: (process.env.POSTGRES_PASSWORD || '').toString(),
        ...sharedOptions,
    };
}

export const pgConfig = {
    url: process.env.POSTGRES_URL || process.env.DATABASE_URL || DEFAULT_POSTGRES_URL,
    
    options: {
        
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT) || 5432,
        database: process.env.POSTGRES_DB || 'titanbot',
        user: process.env.POSTGRES_USER || 'postgres',
        password: (process.env.POSTGRES_PASSWORD || '').toString(),
        ssl: resolveSslConfig(),

        max: intFromEnv('POSTGRES_MAX_CONNECTIONS', 20),
        min: intFromEnv('POSTGRES_MIN_CONNECTIONS', 0),
        idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT) || 30000,
        connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT) || 10000,

        application_name: 'titanbot',
        statement_timeout: process.env.NODE_ENV === 'production' ? 30000 : 0,
        keepalives: 1,
        keepalives_idle: 30,

        retries: parseInt(process.env.POSTGRES_RETRIES) || 3,
        backoffBase: parseInt(process.env.POSTGRES_BACKOFF_BASE) || 100,
        backoffMultiplier: parseInt(process.env.POSTGRES_BACKOFF_MULTIPLIER) || 2,
    },
    
    tables: validatedTables,
    
    defaultTTL: {
        userSession: 86400,
        
        temp: 3600,
        
        cache: 1800,
        
        guildConfig: null,
        
        economy: null,
        
        leveling: null,
        
        giveaway: null,
        
        ticket: 604800,
        
        afk: 86400,
        
        welcome: null,
        
        birthday: null,
    },
    
    features: {
        pooling: true,
        ssl: process.env.NODE_ENV === 'production',
        
        metrics: true,
        
        debug: process.env.NODE_ENV === 'development',
        
        autoCreateTables: true,
        
        autoMigrate: process.env.AUTO_MIGRATE !== 'false',
    },
    
    healthCheck: {
        enabled: true,
        
        interval: 30000,
        
        maxFailures: 3,
        
        query: 'SELECT 1',
    },
    
    migration: {
        enabled: true,
        
        table: 'schema_migrations',
        
        directory: 'database/migrations',
        
        rollbackOnFailure: false,

        expectedVersion: EXPECTED_SCHEMA_VERSION,

        expectedLabel: EXPECTED_SCHEMA_LABEL,
    }
};

export default pgConfig;