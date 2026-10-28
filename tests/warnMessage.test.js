// "Warn for this message" context menu: up-front refusals and the prefilled warn flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';
const MAIN = process.env.MAIN_GUILD_ID;

const { default: warnMessage } = await import('../src/commands/Enforcement/warnmessage.js');
const { getFlow } = await import('../src/services/enforcement/panelState.js');
const { REQUIRED_BOT_PERMISSIONS } = await import('../src/services/enforcement/enforcementService.js');

const MOD_ID = '200000000000000001';
const AUTHOR_ID = '200000000000000002';
const BOT_ID = '200000000000000009';

function role(position) {
    return { id: `r${position}`, position };
}

function member(id, guild, { admin = false, top = 1 } = {}) {
    const highest = role(top);
    return {
        id,
        guild,
        user: { id, username: `u${id.slice(-1)}` },
        permissions: { has: (flag) => admin && flag === PermissionFlagsBits.Administrator },
        roles: { highest, cache: new Map([[highest.id, highest]]) },
    };
}

function world({ admin = true, authorTop = 1, authorInGuild = true, authorBot = false, authorId = AUTHOR_ID, guildId = MAIN, botMissing = false } = {}) {
    const guild = { id: guildId, ownerId: '200000000000000099', client: { user: { id: BOT_ID } } };
    const me = member(BOT_ID, guild, { top: 50 });
    me.permissions = { has: () => !botMissing };
    const mod = member(MOD_ID, guild, { admin, top: 10 });
    const authorMember = member(authorId, guild, { top: authorTop });
    guild.members = {
        me,
        fetch: async (id) => {
            if (id === authorId && authorInGuild) return authorMember;
            throw new Error('Unknown Member');
        },
    };
    const replies = [];
    const message = {
        id: '300000000000000003',
        guildId,
        channelId: '300000000000000002',
        author: { id: authorId, username: 'kit', bot: authorBot },
        content: 'some rude words',
        attachments: { size: 0 },
        embeds: [],
    };
    const interaction = {
        id: 'i1',
        guildId,
        guild,
        member: mod,
        user: mod.user,
        targetMessage: message,
        deferred: false,
        replied: false,
        deferReply: async () => { interaction.deferred = true; },
        editReply: async (payload) => { replies.push(payload); },
        reply: async (payload) => { replies.push(payload); },
    };
    return { interaction, replies, message };
}

test('warn for this message: refused outside the main server, for non-admins, bots, self', async () => {
    await assert.rejects(warnMessage.execute(world({ guildId: '100000000000000777' }).interaction), /main server/);
    await assert.rejects(warnMessage.execute(world({ admin: false }).interaction), /Administrator/);
    await assert.rejects(warnMessage.execute(world({ authorBot: true }).interaction), /Bot, webhook/);
    await assert.rejects(warnMessage.execute(world({ authorId: MOD_ID }).interaction), /warn yourself/);
});

test('warn for this message: refused when the author left, outranks the moderator, or the bot lacks permissions', async () => {
    await assert.rejects(warnMessage.execute(world({ authorInGuild: false }).interaction), /no longer in the server/);
    await assert.rejects(warnMessage.execute(world({ authorTop: 20 }).interaction), /You cannot warn .* equal to or above yours/);
    await assert.rejects(warnMessage.execute(world({ botMissing: true }).interaction), new RegExp(REQUIRED_BOT_PERMISSIONS[0][1]));
});

test('warn for this message: opens the warn flow with the message attached as evidence', async () => {
    const { interaction, replies, message } = world();
    await warnMessage.execute(interaction);
    assert.equal(interaction.deferred, true);
    assert.equal(replies.length, 1);
    const payload = replies[0];
    const url = `https://discord.com/channels/${MAIN}/${message.channelId}/${message.id}`;
    const embed = payload.embeds[0].toJSON();
    assert.match(embed.title, /^Warn — kit/);
    assert.ok(embed.description.includes(url));

    const select = payload.components[0].toJSON().components[0];
    const [handler, step, moderatorId, nonce] = select.custom_id.split(':');
    assert.deepEqual([handler, step, moderatorId], ['enfsel', 'reason', MOD_ID]);
    const flow = getFlow(nonce);
    assert.equal(flow.type, 'warn');
    assert.equal(flow.targetId, AUTHOR_ID);
    assert.equal(flow.evidenceInput, url);
    assert.equal(flow.prefetchedExcerpts.get(url), 'kit: some rude words');
});
