// "Delete this server's data" (owner decision 2026-11-07), without a database: only the server's
// owner (live guild.ownerId, or a fresh OAuth `owner` flag once the bot is gone), never admins or
// OWNER_IDS, Mewvo's own servers refused; the preview, the 7-day grace and Cancel on both paths
// (/serverdata delete + buttons, dashboard in the server and after removal). The deletion itself
// and two-server isolation: tests/db/serverDataDeletion.test.js. The inventory guard:
// tests/serverDataInventory.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    GRACE_MS, HOME_GUILD_IDS, OAUTH_OWNER_FRESH_MS, checkServerOwner, deleteServerData, previewServerData,
    requestServerDeletion, serverRefusal,
} from '../src/services/privacy/serverDataDeletion.js';
import { KINDS } from '../src/services/privacy/serverDataInventory.js';
import { KIND_KEYS, previewMessage, runServerDataCommand, scheduledMessage } from '../src/commands/Utility/serverdata.js';
import { handleServerDataButton } from '../src/interactions/buttons/serverdata/serverdata.js';
import { createServerDataHandlers } from '../src/services/dashboard/serverDataRoutes.js';
import { serverDataCard } from '../src/services/dashboard/serverDataPages.js';
import { guildListFrom, collectPicker, pickerPage } from '../src/services/dashboard/serverPicker.js';
import { allows, requiredLevel, routeKey } from '../src/services/dashboard/permissions.js';
import { decideAccess } from '../src/services/dashboard/access.js';
import { dashboardText } from '../src/services/dashboard/language.js';
import { BOT_CATALOG, botText } from '../src/utils/botText.js';
import { DASHBOARD_CATALOG } from '../src/services/site/i18n.js';
import { checkCommandAccess } from '../src/utils/commandGate.js';
import serverdataCommand from '../src/commands/Utility/serverdata.js';

const GUILD = '170000000000000071';
const OTHER = '170000000000000072';
const OWNER = '180000000000000081';
const ADMIN = '180000000000000082';
const NOW = Date.parse('2026-11-08T12:00:00Z');

const clientWith = (guilds = {}) => ({
    guilds: {
        cache: {
            get: (id) => (guilds[id] ? { id, name: guilds[id].name || 'Srv', ownerId: guilds[id].ownerId, fetch: async () => { if (guilds[id].fail) throw new Error('down'); return { ownerId: guilds[id].liveOwner ?? guilds[id].ownerId }; } } : undefined),
            has: (id) => Boolean(guilds[id]),
        },
    },
});

// ── Who may ask ───────────────────────────────────────────────────────────

test("home servers are refused entirely; a bad id too", async () => {
    for (const id of HOME_GUILD_IDS) assert.equal(serverRefusal(id), 'home');
    assert.equal(serverRefusal('1'), 'badId');
    assert.equal(serverRefusal(GUILD, { mainGuildId: GUILD }), 'home', 'the configured main server too');
    const r = await checkServerOwner({ client: clientWith({ [HOME_GUILD_IDS[0]]: { ownerId: OWNER } }), guildId: HOME_GUILD_IDS[0], userId: OWNER });
    assert.deepEqual([r.allowed, r.reason], [false, 'home'], 'even the real owner of a home server');
    // Nothing reaches the database for a home server.
    const calls = [];
    const query = async (...a) => { calls.push(a); return { rows: [] }; };
    await assert.rejects(previewServerData(HOME_GUILD_IDS[1], { query }));
    await assert.rejects(requestServerDeletion({ guildId: HOME_GUILD_IDS[0], userId: OWNER, query }));
    await assert.rejects(deleteServerData(HOME_GUILD_IDS[0], { withTransaction: async () => { calls.push('tx'); } }));
    assert.equal(calls.length, 0);
});

