// /poll create | end: the command posts through botMessageService (fake channel, nothing reaches Discord).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import poll from '../src/commands/Tools/poll.js';

function makeInteraction(subcommand, values) {
    const sent = [];
    const replies = [];
    const channel = {
        id: '500000000000000001', name: 'general', type: ChannelType.GuildText, isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
        async send(payload) {
            sent.push(payload);
            return { id: '710000000000000001', url: 'https://discord.com/channels/1/2/3', async react() {} };
        },
    };
    const interaction = {
        id: '1', deferred: true, replied: false, createdTimestamp: Date.now(), user: { id: '2' }, guildId: '100000000000000001',
        guild: { id: '100000000000000001', members: { me: { id: 'bot' } } }, channel,
        options: {
            getSubcommand: () => subcommand,
            getString: (name) => values[name] ?? null,
            getInteger: (name) => values[name] ?? null,
            getBoolean: (name) => values[name] ?? null,
        },
        isRepliable: () => true,
        async editReply(payload) { replies.push(payload); return {}; },
    };
    return { interaction, sent, replies };
}

test('/poll: registered as create and end subcommands (one top-level command); option descriptions fit Discord', () => {
    const json = poll.data.toJSON();
    assert.equal(json.name, 'poll');
    assert.deepEqual(json.options.map((o) => o.name), ['create', 'end']);
    const create = json.options[0].options.map((o) => o.name);
    assert.deepEqual(create, ['question', ...Array.from({ length: 10 }, (_, i) => `option${i + 1}`), 'hours', 'multiple', 'anonymous']);
    const hours = json.options[0].options.find((o) => o.name === 'hours');
    assert.deepEqual([hours.min_value, hours.max_value], [1, 168]);
    assert.match(json.options[0].options.find((o) => o.name === 'anonymous').description, /Discord polls list who voted/);
});

test('/poll create: posts a Discord poll by default with hours and multiple', async () => {
    const { interaction, sent, replies } = makeInteraction('create', { question: 'Pizza?', option1: 'Yes', option2: 'No', hours: 3, multiple: true });
    await poll.execute(interaction);
    assert.deepEqual(sent[0].poll, { question: { text: 'Pizza?' }, answers: [{ text: 'Yes' }, { text: 'No' }], duration: 3, allowMultiselect: true });
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    assert.match(replies.at(-1).content, /Poll posted\. It closes <t:\d+:F>/);
});

test('/poll create anonymous: the reaction poll, and the reply says hours/multiple were ignored', async () => {
    const { interaction, sent, replies } = makeInteraction('create', { question: 'Pizza?', option1: 'Yes', option2: 'No', anonymous: true, hours: 5 });
    await poll.execute(interaction);
    assert.equal(sent[0].poll, undefined);
    assert.equal(sent[0].embeds.length, 1);
    assert.match(replies.at(-1).content, /Reaction poll posted\. Hours and multiple only apply to Discord polls/);
});

test('/poll end: a bad link is refused by the service and nothing is ended', async () => {
    const { interaction } = makeInteraction('end', { message_link: 'nope' });
    await assert.rejects(poll.execute(interaction), /not a message link/);
});
