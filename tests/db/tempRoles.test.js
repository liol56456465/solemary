// Temporary roles against the local test database (npm run test:db): give with an end time,
// give again (replaces the end time), expiry takes the role off and deletes the row, a
// rejoin before the end gives the role back unless the role became unsafe, a member who left is
// just forgotten, and endTempRoles (role removed in Discord, ban) clears rows.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, temp;
const runId = String(Date.now()).slice(-9);
const guildId = `9${runId}00000008`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
const ROLE = `7${runId}00000001`;
const GONE_ROLE = `7${runId}00000002`;
const STAFF_ROLE = `7${runId}00000003`;

function fakeWorld() {
    const calls = [];
    const members = new Map();
    const guild = { id: guildId };
    const role = (id, name, perms = []) => ({ id, name, guild, position: 1, managed: false, permissions: { has: (p) => perms.includes(p) } });
    guild.roles = { cache: new Map([[ROLE, role(ROLE, 'Event')], [STAFF_ROLE, role(STAFF_ROLE, 'Was event', ['Administrator'])]]) };
    guild.members = {
        me: { roles: { highest: { position: 10 } } },
        fetch: async ({ user: id }) => { if (!members.has(id)) throw new Error('Unknown Member'); return members.get(id); },
    };
    const member = (id) => {
        const cache = new Map();
        const m = {
            id, guild,
            roles: {
                cache,
                add: async (roleId, reason) => { calls.push({ id, call: 'add', roleId, reason }); cache.set(roleId, { id: roleId }); },
                remove: async (roleId, reason) => { calls.push({ id, call: 'remove', roleId, reason }); cache.delete(roleId); },
            },
        };
        members.set(id, m);
        return m;
    };
    const client = { guilds: { cache: new Map([[guildId, guild]]) } };
    return { calls, members, member, client };
}

const rowsFor = async (userId) => (await pgDb.pool.query('SELECT role_id, expires_at, given_by_username, reason FROM member_temp_roles WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rows;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    temp = await import('../../src/services/members/tempRoleService.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM member_temp_roles WHERE guild_id = $1', [guildId]);
    await pgDb.disconnect();
});

test('give, give again, list, end', { skip }, async () => {
    const w = fakeWorld();
    const m = w.member(user(1));
    const by = { id: user(9), username: 'admin' };
    const now = Date.UTC(2030, 0, 1);
    const until = await temp.addTempRole({ member: m, role: { id: ROLE }, ms: 3_600_000, by, reason: 'event', auditReason: 'Dashboard (admin): event', now });
    assert.equal(until.getTime(), now + 3_600_000);
    assert.deepEqual(w.calls, [{ id: user(1), call: 'add', roleId: ROLE, reason: 'Dashboard (admin): event' }]);
    await temp.addTempRole({ member: m, role: { id: ROLE }, ms: 86_400_000, by, now });
    assert.equal(w.calls.length, 1, 'a role they already have is not added twice');
    const rows = await temp.listTempRoles(guildId, user(1));
    assert.equal(rows.length, 1, 'one row per member and role');
    assert.equal(new Date(rows[0].expires_at).getTime(), now + 86_400_000, 'the end time is replaced');
    await temp.endTempRole(guildId, user(1), ROLE);
    assert.deepEqual(await rowsFor(user(1)), []);
});

test('expiry takes the role off and deletes the row; a member who left or a deleted role is forgotten', { skip }, async () => {
    const w = fakeWorld();
    const by = { id: user(9), username: 'admin' };
    const past = Date.now() - 2 * 3_600_000;
    const stays = w.member(user(2));
    const leaves = w.member(user(3));
    await temp.addTempRole({ member: stays, role: { id: ROLE }, ms: 3_600_000, by, now: past });
    await temp.addTempRole({ member: leaves, role: { id: GONE_ROLE }, ms: 3_600_000, by, now: past });
    const running = w.member(user(4));
    await temp.addTempRole({ member: running, role: { id: ROLE }, ms: 3_600_000, by });
    w.members.delete(user(3));
    w.calls.length = 0;
    const handled = await temp.runTempRoleExpiry(w.client);
    assert.ok(handled >= 2);
    assert.deepEqual(w.calls, [{ id: user(2), call: 'remove', roleId: ROLE, reason: 'Temporary role ended' }]);
    assert.deepEqual(await rowsFor(user(2)), []);
    assert.deepEqual(await rowsFor(user(3)), []);
    assert.equal((await rowsFor(user(4))).length, 1, 'a role that has not ended stays');
});

test('rejoin before the end gives the role back; an ended or deleted role is not given', { skip }, async () => {
    const w = fakeWorld();
    const by = { id: user(9), username: 'admin' };
    const first = w.member(user(5));
    await temp.addTempRole({ member: first, role: { id: ROLE }, ms: 3_600_000, by });
    await temp.addTempRole({ member: first, role: { id: GONE_ROLE }, ms: 3_600_000, by });
    const rejoined = w.member(user(5));
    w.calls.length = 0;
    await temp.reapplyTempRolesOnJoin(rejoined);
    assert.deepEqual(w.calls, [{ id: user(5), call: 'add', roleId: ROLE, reason: 'Temporary role (rejoined before it ended)' }]);
    w.calls.length = 0;
    await temp.reapplyTempRolesOnJoin(w.member(user(5)), new Date(Date.now() + 2 * 3_600_000));
    assert.deepEqual(w.calls, [], 'after the end nothing is given back');
});

test('rejoin skips (and forgets) a role that has since gained staff permissions', { skip }, async () => {
    const w = fakeWorld();
    const by = { id: user(9), username: 'admin' };
    await temp.addTempRole({ member: w.member(user(6)), role: { id: STAFF_ROLE }, ms: 3_600_000, by });
    w.calls.length = 0;
    await temp.reapplyTempRolesOnJoin(w.member(user(6)));
    assert.deepEqual(w.calls, [], 'a role with Administrator is never handed out automatically');
    assert.deepEqual(await rowsFor(user(6)), []);
});

test('endTempRoles: only the removed roles, or every role (ban)', { skip }, async () => {
    const w = fakeWorld();
    const by = { id: user(9), username: 'admin' };
    const m = w.member(user(7));
    await temp.addTempRole({ member: m, role: { id: ROLE }, ms: 3_600_000, by });
    await temp.addTempRole({ member: m, role: { id: GONE_ROLE }, ms: 3_600_000, by });
    await temp.endTempRoles(guildId, user(7), []);
    assert.equal((await rowsFor(user(7))).length, 2, 'an empty list removes nothing');
    await temp.endTempRoles(guildId, user(7), [ROLE]);
    assert.deepEqual((await rowsFor(user(7))).map((r) => r.role_id), [GONE_ROLE]);
    await temp.endTempRoles(guildId, user(7));
    assert.deepEqual(await rowsFor(user(7)), []);
});
