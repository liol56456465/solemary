// Dashboard Phase 3: enforcement and records. Flow-builder parity with the panel,
// confirm tokens (single use, expiry, binding), canAct enforcement, the mass-action
// guard message, and every POST with fake req/res: no CSRF / bad Origin / editing off /
// not allowed → 403, invalid input → 400 and nothing called, valid → the service is
// called, an audit row is written and the browser is sent on with 303.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { createDashboard, dashboardSettings } from '../src/services/dashboard/routes.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import { SESSION_COOKIE, signValue } from '../src/services/dashboard/security.js';
import { createConfirmStore, flowHash } from '../src/services/dashboard/confirmTokens.js';
import { buildRecordFlow, resultMessage, searchMembers } from '../src/services/dashboard/enforcementRoutes.js';
import {
    completeFlowDetails, flowSummary, liftReasonPatch, parseFlowInput, reasonPatch, startFlow, availableActions,
} from '../src/services/enforcement/flowBuilder.js';
import { createError, ErrorTypes } from '../src/utils/errorHandler.js';
import { plainText } from '../src/services/dashboard/forms.js';
import { buildCoverageReport, intensityLevel } from '../src/services/staffCoverageService.js';
import { JS_PATH } from '../src/services/dashboard/html.js';

const ALLOWED_SCRIPT = `<script src="${JS_PATH}" defer></script>`;
const SECRET = 'y'.repeat(64);
const GUILD = '100000000000000001';
const ADMIN = '200000000000000002';
const OWNER = '200000000000000003';
const TARGET = '300000000000000004';
const OTHER = '300000000000000005';
const BOTUSER = '300000000000000006';
const ORIGIN = 'https://bot.example';
const CODE = 'abc234x';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};

const LADDER = { level: 0, warns_since_level: 1 };

// ── fakes ─────────────────────────────────────────────────────────────────

