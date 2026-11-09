// Multi-server B2 (public bot): one global command registration (no /database, at most 100), the
// switch away from the main server's guild list without a gap, the "only Mewvo servers" gate gone
// (Administrator-only stays Administrator-only), the join welcome (channel choice, DM to the adder,
// no repost within 24 h), /setup (checklist, Manage Server access, category list) and guildDelete
// keeping data.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000777'; // not a home server
const EMPTY = '100000000000000888'; // not a home server, nothing stored
const BOT = '1600000000000000001';
const ADMIN = '500000000000000001';
const MANAGER = '500000000000000002';
const MEMBER = '500000000000000003';

Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, PUBLIC_URL: 'https://bot.example' });

const { enforcementConfig } = await import('../src/config/enforcement.js');
const { testMode } = await import('../src/config/testMode.js');
const loader = await import('../src/handlers/loaders/commandLoader.js');
const { checkCommandAccess, isCommandAvailableInGuild } = await import('../src/utils/commandGate.js');
const { MANAGE_SERVER_COMMANDS } = await import('../src/config/commands/commandAccess.js');
const { resetSettingsCacheForTests, setSettingsCacheForTests, SettingsUnavailableError } = await import('../src/services/settings/guildSettings.js');
const { botText } = await import('../src/utils/botText.js');
const { dashboardUrlFor } = await import('../src/services/site/shell.js');
const welcome = await import('../src/services/setup/joinWelcome.js');
const guide = await import('../src/services/setup/setupGuide.js');
const { runSetup } = await import('../src/commands/Core/setup.js');
const { handleSetupCategory } = await import('../src/interactions/selectMenus/setup/setupCategory.js');
const { default: guildDelete } = await import('../src/events/guildDelete.js');

afterEach(() => resetSettingsCacheForTests());

const silentLog = () => {
    const lines = [];
    const push = (level) => (message) => lines.push({ level, message });
    return { lines, info: push('info'), warn: push('warn'), error: push('error') };
};

function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

/** A permissions object: has(bit | [bits]) is true only when every bit is in `bits` (like discord.js). */
const perms = (...bits) => ({ has: (wanted) => (Array.isArray(wanted) ? wanted : [wanted]).every((b) => bits.includes(b)) });
const ALL_POST = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

let realClient = null;
async function loadedClient() {
    if (!realClient) {
        realClient = {};
        await loader.loadCommands(realClient);
    }
    return realClient;
}

// ── Registration ─────────────────────────────────────────────────────────

test('registration body: every real command but /database is global, /setup included, at most 100', async () => {
    const client = await loadedClient();
    const { sets, totalSubcommands } = loader.collectCommandPayloads(client);
    const { globalCommands, ownerCommands } = withEnv({ RETIRE_ADMIN_COMMANDS: '' }, () => loader.buildRegistrationBodies(sets, totalSubcommands, { quiet: true }));
    const names = globalCommands.map((c) => c.name);
    assert.ok(globalCommands.length <= 100, `${globalCommands.length} global commands`);
    assert.ok(!names.includes('database'), '/database is never global');
    assert.deepEqual(ownerCommands.map((c) => c.name), ['database']);
    for (const name of ['setup', 'help', 'enforcements', 'appeals', 'setappeal', 'test', 'modmail', 'Report message']) assert.ok(names.includes(name), name);
    assert.equal(new Set(names).size, names.length, 'no duplicates');
    assert.equal(names.length, client.commands.size - 1, 'everything else is global');
    for (const c of globalCommands) {
        assert.equal(c.default_member_permissions, null, `${c.name}: visible to everyone (the gate decides)`);
        assert.deepEqual(c.contexts, [0], `${c.name}: servers only`);
    }
    // Retired: /setup stays (Manage Server), admin-only commands go, /database is unaffected.
    const retired = withEnv({ RETIRE_ADMIN_COMMANDS: 'true' }, () => loader.buildRegistrationBodies(sets, totalSubcommands, { quiet: true }));
    const retiredNames = retired.globalCommands.map((c) => c.name);
    assert.ok(retiredNames.includes('setup') && retiredNames.includes('help'));
    assert.ok(!retiredNames.includes('purge'));
    assert.deepEqual(retired.ownerCommands.map((c) => c.name), ['database']);
});

