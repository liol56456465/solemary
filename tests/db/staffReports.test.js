// Staff reports against the local test database (npm run test:db): two report forms sent at
// the same moment by one member open one report, not two ("one open report at a time").
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const skip = isLocalDatabaseUrl(process.env.POSTGRES_URL || '') ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
const runId = String(Date.now()).slice(-9);
const reporter = `6${runId}00000088`;
let pgDb, appeals, enforcementConfig, savedCategory;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    ({ enforcementConfig } = await import('../../src/config/enforcement.js'));
    appeals = await import('../../src/services/enforcement/appealService.js');
    savedCategory = enforcementConfig.appealsCategoryId;
    enforcementConfig.appealsCategoryId = `7${runId}00000005`;
});

after(async () => {
    if (skip) return;
    enforcementConfig.appealsCategoryId = savedCategory;
    await pgDb.pool.query(`DELETE FROM mod_appeals WHERE kind = 'report' AND user_id = $1`, [reporter]);
    await pgDb.disconnect();
});

test('two report forms at the same moment: one report opens, the other is refused', { skip }, async () => {
    const created = [];
    const guild = { id: enforcementConfig.mainGuildId };
    const client = { user: { id: '999999999999999998' }, guilds: { cache: new Map([[guild.id, guild]]) } };
    guild.client = client;
    guild.channels = {
        cache: new Map(),
        fetch: async (id) => ({ id, type: ChannelType.GuildCategory }),
        create: async (options) => {
            await new Promise((resolve) => setTimeout(resolve, 30)); // Discord takes a moment
            const channel = { id: `8${runId}${String(created.length).padStart(8, '0')}`, ...options, send: async () => {} };
            created.push(channel);
            guild.channels.cache.set(channel.id, channel);
            return channel;
        },
    };
    const send = () => appeals.submitStaffReport({ client, user: { id: reporter, username: 'reporter' }, staffMember: 'someone', details: 'details', proof: '' });
    const results = await Promise.allSettled([send(), send()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const refused = results.find((r) => r.status === 'rejected');
    assert.match(refused.reason.userMessage || refused.reason.message, /already have an open staff report/);
    assert.equal(created.length, 1, 'one channel');
});
