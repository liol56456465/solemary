// One database URL: the bot reads POSTGRES_URL only. DATABASE_URL (Replit points it at
// its own, suspended database) is ignored, with a startup warning when it differs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ignoredDatabaseUrlWarning, resolvePostgresPoolConfig } from '../src/config/database/postgres.js';

const NEON = 'postgresql://user:pw@ep-example-123-pooler.us-east-2.aws.neon.tech/neondb';
const REPLIT = 'postgresql://user:secret@ep-dead-456.us-east-2.aws.neon.tech/neondb';

function withEnv(vars, fn) {
    const saved = {};
    for (const [key, value] of Object.entries(vars)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('the pool uses POSTGRES_URL and never DATABASE_URL', () => {
    withEnv({ POSTGRES_URL: NEON, DATABASE_URL: REPLIT }, () => {
        assert.match(resolvePostgresPoolConfig().connectionString, /ep-example-123-pooler/);
    });
    // DATABASE_URL alone is not used: the pool falls back to POSTGRES_HOST / localhost.
    withEnv({ POSTGRES_URL: undefined, DATABASE_URL: REPLIT, POSTGRES_HOST: undefined }, () => {
        const config = resolvePostgresPoolConfig();
        assert.equal(config.connectionString, undefined);
        assert.equal(config.host, 'localhost');
    });
});

test('DATABASE_URL that differs gives a warning with the host only (no password)', () => {
    assert.equal(ignoredDatabaseUrlWarning({ POSTGRES_URL: NEON }), null);
    assert.equal(ignoredDatabaseUrlWarning({ POSTGRES_URL: NEON, DATABASE_URL: NEON }), null, 'same value: harmless');
    const both = ignoredDatabaseUrlWarning({ POSTGRES_URL: NEON, DATABASE_URL: REPLIT });
    assert.match(both, /DATABASE_URL is set \(ep-dead-456\.us-east-2\.aws\.neon\.tech\) but ignored/);
    assert.ok(!both.includes('secret'));
    assert.match(ignoredDatabaseUrlWarning({ DATABASE_URL: REPLIT }), /POSTGRES_URL is not set/);
    assert.match(ignoredDatabaseUrlWarning({ DATABASE_URL: 'not a url' }), /an unparseable URL/);
});

test('production refuses to start with only DATABASE_URL', async () => {
    const { validateConfig } = await import('../src/config/bot.js');
    withEnv({ NODE_ENV: 'production', POSTGRES_URL: undefined, DATABASE_URL: REPLIT, POSTGRES_HOST: undefined, POSTGRES_USER: undefined, POSTGRES_PASSWORD: undefined }, () => {
        const errors = validateConfig({});
        assert.ok(errors.some((e) => /PostgreSQL connection is required in production \(set POSTGRES_URL/.test(e)), errors.join('; '));
    });
    withEnv({ NODE_ENV: 'production', POSTGRES_URL: NEON, DATABASE_URL: REPLIT }, () => {
        assert.ok(!validateConfig({}).some((e) => /PostgreSQL/.test(e)));
    });
});
