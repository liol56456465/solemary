// Appeal routing against the local test database (npm run test:db):
//   - ban and kick appeals open in the support server; the appellant is added to the channel
//     and sees a member-safe summary only; the dossier and Accept / Deny are in a private
//     staff thread they are not in;
//   - mute and warn appeals open staff-only in the main server;
//   - no support category (or the appellant not in the support server): staff-only in main;
//   - a decision shows the appellant no admin name or note; the staff thread gets the details.
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
let pgDb, appeals, enforcementConfig;
const saved = {};

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    ({ enforcementConfig } = await import('../../src/config/enforcement.js'));
    appeals = await import('../../src/services/enforcement/appealService.js');
    saved.appeals = enforcementConfig.appealsCategoryId;
    enforcementConfig.appealsCategoryId = id('7', 1);
});

after(async () => {
    if (skip) return;
    enforcementConfig.appealsCategoryId = saved.appeals;
    enforcementConfig.supportAppealsCategoryId = undefined;
    await pgDb.pool.query(`DELETE FROM mod_appeals WHERE user_id LIKE $1`, [`6${runId}%`]);
    await pgDb.pool.query(`DELETE FROM mod_cases WHERE target_user_id LIKE $1`, [`6${runId}%`]);
    await pgDb.disconnect();
});

function world({ appellantInSupport = true } = {}) {
    const sent = []; // { where, payload }
    const dms = [];
    let n = 100;
    const makeGuild = (gid, categoryId) => {
        const guild = { id: gid, created: [] };
        const makeChannel = (options, type = ChannelType.GuildText) => {
            const channel = {
                id: id('8', (n += 1)), guild, type, ...options,
                send: async (payload) => { sent.push({ where: channel, payload }); return payload; },
                messages: { fetch: async () => new Map() },
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
    support.members = { fetch: async ({ user }) => (appellantInSupport ? { id: user } : Promise.reject(new Error('Unknown Member'))) };
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

async function insertCase(type, target, extra = {}) {
    const code = caseCode();
    await pgDb.pool.query(
        `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, status)
         VALUES ($1, $2, $3, 'appellant', $4, 'secretmod', $5, $6, 'Spam', 'prebuilt', 'active')`,
        [enforcementConfig.mainGuildId, code, target, id("6", 999), type, `appellant ${type} ${code}`]);
    return code;
}

const text = (payload) => JSON.stringify(payload);

for (const type of ['ban', 'kick']) {
    test(`${type} appeal: support server, appellant added and sees only a safe summary; dossier + buttons in a private staff thread`, { skip }, async () => {
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

        assert.equal(staffChannel.type, ChannelType.PrivateThread, 'staff thread is private');
        assert.equal(staffChannel.invitable, false);
        assert.equal(staffChannel.parentId, channel.id);

        const inChannel = text(w.sent.filter((s) => s.where === channel).map((s) => s.payload));
        assert.match(inChannel, new RegExp(code));
        assert.match(inChannel, /I am sorry/, 'their own answers');
        assert.ok(!inChannel.includes('secretmod') && !inChannel.includes(id('6', 999)), 'no moderator in what the appellant sees');
        assert.ok(!inChannel.includes('appealdecide'), 'no Accept / Deny where the appellant reads');
        const inThread = w.sent.filter((s) => s.where === staffChannel).map((s) => s.payload);
        assert.match(text(inThread), /secretmod/, 'full dossier in the staff thread');
        assert.match(text(inThread), /appealdecide:accept/, 'buttons in the staff thread');

        const { rows: [row] } = await pgDb.pool.query(`SELECT guild_id, channel_id, channel_guild_id, staff_thread_id FROM mod_appeals WHERE case_code = $1`, [code]);
        assert.deepEqual(row, { guild_id: enforcementConfig.mainGuildId, channel_id: channel.id, channel_guild_id: w.support.id, staff_thread_id: staffChannel.id });
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

test('decision on a support appeal: the appellant sees no admin name or note; the staff thread gets the details', { skip }, async () => {
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
    const inThread = text(w.sent.filter((s) => s.where === staffChannel).map((s) => s.payload));
    assert.match(inThread, /secretadmin/);
    assert.match(inThread, /repeat offender/);
});