test('over 100 global commands: refused before any request (a truncated PUT would delete commands)', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ name: `c${i}`, description: 'x' }));
    assert.throws(() => loader.buildRegistrationBodies({ global: many, owner: [] }, 0, { quiet: true }), /over Discord's limit of 100/);
    const puts = [];
    await assert.rejects(loader.registerCommandSets({ put: async (r) => puts.push(r), get: async () => [] }, BOT, { global: many, owner: [] }), /limit/);
    assert.equal(puts.length, 0);
});

test('snowflake times and the settle rule: an hour after the oldest global command, never before', () => {
    const id = '1531096173786566697';
    const t = loader.snowflakeTime(id);
    assert.equal(t, Number((BigInt(id) >> 22n) + 1420070400000n));
    assert.equal(loader.snowflakeTime('nope'), null);
    assert.equal(loader.globalSettleRemainingMs([], t), loader.GLOBAL_SETTLE_MS, 'first switch: an hour');
    assert.equal(loader.globalSettleRemainingMs(null, t), loader.GLOBAL_SETTLE_MS, 'unreadable: an hour');
    assert.equal(loader.globalSettleRemainingMs([{ id }], t + 10 * 60000), 50 * 60000);
    assert.equal(loader.globalSettleRemainingMs([{ id }], t + loader.GLOBAL_SETTLE_MS), 0);
});

function fakeRest(existing) {
    const puts = [];
    return {
        puts,
        get: async () => {
            if (existing instanceof Error) throw existing;
            return existing;
        },
        put: async (route, { body }) => { puts.push({ route: String(route), names: body.map((c) => c.name) }); },
    };
}

async function withProduction(fn) {
    const saved = { main: enforcementConfig.mainGuildId, support: enforcementConfig.supportGuildId, test: testMode.enabled };
    Object.assign(enforcementConfig, { mainGuildId: MAIN, supportGuildId: SUPPORT });
    testMode.enabled = false;
    try { return await fn(); } finally {
        Object.assign(enforcementConfig, { mainGuildId: saved.main, supportGuildId: saved.support });
        testMode.enabled = saved.test;
    }
}

const SETS = {
    global: [{ name: 'help', description: 'h' }, { name: 'enforcements', description: 'e' }],
    owner: [{ name: 'database', description: 'd' }],
};
const GLOBAL_ROUTE = `/applications/${BOT}/commands`;
const guildRoute = (id) => `/applications/${BOT}/guilds/${id}/commands`;

test('the switch, first run: global list PUT, the home servers keep a guild copy, emptied when the hour is up', async () => withProduction(async () => {
    const rest = fakeRest([]);
    const timers = [];
    const result = await loader.registerCommandSets(rest, BOT, SETS, 0, { now: Date.now(), schedule: (fn, ms) => timers.push({ fn, ms }) });
    assert.deepEqual(result, { scope: 'global', count: 2 });
    assert.equal(rest.puts[0].route, GLOBAL_ROUTE, 'global first, so the copy is never the only list for long');
    assert.deepEqual(rest.puts[0].names, ['help', 'enforcements']);
    assert.deepEqual(rest.puts.find((p) => p.route === guildRoute(MAIN)).names, ['help', 'enforcements'], 'main server never without commands');
    assert.deepEqual(rest.puts.find((p) => p.route === guildRoute(SUPPORT)).names, ['help', 'enforcements']);
    assert.ok(!rest.puts.some((p) => p.route !== guildRoute('1564332751170044186') && p.names.includes('database')), '/database only in the owner-tools server');
    assert.deepEqual(rest.puts.find((p) => p.route === guildRoute('1564332751170044186')).names, ['database']);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, loader.GLOBAL_SETTLE_MS);
    rest.puts.length = 0;
    await timers[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rest.puts.map((p) => [p.route, p.names]), [[guildRoute(MAIN), []], [guildRoute(SUPPORT), []]], 'then the guild copies go');
}));

