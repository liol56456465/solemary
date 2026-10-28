// The Members list: listMembers (pure: filter, sort, page) and the page markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listMembers, memberRow } from '../src/services/dashboard/membersData.js';
import { membersPage } from '../src/services/dashboard/enforcementPages.js';

const G = '100000000000000001';
const NOW = Date.UTC(2026, 9, 28, 12);
const DAY = 864e5;
const role = (id, name, position) => ({ id, name, position });
const ROLES = { everyone: role(G, '@everyone', 0), mod: role('600000000000000002', 'Mod', 5), vip: role('600000000000000003', 'VIP', 3) };

function member(id, username, { nick = null, joinedDaysAgo = 1, roles = [], bot = false } = {}) {
    return {
        id, nickname: nick, joinedTimestamp: NOW - joinedDaysAgo * DAY,
        user: { id, username, globalName: null, bot },
        roles: { cache: new Map([[G, ROLES.everyone], ...roles.map((r) => [r.id, r])]) },
    };
}

function guild(count = 0) {
    const list = [
        member('300000000000000001', 'alice', { joinedDaysAgo: 0.5, roles: [ROLES.vip] }),
        member('300000000000000002', 'bob', { nick: 'Bobby', joinedDaysAgo: 3, roles: [ROLES.mod, ROLES.vip] }),
        member('300000000000000003', 'carol', { joinedDaysAgo: 40 }),
        member('300000000000000004', 'botty', { joinedDaysAgo: 10, bot: true }),
    ];
    for (let i = 0; i < count; i += 1) list.push(member(`4000000000000000${String(i).padStart(2, '0')}`, `filler${i}`, { joinedDaysAgo: 100 + i }));
    return { id: G, memberCount: list.length, members: { cache: new Map(list.map((m) => [m.id, m])) } };
}

const STANDINGS = { ladder: new Map([['300000000000000002', { level: 1, warns: 1 }], ['300000000000000003', { level: 0, warns: 2 }]]), muted: new Set(['300000000000000003']) };
const names = (list) => list.rows.map((r) => r.username);

test('members list: newest first by default; roles highest first without @everyone; warns and mute from the database', () => {
    const list = listMembers(guild(), STANDINGS, { now: NOW });
    assert.deepEqual(names(list), ['alice', 'bob', 'botty', 'carol']);
    const bob = list.rows[1];
    assert.equal(bob.displayName, 'Bobby');
    assert.deepEqual(bob.roles.map((r) => r.name), ['Mod', 'VIP']);
    assert.equal(bob.level, 1);
    assert.equal(list.rows[3].muted, true);
    assert.equal(list.total, 4);
});

test('members list: search (name, nickname, ID), role, joined, state and sort filters', () => {
    const g = guild();
    assert.deepEqual(names(listMembers(g, STANDINGS, { q: 'bobb', now: NOW })), ['bob'], 'nickname');
    assert.deepEqual(names(listMembers(g, STANDINGS, { q: '300000000000000003', now: NOW })), ['carol'], 'ID');
    assert.deepEqual(names(listMembers(g, STANDINGS, { role: ROLES.vip.id, now: NOW })), ['alice', 'bob']);
    assert.deepEqual(names(listMembers(g, STANDINGS, { joined: '24h', now: NOW })), ['alice']);
    assert.deepEqual(names(listMembers(g, STANDINGS, { joined: '7d', now: NOW })), ['alice', 'bob']);
    assert.deepEqual(names(listMembers(g, STANDINGS, { joined: 'older', now: NOW })), ['carol']);
    assert.deepEqual(names(listMembers(g, STANDINGS, { state: 'sanction', now: NOW })), ['carol']);
    assert.deepEqual(names(listMembers(g, STANDINGS, { state: 'warned', now: NOW })), ['bob', 'carol']);
    assert.deepEqual(names(listMembers(g, STANDINGS, { state: 'noroles', now: NOW })), ['botty', 'carol']);
    assert.deepEqual(names(listMembers(g, STANDINGS, { state: 'bots', now: NOW })), ['botty']);
    assert.deepEqual(names(listMembers(g, STANDINGS, { state: 'humans', sort: 'name', now: NOW })), ['alice', 'bob', 'carol'], 'sorted by shown name (alice, Bobby, carol)');
    assert.deepEqual(names(listMembers(g, STANDINGS, { sort: 'joined_asc', now: NOW })), ['carol', 'botty', 'bob', 'alice']);
});

test('members list: 50 per page; out-of-range pages land on the last page', () => {
    const g = guild(60); // 64 members
    const first = listMembers(g, STANDINGS, { now: NOW });
    assert.equal(first.rows.length, 50);
    assert.equal(first.pages, 2);
    const second = listMembers(g, STANDINGS, { page: 1, now: NOW });
    assert.equal(second.rows.length, 14);
    assert.equal(listMembers(g, STANDINGS, { page: 99, now: NOW }).page, 1);
});

test('members page: rows link to the member, escape names, show warns / muted in words, keep filters in the pager', () => {
    const g = guild(60);
    g.members.cache.get('300000000000000001').nickname = '<img src=x>';
    const list = listMembers(g, STANDINGS, { now: NOW, sort: 'joined_desc' });
    const page = String(membersPage({ session: { username: 'a', csrf: 't' }, list, filters: { state: 'humans', sort: 'joined_desc' }, roles: [{ id: ROLES.vip.id, name: 'VIP' }] }));
    assert.ok(page.includes('href="/dashboard/users/300000000000000001"'));
    assert.ok(page.includes('&lt;img src=x&gt;') && !page.includes('<img src=x>'), 'escaped');
    assert.ok(page.includes('level 1 · 1 warn'));
    assert.match(page, /<span class="state-word is-warn"><span class="dot dot-warn" aria-hidden="true"><\/span>Muted<\/span>/);
    assert.ok(page.includes('Page 1 of 2 · 64 members'));
    assert.ok(page.includes('href="/dashboard/users?state=humans&amp;sort=joined_desc&amp;page=1"'), 'next page keeps the filters');
    assert.ok(!/style=/.test(page), 'no inline styles (CSP)');
    const none = String(membersPage({ session: { username: 'a', csrf: 't' }, filters: { q: 'zzzz' }, list: listMembers(g, STANDINGS, { q: 'zzzz', now: NOW }) }));
    assert.ok(none.includes('No member matches these filters.'));
    const empty = String(membersPage({ session: { username: 'a', csrf: 't' }, filters: {}, list: listMembers({ id: G, members: { cache: new Map() } }, STANDINGS, { now: NOW }) }));
    assert.ok(empty.includes('No members to show yet.'), 'no filters + no members: not "no match"');
});

test('memberRow: unknown join date and no avatar function are fine', () => {
    const row = memberRow({ id: '1', user: { id: '1', username: 'x' }, roles: { cache: new Map() } }, G, null);
    assert.equal(row.joinedAt, null);
    assert.equal(row.avatarUrl, null);
    assert.deepEqual(row.roles, []);
});
