import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';

const { EVERYONE_COMMANDS, SUPPORT_SERVER_COMMANDS } = await import('../src/config/commands/commandAccess.js');
const { checkCommandAccess } = await import('../src/utils/commandGate.js');
const { enforcementConfig } = await import('../src/config/enforcement.js');

const SUBCOMMAND = 1;
const GROUP = 2;

async function allAccessKeys() {
    const root = path.resolve('src/commands');
    const keys = new Set();
    for (const dir of await fs.readdir(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const file of await fs.readdir(path.join(root, dir.name))) {
            if (!file.endsWith('.js')) continue;
            const mod = await import(pathToFileURL(path.join(root, dir.name, file)).href);
            const json = mod.default?.data?.toJSON?.();
            if (!json?.name) continue;
            const subs = (json.options || []).filter((o) => o.type === SUBCOMMAND || o.type === GROUP);
            if (subs.length === 0) keys.add(json.name);
            for (const sub of subs) {
                if (sub.type === SUBCOMMAND) keys.add(`${json.name} ${sub.name}`);
                else for (const nested of sub.options || []) keys.add(`${json.name} ${sub.name} ${nested.name}`);
            }
        }
    }
    return keys;
}

test('every everyone-key names a real command or subcommand', async () => {
    const keys = await allAccessKeys();
    const unknown = [...EVERYONE_COMMANDS].filter((key) => !keys.has(key));
    assert.deepEqual(unknown, []);
});

test('plain command names (owner, 2026-11-07): new keys exist, old jargon names are gone, no aliases', async () => {
    const keys = await allAccessKeys();
    for (const key of ['case remove', 'case keepapart add', 'case keepapart list', 'case keepapart end',
        'automod extrawatch', 'automod friendlynotice', 'backup changes']) {
        assert.ok(keys.has(key), key);
    }
    const old = [...keys].filter((key) => /^(case void|case nocontact|automod probation|automod secondchance|backup diff)\b/.test(key));
    assert.deepEqual(old, []);
    const { default: testCommand } = await import('../src/commands/Owner/test.js');
    const testOptions = testCommand.data.toJSON().options.map((o) => o.name);
    assert.ok(testOptions.includes('no_appeal'));
    assert.ok(!testOptions.includes('unappealable'));
});

test('every owner-kit key names a real command or subcommand', async () => {
    const { OWNER_KIT } = await import('../src/config/commands/retirement.js');
    const keys = await allAccessKeys();
    assert.deepEqual([...OWNER_KIT].filter((key) => !keys.has(key)), []);
});

test('Discord limits: at most 25 options per level, names and descriptions within 32/100 characters', async () => {
    const root = path.resolve('src/commands');
    const walk = (where, options = []) => {
        assert.ok(options.length <= 25, `${where}: ${options.length} options`);
        for (const o of options) {
            assert.ok(o.name.length <= 32, `${where} ${o.name}: name too long`);
            assert.ok((o.description || '').length <= 100, `${where} ${o.name}: description too long`);
            if (o.options) walk(`${where} ${o.name}`, o.options);
        }
    };
    for (const dir of await fs.readdir(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const file of await fs.readdir(path.join(root, dir.name))) {
            if (!file.endsWith('.js')) continue;
            const mod = await import(pathToFileURL(path.join(root, dir.name, file)).href);
            const json = mod.default?.data?.toJSON?.();
            if (!json?.name || json.type === 2 || json.type === 3) continue;
            assert.ok((json.description || '').length <= 100, `${json.name}: description too long`);
            walk(json.name, json.options);
        }
    }
});

test('every support-server command exists', async () => {
    const names = new Set([...(await allAccessKeys())].map((key) => key.split(' ')[0]));
    assert.deepEqual([...SUPPORT_SERVER_COMMANDS].filter((name) => !names.has(name)), []);
});

test('owner decisions stay admin-only', () => {
    for (const key of ['tools randomuser', 'poll create', 'poll end', 'countdown', 'embedbuilder', 'shorten', 'birthday setchannel']) {
        assert.equal(EVERYONE_COMMANDS.has(key), false, key);
    }
});

test('gate: listed keys pass for members, everything else needs Administrator', () => {
    const guild = { id: enforcementConfig.mainGuildId, ownerId: 'owner' };
    const member = { has: () => false };
    const admin = { has: () => true };
    const run = (accessKey, permissions, userId = 'member') =>
        checkCommandAccess({ command: {}, accessKey, guild, userId, permissions }).allowed;

    assert.equal(run('birthday set', member), true);
    assert.equal(run('birthday setchannel', member), false);
    assert.equal(run('birthday', member), false); // no subcommand resolved
    assert.equal(run(null, member), false);
    assert.equal(run('shorten', member), false);
    assert.equal(run('shorten', admin), true);
    assert.equal(run('shorten', member, 'owner'), true);
    assert.equal(run('wipedata', member), true, 'self-service: deletes only the caller\'s own data');
});

test('gate: OWNER_IDS without Administrator pass as an owner override (recorded by the caller); admins and open commands do not', async () => {
    const { botConfig } = await import('../src/config/bot.js');
    const ownerId = '1999999999999999991';
    const owners = botConfig.commands.owners;
    botConfig.commands.owners = [...(owners || []), ownerId];
    try {
        const guild = { id: enforcementConfig.mainGuildId, ownerId: 'server-owner' };
        const check = (accessKey, permissions, userId) => checkCommandAccess({ command: {}, accessKey, guild, userId, permissions });
        assert.deepEqual(check('shorten', { has: () => false }, ownerId), { allowed: true, ownerOverride: true });
        assert.deepEqual(check('shorten', { has: () => true }, ownerId), { allowed: true }, 'an owner who is also admin: no override');
        assert.deepEqual(check('birthday set', { has: () => false }, ownerId), { allowed: true }, 'open command: no override');
    } finally {
        botConfig.commands.owners = owners;
    }
});
