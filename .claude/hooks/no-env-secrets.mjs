#!/usr/bin/env node
// PreToolUse guard: Claude must not read the secret env files (.env, .env.test, .env.local,
// .env.<name>.local). They hold the production Discord token and other secrets (CLAUDE.md).
// Covers Bash commands (cat/grep/source/cp … .env) and Grep/Glob/Read paths; the Read
// tool is also denied in settings.json. Allowed: the *.example templates and
// `--env-file=.env.test`, which only makes node load the file (the npm scripts use it).
// Exit 2 = block, reason on stderr.

// A secret env file name, as a whole path segment: .env, .env.test, .env.local, .env.<x>.local
const SECRET = /(^|[\s'"`=:/<>|;&(])\.env(\.test|\.local|\.[A-Za-z0-9_-]+\.local)?(?=$|[\s'"`;|&)<>])/g;

function secretHits(text) {
    const hits = [];
    for (const m of text.matchAll(SECRET)) {
        const start = m.index + m[1].length;
        const before = text.slice(Math.max(0, start - 11), start);
        if (before === '--env-file=') continue; // node loads it; nothing is printed
        hits.push(text.slice(start, start + m[0].length - m[1].length));
    }
    return hits;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    let call;
    try {
        call = JSON.parse(input);
    } catch {
        process.stderr.write('no-env-secrets: could not read the tool call; refused.\n');
        process.exit(2);
    }
    const ti = call.tool_input || {};
    const texts = [ti.command, ti.path, ti.file_path, ti.pattern && call.tool_name === 'Glob' ? ti.pattern : null]
        .filter((v) => typeof v === 'string');
    const bad = [...new Set(texts.flatMap(secretHits))];
    if (bad.length) {
        process.stderr.write(
            `Blocked by .claude/hooks/no-env-secrets.mjs: ${bad.join(', ')} holds secrets and must not be read (CLAUDE.md). `
            + 'Use .env.example / .env.test.example for variable names, or ask Ramūnas.\n'
        );
        process.exit(2);
    }
    process.exit(0);
});
