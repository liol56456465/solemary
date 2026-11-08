// configCache.js — a short-lived read cache for per-server config rows that are read on
// every message or log event (guild config, counting game). Bounded (BoundedMap) and with a
// TTL, so a write made by another process (a restore script) shows within ttlMs.
//
// Correctness rules (data layer, CLAUDE.md):
//   - A failed read throws and caches nothing (an error is never remembered, and no
//     defaults are returned on error).
//   - Every write in this process goes through write(), which drops the entry before and
//     after the write, so a read after a write sees the new value.
//   - A read that started before a write finished is not cached (version check), so a
//     slow read can't put the old value back after the write cleared it.
//   - Callers get a copy (structuredClone): changing the returned object never changes
//     the cache.
//
// One cache per database object (WeakMap keyed by client.db), so a test's fake database
// or a second client never sees another one's entries.

import { BoundedMap } from './boundedMap.js';

export function createConfigCache({ maxSize = 2000, ttlMs = 60_000, now = () => Date.now() } = {}) {
    const stores = new WeakMap();
    const stats = { hits: 0, misses: 0 };

    const storeFor = (db) => {
        if (!db || (typeof db !== 'object' && typeof db !== 'function')) return null;
        let store = stores.get(db);
        if (!store) {
            store = { entries: new BoundedMap(maxSize), version: 0 };
            stores.set(db, store);
        }
        return store;
    };

    const invalidate = (db, id) => {
        const store = storeFor(db);
        if (!store) return;
        store.version += 1;
        store.entries.delete(String(id));
    };

    return {
        /** The cached value for id, or loader()'s result (cached on success). loader errors propagate. */
        async read(db, id, loader) {
            const store = storeFor(db);
            if (!store) return loader();
            const key = String(id);
            const hit = store.entries.get(key);
            if (hit && hit.expiresAt > now()) {
                stats.hits += 1;
                return structuredClone(hit.value);
            }
            if (hit) store.entries.delete(key);
            stats.misses += 1;
            const version = store.version;
            const value = await loader();
            if (store.version === version) {
                store.entries.set(key, { value: structuredClone(value), expiresAt: now() + ttlMs });
            }
            return value;
        },

        /** Runs a write; the entry is dropped before and after it (also when it fails). */
        async write(db, id, fn) {
            invalidate(db, id);
            try {
                return await fn();
            } finally {
                invalidate(db, id);
            }
        },

        invalidate,

        /** Tests: entries held for this database. */
        size(db) {
            return stores.get(db)?.entries.size ?? 0;
        },

        /** Tests / health: hit and miss counts since start. */
        stats() {
            return { ...stats };
        },
    };
}
