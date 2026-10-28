// Dashboard Inbox: one list of everything waiting for staff (each kind, oldest first,
// filters, escaping), the sidebar count, and reading / replying / closing modmail and
// tickets from the web: modmail replies reach the member's DM path, `//` notes do not,
// ticket replies go to the channel, close needs the confirm token, non-admins are refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { createDashboard, dashboardSettings } from '../src/services/dashboard/routes.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import { SESSION_COOKIE, signValue } from '../src/services/dashboard/security.js';
import { createInboxBadge } from '../src/services/dashboard/inboxRoutes.js';
import { NAV } from '../src/services/dashboard/html.js';
import { hasIcon } from '../src/services/dashboard/icons.js';

const SECRET = 'z'.repeat(64);
const GUILD = '100000000000000001';
const ADMIN = '200000000000000002';
const OWNER = '200000000000000003';
const MEMBER = '300000000000000004';
const MODMAIL_CH = '500000000000000001';
const TICKET_CH = '500000000000000002';
const REPORT_CH = '500000000000000003';
const GONE_CH = '500000000000000009';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};
const HOUR = 3600000;

function makeChannel(id, name) {
    const channel = {
        id, name, sent: [], reactions: [],
        async send(payload) {
            channel.sent.push(payload);
            return { react: async (emoji) => { channel.reactions.push(emoji); } };
        },
        messages: {
            fetch: async () => new Map([
                ['2', { id: '2', content: 'second <img src=x onerror=alert(1)>', createdTimestamp: Date.now() - 1000, author: { id: ADMIN, username: 'admin' }, member: { displayName: 'Admin<b>' }, embeds: [], attachments: new Map() }],
                ['1', {
                    id: '1', content: 'first', createdTimestamp: Date.now() - 5000, author: { id: MEMBER, username: 'member', bot: false }, embeds: [{ title: 'Modmail', description: 'header <i>' }],
                    attachments: new Map([['a', { name: 'shot<1>.png', url: 'https://cdn.discordapp.com/attachments/1/2/shot.png' }], ['b', { name: 'evil', url: 'javascript:alert(1)' }]]),
                }],
            ]),
        },
    };
    return channel;
}

function makeWorld({ admins = new Set([ADMIN]) } = {}) {
    const channels = new Map([
        [MODMAIL_CH, makeChannel(MODMAIL_CH, 'modmail-member')],
        [TICKET_CH, makeChannel(TICKET_CH, 'ticket-0007')],
        [REPORT_CH, makeChannel(REPORT_CH, 'report-member')],
    ]);
    const guild = { id: GUILD, name: 'Main', ownerId: '999999999999999990', channels: { cache: channels } };
    const memberOf = (id) => ({
        id, guild, displayName: id === ADMIN ? 'Admin Display' : `user${id.slice(-2)}`, user: { id, username: id === ADMIN ? 'admin' : `user${id.slice(-2)}` },
        permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator && admins.has(id) },
    });
    guild.members = {
        cache: new Map([[MEMBER, { user: { id: MEMBER, username: 'member<script>' } }]]),
        fetch: async (arg) => memberOf(typeof arg === 'string' ? arg : arg?.user),
    };
    const client = { user: { id: '999999999999999998' }, guilds: { cache: new Map([[GUILD, guild]]) }, users: { cache: new Map(), fetch: async (id) => ({ id, username: 'u' }) } };
    return { guild, client, channels };
}

