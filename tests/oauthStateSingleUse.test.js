import { test } from 'node:test';
import assert from 'node:assert/strict';

const ENV = { CLIENT_ID: '100000000000000123', DISCORD_CLIENT_SECRET: 'test-secret-not-real', PUBLIC_URL: 'http://localhost:3100' };

async function withEnv(fn) {
    const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

const stateOf = (url) => new URL(url).searchParams.get('state');

function fakeStore() {
    const rows = new Map();
    return {
        rows,
        getStored: async (key, fallback) => (rows.has(key) ? rows.get(key).value : fallback),
        setStored: async (key, value, ttl) => { rows.set(key, { value, ttl }); return true; },
    };
}

test('OAuth state: used once; the used marker goes to the store with a TTL up to the state expiry', async () => {
    await withEnv(async () => {
        const { buildVerifyUrl, readState } = await import('../src/services/oauthVerification.js');
        const store = fakeStore();
        const state = stateOf(buildVerifyUrl('200000000000000001', '300000000000000001'));
        assert.deepEqual(await readState(state, store), { guildId: '200000000000000001', userId: '300000000000000001' });
        assert.equal(await readState(state, store), null, 'second use refused (memory fast path)');
        const [[key, row]] = [...store.rows];
        assert.match(key, /^oauth:state_used:[0-9a-f]{16}$/);
        assert.equal(row.value, true);
        assert.ok(row.ttl > 600 && row.ttl <= 660, `TTL ${row.ttl}s covers the 10-minute state life`);
    });
});

test('OAuth state: a nonce marked used in the store (e.g. before a restart) is refused', async () => {
    await withEnv(async () => {
        const { buildVerifyUrl, readState } = await import('../src/services/oauthVerification.js');
        const state = stateOf(buildVerifyUrl('200000000000000001', '300000000000000002'));
        const nonce = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString('utf8')).n;
        const store = fakeStore();
        store.rows.set(`oauth:state_used:${nonce}`, { value: true, ttl: 600 });
        assert.equal(await readState(state, store), null);
    });
});

test('OAuth state: a store error throws (the callback answers 503), a forged state is null without touching the store', async () => {
    await withEnv(async () => {
        const { buildVerifyUrl, readState } = await import('../src/services/oauthVerification.js');
        const state = stateOf(buildVerifyUrl('200000000000000001', '300000000000000003'));
        const failing = { getStored: async () => { throw new Error('database not responding'); }, setStored: async () => true };
        await assert.rejects(readState(state, failing), /database not responding/);
        let touched = false;
        const spy = { getStored: async () => { touched = true; return null; }, setStored: async () => { touched = true; } };
        assert.equal(await readState(`${state.split('.')[0]}.forged`, spy), null);
        assert.equal(touched, false);
    });
});
