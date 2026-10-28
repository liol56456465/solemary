// Role rules (dashboard Members → Role rules): evaluation and dry run (pure), the role safety
// refusals, the runner (adds, removes, change cap, pauses, run records) and the per-member
// event path, all with fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    describeRule, dryRunRule, planRules, ruleMatches, ruleProblem, runRoleRules, applyRoleRulesToMember,
} from '../src/services/members/roleRuleService.js';

const G = '100000000000000001';
const NOW = Date.UTC(2026, 9, 28, 12);
const DAY = 864e5;
const ROLE = { regular: '600000000000000001', veteran: '600000000000000002', vip: '600000000000000003', staff: '600000000000000004', top: '600000000000000005', bridge: '600000000000000006', booster: '600000000000000007' };

function makeGuild() {
    const guild = { id: G, memberCount: 0, calls: [] };
    const role = (id, name, position, { perms = [], managed = false } = {}) => ({ id, name, position, managed, guild, permissions: { has: (p) => perms.includes(p) } });
    guild.roles = { cache: new Map([
        [G, role(G, '@everyone', 0)],
        [ROLE.regular, role(ROLE.regular, 'Regular', 2)],
        [ROLE.veteran, role(ROLE.veteran, 'Veteran', 3)],
        [ROLE.vip, role(ROLE.vip, 'VIP', 4)],
        [ROLE.staff, role(ROLE.staff, 'Staff', 5, { perms: ['BanMembers'] })],
        [ROLE.top, role(ROLE.top, 'Above bot', 20)],
        [ROLE.bridge, role(ROLE.bridge, 'Bridge', 6, { managed: true })],
        [ROLE.booster, role(ROLE.booster, 'Booster', 7)],
    ]) };
    guild.members = { cache: new Map(), me: { id: '999', roles: { highest: { position: 10 } } }, fetch: async () => guild.members.cache };
    return guild;
}

function addMember(guild, id, { days = 10, roles = [], bot = false, fail = false } = {}) {
    const cache = new Map([[G, { id: G }], ...roles.map((r) => [r, { id: r }])]);
    const member = {
        id, guild, joinedTimestamp: NOW - days * DAY, user: { id, username: `u${id.slice(-3)}`, bot },
        roles: {
            cache,
            add: async (roleId, reason) => { if (fail) throw new Error('Missing Permissions'); guild.calls.push(['add', id, roleId, reason]); cache.set(roleId, { id: roleId }); },
            remove: async (roleId, reason) => { guild.calls.push(['remove', id, roleId, reason]); cache.delete(roleId); },
        },
    };
    guild.members.cache.set(id, member);
    guild.memberCount = guild.members.cache.size;
    return member;
}

const rule = (over) => ({ id: 1, name: 'Regulars', trigger: 'days_in_server', threshold: 30, triggerRoleId: null, roleId: ROLE.regular, removeWhenFalse: false, enabled: true, ...over });
const ctx = (guild, extra = {}) => ({ guild, botMember: guild.members.me, now: NOW, ...extra });

test('ruleMatches: days in the server, leveling level and has role', () => {
    const guild = makeGuild();
    const old = addMember(guild, '300000000000000001', { days: 31 });
    const fresh = addMember(guild, '300000000000000002', { days: 1, roles: [ROLE.vip] });
    assert.equal(ruleMatches(rule(), old, { now: NOW }), true);
    assert.equal(ruleMatches(rule(), fresh, { now: NOW }), false);
    assert.equal(ruleMatches(rule({ threshold: 0 }), fresh, { now: NOW }), true, '0 days = everyone');
    assert.equal(ruleMatches(rule(), { id: 'x', roles: { cache: new Map() } }, { now: NOW }), false, 'unknown join date never matches');
    const levels = new Map([[old.id, 5]]);
    assert.equal(ruleMatches(rule({ trigger: 'level_reached', threshold: 5 }), old, { levels }), true);
    assert.equal(ruleMatches(rule({ trigger: 'level_reached', threshold: 6 }), old, { levels }), false);
    assert.equal(ruleMatches(rule({ trigger: 'level_reached', threshold: 1 }), fresh, { levels }), false, 'no level row = level 0');
    assert.equal(ruleMatches(rule({ trigger: 'has_role', triggerRoleId: ROLE.vip }), fresh, {}), true);
    assert.equal(ruleMatches(rule({ trigger: 'has_role', triggerRoleId: ROLE.vip }), old, {}), false);
});

