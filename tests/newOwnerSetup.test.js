// newOwnerSetup.test.js — where a new owner gets stuck (audit 2026-11-05): Mewvo's permissions
// card, the new checklist steps, the failed staff post recorder, the admin refusal per server
// and the inline setup step forms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';
const MAIN = process.env.MAIN_GUILD_ID;
const SUPPORT = process.env.SUPPORT_GUILD_ID;

const { botPermissionReport, rolesToCheck, PERMISSION_NAMES } = await import('../src/services/dashboard/botPermissions.js');
const { gettingStarted, hasSupportServer, overviewPage, permissionsList } = await import('../src/services/dashboard/overview.js');
const failures = await import('../src/services/automod/postFailures.js');
const { getAdminRequiredMessage, checkCommandAccess } = await import('../src/utils/commandGate.js');
const { enforcementConfig } = await import('../src/config/enforcement.js');
const { setupPage, stepNumber } = await import('../src/services/dashboard/helpPages.js');
const { setupStepForm } = await import('../src/services/dashboard/setupForms.js');
const { dashboardText } = await import('../src/services/dashboard/language.js');

/** A guild whose bot member has exactly `granted` (names) and a top role at `top`. */
function guildWith(granted, { top = 5, roles = [] } = {}) {
    const set = new Set(granted.map((n) => PermissionFlagsBits[n]));
    const guild = { id: MAIN, name: 'Main' };
    guild.roles = { cache: new Map(roles.map((r) => [r.id, r])) };
    guild.members = { me: { permissions: { has: (bit) => set.has(bit) }, roles: { highest: { id: 'botrole', name: 'Mewvo <b>', position: top } } } };
    return guild;
}

// ── Mewvo's permissions ───────────────────────────────────────────────────