function makeWorld({ admins = new Set([ADMIN]), targetInGuild = true } = {}) {
    const guild = { id: GUILD, ownerId: '999999999999999990', name: 'Main', memberCalls: [] };
    // Role / nickname / timeout calls that reached "Discord" (member page actions).
    const discordSide = (id) => ({
        add: async (roleId, reason) => { guild.memberCalls.push({ id, call: 'roles.add', roleId, reason }); },
        remove: async (roleId, reason) => { guild.memberCalls.push({ id, call: 'roles.remove', roleId, reason }); },
    });
    const memberOf = (id) => ({
        id, guild, nickname: id === TARGET ? 'Nick<b>' : null, joinedAt: new Date('2025-01-01T00:00:00Z'),
        user: { id, username: id === TARGET ? 'target<script>' : `user${id.slice(-2)}`, globalName: id === TARGET ? 'Target Global' : null },
        permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator && admins.has(id) },
        roles: { cache: new Map([[GUILD, { id: GUILD, name: '@everyone', position: 0 }], ['600000000000000001', { id: '600000000000000001', name: 'Member', position: 1 }]]), highest: { position: id === ADMIN ? 5 : 1 }, ...discordSide(id) },
        setNickname: async (nick, reason) => { guild.memberCalls.push({ id, call: 'setNickname', nick, reason }); },
        timeout: async (ms, reason) => { guild.memberCalls.push({ id, call: 'timeout', ms, reason }); },
        communicationDisabledUntilTimestamp: null,
    });
    const cache = new Map([[TARGET, memberOf(TARGET)], [OTHER, memberOf(OTHER)]]);
    guild.roles = { cache: new Map([[GUILD, { id: GUILD, name: '@everyone', position: 0 }], ['600000000000000001', { id: '600000000000000001', name: 'Member', position: 1 }],
        ['600000000000000002', { id: '600000000000000002', name: 'Helper', position: 2 }], ['600000000000000009', { id: '600000000000000009', name: 'Staff', position: 3, permissions: { has: (p) => p === 'BanMembers' } }],
        ['600000000000000008', { id: '600000000000000008', name: 'Above me', position: 6 }]]) };
    guild.members = {
        cache,
        me: { id: '999999999999999998', user: { id: '999999999999999998' }, permissions: { has: () => true }, roles: { highest: { position: 10 } } },
        fetch: async (arg) => {
            const id = typeof arg === 'string' ? arg : arg?.user;
            if (id === TARGET) return targetInGuild ? cache.get(TARGET) : null;
            if (id === ADMIN || id === OWNER) return memberOf(id);
            return cache.get(id) || null;
        },
    };
    const users = new Map([[TARGET, 'target<script>'], [OTHER, 'other'], [ADMIN, 'admin'], [OWNER, 'owner'], [BOTUSER, 'botty']]);
    const client = {
        user: { id: '999999999999999998', username: 'bot' },
        guilds: { cache: new Map([[GUILD, guild]]) },
        users: {
            cache: new Map(),
            fetch: async (id) => (users.has(id) ? {
                id, username: users.get(id), globalName: null, bot: id === BOTUSER, createdAt: new Date('2020-01-01T00:00:00Z'),
                displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/x.png`,
            } : null),
        },
    };
    return { guild, client };
}

const fakeDeps = {
    isNameTaken: async (guildId, name) => name === 'taken name',
    nextDefaultName: async (guildId, userId, username, type) => `${username} ${type} 1`,
    assertBotPermissions: () => {},
    assertCanTarget: (guild, moderator, targetId) => {
        if (targetId === moderator.id) throw createError('self', ErrorTypes.VALIDATION, 'You cannot warn yourself.', { expected: true });
    },
    getTargetState: async () => ({ ladder: { ...LADDER } }),
    captureLinks: async (guild, entries) => entries.map(({ url, message }) => ({ url, sourceMessageUrl: message ? url : null, excerpt: message ? 'someone: bad words' : null })),
    precedentHint: async (guildId, key, label) => (key === 'custom' ? null : `Precedent for ${label}: 3 cases`),
};

function makeEnforcement(overrides = {}) {
    const calls = [];
    const rec = (name, value) => (...args) => { calls.push({ name, args }); return typeof value === 'function' ? value(...args) : value; };
    const record = { id: 1, case_code: CODE, guild_id: GUILD, target_user_id: TARGET, target_username: 'target', type: 'ban', status: 'active', reason: 'old reason', name: 'target ban 1', moderator_username: 'mod', created_at: new Date(), duration_ms: 3600000, expires_at: new Date(Date.now() + 3600000) };
    const e = {
        memberStandings: rec('memberStandings', async () => ({ ladder: new Map([[TARGET, { level: 0, warns: 1 }]]), muted: new Set([OTHER]) })),
        getTargetState: rec('getTargetState', async (guild, id) => ({ member: guild.members.cache.get(id) || null, banned: false, muted: false, ladder: { ...LADDER }, activeBan: null, activeMute: null })),
        getLadder: rec('getLadder', async () => ({ ...LADDER })),
        getCountedWarns: rec('getCountedWarns', async () => [{ case_code: 'wrn2345', name: 'target warn 1', reason: 'Spam' }]),
        listCasesForUser: rec('listCasesForUser', async () => ({ rows: [{ ...record, reason: '<img src=x>' }], total: 1 })),
        getLatestAppealStatuses: rec('getLatestAppealStatuses', async () => new Map([[CODE, 'pending']])),
        getActiveOrdersFor: rec('getActiveOrdersFor', () => [{ id: 7, otherId: OTHER, until: Date.now() + 86400000 }]),
        listNotes: rec('listNotes', async () => [{ id: 1700000000000, content: 'note <i>', author: 'admin', timestamp: new Date().toISOString() }]),
        addNote: rec('addNote', async (g, u, content) => ({ id: 1, content })),
        removeNote: rec('removeNote', async (g, u, { id }) => (id === '1700000000000' ? { id: 1700000000000, content: 'gone' } : null)),
        precedentHint: rec('precedentHint', async () => 'Spam: 3 cases'),
        completeFlowDetails: rec('completeFlowDetails', (args) => completeFlowDetails({ ...args, deps: fakeDeps })),
        executeAction: rec('executeAction', async ({ flow }) => ({ record: flow.type === 'warn' ? { case_code: 'new2345', name: 'target warn 2' } : null, dmDelivered: true, notes: ['Warning limit reached: automatic 1d ban `ban2345` (ladder level 1).'] })),
        attachFlowEvidence: rec('attachFlowEvidence', async () => []),
        recentBanKickCount: rec('recentBanKickCount', async () => 4),
        addTempRole: rec('addTempRole', async ({ member, role, ms, auditReason }) => { if (!member.roles.cache.has(role.id)) await member.roles.add(role.id, auditReason); return new Date(Date.now() + ms); }),
        endTempRole: rec('endTempRole', async () => {}),
        listTempRoles: rec('listTempRoles', async () => []),
        getMassActionBlock: rec('getMassActionBlock', async (g, id) => (id === OTHER ? { until: new Date(Date.now() + 60000).toISOString(), count: 5 } : null)),
        getCaseByCode: rec('getCaseByCode', async (code) => (code === CODE ? { ...record } : null)),
        getAppealHistory: rec('getAppealHistory', async () => [{ id: 3, status: 'pending', created_at: new Date(), body: { reason: 'I am sorry <b>', didIt: 'yes' } }]),
        editCase: rec('editCase', async (client, { reason }) => ({ after: { ...record, reason }, changes: [{ field: 'reason', oldValue: 'old reason', newValue: reason }] })),
        voidCase: rec('voidCase', async () => ({ record: { ...record, voided_at: new Date() }, notes: ['The user was unbanned.'], dmDelivered: true })),
        addEvidence: rec('addEvidence', async () => ({ id: 11 })),
        addImageEvidence: rec('addImageEvidence', async () => ({ id: 12 })),
        removeEvidence: rec('removeEvidence', async (code, id) => (id === 11 ? { id: 11, kind: 'link', url: 'https://x.example' } : null)),
        captureLinks: rec('captureLinks', async (guild, entries) => entries.map(({ url }) => ({ url, sourceMessageUrl: null, excerpt: null }))),
        listEvidence: rec('listEvidence', async () => []),
        resolveImageUrls: rec('resolveImageUrls', async () => new Map()),
        decideAppeal: rec('decideAppeal', async ({ decision }) => ({ record, dmDelivered: true, label: decision === 'accept' ? 'accepted' : 'denied', notes: ['The user was unbanned.'] })),
        listActiveNoContactOrders: rec('listActiveNoContactOrders', async () => [{ id: 7, user_a: TARGET, user_b: OTHER, until: new Date(Date.now() + 86400000), created_by: ADMIN, reason: 'feud <b>' }]),
        addNoContactOrder: rec('addNoContactOrder', async () => ({ order: { id: 8 }, delivered: [true, true] })),
        endNoContactOrder: rec('endNoContactOrder', async (c, { id }) => (id === 7 ? { order: { id: 7 }, delivered: [true, false] } : null)),
        listMassActionBlocks: rec('listMassActionBlocks', async () => [{ moderatorId: ADMIN, until: new Date(Date.now() + 60000).toISOString(), count: 5, at: new Date().toISOString() }]),
        clearMassActionBlock: rec('clearMassActionBlock', async () => {}),
        loadCoverageCounts: rec('loadCoverageCounts', async () => ({ incidents: [{ hour: '2026-10-26T10:00:00Z', count: 4 }], staff: [{ hour: '2026-10-26T10:00:00Z', count: 1 }] })),
        getGuildConfig: rec('getGuildConfig', async () => ({ birthdayTimezone: 'UTC' })),
        isBotOwner: (id) => id === OWNER,
        ...overrides,
    };
    return { e, calls };
}

function fakeRes() {
    return {
        statusCode: 200, headers: {}, cookies: [], body: null, redirectedTo: null,
        status(code) { this.statusCode = code; return this; },
        type() { return this; },
        send(body) { this.body = body; return this; },
        set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; },
        append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
}

async function setup({ env = ENV, userId = ADMIN, admins = new Set([ADMIN]), owners = new Set([OWNER]), overrides = {}, targetInGuild = true } = {}) {
    const { guild, client } = makeWorld({ admins, targetInGuild });
    const { e, calls } = makeEnforcement(overrides);
    const sessions = createMemorySessionStore();
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: admins.has(id), isOwnerId: owners.has(id) }) });
    const auditRows = [];
    const modLog = [];
    const auditStore = {
        writeRows: async (g, actor, module, changes) => { for (const c of changes) auditRows.push({ actor, module, ...c }); return changes.length; },
        list: async () => ({ rows: [], total: 0 }), users: async () => [],
    };
    const services = { postModLog: async (c, kind, fields, options) => { modLog.push({ kind, options }); }, getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) };
    const confirms = createConfirmStore();
    const data = {
        overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) },
        getCaseByCode: e.getCaseByCode, getCaseEdits: async () => [], listEvidence: async () => [{ id: 11, kind: 'link', url: 'https://x.example', added_by_username: 'a', added_at: new Date() }],
        resolveImageUrls: async () => new Map(), getAppealHistory: async () => [],
        listPendingAppeals: async () => [{ case_code: CODE, type: 'ban', username: 'target', user_id: TARGET, created_at: new Date() }],
        staffModerationStats: async () => [],
    };
    const d = createDashboard({ client, settings: dashboardSettings(env), sessions, access, services, auditStore, env, enforcement: e, confirms, data });
    const session = await sessions.create({ userId, username: userId === OWNER ? 'owner' : 'admin' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, e, calls, sessions, session, cookie, auditRows, modLog, confirms, guild, client };
}

async function run(h, handler, req) {
    const res = fakeRes();
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (passed) await handler(req, res, () => { res.fellThrough = true; });
    return res;
}

function get(h, handler, { params = {}, query = {} } = {}) {
    return run(h, handler, { method: 'GET', params, query, headers: { cookie: h.cookie } });
}

function post(h, handler, { params = {}, form = {}, origin = ORIGIN, csrf = h.session.csrf } = {}) {
    return run(h, handler, {
        method: 'POST', params, query: {}, path: '/x',
        headers: { cookie: h.cookie, ...(origin ? { origin } : {}) },
        body: { ...(csrf === null ? {} : { csrf }), ...form },
    });
}

const serviceCalls = (h, names) => h.calls.filter((c) => names.includes(c.name));

// ── flow builder parity ───────────────────────────────────────────────────

/** The panel's steps (handleEnforcementSelect + handleEnforcementModal), with the same deps. */
async function panelFlow({ guild, moderator, targetUser, type, reasonKey, modal }) {
    const flow = startFlow({ type, moderatorId: moderator.id, targetUser });
    Object.assign(flow, reasonPatch(flow, reasonKey));
    const parsed = parseFlowInput(flow, modal);
    assert.equal(parsed.error, null);
    const { patch, error, fatal } = await completeFlowDetails({ guild, moderator, targetUser, flow, patch: parsed.patch, customName: modal.name, deps: fakeDeps });
    assert.equal(error, null);
    assert.equal(fatal, null);
    return Object.assign(flow, patch);
}

test('flow builder parity: the dashboard builds the same flow as the panel for the same inputs', async () => {
    const { guild, client } = makeWorld();
    const moderator = await guild.members.fetch({ user: ADMIN });
    const targetUser = await client.users.fetch(TARGET);
    const complete = (args) => completeFlowDetails({ ...args, deps: fakeDeps });
    const evidence = 'see https://discord.com/channels/100000000000000001/500000000000000001/700000000000000001 and https://example.com/x';

    // ban: severe prebuilt reason (unappealable by default), duration, custom name, two links
    const panelBan = await panelFlow({ guild, moderator, targetUser, type: 'ban', reasonKey: 'harassment', modal: { durationInput: '7d', unappealable: true, evidenceInput: evidence, name: 'my ban' } });
    const webBan = await buildRecordFlow({ guild, moderator, moderatorId: ADMIN, targetUser, type: 'ban', completeFlowDetails: complete, form: { reason: 'harassment', duration: '7d', unappealable: 'default', evidence, name: 'my ban' } });
    assert.deepEqual(webBan, panelBan);
    assert.equal(webBan.unappealable, true);
    assert.equal(webBan.durationMs, 7 * 86400000);
    assert.equal(webBan.evidence.length, 2);
    assert.equal(webBan.evidence[0].excerpt, 'someone: bad words');

    // warn: custom reason, default name, ladder preview and precedent (none for custom)
    const panelWarn = await panelFlow({ guild, moderator, targetUser, type: 'warn', reasonKey: 'custom', modal: { customReason: 'being rude', evidenceInput: '', name: '' } });
    const webWarn = await buildRecordFlow({ guild, moderator, moderatorId: ADMIN, targetUser, type: 'warn', completeFlowDetails: complete, form: { reason: 'custom', custom_reason: 'being rude', name: '' } });
    assert.deepEqual(webWarn, panelWarn);
    assert.deepEqual(webWarn.ladder, LADDER);
    assert.equal(webWarn.name, 'target<script> warn 1');
    assert.equal(webWarn.nameIsDefault, true);
    assert.equal(webWarn.reasonSource, 'custom');

    // mute with a prebuilt reason; ban with the appealable override
    const panelMute = await panelFlow({ guild, moderator, targetUser, type: 'mute', reasonKey: 'spam', modal: { durationInput: '1h', evidenceInput: '', name: '' } });
    const webMute = await buildRecordFlow({ guild, moderator, moderatorId: ADMIN, targetUser, type: 'mute', completeFlowDetails: complete, form: { reason: 'spam', duration: '1h' } });
    assert.deepEqual(webMute, panelMute);
    const webAppealable = await buildRecordFlow({ guild, moderator, moderatorId: ADMIN, targetUser, type: 'ban', completeFlowDetails: complete, form: { reason: 'raiding', unappealable: 'no' } });
    assert.equal(webAppealable.unappealable, false);
    assert.equal(webAppealable.durationMs, null);

    // lift actions: the same reason patch (only the "via" differs when blank)
    assert.deepEqual(liftReasonPatch({ type: 'unban' }, '  sorry  '), { reason: 'sorry' });
    assert.deepEqual(liftReasonPatch({ type: 'unmute' }, ''), { reason: 'Unmute via /enforcements' });
    assert.deepEqual(liftReasonPatch({ type: 'unmute' }, '', 'the dashboard'), { reason: 'Unmute via the dashboard' });
});

test('flow builder: the panel\'s validation messages, name clashes and hierarchy refusals', async () => {
    const { guild, client } = makeWorld();
    const moderator = await guild.members.fetch({ user: ADMIN });
    const targetUser = await client.users.fetch(TARGET);
    const flow = (type, reasonKey) => Object.assign(startFlow({ type, moderatorId: ADMIN, targetUser }), reasonPatch({ type }, reasonKey));
    assert.match(parseFlowInput(flow('warn', 'custom'), {}).error, /custom reason is required/);
    assert.match(parseFlowInput(flow('mute', 'spam'), {}).error, /mute needs a duration/);
    assert.match(parseFlowInput(flow('ban', 'spam'), { durationInput: 'soon' }).error, /not a valid duration/);
    assert.match(parseFlowInput(flow('warn', 'spam'), { evidenceInput: 'no links here' }).error, /Evidence must be links/);
    const six = Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`).join(' ');
    assert.match(parseFlowInput(flow('warn', 'spam'), { evidenceInput: six }).error, /At most 5/);
    assert.equal(reasonPatch({ type: 'ban' }, 'scamming').unappealable, true);
    assert.equal(reasonPatch({ type: 'warn' }, 'scamming').unappealable, false);

    const complete = (args) => completeFlowDetails({ ...args, deps: fakeDeps });
    await assert.rejects(buildRecordFlow({ guild, moderator, moderatorId: ADMIN, targetUser, type: 'warn', completeFlowDetails: complete, form: { reason: 'spam', name: 'taken name' } }), /already exists/);
    await assert.rejects(buildRecordFlow({ guild, moderator, moderatorId: ADMIN, targetUser, type: 'warn', completeFlowDetails: complete, form: { reason: 'nope' } }), /Choose a reason/);
    const self = await guild.members.fetch({ user: ADMIN });
    await assert.rejects(buildRecordFlow({ guild, moderator, moderatorId: ADMIN, targetUser: { id: self.id, username: 'me' }, type: 'warn', completeFlowDetails: complete, form: { reason: 'spam' } }),
        (error) => error.status === 403 && /cannot warn yourself/.test(error.message));

    const summary = flowSummary(await buildRecordFlow({ guild, moderator, moderatorId: ADMIN, targetUser, type: 'warn', completeFlowDetails: complete, form: { reason: 'spam' } }));
    assert.equal(summary.effect, 'warning 2 of 3.');
    assert.equal(summary.precedent, 'Precedent for Spam: 3 cases');
    assert.deepEqual(availableActions({ banned: false, member: {}, muted: false, ladder: LADDER }), ['ban', 'kick', 'mute', 'warn', 'removewarn']);
});

// ── confirm tokens ────────────────────────────────────────────────────────

test('confirm tokens: single use, expire after 5 minutes, bound to session + subject + flow hash', () => {
    const store = createConfirmStore();
    const payload = { type: 'warn', targetId: TARGET, reason: 'Spam' };
    const bind = { session: 'sess1', subject: `user:${TARGET}` };
    const a = store.issue({ ...bind, payload }, 1000);
    assert.equal(a.hash, flowHash(payload));
    assert.deepEqual(store.consume(a.token, { ...bind, hash: a.hash }, 2000), payload);
    assert.equal(store.consume(a.token, { ...bind, hash: a.hash }, 2000), null, 'second use refused');

    const b = store.issue({ ...bind, payload }, 1000);
    assert.equal(store.consume(b.token, { ...bind, hash: a.hash }, 1000 + 5 * 60 * 1000), null, 'expired');
    for (const wrong of [{ session: 'sess2' }, { subject: `user:${OTHER}` }, { hash: 'nothash' }]) {
        const t = store.issue({ ...bind, payload }, 1000);
        assert.equal(store.consume(t.token, { ...bind, hash: t.hash, ...wrong }, 2000), null, JSON.stringify(wrong));
        assert.equal(store.consume(t.token, { ...bind, hash: t.hash }, 2000), null, 'a refused token is gone too');
    }
    assert.equal(store.consume('', { ...bind, hash: a.hash }), null);
    assert.equal(flowHash({ a: 1, m: new Map([[1, 2]]) }), flowHash({ a: 1 }), 'Maps are left out of the hash');
});

// ── actions end to end (handlers) ─────────────────────────────────────────

async function preview(h, form, userId = TARGET) {
    return post(h, h.d.enforcement.actionPreview, { params: { id: userId }, form });
}

function tokenFrom(body) {
    return {
        token: /name="token" value="([^"]+)"/.exec(body)?.[1],
        fh: /name="fh" value="([^"]+)"/.exec(body)?.[1],
    };
}