test('the switch, settled: an hour-old global list empties the home guild lists at once; a failed read keeps the copy', async () => withProduction(async () => {
    const oldId = '1531096173786566697';
    const now = loader.snowflakeTime(oldId) + 2 * loader.GLOBAL_SETTLE_MS;
    const rest = fakeRest([{ id: oldId, name: 'help' }]);
    const timers = [];
    await loader.registerCommandSets(rest, BOT, SETS, 0, { now, schedule: (fn, ms) => timers.push({ fn, ms }) });
    assert.deepEqual(rest.puts.find((p) => p.route === GLOBAL_ROUTE).names, ['help', 'enforcements']);
    assert.deepEqual(rest.puts.find((p) => p.route === guildRoute(MAIN)).names, []);
    assert.deepEqual(rest.puts.find((p) => p.route === guildRoute(SUPPORT)).names, []);
    assert.equal(timers.length, 0);

    const failing = fakeRest(new Error('503'));
    await loader.registerCommandSets(failing, BOT, SETS, 0, { now, schedule: () => {} });
    assert.deepEqual(failing.puts.find((p) => p.route === guildRoute(MAIN)).names, ['help', 'enforcements'], 'unsure: keep the copy');
}));

test('test mode: test guilds only, never global; the owner-tools test guild also gets /database', async () => {
    const saved = { test: testMode.enabled, ids: testMode.guildIds };
    testMode.enabled = true;
    testMode.guildIds = new Set(['1700000000000000009', '1564332751170044186']);
    try {
        const rest = fakeRest([]);
        const result = await loader.registerCommandSets(rest, BOT, SETS, 0, { schedule: () => assert.fail('no timer in test mode') });
        assert.deepEqual(result, { scope: 'test', count: 2 });
        assert.ok(!rest.puts.some((p) => p.route === GLOBAL_ROUTE));
        assert.deepEqual(rest.puts.find((p) => p.route === guildRoute('1700000000000000009')).names, ['help', 'enforcements']);
        assert.deepEqual(rest.puts.find((p) => p.route === guildRoute('1564332751170044186')).names, ['help', 'enforcements', 'database']);
        const failing = { put: async () => { throw new Error('Missing Access'); } };
        await assert.rejects(loader.registerCommandSets(failing, BOT, SETS, 0), /any test guild/, 'never success when nothing was registered');
    } finally {
        testMode.enabled = saved.test;
        testMode.guildIds = saved.ids;
    }
});

// ── The gate ─────────────────────────────────────────────────────────────

test('gate: every public command runs in any server; Administrator-only stays Administrator-only', async () => {
    const client = await loadedClient();
    const guild = { id: OTHER, ownerId: '500000000000000099' };
    const check = (name, accessKey, permissions, userId = MEMBER) => checkCommandAccess({ command: client.commands.get(name), accessKey, guild, userId, permissions });
    assert.deepEqual(check('help', 'help', perms()), { allowed: true }, 'everyone-command in another server');
    assert.deepEqual(check('enforcements', 'enforcements', perms(PermissionFlagsBits.Administrator), ADMIN), { allowed: true }, "a former main-only command for an admin");
    const refused = check('enforcements', 'enforcements', perms());
    assert.equal(refused.allowed, false);
    assert.equal(refused.message, botText('en').t('errors.access.adminOther'));
    assert.equal(check('purge', 'purge', perms(PermissionFlagsBits.ManageGuild), MANAGER).allowed, false, 'Manage Server is not Administrator');
    assert.ok(!JSON.stringify(refused).includes('Mewvo servers'));
    // The support server: every command, not only the old support list.
    assert.deepEqual(checkCommandAccess({ command: client.commands.get('enforcements'), accessKey: 'enforcements', guild: { id: SUPPORT }, userId: ADMIN, permissions: perms(PermissionFlagsBits.Administrator) }), { allowed: true });
    for (const command of client.commands.values()) {
        assert.equal(isCommandAvailableInGuild(command, OTHER), command.scope !== 'owner', command.data.name);
    }
});

