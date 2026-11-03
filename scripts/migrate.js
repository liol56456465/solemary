import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../src/utils/logger.js';
import { EXPECTED_SCHEMA_LABEL, EXPECTED_SCHEMA_VERSION } from '../src/config/database/schemaVersion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Skip .env when started with --env-file (e.g. .env.test) so production values never leak in.
if (!process.execArgv.some((arg) => arg.startsWith('--env-file'))) {
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
}

// Imported after dotenv.config so resolveSslConfig sees the loaded env vars.
const { resolveSslConfig, sanitizeConnectionString } = await import('../src/config/database/postgres.js');
// The schema is the single source of truth shared with the runtime auto-create
// path (src/utils/postgresDatabase.js), so this script can never diverge from it.
const {
  tableStatements,
  indexStatements,
  UPDATE_TIMESTAMP_FUNCTION,
  triggerDefinitions,
} = await import('../src/utils/database/schema.js');
const { assertAllowlistedIdentifier, quoteIdentifier } = await import('../src/utils/sqlIdentifiers.js');

const { Pool } = pg;

const databaseUrl = process.env.POSTGRES_URL;

// Test runs (npm run migrate:test, or NODE_ENV=test) may only migrate a local Postgres. This script
// can't import src/config/testMode.js (its import-time checks would also demand the test bot), so
// the host check is repeated here; same rule as testMode's databaseHosts().
const TEST_ENV_FILE = /(^|[=/\\])\.?env\.test$/;
const isTestRun = process.env.NODE_ENV === 'test' || process.execArgv.some((arg) => TEST_ENV_FILE.test(arg));
if (isTestRun) {
  let problem = null;
  try {
    const url = new URL(databaseUrl || '');
    const override = ['host', 'hostaddr', 'port', 'user', 'password', 'database', 'dbname'].find((p) => url.searchParams.has(p));
    if (override) problem = `URL parameter "${override}" is not allowed`;
    else if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) problem = `host is "${url.hostname}"`;
  } catch {
    problem = 'POSTGRES_URL is missing or unparseable';
  }
  if (problem) {
    logger.error(`❌ Refusing a test migration: ${problem}. Test runs only migrate a local Postgres (localhost / 127.0.0.1).`);
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: sanitizeConnectionString(databaseUrl),
  ssl: resolveSslConfig(databaseUrl),
});

const migrationTable = process.env.POSTGRES_MIGRATION_TABLE || 'schema_migrations';
const migrationTablePattern = /^[a-z_][a-z0-9_]*$/;

if (!migrationTablePattern.test(migrationTable)) {
  throw new Error(`Invalid migration table name: ${migrationTable}`);
}

const ensureMigrationLedger = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${migrationTable} (
      version INTEGER PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

const recordSchemaVersion = async (client) => {
  await ensureMigrationLedger(client);
  await client.query(
    `INSERT INTO ${migrationTable} (version, label)
     VALUES ($1, $2)
     ON CONFLICT (version)
     DO UPDATE SET label = EXCLUDED.label, applied_at = CURRENT_TIMESTAMP`,
    [EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL]
  );
};

const getCurrentSchemaVersion = async (client) => {
  await ensureMigrationLedger(client);
  const result = await client.query(
    `SELECT version, label, applied_at FROM ${migrationTable} ORDER BY version DESC LIMIT 1`
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
};

const createTables = async (client) => {
  logger.info('📊 Creating database tables...');

  for (const statement of tableStatements) {
    try {
      await client.query(statement);
    } catch (error) {
      logger.error(`❌ Error creating table: ${error.message}`);
      throw error;
    }
  }

  logger.info('✅ All tables created successfully');
};

const createIndexes = async (client) => {
  logger.info('📈 Creating indexes...');

  for (const statement of indexStatements) {
    try {
      await client.query(statement);
    } catch (error) {
      logger.error(`❌ Error creating index: ${error.message}`);
      throw error;
    }
  }

  logger.info('✅ All indexes created successfully');
};

const createTriggers = async (client) => {
  logger.info('⏰ Setting up automatic timestamps...');

  await client.query(UPDATE_TIMESTAMP_FUNCTION);

  const allowedTriggerIdentifiers = new Set(triggerDefinitions.map((trigger) => trigger.name));
  const allowedTableIdentifiers = new Set(triggerDefinitions.map((trigger) => trigger.table));

  for (const { name, table } of triggerDefinitions) {
    try {
      const safeTrigger = quoteIdentifier(
        assertAllowlistedIdentifier(name, allowedTriggerIdentifiers, 'Trigger identifier')
      );
      const safeTable = quoteIdentifier(
        assertAllowlistedIdentifier(table, allowedTableIdentifiers, 'Trigger table identifier')
      );

      await client.query(`DROP TRIGGER IF EXISTS ${safeTrigger} ON ${safeTable};`);
      await client.query(
        `CREATE TRIGGER ${safeTrigger}
         BEFORE UPDATE ON ${safeTable}
         FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`
      );
    } catch (error) {
      logger.error(`❌ Error creating trigger for ${table}: ${error.message}`);
      throw error;
    }
  }

  logger.info('✅ All triggers created successfully');
};

const migrate = async () => {
  const client = await pool.connect();

  try {
    logger.info('🚀 Starting database migration...');

    await createTables(client);
    await createIndexes(client);
    await createTriggers(client);
    await recordSchemaVersion(client);

    logger.info('✨ Migration completed successfully!');
    logger.info(`📌 Schema version recorded: v${EXPECTED_SCHEMA_VERSION} (${EXPECTED_SCHEMA_LABEL})`);
    logger.info('Database is ready for Mewvo.');
  } catch (error) {
    logger.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

const checkMigrationVersion = async () => {
  const client = await pool.connect();

  try {
    const current = await getCurrentSchemaVersion(client);

    if (!current) {
      logger.error(`❌ No schema version found in ${migrationTable}. Expected v${EXPECTED_SCHEMA_VERSION}.`);
      process.exit(1);
    }

    const currentVersion = Number(current.version);
    if (currentVersion !== EXPECTED_SCHEMA_VERSION) {
      logger.error(
        `❌ Schema drift detected. Expected v${EXPECTED_SCHEMA_VERSION}, found v${currentVersion}.`
      );
      process.exit(1);
    }

    logger.info(
      `✅ Schema version check passed (v${currentVersion}, label: ${current.label}).`
    );
  } catch (error) {
    logger.error('❌ Migration check failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

const printMigrationStatus = async () => {
  const client = await pool.connect();

  try {
    const current = await getCurrentSchemaVersion(client);
    if (!current) {
      logger.info(`ℹ️ No schema version recorded yet. Expected v${EXPECTED_SCHEMA_VERSION}.`);
      return;
    }

    logger.info(`📌 Current schema version: v${current.version}`);
    logger.info(`🏷️ Label: ${current.label}`);
    logger.info(`🕒 Applied at: ${current.applied_at}`);
    logger.info(`🎯 Expected: v${EXPECTED_SCHEMA_VERSION} (${EXPECTED_SCHEMA_LABEL})`);
  } catch (error) {
    logger.error('❌ Migration status failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

const command = process.argv[2] || 'apply';

if (command === 'apply') {
  migrate();
} else if (command === 'check') {
  checkMigrationVersion();
} else if (command === 'status') {
  printMigrationStatus();
} else {
  logger.error(`Unknown command: ${command}. Use one of: apply, check, status`);
  process.exit(1);
}
