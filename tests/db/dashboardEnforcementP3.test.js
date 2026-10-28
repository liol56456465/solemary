// Dashboard Phase 3 against the local test database (npm run test:db): a full warn
// through the dashboard path (preview → confirm token → executeAction with the real
// enforcement service, ladder, case, DM, audit row), a third warn that triggers the
// automatic ladder ban, and an appeal accepted through decideAppeal.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, routes, security, access, store;
const runId = String(Date.now()).slice(-9);
// Not the main guild of the bot config, so mod-log posts and role syncs are no-ops.
const guildId = `9${runId}00000007`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
const ADMIN = user(1);
const BOT_ID = `5${runId}00000009`;
const ORIGIN = 'https://bot.example';
const SECRET = 'z'.repeat(64);
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
let seq = Number(runId) * 11;
const code = () => { let out = ''; let x = (seq += 17); for (let i = 0; i < 7; i += 1) { out += ALPHA[x % ALPHA.length]; x = Math.floor(x / ALPHA.length); } return out; };

function fakeWorld() {
    const dms = [];
    const bans = [];
    const unbans = [];
    const guild = { id: guildId, ownerId: user(99), name: 'Test guild' };
    const role = (name, position) => ({ id: `7${runId}${String(position).padStart(8, '0')}`, name, position });
    const member = (id, position, admin = false) => ({
        id, guild, nickname: null, joinedAt: new Date(),
        user: { id, username: `user${id.slice(-3)}`, tag: `user${id.slice(-3)}` },
        permissions: { has: (flag) => admin && flag === PermissionFlagsBits.Administrator },
        roles: { highest: role(admin ? 'Admin' : 'Member', position), cache: new Map() },
    });
    const members = new Map();
    const channel = { id: '1', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) };
    guild.members = {
        me: { id: BOT_ID, guild, permissions: { has: () => true }, roles: { highest: role('Bot', 100) } },
        cache: members,
        fetch: async (arg) => {
            const id = typeof arg === 'string' ? arg : arg?.user;
            return members.get(id) || null;
        },
        ban: async (id) => { bans.push(id); members.delete(id); },
        unban: async (id) => { unbans.push(id); },
    };
    guild.bans = { fetch: async () => null };
    guild.roles = { cache: new Map(), fetch: async () => null };
    guild.channels = { cache: new Map(), fetch: async () => null };
    guild.rulesChannel = channel;
    guild.systemChannel = null;
    guild.invites = { create: async () => ({ url: 'https://discord.gg/abc' }) };
    const client = {
        db,
        user: { id: BOT_ID, username: 'bot' },
        isReady: () => true,
        guilds: { cache: new Map([[guildId, guild]]), fetch: async () => null },
        users: {
            cache: new Map(),
            fetch: async (id) => ({
                id, username: `user${id.slice(-3)}`, createdAt: new Date('2020-01-01'), bot: false,
                displayAvatarURL: () => null,
                send: async ({ content }) => { dms.push([id, content]); },
            }),
        },
    };
    guild.client = client;
    members.set(ADMIN, member(ADMIN, 50, true));
    return { guild, client, dms, bans, unbans, addMember: (id) => members.set(id, member(id, 1)) };
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    routes = await import('../../src/services/dashboard/routes.js');
    security = await import('../../src/services/dashboard/security.js');
    access = await import('../../src/services/dashboard/access.js');
    store = await import('../../src/services/dashboard/sessionStore.js');
});

after(async () => {
    if (skip) return;
    const { rows } = await pgDb.pool.query('SELECT case_code FROM mod_cases WHERE guild_id = $1', [guildId]);
    const codes = rows.map((r) => r.case_code);
    await pgDb.pool.query('DELETE FROM mod_case_evidence WHERE case_code = ANY($1)', [codes]).catch(() => {});
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM mod_ladder WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM dashboard_audit WHERE guild_id = $1', [guildId]);
    await pgDb.disconnect();
});

