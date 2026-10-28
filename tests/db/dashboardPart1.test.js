// "Everything from the web" against the local test database: the service functions
// extracted from the commands (application roles, counters, giveaways, reaction role
// panels, ticket / verification setup, join to create) with the real storage and a
// fake guild (Discord objects only). Concurrent writes must not lose data and refused
// requests must leave nothing behind.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, client;
let apps, counters, giveaways, reactionRoles, ticketPanel, ticketSettings, verificationPanel, verificationSettings, jtc;

const runId = String(Date.now()).slice(-9);
const guildId = `7${runId}00000009`;
const id = (n) => `6${runId}${String(n).padStart(8, '0')}`;
let nextId = 500;
const newId = () => id(nextId += 1);
/** Rejects with a user-facing message (userMessage, else message) matching re. */
const rejectsUser = (promise, re) => assert.rejects(promise, (error) => { assert.match(error.userMessage || error.message, re); return true; });

// ── a fake guild: channels that record what was sent, roles, the bot's member ──

function makeGuild() {
    const guild = { id: guildId, name: 'Test', memberCount: 10 };
    const sent = [];
    const deleted = [];
    const permissions = (allowed = true) => ({ has: () => allowed });
    const makeChannel = (props) => {
        const messages = new Collection();
        const channel = {
            guild, parentId: null, rawPosition: 0, ...props,
            isTextBased: () => props.type === ChannelType.GuildText || props.type === ChannelType.GuildAnnouncement,
            permissionsFor: () => permissions(true),
            toString: () => `<#${props.id}>`,
            async send(payload) {
                const message = {
                    id: newId(), channel, channelId: props.id, author: { id: client.user.id }, url: `https://discord.com/channels/${guildId}/${props.id}/x`,
                    components: payload.components || [], embeds: payload.embeds || [], payload,
                    async edit(next) { message.payload = next; message.edited = true; return message; },
                    async delete() { messages.delete(message.id); deleted.push(message.id); },
                };
                messages.set(message.id, message);
                sent.push({ channelId: props.id, message });
                return message;
            },
            messages: {
                async fetch(arg) {
                    if (typeof arg === 'string') {
                        const found = messages.get(arg);
                        if (!found) throw new Error('Unknown Message');
                        return found;
                    }
                    return messages;
                },
            },
            async setName(name) { channel.name = name; return channel; },
            async delete() { guild.channels.cache.delete(props.id); deleted.push(props.id); },
        };
        return channel;
    };
    guild.channels = {
        cache: new Collection(),
        async fetch(channelId) { return guild.channels.cache.get(channelId) || null; },
        async create(options) {
            const channel = makeChannel({ id: newId(), name: options.name, type: options.type, parentId: options.parent || null });
            guild.channels.cache.set(channel.id, channel);
            return channel;
        },
    };
    const add = (props) => { const c = makeChannel(props); guild.channels.cache.set(c.id, c); return c; };
    const text = add({ id: id(1), name: 'general', type: ChannelType.GuildText });
    const category = add({ id: id(2), name: 'Stats', type: ChannelType.GuildCategory });
    const role = (rid, name, position, perms = [], managed = false) => ({
        id: rid, name, position, managed, guild, permissions: { has: (p) => perms.includes(p), toArray: () => perms }, toString: () => `<@&${rid}>`,
    });
    guild.roles = { cache: new Collection([
        [guildId, role(guildId, '@everyone', 0)],
        [id(10), role(id(10), 'Red', 1)], [id(11), role(id(11), 'Blue', 2)],
        [id(12), role(id(12), 'Mods', 3, [PermissionFlagsBits.Administrator, 'Administrator'])],
        [id(13), role(id(13), 'Owner', 50)],
    ]) };
    guild.roles.fetch = async (rid) => guild.roles.cache.get(rid) || null;
    guild.members = {
        cache: new Collection(),
        me: { id: client.user.id, permissions: { has: () => true }, roles: { highest: { position: 10 } }, permissionsIn: () => permissions(true) },
        async fetch() { return new Collection(); },
    };
    guild.client = client;
    return { guild, text, category, sent, deleted };
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    client = { db, user: { id: id(99) }, guilds: { cache: new Map() }, channels: { async fetch(cid) { return client.channelsById?.get(cid) || null; } } };
    apps = await import('../../src/services/applicationRoleService.js');
    counters = await import('../../src/services/serverstatsService.js');
    giveaways = await import('../../src/services/giveawayService.js');
    reactionRoles = await import('../../src/services/reactionRoleService.js');
    ticketPanel = await import('../../src/services/ticketPanelService.js');
    ticketSettings = await import('../../src/services/ticketSettingsService.js');
    verificationPanel = await import('../../src/services/verificationPanelService.js');
    verificationSettings = await import('../../src/services/verificationSettingsService.js');
    jtc = await import('../../src/services/joinToCreateService.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM giveaways WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.pool.query('DELETE FROM temp_data WHERE key LIKE $1', [`%${guildId}%`]).catch(() => {});
    await pgDb.pool.query('DELETE FROM guilds WHERE id = $1', [guildId]).catch(() => {});
    await pgDb.disconnect();
});

