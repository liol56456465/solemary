// The Automod log (owner, 2026-11-13) against the local test database (npm run test:db): a warn by
// automod (executeSystemAction: the bot is the moderator) and the ladder ban it triggers go to the
// Automod log, not the mod log; the same warn by a staff member stays in the mod log. Without an
// Automod log the automod warn goes to the mod log as before.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const runId = String(Date.now()).slice(-9);
const GUILD = `7${runId}00000051`; // never a home server
const GUILD_NONE = `7${runId}00000052`;
const TARGET = `6${runId}00000051`;
const MOD = `6${runId}00000052`;
const BOT = `5${runId}00000051`;
const MODLOG = `8${runId}00000051`;
const AUTOMOD = `8${runId}00000052`;

let pgDb, db, enforcement, guildSettings;

function store(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        async get(key, fallback = null) { return data.has(key) ? structuredClone(data.get(key)) : fallback; },
        async set(key, value) { data.set(key, structuredClone(value)); return true; },
        async delete(key) { return data.delete(key); },
        async update(key, mutator, fallback = null) {
            const next = await mutator(data.has(key) ? structuredClone(data.get(key)) : fallback);
            data.set(key, structuredClone(next));
            return next;
        },
    };
}

function fakeGuild(guildId, logging) {
    const bans = [];
    const botUser = { id: BOT, username: 'Mewvo', bot: true };
    const client = {
        user: botUser, guilds: { cache: new Map(), fetch: async () => null }, users: { cache: new Map(), fetch: async () => null },
        db: store({ [`guild:${guildId}:config`]: { logging: { enabled: true, ...logging } } }),
    };
    const channels = new Map();
    const text = (id) => {
        const channel = { id, type: ChannelType.GuildText, guildId, sent: [], permissionsFor: () => ({ has: () => true }), isTextBased: () => true };
        channel.send = async (m) => { channel.sent.push(m); return { id: `m${channel.sent.length}` }; };
        channels.set(id, channel);
        return channel;
    };
    const modlog = text(MODLOG);
    const automod = text(AUTOMOD);
    const guild = { id: guildId, name: 'Automod log test', ownerId: '999999999999999999', client, channels: { cache: channels, fetch: async (id) => channels.get(id) || null }, roles: { cache: new Map() }, iconURL: () => null };
    client.guilds.cache.set(guildId, guild);
    const me = { id: BOT, user: botUser, guild, permissions: { has: () => true }, roles: { highest: { position: 100 }, cache: new Map() } };
    const target = {
        id: TARGET, guild, user: { id: TARGET, username: 'target' },
        roles: { highest: { position: 1 }, cache: new Map(), add: async () => {}, remove: async () => {} },
        permissions: { has: () => false },
    };
    const moderator = { id: MOD, guild, user: { id: MOD, username: 'mod' }, permissions: { has: () => true }, roles: { highest: { position: 50 }, cache: new Map() } };
    guild.members = {
        me, cache: new Map([[TARGET, target]]),
        fetch: async (id) => { if (id === TARGET) return target; throw new Error('Unknown member'); },
        fetchMe: async () => me,
        ban: async (id) => { bans.push(id); },
        unban: async () => {},
    };
    guild.bans = { fetch: async () => null };
    const targetUser = { id: TARGET, username: 'target', send: async () => ({ id: 'm1', channelId: 'c1' }) };
    return { guild, targetUser, moderator, bans, modlog, automod };
}

const flow = (n, reason = 'Automod: Spam') => ({
    type: 'warn', reason, reasonSource: 'prebuilt', reasonKey: 'automod:spam',
    durationMs: null, unappealable: false, name: `target warn ${n}`, nameIsDefault: false,
});
const lines = (channel) => channel.sent.map((m) => m.embeds[0].data.description || m.embeds[0].data.title);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    enforcement = await import('../../src/services/enforcement/enforcementService.js');
    guildSettings = await import('../../src/services/settings/guildSettings.js');
    // Automod warns count on the ladder here, so the third one is an automatic ban.
    guildSettings.setSettingsCacheForTests(GUILD, { modLogChannelId: MODLOG, automodWarnsCountOnLadder: true });
    guildSettings.setSettingsCacheForTests(GUILD_NONE, { modLogChannelId: MODLOG });
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_cases WHERE guild_id = ANY($1)', [[GUILD, GUILD_NONE]]);
    await pgDb.pool.query('DELETE FROM mod_ladder WHERE guild_id = ANY($1)', [[GUILD, GUILD_NONE]]);
    await pgDb.pool.query('DELETE FROM bot_dm_log WHERE guild_id = ANY($1)', [[GUILD, GUILD_NONE]]).catch(() => {});
    guildSettings.resetSettingsCacheForTests();
    await pgDb.disconnect();
});

test('automod warns and their ladder ban go to the Automod log; a staff warn stays in the mod log', { skip }, async () => {
    const { guild, targetUser, moderator, bans, modlog, automod } = fakeGuild(GUILD, { channels: { automod: AUTOMOD } });
    const staff = await enforcement.executeAction({ guild, moderator, targetUser, flow: flow(0, 'Spam') });
    assert.ok(staff.record?.case_code);
    assert.equal(modlog.sent.length, 1, 'control: the staff warn is in the mod log');
    assert.match(lines(modlog)[0], /by mod/);
    assert.equal(automod.sent.length, 0);

    for (const n of [1, 2]) await enforcement.executeSystemAction({ guild, targetUser, flow: flow(n) });
    assert.deepEqual(bans, [TARGET], 'the second automod warn is the third counted one: an automatic ban');
    assert.equal(modlog.sent.length, 1, 'nothing automatic in the mod log');
    // Two warns and the ladder ban.
    assert.equal(automod.sent.length, 3);
    assert.ok(lines(automod).every((line) => /by Mewvo/.test(line)), lines(automod).join('\n'));
    assert.match(lines(automod)[2], /^\*\*Ban\*\*/);
    assert.ok(automod.sent.every((m) => m.allowedMentions?.parse?.length === 0));
});

test('no Automod log set: an automod warn goes to the mod log, as before', { skip }, async () => {
    const { guild, targetUser, modlog, automod } = fakeGuild(GUILD_NONE, { channels: {} });
    await enforcement.executeSystemAction({ guild, targetUser, flow: flow(9) });
    assert.equal(modlog.sent.length, 1);
    assert.match(lines(modlog)[0], /by Mewvo/);
    assert.equal(automod.sent.length, 0);
});
