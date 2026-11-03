// botMessageService: posting as the bot (dashboard Messages page, /poll, /countdown).
// Fake channels record every send; nothing reaches Discord.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
    activeCountdowns, assertCanPost, buildMessageEmbed, buildNativePollPayload, cleanNativePoll, createNativePoll, createPoll, endPoll, isEmbedImageUrl,
    parseHexColour, parseMessageLink, postBotMessage, startCountdownMessage,
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
    assert.equal(channel.sent[0].embeds[0].data.title, 'Anonymous poll');
    assert.match(channel.sent[0].embeds[0].data.description, /^\*\*Pizza @everyone\?\*\*\n\n1️⃣ Yes\n2️⃣ No\n\n\*Anonymous poll: votes aren't tied to names/);

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

// ── Native Discord polls ──────────────────────────────────────────────────

test('cleanNativePoll: Discord limits (question 300, 2 to 10 answers of 55, 1 to 168 hours), refused not cut', () => {
    const ok = cleanNativePoll(' Q ', [' a ', '', 'b'], { durationHours: 168, multiSelect: 1 });
    assert.deepEqual(ok, { question: 'Q', options: ['a', 'b'], durationHours: 168, multiSelect: true });
    assert.equal(cleanNativePoll('Q', ['a', 'b']).durationHours, 24, 'default 24 hours');
    assert.equal(cleanNativePoll('Q', ['a', 'b'], { durationHours: null }).durationHours, 24);
    assert.equal(cleanNativePoll('q'.repeat(300), ['x'.repeat(55), 'b']).question.length, 300);
    assert.throws(() => cleanNativePoll('q'.repeat(301), ['a', 'b']), /limited to 300/);
    assert.throws(() => cleanNativePoll('', ['a', 'b']), /needs a question/);
    assert.throws(() => cleanNativePoll('Q', ['a']), /at least 2 options/);
    assert.throws(() => cleanNativePoll('Q', Array.from({ length: 11 }, (_, i) => `o${i}`)), /at most 10 options/);
    assert.throws(() => cleanNativePoll('Q', ['a', 'x'.repeat(56)]), /limited to 55 characters/);
    for (const bad of [0, 169, 1.5, 'abc', -1]) assert.throws(() => cleanNativePoll('Q', ['a', 'b'], { durationHours: bad }), /1 hour to 168 hours/, String(bad));
});

test('createNativePoll: the payload sent is a Discord poll (no embed, no reactions, no pings); Send Polls checked first', async () => {
    const channel = makeChannel();
    const result = await createNativePoll(guild, { channel, question: 'Pizza @everyone?', options: ['Yes', 'No'], durationHours: 48, multiSelect: true });
    assert.equal(channel.sent.length, 1);
    assert.deepEqual(channel.sent[0], {
        poll: { question: { text: 'Pizza @everyone?' }, answers: [{ text: 'Yes' }, { text: 'No' }], duration: 48, allowMultiselect: true },
        allowedMentions: { parse: [] },
    });
    assert.deepEqual(channel.reactions, [], 'no reactions on a Discord poll');
    assert.ok(Math.abs(result.endsAt - (Date.now() + 48 * 3600000)) < 5000);
    assert.equal(buildNativePollPayload(cleanNativePoll('Q', ['a', 'b'])).poll.allowMultiselect, false);

    const noPolls = makeChannel({ denied: ['SendPolls'] });
    await assert.rejects(createNativePoll(guild, { channel: noPolls, question: 'Q', options: ['a', 'b'] }),
        (e) => e.type === 'permission' && /missing Send Polls in #general/.test(e.userMessage));
    assert.equal(noPolls.sent.length, 0);
    const noReactions = makeChannel({ denied: ['AddReactions', 'EmbedLinks'] });
    await createNativePoll(guild, { channel: noReactions, question: 'Q', options: ['a', 'b'] });
    assert.equal(noReactions.sent.length, 1, 'reactions and embeds are not needed');
    await assert.rejects(createNativePoll(guild, { channel: makeChannel(), question: 'Q', options: ['a', 'x'.repeat(56)] }), /55 characters/);
    assert.throws(() => assertCanPost(guild, makeChannel({ type: ChannelType.GuildVoice })), /text or announcement/);
});

test('the anonymous path is still the reaction poll: an embed and number reactions, no Discord poll', async () => {
    const channel = makeChannel();
    await createPoll(guild, { channel, question: 'Q', options: ['a', 'b'], anonymous: true, reactDelayMs: 0 });
    assert.equal(channel.sent[0].poll, undefined);
    assert.equal(channel.sent[0].embeds.length, 1);
    assert.deepEqual(channel.reactions, POLL_EMOJIS.slice(0, 2));
});

test('parseMessageLink: discord.com, ptb, canary and discordapp links; anything else is null', () => {
    const ids = { guildId: '100000000000000001', channelId: '500000000000000001', messageId: '710000000000000001' };
    for (const ok of [
        'https://discord.com/channels/100000000000000001/500000000000000001/710000000000000001',
        ' https://ptb.discord.com/channels/100000000000000001/500000000000000001/710000000000000001 ',
        '<https://canary.discordapp.com/channels/100000000000000001/500000000000000001/710000000000000001>',
    ]) assert.deepEqual(parseMessageLink(ok), ids, ok);
    for (const bad of ['', null, 'https://evil.com/channels/100000000000000001/500000000000000001/710000000000000001',
        'https://discord.com/channels/@me/500000000000000001/710000000000000001', 'https://discord.com/channels/1/2/3', '710000000000000001']) {
        assert.equal(parseMessageLink(bad), null, String(bad));
    }
});

const BOT = '999999999999999998';
const LINK = 'https://discord.com/channels/100000000000000001/500000000000000001/710000000000000001';

/** A guild with one channel holding `message` (or nothing). */
function pollGuild(message, { denied = [] } = {}) {
    const channel = {
        id: '500000000000000001', name: 'general', type: ChannelType.GuildText, isThread: () => false,
        permissionsFor: () => ({ has: (flag) => !denied.some((name) => PermissionFlagsBits[name] === flag) }),
        messages: {
            async fetch(id) {
                if (!message || id !== '710000000000000001') throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
                return message;
            },
        },
    };
    return {
        id: '100000000000000001', client: { user: { id: BOT } }, members: { me: { id: BOT } },
        channels: { cache: new Map([[channel.id, channel]]), fetch: async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); } },
    };
}
function pollMessage({ author = BOT, poll = true, finalized = false, expires = Date.now() + 3600000 } = {}) {
    const msg = { id: '710000000000000001', author: { id: author }, ended: 0, poll: null };
    if (poll) msg.poll = { question: { text: 'Pizza?' }, resultsFinalized: finalized, expiresTimestamp: expires, async end() { msg.ended += 1; return msg; } };
    return msg;
}

