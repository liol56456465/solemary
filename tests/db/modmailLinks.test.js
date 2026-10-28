// Modmail links against the local test database (npm run test:db): the channel ↔ member link
// lives in modmail_links only. A channel whose topic names a member is NOT a modmail channel
// unless it is linked; channels from before the table are imported once from their topic, and
// a topic faked after that import changes nothing.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const skip = isLocalDatabaseUrl(process.env.POSTGRES_URL || '') ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
const runId = String(Date.now()).slice(-9);
const guildId = `9${runId}00000009`;
const id = (prefix, n) => `${prefix}${runId}${String(n).padStart(8, '0')}`;
let pgDb, db, links, modmail, enforcementConfig;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    links = await import('../../src/services/modmailLinks.js');
    ({ enforcementConfig } = await import('../../src/config/enforcement.js'));
    enforcementConfig.modmailCategoryId = CATEGORY;
    modmail = await import('../../src/services/modmailService.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM modmail_links WHERE guild_id = $1', [guildId]);
    await db.delete(`modmail:links:imported:${guildId}`).catch(() => {});
    enforcementConfig.modmailCategoryId = undefined;
    await pgDb.disconnect();
});

const BOT = '999999999999999998';
const CATEGORY = id('7', 1);
const bits = (list) => ({ has: (p) => list.includes(p) });
const fakeGuild = () => {
    const client = { user: { id: BOT }, users: { fetch: async (u) => ({ id: u, send: async (m) => dms.push({ to: u, m }) }) } };
    const guild = { id: guildId, client, members: { me: { id: BOT } }, channels: { cache: new Map() } };
    const dms = [];
    // botMade: what openModmail creates (text channel in the category, @everyone denied, bot allowed Manage Channels).
    const channel = (n, topic, { botMade = true, parentId = CATEGORY } = {}) => {
        const overwrites = botMade
            ? new Map([[guildId, { deny: bits([PermissionFlagsBits.ViewChannel]), allow: bits([]) }], [BOT, { deny: bits([]), allow: bits([PermissionFlagsBits.ManageChannels]) }]])
            : new Map();
        const c = { id: id('8', n), name: `chan${n}`, type: ChannelType.GuildText, parentId, topic, guild, client, permissionOverwrites: { cache: overwrites } };
        guild.channels.cache.set(c.id, c);
        return c;
    };
    return { guild, channel, dms };
};

test('one-time import links pre-existing channels from their topic; a topic faked afterwards changes nothing', { skip }, async () => {
    links.resetModmailLinksForTests();
    const { guild, channel, dms } = fakeGuild();
    const victim = id('6', 1);
    const legacy = channel(1, `modmail:${id('6', 2)}`);
    // Faked before the first import: not bot-made, or outside the category, or two claims on one member.
    const lookalike = channel(10, `modmail:${id('6', 10)}`, { botMade: false });
    const elsewhere = channel(11, `modmail:${id('6', 11)}`, { parentId: id('7', 9) });
    const twinA = channel(12, `modmail:${id('6', 12)}`);
    const twinB = channel(13, `modmail:${id('6', 12)}`);
    assert.equal(await links.importModmailTopicsOnce(guild), 1, 'only the real one');
    for (const c of [lookalike, elsewhere, twinA, twinB]) assert.equal(await modmail.modmailUserId(c), null, `${c.name} not imported`);
    assert.equal(await modmail.findModmailChannel(guild, id('6', 12)), null, 'a disputed member gets no channel');
    assert.equal(await modmail.modmailUserId(legacy), id('6', 2), 'imported');

    // Someone with Manage Channels creates a channel whose topic names another member.
    const fake = channel(3, `modmail:${victim}`);
    assert.equal(await links.importModmailTopicsOnce(guild), null, 'the import never runs twice');
    assert.equal(await modmail.modmailUserId(fake), null, 'a faked topic is not a modmail channel');
    assert.equal(await modmail.findModmailChannel(guild, victim), null, 'the victim\'s DMs do not go there');
    const handled = await modmail.handleModmailStaffMessage({ channel: fake, content: 'hello', client: fake.client, author: { username: 'rogue' } });
    assert.equal(handled, false, 'nothing typed there reaches the victim');
    assert.deepEqual(dms, []);
    // The mirror is not the source: a fresh read from the database agrees.
    links.resetModmailLinksForTests();
    assert.equal(await modmail.modmailUserId(fake), null);
    assert.equal(await modmail.modmailUserId(legacy), id('6', 2));
});

test('links: one channel per member; unlink frees the member; a link to a deleted channel is cleaned up', { skip }, async () => {
    links.resetModmailLinksForTests();
    const { guild, channel } = fakeGuild();
    const member = id('6', 5);
    const first = channel(5, null);
    await links.linkModmailChannel(guildId, first.id, member);
    await assert.rejects(links.linkModmailChannel(guildId, channel(6, null).id, member), /duplicate key|unique/i);
    assert.equal((await modmail.findModmailChannel(guild, member)).id, first.id);
    await links.unlinkModmailChannel(first.id);
    assert.equal(await modmail.findModmailChannel(guild, member), null);

    const gone = channel(7, null);
    await links.linkModmailChannel(guildId, gone.id, member);
    guild.channels.cache.delete(gone.id); // deleted while the bot was offline
    assert.equal(await modmail.findModmailChannel(guild, member), null);
    const { rows } = await pgDb.pool.query('SELECT 1 FROM modmail_links WHERE channel_id = $1', [gone.id]);
    assert.equal(rows.length, 0, 'stale link removed');
});