test('warn: preview shows the ladder effect and precedent; execute runs executeAction once with a fresh admin member, audits, 303', async () => {
    const h = await setup();
    const res = await preview(h, { type: 'warn', reason: 'spam', evidence: 'https://discord.com/channels/100000000000000001/500000000000000001/700000000000000001' });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /Confirm: Warn/);
    assert.match(res.body, /warning 2 of 3\./);
    assert.match(res.body, /Precedent for Spam/);
    assert.match(res.body, /someone: bad words/);
    assert.ok(!res.body.includes('<script>'), 'target name escaped');
    assert.equal(serviceCalls(h, ['executeAction']).length, 0, 'preview runs nothing');
    const { token, fh } = tokenFrom(res.body);
    assert.ok(token && fh);

    const done = await post(h, h.d.enforcement.actionExecute, { params: { id: TARGET }, form: { token, fh } });
    assert.equal(done.statusCode, 303);
    assert.equal(done.redirectedTo, `/dashboard/users/${TARGET}`);
    const [call] = serviceCalls(h, ['executeAction']);
    assert.equal(call.args[0].moderator.id, ADMIN);
    assert.equal(call.args[0].flow.type, 'warn');
    assert.equal(call.args[0].flow.reason, 'Spam');
    assert.equal(call.args[0].flow.moderatorId, ADMIN);
    assert.equal(serviceCalls(h, ['attachFlowEvidence']).length, 1);
    assert.equal(h.auditRows.length, 1);
    assert.equal(h.auditRows[0].module, 'actions');
    assert.equal(h.auditRows[0].key, 'warn');
    assert.equal(h.auditRows[0].new.case, 'new2345');
    assert.equal(h.modLog.length, 0, 'the enforcement service posts the mod log itself');
    const session = await h.sessions.get(h.session.id);
    assert.match(session.flash, /Case new2345/);
    assert.match(session.flash, /automatic 1d ban ban2345/);

    const again = await post(h, h.d.enforcement.actionExecute, { params: { id: TARGET }, form: { token, fh } });
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /expired or was already used/);
    assert.equal(serviceCalls(h, ['executeAction']).length, 1, 'a token works once');
});

