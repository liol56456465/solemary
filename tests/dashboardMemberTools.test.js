// Members → Role rules and Insights in the dashboard: the insight helpers (pure), the pages
// (escaping, no inline styles, the chart), and every POST with fake req/res: no CSRF, editing
// off, no Administrator → 403 and nothing saved; unsafe roles refused; dry run → save with the
// one-time token → audit row + mod-log line + 303.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { createDashboard, dashboardSettings } from '../src/services/dashboard/routes.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import { SESSION_COOKIE, signValue } from '../src/services/dashboard/security.js';
import { fillDays, inactiveMembers, membersWithoutRoles } from '../src/services/members/memberInsightsService.js';
import { insightsPage, joinsChart, roleRulePreviewPage, roleRulesPage } from '../src/services/dashboard/memberToolsPages.js';
import { parseRuleForm } from '../src/services/dashboard/memberToolsRoutes.js';

const NOW = Date.UTC(2026, 9, 28, 12);
const DAY = 864e5;
const SECRET = 'z'.repeat(64);
const GUILD = '100000000000000001';
const ADMIN = '200000000000000002';
const OWNER = '200000000000000003';
const ORIGIN = 'https://bot.example';
const ROLE = { regular: '600000000000000001', staff: '600000000000000004', high: '600000000000000005', vip: '600000000000000003' };
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};
const session = { username: 'a', csrf: 't' };

// ── insight helpers ──────────────────────────────────────────────────────

test('fillDays: 30 UTC days oldest first, gaps are zero, today last', () => {
    const days = fillDays([{ day: '2026-10-28', kind: 'join', n: 3 }, { day: '2026-10-28', kind: 'leave', n: 1 }, { day: '2026-10-01', kind: 'leave', n: '2' }, { day: '2026-09-01', kind: 'join', n: 9 }], { now: NOW });
    assert.equal(days.length, 30);
    assert.deepEqual(days.at(-1), { day: '2026-10-28', joins: 3, leaves: 1 });
    assert.deepEqual(days[0], { day: '2026-09-29', joins: 0, leaves: 0 });
    assert.equal(days.find((d) => d.day === '2026-10-01').leaves, 2);
    assert.ok(!days.some((d) => d.day === '2026-09-01'), 'outside the window');
});

function cacheGuild(list) {
    const member = ({ id, days, roles = [], bot = false, nick = null }) => ({
        id, nickname: nick, joinedTimestamp: NOW - days * DAY, user: { id, username: `user${id.slice(-2)}`, bot },
        roles: { cache: new Map([[GUILD, {}], ...roles.map((r) => [r, {}])]) },
    });
    return { id: GUILD, members: { cache: new Map(list.map((m) => [m.id, member(m)])) } };
}

test('membersWithoutRoles: joined 24 h – 30 d ago, still no role, no bots; longest waiting first', () => {
    const guild = cacheGuild([
        { id: '300000000000000001', days: 0.5 },
        { id: '300000000000000002', days: 3 },
        { id: '300000000000000003', days: 10, nick: '<b>Nick' },
        { id: '300000000000000004', days: 5, roles: [ROLE.regular] },
        { id: '300000000000000005', days: 5, bot: true },
        { id: '300000000000000006', days: 60 },
    ]);
    const result = membersWithoutRoles(guild, { now: NOW });
    assert.equal(result.total, 2);
    assert.deepEqual(result.rows.map((r) => r.id), ['300000000000000003', '300000000000000002']);
    assert.equal(result.rows[0].displayName, '<b>Nick');
});

test('inactiveMembers: last XP older than 30 days; no leveling record counted apart; newcomers and bots left out', () => {
    const guild = cacheGuild([
        { id: '300000000000000001', days: 100 },
        { id: '300000000000000002', days: 100 },
        { id: '300000000000000003', days: 100 },
        { id: '300000000000000004', days: 5 },
        { id: '300000000000000005', days: 100, bot: true },
    ]);
    const last = new Map([['300000000000000001', NOW - 45 * DAY], ['300000000000000002', NOW - 2 * DAY], ['300000000000000004', NOW - 40 * DAY]]);
    const result = inactiveMembers(guild, last, { now: NOW });
    assert.deepEqual(result.rows.map((r) => r.id), ['300000000000000001']);
    assert.equal(result.noRecord, 1, 'member 3 has no record; the bot is not counted');
});

// ── pages ────────────────────────────────────────────────────────────────

