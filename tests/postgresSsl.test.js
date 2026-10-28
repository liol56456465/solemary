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

test('connection-target parameters are stripped, so ?host= cannot redirect the connection past the TLS decision', async () => {
    const { parse } = await import('pg-connection-string');
    const cleaned = sanitizeConnectionString('postgresql://u:p@localhost:5432/db?host=db.remote.example&hostaddr=10.0.0.1&port=1&user=x&dbname=y&channel_binding=require');
    const target = parse(cleaned);
    assert.equal(target.host, 'localhost');
    assert.equal(target.port, '5432');
    assert.equal(target.user, 'u');
    assert.equal(target.database, 'db');
    assert.equal(cleaned.includes('channel_binding=require'), true, 'other parameters stay');
});

test('a CA certificate from the environment is used for remote hosts (Supabase)', () => {
    const saved = { cert: process.env.POSTGRES_CA_CERT, ssl: process.env.POSTGRES_SSL };
    try {
        delete process.env.POSTGRES_SSL;
        process.env.POSTGRES_CA_CERT = '-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----';
        const ssl = resolveSslConfig('postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres');
        assert.equal(ssl.rejectUnauthorized, true);
        assert.equal(ssl.ca, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----', 'escaped newlines restored');
        process.env.POSTGRES_SSL = 'no-verify';
        assert.throws(() => resolveSslConfig('postgresql://u:p@db.example.com/x'), /both set/);
    } finally {
        for (const [key, name] of [['cert', 'POSTGRES_CA_CERT'], ['ssl', 'POSTGRES_SSL']]) {
            if (saved[key] === undefined) delete process.env[name];
            else process.env[name] = saved[key];
        }
    }
});
