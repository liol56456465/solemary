// Members → Role rules and Insights against the local test database (npm run test:db): the
// rule store (create, edit, 25-rule cap, disable, delete), the cron runner with the real store
// and a fake Discord, levels from user_levels, joins/leaves per day + retention, repeat
// offenders (voided / imported / test cases left out) and the last-activity read.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, rules, insights;
const runId = String(Date.now()).slice(-9);
const guildId = `9${runId}00000009`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
const ROLE = `7${runId}00000001`;
const DAY = 864e5;
const by = { id: user(99), username: 'admin' };

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    rules = await import('../../src/services/members/roleRuleService.js');
    insights = await import('../../src/services/members/memberInsightsService.js');
});

after(async () => {
    if (skip) return;
    for (const table of ['member_role_rules', 'member_events', 'mod_cases', 'user_levels']) {
        await pgDb.pool.query(`DELETE FROM ${table} WHERE guild_id = $1`, [guildId]);
    }
    await pgDb.pool.query('DELETE FROM guilds WHERE id = $1', [guildId]);
    await pgDb.disconnect();
});

const rule = (over = {}) => ({ name: 'Regulars', trigger: 'days_in_server', threshold: 30, triggerRoleId: null, roleId: ROLE, removeWhenFalse: true, enabled: true, ...over });

test('rule store: create, edit, disable, delete; at most 25 rules per server', { skip }, async () => {
    const { after: created } = await rules.saveRoleRule(guildId, rule(), by);
    assert.equal(created.name, 'Regulars');
    assert.equal(created.trigger, 'days_in_server');
    assert.equal(created.threshold, 30);
    assert.equal(created.enabled, true);
    assert.equal(created.createdByUsername, 'admin');
    const { before: old, after: edited } = await rules.saveRoleRule(guildId, rule({ id: created.id, name: 'VIPs', trigger: 'has_role', triggerRoleId: user(50), threshold: 5 }), by);
    assert.equal(old.name, 'Regulars');
    assert.equal(edited.threshold, null, 'has-role rules keep no threshold');
    assert.equal(edited.triggerRoleId, user(50));
    const off = await rules.disableRoleRule(guildId, created.id);
    assert.equal(off.enabled, true, 'returns the rule before');
    assert.equal((await rules.getRoleRule(guildId, created.id)).enabled, false);
    assert.equal((await rules.saveRoleRule(guildId, rule({ id: 999999999 }), by)).after, null, 'editing a missing rule saves nothing');
    for (let i = 1; i < rules.MAX_RULES; i += 1) await rules.saveRoleRule(guildId, rule({ name: `R${i}`, enabled: false }), by);
    assert.equal((await rules.listRoleRules(guildId)).length, rules.MAX_RULES);
    const full = await rules.saveRoleRule(guildId, rule({ name: 'one too many' }), by);
    assert.equal(full.full, true);
    assert.equal((await rules.listRoleRules(guildId)).length, rules.MAX_RULES);
    for (const r of await rules.listRoleRules(guildId)) assert.ok(await rules.deleteRoleRule(guildId, r.id));
    assert.equal(await rules.deleteRoleRule(guildId, created.id), null);
    assert.deepEqual(await rules.listRoleRules(guildId), []);
});

test('levels: loadLevels reads user_levels (server or one member)', { skip }, async () => {
    await pgDb.pool.query('INSERT INTO guilds (id) VALUES ($1) ON CONFLICT DO NOTHING', [guildId]);
    for (const [n, level, last] of [[1, 6, Date.now() - 40 * DAY], [2, 0, Date.now()], [3, 2, Date.now() - DAY]]) {
        await pgDb.pool.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING', [user(n)]);
        await pgDb.pool.query('INSERT INTO user_levels (guild_id, user_id, xp, level, total_xp, last_message) VALUES ($1, $2, 0, $3, 0, $4)', [guildId, user(n), level, new Date(last)]);
    }
    assert.deepEqual([...(await rules.loadLevels(guildId)).entries()].sort(), [[user(1), 6], [user(3), 2]]);
    assert.deepEqual([...(await rules.loadLevels(guildId, user(3))).entries()], [[user(3), 2]]);
    const activity = await insights.loadLastActivity(guildId);
    assert.equal(activity.size, 3);
    assert.ok(Math.abs(activity.get(user(1)) - (Date.now() - 40 * DAY)) < 5000);
});