test('ruleProblem: the given role must be safe to hand out (same check as other automatic roles)', () => {
    const guild = makeGuild();
    const me = guild.members.me;
    assert.equal(ruleProblem(rule(), guild, me), null);
    assert.match(ruleProblem(rule({ roleId: G }), guild, me), /@everyone/);
    assert.match(ruleProblem(rule({ roleId: ROLE.bridge }), guild, me), /managed/);
    assert.match(ruleProblem(rule({ roleId: ROLE.top }), guild, me), /not below my highest role/);
    assert.match(ruleProblem(rule({ roleId: ROLE.staff }), guild, me), /staff permissions \(BanMembers\)/);
    assert.match(ruleProblem(rule({ roleId: '600000000000000099' }), guild, me), /no longer exists/);
    assert.match(ruleProblem(rule(), guild, null), /not below my highest role/, 'no bot member: fails closed');
    assert.match(ruleProblem(rule({ trigger: 'has_role', triggerRoleId: G }), guild, me), /not @everyone/);
    assert.match(ruleProblem(rule({ trigger: 'has_role', triggerRoleId: ROLE.regular }), guild, me), /must differ/);
    assert.match(ruleProblem(rule({ trigger: 'has_role', triggerRoleId: '600000000000000099' }), guild, me), /trigger role no longer exists/);
    assert.match(ruleProblem(rule({ threshold: -1 }), guild, me), /0 to 3650/);
    assert.match(ruleProblem(rule({ threshold: 4000 }), guild, me), /0 to 3650/);
    assert.match(ruleProblem(rule({ trigger: 'level_reached', threshold: 0 }), guild, me), /1 to 1000/);
    assert.match(ruleProblem(rule({ trigger: 'nope' }), guild, me), /Unknown trigger/);
});

test('planRules: adds to matching members, removes only with "remove when no longer true", never bots', () => {
    const guild = makeGuild();
    const a = addMember(guild, '300000000000000001', { days: 40 });
    const b = addMember(guild, '300000000000000002', { days: 40, roles: [ROLE.regular] });
    const c = addMember(guild, '300000000000000003', { days: 2, roles: [ROLE.regular] });
    addMember(guild, '300000000000000004', { days: 400, bot: true });
    const [keep] = planRules([rule()], guild.members.cache.values(), ctx(guild));
    assert.deepEqual(keep.add, [a.id]);
    assert.deepEqual(keep.remove, [], 'without the option nothing is taken away');
    const [strict] = planRules([rule({ removeWhenFalse: true })], guild.members.cache.values(), ctx(guild));
    assert.deepEqual(strict.add, [a.id]);
    assert.deepEqual(strict.remove, [c.id]);
    assert.ok(!strict.add.includes(b.id), 'already has it');
});

test('planRules: another rule for the same role keeps it; one add per member and role; unsafe rules change nothing', () => {
    const guild = makeGuild();
    const vip = addMember(guild, '300000000000000001', { days: 2, roles: [ROLE.vip, ROLE.regular] });
    const old = addMember(guild, '300000000000000002', { days: 40, roles: [ROLE.vip] });
    const rules = [
        rule({ id: 1, removeWhenFalse: true }),
        rule({ id: 2, name: 'VIPs are regulars', trigger: 'has_role', triggerRoleId: ROLE.vip, threshold: null }),
        rule({ id: 3, name: 'Staff for all', roleId: ROLE.staff, threshold: 0 }),
    ];
    const plans = planRules(rules, guild.members.cache.values(), ctx(guild));
    assert.deepEqual(plans[0].remove, [], 'the VIP rule still gives Regular to the new VIP');
    assert.deepEqual(plans[0].add, [old.id]);
    assert.deepEqual(plans[1].add, [], 'old already claimed by rule 1; vip already has it');
    assert.match(plans[2].problem, /staff permissions/);
    assert.deepEqual([plans[2].add, plans[2].remove], [[], []]);
    assert.ok(vip);
});

