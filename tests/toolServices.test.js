// The services behind /tools randomuser, /shorten and /wipedata that the dashboard
// shares: member filters + crypto pick, is.gd calls (fake fetch), own-data key match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPoolMessage, filterRandomMemberPool, pickFromPool, pickRandomMember } from '../src/services/randomMemberService.js';
import { shortenUrl, validateShortenInput } from '../src/services/urlShortener.js';
import { isOwnDataKey } from '../src/handlers/wipedataButtons.js';

const ROLE = '600000000000000001';
const member = (id, { bot = false, status = 'online', roles = [] } = {}) => ({
    id, user: { id, bot, username: `u${id}` }, presence: status ? { status } : null, roles: { cache: new Set(roles) },
});

test('random member: role, bots and online filters as /tools randomuser', () => {
    const all = [member('1'), member('2', { bot: true }), member('3', { status: 'offline', roles: [ROLE] }), member('4', { status: null, roles: [ROLE] }), member('5', { roles: [ROLE] })];
    const ids = (opts) => filterRandomMemberPool(all, opts).map((m) => m.id);
    assert.deepEqual(ids({}), ['1', '3', '4', '5'], 'bots excluded by default');
    assert.deepEqual(ids({ includeBots: true }), ['1', '2', '3', '4', '5']);
    assert.deepEqual(ids({ roleId: ROLE }), ['3', '4', '5']);
    assert.deepEqual(ids({ onlineOnly: true }), ['1', '5'], 'no presence counts as offline');
    assert.deepEqual(ids({ roleId: ROLE, onlineOnly: true }), ['5']);
});

test('random member: uniform pick through randomInt; empty pool → the command\'s message', async () => {
    const pool = ['a', 'b', 'c'];
    assert.equal(pickFromPool(pool, (n) => n - 1), 'c');
    assert.equal(pickFromPool([], () => 0), null);
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(pickFromPool(pool));
    assert.deepEqual([...seen].sort(), pool, 'real randomInt reaches every member');

    const cache = new Map([['1', member('1')], ['2', member('2', { bot: true })]]);
    const guild = { members: { cache, fetch: async () => { throw new Error('no intent'); } }, roles: { cache: new Map([[ROLE, { name: 'Helper' }]]) } };
    const picked = await pickRandomMember(guild, {}, { pick: () => 0 });
    assert.deepEqual([picked.member.id, picked.poolSize], ['1', 1], 'cache used when the fetch fails');
    await assert.rejects(pickRandomMember(guild, { roleId: ROLE }), (error) => error.type === 'user_input' && /No users have the \*\*Helper\*\* role/.test(error.userMessage));
    assert.match(emptyPoolMessage({ roleName: 'Helper', onlineOnly: true }), /No \*\*Helper\*\* members are online/);
});

test('shorten: input checks of /shorten (http/https, custom ending), is.gd answers mapped to messages', async () => {
    assert.throws(() => validateShortenInput('example.com'), /Include http/);
    assert.throws(() => validateShortenInput('javascript:alert(1)'), (e) => /Include http/.test(e.userMessage));
    assert.throws(() => validateShortenInput('https://example.com', 'bad ending!'), (e) => /letters, numbers/.test(e.userMessage));
    assert.throws(() => validateShortenInput(`https://example.com/${'a'.repeat(2001)}`), (e) => /too long/.test(e.userMessage));

    let asked = null;
    const ok = async (url) => { asked = url; return { ok: true, status: 200, text: async () => 'https://is.gd/abc\n' }; };
    assert.equal(await shortenUrl('https://example.com/a?b=1', 'mine', { fetchImpl: ok }), 'https://is.gd/abc');
    assert.equal(asked, 'https://is.gd/create.php?format=simple&url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&shorturl=mine');

    const answer = (body, status = 200) => async () => ({ ok: status < 400, status, text: async () => body });
    await assert.rejects(shortenUrl('https://example.com', 'taken', { fetchImpl: answer('Error, the shorturl already exists') }), (e) => e.type === 'validation' && /already taken/.test(e.userMessage));
    await assert.rejects(shortenUrl('https://example.com', '', { fetchImpl: answer('', 503) }), (e) => /HTTP 503/.test(e.userMessage));
    await assert.rejects(shortenUrl('https://example.com', '', { fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } }), (e) => e.type === 'network' && /timed out/.test(e.userMessage));
});

test('wipedata: only keys holding the caller\'s own guild:user ids (a longer id that starts the same is someone else)', () => {
    const g = '100000000000000001';
    const me = '20000000000000000';
    const other = `${me}9`;
    assert.equal(isOwnDataKey(`economy:${g}:${me}`, g, me), true);
    assert.equal(isOwnDataKey(`${g}:${me}:inventory`, g, me), true);
    assert.equal(isOwnDataKey(`economy:${g}:${other}`, g, me), false, 'another member whose id starts with mine');
    assert.equal(isOwnDataKey(`economy:9${g}:${me}`, g, me), false, 'another guild whose id ends with mine');
    assert.equal(isOwnDataKey(`economy:${g}:x`, g, me), false);
    assert.equal(isOwnDataKey(null, g, me), false);
});
