// Fix permissions: the picker marks channels where Mewvo lacks what a feature needs (before
// saving), planPermissionFix / fixBotChannelPermissions give Mewvo only the missing bits its own
// role has (a member overwrite), and /dashboard/fix-permissions is a confirm page + an
// Administrator-only POST (CSRF, Origin, editing switch, one-time token, audit + log).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import { createDashboard, dashboardSettings } from '../src/services/dashboard/routes.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import { SESSION_COOKIE, signValue } from '../src/services/dashboard/security.js';
import { PERMS, channelPicker, fixPermissionsLink, missingChannelPerms } from '../src/services/dashboard/forms.js';
import { allows, routeKey } from '../src/services/dashboard/permissions.js';
import { blockedReason, fixBotChannelPermissions, manualFixSteps, planPermissionFix } from '../src/services/channelToolsService.js';
import { backPathOf, parseNeed } from '../src/services/dashboard/permissionFixRoutes.js';

const SECRET = 'y'.repeat(64);
const GUILD = '100000000000000001';
const ADMIN = '200000000000000002';
const OWNER = '200000000000000003';
const BOT = '400000000000000009';
const TEXT = '500000000000000001';
const OK = '500000000000000002';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: `${ORIGIN}/`, MAIN_GUILD_ID: GUILD, NODE_ENV: 'test',
};
const F = PermissionFlagsBits;
const bits = (names) => new Set(names.map((n) => F[n]));

/**
 * A guild with #general (TEXT: Mewvo lacks `channelLacks` there) and #ok (everything).
 * `server`: the bits Mewvo's roles have in the server. Overwrite edits are recorded.
 */