test('the confirm token is bound to the user in the URL and the session', async () => {
    const h = await setup();
    const { token, fh } = tokenFrom((await preview(h, { type: 'kick', reason: 'spam' })).body);
    const other = await post(h, h.d.enforcement.actionExecute, { params: { id: OTHER }, form: { token, fh } });
    assert.equal(other.statusCode, 400);
    assert.equal(serviceCalls(h, ['executeAction']).length, 0);

    const h2 = await setup();
    const t2 = tokenFrom((await preview(h2, { type: 'kick', reason: 'spam' })).body);
    const session2 = await h2.sessions.create({ userId: ADMIN, username: 'admin' });
    const otherSession = await run(h2, h2.d.enforcement.actionExecute, {
        method: 'POST', params: { id: TARGET }, query: {}, headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(signValue(session2.id, SECRET))}`, origin: ORIGIN },
        body: { csrf: session2.csrf, ...t2 },
    });
    assert.equal(otherSession.statusCode, 400);
    assert.equal(serviceCalls(h2, ['executeAction']).length, 0);
});

test('canAct: OWNER_IDS without Administrator get 403 on preview and execute; nothing runs', async () => {
    const admin = await setup();
    const { token, fh } = tokenFrom((await preview(admin, { type: 'warn', reason: 'spam' })).body);

    const h = await setup({ userId: OWNER });
    const page = await get(h, h.d.enforcement.userPage, { params: { id: TARGET } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /View only/);
    assert.ok(!page.body.includes('/action/preview'), 'no action forms for owners without Administrator');
    const p = await preview(h, { type: 'warn', reason: 'spam' });
    assert.equal(p.statusCode, 403);
    const x = await post(h, h.d.enforcement.actionExecute, { params: { id: TARGET }, form: { token, fh } });
    assert.equal(x.statusCode, 403);
    assert.equal(serviceCalls(h, ['executeAction', 'completeFlowDetails']).length, 0);
});

test('an administrator who lost Administrator since login is refused when the member is fetched fresh', async () => {
    const admins = new Set([ADMIN]);
    const h = await setup({ admins });
    const { token, fh } = tokenFrom((await preview(h, { type: 'warn', reason: 'spam' })).body);
    // Access is cached for 60 s, but the member is fetched fresh before executing.
    admins.delete(ADMIN);
    const res = await post(h, h.d.enforcement.actionExecute, { params: { id: TARGET }, form: { token, fh } });
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Administrator/);
    assert.equal(serviceCalls(h, ['executeAction']).length, 0);
});

test('the mass-action guard refusal is shown on the page (plain text), with no audit row', async () => {
    const until = Math.floor(Date.now() / 1000) + 600;
    const h = await setup({
        overrides: {
            executeAction: async () => {
                throw createError('blocked', ErrorTypes.PERMISSION,
                    `You are blocked from the enforcement panel until <t:${until}:t> (<t:${until}:R>) after 5 bans/kicks in a short time. The bot owners were alerted.`, { expected: true });
            },
        },
    });
    const { token, fh } = tokenFrom((await preview(h, { type: 'ban', reason: 'spam' })).body);
    const res = await post(h, h.d.enforcement.actionExecute, { params: { id: TARGET }, form: { token, fh } });
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /You are blocked from the enforcement panel until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    assert.ok(!res.body.includes('&lt;t:'), 'Discord timestamps converted');
    assert.equal(h.auditRows.length, 0);
});

test('an unexpected failure in executeAction is a 500 with a safe message', async () => {
    const h = await setup({ overrides: { executeAction: async () => { throw new Error('socket hang up'); } } });
    const { token, fh } = tokenFrom((await preview(h, { type: 'kick', reason: 'spam' })).body);
    const res = await post(h, h.d.enforcement.actionExecute, { params: { id: TARGET }, form: { token, fh } });
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /nothing may have changed/);
    assert.ok(!res.body.includes('socket hang up'));
});

test('preview validation: unknown action, unavailable action, bad input, other member\'s warning, not a snowflake', async () => {
    const h = await setup();
    assert.equal((await preview(h, { type: 'nuke' })).statusCode, 400);
    const unban = await preview(h, { type: 'unban' });
    assert.equal(unban.statusCode, 400);
    assert.match(unban.body, /not available/);
    const mute = await preview(h, { type: 'mute', reason: 'spam' });
    assert.equal(mute.statusCode, 400);
    assert.match(mute.body, /mute needs a duration/);
    assert.match(mute.body, /value="mute"/, 'the form keeps what was typed');
    const rw = await preview(h, { type: 'removewarn', warn: 'zzz2345' });
    assert.equal(rw.statusCode, 400);
    assert.match(rw.body, /counted warnings/);
    const okRw = await preview(h, { type: 'removewarn', warn: 'wrn2345', reason: '' });
    assert.equal(okRw.statusCode, 200);
    assert.match(okRw.body, /Remove warn via the dashboard/);
    assert.equal((await preview(h, { type: 'warn', reason: 'spam' }, '12345')).statusCode, 404);
    assert.equal(serviceCalls(h, ['executeAction']).length, 0);
});

// ── the POST framework on every Phase 3 form ──────────────────────────────

const POSTS = [
    { name: 'action preview', handler: 'actionPreview', params: { id: TARGET }, form: { type: 'warn', reason: 'spam' }, bad: { type: 'warn', reason: 'nope' }, service: 'completeFlowDetails', status: 200 },
    { name: 'note add', handler: 'noteAdd', params: { id: TARGET }, form: { note: 'watch them' }, bad: { note: '' }, service: 'addNote', audit: 'notes', modLog: true },
    { name: 'note remove', handler: 'noteRemove', params: { id: TARGET }, form: { note: '1700000000000' }, bad: { note: 'x' }, service: 'removeNote', audit: 'notes', modLog: true },
    { name: 'case edit', handler: 'caseEdit', params: { code: CODE }, form: { reason: 'better reason' }, bad: { reason: '', duration: 'soon' }, service: 'editCase', audit: 'cases' },
    { name: 'case void', handler: 'caseVoid', params: { code: CODE }, form: { reason: 'mistake', confirm: '1' }, bad: { reason: 'mistake' }, service: 'voidCase', audit: 'cases' },
    { name: 'evidence add', handler: 'evidenceAdd', params: { code: CODE }, form: { link: 'https://x.example/1', note: 'n' }, bad: { link: 'not a link' }, service: 'addEvidence', audit: 'cases', modLog: true },
    { name: 'evidence remove', handler: 'evidenceRemove', params: { code: CODE }, form: { id: '11' }, bad: { id: '1x' }, service: 'removeEvidence', audit: 'cases', modLog: true },
    { name: 'appeal preview', handler: 'appealPreview', params: { code: CODE }, form: { decision: 'accept', note: 'ok' }, bad: { decision: 'maybe' }, service: 'getAppealHistory', status: 200 },
    { name: 'no-contact add', handler: 'noContactAdd', params: {}, form: { user_a: TARGET, user_b: OTHER, days: '7', reason: 'feud' }, bad: { user_a: TARGET, user_b: BOTUSER, days: '7', reason: 'feud' }, service: 'addNoContactOrder', audit: 'nocontact' },
    { name: 'no-contact end', handler: 'noContactEnd', params: {}, form: { id: '7' }, bad: { id: '9' }, service: 'endNoContactOrder', audit: 'nocontact', badCallsService: true },
    { name: 'block lift', handler: 'blockLift', params: {}, form: { moderator: OTHER }, bad: { moderator: 'x' }, service: 'clearMassActionBlock', audit: 'massguard', modLog: true, owner: true },
];

for (const spec of POSTS) {
    test(`POST ${spec.name}: CSRF, Origin, edit switch, access, validation, success`, async () => {
        const userId = spec.owner ? OWNER : ADMIN;
        const mk = (opts = {}) => setup({ userId, admins: new Set([ADMIN, ...(spec.owner ? [OWNER] : [])]), ...opts });
        const call = (h, opts) => post(h, h.d.enforcement[spec.handler], { params: spec.params, form: spec.form, ...opts });
        const touched = (h) => serviceCalls(h, [spec.service, 'executeAction', 'decideAppeal']).filter((c) => c.name !== 'getAppealHistory' || spec.service === 'getAppealHistory').length;

        let h = await mk();
        assert.equal((await call(h, { csrf: null })).statusCode, 403, 'no CSRF');
        assert.equal((await call(h, { csrf: 'wrong' })).statusCode, 403, 'wrong CSRF');
        assert.equal((await call(h, { origin: 'https://evil.example' })).statusCode, 403, 'bad Origin');
        assert.equal(touched(h), 0);

        h = await mk({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
        const off = await call(h);
        assert.equal(off.statusCode, 403);
        assert.match(off.body, /Editing is off/);
        assert.equal(touched(h), 0);

        // Not allowed: an owner without Administrator for enforcement; an admin who is not an owner for the block lift.
        h = spec.owner ? await setup({ userId: ADMIN }) : await setup({ userId: OWNER });
        assert.equal((await call(h)).statusCode, 403, 'not allowed');
        assert.equal(touched(h), 0);

        h = await mk();
        const bad = await call(h, { form: spec.bad });
        assert.ok([400, 404].includes(bad.statusCode), `invalid input → 400 (got ${bad.statusCode})`);
        assert.match(bad.body, /class="error"/);
        if (!spec.badCallsService && spec.service !== 'getAppealHistory') assert.equal(serviceCalls(h, [spec.service]).length, 0, 'service not called on bad input');
        assert.equal(h.auditRows.length, 0);

        h = await mk();
        const ok = await call(h);
        assert.equal(ok.statusCode, spec.status || 303, ok.body);
        assert.ok(serviceCalls(h, [spec.service]).length >= 1, 'service called');
        if (spec.audit) {
            assert.equal(h.auditRows.length >= 1, true, 'audited');
            assert.equal(h.auditRows[0].module, spec.audit);
            assert.equal(h.auditRows[0].actor.userId, userId);
            assert.equal(h.modLog.length, spec.modLog ? 1 : 0);
            assert.ok((await h.sessions.get(h.session.id)).flash, 'flash set');
        }
    });
}

test('appeal: preview → confirm page → decide runs decideAppeal once with the fresh admin user, audits, 303', async () => {
    const h = await setup();
    const res = await post(h, h.d.enforcement.appealPreview, { params: { code: CODE }, form: { decision: 'deny', note: 'no <b>' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Confirm: deny/);
    assert.ok(res.body.includes('no &lt;b&gt;'));
    assert.equal(serviceCalls(h, ['decideAppeal']).length, 0);
    const { token, fh } = tokenFrom(res.body);
    const done = await post(h, h.d.enforcement.appealDecide, { params: { code: CODE }, form: { token, fh } });
    assert.equal(done.statusCode, 303);
    assert.equal(done.redirectedTo, '/dashboard/appeals');
    const [call] = serviceCalls(h, ['decideAppeal']);
    assert.equal(call.args[0].admin.id, ADMIN);
    assert.equal(call.args[0].decision, 'deny');
    assert.equal(call.args[0].note, 'no <b>');
    assert.equal(h.auditRows[0].module, 'appeal-decisions');
    const replay = await post(h, h.d.enforcement.appealDecide, { params: { code: CODE }, form: { token, fh } });
    assert.equal(replay.statusCode, 400);
    assert.equal(serviceCalls(h, ['decideAppeal']).length, 1);

    const owner = await setup({ userId: OWNER });
    assert.equal((await post(owner, owner.d.enforcement.appealDecide, { params: { code: CODE }, form: { token, fh } })).statusCode, 403);
    assert.equal((await post(h, h.d.enforcement.appealDecide, { params: { code: 'not a code!' }, form: { token, fh } })).statusCode, 404);
});

// ── pages ─────────────────────────────────────────────────────────────────

test('member lookup: ID redirects, names match by prefix (username, display name, nickname), max 25', async () => {
    const h = await setup();
    const byId = await get(h, h.d.enforcement.users, { query: { q: TARGET } });
    assert.equal(byId.statusCode, 302);
    assert.equal(byId.redirectedTo, `/dashboard/users/${TARGET}`);
    const unknown = await get(h, h.d.enforcement.users, { query: { q: '123456789012345678' } });
    assert.equal(unknown.statusCode, 404);
    const byName = await get(h, h.d.enforcement.users, { query: { q: 'TARG' } });
    assert.equal(byName.statusCode, 200);
    assert.ok(byName.body.includes(`/dashboard/users/${TARGET}`));
    assert.ok(!byName.body.includes('<script>'));
    // A long search in the address bar is cut, never a server error (regression from the "too long" form check).
    const long = await get(h, h.d.enforcement.users, { query: { q: 'TARG' + 'x'.repeat(200) } });
    assert.equal(long.statusCode, 200);
    assert.equal(searchMembers(h.guild, 'nick').length, 1, 'nickname');
    assert.equal(searchMembers(h.guild, 'target g').length, 1, 'display name');
    assert.equal(searchMembers(h.guild, 'zzz').length, 0);
    const many = { members: { cache: new Map(Array.from({ length: 40 }, (_, i) => [String(i), { id: String(i), user: { id: String(i), username: `bob${i}` } }])) } };
    assert.equal(searchMembers(many, 'bob').length, 25);
});

test('member page: standing, no-contact, notes, cases, actions; everything escaped, no inline styles', async () => {
    const h = await setup();
    const res = await get(h, h.d.enforcement.userPage, { params: { id: TARGET }, query: { reason: 'spam' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<header class="member-header">/, 'header: who + standing at a glance');
    assert.match(res.body, /<span class="label">Ladder level<\/span><span class="value">\d of 3<\/span>/);
    assert.match(res.body, /<details class="card section" id="s-member-cases" data-key="member-cases"><summary>/, 'case history collapsed by default');
    for (const text of ['Counted warns', '1 of 3', 'Next warning', 'Pending appeals', 'No-contact orders', 'Staff notes (1)', 'Case history (1)', 'Spam: 3 cases', '/action/preview', 'Account created', '@Member', 'cdn.discordapp.com']) {
        assert.ok(res.body.includes(text), text);
    }
    assert.ok(!res.body.includes('<img src=x>') && !res.body.includes('<i>') && !res.body.includes('<script>'));
    assert.ok(!/style=/.test(res.body) && !/<script/.test(res.body.replace(ALLOWED_SCRIPT, '')));
    assert.equal((await get(h, h.d.enforcement.userPage, { params: { id: 'abc' } })).statusCode, 404);
    assert.equal((await get(h, h.d.enforcement.userPage, { params: { id: '123456789012345678' } })).statusCode, 404);

    const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    const ro = await get(off, off.d.enforcement.userPage, { params: { id: TARGET } });
    assert.match(ro.body, /Read-only/);
    assert.ok(!ro.body.includes('/notes/add'));
});

test('case page: action forms for administrators (edit, void, evidence links); read-only for owners', async () => {
    const h = await setup();
    const res = await get(h, h.d.caseDetail, { params: { code: CODE } });
    assert.equal(res.statusCode, 200);
    for (const action of ['/edit', '/void', '/evidence/add', '/evidence/remove']) assert.ok(res.body.includes(`/dashboard/cases/${CODE}${action}`), action);
    const owner = await setup({ userId: OWNER });
    const ro = await get(owner, owner.d.caseDetail, { params: { code: CODE } });
    assert.ok(!ro.body.includes(`/cases/${CODE}/void`));
    assert.match(ro.body, /View only/);
});

test('appeals: the queue links each appeal; the detail page shows the answers and the decision form', async () => {
    const h = await setup();
    const list = await get(h, h.d.appeals);
    assert.ok(list.body.includes(`/dashboard/appeals/${CODE}`));
    const detail = await get(h, h.d.enforcement.appealDetail, { params: { code: CODE } });
    assert.equal(detail.statusCode, 200);
    assert.ok(detail.body.includes('I am sorry &lt;b&gt;'));
    assert.ok(detail.body.includes('Yes, I did it'));
    assert.ok(detail.body.includes(`/dashboard/appeals/${CODE}/preview`));
    assert.equal((await get(h, h.d.enforcement.appealDetail, { params: { code: 'zzzzzzz' } })).statusCode, 404);
});

test('staff page: coverage heatmap as a table with intensity classes and the mass-action blocks (lift for owners only)', async () => {
    const h = await setup();
    const res = await get(h, h.d.staff, { query: { coverage: '30d' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /class="heat"/);
    assert.match(res.body, /class="heat-4"/);
    assert.match(res.body, /class="heat-0"/);
    assert.match(res.body, /Mass-action guard blocks \(1\)/);
    assert.ok(!res.body.includes('/staff/blocks/lift'), 'admins who are not owners cannot lift');
    assert.ok(!/style=/.test(res.body));
    assert.equal(serviceCalls(h, ['loadCoverageCounts'])[0].args[2], 30);
    const owner = await setup({ userId: OWNER });
    assert.ok((await get(owner, owner.d.staff)).body.includes('/staff/blocks/lift'));
    const broken = await setup({ overrides: { loadCoverageCounts: async () => { throw new Error('db down'); } } });
    assert.match((await get(broken, broken.d.staff)).body, /Coverage could not be loaded/);

    const report = buildCoverageReport({ incidents: [{ hour: '2026-10-26T10:00:00Z', count: 4 }], staff: [] }, 'UTC');
    assert.equal(report.incidentGrid[0][10], 4);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => intensityLevel(n, 4)), [0, 1, 2, 3, 4, 4]);
});

test('no-contact page lists orders with end buttons and the start form', async () => {
    const h = await setup();
    const res = await get(h, h.d.enforcement.noContact);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('feud &lt;b&gt;'));
    assert.ok(res.body.includes('/dashboard/nocontact/end'));
    assert.ok(res.body.includes('/dashboard/nocontact/add'));
});

test('result message and plain text: case code, DM, notes; Discord markdown removed', () => {
    const text = resultMessage({ type: 'warn', targetUsername: 'bob' }, { record: { case_code: 'k7m2qxa', name: 'bob warn 3' }, dmDelivered: false, notes: ['⚠️ Evidence x was not saved: **full**'] });
    assert.match(text, /Warn done for bob\. Case k7m2qxa \(bob warn 3\)\. The DM could not be delivered/);
    assert.match(text, /Warning: Evidence x was not saved: full/);
    assert.equal(plainText('<@123> in <#456>'), '@123 in #456');
});

// ── evidence image upload (multipart, no dependency) ──────────────────────

const BOUNDARY = '----meowistTestBoundary7';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function multipartBody(fields, file = null) {
    const parts = Object.entries(fields).map(([name, value]) => Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    if (file) {
        parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="image"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(parts);
}

async function upload(h, { fields = {}, file = { name: 'shot.png', type: 'image/png', data: PNG }, origin = ORIGIN, csrf = h.session.csrf } = {}) {
    const res = fakeRes();
    const req = {
        method: 'POST', params: { code: CODE }, query: {}, path: '/x',
        headers: { cookie: h.cookie, ...(origin ? { origin } : {}), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        body: multipartBody({ ...(csrf === null ? {} : { csrf }), ...fields }, file),
    };
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (!passed) return res;
    let parsed = false;
    await h.d.parseUpload(req, res, () => { parsed = true; });
    if (parsed) await h.d.enforcement.evidenceUpload(req, res);
    return res;
}

test('POST evidence upload: CSRF, Origin, edit switch, access; nothing stored when refused', async () => {
    let h = await setup();
    assert.equal((await upload(h, { csrf: null })).statusCode, 403, 'no CSRF');
    assert.equal((await upload(h, { csrf: 'wrong' })).statusCode, 403, 'wrong CSRF');
    assert.equal((await upload(h, { origin: 'https://evil.example' })).statusCode, 403, 'bad Origin');
    h = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    const off = await upload(h);
    assert.equal(off.statusCode, 403);
    assert.match(off.body, /Editing is off/);
    h = await setup({ userId: OWNER });
    assert.equal((await upload(h)).statusCode, 403, 'OWNER_IDS without Administrator');
    assert.equal(serviceCalls(h, ['addImageEvidence']).length, 0);
});

test('POST evidence upload: only real images (magic bytes), size cap, one file; valid → re-hosted, audited, 303', async () => {
    let h = await setup();
    const fake = await upload(h, { file: { name: 'evil.png', type: 'image/png', data: Buffer.from('<script>alert(1)</script>') } });
    assert.equal(fake.statusCode, 400);
    assert.match(fake.body, /not a PNG, JPEG, GIF or WebP/);
    const none = await upload(h, { file: null });
    assert.equal(none.statusCode, 400);
    assert.match(none.body, /Choose an image/);
    const big = await upload(h, { file: { name: 'big.png', type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]) } });
    assert.equal(big.statusCode, 413);
    assert.equal(serviceCalls(h, ['addImageEvidence']).length, 0);
    assert.equal(h.auditRows.length, 0);

    h = await setup();
    const ok = await upload(h, { fields: { note: 'screenshot <b>' } });
    assert.equal(ok.statusCode, 303, ok.body);
    assert.equal(ok.redirectedTo, `/dashboard/cases/${CODE}`);
    const [call] = serviceCalls(h, ['addImageEvidence']);
    assert.equal(call.args[1], CODE);
    assert.ok(Buffer.isBuffer(call.args[2].data));
    assert.equal(call.args[2].name, `evidence-${CODE}.png`, 'the file name is ours, not the uploaded one');
    assert.equal(call.args[2].contentType, 'image/png');
    assert.equal(call.args[3].note, 'screenshot <b>');
    assert.equal(call.args[3].addedBy.id, ADMIN);
    assert.equal(h.auditRows[0].module, 'cases');
    assert.equal(h.modLog.length, 1);
    assert.match((await h.sessions.get(h.session.id)).flash, /Image evidence #12 added/);
});

test('multipart parser and image sniffing', async () => {
    const { parseMultipart, sniffImage, boundaryOf, MultipartError } = await import('../src/services/dashboard/multipart.js');
    const type = `multipart/form-data; boundary=${BOUNDARY}`;
    assert.equal(boundaryOf(type), BOUNDARY);
    assert.equal(boundaryOf('multipart/form-data; boundary="q u"'), 'q u');
    assert.equal(boundaryOf('application/json'), null);
    const parsed = parseMultipart(multipartBody({ csrf: 't', note: 'n' }, { name: 'a.png', type: 'image/png', data: PNG }), type);
    assert.deepEqual(parsed.fields, { csrf: 't', note: 'n' });
    assert.equal(parsed.file.data.length, PNG.length);
    assert.throws(() => parseMultipart(Buffer.from('garbage'), type), MultipartError);
    assert.throws(() => parseMultipart(multipartBody({ a: '1' }).subarray(0, 30), type), /truncated|Malformed/);
    const many = multipartBody(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'x'])));
    assert.throws(() => parseMultipart(many, type), /Too many fields/);
    const two = Buffer.concat([multipartBody({}, { name: 'a.png', type: 'image/png', data: PNG }).subarray(0, -(BOUNDARY.length + 6)),
        multipartBody({}, { name: 'b.png', type: 'image/png', data: PNG })]);
    assert.throws(() => parseMultipart(two, type), /one image at a time/);
    assert.throws(() => parseMultipart(multipartBody({}), 'text/plain'), /multipart\/form-data/);
    assert.deepEqual(sniffImage(PNG), { type: 'image/png', ext: 'png' });
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])).type, 'image/jpeg');
    assert.equal(sniffImage(Buffer.from('GIF89a......')).type, 'image/gif');
    assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')).type, 'image/webp');
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'SVG is refused (scripts)');
    assert.equal(sniffImage(Buffer.from('%PDF-1.7')), null);
});

test('uploadBody: a body over the limit is a plain 413 page (real Express, no stack trace)', async () => {
    const express = (await import('express')).default;
    const { uploadBody } = await import('../src/services/dashboard/routes.js');
    const app = express();
    app.post('/u', uploadBody(1000), (req, res) => res.status(200).send(`ok ${req.body.length}`));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const url = `http://127.0.0.1:${server.address().port}/u`;
        const headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
        const small = await fetch(url, { method: 'POST', headers, body: multipartBody({ a: '1' }) });
        assert.equal(small.status, 200);
        const big = await fetch(url, { method: 'POST', headers, body: Buffer.alloc(5000, 65) });
        assert.equal(big.status, 413);
        const text = await big.text();
        assert.match(text, /larger than 8 MB/);
        assert.ok(!/at .*\.js:\d+/.test(text), 'no stack trace');
    } finally {
        server.close();
    }
});

