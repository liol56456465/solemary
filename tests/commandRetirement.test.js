// Retiring admin commands (RETIRE_ADMIN_COMMANDS): only everyone-commands and the owner-only
// emergency kit stay registered; the gate sends everything else to its dashboard page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminCommandsRetired, dashboardPageFor, retireCommandJson, retiredMessage } from '../src/config/commands/retirement.js';

const { enforcementConfig } = await import('../src/config/enforcement.js');
const { botConfig } = await import('../src/config/bot.js');
const { checkCommandAccess } = await import('../src/utils/commandGate.js');
const { expectedMainCommands, registerCommandSets, registerMainGuildCommands } = await import('../src/handlers/loaders/commandLoader.js');
const { testMode } = await import('../src/config/testMode.js');

const SUB = (name) => ({ type: 1, name, description: name });

function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

test('retirement is off unless RETIRE_ADMIN_COMMANDS is true', () => {
    assert.equal(adminCommandsRetired({}), false);
    assert.equal(adminCommandsRetired({ RETIRE_ADMIN_COMMANDS: 'false' }), false);
    assert.equal(adminCommandsRetired({ RETIRE_ADMIN_COMMANDS: 'true' }), true);
});

test('registration while retired: admin subcommands stripped, admin-only commands dropped, owner kit kept', () => {
    const birthday = { name: 'birthday', description: 'b', options: [SUB('set'), SUB('setchannel'), SUB('info')] };
    assert.deepEqual(retireCommandJson(birthday).options.map((o) => o.name), ['set', 'info']);
    assert.equal(retireCommandJson({ name: 'purge', description: 'p', options: [{ type: 4, name: 'amount' }] }), null);
    assert.equal(retireCommandJson({ name: 'ping', description: 'p' }).name, 'ping');
    const automod = { name: 'automod', description: 'a', options: [SUB('mode'), SUB('panic'), SUB('lockdown-end'), { type: 2, name: 'native', options: [SUB('list'), SUB('set')] }] };
    assert.deepEqual(retireCommandJson(automod).options.map((o) => o.name), ['panic', 'lockdown-end'], 'only the emergency kit');
    const todo = { name: 'todo', description: 't', options: [SUB('add'), { type: 2, name: 'share', options: [SUB('create'), SUB('view')] }] };
    assert.deepEqual(retireCommandJson(todo).options.find((o) => o.name === 'share').options.map((o) => o.name), ['create', 'view'], 'groups kept with their everyone subcommands');
    assert.equal(retireCommandJson({ name: 'Moderate', type: 2 }), null, 'admin context menu dropped');
    assert.equal(retireCommandJson({ name: 'Report message', type: 3 }).name, 'Report message');
});

test('the gate while retired: everyone-commands work, admin keys point to their dashboard page, the kit is owner-only', () => {
    const owner = '1999999999999999992';
    const owners = botConfig.commands.owners;
    botConfig.commands.owners = [...(owners || []), owner];
    const savedMain = enforcementConfig.mainGuildId;
    enforcementConfig.mainGuildId = '1700000000000000001';
    try {
        withEnv({ RETIRE_ADMIN_COMMANDS: 'true', PUBLIC_URL: 'https://bot.example/' }, () => {
            const guild = { id: enforcementConfig.mainGuildId, ownerId: 'server-owner' };
            const admin = { has: () => true };
            const member = { has: () => false };
            const check = (key, permissions, userId = 'someone') => checkCommandAccess({ command: {}, accessKey: key, guild, userId, permissions });
            assert.deepEqual(check('birthday set', member), { allowed: true });
            assert.deepEqual(check('automod mode', admin), { allowed: false, message: 'This command moved to the dashboard: https://bot.example/dashboard/automod' }, 'even admins use the dashboard');
            assert.equal(check('purge', admin).message, 'This command moved to the dashboard: https://bot.example/dashboard/channels');
            assert.equal(check('enforcements', admin).allowed, false, 'kit: not for admins');
            assert.deepEqual(check('enforcements', member, owner), { allowed: true, ownerOverride: true }, 'kit: owners, logged as override without Administrator');
            assert.deepEqual(check('automod panic', admin, owner), { allowed: true });
            assert.equal(check('automod mode', admin, owner).allowed, false, 'owners too: everything else is on the dashboard');
        });
    } finally {
        botConfig.commands.owners = owners;
        enforcementConfig.mainGuildId = savedMain;
    }
    assert.equal(dashboardPageFor('case evidence add'), 'cases');
    assert.equal(retiredMessage('poll', ''), 'This command moved to the dashboard (messages page).');
});