test('runRoleRules with the real store: applies, records the run, skips disabled rules', { skip }, async () => {
    const calls = [];
    const guild = { id: guildId, memberCount: 3 };
    guild.roles = { cache: new Map([[ROLE, { id: ROLE, name: 'Regular', position: 1, managed: false, guild, permissions: { has: () => false } }]]) };
    const member = (n, days, roles = []) => {
        const cache = new Map(roles.map((r) => [r, {}]));
        return { id: user(n), guild, joinedTimestamp: Date.now() - days * DAY, user: { id: user(n) }, roles: { cache,
            add: async (r, reason) => { calls.push(['add', user(n), r, reason]); cache.set(r, {}); },
            remove: async (r, reason) => { calls.push(['remove', user(n), r, reason]); cache.delete(r); } } };
    };
    guild.members = { me: { roles: { highest: { position: 5 } } }, cache: new Map([[user(1), member(1, 40)], [user(2), member(2, 1, [ROLE])], [user(3), member(3, 1)]]) };
    const { after: on } = await rules.saveRoleRule(guildId, rule(), by);
    const { after: lvl } = await rules.saveRoleRule(guildId, rule({ name: 'Level 2', trigger: 'level_reached', threshold: 2, removeWhenFalse: false }), by);
    await rules.saveRoleRule(guildId, rule({ name: 'Off', threshold: 0, enabled: false }), by);
    const client = { guilds: { cache: new Map([[guildId, guild]]) } };
    const summary = await rules.runRoleRules(client, { deps: { sleep: async () => {}, completeMemberCache: async () => {} } });
    const mine = summary.find((s) => s.guildId === guildId);
    // user 1: 40 days → add; user 2: 1 day, has it, no level → removed; user 3: level 2 → add.
    assert.deepEqual(calls.sort(), [['add', user(1), ROLE, 'Role rule: Regulars'], ['add', user(3), ROLE, 'Role rule: Level 2'], ['remove', user(2), ROLE, 'Role rule: Regulars']].sort());
    assert.deepEqual({ added: mine.added, removed: mine.removed, failed: mine.failed }, { added: 2, removed: 1, failed: 0 });
    const stored = await rules.getRoleRule(guildId, on.id);
    assert.ok(stored.lastRunAt);
    assert.deepEqual([stored.lastAdded, stored.lastRemoved, stored.lastProblem], [1, 1, null]);
    assert.equal((await rules.getRoleRule(guildId, lvl.id)).lastAdded, 1);
    // The role became a staff role: the run changes nothing and records why.
    guild.roles.cache.get(ROLE).permissions = { has: (p) => p === 'ManageRoles' };
    calls.length = 0;
    guild.members.cache.get(user(1)).roles.cache.delete(ROLE);
    await rules.runRoleRules(client, { deps: { sleep: async () => {}, completeMemberCache: async () => {} } });
    assert.deepEqual(calls, []);
    assert.match((await rules.getRoleRule(guildId, on.id)).lastProblem, /staff permissions \(ManageRoles\)/);
    for (const r of await rules.listRoleRules(guildId)) await rules.deleteRoleRule(guildId, r.id);
});

test('member events: joins and leaves per UTC day, the first event, and the 90-day retention', { skip }, async () => {
    const now = Date.now();
    const at = (daysAgo) => new Date(now - daysAgo * DAY);
    await insights.recordMemberEvent(guildId, user(1), 'join', at(0));
    await insights.recordMemberEvent(guildId, user(2), 'join', at(0));
    await insights.recordMemberEvent(guildId, user(1), 'leave', at(0));
    await insights.recordMemberEvent(guildId, user(3), 'join', at(5));
    await insights.recordMemberEvent(guildId, user(4), 'leave', at(40));
    await insights.recordMemberEvent(guildId, user(5), 'join', at(100));
    await assert.rejects(insights.recordMemberEvent(guildId, user(6), 'boost'), /Unknown member event/);
    const { days, since } = await insights.joinsLeavesPerDay(guildId, { now });
    assert.equal(days.length, 30);
    assert.deepEqual(days.at(-1), { day: insights.utcDay(now), joins: 2, leaves: 1 });
    assert.equal(days.find((d) => d.day === insights.utcDay(now - 5 * DAY)).joins, 1);
    assert.equal(days.reduce((s, d) => s + d.joins + d.leaves, 0), 4, 'events older than 30 days are not in the chart');
    assert.ok(Math.abs(new Date(since).getTime() - at(100).getTime()) < 1000);
    const pruned = await insights.pruneMemberEvents(new Date(now));
    assert.ok(pruned >= 1);
    const { rows } = await pgDb.pool.query('SELECT COUNT(*)::int AS n FROM member_events WHERE guild_id = $1', [guildId]);
    assert.equal(rows[0].n, 5, 'only the 100-day-old event is gone');
});

test('repeat offenders: two or more real cases in 90 days; voided, imported, test and old cases left out', { skip }, async () => {
    let n = 0;
    const add = async (target, type, daysAgo, extra = {}) => {
        n += 1;
        const code = `r${runId.slice(-4)}${n}`.slice(0, 7).replace(/[01lio]/g, 'x');
        await pgDb.pool.query(
            `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, created_at, is_imported, is_test, voided_at)
             VALUES ($1, $2, $3, $4, '1', 'mod', $5, $2, 'r', 'custom', $6, $7, $8, $9)`,
            [guildId, `${code}${n}`.slice(-7), target, `name${target.slice(-1)}${daysAgo}`, type, new Date(Date.now() - daysAgo * DAY), Boolean(extra.imported), Boolean(extra.test), extra.voided ? new Date() : null]);
    };
    await add(user(1), 'warn', 1); await add(user(1), 'warn', 10); await add(user(1), 'kick', 20);
    await add(user(2), 'warn', 1); await add(user(2), 'warn', 2, { voided: true }); await add(user(2), 'warn', 3, { imported: true }); await add(user(2), 'warn', 4, { test: true });
    await add(user(3), 'mute', 1); await add(user(3), 'ban', 100);
    await add(user(4), 'warn', 5); await add(user(4), 'mute', 6);
    const rows = await insights.repeatOffenders(guildId);
    assert.deepEqual(rows.map((r) => [r.userId, r.cases]), [[user(1), 3], [user(4), 2]]);
    assert.deepEqual([rows[0].warns, rows[0].kicks, rows[0].mutes, rows[0].bans], [2, 1, 0, 0]);
    assert.equal(rows[0].username, `name${user(1).slice(-1)}1`, 'the newest username');
});