function world() {
    const w = makeGuild();
    client.guilds.cache = new Map([[guildId, w.guild]]);
    client.channelsById = w.guild.channels.cache;
    return w;
}

test('application roles: concurrent creates all survive; duplicate refused; update and delete', { skip }, async () => {
    world();
    await Promise.all([
        apps.createApplicationRole(client, guildId, { roleId: id(10), name: 'Red team', questions: 'Why red?\nAge? [min:2]' }),
        apps.createApplicationRole(client, guildId, { roleId: id(11), name: 'Blue team' }),
        apps.createApplicationRole(client, guildId, { roleId: id(13), name: 'Owners', questions: ['One?'] }),
    ]);
    let roles = await apps.listApplicationRoles(client, guildId);
    assert.deepEqual(roles.map((r) => r.roleId).sort(), [id(10), id(11), id(13)].sort());
    const red = roles.find((r) => r.roleId === id(10));
    assert.deepEqual(red.questions, ['Why red?', { question: 'Age?', minLength: 2 }]);
    assert.ok(roles.find((r) => r.roleId === id(11)).questions.length > 0, 'default questions');

    await rejectsUser(apps.createApplicationRole(client, guildId, { roleId: id(10), name: 'Again' }), /already configured/);
    await rejectsUser(apps.createApplicationRole(client, guildId, { roleId: id(12), name: 'x'.repeat(51) }), /limited to 50/);
    await rejectsUser(apps.createApplicationRole(client, guildId, { roleId: id(12), name: 'Too many', questions: 'a\nb\nc\nd\ne\nf' }), /At most 5/);

    const [one, two] = await Promise.all([
        apps.updateApplicationRole(client, guildId, id(10), { name: 'Red squad', enabled: false }),
        apps.updateApplicationRole(client, guildId, id(10), { questions: 'Why? [min:10]', logChannelId: id(1) }),
    ]);
    assert.ok(one.before && two.after);
    roles = await apps.listApplicationRoles(client, guildId);
    const after1 = roles.find((r) => r.roleId === id(10));
    assert.equal(after1.name, 'Red squad');
    assert.equal(after1.enabled, false);
    assert.deepEqual(after1.questions, [{ question: 'Why?', minLength: 10 }]);
    assert.equal(after1.logChannelId, id(1));

    const { deletedApplications } = await apps.deleteApplicationRole(client, guildId, id(13));
    assert.equal(deletedApplications, 0);
    roles = await apps.listApplicationRoles(client, guildId);
    assert.ok(!roles.some((r) => r.roleId === id(13)));
    await rejectsUser(apps.deleteApplicationRole(client, guildId, id(13)), /no longer exists/);
});

