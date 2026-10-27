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

test('every support-server command exists', async () => {
    const names = new Set([...(await allAccessKeys())].map((key) => key.split(' ')[0]));
    assert.deepEqual([...SUPPORT_SERVER_COMMANDS].filter((name) => !names.has(name)), []);
});

test('owner decisions stay admin-only', () => {
    for (const key of ['wipedata', 'tools randomuser', 'poll', 'countdown', 'embedbuilder', 'shorten', 'birthday setchannel']) {
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
    assert.equal(run('wipedata', member), false);
    assert.equal(run('wipedata', admin), true);
    assert.equal(run('wipedata', member, 'owner'), true);
});