test('case page: the image upload form is multipart with the CSRF token (administrators)', async () => {
    const h = await setup();
    const res = await get(h, h.d.caseDetail, { params: { code: CODE } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, new RegExp(`<form method="post" action="/dashboard/cases/${CODE}/evidence/upload" class="settings-form" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${h.session.csrf}">`));
    assert.match(res.body, /accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
});

// ── member page: roles, nickname, timeout ─────────────────────────────────

test('member page: give and take roles; Discord gets the change with the moderator in the audit reason; audit + mod log', async () => {
    const h = await setup();
    const add = await post(h, h.d.enforcement.roleAdd, { params: { id: TARGET }, form: { roleId: '600000000000000002', reason: 'event helper' } });
    assert.equal(add.statusCode, 303);
    assert.equal(add.redirectedTo, `/dashboard/users/${TARGET}`);
    assert.deepEqual(h.guild.memberCalls.at(-1), { id: TARGET, call: 'roles.add', roleId: '600000000000000002', reason: 'Dashboard (admin): event helper' });
    assert.equal(h.auditRows.at(-1).key, `role:${TARGET}`);
    assert.equal(h.auditRows.at(-1).new, '@Helper');
    assert.equal(h.modLog.length, 1);
    const remove = await post(h, h.d.enforcement.roleRemove, { params: { id: TARGET }, form: { roleId: '600000000000000001' } });
    assert.equal(remove.statusCode, 303);
    assert.equal(h.guild.memberCalls.at(-1).call, 'roles.remove');
});

test('member page: role changes are refused for staff roles, roles at or above you or the bot, roles they already have, and protected targets', async () => {
    const h = await setup();
    const refused = async (handler, params, form, message) => {
        const before = h.guild.memberCalls.length;
        const res = await post(h, handler, { params, form });
        assert.equal(res.statusCode, 400, message.source);
        assert.match(res.body, message);
        assert.equal(h.guild.memberCalls.length, before, 'nothing reached Discord');
    };
    await refused(h.d.enforcement.roleAdd, { id: TARGET }, { roleId: '600000000000000009' }, /staff permissions \(BanMembers\)/);
    await refused(h.d.enforcement.roleAdd, { id: TARGET }, { roleId: '600000000000000008' }, /not below your highest role/);
    await refused(h.d.enforcement.roleAdd, { id: TARGET }, { roleId: GUILD }, /@everyone/);
    await refused(h.d.enforcement.roleAdd, { id: TARGET }, { roleId: '600000000000000001' }, /already has @Member/);
    await refused(h.d.enforcement.roleRemove, { id: TARGET }, { roleId: '600000000000000002' }, /does not have @Helper/);
    await refused(h.d.enforcement.roleAdd, { id: ADMIN }, { roleId: '600000000000000002' }, /your own roles/);
    await refused(h.d.enforcement.timeout, { id: TARGET }, { duration: '3y' }, /Choose a timeout length/);
    // Owners (OWNER_IDS) are above the hierarchy here and may hand out staff roles.
    const o = await setup({ userId: OWNER });
    const res = await post(o, o.d.enforcement.roleAdd, { params: { id: TARGET }, form: { roleId: '600000000000000009' } });
    assert.equal(res.statusCode, 403, 'OWNER_IDS without Administrator cannot act at all (canAct)');
});

test('member page: nickname and timeout reach Discord; removing a timeout that is not there is refused', async () => {
    const h = await setup();
    const nick = await post(h, h.d.enforcement.nickname, { params: { id: TARGET }, form: { nickname: 'Calm cat' } });
    assert.equal(nick.statusCode, 303);
    assert.deepEqual(h.guild.memberCalls.at(-1), { id: TARGET, call: 'setNickname', nick: 'Calm cat', reason: 'Dashboard (admin)' });
    const out = await post(h, h.d.enforcement.timeout, { params: { id: TARGET }, form: { duration: '1h', reason: 'cool down' } });
    assert.equal(out.statusCode, 303);
    assert.deepEqual(h.guild.memberCalls.at(-1), { id: TARGET, call: 'timeout', ms: 3_600_000, reason: 'Dashboard (admin): cool down' });
    const off = await post(h, h.d.enforcement.timeout, { params: { id: TARGET }, form: { duration: 'off' } });
    assert.equal(off.statusCode, 400);
    assert.match(off.body, /is not timed out/);
});

test('member page: the roles section shows Remove only where allowed and a picker without staff / higher / owned roles', async () => {
    const h = await setup();
    const page = await get(h, h.d.enforcement.userPage, { params: { id: TARGET } });
    assert.equal(page.statusCode, 200);
    const section = page.body.slice(page.body.indexOf('id="s-member-roles"'));
    assert.match(section, /<option value="600000000000000002">@Helper<\/option>/);
    assert.ok(!section.includes('value="600000000000000009"'), 'staff role not offered');
    assert.ok(!section.includes('value="600000000000000008"'), 'role above the moderator not offered');
    assert.ok(section.includes('action="/dashboard/users/' + TARGET + '/roles/remove"'), 'Member can be removed');
    assert.ok(section.includes('action="/dashboard/users/' + TARGET + '/timeout"'));
});

test('member page: a timed role is stored with its end time, shown on the chip, and ended when taken off; unknown lengths are refused', async () => {
    const h = await setup();
    const add = await post(h, h.d.enforcement.roleAdd, { params: { id: TARGET }, form: { roleId: '600000000000000002', for: '7d', reason: 'event' } });
    assert.equal(add.statusCode, 303);
    const [call] = serviceCalls(h, ['addTempRole']);
    assert.equal(call.args[0].ms, 7 * 86_400_000);
    assert.equal(call.args[0].role.id, '600000000000000002');
    assert.deepEqual(call.args[0].by, { id: ADMIN, username: 'admin' });
    assert.equal(call.args[0].auditReason, 'Dashboard (admin): event');
    assert.deepEqual(h.guild.memberCalls.at(-1), { id: TARGET, call: 'roles.add', roleId: '600000000000000002', reason: 'Dashboard (admin): event' });
    assert.equal(h.auditRows.at(-1).new, '@Helper for 7 days');
    // A length on a role they already have sets an end time instead of being refused.
    const again = await post(h, h.d.enforcement.roleAdd, { params: { id: TARGET }, form: { roleId: '600000000000000001', for: '1d' } });
    assert.equal(again.statusCode, 303);
    assert.equal(serviceCalls(h, ['addTempRole']).length, 2);
    const bad = await post(h, h.d.enforcement.roleAdd, { params: { id: TARGET }, form: { roleId: '600000000000000002', for: '9y' } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /Choose how long/);
    const remove = await post(h, h.d.enforcement.roleRemove, { params: { id: TARGET }, form: { roleId: '600000000000000001' } });
    assert.equal(remove.statusCode, 303);
    assert.deepEqual(serviceCalls(h, ['endTempRole']).at(-1).args, [GUILD, TARGET, '600000000000000001']);
    const t = await setup({ overrides: { listTempRoles: async () => [{ role_id: '600000000000000001', expires_at: new Date('2030-01-02T03:04:00Z') }] } });
    const page = await get(t, t.d.enforcement.userPage, { params: { id: TARGET } });
    const section = page.body.slice(page.body.indexOf('id="s-member-roles"'));
    assert.match(section, /@Member <span class="muted">until [^<]*2030/);
    assert.match(section, /<select name="for"><option value="">Permanently<\/option>/);
});

test('bulk: a timed role-add says the length on the preview and stores each member through addTempRole', async () => {
    const h = await setup();
    const preview = await post(h, h.d.enforcement.bulkPreview, { form: { scope: 'selected', ids: [TARGET, OTHER], action: 'role-add', roleId: '600000000000000002', for: '3d' } });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.body, /Give @Helper to 2 members for 3 days/);
    const token = preview.body.match(/name="token" value="([^"]+)"/)[1];
    const fh = preview.body.match(/name="fh" value="([^"]+)"/)[1];
    const run = await post(h, h.d.enforcement.bulkExecute, { form: { token, fh } });
    const done = await waitForJob(h, run.redirectedTo);
    assert.match(done.body, /for 3 days/);
    assert.deepEqual(serviceCalls(h, ['addTempRole']).map((c) => c.args[0].ms), [3 * 86_400_000, 3 * 86_400_000]);
    const bad = await post(h, h.d.enforcement.bulkPreview, { form: { scope: 'selected', ids: [TARGET], action: 'role-add', roleId: '600000000000000002', for: 'x' } });
    assert.equal(bad.statusCode, 400);
});