test('endPoll: ends Mewvo\'s open poll exactly once', async () => {
    const msg = pollMessage();
    const { question, channel } = await endPoll(pollGuild(msg), LINK);
    assert.equal(msg.ended, 1);
    assert.equal(question, 'Pizza?');
    assert.equal(channel.name, 'general');
});

test('endPoll refusals: bad link, other server, gone channel or message, not a poll, already ended, not by the bot, no read access', async () => {
    const cases = [
        [pollGuild(pollMessage()), 'not a link', /not a message link/],
        [pollGuild(pollMessage()), 'https://discord.com/channels/100000000000000999/500000000000000001/710000000000000001', /another server/],
        [pollGuild(pollMessage()), 'https://discord.com/channels/100000000000000001/500000000000000777/710000000000000001', /could not find the channel/],
        [pollGuild(null), LINK, /could not find that message/],
        [pollGuild(pollMessage({ poll: false })), LINK, /not a Discord poll/],
        [pollGuild(pollMessage({ finalized: true })), LINK, /already ended/],
        [pollGuild(pollMessage({ expires: Date.now() - 1000 })), LINK, /already ended/],
        [pollGuild(pollMessage({ author: '300000000000000004' })), LINK, /not posted by Mewvo/],
        [pollGuild(pollMessage(), { denied: ['ReadMessageHistory'] }), LINK, /missing Read Message History/],
    ];
    for (const [g, link, expected] of cases) {
        const msg = g.channels.cache.get('500000000000000001').messages;
        await assert.rejects(endPoll(g, link), (e) => expected.test(e.userMessage), String(expected));
        const fetched = await msg.fetch('710000000000000001').catch(() => null);
        assert.equal(fetched?.ended ?? 0, 0, `${expected}: nothing ended`);
    }
});

test('endPoll: an unexpected Discord error while fetching is not hidden as "not found"', async () => {
    const g = pollGuild(pollMessage());
    g.channels.cache.get('500000000000000001').messages.fetch = async () => { throw Object.assign(new Error('Service unavailable'), { status: 503 }); };
    await assert.rejects(endPoll(g, LINK), /Service unavailable/);
});

test('endPoll: Missing Access while fetching, and an expiry race in end(), become readable refusals', async () => {
    const g = pollGuild(pollMessage());
    g.channels.cache.get('500000000000000001').messages.fetch = async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); };
    await assert.rejects(endPoll(g, LINK), (e) => /no access to that channel or thread/.test(e.userMessage));

    const msg = pollMessage();
    msg.poll.end = async () => { throw Object.assign(new Error('Poll has already expired.'), { code: 'PollAlreadyExpired' }); };
    await assert.rejects(endPoll(pollGuild(msg), LINK), (e) => /already ended/.test(e.userMessage));
});
