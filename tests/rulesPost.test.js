// The rules post (services/rules/rulesPost.js): building the embeds within Discord's
// limits (both layouts), images (links and attached uploads), posting with rollback, and
// updating in place. Discord is faked: channels record what was sent, edited and deleted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
    DESCRIPTION_MAX, EMBED_CHARS_MAX, EMBEDS_PER_MESSAGE, FIELDS_PER_EMBED, FIELD_NAME_MAX, FIELD_VALUE_MAX,
    buildRulesMessages, embedLength, postRulesMessages, resolveRulesImages, ruleBlock, ruleField, updateRulesMessages,
} from '../src/services/rules/rulesPost.js';
import { RULES_POST_LIMITS } from '../src/services/settings/settingsRegistry.js';

const CHANNEL = '500000000000000001';

const rule = (n, extra = {}) => ({ id: `r${String(n).padStart(4, '0')}`, number: n, title: `Rule title ${n}`, text: `Text ${n}`, consequence: '', ...extra });
const design = (extra = {}) => ({ title: 'Server rules', colour: 0x9b59b6, intro: '', footer: '', layout: 'list', ...extra });

/** 30 rules at the limits: title 80, text 1000, consequence 100. */
const bigRules = () => Array.from({ length: 30 }, (_, i) => rule(i + 1, { title: 'T'.repeat(80), text: 'x'.repeat(1000), consequence: 'C'.repeat(100) }));

function assertWithinLimits(messages) {
    assert.ok(messages.length <= RULES_POST_LIMITS.maxMessages, `${messages.length} messages`);
    for (const message of messages) {
        assert.ok(message.embeds.length <= EMBEDS_PER_MESSAGE);
        const total = message.embeds.reduce((sum, e) => sum + embedLength(e.data), 0);
        assert.ok(total <= EMBED_CHARS_MAX, `message total ${total}`);
        for (const { data } of message.embeds) {
            assert.ok(embedLength(data) <= EMBED_CHARS_MAX);
            assert.ok((data.description?.length || 0) <= DESCRIPTION_MAX);
            assert.ok((data.fields?.length || 0) <= FIELDS_PER_EMBED);
            for (const f of data.fields || []) assert.ok(f.name.length <= FIELD_NAME_MAX && f.value.length <= FIELD_VALUE_MAX);
            assert.ok(Array.isArray(message.files));
        }
    }
}

/** Every rule appears exactly once, in order. */
function assertAllRules(messages, layout) {
    const text = messages.flatMap((m) => m.embeds).map((e) => (layout === 'fields' ? (e.data.fields || []).map((f) => f.name).join('\n') : e.data.description || '')).join('\n');
    let from = 0;
    for (let n = 1; n <= 30; n++) {
        const at = text.indexOf(layout === 'fields' ? `${n}. ` : `**${n}. `, from);
        assert.ok(at >= from, `rule ${n} in order`);
        from = at + 1;
    }
}

// ── building ──────────────────────────────────────────────────────────────

test('blocks: list block is "**N. title**", text, "*Consequence: …*"; field puts the consequence in the name', () => {
    assert.equal(ruleBlock(rule(2, { consequence: 'Warning' })), '**2. Rule title 2**\nText 2\n*Consequence: Warning*');
    assert.equal(ruleBlock(rule(3, { text: '' })), '**3. Rule title 3**');
    assert.deepEqual(ruleField(rule(4, { consequence: '1-hour mute' })), { name: '4. Rule title 4 · 1-hour mute', value: 'Text 4' });
    assert.equal(ruleField(rule(5, { text: '' })).value, '​', 'an empty value is a zero-width space (Discord refuses empty fields)');
});

test('splitting: 30 rules × 1000 characters, list layout, stays within every Discord limit and keeps all rules in order', () => {
    const messages = buildRulesMessages(bigRules(), design({ intro: 'i'.repeat(1000), footer: 'f'.repeat(200), title: 'T'.repeat(256) }));
    assert.ok(messages.length > 1, 'needs more than one message');
    assertWithinLimits(messages);
    assertAllRules(messages, 'list');
});

