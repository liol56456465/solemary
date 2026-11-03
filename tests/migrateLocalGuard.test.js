// migrate:test must never migrate a remote database: scripts/migrate.js refuses a non-local
// POSTGRES_URL when NODE_ENV=test. These runs stop before any connection is opened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = (env) => spawnSync(process.execPath, ['scripts/migrate.js', 'status'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LOG_LEVEL: 'error', ...env },
    encoding: 'utf8',
    timeout: 20000,
});

test('test migration refuses a remote host', () => {
    const result = run({ NODE_ENV: 'test', POSTGRES_URL: 'postgresql://u:p@db.remote.example:5432/x' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Refusing a test migration: host is "db\.remote\.example"/);
});

test('test migration refuses a local-looking URL with a ?host= override', () => {
    const result = run({ NODE_ENV: 'test', POSTGRES_URL: 'postgresql://u:p@localhost:5433/x?host=db.remote.example' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /URL parameter "host" is not allowed/);
});

test('test migration refuses a missing POSTGRES_URL', () => {
    const result = run({ NODE_ENV: 'test' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /POSTGRES_URL is missing or unparseable/);
});