test('registerCommandSets while retired registers the reduced lists', async () => {
    const puts = [];
    const rest = { put: async (route, { body }) => { puts.push({ route, names: body.map((c) => c.name) }); } };
    const saved = { main: enforcementConfig.mainGuildId, support: enforcementConfig.supportGuildId };
    Object.assign(enforcementConfig, { mainGuildId: '1700000000000000001', supportGuildId: '' });
    try {
        const sets = {
            global: [], support: [],
            main: [{ name: 'ping', description: 'p' }, { name: 'purge', description: 'p' }, { name: 'birthday', description: 'b', options: [SUB('set'), SUB('setchannel')] }],
        };
        await withEnv({ RETIRE_ADMIN_COMMANDS: 'true' }, () => registerCommandSets(rest, '1600000000000000001', sets));
        const main = puts.find((p) => String(p.route).includes('1700000000000000001'));
        assert.deepEqual(main.names, ['ping', 'birthday']);
    } finally {
        Object.assign(enforcementConfig, { mainGuildId: saved.main, supportGuildId: saved.support });
    }
});

test('registerMainGuildCommands: one PUT to the main guild with the startup list (retirement applied); global and support untouched', async () => {
    const puts = [];
    const cmd = (json) => ({ data: { name: json.name, toJSON: () => json } });
    const client = {
        rest: { put: async (route, { body }) => { puts.push({ route: String(route), names: body.map((c) => c.name) }); } },
        commands: new Map([
            ['ping', cmd({ name: 'ping', description: 'p' })], ['purge', cmd({ name: 'purge', description: 'p' })],
            ['birthday', cmd({ name: 'birthday', description: 'b', options: [SUB('set'), SUB('setchannel')] })],
        ]),
    };
    const saved = { main: enforcementConfig.mainGuildId, support: enforcementConfig.supportGuildId, test: testMode.enabled, ids: testMode.guildIds };
    Object.assign(enforcementConfig, { mainGuildId: '1700000000000000001', supportGuildId: '1700000000000000002' });
    testMode.enabled = false;
    try {
        const result = await withEnv({ RETIRE_ADMIN_COMMANDS: 'true' }, () => registerMainGuildCommands(client, { clientId: '1600000000000000001' }));
        assert.deepEqual(result, { guildId: '1700000000000000001', count: 2 });
        assert.equal(puts.length, 1, 'exactly one request');
        assert.equal(puts[0].route, '/applications/1600000000000000001/guilds/1700000000000000001/commands');
        assert.deepEqual(puts[0].names, ['ping', 'birthday']);
        assert.deepEqual(withEnv({ RETIRE_ADMIN_COMMANDS: '' }, () => expectedMainCommands(client)).map((c) => c.name), ['ping', 'purge', 'birthday']);
        assert.equal(puts.length, 1, 'the comparison list never registers anything');

        await assert.rejects(registerMainGuildCommands(client, { clientId: '' }), /CLIENT_ID/);
        testMode.enabled = true;
        testMode.guildIds = new Set(['1700000000000000009']);
        await assert.rejects(registerMainGuildCommands(client, { clientId: '1600000000000000001' }), /TEST_GUILD_IDS/);
        assert.equal(puts.length, 1, 'refused without a request');
    } finally {
        Object.assign(enforcementConfig, { mainGuildId: saved.main, supportGuildId: saved.support });
        testMode.enabled = saved.test;
        testMode.guildIds = saved.ids;
    }
});
