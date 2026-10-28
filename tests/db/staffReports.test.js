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
    enforcementConfig.openChannelCap = undefined;
    await pgDb.pool.query(`DELETE FROM mod_appeals WHERE guild_id = $1 AND user_id LIKE $2`, [enforcementConfig.mainGuildId, `6${runId}%`]);
    await pgDb.pool.query(`DELETE FROM mod_cases WHERE guild_id = $1 AND target_user_id LIKE $2`, [enforcementConfig.mainGuildId, `6${runId}%`]);
    await pgDb.pool.query(`DELETE FROM modmail_links WHERE guild_id = $1 AND user_id LIKE $2`, [enforcementConfig.mainGuildId, `6${runId}%`]);
    await pgDb.disconnect();
});

function fakeMain() {
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
    return { guild, client, created };
}

test('two report forms at the same moment: one report opens, the other is refused', { skip }, async () => {
    const { client, created } = fakeMain();
    const send = () => appeals.submitStaffReport({ client, user: { id: reporter, username: 'reporter' }, staffMember: 'someone', details: 'details', proof: '' });
    const results = await Promise.allSettled([send(), send()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const refused = results.find((r) => r.status === 'rejected');
    assert.match(refused.reason.userMessage || refused.reason.message, /already have an open staff report/);
    assert.equal(created.length, 1, 'one channel');
});

test('open-channel cap: reports + modmail together; at the cap a report is refused clearly and no channel opens; staff alerted once an hour', { skip }, async () => {
    const { guild, client, created } = fakeMain();
    const cap = await import('../../src/services/openChannelCap.js');
    const links = await import('../../src/services/modmailLinks.js');
    cap.resetOpenChannelCapForTests();
    enforcementConfig.openChannelCap = 2;
    // One open report (someone else) and one open modmail conversation: 2 of 2.
    const other = `6${runId}00000090`;
    const reportChannel = await guild.channels.create({ name: 'report-other' });
    await pgDb.pool.query(`INSERT INTO mod_appeals (kind, user_id, username, guild_id, body, channel_id) VALUES ('report', $1, 'other', $2, '{}', $3)`, [other, guild.id, reportChannel.id]);
    const modmailChannel = await guild.channels.create({ name: 'modmail-x' });
    await links.linkModmailChannel(guild.id, modmailChannel.id, `6${runId}00000091`);
    assert.equal(await cap.countOpenStaffChannels(guild), 2);
    const before = created.length;

    const newcomer = `6${runId}00000092`;
    await assert.rejects(
        appeals.submitStaffReport({ client, user: { id: newcomer, username: 'newcomer' }, staffMember: 's', details: 'd', proof: '' }),
        (error) => /Staff are handling a lot of conversations right now/.test(error.userMessage || error.message));
    assert.equal(created.length, before, 'no channel');
    const { rows } = await pgDb.pool.query(`SELECT 1 FROM mod_appeals WHERE kind = 'report' AND user_id = $1`, [newcomer]);
    assert.equal(rows.length, 0, 'no report row left behind');

    const alerts = [];
    const alert = async (...args) => { alerts.push(args); };
    const now = Date.now();
    assert.deepEqual(await cap.withOpenChannelSlot(guild, 'modmail conversation', async () => 'opened', { now: now + 1, alert }), { refused: cap.CAP_REFUSAL });
    assert.deepEqual(await cap.withOpenChannelSlot(guild, 'modmail conversation', async () => 'opened', { now: now + 2, alert }), { refused: cap.CAP_REFUSAL });
    assert.ok(alerts.length <= 1, 'at most one alert an hour');
    enforcementConfig.openChannelCap = 3;
    assert.equal(await cap.withOpenChannelSlot(guild, 'modmail conversation', async () => 'opened', { alert }), 'opened', 'under the cap: opens');
});

test('open-channel cap: an appeal still opens while reports + modmail are at the cap', { skip }, async () => {
    const { guild, client, created } = fakeMain();
    const links = await import('../../src/services/modmailLinks.js');
    enforcementConfig.openChannelCap = 1;
    const modmailChannel = await guild.channels.create({ name: 'modmail-y' });
    await links.linkModmailChannel(guild.id, modmailChannel.id, `6${runId}00000093`);
    const member = `6${runId}00000094`;
    const code = `w${runId.slice(-6)}`.replace(/[01ilo]/g, 'x');
    await pgDb.pool.query(
        `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom)
         VALUES ($1, $2, $3, 'member', '1', 'mod', 'warn', 'member warn 1', 'Spam', 'prebuilt')`, [guild.id, code, member]);
    const before = created.length;
    const result = await appeals.submitAppeal({ client, user: { id: member, username: 'member' }, caseCode: code, answers: { reason: 'sorry', didIt: 'yes' } });
    assert.ok(result.channel, 'appeal channel opened');
    assert.equal(created.length, before + 1);
});
