// .claude/hooks/no-env-secrets.mjs: blocks reads of the secret env files, but not code or text that
// merely contains brackets or wildcards (false positives seen 2026-11-09: `rows[rows.length`,
// `steps[{store`, `kind[^,]`, `src[:src.index`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../.claude/hooks/no-env-secrets.mjs', import.meta.url));

function run(toolInput, toolName = 'Bash') {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }), encoding: 'utf8' });
    return r.status;
}

const BLOCKED = [
    'cat .env', 'cat ./.env.test', 'grep TOKEN .env.local', 'source .env', 'cp .env /tmp/x',
    "cat '.en''v'", 'cat .e*', 'ls .[e]nv', 'head .en?', 'cat .env.production.local',
    'cat ~/.config/mewvo/env.prod', 'cat $HOME/.config/mewvo/env.test', 'cat /home/x/.config/mewvo/env.test',
    'node --env-file=x.env -e 1', 'NODE_OPTIONS=--env-file=y node a.js', 'node -e "process.loadEnvFile()"',
    'cat .*', 'cat .e{n,x}v',
];
const ALLOWED = [
    'cat .env.example', 'cat .env.test.example', 'ls src/*.js', 'grep -rn "x" src',
    'python3 - <<EOF\nafterId = rows[rows.length - 1].id\nEOF',
    "node -e \"const s = steps[{store: 1}]\"",
    "grep -rhoE \"kind[^,]{0,40}(youtube|twitch)[^)]{0,60}\" src",
    "python3 -c \"head = src[:src.index('x')]\"",
    'grep -c "[0-9]" file.txt', 'echo a?b', 'ls tests/*.test.js',
];

test('secret env files and the secrets dir stay blocked', () => {
    for (const command of BLOCKED) assert.equal(run({ command }), 2, command);
    assert.equal(run({ file_path: '/home/x/solemary/.env' }, 'Read'), 2);
    assert.equal(run({ pattern: '.env*' }, 'Glob'), 2);
    assert.equal(run({ path: '.env.test' }, 'Grep'), 2);
});

test('code and text with brackets or wildcards are not mistaken for secret globs', () => {
    for (const command of ALLOWED) assert.equal(run({ command }), 0, command);
    assert.equal(run({ file_path: '/home/x/solemary/src/app.js' }, 'Read'), 0);
});

test('an unreadable tool call is refused', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.equal(r.status, 2);
});