test('bot in the server: only the live owner; admins and a stale cached owner are refused; no answer = refused', async () => {
    const client = clientWith({ [GUILD]: { ownerId: ADMIN, liveOwner: OWNER } });
    assert.equal((await checkServerOwner({ client, guildId: GUILD, userId: OWNER })).allowed, true, 'fresh ownerId from Discord decides');
    assert.equal((await checkServerOwner({ client, guildId: GUILD, userId: ADMIN })).reason, 'notOwner', 'the cached (old) owner / an admin is refused');
    const down = clientWith({ [GUILD]: { ownerId: OWNER, fail: true } });
    assert.equal((await checkServerOwner({ client: down, guildId: GUILD, userId: OWNER })).reason, 'unknown', 'fail closed');
});

test('bot removed: a fresh OAuth owner flag for THIS server proves ownership; stale, other server or no flag do not', async () => {
    const client = clientWith({});
    const entry = { id: GUILD, owner: true, listedAt: NOW - 60_000 };
    assert.equal((await checkServerOwner({ client, guildId: GUILD, userId: OWNER, oauthEntry: entry, now: NOW })).allowed, true);
    assert.equal((await checkServerOwner({ client, guildId: GUILD, userId: OWNER, oauthEntry: { ...entry, listedAt: NOW - OAUTH_OWNER_FRESH_MS - 1 }, now: NOW })).reason, 'stale');
    assert.equal((await checkServerOwner({ client, guildId: GUILD, userId: OWNER, oauthEntry: { ...entry, id: OTHER }, now: NOW })).reason, 'notOwner');
    assert.equal((await checkServerOwner({ client, guildId: GUILD, userId: OWNER, oauthEntry: { id: GUILD, canManage: true }, now: NOW })).reason, 'notOwner', 'Manage Server is not ownership');
    assert.equal((await checkServerOwner({ client, guildId: GUILD, userId: OWNER, oauthEntry: null, now: NOW })).reason, 'notOwner');
});

test('the login keeps owner + listedAt only for owned servers (the picker test shape is unchanged otherwise)', () => {
    const list = guildListFrom([
        { id: GUILD, name: 'Mine', owner: true, permissions: '0' },
        { id: OTHER, name: 'Theirs', owner: false, permissions: '8' },
    ], { botHas: () => false, now: NOW });
    assert.deepEqual(list, [
        { id: GUILD, name: 'Mine', icon: null, canManage: true, owner: true, listedAt: NOW },
        { id: OTHER, name: 'Theirs', icon: null, canManage: true },
    ]);
});

