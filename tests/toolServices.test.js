// The services behind /tools randomuser, /shorten and /wipedata that the dashboard
// shares: member filters + crypto pick, is.gd calls (fake fetch), own-data key match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPoolMessage, filterRandomMemberPool, pickFromPool, pickRandomMember } from '../src/services/randomMemberService.js';
import { shortenUrl, validateShortenInput } from '../src/services/urlShortener.js';
import { WIPE_ITEMS, wipeMemberData } from '../src/services/wipedataService.js';

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

test('wipedata: deletes levels, economy, AFK, birthday and to-do; reports failures instead of success', async () => {
    const g = '100000000000000001';
    const me = '20000000000000000';
    const store = new Map([
        [`guild:${g}:leveling:users:${me}`, { xp: 5 }],
        [`guild:${g}:afk:${me}`, { reason: 'x' }],
        [`todo_${me}`, { tasks: [] }],
        [`oauth:tokens:${me}`, { tokens: 'encrypted' }],
        [`oauth:tokens:${me}9`, { tokens: 'encrypted' }],
        [`guild:${g}:leveling:users:${me}9`, { xp: 9 }],
    ]);
    const db = { exists: async (k) => store.has(k), delete: async (k) => store.delete(k) };
    const birthdays = [];
    const reminders = [];
    const verifiedGuilds = [];
    const dmLogs = [];
    const ratings = [];
    const result = await wipeMemberData({ db }, g, me, {
        removeBirthday: async (_c, guild, user) => { birthdays.push(`${guild}:${user}`); },
        removeReminders: async (user) => { reminders.push(user); },
        removeVerifiedGuilds: async (user) => { verifiedGuilds.push(user); },
        removeDmLog: async (user) => { dmLogs.push(user); },
        removeTicketRatings: async (user) => { ratings.push(user); },
    });
    assert.deepEqual(result.deleted, WIPE_ITEMS.map((i) => i.id));
    assert.deepEqual(result.failed, []);
    assert.deepEqual([...store.keys()], [`oauth:tokens:${me}9`, `guild:${g}:leveling:users:${me}9`], 'another member with a longer id is untouched');
    assert.ok(result.deleted.includes('oauth'), 'the stored OAuth token is deleted too');
    assert.deepEqual(birthdays, [`${g}:${me}`], 'the birthday row is removed (it was never deleted before)');
    assert.deepEqual(reminders, [me], 'reminders too');
    assert.deepEqual(verifiedGuilds, [me], 'the servers the token was given in go with it (v12)');
    assert.deepEqual(dmLogs, [me], 'the bot DM log too (v13)');
    assert.deepEqual(ratings, [me], 'the ticket ratings they gave lose their name and comment (v14)');

    const broken = { db: { exists: async () => true, delete: async (k) => { if (k.includes('afk')) throw new Error('db down'); return true; } } };
    const partial = await wipeMemberData(broken, g, me, { removeBirthday: async () => { throw new Error('db down'); }, removeReminders: async () => {}, removeVerifiedGuilds: async () => {}, removeDmLog: async () => {}, removeTicketRatings: async () => {} });
    assert.deepEqual(partial.failed.map((f) => f.id), ['afk', 'birthday']);
    assert.ok(partial.deleted.includes('levels'));
    const silentFail = await wipeMemberData({ db: { exists: async () => true, delete: async () => false } }, g, me, { removeBirthday: async () => {}, removeReminders: async () => {}, removeVerifiedGuilds: async () => {}, removeDmLog: async () => {}, removeTicketRatings: async () => {} });
    const listFails = await wipeMemberData({ db }, g, me, { removeBirthday: async () => {}, removeReminders: async () => {}, removeVerifiedGuilds: async () => { throw new Error('db down'); }, removeDmLog: async () => {}, removeTicketRatings: async () => {} });
    assert.deepEqual(listFails.failed.map((f) => f.id), ['oauth'], 'a failed delete of the server list is reported, not hidden');
    assert.ok(silentFail.failed.length === 5, 'a false from delete is an error');
    const dmLogFails = await wipeMemberData({ db }, g, me, { removeBirthday: async () => {}, removeReminders: async () => {}, removeVerifiedGuilds: async () => {}, removeDmLog: async () => { throw new Error('db down'); }, removeTicketRatings: async () => {} });
    assert.deepEqual(dmLogFails.failed.map((f) => f.id), ['dmlog'], 'a failed DM log delete is reported');
    const ratingsFail = await wipeMemberData({ db }, g, me, { removeBirthday: async () => {}, removeReminders: async () => {}, removeVerifiedGuilds: async () => {}, removeDmLog: async () => {}, removeTicketRatings: async () => { throw new Error('db down'); } });
    assert.deepEqual(ratingsFail.failed.map((f) => f.id), ['ticketRatings'], 'a failed ratings wipe is reported, never shown as done');
    await assert.rejects(wipeMemberData({ db }, 'x', me), /bad ids/);
});

test('/support links the configured support invite, never the old hard-coded one', async () => {
    const { supportInviteUrl } = await import('../src/commands/Core/support.js');
    assert.equal(supportInviteUrl({ supportServerInvite: 'https://discord.gg/abcDEF1' }), 'https://discord.gg/abcDEF1');
    assert.equal(supportInviteUrl({ supportServerInvite: 'javascript:alert(1)' }), 'https://discord.gg/7Ckv9Bt577');
    assert.equal(supportInviteUrl({}), 'https://discord.gg/7Ckv9Bt577');
});

test('/support adds Privacy Policy and Terms buttons when PUBLIC_URL is set', async () => {
    const { legalLinks } = await import('../src/commands/Core/support.js');
    assert.deepEqual(legalLinks({ PUBLIC_URL: 'https://mewvo.example/' }), [['Privacy Policy', 'https://mewvo.example/privacy'], ['Terms', 'https://mewvo.example/terms']]);
    assert.deepEqual(legalLinks({}), []);
    assert.deepEqual(legalLinks({ PUBLIC_URL: 'javascript:x' }), []);
});
