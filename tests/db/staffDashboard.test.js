// Staff dashboard pages against the local test database: the real case search,
// case detail, appeals, automod and stats services behind the route handlers.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, routes, security, access;
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
    routes = await import('../../src/services/staffDashboard/routes.js');
    security = await import('../../src/services/staffDashboard/security.js');
    access = await import('../../src/services/staffDashboard/access.js');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]);
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
        STAFF_DASHBOARD_ENABLED: 'true', SESSION_SECRET: 's'.repeat(40), CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'x',
        PUBLIC_URL: 'http://127.0.0.1:3100', MAIN_GUILD_ID: guildId,
    });
    assert.equal(settings.enabled, true);
    const sessions = security.createSessionStore();
    const session = sessions.create({ userId: admin, username: 'admin' });
    const checker = access.createAccessChecker({}, { facts: async () => ({ inGuild: true, isAdmin: true }) });
    const d = routes.createDashboard({ client: { user: { id: '1' }, channels: { cache: new Map() } }, settings, access: checker, sessions });
    const cookie = `${security.SESSION_COOKIE}=${encodeURIComponent(security.signValue(session.id, settings.sessionSecret))}`;
    const run = async (handler, req) => {
        const res = fakeRes();
        let ok = false;
        await d.requireStaff({ method: 'GET', headers: { cookie }, query: {}, params: {}, ...req }, res, () => { ok = true; });
        if (ok) await handler({ method: 'GET', headers: { cookie }, query: {}, params: {}, staffSession: session, ...req }, res);
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

    const appeals = await run(d.appeals, {});
    assert.equal(appeals.statusCode, 200);
    assert.match(appeals.body, new RegExp(warn.case_code));
    assert.match(appeals.body, /2 d|4\d h/);

    const automod = await run(d.automod, {});
    assert.equal(automod.statusCode, 200);
    assert.match(automod.body, /Spam/);
    assert.match(automod.body, /50%/);

    const stats = await run(d.stats, { query: { period: '7d' } });
    assert.equal(stats.statusCode, 200);
    assert.match(stats.body, /mod/);
});
