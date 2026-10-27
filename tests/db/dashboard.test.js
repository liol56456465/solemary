// Dashboard against the local test database: the real case search, case detail,
// appeals, automod and stats services behind the route handlers, and the Postgres
// session store (create, read, rotate, expire, logout).
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, routes, security, access, store;
const runId = String(Date.now()).slice(-9);
const guildId = `8${runId}00000003`;
const target = `6${runId}00000011`;
const admin = `6${runId}00000012`;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
let n = Number(runId) * 7;
const code = () => { let out = ''; let x = (n += 13); for (let i = 0; i < 7; i += 1) { out += ALPHA[x % ALPHA.length]; x = Math.floor(x / ALPHA.length); } return out; };
const codes = [];

async function insertCase(fields) {
    const row = {
        guild_id: guildId, case_code: code(), target_user_id: target, target_username: '<b>target</b>',
        moderator_id: admin, moderator_username: 'mod', type: 'warn', reason: 'Automod: Spam', reason_key: 'automod:spam',
        prebuilt_or_custom: 'prebuilt', ...fields,
    };
    row.name ??= `${row.case_code}-name`;
    codes.push(row.case_code);
    const keys = Object.keys(row);
    const { rows } = await pgDb.pool.query(
        `INSERT INTO mod_cases (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        keys.map((k) => row[k]),
    );
    return rows[0];
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
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM dashboard_sessions WHERE user_id = $1', [admin]);
    await pgDb.disconnect();
});

function fakeRes() {
    return {
        statusCode: 200, headers: {}, cookies: [], body: null,
        status(c) { this.statusCode = c; return this; }, type() { return this; }, send(b) { this.body = b; return this; },
        set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; },
        append(k, v) { this.cookies.push(v); return this; }, redirect(c, u) { this.statusCode = c; this.redirectedTo = u; return this; },
    };
}

test('dashboard pages render real data', { skip }, async () => {
    const warn = await insertCase({});
    await insertCase({ type: 'mute', duration_ms: 3600000, status: 'revoked', revoke_reason: 'Automod decision reversed by x' });
    await pgDb.pool.query(
        `INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, created_at) VALUES ('appeal', $1, $2, 'target', $3, NOW() - INTERVAL '2 days')`,
        [warn.case_code, target, guildId],
    );

    const settings = routes.dashboardSettings({
        DASHBOARD_ENABLED: 'true', SESSION_SECRET: 's'.repeat(40), CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'x',
        PUBLIC_URL: 'http://127.0.0.1:3100', MAIN_GUILD_ID: guildId,
    });
    assert.equal(settings.enabled, true);
    const { query } = await import('../../src/services/enforcement/db.js');
    const sessions = store.createPgSessionStore({ query });
    const session = await sessions.create({ userId: admin, username: 'admin' });
    const checker = access.createAccessChecker({}, { facts: async () => ({ inGuild: true, isAdmin: true }) });
    const d = routes.createDashboard({ client: { user: { id: '1' }, channels: { cache: new Map() } }, settings, access: checker, sessions });
    const cookie = `${security.SESSION_COOKIE}=${encodeURIComponent(security.signValue(session.id, settings.sessionSecret))}`;
    const run = async (handler, req) => {
        const res = fakeRes();
        let ok = false;
        const full = { method: 'GET', headers: { cookie }, query: {}, params: {}, ...req };
        await d.requireUser(full, res, () => { ok = true; });
        if (ok) await handler(full, res);
        return res;
    };

    const list = await run(d.cases, { query: { member: target } });
    assert.equal(list.statusCode, 200);
    assert.match(list.body, new RegExp(warn.case_code));
    assert.match(list.body, /&lt;b&gt;target&lt;\/b&gt;/);
    assert.match(list.body, /appeal pending|active/);

    const revoked = await run(d.cases, { query: { member: target, status: 'revoked' } });
    assert.match(revoked.body, /Page 1 of 1 · 1 case</);

    const detail = await run(d.caseDetail, { params: { code: warn.case_code } });
    assert.equal(detail.statusCode, 200);
    assert.match(detail.body, /Appeals \(1\)/);

    // An appeal on another server's case is not listed (listPendingAppeals filters by guild).
    const otherGuild = `8${runId}00000099`;
    const foreign = await insertCase({ guild_id: otherGuild });
    await pgDb.pool.query(
        `INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id) VALUES ('appeal', $1, $2, 'target', $3)`,
        [foreign.case_code, target, otherGuild],
    );
    const appeals = await run(d.appeals, {});
    assert.ok(!appeals.body.includes(foreign.case_code), 'other guild appeal hidden');
    assert.equal(appeals.statusCode, 200);
    assert.match(appeals.body, new RegExp(warn.case_code));
    assert.match(appeals.body, /2 d|4\d h/);

    const automod = await run(d.modulePage, { params: { module: 'automod' } });
    assert.equal(automod.statusCode, 200);
    assert.match(automod.body, /Spam/);
    assert.match(automod.body, /50%/);

    const stats = await run(d.staff, { query: { period: '7d' } });
    assert.equal(stats.statusCode, 200);
    assert.match(stats.body, /mod/);
});

test('Postgres session store: create, read, rotate, expire, logout, lazy cleanup', { skip }, async () => {
    const { query } = await import('../../src/services/enforcement/db.js');
    const sessions = store.createPgSessionStore({ query, ttlMs: 60 * 60 * 1000 });
    const now = Date.now();
    const s1 = await sessions.create({ userId: admin, username: 'admin', avatar: 'abc' }, now);
    const { rows } = await pgDb.pool.query('SELECT * FROM dashboard_sessions WHERE user_id = $1', [admin]);
    assert.ok(rows.some((r) => r.id_hash === store.hashSessionId(s1.id)));
    assert.ok(!rows.some((r) => r.id_hash === s1.id), 'raw id never stored');
    const read = await sessions.get(s1.id, now + 1000);
    assert.equal(read.userId, admin);
    assert.equal(read.csrf, s1.csrf);
    assert.equal(read.avatar, 'abc');
    assert.equal(await sessions.get('not-a-session', now), null);

    const s2 = await sessions.rotate(s1.id, { userId: admin, username: 'admin' }, now + 2000);
    assert.notEqual(s2.id, s1.id);
    assert.equal(await sessions.get(s1.id, now + 3000), null, 'rotated away');
    assert.ok(await sessions.get(s2.id, now + 3000));

    assert.equal(await sessions.get(s2.id, now + 2000 + 60 * 60 * 1000 + 1), null, 'expired after the TTL');

    assert.equal(await sessions.destroy(s2.id), true, 'logout');
    assert.equal(await sessions.get(s2.id, now + 4000), null);

    const old = await sessions.create({ userId: admin, username: 'admin' }, now - 2 * 60 * 60 * 1000);
    const removed = await sessions.cleanup(now, true);
    assert.ok(removed >= 1);
    const { rows: left } = await pgDb.pool.query('SELECT 1 FROM dashboard_sessions WHERE id_hash = $1', [store.hashSessionId(old.id)]);
    assert.equal(left.length, 0, 'expired rows deleted');
});

test('Postgres session store: one-shot flash message', { skip }, async () => {
    const query = (text, params) => pgDb.pool.query(text, params);
    const sessions = store.createPgSessionStore({ query });
    const s = await sessions.create({ userId: admin, username: 'admin' });
    assert.equal((await sessions.get(s.id)).flash, null);
    assert.equal(await sessions.setFlash(s.id, 'Saved <b>.'), true);
    assert.equal((await sessions.get(s.id)).flash, 'Saved <b>.');
    await sessions.setFlash(s.id, null);
    assert.equal((await sessions.get(s.id)).flash, null);
    await sessions.destroy(s.id);
});

test('dashboard audit store: rows, filters by user and module, paging, users list', { skip }, async () => {
    const { createAuditStore } = await import('../../src/services/dashboard/audit.js');
    const query = (text, params) => pgDb.pool.query(text, params);
    const audits = createAuditStore({ query, table: 'dashboard_audit' });
    const other = `6${runId}00000013`;
    await audits.writeRows(guildId, { userId: admin, username: 'admin' }, 'tickets', [{ key: 'maxTicketsPerUser', old: 3, new: 5 }, { key: 'dmOnClose', old: true, new: false }]);
    await audits.writeRows(guildId, { userId: other, username: 'other' }, 'logging', [{ key: 'logging.enabled', old: false, new: true }]);
    const all = await audits.list(guildId, { pageSize: 2 });
    assert.equal(all.total, 3);
    assert.equal(all.rows.length, 2);
    assert.equal(all.rows[0].key, 'logging.enabled', 'newest first');
    const page2 = await audits.list(guildId, { pageSize: 2, page: 1 });
    assert.equal(page2.rows.length, 1);
    const byUser = await audits.list(guildId, { userId: admin });
    assert.deepEqual(byUser.rows.map((r) => r.key).sort(), ['dmOnClose', 'maxTicketsPerUser']);
    assert.deepEqual(byUser.rows.find((r) => r.key === 'maxTicketsPerUser').new, 5);
    const byModule = await audits.list(guildId, { module: 'logging' });
    assert.equal(byModule.total, 1);
    const users = await audits.users(guildId);
    assert.deepEqual(users.map((u) => u.user_id).sort(), [admin, other].sort());
    await pgDb.pool.query('DELETE FROM dashboard_audit WHERE guild_id = $1', [guildId]);
});