function makeInbox(overrides = {}) {
    const calls = [];
    const rec = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };
    const now = Date.now();
    const inbox = {
        listPendingAppeals: rec('listPendingAppeals', () => [{ case_code: 'abc234x', type: 'ban', username: 'appellant<b>', user_id: MEMBER, created_at: new Date(now - 4 * 86400000) }]),
        listOpenTickets: rec('listOpenTickets', () => [
            { channelId: TICKET_CH, userId: MEMBER, createdAt: new Date(now - 3 * HOUR).toISOString(), claimedBy: null, reason: 'help <script>x</script>' },
            { channelId: GONE_CH, userId: MEMBER, createdAt: new Date(now - 9 * HOUR).toISOString() },
        ]),
        listOpenModmail: rec('listOpenModmail', () => [{ channelId: MODMAIL_CH, userId: MEMBER, createdAt: new Date(now - 2 * HOUR) }]),
        listOpenReports: rec('listOpenReports', () => [{ id: 4, userId: MEMBER, username: 'reporter', channelId: REPORT_CH, createdAt: new Date(now - HOUR), staffMember: 'mod<x>' }]),
        collectOpenReviews: rec('collectOpenReviews', () => [
            { title: 'Spam by <b>x</b>', url: 'https://discord.com/channels/1/2/3', at: now - 30 * 60000, count: 2 },
            { title: 'bad url', url: 'javascript:alert(1)', at: now - 60000, count: 1 },
        ]),
        modmailUserId: rec('modmailUserId', (channel) => (channel.id === MODMAIL_CH ? MEMBER : null)),
        getTicketData: rec('getTicketData', (g, id) => (id === TICKET_CH ? { status: 'open', userId: MEMBER } : null)),
        sendStaffTextToMember: rec('sendStaffTextToMember', () => true),
        closeModmail: rec('closeModmail', () => true),
        closeTicket: rec('closeTicket', () => ({ status: 'closed' })),
        ...overrides,
    };
    return { inbox, calls };
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

async function setup({ userId = ADMIN, admins = new Set([ADMIN]), env = ENV, overrides = {}, inboxBadge = false } = {}) {
    const world = makeWorld({ admins });
    const { inbox, calls } = makeInbox(overrides);
    const sessions = createMemorySessionStore();
    const access = createAccessChecker(world.client, { facts: async (c, id) => ({ inGuild: true, isAdmin: admins.has(id), isOwnerId: id === OWNER }) });
    const auditRows = [];
    const auditStore = {
        writeRows: async (g, actor, module, changes) => { for (const c of changes) auditRows.push({ actor, module, ...c }); return changes.length; },
        list: async () => ({ rows: [], total: 0 }), users: async () => [],
    };
    const services = { postModLog: async () => {}, getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) };
    const data = { overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) } };
    const d = createDashboard({ client: world.client, settings: dashboardSettings(env), sessions, access, services, auditStore, env, data, inbox, inboxBadge, owner: { isBotOwner: (id) => id === OWNER } });
    const session = await sessions.create({ userId, username: userId === OWNER ? 'owner' : 'admin' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, calls, sessions, session, cookie, auditRows, ...world };
}

async function run(h, handler, req) {
    const res = fakeRes();
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (passed) await handler(req, res, () => { res.fellThrough = true; });
    return res;
}

const get = (h, handler, { params = {}, query = {} } = {}) => run(h, handler, { method: 'GET', params, query, headers: { cookie: h.cookie } });
const post = (h, handler, { params = {}, form = {}, csrf = h.session.csrf } = {}) => run(h, handler, {
    method: 'POST', params, query: {}, path: '/x', headers: { cookie: h.cookie, origin: ORIGIN }, body: { ...(csrf === null ? {} : { csrf }), ...form },
});
const called = (h, name) => h.calls.filter((c) => c.name === name);
const hidden = (body, name) => body.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];

test('sidebar: Inbox is the second Moderate entry, with its own icon', () => {
    const moderate = NAV.find((g) => g.group === 'Moderate');
    assert.deepEqual(moderate.items.slice(0, 2).map((i) => i.key), ['overview', 'inbox']);
    assert.ok(hasIcon('inbox'));
});

