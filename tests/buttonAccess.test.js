// Public buttons that affect other members follow the access model: Administrator only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { giveawayEndHandler, giveawayRerollHandler } from '../src/handlers/giveawayButtons.js';

const fakeInteraction = (perms) => {
    const replies = [];
    return {
        replies,
        id: '2000000000000000001', customId: 'giveaway_end', createdTimestamp: Date.now(),
        guildId: '1700000000000000001',
        inGuild: () => true,
        user: { id: '1800000000000000001' },
        member: { id: '1800000000000000001', guild: { ownerId: '1800000000000000009' }, permissions: { has: (p) => perms.includes(p) } },
        message: { id: '1900000000000000001' },
        deferred: false, replied: false,
        reply: async (payload) => { replies.push(payload); },
        deferReply: async () => { replies.push('deferred'); },
        followUp: async (payload) => { replies.push(payload); },
        editReply: async (payload) => { replies.push(payload); },
    };
};
const text = (payload) => JSON.stringify(payload);

for (const [name, handler] of [['end', giveawayEndHandler], ['reroll', giveawayRerollHandler]]) {
    test(`giveaway ${name}: Manage Server is not enough; Administrator is needed (nothing deferred or changed)`, async () => {
        const interaction = fakeInteraction([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageMessages]);
        await handler.execute(interaction, {});
        assert.equal(interaction.replies.length, 1);
        assert.notEqual(interaction.replies[0], 'deferred');
        assert.match(text(interaction.replies[0]), /Administrator/);
    });
}