test('server counter: created in the category and saved; one per type (a second channel is removed again)', { skip }, async () => {
    const w = world();
    const { counter, channel, renamed } = await counters.createServerCounter(client, w.guild, { type: 'members', channelType: 'voice', category: w.category });
    assert.equal(renamed, true);
    assert.equal(channel.parentId, w.category.id);
    assert.equal(channel.type, ChannelType.GuildVoice);
    assert.match(channel.name, /10/);
    const stored = await counters.getServerCounters(client, guildId);
    assert.deepEqual(stored.map((c) => [c.id, c.type, c.channelId]), [[counter.id, 'members', channel.id]]);
    await rejectsUser(counters.createServerCounter(client, w.guild, { type: 'members', category: w.category }), /already exists/);
    await rejectsUser(counters.createServerCounter(client, w.guild, { type: 'members_only', category: w.text }), /valid category/);
    await rejectsUser(counters.createServerCounter(client, w.guild, { type: 'cats', category: w.category }), /Unknown counter type/);
    // Two creates of the same type at once: exactly one survives, the loser's channel is deleted.
    const results = await Promise.allSettled([
        counters.createServerCounter(client, w.guild, { type: 'bots', category: w.category }),
        counters.createServerCounter(client, w.guild, { type: 'bots', category: w.category }),
    ]);
    const bots = (await counters.getServerCounters(client, guildId)).filter((c) => c.type === 'bots');
    assert.equal(bots.length, 1);
    if (results.every((r) => r.status === 'fulfilled')) assert.fail('both creates succeeded');
    const loser = results.find((r) => r.status === 'rejected');
    assert.match(loser.reason.userMessage, /already exists/);
    await counters.removeServerCounter(client, w.guild, counter.id);
    await counters.removeServerCounter(client, w.guild, bots[0].id);
});

test('giveaway: create posts and saves; bad input posts nothing; delete removes message and row', { skip }, async () => {
    const w = world();
    await rejectsUser(giveaways.createGiveaway(client, w.guild, { channel: w.text, duration: 'soon', winnerCount: 1, prize: 'x', hostId: id(50) }), /Invalid duration/);
    await rejectsUser(giveaways.createGiveaway(client, w.guild, { channel: w.text, duration: '1h', winnerCount: 99, prize: 'x', hostId: id(50) }), /Winner count/);
    await rejectsUser(giveaways.createGiveaway(client, w.guild, { channel: w.category, duration: '1h', winnerCount: 1, prize: 'x', hostId: id(50) }), /text channel/);
    assert.equal(w.sent.length, 0, 'nothing posted for bad input');
    const { giveaway, message } = await giveaways.createGiveaway(client, w.guild, { channel: w.text, duration: '2h', winnerCount: 2, prize: '  Nitro  ', hostId: id(50) });
    assert.equal(giveaway.prize, 'Nitro');
    assert.equal(giveaway.messageId, message.id);
    assert.ok(Math.abs(giveaway.endTime - (Date.now() + 2 * 3600000)) < 60000);
    const { getGuildGiveaways } = await import('../../src/utils/giveaways.js');
    assert.ok((await getGuildGiveaways(client, guildId)).some((g) => g.messageId === message.id && g.winnerCount === 2));
    const { deletedMessage } = await giveaways.deleteGiveawayNow(client, w.guild, message.id, id(50));
    assert.equal(deletedMessage, true);
    assert.ok(w.deleted.includes(message.id));
    assert.ok(!(await getGuildGiveaways(client, guildId)).some((g) => g.messageId === message.id));
    await rejectsUser(giveaways.deleteGiveawayNow(client, w.guild, message.id, id(50)), /No giveaway was found/);
});

test('reaction role panel: unsafe roles skipped and named, panel posted and saved; no valid role → nothing posted', { skip }, async () => {
    const w = world();
    await rejectsUser(reactionRoles.createReactionRolePanel(client, w.guild, { channel: w.text, title: 'T', description: 'D', roleIds: [id(12), id(13)] }), /cannot be added[^]*Mods[^]*Owner/);
    assert.equal(w.sent.length, 0);
    const { message, roles, rejected } = await reactionRoles.createReactionRolePanel(client, w.guild, {
        channel: w.text, title: 'Colours', description: 'Pick one', roleIds: [id(10), id(11), id(10), id(12)], actorId: id(50),
    });
    assert.deepEqual(roles.map((r) => r.id), [id(10), id(11)]);
    assert.equal(rejected.length, 2, 'duplicate + dangerous');
    assert.equal(message.payload.components[0].components[0].data.custom_id, 'reaction_roles');
    const panels = await reactionRoles.getAllReactionRoleMessages(client, guildId);
    assert.deepEqual(panels.find((p) => p.messageId === message.id).roles, [id(10), id(11)]);
    await reactionRoles.deletePanel(client, guildId, message.id, {});
});

