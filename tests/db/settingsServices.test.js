// Atomic settings services against the local test database (npm run test:db):
// concurrent writes to different fields must all survive the row lock.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, client;
let tickets, verification, welcome, leveling;

const runId = String(Date.now()).slice(-9);
const guild = `7${runId}00000001`;
const id = (n) => `6${runId}${String(n).padStart(8, '0')}`;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    client = { db };
    tickets = await import('../../src/services/ticketSettingsService.js');
    verification = await import('../../src/services/verificationSettingsService.js');
    welcome = await import('../../src/services/welcomeService.js');
    leveling = await import('../../src/services/leveling/leveling.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM welcome_configs WHERE guild_id = $1', [guild]).catch(() => {});
    await pgDb.pool.query('DELETE FROM temp_data WHERE key LIKE $1', [`%${guild}%`]).catch(() => {});
    await pgDb.pool.query('DELETE FROM guilds WHERE id = $1', [guild]).catch(() => {});
    await pgDb.disconnect();
});

test('tickets: concurrent updates of different fields all survive', { skip }, async () => {
    await tickets.updateTicketSettings(client, guild, { ticketPanelChannelId: id(1) });
    await Promise.all([
        tickets.updateTicketSettings(client, guild, { ticketButtonLabel: 'Open a ticket' }),
        tickets.updateTicketSettings(client, guild, { maxTicketsPerUser: 5 }),
        tickets.updateTicketSettings(client, guild, { dmOnClose: false }),
        tickets.updateTicketSettings(client, guild, { ticketStaffRoleId: id(2) }),
    ]);
    const stored = await tickets.getTicketSettings(client, guild);
    assert.equal(stored.ticketPanelChannelId, id(1));
    assert.equal(stored.ticketButtonLabel, 'Open a ticket');
    assert.equal(stored.maxTicketsPerUser, 5);
    assert.equal(stored.dmOnClose, false);
    assert.equal(stored.ticketStaffRoleId, id(2));
});

test('verification: concurrent field and autoVerify updates all survive', { skip }, async () => {
    await verification.setVerificationSettings(client, guild, {
        enabled: false, channelId: id(3), roleId: id(4), message: 'Verify here', buttonText: 'Verify',
        autoVerify: { enabled: false, criteria: 'none', accountAgeDays: null, roleId: null },
    });
    await Promise.all([
        verification.updateVerificationSettings(client, guild, { messageId: id(5) }),
        verification.updateVerificationSettings(client, guild, { buttonText: 'Go' }),
        verification.updateVerificationSettings(client, guild, { autoVerify: { roleId: id(6) } }),
        verification.updateVerificationSettings(client, guild, { autoVerify: { criteria: 'account_age', accountAgeDays: 14 } }),
    ]);
    const stored = await verification.getVerificationSettings(client, guild);
    assert.equal(stored.messageId, id(5));
    assert.equal(stored.buttonText, 'Go');
    assert.equal(stored.message, 'Verify here');
    assert.equal(stored.autoVerify.roleId, id(6));
    assert.equal(stored.autoVerify.criteria, 'account_age');
    assert.equal(stored.autoVerify.accountAgeDays, 14);
    // The ticket settings written above are untouched.
    assert.equal((await tickets.getTicketSettings(client, guild)).ticketButtonLabel, 'Open a ticket');
});

test('welcome: concurrent addAutoRole x2 and settings updates lose nothing', { skip }, async () => {
    const results = await Promise.all([
        welcome.addAutoRole(client, guild, id(7)),
        welcome.addAutoRole(client, guild, id(8)),
        welcome.updateWelcomeSettings(client, guild, { enabled: true, channelId: id(9) }),
        welcome.updateWelcomeSettings(client, guild, { goodbyeEnabled: true, goodbyeChannelId: id(10) }),
    ]);
    const stored = await welcome.getWelcomeSettings(client, guild);
    assert.equal(stored.enabled, true);
    assert.equal(stored.channelId, id(9));
    assert.equal(stored.goodbyeEnabled, true);
    assert.equal(stored.goodbyeChannelId, id(10));
    // One auto-role is allowed, so the second add replaced the first: each add saw
    // the other's result (serialized), and the survivor is the one that ran last.
    assert.equal(stored.roleIds.length, welcome.MAX_AUTO_ROLES);
    const [first, second] = results;
    assert.ok(first.changed && second.changed);
    const last = first.before.roleIds.includes(id(8)) ? id(7) : id(8);
    assert.deepEqual(stored.roleIds, [last]);

    await welcome.removeAutoRole(client, guild, last);
    assert.deepEqual((await welcome.getWelcomeSettings(client, guild)).roleIds, []);
});

