// botMessageService: posting as the bot (dashboard Messages page, /poll, /countdown).
// Fake channels record every send; nothing reaches Discord.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
    activeCountdowns, assertCanPost, buildMessageEmbed, createPoll, isEmbedImageUrl, parseHexColour, postBotMessage, startCountdownMessage,
    POLL_EMOJIS,
} from '../src/services/botMessageService.js';

function makeChannel({ type = ChannelType.GuildText, denied = [], thread = false, failReactAt = Infinity } = {}) {
    const sent = [];
    const reactions = [];
    return {
        id: '500000000000000001', name: 'general', type, sent, reactions,
        isThread: () => thread,
        permissionsFor: () => ({ has: (flag) => !denied.some((name) => PermissionFlagsBits[name] === flag) }),
        async send(payload) {
            sent.push(payload);
            return {
                id: '710000000000000001', payload,
                async react(emoji) { if (reactions.length >= failReactAt) throw new Error('Missing Permissions'); reactions.push(emoji); },
                async edit() {},
            };
        },
    };
}
const guild = { members: { me: { id: 'bot' } } };

test('postBotMessage: allowedMentions never parses anything, even with @everyone, @here and role mentions typed', async () => {
    const channel = makeChannel();
    await postBotMessage(guild, { channel, content: '@everyone @here <@&600000000000000001> <@300000000000000004>', embed: { title: 'Hi <@&1>', description: '@everyone' } });
    assert.equal(channel.sent.length, 1);
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    assert.equal(channel.sent[0].content, '@everyone @here <@&600000000000000001> <@300000000000000004>');
    assert.equal(channel.sent[0].embeds[0].data.title, 'Hi <@&1>');
});

test('postBotMessage: embed parts (colour, image, footer written directly); empty or footer-only refused', async () => {
    const channel = makeChannel();
    await postBotMessage(guild, { channel, embed: { title: 'T', description: 'D', colour: 0x123456, imageUrl: 'https://cdn.example.com/a.png', footer: 'F' } });
    const data = channel.sent[0].embeds[0].data;
    assert.equal(data.color, 0x123456);
    assert.equal(data.image.url, 'https://cdn.example.com/a.png');
    assert.deepEqual(data.footer, { text: 'F' });
    assert.equal(channel.sent[0].content, undefined, 'no empty content');
    await assert.rejects(postBotMessage(guild, { channel }), /nothing to post/);
    await assert.rejects(postBotMessage(guild, { channel, embed: { footer: 'only' } }), /footer alone/);
    await assert.rejects(postBotMessage(guild, { channel, content: 'x'.repeat(2001) }), /limited to 2000/);
    assert.throws(() => buildMessageEmbed({ title: 'x'.repeat(257) }), /limited to 256/);
    assert.throws(() => buildMessageEmbed({ description: 'x'.repeat(4096), footer: 'y'.repeat(2000) }), /6000 characters/);
    assert.throws(() => buildMessageEmbed({ title: 'x', imageUrl: 'http://example.com/a.png' }), /https/);
    assert.equal(channel.sent.length, 1, 'refusals posted nothing');
});

test('image URLs: https with a real host only; http, data:, javascript:, credentials, spaces and over-long refused', () => {
    for (const ok of ['https://cdn.discordapp.com/a.png', 'https://example.com/i.gif?x=1']) assert.ok(isEmbedImageUrl(ok), ok);
    for (const bad of ['http://example.com/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://user:pw@example.com/a.png',
        'https://localhost/a.png', 'https://exa mple.com/a.png', `https://example.com/${'a'.repeat(2048)}`, '', null, 'example.com/a.png']) {
        assert.equal(isEmbedImageUrl(bad), false, String(bad));
    }
});

test('hex colours', () => {
    assert.equal(parseHexColour('#9B59B6'), 0x9B59B6);
    assert.equal(parseHexColour('00ff00'), 0x00ff00);
    for (const bad of ['#fff', 'green', '#12345g', '', null]) assert.equal(parseHexColour(bad), null, String(bad));
});

test('permission check: missing View/Send/Embed refuses with a clear message and sends nothing; threads need Send Messages in Threads', async () => {
    for (const perm of ['ViewChannel', 'SendMessages', 'EmbedLinks']) {
        const channel = makeChannel({ denied: [perm] });
        await assert.rejects(postBotMessage(guild, { channel, content: 'hi' }),
            (e) => e.type === 'permission' && /I am missing .* in #general\. Nothing was posted\./.test(e.userMessage));
        assert.equal(channel.sent.length, 0);
    }
    assert.throws(() => assertCanPost(guild, makeChannel({ type: ChannelType.GuildVoice })), /text or announcement channel/);
    const thread = makeChannel({ type: ChannelType.PublicThread, thread: true, denied: ['SendMessages'] });
    assert.doesNotThrow(() => assertCanPost(guild, thread), 'Send Messages is not what a thread needs');
    assert.throws(() => assertCanPost(guild, makeChannel({ type: ChannelType.PublicThread, thread: true, denied: ['SendMessagesInThreads'] })), /Send Messages in Threads/);
});

test('createPoll: same embed as /poll, no pings, number reactions in order; a refused reaction is counted; poll permissions checked', async () => {
    const channel = makeChannel();
    const { reacted } = await createPoll(guild, { channel, question: 'Pizza @everyone?', options: ['Yes', ' ', 'No'], anonymous: true, reactDelayMs: 0 });
    assert.equal(reacted, 2);
    assert.deepEqual(channel.reactions, POLL_EMOJIS.slice(0, 2));
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    assert.equal(channel.sent[0].embeds[0].data.title, '📊 Anonymous Poll');
    assert.match(channel.sent[0].embeds[0].data.description, /^\*\*Pizza @everyone\?\*\*\n\n1️⃣ Yes\n2️⃣ No\n\n\*This is an anonymous poll/);

    const partial = makeChannel({ failReactAt: 1 });
    assert.equal((await createPoll(guild, { channel: partial, question: 'Q', options: ['a', 'b', 'c'], reactDelayMs: 0 })).reacted, 1);
    await assert.rejects(createPoll(guild, { channel: makeChannel(), question: 'Q', options: ['a'] }), /at least 2 options/);
    const noReact = makeChannel({ denied: ['AddReactions'] });
    await assert.rejects(createPoll(guild, { channel: noReact, question: 'Q', options: ['a', 'b'] }), /Add Reactions/);
    assert.equal(noReact.sent.length, 0);
});

test('startCountdownMessage: buttons, no pings, registered for the pause/cancel buttons; limits', async () => {
    const channel = makeChannel();
    const { countdownId } = await startCountdownMessage(guild, { channel, totalSeconds: 90, title: 'Launch' });
    try {
        assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
        assert.equal(channel.sent[0].embeds[0].data.title, '⏱️ Launch');
        assert.equal(channel.sent[0].components.length, 1);
        assert.ok(activeCountdowns.has(countdownId));
        const { activeCountdowns: fromCommand } = await import('../src/commands/Tools/countdown.js');
        assert.equal(fromCommand, activeCountdowns, 'the buttons see dashboard countdowns');
    } finally {
        clearTimeout(activeCountdowns.get(countdownId)?.interval);
        activeCountdowns.delete(countdownId);
    }
    await assert.rejects(startCountdownMessage(guild, { channel, totalSeconds: 0 }), /at least 1 second/);
    await assert.rejects(startCountdownMessage(guild, { channel, totalSeconds: 86401 }), /24 hours/);
    assert.equal(channel.sent.length, 1);
});
