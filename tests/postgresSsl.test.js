import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSslConfig, sanitizeConnectionString } from '../src/config/database/postgres.js';

const NEON = 'postgresql://user:pw@ep-example-123.eu-central-1.aws.neon.tech/neondb';

test('remote databases always get verified TLS, whatever the URL says', () => {
    const saved = process.env.POSTGRES_SSL;
    try {
        for (const value of [undefined, 'false', 'true']) {
            if (value === undefined) delete process.env.POSTGRES_SSL;
            else process.env.POSTGRES_SSL = value;
            assert.deepEqual(resolveSslConfig(NEON), { rejectUnauthorized: true }, `POSTGRES_SSL=${value}`);
            assert.deepEqual(resolveSslConfig(`${NEON}?sslmode=require`), { rejectUnauthorized: true });
        }
        process.env.POSTGRES_SSL = 'no-verify';
        assert.deepEqual(resolveSslConfig(NEON), { rejectUnauthorized: false });
    } finally {
        if (saved === undefined) delete process.env.POSTGRES_SSL;
        else process.env.POSTGRES_SSL = saved;
    }
});

test('the local test database may run without TLS', () => {
    const saved = process.env.POSTGRES_SSL;
    try {
        process.env.POSTGRES_SSL = 'false';
        assert.equal(resolveSslConfig('postgresql://u:p@localhost:5433/meowist_test'), false);
    } finally {
        if (saved === undefined) delete process.env.POSTGRES_SSL;
        else process.env.POSTGRES_SSL = saved;
    }
});

test('TLS parameters are stripped from the URL so pg cannot override them', () => {
    const cleaned = sanitizeConnectionString(`${NEON}?sslmode=require&channel_binding=require`);
    assert.equal(cleaned.includes('sslmode'), false);
    assert.equal(cleaned.includes('channel_binding=require'), true);
});
