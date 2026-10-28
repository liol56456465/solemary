import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from './helpers/localDb.js';

test('DB test guard: only a Postgres on this machine; tricks that point pg elsewhere are refused', () => {
    assert.equal(isLocalDatabaseUrl('postgresql://u:p@localhost:5433/t'), true);
    assert.equal(isLocalDatabaseUrl('postgres://u:p@127.0.0.1/t'), true);
    assert.equal(isLocalDatabaseUrl('postgresql://u:p@localhost:5433/t?host=db.remote.example'), false, '?host= wins in pg');
    assert.equal(isLocalDatabaseUrl('postgresql://localhost@db.remote.example/t'), false, 'localhost is the user name here');
    assert.equal(isLocalDatabaseUrl('postgresql://u:p@localhost.remote.example/t'), false);
    assert.equal(isLocalDatabaseUrl('postgresql://u:p@ep-x.neon.tech/t'), false);
    assert.equal(isLocalDatabaseUrl(''), false);
});