test('inbox: lists every kind oldest first with counts, links and escaping; stale channels and unsafe URLs are left out', async () => {
    const h = await setup();
    const res = await get(h, h.d.inbox.list);
    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.match(body, /<h1>Inbox \(5\)<\/h1>/);
    // one row per kind; the ticket whose channel is gone and the javascript: review are not listed
    for (const label of ['Appeal', 'Ticket', 'Modmail', 'Staff report', 'Automod review']) assert.match(body, new RegExp(`</svg>${label}</span>`));
    assert.doesNotMatch(body, new RegExp(GONE_CH));
    assert.doesNotMatch(body, /javascript:/);
    // oldest first: appeal (4 d) → ticket (3 h) → modmail (2 h) → report (1 h) → review (30 min)
    const order = ['/dashboard/appeals/abc234x', `/dashboard/inbox/ticket/${TICKET_CH}`, `/dashboard/inbox/modmail/${MODMAIL_CH}`, `https://discord.com/channels/${GUILD}/${REPORT_CH}`, 'https://discord.com/channels/1/2/3']
        .map((href) => body.indexOf(`href="${href}"`));
    assert.ok(order.every((pos) => pos > 0), 'every main action link is present');
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(body, />Review appeal</);
    assert.match(body, />Open conversation</);
    // escaped user text
    assert.match(body, /help &lt;script&gt;x&lt;\/script&gt;/);
    assert.match(body, /appellant&lt;b&gt;/);
    assert.match(body, /Spam by &lt;b&gt;x&lt;\/b&gt;/);
    assert.doesNotMatch(body, /<script>x/);
    // chips with counts
    assert.match(body, /All <span class="chip-count">5<\/span>/);
    assert.match(body, /Modmail <span class="chip-count">1<\/span>/);
    // a day old is amber, three days red
    assert.match(body, /class="nowrap bad"/);

    const filtered = await get(h, h.d.inbox.list, { query: { kind: 'modmail' } });
    assert.match(filtered.body, new RegExp(`/dashboard/inbox/modmail/${MODMAIL_CH}`));
    assert.doesNotMatch(filtered.body, /\/dashboard\/appeals\/abc234x/);
    assert.match(filtered.body, /href="\/dashboard\/inbox\?kind=modmail" aria-current="page"/);
});

test('inbox: a source that fails is named, not shown as zero', async () => {
    const h = await setup({ overrides: { listOpenTickets: async () => { throw new Error('db down'); } } });
    const res = await get(h, h.d.inbox.list);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Could not be loaded right now: Tickets/);
});

test('sidebar badge: cached total, refreshed in the background, shown once known', async () => {
    let loads = 0;
    let clock = 0;
    const badge = createInboxBadge({ load: async () => { loads += 1; return 7; }, ttlMs: 1000, now: () => clock });
    assert.equal(badge.peek(), null); // never waits
    await badge.refresh();
    assert.equal(badge.peek(), 7);
    assert.equal(loads, 1);
    clock = 500;
    badge.peek();
    assert.equal(loads, 1, 'still fresh: no reload');
    clock = 1500;
    badge.peek();
    await badge.refresh();
    assert.equal(loads, 2);

    const h = await setup({ inboxBadge: true });
    await get(h, h.d.overview).catch(() => null); // first page: no count yet (refresh started)
    await h.d.badge.refresh();
    const res = await get(h, h.d.inbox.conversation, { params: { kind: 'modmail', id: MODMAIL_CH } });
    assert.match(res.body, /<span class="nav-badge">5<span class="sr"> waiting<\/span><\/span>/);
});