test('permission report: what the enabled features need, missing ones named, roles above Mewvo flagged', () => {
    const all = guildWith(PERMISSION_NAMES);
    const ok = botPermissionReport(all, { moduleStates: { logging: true, tickets: true } });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.missing, []);
    assert.ok(ok.permissions.find((p) => p.name === 'ViewAuditLog').features.includes('logging'));

    const some = guildWith(['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'KickMembers']);
    const report = botPermissionReport(some, { moduleStates: { automod: false, logging: false, tickets: false, leveling: false, verification: false } });
    assert.equal(report.ok, false);
    assert.ok(report.missing.includes('BanMembers') && report.missing.includes('ManageRoles'));
    assert.ok(!report.permissions.some((p) => p.name === 'ManageGuild'), 'automod off: Manage Server is not asked for');
    assert.ok(!report.permissions.some((p) => p.name === 'ViewAuditLog'), 'logging and automod off: no audit log');
    // Automod has no saved state: it counts as on (its default).
    assert.ok(botPermissionReport(some, {}).permissions.some((p) => p.name === 'ManageGuild'));

    const muted = { id: 'm1', name: 'Muted', position: 7 };
    const warn = { id: 'w1', name: 'Warned', position: 2 };
    const g = guildWith(PERMISSION_NAMES, { top: 5, roles: [muted, warn] });
    const roles = rolesToCheck(g, { mutedRoleId: 'm1', warnRoleIds: ['w1', 'gone'] });
    assert.equal(roles.length, 2, 'a missing role is skipped');
    const high = botPermissionReport(g, { roles });
    assert.equal(high.ok, false);
    assert.deepEqual(high.roles.map((r) => r.name), ['Muted'], 'only the role at or above Mewvo');
    assert.equal(high.botRole, 'Mewvo <b>');

    assert.equal(botPermissionReport({ members: {} }), null, 'no bot member: cannot check');
    assert.equal(botPermissionReport(null), null);
});

test('permission list: ✓ or missing with a fix line, role position line, escaped; all fine folds away', () => {
    const tr = dashboardText('en');
    const report = botPermissionReport(guildWith(['ViewChannel'], { roles: [{ id: 'm', name: 'Muted <i>', position: 9 }] }), {
        roles: [{ role: { id: 'm', name: 'Muted <i>', position: 9 }, purpose: 'muted' }],
    });
    const out = String(permissionsList(report, tr));
    assert.match(out, /<b>Ban Members<\/b> <span class="bad">missing<\/span>/);
    assert.match(out, /To fix it: Server Settings → Roles → Mewvo &lt;b&gt; → turn on Ban Members\./);
    assert.match(out, /<b>View Channels<\/b> <span class="ok-text">on<\/span>/);
    assert.match(out, /Move Mewvo&#39;s role above @Muted &lt;i&gt;/);
    assert.ok(!out.includes('<i>') && !out.includes('<b>Mewvo'), 'names are escaped');
    assert.ok(out.indexOf('Ban Members') < out.indexOf('View Channels'), 'missing ones first');
    const fine = String(permissionsList(botPermissionReport(guildWith(PERMISSION_NAMES)), tr));
    assert.match(fine, /Mewvo has every permission it needs\./);
    assert.match(fine, /<details class="sub" data-key="bot-perms"><summary>Show the list<\/summary>/);
    assert.match(String(permissionsList(null, tr)), /could not be checked/);
    // Another language names the permissions in that language.
    assert.match(String(permissionsList(report, dashboardText('de'))), /Mitglieder bannen/);
});

// ── Getting started ───────────────────────────────────────────────────────

const BASE = { config: {}, welcome: null, settings: {}, mutedRole: null };
const keys = (items) => items.map((i) => i.key);

test('checklist: permissions first, then mod log, main log channel and moderator role; support steps only with a support server', () => {
    const report = { ok: false, missing: ['BanMembers'], roles: [], permissions: [] };
    const items = gettingStarted({ ...BASE, permissions: report, appealPanel: null, supportServer: true });
    assert.deepEqual(keys(items).slice(0, 4), ['permissions', 'modLog', 'logChannel', 'modRole']);
    assert.ok(keys(items).includes('appealPanel') && keys(items).includes('bannedRole'));
    assert.equal(items[0].done, false);
    assert.equal(items[0].href, '/dashboard/setup?step=permissions');
    assert.equal(items[0].report, report, 'the setup page shows the same report');

    const none = gettingStarted({ ...BASE });
    assert.ok(!keys(none).includes('permissions'), 'not checkable: no line');
    assert.ok(!keys(none).includes('bannedRole'), 'no support server: no banned role step');
    assert.ok(!keys(none).includes('appealPanel'));
    assert.ok(!keys(gettingStarted({ ...BASE, supportServer: true })).includes('appealPanel'), 'unreadable posting: left out');

    const done = gettingStarted({
        ...BASE, permissions: { ok: true }, appealPanel: { at: '2026-11-01T00:00:00Z' }, supportServer: true,
        config: { logging: { channels: { audit: '5' } }, modRole: { id: '7' } },
    });
    for (const key of ['permissions', 'logChannel', 'modRole', 'appealPanel']) assert.equal(done.find((i) => i.key === key).done, true, key);
    assert.equal(gettingStarted({ ...BASE, config: { modRole: '7' } }).find((i) => i.key === 'modRole').done, true, 'a plain id counts too');

    assert.equal(hasSupportServer(MAIN, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT }), true);
    assert.equal(hasSupportServer(MAIN, { MAIN_GUILD_ID: MAIN }), false, 'no support server configured');
    assert.equal(hasSupportServer('999', { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT }), false, 'not the home server');
});

test('every new checklist label exists in all 8 languages', () => {
    for (const lang of ['en', 'ru', 'de', 'fr', 'it', 'pl', 'es', 'pt-BR']) {
        const items = gettingStarted({ ...BASE, permissions: { ok: true }, appealPanel: null, supportServer: true }, dashboardText(lang));
        for (const item of items) assert.ok(item.label && !item.label.startsWith('overview.'), `${lang}: ${item.key}`);
    }
});

// ── Failed staff posts ────────────────────────────────────────────────────

test('post failures: counted per day, bounded, cleared by a working post, newest first', () => {
    failures.resetPostFailures();
    const day = Date.UTC(2026, 10, 7, 10);
    failures.recordPostFailure({ guildId: MAIN, purpose: 'modlog', channelId: 'c1', channelName: 'mod-log', reason: 'perms', missing: ['SendMessages'], now: day });
    failures.recordPostFailure({ guildId: MAIN, purpose: 'modlog', channelId: 'c1', reason: 'perms', missing: ['SendMessages'], now: day + 1000 });
    failures.recordPostFailure({ guildId: MAIN, purpose: 'modlog', channelId: 'c1', reason: 'perms', missing: ['SendMessages'], now: day + 2000 });
    failures.recordPostFailure({ guildId: MAIN, purpose: 'alerts', reason: 'notSet', now: day + 3000 });
    let list = failures.listPostFailures(MAIN, day + 5000);
    assert.equal(list.length, 2);
    assert.equal(list[0].purpose, 'alerts', 'newest first');
    assert.equal(list[1].count, 3);
    assert.equal(list[1].channelName, 'mod-log', 'the name is kept');
    assert.deepEqual(failures.listPostFailures('other-guild', day), []);
    assert.deepEqual(failures.listPostFailures(MAIN, day + 86_400_000), [], 'yesterday is not today');
    failures.recordPostFailure({ guildId: MAIN, purpose: 'modlog', channelId: 'c1', reason: 'perms', now: day + 86_400_000 });
    assert.equal(failures.listPostFailures(MAIN, day + 86_400_000)[0].count, 1, 'a new day starts at 1');

    failures.clearPostFailures(MAIN, 'modlog');
    list = failures.listPostFailures(MAIN, day + 5000);
    assert.deepEqual(list.map((f) => f.purpose), ['alerts']);

    failures.resetPostFailures();
    for (let i = 0; i < failures.MAX_ENTRIES + 20; i += 1) failures.recordPostFailure({ guildId: MAIN, purpose: 'modlog', channelId: `c${i}`, reason: 'missing', now: day + i });
    list = failures.listPostFailures(MAIN, day + 999);
    assert.equal(list.length, failures.MAX_ENTRIES, 'bounded');
    assert.ok(!list.some((f) => f.channelId === 'c0'), 'the oldest went first');
    failures.recordPostFailure({ guildId: null, purpose: 'modlog', reason: 'notSet' });
    assert.equal(failures.listPostFailures(MAIN, day + 999).length, failures.MAX_ENTRIES, 'no guild: ignored');
    failures.resetPostFailures();
});

test('a refused send names the missing permissions; other errors are "refused"', () => {
    failures.resetPostFailures();
    const now = Date.UTC(2026, 10, 7, 12);
    const channel = { id: 'c9', name: 'mod-log', guild: { members: { me: {} } }, permissionsFor: () => ({ has: (bit) => bit === PermissionFlagsBits.ViewChannel }) };
    failures.recordSendError({ guildId: MAIN, purpose: 'modlog', channel, error: { code: 50013 }, now });
    failures.recordSendError({ guildId: MAIN, purpose: 'alerts', channel, error: { code: 500 }, now: now + 1 });
    const [other, perms] = failures.listPostFailures(MAIN, now + 2);
    assert.equal(perms.reason, 'perms');
    assert.deepEqual(perms.missing, ['SendMessages', 'EmbedLinks']);
    assert.equal(other.reason, 'other');
    failures.recordSendError({ guildId: MAIN, purpose: 'review', channel: { id: 'x', name: 'x' }, error: { code: 50001 }, now });
    assert.deepEqual(failures.listPostFailures(MAIN, now + 3).find((f) => f.purpose === 'review').missing, ['ViewChannel'], 'Missing Access: cannot see it');
    failures.resetPostFailures();
});

test('postModLog and postAlert record a missing channel and a refused post, and clear after a working one', async () => {
    failures.resetPostFailures();
    const { postModLog } = await import('../src/services/enforcement/enforcementService.js');
    const { postAlert } = await import('../src/services/automod/alertPost.js');
    const { automodConfig } = await import('../src/config/automod.js');
    const before = { mod: enforcementConfig.modLogChannelId, alerts: automodConfig.alertsChannelId, main: enforcementConfig.mainGuildId };
    let sendFails = true;
    const channel = {
        id: '300000000000000001', name: 'mod-log', isTextBased: () => true,
        permissionsFor: () => ({ has: (bit) => bit !== PermissionFlagsBits.SendMessages }),
        send: async () => { if (sendFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); return { id: 'm' }; },
    };
    const guild = { id: MAIN, members: { me: {} }, channels: { cache: new Map([[channel.id, channel]]), fetch: async () => null } };
    channel.guild = guild;
    const client = { guilds: { cache: new Map([[MAIN, guild]]) } };
    try {
        enforcementConfig.mainGuildId = MAIN;
        enforcementConfig.modLogChannelId = null;
        automodConfig.alertsChannelId = null;
        await postModLog(client, 'ban', [{ name: 'User', value: 'x' }]);
        assert.equal(failures.listPostFailures(MAIN)[0].reason, 'notSet');
        await postAlert(client, 'raid', { title: 'Raid' });
        assert.ok(failures.listPostFailures(MAIN).some((f) => f.purpose === 'alerts' && f.reason === 'notSet'));

        failures.resetPostFailures();
        enforcementConfig.modLogChannelId = channel.id;
        await postModLog(client, 'ban', [{ name: 'User', value: 'x' }]);
        const [entry] = failures.listPostFailures(MAIN);
        assert.equal(entry.reason, 'perms');
        assert.deepEqual(entry.missing, ['SendMessages']);
        assert.equal(entry.channelName, 'mod-log');
        sendFails = false;
        await postModLog(client, 'ban', [{ name: 'User', value: 'x' }]);
        assert.deepEqual(failures.listPostFailures(MAIN), [], 'a working post clears it');

        enforcementConfig.modLogChannelId = '300000000000000099';
        await postModLog(client, 'ban', [{ name: 'User', value: 'x' }]);
        assert.equal(failures.listPostFailures(MAIN)[0].reason, 'missing');
    } finally {
        enforcementConfig.modLogChannelId = before.mod;
        automodConfig.alertsChannelId = before.alerts;
        enforcementConfig.mainGuildId = before.main;
        failures.resetPostFailures();
    }
});

test('overview shows failed posts under Needs your attention with a fix link (admins only)', () => {
    const o = {
        now: Date.now(), bot: { ready: true, ping: 10 }, database: null, guild: { name: 'G', memberCount: 3 }, openTickets: 0,
        week: [], activeBans: 0, activeMutes: 0, pendingAppeals: 0, pendingList: [], lockdown: { active: false }, recent: [], moduleStates: {},
        checklist: [], permissions: null,
        postFailures: [
            { purpose: 'modlog', reason: 'perms', channelId: 'c1', channelName: 'mod-log <b>', missing: ['SendMessages'], count: 3, lastAt: Date.now() },
            { purpose: 'alerts', reason: 'notSet', channelId: null, channelName: null, missing: [], count: 1, lastAt: Date.now() },
        ],
    };
    const page = String(overviewPage({ session: { username: 'a', csrf: 't' }, overview: o }));
    assert.match(page, /Mewvo couldn&#39;t post to #mod-log &lt;b&gt;: missing Send Messages/);
    assert.match(page, /3 times today\./);
    assert.match(page, /Mewvo couldn&#39;t post a staff alert: no alerts or mod log channel is set/);
    assert.match(page, /1 time today\./);
    assert.match(page, /<a class="btn small" href="\/dashboard\/enforcement">Fix it/);
    assert.match(page, /<a class="btn small" href="\/dashboard\/automod">Fix it/);
    assert.match(page, /Mewvo&#39;s permissions could not be checked just now/, 'the card says it could not check');
    const mod = String(overviewPage({ session: { username: 'm', csrf: 't' }, access: { allowed: true, role: 'moderator', canView: false, canAct: false }, overview: o }));
    assert.ok(!mod.includes('couldn&#39;t post'), 'moderators do not get admin fixes');
    assert.ok(!mod.includes('Mewvo&#39;s permissions'), 'nor the permissions card');
});

// ── Admin refusal text per server ──────────────────────────────────────────

test('admin refusal: the main server keeps its wording and channel; other servers never get the main channel', () => {
    const before = { main: enforcementConfig.mainGuildId, channel: enforcementConfig.adminRequestChannelId };
    try {
        enforcementConfig.mainGuildId = MAIN;
        enforcementConfig.adminRequestChannelId = '1527697155643408442';
        const main = 'You need the Administrator role to use this command. Request a mod/admin role here: <#1527697155643408442>';
        assert.equal(getAdminRequiredMessage(MAIN), main);
        assert.equal(getAdminRequiredMessage(), main, 'no server given: as before');
        const none = getAdminRequiredMessage(SUPPORT, { stored: () => undefined });
        assert.ok(!none.includes('1527697155643408442'), 'not the main channel');
        assert.equal(none, 'You need the Administrator role to use this command. Ask an admin of this server if you need access.');
        assert.equal(getAdminRequiredMessage(SUPPORT, { stored: (g, key) => (g === SUPPORT && key === 'adminRequestChannelId' ? '777' : undefined) }),
            'You need the Administrator role to use this command. Request a mod/admin role here: <#777>');
        assert.ok(!getAdminRequiredMessage(SUPPORT, { stored: () => { throw new Error('x'); } }).includes('<#'), 'a failing read: neutral');
        // Through the gate: a support-server command refused for a non-admin (default stored lookup: nothing stored).
        const result = checkCommandAccess({ command: { data: { name: 'help' } }, accessKey: 'ban', guild: { id: SUPPORT, ownerId: 'o' }, userId: 'u', permissions: { has: () => false } });
        if (!result.allowed && /Administrator/.test(result.message)) assert.ok(!result.message.includes('1527697155643408442'));
        enforcementConfig.adminRequestChannelId = null;
        assert.equal(getAdminRequiredMessage(MAIN), 'You need the Administrator role to use this command.');
    } finally {
        enforcementConfig.mainGuildId = before.main;
        enforcementConfig.adminRequestChannelId = before.channel;
    }
});

// ── Setup step by step: inline forms ──────────────────────────────────────

function setupCtx({ canEdit = true, canAct = true } = {}) {
    const text = (id, name) => ({ id, name, type: 0 });
    const guild = guildWith(PERMISSION_NAMES);
    guild.channels = { cache: new Map([['501', text('501', 'mod-log')], ['502', text('502', 'general')], ['503', { id: '503', name: 'Appeals', type: 4 }]]) };
    guild.roles = { cache: new Map([[MAIN, { id: MAIN, name: '@everyone', position: 0 }], ['601', { id: '601', name: 'Muted', position: 1 }], ['602', { id: '602', name: 'Mods', position: 2 }]]) };
    guild.members.me.permissionsIn = () => ({ has: () => true });
    return { lang: 'en', guild, csrf: 'tok', canEdit, canAct, env: process.env, services: {}, client: { guilds: { cache: new Map() } } };
}
const DATA = {
    registry: { modLogChannelId: null, evidenceChannelId: '502', adminRequestChannelId: '502', appealsCategoryId: '503', reportsCategoryId: null, modmailCategoryId: null,
        reviewChannelId: null, alertsChannelId: '502', mutedRoleId: null, warnRoleIds: ['602'], bannedRoleId: null },
    config: { prefix: '!', modRole: null, birthdayTimezone: 'Europe/Vilnius' },
    logChannels: { audit: null, applications: '502', reports: null },
    supportGuild: null,
};

test('setup steps get a small form on the existing save route, with only their one field', () => {
    const ctx = setupCtx();
    const step = (key, done = false) => ({ key, label: `Label ${key}`, done, href: '/dashboard/x', hint: 'h' });
    const hiddenNames = (out) => [...out.matchAll(/<input type="hidden" name="([^"]+)"/g)].map((m) => m[1]).sort();
    const cases = {
        modLog: ['enforcement/channels', 'modLogChannelId'], appeals: ['enforcement/channels', 'appealsCategoryId'],
        review: ['automod/channels', 'reviewChannelId'], alerts: ['automod/channels', 'alertsChannelId'],
        muted: ['enforcement/roles', 'mutedRoleId'], logChannel: ['logging/channels', 'audit'],
        modRole: ['commands/bot-settings', 'modRole'], birthdays: ['birthdays/settings', 'channelId'], appealPanel: ['enforcement/appeal-panels', 'channelId'],
    };
    for (const [key, [action, field]] of Object.entries(cases)) {
        const out = String(setupStepForm(ctx, step(key), DATA));
        assert.match(out, new RegExp(`<form method="post" action="/dashboard/${action}"`), key);
        assert.match(out, new RegExp(`<select[^>]*name="${field}"`), key);
        assert.deepEqual(hiddenNames(out), ['back', 'csrf', 'step'], `${key}: no hidden copies of other settings`);
        assert.match(out, new RegExp(`<input type="hidden" name="back" value="setup"><input type="hidden" name="step" value="${key}">`), key);
    }
    assert.match(String(setupStepForm(ctx, step('modLog'), DATA)), /name="csrf" value="tok"/);
    assert.match(String(setupStepForm(setupCtx({ canAct: false }), step('modRole'), DATA)), /<fieldset disabled>/, 'Administrator-only action: disabled without it');
    assert.match(String(setupStepForm(ctx, step('appealPanel'), DATA)), /data-confirm=/);

    assert.equal(setupStepForm(ctx, step('bannedRole'), DATA), null, 'no support guild: link only');
    assert.equal(setupStepForm(ctx, step('welcome'), DATA), null, 'several settings: link only');
    assert.equal(setupStepForm(ctx, step('modLog'), null), null, 'data unreadable: link only');
    assert.match(String(setupStepForm(setupCtx({ canEdit: false }), step('modLog'), DATA)), /<fieldset disabled>/, 'editing off: disabled');
});

test('setup page: the step form on the page, permissions read-only, ?step= by key, flash shown', () => {
    const ctx = setupCtx();
    const report = botPermissionReport(guildWith(['ViewChannel']));
    const steps = [
        { key: 'permissions', label: "Mewvo's permissions", done: false, href: '/dashboard/setup?step=permissions', hint: 'h', report },
        { key: 'modLog', label: 'Mod log channel', done: false, href: '/dashboard/enforcement', hint: 'h' },
        { key: 'welcome', label: 'Welcome channel', done: false, href: '/dashboard/welcome', hint: 'h' },
    ];
    assert.equal(stepNumber({ step: 'modLog' }, steps), 2);
    assert.equal(stepNumber({ step: 'nope' }, steps), 1);
    assert.equal(stepNumber({ step: '2abc' }, steps), 1, 'not a number');
    const session = { username: 'a', csrf: 'tok' };
    const first = String(setupPage({ session, steps, query: {}, ctx, forms: DATA }));
    assert.match(first, /Ban Members/);
    assert.ok(!/<form method="post"(?![^>]*logout)/.test(first), 'the permissions step changes nothing');
    const second = String(setupPage({ session, steps, query: { step: 'modLog' }, ctx, forms: DATA, flash: 'Saved.' }));
    assert.match(second, /action="\/dashboard\/enforcement\/channels"/);
    assert.match(second, /<p class="flash" role="status">Saved\.<\/p>/);
    assert.match(second, /open its page/);
    const third = String(setupPage({ session, steps, query: { step: '3' }, ctx, forms: DATA }));
    assert.match(third, /<a class="btn primary" href="\/dashboard\/welcome">Set this up<\/a>/);
});
