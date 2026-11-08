// Multi-server B3b (agent A4): module pages per server. Admin markers on role- and
// permission-granting actions and safety settings, the appeals-home setting for other
// servers, automod off owner-only while the staff guard is on, appeals without a channel
// listed first, and the home-only parts (public /rules link, support server commands).
//
// The module actions are called directly with a ctx for a server other than Mewvo's own
// (the routed per-server dashboard is A1's; its cross-server tests are A5's).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, getAction, getModule } from '../src/services/dashboard/modules/index.js';
import { appealsHomeForm } from '../src/services/dashboard/modules/enforcement.js';
import { isHomeScope } from '../src/services/dashboard/modules/serverScope.js';
import { getSettingEntry, neutralValue, seedValue } from '../src/services/settings/settingsRegistry.js';
import { appealsPage, orderAppeals } from '../src/services/dashboard/pages.js';
import { appealDetailPage } from '../src/services/dashboard/enforcementPages.js';
import { InputError } from '../src/services/dashboard/forms.js';
import { enforcementConfig } from '../src/config/enforcement.js';
import { FIELD_LEVEL, NOT_PRIVILEGED, PRIVILEGE_PATTERN } from './helpers/privilegedActions.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '300000000000000003';
const OWNER_OF_OTHER = '200000000000000009';
const ADMIN = '200000000000000002';
const ENV = { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, NODE_ENV: 'test', PUBLIC_URL: 'https://mewvo.example/' };

/** A ctx as routes.js contextFor builds it, for `guildId`, with a settings store and a call log. */
function ctxFor(guildId, { canAct = true, userId = ADMIN, registry = {}, automod = {}, guildOwnerId = OWNER_OF_OTHER } = {}) {
    const calls = [];
    const store = { ...registry };
    const services = {
        getSetting: (gid, key) => (Object.hasOwn(store, key) ? store[key] : seedValue(getSettingEntry(key), ENV)),
        // Another server's own row (modules/common.js registryValue): no env or home fallbacks.
        resolveSetting: (gid, key) => (Object.hasOwn(store, key) ? store[key] : neutralValue(getSettingEntry(key))),
        updateSettings: async (gid, patch) => {
            calls.push({ name: 'updateSettings', guildId: gid, patch });
            const changes = Object.entries(patch).map(([key, value]) => ({ key, old: store[key] ?? null, new: value }));
            Object.assign(store, patch);
            return { changes };
        },
        getAutomodSettings: async () => ({ enabled: true, staffGuard: false, ...automod }),
        setAutomodEnabled: async (gid, enabled) => { calls.push({ name: 'setAutomodEnabled', guildId: gid, enabled }); return { enabled, staffGuard: automod.staffGuard ?? false }; },
    };
    return {
        lang: 'en', guildId, env: ENV, services, calls, store,
        guild: { id: guildId, ownerId: guildOwnerId, channels: { cache: new Map() }, roles: { cache: new Map() }, members: { me: null } },
        client: {}, csrf: 'c'.repeat(32), canEdit: true, canAct, actor: { userId, username: 'someone' }, query: {},
    };
}

const run = (moduleKey, action, ctx, form) => getAction(getModule(moduleKey), action).run(ctx, form);

// ── scope ─────────────────────────────────────────────────────────────────

test('server scope: main and support are home, another server is not; no guild id means the main server', () => {
    assert.equal(isHomeScope(ctxFor(MAIN)), true);
    assert.equal(isHomeScope(ctxFor(SUPPORT)), true);
    assert.equal(isHomeScope(ctxFor(OTHER)), false);
    assert.equal(isHomeScope({ env: ENV }), true, 'no ctx.guildId: the main server, as before');
});

// ── admin markers ─────────────────────────────────────────────────────────