test('dryRunRule: the edited rule replaces its saved version; disabled rules do not count', () => {
    const guild = makeGuild();
    const m = addMember(guild, '300000000000000001', { days: 10, roles: [ROLE.regular] });
    const saved = [rule({ id: 1, threshold: 5 }), rule({ id: 2, threshold: 1, enabled: false })];
    // Editing rule 1 to 30 days with removal: the old 5-day version must not protect the member.
    const plan = dryRunRule(rule({ id: 1, threshold: 30, removeWhenFalse: true }), saved, guild.members.cache.values(), ctx(guild));
    assert.deepEqual(plan.remove, [m.id]);
    // A new rule next to the enabled 5-day rule for the same role: that one protects the member.
    const fresh = dryRunRule(rule({ id: undefined, threshold: 30, removeWhenFalse: true }), saved, guild.members.cache.values(), ctx(guild));
    assert.deepEqual(fresh.remove, []);
});

test('describeRule: plain sentences for the page and the audit row', () => {
    const name = (id) => ({ [ROLE.regular]: 'Regular', [ROLE.vip]: 'VIP' })[id];
    assert.equal(describeRule(rule(), name), 'Members in the server for 30+ days get @Regular.');
    assert.equal(describeRule(rule({ threshold: 0 }), name), 'Every member, on joining, get @Regular.');
    assert.equal(describeRule(rule({ trigger: 'level_reached', threshold: 5, removeWhenFalse: true }), name), 'Members at leveling level 5+ get @Regular, taken away again when that is no longer true.');
    assert.equal(describeRule(rule({ trigger: 'has_role', triggerRoleId: ROLE.vip }), name), 'Members with @VIP get @Regular.');
});

function fakeDeps(rules, { levels = new Map(), limit = 120 } = {}) {
    const runs = [];
    const sleeps = [];
    return {
        runs, sleeps,
        deps: {
            guildIds: async () => [G, '100000000000000999'],
            listRules: async () => rules,
            loadLevels: async () => levels,
            recordRun: async (r, result) => { runs.push({ id: r.id, ...result }); },
            completeMemberCache: async () => {},
            sleep: async (ms) => { sleeps.push(ms); },
            delayMs: 1000,
            limit,
        },
    };
}

test('runRoleRules: gives and takes roles, pauses between calls, records each rule run', async () => {
    const guild = makeGuild();
    const a = addMember(guild, '300000000000000001', { days: 40 });
    const c = addMember(guild, '300000000000000003', { days: 2, roles: [ROLE.regular] });
    const lvl = addMember(guild, '300000000000000005', { days: 1 });
    const rules = [rule({ removeWhenFalse: true }), rule({ id: 2, name: 'Level 5', trigger: 'level_reached', threshold: 5, roleId: ROLE.veteran }), rule({ id: 3, name: 'Bad', roleId: ROLE.top })];
    const { deps, runs, sleeps } = fakeDeps(rules, { levels: new Map([[lvl.id, 7]]) });
    const client = { guilds: { cache: new Map([[G, guild]]) } };
    const [summary] = await runRoleRules(client, { now: new Date(NOW), deps });
    assert.deepEqual(guild.calls, [
        ['add', a.id, ROLE.regular, 'Role rule: Regulars'],
        ['remove', c.id, ROLE.regular, 'Role rule: Regulars'],
        ['add', lvl.id, ROLE.veteran, 'Role rule: Level 5'],
    ]);
    assert.deepEqual(sleeps, [1000, 1000], 'a pause between calls, none before the first');
    assert.deepEqual({ ...summary }, { guildId: G, added: 2, removed: 1, failed: 0, capped: false });
    assert.equal(runs.length, 3);
    assert.deepEqual(runs.find((r) => r.id === 1), { id: 1, at: new Date(NOW), added: 1, removed: 1, failed: 0, problem: null });
    assert.match(runs.find((r) => r.id === 3).problem, /not below my highest role/);
    assert.ok(!runs.find((r) => r.id === 3).problem.includes('**'), 'stored without markdown');
    // A second run finds nothing to do.
    guild.calls.length = 0;
    await runRoleRules(client, { now: new Date(NOW), deps });
    assert.deepEqual(guild.calls, []);
});

