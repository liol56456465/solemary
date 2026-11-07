// Appeal routing against the local test database (npm run test:db):
//   - ban and kick appeals: a support-server channel with the appellant (member-safe summary
//     only) plus an admin-only staff channel in the main server with the dossier and buttons;
//   - mute and warn appeals open staff-only in the main server;
//   - no support category (or the appellant not in the support server): staff-only in main;
//   - a decision shows the appellant no admin name or note; the staff channel gets the details.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const skip = isLocalDatabaseUrl(process.env.POSTGRES_URL || '') ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
const runId = String(Date.now()).slice(-9);
const id = (prefix, n) => `${prefix}${runId}${String(n).padStart(8, '0')}`;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
let seq = Number(runId) * 7;
const caseCode = () => { let out = ''; let x = (seq += 13); for (let i = 0; i < 7; i += 1) { out += ALPHA[x % ALPHA.length]; x = Math.floor(x / ALPHA.length); } return out; };
let pgDb, appeals, enforcementConfig, settings;
let n = 100; // channel numbers, unique across all fake worlds in this file
const OTHER_GUILD = id('5', 1); // not a home server

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    ({ enforcementConfig } = await import('../../src/config/enforcement.js'));
    appeals = await import('../../src/services/enforcement/appealService.js');
    settings = await import('../../src/services/settings/guildSettings.js');
    // The appeals category is read per server (resolveSetting), so it is set in the main
    // server's cached settings row instead of pinned on enforcementConfig.
    settings.setSettingsCacheForTests(enforcementConfig.mainGuildId, { appealsCategoryId: id('7', 1) });
});

after(async () => {
    if (skip) return;
    settings.setSettingsCacheForTests(enforcementConfig.mainGuildId, null);
    settings.setSettingsCacheForTests(OTHER_GUILD, null);
    enforcementConfig.supportAppealsCategoryId = undefined;
    await pgDb.pool.query(`DELETE FROM mod_appeals WHERE user_id LIKE $1`, [`6${runId}%`]);
    await pgDb.pool.query(`DELETE FROM mod_cases WHERE target_user_id LIKE $1`, [`6${runId}%`]);
    await pgDb.disconnect();
});

function world({ appellantInSupport = true, appellantIsSupportAdmin = false } = {}) {
    const sent = []; // { where, payload }
    const dms = [];
    const makeGuild = (gid, categoryId) => {
        const guild = { id: gid, created: [] };
        const makeChannel = (options, type = ChannelType.GuildText) => {
            const channel = {
                id: id('8', (n += 1)), guild, type, ...options,
                send: async (payload) => { sent.push({ where: channel, payload }); return payload; },
                messages: { fetch: async () => new Map() },
                removedMembers: [],
                members: { remove: async (uid) => { channel.removedMembers.push(uid); } },
                delete: async () => { guild.channels.cache.delete(channel.id); },
                threads: {
                    create: async (threadOptions) => {
                        const thread = makeChannel({ ...threadOptions, parentId: channel.id }, threadOptions.type);
                        guild.created.push(thread);
                        return thread;
                    },
                },
            };
            guild.channels.cache.set(channel.id, channel);
            return channel;
        };
        guild.channels = {
            cache: new Map(),
            fetch: async (cid) => guild.channels.cache.get(cid) || (cid === categoryId ? { id: cid, type: ChannelType.GuildCategory } : null),
            create: async (options) => { const channel = makeChannel(options); guild.created.push(channel); return channel; },
        };
        return guild;
    };
    const main = makeGuild(enforcementConfig.mainGuildId, id('7', 1));
    const support = makeGuild(enforcementConfig.supportGuildId, id('7', 2));
    support.members = { fetch: async ({ user }) => (appellantInSupport
        ? { id: user, permissions: { has: (p) => appellantIsSupportAdmin && p === PermissionFlagsBits.Administrator } }
        : Promise.reject(new Error('Unknown Member'))) };
    main.members = { fetch: async () => null };
    const client = {
        user: { id: '999999999999999998' },
        guilds: { cache: new Map([[main.id, main], [support.id, support]]) },
        users: { fetch: async (uid) => ({ id: uid, username: 'appellant', send: async (payload) => { dms.push(payload); return payload; } }) },
        channels: { fetch: async () => null },
    };
    main.client = client;
    support.client = client;
    return { client, main, support, sent, dms };
}