test('member page: an admin who lost Administrator since login cannot change roles, nickname or timeout (fresh check)', async () => {
    const admins = new Set([ADMIN]);
    const h = await setup({ admins });
    assert.equal((await get(h, h.d.enforcement.userPage, { params: { id: TARGET } })).statusCode, 200); // access is now cached for 60 s
    admins.delete(ADMIN); // the access check on the request is cached; the member fetch is not
    for (const [handler, form] of [[h.d.enforcement.roleAdd, { roleId: '600000000000000002' }], [h.d.enforcement.nickname, { nickname: 'x' }], [h.d.enforcement.timeout, { duration: '1h' }]]) {
        const res = await post(h, handler, { params: { id: TARGET }, form });
        assert.equal(res.statusCode, 403);
        assert.match(res.body, /Administrator/);
    }
    assert.equal(h.guild.memberCalls.length, 0, 'nothing reached Discord');
});

// ── bulk actions ──────────────────────────────────────────────────────────

const waitForJob = async (h, location) => {
    const job = location.split('/').pop();
    for (let i = 0; i < 50; i += 1) {
        const page = await get(h, h.d.enforcement.bulkJob, { params: { job } });
        if (/Finished:/.test(page.body)) return page;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('bulk job did not finish');
};

test('bulk: preview lists who changes and who is skipped (with why); run needs the one-time token; progress page; audit + mod log', async () => {
    const h = await setup();
    const preview = await post(h, h.d.enforcement.bulkPreview, { form: { scope: 'selected', ids: [TARGET, OTHER, ADMIN], action: 'role-add', roleId: '600000000000000002', reason: 'event' } });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.body, /Give a role @Helper: 2 members/);
    assert.match(preview.body, /Skipped \(1\)/);
    assert.match(preview.body, /your own roles/, 'yourself is skipped with the reason');
    assert.equal(h.guild.memberCalls.length, 0, 'nothing changed at the preview');
    const token = preview.body.match(/name="token" value="([^"]+)"/)[1];
    const fh = preview.body.match(/name="fh" value="([^"]+)"/)[1];
    const run = await post(h, h.d.enforcement.bulkExecute, { form: { token, fh } });
    assert.equal(run.statusCode, 303);
    assert.match(run.redirectedTo, /^\/dashboard\/users\/bulk\/[0-9a-f-]{36}$/);
    const done = await waitForJob(h, run.redirectedTo);
    assert.match(done.body, /Finished: 2 done, 0 failed/);
    assert.deepEqual(h.guild.memberCalls.map((c) => [c.id, c.call, c.roleId]).sort(), [[OTHER, 'roles.add', '600000000000000002'], [TARGET, 'roles.add', '600000000000000002']].sort());
    assert.equal(h.auditRows.at(-1).key, 'bulk:role-add');
    assert.match(h.auditRows.at(-1).new, /2 done, 0 failed/);
    const again = await post(h, h.d.enforcement.bulkExecute, { form: { token, fh } });
    assert.equal(again.statusCode, 400, 'the token works once');
});