test('admin markers: every role- or permission-granting action and safety setting is Administrator-only', () => {
    const expected = {
        commands: ['bot-settings'], // modRole
        welcome: ['autorole-add', 'autorole-remove', 'autorole-delay'],
        'reaction-roles': ['panel-create', 'role-add', 'role-remove', 'panel-delete'],
        leveling: ['reward-add', 'reward-remove', 'reward-mode'],
        verification: ['setup', 'enabled', 'settings', 'auto-enabled', 'auto'],
        applications: ['role-create', 'role-update', 'role-delete', 'manager-add', 'manager-remove'],
        channels: ['lock', 'unlock', 'purge'],
        automod: ['trusted'],
        enforcement: ['roles', 'mass-action', 'appeal-review'],
        support: ['banned-role'],
        tickets: ['setup'],
    };
    for (const [moduleKey, actions] of Object.entries(expected)) {
        for (const action of actions) {
            assert.equal(getAction(getModule(moduleKey), action)?.admin, true, `${moduleKey}/${action} must be admin: true`);
        }
    }
    // Plain settings stay open to every editor (a Manage Server manager).
    for (const [moduleKey, action] of [['enforcement', 'channels'], ['enforcement', 'timings'], ['enforcement', 'appeals-home'], ['automod', 'mode'], ['birthdays', 'settings'], ['tickets', 'settings']]) {
        assert.equal(getAction(getModule(moduleKey), action).admin, false, `${moduleKey}/${action} stays open`);
    }
});