test('/setup access: Administrator or Manage Server; a member is refused; still works while admin commands are retired', () => {
    assert.ok(MANAGE_SERVER_COMMANDS.has('setup'));
    const guild = { id: OTHER, ownerId: '500000000000000099' };
    const check = (permissions, userId = MEMBER) => checkCommandAccess({ command: {}, accessKey: 'setup', guild, userId, permissions });
    assert.deepEqual(check(perms(PermissionFlagsBits.ManageGuild), MANAGER), { allowed: true });
    assert.deepEqual(check(perms(PermissionFlagsBits.Administrator), ADMIN), { allowed: true });
    assert.deepEqual(check(perms(), guild.ownerId), { allowed: true }, 'the server owner');
    assert.deepEqual(check(perms()), { allowed: false, message: 'You need the Manage Server or Administrator permission to use this command.' });
    assert.equal(checkCommandAccess({ command: {}, accessKey: 'setup', guild, userId: MEMBER, permissions: perms(), lang: 'de' }).message, botText('de').t('errors.access.manageServer'));
    withEnv({ RETIRE_ADMIN_COMMANDS: 'true' }, () => assert.deepEqual(check(perms(PermissionFlagsBits.ManageGuild), MANAGER), { allowed: true }));
});

// ── The join welcome ─────────────────────────────────────────────────────

function fakeChannel(id, { type = ChannelType.GuildText, can = ALL_POST, rawPosition = 0, parent = null, fail = false } = {}) {
    const sent = [];
    return {
        id, type, rawPosition, parent, sent,
        isTextBased: () => type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement,
        permissionsFor: () => perms(...can),
        send: async (payload) => {
            if (fail) throw new Error('Missing Permissions');
            sent.push(payload);
        },
    };
}

function fakeGuild({ system = null, channels = [], audit = false, entries = [] } = {}) {
    const fetches = [];
    return {
        id: OTHER, name: 'Cats & Co', fetches,
        systemChannel: system,
        channels: { cache: new Map([...(system ? [system] : []), ...channels].map((c) => [c.id, c])) },
        members: { me: { id: BOT, permissions: audit ? perms(PermissionFlagsBits.ViewAuditLog) : perms() } },
        fetchAuditLogs: async (options) => {
            fetches.push(options);
            return { entries: new Map(entries.map((e, i) => [String(i), e])) };
        },
    };
}

test('welcome channel: the system channel when Mewvo can view, send and embed there', () => {
    const system = fakeChannel('200000000000000001', { rawPosition: 5 });
    const first = fakeChannel('200000000000000002', { rawPosition: 0 });
    assert.equal(welcome.chooseWelcomeChannel(fakeGuild({ system, channels: [first] })), system);
});