function fakeRes() {
    return {
        statusCode: 200, headers: {}, body: null, redirectedTo: null,
        status(c) { this.statusCode = c; return this; }, type() { return this; }, send(b) { this.body = b; return this; },
        set(n, v) { if (typeof n === 'object') Object.assign(this.headers, n); else this.headers[n] = v; return this; },
        append() { return this; }, redirect(c, u) { this.statusCode = c; this.redirectedTo = u; return this; },
    };
}

async function dashboardFor(world) {
    const env = {
        DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
        DISCORD_CLIENT_SECRET: 'x', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: guildId, NODE_ENV: 'test',
    };
    const sessions = store.createMemorySessionStore();
    const checker = access.createAccessChecker(world.client, { facts: async () => ({ inGuild: true, isAdmin: true, isOwnerId: false }) });
    const d = routes.createDashboard({
        client: world.client, settings: routes.dashboardSettings(env), sessions, access: checker, env,
        services: { postModLog: async () => {}, getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) },
        data: { overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) } },
    });
    const session = await sessions.create({ userId: ADMIN, username: 'admin' });
    const cookie = `${security.SESSION_COOKIE}=${encodeURIComponent(security.signValue(session.id, SECRET))}`;
    const call = async (handler, params, form) => {
        const req = { method: 'POST', path: '/x', params, query: {}, headers: { cookie, origin: ORIGIN }, body: { csrf: session.csrf, ...form } };
        const res = fakeRes();
        let ok = false;
        await d.requireUser(req, res, () => { ok = true; });
        if (ok) await handler(req, res, () => {});
        return res;
    };
    const tokens = (body) => ({ token: /name="token" value="([^"]+)"/.exec(body)?.[1], fh: /name="fh" value="([^"]+)"/.exec(body)?.[1] });
    return { d, sessions, session, call, tokens };
}

test('a warn from the dashboard: preview → confirm → the real enforcement service records the case, ladder, DM and audit', { skip }, async () => {
    const world = fakeWorld();
    const target = user(10);
    world.addMember(target);
    const { d, sessions, session, call, tokens } = await dashboardFor(world);

    const preview = await call(d.enforcement.actionPreview, { id: target }, { type: 'warn', reason: 'spam', name: '' });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.match(preview.body, /warning 1 of 3\./);
    const { token, fh } = tokens(preview.body);

    const done = await call(d.enforcement.actionExecute, { id: target }, { token, fh });
    assert.equal(done.statusCode, 303, done.body);

    const { rows: [warn] } = await pgDb.pool.query('SELECT * FROM mod_cases WHERE guild_id = $1 AND target_user_id = $2', [guildId, target]);
    assert.equal(warn.type, 'warn');
    assert.equal(warn.reason, 'Spam');
    assert.equal(warn.reason_key, 'spam');
    assert.equal(warn.moderator_id, ADMIN);
    assert.equal(warn.dm_delivered, true);
    assert.equal(warn.name, `user${target.slice(-3)} warn 1`);
    const { rows: [ladder] } = await pgDb.pool.query('SELECT level, warns_since_level FROM mod_ladder WHERE guild_id = $1 AND user_id = $2', [guildId, target]);
    assert.deepEqual({ ...ladder }, { level: 0, warns_since_level: 1 });
    assert.equal(world.dms.filter(([id]) => id === target).length, 1);
    const { rows: audit } = await pgDb.pool.query('SELECT module, key, user_id, new FROM dashboard_audit WHERE guild_id = $1 AND module = $2', [guildId, 'actions']);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].user_id, ADMIN);
    assert.equal(audit[0].new.case, warn.case_code);
    assert.match((await sessions.get(session.id)).flash, new RegExp(`Case ${warn.case_code}`));

    // The token is gone: a replay does nothing.
    const replay = await call(d.enforcement.actionExecute, { id: target }, { token, fh });
    assert.equal(replay.statusCode, 400);
    const { rows: [{ count }] } = await pgDb.pool.query('SELECT COUNT(*)::int AS count FROM mod_cases WHERE guild_id = $1 AND target_user_id = $2', [guildId, target]);
    assert.equal(count, 1);
});