async function insertCase(type, target, { guildId = enforcementConfig.mainGuildId } = {}) {
    const code = caseCode();
    await pgDb.pool.query(
        `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, status)
         VALUES ($1, $2, $3, 'appellant', $4, 'secretmod', $5, $6, 'Spam', 'prebuilt', 'active')`,
        [guildId, code, target, id("6", 999), type, `appellant ${type} ${code}`]);
    return code;
}

const text = (payload) => JSON.stringify(payload);

for (const type of ['ban', 'kick']) {
    test(`${type} appeal: support channel with the appellant (safe summary); dossier + buttons in a main-server staff channel`, { skip }, async () => {
        enforcementConfig.supportAppealsCategoryId = id('7', 2);
        const w = world();
        const user = { id: id('6', type === 'ban' ? 1 : 2), username: 'appellant' };
        const code = await insertCase(type, user.id);
        const { channel, staffChannel } = await appeals.submitAppeal({ client: w.client, user, caseCode: code, answers: { reason: 'I am sorry, it will not happen again', didIt: 'yes' } });

        assert.equal(channel.guild.id, w.support.id, 'opened in the support server');
        assert.equal(channel.parent, id('7', 2), 'in the support appeals category');
        const overwrites = channel.permissionOverwrites;
        const everyone = overwrites.find((o) => o.id === w.support.id);
        assert.ok(everyone.deny.includes(PermissionFlagsBits.ViewChannel), '@everyone cannot see it');
        const appellant = overwrites.find((o) => o.id === user.id);
        assert.ok(appellant.allow.includes(PermissionFlagsBits.ViewChannel) && appellant.allow.includes(PermissionFlagsBits.SendMessages), 'appellant added');
        assert.ok(appellant.deny.includes(PermissionFlagsBits.CreatePrivateThreads));

        assert.equal(staffChannel.guild.id, w.main.id, 'staff side in the main server');
        assert.equal(staffChannel.parent, id('7', 1), 'in the main appeals category');
        assert.ok(!staffChannel.permissionOverwrites.some((o) => o.id === user.id), 'appellant not in the staff channel');
        assert.equal(w.support.created.length, 1, 'no thread or extra channel in support');

        const inChannel = text(w.sent.filter((s) => s.where === channel).map((s) => s.payload));
        assert.match(inChannel, new RegExp(code));
        assert.match(inChannel, /I am sorry/, 'their own answers');
        assert.ok(!inChannel.includes('secretmod') && !inChannel.includes(id('6', 999)), 'no moderator in what the appellant sees');
        assert.ok(!inChannel.includes('appealdecide'), 'no Accept / Deny where the appellant reads');
        const inStaff = w.sent.filter((s) => s.where === staffChannel).map((s) => s.payload);
        assert.match(text(inStaff), /secretmod/, 'full dossier in the staff channel');
        assert.match(text(inStaff), /appealdecide:accept/, 'buttons in the staff channel');
        assert.match(text(inStaff), new RegExp(channel.id), 'link to the support conversation');

        const { rows: [row] } = await pgDb.pool.query(`SELECT guild_id, channel_id, channel_guild_id, staff_channel_id FROM mod_appeals WHERE case_code = $1`, [code]);
        assert.deepEqual(row, { guild_id: enforcementConfig.mainGuildId, channel_id: channel.id, channel_guild_id: w.support.id, staff_channel_id: staffChannel.id });
    });
}