test('welcome channel: else the first text channel by position where Mewvo can post; none → null', () => {
    const noEmbed = fakeChannel('200000000000000001', { can: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    const category = { rawPosition: 0 };
    const inCategory = fakeChannel('200000000000000002', { rawPosition: 0, parent: category });
    const topLater = fakeChannel('200000000000000003', { rawPosition: 7 });
    const topFirstNoSend = fakeChannel('200000000000000004', { rawPosition: 1, can: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks] });
    const voice = fakeChannel('200000000000000005', { type: ChannelType.GuildVoice, rawPosition: 0 });
    const guild = fakeGuild({ system: noEmbed, channels: [inCategory, topLater, topFirstNoSend, voice] });
    assert.equal(welcome.chooseWelcomeChannel(guild), topLater, 'system channel lacks Embed Links; channels outside categories come first');
    assert.equal(welcome.chooseWelcomeChannel(fakeGuild({ channels: [inCategory] })), inCategory);
    assert.equal(welcome.chooseWelcomeChannel(fakeGuild({ system: noEmbed, channels: [topFirstNoSend, voice] })), null);
    assert.equal(welcome.chooseWelcomeChannel({ ...fakeGuild(), members: { me: null } }), null);
});

function welcomeDeps(config, saved, log = silentLog(), blacklisted = {}) {
    return {
        getGuildConfig: async () => {
            if (config instanceof Error) throw config;
            return config;
        },
        stampWelcome: async (client, guildId, at) => {
            if (config instanceof Error) throw config;
            saved.push({ guildId, at });
        },
        blacklistHit: ({ userId, guildId }) => (blacklisted.guild === guildId && guildId ? { kind: 'guild' } : blacklisted.user === userId && userId ? { kind: 'user' } : null),
        textFor: () => botText('en'),
        log,
    };
}

test('welcomeOnJoin: posts once with the /setup line, dashboard and support buttons, no mentions; stamps the config', async () => {
    const system = fakeChannel('200000000000000001');
    const guild = fakeGuild({ system });
    const saved = [];
    const now = Date.parse('2026-11-08T12:00:00Z');
    const result = await welcome.welcomeOnJoin(guild, { user: { id: BOT } }, { deps: welcomeDeps({ prefix: '!' }, saved), now });
    assert.deepEqual(result, { posted: system.id, dm: false, skipped: null });
    const [payload] = system.sent;
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, 'Thanks for adding Mewvo!');
    assert.ok(embed.description.startsWith('An admin can type **/setup** to get started.'));
    const buttons = payload.components[0].toJSON().components;
    // B3: every server gets a link to its own dashboard, no "coming soon" line.
    assert.deepEqual(buttons.map((b) => b.url), [`https://bot.example/dashboard/${OTHER}`, 'https://discord.gg/7Ckv9Bt577']);
    assert.ok(!embed.description.includes('coming soon'), embed.description);
    assert.equal(dashboardUrlFor(OTHER), `https://bot.example/dashboard/${OTHER}`);
    assert.equal(dashboardUrlFor(MAIN), `https://bot.example/dashboard/${MAIN}`, 'home servers too');
    assert.equal(dashboardUrlFor(SUPPORT), `https://bot.example/dashboard/${SUPPORT}`, 'the dashboard redirects the Support id to main');
    assert.equal(dashboardUrlFor(undefined), 'https://bot.example/dashboard', 'no server: the picker');
    assert.equal(dashboardUrlFor('../owner'), 'https://bot.example/dashboard', 'never a path from a non-snowflake');
    assert.equal(dashboardUrlFor(OTHER, {}), null, 'no PUBLIC_URL: no link');
    const home = welcome.welcomeMessage({ id: MAIN, name: 'Mewvo' }, botText('en'));
    assert.deepEqual(home.components[0].toJSON().components.map((b) => b.url), [`https://bot.example/dashboard/${MAIN}`, 'https://discord.gg/7Ckv9Bt577']);
    assert.ok(!home.embeds[0].toJSON().description.includes('coming soon'));
    assert.deepEqual(saved, [{ guildId: OTHER, at: '2026-11-08T12:00:00.000Z' }], 'one atomic stamp (a row-locked merge, other keys untouched)');
    assert.equal(guild.fetches.length, 0, 'no View Audit Log: no audit-log read, no DM');
});

test('welcomeOnJoin: no repost when the bot rejoins within 24 hours; after 24 hours it posts again', async () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const recent = { botWelcomeAt: new Date(now - 23 * 3600000).toISOString() };
    const system = fakeChannel('200000000000000001');
    const saved = [];
    const result = await welcome.welcomeOnJoin(fakeGuild({ system, audit: true }), { user: { id: BOT } }, { deps: welcomeDeps(recent, saved), now });
    assert.deepEqual(result, { posted: null, dm: false, skipped: 'recent' });
    assert.equal(system.sent.length, 0);
    assert.deepEqual(saved, [], 'nothing written, the stamp is not moved');

    const old = { botWelcomeAt: new Date(now - 25 * 3600000).toISOString() };
    const again = await welcome.welcomeOnJoin(fakeGuild({ system }), { user: { id: BOT } }, { deps: welcomeDeps(old, []), now });
    assert.equal(again.posted, system.id);
});

test('welcomeOnJoin: DMs the member who added Mewvo (BotAdd, last minute) when it has View Audit Log', async () => {
    const now = Date.now();
    const dms = [];
    const adder = { id: ADMIN, bot: false, send: async (payload) => dms.push(payload) };
    const stale = { target: { id: BOT }, createdTimestamp: now - 5 * 60000, executor: { id: 'old', send: async () => assert.fail('stale entry') } };
    const otherBot = { target: { id: '1600000000000000099' }, createdTimestamp: now, executor: { id: 'x', send: async () => assert.fail('another bot') } };
    const fresh = { target: { id: BOT }, createdTimestamp: now - 10000, executor: adder };
    const guild = fakeGuild({ system: fakeChannel('200000000000000001'), audit: true, entries: [stale, otherBot, fresh] });
    const result = await welcome.welcomeOnJoin(guild, { user: { id: BOT } }, { deps: welcomeDeps({}, []), now });
    assert.equal(result.dm, true);
    assert.equal(guild.fetches[0].type, 28, 'AuditLogEvent.BotAdd');
    assert.ok(dms[0].embeds[0].toJSON().description.includes('You added Mewvo to **Cats & Co**.'));
    assert.deepEqual(dms[0].allowedMentions, { parse: [] });
});