test('the third warn from the dashboard triggers the automatic ladder ban, like the panel', { skip }, async () => {
    const world = fakeWorld();
    const target = user(20);
    world.addMember(target);
    await pgDb.pool.query('INSERT INTO mod_ladder (guild_id, user_id, level, warns_since_level) VALUES ($1, $2, 0, 2)', [guildId, target]);
    const { d, sessions, session, call, tokens } = await dashboardFor(world);

    const preview = await call(d.enforcement.actionPreview, { id: target }, { type: 'warn', reason: 'custom', custom_reason: 'third strike' });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.match(preview.body, /reaches the warning limit/);
    const done = await call(d.enforcement.actionExecute, { id: target }, tokens(preview.body));
    assert.equal(done.statusCode, 303, done.body);

    const { rows } = await pgDb.pool.query('SELECT type, is_auto, reason FROM mod_cases WHERE guild_id = $1 AND target_user_id = $2 ORDER BY id', [guildId, target]);
    assert.deepEqual(rows.map((r) => [r.type, r.is_auto]), [['warn', false], ['ban', true]]);
    assert.equal(rows[0].reason, 'third strike');
    assert.deepEqual(world.bans, [target]);
    assert.match((await sessions.get(session.id)).flash, /Warning limit reached: automatic/);
});

test('an appeal accepted from the dashboard goes through decideAppeal: warn lifted, ladder down, DM, audit', { skip }, async () => {
    const world = fakeWorld();
    const target = user(30);
    world.addMember(target);
    const caseCode = code();
    await pgDb.pool.query('INSERT INTO mod_ladder (guild_id, user_id, level, warns_since_level) VALUES ($1, $2, 0, 1)', [guildId, target]);
    await pgDb.pool.query(
        `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason,
            prebuilt_or_custom, status, counts_toward_level, ladder_level_after)
         VALUES ($1, $2, $3, 'target', $4, 'admin', 'warn', $5, 'Spam', 'prebuilt', 'appeal_pending', 0, 0)`,
        [guildId, caseCode, target, ADMIN, `${caseCode} name`]);
    await pgDb.pool.query(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, body) VALUES ('appeal', $1, $2, 'target', $3, $4)`,
        [caseCode, target, guildId, JSON.stringify({ reason: 'It was a joke between friends, sorry.', didIt: 'partly' })]);
    const { d, call, tokens } = await dashboardFor(world);

    const preview = await call(d.enforcement.appealPreview, { code: caseCode }, { decision: 'accept', note: 'fair enough' });
    assert.equal(preview.statusCode, 200, preview.body);
    const done = await call(d.enforcement.appealDecide, { code: caseCode }, tokens(preview.body));
    assert.equal(done.statusCode, 303, done.body);

    const { rows: [record] } = await pgDb.pool.query('SELECT status, revoke_reason FROM mod_cases WHERE case_code = $1', [caseCode]);
    assert.equal(record.status, 'revoked');
    assert.match(record.revoke_reason, /Appeal accepted by user/);
    const { rows: [appeal] } = await pgDb.pool.query('SELECT status, decided_by, note FROM mod_appeals WHERE case_code = $1', [caseCode]);
    assert.deepEqual({ ...appeal }, { status: 'accepted', decided_by: ADMIN, note: 'fair enough' });
    const { rows: [ladder] } = await pgDb.pool.query('SELECT warns_since_level FROM mod_ladder WHERE guild_id = $1 AND user_id = $2', [guildId, target]);
    assert.equal(ladder.warns_since_level, 0);
    assert.equal(world.dms.filter(([id]) => id === target).length, 1);
    const { rows: audit } = await pgDb.pool.query('SELECT key, new FROM dashboard_audit WHERE guild_id = $1 AND module = $2', [guildId, 'appeal-decisions']);
    assert.equal(audit[0].key, caseCode);
    assert.equal(audit[0].new.decision, 'accepted');
});
