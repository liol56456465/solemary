// Community batch H5 against the local test database (npm run test:db):
// sticky messages, tags, suggestions, starboard, feeds.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db;
const runId = String(Date.now()).slice(-9);
const guildId = `7${runId}00000005`;
const id = (n) => `6${runId}${String(n).padStart(8, '0')}`;

function fakeChannel(channelId) {
    const sent = [];
    const deleted = [];
    let seq = 0;
    return {
        id: channelId,
        sent,
        deleted,
        toString: () => `<#${channelId}>`,
        send: async (payload) => {
            seq += 1;
            const message = { id: `${channelId.slice(0, 10)}${String(seq).padStart(9, '0')}`, payload };
            sent.push(message);
            return message;
        },
        messages: { delete: async (messageId) => { deleted.push(messageId); } },
    };
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM sticky_messages WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.pool.query('DELETE FROM tags WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.disconnect();
});

test('sticky: set posts and saves the id, replace reposts, reload restores, remove deletes', { skip }, async () => {
    const sticky = await import('../../src/services/community/stickyService.js');
    const channel = fakeChannel(id(1));
    const { posted } = await sticky.setSticky({ guildId, channel, content: 'Read the rules', updatedBy: id(90) });
    assert.equal(posted, true);
    assert.equal(channel.sent.length, 1);
    const { rows: [row] } = await pgDb.pool.query('SELECT * FROM sticky_messages WHERE channel_id = $1', [channel.id]);
    assert.equal(row.content, 'Read the rules');
    assert.equal(row.last_message_id, channel.sent[0].id);

    await sticky.setSticky({ guildId, channel, content: 'New rules', updatedBy: id(90) });
    assert.equal(channel.sent.length, 2);
    assert.deepEqual(channel.deleted, [channel.sent[0].id]);

    sticky.setStickiesForTests([]);
    await sticky.loadStickies();
    assert.deepEqual(sticky.listStickies(guildId), [{ channelId: channel.id, content: 'New rules', lastMessageId: channel.sent[1].id }]);

    await assert.rejects(sticky.setSticky({ guildId, channel, content: '   ', updatedBy: id(90) }), /empty/);

    assert.equal(await sticky.removeSticky({ channelId: channel.id, channel }), true);
    assert.ok(channel.deleted.includes(channel.sent[1].id));
    assert.equal(await sticky.removeSticky({ channelId: channel.id, channel }), false);
    const { rowCount } = await pgDb.pool.query('SELECT 1 FROM sticky_messages WHERE channel_id = $1', [channel.id]);
    assert.equal(rowCount, 0);
});

test('tags: create, unique names, edit fields, triggers from the cache, uses, delete', { skip }, async () => {
    const tags = await import('../../src/services/community/tagService.js');
    await tags.loadTags();
    const created = await tags.createTag({ guildId, name: 'IP', content: 'play.example.com', triggerKind: 'word', trigger: 'server ip', createdBy: id(90) });
    assert.equal(created.name, 'ip');
    assert.equal(created.cooldownS, 60);
    await assert.rejects(tags.createTag({ guildId, name: 'ip', content: 'x', createdBy: id(90) }), /already a tag/);
    await assert.rejects(tags.createTag({ guildId, name: 'bad name', content: 'x', createdBy: id(90) }), /lowercase/);
    await assert.rejects(tags.createTag({ guildId, name: 'evil', content: 'x', triggerKind: 'regex', trigger: '(a+)+', createdBy: id(90) }), /unsafe/);
    await assert.rejects(tags.createTag({ guildId, name: 'fast', content: 'x', triggerKind: 'word', trigger: 'hi', cooldownS: 1, createdBy: id(90) }), /cooldown/);

    const edited = await tags.editTag({ guildId, name: 'ip', content: 'new.example.com', denyChannels: [id(2)], cooldownS: 30 });
    assert.equal(edited.content, 'new.example.com');
    assert.deepEqual(edited.denyChannels, [id(2)]);
    assert.equal(edited.triggerKind, 'word'); // untouched
    assert.equal(await tags.editTag({ guildId, name: 'missing', content: 'x' }), null);

    const msg = (content, channelId) => ({ guild: { id: guildId }, channel: { id: channelId, isThread: () => false }, content });
    assert.equal(tags.findTriggeredTag(msg('the server ip?', id(1)))?.name, 'ip');
    assert.equal(tags.findTriggeredTag(msg('the server ip?', id(2))), null);

    const noTrigger = await tags.editTag({ guildId, name: 'ip', triggerKind: 'none' });
    assert.equal(noTrigger.trigger, null);
    assert.equal(tags.findTriggeredTag(msg('the server ip?', id(3))), null);

    tags.useTag(guildId, 'ip');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { rows: [row] } = await pgDb.pool.query('SELECT uses FROM tags WHERE guild_id = $1 AND name = $2', [guildId, 'ip']);
    assert.equal(row.uses, 1);

    assert.equal(await tags.deleteTag(guildId, 'ip'), true);
    assert.equal(await tags.deleteTag(guildId, 'ip'), false);
    assert.equal(tags.getTag(guildId, 'ip'), null);
});