test('welcomeOnJoin: a blacklisted server gets nothing; a blacklisted adder gets no DM', async () => {
    const system = fakeChannel('200000000000000001');
    const saved = [];
    const skipped = await welcome.welcomeOnJoin(fakeGuild({ system }), { user: { id: BOT } }, { deps: welcomeDeps({}, saved, silentLog(), { guild: OTHER }) });
    assert.deepEqual(skipped, { posted: null, dm: false, skipped: 'blacklisted' });
    assert.equal(system.sent.length, 0);
    assert.deepEqual(saved, []);
    const adder = { id: ADMIN, send: async () => assert.fail('blacklisted adder') };
    const guild = fakeGuild({ system, audit: true, entries: [{ target: { id: BOT }, createdTimestamp: Date.now(), executor: adder }] });
    const result = await welcome.welcomeOnJoin(guild, { user: { id: BOT } }, { deps: welcomeDeps({}, [], silentLog(), { user: ADMIN }) });
    assert.equal(result.posted, system.id);
    assert.equal(result.dm, false);
});

test('welcomeOnJoin never throws: a failed send, DM or config read is one log line each', async () => {
    const log = silentLog();
    const guild = fakeGuild({ system: fakeChannel('200000000000000001', { fail: true }), audit: true, entries: [{ target: { id: BOT }, createdTimestamp: Date.now(), executor: { id: ADMIN, send: async () => { throw new Error('Cannot send messages to this user'); } } }] });
    const saved = [];
    const result = await welcome.welcomeOnJoin(guild, { user: { id: BOT } }, { deps: welcomeDeps(new Error('database not responding'), saved, log) });
    assert.deepEqual(result, { posted: null, dm: false, skipped: null });
    assert.deepEqual(saved, [], 'the stamp write failed too (database down): logged');
    assert.equal(log.lines.filter((l) => l.level === 'warn').length, 4, 'read, stamp, post, DM');
    const none = await welcome.welcomeOnJoin(fakeGuild(), { user: { id: BOT } }, { deps: welcomeDeps({}, [], log) });
    assert.equal(none.posted, null, 'no channel: nothing posted');
});

test('guildDelete: log only, the data is kept (no database or delete call in the handler)', async () => {
    await guildDelete.execute({ id: OTHER, name: 'x', available: true });
    await guildDelete.execute({ id: OTHER, available: false });
    const source = readFileSync(new URL('../src/events/guildDelete.js', import.meta.url), 'utf8');
    assert.ok(!/import[^\n]*(database|services|db\.js)/.test(source));
    assert.ok(!/delete|DROP|TRUNCATE/.test(source.replace(/\/\/[^\n]*/g, '').replace(/Events\.GuildDelete|guild\.delete/g, '')));
});

// ── /setup ───────────────────────────────────────────────────────────────

function fakeInteraction({ guildId = OTHER, userId = MANAGER, permissions = perms(PermissionFlagsBits.ManageGuild), locale = 'en-US', values = [], name = 'Cats & Co' } = {}) {
    const calls = [];
    return {
        calls, id: '2000000000000000001', createdTimestamp: Date.now(), locale,
        user: { id: userId, username: 'u' }, guildId, guild: { id: guildId, name, ownerId: '500000000000000099' },
        memberPermissions: permissions, values,
        deferred: false, replied: false,
        async deferReply(payload) { this.deferred = true; calls.push(['defer', payload]); },
        async deferUpdate() { this.deferred = true; calls.push(['deferUpdate']); },
        async reply(payload) { this.replied = true; calls.push(['reply', payload]); },
        async editReply(payload) { calls.push(['edit', payload]); },
        async followUp(payload) { calls.push(['followUp', payload]); },
    };
}

