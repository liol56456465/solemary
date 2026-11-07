// /rules post | update | preview: the command uses the same rules post service as the
// dashboard Rules page. Discord and the settings store are faked (rulesCommandDeps), so
// nothing reaches Discord or the database.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, MessageFlags } from 'discord.js';
import rules, { rulesCommandDeps } from '../src/commands/Moderation/rules.js';
import { checkCommandAccess } from '../src/utils/commandGate.js';
import { dashboardPageFor } from '../src/config/commands/retirement.js';
import { SLASH_ONLY_COMMANDS } from '../src/config/commands/prefixRestrictions.js';
import { MODULE_COMMANDS } from '../src/services/dashboard/modules/commands.js';

const MAIN = '100000000000000001';
const RULES_CHANNEL = '500000000000000001';
const OTHER_CHANNEL = '500000000000000002';
const realDeps = { ...rulesCommandDeps };

const storedRules = { rules: [{ id: 'abcd1', title: 'Be kind', text: 'No insults.', consequence: 'Warning' }, { id: 'abcd2', title: 'No spam', text: '', consequence: '' }], updatedAt: null };

let state;
beforeEach(() => {
    Object.assign(rulesCommandDeps, realDeps);
    state = {
        settings: { serverRules: storedRules, rulesPost: { channelId: RULES_CHANNEL, title: 'Our rules', colour: 0x9b59b6, intro: '', footer: '', layout: 'list', banner: null, thumbnail: null, posted: null } },
        saves: [], posts: [], updates: [], loaded: true, saveFails: false, postFails: null,
    };
    Object.assign(rulesCommandDeps, {
        guildIdFor: (which) => (which === 'main' ? MAIN : null),
        isSettingsLoaded: () => state.loaded,
        resolveSetting: (guildId, key) => { assert.equal(guildId, MAIN, 'reads the server it posts in'); return structuredClone(state.settings[key]); },
        updateSettings: async (guildId, patch, actor) => {
            if (state.saveFails) throw new Error('database not responding');
            state.saves.push({ guildId, patch, actor });
            Object.assign(state.settings, patch);
            return { changes: [], settings: patch };
        },
        resolveWelcomeImageUrl: async () => { throw new Error('no uploads in these tests'); },
        postRulesMessages: async (guild, channel, messages) => {
            state.posts.push({ channelId: channel.id, messages });
            if (state.postFails) throw state.postFails;
            return messages.map((_, i) => `91000000000000000${i + 1}`);
        },
        updateRulesMessages: async (guild, posted, messages) => {
            state.updates.push({ posted, messages });
            return { channel: guild.channels.cache.get(posted.channelId), ids: posted.messageIds.slice(0, messages.length), added: [], leftovers: [] };
        },
    });
});

function makeInteraction(subcommand, { channel = null, guildId = MAIN } = {}) {
    const replies = [];
    const followUps = [];
    const deleted = [];
    const textChannel = (id, name) => ({ id, name, type: ChannelType.GuildText, isThread: () => false, messages: { delete: async (mid) => { deleted.push(mid); } } });
    const channels = new Map([[RULES_CHANNEL, textChannel(RULES_CHANNEL, 'rules')], [OTHER_CHANNEL, textChannel(OTHER_CHANNEL, 'welcome')]]);
    const interaction = {
        id: '1', deferred: true, replied: false, createdTimestamp: Date.now(), guildId,
        user: { id: '200000000000000001', username: 'admin' },
        guild: { id: guildId, members: { me: { id: 'bot' } }, channels: { cache: channels } },
        client: {},
        options: {
            getSubcommand: () => subcommand,
            getChannel: () => (channel ? channels.get(channel) : null),
        },
        isRepliable: () => true,
        async editReply(payload) { replies.push(payload); return {}; },
        async followUp(payload) { followUps.push(payload); return {}; },
    };
    return { interaction, replies, followUps, deleted };
}