test('splitting: 30 rules × 1000 characters, fields layout, stays within every Discord limit (title and footer counted)', () => {
    const messages = buildRulesMessages(bigRules(), design({ layout: 'fields', intro: 'i'.repeat(1000), footer: 'f'.repeat(200), title: 'T'.repeat(256) }));
    assertWithinLimits(messages);
    assertAllRules(messages, 'fields');
    // Short rules: 30 fields → two embeds (25 per embed).
    const short = buildRulesMessages(Array.from({ length: 30 }, (_, i) => rule(i + 1)), design({ layout: 'fields' }));
    const embeds = short.flatMap((m) => m.embeds);
    assert.deepEqual(embeds.map((e) => e.data.fields.length), [25, 5]);
    assert.equal(short.length, 1, 'both embeds fit in one message');
});

test('limits: nothing to post refuses; more than the message limit refuses with a clear message', () => {
    assert.throws(() => buildRulesMessages([], design()), /no rules to post yet/);
    // Over the limit: many long rules (past the stored limits, to force it).
    const huge = Array.from({ length: 60 }, (_, i) => rule(i + 1, { text: 'x'.repeat(3500) }));
    assert.throws(() => buildRulesMessages(huge, design()), (error) => /more than 10\. Shorten some rule texts/.test(error.userMessage) && error.type === 'validation');
});

test('layout: title and thumbnail on the first rules embed, the banner as its own embed first, the footer on the last embed only', () => {
    const messages = buildRulesMessages(bigRules(), design({ footer: 'Be nice' }), {
        banner: { url: 'https://img.example/banner.png' }, thumbnail: { url: 'https://img.example/logo.png' },
    });
    const embeds = messages.flatMap((m) => m.embeds).map((e) => e.data);
    assert.equal(embeds[0].image.url, 'https://img.example/banner.png');
    assert.equal(embeds[0].description, undefined, 'the banner embed is image only');
    assert.equal(embeds[1].title, 'Server rules');
    assert.equal(embeds[1].thumbnail.url, 'https://img.example/logo.png');
    assert.equal(embeds.at(-1).footer.text, 'Be nice');
    assert.equal(embeds.filter((e) => e.footer).length, 1);
    assert.equal(embeds.filter((e) => e.title).length, 1);
    assert.ok(embeds.every((e) => e.color === 0x9b59b6), 'one colour on every embed');
    assert.deepEqual(messages.flatMap((m) => m.files), [], 'links: nothing attached');
});

test('files: uploaded images are attached to the first message and referenced as attachment://', () => {
    const messages = buildRulesMessages([rule(1), rule(2)], design(), {
        banner: { attachment: 'https://cdn.discordapp.com/a/banner.png', name: 'rules-banner.png' },
        thumbnail: { attachment: 'https://cdn.discordapp.com/a/thumb.webp', name: 'rules-thumbnail.webp' },
    });
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].files, [
        { attachment: 'https://cdn.discordapp.com/a/banner.png', name: 'rules-banner.png' },
        { attachment: 'https://cdn.discordapp.com/a/thumb.webp', name: 'rules-thumbnail.webp' },
    ]);
    assert.equal(messages[0].embeds[0].data.image.url, 'attachment://rules-banner.png');
    assert.equal(messages[0].embeds[1].data.thumbnail.url, 'attachment://rules-thumbnail.webp');
});