// Loops over every module action descriptor (tests/helpers/privilegedActions.js has the rule and the exceptions).
test('every module action that saves a role, permission, staff/mod list or safety setting is admin: true', () => {
    const offenders = [];
    for (const module of MODULES) {
        for (const name of Object.keys(module.actions)) {
            const action = getAction(module, name);
            const id = `${module.key}/${name}`;
            const source = `${action.run}${action.confirm || ''}`;
            if (!PRIVILEGE_PATTERN.test(source) || action.admin || NOT_PRIVILEGED.has(id)) continue;
            if (FIELD_LEVEL.has(id) && /requireCanAct\(/.test(source)) continue;
            offenders.push(id);
        }
    }
    assert.deepEqual(offenders, [], `not Administrator-only: ${offenders.join(', ')}`);
    // The field-level ones really check (a refactor must not drop the check silently).
    for (const id of FIELD_LEVEL) {
        const [moduleKey, name] = id.split('/');
        assert.match(String(getAction(getModule(moduleKey), name).run), /requireCanAct\(/, id);
    }
});

test('birthday role: changing it needs Administrator (403, nothing saved); the time zone does not', async () => {
    const birthdays = getModule('birthdays');
    const make = (canAct) => {
        const ctx = ctxFor(OTHER, { canAct });
        ctx.services.getGuildConfig = async () => ({ birthdayChannelId: null, birthdayTimezone: 'UTC', birthdayRoleId: '600000000000000001' });
        ctx.services.updateBirthdaySettings = async (client, gid, patch) => { ctx.calls.push({ name: 'updateBirthdaySettings', patch }); return { before: {}, after: patch }; };
        return ctx;
    };
    const manager = make(false);
    await assert.rejects(birthdays.actions.settings(manager, { roleId: '' }), (error) => error instanceof InputError && error.status === 403 && /Administrator/.test(error.message));
    assert.equal(manager.calls.length, 0);
    await birthdays.actions.settings(manager, { timezone: 'Europe/London' });
    assert.deepEqual(manager.calls.map((c) => c.patch), [{ timezone: 'Europe/London' }]);
    const admin = make(true);
    await birthdays.actions.settings(admin, { roleId: '' });
    assert.deepEqual(admin.calls.map((c) => c.patch), [{ roleId: null }]);
});

test('ticket staff role: changing it needs Administrator (403, nothing saved)', async () => {
    const tickets = getAction(getModule('tickets'), 'settings');
    const current = { ticketCategoryId: null, ticketClosedCategoryId: null, ticketStaffRoleId: '600000000000000001', maxTicketsPerUser: 3, dmOnClose: true, ticketLogsChannelId: null, ticketTranscriptChannelId: null, ticketButtonLabel: 'Open ticket', ticketPanelMessage: 'x' };
    const form = { ticketCategoryId: '', ticketClosedCategoryId: '', ticketStaffRoleId: '', maxTicketsPerUser: '3', dmOnClose: '1', ticketLogsChannelId: '', ticketTranscriptChannelId: '', ticketButtonLabel: 'Open ticket', ticketPanelMessage: 'x' };
    const make = (canAct, now = current) => {
        const ctx = ctxFor(OTHER, { canAct });
        ctx.services.getTicketSettings = async () => ({ ...now });
        ctx.services.updateTicketSettings = async (client, gid, patch) => { ctx.calls.push({ name: 'updateTicketSettings', patch }); return { before: now, after: { ...now, ...patch } }; };
        return ctx;
    };
    const manager = make(false);
    await assert.rejects(tickets.run(manager, form), (error) => error.status === 403 && /Administrator/.test(error.message));
    assert.equal(manager.calls.length, 0);
    const noRole = make(false, { ...current, ticketStaffRoleId: null });
    await tickets.run(noRole, { ...form, maxTicketsPerUser: '5' });
    assert.deepEqual(noRole.calls.map((c) => c.patch), [{ maxTicketsPerUser: 5 }], 'other ticket settings stay open to managers');
    const admin = make(true);
    await tickets.run(admin, form);
    assert.deepEqual(admin.calls.map((c) => c.patch), [{ ticketStaffRoleId: null }]);
});

// ── appeals home ──────────────────────────────────────────────────────────

test('appealsHome: the registry keys exist, guild main, with the expected schema', () => {
    assert.equal(getSettingEntry('appealsHome').guild, 'main');
    assert.equal(getSettingEntry('appealsHome').fallback, 'mewvo');
    assert.equal(getSettingEntry('appealsInvite').guild, 'main');
    assert.equal(getSettingEntry('appealsInvite').fallback, null);
});

test('appealsHome form: choices checked, the invite validated with inviteOrNull, own without an invite allowed', () => {
    const ctx = ctxFor(OTHER);
    assert.deepEqual(appealsHomeForm(ctx, { appealsHome: 'own', appealsInvite: '' }), { appealsHome: 'own', appealsInvite: null });
    assert.deepEqual(appealsHomeForm(ctx, { appealsHome: 'own', appealsInvite: ' https://discord.gg/abc-1 ' }), { appealsHome: 'own', appealsInvite: 'https://discord.gg/abc-1' });
    assert.deepEqual(appealsHomeForm(ctx, { appealsHome: 'mewvo', appealsInvite: 'https://discord.com/invite/xyz' }), { appealsHome: 'mewvo', appealsInvite: 'https://discord.com/invite/xyz' });
    for (const bad of ['http://discord.gg/abc', 'https://evil.example/abc', 'javascript:alert(1)', 'https://discord.gg/abc/../x', 'discord.gg/abc']) {
        assert.throws(() => appealsHomeForm(ctx, { appealsHome: 'own', appealsInvite: bad }), (error) => error instanceof InputError && error.field === 'appealsInvite' && /discord\.gg invite/.test(error.message), bad);
    }
    assert.throws(() => appealsHomeForm(ctx, { appealsHome: 'elsewhere' }), /unknown choice/);
});

test('appeals-home action: saved for another server; a bad invite saves nothing; refused in the home servers', async () => {
    const other = ctxFor(OTHER);
    const result = await run('enforcement', 'appeals-home', other, { appealsHome: 'own', appealsInvite: '' });
    assert.deepEqual(other.calls.map((c) => c.patch), [{ appealsHome: 'own' }], 'only the changed key (the invite stays empty)');
    assert.ok(result.changes.length);
    await run('enforcement', 'appeals-home', other, { appealsHome: 'own', appealsInvite: 'https://discord.gg/ours' });
    assert.deepEqual(other.calls[1].patch, { appealsInvite: 'https://discord.gg/ours' });
    const unchanged = await run('enforcement', 'appeals-home', other, { appealsHome: 'own', appealsInvite: 'https://discord.gg/ours' });
    assert.equal(unchanged.changes.length, 0);

    const bad = ctxFor(OTHER);
    await assert.rejects(run('enforcement', 'appeals-home', bad, { appealsHome: 'own', appealsInvite: 'https://evil.example/x' }), /discord\.gg invite/);
    assert.equal(bad.calls.length, 0);

    for (const home of [MAIN, SUPPORT]) {
        const ctx = ctxFor(home);
        await assert.rejects(run('enforcement', 'appeals-home', ctx, { appealsHome: 'own', appealsInvite: '' }), /does not apply in Mewvo's own servers/);
        assert.equal(ctx.calls.length, 0);
    }
});

test('enforcement page: another server gets the appeals-home radio and invite field, no Support invite and no public pages; home servers get the note', async () => {
    const module = getModule('enforcement');
    const other = ctxFor(OTHER, { registry: { appealsHome: 'own', appealsInvite: 'https://discord.gg/ours' } });
    const page = String(module.render(other, await module.load(other)));
    assert.match(page, /type="radio" name="appealsHome" value="own" checked/);
    assert.match(page, /type="radio" name="appealsHome" value="mewvo">/);
    assert.match(page, /name="appealsInvite"[^>]*value="https:\/\/discord\.gg\/ours"/);
    assert.ok(!page.includes('name="supportServerInvite"'), 'the Support invite is a home-server setting');
    assert.ok(!page.includes('/enforcement/transparency'), 'no transparency report switch');
    assert.ok(!page.includes('/enforcement/trust-card'), 'no trust card switch');

    const home = ctxFor(MAIN);
    const homePage = String(module.render(home, await module.load(home)));
    assert.ok(!homePage.includes('name="appealsHome"'));
    assert.match(homePage, /This does not apply here/);
    assert.ok(homePage.includes('name="supportServerInvite"'));
    assert.ok(homePage.includes('/enforcement/transparency'));
});

test('enforcement page: a viewer who cannot act (Manage Server manager) sees roles, safety limit and appeal review disabled', async () => {
    const module = getModule('enforcement');
    const manager = ctxFor(OTHER, { canAct: false });
    const page = String(module.render(manager, await module.load(manager)));
    for (const action of ['roles', 'mass-action', 'appeal-review']) {
        const form = page.match(new RegExp(`action="/dashboard/enforcement/${action}"[\\s\\S]*?</form>`))?.[0] || '';
        assert.match(form, /<fieldset disabled>/, `${action} disabled`);
    }
    const channels = page.match(/action="\/dashboard\/enforcement\/channels"[\s\S]*?<\/form>/)[0];
    assert.ok(!channels.includes('<fieldset disabled>'), 'channels stay editable');
});

// ── automod off ───────────────────────────────────────────────────────────

test('automod off: owner-only while the staff guard is on (as /automod enable); Administrator needed in any case', async () => {
    // Another server, staff guard on: an Administrator who is not the server owner is refused.
    const admin = ctxFor(OTHER, { automod: { staffGuard: true } });
    await assert.rejects(run('automod', 'enabled', admin, { enabled: 'false' }), (error) => error.status === 403 && /Only the server owner/.test(error.message));
    assert.equal(admin.calls.length, 0);
    // The server owner may.
    const owner = ctxFor(OTHER, { userId: OWNER_OF_OTHER, automod: { staffGuard: true } });
    await run('automod', 'enabled', owner, { enabled: 'false' });
    assert.deepEqual(owner.calls.map((c) => [c.name, c.enabled]), [['setAutomodEnabled', false]]);
    // Staff guard off: any Administrator.
    const noGuard = ctxFor(OTHER, { automod: { staffGuard: false } });
    await run('automod', 'enabled', noGuard, { enabled: 'false' });
    assert.equal(noGuard.calls.length, 1);
    // Without Administrator (a manager): refused, even with the guard off.
    const manager = ctxFor(OTHER, { canAct: false });
    await assert.rejects(run('automod', 'enabled', manager, { enabled: 'false' }), (error) => error.status === 403 && /Administrator/.test(error.message));
    assert.equal(manager.calls.length, 0);
    // Turning it on stays open to every editor.
    const managerOn = ctxFor(OTHER, { canAct: false, automod: { enabled: false } });
    await run('automod', 'enabled', managerOn, { enabled: 'true' });
    assert.equal(managerOn.calls.length, 1);
    // The main server keeps its old rule (staff guard always on there; admins may switch automod off).
    const main = ctxFor(enforcementConfig.mainGuildId, { automod: { staffGuard: true } });
    await run('automod', 'enabled', main, { enabled: 'false' });
    assert.equal(main.calls.length, 1);
});

// ── appeals list ──────────────────────────────────────────────────────────

const appeal = (code, channelId, minutesAgo) => ({
    case_code: code, type: 'ban', username: `user-${code}`, user_id: '200000000000000005', channel_id: channelId,
    created_at: new Date(Date.UTC(2026, 10, 8, 12, 0) - minutesAgo * 60000),
});

test('appeals list: appeals without a channel first, labelled "No channel: decide here"; each group keeps its order', () => {
    const list = [appeal('aaaaa', '500000000000000001', 300), appeal('bbbbb', null, 200), appeal('ccccc', '500000000000000002', 100), appeal('ddddd', null, 50)];
    assert.deepEqual(orderAppeals(list).map((a) => a.case_code), ['bbbbb', 'ddddd', 'aaaaa', 'ccccc']);
    assert.deepEqual(orderAppeals([]), []);
    const page = String(appealsPage({ session: { lang: 'en', csrf: 'x' }, appeals: list, now: Date.UTC(2026, 10, 8, 12, 0), canWrite: true }));
    const order = ['bbbbb', 'ddddd', 'aaaaa', 'ccccc'].map((code) => page.indexOf(`/dashboard/appeals/${code}`));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `page order ${order}`);
    assert.equal((page.match(/No channel: decide here/g) || []).length, 2);
});

test('appeal detail: an appeal without a channel says to decide here and links no channel', () => {
    const record = { case_code: 'bbbbb', type: 'ban', target_user_id: '200000000000000005', target_username: 'member', name: 'Spam', reason: 'spam', moderator_username: 'mod', created_at: new Date(0), guild_id: OTHER };
    const page = String(appealDetailPage({
        session: { lang: 'en', csrf: 'x' }, canWrite: true,
        data: { record, appeal: { status: 'pending', created_at: new Date(0), channel_id: null }, answers: [] },
    }));
    assert.match(page, /This appeal has no channel in Discord/);
    assert.ok(!/discord\.com\/channels\//.test(page));
    const withChannel = String(appealDetailPage({
        session: { lang: 'en', csrf: 'x' }, canWrite: true,
        data: { record, appeal: { status: 'pending', created_at: new Date(0), channel_id: '500000000000000001' }, answers: [] },
    }));
    assert.ok(!withChannel.includes('This appeal has no channel in Discord'));
});

// ── support server module ────────────────────────────────────────────────

test('support module from another server: resolves no support server (never the home one), shows "not connected", refuses every action', async () => {
    const module = getModule('support');
    const supportGuild = { id: SUPPORT, name: 'Mewvo Support', roles: { cache: new Map() }, channels: { cache: new Map() } };
    const other = ctxFor(OTHER);
    other.client = { guilds: { cache: new Map([[SUPPORT, supportGuild]]) } };
    const data = await module.load(other);
    assert.equal(data.supportGuildId, null);
    assert.equal(data.supportGuild, null);
    assert.match(String(module.render(other, data)), /No support server is connected/);
    for (const [action, form] of [['banned-role', { bannedRoleId: '' }], ['appeals-category', { supportAppealsCategoryId: '' }]]) {
        await assert.rejects(getAction(module, action).run(other, form), (error) => error instanceof InputError && /No support server is connected/.test(error.message), action);
    }
    assert.equal(other.calls.length, 0, 'nothing written, least of all to the home support server');

    // The home servers keep Mewvo's support server.
    const main = ctxFor(MAIN);
    main.client = { guilds: { cache: new Map([[SUPPORT, supportGuild]]) } };
    const home = await module.load(main);
    assert.equal(home.supportGuildId, SUPPORT);
    assert.equal(home.supportGuild, supportGuild);
});

// ── home-only parts ───────────────────────────────────────────────────────

test('rules: the public /rules link shows in Mewvo\'s own servers only', async () => {
    const module = getModule('rules');
    const render = async (guildId) => {
        const ctx = ctxFor(guildId);
        return String(module.render(ctx, await module.load(ctx)));
    };
    assert.ok((await render(MAIN)).includes('https://mewvo.example/rules'));
    assert.ok(!(await render(OTHER)).includes('/rules"'), 'no public rules link for another server');
});

test('texts: no "main server" wording left in the automod and commands module texts', async () => {
    const { readFileSync } = await import('node:fs');
    for (const lang of ['en']) {
        for (const file of ['automod', 'commands']) {
            const text = readFileSync(new URL(`../src/content/dashboard/${lang}/${file}.json`, import.meta.url), 'utf8');
            assert.ok(!/main server/i.test(text), `${lang}/${file}.json`);
        }
    }
    assert.ok(!/main server/i.test(getModule('automod').help));
});