for (const type of ['mute', 'warn']) {
    test(`${type} appeal: staff-only channel in the main server, appellant not added`, { skip }, async () => {
        enforcementConfig.supportAppealsCategoryId = id('7', 2);
        const w = world();
        const user = { id: id('6', type === 'mute' ? 3 : 4), username: 'appellant' };
        const code = await insertCase(type, user.id);
        if (type === 'mute') await pgDb.pool.query(`UPDATE mod_cases SET expires_at = NOW() + INTERVAL '1 day', duration_ms = 86400000 WHERE case_code = $1`, [code]);
        const { channel, staffChannel } = await appeals.submitAppeal({ client: w.client, user, caseCode: code, answers: { reason: 'Please lift this, I understand now' } });
        assert.equal(channel.guild.id, w.main.id);
        assert.equal(staffChannel, channel);
        assert.ok(!channel.permissionOverwrites.some((o) => o.id === user.id), 'appellant not added');
        assert.equal(w.support.created.length, 0);
    });
}

test('ban appeal falls back to staff-only in main when the support category is not set or the appellant is not in support', { skip }, async () => {
    enforcementConfig.supportAppealsCategoryId = null;
    let w = world();
    const first = { id: id('6', 5), username: 'appellant' };
    let res = await appeals.submitAppeal({ client: w.client, user: first, caseCode: await insertCase('ban', first.id), answers: { reason: 'Please unban me, I learned my lesson' } });
    assert.equal(res.channel.guild.id, w.main.id, 'no support category: main');

    enforcementConfig.supportAppealsCategoryId = id('7', 2);
    w = world({ appellantInSupport: false });
    const second = { id: id('6', 6), username: 'appellant' };
    res = await appeals.submitAppeal({ client: w.client, user: second, caseCode: await insertCase('ban', second.id), answers: { reason: 'Please unban me, I learned my lesson' } });
    assert.equal(res.channel.guild.id, w.main.id, 'not in support: main');
    assert.equal(w.support.created.length, 0);
});

test('decision on a support appeal: the appellant sees no admin name or note; the staff channel gets the details', { skip }, async () => {
    enforcementConfig.supportAppealsCategoryId = id('7', 2);
    const w = world();
    const user = { id: id('6', 7), username: 'appellant' };
    const code = await insertCase('kick', user.id);
    const { channel, staffChannel } = await appeals.submitAppeal({ client: w.client, user, caseCode: code, answers: { reason: 'It was a misunderstanding, please' } });
    w.sent.length = 0;
    await appeals.decideAppeal({ client: w.client, admin: { id: id('6', 998), username: 'secretadmin' }, caseCode: code, decision: 'deny', note: 'internal: repeat offender' });
    const inChannel = text(w.sent.filter((s) => s.where === channel).map((s) => s.payload));
    assert.match(inChannel, /denied/);
    assert.ok(!inChannel.includes('secretadmin') && !inChannel.includes('repeat offender'), 'no admin or note for the appellant');
    const inStaff = text(w.sent.filter((s) => s.where === staffChannel).map((s) => s.payload));
    assert.match(inStaff, /secretadmin/);
    assert.match(inStaff, /repeat offender/);
});

// ── Another (non-home) server: never a channel in Mewvo's main or Support server ──

function withOtherGuild(w, categoryId) {
    const other = { id: OTHER_GUILD, created: [], client: w.client };
    other.channels = {
        cache: new Map(),
        fetch: async (cid) => other.channels.cache.get(cid) || (categoryId && cid === categoryId ? { id: cid, type: ChannelType.GuildCategory } : null),
        create: async (options) => {
            const channel = { id: id('8', (n += 1)), guild: other, ...options, send: async (payload) => { w.sent.push({ where: channel, payload }); return payload; }, messages: { fetch: async () => new Map() } };
            other.channels.cache.set(channel.id, channel);
            other.created.push(channel);
            return channel;
        },
    };
    w.client.guilds.cache.set(other.id, other);
    // Its guild config reads fine and has no /ticket category.
    w.client.db = { get: async (key, fallback) => fallback };
    return other;
}