test('/rules: one top-level command with post [channel], update and preview; descriptions fit Discord', () => {
    const json = rules.data.toJSON();
    assert.equal(json.name, 'rules');
    assert.deepEqual(json.options.map((o) => o.name), ['post', 'update', 'preview']);
    const channel = json.options[0].options[0];
    assert.equal(channel.name, 'channel');
    assert.equal(channel.required, false);
    assert.deepEqual(channel.channel_types, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
    for (const o of [json, ...json.options, channel]) assert.ok(o.description.length <= 100 && !o.description.includes('—'), o.name);
});

test('/rules: Administrator-only (unlisted keys), slash-only, listed with the dashboard Rules page', () => {
    const guild = { id: MAIN, ownerId: 'server-owner' };
    const member = { has: () => false, any: () => false };
    for (const key of ['rules post', 'rules update', 'rules preview']) {
        const result = checkCommandAccess({ command: {}, accessKey: key, guild, userId: 'someone', permissions: member });
        assert.equal(result.allowed, false, key);
        assert.equal(dashboardPageFor(key), 'rules');
    }
    assert.ok(SLASH_ONLY_COMMANDS.has('rules'));
    assert.deepEqual(MODULE_COMMANDS.rules, ['rules']);
});

test('/rules post: posts the saved design in the saved channel, saves the ids, ephemeral reply without mentions', async () => {
    const { interaction, replies } = makeInteraction('post');
    await rules.execute(interaction, {}, {});
    assert.equal(state.posts.length, 1);
    assert.equal(state.posts[0].channelId, RULES_CHANNEL);
    const embed = state.posts[0].messages[0].embeds[0].data;
    assert.equal(embed.title, 'Our rules');
    assert.equal(embed.color, 0x9b59b6);
    assert.match(embed.description, /\*\*1\. Be kind\*\*/);
    assert.equal(state.saves.length, 1);
    assert.equal(state.saves[0].guildId, MAIN);
    assert.deepEqual(state.saves[0].actor, { userId: '200000000000000001', username: 'admin', module: 'rules' });
    const saved = state.saves[0].patch.rulesPost;
    assert.equal(saved.title, 'Our rules', 'the design is kept');
    assert.equal(saved.channelId, RULES_CHANNEL);
    assert.deepEqual(saved.posted.messageIds, ['910000000000000001']);
    assert.equal(saved.posted.channelId, RULES_CHANNEL);
    assert.deepEqual(replies.at(-1).allowedMentions, { parse: [] });
    assert.equal(replies.at(-1).content, `The rules were posted in <#${RULES_CHANNEL}> (1 message).`);
});

test('/rules post channel: posts there, keeps the saved design channel, and says the earlier post stays', async () => {
    state.settings.rulesPost.posted = { channelId: RULES_CHANNEL, messageIds: ['900000000000000001'], at: '2026-11-01T00:00:00.000Z' };
    const { interaction, replies } = makeInteraction('post', { channel: OTHER_CHANNEL });
    await rules.execute(interaction, {}, {});
    assert.equal(state.posts[0].channelId, OTHER_CHANNEL);
    const saved = state.saves[0].patch.rulesPost;
    assert.equal(saved.channelId, RULES_CHANNEL);
    assert.equal(saved.posted.channelId, OTHER_CHANNEL);
    assert.match(replies.at(-1).content, /The earlier post in <#500000000000000001> stays where it is\. Next time, use \/rules update/);
});

test('/rules post: refusals (no channel, gone channel, no rules, other server, settings not loaded) post nothing', async () => {
    state.settings.rulesPost.channelId = null;
    await assert.rejects(rules.execute(makeInteraction('post').interaction, {}, {}), (e) => /No rules channel is saved/.test(e.userMessage));
    state.settings.rulesPost.channelId = '500000000000000099';
    await assert.rejects(rules.execute(makeInteraction('post').interaction, {}, {}), (e) => /saved rules channel no longer exists/.test(e.userMessage));
    state.settings.rulesPost.channelId = RULES_CHANNEL;
    state.settings.serverRules = { rules: [], updatedAt: null };
    await assert.rejects(rules.execute(makeInteraction('post').interaction, {}, {}), /There are no rules to post yet/);
    state.settings.serverRules = storedRules;
    await assert.rejects(rules.execute(makeInteraction('post', { guildId: '100000000000000009' }).interaction, {}, {}), (e) => /only be posted from the main server/.test(e.userMessage));
    state.loaded = false;
    await assert.rejects(rules.execute(makeInteraction('post').interaction, {}, {}), (e) => /not loaded/.test(e.userMessage));
    assert.equal(state.posts.length, 0);
    assert.equal(state.saves.length, 0);
});

test('/rules post: a failed save deletes the post again; an unexpected Discord error becomes a readable refusal', async () => {
    state.saveFails = true;
    const { interaction, deleted } = makeInteraction('post');
    await assert.rejects(rules.execute(interaction, {}, {}), (e) => e.userMessage === 'Could not save the post (database not responding). The post was removed again. Nothing was changed.');
    assert.deepEqual(deleted, ['910000000000000001']);

    state.saveFails = false;
    state.postFails = new Error('Missing Access');
    await assert.rejects(rules.execute(makeInteraction('post').interaction, {}, {}), (e) => e.userMessage === 'Discord refused the post. Nothing was posted. Discord said: Missing Access');
    assert.equal(state.saves.length, 0);
});

test('/rules update: edits the stored post in place and saves the ids; refuses before the first post', async () => {
    await assert.rejects(rules.execute(makeInteraction('update').interaction, {}, {}), (e) => /not been posted yet\. Use \/rules post first/.test(e.userMessage));
    assert.equal(state.updates.length, 0);

    state.settings.rulesPost.posted = { channelId: RULES_CHANNEL, messageIds: ['900000000000000001'], at: '2026-11-01T00:00:00.000Z' };
    const { interaction, replies } = makeInteraction('update');
    await rules.execute(interaction, {}, {});
    assert.deepEqual(state.updates[0].posted.messageIds, ['900000000000000001']);
    assert.deepEqual(state.saves[0].patch.rulesPost.posted.messageIds, ['900000000000000001']);
    assert.notEqual(state.saves[0].patch.rulesPost.posted.at, '2026-11-01T00:00:00.000Z');
    assert.equal(replies.at(-1).content, `The posted rules in <#${RULES_CHANNEL}> were updated (1 message).`);
    assert.deepEqual(replies.at(-1).allowedMentions, { parse: [] });
});

test('/rules preview: the embeds only to the invoker, nothing posted or saved; more messages come as ephemeral follow-ups', async () => {
    const { interaction, replies, followUps } = makeInteraction('preview');
    await rules.execute(interaction, {}, {});
    assert.equal(state.posts.length + state.updates.length + state.saves.length, 0);
    assert.match(replies.at(-1).content, /Preview of the rules post \(1 message, saved channel: <#500000000000000001>\)\. Only you can see this\. Nothing was posted\./);
    assert.equal(replies.at(-1).embeds[0].data.title, 'Our rules');
    assert.deepEqual(replies.at(-1).allowedMentions, { parse: [] });
    assert.equal(followUps.length, 0);

    // 30 long rules need several messages.
    state.settings.serverRules = { rules: Array.from({ length: 30 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, title: 'T'.repeat(80), text: 'x'.repeat(1000), consequence: '' })), updatedAt: null };
    const many = makeInteraction('preview');
    await rules.execute(many.interaction, {}, {});
    assert.ok(many.followUps.length >= 1);
    for (const f of many.followUps) {
        assert.equal(f.flags, MessageFlags.Ephemeral);
        assert.deepEqual(f.allowedMentions, { parse: [] });
    }
    assert.equal(state.posts.length, 0);
});
