// Key-value list() against the local test database (npm run test:db): a prefix with "_" or "%"
// matches only itself (LIKE wildcards are escaped). Skipped unless POSTGRES_URL is on localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
const runId = String(Date.now()).slice(-9);
let pgDb;
const q = (text, params) => pgDb.pool.query(text, params);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
});

after(async () => {
    if (skip) return;
    await q('DELETE FROM temp_data WHERE key LIKE $1', [`kvlist${runId}%`]).catch(() => {});
    await q('DELETE FROM cache_data WHERE key LIKE $1', [`kvlist${runId}%`]).catch(() => {});
    await pgDb.disconnect();
});

test('list(): "_" and "%" in the prefix are literal characters, not wildcards', { skip }, async () => {
    const keys = [`kvlist${runId}_a:1`, `kvlist${runId}Xa:1`, `kvlist${runId}%b:1`, `kvlist${runId}Yb:1`];
    for (const key of keys) {
        await q(`INSERT INTO temp_data (key, value) VALUES ($1, '1'::jsonb)`, [key]);
        await q(`INSERT INTO cache_data (key, value) VALUES ($1, '1'::jsonb)`, [key]);
    }
    assert.deepEqual(await pgDb.list(`kvlist${runId}_a:`), [`kvlist${runId}_a:1`]);
    assert.deepEqual(await pgDb.list(`kvlist${runId}%b:`), [`kvlist${runId}%b:1`]);
    assert.equal((await pgDb.list(`kvlist${runId}`)).length, 4);
});