test('conversation page: messages oldest first, escaped, https attachments only; reply and close forms', async () => {
    const h = await setup();
    const res = await get(h, h.d.inbox.conversation, { params: { kind: 'modmail', id: MODMAIL_CH } });
    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.ok(body.indexOf('>first<') < body.indexOf('second'));
    assert.match(body, /second &lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(body, /Admin&lt;b&gt;/);
    assert.match(body, /header &lt;i&gt;/);
    assert.match(body, /href="https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/shot\.png"[^>]*>shot&lt;1&gt;\.png</);
    assert.doesNotMatch(body, /javascript:/);
    assert.match(body, new RegExp(`action="/dashboard/inbox/modmail/${MODMAIL_CH}/reply"`));
    assert.match(body, new RegExp(`action="/dashboard/inbox/modmail/${MODMAIL_CH}/close/preview"`));
    assert.doesNotMatch(body, /style=/);
    assert.doesNotMatch(body, /<script>(?!<\/script>)/);

    // a channel that is not linked as modmail (or not an open ticket) is a 404
    const notLinked = await get(h, h.d.inbox.conversation, { params: { kind: 'modmail', id: TICKET_CH } });
    assert.equal(notLinked.statusCode, 404);
    const badKind = await get(h, h.d.inbox.conversation, { params: { kind: 'report', id: REPORT_CH } });
    assert.equal(badKind.statusCode, 404);
});

test('modmail reply: DMed to the member as "Name (staff)" and copied to the channel, no pings, audited', async () => {
    const h = await setup();
    const res = await post(h, h.d.inbox.reply, { params: { kind: 'modmail', id: MODMAIL_CH }, form: { text: '  Hello @everyone <b>hi</b>  ' } });
    assert.equal(res.statusCode, 303);
    assert.equal(res.redirectedTo, `/dashboard/inbox/modmail/${MODMAIL_CH}`);
    const dm = called(h, 'sendStaffTextToMember');
    assert.equal(dm.length, 1);
    assert.equal(dm[0].args[0].id, MODMAIL_CH);
    assert.equal(dm[0].args[1], 'Admin Display');
    assert.equal(dm[0].args[2], 'Hello @everyone <b>hi</b>');
    const channel = h.channels.get(MODMAIL_CH);
    assert.equal(channel.sent.length, 1);
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    assert.match(channel.sent[0].content, /^\*\*Admin Display \(staff, from the dashboard\):\*\*\nHello @everyone/);
    assert.deepEqual(channel.reactions, ['✅']);
    assert.equal(h.auditRows.length, 1);
    assert.equal(h.auditRows[0].module, 'inbox');
    assert.equal(h.auditRows[0].new.dmDelivered, true);
});

test('modmail reply: a DM that fails is reported in the channel and to the moderator', async () => {
    const h = await setup({ overrides: { sendStaffTextToMember: async () => { throw new Error('Cannot send messages to this user'); } } });
    const res = await post(h, h.d.inbox.reply, { params: { kind: 'modmail', id: MODMAIL_CH }, form: { text: 'hi' } });
    assert.equal(res.statusCode, 303);
    const channel = h.channels.get(MODMAIL_CH);
    assert.deepEqual(channel.reactions, ['❌']);
    assert.match(channel.sent.at(-1).content, /Could not DM the member/);
    assert.equal(h.auditRows[0].new.dmDelivered, false);
    assert.match((await h.sessions.get(h.session.id)).flash, /DM could not be delivered/);
});

test('modmail reply starting with // is an internal note: posted in the channel, never sent to the member', async () => {
    const h = await setup();
    const res = await post(h, h.d.inbox.reply, { params: { kind: 'modmail', id: MODMAIL_CH }, form: { text: '// checked their history' } });
    assert.equal(res.statusCode, 303);
    assert.equal(called(h, 'sendStaffTextToMember').length, 0);
    const channel = h.channels.get(MODMAIL_CH);
    assert.equal(channel.sent.length, 1);
    assert.match(channel.sent[0].content, /internal note, from the dashboard\):\*\*\n\/\/ checked their history/);
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    assert.equal(h.auditRows[0].new.note, true);
});

test('ticket reply: posted in the ticket channel, no DM path', async () => {
    const h = await setup();
    const res = await post(h, h.d.inbox.reply, { params: { kind: 'ticket', id: TICKET_CH }, form: { text: 'We are on it <@&123>' } });
    assert.equal(res.statusCode, 303);
    assert.equal(called(h, 'sendStaffTextToMember').length, 0);
    const channel = h.channels.get(TICKET_CH);
    assert.equal(channel.sent.length, 1);
    assert.match(channel.sent[0].content, /We are on it <@&123>/);
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
});

test('reply: empty or too long is refused and nothing is sent', async () => {
    const h = await setup();
    const empty = await post(h, h.d.inbox.reply, { params: { kind: 'modmail', id: MODMAIL_CH }, form: { text: '   ' } });
    assert.equal(empty.statusCode, 400);
    const long = await post(h, h.d.inbox.reply, { params: { kind: 'modmail', id: MODMAIL_CH }, form: { text: 'x'.repeat(4001) } });
    assert.equal(long.statusCode, 400);
    assert.equal(h.channels.get(MODMAIL_CH).sent.length, 0);
    assert.equal(called(h, 'sendStaffTextToMember').length, 0);
});