test('non-home ban appeal without an appeals category: stored, no channel anywhere (dashboard / web form only)', { skip }, async () => {
    enforcementConfig.supportAppealsCategoryId = id('7', 2);
    settings.setSettingsCacheForTests(OTHER_GUILD, {}); // its settings were read: nothing stored
    const w = world();
    const other = withOtherGuild(w, null);
    const user = { id: id('6', 11), username: 'appellant' };
    const code = await insertCase('ban', user.id, { guildId: OTHER_GUILD });
    const res = await appeals.submitAppeal({ client: w.client, user, caseCode: code, answers: { reason: 'Please unban me, I learned my lesson' } });
    assert.equal(res.channel, null);
    assert.equal(res.staffChannel, null);
    assert.equal(res.storedOnly, true);
    assert.equal(w.main.created.length + w.support.created.length + other.created.length, 0, 'no channel in main, support or the server itself');
    const { rows: [row] } = await pgDb.pool.query(`SELECT guild_id, status, channel_id, channel_guild_id, staff_channel_id FROM mod_appeals WHERE case_code = $1`, [code]);
    assert.deepEqual(row, { guild_id: OTHER_GUILD, status: 'pending', channel_id: null, channel_guild_id: null, staff_channel_id: null });
    const { rows: [kase] } = await pgDb.pool.query(`SELECT status FROM mod_cases WHERE case_code = $1`, [code]);
    assert.equal(kase.status, 'appeal_pending');

    // Its guild config cannot be read: an error, never a silent store-only appeal.
    const w2 = world();
    withOtherGuild(w2, null);
    delete w2.client.db;
    const user2 = { id: id('6', 14), username: 'appellant' };
    const code2 = await insertCase('ban', user2.id, { guildId: OTHER_GUILD });
    await assert.rejects(appeals.submitAppeal({ client: w2.client, user: user2, caseCode: code2, answers: { reason: 'Please unban me, I learned my lesson' } }),
        { message: 'Database client unavailable for guild config' });
    const { rows: none } = await pgDb.pool.query(`SELECT 1 FROM mod_appeals WHERE case_code = $1`, [code2]);
    assert.equal(none.length, 0, 'nothing stored');
});

test('non-home kick appeal with its own appeals category: staff channel in that server only, never in Support', { skip }, async () => {
    enforcementConfig.supportAppealsCategoryId = id('7', 2);
    settings.setSettingsCacheForTests(OTHER_GUILD, { appealsCategoryId: id('7', 3) });
    const w = world();
    const other = withOtherGuild(w, id('7', 3));
    const user = { id: id('6', 12), username: 'appellant' };
    const code = await insertCase('kick', user.id, { guildId: OTHER_GUILD });
    const { channel, staffChannel } = await appeals.submitAppeal({ client: w.client, user, caseCode: code, answers: { reason: 'It was a misunderstanding, please' } });
    assert.equal(staffChannel.guild.id, OTHER_GUILD);
    assert.equal(staffChannel.parent, id('7', 3), 'in its own appeals category');
    assert.equal(channel, staffChannel, 'no separate Support conversation');
    assert.equal(w.main.created.length + w.support.created.length, 0, "nothing in Mewvo's servers");
    assert.equal(other.created.length, 1);
    const { rows: [row] } = await pgDb.pool.query(`SELECT guild_id, channel_guild_id, staff_channel_id FROM mod_appeals WHERE case_code = $1`, [code]);
    assert.deepEqual(row, { guild_id: OTHER_GUILD, channel_guild_id: OTHER_GUILD, staff_channel_id: null });
});

test('non-home appeal: its own appeal window, not the main server\'s', { skip }, async () => {
    settings.setSettingsCacheForTests(OTHER_GUILD, { appealWindowMs: 86400000 });
    const user = { id: id('6', 13), username: 'appellant' };
    const code = await insertCase('warn', user.id, { guildId: OTHER_GUILD });
    await pgDb.pool.query(`UPDATE mod_cases SET created_at = NOW() - INTERVAL '3 days' WHERE case_code = $1`, [code]);
    const record = (await pgDb.pool.query(`SELECT * FROM mod_cases WHERE case_code = $1`, [code])).rows[0];
    await assert.rejects(appeals.assertAppealable(record, user.id), /within 1 day\./);
    settings.setSettingsCacheForTests(OTHER_GUILD, null);
    await assert.rejects(appeals.assertAppealable(record, user.id), { name: 'SettingsUnavailableError' }, 'unknown settings: an error, never defaults');
});