test('picker: "Delete stored data" only on servers the user owns and the bot left', async () => {
    const list = [{ id: GUILD, name: 'Mine', canManage: true, owner: true, listedAt: NOW }, { id: OTHER, name: 'Theirs', canManage: true }];
    const picker = await collectPicker({ client: clientWith({}), list, checkAccess: async () => ({ allowed: false }), clientId: '400000000000000004' });
    assert.equal(picker.addable.find((g) => g.id === GUILD).dataHref, `/dashboard/removed/${GUILD}/data`);
    assert.equal(picker.addable.find((g) => g.id === OTHER).dataHref, null);
    const page = String(pickerPage({ session: { username: 'x', csrf: 'c' }, picker, lang: 'en' }));
    assert.equal((page.match(/\/dashboard\/removed\//g) || []).length, 1);
});

test('access: the routes are Administrator keys (Manage Server is not enough), registered before the settings catch-alls', () => {
    assert.equal(routeKey('POST', '/server-data/request'), 'serverdata.request');
    assert.equal(routeKey('POST', '/server-data/cancel'), 'serverdata.request');
    assert.equal(routeKey('GET', '/server-data'), 'page:server-data');
    assert.equal(requiredLevel('serverdata.request'), 'admin');
    const manager = decideAccess({ inGuild: true, isManager: true });
    assert.equal(allows(manager, 'serverdata.request'), false);
    assert.equal(allows(manager, 'page:server-data'), false);
    // /serverdata: an admin command (Administrator gate first); the owner check runs inside.
    const guild = { id: GUILD, ownerId: OWNER };
    const noPerms = { has: () => false };
    assert.equal(checkCommandAccess({ command: serverdataCommand, accessKey: 'serverdata delete', guild, userId: ADMIN, permissions: noPerms }).allowed, false);
    assert.equal(checkCommandAccess({ command: serverdataCommand, accessKey: 'serverdata delete', guild, userId: OWNER, permissions: noPerms }).allowed, true);
});

// ── /serverdata delete ────────────────────────────────────────────────────

function fakeInteraction({ userId = OWNER, guildId = GUILD, locale = 'en-US' } = {}) {
    const calls = [];
    return {
        calls, user: { id: userId }, guildId, guild: { id: guildId, name: 'Srv' }, locale,
        deferReply: async (o) => calls.push(['deferReply', o]),
        deferUpdate: async () => calls.push(['deferUpdate']),
        editReply: async (o) => calls.push(['editReply', o]),
        reply: async (o) => calls.push(['reply', o]),
    };
}
const last = (i) => i.calls.filter((c) => c[0] === 'editReply').at(-1)?.[1];
const ids = (payload) => (payload.components || []).flatMap((row) => row.components.map((c) => c.data.custom_id));

test('/serverdata delete: refused for an admin who is not the owner (nothing read); deferred first', async () => {
    const interaction = fakeInteraction({ userId: ADMIN });
    let read = 0;
    await runServerDataCommand(interaction, {}, {
        check: async () => ({ allowed: false, reason: 'notOwner' }), getRequest: async () => { read += 1; }, preview: async () => { read += 1; },
    });
    assert.equal(interaction.calls[0][0], 'deferReply');
    assert.equal(read, 0);
    assert.equal(last(interaction).content, botText('en').t('serverdata.refuse.notOwner'));
    assert.deepEqual(last(interaction).allowedMentions, { parse: [] });
});

test('/serverdata delete: the preview lists counts per kind, says cases leave "My record", offers the three buttons', async () => {
    const interaction = fakeInteraction();
    const kinds = Object.fromEntries(KINDS.map((k) => [k, 0]));
    kinds.cases = 12;
    kinds.kv = 3;
    await runServerDataCommand(interaction, {}, { check: async () => ({ allowed: true }), getRequest: async () => null, preview: async () => ({ kinds, total: 15 }) });
    const payload = last(interaction);
    const text = payload.embeds[0].data.description;
    assert.match(text, /Moderation cases .*: 12/);
    assert.match(text, /Other stored settings and records: 3/);
    assert.doesNotMatch(text, /Tickets/, 'kinds without data are not listed');
    assert.match(text, /My record/);
    assert.match(text, /7 days/);
    assert.deepEqual(ids(payload), [`serverdata:confirm:${OWNER}`, `serverdata:leave:${OWNER}`, `serverdata:dismiss:${OWNER}`]);
});

test('/serverdata delete while a deletion is scheduled: the date and [Cancel deletion]; running: no button', async () => {
    const record = { status: 'scheduled', dueAt: new Date(NOW + GRACE_MS).toISOString(), removeBot: true };
    const interaction = fakeInteraction();
    await runServerDataCommand(interaction, {}, { check: async () => ({ allowed: true }), getRequest: async () => record, preview: async () => assert.fail('no preview') });
    const unix = Math.floor((NOW + GRACE_MS) / 1000);
    assert.match(last(interaction).embeds[0].data.description, new RegExp(`<t:${unix}:F>`));
    assert.match(last(interaction).embeds[0].data.description, /leave the server/);
    assert.deepEqual(ids(last(interaction)), [`serverdata:cancel:${OWNER}`]);
    assert.deepEqual(scheduledMessage({ ...record, status: 'running' }, OWNER).components, []);
});

test('/serverdata delete: a database error says nothing was changed', async () => {
    const interaction = fakeInteraction();
    await runServerDataCommand(interaction, {}, { check: async () => ({ allowed: true }), getRequest: async () => { throw new Error('down'); } });
    assert.equal(last(interaction).content, botText('en').t('serverdata.refuse.database'));
});

test('buttons: someone else cannot click (no defer, nothing done); the owner is re-checked on every click', async () => {
    let requested = 0;
    const deps = { check: async ({ userId }) => ({ allowed: userId === OWNER, reason: 'notOwner' }), request: async () => { requested += 1; return { record: {}, created: true }; }, cancel: async () => ({}) };
    const stranger = fakeInteraction({ userId: ADMIN });
    await handleServerDataButton(stranger, {}, ['confirm', OWNER], deps);
    assert.deepEqual(stranger.calls.map((c) => c[0]), ['reply']);
    // The panel was opened by ADMIN (e.g. before an ownership transfer): re-check refuses.
    const former = fakeInteraction({ userId: ADMIN });
    await handleServerDataButton(former, {}, ['confirm', ADMIN], deps);
    assert.equal(former.calls[0][0], 'deferUpdate');
    assert.equal(last(former).content, botText('en').t('serverdata.refuse.notOwner'));
    assert.equal(requested, 0);
});

test('buttons: Confirm schedules (7 days), "and remove Mewvo" sets removeBot, Cancel cancels, Dismiss changes nothing', async () => {
    const seen = [];
    const record = { status: 'scheduled', dueAt: new Date(NOW + GRACE_MS).toISOString() };
    const deps = {
        check: async () => ({ allowed: true }),
        request: async (args) => { seen.push(['request', args]); return { record: { ...record, removeBot: args.removeBot }, created: true }; },
        cancel: async (args) => { seen.push(['cancel', args]); return { cancelled: true }; },
    };
    for (const action of ['confirm', 'leave', 'cancel', 'dismiss']) {
        const i = fakeInteraction();
        await handleServerDataButton(i, {}, [action, OWNER], deps);
        assert.equal(i.calls[0][0], 'deferUpdate', `${action}: deferred first`);
        if (action === 'dismiss') assert.equal(last(i).content, botText('en').t('serverdata.dismissed'));
        if (action === 'cancel') assert.equal(last(i).content, botText('en').t('serverdata.cancelled'));
        if (action === 'confirm' || action === 'leave') assert.deepEqual(ids(last(i)), [`serverdata:cancel:${OWNER}`]);
    }
    assert.deepEqual(seen.map(([kind, a]) => [kind, a.guildId, a.userId, a.removeBot]), [
        ['request', GUILD, OWNER, false], ['request', GUILD, OWNER, true], ['cancel', GUILD, OWNER, undefined],
    ]);
    assert.equal(seen[0][1].source, 'command');
});

test('the grace period: a request is due 7 days after it was made', async () => {
    let params = null;
    const query = async (text, p) => { if (/INSERT INTO/.test(text)) { params = p; return { rows: [{ value: JSON.parse(p[1]) }] }; } return { rows: [] }; };
    const { record, created } = await requestServerDeletion({ guildId: GUILD, userId: OWNER, removeBot: true, now: NOW, query, config: {} });
    assert.equal(created, true);
    assert.equal(params[0], `serverdata:deletion:${GUILD}`);
    assert.equal(Date.parse(record.dueAt) - Date.parse(record.requestedAt), 7 * 24 * 60 * 60 * 1000);
    assert.deepEqual([record.status, record.removeBot, record.requestedBy], ['scheduled', true, OWNER]);
});

// ── Dashboard ─────────────────────────────────────────────────────────────

function dashboardCtx({ guildId = GUILD, isHomeServer = false, client = clientWith({ [GUILD]: { ownerId: OWNER } }), deps = {}, lists = new Map(), editEnabled = true, post = true } = {}) {
    const out = { pages: [], flashes: [], logins: [] };
    const ctx = {
        client, guildId, isHomeServer, settings: { editEnabled }, sessions: { setFlash: async (_id, text) => out.flashes.push(text) },
        guildLists: { get: (id) => lists.get(id) }, startLogin: (_req, res, opts) => { out.logins.push(opts); return res.redirect(302, 'discord'); },
        sendHtml: (res, status, page) => { out.pages.push({ status, page: String(page) }); return res.status(status); },
        shellOf: (req) => ({ session: { ...req.dashboard.session, lang: 'en' }, access: null, moduleStates: {} }),
        fail: (res, status, title, message) => { out.pages.push({ status, page: `${title}: ${message}` }); return res.status(status); },
        failT: (res, status, title, message) => { out.pages.push({ status, page: `${title}/${message}` }); return res.status(status); },
        textOfReq: () => dashboardText('en'), checkPost: () => post, postLimiter: { allow: () => true },
        serverNotFound: (_req, res) => { out.pages.push({ status: 404, page: 'not found' }); return res.status(404); },
        themeOf: () => 'system', path: (s) => `/dashboard/${guildId}${s}`,
        deps: {
            check: async ({ userId, guildId: g, oauthEntry }) => checkServerOwner({ client, guildId: g, userId, oauthEntry, now: Date.now(), config: {} }),
            preview: async () => ({ kinds: Object.fromEntries(KINDS.map((k) => [k, k === 'cases' ? 4 : 0])), tables: [{ table: 'mod_cases', key: 'mod_cases', kind: 'cases', count: 4 }], total: 4 }),
            getRequest: async () => null,
            request: async (a) => { out.request = a; return { record: { status: 'scheduled', dueAt: new Date(Date.now() + GRACE_MS).toISOString() }, created: true }; },
            cancel: async (a) => { out.cancel = a; return { cancelled: true }; },
            ...deps,
        },
    };
    return { handlers: createServerDataHandlers(ctx), out };
}
const fakeRes = () => {
    const res = { code: 200, location: null, headers: {} };
    res.status = (c) => { res.code = c; return res; };
    res.redirect = (c, l) => { res.code = c; res.location = l; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    return res;
};
const reqAs = (userId, extra = {}) => ({ method: 'GET', params: {}, body: {}, dashboard: { session: { userId, idHash: 'h', id: 's', csrf: 'tok' }, lang: 'en', flash: null }, ...extra });

test('dashboard page: 404 for an admin who is not the owner and in a home server; the owner gets counts + Confirm + the remove-Mewvo box', async () => {
    const { handlers, out } = dashboardCtx();
    let res = fakeRes();
    await handlers.page(reqAs(ADMIN), res);
    assert.equal(res.code, 404);
    res = fakeRes();
    await handlers.page(reqAs(OWNER), res);
    const html = out.pages.at(-1).page;
    assert.equal(out.pages.at(-1).status, 200);
    assert.match(html, /action="\/dashboard\/server-data\/request"/);
    assert.match(html, /name="removeBot" value="1"/);
    assert.match(html, /<dd>4<\/dd>/);
    assert.match(html, /My record/);
    assert.match(html, /Delete in 7 days/);
    const home = dashboardCtx({ isHomeServer: true });
    res = fakeRes();
    await home.handlers.page(reqAs(OWNER), res);
    assert.equal(res.code, 404);
});

test('dashboard request / cancel: CSRF first, the owner checked fresh, removeBot from the box, 303 back to the page', async () => {
    const refused = dashboardCtx({ post: false });
    let res = fakeRes();
    await refused.handlers.request(reqAs(OWNER, { method: 'POST', body: { removeBot: '1' } }), res);
    assert.equal(res.code, 403);
    assert.equal(refused.out.request, undefined);
    const { handlers, out } = dashboardCtx();
    res = fakeRes();
    await handlers.request(reqAs(ADMIN, { method: 'POST', body: {} }), res);
    assert.equal(res.code, 404, 'an admin cannot request');
    assert.equal(out.request, undefined);
    res = fakeRes();
    await handlers.request(reqAs(OWNER, { method: 'POST', body: { removeBot: '1' } }), res);
    assert.equal(res.code, 303);
    assert.deepEqual([out.request.guildId, out.request.userId, out.request.removeBot, out.request.source], [GUILD, OWNER, true, 'dashboard']);
    assert.match(out.flashes.at(-1), /^Deletion scheduled for /);
    res = fakeRes();
    await handlers.cancel(reqAs(OWNER, { method: 'POST', body: {} }), res);
    assert.equal(res.code, 303);
    assert.deepEqual([out.cancel.guildId, out.cancel.userId], [GUILD, OWNER]);
    assert.equal(out.flashes.at(-1), dashboardText('en').t('serverData.flash.cancelled'));
});

test('dashboard while scheduled: the status and [Cancel deletion], no second Confirm', async () => {
    const record = { status: 'scheduled', dueAt: new Date(Date.now() + GRACE_MS).toISOString(), removeBot: false };
    const { handlers, out } = dashboardCtx({ deps: { getRequest: async () => record, preview: async () => assert.fail('no preview') } });
    await handlers.page(reqAs(OWNER), fakeRes());
    const html = out.pages.at(-1).page;
    assert.match(html, /action="\/dashboard\/server-data\/cancel"/);
    assert.doesNotMatch(html, /server-data\/request/);
});

test('overview card: only for the owner (cached ownerId), never in a home server; scheduled shows Cancel', async () => {
    const { handlers } = dashboardCtx();
    assert.equal(await handlers.overviewInfo(reqAs(ADMIN)), null);
    assert.deepEqual(await handlers.overviewInfo(reqAs(OWNER)), { record: null });
    assert.equal(await dashboardCtx({ isHomeServer: true }).handlers.overviewInfo(reqAs(OWNER)), null);
    const tr = dashboardText('en');
    assert.equal(String(serverDataCard(null, { csrf: 'c', tr })), '');
    assert.match(String(serverDataCard({ record: null }, { csrf: 'c', tr })), /href="\/dashboard\/server-data"/);
    assert.match(String(serverDataCard({ record: { status: 'scheduled', dueAt: new Date().toISOString() } }, { csrf: 'c', tr })), /server-data\/cancel/);
});

test('removed path: bot still there → the in-server page; stale list → "Check with Discord" (silent re-login back here); fresh owner → page without the remove box', async () => {
    const inGuild = dashboardCtx({ guildId: '170000000000000001', client: clientWith({ [GUILD]: { ownerId: OWNER } }) });
    let res = fakeRes();
    await inGuild.handlers.removedPage(reqAs(OWNER, { params: { id: GUILD } }), res);
    assert.deepEqual([res.code, res.location], [302, `/dashboard/${GUILD}/server-data`]);

    const lists = new Map([[OWNER, [{ id: GUILD, name: 'Gone', canManage: true, owner: true, listedAt: Date.now() - OAUTH_OWNER_FRESH_MS - 5000 }]]]);
    const stale = dashboardCtx({ guildId: '170000000000000001', client: clientWith({}), lists });
    await stale.handlers.removedPage(reqAs(OWNER, { params: { id: GUILD } }), fakeRes());
    assert.match(stale.out.pages.at(-1).page, new RegExp(`/dashboard/removed/${GUILD}/data/verify`));
    res = fakeRes();
    stale.handlers.removedVerify(reqAs(OWNER, { params: { id: GUILD } }), res);
    assert.deepEqual(stale.out.logins.at(-1), { returnTo: `/dashboard/removed/${GUILD}/data`, prompt: 'none' });
    // A POST with a stale list does nothing and goes back to the page (which asks to check again).
    res = fakeRes();
    await stale.handlers.removedRequest(reqAs(OWNER, { method: 'POST', params: { id: GUILD } }), res);
    assert.deepEqual([res.code, stale.out.request], [303, undefined]);

    lists.set(OWNER, [{ id: GUILD, name: 'Gone', canManage: true, owner: true, listedAt: Date.now() }]);
    // CSRF / Origin first on the global POSTs too.
    const noCsrf = dashboardCtx({ guildId: '170000000000000001', client: clientWith({}), lists, post: false });
    for (const action of ['removedRequest', 'removedCancel']) {
        res = fakeRes();
        await noCsrf.handlers[action](reqAs(OWNER, { method: 'POST', params: { id: GUILD } }), res);
        assert.equal(res.code, 403, action);
    }
    assert.deepEqual([noCsrf.out.request, noCsrf.out.cancel], [undefined, undefined]);
    const fresh = dashboardCtx({ guildId: '170000000000000001', client: clientWith({}), lists });
    await fresh.handlers.removedPage(reqAs(OWNER, { params: { id: GUILD } }), fakeRes());
    const html = fresh.out.pages.at(-1).page;
    assert.match(html, new RegExp(`action="/dashboard/removed/${GUILD}/data/request"`));
    assert.doesNotMatch(html, /removeBot/);
    assert.match(html, /Gone/);
    res = fakeRes();
    await fresh.handlers.removedRequest(reqAs(OWNER, { method: 'POST', params: { id: GUILD } }), res);
    assert.deepEqual([res.code, fresh.out.request.guildId, fresh.out.request.removeBot, fresh.out.request.source], [303, GUILD, false, 'dashboard-removed']);
    res = fakeRes();
    await fresh.handlers.removedCancel(reqAs(OWNER, { method: 'POST', params: { id: GUILD } }), res);
    assert.equal(fresh.out.cancel.guildId, GUILD);

    // Someone else (an admin of that server, no owner flag) and a home server: 404.
    for (const [user, id] of [[ADMIN, GUILD], [OWNER, HOME_GUILD_IDS[0]], [OWNER, 'abc']]) {
        res = fakeRes();
        await fresh.handlers.removedPage(reqAs(user, { params: { id } }), res);
        assert.equal(res.code, 404, `${user} ${id}`);
    }
});

// ── Text ──────────────────────────────────────────────────────────────────

test('every bot and dashboard key the new code names exists (English; the parity tests cover the other 7)', () => {
    // serverDataDeletion.js names log events (serverdata.deleted …); its one text is the DM.
    const files = ['commands/Utility/serverdata.js', 'interactions/buttons/serverdata/serverdata.js'];
    const used = new Set(['serverdata.dm.done']);
    for (const f of files) for (const m of readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').matchAll(/['"`](serverdata\.[A-Za-z0-9.]+)['"`]/g)) used.add(m[1]);
    for (const key of Object.values(KIND_KEYS)) used.add(key);
    assert.ok(used.size > 20);
    assert.deepEqual([...used].filter((k) => BOT_CATALOG.catalogText('en', k) === undefined), []);
    const dash = new Set();
    for (const f of ['services/dashboard/serverDataPages.js', 'services/dashboard/serverDataRoutes.js', 'services/dashboard/serverPicker.js', 'services/dashboard/ownerPages.js']) {
        for (const m of readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').matchAll(/['"`](serverData\.[A-Za-z0-9.]+)['"`]/g)) dash.add(m[1]);
    }
    for (const kind of KINDS) dash.add(`serverData.kind.${kind}`);
    assert.ok(dash.size > 20);
    assert.deepEqual([...dash].filter((k) => DASHBOARD_CATALOG.catalogText('en', k) === undefined), []);
    // The kind labels are the same words on both paths.
    for (const kind of KINDS) assert.equal(DASHBOARD_CATALOG.catalogText('de', `serverData.kind.${kind}`), BOT_CATALOG.catalogText('de', `serverdata.kind.${kind}`));
});

test('previewMessage stays within Discord limits in every language', () => {
    const kinds = Object.fromEntries(KINDS.map((k) => [k, 123456]));
    for (const lang of ['en', 'ru', 'de', 'fr', 'it', 'pl', 'es', 'pt-BR']) {
        const msg = previewMessage({ kinds }, OWNER, botText(lang));
        assert.ok(msg.embeds[0].data.description.length <= 4096, lang);
        for (const row of msg.components) for (const b of row.components) assert.ok(b.data.label.length <= 80, `${lang}: ${b.data.label}`);
    }
});
