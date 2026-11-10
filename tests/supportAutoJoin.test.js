import test from 'node:test';
import assert from 'node:assert/strict';
import { joinSupportQuietly } from '../src/services/supportAutoJoin.js';

const MAIN = '111111111111111111';
const SUPPORT = '222222222222222222';
const client = { guilds: { cache: new Map([[SUPPORT, {}]]) } };
const ids = { mainGuildId: MAIN, supportGuildId: SUPPORT };

test('support auto-join: main-server ban/verify adds the member to Support', async () => {
    const calls = [];
    const result = await joinSupportQuietly(client, '333333333333333333', { ...ids, guildId: MAIN, addMember: async (...a) => { calls.push(a.slice(1)); return 'added'; } });
    assert.equal(result, 'added');
    assert.deepEqual(calls, [[SUPPORT, '333333333333333333']]);
});

test('support auto-join: other servers, no bot in Support, errors', async () => {
    const never = async () => { throw new Error('must not be called'); };
    assert.equal(await joinSupportQuietly(client, 'u', { ...ids, guildId: '999999999999999999', addMember: never }), 'skipped');
    assert.equal(await joinSupportQuietly({ guilds: { cache: new Map() } }, 'u', { ...ids, guildId: MAIN, addMember: never }), 'skipped');
    assert.equal(await joinSupportQuietly(client, 'u', { ...ids, guildId: MAIN, addMember: never }), 'failed');
    assert.equal(await joinSupportQuietly(client, 'u', { ...ids, guildId: MAIN, addMember: async () => 'no_token' }), 'no_token');
});