test('joinsChart: SVG with classes and presentation attributes only, theme colour classes, a label', () => {
    const days = fillDays([{ day: '2026-10-28', kind: 'join', n: 4 }, { day: '2026-10-27', kind: 'leave', n: 2 }], { now: NOW });
    const svg = String(joinsChart(days));
    assert.ok(svg.startsWith('<svg class="ins-chart"'));
    assert.ok(!/style=/.test(svg), 'no inline styles (CSP)');
    assert.equal((svg.match(/class="ins-join"/g) || []).length, 1);
    assert.equal((svg.match(/class="ins-leave"/g) || []).length, 1);
    assert.match(svg, /aria-label="Joins and leaves per day, last 30 days: 4 joins, 2 leaves"/);
    assert.match(svg, /<title>2026-10-28: 4 joined, 0 left<\/title>/);
    const empty = String(joinsChart(fillDays([], { now: NOW })));
    assert.ok(!empty.includes('<rect'), 'no bars on empty days');
});

test('dashboard.css: the chart classes use the theme chart tokens', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../src/services/dashboard/static/dashboard.css', import.meta.url), 'utf8');
    assert.match(css, /\.ins-join \{ fill: var\(--c-[a-z]+\); \}/);
    assert.match(css, /\.ins-leave \{ fill: var\(--c-[a-z]+\); \}/);
});

test('insightsPage: escapes names, explains missing activity data instead of inventing it, shows each error apart', () => {
    const joins = { days: fillDays([], { now: NOW }), since: null };
    const offenders = [{ userId: '300000000000000001', username: '<script>x</script>', cases: 3, warns: 2, mutes: 0, kicks: 1, bans: 0, lastAt: new Date(NOW) }];
    const noRoles = { total: 1, rows: [{ id: '300000000000000002', username: 'u', displayName: '<img src=x>', joinedAt: new Date(NOW - 2 * DAY) }] };
    const off = String(insightsPage({ session, joins, noRoles, offenders, levelingOn: false }));
    assert.ok(off.includes('&lt;script&gt;x&lt;/script&gt;') && !off.includes('<script>x'), 'escaped');
    assert.ok(off.includes('&lt;img src=x&gt;'));
    assert.ok(off.includes('3<br><small class="muted">2 warns, 1 kick</small>'));
    assert.match(off, /Not available: the only activity time Mewvo stores is the last time leveling gave a member XP, and leveling is off/);
    assert.ok(off.includes('Nothing counted yet'));
    assert.ok(!/style=/.test(off), 'no inline styles');
    assert.ok(off.includes('aria-current="page">Insights'), 'tab row');
    const on = String(insightsPage({ session, joins: null, joinsError: 'DB down', offenders: null, offendersError: 'DB down 2', levelingOn: true, inactive: { total: 0, noRecord: 1, rows: [] } }));
    assert.ok(on.includes('DB down') && on.includes('DB down 2'));
    assert.ok(on.includes('1 member has no leveling record at all'));
});

const ROLE_NAMES = { [ROLE.regular]: 'Regular<b>', [ROLE.vip]: 'VIP' };
const roleName = (id) => ROLE_NAMES[id] || id;

test('roleRulesPage: rules escaped, paused rules say why, view-only without the form, 25-rule cap', () => {
    const rules = [
        { id: 1, name: '<i>Regulars</i>', trigger: 'days_in_server', threshold: 30, roleId: ROLE.regular, removeWhenFalse: true, enabled: true, lastRunAt: new Date(NOW), lastAdded: 2, lastRemoved: 1, lastFailed: 0 },
        { id: 2, name: 'VIP', trigger: 'has_role', triggerRoleId: ROLE.vip, roleId: ROLE.regular, enabled: false },
    ];
    const page = String(roleRulesPage({ session, rules, roleName, problems: new Map([[1, 'Regular is not below my highest role']]), canWrite: true, givable: [{ id: ROLE.regular, name: 'Regular<b>' }], roles: [] }));
    assert.ok(page.includes('&lt;i&gt;Regulars&lt;/i&gt;') && !page.includes('<i>Regulars'));
    assert.ok(page.includes('@Regular&lt;b&gt;'));
    assert.ok(page.includes('On, paused') && page.includes('not below my highest role'));
    assert.ok(page.includes('+2 −1'));
    assert.ok(page.includes('action="/dashboard/users/rules/1/disable"'));
    assert.ok(page.includes('Turn on…'), 'disabled rule: turn on goes through the dry run');
    assert.ok(page.includes('action="/dashboard/users/rules/preview"'));
    assert.ok(page.includes('Dry run'));
    assert.ok(!/style=/.test(page));
    const view = String(roleRulesPage({ session, rules, roleName, canWrite: false, canAct: false }));
    assert.ok(!view.includes('/users/rules/preview') && !view.includes('/disable'), 'no forms for viewers');
    assert.ok(view.includes('View only'));
    const full = String(roleRulesPage({ session, rules: Array.from({ length: 25 }, (_, i) => ({ ...rules[1], id: i + 1 })), roleName, canWrite: true }));
    assert.ok(full.includes('the most allowed'));
});