test('resolveRulesImages: a link stays a link; an upload gets a fresh link and is attached; a lost stored copy refuses', async () => {
    const ref = { channelId: CHANNEL, messageId: '800000000000000001', url: 'https://cdn.discordapp.com/attachments/1/2/rules-banner.png?ex=1&is=1&hm=1' };
    const fresh = 'https://cdn.discordapp.com/attachments/1/2/rules-banner.png?ex=ffffffff&is=2&hm=2';
    const calls = [];
    const resolve = async (client, url, r, opts) => { calls.push([url, r, opts]); return fresh; };
    const images = await resolveRulesImages({}, 'g', { banner: { url: ref.url, ref }, thumbnail: { url: 'https://img.example/t.gif', ref: null } }, resolve);
    assert.deepEqual(images.banner, { attachment: fresh, name: 'rules-banner.png' });
    assert.deepEqual(images.thumbnail, { url: 'https://img.example/t.gif' });
    assert.equal(calls.length, 1, 'only the upload is refreshed');
    assert.deepEqual(await resolveRulesImages({}, 'g', { banner: null, thumbnail: null }, resolve), { banner: null, thumbnail: null });
    // The store falls back to the saved (expired) link when the stored message is gone.
    await assert.rejects(resolveRulesImages({}, 'g', { banner: { url: ref.url, ref }, thumbnail: null }, async (c, url) => url), /could not be loaded from its stored copy/);
    await assert.rejects(resolveRulesImages({}, 'g', { banner: { url: ref.url, ref }, thumbnail: null }, async () => { throw new Error('down'); }), /Upload it again or remove it/);
});

// ── posting and updating (fake Discord) ───────────────────────────────────

function fakeGuild({ failOnSend = 0, missing = [], perms = null } = {}) {
    let next = 1;
    const channel = {
        id: CHANNEL, name: 'rules', type: ChannelType.GuildText, sent: [], deleted: [], edited: [],
        permissionsFor: () => ({ has: (bit) => (perms ? perms(bit) : true) }),
        isThread: () => false,
    };
    const makeMessage = (id) => ({
        id,
        edit: async (payload) => { channel.edited.push({ id, payload }); },
        delete: async () => { channel.deleted.push(id); },
    });
    channel.existing = new Map(['900000000000000001', '900000000000000002', '900000000000000003'].map((id) => [id, makeMessage(id)]));
    channel.send = async (payload) => {
        channel.sent.push(payload);
        if (failOnSend && channel.sent.length === failOnSend) throw new Error('Missing Access');
        return makeMessage(`91000000000000000${next++}`);
    };
    channel.messages = { fetch: async (id) => (missing.includes(id) ? Promise.reject(Object.assign(new Error('Unknown Message'), { code: 10008 })) : channel.existing.get(id) || null) };
    const guild = { id: 'g', members: { me: {} }, channels: { cache: new Map([[CHANNEL, channel]]) } };
    return { guild, channel };
}

const threeMessages = () => buildRulesMessages(bigRules(), design()).slice(0, 3);

test('post: sends every message in order with allowedMentions parse [] and returns the ids', async () => {
    const { guild, channel } = fakeGuild();
    const messages = buildRulesMessages([rule(1)], design(), { banner: { attachment: 'https://cdn.discordapp.com/x.png', name: 'rules-banner.png' } });
    const ids = await postRulesMessages(guild, channel, messages);
    assert.deepEqual(ids, ['910000000000000001']);
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    assert.equal(channel.sent[0].files.length, 1);
    assert.equal(channel.sent[0].embeds.length, 2);
});

test('post: when one send fails the messages already sent are deleted again and the error is thrown', async () => {
    const { guild, channel } = fakeGuild({ failOnSend: 3 });
    const messages = threeMessages();
    assert.equal(messages.length, 3);
    await assert.rejects(postRulesMessages(guild, channel, messages), /Missing Access/);
    assert.deepEqual(channel.deleted.sort(), ['910000000000000001', '910000000000000002']);
});

