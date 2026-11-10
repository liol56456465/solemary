import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminHits } from '../src/services/automod/automodService.js';

const message = (id) => ({ id, client: {}, guild: { id: '100000000000000001' }, channel: { id: '400000000000000004' }, author: { id: '200000000000000002', username: 'admin' } });

test('automod on administrators: message removed and reported, never punished', async () => {
    const removed = [];
    const posts = [];
    const handled = await handleAdminHits(message('1'), [{ rule: 'slurs', mode: 'enforce' }], {
        deleteQuietly: async (m) => removed.push(m.id), post: async (...a) => posts.push(a),
    });
    assert.equal(handled, true);
    assert.deepEqual(removed, ['1']);
    assert.equal(posts.length, 1);
    assert.equal(posts[0][1], 'automod');
    assert.match(posts[0][2].find((f) => f.name === 'Action').value, /no warn, mute or ban/);
});

test('automod on administrators: watch-mode rule only reports; no hit does nothing', async () => {
    const removed = [];
    const posts = [];
    const deps = { deleteQuietly: async (m) => removed.push(m.id), post: async (...a) => posts.push(a) };
    assert.equal(await handleAdminHits(message('2'), [{ rule: 'spam', mode: 'monitor' }], deps), true);
    assert.deepEqual(removed, []);
    assert.equal(posts.length, 1);
    assert.equal(await handleAdminHits(message('3'), [], deps), false);
    assert.equal(posts.length, 1);
});

test('automod on administrators: the default staff post is wired (no injected post)', async () => {
    const removed = [];
    // No client guilds: postModLog finds no channel and returns; it must not throw.
    const msg = { ...message('4'), client: { guilds: { cache: new Map() } } };
    assert.equal(await handleAdminHits(msg, [{ rule: 'slurs', mode: 'enforce' }], { deleteQuietly: async (m) => removed.push(m.id) }), true);
    assert.deepEqual(removed, ['4']);
});