test('bulk: a job stops for the remaining members once the moderator loses Administrator', async () => {
    const admins = new Set([ADMIN]);
    const h = await setup({ admins });
    const preview = await post(h, h.d.enforcement.bulkPreview, { form: { scope: 'selected', ids: [TARGET, OTHER], action: 'role-add', roleId: '600000000000000002' } });
    const token = preview.body.match(/name="token" value="([^"]+)"/)[1];
    const fh = preview.body.match(/name="fh" value="([^"]+)"/)[1];
    // The first member that is changed takes the moderator's Administrator away.
    for (const id of [TARGET, OTHER]) {
        const member = h.guild.members.cache.get(id);
        const add = member.roles.add;
        member.roles.add = async (...args) => { admins.delete(ADMIN); return add(...args); };
    }
    const run = await post(h, h.d.enforcement.bulkExecute, { form: { token, fh } });
    const done = await waitForJob(h, run.redirectedTo);
    assert.match(done.body, /Finished: 1 done, 1 failed/);
    assert.match(done.body, /Administrator/);
    assert.equal(h.guild.memberCalls.filter((c) => c.call === 'roles.add').length, 1);
});

test('bulk: kicks/bans stop at the mass-action guard (4 of 5 used → 1 planned), each through executeAction', async () => {
    const h = await setup();
    const preview = await post(h, h.d.enforcement.bulkPreview, { form: { scope: 'selected', ids: [TARGET, OTHER], action: 'kick', reasonKey: 'spam' } });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.body, /Kick: 1 member/);
    assert.match(preview.body, /mass-action guard: no more bans\/kicks/);
    assert.match(preview.body, /allows 1 more ban\/kick/);
    const token = preview.body.match(/name="token" value="([^"]+)"/)[1];
    const fh = preview.body.match(/name="fh" value="([^"]+)"/)[1];
    const run = await post(h, h.d.enforcement.bulkExecute, { form: { token, fh } });
    await waitForJob(h, run.redirectedTo);
    const kicks = h.calls.filter((c) => c.name === 'executeAction');
    assert.equal(kicks.length, 1);
    assert.equal(kicks[0].args[0].flow.type, 'kick');
});

test('bulk: refused without a choice, without ticks, and above the limit; another session cannot see the job', async () => {
    const h = await setup();
    const noAction = await post(h, h.d.enforcement.bulkPreview, { form: { scope: 'selected', ids: [TARGET] } });
    assert.equal(noAction.statusCode, 400);
    const noTicks = await post(h, h.d.enforcement.bulkPreview, { form: { scope: 'selected', action: 'timeout', timeout: '1h' } });
    assert.match(noTicks.body, /Tick at least one member/);
    const tooMany = await post(h, h.d.enforcement.bulkPreview, { form: { scope: 'selected', action: 'timeout', timeout: '1h', ids: Array.from({ length: 101 }, (_, i) => `30000000000000${String(1000 + i)}`) } });
    assert.match(tooMany.body, /at most 100 members/);
    const unknown = await get(h, h.d.enforcement.bulkJob, { params: { job: '00000000-0000-0000-0000-000000000000' } });
    assert.equal(unknown.statusCode, 404);
});
