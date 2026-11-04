// Owner area → Erase a case: owners only (others get 404), CSRF / Origin on the POSTs, a confirm
// page naming the case with a one-time token and a tick-box, refusals shown without changing
// anything, a database error answered with 503, the audit row without case content.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';

const { createDashboard, dashboardSettings } = await import('../src/services/dashboard/routes.js');
const { createMemorySessionStore } = await import('../src/services/dashboard/sessionStore.js');
const { createAccessChecker } = await import('../src/services/dashboard/access.js');
const { SESSION_COOKIE, signValue } = await import('../src/services/dashboard/security.js');
const { OWNER_NAV } = await import('../src/services/dashboard/html.js');

const SECRET = 'y'.repeat(64);
const OWNER = '200000000000000003';
const ADMIN = '200000000000000002';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: process.env.MAIN_GUILD_ID, NODE_ENV: 'test',
};
const CASE = {
    case_code: 'abcdefg', type: 'warn', name: 'alice warn 2', target_username: 'alice', target_user_id: '300000000000000001',
    guild_id: process.env.MAIN_GUILD_ID, created_at: new Date('2026-10-01T10:00:00Z'), moderator_username: 'mod', status: 'active', reason: 'Posted <b>her</b> address',
};

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

async function setup({ userId = OWNER, preview = null, erase = null, evidenceResult = { deleted: 1, failed: 0 } } = {}) {
    const client = { user: { id: '999999999999999998', username: 'Mewvo' }, guilds: { cache: new Map() }, users: { cache: new Map(), fetch: async () => null } };
    const calls = [];
    const owner = {
        isBotOwner: (id) => id === OWNER,
        previewCaseErase: async (code) => { calls.push(['preview', code]); return preview ? preview(code) : { code: 'abcdefg', case: CASE, counts: { notes: 1, evidence: 2, edits: 0, appeals: 1 }, mode: 'anonymise', refusal: null }; },
        eraseCase: async (code) => { calls.push(['erase', code]); return erase ? erase(code) : { code, mode: 'anonymise', type: 'warn', guildId: CASE.guild_id, counts: {}, evidenceMessages: [{ channelId: '1', messageId: '2' }] }; },
        deleteEvidenceMessages: async (c, list) => { calls.push(['images', list.length]); return evidenceResult; },
    };
    const sessions = createMemorySessionStore({ ttlMs: 48 * 3600 * 1000 });
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: id === ADMIN || id === OWNER, isOwnerId: id === OWNER }) });
    const auditRows = [];
    const auditStore = { writeRows: async (g, actor, module, changes) => { for (const c of changes) auditRows.push({ module, ...c }); return changes.length; }, list: async () => ({ rows: [], total: 0 }), users: async () => [] };
    const services = { postModLog: async () => {}, getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) };
    const data = { overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) } };
    const d = createDashboard({ client, settings: dashboardSettings(ENV), sessions, access, services, auditStore, env: ENV, data, owner });
    const session = await sessions.create({ userId, username: 'owner' }, Date.now());
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, calls, session, cookie, auditRows, ow: d.owner };
}

async function run(h, handler, req) {
    const res = fakeRes();
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (!passed) return res;
    let ownerOk = false;
    await h.ow.requireOwner(req, res, () => { ownerOk = true; });
    if (ownerOk) await handler(req, res, () => {});
    return res;
}
const get = (h, handler) => run(h, handler, { method: 'GET', params: {}, query: {}, headers: { cookie: h.cookie } });
const post = (h, handler, { form = {}, origin = ORIGIN, csrf = h.session.csrf } = {}) => run(h, handler, {
    method: 'POST', params: {}, query: {}, path: '/owner/erase', headers: { cookie: h.cookie, ...(origin ? { origin } : {}) }, body: { csrf, ...form },
});
const tokenOf = (body) => ({ token: body.match(/name="token" value="([^"]+)"/)?.[1], fh: body.match(/name="fh" value="([^"]+)"/)?.[1] });

test('erase: in the Owner nav; non-owners get 404 on the page and the POSTs', async () => {
    assert.ok(OWNER_NAV.items.some((item) => item.key === 'owner/erase'));
    const h = await setup({ userId: ADMIN });
    assert.equal((await get(h, h.ow.erase)).statusCode, 404);
    assert.equal((await post(h, h.ow.erasePreview, { form: { code: 'abcdefg' } })).statusCode, 404);
    assert.equal((await post(h, h.ow.eraseRun, { form: { code: 'abcdefg', token: 'x', fh: 'y', confirm: '1' } })).statusCode, 404);
    assert.deepEqual(h.calls, []);
});