test('roleRulePreviewPage: counts, names (escaped, capped at 50), the save token', () => {
    const add = Array.from({ length: 52 }, (_, i) => ({ id: `3000000000000001${String(i).padStart(2, '0')}`, name: i === 0 ? '<b>first' : `m${i}` }));
    const page = String(roleRulePreviewPage({ session, rule: { name: 'R', enabled: true, removeWhenFalse: true }, description: 'desc', add, remove: [{ id: '300000000000000999', name: 'gone' }], token: 'tok', hash: 'hh' }));
    assert.ok(page.includes('Would change <b>53</b> members now: give the role to 52, take it from 1.'));
    assert.ok(page.includes('&lt;b&gt;first'));
    assert.ok(page.includes('… and 2 more.'));
    assert.ok(page.includes('name="token" value="tok"') && page.includes('name="fh" value="hh"'));
    assert.ok(page.includes('action="/dashboard/users/rules/save"'));
});

test('parseRuleForm: required fields, numbers, has-role needs a trigger role', () => {
    assert.deepEqual(parseRuleForm({ name: 'R', trigger: 'days_in_server', threshold: '30', roleId: ROLE.regular, enabled: '1' }),
        { name: 'R', trigger: 'days_in_server', roleId: ROLE.regular, removeWhenFalse: false, enabled: true, threshold: 30, triggerRoleId: null });
    assert.throws(() => parseRuleForm({ trigger: 'days_in_server', threshold: '1', roleId: ROLE.regular }), /Give the rule a name/);
    assert.throws(() => parseRuleForm({ name: 'R', trigger: 'x', roleId: ROLE.regular }), /Choose when/);
    assert.throws(() => parseRuleForm({ name: 'R', trigger: 'days_in_server', threshold: '-1', roleId: ROLE.regular }), /whole number/);
    assert.throws(() => parseRuleForm({ name: 'R', trigger: 'days_in_server', threshold: '1', roleId: 'abc' }), /role to give/);
    assert.throws(() => parseRuleForm({ name: 'R', trigger: 'has_role', roleId: ROLE.regular }), /trigger role/);
    assert.throws(() => parseRuleForm({ name: 'x'.repeat(81), trigger: 'has_role', roleId: ROLE.regular }), /Too long/);
    assert.equal(parseRuleForm({ name: 'R', trigger: 'has_role', triggerRoleId: ROLE.vip, roleId: ROLE.regular, id: '7' }).id, 7);
});

// ── handlers (fake req/res) ──────────────────────────────────────────────

function makeWorld({ admins }) {
    const guild = { id: GUILD, ownerId: '999999999999999990', name: 'Main', memberCount: 3 };
    const role = (id, name, position, perms = []) => ({ id, name, position, managed: false, guild, permissions: { has: (p) => perms.includes(p) } });
    guild.roles = { cache: new Map([[GUILD, role(GUILD, '@everyone', 0)], [ROLE.regular, role(ROLE.regular, 'Regular', 2)], [ROLE.vip, role(ROLE.vip, 'VIP', 3)],
        [ROLE.staff, role(ROLE.staff, 'Staff', 4, ['KickMembers'])], [ROLE.high, role(ROLE.high, 'High', 8)]]) };
    const memberOf = (id, days, roles = []) => ({
        id, guild, nickname: null, joinedTimestamp: Date.now() - days * DAY, user: { id, username: `user${id.slice(-2)}` },
        permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator && admins.has(id) },
        roles: { cache: new Map([[GUILD, {}], ...roles.map((r) => [r, {}])]), highest: { position: id === ADMIN ? 5 : 1 } },
    });
    const cache = new Map([['300000000000000001', memberOf('300000000000000001', 40)], ['300000000000000002', memberOf('300000000000000002', 2, [ROLE.regular])], ['300000000000000003', memberOf('300000000000000003', 50, [ROLE.regular])]]);
    guild.members = {
        cache, me: { id: '999999999999999998', roles: { highest: { position: 10 } } },
        fetch: async (arg) => { const id = typeof arg === 'string' ? arg : arg?.user; return id ? (cache.get(id) || (id === ADMIN || id === OWNER ? memberOf(id, 100) : null)) : cache; },
    };
    const client = { user: { id: '999999999999999998' }, guilds: { cache: new Map([[GUILD, guild]]) }, users: { cache: new Map(), fetch: async () => null } };
    return { guild, client };
}