function makeGuild({ channelLacks = ['SendMessages', 'EmbedLinks'], server = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ManageRoles'], editError = null } = {}) {
    const guild = { id: GUILD, name: 'Main' };
    const edits = [];
    const lacks = { [TEXT]: bits(channelLacks), [OK]: new Set() };
    const ch = (id, name) => ({
        id, name, type: 0, parentId: null, rawPosition: 0, guild, toString: () => `<#${id}>`,
        permissionOverwrites: {
            edit: async (target, patch, options) => {
                if (editError) throw editError;
                edits.push({ target, patch, options });
                // The overwrite takes effect: those bits are no longer missing.
                for (const [name, on] of Object.entries(patch)) if (on) lacks[id].delete(F[name]);
            },
        },
    });
    guild.channels = { cache: new Map([[TEXT, ch(TEXT, 'general')], [OK, ch(OK, 'ok')]]) };
    guild.roles = { cache: new Map([[GUILD, { id: GUILD, name: '@everyone', position: 0 }]]) };
    const serverBits = bits(server);
    guild.members = {
        me: {
            id: BOT,
            permissionsIn: (channel) => ({ has: (bit) => !lacks[channel.id]?.has(bit) }),
            permissions: { has: (bit) => serverBits.has(bit) },
            roles: { highest: { position: 10 } },
        },
    };
    return { guild, edits, lacks };
}

// ── the picker helper ─────────────────────────────────────────────────────

test('missingChannelPerms: the names Mewvo lacks; null when it cannot be checked', () => {
    const { guild } = makeGuild();
    const channel = guild.channels.cache.get(TEXT);
    assert.deepEqual(missingChannelPerms(guild, channel, PERMS.post), ['SendMessages', 'EmbedLinks']);
    assert.deepEqual(missingChannelPerms(guild, channel, PERMS.text), ['SendMessages'], 'plain text never asks for Embed Links');
    assert.deepEqual(missingChannelPerms(guild, guild.channels.cache.get(OK), PERMS.post), []);
    assert.equal(missingChannelPerms({ ...guild, members: {} }, channel, PERMS.post), null);
});

test('channelPicker: marks channels before saving; the chosen one gets Fix permissions; text escaped', () => {
    const { guild } = makeGuild();
    guild.channels.cache.get(OK).name = '<b>ok';
    const empty = String(channelPicker(guild, 'channelId', null, { label: 'Channel', perms: PERMS.post }));
    assert.match(empty, /<option value="500000000000000001">#general \(Mewvo lacks: Send Messages, Embed Links\)<\/option>/);
    assert.match(empty, /<option value="500000000000000002">#&lt;b&gt;ok<\/option>/, 'a fine channel is not marked; names escaped');
    assert.match(empty, /needs more permissions before this works there/);
    assert.doesNotMatch(empty, /fix-link/, 'nothing chosen: no link yet');
    const chosen = String(channelPicker(guild, 'channelId', TEXT, { label: 'Channel', perms: PERMS.post }));
    assert.match(chosen, /class="field-warn">I am missing Send Messages, Embed Links in #general\. To fix it, allow them for Mewvo&#39;s role in Edit Channel → Permissions, or pick another channel <a class="fix-link" href="\/dashboard\/fix-permissions\?channel=500000000000000001&amp;need=SendMessages%2CEmbedLinks">Fix permissions<\/a>/);
    const fine = String(channelPicker(guild, 'channelId', OK, { label: 'Channel', perms: PERMS.text }));
    assert.doesNotMatch(fine, /fix-link|field-warn/, 'the chosen channel is fine: no warning, no link');
    assert.match(fine, /<option value="500000000000000002" selected>#&lt;b&gt;ok<\/option>/);
    assert.equal(String(fixPermissionsLink('not-an-id', ['SendMessages'])), '');
    assert.equal(String(fixPermissionsLink(TEXT, ['Administrator'])), '', 'unknown permission names are dropped');
});

// ── the plan and the change ───────────────────────────────────────────────

test('planPermissionFix: gives only missing bits its own role has; management bits and editing rights reported', () => {
    let { guild } = makeGuild({ channelLacks: ['SendMessages', 'EmbedLinks', 'AttachFiles', 'ManageChannels'], server: ['SendMessages', 'EmbedLinks', 'ManageRoles'] });
    let plan = planPermissionFix(guild, guild.channels.cache.get(TEXT), [...PERMS.postFiles, 'ManageChannels']);
    assert.deepEqual(plan.missing, ['SendMessages', 'EmbedLinks', 'AttachFiles', 'ManageChannels']);
    assert.deepEqual(plan.grantable, ['SendMessages', 'EmbedLinks']);
    assert.deepEqual(plan.notInServer, ['AttachFiles']);
    assert.deepEqual(plan.notFixable, ['ManageChannels']);
    assert.deepEqual(plan.cannotEdit, []);
    ({ guild } = makeGuild({ channelLacks: ['SendMessages', 'ManageRoles'] }));
    plan = planPermissionFix(guild, guild.channels.cache.get(TEXT), PERMS.post);
    assert.deepEqual(plan.cannotEdit, ['ManageRoles']);
    assert.deepEqual(plan.grantable, [], 'cannot edit the channel: nothing to give');
    const steps = manualFixSteps(guild.channels.cache.get(TEXT), plan).join(' ');
    assert.match(steps, /Server Settings → Roles → Mewvo, turn on Manage Roles/);
    assert.match(steps, /right-click #general → Edit Channel → Permissions → add Mewvo, turn on Send Messages/);

    // Mewvo cannot see the channel: Discord gives it nothing else there, so it cannot fix it itself.
    let lacks;
    ({ guild, lacks } = makeGuild({ channelLacks: ['ViewChannel', 'SendMessages'] }));
    plan = planPermissionFix(guild, guild.channels.cache.get(TEXT), PERMS.post);
    assert.equal(plan.blockedBy, 'hidden');
    assert.deepEqual(plan.grantable, []);
    assert.match(blockedReason(guild.channels.cache.get(TEXT), plan), /cannot see #general/);

    // A thread has no overwrites of its own: never offered, the steps point at the parent channel.
    const thread = { id: '500000000000000077', name: 'help-thread', type: 11, isThread: () => true };
    lacks[thread.id] = new Set([F.SendMessages]);
    plan = planPermissionFix(guild, thread, PERMS.text);
    assert.equal(plan.blockedBy, 'thread');
    assert.deepEqual(plan.grantable, []);
    assert.match(manualFixSteps(thread, plan).join(' '), /right-click #the parent channel/);
});

test('fixBotChannelPermissions: a member overwrite for Mewvo with only the grantable bits, logged; refusals change nothing', async () => {
    const { guild, edits } = makeGuild({ channelLacks: ['SendMessages', 'EmbedLinks', 'AttachFiles'], server: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ManageRoles'] });
    const logs = [];
    const channel = guild.channels.cache.get(TEXT);
    const result = await fixBotChannelPermissions({
        client: {}, guild, channel, wanted: PERMS.postFiles, moderator: { id: ADMIN, tag: 'admin' }, auditReason: 'Dashboard (admin): Fix permissions', log: async (e) => logs.push(e),
    });
    assert.equal(edits.length, 1);
    assert.equal(edits[0].target, guild.members.me, "Mewvo's own member");
    assert.deepEqual(edits[0].patch, { SendMessages: true, EmbedLinks: true }, 'never more than what is missing and grantable');
    assert.deepEqual(edits[0].options, { type: OverwriteType.Member, reason: 'Dashboard (admin): Fix permissions' });
    assert.deepEqual(result.granted, ['Send Messages', 'Embed Links']);
    assert.deepEqual(result.stillMissing, ['Attach Files']);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event.action, 'Channel Permissions Fixed');
    assert.deepEqual(logs[0].event.metadata.granted, ['SendMessages', 'EmbedLinks']);

    // Nothing missing any more → refused, no second edit.
    await assert.rejects(fixBotChannelPermissions({ client: {}, guild, channel, wanted: PERMS.post, moderator: { id: ADMIN, tag: 'a' }, log: async () => {} }), /already has what it needs/);
    assert.equal(edits.length, 1);

    // No Manage Permissions in the channel → the Discord steps, nothing edited, nothing logged.
    const noManage = makeGuild({ channelLacks: ['SendMessages', 'ManageRoles'] });
    const noLogs = [];
    await assert.rejects(
        fixBotChannelPermissions({ client: {}, guild: noManage.guild, channel: noManage.guild.channels.cache.get(TEXT), wanted: PERMS.post, moderator: { id: ADMIN, tag: 'a' }, log: async (e) => noLogs.push(e) }),
        (e) => e.type === 'permission' && /cannot change permissions in #general/.test(e.userMessage) && /Server Settings → Roles → Mewvo/.test(e.userMessage),
    );
    assert.equal(noManage.edits.length, 0);
    assert.equal(noLogs.length, 0);

    // The bit is missing from Mewvo's own role → it cannot give it to itself.
    const noRole = makeGuild({ channelLacks: ['EmbedLinks'], server: ['ViewChannel', 'SendMessages', 'ManageRoles'] });
    await assert.rejects(
        fixBotChannelPermissions({ client: {}, guild: noRole.guild, channel: noRole.guild.channels.cache.get(TEXT), wanted: PERMS.post, moderator: { id: ADMIN, tag: 'a' }, log: async () => {} }),
        (e) => e.type === 'permission' && /cannot give itself Embed Links/.test(e.userMessage),
    );
    assert.equal(noRole.edits.length, 0);

    // Discord says no (50013) → a readable refusal with the steps.
    const refused = makeGuild({ editError: Object.assign(new Error('Missing Permissions'), { code: 50013 }) });
    await assert.rejects(
        fixBotChannelPermissions({ client: {}, guild: refused.guild, channel: refused.guild.channels.cache.get(TEXT), wanted: PERMS.post, moderator: { id: ADMIN, tag: 'a' }, log: async () => {} }),
        (e) => e.type === 'permission' && /Discord refused the change/.test(e.userMessage),
    );
});

test('parseNeed and backPathOf: known permission names only; back stays on the dashboard', () => {
    assert.deepEqual(parseNeed('SendMessages,EmbedLinks,Administrator,BanMembers'), ['SendMessages', 'EmbedLinks']);
    assert.deepEqual(parseNeed(''), PERMS.post);
    assert.deepEqual(parseNeed(['SendMessages']), PERMS.post, 'arrays are not strings');
    assert.equal(backPathOf({ query: { back: '/dashboard/messages' }, headers: {} }, ORIGIN), '/dashboard/messages');
    assert.equal(backPathOf({ query: { back: 'https://evil.example/' }, headers: {} }, ORIGIN), '/dashboard/channels');
    assert.equal(backPathOf({ query: {}, headers: { referer: `${ORIGIN}/dashboard/logging?x=1` } }, ORIGIN), '/dashboard/logging?x=1');
    assert.equal(backPathOf({ query: {}, headers: { referer: 'https://evil.example/dashboard/logging' } }, ORIGIN), '/dashboard/channels');
    assert.equal(backPathOf({ query: { back: '//evil.example/dashboard' }, headers: {} }, ORIGIN), '/dashboard/channels');
});

// ── the routes ────────────────────────────────────────────────────────────

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

async function setup({ userId = ADMIN, env = ENV, guildOpts = {} } = {}) {
    const g = makeGuild(guildOpts);
    const client = { user: { id: BOT }, guilds: { cache: new Map([[GUILD, g.guild]]) } };
    const sessions = createMemorySessionStore();
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: id === ADMIN, isOwnerId: id === OWNER }) });
    const auditRows = [];
    const modLog = [];
    const logs = [];
    const services = {
        fixBotChannelPermissions: (args) => fixBotChannelPermissions({ ...args, log: async (e) => logs.push(e) }),
        postModLog: async (c, kind, files, payload) => modLog.push(payload),
    };
    const auditStore = { writeRows: async (guildId, actor, module, changes) => { for (const c of changes) auditRows.push({ actor, module, ...c }); return changes.length; } };
    const d = createDashboard({ client, settings: dashboardSettings(env), sessions, access, services, auditStore, env, data: { overview: {} } });
    const session = await sessions.create({ userId, username: userId === OWNER ? 'owner' : 'admin' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, g, sessions, session, cookie, auditRows, modLog, logs };
}

async function run(h, handler, req) {
    const res = fakeRes();
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (passed) await handler(req, res, () => { res.fellThrough = true; });
    return res;
}

const getPage = (h, query = { channel: TEXT, need: 'ViewChannel,SendMessages,EmbedLinks', back: '/dashboard/messages' }) => run(h, h.d.permissionFix.page, {
    method: 'GET', path: '/fix-permissions', query, headers: { cookie: h.cookie },
});
const postFix = (h, form, { origin = ORIGIN, csrf = h.session.csrf } = {}) => run(h, h.d.permissionFix.apply, {
    method: 'POST', path: '/fix-permissions', query: {}, headers: { cookie: h.cookie, ...(origin ? { origin } : {}) }, body: { ...(csrf === null ? {} : { csrf }), ...form },
});
const tokenOf = (body) => ({
    token: /name="token" value="([^"]+)"/.exec(body)?.[1], fh: /name="fh" value="([^"]+)"/.exec(body)?.[1],
});

test('fix-permissions routes are Administrator-only in the permission table', () => {
    assert.equal(routeKey('GET', '/fix-permissions'), 'permissions.fix');
    assert.equal(routeKey('POST', '/fix-permissions'), 'permissions.fix');
    assert.equal(allows({ role: 'moderator', allowed: true }, 'permissions.fix'), false);
    assert.equal(allows({ role: 'admin', allowed: true, canAct: true }, 'permissions.fix'), true);
});

test('GET: the confirm page lists what Mewvo will give itself and changes nothing', async () => {
    const h = await setup();
    const res = await getPage(h);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Fix Mewvo&#39;s permissions in #general|Fix Mewvo's permissions in #general/);
    assert.match(res.body, /<dt>Missing<\/dt><dd>Send Messages, Embed Links<\/dd>/);
    assert.match(res.body, /<dt>Mewvo will give itself<\/dt><dd>Send Messages, Embed Links<\/dd>/);
    assert.match(res.body, /Give Mewvo these permissions/);
    assert.match(res.body, /href="\/dashboard\/messages">← Back \(cancel\)/);
    assert.ok(tokenOf(res.body).token, 'a one-time token on the form');
    assert.equal(h.g.edits.length, 0);
    assert.equal((await getPage(h, { channel: '999999999999999999' })).statusCode, 404);
});

test('POST: CSRF, Origin, Administrator and the token are checked; nothing changes on a refusal', async () => {
    const h = await setup();
    const { token, fh } = tokenOf((await getPage(h)).body);
    const form = { channel: TEXT, token, fh, back: '/dashboard/messages' };
    assert.equal((await postFix(h, form, { csrf: null })).statusCode, 403, 'no CSRF token');
    assert.equal((await postFix(h, form, { csrf: 'wrong' })).statusCode, 403, 'wrong CSRF token');
    assert.equal((await postFix(h, form, { origin: 'https://evil.example' })).statusCode, 403, 'other origin');
    assert.equal(h.g.edits.length, 0);

    // OWNER_IDS without Administrator: may see the page (no form), never change it.
    const o = await setup({ userId: OWNER });
    const ownerPage = await getPage(o);
    assert.equal(ownerPage.statusCode, 200);
    assert.match(ownerPage.body, /Only members with the Administrator permission/);
    assert.doesNotMatch(ownerPage.body, /Give Mewvo these permissions/);
    const ownerPost = await postFix(o, { channel: TEXT, token: 'x', fh: 'y' });
    assert.equal(ownerPost.statusCode, 403);
    assert.equal(o.g.edits.length, 0);

    // Editing off: refused.
    const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    assert.equal((await postFix(off, { channel: TEXT, token: 'x', fh: 'y' })).statusCode, 403);

    // A made-up token: refused with the page again, nothing changed.
    const fake = await postFix(h, { ...form, token: 'made-up' });
    assert.equal(fake.statusCode, 400);
    assert.match(fake.body, /expired or was already used/);
    assert.equal(h.g.edits.length, 0);
});

test('POST: the overwrite is added, audited, logged, flashed; the token works once', async () => {
    const h = await setup();
    const { token, fh } = tokenOf((await getPage(h)).body);
    const res = await postFix(h, { channel: TEXT, token, fh, back: '/dashboard/messages' });
    assert.equal(res.statusCode, 303);
    assert.equal(res.redirectedTo, '/dashboard/messages');
    assert.equal(h.g.edits.length, 1);
    assert.deepEqual(h.g.edits[0].patch, { SendMessages: true, EmbedLinks: true });
    assert.equal(h.logs.length, 1, 'mod log line through loggingService');
    assert.equal(h.auditRows.length, 1);
    assert.equal(h.auditRows[0].key, `permissions.${TEXT}`);
    assert.deepEqual(h.auditRows[0].new.granted, ['SendMessages', 'EmbedLinks']);
    assert.equal(h.modLog.length, 1);
    assert.match((await h.sessions.get(h.session.id)).flash, /Mewvo now has Send Messages, Embed Links in #general\./);
    const again = await postFix(h, { channel: TEXT, token, fh, back: '/dashboard/messages' });
    assert.equal(again.statusCode, 400, 'a token works once');
    assert.equal(h.g.edits.length, 1);
});

test('POST: Mewvo lacks Manage Permissions → no form; a forced POST is refused with the Discord steps', async () => {
    const h = await setup({ guildOpts: { channelLacks: ['SendMessages', 'ManageRoles'] } });
    const res = await getPage(h);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Why Mewvo can&#39;t fix it|Why Mewvo can't fix it/);
    assert.match(res.body, /What to do in Discord/);
    assert.match(res.body, /Server Settings → Roles → Mewvo, turn on Manage Roles/);
    assert.doesNotMatch(res.body, /Give Mewvo these permissions/, 'nothing Mewvo can give: no form');
    assert.equal(tokenOf(res.body).token, undefined);

    // The permission is taken away between the page and the POST: the change is refused.
    const ok = await setup();
    const { token, fh } = tokenOf((await getPage(ok)).body);
    ok.g.lacks[TEXT].add(F.ManageRoles);
    const refused = await postFix(ok, { channel: TEXT, token, fh, back: '/dashboard/messages' });
    assert.equal(refused.statusCode, 403);
    assert.match(refused.body, /cannot change permissions in #general/);
    assert.equal(ok.g.edits.length, 0);
    assert.equal(ok.auditRows.length, 0);
    assert.equal(ok.logs.length, 0);
});

// ── slash commands: announcement channels where the bot only posts ───────────

test('posting channel options accept announcement channels (/logging channel, welcome, goodbye, level, birthday, report, giveaway)', async () => {
    const { ChannelType } = await import('discord.js');
    const optionTypes = (json, path) => {
        let node = json;
        for (const name of path) node = node.options.find((o) => o.name === name);
        return node.channel_types;
    };
    const cases = [
        ['../src/commands/Logging/logging.js', ['channel', 'channel']],
        ['../src/commands/Welcome/welcome.js', ['setup', 'channel']],
        ['../src/commands/Welcome/goodbye.js', ['setup', 'channel']],
        ['../src/commands/Leveling/level.js', ['setup', 'channel']],
        ['../src/commands/Birthday/birthday.js', ['setchannel', 'channel']],
        ['../src/commands/Utility/report.js', ['setchannel', 'channel']],
    ];
    for (const [file, path] of cases) {
        const { default: command } = await import(file);
        const types = optionTypes(command.data.toJSON(), path);
        assert.ok(types.includes(ChannelType.GuildText) && types.includes(ChannelType.GuildAnnouncement), `${file} ${path.join(' ')}`);
    }
});
