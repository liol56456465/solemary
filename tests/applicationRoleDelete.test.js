// Deleting an application role removes every application sent for it (not only the newest
// 50 of the server), and a read error stops before anything is removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApplicationRole } from '../src/services/applicationRoleService.js';

const GUILD = '100000000000000001';
const ROLE = '600000000000000001';
const OTHER_ROLE = '600000000000000002';

function fakeClient({ failList = false } = {}) {
    const store = new Map();
    const db = {
        async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
        async set(key, value) { store.set(key, structuredClone(value)); return true; },
        async delete(key) { store.delete(key); return true; },
        async list(prefix) {
            if (failList) throw new Error('connection refused');
            return [...store.keys()].filter((k) => k.startsWith(prefix));
        },
        async update(key, fn, fallback) { const next = fn(store.has(key) ? structuredClone(store.get(key)) : fallback); store.set(key, next); return next; },
    };
    return { client: { db }, store };
}

function seed(store) {
    store.set(`guild:${GUILD}:applications:roles`, [{ roleId: ROLE, name: 'Helper' }]);
    const now = Date.now();
    // 60 newer applications for another role, then 30 older ones for ROLE.
    for (let i = 0; i < 60; i += 1) store.set(`guild:${GUILD}:applications:o${i}`, { id: `o${i}`, roleId: OTHER_ROLE, userId: 'u', status: 'pending', createdAt: now - i });
    for (let i = 0; i < 30; i += 1) store.set(`guild:${GUILD}:applications:x${i}`, { id: `x${i}`, roleId: ROLE, userId: 'u', status: 'pending', createdAt: now - 10_000 - i });
}

const appKeys = (store, prefix) => [...store.keys()].filter((k) => k.startsWith(`guild:${GUILD}:applications:${prefix}`));

test('deleteApplicationRole deletes every application of the role, also older than the newest 50', async () => {
    const { client, store } = fakeClient();
    seed(store);
    const result = await deleteApplicationRole(client, GUILD, ROLE);
    assert.equal(result.deletedApplications, 30);
    assert.equal(appKeys(store, 'x').length, 0);
    assert.equal(appKeys(store, 'o').length, 60, 'other roles untouched');
    assert.deepEqual(store.get(`guild:${GUILD}:applications:roles`), [], 'the role entry is gone');
});

test('deleteApplicationRole: a read error throws before the role is removed (nothing orphaned)', async () => {
    const { client, store } = fakeClient({ failList: true });
    seed(store);
    const before = JSON.stringify([...store.entries()]);
    await assert.rejects(() => deleteApplicationRole(client, GUILD, ROLE));
    assert.equal(JSON.stringify([...store.entries()]), before, 'nothing changed');
});
