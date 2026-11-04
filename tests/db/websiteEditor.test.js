// Website editor tables (site_content, site_content_history, site_images; schema v10) against the
// local test database (npm run test:db): save + history in one transaction, reset, restore,
// a failing history write rolls the save back, DB errors throw, images round-trip.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, sc, si, edb;
const runId = String(Date.now()).slice(-9);
const key = `zztest${runId}.hero.title`;
const slot = `zztest${runId}`;
const owner = '200000000000000003';

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    sc = await import('../../src/services/site/siteContent.js');
    si = await import('../../src/services/site/siteImages.js');
    edb = await import('../../src/services/enforcement/db.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM site_content WHERE key = $1', [key]).catch(() => {});
    await pgDb.pool.query('DELETE FROM site_content_history WHERE key = $1', [key]).catch(() => {});
    await pgDb.pool.query('DELETE FROM site_images WHERE slot = $1', [slot]).catch(() => {});
    await pgDb.disconnect();
});

test('site_content: save + history together, update, reset, restore source, newest first', { skip }, async () => {
    const store = sc.siteContentStore;
    const first = await store.save({ lang: 'de', key, text: 'Hallo', sourceHash: 'a'.repeat(64), userId: owner });
    assert.equal(first.oldText, null, 'it was the catalog text');
    assert.equal(first.row.text, 'Hallo');
    assert.equal(first.row.source_hash, 'a'.repeat(64));
    assert.equal(first.row.updated_by, owner);

    const second = await store.save({ lang: 'de', key, text: 'Servus', sourceHash: 'b'.repeat(64), userId: owner });
    assert.equal(second.oldText, 'Hallo');
    const rows = (await store.listAll()).filter((r) => r.key === key);
    assert.deepEqual(rows.map((r) => [r.lang, r.text, r.source_hash]), [['de', 'Servus', 'b'.repeat(64)]]);

    const reset = await store.reset({ lang: 'de', key, userId: owner });
    assert.deepEqual(reset, { removed: true, oldText: 'Servus' });
    assert.deepEqual(await store.reset({ lang: 'de', key, userId: owner }), { removed: false, oldText: null }, 'nothing to reset: no history row');
    assert.equal((await store.listAll()).filter((r) => r.key === key).length, 0);

    const history = await store.history('de', key);
    assert.deepEqual(history.map((h) => [h.old_text, h.new_text]), [['Servus', null], ['Hallo', 'Servus'], [null, 'Hallo']]);
    const entry = await store.historyEntry(Number(history[2].id));
    assert.equal(entry.new_text, 'Hallo', 'a version to restore');
    assert.equal(await store.historyEntry(-1), null);
});

test('site_content: a failing history write rolls the save back; DB errors throw; the DB refuses > 5,000 characters', { skip }, async () => {
    const broken = sc.createSiteContentStore({ historyTable: 'site_content_history_does_not_exist' });
    await assert.rejects(broken.save({ lang: 'fr', key, text: 'Bonjour', userId: owner }));
    const { rows } = await pgDb.pool.query('SELECT 1 FROM site_content WHERE lang = $1 AND key = $2', ['fr', key]);
    assert.equal(rows.length, 0, 'the row was not saved without its history');

    const down = sc.createSiteContentStore({ query: async () => { throw new Error('connection refused'); }, withTransaction: async () => { throw new Error('connection refused'); } });
    await assert.rejects(down.listAll(), /connection refused/);
    await assert.rejects(down.history('de', key), /connection refused/);
    await assert.rejects(down.save({ lang: 'de', key, text: 'x', userId: owner }), /connection refused/);
    // The live copy is only touched after a successful save (handlers): loadSiteContent survives an error.
    assert.equal(await sc.loadSiteContent(down), null);

    await assert.rejects(sc.siteContentStore.save({ lang: 'it', key, text: 'x'.repeat(5001), userId: owner }), /check constraint/i);
    assert.equal((await pgDb.pool.query('SELECT 1 FROM site_content_history WHERE lang = $1 AND key = $2', ['it', key])).rows.length, 0);
});

test('site_images: round-trip of the bytes, replace reports the old hash, remove, 2 MB limit in the DB', { skip }, async () => {
    const store = si.siteImageStore;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0, 255]);
    const first = await store.save({ slot, mime: 'image/png', width: 1200, height: 630, bytes, sha256: 'c'.repeat(64), userId: owner });
    assert.equal(first.oldSha256, null);
    assert.equal(first.row.slot, slot);
    assert.ok(!('bytes' in first.row));
    const loaded = (await store.listAll()).find((r) => r.slot === slot);
    assert.ok(Buffer.isBuffer(loaded.bytes) && loaded.bytes.equals(bytes), 'bytes come back unchanged');
    assert.deepEqual([loaded.mime, loaded.width, loaded.height], ['image/png', 1200, 630]);

    const second = await store.save({ slot, mime: 'image/png', width: 1200, height: 630, bytes: Buffer.from([1]), sha256: 'd'.repeat(64), userId: owner });
    assert.equal(second.oldSha256, 'c'.repeat(64));
    assert.deepEqual(await store.remove(slot), { removed: true, oldSha256: 'd'.repeat(64) });
    assert.deepEqual(await store.remove(slot), { removed: false, oldSha256: null });

    await assert.rejects(store.save({ slot, mime: 'image/png', width: 1, height: 1, bytes: Buffer.alloc(2 * 1024 * 1024 + 1), sha256: 'e'.repeat(64), userId: owner }), /check constraint/i);
    const down = si.createSiteImageStore({ query: async () => { throw new Error('connection refused'); } });
    await assert.rejects(down.listAll(), /connection refused/);
    await assert.rejects(down.save({ slot, mime: 'image/png', width: 1, height: 1, bytes, sha256: 'f'.repeat(64), userId: owner }), /connection refused/);
    assert.ok(edb.isEnforcementDbAvailable());
});