test('close needs the confirm step: preview → single-use token → closeModmail / closeTicket', async () => {
    const h = await setup();
    const params = { kind: 'modmail', id: MODMAIL_CH };
    // without a token: refused, nothing closed
    const noToken = await post(h, h.d.inbox.close, { params, form: {} });
    assert.equal(noToken.statusCode, 400);
    assert.equal(called(h, 'closeModmail').length, 0);
    // preview: the confirm page, nothing closed yet
    const preview = await post(h, h.d.inbox.closePreview, { params, form: { reason: 'solved <b>' } });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.body, /Confirm: close the modmail conversation/);
    assert.match(preview.body, /solved &lt;b&gt;/);
    assert.equal(called(h, 'closeModmail').length, 0);
    const form = { token: hidden(preview.body, 'token'), fh: hidden(preview.body, 'fh') };
    // a token for this conversation does not close another
    const wrong = await post(h, h.d.inbox.close, { params: { kind: 'ticket', id: TICKET_CH }, form });
    assert.equal(wrong.statusCode, 400);
    assert.equal(called(h, 'closeTicket').length, 0);
    // the token was used up by the wrong attempt: preview again
    const again = await post(h, h.d.inbox.closePreview, { params, form: { reason: 'solved' } });
    const form2 = { token: hidden(again.body, 'token'), fh: hidden(again.body, 'fh') };
    const ok = await post(h, h.d.inbox.close, { params, form: form2 });
    assert.equal(ok.statusCode, 303);
    assert.equal(ok.redirectedTo, '/dashboard/inbox?kind=modmail');
    const closes = called(h, 'closeModmail');
    assert.equal(closes.length, 1);
    assert.equal(closes[0].args[0].id, MODMAIL_CH);
    assert.equal(closes[0].args[1].id, ADMIN);
    assert.equal(closes[0].args[2], 'solved');
    assert.equal(h.auditRows.at(-1).new.closed, true);
    // reused token: refused
    const reuse = await post(h, h.d.inbox.close, { params, form: form2 });
    assert.equal(reuse.statusCode, 400);
    assert.equal(called(h, 'closeModmail').length, 1);

    // tickets close through the ticket service
    const t = await post(h, h.d.inbox.closePreview, { params: { kind: 'ticket', id: TICKET_CH }, form: {} });
    const tf = { token: hidden(t.body, 'token'), fh: hidden(t.body, 'fh') };
    const tok = await post(h, h.d.inbox.close, { params: { kind: 'ticket', id: TICKET_CH }, form: tf });
    assert.equal(tok.statusCode, 303);
    assert.equal(called(h, 'closeTicket').length, 1);
    assert.equal(called(h, 'closeTicket')[0].args[2], 'Closed from the dashboard');
});

test('non-admins are refused: owner without Administrator, lost Administrator, no CSRF, editing off', async () => {
    const params = { kind: 'modmail', id: MODMAIL_CH };
    // bot owner without Administrator: can read, cannot reply or close
    const owner = await setup({ userId: OWNER });
    const page = await get(owner, owner.d.inbox.conversation, { params });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Replying needs Administrator/);
    assert.equal((await post(owner, owner.d.inbox.reply, { params, form: { text: 'hi' } })).statusCode, 403);
    assert.equal((await post(owner, owner.d.inbox.closePreview, { params, form: {} })).statusCode, 403);
    assert.equal(called(owner, 'sendStaffTextToMember').length, 0);
    assert.equal(owner.channels.get(MODMAIL_CH).sent.length, 0);

    // access cache says admin, but the freshly fetched member is not: refused
    const stale = await setup();
    stale.guild.members.fetch = async (arg) => ({ id: typeof arg === 'string' ? arg : arg?.user, guild: stale.guild, permissions: { has: () => false } });
    assert.equal((await post(stale, stale.d.inbox.reply, { params, form: { text: 'hi' } })).statusCode, 403);
    assert.equal(stale.channels.get(MODMAIL_CH).sent.length, 0);

    // no CSRF token
    const h = await setup();
    assert.equal((await post(h, h.d.inbox.reply, { params, form: { text: 'hi' }, csrf: null })).statusCode, 403);
    // editing off
    const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    assert.equal((await post(off, off.d.inbox.reply, { params, form: { text: 'hi' } })).statusCode, 403);
    assert.equal(called(h, 'sendStaffTextToMember').length + called(off, 'sendStaffTextToMember').length, 0);

    // not an admin and not an owner: no dashboard at all
    const nobody = await setup({ userId: MEMBER });
    const res = await get(nobody, nobody.d.inbox.list);
    assert.equal(res.statusCode, 403);
});
