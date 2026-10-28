import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertWriteTargetAllowed, hostOf, isLocalUrl, libpqTarget } from '../scripts/lib/dbTarget.js';

test('backup scripts: the host is read like pg reads it; ?host= cannot fake a local target', () => {
    assert.equal(hostOf('postgresql://u:p@localhost:5432/db?host=db.remote.example'), 'localhost');
    assert.equal(isLocalUrl('postgresql://localhost@db.remote.example/db'), false);
    assert.equal(isLocalUrl('postgresql://u:p@127.0.0.1:5433/t'), true);
});

test('restore: writing to a remote host needs --confirm-host with exactly that host', () => {
    const remote = 'postgresql://u:p@ep-x.eu.aws.neon.tech/neondb?sslmode=require';
    assert.throws(() => assertWriteTargetAllowed(remote, undefined, 'Restore'), /--confirm-host=ep-x\.eu\.aws\.neon\.tech/);
    assert.throws(() => assertWriteTargetAllowed(remote, true, 'Restore'), /remote database/, 'a bare --confirm-host is not enough');
    assert.throws(() => assertWriteTargetAllowed(remote, 'other.neon.tech', 'Restore'));
    assert.doesNotThrow(() => assertWriteTargetAllowed(remote, 'ep-x.eu.aws.neon.tech', 'Restore'));
    assert.doesNotThrow(() => assertWriteTargetAllowed('postgresql://u:p@localhost/t', undefined, 'Restore'));
});

test('pg_* children get the password through PGPASSWORD, never on the command line', () => {
    const { url, env } = libpqTarget('postgresql://user:s%40cret@db.example/db?sslmode=require&host=evil.example');
    assert.equal(url.includes('s%40cret') || url.includes('s@cret'), false);
    assert.equal(url.includes('evil.example'), false);
    assert.equal(url.includes('sslmode=require'), true, 'TLS settings stay for libpq');
    assert.equal(env.PGPASSWORD, 's@cret');
});
