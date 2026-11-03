// Test mode runs a separate test bot: it refuses the production bot (by CLIENT_ID and
// by the token's bot ID), and DMs reach the test bot from anyone (modmail tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRODUCTION_CLIENT_ID, botIdentityErrors, tokenBotId, envFileFromExecArgv, envFilesFromExecArgv, isTestEnvFile } from '../src/config/testMode.js';

const TEST_BOT = '1600000000000000001';
// Fake tokens: the first part is the bot ID in base64, the rest is filler.
const fakeToken = (id) => `${Buffer.from(id).toString('base64')}.AAAAAA.fake-token-for-tests`;

test('tokenBotId reads the bot ID from the first part of a token', () => {
    assert.equal(tokenBotId(fakeToken(TEST_BOT)), TEST_BOT);
    assert.equal(tokenBotId(fakeToken(PRODUCTION_CLIENT_ID)), PRODUCTION_CLIENT_ID);
    assert.equal(tokenBotId(''), null);
    assert.equal(tokenBotId('not-a-token'), null);
});

test('botIdentityErrors refuses the production CLIENT_ID and token, and a mismatched pair', () => {
    assert.deepEqual(botIdentityErrors({ CLIENT_ID: TEST_BOT, DISCORD_TOKEN: fakeToken(TEST_BOT) }), []);
    assert.match(botIdentityErrors({ CLIENT_ID: PRODUCTION_CLIENT_ID, DISCORD_TOKEN: fakeToken(TEST_BOT) }).join(), /CLIENT_ID is the production Mewvo bot/);
    // A test CLIENT_ID does not hide the production token.
    assert.match(botIdentityErrors({ CLIENT_ID: TEST_BOT, DISCORD_TOKEN: fakeToken(PRODUCTION_CLIENT_ID) }).join(), /DISCORD_TOKEN is the production Mewvo bot's token/);
    assert.match(botIdentityErrors({ CLIENT_ID: '1600000000000000002', DISCORD_TOKEN: fakeToken(TEST_BOT) }).join(), /belongs to bot 1600000000000000001, but CLIENT_ID is 1600000000000000002/);
    assert.match(botIdentityErrors({ CLIENT_ID: TEST_BOT, TOKEN: fakeToken(PRODUCTION_CLIENT_ID) }).join(), /production Mewvo bot's token/, 'TOKEN alias too');
});

const MAIN = '1700000000000000001';
const SUPPORT = '1700000000000000002';
const testEnv = (extra = {}) => ({
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', LOG_LEVEL: 'error',
    TEST_GUILD_IDS: `${MAIN},${SUPPORT}`, MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT,
    POSTGRES_URL: 'postgresql://u:p@localhost:5433/t', CLIENT_ID: TEST_BOT, DISCORD_TOKEN: fakeToken(TEST_BOT), ...extra,
});

test('test mode refuses to start with the production bot (real startup check, separate process)', () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/testMode.js'); console.log('STARTED');"],
        { env: testEnv({ CLIENT_ID: PRODUCTION_CLIENT_ID, DISCORD_TOKEN: fakeToken(PRODUCTION_CLIENT_ID) }), encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.ok(!run.stdout.includes('STARTED'));
    assert.match(run.stdout + run.stderr, /CLIENT_ID is the production Mewvo bot/);
    const ok = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/testMode.js'); console.log('STARTED');"],
        { env: testEnv(), encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /STARTED/);
});

test('test mode refuses a local-looking URL whose ?host= points elsewhere (pg would follow the parameter)', () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/testMode.js'); console.log('STARTED');"],
        { env: testEnv({ POSTGRES_URL: 'postgresql://u:p@localhost:5433/t?host=db.remote.example' }), encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.ok(!run.stdout.includes('STARTED'));
    assert.match(run.stdout + run.stderr, /URL parameter "host" is not allowed/);
});

test('test mode: DMs from anyone reach the test bot; other servers stay blocked', () => {
    const script = `
const { installGuildAllowlist } = await import('./src/config/testMode.js');
const seen = [];
const client = { ws: { handlePacket: (p) => { seen.push(p.t + ':' + (p.d.guild_id || 'dm')); return true; } }, guilds: { fetch: async () => null } };
installGuildAllowlist(client);
client.ws.handlePacket({ t: 'MESSAGE_CREATE', d: { author: { id: '1800000000000000009' } } });
client.ws.handlePacket({ t: 'INTERACTION_CREATE', d: { user: { id: '1800000000000000009' } } });
client.ws.handlePacket({ t: 'MESSAGE_CREATE', d: { guild_id: '${MAIN}', author: { id: '1' } } });
client.ws.handlePacket({ t: 'MESSAGE_CREATE', d: { guild_id: '1527697154926182492', author: { id: '1' } } });
client.ws.handlePacket({ t: 'TYPING_START', d: {} });
console.log(JSON.stringify(seen));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: testEnv(), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').pop()), ['MESSAGE_CREATE:dm', 'INTERACTION_CREATE:dm', `MESSAGE_CREATE:${MAIN}`]);
});

test('the test env file is recognised by name, in the repo or in ~/.config/mewvo', () => {
    assert.equal(isTestEnvFile('.env.test'), true);
    assert.equal(isTestEnvFile('/home/u/.config/mewvo/env.test'), true);
    assert.equal(isTestEnvFile('C:\\Users\\u\\.config\\mewvo\\env.test'), true);
    assert.equal(isTestEnvFile('/home/u/.config/mewvo/env.prod'), false);
    assert.equal(isTestEnvFile('.env'), false);
    assert.equal(isTestEnvFile('my-env.test'), false);
    assert.equal(isTestEnvFile(''), false);
    assert.equal(envFileFromExecArgv(['--env-file=/x/env.test']), '/x/env.test');
    assert.equal(envFileFromExecArgv(['--env-file', '/x/env.test', '--test']), '/x/env.test');
    assert.equal(envFileFromExecArgv(['--env-file-if-exists=/x/env.test']), '/x/env.test');
    assert.equal(envFileFromExecArgv(['--test']), '');
    assert.deepEqual(envFilesFromExecArgv(['--env-file=/a/prod', '--env-file', '/x/env.test']), ['/a/prod', '/x/env.test']);
});

test('several --env-file flags: the guard still sees the test file when it is not the first', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mewvo-envfile-'));
    try {
        const prodFile = path.join(dir, 'env.prod');
        const testFile = path.join(dir, 'env.test');
        writeFileSync(prodFile, 'LOG_LEVEL=error\n');
        writeFileSync(testFile, 'LOG_LEVEL=error\n');
        const code = "await import('./src/config/testMode.js'); console.log('STARTED');";
        const run = spawnSync(process.execPath, [`--env-file=${prodFile}`, `--env-file=${testFile}`, '--input-type=module', '-e', code],
            { env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' });
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.match(run.stdout + run.stderr, /NODE_ENV is not "test"/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('started with the moved test env file but without NODE_ENV=test: refuses to start (separate process)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mewvo-envfile-'));
    try {
        const testFile = path.join(dir, 'env.test');
        const prodFile = path.join(dir, 'env.prod');
        writeFileSync(testFile, 'LOG_LEVEL=error\n');
        writeFileSync(prodFile, 'LOG_LEVEL=error\n');
        const env = { PATH: process.env.PATH, HOME: process.env.HOME };
        const code = "await import('./src/config/testMode.js'); console.log('STARTED');";
        const run = spawnSync(process.execPath, [`--env-file=${testFile}`, '--input-type=module', '-e', code], { env, encoding: 'utf8' });
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.ok(!run.stdout.includes('STARTED'));
        assert.match(run.stdout + run.stderr, /NODE_ENV is not "test"/);
        const other = spawnSync(process.execPath, [`--env-file=${prodFile}`, '--input-type=module', '-e', code], { env, encoding: 'utf8' });
        assert.equal(other.status, 0, other.stdout + other.stderr);
        assert.match(other.stdout, /STARTED/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