test('leveling: concurrent config patches and role rewards all survive', { skip }, async () => {
    await leveling.updateLevelingConfig(client, guild, { configured: true, levelUpChannel: id(11) });
    await Promise.all([
        leveling.updateLevelingConfig(client, guild, { xpCooldown: 45 }),
        leveling.updateLevelingConfig(client, guild, { xpRange: { min: 5, max: 9 } }),
        leveling.updateLevelingConfig(client, guild, { ignoredChannels: [id(12)] }),
        leveling.setLevelRoleReward(client, guild, 5, id(13)),
        leveling.setLevelRoleReward(client, guild, 10, id(14)),
    ]);
    const stored = await leveling.getLevelingConfig(client, guild);
    assert.equal(stored.configured, true);
    assert.equal(stored.levelUpChannel, id(11));
    assert.equal(stored.xpCooldown, 45);
    assert.deepEqual(stored.xpRange, { min: 5, max: 9 });
    assert.deepEqual(stored.ignoredChannels, [id(12)]);
    assert.deepEqual(stored.roleRewards, { 5: id(13), 10: id(14) });
    // Ticket and verification settings in the same row are untouched.
    assert.equal((await tickets.getTicketSettings(client, guild)).maxTicketsPerUser, 5);
    assert.equal((await verification.getVerificationSettings(client, guild)).buttonText, 'Go');
});

test('applications, logging, counters, join-to-create, birthdays: concurrent dashboard + command writes lose nothing', { skip }, async () => {
    const apps = await import('../../src/services/applicationSettingsService.js');
    const logging = await import('../../src/services/loggingService.js');
    const counters = await import('../../src/services/serverstatsService.js');
    const database = await import('../../src/utils/database.js');
    const jtc = await import('../../src/services/joinToCreateService.js');
    const birthdays = await import('../../src/services/birthdayService.js');

    await Promise.all([
        apps.updateApplicationSettings(client, guild, { enabled: true }),
        apps.updateApplicationSettings(client, guild, { logChannelId: id(20) }),
        apps.updateApplicationSettings(client, guild, { pendingApplicationRetentionDays: 9, reviewedApplicationRetentionDays: 8 }),
        apps.updateApplicationSettings(client, guild, { managerRoles: [id(21)] }),
    ]);
    const a = await database.getApplicationSettings(client, guild);
    assert.deepEqual([a.enabled, a.logChannelId, a.pendingApplicationRetentionDays, a.reviewedApplicationRetentionDays, a.managerRoles], [true, id(20), 9, 8, [id(21)]]);

    await Promise.all([
        logging.setLoggingEnabled(client, guild, true),
        logging.setLogChannel(client, guild, 'reports', id(22)),
        logging.toggleEventLogging(client, guild, ['message.delete'], false),
        logging.updateIgnoreList(client, guild, { action: 'add', type: 'user', id: id(23) }),
        birthdays.updateBirthdaySettings(client, guild, { roleId: id(24), timezone: 'europe/london' }),
    ]);
    const status = await logging.getLoggingStatus(client, guild);
    assert.equal(status.enabled, true);
    assert.equal(status.channels.reports, id(22));
    assert.equal(status.enabledEvents['message.delete'], false);
    assert.deepEqual(status.ignore.users, [id(23)]);
    const config = await (await import('../../src/services/config/guildConfig.js')).getGuildConfig(client, guild);
    assert.equal(config.birthdayRoleId, id(24));
    assert.equal(config.birthdayTimezone, 'Europe/London', 'time zone canonicalized');
    assert.equal(config.maxTicketsPerUser, 5, 'ticket settings untouched');

    await counters.mutateServerCounters(client, guild, () => [
        { id: 'a', type: 'members', channelId: id(30) }, { id: 'b', type: 'bots', channelId: id(31) }, { id: 'c', type: 'members_only', channelId: id(32) },
    ]);
    const fakeGuild = { id: guild, channels: { cache: new Map() } };
    await Promise.all([
        counters.removeServerCounter(client, fakeGuild, 'a'),
        counters.removeServerCounter(client, fakeGuild, 'b'),
    ]);
    assert.deepEqual((await counters.getServerCounters(client, guild)).map((c) => c.id), ['c']);
    await assert.rejects(counters.removeServerCounter(client, fakeGuild, 'zzz'), (error) => /was not found/.test(error.userMessage));

    await database.addJoinToCreateTrigger(client, guild, id(40));
    await database.addJoinToCreateTrigger(client, guild, id(41));
    await Promise.all([
        jtc.updateChannelConfig(client, guild, id(40), { userLimit: 5 }),
        jtc.updateChannelConfig(client, guild, id(40), { bitrate: 96000 }),
        jtc.removeTriggerChannel(client, guild, id(41)),
    ]);
    const j = await database.getJoinToCreateConfig(client, guild);
    assert.deepEqual(j.triggerChannels, [id(40)]);
    assert.equal(j.channelOptions[id(40)].userLimit, 5);
    assert.equal(j.channelOptions[id(40)].bitrate, 96000);
    await assert.rejects(jtc.updateChannelConfig(client, guild, id(41), { userLimit: 1 }), (error) => /not set up as a Join to Create trigger/.test(error.userMessage));
});
