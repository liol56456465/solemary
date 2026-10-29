import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendLateInteractionNotice } from '../src/utils/lateInteractionNotice.js';

function fakeInteraction(id, isAdmin) {
    const sent = [];
    return {
        sent,
        id: `i-${id}`,
        user: { id, send: async (msg) => sent.push(['dm', msg]) },
        guild: { id: 'g', name: 'Mewvo', ownerId: 'owner' },
        guildId: 'g',
        channel: { send: async (msg) => { sent.push(['channel', msg]); return { delete: async () => {} }; } },
        memberPermissions: { has: () => isAdmin },
        createdTimestamp: Date.now() - 5000,
        isChatInputCommand: () => true,
        commandName: 'help',
    };
}

test('members get no "sorry, I did not respond" DM or channel ping', async () => {
    const member = fakeInteraction('member-1', false);
    assert.equal(await sendLateInteractionNotice(member), false);
    assert.deepEqual(member.sent, []);
});

test('admins still get the notice by DM', async () => {
    const admin = fakeInteraction('admin-1', true);
    assert.equal(await sendLateInteractionNotice(admin), true);
    assert.equal(admin.sent[0][0], 'dm');
});