test('erase: wrong origin or CSRF → 403, nothing read or changed', async () => {
    const h = await setup();
    assert.equal((await post(h, h.ow.erasePreview, { form: { code: 'abcdefg' }, origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await post(h, h.ow.erasePreview, { form: { code: 'abcdefg' }, csrf: 'nope' })).statusCode, 403);
    assert.deepEqual(h.calls, []);
});

test('erase: form → confirm page naming the case → tick-box + one-time token → erased and audited without content', async () => {
    const h = await setup();
    const page = await get(h, h.ow.erase);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Erase a case/);

    const preview = await post(h, h.ow.erasePreview, { form: { code: 'ABCDEFG' } });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.body, /Confirm: erase case abcdefg/);
    assert.match(preview.body, /alice warn 2/);
    assert.match(preview.body, /300000000000000001/);
    assert.match(preview.body, /Posted &lt;b&gt;her&lt;\/b&gt; address/, 'escaped');
    assert.match(preview.body, /stays as a counted row/);
    assert.match(preview.body, /Anonymise the case/);
    const { token, fh } = tokenOf(preview.body);
    assert.ok(token && fh);

    const noTick = await post(h, h.ow.eraseRun, { form: { code: 'abcdefg', token, fh } });
    assert.equal(noTick.statusCode, 400);
    assert.ok(!h.calls.some(([name]) => name === 'erase'));

    const fresh = tokenOf((await post(h, h.ow.erasePreview, { form: { code: 'abcdefg' } })).body);
    const otherCode = await post(h, h.ow.eraseRun, { form: { code: 'bbbbbbb', ...fresh, confirm: '1' } });
    assert.equal(otherCode.statusCode, 400, 'the token is bound to the case');
    assert.ok(!h.calls.some(([name]) => name === 'erase'));

    const again = tokenOf((await post(h, h.ow.erasePreview, { form: { code: 'abcdefg' } })).body);
    const done = await post(h, h.ow.eraseRun, { form: { code: 'abcdefg', ...again, confirm: '1' } });
    assert.equal(done.statusCode, 303);
    assert.match(done.redirectedTo, /\/owner\/erase$/);
    assert.deepEqual(h.calls.filter(([name]) => name !== 'preview'), [['erase', 'abcdefg'], ['images', 1]]);
    assert.deepEqual(h.auditRows.at(-1), { module: 'owner', key: 'privacy.erase.abcdefg', old: { type: 'warn', guildId: CASE.guild_id }, new: 'anonymised' });
    assert.ok(!JSON.stringify(h.auditRows).includes('address'), 'no case content in the audit log');

    const reused = await post(h, h.ow.eraseRun, { form: { code: 'abcdefg', ...again, confirm: '1' } });
    assert.equal(reused.statusCode, 400, 'a token works once');
    assert.equal(h.calls.filter(([name]) => name === 'erase').length, 1);
});

test('erase: a refusal re-renders the form with the reason; a database error → 503 "nothing was changed"', async () => {
    const refused = await setup({ preview: () => ({ code: 'abcdefg', case: CASE, counts: {}, mode: null, refusal: 'This ban is still in force. Lift it first.' }) });
    const res = await post(refused, refused.ow.erasePreview, { form: { code: 'abcdefg' } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /still in force/);
    assert.ok(!res.body.includes('name="token"'));

    const down = await setup({ preview: () => { throw new Error('connection refused'); } });
    const res503 = await post(down, down.ow.erasePreview, { form: { code: 'abcdefg' } });
    assert.equal(res503.statusCode, 503);
    assert.match(res503.body, /Nothing was changed/);

    const failing = await setup({ erase: () => { throw new Error('connection refused'); } });
    const t = tokenOf((await post(failing, failing.ow.erasePreview, { form: { code: 'abcdefg' } })).body);
    const res2 = await post(failing, failing.ow.eraseRun, { form: { code: 'abcdefg', ...t, confirm: '1' } });
    assert.equal(res2.statusCode, 503);
    assert.equal(failing.auditRows.length, 0, 'no audit row for a failed erase');
    assert.ok(!failing.calls.some(([name]) => name === 'images'));
});