test('ticket system: setup validates before posting, saves the panel id; second setup refused; publish refreshes or re-posts', { skip }, async () => {
    const w = world();
    await rejectsUser(ticketPanel.setupTicketSystem(client, w.guild, { panelChannel: w.text, maxTicketsPerUser: 50 }), /between 1 and 10/);
    assert.equal(w.sent.length, 0, 'nothing posted for bad input');
    const { message } = await ticketPanel.setupTicketSystem(client, w.guild, { panelChannel: w.text, panelMessage: 'Need help?', buttonLabel: 'Open', maxTicketsPerUser: 2, dmOnClose: false });
    const stored = await ticketSettings.getTicketSettings(client, guildId);
    assert.equal(stored.ticketPanelChannelId, w.text.id);
    assert.equal(stored.ticketPanelMessageId, message.id);
    assert.equal(stored.maxTicketsPerUser, 2);
    assert.equal(message.payload.components[0].components[0].data.custom_id, 'create_ticket');
    await rejectsUser(ticketPanel.setupTicketSystem(client, w.guild, { panelChannel: w.text }), /already has a ticket system/);
    await ticketSettings.updateTicketSettings(client, guildId, { ticketPanelMessage: 'New text' });
    assert.deepEqual(await ticketPanel.publishTicketPanel(client, w.guild), { action: 'updated' });
    assert.equal(message.payload.embeds[0].data.description, 'New text');
    await message.delete();
    const reposted = await ticketPanel.publishTicketPanel(client, w.guild);
    assert.equal(reposted.action, 'posted');
    assert.equal((await ticketSettings.getTicketSettings(client, guildId)).ticketPanelMessageId, reposted.message.id);
});

test('verification: setup posts the real verify button (not a link) and saves; publish re-posts a deleted panel', { skip }, async () => {
    const w = world();
    await rejectsUser(verificationPanel.setupVerification(client, w.guild, { channel: w.text, role: w.guild.roles.cache.get(id(13)) }), /below my highest role/);
    assert.equal(w.sent.length, 0);
    const { message } = await verificationPanel.setupVerification(client, w.guild, { channel: w.text, role: w.guild.roles.cache.get(id(10)), message: 'Hi', buttonText: 'Go' });
    const button = message.payload.components[0].components[0].data;
    assert.equal(button.custom_id, 'verify_user');
    assert.equal(button.url, undefined, 'no external link button');
    const stored = await verificationSettings.getVerificationSettings(client, guildId);
    assert.equal(stored.enabled, true);
    assert.equal(stored.messageId, message.id);
    await message.delete();
    const { action } = await verificationPanel.publishVerificationPanel(client, w.guild);
    assert.equal(action, 'posted');
});

test('join to create: one trigger per server; bad options create no channel', { skip }, async () => {
    const w = world();
    const before = w.guild.channels.cache.size;
    await rejectsUser(jtc.setupJoinToCreate(client, w.guild, { userLimit: 500 }), /between 0/);
    await rejectsUser(jtc.setupJoinToCreate(client, w.guild, { nameTemplate: '{nope}' }), /Unknown placeholder/);
    assert.equal(w.guild.channels.cache.size, before, 'no channel left behind');
    const { channel, config } = await jtc.setupJoinToCreate(client, w.guild, { categoryId: w.category.id, userLimit: 4, bitrateKbps: 96, nameTemplate: "{username}'s Den" });
    assert.equal(channel.type, ChannelType.GuildVoice);
    assert.deepEqual(config.triggerChannels, [channel.id]);
    assert.equal(config.channelOptions[channel.id].bitrate, 96000);
    await rejectsUser(jtc.setupJoinToCreate(client, w.guild, {}), /already has a Join to Create/);
    await jtc.removeTriggerChannel(client, guildId, channel.id);
});
