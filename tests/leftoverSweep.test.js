// Regression tests for bugs reported in an earlier sweep (fixed in later batches).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MessageFlags } from 'discord.js';
import { createEmbed } from '../src/utils/embeds.js';
import { checkGiveaways } from '../src/services/giveawayService.js';
import { formatChannelName } from '../src/services/joinToCreateService.js';
import { markGiveawayEnded } from '../src/utils/database.js';
import { reloadCommand } from '../src/handlers/loaders/commandLoader.js';
import { counterDeleteActionHandler } from '../src/handlers/counterButtons.js';

test('embeds keep emoji: an emoji-only field, title and footer survive and do not throw', () => {
    const embed = createEmbed({
        title: '🎉',
        fields: [{ name: '🏆', value: '🥇' }],
        footer: '⭐ footer',
        timestamp: true,
    });
    assert.equal(embed.data.title, '🎉');
    assert.deepEqual(embed.data.fields.map(f => [f.name, f.value]), [['🏆', '🥇']]);
    assert.equal(embed.data.footer.text, '⭐ footer');
    assert.ok(embed.data.timestamp, 'timestamp is set');
});

test('long emoji text is cut without leaving half an emoji', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
    const value = '🥇'.repeat(600); // a cut at 1023 units lands mid-emoji
    const embed = createEmbed({ title: 'a' + '🎉'.repeat(200), description: 'a' + '🎉'.repeat(3000), fields: [{ name: 'x', value }] });
    assert.ok(!lone.test(embed.data.title));
    assert.ok(!lone.test(embed.data.description));
    assert.ok(!lone.test(embed.data.fields[0].value));
    assert.ok(embed.data.fields[0].value.endsWith('…'));
    assert.ok(embed.data.fields[0].value.length <= 1024);
});

test("formatChannelName keeps \"{username}'s Room\" and supports {displayName}", () => {
    const vars = { username: 'kitty', displayName: 'Kitty Cat', guildName: 'Mewvo', channelName: 'Lobby' };
    assert.equal(formatChannelName("{username}'s Room", vars), "kitty's Room");
    assert.equal(formatChannelName('{displayName} talks', vars), 'Kitty Cat talks');
    assert.equal(formatChannelName('{display_name} in {guild_name}', vars), 'Kitty Cat in Mewvo');
});

test('markGiveawayEnded (key-value store) saves the record under its guildId', async () => {
    const store = new Map();
    const client = { db: { get: async (key, def) => (store.has(key) ? store.get(key) : def), set: async (key, value) => { store.set(key, value); return true; } } };
    const ended = { guildId: 'g1', messageId: 'm1', ended: true, isEnded: true, prize: 'cat' };
    assert.equal(await markGiveawayEnded(client, 'm1', ended), true);
    assert.equal(store.get('guild:g1:giveaways').m1.isEnded, true);
    // Without guildId the fallback cannot know where to save and reports failure.
    assert.equal(await markGiveawayEnded(client, 'm2', { messageId: 'm2' }), false);
});

test('markGiveawayEnded (Postgres) updates by (guild_id, message_id) and reports a missed row', async () => {
    const calls = [];
    let rowCount = 1;
    const client = { db: { get: async () => null, db: { pool: {}, isAvailable: () => true, _query: async (sql, params) => { calls.push({ sql, params }); return { rowCount }; } } } };
    const ended = { guildId: 'g1', messageId: 'm1', isEnded: true };
    assert.equal(await markGiveawayEnded(client, 42, ended), true);
    assert.match(calls[0].sql, /WHERE guild_id = \$2 AND message_id = \$3/);
    assert.deepEqual(calls[0].params.slice(1), ['g1', 'm1']);
    rowCount = 0;
    assert.equal(await markGiveawayEnded(client, 42, ended), false);
});

test('reloadCommand keeps category and filePath, so a second reload works', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mewvo-reload-'));
    const filePath = path.join(dir, 'fake.js');
    await fs.writeFile(filePath, "export default { data: { name: 'fake' }, execute() {} };\n");
    try {
        const commands = new Map([['fake', { data: { name: 'fake' }, category: 'Tools', filePath }]]);
        const client = { commands };
        assert.equal((await reloadCommand(client, 'fake')).success, true);
        assert.equal(commands.get('fake').category, 'Tools');
        assert.equal(commands.get('fake').filePath, filePath);
        assert.equal((await reloadCommand(client, 'fake')).success, true);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('counter delete: a validation error goes to an ephemeral follow-up, the confirmation is untouched', async () => {
    const sent = { followUp: [], editReply: [] };
    const interaction = {
        id: '1',
        customId: 'counter-delete:confirm:c1:owner',
        createdTimestamp: Date.now(),
        user: { id: 'someone-else' },
        guildId: 'g1',
        deferred: false,
        replied: false,
        ephemeral: null,
        inGuild: () => true,
        deferUpdate: async () => { interaction.deferred = true; },
        followUp: async (payload) => { sent.followUp.push(payload); },
        editReply: async (payload) => { sent.editReply.push(payload); },
        reply: async () => { throw new Error('reply after deferUpdate'); },
    };
    await counterDeleteActionHandler.execute(interaction, {}, ['confirm', 'c1', 'owner']);
    assert.equal(sent.editReply.length, 0, 'the confirmation message (and its buttons) is not overwritten');
    assert.equal(sent.followUp.length, 1);
    assert.equal(sent.followUp[0].flags, MessageFlags.Ephemeral);
});

function fakeGiveawayClient({ failSave = false } = {}) {
    const giveaway = { messageId: '900', channelId: 'c1', hostId: 'h1', prize: 'cat', winnerCount: 1, participants: ['u1'], endsAt: Date.now() - 1000 };
    const store = new Map([['guild:g1:giveaways', { 900: giveaway }]]);
    const events = [];
    const message = { edit: async () => { events.push('edit'); } };
    const channel = {
        id: 'c1',
        messages: { fetch: async () => message },
        send: async (payload) => { events.push(['send', payload]); return { id: 'ping1' }; },
    };
    const client = {
        guilds: { cache: new Map([['g1', { id: 'g1', channels: { fetch: async () => channel } }]]) },
        db: {
            list: async (prefix) => [...store.keys()].filter(k => k.startsWith(prefix)),
            get: async (key, def) => (store.has(key) ? store.get(key) : def),
            set: async (key, value) => {
                if (failSave) throw new Error('database down');
                events.push('save');
                store.set(key, value);
                return true;
            },
        },
    };
    return { client, store, events };
}

test('scheduled giveaway end: a failed save announces nothing, so the next tick cannot re-pick winners', async () => {
    const { client, events } = fakeGiveawayClient({ failSave: true });
    await checkGiveaways(client);
    assert.deepEqual(events, [], 'no message edit and no winner ping after a failed save');
});

test('scheduled giveaway end: saves the ended state before editing and pinging, with user-only mentions', async () => {
    const { client, store, events } = fakeGiveawayClient();
    await checkGiveaways(client);
    assert.equal(events[0], 'save');
    assert.equal(events[1], 'edit');
    const ping = events.find(e => Array.isArray(e) && e[0] === 'send')[1];
    assert.deepEqual(ping.allowedMentions, { users: ['u1', 'h1'] });
    const saved = store.get('guild:g1:giveaways')[900];
    assert.equal(saved.isEnded, true);
    assert.deepEqual(saved.winnerIds, ['u1']);
    assert.equal(saved.winnerPingMessageId, 'ping1');
    // A second tick finds nothing to end.
    events.length = 0;
    await checkGiveaways(client);
    assert.deepEqual(events, []);
});
