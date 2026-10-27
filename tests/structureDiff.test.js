import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { diffHasChanges, diffStructure, formatDiff, formatRevertSummary } from '../src/services/structureBackupService.js';

const G = '100';
const role = (id, name, position, permissions = '0') => ({ id, name, color: 0, hoist: false, mentionable: false, permissions, position });
const channel = (id, name, type, overwrites = [], parentId = null) => ({
    id, name, type, parentId, position: 0, topic: null, nsfw: false, rateLimitPerUser: 0, bitrate: null, userLimit: null, overwrites,
});
const ow = (roleId, allow = '0', deny = '0') => ({ roleId, allow, deny });

const snapshot = {
    guildId: G,
    everyonePermissions: '1024',
    roles: [role('r1', 'Member', 1, '1024'), role('r2', 'Mod', 2, '8192'), role('r3', 'VIP', 3)],
    channels: [
        channel('c0', 'Info', ChannelType.GuildCategory),
        channel('c1', 'rules', ChannelType.GuildText, [ow(G, '0', '2048'), ow('r2', '2048')], 'c0'),
        channel('c2', 'general', ChannelType.GuildText, [ow('r3', '1024')]),
        channel('c3', 'voice', ChannelType.GuildVoice),
    ],
};

test('structure diff: identical structures have no changes', () => {
    const diff = diffStructure(snapshot, structuredClone(snapshot));
    assert.equal(diffHasChanges(diff), false);
    assert.match(formatDiff(diff), /No differences/);
});

test('structure diff: a nuke shows deleted roles/channels, permission and overwrite changes', () => {
    const live = {
        guildId: G,
        everyonePermissions: '9', // @everyone got dangerous permissions
        roles: [role('r1', 'Member', 1, '8'), role('r9', 'nuked', 2)], // Mod and VIP deleted, Member changed
        channels: [
            channel('c1', 'rules', ChannelType.GuildText, [ow(G, '2048', '0')], null), // @everyone overwrite changed, Mod's gone
            channel('c2', 'general', ChannelType.GuildText, [ow('r1', '8')]),          // VIP's gone (role deleted), Member added
            channel('c9', 'raided', ChannelType.GuildText),
        ],
    };
    const diff = diffStructure(snapshot, live);
    assert.equal(diffHasChanges(diff), true);
    assert.deepEqual(diff.everyone, { before: '1024', after: '9' });
    assert.deepEqual(diff.deletedRoles.map((r) => r.id), ['r2', 'r3']);
    assert.deepEqual(diff.deletedChannels.map((c) => c.id), ['c0', 'c3'], 'categories first');
    assert.deepEqual(diff.changedRoles, [{ id: 'r1', name: 'Member', before: '1024', after: '8' }]);
    assert.deepEqual(diff.addedRoles.map((r) => r.id), ['r9']);
    assert.deepEqual(diff.addedChannels.map((c) => c.id), ['c9']);

    const rules = diff.overwriteChanges.find((entry) => entry.channelId === 'c1');
    assert.deepEqual(rules.changes.map((c) => [c.roleName, Boolean(c.before), Boolean(c.after), c.deletedRole]), [
        ['@everyone', true, true, false],
        ['Mod', true, false, true],
    ]);
    const general = diff.overwriteChanges.find((entry) => entry.channelId === 'c2');
    assert.deepEqual(general.changes.map((c) => [c.roleName, Boolean(c.before), Boolean(c.after)]), [
        ['VIP', true, false],
        ['Member', false, true],
    ]);

    const text = formatDiff(diff);
    assert.match(text, /Deleted roles \(2\):\*\* `Mod`, `VIP`/);
    assert.match(text, /Deleted channels \(2\):\*\* 📁`Info`, 🔊`voice`/);
    assert.match(text, /@everyone permissions:\*\* changed/);
    assert.match(text, /#rules \(@everyone changed\)/);
    assert.match(text, /#general \(Member added\)/);
    assert.match(text, /Plus 2 overwrite\(s\) of deleted roles/);
    assert.match(text, /Created since the snapshot \(left alone\):\*\* 1 role\(s\): `nuked`; 1 channel\(s\): `raided`/);
});

test('structure diff: overwrites for roles created after the snapshot are ignored', () => {
    const live = structuredClone(snapshot);
    live.roles.push(role('r10', 'New', 4));
    live.channels[1].overwrites.push(ow('r10', '1'));
    const diff = diffStructure(snapshot, live);
    assert.equal(diff.overwriteChanges.length, 0);
    assert.equal(diffHasChanges(diff), false);
});

test('structure diff: long lists are cut and the summary reads well', () => {
    const many = { ...snapshot, roles: Array.from({ length: 40 }, (_, i) => role(`x${i}`, `role-${i}`, i)) };
    const text = formatDiff(diffStructure(many, { ...snapshot, roles: [] }));
    assert.match(text, /and 25 more/);
    assert.ok(text.length <= 3800);
    assert.equal(
        formatRevertSummary({ rolesCreated: 2, rolesFixed: 1, channelsCreated: 3, overwritesFixed: 4, failed: 0, skipped: [] }),
        '2 role(s) recreated, 1 role permission(s) fixed, 3 channel(s) recreated, 4 overwrite(s) fixed, 0 failed. Recreated roles are empty: give them back to members by hand.',
    );
});