const moduleData = (config, welcomeConfig, automod) => ({
    ...guide.defaultSetupData,
    getGuildConfig: async () => config,
    getWelcomeConfig: async () => welcomeConfig,
    getAutomodSettings: async () => automod,
});

test('/setup on a configured non-home server: every line ✅, a button to its own dashboard, category select', async () => {
    setSettingsCacheForTests(OTHER, {
        modLogChannelId: '300000000000000001', reviewChannelId: '300000000000000002',
        appealsHome: 'own', appealsInvite: 'https://discord.gg/catsco', botLanguage: 'de',
    });
    const client = await loadedClient();
    const interaction = fakeInteraction();
    const config = { ticketCategoryId: '400000000000000001', verification: { enabled: true }, leveling: { enabled: true } };
    await runSetup(interaction, config, client, { data: moduleData(config, { enabled: true, channelId: '300000000000000003' }, { enabled: true }) });
    assert.deepEqual(interaction.calls[0][1].flags, 64, 'ephemeral');
    const payload = interaction.calls.find((c) => c[0] === 'edit')[1];
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, 'Set up Mewvo in Cats & Co');
    assert.ok(embed.description.length <= 4096);
    const lines = embed.description.split('\n').filter((l) => /^(✅|➖)/.test(l));
    assert.equal(lines.length, 9);
    assert.ok(lines.every((l) => l.startsWith('✅')), lines.join('\n'));
    assert.ok(embed.description.includes('✅ **Mod log channel**: <#300000000000000001>'));
    assert.ok(embed.description.includes('✅ **Appeals**: Members appeal in your own server: https://discord.gg/catsco'));
    assert.ok(embed.description.includes('✅ **Bot language**: Deutsch'));
    // B3: the button opens this server's own dashboard; no "coming soon" or "not available" line.
    const rows = payload.components.map((c) => c.toJSON());
    const dashboard = rows.find((r) => r.components[0].type === 2);
    const select = rows.find((r) => r.components[0].type === 3);
    assert.deepEqual(dashboard.components.map((b) => b.url), [`https://bot.example/dashboard/${OTHER}`]);
    assert.ok(!embed.description.includes('coming soon') && !embed.description.includes('not available'), embed.description);
    assert.equal(select.components[0].custom_id, `setup-cat:${MANAGER}`);
    const categories = select.components[0].options.map((o) => o.value);
    assert.ok(categories.includes('Enforcement') && categories.includes('Core'));
    assert.ok(categories.length <= 25);
    assert.ok(!guide.commandCategories(client, OTHER).some((c) => c.commands.some((x) => x.name === 'database')), '/database not listed outside the owner-tools server');
});

test('/setup on an empty non-home server: ➖ lines with what to do next; the main server values are not borrowed', async () => {
    setSettingsCacheForTests(EMPTY, {});
    const client = await loadedClient();
    const interaction = fakeInteraction({ guildId: EMPTY });
    await runSetup(interaction, {}, client, { data: moduleData({}, null, { enabled: false }) });
    const embed = interaction.calls.find((c) => c[0] === 'edit')[1].embeds[0].toJSON();
    const d = embed.description;
    assert.ok(d.includes('➖ **Mod log channel**: Pick a channel on the dashboard (Enforcement).'));
    assert.ok(d.includes('➖ **Staff review channel**: Pick a channel on the dashboard (Automod).'));
    // Owner decision D2: a new server appeals in its own server; an invite is the next step.
    assert.ok(d.includes('➖ **Appeals**: Members appeal in your own server (the default). Add an invite on the dashboard (Enforcement), so members who were kicked or banned know where to go.'));
    assert.ok(d.includes('➖ **Automod**: off. Turn it on on the dashboard (Automod).'));
    assert.ok(d.includes('➖ **Tickets**: off. Set them up with /ticket or on the dashboard.'));
    assert.ok(d.includes('➖ **Bot language**: English (default).'));
    assert.ok(d.includes('✅ **Leveling**: on'), 'leveling defaults to on');
    assert.ok(!d.includes('<#'), 'no channel of another server');
});

