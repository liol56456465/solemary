#!/usr/bin/env node
// PreToolUse guard: Claude must not read the secret env files (.env, .env.test, .env.local,
// .env.<name>.local). They hold the production Discord token and other secrets (CLAUDE.md).
// Covers Bash commands (cat/grep/source/cp … .env), Grep path/glob and Glob/Read paths; the
// Read tool is also denied in settings.json. Allowed: the *.example templates. The npm scripts
// (start:test, test:db, migrate:test) load .env.test themselves, so no direct --env-file is needed
// (`node --env-file=.env.test -e …` could print it, so it is blocked too).
// Limits: this is a guard against accidental reads, not a sandbox. A recursive scan such as
// `grep -r X .` still reaches the files; the real fix is keeping secrets outside the repo.
// Exit 2 = block, reason on stderr.

// A secret env file name, as a whole path segment: .env, .env.test, .env.local, .env.<x>.local
const SECRET = /(^|[\s=:/<>|;&(),{}])\.env(\.test|\.local|\.[A-Za-z0-9_-]+\.local)?(?=$|[\s;|&()<>,{}])/g;
const SECRET_NAMES = ['.env', '.env.test', '.env.local', '.env.production.local', '.env.test.local'];

// Strip shell quoting/escapes so `.en""v`, `'.env'`, `.e\nv` are seen as `.env`.
const normalize = (text) => text.replace(/["'`\\]/g, '');

function globToRegex(glob) {
    let re = '';
    for (const ch of glob) {
        if (ch === '*') re += '.*';
        else if (ch === '?') re += '.';
        else if (ch === '[' || ch === ']') re += ch;
        else if (ch === '!' && re.endsWith('[')) re += '^';
        else re += ch.replace(/[.+^${}()|\\/-]/g, '\\$&');
    }
    try { return new RegExp(`^${re}$`); } catch { return /^\.e/; } // unparsable glob: be strict
}

function secretHits(raw) {
    const text = normalize(raw);
    const hits = [...text.matchAll(SECRET)].map((m) => m[0].slice(m[1].length));
    // Glob tokens (cat .e*, ls .[e]nv, head /x/.en?) that would expand to a secret file.
    for (const token of text.split(/[\s;|&()<>=,]+/)) {
        if (!/[*?[]/.test(token)) continue;
        const base = token.split('/').pop();
        for (const part of base.split(/[{}]/)) {
            if (/^[*?[]/.test(part)) continue; // like the shell: a leading wildcard skips dotfiles
            const re = globToRegex(part);
            if (SECRET_NAMES.some((n) => re.test(n))) hits.push(token);
        }
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
    const texts = [ti.command, ti.path, ti.file_path, ti.glob, call.tool_name === 'Glob' ? ti.pattern : null]
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