test('runRoleRules: stops at the change cap (the rest next run) and counts failed calls', async () => {
    const guild = makeGuild();
    for (let i = 0; i < 5; i += 1) addMember(guild, `30000000000000001${i}`, { days: 40 });
    addMember(guild, '300000000000000020', { days: 40, fail: true });
    const { deps, runs } = fakeDeps([rule()], { limit: 3 });
    const client = { guilds: { cache: new Map([[G, guild]]) } };
    const [first] = await runRoleRules(client, { now: new Date(NOW), deps });
    assert.equal(guild.calls.length, 3);
    assert.equal(first.capped, true);
    const second = await runRoleRules(client, { now: new Date(NOW), deps });
    const third = await runRoleRules(client, { now: new Date(NOW), deps });
    assert.equal(guild.calls.length, 5, 'everyone got it over the next runs');
    assert.equal(second[0].added + third[0].added, 2);
    assert.equal(second[0].failed, 1, 'the failing member is counted, not fatal');
    assert.deepEqual([third[0].added, third[0].failed], [0, 1], 'and tried again on the next run');
    assert.ok(runs.some((r) => r.failed === 1));
});

test('applyRoleRulesToMember: only the triggers asked for; the level from the event; bots never', async () => {
    const guild = makeGuild();
    const m = addMember(guild, '300000000000000001', { days: 40, roles: [ROLE.vip] });
    const rules = [rule(), rule({ id: 2, name: 'L3', trigger: 'level_reached', threshold: 3, roleId: ROLE.veteran }), rule({ id: 3, name: 'VIP', trigger: 'has_role', triggerRoleId: ROLE.vip, roleId: ROLE.booster })];
    let levelLookups = 0;
    const deps = { listEnabled: async () => rules, loadLevels: async () => { levelLookups += 1; return new Map(); } };
    assert.deepEqual(await applyRoleRulesToMember(m, { triggers: ['level_reached'], level: 3, deps }), { added: 1, removed: 0 });
    assert.deepEqual(guild.calls, [['add', m.id, ROLE.veteran, 'Role rule: L3']]);
    assert.equal(levelLookups, 0, 'level passed by the level-up event');
    assert.deepEqual(await applyRoleRulesToMember(m, { triggers: ['has_role'], deps }), { added: 1, removed: 0 });
    assert.equal(levelLookups, 1, 'looked up once for the "another rule" check');
    assert.deepEqual(await applyRoleRulesToMember(m, { deps }), { added: 1, removed: 0 }, 'join: every rule (days)');
    assert.deepEqual(await applyRoleRulesToMember(m, { deps }), { added: 0, removed: 0 }, 'nothing left');
    const bot = addMember(guild, '300000000000000002', { days: 40, bot: true });
    assert.deepEqual(await applyRoleRulesToMember(bot, { deps }), { added: 0, removed: 0 });
    assert.deepEqual(await applyRoleRulesToMember(m, { triggers: ['has_role'], deps: { listEnabled: async () => [], loadLevels: deps.loadLevels } }), { added: 0, removed: 0 });
});