function fakeTools() {
    const calls = [];
    const saved = [];
    const tools = {
        listRoleRules: async () => saved.map((r) => ({ ...r })),
        saveRoleRule: async (g, rule, by) => {
            calls.push({ name: 'saveRoleRule', rule, by });
            if (rule.id) {
                const i = saved.findIndex((r) => r.id === rule.id);
                if (i < 0) return { before: null, after: null };
                const before = saved[i];
                saved[i] = { ...before, ...rule };
                return { before, after: saved[i] };
            }
            const after = { ...rule, id: saved.length + 1 };
            saved.push(after);
            return { before: null, after };
        },
        disableRoleRule: async (g, id) => { calls.push({ name: 'disableRoleRule', id }); const r = saved.find((x) => x.id === id); if (!r) return null; const before = { ...r }; r.enabled = false; return before; },
        deleteRoleRule: async (g, id) => { calls.push({ name: 'deleteRoleRule', id }); const i = saved.findIndex((x) => x.id === id); return i < 0 ? null : saved.splice(i, 1)[0]; },
        loadLevels: async () => new Map(),
        joinsLeavesPerDay: async () => ({ days: fillDays([{ day: new Date().toISOString().slice(0, 10), kind: 'join', n: 2 }]), since: new Date() }),
        repeatOffenders: async () => [],
        loadLastActivity: async () => new Map(),
        levelingEnabled: async () => true,
    };
    return { tools, calls, saved };
}