test('/setup: a database error throws (the dispatcher gives the normal error reply), nothing is shown', async () => {
    const client = await loadedClient();
    const interaction = fakeInteraction({ guildId: '100000000000000999' }); // never loaded: settings unreadable
    await assert.rejects(runSetup(interaction, {}, client, { data: moduleData({}, null, {}) }), SettingsUnavailableError);
    assert.ok(!interaction.calls.some((c) => c[0] === 'edit'));
    setSettingsCacheForTests(EMPTY, {});
    const broken = { ...moduleData({}, null, {}), getAutomodSettings: async () => { throw new Error('database not responding'); } };
    await assert.rejects(runSetup(fakeInteraction({ guildId: EMPTY }), {}, client, { data: broken }), /database not responding/);
});

test('/setup in the user language: German labels', async () => {
    setSettingsCacheForTests(EMPTY, {});
    const client = await loadedClient();
    const interaction = fakeInteraction({ guildId: EMPTY, locale: 'de' });
    await runSetup(interaction, {}, client, { data: moduleData({}, null, { enabled: true }) });
    const embed = interaction.calls.find((c) => c[0] === 'edit')[1].embeds[0].toJSON();
    assert.ok(embed.description.includes(`➖ **${botText('de').t('setup.item.modLog.label')}**`));
    assert.ok(embed.description.includes('✅ **Automod**: an'));
});

test('/setup category select: only the invoker, Manage Server re-checked, one line per command within the embed limit', async () => {
    const client = await loadedClient();
    const stranger = fakeInteraction({ userId: MEMBER, values: ['Core'] });
    await handleSetupCategory(stranger, client, [MANAGER]);
    assert.equal(stranger.calls[0][1].content, botText('en').t('setup.notYours'));

    const demoted = fakeInteraction({ permissions: perms(), values: ['Core'] });
    await handleSetupCategory(demoted, client, [MANAGER]);
    assert.equal(demoted.calls[0][1].content, botText('en').t('errors.access.manageServer'));

    const ok = fakeInteraction({ values: ['Enforcement'] });
    await handleSetupCategory(ok, client, [MANAGER]);
    assert.equal(ok.calls[0][0], 'deferUpdate');
    const embed = ok.calls[1][1].embeds[0].toJSON();
    assert.equal(embed.title, 'Enforcement commands');
    assert.ok(embed.description.length <= 4096);
    assert.ok(embed.description.includes('🔒 **/enforcements**'));
    assert.ok(embed.description.includes('**/appeal** '), 'a command with an everyone part is not locked');

    const core = guide.categoryReply({ client, guildId: OTHER, userId: MANAGER, category: 'Core', tr: botText('en') }).embeds[0].toJSON();
    assert.ok(core.description.includes('**/setup**') && !core.description.includes('🔒 **/setup**'));
    // Many long commands: cut with "…and N more", never over 4096.
    const big = { commands: new Map(Array.from({ length: 60 }, (_, i) => [`c${i}`, { category: 'Big', data: { toJSON: () => ({ name: `c${i}`, description: 'x'.repeat(100) }) } }])) };
    const cut = guide.categoryReply({ client: big, guildId: OTHER, userId: MANAGER, category: 'Big', tr: botText('en') }).embeds[0].toJSON();
    assert.ok(cut.description.length <= 4096);
    assert.match(cut.description, /…and \d+ more$/);
});

test('catalog: /setup and the welcome are in all 8 languages, English as written', () => {
    for (const lang of ['en', 'ru', 'de', 'fr', 'it', 'pl', 'es', 'pt-BR']) {
        const tr = botText(lang);
        for (const key of ['setup.title', 'setup.welcome.title', 'setup.welcome.body', 'setup.welcome.dm', 'setup.item.language.default', 'errors.access.manageServer']) {
            assert.ok(tr.has(key), `${lang}: ${key}`);
        }
        assert.ok(tr.t('setup.welcome.body').includes('**/setup**'), `${lang}: /setup kept`);
    }
    assert.equal(botText('en').t('setup.welcome.body'), 'An admin can type **/setup** to get started.');
    assert.equal(botText('en').t('setup.welcome.title'), 'Thanks for adding Mewvo!');
});