test('post: refuses (nothing sent) without the permissions; uploads also need Attach Files', async () => {
    const noEmbed = fakeGuild({ perms: (bit) => bit !== 1n << 14n });
    await assert.rejects(postRulesMessages(noEmbed.guild, noEmbed.channel, [{ embeds: [], files: [] }]), (e) => /Embed Links/.test(e.userMessage));
    assert.equal(noEmbed.channel.sent.length, 0);
    const noFiles = fakeGuild({ perms: (bit) => bit !== 1n << 15n });
    await assert.rejects(postRulesMessages(noFiles.guild, noFiles.channel, [{ embeds: [], files: [{ attachment: 'x', name: 'a.png' }] }]), (e) => /Attach Files/.test(e.userMessage));
    assert.equal(noFiles.channel.sent.length, 0);
});

test('update: edits the stored messages in place, sends the extra ones, returns left-overs (not deleted yet); allowedMentions parse [] everywhere', async () => {
    const { guild, channel } = fakeGuild();
    const messages = threeMessages();
    // Two stored messages, three needed: two edits and one send.
    let result = await updateRulesMessages(guild, { channelId: CHANNEL, messageIds: ['900000000000000001', '900000000000000002'] }, messages);
    assert.deepEqual(result.ids, ['900000000000000001', '900000000000000002', '910000000000000001']);
    assert.equal(result.channel, channel);
    assert.deepEqual(result.added.map((m) => m.id), ['910000000000000001']);
    assert.deepEqual(result.leftovers, []);
    assert.deepEqual(channel.edited.map((e) => e.id), ['900000000000000001', '900000000000000002']);
    for (const { payload } of channel.edited) {
        assert.deepEqual(payload.allowedMentions, { parse: [] });
        assert.deepEqual(payload.attachments, [], 'old attachments dropped');
    }
    assert.deepEqual(channel.sent.map((p) => p.allowedMentions), [{ parse: [] }]);
    // Three stored, one needed: one edit, two deleted.
    channel.edited.length = 0;
    result = await updateRulesMessages(guild, { channelId: CHANNEL, messageIds: ['900000000000000001', '900000000000000002', '900000000000000003'] }, messages.slice(0, 1));
    assert.deepEqual(result.ids, ['900000000000000001']);
    assert.deepEqual(result.leftovers.map((m) => m.id), ['900000000000000002', '900000000000000003']);
    assert.deepEqual(channel.deleted, [], 'the caller deletes left-overs after saving the new ids');
});

test('update: refuses (nothing edited) when a stored message or the channel is gone, or Read Message History is missing', async () => {
    const { guild, channel } = fakeGuild({ missing: ['900000000000000002'] });
    await assert.rejects(updateRulesMessages(guild, { channelId: CHANNEL, messageIds: ['900000000000000001', '900000000000000002'] }, threeMessages()),
        (e) => /was deleted in #rules\. Use Post to send a new copy/.test(e.userMessage));
    assert.equal(channel.edited.length + channel.sent.length + channel.deleted.length, 0);
    await assert.rejects(updateRulesMessages(guild, { channelId: '500000000000000009', messageIds: ['900000000000000001'] }, threeMessages()), /no longer exists/);
    // A fetch error that is not "Unknown Message" is not reported as a deleted message.
    const flaky = fakeGuild();
    flaky.channel.messages.fetch = async () => { throw new Error('socket hang up'); };
    await assert.rejects(updateRulesMessages(flaky.guild, { channelId: CHANNEL, messageIds: ['900000000000000001'] }, threeMessages()), /socket hang up/);
    const noHistory = fakeGuild({ perms: (bit) => bit !== 1n << 16n });
    await assert.rejects(updateRulesMessages(noHistory.guild, { channelId: CHANNEL, messageIds: ['900000000000000001'] }, threeMessages()), (e) => /Read Message History/.test(e.userMessage));
});

test('update: a failed send removes the new messages it already sent', async () => {
    const { guild, channel } = fakeGuild({ failOnSend: 2 });
    await assert.rejects(updateRulesMessages(guild, { channelId: CHANNEL, messageIds: ['900000000000000001'] }, threeMessages()), /Missing Access/);
    assert.deepEqual(channel.deleted, ['910000000000000001']);
});