function fakeRes() {
    return {
        statusCode: 200, headers: {}, body: null, redirectedTo: null,
        status(code) { this.statusCode = code; return this; }, type() { return this; },
        send(body) { this.body = body; return this; }, set(name, value) { this.headers[name] = value; return this; },
        append() { return this; }, redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
}

async function setup({ env = ENV, userId = ADMIN, admins = new Set([ADMIN]) } = {}) {
    const { guild, client } = makeWorld({ admins });
    const { tools, calls, saved } = fakeTools();
    const sessions = createMemorySessionStore();
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: admins.has(id), isOwnerId: id === OWNER }) });
    const auditRows = [];
    const modLog = [];
    const auditStore = { writeRows: async (g, actor, module, changes) => { for (const c of changes) auditRows.push({ module, ...c }); return changes.length; }, list: async () => ({ rows: [], total: 0 }), users: async () => [] };
    const services = { postModLog: async (c, kind, fields, options) => { modLog.push({ kind, fields, options }); }, getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) };
    const d = createDashboard({ client, settings: dashboardSettings(env), sessions, access, services, auditStore, env, memberTools: tools, enforcement: { isBotOwner: (id) => id === OWNER, memberStandings: async () => ({ ladder: new Map(), muted: new Set() }) } });
    const s = await sessions.create({ userId, username: userId === OWNER ? 'owner' : 'admin' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(s.id, SECRET))}`;
    return { d, calls, saved, session: s, cookie, auditRows, modLog, guild };
}

async function run(h, handler, req) {
    const res = fakeRes();
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (passed) await handler(req, res, () => {});
    return res;
}
const get = (h, handler, query = {}) => run(h, handler, { method: 'GET', params: {}, query, headers: { cookie: h.cookie } });
const post = (h, handler, { params = {}, form = {}, csrf = h.session.csrf } = {}) => run(h, handler, {
    method: 'POST', params, query: {}, path: '/x', headers: { cookie: h.cookie, origin: ORIGIN }, body: { ...(csrf === null ? {} : { csrf }), ...form },
});
const RULE_FORM = { name: 'Regulars', trigger: 'days_in_server', threshold: '30', roleId: ROLE.regular, removeWhenFalse: '1', enabled: '1' };
const tokenOf = (body) => ({ token: /name="token" value="([^"]+)"/.exec(body)[1], fh: /name="fh" value="([^"]+)"/.exec(body)[1] });

test('role rules: dry run shows who changes, then the token saves it (audited + mod log); the token works once', async () => {
    const h = await setup();
    const mt = h.d.memberTools;
    const preview = await post(h, mt.preview, { form: RULE_FORM });
    assert.equal(preview.statusCode, 200);
    assert.ok(preview.body.includes('Would change <b>2</b> members now: give the role to 1, take it from 1.'), preview.body.match(/notice">[^<]*/)?.[0]);
    assert.ok(preview.body.includes('user01') && preview.body.includes('user02'));
    assert.equal(h.calls.length, 0, 'nothing saved by the dry run');
    const saved = await post(h, mt.save, { form: tokenOf(preview.body) });
    assert.equal(saved.statusCode, 303);
    assert.equal(saved.redirectedTo, '/dashboard/users/rules');
    assert.equal(h.saved.length, 1);
    assert.deepEqual(h.calls[0].by, { id: ADMIN, username: 'admin' });
    assert.equal(h.auditRows[0].module, 'rolerules');
    assert.equal(h.auditRows[0].new.rule, 'Members in the server for 30+ days get @Regular, taken away again when that is no longer true.');
    assert.equal(h.modLog.length, 1);
    const again = await post(h, mt.save, { form: tokenOf(preview.body) });
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /expired or was already used/);
    assert.equal(h.saved.length, 1);
    const page = await get(h, mt.rules);
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('Regulars'));
});

test('role rules: unsafe roles are refused before the dry run (staff permissions, above the bot or the moderator, @everyone)', async () => {
    const h = await setup();
    const mt = h.d.memberTools;
    for (const [roleId, message] of [[ROLE.staff, /staff permissions/], [ROLE.high, /not below my highest role|not below your highest role/], [GUILD, /@everyone/]]) {
        const res = await post(h, mt.preview, { form: { ...RULE_FORM, roleId } });
        assert.equal(res.statusCode, 400, roleId);
        assert.match(res.body, message);
    }
    // VIP (position 3) is below the bot (10) and the admin (5): fine. Not below an admin at position 2.
    h.guild.roles.cache.get(ROLE.vip).position = 6;
    const above = await post(h, mt.preview, { form: { ...RULE_FORM, roleId: ROLE.vip } });
    assert.equal(above.statusCode, 400);
    assert.match(above.body, /not below your highest role/);
    assert.equal(h.calls.length, 0);
    // The form keeps what was typed.
    assert.ok(above.body.includes('value="Regulars"'));
});

test('role rules: no CSRF, editing off, or no Administrator → 403 and nothing saved', async () => {
    const h = await setup();
    const res = await post(h, h.d.memberTools.preview, { form: RULE_FORM, csrf: null });
    assert.equal(res.statusCode, 403);
    const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    assert.equal((await post(off, off.d.memberTools.preview, { form: RULE_FORM })).statusCode, 403);
    const owner = await setup({ userId: OWNER });
    const denied = await post(owner, owner.d.memberTools.preview, { form: RULE_FORM });
    assert.equal(denied.statusCode, 403);
    assert.match(denied.body, /Administrator/);
    assert.equal((await post(owner, owner.d.memberTools.remove, { params: { rid: '1' } })).statusCode, 403);
    for (const x of [h, off, owner]) assert.equal(x.calls.length, 0);
    // The owner without Administrator can still look.
    const view = await get(owner, owner.d.memberTools.rules);
    assert.equal(view.statusCode, 200);
    assert.ok(view.body.includes('View only'));
});

test('role rules: turn off and delete are audited; an unknown rule is a clear error', async () => {
    const h = await setup();
    const mt = h.d.memberTools;
    h.saved.push({ id: 1, name: 'R', trigger: 'days_in_server', threshold: 1, roleId: ROLE.regular, removeWhenFalse: false, enabled: true });
    const off = await post(h, mt.disable, { params: { rid: '1' } });
    assert.equal(off.statusCode, 303);
    assert.deepEqual(h.auditRows.map((r) => [r.key, r.old, r.new]), [['rule:1.enabled', true, false]]);
    const del = await post(h, mt.remove, { params: { rid: '1' } });
    assert.equal(del.statusCode, 303);
    assert.equal(h.auditRows[1].new, null);
    assert.equal(h.saved.length, 0);
    const missing = await post(h, mt.remove, { params: { rid: '1' } });
    assert.equal(missing.statusCode, 404);
    assert.match(missing.body, /no longer exists/);
    assert.equal((await post(h, mt.disable, { params: { rid: 'abc' } })).statusCode, 404);
});

test('insights page renders for any dashboard user; nothing to post', async () => {
    const h = await setup({ userId: OWNER });
    const res = await get(h, h.d.memberTools.insights);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('Joins and leaves (last 30 days)'));
    assert.ok(res.body.includes('2 joined'));
    assert.ok(res.body.includes('<svg class="ins-chart"'));
});
